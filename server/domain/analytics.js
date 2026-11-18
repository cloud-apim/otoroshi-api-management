// Analytics read the computed path only. Dashboards speak the catalogue's vocabulary — apis, plans,
// applications, subscriptions — not the infrastructure's.

import { likePattern } from '../http/paging.js';
import { adb, db } from '../db/index.js';
import { policy } from './ingest-policy.js';
import { DURATION_BOUNDS, horizon, percentile, rolledUntil } from './retention.js';

function range({ from, to }) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 24 * 3600 * 1000);
  const spanH = (end - start) / 3600000;
  const bucket = spanH <= 2 ? 'minute' : spanH <= 72 ? 'hour' : 'day';
  return { start, end, bucket };
}

const appsOf = (filter) => (filter.applicationIds ? '{' + filter.applicationIds.join(',') + '}' : null);

// the filters of a dashboard, on the calls or on their rollups (whose dimensions are '' for none)
function filters(filter) {
  const ws = filter.workspaceId || null;
  const api = filter.apiId || null;
  const app = filter.applicationId || null;
  const sub = filter.subscriptionId || null;
  const appsArr = appsOf(filter); // restricts a consumer to its own applications
  return adb`(${ws}::text is null or workspace_id = ${ws})
    and (${api}::text is null or api_id = ${api})
    and (${app}::text is null or application_id = ${app})
    and (${sub}::text is null or subscription_id = ${sub})
    and (${appsArr}::text[] is null or application_id = any(${appsArr}::text[]))`;
}

// names from the catalogue
async function named({ byApi, byApp, byPlan }) {
  const apiIds = [...new Set([...byApi, ...byPlan].map((r) => r.api_id).filter(Boolean))];
  const appIds = [...new Set(byApp.map((r) => r.application_id).filter(Boolean))];
  const apiRows = apiIds.length ? await db`select id, name, version, draft->'plans' as plans from apis where id in ${db(apiIds)}` : [];
  const appRows = appIds.length ? await db`select id, name from applications where id in ${db(appIds)}` : [];
  const apiName = (id) => {
    const a = apiRows.find((x) => x.id === id);
    return a ? `${a.name} ${a.version}` : id || '(unattributed)';
  };
  const planName = (apiId, planId) => {
    const a = apiRows.find((x) => x.id === apiId);
    const p = (a?.plans || []).find((x) => x.id === planId);
    return p?.name || planId || '(no plan)';
  };
  return {
    byApi: byApi.map((r) => ({ ...r, name: apiName(r.api_id) })),
    byApplication: byApp.map((r) => ({ ...r, name: appRows.find((a) => a.id === r.application_id)?.name || r.application_id || '(anonymous / unattributed)' })),
    byPlan: byPlan.map((r) => ({ ...r, api_name: apiName(r.api_id), plan_name: planName(r.api_id, r.plan_id) })),
  };
}

// A range within the retention of the calls is read from them, exactly. A range that starts
// before is read from the hourly rollups, plus the calls not rolled up yet: its counts are exact,
// its buckets an hour at least, its percentiles read from histograms.
export async function overview(filter) {
  const p = await policy();
  const { start, end, bucket } = range(filter);
  const from = await horizon();
  const kept = { callsDays: p.retention.callsDays, rollupsDays: p.retention.rollupsDays, from };
  if (start >= from) return { ...(await fromCalls(filter, { start, end, bucket })), source: 'calls', retention: kept };
  return { ...(await fromRollups(filter, { start, end, bucket: bucket === 'minute' ? 'hour' : bucket })), source: 'rollups', approximate: ['p95_ms'], retention: kept };
}

async function fromCalls(filter, { start, end, bucket }) {
  const where = adb`at >= ${start} and at <= ${end} and ${filters(filter)}`;
  const [totals] = await adb`select count(*)::int as calls,
      count(*) filter (where status >= 400 or err)::int as errors,
      coalesce(avg(duration_ms), 0)::float8 as avg_ms,
      coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::float8 as p95_ms,
      coalesce(avg(overhead_ms), 0)::float8 as avg_overhead_ms,
      coalesce(sum(bytes_in), 0)::float8 as bytes_in, coalesce(sum(bytes_out), 0)::float8 as bytes_out,
      count(distinct application_id)::int as applications
    from calls where ${where}`;
  const series = await adb`select date_trunc(${bucket}, at) as t, count(*)::int as calls,
      count(*) filter (where status >= 400 or err)::int as errors, coalesce(avg(duration_ms), 0)::float8 as avg_ms
    from calls where ${where} group by 1 order by 1`;
  const statuses = await adb`select (status / 100)::int * 100 as class, count(*)::int as calls from calls where ${where} group by 1 order by 1`;
  const byApi = await adb`select api_id, count(*)::int as calls, count(*) filter (where status >= 400 or err)::int as errors,
      coalesce(avg(duration_ms), 0)::float8 as avg_ms from calls where ${where} group by api_id order by calls desc limit 100`;
  const byApp = await adb`select application_id, count(*)::int as calls, count(*) filter (where status >= 400 or err)::int as errors
    from calls where ${where} group by application_id order by calls desc limit 100`;
  const byPlan = await adb`select api_id, plan_id, count(*)::int as calls from calls where ${where} group by api_id, plan_id order by calls desc limit 100`;
  // the paths by their template: /pets/{n}, not one line per pet
  const byPath = await adb`select method, coalesce(path_template, path) as path, count(*)::int as calls, coalesce(avg(duration_ms), 0)::float8 as avg_ms
    from calls where ${where} group by 1, 2 order by calls desc limit 100`;
  return { range: { from: start, to: end, bucket }, totals, series, statuses, ...(await named({ byApi, byApp, byPlan })), byPath };
}

async function fromRollups(filter, { start, end, bucket }) {
  const rolled = await rolledUntil();
  const f = filters(filter);
  // the rollups of the range, and the calls of the range not rolled up yet, in one shape
  const rows = () => adb`(
    select hour as at, nullif(workspace_id, '') as workspace_id, nullif(api_id, '') as api_id, nullif(plan_id, '') as plan_id,
      nullif(subscription_id, '') as subscription_id, nullif(application_id, '') as application_id, nullif(method, '') as method,
      nullif(path, '') as path, status_class, calls, errors, duration_sum, overhead_sum, bytes_in, bytes_out, durations
    from call_rollups where hour >= date_trunc('hour', ${start}::timestamptz) and hour <= ${end} and ${f}
    union all
    select at, workspace_id, api_id, plan_id, subscription_id, application_id, method, coalesce(path_template, path), coalesce(status / 100 * 100, 0),
      1, (status >= 400 or err)::int, coalesce(duration_ms, 0), coalesce(overhead_ms, 0), coalesce(bytes_in, 0), coalesce(bytes_out, 0),
      jsonb_build_object(width_bucket(coalesce(duration_ms, 0), ${`{${DURATION_BOUNDS.join(',')}}`}::int[])::text, 1)
    from calls where id > ${rolled} and at >= ${start} and at <= ${end} and ${f}
  ) u`;
  const avgMs = () => adb`coalesce(sum(duration_sum)::float8 / nullif(sum(calls), 0), 0)::float8`;
  const [totals] = await adb`select coalesce(sum(calls), 0)::int as calls, coalesce(sum(errors), 0)::int as errors,
      ${avgMs()} as avg_ms, coalesce(sum(overhead_sum)::float8 / nullif(sum(calls), 0), 0)::float8 as avg_overhead_ms,
      coalesce(sum(bytes_in), 0)::float8 as bytes_in, coalesce(sum(bytes_out), 0)::float8 as bytes_out,
      count(distinct application_id)::int as applications
    from ${rows()}`;
  const histogram = await adb`select k as b, sum(v::bigint)::float8 as n from ${rows()}, jsonb_each_text(u.durations) as d(k, v) group by 1`;
  totals.p95_ms = percentile(Object.fromEntries(histogram.map((h) => [h.b, h.n])), 0.95);
  const series = await adb`select date_trunc(${bucket}, at) as t, sum(calls)::int as calls, sum(errors)::int as errors, ${avgMs()} as avg_ms
    from ${rows()} group by 1 order by 1`;
  const statuses = await adb`select status_class as class, sum(calls)::int as calls from ${rows()} group by 1 order by 1`;
  const byApi = await adb`select api_id, sum(calls)::int as calls, sum(errors)::int as errors, ${avgMs()} as avg_ms
    from ${rows()} group by api_id order by calls desc limit 100`;
  const byApp = await adb`select application_id, sum(calls)::int as calls, sum(errors)::int as errors from ${rows()} group by application_id order by calls desc limit 100`;
  const byPlan = await adb`select api_id, plan_id, sum(calls)::int as calls from ${rows()} group by api_id, plan_id order by calls desc limit 100`;
  const byPath = await adb`select method, path, sum(calls)::int as calls, ${avgMs()} as avg_ms from ${rows()} group by 1, 2 order by calls desc limit 100`;
  return { range: { from: start, to: end, bucket }, totals, series, statuses, ...(await named({ byApi, byApp, byPlan })), byPath };
}

// the request log as a paged list; the search matches the path, the method, the status, the
// client id and the caller's address
export async function searchCalls(filter, { limit = 50, offset = 0, q = '' } = {}) {
  const { start, end } = range(filter);
  const appsArr = filter.applicationIds ? '{' + filter.applicationIds.join(',') + '}' : null;
  const pattern = q ? likePattern(q) : null;
  const status = /^\d{3}$/.test(q) ? parseInt(q, 10) : null;
  const where = () => adb`at >= ${start} and at <= ${end}
      and (${filter.workspaceId || null}::text is null or workspace_id = ${filter.workspaceId || null})
      and (${filter.apiId || null}::text is null or api_id = ${filter.apiId || null})
      and (${filter.applicationId || null}::text is null or application_id = ${filter.applicationId || null})
      and (${filter.subscriptionId || null}::text is null or subscription_id = ${filter.subscriptionId || null})
      and (${appsArr}::text[] is null or application_id = any(${appsArr}::text[]))
      and (${pattern}::text is null or path ilike ${pattern} or method ilike ${pattern} or client_id ilike ${pattern} or from_ip ilike ${pattern}
           or (${status}::int is not null and status = ${status}))`;
  const [items, [{ total }]] = await Promise.all([
    adb`select at, req_id, method, path, status, duration_ms, api_id, plan_id, application_id, subscription_id, client_id, from_ip
      from calls where ${where()} order by at desc limit ${limit} offset ${offset}`,
    adb`select count(*)::int as total from calls where ${where()}`,
  ]);
  // the request log is the calls themselves: it goes as far back as they are kept
  const p = await policy();
  return { items, total, limit, offset, retention: { callsDays: p.retention.callsDays, from: await horizon() } };
}

export async function ingestStats() {
  const [c] = await adb`select count(*)::int as calls, max(at) as last_at, min(at) as oldest_at from calls`;
  const [r] = await adb`select count(*)::int as raw, min(at) as raw_oldest_at from raw_events`;
  const [a] = await adb`select count(*)::int as ai from ai_usage`;
  const [h] = await adb`select count(*)::int as rollups, min(hour) as rollups_oldest_at from call_rollups`;
  const [w] = await adb`select count(*)::int as pending from calls where id > ${await rolledUntil()}`;
  const run = (await db`select value from settings where key = 'ingest.last_run'`)[0]?.value || null;
  return { ...c, ...r, ...a, ...h, rollup_pending: w.pending, last_run: run };
}
