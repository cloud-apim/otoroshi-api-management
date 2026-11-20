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

  test('the settings are checked', async () => {
    const res = await fetch(`${ROOT}/api/settings/ingest`, { method: 'PUT', headers: { authorization: 'Bearer ingestion-test-token', 'content-type': 'application/json' }, body: JSON.stringify({ retention: { callsDays: 0 } }) });
    expect(res.status).toBe(400);
  });
});

describe('the attribution', () => {
  test('a call is attributed from the apiRef the gateway gives its event', async () => {
    const api = await ok('GET', `/workspaces/${WS}/apis/${apiId}`);
    const planId = api.draft.plans[0].id;
    const team = (await ok('GET', `/workspaces/${WS}/teams`))[0];
    const app = await ok('POST', `/workspaces/${WS}/applications`, { name: 'Dashboards', team_id: team.id });
    await ok('POST', `/workspaces/${WS}/apis/${apiId}/publish`, { comment: 'attribution', deploy: true });
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
