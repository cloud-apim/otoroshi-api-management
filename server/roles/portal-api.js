// The developer portal API (/front/api). One portal per workspace (D-20): the workspace is resolved
// from the URL by the server, never from a session. The catalogue is served from the snapshots that
// run on the gateway, so it stays readable during a gateway incident (D-4).

import { Router, badRequest, forbidden, notFound, unauthorized } from '../http/router.js';
import { db } from '../db/index.js';
import * as identity from '../domain/identity.js';
import * as applications from '../domain/applications.js';
import * as subscriptions from '../domain/subscriptions.js';
import * as analytics from '../domain/analytics.js';
import { audit } from '../domain/audit.js';
import { normalizeDraft } from '../domain/model.js';
import { gatewaySettings, oto } from '../otoroshi/client.js';
import YAML from 'yaml';
import { listFields } from '../domain/metadata.js';

const r = new Router();

export async function gatewayBaseUrl(draft) {
  const gw = await gatewaySettings();
  const scheme = gw.publicScheme || 'http';
  const port = gw.publicPort ? String(gw.publicPort) : '';
  const defaultPort = (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const cp = !draft.entrypoint.contextPath || draft.entrypoint.contextPath === '/' ? '' : draft.entrypoint.contextPath.replace(/\/$/, '');
  return `${scheme}://${draft.entrypoint.domain}${port && !defaultPort ? `:${port}` : ''}${cp}`;
}

// the catalogue: what is deployed, filtered by the visibility ACL (D-2: visibility is never projected)
async function catalogue(ctx) {
  const rows = await db`select a.id, a.slug, a.team_id, a.lifecycle, a.previous_version_id, s.content, s.number, s.published_at
    from apis a
    join lateral (select d.snapshot_id, d.action from api_deployments d where d.api_id = a.id and d.status = 'deployed' order by d.finished_at desc limit 1) dep on true
    join api_snapshots s on s.id = dep.snapshot_id
    where a.workspace_id = ${ctx.workspace.id} and dep.action = 'deploy' and a.lifecycle in ('published', 'deprecated')
    order by a.slug, a.created_at`;
  const tags = await identity.userAclTags(ctx.user, ctx.workspace.id);
  const privileged = ctx.user?.is_admin || ['admin', 'producer'].includes(ctx.role);
  return rows.filter((row) => identity.aclAllows(row.content.api.visibility, row.content.api.acl, tags, privileged)).map((row) => ({ row, tags, privileged }));
}

function publicPlan(p, draft) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    auth_kind: p.auth.kind,
    validation: p.validation,
    subscribable: p.subscribable && p.status === 'published',
    rate_limit: p.rateLimit.enabled ? { calls: p.rateLimit.calls, window_ms: p.rateLimit.windowMs } : null,
    // what really applies, never a theoretical total (D-9 n°3, D-31)
    quota: { daily: p.quota.daily, monthly: p.quota.monthly },
    resources:
      p.resourceFilter.mode === 'only'
        ? p.resourceFilter.resources.map((rid) => draft.resources.find((r) => r.id === rid)).filter(Boolean).map((r) => ({ name: r.name, path: r.path, methods: r.methods }))
        : null,
    terms: p.terms.enabled ? { url: p.terms.url, page: p.terms.pageSlug } : null,
    usage_statement: p.usageStatement.enabled ? { required: p.usageStatement.required, prompt: p.usageStatement.prompt } : null,
    pricing: p.pricing.kind === 'paid' ? { amount: p.pricing.amount, currency: p.pricing.currency, interval: p.pricing.interval } : null,
  };
}

async function apiView(entry, { full = false } = {}) {
  const { row, tags, privileged } = entry;
  const c = row.content;
  const draft = normalizeDraft(c.draft);
  const base = {
    id: row.id,
    slug: row.slug,
    name: c.api.name,
    version: c.api.version,
    description: c.api.description,
    tags: c.api.tags,
    lifecycle: row.lifecycle,
    snapshot: row.number,
    published_at: row.published_at,
    plans_count: draft.plans.filter((p) => p.status === 'published').length,
    has_openapi: !!draft.openapi.content?.trim(),
  };
  if (!full) return base;
  return {
    ...base,
    base_url: await gatewayBaseUrl(draft),
    resources: draft.resources.filter((r) => r.enabled).map((r) => ({ name: r.name, description: r.description, path: r.path, methods: r.methods })),
    plans: draft.plans
      .filter((p) => ['published', 'deprecated'].includes(p.status) && identity.aclAllows(p.visibility, p.acl, tags, privileged))
      .map((p) => publicPlan(p, draft)),
    languages: draft.documentation.languages,
    default_language: draft.documentation.defaultLanguage,
    pages: (c.docs?.pages || []).map((p) => ({ id: p.id, slug: p.slug, parent_id: p.parent_id, position: p.position, title: p.title })),
  };
}

async function findEntry(ctx, idOrSlug) {
  const list = await catalogue(ctx);
  const matching = list.filter((e) => e.row.id === idOrSlug || e.row.slug === idOrSlug);
  if (!matching.length) throw notFound('api not found');
  // by slug: the most recent version
  return matching[matching.length - 1];
}

function requireUser(ctx) {
  if (!ctx.user) throw unauthorized('please sign in');
}

async function myApplicationIds(ctx) {
  const apps = await applications.listApplications(ctx.workspace.id, { userId: ctx.user.id });
  return apps.map((a) => a.id);
}

// ---------------------------------------------------------------- portal & auth

function publicPortal(portal = {}) {
  const { oidc, ...rest } = portal;
  return { ...rest, sso: oidc?.enabled ? { label: oidc.label || 'single sign-on' } : null };
}

r.get('/portal', async ({ ctx }) => ({
  workspace: { slug: ctx.workspace.slug, name: ctx.workspace.name, description: ctx.workspace.description },
  portal: publicPortal(ctx.workspace.portal),
  user: ctx.user ? { ...identity.publicUser(ctx.user), role: ctx.role } : null,
}));

r.get('/me', async ({ ctx }) => {
  requireUser(ctx);
  const teams = await identity.listTeams(ctx.workspace.id, ctx.user.id);
  return { user: identity.publicUser(ctx.user), role: ctx.role, teams };
});

// the typed fields the portal asks: the request form of a subscription, the application fields
r.get('/metadata-fields', async ({ ctx }) => {
  const fields = await listFields(ctx.workspace.id);
  return fields.filter((f) => f.portal && ['subscription', 'application'].includes(f.scope)).map(({ workspace_id, ...f }) => f);
});

// ---------------------------------------------------------------- catalogue

r.get('/apis', async ({ ctx, query }) => {
  const list = await catalogue(ctx);
  const q = (query.get('q') || '').toLowerCase();
  const tag = query.get('tag');
  const views = await Promise.all(list.map((e) => apiView(e)));
  return views.filter(
    (a) =>
      (!q || a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q) || (a.tags || []).some((t) => t.toLowerCase().includes(q))) &&
      (!tag || (a.tags || []).includes(tag))
  );
});

r.get('/apis/:api', async ({ ctx, params }) => {
  const entry = await findEntry(ctx, params.api);
  const view = await apiView(entry, { full: true });
  const versions = (await catalogue(ctx)).filter((e) => e.row.slug === entry.row.slug).map((e) => ({ id: e.row.id, version: e.row.content.api.version, lifecycle: e.row.lifecycle }));
  return { ...view, versions };
});

r.get('/apis/:api/pages/:page', async ({ ctx, params }) => {
  const entry = await findEntry(ctx, params.api);
  const page = (entry.row.content.docs?.pages || []).find((p) => p.slug === params.page || p.id === params.page);
  if (!page) throw notFound('page not found');
  return page;
});

// the OpenAPI document of the deployed snapshot, its servers pointing at the gateway
r.get('/apis/:api/openapi', async ({ ctx, params }) => {
  const entry = await findEntry(ctx, params.api);
  const draft = normalizeDraft(entry.row.content.draft);
  const raw = draft.openapi.content || '';
  if (!raw.trim()) throw notFound('this api has no openapi specification');
  let spec;
  try {
    spec = raw.trim().startsWith('{') ? JSON.parse(raw) : YAML.parse(raw);
  } catch (e) {
    throw badRequest('the openapi specification of this api cannot be parsed');
  }
  spec.servers = [{ url: await gatewayBaseUrl(draft), description: 'Otoroshi gateway' }];
  return spec;
});

// ---------------------------------------------------------------- teams (an individual gets an implicit one, Q-1)

r.get('/teams', async ({ ctx }) => {
  requireUser(ctx);
  await identity.personalTeam(ctx, ctx.workspace.id, ctx.user);
  const teams = await identity.listTeams(ctx.workspace.id, ctx.user.id);
  return Promise.all(teams.map(async (t) => ({ ...t, members: await identity.teamMembers(t.id) })));
});

r.post('/teams', async ({ ctx, body }) => {
  requireUser(ctx);
  return identity.createTeam(ctx, ctx.workspace.id, { name: body.name, description: body.description, ownerId: ctx.user.id });
});

r.post('/teams/:team/members', async ({ ctx, params, body }) => {
  requireUser(ctx);
  const team = await identity.findTeam(ctx.workspace.id, params.team);
  if (!team || !(await identity.isTeamMember(team.id, ctx.user.id))) throw notFound('team not found');
  if (team.personal) throw badRequest('a personal team cannot have other members: create a team');
  // D-19: an invitation must not reveal whether an email exists elsewhere
  const user = await identity.findUserByEmail(body.email || '');
  if (!user || !(await identity.membership(ctx.workspace.id, user.id))) return { invited: true };
  await identity.setTeamMember(ctx, team, user.id, 'member');
  return { invited: true };
});

// ---------------------------------------------------------------- applications

r.get('/applications', async ({ ctx }) => {
  requireUser(ctx);
  return applications.listApplications(ctx.workspace.id, { userId: ctx.user.id });
});

r.post('/applications', async ({ ctx, body }) => {
  requireUser(ctx);
  const teamId = body.team_id || (await identity.personalTeam(ctx, ctx.workspace.id, ctx.user)).id;
  return applications.createApplication(ctx, ctx.workspace.id, { ...body, team_id: teamId });
});

r.get('/applications/:app', async ({ ctx, params }) => {
  requireUser(ctx);
  const app = await applications.getApplication(ctx.workspace.id, params.app);
  await applications.requireSeeApplication(ctx, app);
  const subs = await subscriptions.listSubscriptions(ctx.workspace.id, { applicationId: app.id });
  const withCreds = await Promise.all(subs.map(async (s) => ({ ...s, credentials: await subscriptions.credentialsOf(s.id) })));
  await audit(ctx, { action: 'credential.read', entityKind: 'application', entityId: app.id, summary: `credentials of ${app.name} read from the portal`, via: 'portal' });
  return { ...app, subscriptions: withCreds };
});

r.put('/applications/:app', async ({ ctx, params, body }) => {
  requireUser(ctx);
  const app = await applications.getApplication(ctx.workspace.id, params.app);
  await applications.requireSeeApplication(ctx, app);
  return applications.updateApplication(ctx, app, { name: body.name, description: body.description, client_id: body.client_id, certificates: body.certificates, metadata: body.metadata });
});

r.delete('/applications/:app', async ({ ctx, params }) => {
  requireUser(ctx);
  const app = await applications.getApplication(ctx.workspace.id, params.app);
  await applications.requireSeeApplication(ctx, app);
  await applications.deleteApplication(ctx, app);
  return { deleted: true };
});

// ---------------------------------------------------------------- subscriptions

r.post('/subscriptions', async ({ ctx, body }) => {
  requireUser(ctx);
  const entry = await findEntry(ctx, body.api_id);
  return subscriptions.requestSubscription(ctx, ctx.workspace.id, { ...body, api_id: entry.row.id });
});

const mySub = async (ctx, id) => {
  requireUser(ctx);
  const sub = await subscriptions.getSubscription(ctx.workspace.id, id);
  const app = await applications.getApplication(ctx.workspace.id, sub.application_id);
  await applications.requireSeeApplication(ctx, app);
  return sub;
};

r.post('/subscriptions/:sub/close', async ({ ctx, params }) => subscriptions.closeSubscription(ctx, await mySub(ctx, params.sub)));

// test payment connector: stands for the provider's hosted checkout + webhook (D-36)
r.post('/subscriptions/:sub/pay', async ({ ctx, params }) => subscriptions.confirmPayment(ctx, await mySub(ctx, params.sub), {}));

r.post('/subscriptions/:sub/credentials/:cred/rotate', async ({ ctx, params }) =>
  subscriptions.rotateCredential(ctx, await mySub(ctx, params.sub), params.cred)
);

// live consumption as the gateway counts it, read-only and never on the request path
r.get('/subscriptions/:sub/quotas', async ({ ctx, params }) => {
  const sub = await mySub(ctx, params.sub);
  const creds = await subscriptions.credentialsOf(sub.id);
  const out = [];
  for (const c of creds.filter((c) => c.status === 'active')) {
    try {
      out.push({ client_id: c.client_id, quotas: await oto.apikeyQuotas(c.client_id) });
    } catch (e) {
      out.push({ client_id: c.client_id, error: 'the gateway is unreachable' });
    }
  }
  return out;
});

r.get('/analytics', async ({ ctx, query }) => {
  requireUser(ctx);
  const ids = await myApplicationIds(ctx);
  if (!ids.length) return analytics.overview({ workspaceId: ctx.workspace.id, applicationIds: ['__none__'] });
  const app = query.get('application');
  if (app && !ids.includes(app)) throw forbidden();
  return analytics.overview({
    workspaceId: ctx.workspace.id,
    applicationIds: ids,
    applicationId: app,
    subscriptionId: query.get('subscription'),
    apiId: query.get('api'),
    from: query.get('from'),
    to: query.get('to'),
  });
});

export const portalRouter = r;

// ---------------------------------------------------------------- try-it proxy (D-17, D-42)
// Scalar sends its requests through `proxyUrl?scalar_url=<target>`. The proxy only talks to the hosts
// of the workspace's deployed apis and never forwards the portal cookies.
export async function tryItProxy(req, ctx) {
  const url = new URL(req.url);
  const target = url.searchParams.get('scalar_url');
  if (!target) return new Response('missing scalar_url', { status: 400 });
  let t;
  try {
    t = new URL(target);
  } catch (e) {
    return new Response('invalid target', { status: 400 });
  }
  const list = await catalogue(ctx);
  const hosts = new Set(list.map((e) => normalizeDraft(e.row.content.draft).entrypoint.domain));
  if (!hosts.has(t.hostname)) return new Response(`host ${t.hostname} is not an api of this portal`, { status: 403 });
  const gw = await gatewaySettings();
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (['cookie', 'host', 'origin', 'referer', 'connection', 'content-length'].includes(lk) || lk.startsWith('sec-')) continue;
    headers.set(k, v);
  }
  headers.set('Host', t.host);
  // the gateway is reached at its own address, with the api host header
  const upstream = `${gw.url}${t.pathname}${t.search}`;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();
  try {
    const res = await fetch(upstream, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const out = new Headers();
    for (const [k, v] of res.headers) {
      if (['set-cookie', 'content-encoding', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) continue;
      out.set(k, v);
    }
    return new Response(await res.arrayBuffer(), { status: res.status, headers: out });
  } catch (e) {
    return new Response(JSON.stringify({ error: `gateway unreachable: ${e.message}` }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
