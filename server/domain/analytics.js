// Analytics read the computed path only. Dashboards speak the catalogue's vocabulary — apis, plans,
// applications, subscriptions — not the infrastructure's.

import { likePattern } from '../http/paging.js';
import { adb, db } from '../db/index.js';

function range({ from, to }) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 24 * 3600 * 1000);
  const spanH = (end - start) / 3600000;
  const bucket = spanH <= 2 ? 'minute' : spanH <= 72 ? 'hour' : 'day';
  return { start, end, bucket };
}

export async function overview(filter) {
  const { start, end, bucket } = range(filter);
  const ws = filter.workspaceId || null;
  const api = filter.apiId || null;
  const app = filter.applicationId || null;
  const sub = filter.subscriptionId || null;
  const apps = filter.applicationIds || null; // restricts a consumer to its own applications
  const appsArr = apps ? '{' + apps.join(',') + '}' : null;
  const where = adb`at >= ${start} and at <= ${end}
    and (${ws}::text is null or workspace_id = ${ws})
    and (${api}::text is null or api_id = ${api})
    and (${app}::text is null or application_id = ${app})
    and (${sub}::text is null or subscription_id = ${sub})
    and (${appsArr}::text[] is null or application_id = any(${appsArr}::text[]))`;
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
  const byPath = await adb`select method, path, count(*)::int as calls, coalesce(avg(duration_ms), 0)::float8 as avg_ms
    from calls where ${where} group by method, path order by calls desc limit 100`;
  // resolve names from the catalogue
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
    range: { from: start, to: end, bucket },
    totals,
    series,
    statuses,
    byApi: byApi.map((r) => ({ ...r, name: apiName(r.api_id) })),
    byApplication: byApp.map((r) => ({ ...r, name: appRows.find((a) => a.id === r.application_id)?.name || r.application_id || '(anonymous / unattributed)' })),
    byPlan: byPlan.map((r) => ({ ...r, api_name: apiName(r.api_id), plan_name: planName(r.api_id, r.plan_id) })),
    byPath,
  };
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
  return { items, total, limit, offset };
}

export async function ingestStats() {
  const [c] = await adb`select count(*)::int as calls, max(at) as last_at from calls`;
  const [r] = await adb`select count(*)::int as raw from raw_events`;
  const [a] = await adb`select count(*)::int as ai from ai_usage`;
  return { ...c, ...r, ...a };
}
