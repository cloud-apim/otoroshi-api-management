// The product's admin API. It is the only way to do anything in the product (D-9 n°1, PX-02): the
// same router is served on /api (bearer token, CLI, CI) and on /backoffice/api (console session),
// so every action of the console replays from the CLI by construction.

import { Router, badRequest, notFound, forbidden } from '../http/router.js';
import { db } from '../db/index.js';
import { config } from '../config.js';
import * as identity from '../domain/identity.js';
import * as apis from '../domain/apis.js';
import * as deployments from '../domain/deployments.js';
import * as applications from '../domain/applications.js';
import * as subscriptions from '../domain/subscriptions.js';
import * as analytics from '../domain/analytics.js';
import { listAudit, audit } from '../domain/audit.js';
import { validateDraft, resolutionOrder, normalizeDraft, AUTH_KINDS } from '../domain/model.js';
import { listTasks, queueStats, enqueue } from '../domain/tasks.js';
import { oto, gatewaySettings, invalidateGatewaySettings, META } from '../otoroshi/client.js';
import { runDriftDetection, driftReports, unmanagedApis, draftFromOtoroshi } from '../otoroshi/drift.js';
import { buildOtoroshiApi } from '../otoroshi/projection.js';
import { exportWorkspace, importWorkspace } from '../domain/exchange.js';
import { gatewayBaseUrl } from './portal-api.js';

const r = new Router();

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

r.get('/me', async ({ ctx }) => {
  identity.requireUser(ctx);
  const workspaces = await identity.listWorkspacesFor(ctx.user);
  return { user: identity.publicUser(ctx.user), workspaces };
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
    portal: { exposure: config.portal.exposure, domain: config.portal.domain, ...(rows.find((x) => x.key === 'portal')?.value || {}) },
    ingest: { storeRaw: config.ingest.storeRaw, url: `${config.publicUrl}/ingest`, ...(rows.find((x) => x.key === 'ingest')?.value || {}) },
    drift: rows.find((x) => x.key === 'drift.last_run')?.value || null,
  };
});

r.put('/settings/:key', async ({ ctx, params, body }) => {
  identity.requireAdmin(ctx);
  if (!['gateway', 'portal', 'ingest'].includes(params.key)) throw badRequest('unknown settings key');
  const current = (await db`select value from settings where key = ${params.key}`)[0]?.value || {};
  const value = { ...current, ...body };
  if (params.key === 'gateway' && (!body.clientSecret || body.clientSecret.includes('••'))) value.clientSecret = current.clientSecret || config.otoroshi.clientSecret;
  await db`insert into settings (key, value) values (${params.key}, ${value}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  invalidateGatewaySettings();
  await audit(ctx, { action: `settings.${params.key}.update`, entityKind: 'settings', entityId: params.key, summary: `${params.key} settings updated` });
  return { updated: params.key };
});

// ---------------------------------------------------------------- gateway (the single cluster, D-37)

r.get('/gateway/status', async ({ ctx }) => {
  identity.requireUser(ctx);
  const [health, queue, lastDrift] = await Promise.all([
    oto.health(),
    queueStats(),
    db`select value from settings where key = 'drift.last_run'`.then((x) => x[0]?.value || null),
  ]);
  const ingest = await analytics.ingestStats().catch(() => null);
  return { health, queue, drift: lastDrift, ingest };
});

r.get('/gateway/tasks', async ({ ctx, query }) => {
  identity.requireUser(ctx);
  return listTasks({ status: query.get('status') });
});

r.post('/gateway/tasks/:id/retry', async ({ ctx, params }) => {
  identity.requireAdmin(ctx);
  await db`update tasks set status = 'pending', run_after = now(), attempts = 0 where id = ${params.id}`;
  return { retried: params.id };
});

// infrastructure the product references but does not own (D-15)
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

r.get('/gateway/plugins', async ({ ctx }) => {
  identity.requireUser(ctx);
  const all = (await oto.pluginsCatalog().catch(() => null)) || [];
  const list = Array.isArray(all) ? all : all.plugins || [];
  return list
    .filter((p) => (p.plugin_type || p.pluginType) === 'ng' || String(p.id || '').startsWith('cp:otoroshi.next'))
    .map((p) => ({ id: p.id, name: p.name, description: p.description, steps: p.plugin_steps || p.steps || [], categories: p.plugin_categories || [] }));
});

// installs the data exporter that feeds the ingester. An exporter is infrastructure (D-15): this is a
// helper, the product marks what it created and never touches other exporters.
r.post('/gateway/exporter', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  const url = body.url || `${config.publicUrl.replace('localhost', 'host.docker.internal')}/ingest`;
  const entity = {
    _loc: { tenant: 'default', teams: ['default'] },
    type: 'webhook',
    enabled: true,
    id: 'apim_ingester_exporter',
    name: 'otoroshi-api-management ingester',
    desc: 'Exports GatewayEvent, LLMUsageAudit and McpAudit to the otoroshi-api-management ingester',
    metadata: { [META.managedBy]: 'otoroshi-api-management' },
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
  const existing = ((await oto.listDataExporters()) || []).find((e) => e.id === entity.id);
  const res = existing ? await oto.updateDataExporter(entity) : await oto.createDataExporter(entity);
  await audit(ctx, { action: 'gateway.exporter.install', entityKind: 'gateway', entityId: entity.id, summary: `data exporter installed towards ${url}` });
  return { installed: true, id: res?.id || entity.id, url };
});

r.post('/gateway/drift', async ({ ctx }) => {
  identity.requireUser(ctx);
  return runDriftDetection();
});

r.get('/gateway/unmanaged-apis', async ({ ctx }) => {
  identity.requireUser(ctx);
  return unmanagedApis();
});

// ---------------------------------------------------------------- users (an admin only sees members of its workspaces, D-19)

r.get('/users', async ({ ctx, query }) => {
  identity.requireUser(ctx);
  const q = query.get('q') ? `%${query.get('q').toLowerCase()}%` : null;
  if (ctx.user.is_admin) {
    return db`select id, email, name, tags, is_admin, created_at from users where (${q}::text is null or lower(email) like ${q} or lower(name) like ${q}) order by email limit 200`;
  }
  return db`select distinct u.id, u.email, u.name, u.tags, u.is_admin, u.created_at from users u
    join workspace_members m on m.user_id = u.id
    where m.workspace_id in (select workspace_id from workspace_members where user_id = ${ctx.user.id} and role = 'admin')
      and (${q}::text is null or lower(u.email) like ${q} or lower(u.name) like ${q}) order by u.email limit 200`;
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

// ---------------------------------------------------------------- workspaces

r.get('/workspaces', async ({ ctx }) => {
  identity.requireUser(ctx);
  return identity.listWorkspacesFor(ctx.user);
});

r.post('/workspaces', async ({ ctx, body }) => {
  identity.requireAdmin(ctx);
  return identity.createWorkspace(ctx, body);
});

r.get('/workspaces/:ws', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return { ...c.workspace, role: c.role };
});

r.put('/workspaces/:ws', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return identity.updateWorkspace(c, c.workspace, body);
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
  await identity.removeTeamMember(c, t, params.user);
  return identity.teamMembers(t.id);
});

// ---------------------------------------------------------------- apis

r.get('/workspaces/:ws/apis', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  return apis.listApis(c.workspace.id, { q: query.get('q'), teamId: query.get('team'), lifecycle: query.get('lifecycle') });
});

r.post('/workspaces/:ws/apis', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params);
  if (body.team_id && c.role === 'producer' && !(await identity.isTeamMember(body.team_id, ctx.user.id)))
    throw forbidden('you are not a member of this team');
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
    validation: validateDraft(draft),
    resolution_order: resolutionOrder(draft),
    versions,
    can_manage: await apis.canManageApi(c, api),
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
  return { draft: normalizeDraft(updated.draft), validation: validateDraft(updated.draft), resolution_order: resolutionOrder(updated.draft) };
});

r.post('/workspaces/:ws/apis/:api/validate', async ({ ctx, params, body }) => {
  await ws(ctx, params);
  return validateDraft(body.draft || body);
});

r.delete('/workspaces/:ws/apis/:api', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params, { manage: true });
  const status = await deployments.deploymentStatus(api);
  let task = null;
  if (status.deployed) task = await deployments.purgeFromGateway(api);
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

// snapshots & publication (D-35)
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

// deployments (D-22 rules 1-2, D-37, D-38)
r.get('/workspaces/:ws/apis/:api/deployments', async ({ ctx, params }) => {
  const c = await ws(ctx, params);
  const api = await apiOf(c, params);
  return { status: await deployments.deploymentStatus(api), history: await deployments.listDeployments(api.id) };
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

// the escape hatch (D-9 n°2, D-14): the projected entity, as computed and as the gateway holds it
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
  return {
    otoroshi: { kind: 'apis.otoroshi.io/Api', id: api.id, backoffice_url: `${gw.backofficeUrl}/bo/dashboard/apis/${api.id}` },
    expected,
    actual,
    error,
    drift: report,
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
    draft: draftFromOtoroshi(entity),
    metadata: { adopted_from: { otoroshi_api_id: entity.id, at: new Date().toISOString(), created_by: entity.metadata?.created_by || null } },
  });
  await audit(c, { action: 'api.adopt', entityKind: 'api', entityId: created.id, summary: `otoroshi api ${entity.id} adopted as a draft (nothing written to the gateway)` });
  return created;
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
  return { ...app, subscriptions: subs, can_see_credentials: await applications.canSeeApplication(c, app) };
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
  return {
    ...sub,
    credentials: creds.map((cr) => ({ ...cr, client_secret: canSee ? cr.client_secret : mask(cr.client_secret) })),
    drift,
  };
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
r.post('/workspaces/:ws/subscriptions/:sub/resume', subAction((c, s) => subscriptions.resumeSubscription(c, s)));
r.post('/workspaces/:ws/subscriptions/:sub/close', subAction((c, s) => subscriptions.closeSubscription(c, s)));
r.post('/workspaces/:ws/subscriptions/:sub/transfer', subAction((c, s, b) => subscriptions.transferSubscription(c, s, b)));
r.post('/workspaces/:ws/subscriptions/:sub/resync', subAction((c, s) => subscriptions.resync(c, s)));
r.post('/workspaces/:ws/subscriptions/:sub/payment', subAction((c, s, b) => subscriptions.confirmPayment(c, s, b)));
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
    applicationId: query.get('application'),
    subscriptionId: query.get('subscription'),
    from: query.get('from'),
    to: query.get('to'),
  });
});

r.get('/workspaces/:ws/analytics/calls', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params);
  const rows = await analytics.recentCalls({
    workspaceId: c.workspace.id,
    apiId: query.get('api'),
    applicationId: query.get('application'),
    subscriptionId: query.get('subscription'),
    from: query.get('from'),
    to: query.get('to'),
  }, parseInt(query.get('limit') || '100', 10));
  // reading request logs is a processing of personal data: it is traced (spec §8)
  await audit(c, { action: 'analytics.calls.read', entityKind: 'workspace', entityId: c.workspace.id, summary: 'request log consulted', data: { filter: Object.fromEntries(query) } });
  return rows;
});

r.get('/workspaces/:ws/audit', async ({ ctx, params, query }) => {
  const c = await ws(ctx, params, ['admin', 'producer']);
  return listAudit(c.workspace.id, { limit: query.get('limit'), before: query.get('before'), entityId: query.get('entity'), action: query.get('action') });
});

r.get('/audit', async ({ ctx, query }) => {
  identity.requireAdmin(ctx);
  return listAudit(null, { limit: query.get('limit'), before: query.get('before'), action: query.get('action') });
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
    join subscriptions s on s.id = c.subscription_id where s.workspace_id = ${wsId} and lower(c.client_id) like ${q} limit 5`;
  return [...a, ...plans, ...apps, ...subs, ...teams, ...creds];
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

// ---------------------------------------------------------------- export / import (PX-07, D-28)

r.get('/workspaces/:ws/export', async ({ ctx, params }) => {
  const c = await ws(ctx, params, ['admin']);
  await audit(c, { action: 'workspace.export', entityKind: 'workspace', entityId: c.workspace.id, summary: 'workspace exported' });
  return exportWorkspace(c.workspace);
});

r.post('/workspaces/:ws/import', async ({ ctx, params, body }) => {
  const c = await ws(ctx, params, ['admin']);
  return importWorkspace(c, c.workspace, body);
});

r.get('/meta/auth-kinds', async () => AUTH_KINDS);

export const adminRouter = r;
