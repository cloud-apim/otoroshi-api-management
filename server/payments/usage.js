// Usage-based billing. The product decides the access, the payment provider decides the money: the
// usage of a subscription to a plan with a usage price is counted from the computed path — exhaustive,
// never sampled — and pushed to a meter of the provider in batches, asynchronously, replayable. The
// gateway never sends an event per call: that would put the provider one hop from the data path.
//
// The calls are taken by id, like the rollups: a batch is the calls received since the last one, a
// late call is counted in the next batch, and none is counted twice. Each batch makes one report per
// subscription, in one transaction with the move of the watermark; a report is then sent once, its
// id the identifier the provider dedupes on, and replayed until it is sent.

import { adb, db, newId } from '../db/index.js';
import { normalizeDraft } from '../domain/model.js';
import { deployedSnapshot } from '../domain/deployments.js';
import { enqueue, registerTaskHandler, PermanentError } from '../domain/tasks.js';
import { paymentProvider } from './billing.js';
import { likePattern } from '../http/paging.js';

const LOCK = 7310452;
const BATCH = 50000;
const KEY = 'usage.billed_until';

// the plans with a usage price of the apis of these subscriptions, as their deployed snapshot runs them
async function usagePlans(apiIds) {
  const out = new Map();
  for (const apiId of apiIds) {
    const snap = await deployedSnapshot(apiId);
    if (!snap) continue;
    for (const p of normalizeDraft(snap.content.draft).plans) if (p.pricing.kind === 'paid' && p.pricing.usage.enabled) out.set(`${apiId}|${p.id}`, p);
  }
  return out;
}

// the id up to which the calls are billed: the retention keeps the calls after it
export async function billedUntil() {
  const v = (await db`select value from settings where key = ${KEY}`)[0]?.value;
  return v ? Number(v.id) : null;
}

// one batch: the reports made, and their sending queued. Null when another runner holds the lock
async function batch(settleMs) {
  const settle = `${Math.max(0, Math.round(settleMs))} milliseconds`;
  return db.begin(async (tx) => {
    const [{ locked }] = await tx`select pg_try_advisory_xact_lock(${LOCK}) as locked`;
    if (!locked) return null;
    const from = Number((await tx`select value from settings where key = ${KEY} for update`)[0]?.value?.id || 0);
    const [{ to, n }] = await adb`select coalesce(max(id), 0)::bigint as to, count(*)::int as n
      from (select id from calls where id > ${from} and received_at < now() - ${settle}::interval order by id limit ${BATCH}) x`;
    if (!n) return { calls: 0, reports: [] };
    const subs = await tx`select id, workspace_id, api_id, plan_id, payment from subscriptions where payment->>'provider_subscription' is not null`;
    const plans = await usagePlans([...new Set(subs.map((s) => s.api_id))]);
    const billable = subs.filter((s) => [...plans.keys()].some((k) => k.startsWith(`${s.api_id}|`)));
    const reports = [];
    if (billable.length) {
      const counted = await adb`select subscription_id, plan_id,
          count(*) filter (where status < 400)::bigint as success,
          count(*) filter (where status < 500 and status <> 429)::bigint as served
        from calls where id > ${from} and id <= ${Number(to)} and subscription_id in ${adb(billable.map((s) => s.id))}
        group by subscription_id, plan_id`;
      for (const row of counted) {
        const sub = billable.find((s) => s.id === row.subscription_id);
        // the calls are billed at the price of the plan they were made on
        const plan = plans.get(`${sub.api_id}|${row.plan_id}`);
        if (!plan) continue;
        const value = Number(plan.pricing.usage.counts === 'served' ? row.served : row.success);
        if (!value) continue;
        const [r] = await tx`insert into usage_reports (id, workspace_id, subscription_id, plan_id, from_id, to_id, value, meter_event_name, account, customer)
          values (${newId('usage')}, ${sub.workspace_id}, ${sub.id}, ${plan.id}, ${from}, ${Number(to)}, ${value}, ${plan.pricing.usage.meterEventName},
            ${sub.payment.account || null}, ${sub.payment.customer || null})
          on conflict (subscription_id, to_id) do nothing returning id`;
        if (r) reports.push(r.id);
      }
    }
    await tx`insert into settings (key, value) values (${KEY}, ${{ id: Number(to) }}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    return { calls: n, reports };
  });
}

// every batch due, then the reports not sent yet: the ones just made, and the ones a failure left
export async function pushUsage({ settleMs = 60000 } = {}) {
  const out = { calls: 0, reports: 0, sent: 0 };
  for (;;) {
    const b = await batch(settleMs);
    if (b === null) return { ...out, skipped: 'another runner holds the lock' };
    out.calls += b.calls;
    out.reports += b.reports.length;
    if (b.calls < BATCH) break;
  }
  const pending = (await db`select id from usage_reports where status = 'pending' order by created_at limit 1000`).map((r) => r.id);
  for (const id of pending) await enqueue('payment_usage', { report_id: id }, { dedupeKey: `usage:${id}` }).catch(() => null);
  if (pending.length) out.sent = (await db`select count(*)::int as n from usage_reports where id in ${db(pending)} and status = 'sent'`)[0].n;
  return out;
}

registerTaskHandler('payment_usage', async ({ report_id }) => {
  const r = (await db`select * from usage_reports where id = ${report_id}`)[0];
  if (!r || r.status !== 'pending') return { skipped: true };
  const p = paymentProvider();
  if (!p) throw new Error('no payment provider: the report waits');
  if (!p.reportUsage) throw new PermanentError(`the payment provider ${p.name} cannot meter a usage`);
  if (!r.account || !r.customer) {
    await db`update usage_reports set status = 'failed', error = 'the subscription has no customer at the provider' where id = ${r.id}`;
    throw new PermanentError('the subscription has no customer at the provider');
  }
  try {
    await p.reportUsage(r.account, { eventName: r.meter_event_name, customer: r.customer, value: Number(r.value), identifier: r.id, timestamp: r.created_at });
  } catch (e) {
    await db`update usage_reports set error = ${e.message} where id = ${r.id}`;
    if (e.status >= 400 && e.status < 500) {
      await db`update usage_reports set status = 'failed' where id = ${r.id}`;
      throw new PermanentError(e.message);
    }
    throw e;
  }
  await db`update usage_reports set status = 'sent', sent_at = now(), error = null where id = ${r.id}`;
  return { sent: r.id, value: Number(r.value) };
});

// whether the installation can bill a usage: its payment provider meters
export function meteringAvailable() {
  const p = paymentProvider();
  return !p || !!p.reportUsage;
}

// the usage reported for a subscription
export async function usageOf(subscriptionId, { limit = 200, offset = 0, q = '', billedOnly = false } = {}) {
  // the totals over every batch; the batches themselves searched (status, meter, error) and paged
  const pattern = q ? likePattern(q) : null;
  // the batches billed or to be: not the ones the provider refused
  const kept = db`subscription_id = ${subscriptionId} and (not ${billedOnly}::boolean or status in ('sent', 'pending'))`;
  const matches = db`(${pattern}::text is null or status ilike ${pattern} or meter_event_name ilike ${pattern} or coalesce(error, '') ilike ${pattern} or plan_id ilike ${pattern})`;
  const [reports, [{ total }], sums] = await Promise.all([
    db`select id, plan_id, value, meter_event_name, status, error, created_at, sent_at from usage_reports where ${kept} and ${matches} order by created_at desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from usage_reports where ${kept} and ${matches}`,
    db`select status, coalesce(sum(value), 0)::bigint as value from usage_reports where ${kept} group by status`,
  ]);
  const sum = (s) => Number(sums.find((r) => r.status === s)?.value || 0);
  return { reports: reports.map((r) => ({ ...r, value: Number(r.value) })), total, limit, offset, sent: sum('sent'), pending: sum('pending'), failed: sum('failed') };
}
