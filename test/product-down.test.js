// The product is never in the request path. Two incidents, against a real stack:
//  - the gateway is unreachable: the portal still serves its catalogue, the console still reads,
//    and a subscription created meanwhile waits, then reaches the gateway once it is back;
//  - the product is down, its processes and its databases: the traffic flows as described, quotas
//    included, and an Otoroshi administrator takes the configuration over by hand with Otoroshi
//    alone — which is what uninstalling the product leaves. Back, the product reports what changed
//    while it was away, and repairs it on demand.
//
// Needs the docker stack (mise run up). The test stops the product container and postgres, and
// starts them again.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'product-down-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { gatewaySettings, invalidateGatewaySettings } = await import('../server/otoroshi/client.js');
const { workOnce } = await import('../server/domain/tasks.js');

const RUN = Date.now().toString(36);
const WS = `down-${RUN}`;
const DOMAIN = `down-${RUN}.oto.tools`;
const ROOT = `http://localhost:${config.port}`;
const JWT_SECRET = 'product-down-secret';
const ISSUER = 'https://id.down.example';
const COMPOSE = ['docker', 'compose', '-f', new URL('../docker/docker-compose.yml', import.meta.url).pathname, '--profile', 'apim'];

let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, {
    method,
    headers: { authorization: 'Bearer product-down-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const ws = (p) => `/workspaces/${WS}${p}`;

// the Otoroshi admin api reached directly, as an Otoroshi administrator would: nothing of the
// product is involved (the product's own client reads its settings from the database)
let gw;
async function otoroshiAdmin(method, path, body) {
  const res = await fetch(`${gw.url}${path}`, {
    method,
    headers: { Host: gw.host, Authorization: 'Basic ' + btoa(`${gw.clientId}:${gw.clientSecret}`), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`otoroshi ${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// the gateway takes a moment to pick up a change in its proxy state
async function gatewayCall(path, { headers = {}, expect: wanted, timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fetch(`http://localhost:8080${path}`, { headers: { Host: DOMAIN, ...headers } });
    if (!wanted || wanted(last)) return last;
    await Bun.sleep(500);
  }
  return last;
}
const withKey = (c) => ({ 'Otoroshi-Client-Id': c.client_id || c.clientId, 'Otoroshi-Client-Secret': c.client_secret || c.clientSecret });

function jwt(claims, secret = JWT_SECRET) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, iss: ISSUER, ...claims });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

function compose(...args) {
  const r = Bun.spawnSync([...COMPOSE, ...args], { stderr: 'pipe', stdout: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`docker compose ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
const running = (service) => compose('ps', '--status', 'running', '--services').split('\n').includes(service);

// a closed port answers at once: nothing listens
function listening(port) {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port }, () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
}

async function until(fn, { timeoutMs = 60000, everyMs = 500 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(everyMs);
  }
  throw new Error(`timed out: ${last?.message || last}`);
}

async function databaseBack() {
  if (!running('postgres')) compose('start', 'postgres');
  await until(async () => (await db`select 1 as ok`)[0].ok === 1);
}

const plans = () => [
  { id: 'plan_standard', name: 'Standard', status: 'published', auth: { kind: 'apikey' }, rateLimit: { enabled: true, calls: 1000, windowMs: 60000 }, validation: 'auto' },
  { id: 'plan_trial', name: 'Trial', status: 'published', auth: { kind: 'apikey' }, rateLimit: { enabled: true, calls: 3, windowMs: 60000 }, validation: 'auto' },
  {
    id: 'plan_partner',
    name: 'Partner',
    status: 'published',
    auth: { kind: 'jwt', config: { clientIdPath: 'client_id', derive: { enabled: true, kind: 'hmac', secret: JWT_SECRET, size: 256, issuer: ISSUER } } },
    rateLimit: { enabled: true, calls: 1000, windowMs: 60000 },
    validation: 'auto',
  },
];

async function subscribe(name, planId, extra = {}) {
  const app = await call('POST', ws('/applications'), { name, team_id: state.teamId, ...extra });
  const sub = await call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: planId, application_id: app.id });
  return { app, sub, full: await call('GET', ws(`/subscriptions/${sub.id}`)) };
}

beforeAll(async () => {
  gw = { ...(await gatewaySettings()) };
  // this test is the only instance of the product: the product container would otherwise work on
  // the same queue, and project what the test expects to wait
  state.apimWasRunning = running('apim');
  if (state.apimWasRunning) compose('stop', 'apim');
  server = await start();

  await call('POST', '/workspaces', { name: `Product down ${RUN}`, slug: WS });
  state.teamId = (await call('POST', ws('/teams'), { name: 'Operations' })).id;
  const api = await call('POST', ws('/apis'), { name: 'Weather', version: '1.0.0', team_id: state.teamId, domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
  state.apiId = api.id;
  const draft = api.draft;
  draft.resources = [{ id: 'res_forecast', name: 'Forecast', path: '/forecast', methods: ['GET'], backendId: draft.backends[0].id, flowId: draft.flows[0].id }];
  draft.plans = plans();
  await call('PUT', ws(`/apis/${api.id}/draft`), { draft });
  await call('POST', ws(`/apis/${api.id}/publish`), { comment: 'first', deploy: true });

  const standard = await subscribe('Dashboard', 'plan_standard');
  state.standard = standard.full.credentials[0];
  const trial = await subscribe('Prototype', 'plan_trial');
  state.trial = trial.full.credentials[0];
  await subscribe('Partner portal', 'plan_partner', { client_id: `partner-${RUN}` });
  const res = await gatewayCall('/forecast', { headers: withKey(state.standard), expect: (r) => r.status === 200 });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  try {
    config.otoroshi.url = gw.url;
    invalidateGatewaySettings();
    await databaseBack();
    if (!(await listening(config.port))) server = await start();
    // what an administrator created by hand on the gateway is not the product's to delete: the test
    // removes its own subscription, and Otoroshi its key with it
    if (state.handSub) await otoroshiAdmin('DELETE', `/apis/apis.otoroshi.io/v1/apisubscriptions/${state.handSub}`);
    if (state.handKey) expect(await otoroshiAdmin('GET', `/api/apikeys/${state.handKey}`)).toBeNull();
    for (const s of (await call('GET', ws('/subscriptions'))).items || []) if (['active', 'suspended'].includes(s.status)) await call('POST', ws(`/subscriptions/${s.id}/close`), {});
    if (state.apiId) await call('DELETE', ws(`/apis/${state.apiId}`));
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  } finally {
    server?.stop(true);
    if (state.apimWasRunning && !running('apim')) compose('start', 'apim');
  }
});

describe('the gateway is unreachable', () => {
  test('the portal serves its catalogue, the console reads, nothing waits on the gateway', async () => {
    config.otoroshi.url = 'http://127.0.0.1:9';
    invalidateGatewaySettings();
    const status = await call('GET', '/gateway/status');
    expect(status.health.ok).toBe(false);
    // the catalogue of the portal, anonymous
    const catalogue = await (await fetch(`${ROOT}/${WS}/front/api/apis`)).json();
    expect(catalogue.map((a) => a.id)).toContain(state.apiId);
    const page = await (await fetch(`${ROOT}/${WS}/front/api/apis/${state.apiId}`)).json();
    expect(page.plans.map((p) => p.id).sort()).toEqual(['plan_partner', 'plan_standard', 'plan_trial']);
    // the console
    expect((await call('GET', ws(`/apis/${state.apiId}`))).name).toBe('Weather');
  });

  test('a subscription created meanwhile waits, and reaches the gateway once it is back', async () => {
    const { sub, full } = await subscribe('Created during the incident', 'plan_standard');
    // accepted by the product, not projected
    expect(sub.status).toBe('active');
    expect(full.projection.status).toBe('error');
    expect(full.projection.error).toContain('unreachable');
    expect(full.credentials).toEqual([]);
    const tasks = await call('GET', `/gateway/tasks?status=pending&q=${sub.id}`);
    expect(tasks.total).toBe(1);
    // the gateway is back: the queue replays the projection, as the workers do
    config.otoroshi.url = gw.url;
    invalidateGatewaySettings();
    const synced = await until(async () => {
      await workOnce();
      const s = await call('GET', ws(`/subscriptions/${sub.id}`));
      return s.projection.status === 'synced' && s.credentials.length ? s : null;
    });
    const res = await gatewayCall('/forecast', { headers: withKey(synced.credentials[0]), expect: (r) => r.status === 200 });
    expect(res.status).toBe(200);
  });
});

describe('the product is down', () => {
  test('nothing of the product answers: its servers and its databases are stopped', async () => {
    server.stop(true);
    compose('stop', 'postgres');
    expect(await listening(config.port)).toBe(false);
    expect(await listening(9000)).toBe(false);
    expect(await listening(5442)).toBe(false);
  });

  test('the traffic flows as described: keys, tokens and the derived verifier', async () => {
    expect((await gatewayCall('/forecast', { headers: withKey(state.standard) })).status).toBe(200);
    expect((await gatewayCall('/forecast')).status).toBe(401);
    expect((await gatewayCall('/forecast', { headers: { Authorization: `Bearer ${jwt({ client_id: `partner-${RUN}` })}` } })).status).toBe(200);
    expect((await gatewayCall('/forecast', { headers: { Authorization: `Bearer ${jwt({ client_id: `partner-${RUN}` }, 'not-the-secret')}` } })).status).toBe(401);
  });

  test('the quotas of the plans are enforced by the gateway alone', async () => {
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await gatewayCall('/forecast', { headers: withKey(state.trial) })).status);
    expect(statuses).toContain(200);
    expect(statuses).toContain(429);
  });

  test('an Otoroshi administrator takes the configuration over by hand, with Otoroshi alone', async () => {
    // revoke a key, and give it back
    const key = await otoroshiAdmin('GET', `/api/apikeys/${state.standard.client_id}`);
    await otoroshiAdmin('PUT', `/api/apikeys/${key.clientId}`, { ...key, enabled: false });
    expect((await gatewayCall('/forecast', { headers: withKey(state.standard), expect: (r) => r.status === 401 })).status).toBe(401);
    await otoroshiAdmin('PUT', `/api/apikeys/${key.clientId}`, { ...key, enabled: true });
    expect((await gatewayCall('/forecast', { headers: withKey(state.standard), expect: (r) => r.status === 200 })).status).toBe(200);

    // subscribe a new consumer: Otoroshi mints its key from the plan
    state.handSub = `hand_${RUN}`;
    await otoroshiAdmin('POST', '/apis/apis.otoroshi.io/v1/apisubscriptions', {
      _loc: { tenant: 'default', teams: ['default'] },
      id: state.handSub,
      name: 'Subscribed by hand',
      description: '',
      tags: [],
      metadata: {},
      status: 'enabled',
      dates: {},
      owner_ref: 'an-otoroshi-administrator',
      plan_ref: 'plan_standard',
      api_ref: state.apiId,
      payment_ref: {},
      subscription_kind: 'apikey',
      token_refs: [],
    });
    const handSub = await otoroshiAdmin('GET', `/apis/apis.otoroshi.io/v1/apisubscriptions/${state.handSub}`);
    state.handKey = handSub.token_refs[0].apikey;
    const handKey = await otoroshiAdmin('GET', `/api/apikeys/${state.handKey}`);
    expect(handKey.apiRef).toEqual({ api: state.apiId, plan: 'plan_standard', sub: state.handSub });
    expect((await gatewayCall('/forecast', { headers: withKey(handKey), expect: (r) => r.status === 200 })).status).toBe(200);

    // change the offer: the quota of a plan reaches the keys of its subscriptions
    const api = await otoroshiAdmin('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`);
    api.plans = api.plans.map((p) =>
      p.id === 'plan_standard' ? { ...p, rate_limiting: { ...p.rate_limiting, strategy: { ...p.rate_limiting.strategy, quota: { ...p.rate_limiting.strategy.quota, window: 2000 } } } } : p
    );
    await otoroshiAdmin('PUT', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`, api);
    const updated = await until(async () => {
      const k = await otoroshiAdmin('GET', `/api/apikeys/${state.standard.client_id}`);
      return k.throttlingStrategy?.quota?.window === 2000 ? k : null;
    });
    expect(updated.enabled).toBe(true);
    expect((await gatewayCall('/forecast', { headers: withKey(state.standard), expect: (r) => r.status === 200 })).status).toBe(200);

    // make the Api an ordinary Otoroshi one: without the marker of the product, Otoroshi no longer
    // takes its writes for deploys of an api managed as code, and manages it through its own draft and deploy
    const marked = await otoroshiAdmin('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`);
    const { created_by, ...metadata } = marked.metadata;
    expect(created_by).toBe('external=otoroshi-api-management');
    await otoroshiAdmin('PUT', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`, { ...marked, metadata });
    const released = await otoroshiAdmin('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`);
    expect(released.metadata.created_by).toBeUndefined();
    expect(released.state).toBe('published');
    expect((await gatewayCall('/forecast', { headers: withKey(state.standard) })).status).toBe(200);
  });

  test('back, the product reports what changed while it was away, and repairs it on demand', async () => {
    await databaseBack();
    server = await start();
    await call('POST', ws('/drift'));
    const drifted = (await call('GET', ws(`/apis/${state.apiId}/projection`))).drift;
    expect(drifted.status).toBe('drifted');
    const paths = drifted.diff.map((d) => d.path).join(' ');
    expect(paths).toContain('plans');
    expect(paths).toContain('owner_marker');
    await call('POST', ws(`/apis/${state.apiId}/deploy`), {});
    await call('POST', ws('/drift'));
    expect((await call('GET', ws(`/apis/${state.apiId}/projection`))).drift.status).toBe('in_sync');
    expect((await otoroshiAdmin('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`)).metadata.created_by).toBe('external=otoroshi-api-management');
    // what was created by hand is not the product's: it is left alone
    expect(await otoroshiAdmin('GET', `/apis/apis.otoroshi.io/v1/apisubscriptions/${state.handSub}`)).toBeTruthy();
    expect((await otoroshiAdmin('GET', `/api/apikeys/${state.handKey}`)).enabled).toBe(true);
  });
});
