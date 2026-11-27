// The product's admin API. It is the only way to do anything in the product: the
// same router is served on /api (bearer token, CLI, CI) and on /backoffice/api (console session),
// so every action of the console replays from the CLI by construction.

import { Router, badRequest, notFound, forbidden } from '../http/router.js';
import { db } from '../db/index.js';
import { config } from '../config.js';
import * as identity from '../domain/identity.js';
import * as portalDesign from '../domain/portal-design.js';
import * as apis from '../domain/apis.js';
import * as deployments from '../domain/deployments.js';
import * as applications from '../domain/applications.js';
import * as subscriptions from '../domain/subscriptions.js';
import * as analytics from '../domain/analytics.js';
import { invalidatePolicy as invalidateIngestPolicy, normalize as normalizeIngest, policy as ingestPolicy, publicPolicy } from '../domain/ingest-policy.js';
import { sealSettings } from '../domain/secrets-store.js';
import { EXPORTER_ID, runSetup, setupState } from '../domain/setup.js';
import { runRetention } from '../domain/retention.js';
import { listAudit, searchAudit, audit } from '../domain/audit.js';
import { likePattern, pageParams } from '../http/paging.js';
import { validateDraft, resolutionOrder, normalizeDraft, AUTH_KINDS } from '../domain/model.js';
import { searchTasks, queueStats, enqueue, dismissTask } from '../domain/tasks.js';
import { oto, gatewaySettings, gatewayPlugins, invalidateGatewaySettings, META } from '../otoroshi/client.js';
import { threatProtectionCatalog } from '../otoroshi/threats.js';
import { runDriftDetection, driftReports, unmanagedApis, draftFromOtoroshi, adoptSubscriptions, trustedChains } from '../otoroshi/drift.js';
import { buildOtoroshiApi, derivedEntities } from '../otoroshi/projection.js';
import { exportWorkspace, importWorkspace, apiDocument, applyApiDocument } from '../domain/exchange.js';
import { gatewayBaseUrl } from './portal-api.js';
import { consoleAuth, invalidateAuthSettings } from '../auth/settings.js';
import * as email from '../domain/email.js';
import * as webhooks from '../domain/webhooks.js';
import * as policyGroups from '../domain/policyGroups.js';
import * as metadata from '../domain/metadata.js';
import { readCertificate, issuerPatterns } from '../domain/pki.js';
import * as catalogs from '../domain/catalogs.js';
import * as auditExport from '../domain/auditExport.js';
import * as notifications from '../domain/notifications.js';
import { currentForm, portalBase, portalHistory, portalUrl } from '../portal-exposure.js';
import * as promotion from '../domain/promotion.js';
import * as billing from '../payments/billing.js';
import * as discovery from '../domain/discovery.js';
import * as announcements from '../domain/announcements.js';
import * as dictionaries from '../domain/dictionaries.js';
import * as sharedResources from '../domain/resources.js';
import { deleteUser, isBootstrapAdmin } from '../domain/people.js';
import { usageOf } from '../payments/usage.js';

const r = new Router();

// the workspaces whose operations someone may follow on the gateway pages (null: all, for an
// installation administrator)
async function visibleWorkspaces(ctx) {
  if (ctx.user?.is_admin) return null;
  return (await identity.listWorkspacesFor(ctx.user)).filter((w) => ['admin', 'producer'].includes(w.role)).map((w) => w.id);
}

async function ws(ctx, params, roles = ['admin', 'producer']) {
  const c = await identity.workspaceContext(ctx, params.ws);
  identity.requireRole(c, roles);
  return c;
}

async function apiOf(c, params, { manage = false } = {}) {
  const api = await apis.getApi(c.workspace.id, params.api);
  if (manage) await apis.requireManageApi(c, api);
  return api;
}

function mask(secret) {
  if (!secret) return secret;
  return secret.slice(0, 4) + '••••••••' + secret.slice(-4);
}

// ---------------------------------------------------------------- me & tokens

// a workspace as the api answers it: with the public url of its portal
const withPortal = (w) => ({ ...identity.maskWorkspace(w), portal_url: portalUrl(w.slug) });

r.get('/me', async ({ ctx }) => {
  identity.requireUser(ctx);
  const workspaces = (await identity.listWorkspacesFor(ctx.user)).map(withPortal);
  return { user: identity.publicUser(ctx.user), workspaces, installation: { tenancy: config.tenancy, portal: currentForm() } };
});

r.get('/me/tokens', async ({ ctx }) => {
  identity.requireUser(ctx);
  return identity.listApiTokens(ctx.user.id);
});

r.post('/me/tokens', async ({ ctx, body }) => {
  identity.requireUser(ctx);
  const t = await identity.createApiToken(ctx.user.id, body.name);
  await audit(ctx, { action: 'token.create', entityKind: 'token', entityId: t.id, summary: `api token ${t.name} created` });
  return t;
});

r.delete('/me/tokens/:id', async ({ ctx, params }) => {
  identity.requireUser(ctx);
  await identity.deleteApiToken(ctx.user.id, params.id);
  return { deleted: true };
});

// ---------------------------------------------------------------- installation settings

r.get('/settings', async ({ ctx }) => {
  identity.requireAdmin(ctx);
  const rows = await db`select key, value, updated_at from settings`;
  const gw = await gatewaySettings();
  return {
    gateway: { ...gw, clientSecret: mask(gw.clientSecret) },
    portal: { tenancy: config.tenancy, exposure: config.portal.exposure, domain: config.portal.domain, url: portalBase(), form: currentForm(), history: portalHistory() },
    // the policy of the ingester, but never the key of its hashes
    ingest: { ...publicPolicy(await ingestPolicy()), url: config.ingest.url || `${config.publicUrl}/ingest` },
    drift: rows.find((x) => x.key === 'drift.last_run')?.value || null,
    auth: await consoleAuth().then((a) => ({
      ...a,
      oidc: { ...a.oidc, clientSecret: mask(a.oidc.clientSecret) },
      otoroshi: { ...a.otoroshi, secret: mask(a.otoroshi.secret) },
      callback: `${config.publicUrl}/backoffice/api/auth/oidc/callback`,
    })),
    email: await emailView(),
  };
});

// the email transport of the installation, its secrets masked, and what it lacks
async function emailView() {
  const e = await email.emailSettings();
  return { ...e, apiKey: mask(e.apiKey), apiSecret: mask(e.apiSecret), smtp: { ...e.smtp, password: mask(e.smtp.password) }, problems: email.emailProblems(e), ready: email.emailReady(e) };
}

r.put('/settings/:key', async ({ ctx, params, body }) => {
  identity.requireAdmin(ctx);
  // the exposure of the portals is not among them: it is set at installation (APIM_TENANCY,
  // APIM_PORTAL_EXPOSURE), since it changes the form of every public url
  if (!['gateway', 'ingest', 'auth', 'email'].includes(params.key)) throw badRequest('unknown settings key');
  const current = (await db`select value from settings where key = ${params.key}`)[0]?.value || {};
  const value = { ...current, ...body };
  if (params.key === 'auth') {
    const effective = await consoleAuth();
    const keep = (v, old) => (!v || String(v).includes('••') ? old : v);
    if (body.oidc) value.oidc = { ...current.oidc, ...body.oidc, clientSecret: keep(body.oidc.clientSecret, effective.oidc.clientSecret) };
    if (body.otoroshi) value.otoroshi = { ...current.otoroshi, ...body.otoroshi, secret: keep(body.otoroshi.secret, effective.otoroshi.secret) };
    if (value.mode === 'otoroshi' && !value.otoroshi?.secret && !effective.otoroshi.secret)
      throw badRequest('the otoroshi mode needs the secret shared with the route that exposes the console');
  }
  if (params.key === 'gateway' && (!body.clientSecret || body.clientSecret.includes('••'))) value.clientSecret = current.clientSecret || config.otoroshi.clientSecret;
  if (params.key === 'email') {
    // a masked secret sent back keeps the one there is; the transport complete, or refused
    const effective = await email.emailSettings();
    const keep = (v, old) => (v === undefined || String(v).includes('••') ? old : v);
    value.apiKey = keep(body.apiKey, effective.apiKey);
    value.apiSecret = keep(body.apiSecret, effective.apiSecret);
    value.smtp = { ...current.smtp, ...body.smtp, password: keep(body.smtp?.password, effective.smtp.password) };
    if (value.smtp.port !== undefined && value.smtp.port !== '') value.smtp.port = Number(value.smtp.port);
    const problems = email.emailProblems({ ...effective, ...value, smtp: { ...effective.smtp, ...value.smtp } });
    if (problems.length) throw badRequest(problems.join('; '));
  }
  // the policy of the ingester: checked, completed, its key kept unless rotated
  const stored = params.key === 'ingest' ? normalizeIngest(body, { ...current, key: (await ingestPolicy()).key }) : value;
  await db`insert into settings (key, value) values (${params.key}, ${sealSettings(params.key, stored)}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  invalidateGatewaySettings();
  invalidateAuthSettings();
  invalidateIngestPolicy();
  email.invalidateEmailSettings();
  // what an ingestion policy changes is a processing of personal data: the audit keeps its old and new values
  const data = params.key === 'ingest' ? { before: publicPolicy(normalizeIngest({}, current)), after: publicPolicy(stored), rotatedKey: !!body.rotateKey } : undefined;
  await audit(ctx, { action: `settings.${params.key}.update`, entityKind: 'settings', entityId: params.key, summary: `${params.key} settings updated`, data });
  return params.key === 'ingest' ? { updated: params.key, ingest: publicPolicy(stored) } : { updated: params.key };
});

// an email to an address, through the transport of the installation: what it answers
r.post('/settings/email/test', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  const to = String(body?.to || ctx.user?.email || '').trim();
  if (!email.parseAddress(to)) throw badRequest('to: an email address');
  const out = await email.sendTestEmail(to);
  await audit(ctx, { action: 'settings.email.test', entityKind: 'settings', entityId: 'email', summary: `test email to ${to}: ${out.sent ? 'sent' : `not sent, ${out.error}`}` });
  return out;
});

// the emails sent, and the ones that failed: searched, paged
r.get('/settings/email/deliveries', async ({ ctx, query }) => {
  identity.requireAdmin(ctx);
  return email.listDeliveries({ ...pageParams(query, { defaultLimit: 50, max: 200 }), status: query.get('status') || null });
});

// rolls the computed path up and applies the retention now, instead of at the next run
r.post('/settings/ingest/run', async ({ ctx }) => {
  identity.requireAdmin(ctx);
  const run = await runRetention();
  await audit(ctx, { action: 'settings.ingest.run', entityKind: 'settings', entityId: 'ingest', summary: 'ingestion rollups and retention run', data: run });
  return run;
});

// ---------------------------------------------------------------- gateway (the single cluster)

r.get('/gateway/status', async ({ ctx }) => {
  identity.requireUser(ctx);
  const [health, queue, lastDrift] = await Promise.all([
    oto.health(),
    queueStats({ workspaceIds: await visibleWorkspaces(ctx) }),
    db`select value from settings where key = 'drift.last_run'`.then((x) => x[0]?.value || null),
  ]);
  if (ctx.user.is_admin) {
    const ingest = await analytics.ingestStats().catch(() => null);
    return { health, queue, drift: lastDrift, ingest };
  }
  // anyone else sees the state of the gateway for its own workspaces: whether it answers, its
  // projections, its drift — not the settings of the gateway (its url, its errors) nor the volumes of
  // the installation
  const mine = (await identity.listWorkspacesFor(ctx.user)).map((w) => w.id);
  const reports = lastDrift ? (await driftReports(null)).filter((r) => r.workspace_id && mine.includes(r.workspace_id)) : [];
  const count = (status) => reports.filter((r) => r.status === status).length;
  return {
    health: { ok: health.ok, latencyMs: health.latencyMs },
    queue,
    drift: lastDrift && { at: lastDrift.at, drifted: count('drifted'), missing: count('missing') },
  };
});

r.get('/gateway/tasks', async ({ ctx, query }) => {
  identity.requireUser(ctx);
  return searchTasks({ status: query.get('status'), ...pageParams(query), workspaceIds: await visibleWorkspaces(ctx) });
});

r.post('/gateway/tasks/:id/retry', async ({ ctx, params }) => {
  identity.requireAdmin(ctx);
  await db`update tasks set status = 'pending', run_after = now(), attempts = 0 where id = ${params.id}`;
  await audit(ctx, { action: 'gateway.task.retry', entityKind: 'task', entityId: params.id, summary: `task ${params.id} queued again` });
  return { retried: params.id };
});

// a failed task given up: it no longer counts as waiting for someone
r.post('/gateway/tasks/:id/dismiss', async ({ ctx, params, body }) => {
  identity.requireAdmin(ctx);
  const task = await dismissTask(params.id, body.reason || `dismissed by ${ctx.user.email}`);
  if (!task) throw badRequest('only a failed task can be dismissed');
  await audit(ctx, { action: 'gateway.task.dismiss', entityKind: 'task', entityId: params.id, summary: `failed task ${task.kind} dismissed` });
  return task;
});

// infrastructure the product references but does not own
r.get('/gateway/references', async ({ ctx }) => {
  identity.requireUser(ctx);
  const [verifiers, auths, certs] = await Promise.all([
    oto.listJwtVerifiers().catch(() => []),
    oto.listAuthModules().catch(() => []),
    oto.listCertificates().catch(() => []),
  ]);
  return {
    jwtVerifiers: (verifiers || []).map((v) => ({ id: v.id, name: v.name })),
    authModules: (auths || []).map((a) => ({ id: a.id, name: a.name, type: a.type })),
    keyPairs: (certs || []).filter((c) => c.keypair).map((c) => ({ id: c.id, name: c.name })),
  };
});

const pluginSummary = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  steps: p.plugin_steps || p.steps || [],
  categories: p.plugin_categories || [],
  defaultConfig: p.default_config ?? null,
});

// what the Threat Protection Suite of the gateway offers a plan: whether it is installed, and the
// policies a plan references (entities of the extension: consumed, never written by the product)
r.get('/gateway/threat-protection', async ({ ctx }) => {
  identity.requireUser(ctx);
  return threatProtectionCatalog();
});

r.get('/gateway/plugins', async ({ ctx }) => {
  identity.requireUser(ctx);
  return (await gatewayPlugins()).map(pluginSummary);
});

// one plugin with the description of its configuration form (`config_schema` / `config_flow`,
// the description Otoroshi's own ui renders)
r.get('/gateway/plugins/:plugin', async ({ ctx, params }) => {
  identity.requireUser(ctx);
  const p = (await gatewayPlugins()).find((x) => x.id === params.plugin);
  if (!p) throw notFound(`plugin ${params.plugin} is not in the gateway's catalog`);
  return { ...pluginSummary(p), configSchema: p.config_schema || null, configFlow: p.config_flow || [] };
});

// reads a certificate pasted in the console: what it is, and how Otoroshi will see its subject
// when it signs the client certificates of an mtls plan
r.post('/certificates/inspect', async ({ ctx, body }) => {
  identity.requireUser(ctx);
  try {
    const c = readCertificate(body.pem);
    return { ...c, issuerPattern: issuerPatterns([body.pem])?.[0] || null };
  } catch (e) {
    throw badRequest(`not a readable PEM certificate: ${e.message}`);
  }
});

// reads the discovery document of an authorization server, to describe it in an oauth2-remote
// plan. Fetched by the product (an IdP inside the network is reachable), http(s) only, short.
r.post('/oidc/discovery', async ({ ctx, body }) => {
  identity.requireUser(ctx);
  let url;
  try {
    url = new URL(String(body.url || '').trim());
  } catch (e) {
    throw badRequest('give the url of the authorization server or of its discovery document');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('an http or https url');
  if (!url.pathname.includes('.well-known')) url = new URL(`${url.href.replace(/\/$/, '')}/.well-known/openid-configuration`);
  let doc;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    doc = await res.json();
  } catch (e) {
    throw badRequest(`cannot read ${url.href}: ${e.message}`);
  }
  return {
    discoveryUrl: url.href,
    issuer: doc.issuer || null,
    jwksUrl: doc.jwks_uri || null,
    userInfoUrl: doc.userinfo_endpoint || null,
    scopes: doc.scopes_supported || [],
  };
});

// installs the data exporter that feeds the ingester: the exporter part of the setup
r.post('/gateway/exporter', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  const report = await runSetup({ only: ['exporter'], options: body.url ? { exporterUrl: body.url } : {}, actor: ctx.user?.email });
  const part = report.parts[0];
  if (part.status === 'error') throw badRequest(part.notes.join('; '));
  await audit(ctx, { action: 'gateway.exporter.install', entityKind: 'gateway', entityId: EXPORTER_ID, summary: `data exporter ${part.actions[0]?.op}`, data: { url: report.options.exporterUrl } });
  return { id: EXPORTER_ID, url: report.options.exporterUrl, op: part.actions[0]?.op };
});

// the setup of the gateway: what the product needs there, its parts, what the last run did
r.get('/gateway/setup', async ({ ctx }) => {
  identity.requireAdmin(ctx);
  return setupState();
});

// a run, all of it or some parts, a dry run first if asked. `otoroshi` is an Otoroshi admin key
// for this run only: never stored, never audited
r.post('/gateway/setup', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  const only = Array.isArray(body.only) ? body.only : body.only ? String(body.only).split(',').map((x) => x.trim()).filter(Boolean) : null;
  const report = await runSetup({ only, dryRun: !!body.dryRun, creds: body.otoroshi || null, options: body.options || {}, actor: ctx.user?.email || 'api' });
  if (!body.dryRun)
    await audit(ctx, {
      action: 'gateway.setup',
      entityKind: 'gateway',
      entityId: 'setup',
      summary: `gateway setup: ${report.parts.map((p) => `${p.part} ${p.status}`).join(', ')}`,
      data: { only, withAdminKey: !!body.otoroshi?.clientId, options: report.options, parts: report.parts.map((p) => ({ part: p.part, status: p.status, actions: p.actions.map((a) => ({ op: a.op, kind: a.kind, id: a.id })) })) },
    });
  return report;
});

r.post('/gateway/drift', async ({ ctx }) => {
  identity.requireUser(ctx);
  return runDriftDetection();
});

// every report of the installation: the gateway is one cluster for all the workspaces
r.get('/gateway/drift-reports', async ({ ctx }) => {
  identity.requireUser(ctx);
  const reports = await driftReports(null);
  if (ctx.user.is_admin) return reports;
  const mine = (await identity.listWorkspacesFor(ctx.user)).map((w) => w.id);
  return reports.filter((r) => !r.workspace_id || mine.includes(r.workspace_id));
});

r.get('/gateway/unmanaged-apis', async ({ ctx }) => {
  identity.requireUser(ctx);
  return unmanagedApis();
});

// ---------------------------------------------------------------- users (an admin only sees members of its workspaces)

// the people of the installation (an installation admin) or of the workspaces the caller administers,
// searched (email, name, tags) and paged on the server
r.get('/users', async ({ ctx, query }) => {
  identity.requireUser(ctx);
  const { limit, offset, q } = pageParams(query, { defaultLimit: 50 });
  const pattern = q ? likePattern(q.toLowerCase()) : null;
  const visible = ctx.user.is_admin
    ? db`true`
    : db`u.id in (select m.user_id from workspace_members m where m.workspace_id in (select workspace_id from workspace_members where user_id = ${ctx.user.id} and role = 'admin'))`;
  const matches = db`(${pattern}::text is null or lower(u.email) like ${pattern} or lower(u.name) like ${pattern} or lower(u.tags::text) like ${pattern})`;
  const [items, [{ total }]] = await Promise.all([
    db`select u.id, u.email, u.name, u.tags, u.is_admin, u.created_at from users u where ${visible} and ${matches} order by u.email limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from users u where ${visible} and ${matches}`,
  ]);
  // a bootstrap administrator is made again at start: it is not deleted from here
  return { items: items.map((u) => ({ ...u, bootstrap: isBootstrapAdmin(u) })), total, limit, offset };
});

r.post('/users', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  const u = await identity.createUser({ email: body.email, name: body.name, password: body.password, isAdmin: !!body.is_admin, tags: body.tags || [] });
  await audit(ctx, { action: 'user.create', entityKind: 'user', entityId: u.id, summary: `user ${u.email} created` });
  return identity.publicUser(u);
});

r.put('/users/:id', async ({ ctx, params, body }) => {
  identity.requireAdmin(ctx);
  const u = await identity.findUser(params.id);
  if (!u) throw notFound('user not found');
  const hash = body.password ? await Bun.password.hash(body.password) : u.password_hash;
  const rows = await db`update users set name = ${body.name ?? u.name}, tags = ${body.tags ?? u.tags}, is_admin = ${body.is_admin ?? u.is_admin},
    password_hash = ${hash}, updated_at = now() where id = ${u.id} returning *`;
  await audit(ctx, { action: 'user.update', entityKind: 'user', entityId: u.id, summary: `user ${u.email} updated` });
  return identity.publicUser(rows[0]);
});

// a person deleted: their personal applications closed and deleted, their access gone (server/domain/people.js)
r.delete('/users/:id', async ({ ctx, params }) => {
  identity.requireAdmin(ctx);
  const u = (await identity.findUser(params.id)) || (await identity.findUserByEmail(params.id));
  if (!u) throw notFound('user not found');
  return deleteUser(ctx, u);
});

// ---------------------------------------------------------------- workspaces

r.get('/workspaces', async ({ ctx }) => {
  identity.requireUser(ctx);
  return (await identity.listWorkspacesFor(ctx.user)).map(withPortal);
});

r.post('/workspaces', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  return withPortal(await identity.createWorkspace(ctx, body));
});

r.get('/workspaces/:ws', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return { ...withPortal(c.workspace), role: c.role };
});

r.put('/workspaces/:ws', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  if (body.metadata !== undefined) body.metadata = await metadata.checkValues(c.workspace.id, 'workspace', body.metadata);
  return withPortal(await identity.updateWorkspace(c, c.workspace, body));
});

// ---------------------------------------------------------------- the design of the portal

// the draft, the published version and what differs; the producers read it, the administrators edit
r.get('/workspaces/:ws/portal/design', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return portalDesign.designState(c.workspace);
});
r.put('/workspaces/:ws/portal/design', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return portalDesign.saveDraft(c, c.workspace, body);
});
r.post('/workspaces/:ws/portal/publish', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return portalDesign.publishDesign(c, c.workspace, body);
});
r.get('/workspaces/:ws/portal/versions', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return portalDesign.listVersions(c.workspace.id, pageParams(query, { defaultLimit: 50 }));
});
r.get('/workspaces/:ws/portal/versions/:n', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return portalDesign.getVersion(c.workspace.id, params.n);
});
r.post('/workspaces/:ws/portal/versions/:n/restore', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return portalDesign.restoreVersion(c, c.workspace, params.n);
});
// the files of the design: uploaded as base64, read back by their digest
r.post('/workspaces/:ws/portal/assets', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return portalDesign.storeAsset(c, c.workspace, body);
});
r.get('/workspaces/:ws/portal/assets/:hash', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  const a = await portalDesign.getAsset(c.workspace.id, params.hash);
  return { hash: params.hash, contentType: a.content_type, size: a.size, data: Buffer.from(a.data).toString('base64') };
});
// the declarative document of the design (the draft), and its apply — the cli and the catalogs
r.get('/workspaces/:ws/portal/document', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return portalDesign.portalDocument(c.workspace);
});
r.post('/workspaces/:ws/portal/apply', async ({ ctx, params, body, query }) => {
  const c = await ws(ctx, params, ['admin']);
  return portalDesign.applyPortalDocument(c, c.workspace, body, { managedBy: query.get('managed_by') || null, publish: query.get('publish') === 'true', comment: query.get('comment') || '', force: query.get('force') === 'true' });
});
// scripts on the portal: off by default; allowing them acknowledges what they can do
r.get('/workspaces/:ws/portal/scripts', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return { ...portalDesign.scriptsOf(c.workspace), warning: portalDesign.SCRIPTS_WARNING };
});
r.put('/workspaces/:ws/portal/scripts', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return portalDesign.setScripts(c, c.workspace, body);
});
// a link to the portal showing the draft, for an hour
r.post('/workspaces/:ws/portal/preview', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  const token = portalDesign.previewToken(c.workspace);
  const base = withPortal(c.workspace).portal_url;
  return { token, url: `${String(base).replace(/\/$/, '')}/?preview=${encodeURIComponent(token)}`, expires_in: 3600 };
});

// what the workspace sends by email: to the people of its portal, to its producers, kind by kind; and
// whether the installation has a transport to send it with
r.get('/workspaces/:ws/email', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  const t = await email.emailSettings();
  return { ...email.normalizeWorkspaceEmail(c.workspace.email), kinds: email.EMAIL_KINDS, transport: { transport: t.transport, ready: email.emailReady(t) } };
});

r.put('/workspaces/:ws/email', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  const before = email.normalizeWorkspaceEmail(c.workspace.email);
  const next = email.normalizeWorkspaceEmail({ ...before, ...(body || {}) });
  await db`update workspaces set email = ${next}, updated_at = now() where id = ${c.workspace.id}`;
  const said = (f) => (next[f].enabled ? `on${Object.keys(next[f].kinds).length ? `, ${Object.keys(next[f].kinds).length} kind(s) off` : ''}` : 'off');
  await audit(c, { action: 'workspace.email.update', workspaceId: c.workspace.id, entityKind: 'workspace', entityId: c.workspace.id, summary: `email to the people of the portal ${said('portal')}, to the producers ${said('console')}`, data: { before, after: next } });
  return next;
});

// the outgoing webhooks of a workspace: its events sent to endpoints, signed, retried, replayed — an
// administrator's
const hookOf = async (c, params) => webhooks.getEndpoint(c.workspace.id, params.webhook);

r.get('/workspaces/:ws/webhooks', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.listEndpoints(c.workspace.id);
});

// the types an endpoint may take: the actions the trail of the workspace has recorded
r.get('/workspaces/:ws/webhook-types', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.eventTypes(c.workspace.id);
});

r.post('/workspaces/:ws/webhooks', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.createEndpoint(c, c.workspace.id, body || {});
});

r.get('/workspaces/:ws/webhooks/:webhook', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.showEndpoint(await hookOf(c, params));
});

r.put('/workspaces/:ws/webhooks/:webhook', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.updateEndpoint(c, await hookOf(c, params), body || {});
});

r.delete('/workspaces/:ws/webhooks/:webhook', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await webhooks.deleteEndpoint(c, await hookOf(c, params));
  return { deleted: true };
});

r.post('/workspaces/:ws/webhooks/:webhook/secret', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.revealSecret(c, await hookOf(c, params));
});

r.post('/workspaces/:ws/webhooks/:webhook/rotate', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.rotateSecret(c, await hookOf(c, params));
});

r.post('/workspaces/:ws/webhooks/:webhook/test', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.sendTest(c, await hookOf(c, params));
});

r.get('/workspaces/:ws/webhooks/:webhook/deliveries', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.listDeliveries(await hookOf(c, params), { ...pageParams(query, { defaultLimit: 50, max: 200 }), status: query.get('status') || null });
});

r.get('/workspaces/:ws/webhooks/:webhook/deliveries/:delivery', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.delivery(await hookOf(c, params), params.delivery);
});

r.post('/workspaces/:ws/webhooks/:webhook/deliveries/:delivery/redeliver', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.redeliver(c, await hookOf(c, params), params.delivery);
});

r.post('/workspaces/:ws/webhooks/:webhook/recover', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return webhooks.recover(c, await hookOf(c, params), body?.since);
});

r.delete('/workspaces/:ws', async ({ ctx, params }) => {
  identity.requireAdmin(ctx);
  const c = await ws(ctx, params, ['admin']);
  const n = (await db`select count(*)::int as c from apis where workspace_id = ${c.workspace.id}`)[0].c;
  if (n > 0) throw badRequest('delete the apis of this workspace first');
  await identity.deleteWorkspace(c, c.workspace);
  return { deleted: true };
});

r.get('/workspaces/:ws/members', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return identity.listMembers(c.workspace.id);
});

r.post('/workspaces/:ws/members', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  let user = body.user_id ? await identity.findUser(body.user_id) : await identity.findUserByEmail(body.email || '');
  if (!user) {
    if (!body.email) throw badRequest('email is required');
    user = await identity.createUser({ email: body.email, name: body.name, password: body.password || crypto.randomUUID() });
  }
  await identity.addMember(c.workspace.id, user.id, body.role || 'consumer');
  await audit(c, { action: 'workspace.member.set', entityKind: 'user', entityId: user.id, summary: `${user.email} is ${body.role || 'consumer'}` });
  return { user_id: user.id, role: body.role || 'consumer' };
});

r.delete('/workspaces/:ws/members/:user', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await identity.removeMember(c.workspace.id, params.user);
  await audit(c, { action: 'workspace.member.remove', entityKind: 'user', entityId: params.user, summary: `member removed` });
  return { deleted: true };
});

// ---------------------------------------------------------------- teams

r.get('/workspaces/:ws/teams', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return identity.listTeams(c.workspace.id);
});

r.post('/workspaces/:ws/teams', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  return identity.createTeam(c, c.workspace.id, { ...body, ownerId: body.owner_id || ctx.user.id });
});

r.get('/workspaces/:ws/teams/:team', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const t = await identity.findTeam(c.workspace.id, params.team);
  if (!t) throw notFound('team not found');
  return { ...t, members: await identity.teamMembers(t.id) };
});

r.put('/workspaces/:ws/teams/:team', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const t = await identity.findTeam(c.workspace.id, params.team);
  if (!t) throw notFound('team not found');
  await identity.requireManageTeam(c, t);
  return identity.updateTeam(c, t, body);
});

r.delete('/workspaces/:ws/teams/:team', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  const t = await identity.findTeam(c.workspace.id, params.team);
  if (!t) throw notFound('team not found');
  await identity.deleteTeam(c, t);
  return { deleted: true };
});

r.post('/workspaces/:ws/teams/:team/members', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const t = await identity.findTeam(c.workspace.id, params.team);
  if (!t) throw notFound('team not found');
  await identity.requireManageTeam(c, t);
  let userId = body.user_id;
  if (!userId && body.email) {
    const u = await identity.findUserByEmail(body.email);
    if (!u) throw notFound('no user with this email');
    userId = u.id;
  }
  await identity.setTeamMember(c, t, userId, body.role || 'member');
  return identity.teamMembers(t.id);
});

r.delete('/workspaces/:ws/teams/:team/members/:user', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const t = await identity.findTeam(c.workspace.id, params.team);
  if (!t) throw notFound('team not found');
  await identity.requireManageTeam(c, t);
  await identity.removeTeamMember(c, t, params.user);
  return identity.teamMembers(t.id);
});

// ---------------------------------------------------------------- apis

r.get('/workspaces/:ws/apis', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return apis.listApis(c.workspace.id, { q: query.get('q'), teamId: query.get('team'), lifecycle: query.get('lifecycle') });
});

// a producer makes an api for one of its own teams only — created or adopted from the gateway
async function requireOwnTeam(c, ctx, teamId) {
  if (teamId && c.role === 'producer' && !(await identity.isTeamMember(teamId, ctx.user.id))) throw forbidden('you are not a member of this team');
}

r.post('/workspaces/:ws/apis', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  await requireOwnTeam(c, ctx, body.team_id);
  return apis.createApi(c, c.workspace.id, body);
});

r.get('/workspaces/:ws/apis/:api', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  const [status, pending, versions] = await Promise.all([
    deployments.deploymentStatus(api),
    apis.pendingChanges(api),
    apis.versionsOf(c.workspace.id, api.slug),
  ]);
  const draft = normalizeDraft(api.draft);
  return {
    ...api,
    draft,
    base_url: await gatewayBaseUrl(draft),
    deployment: status,
    pending_changes: { hasChanges: pending.hasChanges, count: pending.changes?.length ?? null, base: pending.snapshot },
    validation: await apis.validateWithMetadata(c.workspace.id, draft, { apiId: api.id }),
    resolution_order: resolutionOrder(draft),
    versions,
    can_manage: await apis.canManageApi(c, api),
    // what waits for its producers: the requests to review
    pending_subscriptions: (await db`select count(*)::int as c from subscriptions where api_id = ${api.id} and status = 'pending'`)[0].c,
  };
});

r.put('/workspaces/:ws/apis/:api', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return apis.updateApi(c, api, body);
});

r.put('/workspaces/:ws/apis/:api/draft', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const updated = await apis.updateApi(c, api, { draft: body.draft || body, force: body.force });
  return { draft: normalizeDraft(updated.draft), validation: await apis.validateWithMetadata(c.workspace.id, updated.draft, { apiId: api.id }), resolution_order: resolutionOrder(updated.draft) };
});

r.post('/workspaces/:ws/apis/:api/validate', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  return apis.validateWithMetadata(c.workspace.id, body.draft || body, { apiId: api.id });
});

r.delete('/workspaces/:ws/apis/:api', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const status = await deployments.deploymentStatus(api);
  let task = null;
  if (status.on_gateway) task = await deployments.purgeFromGateway(api);
  await apis.deleteApiRow(c, api);
  return { deleted: true, gateway: task ? { task: task.id, status: task.status, error: task.last_error } : null };
});

r.post('/workspaces/:ws/apis/:api/lifecycle', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const updated = await apis.setLifecycle(c, api, body.lifecycle);
  // a lifecycle change changes the state of the projected Api: redeploy the running snapshot
  const current = await deployments.currentDeployment(api.id);
  if (current && ['published', 'deprecated'].includes(updated.lifecycle)) await deployments.deploy(c, updated, { snapshot: current.snapshot_id });
  if (updated.lifecycle === 'archived' && current) await deployments.undeploy(c, updated);
  return updated;
});

// the catalogue as a discovery system: where an api stands (categories, featured), its reviews
r.put('/workspaces/:ws/apis/:api/placement', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return discovery.setPlacement(c, api, body);
});

r.get('/workspaces/:ws/apis/:api/reviews', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  const list = await discovery.listReviews(c.workspace.id, api.slug, { includeHidden: true });
  const shown = list.filter((r) => !r.hidden);
  return {
    rating: shown.length ? { average: Math.round((shown.reduce((s, r) => s + r.rating, 0) / shown.length) * 10) / 10, count: shown.length } : null,
    reviews: list,
  };
});

r.post('/workspaces/:ws/apis/:api/reviews/:review/hide', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  await apiOf(c, params, { manage: true });
  return discovery.hideReview(c, c.workspace.id, params.review, body?.hidden !== false);
});

// the announcements of an api, across its versions: published at once, its subscribers told
r.get('/workspaces/:ws/apis/:api/announcements', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  return announcements.listAnnouncements(c.workspace.id, api.slug);
});

r.post('/workspaces/:ws/apis/:api/announcements', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return announcements.createAnnouncement(c, api, body || {});
});

r.put('/workspaces/:ws/apis/:api/announcements/:announcement', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const current = await announcements.getAnnouncement(c.workspace.id, api.slug, params.announcement);
  return announcements.updateAnnouncement(c, api, current, body || {});
});

r.delete('/workspaces/:ws/apis/:api/announcements/:announcement', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const current = await announcements.getAnnouncement(c.workspace.id, api.slug, params.announcement);
  await announcements.deleteAnnouncement(c, api, current);
  return { deleted: true };
});

r.post('/workspaces/:ws/apis/:api/versions', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return apis.newVersion(c, api, body);
});

// documentation pages
r.get('/workspaces/:ws/apis/:api/pages', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  return apis.listPages(api.id);
});
r.post('/workspaces/:ws/apis/:api/pages', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return apis.createPage(c, api, body);
});
r.get('/workspaces/:ws/apis/:api/pages/:page', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  return apis.getPage(api.id, params.page);
});
r.put('/workspaces/:ws/apis/:api/pages/:page', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return apis.updatePage(c, api, await apis.getPage(api.id, params.page), body);
});
r.delete('/workspaces/:ws/apis/:api/pages/:page', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  await apis.deletePage(c, api, await apis.getPage(api.id, params.page));
  return { deleted: true };
});

// snapshots & publication
r.get('/workspaces/:ws/apis/:api/changes', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return apis.pendingChanges(await apiOf(c, params));
});
r.post('/workspaces/:ws/apis/:api/publish', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const res = await apis.publish(c, api, body);
  if (body.deploy) {
    const dep = await deployments.deploy(c, (await apis.getApi(c.workspace.id, api.id)), { snapshot: res.snapshot.id });
    return { ...res, deployment: dep };
  }
  return res;
});
r.get('/workspaces/:ws/apis/:api/snapshots', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return apis.listSnapshots((await apiOf(c, params)).id);
});
r.get('/workspaces/:ws/apis/:api/snapshots/:snap', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return apis.getSnapshot((await apiOf(c, params)).id, params.snap);
});

// payments: the Stripe account a workspace sells its paid plans with (Stripe Connect), its events
r.get('/workspaces/:ws/payments', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return billing.status(c.workspace);
});
r.post('/workspaces/:ws/payments/connect', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return { url: billing.connectUrl(c, c.workspace) };
});
r.delete('/workspaces/:ws/payments', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return billing.disconnect(c, c.workspace);
});
r.get('/workspaces/:ws/payments/events', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params, ['admin']);
  return billing.events(c.workspace, pageParams(query, { defaultLimit: 50 }));
});
r.post('/workspaces/:ws/payments/reconcile', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  const res = await billing.reconcile({ workspaceId: c.workspace.id });
  await audit(c, { action: 'payments.reconcile', workspaceId: c.workspace.id, entityKind: 'workspace', entityId: c.workspace.id, summary: `payments reconciled: ${res.checked} checked, ${res.changed.length} changed` });
  return res;
});

// promotion: the same snapshot on the next installation. It carries the secrets of the plans: its
// export is written in the audit trail
r.get('/workspaces/:ws/apis/:api/snapshots/:snap/promotion', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  // `deployed`: the snapshot that runs here, what a promotion usually sends on
  const snapshot = params.snap === 'deployed' ? await deployments.deployedSnapshot(api.id) : await apis.getSnapshot(api.id, params.snap);
  if (!snapshot) throw badRequest('this api is not deployed: name the snapshot to promote');
  return promotion.exportSnapshot(c, c.workspace, api, snapshot);
});
r.post('/workspaces/:ws/promotions', async ({ ctx, params, body, query }) => {
  const c = await ws(ctx, params);
  const doc = body.document || body;
  const flag = (k) => body[k] === true || query.get(k) === 'true';
  return promotion.promote(c, c.workspace, doc, { dryRun: flag('dry_run'), deploy: flag('deploy'), replaceDraft: flag('replace_draft') });
});

// deployments: the described state is not the deployed state, and the diff comes first
r.get('/workspaces/:ws/apis/:api/deployments', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  const history = await deployments.listDeployments(api.id, pageParams(query, { defaultLimit: 50 }));
  return { status: await deployments.deploymentStatus(api), history: history.items, total: history.total, limit: history.limit, offset: history.offset };
});
r.post('/workspaces/:ws/apis/:api/deploy', async ({ ctx, params, body, query }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return deployments.deploy(c, api, { snapshot: body.snapshot, dryRun: body.dry_run || query.get('dry_run') === 'true' });
});
r.post('/workspaces/:ws/apis/:api/undeploy', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  return deployments.undeploy(c, api);
});

// the escape hatch: the projected entity, as computed and as the gateway holds it
r.get('/workspaces/:ws/apis/:api/projection', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  const snap = await deployments.deployedSnapshot(api.id);
  const expected = snap ? buildOtoroshiApi(snap.content, { snapshotId: snap.id, snapshotNumber: snap.number, lifecycle: api.lifecycle }) : null;
  let actual = null;
  let error = null;
  try {
    actual = await oto.getApi(api.id);
  } catch (e) {
    error = e.message;
  }
  const gw = await gatewaySettings();
  const report = (await db`select * from drift_reports where entity_kind = 'api' and entity_id = ${api.id}`)[0] || null;
  // objects derived from the description of the api, and whether the gateway holds them
  const derived = [];
  for (const d of snap ? derivedEntities(snap.content) : []) {
    const got = await oto.getEntity(d.path, d.id).catch(() => null);
    derived.push({ kind: d.kind, id: d.id, name: d.entity.name, present: !!got });
  }
  // the deployment history of the gateway, each deployment tied to the snapshot it put live (its ref)
  const numbers = new Map((await db`select id, number from api_snapshots where api_id = ${api.id}`).map((s) => [s.id, s.number]));
  const gatewayDeployments = (actual?.deployments || []).map((d) => ({ id: d.id, at: d.at, owner: d.owner, ref: d.ref || null, snapshot_number: numbers.get(d.ref) ?? null }));
  return {
    derived,
    gateway_deployments: gatewayDeployments,
    otoroshi: { kind: 'apis.otoroshi.io/Api', id: api.id, backoffice_url: gw.backofficeUrl ? `${gw.backofficeUrl.replace(/\/$/, '')}/bo/dashboard/apis/${api.id}` : null },
    expected,
    actual,
    error,
    drift: report,
  };
});

// the execution report of a trial, as the console shows it: the steps that ran plugins, each plugin
// with its outcome, and the consumer the access validators identified. Never the raw report: it
// holds the headers of the request, credentials included.
function traceOf(report) {
  if (!report?.steps) return null;
  const outcome = (p) => p.execution_debug?.out?.result || {};
  const steps = report.steps
    .filter((s) => s.ctx?.plugins?.length)
    .map((s) => ({
      step: s.task,
      durationMs: s.duration,
      plugins: s.ctx.plugins.map((p) => ({ plugin: p.plugin, name: p.name || p.plugin.split('.').pop(), result: outcome(p).kind || null, status: outcome(p).status || null, durationMs: p.duration })),
    }));
  const validators = report.steps.find((s) => s.task === 'call-access-validator-plugins')?.ctx?.plugins || [];
  const key = validators.map((p) => p.execution_debug?.out?.ctx?.apikey || p.execution_debug?.in?.ctx?.apikey).filter(Boolean).pop();
  return {
    durationMs: report.duration,
    overheadMs: report.overhead,
    steps,
    consumer: key ? { client_id: key.clientId, plan_id: key.metadata?.plan_id || null, subscription_id: key.metadata?.apim_subscription_id || null } : null,
    last_step: report.steps[report.steps.length - 1]?.task || null,
  };
}

// the route a path goes to: the resource whose path is the longest prefix of it
function routeFor(draft, path, method) {
  const cp = draft.entrypoint.contextPath === '/' ? '' : draft.entrypoint.contextPath.replace(/\/$/, '');
  const rel = path.startsWith(cp) ? path.slice(cp.length) || '/' : path;
  const fits = (r) => (r.exact ? rel === r.path : rel === r.path || rel.startsWith(r.path === '/' ? '/' : `${r.path}/`) || r.path === '/') && (!r.methods?.length || r.methods.includes(method));
  return [...draft.resources].filter(fits).sort((a, b) => b.path.length - a.path.length)[0] || draft.resources[0];
}

// console side: replay a request through the api on the gateway — real routing, real plans, real
// keys — with Otoroshi's request tester, which answers the execution report of the call: which
// plan identified the caller, what refused it, which plugins ran
r.post('/workspaces/:ws/apis/:api/test', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  const snap = await deployments.deployedSnapshot(api.id);
  if (!snap) throw badRequest('this api is not deployed');
  const draft = normalizeDraft(snap.content.draft);
  const cp = draft.entrypoint.contextPath === '/' ? '' : draft.entrypoint.contextPath.replace(/\/$/, '');
  const path = `${cp}${(body.path || '/').startsWith('/') ? body.path || '/' : `/${body.path}`}`;
  const headers = { ...(body.headers || {}) };
  for (const k of Object.keys(headers)) if (k.toLowerCase() === 'host') delete headers[k];
  let credential = null;
  if (body.subscription_id) {
    // only the credentials the caller can see: the subscriptions of its own applications
    const sub = await subscriptions.getSubscription(c.workspace.id, body.subscription_id);
    const app = await applications.getApplication(c.workspace.id, sub.application_id);
    await applications.requireSeeApplication(c, app);
    const cred = (await subscriptions.credentialsOf(sub.id)).find((x) => x.status === 'active');
    if (!cred) throw badRequest('this subscription has no active credential');
    headers.Authorization = 'Basic ' + Buffer.from(`${cred.client_id}:${cred.client_secret}`).toString('base64');
    credential = { subscription_id: sub.id, client_id: cred.client_id, plan_id: sub.plan_id };
  }
  const method = (body.method || 'GET').toUpperCase();
  const query = body.query ? `?${body.query.replace(/^\?/, '')}` : '';
  const route = routeFor(draft, path, method);
  const started = performance.now();
  let trial;
  try {
    trial = await oto.tryRoute(api.id, route.id, {
      method,
      path: `${path}${query}`,
      headers,
      ...(['GET', 'HEAD'].includes(method) || !body.body ? {} : { body: body.body }),
    });
  } catch (e) {
    throw badRequest(e.status === 0 ? `gateway unreachable: ${e.message}` : `the gateway could not try the request: ${e.message}`);
  }
  if (!trial) throw badRequest('the gateway does not serve this api yet: a deployment takes a few seconds to reach it');
  const durationMs = Math.round(performance.now() - started);
  const buf = Buffer.from(trial.body_base_64 || '', 'base64');
  const text = buf.subarray(0, 256 * 1024).toString('utf8');
  const trace = traceOf(trial.report);
  await audit(c, { action: 'api.test', entityKind: 'api', entityId: api.id, summary: `${method} ${path} tried on the gateway: ${trial.status}`, data: { credential, consumer: trace?.consumer || null } });
  return {
    request: { method, url: `${draft.entrypoint.domain}${path}${query}`, credential },
    status: trial.status,
    durationMs,
    headers: Object.fromEntries(Object.entries(trial.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
    body: text,
    truncated: buf.length > 256 * 1024,
    size: buf.length,
    trace,
  };
});

r.get('/workspaces/:ws/apis/:api/plans', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  const { plans, snapshot } = await subscriptions.subscribablePlans(api);
  return { snapshot: snapshot ? { id: snapshot.id, number: snapshot.number } : null, plans };
});

// adopt mode: take over an Otoroshi Api without overwriting it
r.post('/workspaces/:ws/adopt', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  await requireOwnTeam(c, ctx, body.team_id);
  const entity = await oto.getApi(body.otoroshi_api_id);
  if (!entity) throw notFound('no such api on the gateway');
  if ((await db`select 1 from apis where id = ${entity.id}`).length) throw badRequest('this api is already managed');
  const created = await apis.createApi(c, c.workspace.id, {
    id: entity.id,
    name: body.name || entity.name,
    version: entity.version || '1.0.0',
    description: entity.description || '',
    team_id: body.team_id || null,
    tags: entity.tags || [],
    draft: draftFromOtoroshi(entity, await trustedChains(entity)),
    metadata: { adopted_from: { otoroshi_api_id: entity.id, at: new Date().toISOString(), created_by: entity.metadata?.created_by || null } },
  });
  // its subscriptions and their keys too, unless asked otherwise: the consumers keep calling with them
  let adopted = null;
  if (body.subscriptions !== false) {
    // the applications of the consumers belong to a team: the one asked, the team of the api, or one made for them
    const teamId =
      body.application_team_id ||
      created.team_id ||
      (await db`select id from teams where workspace_id = ${c.workspace.id} and personal = false order by created_at limit 1`)[0]?.id ||
      (await identity.createTeam(c, c.workspace.id, { name: 'Consumers adopted from the gateway' })).id;
    adopted = await adoptSubscriptions(c, c.workspace.id, entity, { teamId });
  }
  await audit(c, {
    action: 'api.adopt',
    entityKind: 'api',
    entityId: created.id,
    summary: `otoroshi api ${entity.id} adopted as a draft${adopted ? `, with ${adopted.subscriptions} subscription(s) and ${adopted.credentials} key(s)` : ''} (nothing written to the gateway)`,
  });
  return { ...created, adopted };
});

// ---------------------------------------------------------------- applications

r.get('/workspaces/:ws/applications', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return applications.listApplications(c.workspace.id, { teamId: query.get('team') });
});
r.post('/workspaces/:ws/applications', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  return applications.createApplication(c, c.workspace.id, body);
});
r.get('/workspaces/:ws/applications/:app', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const app = await applications.getApplication(c.workspace.id, params.app);
  const subs = await subscriptions.listSubscriptions(c.workspace.id, { applicationId: app.id });
  // its certificates are on the gateway while it has an active subscription to an mtls plan
  const certificatesOnGateway = (app.certificates || []).length > 0 && subs.some((s) => s.status === 'active' && s.auth_kind === 'mtls');
  return {
    ...app,
    subscriptions: subs,
    can_see_credentials: await applications.canSeeApplication(c, app),
    certificates_on_gateway: certificatesOnGateway,
    shared_key: await applications.sharedCredentialOf(app.id),
  };
});
r.put('/workspaces/:ws/applications/:app', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const app = await applications.getApplication(c.workspace.id, params.app);
  await applications.requireSeeApplication(c, app);
  return applications.updateApplication(c, app, body);
});
r.delete('/workspaces/:ws/applications/:app', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const app = await applications.getApplication(c.workspace.id, params.app);
  await applications.requireSeeApplication(c, app);
  await applications.deleteApplication(c, app);
  return { deleted: true };
});

// ---------------------------------------------------------------- subscriptions

r.get('/workspaces/:ws/subscriptions', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return subscriptions.listSubscriptions(c.workspace.id, {
    apiId: query.get('api'),
    applicationId: query.get('application'),
    status: query.get('status'),
    planId: query.get('plan'),
  });
});

r.post('/workspaces/:ws/subscriptions', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  return subscriptions.requestSubscription(c, c.workspace.id, body);
});

r.get('/workspaces/:ws/subscriptions/:sub', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const sub = await subscriptions.getSubscription(c.workspace.id, params.sub);
  const app = await applications.getApplication(c.workspace.id, sub.application_id);
  const canSee = await applications.canSeeApplication(c, app);
  const creds = await subscriptions.credentialsOf(sub.id);
  const drift = (await db`select * from drift_reports where entity_kind = 'subscription' and entity_id = ${sub.id}`)[0] || null;
  if (canSee) await audit(c, { action: 'credential.read', entityKind: 'subscription', entityId: sub.id, summary: `credentials of ${sub.id} read` });
  const api = await apis.getApi(c.workspace.id, sub.api_id).catch(() => null);
  return {
    ...sub,
    credentials: creds.map((cr) => ({ ...cr, client_secret: canSee ? cr.client_secret : mask(cr.client_secret) })),
    // what the reader may do: decide (who manages the api), see and rotate the secret (its application's team)
    can_manage: api ? await apis.canManageApi(c, api) : false,
    can_see_credentials: canSee,
    drift,
  };
});

// the usage of a subscription pushed to the meter of the payment provider, batch by batch
r.get('/workspaces/:ws/subscriptions/:sub/usage', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const sub = await subscriptions.getSubscription(c.workspace.id, params.sub);
  return usageOf(sub.id, pageParams(query, { defaultLimit: 200 }));
});

const subAction = (fn) => async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  const sub = await subscriptions.getSubscription(c.workspace.id, params.sub);
  const api = await apis.getApi(c.workspace.id, sub.api_id);
  await apis.requireManageApi(c, api);
  return fn(c, sub, body);
};

r.post('/workspaces/:ws/subscriptions/:sub/accept', subAction((c, s, b) => subscriptions.acceptSubscription(c, s, b)));
r.post('/workspaces/:ws/subscriptions/:sub/reject', subAction((c, s, b) => subscriptions.rejectSubscription(c, s, b)));
r.post('/workspaces/:ws/subscriptions/:sub/suspend', subAction((c, s, b) => subscriptions.suspendSubscription(c, s, b)));
// the end date of a subscription: { "at": "2027-01-31T00:00:00Z" }, or { "at": null } for none
r.post('/workspaces/:ws/subscriptions/:sub/ending', subAction((c, s, b) => subscriptions.setEnding(c, s, b)));
r.post('/workspaces/:ws/subscriptions/:sub/resume', subAction((c, s) => subscriptions.resumeSubscription(c, s)));
r.post('/workspaces/:ws/subscriptions/:sub/close', subAction((c, s) => subscriptions.closeSubscription(c, s)));
r.post('/workspaces/:ws/subscriptions/:sub/transfer', subAction((c, s, b) => subscriptions.transferSubscription(c, s, b, { initiator: 'producer' })));
r.post('/workspaces/:ws/subscriptions/:sub/transfer/decision', subAction((c, s, b) => subscriptions.answerTransfer(c, s, b, { side: 'producer' })));
r.post('/workspaces/:ws/subscriptions/:sub/resync', subAction((c, s) => subscriptions.resync(c, s)));
r.put('/workspaces/:ws/subscriptions/:sub/metadata', subAction((c, s, b) => subscriptions.setSubscriptionMetadata(c, s, b)));
r.post('/workspaces/:ws/subscriptions/:sub/credentials/:cred/rotate', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const sub = await subscriptions.getSubscription(c.workspace.id, params.sub);
  const app = await applications.getApplication(c.workspace.id, sub.application_id);
  await applications.requireSeeApplication(c, app);
  return subscriptions.rotateCredential(c, sub, params.cred);
});

// ---------------------------------------------------------------- observability, audit, drift, search

r.get('/workspaces/:ws/analytics', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return analytics.overview({
    workspaceId: c.workspace.id,
    apiId: query.get('api'),
    planId: query.get('plan'),
    applicationId: query.get('application'),
    subscriptionId: query.get('subscription'),
    status: query.get('status'),
    endpoint: query.get('endpoint'),
    from: query.get('from'),
    to: query.get('to'),
  });
});

// the endpoints called in a range, what the dashboards are filtered on: a method and a templated path
r.get('/workspaces/:ws/analytics/endpoints', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return analytics.endpoints({
    workspaceId: c.workspace.id,
    apiId: query.get('api'),
    planId: query.get('plan'),
    applicationId: query.get('application'),
    subscriptionId: query.get('subscription'),
    status: query.get('status'),
    from: query.get('from'),
    to: query.get('to'),
  });
});

// the filters of a request log, from its url
const callFilter = (c, query) => ({
  workspaceId: c.workspace.id,
  apiId: query.get('api'),
  planId: query.get('plan'),
  applicationId: query.get('application'),
  subscriptionId: query.get('subscription'),
  status: query.get('status'),
  endpoint: query.get('endpoint'),
  method: query.get('method'),
  path: query.get('path'),
  clientId: query.get('client'),
  from: query.get('from'),
  to: query.get('to'),
});

r.get('/workspaces/:ws/analytics/calls', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const rows = await analytics.searchCalls(callFilter(c, query), pageParams(query));
  // reading request logs is a processing of personal data: it is traced
  await audit(c, { action: 'analytics.calls.read', entityKind: 'workspace', entityId: c.workspace.id, summary: 'request log consulted', data: { filter: Object.fromEntries(query) } });
  return rows;
});

// the filtered calls as CSV, the most recent first: an export of personal data, traced as such
r.get('/workspaces/:ws/analytics/calls/export', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const out = await analytics.exportCalls(callFilter(c, query), { q: (query.get('q') || '').trim() });
  await audit(c, {
    action: 'analytics.calls.export',
    entityKind: 'workspace',
    entityId: c.workspace.id,
    summary: `request log exported: ${out.count} calls${out.truncated ? ' (truncated)' : ''}`,
    data: { filter: Object.fromEntries(query), count: out.count },
  });
  return new Response(out.csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="calls-${c.workspace.slug}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv"`,
      'x-apim-exported': String(out.count),
      'x-apim-truncated': String(out.truncated),
      'cache-control': 'no-store',
    },
  });
});

// the security events of the Threat Protection Suite, attributed to the catalogue; they carry the
// address of the caller: reading them is traced like the request log
r.get('/workspaces/:ws/analytics/security', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const rows = await analytics.securityEvents(
    {
      workspaceId: c.workspace.id,
      apiId: query.get('api'),
      planId: query.get('plan'),
      applicationId: query.get('application'),
      category: query.get('category'),
      action: query.get('action'),
      from: query.get('from'),
      to: query.get('to'),
    },
    pageParams(query)
  );
  await audit(c, { action: 'analytics.security.read', entityKind: 'workspace', entityId: c.workspace.id, summary: 'security events consulted', data: { filter: Object.fromEntries(query) } });
  return rows;
});

r.get('/workspaces/:ws/audit', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return searchAudit(c.workspace.id, { ...pageParams(query), entityId: query.get('entity'), action: query.get('action') });
});

r.get('/audit', async ({ ctx, query }) => {
  identity.requireAdmin(ctx);
  return searchAudit(null, { ...pageParams(query), action: query.get('action') });
});

// audit trail exporters (installation level)
const hideAuth = (e) => ({ ...e, headers: Object.fromEntries(Object.entries(e.headers || {}).map(([k, v]) => [k, /auth|token|key/i.test(k) ? '••••••' : v])) });
r.get('/audit/exporters', async ({ ctx }) => {
  identity.requireAdmin(ctx);
  return (await auditExport.listExporters()).map(hideAuth);
});
r.post('/audit/exporters', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  return hideAuth(await auditExport.saveExporter(ctx, body));
});
r.put('/audit/exporters/:id', async ({ ctx, params, body }) => {
  identity.requireAdmin(ctx);
  const ex = await auditExport.getExporter(params.id);
  const headers = body.headers ? Object.fromEntries(Object.entries(body.headers).map(([k, v]) => [k, v === '••••••' ? ex.headers?.[k] : v])) : ex.headers;
  return hideAuth(await auditExport.saveExporter(ctx, { ...body, headers }, ex));
});
r.delete('/audit/exporters/:id', async ({ ctx, params }) => {
  identity.requireAdmin(ctx);
  await auditExport.deleteExporter(ctx, await auditExport.getExporter(params.id));
  return { deleted: true };
});
r.post('/audit/exporters/:id/test', async ({ ctx, params }) => {
  identity.requireAdmin(ctx);
  return auditExport.testExporter(await auditExport.getExporter(params.id));
});

// the notifications of the person signed in: each reads them, and marks them done, on their own.
// filter: open (not done, the default) | unread | done | all
r.get('/workspaces/:ws/notifications', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const filter = ['open', 'unread', 'done', 'all'].includes(query.get('filter')) ? query.get('filter') : 'open';
  const page = await notifications.searchFor(ctx.user, c.workspace.id, 'console', { filter, ...pageParams(query, { defaultLimit: 50 }) });
  return { unread: await notifications.unreadCount(ctx.user, c.workspace.id, 'console'), ...page };
});
const noteIds = (body) => (Array.isArray(body?.ids) ? body.ids.map(String) : null);
// all of them, or the `ids` given
r.post('/workspaces/:ws/notifications/read', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  await notifications.markRead(ctx.user, c.workspace.id, 'console', noteIds(body));
  return { unread: await notifications.unreadCount(ctx.user, c.workspace.id, 'console') };
});
r.post('/workspaces/:ws/notifications/done', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  if (!noteIds(body)) throw badRequest('ids: the notifications to mark done');
  await notifications.markDone(ctx.user, c.workspace.id, 'console', noteIds(body), body.done !== false);
  return { unread: await notifications.unreadCount(ctx.user, c.workspace.id, 'console') };
});

r.get('/workspaces/:ws/drift', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return driftReports(c.workspace.id);
});

r.post('/workspaces/:ws/drift', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return runDriftDetection({ workspaceId: c.workspace.id });
});

r.get('/workspaces/:ws/search', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const q = `%${(query.get('q') || '').toLowerCase()}%`;
  const wsId = c.workspace.id;
  const [a, apps, subs, teams] = await Promise.all([
    db`select id, name, version, 'api' as kind from apis where workspace_id = ${wsId} and (lower(name) like ${q} or lower(slug) like ${q} or tags::text ilike ${q}) limit 8`,
    db`select id, name, 'application' as kind from applications where workspace_id = ${wsId} and (lower(name) like ${q} or lower(coalesce(client_id, '')) like ${q}) limit 8`,
    db`select s.id, s.status, s.api_id, a.name as api_name, app.name as app_name, 'subscription' as kind from subscriptions s
       join apis a on a.id = s.api_id join applications app on app.id = s.application_id
       where s.workspace_id = ${wsId} and (lower(s.id) like ${q} or lower(app.name) like ${q}) limit 8`,
    db`select id, name, 'team' as kind from teams where workspace_id = ${wsId} and lower(name) like ${q} limit 5`,
  ]);
  const plans = await db`select a.id as api_id, a.name as api_name, a.version, p->>'id' as id, p->>'name' as name, 'plan' as kind
    from apis a, jsonb_array_elements(a.draft->'plans') p where a.workspace_id = ${wsId} and lower(p->>'name') like ${q} limit 8`;
  // a credential found by its client id
  const creds = await db`select c.client_id, c.subscription_id as id, 'credential' as kind from credentials c
    join subscriptions s on s.id = c.subscription_id where s.workspace_id = ${wsId} and c.kind <> 'alias' and lower(c.client_id) like ${q} limit 5`;
  // the credential of an application, which every api of the application is called with
  const shared = await db`select app.id, app.name, 'application' as kind from credentials c join applications app on app.id = c.application_id
    where app.workspace_id = ${wsId} and c.shared and c.status = 'active' and lower(c.client_id) like ${q} limit 5`;
  return [...a, ...plans, ...apps, ...subs, ...teams, ...creds, ...shared.filter((x) => !apps.some((y) => y.id === x.id))];
});

r.get('/workspaces/:ws/home', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const wsId = c.workspace.id;
  const [counts] = await db`select
      (select count(*)::int from apis where workspace_id = ${wsId}) as apis,
      (select count(*)::int from apis where workspace_id = ${wsId} and lifecycle = 'published') as published_apis,
      (select count(*)::int from applications where workspace_id = ${wsId}) as applications,
      (select count(*)::int from subscriptions where workspace_id = ${wsId} and status = 'active') as active_subscriptions,
      (select count(*)::int from subscriptions where workspace_id = ${wsId} and status = 'pending') as pending_subscriptions,
      (select count(*)::int from drift_reports where workspace_id = ${wsId} and status in ('drifted', 'missing')) as drifted`;
  const pending = await subscriptions.listSubscriptions(wsId, { status: 'pending' });
  const recent = await listAudit(wsId, { limit: 12 });
  const outOfSync = await db`select a.id, a.name, a.version from apis a where a.workspace_id = ${wsId}
    and exists (select 1 from api_snapshots s where s.api_id = a.id)
    and coalesce((select d.snapshot_id from api_deployments d where d.api_id = a.id and d.status = 'deployed' order by d.finished_at desc limit 1), '')
      <> (select s.id from api_snapshots s where s.api_id = a.id order by s.number desc limit 1)`;
  return { counts, pending: pending.slice(0, 10), recent, out_of_sync: outOfSync };
});

// ---------------------------------------------------------------- export / import

r.get('/workspaces/:ws/export', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await audit(c, { action: 'workspace.export', entityKind: 'workspace', entityId: c.workspace.id, summary: 'workspace exported' });
  return exportWorkspace(c.workspace);
});

r.post('/workspaces/:ws/import', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return importWorkspace(c, c.workspace, body);
});

// ---------------------------------------------------------------- remote catalogs

const hideHeaders = (c) => ({ ...c, headers: Object.fromEntries(Object.entries(c.headers || {}).map(([k, v]) => [k, /auth|token|key/i.test(k) ? '••••••' : v])) });

r.get('/workspaces/:ws/catalogs', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return (await catalogs.listCatalogs(c.workspace.id)).map(hideHeaders);
});
r.post('/workspaces/:ws/catalogs', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return hideHeaders(await catalogs.createCatalog(c, c.workspace.id, body));
});
r.put('/workspaces/:ws/catalogs/:cat', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  const cat = await catalogs.getCatalog(c.workspace.id, params.cat);
  const headers = body.headers ? Object.fromEntries(Object.entries(body.headers).map(([k, v]) => [k, v === '••••••' ? cat.headers?.[k] : v])) : cat.headers;
  return hideHeaders(await catalogs.updateCatalog(c, cat, { ...body, headers }));
});
r.delete('/workspaces/:ws/catalogs/:cat', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await catalogs.deleteCatalog(c, await catalogs.getCatalog(c.workspace.id, params.cat));
  return { deleted: true };
});
// the dry run of a sync: what it would create, update, orphan or delete
r.post('/workspaces/:ws/catalogs/:cat/preview', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  const { docs, ...plan } = await catalogs.preview(await catalogs.getCatalog(c.workspace.id, params.cat));
  return plan;
});
r.post('/workspaces/:ws/catalogs/:cat/sync', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  return catalogs.sync(c, await catalogs.getCatalog(c.workspace.id, params.cat), { apis, deployments });
});

// ---------------------------------------------------------------- typed metadata

r.get('/workspaces/:ws/metadata-fields', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return metadata.listFields(c.workspace.id, query.get('scope'));
});
r.put('/workspaces/:ws/metadata-fields', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return metadata.saveFields(c, c.workspace.id, body.fields || body);
});

// ---------------------------------------------------------------- shared policy groups

r.get('/workspaces/:ws/policy-groups', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const groups = await policyGroups.listGroups(c.workspace.id);
  return Promise.all(groups.map(async (g) => ({ ...g, usage: await policyGroups.groupUsage(c.workspace.id, g.id) })));
});
r.post('/workspaces/:ws/policy-groups', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  return policyGroups.createGroup(c, c.workspace.id, body);
});
r.get('/workspaces/:ws/policy-groups/:pg', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const g = await policyGroups.getGroup(c.workspace.id, params.pg);
  return { ...g, versions: await policyGroups.listVersions(g.id), usage: await policyGroups.groupUsage(c.workspace.id, g.id) };
});
r.put('/workspaces/:ws/policy-groups/:pg', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  return policyGroups.updateGroup(c, await policyGroups.getGroup(c.workspace.id, params.pg), body);
});
r.post('/workspaces/:ws/policy-groups/:pg/publish', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  return policyGroups.publishGroup(c, await policyGroups.getGroup(c.workspace.id, params.pg), body);
});
// the apis behind upgraded to the latest version: their drafts, and on demand their snapshots and
// deployments; each api the caller manages, the others reported
r.post('/workspaces/:ws/policy-groups/:pg/upgrade', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return policyGroups.upgradeGroup(c, await policyGroups.getGroup(c.workspace.id, params.pg), { publish: !!body.publish, deploy: !!body.deploy, apis: Array.isArray(body.apis) ? body.apis : null });
});
r.delete('/workspaces/:ws/policy-groups/:pg', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await policyGroups.deleteGroup(c, await policyGroups.getGroup(c.workspace.id, params.pg));
  return { deleted: true };
});

// ---------------------------------------------------------------- shared resources

r.get('/workspaces/:ws/shared-resources', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const list = await sharedResources.listResources(c.workspace.id);
  return Promise.all(list.map(async (x) => ({ ...x, usage: await sharedResources.resourceUsage(c.workspace.id, x.id), versions: (await sharedResources.listVersions(x.id)).map((v) => v.number) })));
});
r.post('/workspaces/:ws/shared-resources', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return sharedResources.createResource(c, c.workspace.id, body);
});
r.get('/workspaces/:ws/shared-resources/:res', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const x = await sharedResources.getResource(c.workspace.id, params.res);
  return { ...x, versions: await sharedResources.listVersions(x.id), usage: await sharedResources.resourceUsage(c.workspace.id, x.id) };
});
r.put('/workspaces/:ws/shared-resources/:res', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return sharedResources.updateResource(c, await sharedResources.getResource(c.workspace.id, params.res), body);
});
r.post('/workspaces/:ws/shared-resources/:res/publish', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return sharedResources.publishResource(c, await sharedResources.getResource(c.workspace.id, params.res), body);
});
r.post('/workspaces/:ws/shared-resources/:res/upgrade', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return sharedResources.upgradeResource(c, await sharedResources.getResource(c.workspace.id, params.res), { publish: !!body.publish, deploy: !!body.deploy, apis: Array.isArray(body.apis) ? body.apis : null });
});
r.delete('/workspaces/:ws/shared-resources/:res', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await sharedResources.deleteResource(c, await sharedResources.getResource(c.workspace.id, params.res));
  return { deleted: true };
});

// ---------------------------------------------------------------- dictionaries

// a dictionary as the console shows it: what the gateway holds of it, and how a plugin reads it
const dictionaryView = (c, d, state) => ({ ...d, gateway: state?.[d.id] || 'unknown', expression: dictionaries.expressionOf(c.workspace.slug, d.name) });

r.get('/workspaces/:ws/dictionaries', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const list = await dictionaries.listDictionaries(c.workspace.id);
  const state = await dictionaries.gatewayState(c.workspace.slug, list);
  return list.map((d) => dictionaryView(c, d, state));
});
r.post('/workspaces/:ws/dictionaries', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return dictionaries.createDictionary(c, c.workspace.id, body);
});
r.get('/workspaces/:ws/dictionaries/:d', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const d = await dictionaries.getDictionary(c.workspace.id, params.d);
  return dictionaryView(c, d, await dictionaries.gatewayState(c.workspace.slug, [d]));
});
r.put('/workspaces/:ws/dictionaries/:d', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return dictionaries.updateDictionary(c, await dictionaries.getDictionary(c.workspace.id, params.d), body);
});
r.post('/workspaces/:ws/dictionaries/:d/refresh', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  const d = await dictionaries.getDictionary(c.workspace.id, params.d);
  if (d.source?.kind !== 'url') throw badRequest('a static dictionary is not refreshed: its values are the ones given');
  await dictionaries.refresh(await db`select * from dictionaries where id = ${d.id}`.then((r) => r[0]));
  await audit(c, { action: 'dictionary.refresh', entityKind: 'dictionary', entityId: d.id, summary: `dictionary ${d.name} refreshed from its source` });
  return dictionaries.getDictionary(c.workspace.id, d.id);
});
r.delete('/workspaces/:ws/dictionaries/:d', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  await dictionaries.deleteDictionary(c, await dictionaries.getDictionary(c.workspace.id, params.d));
  return { deleted: true };
});

// declarative api documents: the unit is the api-version
r.get('/workspaces/:ws/apis/:api/document', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  return apiDocument(await apiOf(c, params));
});

r.post('/workspaces/:ws/apply', async ({ ctx, params, body, query }) => {
  const c = await ws(ctx, params);
  const docs = Array.isArray(body) ? body : body.items || [body];
  const results = [];
  for (const doc of docs) {
    // an api that exists is changed by who can manage it, as from the console
    const res = await applyApiDocument(c, c.workspace, doc, { managedBy: query.get('managed_by') || null, checkManage: true });
    const api = await apis.getApi(c.workspace.id, res.api.id);
    if (query.get('publish') === 'true' || query.get('deploy') === 'true') await apis.requireManageApi(c, api);
    if (query.get('publish') === 'true') {
      const pending = await apis.pendingChanges(api);
      if (pending.hasChanges) {
        const pub = await apis.publish(c, api, { comment: query.get('comment') || 'apply' });
        res.snapshot = pub.snapshot.number;
        if (query.get('deploy') === 'true') {
          const dep = await deployments.deploy(c, await apis.getApi(c.workspace.id, api.id), { snapshot: pub.snapshot.id });
          res.deployment = dep.deployment.status;
        }
      } else res.snapshot = 'unchanged';
    }
    results.push(res);
  }
  return results;
});

r.get('/meta/auth-kinds', async () => AUTH_KINDS);

export const adminRouter = r;
