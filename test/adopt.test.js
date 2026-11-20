// Adopt mode, end to end on the gateway: an Api the product did not make, with a subscription and
// its key, is taken over — the api as a draft, the subscription and its key as they are — and the
// first deployment updates them in place: the consumer keeps calling with its key.
//
// Needs the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'adopt-test-token';

const { start } = await import('../server/main.js');
const { otoroshi } = await import('../server/otoroshi/client.js');
const { buildOtoroshiApi } = await import('../server/otoroshi/projection.js');
const { defaultPlan } = await import('../server/domain/model.js');

const RUN = Date.now().toString(36);
const WS = `adopt-${RUN}`;
const DOMAIN = `adopt-${RUN}.oto.tools`;
const API = `api_handmade_${RUN}`;
const SUB = `sub_handmade_${RUN}`;
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer adopt-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}
const ws = (p) => `/workspaces/${WS}${p}`;

async function gatewayStatus(wanted) {
  let last;
  for (let i = 0; i < 60; i++) {
    last = (await fetch('http://localhost:8080/', { headers: { Host: DOMAIN, 'Otoroshi-Client-Id': state.key.clientId, 'Otoroshi-Client-Secret': state.key.clientSecret } })).status;
    if (last === wanted) return last;
    await Bun.sleep(500);
  }
  return last;
}

beforeAll(async () => {
  server = await start();
  await call('POST', '/workspaces', { name: `Adopt ${RUN}`, slug: WS });
  // an Api made by hand on the gateway, by another tool
  const entity = buildOtoroshiApi({
    api: { id: API, name: 'Harbour', version: '1.0.0', workspace_id: 'elsewhere' },
    draft: { entrypoint: { domain: DOMAIN, contextPath: '/' }, plans: [defaultPlan({ id: 'plan_dock', name: 'Dock', status: 'published', auth: { kind: 'apikey' } })], settings: { correlationId: false } },
  });
  entity.metadata = { created_by: 'external=hand-made' };
  await otoroshi('POST', `/apis/apis.otoroshi.io/v1/apis/${API}`, entity);
  // and a subscription of a consumer of it, with its key
  await otoroshi('POST', '/apis/apis.otoroshi.io/v1/apisubscriptions', {
    _loc: { tenant: 'default', teams: ['default'] },
    id: SUB,
    name: 'Fishermen',
    description: '',
    tags: [],
    metadata: {},
    status: 'enabled',
    dates: {},
    owner_ref: 'fishermen',
    plan_ref: 'plan_dock',
    api_ref: API,
    payment_ref: {},
    subscription_kind: 'apikey',
    token_refs: [],
  });
  const sub = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apisubscriptions/${SUB}`);
  state.key = await otoroshi('GET', `/api/apikeys/${sub.token_refs[0].apikey}`);
});

afterAll(async () => {
  try {
    if (state.adopted) await call('DELETE', ws(`/apis/${API}`));
    else await otoroshi('DELETE', `/apis/apis.otoroshi.io/v1/apis/${API}`);
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('adopt mode', () => {
  test('the Api the product did not make is listed, with its subscription', async () => {
    expect(await gatewayStatus(200)).toBe(200);
    const listed = (await call('GET', '/gateway/unmanaged-apis')).find((a) => a.id === API);
    expect(listed).toMatchObject({ name: 'Harbour 1.0.0', subscriptions: 1, created_by: 'external=hand-made' });
  });

  test('adopted: the api as a draft, the subscription and its key as they are', async () => {
    const adopted = await call('POST', ws('/adopt'), { otoroshi_api_id: API });
    state.adopted = true;
    expect(adopted.adopted).toMatchObject({ subscriptions: 1, applications: 1, credentials: 1, skipped: [] });
    expect(adopted.draft.plans.map((p) => p.id)).toEqual(['plan_dock']);
    const sub = await call('GET', ws(`/subscriptions/${SUB}`));
    expect(sub).toMatchObject({ status: 'active', plan_id: 'plan_dock', auth_kind: 'apikey', application_name: 'fishermen' });
    expect(sub.credentials.map((c) => [c.client_id, c.client_secret])).toEqual([[state.key.clientId, state.key.clientSecret]]);
    // nothing written to the gateway: the Api is still the other tool's
    expect((await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${API}`)).metadata.created_by).toBe('external=hand-made');
  });

  test('the first deployment updates them in place: the consumer keeps calling with its key', async () => {
    await call('POST', ws(`/apis/${API}/publish`), { comment: 'adopted', deploy: true });
    const entity = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${API}`);
    expect(entity.metadata.created_by).toBe('external=otoroshi-api-management');
    // the deployment queues the projection of its subscriptions: the workers run it, here by hand
    await call('POST', ws(`/subscriptions/${SUB}/resync`));
    const sub = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apisubscriptions/${SUB}`);
    expect(sub.token_refs).toEqual([{ apikey: state.key.clientId }]);
    expect(sub.metadata.id_ref).toBeTruthy();
    expect((await otoroshi('GET', `/api/apikeys/${state.key.clientId}`)).clientSecret).toBe(state.key.clientSecret);
    expect(await gatewayStatus(200)).toBe(200);
    await call('POST', ws('/drift'));
    expect((await call('GET', ws(`/subscriptions/${SUB}`))).drift?.status).toBe('in_sync');
  });
});
