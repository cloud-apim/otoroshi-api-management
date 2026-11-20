// Shared resources, end to end on the gateway: an authorization server named once for the workspace,
// published, pinned by an oauth2-remote plan; the snapshot freezes the version, the projection
// derives the auth module from it, and a token of that server passes. Publishing a new version
// changes nothing until the api is upgraded to it; a resource still used is not deleted.
//
// Needs the docker stack (mise run up), its development identity provider among it.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'resources-test-token';

const { start } = await import('../server/main.js');
const { otoroshi } = await import('../server/otoroshi/client.js');

const RUN = Date.now().toString(36);
const WS = `res-${RUN}`;
const DOMAIN = `res-${RUN}.oto.tools`;
const IDP = 'http://oidc.oto.tools:8090/default';
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer resources-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => null);
  return { status: res.status, body: out };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const ws = (p) => `/workspaces/${WS}${p}`;
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
async function token(clientId, audience = 'documents') {
  const res = await fetch(`${IDP}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=whatever&scope=openid%20${audience}`,
  });
  return (await res.json()).access_token;
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Resources ${RUN}`, slug: WS });
  state.team = await ok('POST', ws('/teams'), { name: 'Identity' });
});

afterAll(async () => {
  try {
    if (state.api) await call('DELETE', ws(`/apis/${state.api.id}`));
    if (state.idp) await call('DELETE', ws(`/shared-resources/${state.idp.id}`));
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('shared resources', () => {
  test('an authorization server, named once, published', async () => {
    const created = await ok('POST', ws('/shared-resources'), { name: 'Corporate IdP', kind: 'authorization-server', content: { issuer: IDP, discoveryUrl: `${IDP}/.well-known/openid-configuration`, userInfoUrl: `${IDP}/userinfo` } });
    state.idp = created;
    // its keys are needed to validate a token
    expect((await call('POST', ws(`/shared-resources/${created.id}/publish`), {})).status).toBe(400);
    await ok('PUT', ws(`/shared-resources/${created.id}`), { content: { ...created.draft, jwksUrl: `${IDP}/jwks` } });
    expect((await ok('POST', ws(`/shared-resources/${created.id}/publish`), { comment: 'first' })).number).toBe(1);
    expect((await call('POST', ws(`/shared-resources/${created.id}/publish`), {})).status).toBe(409);
  });

  test('a plan pins it: the auth module derived from it, a token of that server passes', async () => {
    const api = await ok('POST', ws('/apis'), { name: 'Documents', version: '1.0.0', team_id: state.team.id, domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
    state.api = api;
    const draft = api.draft;
    draft.plans = [{ id: 'plan_sso', name: 'SSO', status: 'published', validation: 'auto', auth: { kind: 'oauth2-remote', config: { clientIdPath: 'sub', audiences: ['documents'], sharedResource: { id: state.idp.id, version: 1 } } } }];
    await ok('PUT', ws(`/apis/${api.id}/draft`), { draft });
    const published = await ok('POST', ws(`/apis/${api.id}/publish`), { comment: 'sso', deploy: true });
    expect(published.deployment.deployment.status).toBe('deployed');
    const entity = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${api.id}`);
    const sso = entity.plans[0].access_mode_configuration;
    expect(sso).toMatchObject({ issuer: IDP, audiences: ['documents'] });
    const mod = await otoroshi('GET', `/api/auths/${sso.verifier}`);
    expect([mod.jwtVerifier.url, mod.oidConfig]).toEqual([`${IDP}/jwks`, `${IDP}/.well-known/openid-configuration`]);
    state.moduleId = sso.verifier;
    // a consumer of the plan, with a token of that server
    const app = await ok('POST', ws('/applications'), { name: 'Reader', team_id: state.team.id, client_id: `reader-${RUN}` });
    await ok('POST', ws('/subscriptions'), { api_id: api.id, plan_id: 'plan_sso', application_id: app.id });
    const res = await gatewayCall('/documents', { headers: { Authorization: `Bearer ${await token(`reader-${RUN}`)}` }, expect: (r) => r.status === 200 });
    expect(res.status).toBe(200);
    // the api pins the version it uses
    const listed = (await ok('GET', ws('/shared-resources'))).find((x) => x.id === state.idp.id);
    expect(listed.usage).toEqual([{ id: api.id, name: 'Documents', version: '1.0.0', pinned: [1], latest: 1, behind: false }]);
  });

  test('a new version changes nothing until the api is upgraded; a resource still used is not deleted', async () => {
    await ok('PUT', ws(`/shared-resources/${state.idp.id}`), { content: { ...state.idp.draft, jwksUrl: `${IDP}/jwks`, scope: 'openid profile' } });
    expect((await ok('POST', ws(`/shared-resources/${state.idp.id}/publish`), { comment: 'profile' })).number).toBe(2);
    expect((await otoroshi('GET', `/api/auths/${state.moduleId}`)).scope).toBe('openid');
    expect((await ok('GET', ws(`/shared-resources/${state.idp.id}`))).usage[0]).toMatchObject({ pinned: [1], latest: 2, behind: true });
    // upgraded: the next snapshot freezes v2, the deployment follows
    const api = await ok('GET', ws(`/apis/${state.api.id}`));
    api.draft.plans[0].auth.config.sharedResource.version = 2;
    await ok('PUT', ws(`/apis/${state.api.id}/draft`), { draft: api.draft });
    await ok('POST', ws(`/apis/${state.api.id}/publish`), { comment: 'v2', deploy: true });
    expect((await otoroshi('GET', `/api/auths/${state.moduleId}`)).scope).toBe('openid profile');
    const del = await call('DELETE', ws(`/shared-resources/${state.idp.id}`));
    expect(del.status).toBe(400);
    expect(del.body.error).toContain('still used by Documents 1.0.0');
  });
});
