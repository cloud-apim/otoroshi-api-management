// Messages, against a real server: a person of the portal opens a conversation with the workspace —
// about an API, a subscription of theirs, or nothing —, routed to the team that answers, the
// administrators seeing them all and another team none; each side told of the other's message, its
// unread marks following; closed, and reopened when the person writes again.
//
// Needs the docker stack (mise run up): the API is deployed, the subscription projected.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'messages-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const WS = `messages-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const PASSWORD = `pw-${RUN}-secret`;
const email = (who) => `${who}-${RUN}@messages.test`;
let server;
const ids = {};
const tokens = { admin: 'messages-test-token' };
const cookies = {};

async function as(who, method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(who, method, path, body) {
  const r = await as(who, method, path, body);
  if (r.status >= 300) throw new Error(`${who} ${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function portal(who, method, path, body) {
  const res = await fetch(`${ROOT}/${WS}/front/api${path}`, { method, headers: { 'content-type': 'application/json', cookie: cookies[who] }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function tokenOf(who) {
  const login = await fetch(`${ROOT}/backoffice/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email(who), password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${ROOT}/backoffice/api/me/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'messages test' }) });
  return (await res.json()).token;
}
const inbox = (who) => ok(who, 'GET', `/workspaces/${WS}/conversations`);
const told = (kind, where) => db`select * from notifications where workspace_id = ${ids.ws} and kind = ${kind} and (${where.team || null}::text is null or team_id = ${where.team || null}) and (${where.user || null}::text is null or user_id = ${where.user || null})`;

beforeAll(async () => {
  server = await start();
  ids.ws = (await ok('admin', 'POST', '/workspaces', { name: `Messages ${RUN}`, slug: WS })).id;
  for (const [who, role] of [['ada', 'admin'], ['bob', 'producer'], ['carl', 'producer'], ['alice', 'consumer'], ['eve', 'consumer']]) {
    await ok('admin', 'POST', `/workspaces/${WS}/members`, { email: email(who), name: who, password: PASSWORD, role });
    ids[who] = (await ok('admin', 'GET', `/users?q=${encodeURIComponent(email(who))}`)).items[0].id;
    if (role !== 'consumer') tokens[who] = await tokenOf(who);
    else {
      const login = await fetch(`${ROOT}/${WS}/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email(who), password: PASSWORD }) });
      cookies[who] = login.headers.get('set-cookie').split(';')[0];
    }
  }
  ids.makers = (await ok('admin', 'POST', `/workspaces/${WS}/teams`, { name: 'Makers', owner_id: ids.bob })).id;
  ids.others = (await ok('admin', 'POST', `/workspaces/${WS}/teams`, { name: 'Others', owner_id: ids.carl })).id;
  const api = await ok('admin', 'POST', `/workspaces/${WS}/apis`, { name: 'Atlas', version: '1.0.0', team_id: ids.makers, domain: `atlas-${RUN}.oto.tools`, contextPath: '/' });
  const draft = api.draft;
  draft.plans = [{ ...draft.plans[0], status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  await ok('admin', 'PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok('admin', 'POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'first', deploy: true });
  ids.api = api.id;
  ids.slug = api.slug;
  const app = (await portal('alice', 'POST', '/applications', { name: 'Alice app' })).body;
  ids.sub = (await portal('alice', 'POST', '/subscriptions', { api_id: api.id, plan_id: draft.plans[0].id, application_id: app.id })).body.id;
});

afterAll(async () => {
  try {
    await as('admin', 'DELETE', `/workspaces/${WS}/apis/${ids.api}`);
    await db`delete from applications where workspace_id = ${ids.ws}`;
    await as('admin', 'DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email like ${`%-${RUN}@messages.test`}`) {
      for (const t of ['api_tokens', 'sessions', 'team_members', 'workspace_members', 'notification_states', 'conversation_reads']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from teams where personal = true and id not in (select team_id from team_members)`.catch(() => null);
      await db`delete from users where id = ${u.id}`;
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('a conversation', () => {
  test('about an API: routed to its team and told there; another team does not see it, the administrators see them all', async () => {
    const r = await portal('alice', 'POST', '/conversations', { title: 'A higher quota for a batch', body: 'Can the **Partner** plan take 10k calls a day?', subject: { kind: 'api', id: ids.slug } });
    expect(r.status).toBe(200);
    ids.conv = r.body.id;
    expect(r.body).toMatchObject({ team_id: ids.makers, subject_kind: 'api', subject_id: ids.api, subject_label: 'Atlas 1.0.0', status: 'open' });
    expect((await told('message.received', { team: ids.makers })).map((n) => n.title)).toEqual(['alice — A higher quota for a batch']);
    const bobs = await inbox('bob');
    expect(bobs.items.map((c) => [c.id, c.unread, c.person_email])).toEqual([[ids.conv, true, email('alice')]]);
    expect((await inbox('carl')).items).toEqual([]);
    expect((await as('carl', 'GET', `/workspaces/${WS}/conversations/${ids.conv}`)).status).toBe(403);
    expect((await inbox('ada')).items.map((c) => c.id)).toEqual([ids.conv]);
    // the person's own inbox: she wrote last, nothing unread
    const mine = (await portal('alice', 'GET', '/conversations')).body;
    expect(mine.items.map((c) => [c.id, c.unread])).toEqual([[ids.conv, false]]);
    expect((await portal('eve', 'GET', '/conversations')).body.items).toEqual([]);
    expect((await portal('eve', 'GET', `/conversations/${ids.conv}`)).status).toBe(404);
  });

  test('answered by the workspace: the person told; the unread marks follow each side', async () => {
    expect((await ok('bob', 'GET', `/workspaces/${WS}/conversations/unread`)).count).toBe(1);
    const read = await ok('bob', 'GET', `/workspaces/${WS}/conversations/${ids.conv}`);
    expect(read.messages.map((m) => [m.side, m.author_email])).toEqual([['person', email('alice')]]);
    expect((await ok('bob', 'GET', `/workspaces/${WS}/conversations/unread`)).count).toBe(0);
    // ada read nothing yet: hers is unread still
    expect((await ok('ada', 'GET', `/workspaces/${WS}/conversations/unread`)).count).toBe(1);

    await ok('bob', 'POST', `/workspaces/${WS}/conversations/${ids.conv}/messages`, { body: 'Yes: ask for the **Gold** plan, it takes 20k.' });
    expect((await told('message.reply', { user: ids.alice })).map((n) => [n.title, n.link])).toEqual([['A higher quota for a batch: an answer', `/messages/${ids.conv}`]]);
    expect((await portal('alice', 'GET', '/conversations/unread')).body.count).toBe(1);
    const thread = (await portal('alice', 'GET', `/conversations/${ids.conv}`)).body;
    expect(thread.messages.map((m) => [m.side, m.body])).toEqual([
      ['person', 'Can the **Partner** plan take 10k calls a day?'],
      ['workspace', 'Yes: ask for the **Gold** plan, it takes 20k.'],
    ]);
    expect((await portal('alice', 'GET', '/conversations/unread')).body.count).toBe(0);
    // the person writes again: the workspace's turn
    expect((await portal('alice', 'POST', `/conversations/${ids.conv}/messages`, { body: 'Thanks!' })).status).toBe(200);
    expect((await ok('bob', 'GET', `/workspaces/${WS}/conversations/unread`)).count).toBe(1);
  });

  test('about a subscription of theirs only, or about nothing — the administrators answer —; closed, reopened when the person writes; checked', async () => {
    const about = await portal('alice', 'POST', '/conversations', { title: 'My key', body: 'Rotated by mistake?', subject: { kind: 'subscription', id: ids.sub } });
    expect(about.body).toMatchObject({ subject_label: 'Alice app → Atlas 1.0.0', team_id: ids.makers });
    expect((await portal('eve', 'POST', '/conversations', { title: 'Not mine', body: 'x', subject: { kind: 'subscription', id: ids.sub } })).status).toBe(403);
    const general = (await portal('eve', 'POST', '/conversations', { title: 'An invoice', body: 'Where are the invoices?' })).body;
    expect(general.team_id).toBeNull();
    expect((await inbox('bob')).items.map((c) => c.id)).not.toContain(general.id);
    expect((await inbox('ada')).items.map((c) => c.id)).toContain(general.id);
    expect((await told('message.received', { user: ids.ada })).length).toBeGreaterThanOrEqual(1);
    expect((await portal('eve', 'POST', '/conversations', { title: ' ', body: 'x' })).status).toBe(400);
    expect((await portal('eve', 'POST', '/conversations', { title: 'x', body: '' })).status).toBe(400);
    expect((await portal('eve', 'POST', '/conversations', { title: 'x', body: 'y', subject: { kind: 'team', id: 'x' } })).status).toBe(400);

    expect((await ok('bob', 'POST', `/workspaces/${WS}/conversations/${ids.conv}/close`)).status).toBe('closed');
    expect((await ok('bob', 'GET', `/workspaces/${WS}/conversations?status=open`)).items.map((c) => c.id)).not.toContain(ids.conv);
    await portal('alice', 'POST', `/conversations/${ids.conv}/messages`, { body: 'One more question.' });
    expect((await ok('bob', 'GET', `/workspaces/${WS}/conversations/${ids.conv}`)).status).toBe('open');
    const trail = await ok('admin', 'GET', `/workspaces/${WS}/audit?action=conversation.open`);
    expect((trail.items || trail).map((e) => e.summary)).toContain(`conversation "A higher quota for a batch" opened by ${email('alice')}, about Atlas 1.0.0`);
  });
});
