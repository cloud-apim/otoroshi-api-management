// The setup of the gateway, end to end on the Otoroshi of the stack: given an admin key, it makes
// the product's own key and switches the product to it, the data exporter, the routes of the
// console and of the portals — reached through the gateway —, the auth module in front of the
// console, the TLS client authentication; a second run changes nothing; it never touches what it
// did not make; the admin key is never stored.
//
// Needs the docker stack (mise run up). Puts the settings of the installation and of the gateway
// back as they were.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'setup-test-token';
config.publicUrl = `http://localhost:${config.port}`;

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { gatewaySettings, invalidateGatewaySettings, oto } = await import('../server/otoroshi/client.js');
const { invalidateAuthSettings } = await import('../server/auth/settings.js');
const { CONSOLE_ROUTE, EXPORTER_ID, KEY_ID, PORTALS_ROUTE } = await import('../server/domain/setup.js');

const RUN = Date.now().toString(36);
const ROOT = `http://localhost:${config.port}`;
const ADMIN = { clientId: 'apim-admin-client', clientSecret: 'apim-admin-secret' };
const CONSOLE_HOST = `console-${RUN}.oto.tools`;
const PORTAL_HOST = `portal-${RUN}.oto.tools`;
const MODULE = `apim_test_module_${RUN}`;
const OPTIONS = { productUrl: 'http://apim:9000', consoleHost: CONSOLE_HOST, portalHost: PORTAL_HOST };
let server;
const saved = {};

// the admin api of Otoroshi, with the admin key of the stack
async function gw(method, path, body) {
  const res = await fetch(`http://localhost:8080${path}`, {
    method,
    headers: { Host: 'otoroshi-api.oto.tools', Authorization: `Basic ${btoa(`${ADMIN.clientId}:${ADMIN.clientSecret}`)}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function setup(body) {
  const res = await fetch(`${ROOT}/api/gateway/setup`, { method: 'POST', headers: { authorization: 'Bearer setup-test-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json();
  if (res.status >= 300) throw new Error(`setup -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}
const part = (report, name) => report.parts.find((p) => p.part === name);

// a route of the gateway answers once the gateway has read it
async function through(host, path, want, init = {}) {
  let last;
  for (let i = 0; i < 40; i++) {
    last = await fetch(`http://${host}:8080${path}`, { redirect: 'manual', ...init });
    if (want(last.status)) return last;
    await Bun.sleep(500);
  }
  return last;
}

beforeAll(async () => {
  server = await start();
  for (const key of ['gateway', 'setup', 'auth']) saved[key] = (await db`select value from settings where key = ${key}`)[0]?.value ?? null;
  saved.clientAuth = (await gw('GET', '/api/globalconfig')).body.tlsSettings.clientAuth;
  const template = (await gw('GET', '/api/auths/_template')).body;
  expect((await gw('POST', '/api/auths', { ...template, id: MODULE, name: `Setup test ${RUN}`, users: [] })).status).toBeLessThan(300);
});

afterAll(async () => {
  for (const [key, value] of Object.entries({ gateway: saved.gateway, setup: saved.setup, auth: saved.auth })) {
    if (value === null) await db`delete from settings where key = ${key}`;
    else await db`insert into settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
  invalidateGatewaySettings();
  invalidateAuthSettings();
  await gw('PATCH', '/api/globalconfig', [{ op: 'replace', path: '/tlsSettings/clientAuth', value: saved.clientAuth }]);
  await gw('DELETE', `/apis/proxy.otoroshi.io/v1/routes/${CONSOLE_ROUTE}`);
  await gw('DELETE', `/apis/proxy.otoroshi.io/v1/routes/${PORTALS_ROUTE}`);
  await gw('DELETE', `/api/apikeys/${KEY_ID}`);
  await gw('DELETE', `/api/auths/${MODULE}`);
  server?.stop(true);
});

describe('the setup of the gateway', () => {
  test('a dry run says what it would do, and does nothing', async () => {
    const report = await setup({ dryRun: true, otoroshi: ADMIN, options: OPTIONS });
    expect(report.dryRun).toBe(true);
    expect(part(report, 'key').actions.map((a) => [a.op, a.kind])).toEqual([
      ['create', 'Apikey'],
      ['update', 'Settings'],
    ]);
    expect(part(report, 'console').actions[0]).toMatchObject({ op: 'create', kind: 'Route', id: CONSOLE_ROUTE });
    expect((await gw('GET', `/api/apikeys/${KEY_ID}`)).status).toBe(404);
    expect((await gw('GET', `/apis/proxy.otoroshi.io/v1/routes/${CONSOLE_ROUTE}`)).status).toBe(404);
  });

  test('a run makes the key of the product, switches the product to it, exposes the console and the portals', async () => {
    const report = await setup({ otoroshi: ADMIN, options: OPTIONS });
    expect(Object.fromEntries(report.parts.map((p) => [p.part, p.status]))).toMatchObject({ key: 'changed', exporter: expect.stringMatching(/ok|changed/), console: 'changed', portals: 'changed', tls: 'skipped' });
    // the key: made by the setup, on the admin api, and the product calls the gateway with it
    const key = (await gw('GET', `/api/apikeys/${KEY_ID}`)).body;
    expect(key.metadata).toMatchObject({ created_by: 'otoroshi-apim-setup', apim_setup_part: 'key' });
    expect(key.authorizedEntities).toEqual(['group_admin-api-group']);
    invalidateGatewaySettings();
    expect((await gatewaySettings()).clientId).toBe(KEY_ID);
    expect((await oto.health()).ok).toBe(true);
    expect(report.checks.find((c) => c.code === 'product_key').level).toBe('ok');
    // the console and the portals, through the gateway
    const console = await through(CONSOLE_HOST, '/backoffice/', (s) => s === 200);
    expect(console.status).toBe(200);
    expect(await console.text()).toContain('<div id="root">');
    expect((await through(PORTAL_HOST, '/default/', (s) => s === 200)).status).toBe(200);
    // the console, the admin api and the ingester are not on the host of the portals
    expect((await through(PORTAL_HOST, '/backoffice/', (s) => s === 404)).status).toBe(404);
    expect((await through(PORTAL_HOST, '/api/me', (s) => s === 404)).status).toBe(404);
    // the admin key is not kept anywhere
    const stored = JSON.stringify((await db`select key, value from settings`).map((r) => r.value));
    expect(stored).not.toContain(ADMIN.clientSecret);
    const [audit] = await db`select data from audit_events where action = 'gateway.setup' order by at desc limit 1`;
    expect(audit.data.withAdminKey).toBe(true);
    expect(JSON.stringify(audit.data)).not.toContain(ADMIN.clientSecret);
    expect(JSON.stringify(audit.data)).not.toContain(key.clientSecret);
  });

  test('a second run, without the admin key, changes nothing; the options are remembered', async () => {
    const report = await setup({});
    expect(report.parts.map((p) => [p.part, p.status])).toEqual([
      ['key', 'ok'],
      ['exporter', 'ok'],
      ['console', 'ok'],
      ['portals', 'ok'],
      ['tls', 'skipped'],
    ]);
    expect(report.options).toMatchObject(OPTIONS);
  });

  test('a part at a time: the host of the portals moved; the key of the product rotated', async () => {
    const moved = await setup({ only: ['portals'], dryRun: true, options: { portalHost: `elsewhere-${RUN}.oto.tools` } });
    expect(part(moved, 'portals').actions[0].changes).toEqual([{ op: 'change', path: 'domains', before: [PORTAL_HOST], after: [`elsewhere-${RUN}.oto.tools`] }]);
    const before = (await gatewaySettings()).clientSecret;
    const rotated = await setup({ only: ['key'], otoroshi: ADMIN, options: { rotateKey: true } });
    expect(part(rotated, 'key').status).toBe('changed');
    invalidateGatewaySettings();
    expect((await gatewaySettings()).clientSecret).not.toBe(before);
    expect((await oto.health()).ok).toBe(true);
  });

  test('the console behind an auth module of the gateway, with the info token the "via Otoroshi" login reads', async () => {
    const report = await setup({ only: ['console'], options: { consoleAuthModule: MODULE } });
    expect(part(report, 'console').status).toBe('changed');
    const route = (await gw('GET', `/apis/proxy.otoroshi.io/v1/routes/${CONSOLE_ROUTE}`)).body;
    expect(route.plugins.map((p) => p.plugin)).toEqual(['cp:otoroshi.next.plugins.AuthModule', 'cp:otoroshi.next.plugins.OtoroshiInfos']);
    const secret = (await db`select value from settings where key = 'auth'`)[0].value.otoroshi.secret;
    expect(route.plugins[1].config.algo).toMatchObject({ type: 'HSAlgoSettings', size: 512, secret });
    // nobody signed in: the gateway sends to its login page
    const res = await through(CONSOLE_HOST, '/backoffice/', (s) => s >= 300 && s < 400);
    expect([302, 303]).toContain(res.status);
    expect(part(report, 'console').notes.join(' ')).toContain('via Otoroshi');
  });

  test('the TLS client authentication of the gateway, asked for', async () => {
    const report = await setup({ only: ['tls'], options: { clientAuth: 'Want' } });
    expect(part(report, 'tls').actions[0]).toMatchObject({ kind: 'GlobalConfig', changes: [{ path: 'tlsSettings.clientAuth', after: 'Want' }] });
    expect((await gw('GET', '/api/globalconfig')).body.tlsSettings.clientAuth).toBe('Want');
  });

  test('what it did not make is left alone', async () => {
    const route = (await gw('GET', `/apis/proxy.otoroshi.io/v1/routes/${PORTALS_ROUTE}`)).body;
    await gw('PUT', `/apis/proxy.otoroshi.io/v1/routes/${PORTALS_ROUTE}`, { ...route, metadata: {} });
    const report = await setup({ only: ['portals'] });
    expect(part(report, 'portals')).toMatchObject({ status: 'error', notes: [expect.stringContaining('was not made by the product')] });
    // not written again: without the marker of the product
    expect((await gw('GET', `/apis/proxy.otoroshi.io/v1/routes/${PORTALS_ROUTE}`)).body.metadata).not.toHaveProperty('created_by');
  });

  test('the exporter helper of the console is the exporter part', async () => {
    const res = await fetch(`${ROOT}/api/gateway/exporter`, { method: 'POST', headers: { authorization: 'Bearer setup-test-token', 'content-type': 'application/json' }, body: '{}' });
    expect(await res.json()).toMatchObject({ id: EXPORTER_ID, url: 'http://apim:9000/ingest', op: 'unchanged' });
  });
});
