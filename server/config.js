// Installation-level configuration, read once from the environment.
//
// One binary, started with a comma-separated list of roles (see README "Deployment roles").
// Everything that is per-workspace lives in the database, not here.

const env = process.env;

// DEV=true: the values of the development stack (docker/docker-compose.yml) stand in for what is not
// given — its databases, its gateway and its admin key, its well-known secrets. Without it the
// product starts for production: what it needs is given, or it refuses to start
// (productionProblems).
export const dev = ['1', 'true', 'yes', 'on'].includes(String(env.DEV || '').toLowerCase());
const devValue = (value) => (dev ? value : null);

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
  publicUrl: env.APIM_PUBLIC_URL || devValue(`http://localhost:${env.APIM_PORT || env.PORT || '9000'}`),
  // the name of this installation — an environment, one per cluster: recette, production. It says
  // where a promoted snapshot comes from
  installationName: env.APIM_INSTALLATION_NAME || null,

  db: {
    app: env.APIM_DATABASE_URL || devValue('postgres://apim:apim@localhost:5442/apim'),
    analytics: env.APIM_ANALYTICS_DATABASE_URL || devValue('postgres://apim:apim@localhost:5442/apim_analytics'),
    // connections each instance may open to each database: several instances share the
    // max_connections of the server; an idle connection is closed after idleTimeoutS
    appPool: parseInt(env.APIM_DATABASE_POOL || '20', 10),
    analyticsPool: parseInt(env.APIM_ANALYTICS_DATABASE_POOL || '10', 10),
    idleTimeoutS: parseInt(env.APIM_DATABASE_IDLE_TIMEOUT_S || '30', 10),
  },

  // the key the secrets the product keeps are sealed with, and the previous ones on a rotation
  secrets: {
    key: env.APIM_SECRETS_KEY || null,
    previousKeys: list(env.APIM_SECRETS_PREVIOUS_KEYS, []),
  },

  // bootstrap administrators: in-memory identities that depend on nothing
  bootstrap: {
    admins: list(env.APIM_BOOTSTRAP_ADMINS, dev ? ['admin@otoroshi.io'] : []),
    password: env.APIM_BOOTSTRAP_PASSWORD || devValue('password'),
    workspace: env.APIM_BOOTSTRAP_WORKSPACE || 'default',
  },

  // the single Otoroshi cluster this installation drives. Editable later in global settings.
  otoroshi: {
    url: env.OTOROSHI_URL || devValue('http://localhost:8080'),
    host: env.OTOROSHI_HOST || devValue('otoroshi-api.oto.tools'),
    clientId: env.OTOROSHI_CLIENT_ID || devValue('apim-admin-client'),
    clientSecret: env.OTOROSHI_CLIENT_SECRET || devValue('apim-admin-secret'),
    // the url of the otoroshi backoffice, used to link a projected entity (escape hatch); none, no link
    backofficeUrl: env.OTOROSHI_BACKOFFICE_URL || devValue('http://otoroshi.oto.tools:8080'),
    // how consumers reach the apis exposed by the gateway: <scheme>://<api domain>:<port>
    publicScheme: env.OTOROSHI_PUBLIC_SCHEME || devValue('http'),
    publicPort: env.OTOROSHI_PUBLIC_PORT || devValue('8080'),
  },

  // token the otoroshi data exporter must present to /ingest
  ingest: {
    token: env.APIM_INGEST_TOKEN || devValue('ingest-secret'),
    // the /ingest url as the gateway reaches it (the data exporter target)
    url: env.APIM_INGEST_URL || null,
    storeRaw: bool(env.APIM_INGEST_STORE_RAW, true),
    // how often the ingester rolls the computed path up and applies the retention
    retentionMs: parseInt(env.APIM_INGEST_RETENTION_MS || '300000', 10),
  },

  // the admin api accepts a static bootstrap token, plus personal tokens stored in db
  adminToken: env.APIM_ADMIN_TOKEN || devValue('apim-admin-token'),

  // multi: one portal per workspace, exposed by path or by hostname; single: one workspace, its
  // portal at the root, no workspace selector in the console
  tenancy: env.APIM_TENANCY || 'multi',

  // portal exposure pattern for the whole installation (multi tenancy): 'path' or 'hostname'
  portal: {
    exposure: env.APIM_PORTAL_EXPOSURE || 'path',
    // in hostname mode: <workspace>.<domain>
    domain: env.APIM_PORTAL_DOMAIN || devValue('portal.oto.tools'),
    // the public base of the portals: <url>/<workspace>/ by path, <url>/ at the root; its scheme and
    // port make the hostname urls. Defaults to APIM_PUBLIC_URL
    url: env.APIM_PORTAL_URL || null,
  },

  // the payments of the paid plans: Stripe Connect — a workspace links its own Stripe account, the
  // product keeps its id only. `fake` stands for Stripe in the development and the tests; `off` by
  // default
  payments: {
    provider: env.APIM_PAYMENTS_PROVIDER || (env.APIM_STRIPE_CLIENT_ID ? 'stripe' : 'off'),
    stripe: {
      secretKey: env.APIM_STRIPE_SECRET_KEY || '',
      clientId: env.APIM_STRIPE_CLIENT_ID || '',
      webhookSecret: env.APIM_STRIPE_WEBHOOK_SECRET || '',
      apiVersion: env.APIM_STRIPE_API_VERSION || '2025-03-31.basil',
      apiUrl: env.APIM_STRIPE_API_URL || 'https://api.stripe.com',
      connectUrl: env.APIM_STRIPE_CONNECT_URL || 'https://connect.stripe.com',
    },
    reconcileMs: parseInt(env.APIM_PAYMENTS_RECONCILE_MS || '3600000', 10),
  },

  // the Kubernetes controller (role `controller`): a pass over its resources every resyncMs
  kube: {
    resyncMs: parseInt(env.APIM_KUBE_RESYNC_MS || '10000', 10),
  },

  workers: {
    projectionIntervalMs: parseInt(env.APIM_PROJECTION_INTERVAL_MS || '2000', 10),
    driftIntervalMs: parseInt(env.APIM_DRIFT_INTERVAL_MS || '60000', 10),
    enabled: bool(env.APIM_WORKERS_ENABLED, true),
  },

  // outgoing webhooks: an endpoint on a private network (loopback, RFC 1918, link-local…) is refused,
  // unless the installation allows it — the development stack does
  webhooks: {
    allowPrivate: bool(env.APIM_WEBHOOKS_ALLOW_PRIVATE, !!devValue(true)),
  },

  sessionTtlMs: 1000 * 60 * 60 * 24 * 7,
  // by default, secure as soon as the product is served over https
  cookieSecure: bool(env.APIM_COOKIE_SECURE, String(env.APIM_PUBLIC_URL || '').startsWith('https:')),
};

export function hasRole(role) {
  return config.roles.includes(role);
}

// What a production start needs, by role: [variable, the roles that need it — every one when absent]
const NEEDED = [
  ['APIM_PUBLIC_URL'],
  ['APIM_DATABASE_URL'],
  ['APIM_ANALYTICS_DATABASE_URL'],
  // every instance seals at start what is not sealed yet
  ['APIM_SECRETS_KEY'],
  // every instance makes the bootstrap administrators it does not find
  ['APIM_BOOTSTRAP_ADMINS'],
  ['APIM_BOOTSTRAP_PASSWORD'],
  ['OTOROSHI_URL'],
  ['OTOROSHI_HOST'],
  ['OTOROSHI_CLIENT_ID'],
  ['OTOROSHI_CLIENT_SECRET'],
  ['OTOROSHI_PUBLIC_SCHEME'],
  ['OTOROSHI_PUBLIC_PORT'],
  // the static token of the admin api; it also keys the previews of a portal and the payment states
  ['APIM_ADMIN_TOKEN', ['api', 'backoffice', 'portal']],
  // what the data exporter presents; the setup gives it to the exporter
  ['APIM_INGEST_TOKEN', ['ingester', 'api', 'backoffice']],
];

// the well-known values of the development stack: a secret everybody can read
const DEV_SECRETS = {
  APIM_ADMIN_TOKEN: 'apim-admin-token',
  APIM_INGEST_TOKEN: 'ingest-secret',
  APIM_BOOTSTRAP_PASSWORD: 'password',
  APIM_SECRETS_KEY: 'development-only-secrets-key',
  OTOROSHI_CLIENT_SECRET: 'apim-admin-secret',
};

// Why a production start is refused: the variables missing for the roles of the instance, and the
// secrets left at the value of the development. Nothing with DEV=true.
export function productionProblems(e = env) {
  if (['1', 'true', 'yes', 'on'].includes(String(e.DEV || '').toLowerCase())) return [];
  const roles = list(e.APIM_ROLES, ['ingester', 'api', 'backoffice', 'portal']);
  const needed = NEEDED.filter(([, only]) => !only || only.some((r) => roles.includes(r))).map(([name]) => name);
  const multi = (e.APIM_TENANCY || 'multi') === 'multi';
  if (multi && e.APIM_PORTAL_EXPOSURE === 'hostname') needed.push('APIM_PORTAL_DOMAIN');
  const problems = needed.filter((name) => !String(e[name] || '').trim()).map((name) => `${name} is missing`);
  for (const [name, value] of Object.entries(DEV_SECRETS)) if (e[name] === value) problems.push(`${name} has the value of the development stack`);
  return problems;
}

// Refuses a production start that lacks what it needs, saying all of it at once.
export function checkProductionConfig(e = env) {
  const problems = productionProblems(e);
  if (problems.length)
    throw Object.assign(
      new Error(
        `the configuration is incomplete for a production start:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
          'Set these variables (documentation › Install › Configuration), or DEV=true for the development stack and its values.'
      ),
      { config: true }
    );
}
