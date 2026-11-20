// The end of a subscription, end to end on the gateway: past its end date it expires — its key
// disabled, kept; a later date renews it with the same key; the workers expire what is due.
//
// Needs the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'expiry-test-token';

const { start } = await import('../server/main.js');
const { oto } = await import('../server/otoroshi/client.js');
const { expirySweep } = await import('../server/domain/subscriptions.js');

const RUN = Date.now().toString(36);
const WS = `expiry-${RUN}`;
const DOMAIN = `expiry-${RUN}.oto.tools`;
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api/workspaces/${WS}${path}`, {
    method,
    headers: { authorization: 'Bearer expiry-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`), { status: res.status });
  return out;
}

// the gateway takes a moment to pick up a change of a key
async function gatewayCall(wanted) {
  let last;
  for (let i = 0; i < 60; i++) {
    last = await fetch(`http://localhost:8080/`, { headers: { Host: DOMAIN, 'Otoroshi-Client-Id': state.cred.client_id, 'Otoroshi-Client-Secret': state.cred.client_secret } });
    if (wanted(last.status)) return last.status;
    await Bun.sleep(500);
  }
  return last.status;
}

beforeAll(async () => {
  server = await start();
  await fetch(`http://localhost:${config.port}/api/workspaces`, {
    method: 'POST',
    headers: { authorization: 'Bearer expiry-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Expiry ${RUN}`, slug: WS }),
  });
  const api = await call('POST', '/apis', { name: 'Tides', version: '1.0.0', domain: DOMAIN, contextPath: '/' });
  state.apiId = api.id;
  await call('POST', `/apis/${api.id}/publish`, { comment: 'expiry', deploy: true });
  const team = await call('POST', '/teams', { name: 'Harbour team' });
  const app = await call('POST', '/applications', { name: 'Harbour', team_id: team.id });
  const sub = await call('POST', '/subscriptions', { api_id: api.id, plan_id: api.draft.plans[0].id, application_id: app.id });
  state.sub = sub.id;
  state.cred = (await call('GET', `/subscriptions/${sub.id}`)).credentials[0];
});

afterAll(async () => {
  try {
    if (state.apiId) await call('DELETE', `/apis/${state.apiId}`);
    await fetch(`http://localhost:${config.port}/api/workspaces/${WS}`, { method: 'DELETE', headers: { authorization: 'Bearer expiry-test-token' } });
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('the end of a subscription', () => {
  test('a future end date changes nothing yet', async () => {
    const at = new Date(Date.now() + 30 * 86400e3).toISOString();
    const sub = await call('POST', `/subscriptions/${state.sub}/ending`, { at });
    expect(sub.status).toBe('active');
    expect(sub.dates.ending_at).toBe(at);
    expect(await gatewayCall((s) => s === 200)).toBe(200);
  });

  test('past its end date it expires: the key is disabled on the gateway, and kept', async () => {
    const sub = await call('POST', `/subscriptions/${state.sub}/ending`, { at: new Date(Date.now() - 1000).toISOString() });
    expect(sub.status).toBe('expired');
    expect((await oto.getSubscription(state.sub)).status).toBe('disabled');
    const key = await oto.getApikey(state.cred.client_id);
    expect(key.enabled).toBe(false);
    expect(await gatewayCall((s) => s !== 200)).not.toBe(200);
  });

  test('a later end date renews it, with the same key', async () => {
    const sub = await call('POST', `/subscriptions/${state.sub}/ending`, { at: null });
    expect(sub.status).toBe('active');
    expect(sub.dates.ending_at).toBeNull();
    expect(sub.dates.renewed_at).toBeTruthy();
    expect((await oto.getApikey(state.cred.client_id)).clientSecret).toBe(state.cred.client_secret);
    expect(await gatewayCall((s) => s === 200)).toBe(200);
  });

  test('the workers expire what is due', async () => {
    await call('POST', `/subscriptions/${state.sub}/ending`, { at: new Date(Date.now() + 1500).toISOString() });
    await Bun.sleep(2000);
    expect(await expirySweep()).toBeGreaterThanOrEqual(1);
    const sub = await call('GET', `/subscriptions/${state.sub}`);
    expect(sub.status).toBe('expired');
    expect(sub.dates.expired_at).toBeTruthy();
    // the trail says so
    const audit = await call('GET', `/audit?limit=50`);
    expect(audit.items.map((e) => e.action)).toEqual(expect.arrayContaining(['subscription.ending', 'subscription.expire', 'subscription.renew']));
  });

  test('an expired subscription can be closed; a closed one has no end date to set', async () => {
    const closed = await call('POST', `/subscriptions/${state.sub}/close`, {});
    expect(closed.status).toBe('closed');
    await expect(call('POST', `/subscriptions/${state.sub}/ending`, { at: null })).rejects.toThrow(/400/);
  });
});
