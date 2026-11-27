// The usage a consumer sees on the portal, against a real server: the keys of its applications and
// the usage of one of them — never the key of someone else —, and how far back it goes: the history
// of the portal, 90 days unless its workspace says otherwise, never beyond what the rollups keep.
//
// Needs the docker stack (mise run up): the apis are deployed, the subscriptions projected.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'portal-usage-token';

const { start } = await import('../server/main.js');
const { db, adb } = await import('../server/db/index.js');
const { invalidateAttributionCache } = await import('../server/domain/ingest.js');
const { policy } = await import('../server/domain/ingest-policy.js');

const RUN = Date.now().toString(36);
const WS = `portal-usage-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const PASSWORD = 'a-long-enough-password';
const people = { alice: `alice-${RUN}@usage.test`, bob: `bob-${RUN}@usage.test` };
const DAY = 86400e3;
let server;
const state = { cookies: {} };

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer portal-usage-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
// the portal, as one of its people
async function portal(who, method, path, body) {
  const res = await fetch(`${ROOT}/${WS}/front/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: state.cookies[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function anApi(team, name) {
  const api = await ok('POST', `/workspaces/${WS}/apis`, { name, version: '1.0.0', team_id: team.id, domain: `${name.toLowerCase()}-${RUN}.oto.tools`, contextPath: '/' });
  const draft = api.draft;
  draft.plans = [{ ...draft.plans[0], status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  await ok('PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok('POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'first', deploy: true });
  return { id: api.id, plan: draft.plans[0].id };
}

// the calls of a key, as the data exporter of the gateway sends them: the key names its subscription
async function callsOf(api, sub, n) {
  const clientId = sub.client_ids[0];
  const events = Array.from({ length: n }, (_, i) => ({
    '@type': 'GatewayEvent',
    '@id': `evt-${sub.id}-${i}`,
    '@timestamp': Date.now(),
    reqId: `${RUN}-${sub.id}-${i}`,
    url: `http://usage-${RUN}.oto.tools/items/${i}`,
    method: 'GET',
    status: 200,
    duration: 10,
    overhead: 1,
    data: { dataIn: 10, dataOut: 100 },
    identity: { identityType: 'APIKEY', identity: clientId, apiRef: { api: api.id, plan: api.plan, sub: sub.id } },
    route: { id: `route_${RUN}`, name: 'r', metadata: { 'Otoroshi-Api-Ref': api.id } },
  }));
  const res = await fetch(`${ROOT}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${config.ingest.token}` }, body: events.map((e) => JSON.stringify(e)).join('\n') });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Portal usage ${RUN}`, slug: WS });
  const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Makers' });
  state.atlas = await anApi(team, 'Atlas');
  state.beacon = await anApi(team, 'Beacon');
  for (const [who, email] of Object.entries(people)) {
    await ok('POST', `/workspaces/${WS}/members`, { email, name: who, password: PASSWORD, role: 'consumer' });
    const login = await fetch(`${ROOT}/${WS}/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    state.cookies[who] = login.headers.get('set-cookie').split(';')[0];
  }
  // alice calls both apis, each with the key of its subscription
  state.app = (await portal('alice', 'POST', '/applications', { name: 'Alice app' })).body;
  for (const api of [state.atlas, state.beacon]) {
    const sub = await portal('alice', 'POST', '/subscriptions', { api_id: api.id, plan_id: api.plan, application_id: state.app.id });
    expect(sub.body.status).toBe('active');
  }
  invalidateAttributionCache();
});

afterAll(async () => {
  try {
    for (const a of [state.atlas, state.beacon]) if (a) await adb`delete from calls where api_id = ${a.id}`;
    for (const a of [state.atlas, state.beacon]) if (a) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await db`delete from applications where workspace_id = (select id from workspaces where slug = ${WS})`;
    await call('DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email in ${db(Object.values(people))}`) {
      for (const t of ['sessions', 'team_members', 'workspace_members', 'notification_states', 'api_tokens']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from teams where personal = true and id not in (select team_id from team_members)`.catch(() => null);
      await db`delete from users where id = ${u.id}`.catch(() => null);
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('the usage of one key', () => {
  test('a consumer lists the keys of its applications, and filters its usage on one of them', async () => {
    const keys = (await portal('alice', 'GET', '/subscriptions')).body;
    expect(keys.map((k) => k.api_id).sort()).toEqual([state.atlas.id, state.beacon.id].sort());
    expect(keys.every((k) => k.application_name === 'Alice app' && k.client_ids.length === 1)).toBe(true);
    // client ids, never a secret
    expect(JSON.stringify(keys)).not.toContain('secret');
    expect((await portal('bob', 'GET', '/subscriptions')).body).toEqual([]);
    state.atlasKey = keys.find((k) => k.api_id === state.atlas.id);
    state.beaconKey = keys.find((k) => k.api_id === state.beacon.id);
    await callsOf(state.atlas, state.atlasKey, 3);
    await callsOf(state.beacon, state.beaconKey, 2);

    const from = new Date(Date.now() - 3600e3).toISOString();
    const usage = async (sub) => (await portal('alice', 'GET', `/analytics?from=${from}${sub ? `&subscription=${sub}` : ''}`)).body.totals.calls;
    expect(await usage()).toBe(5);
    expect(await usage(state.atlasKey.id)).toBe(3);
    expect(await usage(state.beaconKey.id)).toBe(2);
    expect((await portal('alice', 'GET', `/analytics/calls?from=${from}&subscription=${state.atlasKey.id}`)).body.total).toBe(3);
    // the key of someone else is not to be read
    expect((await portal('bob', 'GET', `/analytics?from=${from}&subscription=${state.atlasKey.id}`)).status).toBe(403);
    expect((await portal('bob', 'GET', `/analytics/calls?from=${from}&subscription=${state.atlasKey.id}`)).status).toBe(403);
  });
});

describe('the history of the portal', () => {
  const since = async (days) => new Date((await portal('alice', 'GET', `/analytics?from=${new Date(Date.now() - days * DAY).toISOString()}`)).body.range.from).getTime();
  const historyOf = async () => (await (await fetch(`${ROOT}/${WS}/front/api/portal`)).json()).portal.usageHistoryDays;

  test('90 days unless the workspace says otherwise: a range that starts earlier starts there', async () => {
    expect(await historyOf()).toBe(90);
    // the first whole day of the range, at most a day before
    expect(await since(200)).toBeGreaterThanOrEqual(Date.now() - 91 * DAY);
  });

  test('set per portal, up to what the rollups keep', async () => {
    const kept = (await policy()).retention.rollupsDays;
    expect((await call('PUT', `/workspaces/${WS}`, { portal: { usageHistoryDays: 0 } })).status).toBe(400);
    const over = await call('PUT', `/workspaces/${WS}`, { portal: { usageHistoryDays: kept + 1 } });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain(`from 1 to ${kept}`);
    const days = Math.min(365, kept);
    expect((await ok('PUT', `/workspaces/${WS}`, { portal: { usageHistoryDays: days } })).portal.usageHistoryDays).toBe(days);
    expect(await historyOf()).toBe(days);
    const from = await since(days + 100);
    expect(from).toBeGreaterThanOrEqual(Date.now() - (days + 1) * DAY);
    expect(from).toBeLessThan(Date.now() - (days - 1) * DAY);
    // none: the default again
    await ok('PUT', `/workspaces/${WS}`, { portal: { usageHistoryDays: null } });
    expect(await historyOf()).toBe(90);
  });
});
