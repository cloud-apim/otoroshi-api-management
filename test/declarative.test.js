// The declarative document, as a contract: its version in `spec.version` (the first form,
// `metadata.version`, still read); the policy groups and the shared resources it pins named, so that
// it moves between installations; its pages, when it lists them, their truth; the content of a page
// given by a file, read and inlined by the cli.
//
// Needs postgres (mise run up); nothing is deployed.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'declarative-test-token';

const { start } = await import('../server/main.js');
const { db, newId } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const WS = `decl-${RUN}`;
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer declarative-test-token', 'content-type': 'application/json' },
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
const doc = (name, spec = {}, metadata = {}) => ({ apiVersion: 'otoroshi-apim.io/v1', kind: 'Api', metadata: { name, ...metadata }, spec: { name, ...spec } });
const apply = (docs) => call('POST', ws('/apply'), docs);
// the cli, in a process of its own: the server it calls runs in this one
async function cli(args, env) {
  const p = Bun.spawn(['bun', 'cli/apim.js', ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [code, stderr] = [await p.exited, await new Response(p.stderr).text()];
  return { code, stderr };
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Declarative ${RUN}`, slug: WS });
  state.group = await ok('POST', ws('/policy-groups'), { name: 'Company headers', plugins: [{ plugin: 'cp:otoroshi.next.plugins.AdditionalHeadersOut', enabled: true, config: { headers: { 'X-Company': 'yes' } } }] });
  await ok('POST', ws(`/policy-groups/${state.group.id}/publish`), { comment: 'v1' });
  state.idp = await ok('POST', ws('/shared-resources'), { name: 'Corporate IdP', kind: 'authorization-server', content: { issuer: 'https://idp.example', jwksUrl: 'https://idp.example/jwks' } });
  await ok('POST', ws(`/shared-resources/${state.idp.id}/publish`), { comment: 'v1' });
});

afterAll(async () => {
  try {
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

const draft = (group, resource) => ({
  entrypoint: { domain: `decl-${RUN}.oto.tools`, contextPath: '/' },
  backends: [{ id: 'backend_main', name: 'main', targets: [{ hostname: 'echo', port: 8080 }] }],
  flows: [{ id: 'flow_main', name: 'main', plugins: [{ group, version: 1 }] }],
  resources: [{ id: 'res_all', name: 'All', path: '/', methods: [], backendId: 'backend_main', flowId: 'flow_main' }],
  plans: [{ id: 'plan_sso', name: 'SSO', status: 'published', validation: 'auto', auth: { kind: 'jwt', config: { audiences: ['documents'], sharedResource: { ...resource, version: 1 } } } }],
});

describe('the declarative document', () => {
  test('its version in spec.version; metadata.version still read; the two differing, refused', async () => {
    expect((await ok('POST', ws('/apply'), [doc('alpha', { version: '2.0.0' })]))[0]).toMatchObject({ action: 'created', api: { slug: 'alpha', version: '2.0.0' } });
    expect((await ok('POST', ws('/apply'), [doc('beta', {}, { version: '3.0.0' })]))[0].api.version).toBe('3.0.0');
    const both = await apply([doc('gamma', { version: '1.0.0' }, { version: '1.1.0' })]);
    expect(both.status).toBe(400);
    expect(both.body.error).toContain('differ');
    // the export writes spec.version
    const exported = await ok('GET', ws('/apis/alpha/document'));
    expect(exported.spec.version).toBe('2.0.0');
    expect(exported.metadata.version).toBeUndefined();
  });

  test('the shared objects it pins, by name — or by id; exported by name; an unknown name refused', async () => {
    const res = await ok('POST', ws('/apply'), [doc('named', { version: '1.0.0', draft: draft('Company headers', { name: 'Corporate IdP' }) })]);
    const api = await ok('GET', ws(`/apis/${res[0].api.id}`));
    // the product keeps ids
    expect(api.draft.flows[0].plugins[0]).toMatchObject({ group: state.group.id, version: 1 });
    expect(api.draft.plans[0].auth.config.sharedResource).toEqual({ id: state.idp.id, version: 1 });
    // the document says names: it moves to another installation
    const exported = await ok('GET', ws(`/apis/${api.id}/document`));
    expect(exported.spec.draft.flows[0].plugins[0]).toMatchObject({ group: 'Company headers', version: 1 });
    expect(exported.spec.draft.plans[0].auth.config.sharedResource).toEqual({ name: 'Corporate IdP', version: 1 });
    // applied back as exported: nothing changes
    expect((await ok('POST', ws('/apply?publish=true'), [exported]))[0].action).toBe('updated');
    expect((await ok('POST', ws('/apply?publish=true'), [exported]))[0].snapshot).toBe('unchanged');
    // by id, as before
    expect((await ok('POST', ws('/apply'), [doc('by-id', { version: '1.0.0', draft: draft(state.group.id, { id: state.idp.id }) })]))[0].action).toBe('created');
    const unknown = await apply([doc('unknown', { version: '1.0.0', draft: draft('Nobody', { name: 'Corporate IdP' }) })]);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('unknown policy group Nobody');
  });

  test('a name names one object: a second of the same name refused; an ambiguous name of older data refused', async () => {
    expect((await call('POST', ws('/policy-groups'), { name: 'Company headers', plugins: [] })).status).toBe(409);
    expect((await call('POST', ws('/shared-resources'), { name: 'Corporate IdP', kind: 'authorization-server', content: {} })).status).toBe(409);
    // two groups of the same name, written before the rule
    const [w] = await db`select id from workspaces where slug = ${WS}`;
    await db`insert into policy_groups (id, workspace_id, name) values (${newId('pg')}, ${w.id}, 'Company headers')`;
    const ambiguous = await apply([doc('ambiguous', { version: '1.0.0', draft: draft('Company headers', { name: 'Corporate IdP' }) })]);
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error).toContain('several policy groups are named Company headers');
    await db`delete from policy_groups where workspace_id = ${w.id} and name = 'Company headers' and id <> ${state.group.id}`;
  });

  test('its pages, when it lists them, are their truth; a document without pages leaves them alone', async () => {
    const pages = (...slugs) => slugs.map((slug) => ({ slug, title: { en: slug }, content: { en: `# ${slug}` } }));
    const res = await ok('POST', ws('/apply'), [doc('docs', { version: '1.0.0', pages: pages('start', 'guide') })]);
    const slugsOf = async () => (await ok('GET', ws(`/apis/${res[0].api.id}/pages`))).map((p) => p.slug).sort();
    expect(await slugsOf()).toEqual(['guide', 'start']);
    await ok('POST', ws('/apply'), [doc('docs', { version: '1.0.0', pages: pages('start') })]);
    expect(await slugsOf()).toEqual(['start']);
    await ok('POST', ws('/apply'), [doc('docs', { version: '1.0.0', description: 'no pages said' })]);
    expect(await slugsOf()).toEqual(['start']);
  });

  test('the content of a page by file: refused over http, read beside the document by the cli', async () => {
    const byFile = doc('files', { version: '1.0.0', pages: [{ slug: 'start', title: { en: 'Start' }, content: { en: { file: 'docs/start.en.md' } } }] });
    const refused = await apply([byFile]);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('inlines it');
    const dir = await mkdtemp(join(tmpdir(), 'apim-decl-'));
    try {
      await mkdir(join(dir, 'docs'));
      await writeFile(join(dir, 'docs', 'start.en.md'), '# Started from a file');
      await writeFile(join(dir, 'api.json'), JSON.stringify(byFile));
      const env = { ...process.env, APIM_URL: `http://localhost:${config.port}`, APIM_TOKEN: 'declarative-test-token' };
      const applied = await cli(['apply', WS, '-f', join(dir, 'api.json')], env);
      expect(applied.code).toBe(0);
      const [page] = (await ok('GET', ws('/apis/files/document'))).spec.pages;
      expect(page.content.en).toBe('# Started from a file');
      // a path that leaves the document is refused
      await writeFile(join(dir, 'escape.json'), JSON.stringify(doc('escape', { version: '1.0.0', pages: [{ slug: 'x', title: { en: 'x' }, content: { en: { file: '../secret.md' } } }] })));
      const escape = await cli(['apply', WS, '-f', join(dir, 'escape.json')], env);
      expect(escape.code).not.toBe(0);
      expect(escape.stderr).toContain('within its source');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
