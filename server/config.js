// Installation-level configuration, read once from the environment.
//
// One binary, started with a comma-separated list of roles (see README "Deployment roles").
// Everything that is per-workspace lives in the database, not here.

const env = process.env;

function list(value, fallback = []) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const config = {
  port: parseInt(env.APIM_PORT || env.PORT || '9000', 10),
  // ingester, api, backoffice, portal
  roles: list(env.APIM_ROLES, ['ingester', 'api', 'backoffice', 'portal']),
  publicUrl: env.APIM_PUBLIC_URL || `http://localhost:${env.APIM_PORT || env.PORT || '9000'}`,

  db: {
    app: env.APIM_DATABASE_URL || 'postgres://apim:apim@localhost:5442/apim',
    analytics: env.APIM_ANALYTICS_DATABASE_URL || 'postgres://apim:apim@localhost:5442/apim_analytics',
  },

  // bootstrap administrators: in-memory identities that depend on nothing
  bootstrap: {
    admins: list(env.APIM_BOOTSTRAP_ADMINS, ['admin@otoroshi.io']),
    password: env.APIM_BOOTSTRAP_PASSWORD || 'password',
    workspace: env.APIM_BOOTSTRAP_WORKSPACE || 'default',
  },

  // the single Otoroshi cluster this installation drives. Editable later in global settings.
  otoroshi: {
    url: env.OTOROSHI_URL || 'http://localhost:8080',
    host: env.OTOROSHI_HOST || 'otoroshi-api.oto.tools',
    clientId: env.OTOROSHI_CLIENT_ID || 'apim-admin-client',
    clientSecret: env.OTOROSHI_CLIENT_SECRET || 'apim-admin-secret',
    // the url of the otoroshi backoffice, used to link a projected entity (escape hatch)
    backofficeUrl: env.OTOROSHI_BACKOFFICE_URL || 'http://otoroshi.oto.tools:8080',
    // how consumers reach the apis exposed by the gateway: <scheme>://<api domain>:<port>
    publicScheme: env.OTOROSHI_PUBLIC_SCHEME || 'http',
    publicPort: env.OTOROSHI_PUBLIC_PORT || '8080',
  },

  // token the otoroshi data exporter must present to /ingest
  ingest: {
    token: env.APIM_INGEST_TOKEN || 'ingest-secret',
    // the /ingest url as the gateway reaches it (the data exporter target)
    url: env.APIM_INGEST_URL || null,
    storeRaw: bool(env.APIM_INGEST_STORE_RAW, true),
  },

  // the admin api accepts a static bootstrap token, plus personal tokens stored in db
  adminToken: env.APIM_ADMIN_TOKEN || 'apim-admin-token',

  // multi: one portal per workspace, exposed by path or by hostname; single: one workspace, its
  // portal at the root, no workspace selector in the console
  tenancy: env.APIM_TENANCY || 'multi',

  // portal exposure pattern for the whole installation (multi tenancy): 'path' or 'hostname'
  portal: {
    exposure: env.APIM_PORTAL_EXPOSURE || 'path',
    // in hostname mode: <workspace>.<domain>
    domain: env.APIM_PORTAL_DOMAIN || 'portal.oto.tools',
    // the public base of the portals: <url>/<workspace>/ by path, <url>/ at the root; its scheme and
    // port make the hostname urls. Defaults to APIM_PUBLIC_URL
    url: env.APIM_PORTAL_URL || null,
  },

  workers: {
    projectionIntervalMs: parseInt(env.APIM_PROJECTION_INTERVAL_MS || '2000', 10),
    driftIntervalMs: parseInt(env.APIM_DRIFT_INTERVAL_MS || '60000', 10),
    enabled: bool(env.APIM_WORKERS_ENABLED, true),
  },

  sessionTtlMs: 1000 * 60 * 60 * 24 * 7,
  cookieSecure: bool(env.APIM_COOKIE_SECURE, false),
};

export function hasRole(role) {
  return config.roles.includes(role);
}
