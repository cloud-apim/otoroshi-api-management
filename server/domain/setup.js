// The setup of the gateway: what the product needs on Otoroshi to work, created or repaired,
// idempotently — all of it or some parts, re-runnable at will, with a dry run that shows what it
// would change first. Run by the binary (`otoroshi-apim setup`, given an Otoroshi admin key), by
// the admin api and the console.
//
// Parts that write, each on entities it marks and that nothing else writes:
//  - key       the product's own admin key, distinct from the admin key given to the setup
//  - exporter  the data exporter that feeds the ingester
//  - console   the route that exposes the console (and the payments callbacks), optionally behind
//              an auth module of the gateway with the info token the "via Otoroshi" login reads
//  - portals   the route that exposes the developer portals, in the form of the installation
//  - tls       the gateway asks callers for a client certificate, when an mtls plan is deployed
// Checks, read only: the gateway, the key of the product, the key pairs of the oauth2-local plans,
// the certificates of the exposed hosts, the events reaching the ingester.

import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { adb, db } from '../db/index.js';
import { badRequest } from '../http/router.js';
import { META, gatewaySettings, invalidateGatewaySettings, otoroshi } from '../otoroshi/client.js';
import { consoleAuth, invalidateAuthSettings } from '../auth/settings.js';
import { currentForm, portalBase } from '../portal-exposure.js';
import { diff } from './diff.js';
import { seal, secretsStatus } from './secrets.js';

export const PARTS = ['key', 'exporter', 'console', 'portals', 'tls'];
export const SETUP_MARKER = 'otoroshi-apim-setup';
export const KEY_ID = 'apim_product_admin';
export const MIN_OTOROSHI = { major: 18, minor: 1 };
export const EXPORTER_ID = 'apim_ingester_exporter';
export const CONSOLE_ROUTE = 'apim_setup_console';
export const PORTALS_ROUTE = 'apim_setup_portals';
const ROUTES = '/apis/proxy.otoroshi.io/v1/routes';
const CLIENT_AUTH = ['Want', 'Need'];

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
};
const isLocal = (host) => !host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
const marker = (part) => ({ [META.createdBy]: SETUP_MARKER, [META.setupPart]: part, [META.managedBy]: 'otoroshi-api-management' });

// ---------------------------------------------------------------- options

// what the setup is told, remembered between runs: where the gateway reaches the product, the
// hosts it exposes; an option given to a run replaces the remembered one, null forgets it
const OPTIONS = ['productUrl', 'exporterUrl', 'consoleHost', 'consoleAuthModule', 'portalHost', 'clientAuth'];

// what goes without saying: read from the configuration of the installation
function defaults() {
  const form = currentForm();
  const publicHost = hostOf(config.publicUrl);
  const portalHost = form.kind === 'hostname' ? `*.${form.domain}` : hostOf(portalBase());
  return {
    productUrl: config.ingest.url ? new URL(config.ingest.url).origin : config.publicUrl.replace(/\/$/, ''),
    exporterUrl: null, // the ingester of the product url, or APIM_INGEST_URL
    consoleHost: isLocal(publicHost) ? null : publicHost,
    consoleAuthModule: null,
    portalHost: isLocal(portalHost) ? null : portalHost,
    clientAuth: null,
  };
}

async function stored() {
  return (await db`select value from settings where key = 'setup'`)[0]?.value || {};
}

// the options given explicitly, by this run and the former ones: what is remembered
export async function givenOptions(input = {}) {
  const given = { ...((await stored()).given || {}) };
  for (const k of OPTIONS) if (k in input) given[k] = input[k] === '' ? null : input[k];
  for (const k of Object.keys(given)) if (given[k] === null || given[k] === undefined) delete given[k];
  return given;
}

export async function setupOptions(input = {}) {
  const base = { ...defaults(), ...(await givenOptions(input)) };
  if (!base.exporterUrl) base.exporterUrl = config.ingest.url && !('productUrl' in input) ? config.ingest.url : `${base.productUrl.replace(/\/$/, '')}/ingest`;
  for (const k of ['productUrl', 'exporterUrl'])
    if (base[k] && !/^https?:\/\/[^/]+/.test(base[k])) throw badRequest(`${k} must be an http or https url (got "${base[k]}")`);
  for (const k of ['consoleHost', 'portalHost']) if (base[k]) base[k] = String(base[k]).toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  if (base.clientAuth && !CLIENT_AUTH.includes(base.clientAuth)) throw badRequest(`clientAuth must be one of ${CLIENT_AUTH.join(', ')}`);
  return base;
}

// ---------------------------------------------------------------- the parts

const action = (op, kind, id, name, changes = []) => ({ op, kind, id, name, changes });

// an entity of the gateway made the way it should be: created when missing, updated when it
// differs on what the setup decides, left alone otherwise
async function converge(run, { kind, path, id, name, wanted, comparable, create, update }) {
  const existing = await run.call('GET', `${path}/${id}`);
  if (existing && existing.metadata?.[META.createdBy] !== SETUP_MARKER && existing.metadata?.[META.managedBy] !== 'otoroshi-api-management')
    throw new Error(`${kind} ${id} exists on the gateway and was not made by the product: it is left alone`);
  const changes = existing ? diff(comparable(existing), comparable(wanted)) : [];
  const op = !existing ? 'create' : changes.length ? 'update' : 'unchanged';
  if (!run.dryRun && op === 'create') await (create ? create(wanted) : run.call('POST', path, wanted));
  if (!run.dryRun && op === 'update') await (update ? update(wanted, existing) : run.call('PUT', `${path}/${id}`, { ...existing, ...wanted }));
  return { action: action(op, kind, id, name, changes), existing };
}

async function partKey(run) {
  const current = await gatewaySettings();
  if (!run.creds) {
    if (current.clientId !== KEY_ID) {
      return {
        skipped: `the product calls the gateway with ${current.clientId}, a key it did not make: give an Otoroshi admin key to the setup so that it makes its own`,
      };
    }
    const own = await run.call('GET', `/api/apikeys/${KEY_ID}`);
    if (!own) throw new Error(`the key of the product, ${KEY_ID}, is missing on the gateway: run the setup with an Otoroshi admin key`);
    return { actions: [action('unchanged', 'Apikey', KEY_ID, own.clientName)] };
  }
  // the product's key is an admin key as the one given: on the same admin api
  const admin = await run.call('GET', `/api/apikeys/${run.creds.clientId}`);
  const adminEntities = (admin?.authorizedEntities || []).filter((e) => /^(group|route|service)_/.test(e));
  // an apikey says what it is authorized on three times (authorizations, authorizedEntities,
  // authorizedGroup): the three of the admin key, or the admin api group
  const authorized = adminEntities.length
    ? { authorizations: admin.authorizations, authorizedEntities: adminEntities, authorizedGroup: admin.authorizedGroup }
    : { authorizations: [{ kind: 'group', id: 'admin-api-group' }], authorizedEntities: ['group_admin-api-group'], authorizedGroup: 'admin-api-group' };
  const existing = await run.call('GET', `/api/apikeys/${KEY_ID}`);
  const secret = existing && !run.options.rotateKey ? existing.clientSecret : randomBytes(32).toString('hex');
  const template = existing || (await run.call('GET', '/api/apikeys/_template'));
  const wanted = {
    ...template,
    clientId: KEY_ID,
    clientSecret: secret,
    clientName: `otoroshi-api-management${config.installationName ? ` — ${config.installationName}` : ''}`,
    description: 'The admin key otoroshi-api-management calls the gateway with. Made by its setup; rotate it with otoroshi-apim setup --only key --rotate-key',
    ...authorized,
    enabled: true,
    readOnly: false,
    allowClientIdOnly: false,
    metadata: { ...(existing?.metadata || {}), ...marker('key') },
  };
  const comparable = (k) => ({ clientName: k.clientName, enabled: k.enabled, readOnly: k.readOnly, authorizedEntities: [...(k.authorizedEntities || [])].sort(), rotated: k.clientSecret !== existing?.clientSecret });
  const { action: a } = await converge(run, {
    kind: 'Apikey',
    path: '/api/apikeys',
    id: KEY_ID,
    name: wanted.clientName,
    wanted,
    comparable,
    update: (w) => run.call('PUT', `/api/apikeys/${KEY_ID}`, w),
  });
  const actions = [a];
  // the product calls the gateway with it from now on — once the gateway knows it: it reads its
  // entities again every few seconds
  if (current.clientId !== KEY_ID || current.clientSecret !== secret) {
    actions.push(action('update', 'Settings', 'gateway', 'the key the product calls the gateway with', [{ op: 'replace', path: 'clientId', before: current.clientId, after: KEY_ID }]));
    if (!run.dryRun) {
      await accepted({ clientId: KEY_ID, clientSecret: secret });
      const value = (await db`select value from settings where key = 'gateway'`)[0]?.value || {};
      await db`insert into settings (key, value) values ('gateway', ${{ ...value, clientId: KEY_ID, clientSecret: seal(secret) }})
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
      invalidateGatewaySettings();
    }
  }
  return { actions };
}

// the gateway answers with a key: it knows it
async function accepted(creds, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await otoroshi('GET', '/api/infos', undefined, { creds, timeoutMs: 3000 })) return;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(500);
  }
  throw new Error(`the gateway does not accept the key of the product after ${timeoutMs / 1000} s (${last?.message || 'no answer'}): the product keeps its former key`);
}

export function exporterEntity(url) {
  return {
    _loc: { tenant: 'default', teams: ['default'] },
    type: 'webhook',
    enabled: true,
    id: EXPORTER_ID,
    name: 'otoroshi-api-management ingester',
    desc: 'Exports GatewayEvent, LLMUsageAudit and McpAudit to the otoroshi-api-management ingester',
    metadata: marker('exporter'),
    tags: [],
    bufferSize: 5000,
    jsonWorkers: 1,
    sendWorkers: 5,
    groupSize: 50,
    groupDuration: 2000,
    projection: {},
    filtering: { include: [{ '@type': { $in: ['GatewayEvent', 'LLMUsageAudit', 'McpAudit'] } }], exclude: [] },
    customFilter: null,
    customTransform: null,
    config: { type: 'webhook', url, headers: { Authorization: `Bearer ${config.ingest.token}` }, mtlsConfig: { mtls: false } },
  };
}

async function partExporter(run) {
  const wanted = exporterEntity(run.options.exporterUrl);
  const comparable = (e) => ({ enabled: e.enabled, type: e.type, filtering: e.filtering, url: e.config?.url, authorization: e.config?.headers?.Authorization });
  const { action: a } = await converge(run, { kind: 'DataExporter', path: '/api/data-exporter-configs', id: EXPORTER_ID, name: wanted.name, wanted, comparable });
  return { actions: [a], notes: [`events go to ${run.options.exporterUrl}: the gateway must reach it`] };
}

// a route of the product: its hosts, the product as its backend, the host it was called on kept
// (no OverrideHost) — the product resolves a portal by it
async function routeEntity(run, { id, part, name, description, domains, plugins = [] }) {
  const template = (await run.call('GET', `${ROUTES}/_template`)) || {};
  const target = new URL(run.options.productUrl);
  const tls = target.protocol === 'https:';
  const t0 = template.backend?.targets?.[0] || {};
  return {
    ...template,
    id,
    name,
    description,
    tags: ['otoroshi-api-management'],
    metadata: marker(part),
    enabled: true,
    frontend: { ...(template.frontend || {}), domains, strip_path: false, exact: false },
    backend: {
      ...(template.backend || {}),
      targets: [{ ...t0, id: 'target_1', hostname: target.hostname, port: Number(target.port || (tls ? 443 : 80)), tls, weight: 1 }],
      root: '/',
      rewrite: false,
    },
    plugins: plugins.map((p) => ({ enabled: true, debug: false, include: [], exclude: [], bound_listeners: [], ...p })),
  };
}

const routeComparable = (r) => ({
  name: r.name,
  enabled: r.enabled,
  domains: [...(r.frontend?.domains || [])].sort(),
  strip_path: r.frontend?.strip_path,
  targets: (r.backend?.targets || []).map((t) => ({ hostname: t.hostname, port: t.port, tls: t.tls })),
  root: r.backend?.root,
  plugins: (r.plugins || []).map((p) => ({ plugin: p.plugin, enabled: p.enabled, config: p.config })),
});

async function partConsole(run) {
  const host = run.options.consoleHost;
  if (!host) return { skipped: 'no host for the console: give it one (--console-host), the public url of the product is local' };
  const domains = [`${host}/backoffice`];
  // Stripe calls the product back on its public url
  if (config.payments.provider !== 'off') domains.push(`${host}/payments`);
  const plugins = [];
  const notes = [];
  if (run.options.consoleAuthModule) {
    const module = await run.call('GET', `/api/auths/${run.options.consoleAuthModule}`);
    if (!module) throw new Error(`no auth module ${run.options.consoleAuthModule} on the gateway`);
    const auth = await consoleAuth();
    let secret = auth.otoroshi.secret;
    if (!secret) {
      // the secret the gateway signs the info token with, shared with the console
      secret = randomBytes(32).toString('hex');
      if (!run.dryRun) {
        const value = (await db`select value from settings where key = 'auth'`)[0]?.value || {};
        await db`insert into settings (key, value) values ('auth', ${{ ...value, otoroshi: { ...(value.otoroshi || {}), secret: seal(secret) } }})
          on conflict (key) do update set value = excluded.value, updated_at = now()`;
        invalidateAuthSettings();
      }
      notes.push('a secret shared with the console signs the info token: it is kept in the console authentication settings');
    }
    plugins.push(
      { plugin: 'cp:otoroshi.next.plugins.AuthModule', config: { auth_module: module.id, pass_with_apikey: false } },
      { plugin: 'cp:otoroshi.next.plugins.OtoroshiInfos', config: { version: 'Legacy', ttl: 30, header_name: auth.otoroshi.header, add_fields: null, projection: {}, algo: { type: 'HSAlgoSettings', size: 512, secret, base64: false } } }
    );
    if (auth.mode !== 'otoroshi') notes.push(`the console is behind ${module.name}: switch its login to "via Otoroshi" in Global settings › Console authentication once the route answers`);
  }
  const wanted = await routeEntity(run, { id: CONSOLE_ROUTE, part: 'console', name: 'otoroshi-api-management — console', description: 'The console of otoroshi-api-management. Made by its setup.', domains, plugins });
  const { action: a } = await converge(run, { kind: 'Route', path: ROUTES, id: CONSOLE_ROUTE, name: wanted.name, wanted, comparable: routeComparable });
  return { actions: [a], notes: [`the console at ${host}/backoffice/`, ...notes] };
}

async function partPortals(run) {
  const host = run.options.portalHost;
  if (!host) return { skipped: 'no host for the portals: give them one (--portal-host), the public url of the portals is local' };
  const form = currentForm();
  const domains = host.startsWith('*.') ? [host, host.slice(2)] : [host];
  const wanted = await routeEntity(run, {
    id: PORTALS_ROUTE,
    part: 'portals',
    name: 'otoroshi-api-management — developer portals',
    description: 'The developer portals of otoroshi-api-management. Made by its setup.',
    domains,
    // an instance can carry every role: the console, the admin api and the ingester are not
    // served on the host of the portals
    plugins: [
      {
        plugin: 'cp:otoroshi.next.plugins.RoutingRestrictions',
        config: { allow_last: true, allowed: [], forbidden: [], not_found: ['/backoffice.*', '/api/.*', '/ingest.*', '/payments/.*'].map((path) => ({ method: '*', path })) },
      },
    ],
  });
  const { action: a } = await converge(run, { kind: 'Route', path: ROUTES, id: PORTALS_ROUTE, name: wanted.name, wanted, comparable: routeComparable });
  const where = form.kind === 'hostname' ? `<workspace>.${form.domain}` : form.kind === 'root' ? `${host}/` : `${host}/<workspace>/`;
  return { actions: [a], notes: [`the portals at ${where}`] };
}

// the published plans of the deployed snapshots, with their api
async function deployedPlans() {
  const rows = await db`select a.name, a.version, s.content -> 'draft' -> 'plans' as plans from api_deployments d
    join api_snapshots s on s.id = d.snapshot_id join apis a on a.id = d.api_id where d.status = 'deployed'`;
  return rows.flatMap((r) => (r.plans || []).filter((p) => p.status === 'published').map((p) => ({ ...p, api: `${r.name} ${r.version}` })));
}

async function partTls(run) {
  const mtls = (await deployedPlans()).filter((p) => p.auth?.kind === 'mtls');
  const wantedAuth = run.options.clientAuth || (mtls.length ? 'Want' : null);
  if (!wantedAuth) return { skipped: 'no mtls plan is deployed: the gateway does not need to ask for client certificates' };
  const global = await run.call('GET', '/api/globalconfig');
  const current = global?.tlsSettings?.clientAuth || 'None';
  // never lowered: Need stays Need
  const op = current === wantedAuth || (current === 'Need' && !run.options.clientAuth) ? 'unchanged' : 'update';
  if (!run.dryRun && op === 'update') await run.call('PATCH', '/api/globalconfig', [{ op: 'replace', path: '/tlsSettings/clientAuth', value: wantedAuth }]);
  return {
    actions: [action(op, 'GlobalConfig', 'global', 'TLS client authentication', op === 'update' ? [{ op: 'replace', path: 'tlsSettings.clientAuth', before: current, after: wantedAuth }] : [])],
    notes: mtls.length ? [`for the mtls plans ${mtls.map((p) => `${p.api} · ${p.name}`).join(', ')}`] : [],
  };
}

const RUNNERS = { key: partKey, exporter: partExporter, console: partConsole, portals: partPortals, tls: partTls };

// ---------------------------------------------------------------- the checks

const covers = (name, host) => {
  const n = String(name || '').toLowerCase();
  if (n === host) return true;
  return n.startsWith('*.') && host.endsWith(n.slice(1)) && !host.slice(0, -n.length + 1).includes('.');
};

async function checks(run) {
  const out = [];
  const add = (level, code, message) => out.push({ level, code, message });
  const infos = await run.call('GET', '/api/infos').catch((e) => ({ error: e.message }));
  if (!infos || infos.error) add('error', 'gateway_unreachable', `the gateway does not answer: ${infos?.error || 'no infos'}`);
  else {
    const v = infos.otoroshi_version_sem || {};
    // the release that carries the contract the product projects to (subscriptions with a client id,
    // plans that require one, apis managed as code...)
    const supported = v.major > MIN_OTOROSHI.major || (v.major === MIN_OTOROSHI.major && v.minor >= MIN_OTOROSHI.minor);
    add(supported ? 'ok' : 'error', 'gateway_version', `Otoroshi ${infos.otoroshi_version}, cluster ${infos.otoroshi_cluster_id}, ${infos.datastore} datastore${supported ? '' : `: the product needs Otoroshi ${MIN_OTOROSHI.major}.${MIN_OTOROSHI.minor} or later`}`);
  }
  // what the product keeps that opens something: sealed with the key of the installation
  const sec = secretsStatus();
  add(
    sec.encrypted ? 'ok' : 'warning',
    'secrets_at_rest',
    sec.encrypted
      ? `the secrets the product keeps are sealed with the key ${sec.keyId}${sec.previousKeys ? `, ${sec.previousKeys} previous key(s) still read` : ''}`
      : 'the secrets the product keeps (credentials, identity providers, the key of the gateway, catalog and exporter tokens) are stored in clear: set APIM_SECRETS_KEY'
  );
  const s = await gatewaySettings();
  add(s.clientId === KEY_ID ? 'ok' : 'warning', 'product_key', s.clientId === KEY_ID ? `the product calls the gateway with its own key, ${KEY_ID}` : `the product calls the gateway with ${s.clientId}, a key it did not make (part key)`);
  // the key pairs the oauth2-local plans sign their tokens with
  const plans = (await deployedPlans()).filter((p) => p.auth?.kind === 'oauth2-local');
  const certs = (await run.call('GET', '/api/certificates').catch(() => null)) || [];
  for (const id of [...new Set(plans.map((p) => p.auth?.config?.defaultKeyPair || 'otoroshi-jwt-signing'))]) {
    const found = certs.find((c) => c.id === id);
    if (!found) add('error', 'key_pair_missing', `the key pair ${id} the oauth2-local plans sign their tokens with is not on the gateway${id === 'otoroshi-jwt-signing' ? ' (Otoroshi makes it again at start and every day)' : ''}`);
    else add('ok', 'key_pair', `the oauth2-local plans sign their tokens with ${found.name || id}`);
  }
  // the certificates of the hosts served over https
  const hosts = [
    ...(run.options.consoleHost && config.publicUrl.startsWith('https:') ? [run.options.consoleHost] : []),
    ...(run.options.portalHost && portalBase().startsWith('https:') ? [run.options.portalHost.replace(/^\*\./, 'x.')] : []),
  ];
  for (const host of hosts) {
    const cert = certs.find((c) => !c.ca && !c.keypair && [c.domain, ...(c.sans || [])].some((n) => covers(n, host)));
    if (cert) add('ok', 'tls_certificate', `${host} is served with ${cert.name || cert.id}`);
    else add('warning', 'tls_certificate_missing', `no certificate of the gateway covers ${host}: https cannot be served there until one is added`);
  }
  // the events reach the ingester
  const exporter = await run.call('GET', `/api/data-exporter-configs/${EXPORTER_ID}`).catch(() => null);
  if (exporter) {
    const [{ last }] = await adb`select max(received_at) as last from calls`;
    if (last && Date.now() - new Date(last).getTime() < 15 * 60000) add('ok', 'events', `events reach the ingester, the last one ${Math.round((Date.now() - new Date(last).getTime()) / 1000)} s ago`);
    else add('warning', 'events', `no event reached the ingester for 15 minutes: is ${exporter.config?.url} reachable from the gateway, and is there traffic?`);
  }
  return out;
}

// ---------------------------------------------------------------- the run

// `creds`: the Otoroshi admin key given to the setup — used for this run, never stored. Without
// it, the parts run with the product's own key
export async function runSetup({ only = null, dryRun = false, creds = null, options = {}, actor = null } = {}) {
  const parts = only?.length ? only : PARTS;
  for (const p of parts) if (!PARTS.includes(p)) throw badRequest(`unknown part ${p}: one of ${PARTS.join(', ')}`);
  const opts = await setupOptions(options);
  const keyCreds = creds?.clientId && creds?.clientSecret ? { clientId: creds.clientId, clientSecret: creds.clientSecret } : null;
  const run = {
    dryRun,
    creds: keyCreds,
    options: { ...opts, rotateKey: !!options.rotateKey },
    call: (method, path, body) => otoroshi(method, path, body, { creds: keyCreds }),
  };
  const results = [];
  for (const part of parts) {
    try {
      const r = await RUNNERS[part](run);
      const changed = (r.actions || []).some((a) => a.op !== 'unchanged');
      results.push({ part, status: r.skipped ? 'skipped' : changed ? (dryRun ? 'would_change' : 'changed') : 'ok', actions: r.actions || [], notes: r.skipped ? [r.skipped] : r.notes || [] });
    } catch (e) {
      results.push({ part, status: 'error', actions: [], notes: [e.message] });
    }
  }
  const report = { at: new Date().toISOString(), dryRun, by: actor, parts: results, checks: await checks(run), options: opts };
  if (!dryRun) {
    await db`insert into settings (key, value) values ('setup', ${{ given: await givenOptions(options), lastRun: report }})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
  return report;
}

export async function setupState() {
  const value = await stored();
  return { parts: PARTS, options: await setupOptions(), given: value.given || {}, lastRun: value.lastRun || null };
}
