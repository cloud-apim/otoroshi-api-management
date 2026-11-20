// The configuration of a production start (server/config.js): what is missing, by role, and the
// secrets of the development stack refused — nothing with DEV=true.

import { describe, test, expect } from 'bun:test';
import { productionProblems } from '../server/config.js';

// a whole configuration, every role
const WHOLE = {
  APIM_PUBLIC_URL: 'https://apim.example.com',
  APIM_DATABASE_URL: 'postgres://apim:s@db/apim',
  APIM_ANALYTICS_DATABASE_URL: 'postgres://apim:s@db/apim_analytics',
  APIM_SECRETS_KEY: 'a-long-random-secret',
  APIM_BOOTSTRAP_ADMINS: 'ops@example.com',
  APIM_BOOTSTRAP_PASSWORD: 'a-password',
  APIM_ADMIN_TOKEN: 'a-token',
  APIM_INGEST_TOKEN: 'an-ingest-token',
  OTOROSHI_URL: 'https://otoroshi-api.example.com',
  OTOROSHI_HOST: 'otoroshi-api.example.com',
  OTOROSHI_CLIENT_ID: 'id',
  OTOROSHI_CLIENT_SECRET: 'secret',
  OTOROSHI_PUBLIC_SCHEME: 'https',
  OTOROSHI_PUBLIC_PORT: '443',
};
const without = (...names) => Object.fromEntries(Object.entries(WHOLE).filter(([k]) => !names.includes(k)));

describe('a production start', () => {
  test('a whole configuration starts; DEV=true accepts anything', () => {
    expect(productionProblems(WHOLE)).toEqual([]);
    expect(productionProblems({ DEV: 'true' })).toEqual([]);
    expect(productionProblems({ DEV: '1', APIM_ADMIN_TOKEN: 'apim-admin-token' })).toEqual([]);
  });

  test('nothing given: every variable named at once', () => {
    const problems = productionProblems({});
    expect(problems).toHaveLength(Object.keys(WHOLE).length);
    for (const name of Object.keys(WHOLE)) expect(problems).toContain(`${name} is missing`);
    // DEV=false is a production start
    expect(productionProblems({ DEV: 'false' })).toEqual(problems);
  });

  test('an empty value is a missing one', () => {
    expect(productionProblems({ ...WHOLE, APIM_SECRETS_KEY: '  ' })).toEqual(['APIM_SECRETS_KEY is missing']);
  });

  test('by role: the admin token where the admin api, the previews and the payments are; the ingest token where events and the setup are', () => {
    const tokens = without('APIM_ADMIN_TOKEN', 'APIM_INGEST_TOKEN');
    expect(productionProblems({ ...tokens, APIM_ROLES: 'controller' })).toEqual([]);
    expect(productionProblems({ ...tokens, APIM_ROLES: 'ingester' })).toEqual(['APIM_INGEST_TOKEN is missing']);
    expect(productionProblems({ ...tokens, APIM_ROLES: 'portal' })).toEqual(['APIM_ADMIN_TOKEN is missing']);
    expect(productionProblems({ ...tokens, APIM_ROLES: 'backoffice' })).toEqual(['APIM_ADMIN_TOKEN is missing', 'APIM_INGEST_TOKEN is missing']);
    // every instance needs its databases and its key, whatever its roles
    expect(productionProblems({ ...without('APIM_SECRETS_KEY'), APIM_ROLES: 'controller' })).toEqual(['APIM_SECRETS_KEY is missing']);
  });

  test('the portals by hostname need their domain', () => {
    expect(productionProblems({ ...WHOLE, APIM_PORTAL_EXPOSURE: 'hostname' })).toEqual(['APIM_PORTAL_DOMAIN is missing']);
    expect(productionProblems({ ...WHOLE, APIM_PORTAL_EXPOSURE: 'hostname', APIM_PORTAL_DOMAIN: 'developers.example.com' })).toEqual([]);
    expect(productionProblems({ ...WHOLE, APIM_PORTAL_EXPOSURE: 'hostname', APIM_TENANCY: 'single' })).toEqual([]);
  });

  test('the secrets of the development stack are refused', () => {
    const dev = {
      APIM_ADMIN_TOKEN: 'apim-admin-token',
      APIM_INGEST_TOKEN: 'ingest-secret',
      APIM_BOOTSTRAP_PASSWORD: 'password',
      APIM_SECRETS_KEY: 'development-only-secrets-key',
      OTOROSHI_CLIENT_SECRET: 'apim-admin-secret',
    };
    expect(productionProblems({ ...WHOLE, ...dev })).toEqual(Object.keys(dev).map((name) => `${name} has the value of the development stack`));
  });
});
