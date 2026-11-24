// One API key for every API of an application (R-12, D-31): its subscriptions to apikey plans share
// the credential of the application — one client id, one secret — each through an alias key of its
// own on the gateway, with the quotas of its own plan. The identity is grouped, the counters never.
//
// Needs the docker stack (mise run up): the gateway serves the calls.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'shared-credential-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { oto } = await import('../server/otoroshi/client.js');
const { checkSubscription } = await import('../server/otoroshi/drift.js');

const RUN = Date.now().toString(36);
const WS = `shared-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const GATEWAY = process.env.OTOROSHI_GATEWAY || 'http://localhost:8080';
let server;
const ids = {};
const apis = {};

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer shared-credential-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// an api with apikey plans, deployed
async function makeApi(name, planNames = ['Default']) {
  const domain = `${name}-${RUN}.oto.tools`;
  const api = await ok('POST', `/workspaces/${WS}/apis`, { name: `${name} ${RUN}`, version: '1.0.0', domain, contextPath: '/' });
  const draft = api.draft;
  const first = draft.plans[0];
  draft.plans = planNames.map((n, i) => (i === 0 ? { ...first, name: n } : { ...first, id: `plan_${name}_${i}_${RUN}`, name: n }));
  await ok('PUT', `/workspaces/${WS}/apis/${api.id}/draft`, draft);
  await ok('POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'shared credential', deploy: true });
  return { id: api.id, domain, plans: draft.plans.map((p) => p.id) };
}

const gw = async (api, id, secret) => (await fetch(`${GATEWAY}/anything`, { headers: { host: api.domain, authorization: 'Basic ' + btoa(`${id}:${secret}`) } })).status;
// the gateway serves a key a few seconds after it is written (its proxy state)
async function until(fn, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return true;
    await Bun.sleep(400);
  }
  return false;
}
const subscribe = (api, plan = api.plans[0]) => ok('POST', `/workspaces/${WS}/subscriptions`, { api_id: api.id, plan_id: plan, application_id: ids.app });
const view = (id) => ok('GET', `/workspaces/${WS}/subscriptions/${id}`);
const aliasOf = async (subId) => ((await oto.getSubscription(subId))?.token_refs || []).find((r) => !r.shared)?.apikey;

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Shared ${RUN}`, slug: WS });
  apis.a = await makeApi('orders', ['Default', 'Second']);
  apis.b = await makeApi('parcels');
  apis.c = await makeApi('invoices');
  const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Logistics' });
  ids.app = (await ok('POST', `/workspaces/${WS}/applications`, { name: 'Logistics hub', team_id: team.id, shared_credential: true })).id;
});

afterAll(async () => {
  try {
    // the last test deletes the workspace itself
    const left = (await call('GET', `/workspaces/${WS}/apis`)).body;
    for (const a of Array.isArray(left) ? left : []) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await call('DELETE', `/workspaces/${WS}`);
    if (ids.credential && (await oto.getApikey(ids.credential))) await oto.deleteApikey(ids.credential);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('one key for every api of an application', () => {
  test('its subscriptions to apikey plans share the credential of the application, each with an alias of its own', async () => {
    const a = await subscribe(apis.a);
    const b = await subscribe(apis.b);
    ids.a = a.id;
    ids.b = b.id;
    expect([a.shares_credential, b.shares_credential]).toEqual([true, true]);
    const [va, vb] = [await view(a.id), await view(b.id)];
    // the consumer sees one credential, the same on both, and with how many subscriptions it is shared
    expect(va.credentials.length).toBe(1);
    expect(va.credentials[0]).toMatchObject({ shared: true, shared_with: 2, kind: 'apikey', status: 'active' });
    expect(vb.credentials.map((c) => [c.client_id, c.client_secret])).toEqual(va.credentials.map((c) => [c.client_id, c.client_secret]));
    ids.credential = va.credentials[0].client_id;
    ids.secret = va.credentials[0].client_secret;
    // on the gateway: the credential of the application, authorized on nothing, and the alias of each subscription
    const key = await oto.getApikey(ids.credential);
    expect(key.sharedCredential.owner).toBe(ids.app);
    expect(key.authorizedEntities).toEqual([]);
    const gwSub = await oto.getSubscription(a.id);
    expect(gwSub.token_refs.find((r) => r.shared).apikey).toBe(ids.credential);
    const alias = await oto.getApikey(await aliasOf(a.id));
    expect(alias.apiRef).toMatchObject({ api: apis.a.id, plan: apis.a.plans[0], sub: a.id, credential: ids.credential });
    // the alias is the product's too, with no secret: nobody calls with it
    const [row] = await db`select kind, client_secret from credentials where subscription_id = ${a.id}`;
    expect(row).toEqual({ kind: 'alias', client_secret: null });
    // one key calls both apis
    expect(await until(async () => (await gw(apis.a, ids.credential, ids.secret)) === 200)).toBe(true);
    expect(await until(async () => (await gw(apis.b, ids.credential, ids.secret)) === 200)).toBe(true);
    // never the alias with its own id, nor a wrong secret
    expect(await gw(apis.a, alias.clientId, alias.clientSecret)).toBe(401);
    expect(await gw(apis.a, ids.credential, 'not-the-secret')).toBe(401);
  });

  test('the calls of each api are counted apart, on the alias of its subscription', async () => {
    const before = await oto.apikeyQuotas(await aliasOf(ids.b));
    for (let i = 0; i < 3; i++) expect(await gw(apis.a, ids.credential, ids.secret)).toBe(200);
    const after = await oto.apikeyQuotas(await aliasOf(ids.b));
    expect(after.currentCallsPerDay).toBe(before.currentCallsPerDay);
    expect((await oto.apikeyQuotas(await aliasOf(ids.a))).currentCallsPerDay).toBeGreaterThanOrEqual(3);
    // the credential itself counts nothing
    expect((await oto.apikeyQuotas(ids.credential)).currentCallsPerDay).toBe(0);
  });

  test('a second subscription of the application to the same api has a key of its own', async () => {
    const second = await subscribe(apis.a, apis.a.plans[1]);
    ids.a2 = second.id;
    expect(second.shares_credential).toBe(false);
    const creds = (await view(second.id)).credentials;
    expect(creds.length).toBe(1);
    expect(creds[0].shared).toBe(false);
    expect(creds[0].client_id).not.toBe(ids.credential);
  });

  test('suspending a subscription cuts its api only', async () => {
    await ok('POST', `/workspaces/${WS}/subscriptions/${ids.b}/suspend`, {});
    expect(await until(async () => (await gw(apis.b, ids.credential, ids.secret)) === 401)).toBe(true);
    expect(await gw(apis.a, ids.credential, ids.secret)).toBe(200);
    await ok('POST', `/workspaces/${WS}/subscriptions/${ids.b}/resume`, {});
    expect(await until(async () => (await gw(apis.b, ids.credential, ids.secret)) === 200)).toBe(true);
  });

  test('a new secret for the credential: every api takes it', async () => {
    const credId = (await view(ids.a)).credentials[0].id;
    const rotated = await ok('POST', `/workspaces/${WS}/subscriptions/${ids.b}/credentials/${credId}/rotate`, {});
    expect(rotated.client_id).toBe(ids.credential);
    expect(rotated.client_secret).not.toBe(ids.secret);
    expect((await view(ids.a)).credentials[0].client_secret).toBe(rotated.client_secret);
    expect(await until(async () => (await gw(apis.a, ids.credential, rotated.client_secret)) === 200 && (await gw(apis.b, ids.credential, rotated.client_secret)) === 200)).toBe(true);
    expect(await gw(apis.a, ids.credential, ids.secret)).toBe(401);
    ids.secret = rotated.client_secret;
    const trail = await db`select entity_kind, entity_id, summary from audit_events where action = 'credential.rotate' and entity_id = ${ids.app}`;
    expect(trail[0].summary).toContain('every api it calls');
  });

  test('moved to another api, a subscription keeps calling with the credential of the application', async () => {
    // not to an api the application already calls with its key
    const refused = await call('POST', `/workspaces/${WS}/subscriptions/${ids.b}/transfer`, { api_id: apis.a.id, plan_id: apis.a.plans[0] });
    expect(refused.status).toBe(409);
    await ok('POST', `/workspaces/${WS}/subscriptions/${ids.b}/transfer`, { api_id: apis.c.id, plan_id: apis.c.plans[0] });
    // the gateway never moves it: it is made again on the other api, sharing the same credential
    expect((await oto.getSubscription(ids.b)).api_ref).toBe(apis.c.id);
    expect((await oto.getSubscription(ids.b)).token_refs.find((r) => r.shared).apikey).toBe(ids.credential);
    expect(await until(async () => (await gw(apis.c, ids.credential, ids.secret)) === 200)).toBe(true);
    expect(await until(async () => (await gw(apis.b, ids.credential, ids.secret)) === 401)).toBe(true);
    expect((await view(ids.b)).credentials.map((c) => c.client_id)).toEqual([ids.credential]);
  });

  test('a credential changed by hand on the gateway is a drift, and a resync repairs it', async () => {
    const key = await oto.getApikey(ids.credential);
    await oto.updateApikey({ ...key, enabled: false });
    const report = await checkSubscription((await db`select * from subscriptions where id = ${ids.a}`)[0]);
    expect(report.status).toBe('drifted');
    expect(report.diff.map((d) => d.path)).toContain(`apikey[${ids.credential}].enabled`);
    await ok('POST', `/workspaces/${WS}/subscriptions/${ids.a}/resync`, {});
    expect((await oto.getApikey(ids.credential)).enabled).toBe(true);
    expect((await checkSubscription((await db`select * from subscriptions where id = ${ids.a}`)[0])).status).toBe('in_sync');
  });

  test('an application that stops sharing: its next subscriptions have keys of their own, the earlier ones keep the credential', async () => {
    await ok('PUT', `/workspaces/${WS}/applications/${ids.app}`, { shared_credential: false });
    const own = await subscribe(apis.b);
    ids.b2 = own.id;
    expect(own.shares_credential).toBe(false);
    expect((await view(own.id)).credentials[0].client_id).not.toBe(ids.credential);
    expect((await view(ids.a)).credentials.map((c) => c.client_id)).toEqual([ids.credential]);
  });

  test('closing every subscription leaves the credential; deleting the application takes it from the gateway', async () => {
    for (const id of [ids.a, ids.b, ids.a2, ids.b2]) await ok('POST', `/workspaces/${WS}/subscriptions/${id}/close`, {});
    // a closed subscription shows no credential any more
    expect((await view(ids.a)).credentials.filter((c) => c.status === 'active')).toEqual([]);
    // the credential stays on the gateway, authorized on nothing: it calls nothing
    expect(await oto.getApikey(ids.credential)).toBeTruthy();
    expect(await until(async () => (await gw(apis.a, ids.credential, ids.secret)) === 401)).toBe(true);
    await ok('DELETE', `/workspaces/${WS}/applications/${ids.app}`);
    expect(await until(async () => !(await oto.getApikey(ids.credential)), 10000)).toBe(true);
  });

  test('a deleted workspace takes the credentials of its applications from the gateway', async () => {
    const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Billing' });
    const other = await ok('POST', `/workspaces/${WS}/applications`, { name: 'Billing hub', team_id: team.id, shared_credential: true });
    const sub = await ok('POST', `/workspaces/${WS}/subscriptions`, { api_id: apis.c.id, plan_id: apis.c.plans[0], application_id: other.id });
    const credential = (await view(sub.id)).credentials[0].client_id;
    expect(await oto.getApikey(credential)).toBeTruthy();
    for (const a of (await ok('GET', `/workspaces/${WS}/apis`)) || []) await ok('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await ok('DELETE', `/workspaces/${WS}`);
    expect(await until(async () => !(await oto.getApikey(credential)), 10000)).toBe(true);
  });
});
