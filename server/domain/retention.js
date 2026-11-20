// What the computed path keeps beyond its calls, and how long each table is kept:
//  - the calls, and the AI usage, are rolled up by the hour, incrementally — by id, so that a late
//    event is counted in its hour — then deleted past their retention, never before they are
//    rolled up;
//  - the rollups are kept for `rollupsDays`, the raw path for `rawDays`.
// Run by the ingester (one runner at a time: an advisory lock), and on demand.

import { adb, db } from '../db/index.js';
import { policy } from './ingest-policy.js';

// the upper bounds of the duration buckets, in ms: bucket 0 is < 5 ms, the last one ≥ 10 s
export const DURATION_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const BOUNDS = `{${DURATION_BOUNDS.join(',')}}`;
const LOCK = 7311_0008;
// an id is rolled up once its row is at least this old: the insert that holds a smaller id has
// committed by then
const SETTLE_MS = 60000;
const BATCH = 100000;

// the percentile of a histogram { bucket: calls }, interpolated within its bucket
export function percentile(histogram, q) {
  const entries = Object.entries(histogram || {})
    .map(([b, n]) => [parseInt(b, 10), Number(n)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (!total) return 0;
  const target = q * total;
  let seen = 0;
  for (const [b, n] of entries) {
    if (seen + n >= target) {
      const lo = b === 0 ? 0 : DURATION_BOUNDS[b - 1];
      const hi = DURATION_BOUNDS[b] ?? DURATION_BOUNDS[DURATION_BOUNDS.length - 1];
      return lo + (hi - lo) * ((target - seen) / n);
    }
    seen += n;
  }
  return DURATION_BOUNDS[DURATION_BOUNDS.length - 1];
}

async function rollCalls(tx, from, to) {
  await tx`insert into call_rollups (hour, workspace_id, api_id, plan_id, subscription_id, application_id, method, path, status_class,
      calls, errors, duration_sum, overhead_sum, bytes_in, bytes_out, durations)
    select hour, workspace_id, api_id, plan_id, subscription_id, application_id, method, path, status_class,
      sum(n), sum(e), sum(ds), sum(os), sum(bi), sum(bo), jsonb_object_agg(b::text, n)
    from (
      select date_trunc('hour', at) as hour, coalesce(workspace_id, '') as workspace_id, coalesce(api_id, '') as api_id,
        coalesce(plan_id, '') as plan_id, coalesce(subscription_id, '') as subscription_id, coalesce(application_id, '') as application_id,
        coalesce(method, '') as method, coalesce(path_template, path, '') as path, coalesce(status / 100 * 100, 0) as status_class,
        width_bucket(coalesce(duration_ms, 0), ${BOUNDS}::int[]) as b,
        count(*) as n, count(*) filter (where status >= 400 or err) as e,
        coalesce(sum(duration_ms), 0) as ds, coalesce(sum(overhead_ms), 0) as os, coalesce(sum(bytes_in), 0) as bi, coalesce(sum(bytes_out), 0) as bo
      from calls where id > ${from} and id <= ${to}
      group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    ) g
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9
    on conflict (hour, workspace_id, api_id, plan_id, subscription_id, application_id, method, path, status_class) do update set
      calls = call_rollups.calls + excluded.calls,
      errors = call_rollups.errors + excluded.errors,
      duration_sum = call_rollups.duration_sum + excluded.duration_sum,
      overhead_sum = call_rollups.overhead_sum + excluded.overhead_sum,
      bytes_in = call_rollups.bytes_in + excluded.bytes_in,
      bytes_out = call_rollups.bytes_out + excluded.bytes_out,
      durations = (select jsonb_object_agg(k, coalesce((call_rollups.durations ->> k)::bigint, 0) + coalesce((excluded.durations ->> k)::bigint, 0))
        from jsonb_object_keys(call_rollups.durations || excluded.durations) as k)`;
}

async function rollAi(tx, from, to) {
  await tx`insert into ai_rollups (hour, workspace_id, api_id, subscription_id, type, provider, model, tool, events, input_tokens, output_tokens, cost_micro_usd)
    select date_trunc('hour', at), coalesce(workspace_id, ''), coalesce(api_id, ''), coalesce(subscription_id, ''), coalesce(type, ''),
      coalesce(provider, ''), coalesce(model, ''), coalesce(tool, ''),
      count(*), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0), coalesce(sum(cost_micro_usd), 0)
    from ai_usage where id > ${from} and id <= ${to}
    group by 1, 2, 3, 4, 5, 6, 7, 8
    on conflict (hour, workspace_id, api_id, subscription_id, type, provider, model, tool) do update set
      events = ai_rollups.events + excluded.events,
      input_tokens = ai_rollups.input_tokens + excluded.input_tokens,
      output_tokens = ai_rollups.output_tokens + excluded.output_tokens,
      cost_micro_usd = ai_rollups.cost_micro_usd + excluded.cost_micro_usd`;
}

// one batch of a table rolled up, in one transaction with the move of its state: exactly once.
// Returns how many rows were rolled up, or null when another runner holds the lock
async function rollBatch(name, table, roll, settleMs) {
  const settle = `${Math.max(0, Math.round(settleMs))} milliseconds`;
  return adb.begin(async (tx) => {
    const [{ locked }] = await tx`select pg_try_advisory_xact_lock(${LOCK}) as locked`;
    if (!locked) return null;
    await tx`insert into rollup_state (name) values (${name}) on conflict (name) do nothing`;
    const [state] = await tx`select last_id from rollup_state where name = ${name} for update`;
    const from = Number(state.last_id);
    const [{ to, n }] =
      table === 'calls'
        ? await tx`select coalesce(max(id), 0)::bigint as to, count(*)::int as n from (select id from calls where id > ${from} and received_at < now() - ${settle}::interval order by id limit ${BATCH}) x`
        : await tx`select coalesce(max(id), 0)::bigint as to, count(*)::int as n from (select id from ai_usage where id > ${from} and received_at < now() - ${settle}::interval order by id limit ${BATCH}) x`;
    if (!n) return 0;
    await roll(tx, from, Number(to));
    await tx`update rollup_state set last_id = ${Number(to)}, updated_at = now() where name = ${name}`;
    return n;
  });
}

export async function rollUp({ settleMs = SETTLE_MS } = {}) {
  const out = { calls: 0, ai: 0 };
  for (const [name, table, roll] of [
    ['calls', 'calls', rollCalls],
    ['ai_usage', 'ai_usage', rollAi],
  ]) {
    for (;;) {
      const n = await rollBatch(name, table, roll, settleMs);
      if (n === null) return null;
      out[name === 'calls' ? 'calls' : 'ai'] += n;
      if (n < BATCH) break;
    }
  }
  return out;
}

// the rows past their retention, deleted by batches; a call or an AI usage only once rolled up
async function purge(query) {
  let total = 0;
  for (;;) {
    const rows = await query();
    total += rows.count ?? rows.length ?? 0;
    if ((rows.count ?? rows.length ?? 0) < 20000) return total;
  }
}

export async function sweep(p, now = new Date()) {
  const before = (days) => new Date(now.getTime() - days * 86400e3);
  const rolled = Object.fromEntries((await adb`select name, last_id from rollup_state`).map((r) => [r.name, Number(r.last_id)]));
  const calls = before(p.retention.callsDays);
  const ai = before(p.retention.aiDays);
  const rollups = before(p.retention.rollupsDays);
  const raw = before(p.retention.rawDays);
  const deletedCalls = await purge(() => adb`delete from calls where id in (select id from calls where at < ${calls} and id <= ${rolled.calls || 0} limit 20000)`);
  // before this date, calls may be missing: the dashboards read the rollups there
  if (deletedCalls)
    await db`insert into settings (key, value) values ('ingest.purged_before', ${{ at: calls.toISOString() }})
      on conflict (key) do update set value = case when (settings.value ->> 'at') > excluded.value ->> 'at' then settings.value else excluded.value end, updated_at = now()`;
  return {
    calls: deletedCalls,
    ai: await purge(() => adb`delete from ai_usage where id in (select id from ai_usage where at < ${ai} and id <= ${rolled.ai_usage || 0} limit 20000)`),
    rollups:
      (await purge(() => adb`delete from call_rollups where ctid in (select ctid from call_rollups where hour < ${rollups} limit 20000)`)) +
      (await purge(() => adb`delete from ai_rollups where ctid in (select ctid from ai_rollups where hour < ${rollups} limit 20000)`)),
    raw: await purge(() => adb`delete from raw_events where id in (select id from raw_events where at < ${raw} limit 20000)`),
    // the security events are kept as long as the calls they judged
    security: await purge(() => adb`delete from security_events where id in (select id from security_events where at < ${calls} limit 20000)`),
  };
}

// a run: rolled up, then swept; its outcome kept for the console
export async function runRetention({ now = new Date(), settleMs } = {}) {
  const p = await policy();
  const started = Date.now();
  const rolled = await rollUp({ settleMs });
  if (rolled === null) return { skipped: 'another runner holds the lock' };
  const deleted = await sweep(p, now);
  const run = { at: new Date().toISOString(), ms: Date.now() - started, rolled, deleted };
  await db`insert into settings (key, value) values ('ingest.last_run', ${run}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return run;
}

// how far back the calls are complete: from the last date before which some were deleted (a
// retention made longer does not bring them back). The rollups before
export async function horizon() {
  const purged = (await db`select value from settings where key = 'ingest.purged_before'`)[0]?.value?.at;
  return new Date(purged || 0);
}

export async function rolledUntil() {
  const [row] = await adb`select last_id from rollup_state where name = 'calls'`;
  return Number(row?.last_id || 0);
}
