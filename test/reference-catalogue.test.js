// End-to-end reference test:
// the Atlas catalogue — 6 plans, 5 auth mechanisms, 4 approval modes, on a single API and a
// single set of routes — is described, projected onto a real Otoroshi `Api` entity, reconciled,
// and its drift detected.
//
// Needs the docker stack (bun run infra:up): postgres on 5442, otoroshi 18 on 8080, echo backend.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

// the gateway takes a few seconds to pick up a new route or a new key
setDefaultTimeout(40000);
import { createHmac } from 'node:crypto';

process.env.APIM_PORT = process.env.APIM_TEST_PORT || '9117';
process.env.APIM_WORKERS_ENABLED = 'false';
process.env.APIM_ADMIN_TOKEN = 'reference-test-token';

const { start } = await import('../server/main.js');
const { oto, otoroshi } = await import('../server/otoroshi/client.js');

const RUN = Date.now().toString(36);
const WS = `ref-atlas-${RUN}`;
const DOMAIN = `atlas-${RUN}.oto.tools`;
const JWT_SECRET = 'atlas-partner-secret';
const VERIFIER_ID = `l0_eu_login_${RUN}`;
const BASE = `http://localhost:${process.env.APIM_PORT}/api`;
const GATEWAY = 'http://localhost:8080';

let server;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: 'Bearer reference-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
const ws = (p) => `/workspaces/${WS}${p}`;

// the gateway takes a moment to pick up a new route or key in its proxy state
async function gatewayCall(path, { headers = {}, expect: wanted, timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fetch(`${GATEWAY}${path}`, { headers: { Host: DOMAIN, ...headers } });
    if (!wanted || wanted(last)) return last;
    await Bun.sleep(500);
  }
  return last;
}

function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const state = {};

beforeAll(async () => {
  server = await start();
  // infrastructure the plans reference but do not own (D-15): the Atlas ID provider JWT verifier
  await otoroshi('POST', '/api/verifiers', {
    _loc: { tenant: 'default', teams: ['default'] },
    type: 'global',
    id: VERIFIER_ID,
    name: 'Atlas ID (reference test)',
    desc: 'HS256 stand-in for the Atlas ID provider',
    strict: true,
    source: { type: 'InHeader', name: 'Authorization', remove: 'Bearer ' },
    algoSettings: { type: 'HSAlgoSettings', size: 256, secret: JWT_SECRET, base64: false },
    strategy: { type: 'PassThrough', verificationSettings: { fields: {}, arrayFields: {} } },
    metadata: {},
    tags: [],
  });
});

afterAll(async () => {
  try {
    if (state.apiId) await call('DELETE', ws(`/apis/${state.apiId}`));
  } catch (e) {}
  await otoroshi('DELETE', `/api/verifiers/${VERIFIER_ID}`).catch(() => null);
  server?.stop(true);
});

const perMinute = (calls) => ({ enabled: true, calls, windowMs: 60000 });

function catalogPlans() {
  return [
    {
      id: 'plan_open',
      name: 'Open',
      description: 'No account, quota per IP',
      status: 'published',
      auth: { kind: 'keyless', config: { expr: '${req.ip}', createIfMissing: false } },
      rateLimit: perMinute(120),
      visibility: 'public',
      subscribable: false,
    },
    {
      id: 'plan_starter',
      name: 'Starter',
      status: 'published',
      auth: { kind: 'apikey' },
      rateLimit: perMinute(600),
      validation: 'auto', // approval mode 1: automatic
    },
    {
      id: 'plan_research',
      name: 'Research',
      status: 'published',
      auth: { kind: 'apikey' },
      rateLimit: perMinute(1200),
      validation: 'manual', // approval mode 2: manual review
    },
    {
      id: 'plan_partner',
      name: 'Partner',
      status: 'published',
      auth: { kind: 'jwt', config: { verifier: VERIFIER_ID, clientIdPath: 'client_id' } },
      rateLimit: perMinute(10000),
      validation: 'auto', // approval mode 3: a form (usage statement + terms)
      usageStatement: { enabled: true, required: true, prompt: 'Which organisation, for what use?' },
      terms: { enabled: true, url: 'https://atlas.example/terms' },
    },
    {
      id: 'plan_bulk',
      name: 'Bulk',
      status: 'published',
      auth: { kind: 'oauth2-local', config: { defaultKeyPair: 'otoroshi-jwt-signing', expiration: 3600 } },
      rateLimit: perMinute(50000),
      validation: 'manual', // approval mode 4: a contract, out of self-service
      subscribable: false,
      terms: { enabled: true, url: 'https://example.eu/bulk-contract.pdf' },
    },
    {
      id: 'plan_internal',
      name: 'Internal',
      status: 'published',
      auth: { kind: 'mtls', config: { regexSubjectDNs: ['CN=.*\\.atlas\\.example.*'], regexIssuerDNs: [], clientIdField: 'CN' } },
      rateLimit: { enabled: false, calls: 0, windowMs: 1000 },
      visibility: 'restricted',
      acl: ['role:admin'],
      subscribable: false, // R34: never offered in self-service
    },
  ];
}

describe('reference catalogue', () => {
  test('describe: one api, one set of routes, 6 plans, 5 auth mechanisms', async () => {
    await call('POST', '/workspaces', { name: `Atlas ${RUN}`, slug: WS });
    const team = await call('POST', ws('/teams'), { name: 'Atlas Data Office' });
    state.teamId = team.id;
    const api = await call('POST', ws('/apis'), {
      name: 'Atlas',
      version: '1.0.0',
      team_id: team.id,
      domain: DOMAIN,
      contextPath: '/',
      tags: ['open-data', 'reference'],
      withDefaultPlan: false,
    });
    state.apiId = api.id;
    const draft = api.draft;
    const backend = draft.backends[0];
    const flow = draft.flows[0];
    draft.resources = [
      { id: 'res_search', name: 'Search', path: '/search', methods: ['GET'], backendId: backend.id, flowId: flow.id },
      { id: 'res_documents', name: 'Documents', path: '/documents', methods: ['GET'], backendId: backend.id, flowId: flow.id },
      { id: 'res_archive', name: 'Archive', path: '/archive', methods: [], backendId: backend.id, flowId: flow.id },
    ];
    draft.plans = catalogPlans();
    const saved = await call('PUT', ws(`/apis/${api.id}/draft`), { draft });
    expect(saved.validation.errors).toEqual([]);
    const kinds = new Set(saved.draft.plans.map((p) => p.auth.kind));
    expect(saved.draft.plans.length).toBe(6);
    expect(kinds.size).toBe(5);
    // the abstraction does not lie: the gaps of the data plane are surfaced, not hidden
    expect(saved.validation.warnings.some((w) => w.code === 'any_token_passes')).toBe(true);
    // effective resolution order: credential based kinds first, keyless last (ADR-10)
    const order = saved.resolution_order.map((o) => o.kind);
    expect(order[order.length - 1]).toBe('keyless');
    expect(order.indexOf('apikey')).toBeLessThan(order.indexOf('jwt'));
  });

  test('project: publish a snapshot and deploy it as a catalog-marked Api entity', async () => {
    const res = await call('POST', ws(`/apis/${state.apiId}/publish`), { comment: 'Atlas catalogue', deploy: true });
    expect(res.snapshot.number).toBe(1);
    expect(res.deployment.deployment.status).toBe('deployed');
    const entity = await oto.getApi(state.apiId);
    expect(entity).toBeTruthy();
    expect(entity.state).toBe('published');
    expect(entity.metadata.created_by).toBe('remote_catalog=otoroshi-apim-deployment');
    expect(entity.metadata.apim_snapshot_id).toBe(res.snapshot.id);
    expect(entity.routes.length).toBe(3); // one set of routes for every plan
    expect(entity.plans.map((p) => p.access_mode_configuration_type).sort()).toEqual(['apikey', 'apikey', 'jwt', 'keyless', 'mtls', 'oauth2-local']);
    const starter = entity.plans.find((p) => p.id === 'plan_starter');
    expect(starter.rate_limiting.strategy.quota.window).toBe(600);
    expect(starter.rate_limiting.strategy.windowDurationMs).toBe(60000);
    // otoroshi records the catalog write in its own deployment history (D-38)
    expect(entity.deployments.length).toBeGreaterThanOrEqual(1);
    // selective synchronisation (D-2): neither documentation nor portal options reach the gateway
    expect(entity.documentation).toBeNull();
    expect(JSON.stringify(entity)).not.toContain('Which institution');
  });

  test('approval 1 — automatic: Starter issues a key at once, and it works on the gateway', async () => {
    const app = await call('POST', ws('/applications'), { name: 'Data journalism startup', team_id: state.teamId });
    state.appId = app.id;
    const sub = await call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_starter', application_id: app.id });
    expect(sub.status).toBe('active');
    const full = await call('GET', ws(`/subscriptions/${sub.id}`));
    expect(full.projection.status).toBe('synced');
    expect(full.credentials.length).toBe(1);
    state.starterSub = sub.id;
    state.cred = full.credentials[0];
    const key = await oto.getApikey(state.cred.client_id);
    expect(key.enabled).toBe(true);
    expect(key.apiRef).toEqual({ api: state.apiId, plan: 'plan_starter', sub: sub.id });
    expect(key.metadata.id_ref).toBe(app.id); // the application, projected (D-26)
    const res = await gatewayCall('/search?q=gdpr', {
      headers: { 'Otoroshi-Client-Id': state.cred.client_id, 'Otoroshi-Client-Secret': state.cred.client_secret },
      expect: (r) => r.status === 200,
    });
    expect(res.status).toBe(200);
  });

  test('open tier: without any credential the keyless plan serves the caller', async () => {
    const res = await gatewayCall('/search?q=open', { expect: (r) => r.status === 200 });
    expect(res.status).toBe(200);
  });

  test('approval 2 — manual: Research waits for a producer, nothing is projected before', async () => {
    const app = await call('POST', ws('/applications'), { name: 'City university', team_id: state.teamId });
    const sub = await call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_research', application_id: app.id });
    expect(sub.status).toBe('pending');
    // Otoroshi 18 would enable the key of a pending subscription: it is never projected
    expect(await oto.getSubscription(sub.id)).toBeNull();
    const accepted = await call('POST', ws(`/subscriptions/${sub.id}/accept`), { message: 'welcome' });
    expect(accepted.status).toBe('active');
    expect(await oto.getSubscription(sub.id)).toBeTruthy();
  });

  test('approval 3 — form: Partner requires a usage statement and the terms', async () => {
    const app = await call('POST', ws('/applications'), { name: 'Regional agency', team_id: state.teamId, client_id: 'agency-north' });
    await expect(call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_partner', application_id: app.id })).rejects.toThrow(/usage/);
    await expect(
      call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_partner', application_id: app.id, usage: 'reference data for our public dashboards' })
    ).rejects.toThrow(/terms/);
    const sub = await call('POST', ws('/subscriptions'), {
      api_id: state.apiId,
      plan_id: 'plan_partner',
      application_id: app.id,
      usage: 'reference data for our public dashboards',
      terms_accepted: true,
    });
    expect(sub.status).toBe('active');
    expect(sub.request.usage).toBe('reference data for our public dashboards');
    // the jwt consumer calls with its own token, identified by the client_id of the application
    const res = await gatewayCall('/documents/2026-0042', { headers: { Authorization: `Bearer ${jwt({ client_id: 'agency-north' })}` }, expect: (r) => r.status === 200 });
    expect(res.status).toBe(200);
  });

  test('approval 4 — contract: Bulk is out of self-service, a producer puts the consumer on it', async () => {
    const app = await call('POST', ws('/applications'), { name: 'Data broker', team_id: state.teamId });
    // a consumer cannot request it (see the portal test); a producer can, under contract
    const sub = await call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_bulk', application_id: app.id, terms_accepted: true });
    expect(sub.status).toBe('pending');
    const accepted = await call('POST', ws(`/subscriptions/${sub.id}/accept`), { message: 'contract #2026-114 signed' });
    expect(accepted.status).toBe('active');
    const full = await call('GET', ws(`/subscriptions/${sub.id}`));
    expect(full.credentials[0].kind).toBe('client_credentials');
  });

  test('a consumer cannot self-subscribe to a contract or internal plan', async () => {
    const consumer = await call('POST', '/users', { email: `consumer-${RUN}@example.com`, password: 'consumer-password', name: 'Consumer' });
    await call('POST', ws('/members'), { user_id: consumer.id, role: 'consumer' });
    // log into the portal of the workspace as that consumer
    const portal = `http://localhost:${process.env.APIM_PORT}/${WS}/front/api`;
    const login = await fetch(`${portal}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: consumer.email, password: 'consumer-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const h = { cookie, 'content-type': 'application/json' };
    const app = await (await fetch(`${portal}/applications`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'my app' }) })).json();
    for (const plan of ['plan_bulk', 'plan_internal']) {
      const r = await fetch(`${portal}/subscriptions`, { method: 'POST', headers: h, body: JSON.stringify({ api_id: state.apiId, plan_id: plan, application_id: app.id }) });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    // the internal tier is not even visible to a consumer (restricted visibility, never projected)
    const view = await (await fetch(`${portal}/apis/${state.apiId}`, { headers: h })).json();
    expect(view.plans.map((p) => p.id)).not.toContain('plan_internal');
    // the contract tier is shown in the catalogue, but marked out of self-service
    expect(view.plans.find((p) => p.id === 'plan_bulk').subscribable).toBe(false);
    const r = await fetch(`${portal}/subscriptions`, { method: 'POST', headers: h, body: JSON.stringify({ api_id: state.apiId, plan_id: 'plan_starter', application_id: app.id }) });
    expect(r.status).toBe(200);
  });

  test('reconcile: drift on the gateway is detected, then repaired by redeploying the snapshot', async () => {
    let report = (await call('POST', ws('/drift'))) && (await call('GET', ws(`/apis/${state.apiId}/projection`))).drift;
    expect(report.status).toBe('in_sync');
    // someone edits the projected entity by hand in Otoroshi
    const entity = await oto.getApi(state.apiId);
    entity.plans = entity.plans.map((p) => (p.id === 'plan_starter' ? { ...p, rate_limiting: { strategy: { ...p.rate_limiting.strategy, quota: { ...p.rate_limiting.strategy.quota, window: 999999 } } } } : p));
    entity.routes = entity.routes.map((r) => (r.id === 'res_search' ? { ...r, frontend: { ...r.frontend, methods: ['GET', 'POST'] } } : r));
    await otoroshi('PUT', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`, entity);
    await call('POST', ws('/drift'));
    report = (await call('GET', ws(`/apis/${state.apiId}/projection`))).drift;
    expect(report.status).toBe('drifted');
    const paths = report.diff.map((d) => d.path).join(' ');
    expect(paths).toContain('plans');
    expect(paths).toContain('routes');
    // reconciliation: redeploy the running snapshot, idempotently
    const dry = await call('POST', ws(`/apis/${state.apiId}/deploy`), { dry_run: true });
    expect(dry.gatewayChanges.length).toBeGreaterThan(0);
    await call('POST', ws(`/apis/${state.apiId}/deploy`), {});
    await call('POST', ws('/drift'));
    report = (await call('GET', ws(`/apis/${state.apiId}/projection`))).drift;
    expect(report.status).toBe('in_sync');
    const again = await call('POST', ws(`/apis/${state.apiId}/deploy`), { dry_run: true });
    expect(again.gatewayChanges).toEqual([]);
  });

  test('a key changed on the gateway is drift too', async () => {
    const key = await oto.getApikey(state.cred.client_id);
    await otoroshi('PUT', `/api/apikeys/${key.clientId}`, { ...key, enabled: false });
    await call('POST', ws('/drift'));
    const sub = await call('GET', ws(`/subscriptions/${state.starterSub}`));
    expect(sub.drift.status).toBe('drifted');
    await call('POST', ws(`/subscriptions/${state.starterSub}/resync`));
    expect((await oto.getApikey(state.cred.client_id)).enabled).toBe(true);
  });

  test('transfer (D-30): Starter -> Research keeps the key; apikey -> jwt is refused', async () => {
    await expect(call('POST', ws(`/subscriptions/${state.starterSub}/transfer`), { plan_id: 'plan_partner' })).rejects.toThrow(/not equivalent/);
    const moved = await call('POST', ws(`/subscriptions/${state.starterSub}/transfer`), { plan_id: 'plan_research' });
    expect(moved.plan_id).toBe('plan_research');
    expect(moved.history.length).toBe(1);
    const key = await oto.getApikey(state.cred.client_id);
    expect(key.clientSecret).toBe(state.cred.client_secret);
    expect(key.apiRef.plan).toBe('plan_research');
    expect(key.throttlingStrategy.quota.window).toBe(1200);
  });

  test('closing a subscription revokes its key on the gateway', async () => {
    await call('POST', ws(`/subscriptions/${state.starterSub}/close`));
    expect(await oto.getApikey(state.cred.client_id)).toBeNull();
    expect(await oto.getSubscription(state.starterSub)).toBeNull();
  });

  test('every action is audited', async () => {
    const events = await call('GET', ws('/audit?limit=200'));
    const actions = new Set(events.map((e) => e.action));
    for (const a of ['api.create', 'api.publish', 'api.deploy', 'subscription.request', 'subscription.accept', 'subscription.transfer', 'subscription.close']) {
      expect(actions.has(a)).toBe(true);
    }
  });
});
