// Analytics read the computed path only. Dashboards speak the catalogue's vocabulary — apis, plans,
// applications, subscriptions — not the infrastructure's.

import { likePattern } from '../http/paging.js';
import { adb, db } from '../db/index.js';
import { policy } from './ingest-policy.js';
import { DURATION_BOUNDS, dailyBefore, horizon, percentile, rolledUntil } from './retention.js';

// the width of the buckets of a chart over time: the finest that keeps a range to 120 buckets at
// most — a minute for an hour, a quarter of an hour for a day, an hour for three days, a day for
// three months. `bucket` says how to label them: by the time of day, or by the date
const STEPS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3];
function range({ from, to }) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 24 * 3600 * 1000);
  const step = STEPS.find((w) => (end - start) / w <= 120) || STEPS[STEPS.length - 1];
  return { start, end, step, bucket: labelOf(start, end, step) };
}
const labelOf = (start, end, step) => (end - start > 2 * 86400e3 ? 'day' : step >= 3600e3 ? 'hour' : 'minute');
// the bucket of a row, aligned on the epoch like the buckets the charts lay out
const binOf = (step) => adb`date_bin(${`${Math.round(step / 1000)} seconds`}::interval, at, timestamptz '1970-01-01 00:00:00+00')`;

const appsOf = (filter) => (filter.applicationIds ? '{' + filter.applicationIds.join(',') + '}' : null);

// the status classes a dashboard filters on: 2xx, 3xx, 4xx, 5xx
export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'];
const classOf = (v) => (STATUS_CLASSES.includes(v) ? Number(v[0]) * 100 : null);

// the filters of a dashboard, on the calls or on their rollups (whose dimensions are '' for none,
// and whose status is a class)
function filters(filter, { rollups = false } = {}) {
  const ws = filter.workspaceId || null;
  const api = filter.apiId || null;
  const plan = filter.planId || null;
  const app = filter.applicationId || null;
  const sub = filter.subscriptionId || null;
  const cls = classOf(filter.status);
  const appsArr = appsOf(filter); // restricts a consumer to its own applications
  const status = rollups ? adb`status_class = ${cls}` : adb`(status / 100)::int * 100 = ${cls}`;
  return adb`(${ws}::text is null or workspace_id = ${ws})
    and (${api}::text is null or api_id = ${api})
    and (${plan}::text is null or plan_id = ${plan})
    and (${app}::text is null or application_id = ${app})
    and (${sub}::text is null or subscription_id = ${sub})
    and (${cls}::int is null or ${status})
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

// the hits of the first entities over time, the others folded into one series: a line per entity
// is read up to a few, past them the tail is "other"
const TOP_SERIES = 4;
const OTHER = '__other';
function topIds(rows, key) {
  return rows
    .map((r) => r[key])
    .filter(Boolean)
    .slice(0, TOP_SERIES);
}
function pivot(rows, key, ids) {
  const out = new Map();
  for (const r of rows) {
    const t = new Date(r.t).toISOString();
    const point = out.get(t) || { t };
    const k = ids.includes(r[key]) ? r[key] : OTHER;
    point[k] = (point[k] || 0) + Number(r.calls);
    out.set(t, point);
  }
  return [...out.values()].sort((a, b) => a.t.localeCompare(b.t));
}

// every bucket of the range, the empty ones too: a chart over time shows the hours without traffic,
// it does not join the ones around them. The buckets are the ones date_bin makes, aligned on the epoch
function bucketsOf(start, end, step) {
  const out = [];
  for (let t = Math.floor(new Date(start).getTime() / step) * step; t <= new Date(end).getTime() && out.length < 2000; t += step) out.push(new Date(t).toISOString());
  return out;
}
function fill(points, times, zero) {
  const byT = new Map(points.map((p) => [new Date(p.t).toISOString(), { ...p, t: new Date(p.t).toISOString() }]));
  return times.map((t) => ({ ...zero, ...(byT.get(t) || { t }) }));
}

// A range within the retention of the calls is read from them, exactly. A range that starts
// before is read from the rollups, plus the calls not rolled up yet: its counts are exact, its
// buckets an hour at least, its percentiles read from histograms. Past `hourlyDays` the rollups are
// daily: a range that reaches them is read by whole days (UTC), its buckets a day at least.
export async function overview(filter) {
  const p = await policy();
  const { start: asked, end, step } = range(filter);
  const from = await horizon();
  const daily = await dailyBefore();
  const kept = { callsDays: p.retention.callsDays, hourlyDays: p.retention.hourlyDays, rollupsDays: p.retention.rollupsDays, from, dailyBefore: daily };
  const byDay = asked < from && daily && asked < daily;
  const start = byDay ? new Date(Math.floor(asked.getTime() / 86400e3) * 86400e3) : asked;
  const seconds = Math.max(1, (end - start) / 1000);
  const out =
    start >= from
      ? { ...(await fromCalls(filter, { start, end, step })), source: 'calls', retention: kept }
      : {
          ...(await fromRollups(filter, { start, end, step: Math.max(step, byDay ? 86400e3 : 3600e3) })),
          source: 'rollups',
          daily: !!byDay,
          approximate: ['p95_ms'],
          retention: kept,
        };
  out.totals.rps = out.totals.calls / seconds;
  // the counts of an empty bucket are zero; its latency is unknown, not zero
  const times = bucketsOf(out.range.from, out.range.to, out.range.step);
  out.series = fill(out.series, times, { calls: 0, errors: 0, success: 0, client_errors: 0, server_errors: 0, avg_ms: null, p95_ms: null, avg_overhead_ms: null });
  for (const k of ['seriesByApplication', 'seriesByApi']) {
    const zero = Object.fromEntries([...out[k].ids, '__other'].map((id) => [id, 0]));
    if (!out[k].points.some((p) => p.__other)) delete zero.__other;
    out[k].points = fill(out[k].points, times, zero);
  }
  return out;
}

const SERVER = adb`count(*) filter (where status >= 500 or (err and coalesce(status, 0) < 400))::int`;

async function fromCalls(filter, { start, end, step }) {
  const bin = binOf(step);
  const where = adb`at >= ${start} and at <= ${end} and ${filters(filter)}`;
  // a call is a success, a client error (a 4xx) or a server error (a 5xx, or a failure of the gateway
  // answered below 400) — the same split as the rollups, which keep the class of a status and its errors
  const outcome = adb`count(*) filter (where coalesce(status, 0) < 400 and not err)::int as success,
      count(*) filter (where status >= 400 and status < 500)::int as client_errors,
      ${SERVER} as server_errors`;
  // the figures and their breakdowns read the same calls, each on its own: in parallel, over the pool
  // (the paths by their template: /pets/{n}, not one line per pet; and as they were called)
  const [[totals], series, statuses, byApi, byApp, byPlan, byPath, byRawPath, byHost, appSeries, apiSeries] = await Promise.all([
    adb`select count(*)::int as calls,
        count(*) filter (where status >= 400 or err)::int as errors,
        ${SERVER} as server_errors,
        coalesce(avg(duration_ms), 0)::float8 as avg_ms,
        coalesce(min(duration_ms), 0)::float8 as min_ms,
        coalesce(max(duration_ms), 0)::float8 as max_ms,
        coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::float8 as p95_ms,
        coalesce(avg(overhead_ms), 0)::float8 as avg_overhead_ms,
        coalesce(sum(bytes_in), 0)::float8 as bytes_in, coalesce(sum(bytes_out), 0)::float8 as bytes_out,
        count(distinct application_id)::int as applications
      from calls where ${where}`,
    adb`select ${bin} as t, count(*)::int as calls,
        count(*) filter (where status >= 400 or err)::int as errors, ${outcome},
        coalesce(avg(duration_ms), 0)::float8 as avg_ms,
        coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::float8 as p95_ms,
        coalesce(avg(overhead_ms), 0)::float8 as avg_overhead_ms
      from calls where ${where} group by 1 order by 1`,
    adb`select (status / 100)::int * 100 as class, count(*)::int as calls from calls where ${where} group by 1 order by 1`,
    adb`select api_id, count(*)::int as calls, count(*) filter (where status >= 400 or err)::int as errors,
        ${SERVER} as server_errors,
        coalesce(avg(duration_ms), 0)::float8 as avg_ms from calls where ${where} group by api_id order by calls desc limit 100`,
    adb`select application_id, count(*)::int as calls, count(*) filter (where status >= 400 or err)::int as errors,
        ${SERVER} as server_errors, coalesce(avg(duration_ms), 0)::float8 as avg_ms
      from calls where ${where} group by application_id order by calls desc limit 100`,
    adb`select api_id, plan_id, count(*)::int as calls from calls where ${where} group by api_id, plan_id order by calls desc limit 100`,
    adb`select method, coalesce(path_template, path) as path, count(*)::int as calls, coalesce(avg(duration_ms), 0)::float8 as avg_ms,
        ${SERVER} as server_errors
      from calls where ${where} group by 1, 2 order by calls desc limit 100`,
    adb`select method, path, count(*)::int as calls from calls where ${where} group by 1, 2 order by calls desc limit 100`,
    adb`select host, count(*)::int as calls from calls where ${where} and host is not null group by 1 order by calls desc limit 100`,
    adb`select ${bin} as t, application_id, count(*)::int as calls from calls where ${where} group by 1, 2`,
    adb`select ${bin} as t, api_id, count(*)::int as calls from calls where ${where} group by 1, 2`,
  ]);
  const appIds = topIds(byApp, 'application_id');
  const apiIds = topIds(byApi, 'api_id');
  const seriesByApplication = pivot(appSeries, 'application_id', appIds);
  const seriesByApi = pivot(apiSeries, 'api_id', apiIds);
  return {
    range: { from: start, to: end, step, bucket: labelOf(start, end, step) },
    totals,
    series,
    statuses,
    ...(await named({ byApi, byApp, byPlan })),
    byPath,
    byRawPath,
    byHost,
    seriesByApplication: { ids: appIds, points: seriesByApplication },
    seriesByApi: { ids: apiIds, points: seriesByApi },
  };
}

async function fromRollups(filter, { start, end, step }) {
  const bin = binOf(step);
  const rolled = await rolledUntil();
  const fr = filters(filter, { rollups: true });
  const fc = filters(filter);
  // the rollups of the range, and the calls of the range not rolled up yet, in one shape
  const rows = () => adb`(
    select hour as at, nullif(workspace_id, '') as workspace_id, nullif(api_id, '') as api_id, nullif(plan_id, '') as plan_id,
      nullif(subscription_id, '') as subscription_id, nullif(application_id, '') as application_id, nullif(method, '') as method,
      nullif(path, '') as path, status_class, calls, errors, duration_sum, overhead_sum, bytes_in, bytes_out, durations
    from call_rollups where hour >= date_trunc('hour', ${start}::timestamptz) and hour <= ${end} and ${fr}
    union all
    select at, workspace_id, api_id, plan_id, subscription_id, application_id, method, coalesce(path_template, path), coalesce(status / 100 * 100, 0),
      1, (status >= 400 or err)::int, coalesce(duration_ms, 0), coalesce(overhead_ms, 0), coalesce(bytes_in, 0), coalesce(bytes_out, 0),
      jsonb_build_object(width_bucket(coalesce(duration_ms, 0), ${`{${DURATION_BOUNDS.join(',')}}`}::int[])::text, 1)
    from calls where id > ${rolled} and at >= ${start} and at <= ${end} and ${fc}
  ) u`;
  const avgMs = () => adb`coalesce(sum(duration_sum)::float8 / nullif(sum(calls), 0), 0)::float8`;
  // a rollup keeps the class of a status and its errors: a gateway failure below 400 is a server error
  const serverErrors = () => adb`(coalesce(sum(calls) filter (where status_class >= 500), 0) + coalesce(sum(errors) filter (where status_class < 400), 0))::int`;
  const outcome = adb`(coalesce(sum(calls) filter (where status_class < 400), 0) - coalesce(sum(errors) filter (where status_class < 400), 0))::int as success,
      coalesce(sum(calls) filter (where status_class = 400), 0)::int as client_errors, ${serverErrors()} as server_errors`;
  // the figures and their breakdowns read the same rows, each on its own: in parallel, over the pool
  const [[totals], histogram, series, statuses, byApi, byApp, byPlan, byPath, appSeries, apiSeries] = await Promise.all([
    adb`select coalesce(sum(calls), 0)::int as calls, coalesce(sum(errors), 0)::int as errors, ${serverErrors()} as server_errors,
      ${avgMs()} as avg_ms, coalesce(sum(overhead_sum)::float8 / nullif(sum(calls), 0), 0)::float8 as avg_overhead_ms,
      coalesce(sum(bytes_in), 0)::float8 as bytes_in, coalesce(sum(bytes_out), 0)::float8 as bytes_out,
      count(distinct application_id)::int as applications
    from ${rows()}`,
    adb`select k as b, sum(v::bigint)::float8 as n from ${rows()}, jsonb_each_text(u.durations) as d(k, v) group by 1`,
    adb`select ${bin} as t, sum(calls)::int as calls, sum(errors)::int as errors, ${outcome}, ${avgMs()} as avg_ms,
      coalesce(sum(overhead_sum)::float8 / nullif(sum(calls), 0), 0)::float8 as avg_overhead_ms
    from ${rows()} group by 1 order by 1`,
    adb`select status_class as class, sum(calls)::int as calls from ${rows()} group by 1 order by 1`,
    adb`select api_id, sum(calls)::int as calls, sum(errors)::int as errors, ${serverErrors()} as server_errors, ${avgMs()} as avg_ms
    from ${rows()} group by api_id order by calls desc limit 100`,
    adb`select application_id, sum(calls)::int as calls, sum(errors)::int as errors, ${serverErrors()} as server_errors, ${avgMs()} as avg_ms
    from ${rows()} group by application_id order by calls desc limit 100`,
    adb`select api_id, plan_id, sum(calls)::int as calls from ${rows()} group by api_id, plan_id order by calls desc limit 100`,
    adb`select method, path, sum(calls)::int as calls, ${avgMs()} as avg_ms, ${serverErrors()} as server_errors from ${rows()} group by 1, 2 order by calls desc limit 100`,
    adb`select ${bin} as t, application_id, sum(calls)::int as calls from ${rows()} group by 1, 2`,
    adb`select ${bin} as t, api_id, sum(calls)::int as calls from ${rows()} group by 1, 2`,
  ]);
  totals.p95_ms = percentile(Object.fromEntries(histogram.map((h) => [h.b, h.n])), 0.95);
  // the extremes are not kept by the rollups
  totals.min_ms = null;
  totals.max_ms = null;
  const appIds = topIds(byApp, 'application_id');
  const apiIds = topIds(byApi, 'api_id');
  const seriesByApplication = pivot(appSeries, 'application_id', appIds);
  const seriesByApi = pivot(apiSeries, 'api_id', apiIds);
  return {
    range: { from: start, to: end, step, bucket: labelOf(start, end, step) },
    totals,
    series,
    statuses,
    ...(await named({ byApi, byApp, byPlan })),
    byPath,
    // the rollups keep the templated paths only, and not the hosts
    byRawPath: null,
    byHost: null,
    seriesByApplication: { ids: appIds, points: seriesByApplication },
    seriesByApi: { ids: apiIds, points: seriesByApi },
  };
}

// the calls a request log shows: the filters of the dashboards, and its own — the method, a part of
// the path, the client id — and a free search
function callsWhere(filter, q) {
  const { start, end } = range(filter);
  const pattern = q ? likePattern(q) : null;
  const status = /^\d{3}$/.test(q) ? parseInt(q, 10) : null;
  const method = filter.method ? String(filter.method).toUpperCase() : null;
  const path = filter.path ? likePattern(filter.path) : null;
  const client = filter.clientId || null;
  return adb`at >= ${start} and at <= ${end} and ${filters(filter)}
      and (${method}::text is null or method = ${method})
      and (${path}::text is null or path ilike ${path} or path_template ilike ${path})
      and (${client}::text is null or client_id = ${client})
      and (${pattern}::text is null or path ilike ${pattern} or method ilike ${pattern} or client_id ilike ${pattern} or from_ip ilike ${pattern} or host ilike ${pattern}
           or req_id = ${q || null} or (${status}::int is not null and status = ${status}))`;
}

const CALL_COLUMNS = adb`id, at, req_id, method, host, path, status, err, duration_ms, overhead_ms, backend_duration_ms, bytes_in, bytes_out,
  api_id, plan_id, application_id, subscription_id, client_id, from_ip, user_agent`;

// the names of the apis, plans and applications of a page of calls
async function namedCalls(items) {
  const names = await named({ byApi: uniq(items, 'api_id'), byApp: uniq(items, 'application_id'), byPlan: uniq(items, 'api_id', 'plan_id') });
  const api = new Map(names.byApi.map((r) => [r.api_id, r.name]));
  const app = new Map(names.byApplication.map((r) => [r.application_id, r.name]));
  const plan = new Map(names.byPlan.map((r) => [`${r.api_id}|${r.plan_id}`, r.plan_name]));
  return items.map((c) => ({
    ...c,
    id: Number(c.id),
    api_name: c.api_id ? api.get(c.api_id) : null,
    plan_name: c.plan_id ? plan.get(`${c.api_id}|${c.plan_id}`) : null,
    application_name: c.application_id ? app.get(c.application_id) : null,
  }));
}
const uniq = (rows, ...keys) => [...new Map(rows.map((r) => [keys.map((k) => r[k]).join('|'), Object.fromEntries(keys.map((k) => [k, r[k]]))])).values()];

// the request log as a paged list; the search matches the path, the method, the status, the host,
// the client id, the caller's address, and the request id (the Otoroshi-Request-Id a caller or a
// backend quotes)
export async function searchCalls(filter, { limit = 50, offset = 0, q = '' } = {}) {
  const [items, [{ total }]] = await Promise.all([
    adb`select ${CALL_COLUMNS} from calls where ${callsWhere(filter, q)} order by at desc, id desc limit ${limit} offset ${offset}`,
    adb`select count(*)::int as total from calls where ${callsWhere(filter, q)}`,
  ]);
  // the request log is the calls themselves: it goes as far back as they are kept
  const p = await policy();
  return { items: await namedCalls(items), total, limit, offset, retention: { callsDays: p.retention.callsDays, from: await horizon() } };
}

// the calls of a request log, as CSV: the filtered calls, the most recent first, up to `max`
export const EXPORT_MAX = 50000;
export async function exportCalls(filter, { q = '', max = EXPORT_MAX } = {}) {
  const items = await namedCalls(await adb`select ${CALL_COLUMNS} from calls where ${callsWhere(filter, q)} order by at desc, id desc limit ${max}`);
  const cols = [
    ['time', (c) => new Date(c.at).toISOString()],
    ['request_id', (c) => c.req_id],
    ['method', (c) => c.method],
    ['host', (c) => c.host],
    ['path', (c) => c.path],
    ['status', (c) => c.status],
    ['gateway_error', (c) => (c.err ? 'true' : 'false')],
    ['duration_ms', (c) => c.duration_ms],
    ['gateway_overhead_ms', (c) => c.overhead_ms],
    ['backend_duration_ms', (c) => c.backend_duration_ms],
    ['bytes_in', (c) => c.bytes_in],
    ['bytes_out', (c) => c.bytes_out],
    ['api', (c) => c.api_name],
    ['api_id', (c) => c.api_id],
    ['plan', (c) => c.plan_name],
    ['application', (c) => c.application_name],
    ['application_id', (c) => c.application_id],
    ['subscription_id', (c) => c.subscription_id],
    ['client_id', (c) => c.client_id],
    ['caller_address', (c) => c.from_ip],
    ['user_agent', (c) => c.user_agent],
  ];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const t = String(v);
    // a cell a spreadsheet would read as a formula is quoted as text
    const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return /[",\n\r]/.test(safe) || safe !== t ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [cols.map(([h]) => h).join(','), ...items.map((c) => cols.map(([, f]) => cell(f(c))).join(','))];
  return { csv: lines.join('\r\n') + '\r\n', count: items.length, truncated: items.length >= max };
}

// the security events of the Threat Protection Suite: what it judged, on which api and plan, and
// what it did — the latest ones, and their counts by category, action and plan over the range
export async function securityEvents(filter, { limit = 50, offset = 0, q = '' } = {}) {
  const { start, end } = range(filter);
  // the search narrows the list of events, not the breakdowns: they answer the filters
  const pattern = q ? likePattern(q) : null;
  const matches = () =>
    adb`(${pattern}::text is null or category ilike ${pattern} or action ilike ${pattern} or outcome ilike ${pattern} or message ilike ${pattern}
      or client_id ilike ${pattern} or from_ip ilike ${pattern} or incident_id ilike ${pattern})`;
  const where = () => adb`at >= ${start} and at <= ${end}
      and (${filter.workspaceId || null}::text is null or workspace_id = ${filter.workspaceId || null})
      and (${filter.apiId || null}::text is null or api_id = ${filter.apiId || null})
      and (${filter.planId || null}::text is null or plan_id = ${filter.planId || null})
      and (${filter.applicationId || null}::text is null or application_id = ${filter.applicationId || null})
      and (${filter.category || null}::text is null or category = ${filter.category || null})
      and (${filter.action || null}::text is null or action = ${filter.action || null})`;
  const [items, [{ total }], [{ events }], byCategory, byAction, byPlan] = await Promise.all([
    adb`select id, at, category, action, outcome, severity, score, api_id, plan_id, subscription_id, application_id, client_id, from_ip, incident_id, message
      from security_events where ${where()} and ${matches()} order by at desc, id desc limit ${limit} offset ${offset}`,
    adb`select count(*)::int as total from security_events where ${where()} and ${matches()}`,
    adb`select count(*)::int as events from security_events where ${where()}`,
    adb`select category, count(*)::int as events from security_events where ${where()} group by 1 order by 2 desc`,
    adb`select action, count(*)::int as events from security_events where ${where()} group by 1 order by 2 desc`,
    adb`select api_id, plan_id, count(*)::int as events from security_events where ${where()} group by 1, 2 order by 3 desc limit 100`,
  ]);
  const names = await named({ byApi: items, byApp: items, byPlan });
  const apiNames = new Map(names.byApi.map((r) => [r.api_id, r.name]));
  const appNames = new Map(names.byApplication.map((r) => [r.application_id, r.name]));
  const planNames = new Map(names.byPlan.map((r) => [`${r.api_id}|${r.plan_id}`, r.plan_name]));
  const p = await policy();
  return {
    items: items.map((r) => ({
      ...r,
      id: Number(r.id),
      api_name: r.api_id ? apiNames.get(r.api_id) : null,
      application_name: r.application_id ? appNames.get(r.application_id) : null,
    })),
    // the events the search found (the list), and the events of the filters (the figures)
    total,
    events,
    limit,
    offset,
    byCategory,
    byAction,
    byPlan: names.byPlan.map((r) => ({ ...r, plan_name: r.plan_id ? planNames.get(`${r.api_id}|${r.plan_id}`) : null })),
    retention: { days: p.retention.callsDays },
  };
}

// the calls of each api over the last days, exact: the rollups, and the calls not rolled up yet
export async function callsByApi(workspaceId, days = 30) {
  const start = new Date(Date.now() - days * 86400000);
  const [state] = await adb`select last_id from rollup_state where name = 'calls'`;
  const rolled = Number(state?.last_id || 0);
  const rows = await adb`select api_id, sum(n)::int as calls from (
      select api_id, sum(calls) as n from call_rollups where workspace_id = ${workspaceId} and hour >= date_trunc('hour', ${start}::timestamptz) group by api_id
      union all
      select api_id, count(*) as n from calls where workspace_id = ${workspaceId} and id > ${rolled} and at >= ${start} group by api_id
    ) t where api_id is not null and api_id <> '' group by api_id`;
  return new Map(rows.map((r) => [r.api_id, r.calls]));
}

export async function ingestStats() {
  const [c] = await adb`select count(*)::int as calls, max(at) as last_at, min(at) as oldest_at from calls`;
  const [r] = await adb`select count(*)::int as raw, min(at) as raw_oldest_at from raw_events`;
  const [a] = await adb`select count(*)::int as ai from ai_usage`;
  const [h] = await adb`select count(*)::int as rollups, min(hour) as rollups_oldest_at from call_rollups`;
  const [w] = await adb`select count(*)::int as pending from calls where id > ${await rolledUntil()}`;
  const run = (await db`select value from settings where key = 'ingest.last_run'`)[0]?.value || null;
  return { ...c, ...r, ...a, ...h, rollup_pending: w.pending, daily_before: await dailyBefore(), last_run: run };
}
