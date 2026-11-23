// Deleting a person (server/domain/people.js): an installation administrator's act; the personal
// applications of the person go with them — their subscriptions closed first, the gateway revoking
// their keys —, their access is gone, the teams they share with others stay.
//
// Needs the docker stack (mise run up) for its database.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'people-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { workOnce } = await import('../server/domain/tasks.js');
const { oto } = await import('../server/otoroshi/client.js');

// the projection queue run until the gateway says what is expected
async function until(fn, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await fn()) return true;
    await workOnce();
    await Bun.sleep(300);
  }
  return false;
}

const RUN = Date.now().toString(36);
const WS = `people-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const DANA = { name: 'Dana', email: `dana-${RUN}@people.test`, password: `dana-${RUN}-secret` };
const ERIN = { name: 'Erin', email: `erin-${RUN}@people.test`, password: `erin-${RUN}-secret` };
let server;
const ids = {};

async function call(method, path, body, token = 'people-test-token') {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// the portal of the workspace, as a person signed up there: a session cookie
async function portal(method, path, body, cookie) {
  const res = await fetch(`${ROOT}/${WS}/front/api${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`portal ${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return { body: out, cookie: res.headers.get('set-cookie')?.split(';')[0] || cookie };
}

// a personal api token, as a person gets one from the console
async function tokenOf(who) {
  const login = await fetch(`${ROOT}/backoffice/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: who.email, password: who.password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${ROOT}/backoffice/api/me/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'people test' }) });
  return (await res.json()).token;
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `People ${RUN}`, slug: WS });
  const api = await ok('POST', `/workspaces/${WS}/apis`, { name: 'Parcels', version: '1.0.0', domain: `parcels-${RUN}.oto.tools`, contextPath: '/' });
  ids.api = api.id;
  ids.plan = api.draft.plans[0].id;
  await ok('POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'people', deploy: true });
  // Dana signs up on the portal, makes an application of her own and subscribes: self-service
  const signed = await portal('POST', '/auth/signup', DANA);
  ids.dana = (await ok('GET', `/users?q=${encodeURIComponent(DANA.email)}`)).items[0].id;
  const app = await portal('POST', '/applications', { name: 'Parcel tracker' }, signed.cookie);
  ids.app = app.body.id;
  ids.personalTeam = app.body.team_id;
  ids.sub = (await portal('POST', '/subscriptions', { api_id: api.id, plan_id: ids.plan, application_id: ids.app }, signed.cookie)).body.id;
  // and a team she shares with Erin, a producer
  await ok('POST', `/workspaces/${WS}/members`, { ...ERIN, role: 'producer' });
  ids.erin = (await ok('GET', `/users?q=${encodeURIComponent(ERIN.email)}`)).items[0].id;
  ids.shared = (await ok('POST', `/workspaces/${WS}/teams`, { name: 'Logistics', owner_id: ids.erin })).id;
  await ok('POST', `/workspaces/${WS}/teams/${ids.shared}/members`, { user_id: ids.dana });
  await ok('POST', `/workspaces/${WS}/members`, { email: DANA.email, role: 'producer' });
  ids.danaToken = await tokenOf(DANA);
  ids.erinToken = await tokenOf(ERIN);
});

afterAll(async () => {
  try {
    for (const a of (await call('GET', `/workspaces/${WS}/apis`)).body || []) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await call('DELETE', `/workspaces/${WS}`);
    await call('DELETE', `/users/${ids.erin}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('deleting a person', () => {
  test('is an installation administrator’s act, never on oneself nor on a bootstrap administrator', async () => {
    expect((await call('DELETE', `/users/${ids.dana}`, null, ids.erinToken)).status).toBe(403);
    const me = (await ok('GET', '/me')).user;
    const self = await call('DELETE', `/users/${me.id}`);
    expect(self.status).toBe(400);
    expect(self.body.error).toContain('yourself');
    // a bootstrap administrator is made again at start: the variable decides
    config.bootstrap.admins.push(ERIN.email);
    try {
      const bootstrap = await call('DELETE', `/users/${ids.erin}`);
      expect(bootstrap.status).toBe(400);
      expect(bootstrap.body.error).toContain('APIM_BOOTSTRAP_ADMINS');
      expect((await ok('GET', `/users?q=${encodeURIComponent(ERIN.email)}`)).items[0].bootstrap).toBe(true);
    } finally {
      config.bootstrap.admins.pop();
    }
    expect((await call('DELETE', '/users/nobody@people.test')).status).toBe(404);
  });

  test('closes the subscriptions of their personal applications, deletes them, and takes their access', async () => {
    expect((await call('GET', '/me', null, ids.danaToken)).status).toBe(200);
    // her subscription is on the gateway: her key calls
    expect(await until(async () => !!(await oto.getSubscription(ids.sub)))).toBe(true);
    // by email as well as by id — and while the gateway does not answer: the closing waits in the queue,
    // its subscription already gone from the product with the application
    const real = { get: oto.getSubscription, del: oto.deleteSubscription };
    oto.getSubscription = oto.deleteSubscription = async () => {
      throw new Error('gateway unreachable');
    };
    let r;
    try {
      r = await ok('DELETE', `/users/${encodeURIComponent(DANA.email)}`);
    } finally {
      oto.getSubscription = real.get;
      oto.deleteSubscription = real.del;
    }
    expect(!!(await oto.getSubscription(ids.sub))).toBe(true);
    expect(r).toEqual({ id: ids.dana, email: DANA.email, applications: 1, subscriptions: 1 });
    // the subscription closed, then gone with the application and the personal team
    expect(await db`select id from subscriptions where id = ${ids.sub}`).toEqual([]);
    expect((await call('GET', `/workspaces/${WS}/applications/${ids.app}`)).status).toBe(404);
    // and gone from the gateway, which revokes its key, though its row went before its closing was projected
    expect(await until(async () => !(await oto.getSubscription(ids.sub)))).toBe(true);
    expect(await db`select id from teams where id = ${ids.personalTeam}`).toEqual([]);
    // the person, their token, their sessions, their memberships
    expect((await ok('GET', `/users?q=${encodeURIComponent(DANA.email)}`)).items).toEqual([]);
    expect((await call('GET', '/me', null, ids.danaToken)).status).toBe(401);
    for (const table of ['sessions', 'api_tokens', 'workspace_members', 'team_members']) expect(await db.unsafe(`select 1 from ${table} where user_id = $1`, [ids.dana])).toEqual([]);
    // the team shared with Erin stays, hers
    const team = (await ok('GET', `/workspaces/${WS}/teams`)).find((t) => t.id === ids.shared);
    expect(team.name).toBe('Logistics');
    // and the audit trail says it
    const trail = await db`select summary from audit_events where action = 'user.delete' and entity_id = ${ids.dana}`;
    expect(trail[0].summary).toContain('1 application(s), 1 subscription(s) closed');
  });
});
