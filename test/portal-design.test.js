// The design of a portal: a draft, published by immutable versions, shown by the portal; its assets
// served by digest, never as scripts; its script only where the administrators allowed scripts, the
// warning acknowledged; a preview link for the draft; its declarative document, applied by a source
// that then owns it.
//
// Needs postgres (mise run up); nothing reaches the gateway.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'design-test-token';

const { start } = await import('../server/main.js');

const RUN = Date.now().toString(36);
const WS = `design-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, {
    method,
    headers: { authorization: 'Bearer design-test-token', 'content-type': 'application/json' },
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
const portal = async (query = '') => (await fetch(`${ROOT}/${WS}/front/api/portal${query}`)).json();
// a png of one pixel
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Design ${RUN}`, slug: WS });
});

afterAll(async () => {
  try {
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('the design of a portal', () => {
  test('before any design, the one its settings describe: the default template, nothing published', async () => {
    const s = await ok('GET', ws('/portal/design'));
    expect(s.draft).toMatchObject({ mode: 'default', texts: { title: { en: `Design ${RUN} developer portal` } }, theme: { accent: '#0061bd' } });
    expect(s.published.number).toBe(0);
    expect(s.scripts.enabled).toBe(false);
    expect((await portal()).design).toMatchObject({ mode: 'default', number: 0, script: false, preview: false });
  });

  test('a draft is checked: links, colors, blocks', async () => {
    expect((await call('PUT', ws('/portal/design'), { navigation: { header: [{ label: { en: 'x' }, href: 'javascript:alert(1)' }] } })).status).toBe(400);
    expect((await call('PUT', ws('/portal/design'), { theme: { accent: 'red; background: url(x)' } })).status).toBe(400);
    expect((await call('PUT', ws('/portal/design'), { home: { blocks: [{ kind: 'iframe' }] } })).status).toBe(400);
    expect((await call('PUT', ws('/portal/design'), { mode: 'themed', css: 'a{}</style><script>' })).status).toBe(400);
  });

  test('its assets, by digest: images, fonts, style sheets — never a script; an svg sandboxed', async () => {
    const logo = await ok('POST', ws('/portal/assets'), { path: 'assets/logo.png', data: PNG });
    // (checked on a copy: an asymmetric matcher of toMatchObject is written into what it checks)
    state.logo = { ...logo };
    expect(logo.contentType).toBe('image/png');
    expect(logo.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('POST', ws('/portal/assets'), { path: 'assets/evil.js', data: Buffer.from('alert(1)').toString('base64') })).status).toBe(400);
    const svg = await ok('POST', ws('/portal/assets'), { path: 'assets/mark.svg', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64') });
    const res = await fetch(`${ROOT}/${WS}/_design/assets/${logo.hash}`);
    expect([res.status, res.headers.get('content-type'), res.headers.get('x-content-type-options')]).toEqual([200, 'image/png', 'nosniff']);
    const s = await fetch(`${ROOT}/${WS}/_design/assets/${svg.hash}`);
    expect(s.headers.get('content-security-policy')).toContain('sandbox');
    // an asset the draft names must be uploaded
    expect((await call('PUT', ws('/portal/design'), { theme: { logo: 'assets/missing.png' } })).status).toBe(400);
  });

  test('published by versions: the portal shows the last one; nothing changed, nothing to publish', async () => {
    await ok('PUT', ws('/portal/design'), {
      mode: 'themed',
      texts: { title: { en: 'Acme developers' } },
      theme: { accent: '#ff5500', logo: 'assets/logo.png', radius: 'large', colors: { dark: { background: '#101010' } } },
      navigation: { header: [{ label: { en: 'Status' }, href: 'https://status.example' }, { label: { en: 'Guide' }, href: 'page:guide' }] },
      home: { blocks: [{ kind: 'hero' }, { kind: 'catalogue', limit: 3 }, { kind: 'markdown', content: { en: '# Welcome' } }] },
      assets: { 'assets/logo.png': state.logo.hash },
    });
    expect((await ok('POST', ws('/portal/publish'), { comment: 'first theme' })).number).toBe(1);
    expect((await call('POST', ws('/portal/publish'), {})).status).toBe(409);
    const d = (await portal()).design;
    expect(d).toMatchObject({ mode: 'themed', number: 1, texts: { title: { en: 'Acme developers' } }, theme: { accent: '#ff5500', logo: `_design/assets/${state.logo.hash}` } });
    expect(d.home.blocks.map((b) => b.kind)).toEqual(['hero', 'catalogue', 'markdown']);
  });

  test('the draft is shown through a preview link only; a version is restored into the draft', async () => {
    await ok('PUT', ws('/portal/design'), { texts: { title: { en: 'Acme — next' } } });
    expect((await portal()).design.texts.title.en).toBe('Acme developers');
    const { token, url } = await ok('POST', ws('/portal/preview'));
    expect(url).toContain(`/${WS}/?preview=`);
    expect((await portal(`?preview=${encodeURIComponent(token)}`)).design).toMatchObject({ preview: true, texts: { title: { en: 'Acme — next' } } });
    expect((await portal('?preview=forged.token')).design.preview).toBe(false);
    const s = await ok('GET', ws('/portal/design'));
    expect(s.changes.length).toBeGreaterThan(0);
    await ok('POST', ws('/portal/versions/1/restore'));
    expect((await ok('GET', ws('/portal/design'))).changes).toEqual([]);
    expect((await ok('GET', ws('/portal/versions'))).items.map((v) => v.number)).toEqual([1]);
  });

  test('a script runs only where scripts are allowed, the warning acknowledged, in the audit trail', async () => {
    await ok('PUT', ws('/portal/design'), { script: 'window.__acme = true;' });
    await ok('POST', ws('/portal/publish'), { comment: 'a script' });
    expect((await portal()).design.script).toBe(false);
    expect((await fetch(`${ROOT}/${WS}/_design/script.js`)).status).toBe(404);
    const refused = await call('PUT', ws('/portal/scripts'), { enabled: true });
    expect(refused.status).toBe(400);
    expect(refused.body.details.warning).toContain('in the session of every consumer');
    expect((await ok('PUT', ws('/portal/scripts'), { enabled: true, acknowledge: true })).enabled).toBe(true);
    expect((await portal()).design.script).toBe(true);
    const js = await fetch(`${ROOT}/${WS}/_design/script.js`);
    expect([js.status, js.headers.get('content-type'), await js.text()]).toEqual([200, 'text/javascript; charset=utf-8', 'window.__acme = true;']);
    const audit = await ok('GET', ws('/audit?action=portal.scripts.allow'));
    expect(audit.items[0].summary).toContain('scripts ALLOWED');
    await ok('PUT', ws('/portal/scripts'), { enabled: false });
    expect((await fetch(`${ROOT}/${WS}/_design/script.js`)).status).toBe(404);
  });

  test('its declarative document: exported, applied with its assets inline, a file refused, owned by its source', async () => {
    const doc = await ok('GET', ws('/portal/document'));
    expect(doc).toMatchObject({ kind: 'Portal', metadata: { name: WS }, spec: { mode: 'themed' } });
    expect(doc.spec.assets).toEqual([{ path: 'assets/logo.png', hash: state.logo.hash, contentType: 'image/png' }]);
    const next = {
      ...doc,
      spec: {
        ...doc.spec,
        mode: 'templates',
        templates: { home: { en: '# {% $portal.title %}' } },
        assets: [...doc.spec.assets, { path: 'assets/banner.png', contentType: 'image/png', data: PNG }],
      },
    };
    expect(await ok('POST', ws('/portal/apply?publish=true&managed_by=catalog:design'), next)).toMatchObject({ action: 'updated', version: 3 });
    expect((await portal()).design).toMatchObject({ mode: 'templates', number: 3 });
    expect((await call('POST', ws('/portal/apply'), { ...next, spec: { ...next.spec, css: { file: 'styles.css' } } })).status).toBe(400);
    // owned by its source: the console does not edit it by hand
    const edit = await call('PUT', ws('/portal/design'), { texts: { title: { en: 'by hand' } } });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toContain('managed by catalog:design');
    // the same document again: nothing changes
    expect(await ok('POST', ws('/portal/apply?publish=true&managed_by=catalog:design'), next)).toMatchObject({ action: 'unchanged', version: 'unchanged' });
  });
});
