// The announcements of an api, against a real server: posts on its page in the portal, across its
// versions, its subscribers told — the subscribers of every version, once per team, nobody else —;
// corrected without telling again; and a version deprecated or archived told to its subscribers.
//
// Needs the docker stack (mise run up): the apis are deployed, the subscriptions projected.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'announcements-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const WS = `announce-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const PASSWORD = 'a-long-enough-password';
const people = { alice: `alice-${RUN}@announce.test`, bob: `bob-${RUN}@announce.test` };
let server;
const state = { cookies: {} };

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer announcements-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function portal(who, method, path, body) {
  const res = await fetch(`${ROOT}/${WS}/front/api${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { cookie: state.cookies[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const told = async (who, kind) => (await portal(who, 'GET', '/notifications?limit=200')).body.items.filter((n) => n.kind === kind);

async function anApi(team, name) {
  const api = await ok('POST', `/workspaces/${WS}/apis`, { name, version: '1.0.0', team_id: team.id, domain: `${name.toLowerCase()}-${RUN}.oto.tools`, contextPath: '/' });
  const draft = api.draft;
  draft.plans = [{ ...draft.plans[0], status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  await ok('PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok('POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'first', deploy: true });
  return { id: api.id, slug: api.slug, plan: draft.plans[0].id };
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Announce ${RUN}`, slug: WS });
  const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Makers' });
  state.atlas = await anApi(team, 'Atlas');
  state.beacon = await anApi(team, 'Beacon');
  for (const [who, email] of Object.entries(people)) {
    await ok('POST', `/workspaces/${WS}/members`, { email, name: who, password: PASSWORD, role: 'consumer' });
    const login = await fetch(`${ROOT}/${WS}/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    state.cookies[who] = login.headers.get('set-cookie').split(';')[0];
  }
  // alice on the first version of Atlas, bob on Beacon only
  for (const [who, api] of [['alice', state.atlas], ['bob', state.beacon]]) {
    const app = (await portal(who, 'POST', '/applications', { name: `${who} app` })).body;
    expect((await portal(who, 'POST', '/subscriptions', { api_id: api.id, plan_id: api.plan, application_id: app.id })).body.status).toBe('active');
  }
  // a second version of Atlas, nobody on it yet
  state.atlas2 = await ok('POST', `/workspaces/${WS}/apis/${state.atlas.id}/versions`, { version: '2.0.0' });
});

afterAll(async () => {
  try {
    for (const a of [state.atlas, state.atlas2, state.beacon]) if (a) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await db`delete from applications where workspace_id = (select id from workspaces where slug = ${WS})`;
    await call('DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email in ${db(Object.values(people))}`) {
      for (const t of ['sessions', 'team_members', 'workspace_members', 'notification_states', 'api_tokens']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from teams where personal = true and id not in (select team_id from team_members)`.catch(() => null);
      await db`delete from users where id = ${u.id}`.catch(() => null);
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('the announcements of an api', () => {
  test('published at once on its page in the portal, across its versions; the subscribers of every version told, nobody else', async () => {
    // written from the page of the second version: alice, on the first one, is told
    const base = `/workspaces/${WS}/apis/${state.atlas2.id}/announcements`;
    const n = await ok('POST', base, { title: 'Version 2 is out', body: 'Move to **2.0.0** before June.' });
    expect(n.told).toBe(1);
    const mine = await told('alice', 'api.announcement');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Atlas — Version 2 is out', body: 'Move to 2.0.0 before June.', link: `/apis/${state.atlas.slug}/announcements/${n.id}` });
    expect(await told('bob', 'api.announcement')).toEqual([]);
    // on the page of the api, for anyone who can see it, whatever the version shown
    const page = (await portal(null, 'GET', `/apis/${state.atlas.id}/announcements`)).body;
    expect(page.map((x) => [x.title, x.body])).toEqual([['Version 2 is out', 'Move to **2.0.0** before June.']]);
    expect(Object.keys(page[0]).sort()).toEqual(['author_name', 'body', 'created_at', 'id', 'title', 'updated_at']);
    expect((await portal(null, 'GET', `/apis/${state.atlas.id}`)).body.announcements_count).toBe(1);
    expect((await portal(null, 'GET', `/apis/${state.beacon.id}`)).body.announcements_count).toBe(0);
    // in the audit trail
    const trail = await ok('GET', `/workspaces/${WS}/audit?action=api.announcement.publish`);
    expect((trail.items || trail)[0].summary).toBe('announcement "Version 2 is out" published on Atlas, 1 team(s) of subscribers told');
    state.first = n.id;
  });

  test('corrected without telling again, published quietly, deleted; a title is required', async () => {
    const base = `/workspaces/${WS}/apis/${state.atlas.id}/announcements`;
    expect((await ok('PUT', `${base}/${state.first}`, { title: 'Version 2 is out, at last' })).title).toBe('Version 2 is out, at last');
    const quiet = await ok('POST', base, { title: 'A typo fixed in the docs', notify: false });
    expect(quiet.told).toBe(0);
    expect(await told('alice', 'api.announcement')).toHaveLength(1);
    expect((await ok('GET', base)).map((x) => x.title)).toEqual(['A typo fixed in the docs', 'Version 2 is out, at last']);
    expect((await call('POST', base, { title: '  ' })).status).toBe(400);
    expect((await call('POST', base, { title: 'x'.repeat(201) })).status).toBe(400);
    await ok('DELETE', `${base}/${quiet.id}`);
    expect((await call('DELETE', `${base}/${quiet.id}`)).status).toBe(404);
    expect((await ok('GET', base)).map((x) => x.id)).toEqual([state.first]);
  });

  test('a version deprecated, then archived: its subscribers told each time, once', async () => {
    const lifecycle = (v) => ok('POST', `/workspaces/${WS}/apis/${state.atlas.id}/lifecycle`, { lifecycle: v });
    await lifecycle('deprecated');
    await lifecycle('deprecated');
    const deprecated = await told('alice', 'api.deprecated');
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0]).toMatchObject({ title: 'Atlas 1.0.0 is deprecated', link: `/apis/${state.atlas.id}` });
    expect(await told('bob', 'api.deprecated')).toEqual([]);
    await lifecycle('archived');
    expect((await told('alice', 'api.archived')).map((x) => x.title)).toEqual(['Atlas 1.0.0 is archived']);
  });
});
