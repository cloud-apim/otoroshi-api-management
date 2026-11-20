// The roles split across instances, and several instances of a role, on one database: each
// instance answers its roles and nothing else; a session made on one console instance is good on
// another; two instances with workers share the task queue without running a task twice.
//
// Needs the docker stack (mise run up): its database. Starts its own instances of the product on
// ports 9131-9133, and stops them.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { db } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const TOKEN = 'roles-test-token';
const INSTANCES = {
  // two instances of the console and the admin api, both running the workers
  a: { roles: 'api,backoffice', port: 9131, workers: true },
  b: { roles: 'api,backoffice', port: 9132, workers: true },
  // the ingester alone, the portal alone
  ingest: { roles: 'ingester', port: 9133, workers: false },
  portal: { roles: 'portal', port: 9134, workers: false },
};
const procs = [];
const url = (name, path) => `http://localhost:${INSTANCES[name].port}${path}`;

async function up(name) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(url(name, '/health'));
      if (res.ok) return res.json();
    } catch (e) {}
    await Bun.sleep(250);
  }
  throw new Error(`instance ${name} did not start`);
}

beforeAll(async () => {
  for (const i of Object.values(INSTANCES)) {
    procs.push(
      Bun.spawn(['bun', 'server/main.js'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          APIM_ROLES: i.roles,
          APIM_PORT: String(i.port),
          APIM_ADMIN_TOKEN: TOKEN,
          APIM_WORKERS_ENABLED: String(i.workers),
          APIM_PROJECTION_INTERVAL_MS: '150',
          APIM_DRIFT_INTERVAL_MS: '3600000',
          // four more instances on the server of the stack: small pools
          APIM_DATABASE_POOL: '4',
          APIM_ANALYTICS_DATABASE_POOL: '2',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      })
    );
  }
  for (const name of Object.keys(INSTANCES)) await up(name);
});

afterAll(async () => {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
  await db`delete from tasks where dedupe_key like ${`roles-${RUN}-%`}`;
});

describe('roles split across instances', () => {
  test('each instance answers its roles, and nothing else', async () => {
    const bearer = { authorization: `Bearer ${TOKEN}` };
    for (const [name, i] of Object.entries(INSTANCES)) expect((await (await fetch(url(name, '/health'))).json()).roles).toEqual(i.roles.split(','));
    // the admin api and the console: not on the ingester nor on the portal
    expect((await fetch(url('a', '/api/me'), { headers: bearer })).status).toBe(200);
    expect((await fetch(url('ingest', '/api/me'), { headers: bearer })).status).toBe(404);
    expect((await fetch(url('portal', '/api/me'), { headers: bearer })).status).not.toBe(200);
    expect((await fetch(url('ingest', '/backoffice/'))).status).toBe(404);
    // the ingester: only on its instance
    const events = JSON.stringify([]);
    expect((await fetch(url('ingest', '/ingest'), { method: 'POST', headers: { authorization: 'Bearer ingest-secret' }, body: events })).status).toBe(200);
    expect((await fetch(url('a', '/ingest'), { method: 'POST', headers: { authorization: 'Bearer ingest-secret' }, body: events })).status).toBe(404);
    // the portal: its catalogue on its instance, not on the console's
    expect((await fetch(url('portal', '/default/front/api/apis'))).status).toBe(200);
    expect((await fetch(url('a', '/default/front/api/apis'))).status).toBe(404);
  });

  test('a session made on one console instance is good on the other', async () => {
    const login = await fetch(url('a', '/backoffice/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@otoroshi.io', password: 'password' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const me = await fetch(url('b', '/backoffice/api/me'), { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe('admin@otoroshi.io');
  });

  test('two instances with workers share the queue: every task runs once', async () => {
    // tasks of a real kind that do nothing: the subscriptions they name do not exist
    const ids = [];
    for (let n = 0; n < 60; n++) {
      const id = `task_roles_${RUN}_${n}`;
      ids.push(id);
      await db`insert into tasks (id, kind, payload, dedupe_key) values (${id}, 'sync_subscription', ${{ subscription_id: `sub_roles_${RUN}_${n}` }}, ${`roles-${RUN}-${n}`})`;
    }
    const left = async () => (await db`select count(*)::int as n from tasks where id = any(${'{' + ids.join(',') + '}'}::text[]) and status <> 'done'`)[0].n;
    for (let i = 0; i < 80 && (await left()) > 0; i++) await Bun.sleep(250);
    const tasks = await db`select status, attempts, payload from tasks where id = any(${'{' + ids.join(',') + '}'}::text[])`;
    expect(tasks.length).toBe(60);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    // claimed by one worker each: never run twice
    expect(tasks.every((t) => t.attempts === 1)).toBe(true);
    expect(tasks.every((t) => t.payload.result?.skipped === 'deleted')).toBe(true);
  });
});
