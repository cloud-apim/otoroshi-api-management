// End-to-end: the objects derived from plan descriptions exist on a real Otoroshi, marked as the
// product's, are referenced by the Api, follow the description, and leave with the api.
//  - an mtls plan's trusted CA → a certificate of the gateway, and the issuer pattern of the plan
//  - an oauth2-remote plan's authorization server → an auth module; a token of that server passes
//
// Needs the docker stack (mise run up): postgres, otoroshi 18 on 8080, the dev OIDC provider.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';

setDefaultTimeout(40000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'derived-test-token';

const { start } = await import('../server/main.js');
const { otoroshi } = await import('../server/otoroshi/client.js');

const CA = readFileSync(new URL('./fixtures/atlas-partner-ca.pem', import.meta.url), 'utf8');
const RUN = Date.now().toString(36);
const WS = `derived-${RUN}`;
const DOMAIN = `derived-${RUN}.oto.tools`;
const BASE = `http://localhost:${config.port}/api`;
const IDP = 'http://oidc.oto.tools:8090/default';

let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: 'Bearer derived-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
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

// the development server gives a token the audience of the scope asked beside openid
async function token(clientId, audience = 'documents') {
  const res = await fetch(`${IDP}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=whatever&scope=openid%20${audience}`,
  });
  return (await res.json()).access_token;
}

const plans = (trustedCAs) => [
  {
    id: 'plan_certified',
    name: 'Certified',
    status: 'published',
    auth: { kind: 'mtls', config: { clientIdField: 'CN', trustedCAs } },
    validation: 'auto',
  },
  {
    id: 'plan_sso',
    name: 'SSO',
    status: 'published',
    auth: {
      kind: 'oauth2-remote',
      config: { clientIdPath: 'sub', fetchUser: false, issuer: IDP, audiences: ['documents'], derive: { enabled: true, discoveryUrl: `${IDP}/.well-known/openid-configuration`, jwksUrl: `${IDP}/jwks`, userInfoUrl: `${IDP}/userinfo`, scope: 'openid' } },
    },
    validation: 'auto',
  },
];

beforeAll(async () => {
  server = await start();
});

afterAll(async () => {
  try {
    if (state.apiId) await call('DELETE', ws(`/apis/${state.apiId}`));
    // the derived objects leave with the api
    if (state.authModuleId) expect(await otoroshi('GET', `/api/auths/${state.authModuleId}`)).toBeNull();
    for (const id of state.certIds || []) expect(await otoroshi('GET', `/api/certificates/${id}`)).toBeNull();
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('derived objects', () => {
  test('describe an mtls plan with a trusted CA and an oauth2-remote plan with its server', async () => {
    await call('POST', '/workspaces', { name: `Derived ${RUN}`, slug: WS });
    const api = await call('POST', ws('/apis'), { name: 'Derived', version: '1.0.0', domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
    state.apiId = api.id;
    const draft = api.draft;
    draft.resources = [{ id: 'res_docs', name: 'Docs', path: '/documents', methods: ['GET'], backendId: draft.backends[0].id, flowId: draft.flows[0].id }];
    draft.plans = plans([CA]);
    const saved = await call('PUT', ws(`/apis/${api.id}/draft`), { draft });
    expect(saved.validation.errors).toEqual([]);
    // the plan says which issuer and which audience its tokens carry
    expect(saved.validation.warnings.map((w) => w.code)).not.toContain('token_claims_not_checked');
  });

  test('the dry run lists the derived objects, and says what the gateway settings defeat', async () => {
    await call('POST', ws(`/apis/${state.apiId}/publish`), { comment: 'derived objects' });
    const plan = await call('POST', ws(`/apis/${state.apiId}/deploy`), { dry_run: true });
    expect(plan.derived.map((d) => d.kind).sort()).toEqual(['AuthModule', 'Certificate']);
    // the dev gateway does not ask for client certificates: the mtls plan cannot work there
    const tls = (await otoroshi('GET', '/api/globalconfig')).tlsSettings;
    if (!['Want', 'Need'].includes(tls.clientAuth)) expect(plan.warnings.map((w) => w.code)).toContain('gateway_no_client_auth');
  });

  test('deploy: a certificate and an auth module of the product, referenced by the plans', async () => {
    const res = await call('POST', ws(`/apis/${state.apiId}/deploy`), {});
    expect(res.deployment.status).toBe('deployed');
    const entity = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`);
    const certified = entity.plans.find((p) => p.id === 'plan_certified').access_mode_configuration;
    // the plan trusts its CA, by the id of the certificate derived from it; both lists of patterns must match
    expect(certified.trusted_ca_refs.length).toBe(1);
    expect(certified.dn_match).toBe('all');
    const sso = entity.plans.find((p) => p.id === 'plan_sso').access_mode_configuration;
    expect(sso).toMatchObject({ issuer: IDP, audiences: ['documents'], subscription_required: true });
    state.authModuleId = sso.verifier;

    const mod = await otoroshi('GET', `/api/auths/${sso.verifier}`);
    expect(mod.type).toBe('oauth2');
    expect(mod.jwtVerifier.url).toBe(`${IDP}/jwks`);
    expect(mod.metadata).toMatchObject({ created_by: 'external=otoroshi-api-management', apim_api_id: state.apiId, apim_derived: 'true' });

    const certs = ((await otoroshi('GET', '/api/certificates')) || []).filter((c) => c.metadata?.apim_api_id === state.apiId);
    expect(certs.length).toBe(1);
    expect(certs[0].id).toBe(certified.trusted_ca_refs[0]);
    expect(certs[0].ca).toBe(true);
    expect(certs[0].privateKey || '').toBe('');
    // written with the upsert of the generic api, which reads the subject and the dates from the chain
    expect(certs[0].subject).toContain('CN=Atlas Partner CA');
    expect(certs[0].to).toBeGreaterThan(Date.now());
    state.certIds = certs.map((c) => c.id);
  });

  test('a token of the authorization server passes the oauth2-remote plan once subscribed, a forged one does not', async () => {
    const team = await call('POST', ws('/teams'), { name: 'SSO partners' });
    const app = await call('POST', ws('/applications'), { name: 'SSO partner', team_id: team.id, client_id: `partner-${RUN}` });
    const good = await token(`partner-${RUN}`);
    // not subscribed yet: a valid token is not a consumer of the plan
    expect((await gatewayCall('/documents', { headers: { Authorization: `Bearer ${good}` }, expect: (r) => r.status !== 404 })).status).toBe(401);
    await call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_sso', application_id: app.id });
    const ok = await gatewayCall('/documents', { headers: { Authorization: `Bearer ${good}` }, expect: (r) => r.status === 200 });
    expect(ok.status).toBe(200);
    // another client of the same server, not subscribed
    expect((await gatewayCall('/documents', { headers: { Authorization: `Bearer ${await token(`stranger-${RUN}`)}` } })).status).toBe(401);
    // the subscribed client, with a token the same server issued for another api: not its audience
    expect((await gatewayCall('/documents', { headers: { Authorization: `Bearer ${await token(`partner-${RUN}`, 'payments')}` } })).status).toBe(401);
    const forged = `${good.split('.').slice(0, 2).join('.')}.${Buffer.from('not the signature').toString('base64url')}`;
    const ko = await gatewayCall('/documents', { headers: { Authorization: `Bearer ${forged}` } });
    expect([400, 401, 403]).toContain(ko.status);
  });

  test('drift: none right after the deployment; an edited derived object is reported', async () => {
    await call('POST', '/gateway/drift', {});
    const report = async () => (await call('GET', '/gateway/drift-reports')).find((d) => d.entity_id === state.apiId);
    expect((await report())?.status).not.toBe('drifted');
    // an operator points the derived auth module at other keys, on the gateway
    const mod = await otoroshi('GET', `/api/auths/${state.authModuleId}`);
    await otoroshi('PUT', `/api/auths/${mod.id}`, { ...mod, jwtVerifier: { ...mod.jwtVerifier, url: 'http://elsewhere/jwks' } });
    await call('POST', '/gateway/drift', {});
    const drifted = await report();
    expect(drifted.status).toBe('drifted');
    expect(JSON.stringify(drifted.diff)).toContain("AuthModule");
    // redeploying repairs it
    await call('POST', ws(`/apis/${state.apiId}/deploy`), {});
    expect((await otoroshi('GET', `/api/auths/${mod.id}`)).jwtVerifier.url).toBe(`${IDP}/jwks`);
  });

  test('the certificate of an application is on the gateway while its mtls subscription is active', async () => {
    const team = await call('POST', ws('/teams'), { name: 'Partners' });
    const app = await call('POST', ws('/applications'), { name: 'Certified partner', team_id: team.id, client_id: 'Atlas Partner CA', certificates: [CA] });
    state.appId = app.id;
    const onGateway = async () => ((await otoroshi('GET', '/api/certificates')) || []).filter((c) => c.metadata?.apim_application_id === app.id);
    expect(await onGateway()).toEqual([]);
    const sub = await call('POST', ws('/subscriptions'), { api_id: state.apiId, plan_id: 'plan_certified', application_id: app.id });
    expect(sub.status).toBe('active');
    const [cert] = await onGateway();
    expect(cert.chain.replace(/\s+/g, '')).toBe(CA.replace(/\s+/g, ''));
    expect(cert.metadata.apim_derived).toBe('true');
    // the subscription carries the client id the application declares, and the gateway provisions
    // its consumer; another client id is another subscription on the gateway, the previous key disabled
    const projected = () => otoroshi('GET', `/apis/apis.otoroshi.io/v1/apisubscriptions/${sub.id}`);
    expect((await projected()).client_id).toBe('Atlas Partner CA');
    const before = `mtls_${state.apiId}_plan_certified_Atlas Partner CA`;
    expect((await projected()).token_refs).toEqual([{ apikey: before }]);
    await call('PUT', ws(`/applications/${app.id}`), { client_id: 'atlas-partner' });
    expect((await projected()).client_id).toBe('atlas-partner');
    expect((await projected()).token_refs).toEqual([{ apikey: `mtls_${state.apiId}_plan_certified_atlas-partner` }]);
    expect((await otoroshi('GET', `/api/apikeys/${encodeURIComponent(before)}`)).enabled).toBe(false);
    await call('POST', '/gateway/drift', {});
    expect((await call('GET', ws(`/subscriptions/${sub.id}`))).drift?.status).toBe('in_sync');
    // suspended: the gateway no longer trusts it; resumed: back
    await call('POST', ws(`/subscriptions/${sub.id}/suspend`), {});
    expect(await onGateway()).toEqual([]);
    await call('POST', ws(`/subscriptions/${sub.id}/resume`), {});
    expect((await onGateway()).length).toBe(1);
    await call('POST', ws(`/subscriptions/${sub.id}/close`), {});
    expect(await onGateway()).toEqual([]);
    const detail = await call('GET', ws(`/applications/${app.id}`));
    expect(detail.certificates_on_gateway).toBe(false);
  });

  test('the derived objects follow the description: a CA removed is a certificate removed', async () => {
    const api = await call('GET', ws(`/apis/${state.apiId}`));
    const draft = api.draft;
    draft.plans = plans([]);
    await call('PUT', ws(`/apis/${state.apiId}/draft`), { draft });
    await call('POST', ws(`/apis/${state.apiId}/publish`), { comment: 'no more CA', deploy: true });
    for (const id of state.certIds) expect(await otoroshi('GET', `/api/certificates/${id}`)).toBeNull();
    expect(await otoroshi('GET', `/api/auths/${state.authModuleId}`)).toBeTruthy();
    state.certIds = [];
  });
});
