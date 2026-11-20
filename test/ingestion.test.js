// The ingester, end to end, on the analytics database of the stack: the personal data of an event
// pseudonymised before it is stored, in the computed path and in the raw one; the raw path
// sampled, its errors kept; the calls rolled up by the hour and deleted past their retention, the
// dashboards then read from the rollups, with the same counts.
//
// Needs the docker stack (mise run up). Changes the ingestion policy of the installation for the
// time of the test, and puts it back.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'ingestion-test-token';
config.publicUrl = `http://localhost:${config.port}`;

const { start } = await import('../server/main.js');
const { db, adb } = await import('../server/db/index.js');
const { invalidateAttributionCache } = await import('../server/domain/ingest.js');
const { invalidatePolicy } = await import('../server/domain/ingest-policy.js');
const { runRetention } = await import('../server/domain/retention.js');

const RUN = Date.now().toString(36);
const WS = `ingest-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
let server;
let saved;
let apiId;

async function ok(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer ingestion-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}

const DAY = 86400e3;
// a GatewayEvent as the data exporter of Otoroshi sends it, for the api of the test
const event = (reqId, { at = Date.now(), status = 200, path = '/v1/users/jane@example.com/orders/42', duration = 12 } = {}) => ({
  '@type': 'GatewayEvent',
  '@id': `evt-${reqId}`,
  '@timestamp': at,
  reqId,
  url: `http://ingest-${RUN}.oto.tools${path}?email=jane@example.com&api_key=k-secret`,
  method: 'GET',
  from: '203.0.113.42',
  status,
  duration,
  overhead: 1,
  data: { dataIn: 10, dataOut: 100 },
  headers: [
    { key: 'User-Agent', value: 'curl/8.9' },
    { key: 'X-Forwarded-For', value: '198.51.100.7' },
  ],
  identity: { identityType: 'PRIVATEAPP', identity: 'jane@example.com', label: 'Jane Doe' },
  route: { id: `route_${RUN}`, name: 'r', metadata: { 'Otoroshi-Api-Ref': apiId } },
});

async function ingest(events) {
  const res = await fetch(`${ROOT}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${config.ingest.token}` }, body: events.map((e) => JSON.stringify(e)).join('\n') });
  expect(res.status).toBe(200);
  return res.json();
}

// another ingester (the one of the stack) may hold the lock for a moment
async function retention() {
  for (let i = 0; i < 20; i++) {
    const run = await runRetention({ settleMs: 0 });
    if (!run.skipped) return run;
    await Bun.sleep(500);
  }
  throw new Error('the retention never ran');
}

beforeAll(async () => {
  server = await start();
  saved = (await db`select value from settings where key = 'ingest'`)[0]?.value || null;
  await ok('POST', '/workspaces', { name: `Ingestion ${RUN}`, slug: WS });
  const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Ops' });
  apiId = (await ok('POST', `/workspaces/${WS}/apis`, { name: 'Users', version: '1.0.0', team_id: team.id, domain: `ingest-${RUN}.oto.tools`, contextPath: '/' })).id;
  invalidateAttributionCache();
});

afterAll(async () => {
  if (saved) await db`update settings set value = ${saved}, updated_at = now() where key = 'ingest'`;
  else await db`delete from settings where key = 'ingest'`;
  invalidatePolicy();
  await adb`delete from calls where api_id = ${apiId}`;
  await adb`delete from security_events where otoroshi_api_id = ${apiId}`;
  await adb`delete from ai_usage where api_id = ${apiId}`;
  await adb`delete from call_rollups where api_id = ${apiId}`;
  await adb`delete from raw_events where payload -> 'route' -> 'metadata' ->> 'Otoroshi-Api-Ref' = ${apiId}`;
  server?.stop(true);
});

describe('the personal data', () => {
  test('pseudonymised before anything is stored, in the computed path and in the raw one', async () => {
    const { ingest: policy } = await ok('PUT', '/settings/ingest', {
      storeRaw: true,
      raw: { sampleRate: 0, keepErrors: true, headers: 'keep' },
      privacy: { ip: 'truncate', user: 'hash', userAgent: 'drop', paths: 'template' },
    });
    expect(policy).toMatchObject({ raw: { sampleRate: 0 }, privacy: { ip: 'truncate', paths: 'template' }, keyed: true });
    expect(policy).not.toHaveProperty('key');
    invalidatePolicy();
    await ingest([event(`${RUN}-ok`), event(`${RUN}-ko`, { status: 503, duration: 900 })]);

    const calls = await adb`select * from calls where api_id = ${apiId} order by status`;
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatchObject({ workspace_id: expect.any(String), from_ip: '203.0.113.0', user_agent: null, path: '/v1/users/{email}/orders/{n}', path_template: '/v1/users/{email}/orders/{n}' });

    // the raw path: no share of the requests, but their errors
    const raw = await adb`select payload from raw_events where payload -> 'route' -> 'metadata' ->> 'Otoroshi-Api-Ref' = ${apiId}`;
    expect(raw.length).toBe(1);
    const e = raw[0].payload;
    expect(e.status).toBe(503);
    expect(e.from).toBe('203.0.113.0');
    expect(e.url).toBe(`http://ingest-${RUN}.oto.tools/v1/users/{email}/orders/{n}?email=*&api_key=*`);
    expect(e.headers).toEqual([{ key: 'X-Forwarded-For', value: '198.51.100.0' }]);
    expect(e.identity.identity).toMatch(/^user:[0-9a-f]{16}$/);
    expect(JSON.stringify(e)).not.toContain('jane');
  });

  test('the key of the pseudonyms is never read back, and rotating it changes them', async () => {
    const before = (await db`select value from settings where key = 'ingest'`)[0].value.key;
    expect(JSON.stringify(await ok('GET', '/settings'))).not.toContain(before);
    await ok('PUT', '/settings/ingest', { rotateKey: true });
    expect((await db`select value from settings where key = 'ingest'`)[0].value.key).not.toBe(before);
    const [audit] = await db`select data from audit_events where action = 'settings.ingest.update' order by at desc limit 1`;
    expect(audit.data.rotatedKey).toBe(true);
    expect(JSON.stringify(audit.data)).not.toContain(before);
  });
});

describe('the retention', () => {
  test('the calls rolled up by the hour, deleted past their retention; the dashboards read the rollups there', async () => {
    await ok('PUT', '/settings/ingest', { privacy: { paths: 'keep' } });
    invalidatePolicy();
    // a call 60 days old — past the 30 days of the calls — and two more at that hour
    const old = Date.now() - 60 * DAY;
    await ingest([event(`${RUN}-old-1`, { at: old, path: '/v1/users/7/orders/1' }), event(`${RUN}-old-2`, { at: old, path: '/v1/users/8/orders/2', duration: 40 }), event(`${RUN}-old-3`, { at: old, status: 404, path: '/v1/users/9' })]);
    const filter = `/workspaces/${WS}/analytics?api=${apiId}&from=${new Date(Date.now() - 90 * DAY).toISOString()}`;
    const exact = await ok('GET', filter);
    expect(exact.totals).toMatchObject({ calls: 5, errors: 2 });

    const run = await retention();
    expect(run.rolled.calls).toBeGreaterThanOrEqual(0);
    expect((await adb`select count(*)::int as n from calls where api_id = ${apiId}`)[0].n).toBe(2);
    const rollups = await adb`select * from call_rollups where api_id = ${apiId} order by hour, path`;
    expect(rollups.reduce((s, r) => s + Number(r.calls), 0)).toBe(5);
    // grouped by the template of the path, whatever the policy of the calls
    expect(rollups.filter((r) => new Date(r.hour) < new Date(Date.now() - 59 * DAY)).map((r) => [r.path, Number(r.calls)])).toEqual([
      ['/v1/users/{n}', 1],
      ['/v1/users/{n}/orders/{n}', 2],
    ]);

    // the same counts, read from the rollups before the retention of the calls
    const long = await ok('GET', filter);
    expect(long.source).toBe('rollups');
    expect(long.approximate).toEqual(['p95_ms']);
    expect(long.totals).toMatchObject({ calls: 5, errors: 2 });
    expect(long.totals.p95_ms).toBeGreaterThan(500);
    expect(long.byPath.find((r) => r.path === '/v1/users/{n}/orders/{n}').calls).toBe(2);
    expect(long.series.reduce((s, r) => s + r.calls, 0)).toBe(5);
    // a range within the retention: the calls themselves
    const day = await ok('GET', `/workspaces/${WS}/analytics?api=${apiId}`);
    expect(day.source).toBe('calls');
    expect(day.totals.calls).toBe(2);
    // the request log goes as far back as the calls are kept
    const log = await ok('GET', `/workspaces/${WS}/analytics/calls?api=${apiId}&from=${new Date(Date.now() - 90 * DAY).toISOString()}`);
    expect(log.total).toBe(2);
    expect(log.retention.callsDays).toBe(30);

    // a second run counts nothing twice
    await retention();
    expect((await adb`select coalesce(sum(calls), 0)::int as n from call_rollups where api_id = ${apiId}`)[0].n).toBe(5);
  });

  test('a late call is counted in its hour; the raw path past its retention is deleted', async () => {
    const old = Date.now() - 60 * DAY;
    await ingest([event(`${RUN}-late`, { at: old, path: '/v1/users/10/orders/3' })]);
    await retention();
    const [{ n }] = await adb`select coalesce(sum(calls), 0)::int as n from call_rollups where api_id = ${apiId} and path = '/v1/users/{n}/orders/{n}' and hour < ${new Date(Date.now() - 59 * DAY)}`;
    expect(n).toBe(3);
    // a raw event older than 7 days
    await adb`insert into raw_events (at, type, payload) values (${new Date(Date.now() - 8 * DAY)}, 'GatewayEvent', ${{ route: { metadata: { 'Otoroshi-Api-Ref': apiId } } }})`;
    const run = await retention();
    expect(run.deleted.raw).toBeGreaterThanOrEqual(1);
    expect((await adb`select count(*)::int as n from raw_events where payload -> 'route' -> 'metadata' ->> 'Otoroshi-Api-Ref' = ${apiId} and at < ${new Date(Date.now() - 7 * DAY)}`)[0].n).toBe(0);
  });

  test('past the hourly retention the rollups are compacted by the day: counts and histograms merged, nothing lost; the dashboards read whole days', async () => {
    const [{ workspace_id: wsId }] = await adb`select workspace_id from calls where api_id = ${apiId} limit 1`;
    const day = new Date(Math.floor((Date.now() - 120 * DAY) / DAY) * DAY);
    const hourly = (h, calls, errors, durations) =>
      adb`insert into call_rollups (hour, workspace_id, api_id, plan_id, subscription_id, application_id, method, path, status_class, calls, errors, duration_sum, overhead_sum, bytes_in, bytes_out, durations)
        values (${new Date(day.getTime() + h * 3600e3)}, ${wsId}, ${apiId}, '', '', '', 'GET', '/v1/compact', 200, ${calls}, ${errors}, ${calls * 10}, ${calls}, 100, 1000, ${durations})`;
    await hourly(2, 3, 1, { 3: 2, 6: 1 });
    await hourly(9, 5, 0, { 3: 5 });
    await hourly(17, 2, 2, { 9: 2 });
    // a range that starts at noon of that day: read from its first whole day, by the day
    const filter = `/workspaces/${WS}/analytics?api=${apiId}&from=${new Date(day.getTime() + 12 * 3600e3).toISOString()}&to=${new Date(day.getTime() + 2 * DAY).toISOString()}`;
    const before = await ok('GET', filter);
    expect(before).toMatchObject({ source: 'rollups', daily: true, range: { step: DAY } });
    expect(before.totals).toMatchObject({ calls: 10, errors: 3 });

    await retention();
    const rows = await adb`select * from call_rollups where api_id = ${apiId} and path = '/v1/compact'`;
    expect(rows.length).toBe(1);
    expect(new Date(rows[0].hour).getTime()).toBe(day.getTime());
    expect([Number(rows[0].calls), Number(rows[0].errors), Number(rows[0].duration_sum)]).toEqual([10, 3, 100]);
    expect(Object.fromEntries(Object.entries(rows[0].durations).map(([k, v]) => [k, Number(v)]))).toEqual({ 3: 7, 6: 1, 9: 2 });
    // the dashboard says the same
    const after = await ok('GET', filter);
    expect(after.totals).toMatchObject({ calls: 10, errors: 3, p95_ms: before.totals.p95_ms });
    expect(after.series.reduce((s, r) => s + r.calls, 0)).toBe(10);

    // a late hourly row in that day is compacted at the next run, added to the day
    await hourly(20, 4, 0, { 3: 4 });
    await retention();
    const again = await adb`select calls, durations from call_rollups where api_id = ${apiId} and path = '/v1/compact'`;
    expect(again.length).toBe(1);
    expect(Number(again[0].calls)).toBe(14);
    expect(Number(again[0].durations['3'])).toBe(11);
  });

  test('the settings are checked', async () => {
    const res = await fetch(`${ROOT}/api/settings/ingest`, { method: 'PUT', headers: { authorization: 'Bearer ingestion-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ retention: { callsDays: 0 } }) });
    expect(res.status).toBe(400);
    // the rollups are hourly at least as long as the calls are kept
    const hourly = await fetch(`${ROOT}/api/settings/ingest`, { method: 'PUT', headers: { authorization: 'Bearer ingestion-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ retention: { hourlyDays: 10 } }) });
    expect(hourly.status).toBe(400);
    expect((await hourly.json()).error).toContain('retention.hourlyDays');
  });
});

describe('the dashboards', () => {
  test('latency, throughput, responses over time and the tops, filtered by status class', async () => {
    const before = await ok('GET', `/workspaces/${WS}/analytics?api=${apiId}&from=${new Date(Date.now() - 3600e3).toISOString()}`);
    await ingest([
      event(`${RUN}-dash-1`, { status: 200, duration: 5, path: '/v1/dash/1' }),
      event(`${RUN}-dash-2`, { status: 404, duration: 20, path: '/v1/dash/2' }),
      event(`${RUN}-dash-3`, { status: 503, duration: 250, path: '/v1/dash/3' }),
    ]);
    const from = new Date(Date.now() - 3600e3).toISOString();
    const d = await ok('GET', `/workspaces/${WS}/analytics?api=${apiId}&from=${from}`);
    expect(d.source).toBe('calls');
    expect(d.totals.calls).toBe(before.totals.calls + 3);
    expect(d.totals.max_ms).toBeGreaterThanOrEqual(250);
    expect(d.totals.server_errors).toBe(before.totals.server_errors + 1);
    expect(d.totals.rps).toBeCloseTo(d.totals.calls / 3600, 4);
    // an hour in minutes: every bucket, the empty ones too, their latency unknown rather than zero
    expect(d.range.step).toBe(60e3);
    expect(d.series.length).toBeGreaterThanOrEqual(60);
    expect(d.series.some((b) => b.calls === 0 && b.avg_ms === null)).toBe(true);
    const sum = (k) => d.series.reduce((n, b) => n + b[k], 0);
    expect(sum('success') + sum('client_errors') + sum('server_errors')).toBe(d.totals.calls);
    expect(d.byHost.find((h) => h.host === `ingest-${RUN}.oto.tools`).calls).toBeGreaterThanOrEqual(3);
    expect(d.byRawPath.map((r) => r.path)).toContain('/v1/dash/3');
    expect(d.byApi[0]).toMatchObject({ api_id: apiId, server_errors: d.totals.server_errors });
    // the hits of an application over time: its buckets, the unattributed calls among them
    expect(d.seriesByApi.ids).toEqual([apiId]);
    expect(d.seriesByApi.points.reduce((n, b) => n + b[apiId], 0)).toBe(d.totals.calls);
    // filtered on a status class: the 5xx only
    const failed = await ok('GET', `/workspaces/${WS}/analytics?api=${apiId}&from=${from}&status=5xx`);
    expect(failed.totals.calls).toBe(d.totals.server_errors);
    expect(failed.statuses.map((r) => r.class)).toEqual([500]);
    // three months: the buckets are days
    const long = await ok('GET', `/workspaces/${WS}/analytics?api=${apiId}&from=${new Date(Date.now() - 90 * DAY).toISOString()}`);
    expect([long.range.step, long.range.bucket]).toEqual([DAY, 'day']);
  });

  test('the request log: filtered like the dashboards and by its own fields, exported as CSV, traced', async () => {
    const from = new Date(Date.now() - 3600e3).toISOString();
    const base = `/workspaces/${WS}/analytics/calls?api=${apiId}&from=${from}`;
    const failed = (await ok('GET', `${base}&status=5xx`)).items;
    expect(failed.map((c) => c.req_id)).toContain(`${RUN}-dash-3`);
    expect(failed.every((c) => c.status >= 500)).toBe(true);
    expect((await ok('GET', `${base}&path=/v1/dash`)).total).toBe(3);
    expect((await ok('GET', `${base}&path=/v1/dash&method=POST`)).total).toBe(0);
    const one = (await ok('GET', `${base}&q=${RUN}-dash-2`)).items[0];
    expect(one).toMatchObject({ status: 404, host: `ingest-${RUN}.oto.tools`, api_name: 'Users 1.0.0' });
    // a value a spreadsheet would run as a formula is quoted as text
    await ingest([event(`=HYPERLINK("http://x")-${RUN}`, { path: '/v1/dash/4' })]);
    const res = await fetch(`${ROOT}/api${`/workspaces/${WS}/analytics/calls/export?api=${apiId}&from=${from}&path=/v1/dash`}`, { headers: { authorization: 'Bearer ingestion-test-token' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain(`calls-${WS}-`);
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines[0].split(',').slice(0, 6)).toEqual(['time', 'request_id', 'method', 'host', 'path', 'status']);
    expect(lines.length).toBe(5);
    expect(lines.find((l) => l.includes(`${RUN}-dash-3`))).toContain(',503,');
    expect(lines.find((l) => l.includes('/v1/dash/4'))).toContain(`,"'=HYPERLINK(""http://x"")-${RUN}",`);
    const trail = await ok('GET', `/workspaces/${WS}/audit?action=analytics.calls.export`);
    expect((trail.items || trail)[0].summary).toBe('request log exported: 4 calls');
  });
});

describe('the AI audits', () => {
  test('an LLM audit of the extension — a generic audit event — keeps its usage and its cost, never its content', async () => {
    const received = await ingest([
      {
        '@type': 'AuditEvent',
        '@id': `ai-${RUN}`,
        '@timestamp': Date.now(),
        audit: 'LLMUsageAudit',
        provider_kind: 'openai',
        model: 'gpt-4o-mini',
        consumed_using: 'chat/completion/blocking',
        request_id: `ai-req-${RUN}`,
        usage: { prompt_tokens: 120, reasoning_tokens: 0, generation_tokens: 30 },
        // the costs of the extension are in dollars
        costs: { input_cost: 0.000018, output_cost: 0.000018, total_cost: 0.000036, currency: 'dollar' },
        input_prompt: [{ role: 'user', content: 'my secret question' }],
        output: { metadata: { usage: { prompt_tokens: 120, generation_tokens: 30 } }, generations: [{ message: { role: 'assistant', content: 'a private answer' } }] },
        apikey: { clientId: `ai-key-${RUN}`, clientSecret: 'never-stored', clientName: 'k' },
        client_ip: '203.0.113.42',
        route: { id: `route_${RUN}`, name: 'r', metadata: { 'Otoroshi-Api-Ref': apiId } },
      },
    ]);
    expect(received.ai).toBe(1);
    const [row] = await adb`select * from ai_usage where client_id = ${`ai-key-${RUN}`}`;
    expect(row).toMatchObject({ type: 'LLMUsageAudit', api_id: apiId, provider: 'openai', model: 'gpt-4o-mini' });
    expect([Number(row.input_tokens), Number(row.output_tokens), Number(row.cost_micro_usd)]).toEqual([120, 30, 36]);
    const kept = JSON.stringify(row.payload);
    for (const word of ['my secret question', 'a private answer', 'never-stored', '203.0.113.42']) expect(kept).not.toContain(word);
  });
});

describe('the attribution', () => {
  test('a security event of the Threat Protection Suite is attributed from the key that called', async () => {
    const api = await ok('GET', `/workspaces/${WS}/apis/${apiId}`);
    const planId = api.draft.plans[0].id;
    const team = (await ok('GET', `/workspaces/${WS}/teams`))[0];
    const app = await ok('POST', `/workspaces/${WS}/applications`, { name: 'Scanner', team_id: team.id });
    await ok('POST', `/workspaces/${WS}/apis/${apiId}/publish`, { comment: 'security', deploy: true });
    const sub = await ok('POST', `/workspaces/${WS}/subscriptions`, { api_id: apiId, plan_id: planId, application_id: app.id });
    await ok('POST', `/workspaces/${WS}/subscriptions/${sub.id}/resync`);
    const clientId = (await ok('GET', `/workspaces/${WS}/subscriptions/${sub.id}`)).credentials[0].client_id;
    invalidateAttributionCache();
    // the event as the extension sends it (security/events.scala): ECS-shaped, the api of the route,
    // the client id of the key that called
    const security = (id, apikey, category, action) => ({
      '@type': 'CloudApimSecurityEvent',
      '@id': id,
      '@timestamp': Date.now(),
      '@serviceId': `route_${RUN}`,
      event: { kind: 'alert', module: 'cloud-apim.security-suite', dataset: `cloud-apim.${category}`, category, action, outcome: 'failure', severity: 7 },
      source: { ip: '203.0.113.9', apikey, user: null },
      threat: { score: 42, tags: ['sqli'], signals: {} },
      otoroshi: { route_id: `route_${RUN}`, route_name: 'r', node: 'n', tenant: 'default', teams: [], api_id: apiId, groups: [] },
      incident: { id: `inc-${id}`, count: 1 },
      message: `${category}: ${action}`,
    });
    const received = await ingest([security(`sec-${RUN}-1`, clientId, 'waf', 'deny'), security(`sec-${RUN}-2`, null, 'bots', 'log')]);
    expect(received.security).toBe(2);
    const found = await ok('GET', `/workspaces/${WS}/analytics/security?api=${apiId}`);
    expect(found.total).toBe(2);
    // the key says the plan, the subscription and the application; an unidentified caller, the api only
    expect(found.items.map((e) => [e.category, e.action, e.plan_id, e.subscription_id, e.application_name, e.api_name]).sort()).toEqual([
      ['bots', 'log', null, null, null, 'Users 1.0.0'],
      ['waf', 'deny', planId, sub.id, 'Scanner', 'Users 1.0.0'],
    ]);
    expect(found.byAction.map((r) => [r.action, r.events]).sort()).toEqual([
      ['deny', 1],
      ['log', 1],
    ]);
    expect(found.byPlan.map((r) => [r.plan_id, r.plan_name, r.events]).sort()).toEqual([
      [null, null, 1],
      [planId, api.draft.plans[0].name, 1],
    ]);
    expect((await ok('GET', `/workspaces/${WS}/analytics/security?api=${apiId}&action=deny`)).items.map((e) => e.category)).toEqual(['waf']);
    // they carry the address of the caller: reading them is traced
    const trail = await ok('GET', `/workspaces/${WS}/audit?action=analytics.security.read`);
    expect((trail.items || trail).length).toBeGreaterThan(0);
  });

  test('the first calls of an api made since the attribution cache was read are attributed too', async () => {
    await ingest([event(`${RUN}-warm`)]);
    const team = (await ok('GET', `/workspaces/${WS}/teams`))[0];
    const fresh = (await ok('POST', `/workspaces/${WS}/apis`, { name: 'Fresh', version: '1.0.0', team_id: team.id, domain: `fresh-${RUN}.oto.tools`, contextPath: '/' })).id;
    await Bun.sleep(1100);
    await ingest([{ ...event(`${RUN}-fresh`), route: { id: `route_fresh_${RUN}`, name: 'r', metadata: { 'Otoroshi-Api-Ref': fresh } } }]);
    const [row] = await adb`select api_id, workspace_id from calls where req_id = ${`${RUN}-fresh`}`;
    expect(row.api_id).toBe(fresh);
    await adb`delete from calls where api_id = ${fresh}`;
    await ok('DELETE', `/workspaces/${WS}/apis/${fresh}`);
  });

  test('a call is attributed from the apiRef the gateway gives its event', async () => {
    const api = await ok('GET', `/workspaces/${WS}/apis/${apiId}`);
    const planId = api.draft.plans[0].id;
    const team = (await ok('GET', `/workspaces/${WS}/teams`))[0];
    const app = await ok('POST', `/workspaces/${WS}/applications`, { name: 'Dashboards', team_id: team.id });
    // deployed by the test before, the same draft
    await ok('POST', `/workspaces/${WS}/apis/${apiId}/publish`, { comment: 'attribution', deploy: true }).catch((e) => {
      if (!e.message.includes('-> 409')) throw e;
    });
    const sub = await ok('POST', `/workspaces/${WS}/subscriptions`, { api_id: apiId, plan_id: planId, application_id: app.id });
    invalidateAttributionCache();
    const consumer = (reqId, apiRef) => ({ ...event(reqId), identity: { identityType: 'APIKEY', identity: `key-${reqId}`, label: 'k', metadata: {}, apiRef } });
    await ingest([
      // the consumer of a subscription: the api, the plan, the subscription and its application
      consumer(`attr-${RUN}-sub`, { api: apiId, plan: planId, sub: sub.id }),
      // a consumer a keyless plan identified: no subscription, the plan still
      consumer(`attr-${RUN}-open`, { api: apiId, plan: 'plan_open', sub: '' }),
    ]);
    const rows = await adb`select req_id, plan_id, subscription_id, application_id, workspace_id from calls where api_id = ${apiId} and req_id like ${`attr-${RUN}-%`} order by req_id`;
    expect(rows.map((r) => [r.req_id, r.plan_id, r.subscription_id, r.application_id])).toEqual([
      [`attr-${RUN}-open`, 'plan_open', null, null],
      [`attr-${RUN}-sub`, planId, sub.id, app.id],
    ]);
    expect(rows[1].workspace_id).toBe(api.workspace_id);
    // the request id a caller quotes finds its call in the request log
    const { searchCalls } = await import('../server/domain/analytics.js');
    const found = await searchCalls({ workspaceId: api.workspace_id, range: '24h' }, { q: `attr-${RUN}-sub` });
    expect(found.items.map((c) => c.req_id)).toEqual([`attr-${RUN}-sub`]);
    // the api leaves the gateway, its subscription with it
    await ok('DELETE', `/workspaces/${WS}/apis/${apiId}`);
  });
});
