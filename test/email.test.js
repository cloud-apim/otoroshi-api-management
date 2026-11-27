// Email, against a real server and fake transports: the transport of the installation — SMTP, or a
// provider over its HTTP API — checked, its secrets masked and sealed, each provider called as its API
// takes it; the notifications of a workspace by email, off until its administrators turn them on, then
// kind by kind, to the people they are addressed to, each person once whatever the retries.
//
// Needs the database of the docker stack (mise run up). Changes the email settings of the installation
// for the time of the test, and puts them back.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'email-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { notify } = await import('../server/domain/notifications.js');
const { runTask } = await import('../server/domain/tasks.js');
const { invalidateEmailSettings } = await import('../server/domain/email.js');

const RUN = Date.now().toString(36);
const WS = `email-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const email = (who) => `${who}-${RUN}@email.test`;
let server;
let saved;
const ids = {};

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer email-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const settings = async (value) => {
  const r = await call('PUT', '/settings/email', value);
  invalidateEmailSettings();
  return r;
};

// a provider: what it was sent; an address of `failing` refused, a key `bad` unauthorized
const provider = { requests: [], failing: new Set() };
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    const r = { method: req.method, path: url.pathname, auth: req.headers.get('authorization'), type: req.headers.get('content-type'), text };
    provider.requests.push(r);
    const auth = r.auth || '';
    if (/bad/.test(auth.startsWith('Basic ') ? atob(auth.slice(6)) : auth)) return new Response('{"message":"unauthorized"}', { status: 401 });
    if ([...provider.failing].some((a) => text.includes(a))) return new Response('{"message":"refused"}', { status: 500 });
    return Response.json({ id: `msg-${provider.requests.length}` }, { status: url.pathname.includes('sendgrid') || url.pathname === '/v3/mail/send' ? 202 : 200 });
  },
});
const API_BASE = `http://localhost:${fake.port}`;

// an SMTP server: the mails it took, as the client wrote them
const smtpMails = [];
const smtp = Bun.listen({
  hostname: '127.0.0.1',
  port: 0,
  socket: {
    open(s) {
      s.data = { buf: '', inData: false, mail: { rcpt: [], data: '' } };
      s.write('220 fake ESMTP\r\n');
    },
    data(s, chunk) {
      s.data.buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = s.data.buf.indexOf('\r\n')) >= 0) {
        const line = s.data.buf.slice(0, i);
        s.data.buf = s.data.buf.slice(i + 2);
        if (s.data.inData) {
          if (line === '.') {
            s.data.inData = false;
            smtpMails.push(s.data.mail);
            s.data.mail = { rcpt: [], data: '' };
            s.write('250 OK queued\r\n');
          } else s.data.mail.data += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') (s.data.mail.from = line), s.write('250 OK\r\n');
        else if (cmd === 'RCPT') s.data.mail.rcpt.push(line), s.write('250 OK\r\n');
        else if (cmd === 'DATA') (s.data.inData = true), s.write('354 go on\r\n');
        else if (cmd === 'QUIT') s.write('221 bye\r\n'), s.end();
        else s.write('250 OK\r\n');
      }
    },
  },
});

// the tasks of a notification run, until the provider has seen what was expected (the worker of the
// product of the stack may hold a task for a moment)
async function deliver(notificationId, until) {
  for (let i = 0; i < 40; i++) {
    for (const t of await db`select id from tasks where kind = 'email_notification' and payload->>'notification_id' = ${notificationId} and status <> 'done'`) await runTask(t.id);
    if (await until()) return true;
    await Bun.sleep(250);
  }
  return false;
}
const tasksOf = async (notificationId) => (await db`select count(*)::int as n from tasks where kind = 'email_notification' and payload->>'notification_id' = ${notificationId}`)[0].n;
const to = (address) => provider.requests.filter((r) => r.text.includes(address));

beforeAll(async () => {
  server = await start();
  saved = (await db`select value from settings where key = 'email'`)[0]?.value || null;
  ids.ws = (await ok('POST', '/workspaces', { name: `Email ${RUN}`, slug: WS })).id;
  for (const who of ['alice', 'carl', 'bob']) {
    await ok('POST', `/workspaces/${WS}/members`, { email: email(who), name: who, password: `pw-${RUN}-secret`, role: who === 'bob' ? 'producer' : 'consumer' });
    ids[who] = (await ok('GET', `/users?q=${encodeURIComponent(email(who))}`)).items[0].id;
  }
  ids.users = (await ok('POST', `/workspaces/${WS}/teams`, { name: 'Users', owner_id: ids.alice })).id;
  await ok('POST', `/workspaces/${WS}/teams/${ids.users}/members`, { email: email('carl') });
  ids.makers = (await ok('POST', `/workspaces/${WS}/teams`, { name: 'Makers', owner_id: ids.bob })).id;
});

afterAll(async () => {
  try {
    if (saved) await db`update settings set value = ${saved}, updated_at = now() where key = 'email'`;
    else await db`delete from settings where key = 'email'`;
    invalidateEmailSettings();
    await db`delete from email_deliveries where address like ${`%-${RUN}@email.test`} or address = ${`someone-${RUN}@example.test`}`;
    await db`delete from tasks where kind = 'email_notification' and payload->>'workspace_id' = ${ids.ws}`;
    await call('DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email like ${`%-${RUN}@email.test`}`) {
      for (const t of ['api_tokens', 'sessions', 'team_members', 'workspace_members', 'notification_states']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from users where id = ${u.id}`;
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  fake.stop(true);
  smtp.stop(true);
  server?.stop(true);
});

describe('the transport of the installation', () => {
  test('checked, its secrets masked and sealed at rest', async () => {
    const lacking = await settings({ transport: 'sendgrid', from: 'Portal <no-reply@example.test>', apiKey: '' });
    expect(lacking.status).toBe(400);
    expect(lacking.body.error).toContain('the API key of sendgrid is needed');
    expect((await settings({ transport: 'carrier-pigeon' })).status).toBe(400);
    expect((await settings({ transport: 'sendgrid', from: 'not an address', apiKey: 'SG.secret-key' })).status).toBe(400);
    expect((await settings({ transport: 'sendgrid', from: 'Portal <no-reply@example.test>', apiKey: 'SG.secret-key', apiBase: API_BASE })).status).toBe(200);
    const shown = (await ok('GET', '/settings')).email;
    expect(shown).toMatchObject({ transport: 'sendgrid', ready: true, problems: [] });
    expect(shown.apiKey).toContain('••');
    expect(shown.apiKey).not.toContain('secret');
    const stored = (await db`select value from settings where key = 'email'`)[0].value;
    expect(stored.apiKey).toStartWith('enc:v1:');
    // the masked value sent back keeps the key
    expect((await settings({ ...shown, apiKey: shown.apiKey })).status).toBe(200);
  });

  test('a test email through each provider, as its API takes it', async () => {
    const someone = `someone-${RUN}@example.test`;
    provider.requests.length = 0;
    expect(await ok('POST', '/settings/email/test', { to: someone })).toMatchObject({ sent: true });
    const sg = provider.requests.at(-1);
    expect([sg.method, sg.path, sg.auth]).toEqual(['POST', '/v3/mail/send', 'Bearer SG.secret-key']);
    const sgBody = JSON.parse(sg.text);
    expect(sgBody.personalizations[0].to[0].email).toBe(someone);
    expect(sgBody.from).toEqual({ email: 'no-reply@example.test', name: 'Portal' });
    expect(sgBody.content.map((c) => c.type)).toEqual(['text/plain', 'text/html']);

    await settings({ transport: 'mailgun', apiKey: 'mg-key', domain: 'mg.example.test', region: 'eu' });
    expect((await ok('POST', '/settings/email/test', { to: someone })).sent).toBe(true);
    const mg = provider.requests.at(-1);
    expect([mg.path, mg.auth]).toEqual(['/v3/mg.example.test/messages', `Basic ${btoa('api:mg-key')}`]);
    expect(Object.fromEntries(new URLSearchParams(mg.text))).toMatchObject({ from: 'Portal <no-reply@example.test>', to: someone, subject: 'A test email from Otoroshi API Management' });

    await settings({ transport: 'mailjet', apiKey: 'mj-key', apiSecret: 'mj-secret' });
    expect((await ok('POST', '/settings/email/test', { to: someone })).sent).toBe(true);
    const mj = provider.requests.at(-1);
    expect([mj.path, mj.auth]).toEqual(['/v3.1/send', `Basic ${btoa('mj-key:mj-secret')}`]);
    expect(JSON.parse(mj.text).Messages[0]).toMatchObject({ From: { Email: 'no-reply@example.test', Name: 'Portal' }, To: [{ Email: someone }] });

    // what the provider refuses is said
    await settings({ transport: 'mailjet', apiKey: 'bad-key', apiSecret: 'mj-secret' });
    const refused = await ok('POST', '/settings/email/test', { to: someone });
    expect(refused.sent).toBe(false);
    expect(refused.error).toContain('Mailjet answered 401');

    await settings({ transport: 'smtp', smtp: { host: '127.0.0.1', port: smtp.port, security: 'none' } });
    expect((await ok('POST', '/settings/email/test', { to: someone })).sent).toBe(true);
    const mail = smtpMails.at(-1);
    expect(mail.rcpt[0]).toContain(someone);
    expect(mail.data).toContain('Subject: A test email from Otoroshi API Management');

    const log = await ok('GET', `/settings/email/deliveries?q=${encodeURIComponent(someone)}`);
    expect(log.items.map((d) => d.status)).toEqual(['sent', 'failed', 'sent', 'sent', 'sent']);
    expect(log.items[1].error).toContain('Mailjet answered 401');
  });
});

describe('the notifications of a workspace by email', () => {
  const note = (over = {}) => ({ workspaceId: ids.ws, teamId: ids.users, face: 'portal', kind: 'api.announcement', title: `Atlas — news ${RUN}`, body: 'Version 2 is out.', link: '/apis/atlas/announcements', ...over });

  test('off until its administrators turn it on: nothing queued', async () => {
    await settings({ transport: 'sendgrid', apiKey: 'SG.secret-key', apiBase: API_BASE });
    const view = await ok('GET', `/workspaces/${WS}/email`);
    expect(view).toMatchObject({ portal: { enabled: false }, console: { enabled: false }, transport: { transport: 'sendgrid', ready: true } });
    expect(view.kinds.portal).toContain('api.announcement');
    expect(view.kinds.console).toContain('subscription.request');
    expect(await tasksOf(await notify(note()))).toBe(0);
  });

  test('turned on for the portal: each person of the team gets it, once, whatever the retries', async () => {
    expect((await ok('PUT', `/workspaces/${WS}/email`, { portal: { enabled: true } })).portal).toEqual({ enabled: true, kinds: {} });
    provider.requests.length = 0;
    provider.failing.add(email('carl'));
    const id = await notify(note());
    expect(await deliver(id, async () => to(email('alice')).length === 1 && to(email('carl')).length >= 1)).toBe(true);
    const first = JSON.parse(to(email('alice'))[0].text);
    expect(first.subject).toBe(`Atlas — news ${RUN}`);
    expect(first.content[0].value).toContain(`/${WS}/apis/atlas/announcements`);
    // carl's failed: the task is tried again, and alice is not sent it twice
    provider.failing.clear();
    expect(await deliver(id, async () => (await db`select status from email_deliveries where notification_id = ${id} and user_id = ${ids.carl}`)[0]?.status === 'sent')).toBe(true);
    expect(to(email('alice'))).toHaveLength(1);
    expect((await db`select user_id, status from email_deliveries where notification_id = ${id} order by address`).map((d) => d.status)).toEqual(['sent', 'sent']);
    // the producers are not sent the notifications of the portal, nor theirs while their face is off
    expect(await tasksOf(await notify({ workspaceId: ids.ws, teamId: ids.makers, face: 'console', kind: 'subscription.request', title: 'Atlas — a request' }))).toBe(0);
  });

  test('kind by kind, and for the producers apart', async () => {
    await ok('PUT', `/workspaces/${WS}/email`, { portal: { enabled: true, kinds: { 'api.announcement': false, 'not.a.kind': false } }, console: { enabled: true } });
    const view = await ok('GET', `/workspaces/${WS}/email`);
    expect(view.portal.kinds).toEqual({ 'api.announcement': false });
    expect(await tasksOf(await notify(note()))).toBe(0);
    expect(await tasksOf(await notify(note({ kind: 'api.deprecated', title: 'Atlas 1.0.0 is deprecated' })))).toBe(1);
    provider.requests.length = 0;
    const id = await notify({ workspaceId: ids.ws, teamId: ids.makers, face: 'console', kind: 'subscription.request', title: `Atlas — a request ${RUN}`, link: '/subscriptions?open=sub_1' });
    expect(await deliver(id, async () => to(email('bob')).length === 1)).toBe(true);
    expect(JSON.parse(to(email('bob'))[0].text).content[0].value).toContain(`/backoffice/ws/${WS}/subscriptions?open=sub_1`);
    const trail = await ok('GET', `/workspaces/${WS}/audit?action=workspace.email.update`);
    expect((trail.items || trail)[0].summary).toBe('email to the people of the portal on, 1 kind(s) off, to the producers on');
  });
});
