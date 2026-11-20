// What pins a version of a shared object never follows a newer one by itself; publishing one tells
// the teams of the apis behind, and an upgrade on demand moves them, each by its own draft, snapshot
// and deployment — an api managed by a source, or whose draft holds other changes, is reported, not
// forced. A policy group and a shared resource, the same way.
//
// Needs the docker stack (mise run up): one api is deployed on the gateway.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'pins-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const WS = `pins-${RUN}`;
let server;
const state = { apis: {} };

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer pins-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const ws = (p) => `/workspaces/${WS}${p}`;
const headers = (value) => [{ plugin: 'cp:otoroshi.next.plugins.AdditionalHeadersOut', enabled: true, config: { headers: { 'X-Pins': value } } }];
const doc = (name, plans = [{ id: `plan_${name}`, name: 'Free', status: 'published', validation: 'auto', auth: { kind: 'apikey' } }]) => ({
  apiVersion: 'otoroshi-apim.io/v1',
  kind: 'Api',
  metadata: { name },
  spec: {
    version: '1.0.0',
    name,
    team: 'Platform',
    draft: {
      entrypoint: { domain: `${name}-${RUN}.oto.tools`, contextPath: '/' },
      backends: [{ id: 'backend_main', name: 'main', targets: [{ hostname: 'echo', port: 8080 }] }],
      flows: [{ id: 'flow_main', name: 'main', plugins: [{ group: 'Headers', version: 1 }] }],
      resources: [{ id: 'res_all', name: 'All', path: '/', methods: [], backendId: 'backend_main', flowId: 'flow_main' }],
      plans,
    },
  },
});

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Pins ${RUN}`, slug: WS });
  state.team = await ok('POST', ws('/teams'), { name: 'Platform' });
  state.group = await ok('POST', ws('/policy-groups'), { name: 'Headers', plugins: headers('v1') });
  await ok('POST', ws(`/policy-groups/${state.group.id}/publish`), { comment: 'v1' });
  // running: deployed; published only; managed by a catalog; with other changes in its draft
  for (const [name, query] of [
    ['running', '?publish=true&deploy=true'],
    ['published', '?publish=true'],
    ['managed', '?publish=true&managed_by=catalog:elsewhere'],
    ['edited', '?publish=true'],
  ])
    state.apis[name] = (await ok('POST', ws(`/apply${query}`), [doc(name)]))[0].api.id;
  const edited = await ok('GET', ws(`/apis/${state.apis.edited}`));
  edited.draft.resources[0].name = 'Everything';
  await ok('PUT', ws(`/apis/${state.apis.edited}/draft`), { draft: edited.draft });
});

afterAll(async () => {
  try {
    for (const id of Object.values(state.apis)) await call('DELETE', ws(`/apis/${id}`));
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('a policy group published again', () => {
  test('changes nothing that runs, and tells the team of the apis behind', async () => {
    await ok('PUT', ws(`/policy-groups/${state.group.id}`), { plugins: headers('v2') });
    await ok('POST', ws(`/policy-groups/${state.group.id}/publish`), { comment: 'v2' });
    const g = await ok('GET', ws(`/policy-groups/${state.group.id}`));
    expect(g.usage.filter((u) => u.behind).map((u) => u.name).sort()).toEqual(['edited', 'managed', 'published', 'running']);
    // nothing republished: the running api keeps its snapshot
    expect((await ok('GET', ws(`/apis/${state.apis.running}`))).deployment.current.snapshot_number).toBe(1);
    const [note] = await db`select * from notifications where team_id = ${state.team.id} and kind = 'pin.behind'`;
    expect(note.title).toBe('policy group Headers v2 published');
    expect(note.body).toContain('running 1.0.0 (v1)');
    expect(note.link).toBe(`/policy-groups/${state.group.id}`);
  });

  test('an upgrade moves each api by its own draft, snapshot and deployment, and reports the others', async () => {
    const { latest, results } = await ok('POST', ws(`/policy-groups/${state.group.id}/upgrade`), { publish: true, deploy: true });
    expect(latest).toBe(2);
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(by.running).toMatchObject({ action: 'deployed', snapshot: 2, from: [1], to: 2 });
    expect(by.published).toMatchObject({ action: 'published', snapshot: 2 });
    expect(by.managed).toMatchObject({ action: 'skipped' });
    expect(by.managed.reason).toContain('managed by catalog:elsewhere');
    expect(by.edited).toMatchObject({ action: 'upgraded' });
    expect(by.edited.reason).toContain('other unpublished changes');
    // the running api runs v2 of the group; the edited one pins it in its draft, not published
    const running = await ok('GET', ws(`/apis/${state.apis.running}`));
    expect(running.deployment.current.snapshot_number).toBe(2);
    expect(running.draft.flows[0].plugins[0]).toMatchObject({ group: state.group.id, version: 2 });
    const edited = await ok('GET', ws(`/apis/${state.apis.edited}`));
    expect(edited.draft.flows[0].plugins[0].version).toBe(2);
    expect(edited.draft.resources[0].name).toBe('Everything');
    // only the managed one stays behind; the upgrade is in the audit trail
    expect((await ok('GET', ws(`/policy-groups/${state.group.id}`))).usage.filter((u) => u.behind).map((u) => u.name)).toEqual(['managed']);
    const audit = await ok('GET', ws(`/audit?action=policy_group.upgrade`));
    expect(audit.items[0].summary).toBe('policy group Headers: 3 api(s) upgraded to v2, published and deployed');
  });
});

describe('a shared resource published again', () => {
  test('the apis behind told, and upgraded in their drafts on demand', async () => {
    const idp = await ok('POST', ws('/shared-resources'), { name: 'IdP', kind: 'authorization-server', content: { issuer: 'https://idp.example', jwksUrl: 'https://idp.example/jwks' } });
    await ok('POST', ws(`/shared-resources/${idp.id}/publish`), { comment: 'v1' });
    const plans = [{ id: 'plan_sso', name: 'SSO', status: 'published', validation: 'auto', auth: { kind: 'jwt', config: { audiences: ['pins'], sharedResource: { name: 'IdP', version: 1 } } } }];
    state.apis.sso = (await ok('POST', ws('/apply'), [doc('sso', plans)]))[0].api.id;
    await ok('PUT', ws(`/shared-resources/${idp.id}`), { content: { issuer: 'https://idp.example', jwksUrl: 'https://idp.example/keys' } });
    await ok('POST', ws(`/shared-resources/${idp.id}/publish`), { comment: 'v2' });
    expect((await db`select count(*)::int as n from notifications where team_id = ${state.team.id} and title = 'shared resource IdP v2 published'`)[0].n).toBe(1);
    const { results } = await ok('POST', ws(`/shared-resources/${idp.id}/upgrade`), {});
    expect(results).toEqual([expect.objectContaining({ name: 'sso', action: 'upgraded', from: [1], to: 2 })]);
    expect((await ok('GET', ws(`/apis/${state.apis.sso}`))).draft.plans[0].auth.config.sharedResource).toEqual({ id: idp.id, version: 2 });
    // the cli lists what is behind, and upgrades it
    const env = { ...process.env, APIM_URL: `http://localhost:${config.port}`, APIM_TOKEN: 'pins-test-token' };
    const p = Bun.spawn(['bun', 'cli/apim.js', 'shared-resources', 'list', WS], { env, stdout: 'pipe' });
    const [code, out] = [await p.exited, await new Response(p.stdout).text()];
    expect(code).toBe(0);
    expect(out).toContain('IdP');
  });
});
