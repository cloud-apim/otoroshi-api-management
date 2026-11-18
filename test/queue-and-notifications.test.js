// What the console asks someone to look at: the notifications of a person, read and done on their
// own even when they were addressed to a whole team; the failed projections of the queue, told
// apart from the waiting ones, dismissed when they no longer apply.
//
// Needs the database of the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'follow-up-token';

const { start } = await import('../server/main.js');
const { db, newId } = await import('../server/db/index.js');
const { notify } = await import('../server/domain/notifications.js');
const { dismissObsolete } = await import('../server/domain/tasks.js');

const RUN = Date.now().toString(36);
const WS = `follow-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const email = (who) => `${who}-${RUN}@follow-up.test`;
const PASSWORD = `pw-${RUN}-secret`;
let server;
const tokens = { admin: 'follow-up-token' };
const ids = {};

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
async function tokenOf(who) {
  const login = await fetch(`${ROOT}/backoffice/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email(who), password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${ROOT}/backoffice/api/me/tokens`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'follow-up test' }) });
  return (await res.json()).token;
}
const notes = (who, filter = 'open') => ok(who, 'GET', `/workspaces/${WS}/notifications?filter=${filter}`);

beforeAll(async () => {
  server = await start();
  ids.ws = (await ok('admin', 'POST', '/workspaces', { name: `Follow-up ${RUN}`, slug: WS })).id;
  for (const who of ['ann', 'ben']) {
    await ok('admin', 'POST', `/workspaces/${WS}/members`, { email: email(who), name: who, password: PASSWORD, role: 'producer' });
    ids[who] = (await ok('admin', 'GET', `/users?q=${encodeURIComponent(email(who))}`))[0].id;
    tokens[who] = await tokenOf(who);
  }
  ids.team = (await ok('admin', 'POST', `/workspaces/${WS}/teams`, { name: 'Ops', owner_id: ids.ann })).id;
  await ok('ann', 'POST', `/workspaces/${WS}/teams/${ids.team}/members`, { email: email('ben') });
});

afterAll(async () => {
  try {
    await db`delete from tasks where payload->>'test_run' = ${RUN}`;
    await ok('admin', 'DELETE', `/workspaces/${WS}`);
    const mine = await db`select id from users where email like ${`%-${RUN}@follow-up.test`}`;
    for (const u of mine) {
      for (const t of ['api_tokens', 'sessions', 'team_members', 'workspace_members', 'notification_states']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from users where id = ${u.id}`;
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('notifications', () => {
  test('one addressed to a team: each member reads it on their own', async () => {
    await notify({ workspaceId: ids.ws, teamId: ids.team, face: 'console', kind: 'test', title: 'A transfer declined', link: '/subscriptions' });
    const [annView, benView] = [await notes('ann'), await notes('ben')];
    expect(annView.unread).toBe(1);
    expect(benView.unread).toBe(1);
    ids.note = annView.items[0].id;
    // opening the list reads nothing: reading is said
    expect((await notes('ann')).unread).toBe(1);
    expect((await ok('ann', 'POST', `/workspaces/${WS}/notifications/read`, { ids: [ids.note] })).unread).toBe(0);
    expect((await notes('ann')).items[0].read_at).toBeTruthy();
    expect((await notes('ben')).unread).toBe(1);
  });

  test('done: out of one person’s list, still in the others’', async () => {
    await ok('ann', 'POST', `/workspaces/${WS}/notifications/done`, { ids: [ids.note] });
    expect((await notes('ann')).items).toEqual([]);
    expect((await notes('ann', 'done')).items.map((n) => n.id)).toEqual([ids.note]);
    expect((await notes('ben')).items.map((n) => n.id)).toEqual([ids.note]);
    // undone
    await ok('ann', 'POST', `/workspaces/${WS}/notifications/done`, { ids: [ids.note], done: false });
    expect((await notes('ann')).items.map((n) => n.id)).toEqual([ids.note]);
    // ben reads everything at once
    await ok('ben', 'POST', `/workspaces/${WS}/notifications/read`, {});
    expect((await notes('ben')).unread).toBe(0);
  });

  test('nobody marks the notifications of others', async () => {
    await notify({ workspaceId: ids.ws, userId: ids.ann, face: 'console', kind: 'test', title: 'For Ann alone' });
    const own = (await notes('ann', 'unread')).items.find((n) => n.title === 'For Ann alone');
    expect((await notes('ben', 'all')).items.map((n) => n.id)).not.toContain(own.id);
    await ok('ben', 'POST', `/workspaces/${WS}/notifications/done`, { ids: [own.id] });
    expect((await notes('ann', 'unread')).items.map((n) => n.id)).toContain(own.id);
  });
});

describe('the projection queue', () => {
  // the workers of another instance may be at work on the same queue: what they do is the same
  const failed = async (kind, payload) => {
    const id = newId('task');
    await db`insert into tasks (id, kind, payload, status, attempts, last_error) values (${id}, ${kind}, ${{ ...payload, workspace_id: ids.ws, test_run: RUN }}, 'failed', 1, 'otoroshi 400: wrong status api')`;
    return id;
  };

  test('a failed projection whose subscription is gone is dismissed by itself, and says why', async () => {
    const id = await failed('sync_subscription', { subscription_id: `sub_gone_${RUN}` });
    const before = await ok('admin', 'GET', `/gateway/tasks?q=${RUN}`);
    expect(before.items.find((t) => t.id === id).target).toEqual({ kind: 'subscription', missing: true, label: 'a subscription that no longer exists' });
    await dismissObsolete();
    const task = (await ok('admin', 'GET', `/gateway/tasks?q=${RUN}`)).items.find((t) => t.id === id);
    expect(task.status).toBe('dismissed');
    expect(task.payload.dismissed).toBe('its subscription no longer exists');
  });

  test('an operator dismisses a failed one, never a done one; it no longer counts', async () => {
    const id = await failed('purge_api', { api_id: `api_whatever_${RUN}` });
    const failedBefore = (await ok('admin', 'GET', '/gateway/status')).queue.failed || 0;
    expect((await as('ann', 'POST', `/gateway/tasks/${id}/dismiss`, {})).status).toBe(403);
    expect((await ok('admin', 'POST', `/gateway/tasks/${id}/dismiss`, {})).status).toBe('dismissed');
    expect((await ok('admin', 'GET', '/gateway/status')).queue.failed || 0).toBe(failedBefore - 1);
    expect((await as('admin', 'POST', `/gateway/tasks/${id}/dismiss`, {})).status).toBe(400);
  });
});
