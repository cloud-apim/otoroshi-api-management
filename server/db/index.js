import { SQL } from 'bun';
import { config } from '../config.js';
import { appMigrations, analyticsMigrations } from './migrations.js';

export const db = new SQL(config.db.app, { max: config.db.appPool, idleTimeout: config.db.idleTimeoutS });
export const adb = new SQL(config.db.analytics, { max: config.db.analyticsPool, idleTimeout: config.db.idleTimeoutS });

// several instances may start at once — the replicas of a deployment —: one migrates at a time, each
// step under a lock of the database held until its transaction ends, and a migration another
// instance applied meanwhile is not run again
const MIGRATION_LOCK = 4242_0001;

export async function migrate(client, migrations, label) {
  await client.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx.unsafe(
      `create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`
    );
  });
  const done = new Set((await client`select version from schema_migrations`).map((r) => r.version));
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    const applied = await client.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      if ((await tx`select 1 from schema_migrations where version = ${m.version}`).length) return false;
      await tx.unsafe(m.sql);
      await tx`insert into schema_migrations (version) values (${m.version})`;
      return true;
    });
    if (applied) console.log(`[apim] ${label} migration applied: ${m.version}`);
  }
}

export async function migrateAll() {
  await migrate(db, appMigrations, 'app db');
  await migrate(adb, analyticsMigrations, 'analytics db');
}

export function newId(prefix) {
  return `${prefix}_${Bun.randomUUIDv7().replace(/-/g, '')}`;
}

export function slugify(value) {
  return (
    String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}
