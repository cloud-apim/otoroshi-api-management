import { SQL } from 'bun';
import { config } from '../config.js';
import { appMigrations, analyticsMigrations } from './migrations.js';

export const db = new SQL(config.db.app, { max: config.db.appPool, idleTimeout: config.db.idleTimeoutS });
export const adb = new SQL(config.db.analytics, { max: config.db.analyticsPool, idleTimeout: config.db.idleTimeoutS });

async function migrate(client, migrations, label) {
  await client.unsafe(
    `create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`
  );
  const done = new Set((await client`select version from schema_migrations`).map((r) => r.version));
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    await client.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx`insert into schema_migrations (version) values (${m.version})`;
    });
    console.log(`[apim] ${label} migration applied: ${m.version}`);
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
