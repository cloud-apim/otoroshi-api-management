// Outgoing webhooks, against a real server and a receiver of the test: an endpoint checked — an http(s)
// url, not on a private network unless allowed —, its whsec_ secret sealed; the events of the workspace
// signed as Standard Webhooks, filtered by type; retried on their schedule, then kept failed and told,
// replayed by hand with the same id; Retry-After honoured, 410 and five days of failures turning it off;
// a test, a rotation signing with both secrets, the deliveries kept 30 days.
//
// Needs the database of the docker stack (mise run up). Its product shares the database and runs the
// worker of the webhooks: it cannot reach the receiver of the test (the host refuses its containers), so
// the endpoints of the test stay off for it — the test fans their events out and sends them itself.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { createHmac } from 'node:crypto';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'webhooks-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { audit } = await import('../server/domain/audit.js');
const webhooks = await import('../server/domain/webhooks.js');

const RUN = Date.now().toString(36);
const WS = `hooks-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const DAY = 86400e3;
let server;
const ids = {};

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer webhooks-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// the receiver: what it was sent, and what it answers
const receiver = { requests: [], answer: () => new Response('ok') };
const rx = Bun.serve({
  port: 0,
  async fetch(req) {
    const r = { path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() };
    receiver.requests.push(r);
    return receiver.answer(r);
  },
});
const URL_OF = (path) => `http://localhost:${rx.port}${path}`;

// Standard Webhooks, verified as a receiver would: base64 HMAC-SHA256 of "id.timestamp.body", the key
// the base64 after whsec_; one of the signatures of the header
const verifies = (r, secret) => {
  const expected = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${r.headers['webhook-id']}.${r.headers['webhook-timestamp']}.${r.body}`).digest('base64');
  return r.headers['webhook-signature'].split(' ').includes(`v1,${expected}`);
};

const event = (action, summary = action) => audit({ user: { id: 'usr_test', email: `ops-${RUN}@hooks.test`, name: 'ops' }, via: 'test' }, { action, workspaceId: ids.ws, entityKind: 'team', entityId: 'team_x', summary, data: { run: RUN } });
const LATER = new Date(Date.now() + 365 * DAY);
const deliveries = (endpointId) => db`select * from webhook_deliveries where endpoint_id = ${endpointId} order by created_at, id`;
// the events of an endpoint fanned out, due later for any other worker; then each pending one sent once
const fan = (endpointId) => webhooks.fanOut({ endpointId, nextAt: LATER });
async function sendPending(endpointId) {
  for (const d of await db`select * from webhook_deliveries where endpoint_id = ${endpointId} and status = 'pending' order by created_at`) await webhooks.attempt(d);
}
const told = (kind) => db`select * from notifications where workspace_id = ${ids.ws} and kind = ${kind}`;
// each administrator of the workspace is told: the people the token made and ada
const admins = async () => (await db`select count(*)::int as n from workspace_members where workspace_id = ${ids.ws} and role = 'admin'`)[0].n;

beforeAll(async () => {
  server = await start();
  ids.ws = (await ok('POST', '/workspaces', { name: `Hooks ${RUN}`, slug: WS })).id;
  await ok('POST', `/workspaces/${WS}/members`, { email: `ada-${RUN}@hooks.test`, name: 'ada', password: `pw-${RUN}-secret`, role: 'admin' });
});

afterAll(async () => {
  try {
    await call('DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email like ${`%-${RUN}@hooks.test`}`) {
      for (const t of ['api_tokens', 'sessions', 'team_members', 'workspace_members', 'notification_states']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from users where id = ${u.id}`;
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  config.webhooks.allowPrivate = true;
  rx.stop(true);
  server?.stop(true);
});

describe('an endpoint', () => {
  test('an http(s) url, not on a private network unless the installation allows it; a whsec_ secret, sealed, shown masked', async () => {
    config.webhooks.allowPrivate = false;
    for (const url of [URL_OF('/hook'), 'http://localhost/hook', 'http://10.1.2.3/hook', 'http://[::1]/hook']) {
      const r = await call('POST', `/workspaces/${WS}/webhooks`, { url });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('private network');
    }
    expect((await call('POST', `/workspaces/${WS}/webhooks`, { url: 'ftp://example.com/x' })).status).toBe(400);
    expect((await call('POST', `/workspaces/${WS}/webhooks`, { url: 'https://user:pw@example.com/x' })).body.error).toContain('no credentials');
    config.webhooks.allowPrivate = true;
    expect((await call('POST', `/workspaces/${WS}/webhooks`, { url: URL_OF('/hook'), types: ['Not A Type'] })).status).toBe(400);
    const made = await ok('POST', `/workspaces/${WS}/webhooks`, { name: 'all', url: URL_OF('/hook'), types: ['*'], enabled: false });
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    ids.all = made.id;
    ids.secret = made.secret;
    const listed = (await ok('GET', `/workspaces/${WS}/webhooks`)).find((e) => e.id === ids.all);
    expect(listed.secret).toContain('••');
    expect(listed.secret).not.toBe(ids.secret);
    expect((await db`select secret from webhook_endpoints where id = ${ids.all}`)[0].secret).toStartWith('enc:v1:');
    expect((await ok('POST', `/workspaces/${WS}/webhooks/${ids.all}/secret`)).secret).toBe(ids.secret);
    ids.subs = (await ok('POST', `/workspaces/${WS}/webhooks`, { name: 'subscriptions', url: URL_OF('/subs'), types: 'subscription.*', enabled: false })).id;
  });
});

describe('the events of the workspace', () => {
  test('signed as Standard Webhooks, each endpoint taking its types; a read only when named', async () => {
    receiver.requests.length = 0;
    await event('team.create', `team Ops created ${RUN}`);
    await event('subscription.accept', 'subscription sub_1 accepted');
    await event('credential.read', 'credentials read');
    await fan(ids.all);
    await fan(ids.subs);
    // the creation of the second endpoint is an event of the workspace too
    expect((await deliveries(ids.all)).map((d) => d.type)).toEqual(['webhook.create', 'team.create', 'subscription.accept']);
    expect((await deliveries(ids.subs)).map((d) => d.type)).toEqual(['subscription.accept']);
    // fanned out once, whatever runs it again
    await fan(ids.all);
    expect(await deliveries(ids.all)).toHaveLength(3);
    await sendPending(ids.all);
    const first = receiver.requests.find((r) => JSON.parse(r.body).type === 'team.create');
    expect(first.path).toBe('/hook');
    expect(first.headers['webhook-id']).toMatch(/^msg_/);
    expect(Math.abs(Number(first.headers['webhook-timestamp']) - Date.now() / 1000)).toBeLessThan(30);
    expect(verifies(first, ids.secret)).toBe(true);
    const payload = JSON.parse(first.body);
    expect(payload).toMatchObject({ type: 'team.create', workspace: { id: ids.ws, slug: WS }, data: { summary: `team Ops created ${RUN}`, entity: { kind: 'team', id: 'team_x' }, actor: { email: `ops-${RUN}@hooks.test` }, details: { run: RUN } } });
    expect(JSON.stringify(payload)).not.toContain('"ip"');
    expect((await deliveries(ids.all)).map((d) => d.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  });
});

describe('the retries', () => {
  test('on their schedule; then kept failed, the administrators told once; replayed by hand with the same id', async () => {
    receiver.answer = () => new Response('down', { status: 500 });
    await event('team.update', 'team Ops renamed');
    await fan(ids.all);
    const [d] = await db`select * from webhook_deliveries where endpoint_id = ${ids.all} and type = 'team.update'`;
    let row = await webhooks.attempt(d);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: 500 });
    const after = (await db`select next_at from webhook_deliveries where id = ${d.id}`)[0].next_at;
    expect(new Date(after) - Date.now()).toBeGreaterThan(3000);
    expect(new Date(after) - Date.now()).toBeLessThan(7000);
    // the next ones: 5 min, 30 min, 2 h, 5 h, 10 h, 10 h — eight attempts in all
    for (let i = 2; i <= 8; i++) row = await webhooks.attempt((await db`select * from webhook_deliveries where id = ${d.id}`)[0]);
    expect(row).toMatchObject({ status: 'failed', attempts: 8, last_error: 'the endpoint answered 500' });
    expect(await told('webhook.failing')).toHaveLength(await admins());
    // the same endpoint failing again: not told twice
    await event('team.update', 'team Ops renamed again');
    await fan(ids.all);
    const [again] = await db`select * from webhook_deliveries where endpoint_id = ${ids.all} and type = 'team.update' and status = 'pending'`;
    await db`update webhook_deliveries set attempts = 7 where id = ${again.id}`;
    await webhooks.attempt({ ...again, attempts: 7 });
    expect(await told('webhook.failing')).toHaveLength(await admins());
    // the endpoint answers again: replayed by hand, the same webhook-id
    receiver.answer = () => new Response('ok');
    receiver.requests.length = 0;
    const replayed = await ok('POST', `/workspaces/${WS}/webhooks/${ids.all}/deliveries/${d.id}/redeliver`);
    expect(replayed).toMatchObject({ id: d.id, status: 'succeeded', attempts: 1 });
    expect(receiver.requests.at(-1).headers['webhook-id']).toBe(d.id);
    expect((await db`select failing_since, told_at from webhook_endpoints where id = ${ids.all}`)[0]).toEqual({ failing_since: null, told_at: null });
    const page = await ok('GET', `/workspaces/${WS}/webhooks/${ids.all}/deliveries?status=failed`);
    expect(page.items.map((x) => x.id)).toEqual([again.id]);
  });

  test('Retry-After honoured; 410 turns the endpoint off; five days of failures too; the failed since a date replayed', async () => {
    receiver.answer = () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    await event('team.update', 'throttled');
    await fan(ids.all);
    const [t] = await db`select * from webhook_deliveries where endpoint_id = ${ids.all} and status = 'pending' and payload->'data'->>'summary' = 'throttled'`;
    await webhooks.attempt(t);
    const wait = new Date((await db`select next_at from webhook_deliveries where id = ${t.id}`)[0].next_at) - Date.now();
    expect(wait).toBeGreaterThan(110e3);
    expect(wait).toBeLessThan(125e3);

    receiver.answer = () => new Response('gone', { status: 410 });
    await webhooks.attempt((await db`select * from webhook_deliveries where id = ${t.id}`)[0]);
    const gone = (await db`select enabled, disabled_reason from webhook_endpoints where id = ${ids.all}`)[0];
    expect(gone).toEqual({ enabled: false, disabled_reason: 'its endpoint answered 410 Gone' });
    expect((await db`select status from webhook_deliveries where id = ${t.id}`)[0].status).toBe('failed');
    expect(await told('webhook.disabled')).toHaveLength(await admins());

    // five days failing in a row
    receiver.answer = () => new Response('down', { status: 503 });
    await event('team.update', 'five days');
    await fan(ids.all);
    await db`update webhook_endpoints set failing_since = ${new Date(Date.now() - 6 * DAY)}, disabled_reason = null where id = ${ids.all}`;
    const [f] = await db`select * from webhook_deliveries where endpoint_id = ${ids.all} and payload->'data'->>'summary' = 'five days'`;
    await webhooks.attempt(f);
    expect((await db`select disabled_reason from webhook_endpoints where id = ${ids.all}`)[0].disabled_reason).toBe('its endpoint has failed for five days in a row');
    expect((await db`select status from webhook_deliveries where id = ${f.id}`)[0].status).toBe('failed');

    // what failed since an hour, replayed once it answers
    receiver.answer = () => new Response('ok');
    const { replayed } = await ok('POST', `/workspaces/${WS}/webhooks/${ids.all}/recover`, { since: new Date(Date.now() - 3600e3).toISOString() });
    expect(replayed).toBeGreaterThanOrEqual(3);
    await sendPending(ids.all);
    expect((await db`select count(*)::int as n from webhook_deliveries where endpoint_id = ${ids.all} and status <> 'succeeded'`)[0].n).toBe(0);
    expect((await call('POST', `/workspaces/${WS}/webhooks/${ids.all}/recover`, {})).status).toBe(400);
  });
});

describe('by hand', () => {
  test('a test; a rotation signing with both secrets for a day; the deliveries kept 30 days', async () => {
    receiver.requests.length = 0;
    const tested = await ok('POST', `/workspaces/${WS}/webhooks/${ids.subs}/test`);
    expect(tested).toMatchObject({ type: 'webhook.test', status: 'succeeded' });
    expect(JSON.parse(receiver.requests.at(-1).body)).toMatchObject({ type: 'webhook.test', data: { webhook: { id: ids.subs } } });

    const old = (await ok('POST', `/workspaces/${WS}/webhooks/${ids.subs}/secret`)).secret;
    const { secret } = await ok('POST', `/workspaces/${WS}/webhooks/${ids.subs}/rotate`);
    expect(secret).not.toBe(old);
    await event('subscription.close', 'subscription sub_1 closed');
    await fan(ids.subs);
    await sendPending(ids.subs);
    const signed = receiver.requests.at(-1);
    expect(signed.headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verifies(signed, secret)).toBe(true);
    expect(verifies(signed, old)).toBe(true);
    // the reads of the secret are in the trail
    const trail = await ok('GET', `/workspaces/${WS}/audit?action=webhook.secret.read`);
    expect((trail.items || trail).filter((e) => e.entity_id === ids.subs)).toHaveLength(1);

    await db`update webhook_deliveries set created_at = now() - interval '31 days' where endpoint_id = ${ids.subs} and type = 'webhook.test'`;
    await webhooks.purge();
    expect((await deliveries(ids.subs)).map((d) => d.type)).toEqual(['subscription.accept', 'subscription.close']);
    expect((await ok('GET', `/workspaces/${WS}/webhook-types`))).toContain('team.create');
  });
});
