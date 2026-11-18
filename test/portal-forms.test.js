// The forms of the portal urls, against a real server: by root path, by hostname, at the root of a
// single-workspace installation — and, each time the form changes, the urls of the forms served
// before redirected to the same pages.
//
// Needs the database of the docker stack (mise run up). The test changes the form of its own
// server only, and puts the recorded history back as it found it.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'portal-forms-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { recordPortalForm } = await import('../server/portal-exposure.js');

const RUN = Date.now().toString(36);
const WS = `forms-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const DOMAIN = 'portal.test';
const saved = { portal: { ...config.portal }, tenancy: config.tenancy, workspace: config.bootstrap.workspace };
let server;
let history;

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, {
    method,
    headers: { authorization: 'Bearer portal-forms-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// a request as a browser would make it on that host; redirects are looked at, not followed
const get = (path, host, init = {}) => fetch(`${ROOT}${path}`, { redirect: 'manual', ...init, headers: { ...(host ? { host } : {}), ...(init.headers || {}) } });
const runtime = async (res) => JSON.parse(/window\.__APIM__ = (\{.*?\});<\/script>/.exec(await res.text())[1]);
const portalOf = async (path, host) => (await (await get(path, host)).json()).workspace.slug;

async function serve({ exposure = 'path', tenancy = 'multi', workspace = saved.workspace } = {}) {
  config.portal.exposure = exposure;
  config.tenancy = tenancy;
  config.bootstrap.workspace = workspace;
  return recordPortalForm();
}

beforeAll(async () => {
  history = (await db`select value from settings where key = 'portal.forms'`)[0]?.value || null;
  config.portal.url = ROOT;
  config.portal.domain = DOMAIN;
  server = await start();
  expect((await call('POST', '/workspaces', { name: `Forms ${RUN}`, slug: WS })).status).toBe(200);
});

afterAll(async () => {
  try {
    Object.assign(config.portal, saved.portal);
    config.tenancy = saved.tenancy;
    config.bootstrap.workspace = saved.workspace;
    if (history) await db`update settings set value = ${history} where key = 'portal.forms'`;
    else await db`delete from settings where key = 'portal.forms'`;
    await recordPortalForm();
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('by root path', () => {
  test('/<workspace>/ is its portal, its api under it', async () => {
    await serve();
    const page = await get(`/${WS}/apis`);
    expect(page.status).toBe(200);
    expect(await runtime(page)).toEqual({ workspace: WS, base: `/${WS}`, exposure: 'path' });
    expect(await portalOf(`/${WS}/front/api/portal`)).toBe(WS);
    expect((await call('GET', `/workspaces/${WS}`)).body.portal_url).toBe(`${ROOT}/${WS}/`);
  });
});

describe('by hostname', () => {
  test('<workspace>.<domain> is its portal, its api at the root of the host', async () => {
    await serve({ exposure: 'hostname' });
    const host = `${WS}.${DOMAIN}`;
    const page = await get('/apis', host);
    expect(page.status).toBe(200);
    expect(await runtime(page)).toEqual({ workspace: WS, base: '', exposure: 'hostname' });
    expect(await portalOf('/front/api/portal', host)).toBe(WS);
    expect((await call('GET', `/workspaces/${WS}`)).body.portal_url).toBe(`http://${host}:${config.port}/`);
    expect((await get('/', `nobody.${DOMAIN}`)).status).toBe(404);
    // the bare domain leads to the default portal, as / does by path
    expect((await get('/', DOMAIN)).headers.get('location')).toBe(`http://${saved.workspace}.${DOMAIN}:${config.port}/`);
  });

  test('the urls by path served before are redirected, permanently, the method kept', async () => {
    const res = await get(`/${WS}/apis/x?tab=plans`, `localhost:${config.port}`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`http://${WS}.${DOMAIN}:${config.port}/apis/x?tab=plans`);
    const post = await get(`/${WS}/front/api/auth/login`, `localhost:${config.port}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(post.status).toBe(308);
    const settings = (await call('GET', '/settings')).body.portal;
    expect(settings.form).toEqual({ kind: 'hostname', domain: DOMAIN });
    expect(settings.history.previous.map((f) => f.kind)).toEqual(['path']);
  });

  test('back by path: the urls by hostname are redirected', async () => {
    await serve();
    const res = await get('/apps', `${WS}.${DOMAIN}`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${ROOT}/${WS}/apps`);
  });
});

describe('a single-workspace installation', () => {
  test('its portal is served at the root, with no prefix', async () => {
    await serve({ tenancy: 'single', workspace: WS });
    const page = await get('/');
    expect(page.status).toBe(200);
    expect(await runtime(page)).toEqual({ workspace: WS, base: '', exposure: 'root' });
    expect(await portalOf('/front/api/portal')).toBe(WS);
    // a page of the portal stays a page
    expect((await get('/apis')).status).toBe(200);
    expect((await call('GET', '/me')).body.installation.tenancy).toBe('single');
    expect((await call('GET', `/workspaces/${WS}`)).body.portal_url).toBe(`${ROOT}/`);
  });

  test('the urls of the forms served before lead to the root', async () => {
    const byPath = await get(`/${WS}/apps`);
    expect(byPath.status).toBe(301);
    expect(byPath.headers.get('location')).toBe(`${ROOT}/apps`);
    const byHost = await get('/apps', `${WS}.${DOMAIN}`);
    expect(byHost.headers.get('location')).toBe(`${ROOT}/apps`);
  });

  test('it creates no other workspace, and keeps its own', async () => {
    expect((await call('POST', '/workspaces', { name: 'Another', slug: `another-${RUN}` })).status).toBe(400);
    expect((await call('DELETE', `/workspaces/${WS}`)).status).toBe(400);
  });

  test('back to several workspaces: the root urls lead to the portal of the one served before', async () => {
    await serve();
    const res = await get('/apis/x');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${ROOT}/${WS}/apis/x`);
  });
});
