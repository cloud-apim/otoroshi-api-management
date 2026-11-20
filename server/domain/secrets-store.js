// Where the product keeps secrets, and their sealing at start: every secret stored in clear before a
// key was set, or sealed with a previous key, is sealed again with the current one. Idempotent: an
// instance that starts beside others does the same, harmlessly.

import { db } from '../db/index.js';
import { current, isSealed, seal, secretsStatus } from './secrets.js';

// the secrets of the settings, by key
export function sealSettings(key, v) {
  if (!v) return v;
  if (key === 'gateway') return { ...v, ...(v.clientSecret ? { clientSecret: seal(v.clientSecret) } : {}) };
  if (key === 'auth')
    return {
      ...v,
      ...(v.oidc ? { oidc: { ...v.oidc, clientSecret: seal(v.oidc.clientSecret) } } : {}),
      ...(v.otoroshi ? { otoroshi: { ...v.otoroshi, secret: seal(v.otoroshi.secret) } } : {}),
    };
  if (key === 'ingest') return { ...v, ...(v.key ? { key: seal(v.key) } : {}) };
  return v;
}

const allCurrent = (values) => values.every((x) => current(x));

export async function resealAll() {
  if (!secretsStatus().encrypted) return { resealed: 0, skipped: 'no key: secrets are stored in clear (APIM_SECRETS_KEY)' };
  let resealed = 0;
  const errors = [];
  const attempt = async (what, fn) => {
    try {
      if (await fn()) resealed++;
    } catch (e) {
      errors.push(`${what}: ${e.message}`);
    }
  };
  for (const c of await db`select id, client_secret from credentials where client_secret is not null and client_secret <> ''`)
    await attempt(`credential ${c.id}`, async () => {
      if (current(c.client_secret)) return false;
      await db`update credentials set client_secret = ${seal(c.client_secret)} where id = ${c.id}`;
      return true;
    });
  for (const s of await db`select key, value from settings where key in ('gateway', 'auth', 'ingest')`)
    await attempt(`settings ${s.key}`, async () => {
      const v = s.value || {};
      if (allCurrent([v.clientSecret, v.oidc?.clientSecret, v.otoroshi?.secret, v.key])) return false;
      await db`update settings set value = ${sealSettings(s.key, v)}, updated_at = now() where key = ${s.key}`;
      return true;
    });
  for (const w of await db`select id, portal from workspaces where portal->'oidc'->>'clientSecret' is not null`)
    await attempt(`workspace ${w.id}`, async () => {
      const secret = w.portal.oidc.clientSecret;
      if (current(secret)) return false;
      await db`update workspaces set portal = ${{ ...w.portal, oidc: { ...w.portal.oidc, clientSecret: seal(secret) } }} where id = ${w.id}`;
      return true;
    });
  const headersOf = (row) => Object.fromEntries(Object.entries(row.headers || {}).map(([k, v]) => [k, seal(v)]));
  for (const row of await db`select id, headers from remote_catalogs`)
    await attempt(`catalog ${row.id}`, async () => {
      if (allCurrent(Object.values(row.headers || {}))) return false;
      await db`update remote_catalogs set headers = ${headersOf(row)} where id = ${row.id}`;
      return true;
    });
  for (const row of await db`select id, headers from audit_exporters`)
    await attempt(`audit exporter ${row.id}`, async () => {
      if (allCurrent(Object.values(row.headers || {}))) return false;
      await db`update audit_exporters set headers = ${headersOf(row)} where id = ${row.id}`;
      return true;
    });
  return { resealed, errors };
}

// how many values are stored in clear, for the setup check
export async function clearSecrets() {
  const credentials = (await db`select count(*)::int as n from credentials where client_secret is not null and client_secret <> '' and client_secret not like 'enc:v1:%'`)[0].n;
  const settings = (await db`select key, value from settings where key in ('gateway', 'auth', 'ingest')`).filter((s) =>
    [s.value?.clientSecret, s.value?.oidc?.clientSecret, s.value?.otoroshi?.secret, s.value?.key].some((x) => x && !isSealed(x))
  ).length;
  return { credentials, settings };
}
