// Who may do what in the console: the admin api enforces it, whatever the client. Two producers in
// two teams, a consumer, and the installation administrator, against a real server.
//
// Needs the docker stack (mise run up) for its database.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'permissions-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const WS = `perm-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const email = (who) => `${who}-${RUN}@permissions.test`;
const PASSWORD = `pw-${RUN}-secret`;

let server;
const tokens = { admin: 'permissions-test-token' };
const ids = {};

// the answer's status, and its body
async function as(who, method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function ok(who, method, path, body) {
  const r = await as(who, method, path, body);
  if (r.status >= 300) throw new Error(`${who} ${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// a personal api token, as a person gets one from the console
async function tokenOf(who) {
  const login = await fetch(`${ROOT}/backoffice/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email(who), password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${ROOT}/backoffice/api/me/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'permissions test' }) });
  return (await res.json()).token;
}

const doc = (name, team) => ({
  apiVersion: 'otoroshi-apim.io/v1',
  kind: 'Api',
  metadata: { name, version: '1.0.0' },
  spec: { name, team, draft: { entrypoint: { domain: `${name}-${RUN}.oto.tools`, contextPath: '/' } } },
});

beforeAll(async () => {
  server = await start();
  ids.ws = (await ok('admin', 'POST', '/workspaces', { name: `Permissions ${RUN}`, slug: WS })).id;
  for (const [who, role] of [['alice', 'producer'], ['bob', 'producer'], ['carl', 'consumer']]) {
    await ok('admin', 'POST', `/workspaces/${WS}/members`, { email: email(who), name: who, password: PASSWORD, role });
    ids[who] = (await ok('admin', 'GET', `/users?q=${encodeURIComponent(email(who))}`)).items[0].id;
    tokens[who] = await tokenOf(who);
  }
  ids.teamA = (await ok('admin', 'POST', `/workspaces/${WS}/teams`, { name: 'Team A', owner_id: ids.alice })).id;
  ids.teamB = (await ok('admin', 'POST', `/workspaces/${WS}/teams`, { name: 'Team B', owner_id: ids.bob })).id;
  const alpha = await ok('admin', 'POST', `/workspaces/${WS}/apis`, { name: 'Alpha', version: '1.0.0', team_id: ids.teamA, domain: `alpha-${RUN}.oto.tools`, contextPath: '/' });
  ids.alpha = alpha.id;
});

afterAll(async () => {
  try {
    for (const a of await ok('admin', 'GET', `/workspaces/${WS}/apis`)) await ok('admin', 'DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await ok('admin', 'DELETE', `/workspaces/${WS}`);
    // users are global and have no delete route: the test removes its own
    const mine = await db`select id from users where email like ${`%-${RUN}@permissions.test`}`;
    for (const u of mine) {
      await db`delete from api_tokens where user_id = ${u.id}`;
      await db`delete from sessions where user_id = ${u.id}`;
      await db`delete from team_members where user_id = ${u.id}`;
      await db`delete from workspace_members where user_id = ${u.id}`;
      await db`delete from users where id = ${u.id}`;
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('a producer', () => {
  test('sees every api of the workspace, and manages those of its teams only', async () => {
    const list = await ok('bob', 'GET', `/workspaces/${WS}/apis`);
    expect(list.map((a) => a.name)).toContain('Alpha');
    const alpha = await ok('bob', 'GET', `/workspaces/${WS}/apis/${ids.alpha}`);
    expect(alpha.can_manage).toBe(false);
    expect((await as('bob', 'PUT', `/workspaces/${WS}/apis/${ids.alpha}/draft`, { draft: alpha.draft })).status).toBe(403);
    expect((await as('bob', 'POST', `/workspaces/${WS}/apis/${ids.alpha}/publish`, {})).status).toBe(403);
    // the owner's team member can
    const mine = await ok('alice', 'GET', `/workspaces/${WS}/apis/${ids.alpha}`);
    expect(mine.can_manage).toBe(true);
    expect((await as('alice', 'PUT', `/workspaces/${WS}/apis/${ids.alpha}/draft`, { draft: mine.draft })).status).toBe(200);
  });

  test('makes an api for its own teams only, created or adopted from the gateway', async () => {
    const other = { name: 'Gamma', version: '1.0.0', team_id: ids.teamA, domain: `gamma-${RUN}.oto.tools`, contextPath: '/' };
    expect((await as('bob', 'POST', `/workspaces/${WS}/apis`, other)).status).toBe(403);
    // refused before the gateway is even asked for the api
    const adopt = await as('bob', 'POST', `/workspaces/${WS}/adopt`, { otoroshi_api_id: `nothing-${RUN}`, team_id: ids.teamA });
    expect(adopt.status).toBe(403);
    expect(adopt.body.error).toContain('not a member of this team');
    // into its own team, the adoption goes on: here the gateway has no such api
    expect((await as('bob', 'POST', `/workspaces/${WS}/adopt`, { otoroshi_api_id: `nothing-${RUN}`, team_id: ids.teamB })).status).toBe(404);
  });

  test('cannot change another team’s api through a declarative document either', async () => {
    expect((await as('bob', 'POST', `/workspaces/${WS}/apply`, [doc('alpha', 'Team A')])).status).toBe(403);
    expect((await as('bob', 'POST', `/workspaces/${WS}/apply`, [doc('beta', 'Team A')])).status).toBe(403);
    expect((await as('bob', 'POST', `/workspaces/${WS}/apply`, [doc('beta', 'Team B')])).status).toBe(200);
  });

  test('cannot join a team it does not own; an owner chooses its members', async () => {
    expect((await as('bob', 'POST', `/workspaces/${WS}/teams/${ids.teamA}/members`, { email: email('bob') })).status).toBe(403);
    expect((await as('bob', 'PUT', `/workspaces/${WS}/teams/${ids.teamA}`, { name: 'mine now' })).status).toBe(403);
    expect((await as('bob', 'POST', `/workspaces/${WS}/teams/${ids.teamB}/members`, { email: email('carl') })).status).toBe(200);
    expect((await as('bob', 'DELETE', `/workspaces/${WS}/teams/${ids.teamB}`)).status).toBe(403);
  });

  test('reads the workspace, does not administer it', async () => {
    expect((await as('bob', 'GET', `/workspaces/${WS}`)).status).toBe(200);
    expect((await as('bob', 'GET', `/workspaces/${WS}/metadata-fields`)).status).toBe(200);
    expect((await as('bob', 'GET', `/workspaces/${WS}/audit`)).status).toBe(200);
    for (const [method, path] of [
      ['PUT', ''],
      ['POST', '/members'],
      ['PUT', '/metadata-fields'],
      ['GET', '/catalogs'],
      ['GET', '/export'],
      ['POST', '/import'],
    ])
      expect([method, path, (await as('bob', method, `/workspaces/${WS}${path}`, {})).status]).toEqual([method, path, 403]);
  });

  test('follows the operations of its own workspaces only', async () => {
    // the other workspaces of the installation have tasks (the admin sees them all); bob's has none
    const mine = await ok('bob', 'GET', '/gateway/tasks?limit=5');
    expect(mine.total).toBe(0);
    const all = await ok('admin', 'GET', '/gateway/tasks?limit=5');
    expect(all.total).toBeGreaterThanOrEqual(mine.total);
    const queue = (await ok('bob', 'GET', '/gateway/status')).queue;
    expect(Object.values(queue).reduce((a, b) => a + b, 0)).toBe(mine.total);
  });

  test('has no installation rights', async () => {
    // the state of the gateway, not its settings: no url of the gateway, no volumes of the installation
    const status = await ok('bob', 'GET', '/gateway/status');
    expect(Object.keys(status.health).sort()).toEqual(['latencyMs', 'ok']);
    expect(status.ingest).toBeUndefined();
    expect((await ok('admin', 'GET', '/gateway/status')).health.url).toBeTruthy();
    for (const [method, path] of [
      ['GET', '/settings'],
      ['PUT', '/settings/gateway'],
      ['PUT', '/settings/ingest'],
      ['GET', '/gateway/setup'],
      ['POST', '/gateway/setup'],
      ['POST', '/users'],
      ['POST', '/workspaces'],
      ['GET', '/audit'],
      ['GET', '/audit/exporters'],
      ['POST', '/gateway/exporter'],
    ])
      expect([method, path, (await as('bob', method, path, {})).status]).toEqual([method, path, 403]);
  });
});

describe('a consumer', () => {
  test('has no access to the console’s workspace pages', async () => {
    for (const path of ['', '/apis', '/applications', '/subscriptions', '/audit', '/home'])
      expect([path, (await as('carl', 'GET', `/workspaces/${WS}${path}`)).status]).toEqual([path, 403]);
  });
});

describe('the installation administrator', () => {
  test('is the administrator of every workspace', async () => {
    const me = await ok('admin', 'GET', '/me');
    expect(me.workspaces.find((w) => w.slug === WS).role).toBe('admin');
    expect(me.workspaces.every((w) => w.role === 'admin')).toBe(true);
  });
});

describe('a workspace administrator', () => {
  test('administers the workspace and manages every api', async () => {
    await ok('admin', 'POST', `/workspaces/${WS}/members`, { email: email('alice'), role: 'admin' });
    expect((await as('alice', 'GET', `/workspaces/${WS}/catalogs`)).status).toBe(200);
    expect((await as('alice', 'GET', `/workspaces/${WS}/export`)).status).toBe(200);
    const beta = (await ok('alice', 'GET', `/workspaces/${WS}/apis`)).find((a) => a.slug === 'beta');
    expect((await ok('alice', 'GET', `/workspaces/${WS}/apis/${beta.id}`)).can_manage).toBe(true);
    // but not the installation
    expect((await as('alice', 'GET', '/settings')).status).toBe(403);
  });
});
