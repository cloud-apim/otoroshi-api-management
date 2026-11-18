// The gateway names the consumers of a token, certificate or open plan after the plan id alone
// (G-18): two apis with a plan of the same id share their consumers. The product says so, on the
// draft against the other apis of the installation, and on the deployment against the gateway.
//
// Needs the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(40000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'shared-plan-ids-token';

const { start } = await import('../server/main.js');

const RUN = Date.now().toString(36);
const OPEN = `plan_open_${RUN}`;
const KEYS = `plan_keys_${RUN}`;
let server;
const state = { apis: [] };

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer shared-plan-ids-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const plans = (openId) => [
  { id: openId, name: 'Open', status: 'published', auth: { kind: 'keyless', config: { expr: '${req.ip}', createIfMissing: false } } },
  { id: KEYS, name: 'Keys', status: 'published', auth: { kind: 'apikey' }, validation: 'auto' },
];

async function api(wsSlug, name, openId) {
  await call('POST', '/workspaces', { name: `${name} ${RUN}`, slug: wsSlug });
  const created = await call('POST', `/workspaces/${wsSlug}/apis`, { name, version: '1.0.0', domain: `${wsSlug}.oto.tools`, contextPath: '/', withDefaultPlan: false });
  state.apis.push([wsSlug, created.id]);
  const draft = created.draft;
  draft.plans = plans(openId);
  const saved = await call('PUT', `/workspaces/${wsSlug}/apis/${created.id}/draft`, { draft });
  return { id: created.id, ws: wsSlug, draft: saved.draft, validation: saved.validation };
}

const shared = (warnings) => warnings.filter((w) => w.code === 'plan_id_shared');

beforeAll(async () => {
  server = await start();
});

afterAll(async () => {
  try {
    for (const [ws, id] of state.apis) await call('DELETE', `/workspaces/${ws}/apis/${id}`);
    for (const [ws] of state.apis) await call('DELETE', `/workspaces/${ws}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('plan ids shared between apis', () => {
  test('the draft says when another api of the installation has an open plan of the same id', async () => {
    const first = await api(`shared-a-${RUN}`, 'Tides', OPEN);
    expect(shared(first.validation.warnings)).toEqual([]);
    await call('POST', `/workspaces/${first.ws}/apis/${first.id}/publish`, { comment: 'first', deploy: true });
    state.first = first;

    // another workspace: the gateway's namespace is the installation's
    const second = await api(`shared-b-${RUN}`, 'Currents', OPEN);
    const warnings = shared(second.validation.warnings);
    // the open plan only: the keys of an apikey plan come from its subscriptions
    expect(warnings.length).toBe(1);
    expect(warnings[0].path).toBe('plans[0]');
    expect(warnings[0].message).toContain(`the API "Tides" 1.0.0 (workspace shared-a-${RUN})`);
    state.second = second;
  });

  test('the deployment says when an Api of the gateway has one', async () => {
    const { ws, id } = state.second;
    await call('POST', `/workspaces/${ws}/apis/${id}/publish`, { comment: 'first' });
    const dry = await call('POST', `/workspaces/${ws}/apis/${id}/deploy`, { dry_run: true });
    expect(shared(dry.warnings).map((w) => w.message).join(' ')).toContain('the Api "Tides 1.0.0" on the gateway has a keyless plan');
  });

  test('an id of its own: nothing to say', async () => {
    const { ws, id, draft } = state.second;
    draft.plans = plans(`plan_currents_open_${RUN}`);
    const saved = await call('PUT', `/workspaces/${ws}/apis/${id}/draft`, { draft });
    expect(shared(saved.validation.warnings)).toEqual([]);
  });
});
