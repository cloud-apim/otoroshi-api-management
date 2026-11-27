// Several instances started at once — the replicas of a deployment — migrate an empty database
// together: one at a time, every migration applied once, none of them failing. Needs the postgres of
// the docker stack.
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { SQL } from 'bun';

const { db, migrate } = await import('../server/db/index.js');
const { appMigrations } = await import('../server/db/migrations.js');

const NAME = `apim_migrate_${Date.now().toString(36)}`;
const clients = [];

beforeAll(async () => {
  await db.unsafe(`create database ${NAME}`);
  // one client per instance, each with a pool of its own
  for (let i = 0; i < 4; i++) clients.push(new SQL(`postgres://apim:apim@localhost:5442/${NAME}`, { max: 2 }));
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await db.unsafe(`drop database if exists ${NAME} with (force)`);
});

describe('migrations', () => {
  test('instances starting together migrate an empty database once, none failing', async () => {
    const results = await Promise.allSettled(clients.map((c) => migrate(c, appMigrations, 'app db')));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    const rows = await clients[0]`select version from schema_migrations`;
    expect(rows.map((r) => r.version).sort()).toEqual(appMigrations.map((m) => m.version).sort());
  });

  test('a database already migrated is left as it is', async () => {
    const before = await clients[0]`select version, applied_at from schema_migrations order by version`;
    await migrate(clients[1], appMigrations, 'app db');
    expect(await clients[0]`select version, applied_at from schema_migrations order by version`).toEqual(before);
  });
});
