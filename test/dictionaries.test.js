// Dictionaries, end to end on the gateway: a named set of values projected into the global env of the
// gateway, read by the expression language of a plugin of an api — static, or refreshed from an
// external source, keeping its last values when the source fails —; what the gateway holds of it
// compared, removed with it.
//
// Needs the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'dictionaries-test-token';

const { start } = await import('../server/main.js');
const { otoroshi } = await import('../server/otoroshi/client.js');

const RUN = Date.now().toString(36);
const WS = `dict-${RUN}`;
const DOMAIN = `dict-${RUN}.oto.tools`;
let server;
let source;
let sourceBody = { data: { fr: 'Paris', de: 'Berlin' } };
let sourceUp = true;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer dictionaries-test-token', 'content-type': 'application/json' },
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
const onGateway = async () => (await otoroshi('GET', '/api/globalconfig')).env?.apim?.dictionaries?.[WS] || {};
async function until(fn, wanted, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (wanted(last)) return last;
    await Bun.sleep(500);
  }
  return last;
}
// the headers the backend received, as the echo backend answers them
const received = async () => {
  const r = await fetch('http://localhost:8080/', { headers: { Host: DOMAIN } });
  return r.status === 200 ? (await r.json()).headers : null;
};

beforeAll(async () => {
  server = await start();
  // an external source of values
  source = Bun.serve({ port: 0, fetch: () => (sourceUp ? Response.json(sourceBody) : new Response('down', { status: 503 })) });
  await ok('POST', '/workspaces', { name: `Dictionaries ${RUN}`, slug: WS });
  const team = await ok('POST', ws('/teams'), { name: 'Platform' });
  state.team = team;
});

afterAll(async () => {
  try {
    if (state.api) await call('DELETE', ws(`/apis/${state.api.id}`));
    for (const d of (await call('GET', ws('/dictionaries'))).body || []) await call('DELETE', ws(`/dictionaries/${d.id}`));
    await call('DELETE', `/workspaces/${WS}`);
    // the workspace entry of the global env, emptied by the deletions above
    const gc = await otoroshi('GET', '/api/globalconfig');
    if (gc.env?.apim?.dictionaries?.[WS]) await otoroshi('PATCH', '/api/globalconfig', [{ op: 'remove', path: `/env/apim/dictionaries/${WS}` }]);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  source?.stop(true);
  server?.stop(true);
});

describe('dictionaries', () => {
  test('a name and keys the expression language can read', async () => {
    expect((await call('POST', ws('/dictionaries'), { name: 'Partners!', entries: {} })).status).toBe(400);
    const dotted = await call('POST', ws('/dictionaries'), { name: 'partners', entries: { 'acme.com': 'gold' } });
    expect(dotted.status).toBe(400);
    expect(dotted.body.error).toContain('holds a dot');
  });

  test('a static dictionary lands in the global env of the gateway, and a plugin of an api reads it', async () => {
    const d = await ok('POST', ws('/dictionaries'), { name: 'partners', description: 'the tiers of our partners', entries: { acme: 'gold', globex: 'silver', limits: { fr: 100 } } });
    state.partners = d;
    expect(d.projection.status).toBe('synced');
    expect((await onGateway()).partners).toEqual({ acme: 'gold', globex: 'silver', limits: { fr: 100 } });
    const listed = (await ok('GET', ws('/dictionaries'))).find((x) => x.name === 'partners');
    expect(listed).toMatchObject({ gateway: 'in_sync', expression: `\${global_config.env.apim.dictionaries.${WS}.partners.<key>}` });
    // an api whose flow adds a header from the dictionary
    const api = await ok('POST', ws('/apis'), { name: 'Partners', version: '1.0.0', team_id: state.team.id, domain: DOMAIN, contextPath: '/' });
    state.api = api;
    const draft = api.draft;
    draft.flows[0].plugins.push({
      plugin: 'cp:otoroshi.next.plugins.AdditionalHeadersIn',
      enabled: true,
      include: [],
      exclude: [],
      config: { headers: { 'X-Partner-Tier': `\${global_config.env.apim.dictionaries.${WS}.partners.acme}`, 'X-Limit-Fr': `\${global_config.env.apim.dictionaries.${WS}.partners.limits.fr}` } },
    });
    draft.plans = [{ ...draft.plans[0], status: 'published', auth: { kind: 'keyless' } }];
    await ok('PUT', ws(`/apis/${api.id}/draft`), { draft });
    await ok('POST', ws(`/apis/${api.id}/publish`), { comment: 'partners', deploy: true });
    const headers = await until(received, (h) => h && h['x-partner-tier'] === 'gold');
    expect([headers['x-partner-tier'], headers['x-limit-fr']]).toEqual(['gold', '100']);
  });

  test('changed in the product, the values change on the gateway: no redeployment of the api', async () => {
    await ok('PUT', ws(`/dictionaries/${state.partners.id}`), { entries: { acme: 'platinum', globex: 'silver', limits: { fr: 100 } } });
    expect((await until(received, (h) => h?.['x-partner-tier'] === 'platinum'))['x-partner-tier']).toBe('platinum');
    // changed on the gateway behind its back: said, and set again by the next projection
    await otoroshi('PATCH', '/api/globalconfig', [{ op: 'replace', path: `/env/apim/dictionaries/${WS}/partners/acme`, value: 'tampered' }]);
    expect((await ok('GET', ws(`/dictionaries/${state.partners.id}`))).gateway).toBe('drifted');
    await ok('PUT', ws(`/dictionaries/${state.partners.id}`), { description: 'the tiers of our partners, again' });
    expect((await onGateway()).partners.acme).toBe('platinum');
  });

  test('a dictionary refreshed from a source keeps its last values when the source fails', async () => {
    const d = await ok('POST', ws('/dictionaries'), { name: 'capitals', source: { kind: 'url', url: `http://localhost:${source.port}/capitals`, everySeconds: 60, pointer: '/data', headers: { Authorization: 'Bearer source-token' } } });
    expect(d).toMatchObject({ entries: { fr: 'Paris', de: 'Berlin' }, refreshed: { status: 'ok' } });
    // the token of the source is a secret: never shown back
    expect(d.source.headers).toEqual({ Authorization: '••••••' });
    expect((await onGateway()).capitals).toEqual({ fr: 'Paris', de: 'Berlin' });
    sourceBody = { data: { fr: 'Paris', de: 'Berlin', it: 'Rome' } };
    expect((await ok('POST', ws(`/dictionaries/${d.id}/refresh`))).entries.it).toBe('Rome');
    expect((await onGateway()).capitals.it).toBe('Rome');
    sourceUp = false;
    const failed = await ok('POST', ws(`/dictionaries/${d.id}/refresh`));
    expect(failed.refreshed).toMatchObject({ status: 'error', error: 'the source answered 503' });
    expect(failed.entries.it).toBe('Rome');
    expect((await onGateway()).capitals.it).toBe('Rome');
    // a static dictionary is not refreshed
    expect((await call('POST', ws(`/dictionaries/${state.partners.id}/refresh`))).status).toBe(400);
  });

  test('deleted, it leaves the gateway', async () => {
    await ok('DELETE', ws(`/dictionaries/${state.partners.id}`));
    expect((await onGateway()).partners).toBeUndefined();
    expect((await onGateway()).capitals).toBeDefined();
  });
});
