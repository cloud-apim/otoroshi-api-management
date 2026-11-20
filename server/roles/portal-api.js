// The developer portal API (/front/api). One portal per workspace: the workspace is resolved
// from the URL by the server, never from a session. The catalogue is served from the snapshots that
// run on the gateway, so it stays readable during a gateway incident.

import { readCertificate } from '../domain/pki.js';
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
import * as notifications from '../domain/notifications.js';
import { resolveLocal } from '../otoroshi/vault-refs.js';
import * as billing from '../payments/billing.js';
import * as discovery from '../domain/discovery.js';
import { usageOf } from '../payments/usage.js';
import { portalUrl } from '../portal-exposure.js';

const r = new Router();

export async function gatewayBaseUrl(draft) {
  const gw = await gatewaySettings();
  const scheme = gw.publicScheme || 'http';
  const port = gw.publicPort ? String(gw.publicPort) : '';
  const defaultPort = (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
  const cp = !draft.entrypoint.contextPath || draft.entrypoint.contextPath === '/' ? '' : draft.entrypoint.contextPath.replace(/\/$/, '');
  // a domain that differs between environments is a vault reference the gateway resolves
  return `${scheme}://${await resolveLocal(draft.entrypoint.domain)}${port && !defaultPort ? `:${port}` : ''}${cp}`;
}

// the catalogue: what is deployed, filtered by the visibility ACL (visibility is never projected)
async function catalogue(ctx) {
  const rows = await db`select a.id, a.slug, a.team_id, a.lifecycle, a.previous_version_id, a.categories, a.featured, s.content, s.number, s.published_at
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
    // what really applies, never a theoretical total
    quota: { daily: p.quota.daily, monthly: p.quota.monthly },
    resources:
      p.resourceFilter.mode === 'only'
        ? p.resourceFilter.resources.map((rid) => draft.resources.find((r) => r.id === rid)).filter(Boolean).map((r) => ({ name: r.name, path: r.path, methods: r.methods }))
        : null,
    terms: p.terms.enabled ? { url: p.terms.url, page: p.terms.pageSlug } : null,
    usage_statement: p.usageStatement.enabled ? { required: p.usageStatement.required, prompt: p.usageStatement.prompt } : null,
    pricing:
      p.pricing.kind === 'paid'
        ? {
            amount: p.pricing.amount,
            currency: p.pricing.currency,
            interval: p.pricing.interval,
            usage: p.pricing.usage.enabled ? { unit_amount: Number(p.pricing.usage.unitAmount) || 0, counts: p.pricing.usage.counts } : null,
          }
        : null,
  };
}

// what the portal shows of the discovery axes: the workspace may keep its reviews or its usage off
function discoveryOf(portal = {}) {
  return { reviews: portal.discovery?.reviews !== false, usage: portal.discovery?.usage !== false, categories: portal.categories || [] };
}

// the signals of the catalogue, once per listing: the rating of each api, its subscribed
// applications and its calls of the last thirty days, across its versions
async function signals(ctx) {
  const d = discoveryOf(ctx.workspace.portal);
  const [rated, subscribed, calls, ids] = await Promise.all([
    d.reviews ? discovery.ratings(ctx.workspace.id) : new Map(),
    d.usage ? discovery.subscribers(ctx.workspace.id) : new Map(),
    d.usage ? analytics.callsByApi(ctx.workspace.id, 30).catch(() => new Map()) : new Map(),
    db`select id, slug from apis where workspace_id = ${ctx.workspace.id}`,
  ]);
  const callsBySlug = new Map();
  for (const { id, slug } of ids) if (calls.has(id)) callsBySlug.set(slug, (callsBySlug.get(slug) || 0) + calls.get(id));
  return { d, rated, subscribed, callsBySlug };
}

function placementOf(row, sig) {
  const known = new Set(sig.d.categories.map((c) => c.slug));
  return {
    categories: (row.categories || []).filter((c) => known.has(c)),
    featured: !!row.featured,
    rating: sig.d.reviews ? sig.rated.get(row.slug) || null : undefined,
    usage: sig.d.usage ? { applications: sig.subscribed.get(row.slug) || 0, calls_30d: sig.callsBySlug.get(row.slug) || 0 } : undefined,
  };
}

async function apiView(entry, { full = false, sig = null } = {}) {
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
    ...(sig ? placementOf(row, sig) : {}),
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

// the order of the catalogue: the featured apis first, then by name, unless asked otherwise
const SORTS = {
  featured: (a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  popular: (a, b) => (b.usage?.applications || 0) - (a.usage?.applications || 0) || (b.usage?.calls_30d || 0) - (a.usage?.calls_30d || 0) || a.name.localeCompare(b.name),
  rating: (a, b) => (b.rating?.average || 0) - (a.rating?.average || 0) || (b.rating?.count || 0) - (a.rating?.count || 0) || a.name.localeCompare(b.name),
  recent: (a, b) => String(b.published_at).localeCompare(String(a.published_at)),
};

r.get('/apis', async ({ ctx, query }) => {
  const list = await catalogue(ctx);
  const q = (query.get('q') || '').toLowerCase();
  const tag = query.get('tag');
  const category = query.get('category');
  const sig = await signals(ctx);
  const views = await Promise.all(list.map((e) => apiView(e, { sig })));
  const sort = SORTS[query.get('sort')] || SORTS.featured;
  return views
    .filter(
      (a) =>
        (!q || a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q) || (a.tags || []).some((t) => t.toLowerCase().includes(q))) &&
        (!tag || (a.tags || []).includes(tag)) &&
        (!category || a.categories.includes(category)) &&
        (query.get('featured') !== 'true' || a.featured)
    )
    .sort(sort);
});

r.get('/apis/:api', async ({ ctx, params }) => {
  const entry = await findEntry(ctx, params.api);
  const view = await apiView(entry, { full: true, sig: await signals(ctx) });
  const versions = (await catalogue(ctx)).filter((e) => e.row.slug === entry.row.slug).map((e) => ({ id: e.row.id, version: e.row.content.api.version, lifecycle: e.row.lifecycle }));
  return { ...view, versions };
});

// the reviews of an api, across its versions: from the consumers who subscribed to it
r.get('/apis/:api/reviews', async ({ ctx, params }) => {
  const entry = await findEntry(ctx, params.api);
  if (!discoveryOf(ctx.workspace.portal).reviews) throw notFound('this portal has no reviews');
  const list = await discovery.listReviews(ctx.workspace.id, entry.row.slug);
  return {
    rating: list.length ? { average: Math.round((list.reduce((s, r) => s + r.rating, 0) / list.length) * 10) / 10, count: list.length } : null,
    reviews: list.map(({ user_id, hidden, hidden_by, ...r }) => ({ ...r, mine: user_id === ctx.user?.id })),
    can_review: await discovery.canReview(ctx.user, ctx.workspace.id, entry.row.slug),
  };
});

r.put('/apis/:api/reviews/mine', async ({ ctx, params, body }) => {
  requireUser(ctx);
  const entry = await findEntry(ctx, params.api);
  if (!discoveryOf(ctx.workspace.portal).reviews) throw notFound('this portal has no reviews');
  const saved = await discovery.saveReview(ctx, ctx.workspace.id, entry.row.slug, body || {});
  return { id: saved.id, rating: saved.rating, comment: saved.comment, updated_at: saved.updated_at };
});

r.delete('/apis/:api/reviews/mine', async ({ ctx, params }) => {
  requireUser(ctx);
  const entry = await findEntry(ctx, params.api);
  await discovery.deleteReview(ctx, ctx.workspace.id, entry.row.slug);
  return { deleted: true };
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

// ---------------------------------------------------------------- teams (an individual gets an implicit one)

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
  // an invitation must not reveal whether an email exists elsewhere
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

// reads a client certificate a consumer pastes for its application
r.post('/certificates/inspect', async ({ ctx, body }) => {
  requireUser(ctx);
  try {
    return readCertificate(body.pem);
  } catch (e) {
    throw badRequest(`not a readable PEM certificate: ${e.message}`);
  }
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

// the consumer's own subscriptions to an api, the ones it can call with: what the composer offers
r.get('/apis/:api/my-subscriptions', async ({ ctx, params }) => {
  if (!ctx.user) return [];
  const entry = await findEntry(ctx, params.api);
  const apps = await applications.listApplications(ctx.workspace.id, { userId: ctx.user.id });
  const ids = new Set(apps.map((a) => a.id));
  const subs = await db`select s.id, s.plan_id, s.auth_kind, s.status, s.request->>'plan_name' as plan_name, s.application_id
    from subscriptions s where s.api_id = ${entry.row.id} and s.status = 'active'`;
  return subs
    .filter((s) => ids.has(s.application_id) && ['apikey', 'oauth2-local'].includes(s.auth_kind))
    .map((s) => ({ id: s.id, plan_name: s.plan_name || s.plan_id, application_name: apps.find((a) => a.id === s.application_id)?.name }));
});

// the composer of the portal, for the apis without an OpenAPI specification (D-17: one composer for
// both faces): the request goes through the gateway — its routing, its plans, its quotas — with the
// credentials of one of the consumer's own subscriptions, or none
r.post('/apis/:api/test', async ({ ctx, params, body }) => {
  const entry = await findEntry(ctx, params.api);
  const draft = normalizeDraft(entry.row.content.draft);
  const cp = draft.entrypoint.contextPath === '/' ? '' : draft.entrypoint.contextPath.replace(/\/$/, '');
  const rel = String(body.path || '/');
  const path = `${cp}${rel.startsWith('/') ? rel : `/${rel}`}`;
  const headers = {};
  for (const [k, v] of Object.entries(body.headers || {})) if (!['host', 'cookie'].includes(k.toLowerCase())) headers[k] = String(v);
  headers.host = await resolveLocal(draft.entrypoint.domain);
  if (body.subscription_id) {
    const sub = await mySub(ctx, body.subscription_id);
    if (sub.api_id !== entry.row.id) throw badRequest('this subscription is not to this api');
    const cred = (await subscriptions.credentialsOf(sub.id)).find((c) => c.status === 'active');
    if (!cred) throw badRequest('this subscription has no credentials to call with');
    headers.authorization = 'Basic ' + Buffer.from(`${cred.client_id}:${cred.client_secret}`).toString('base64');
  }
  const method = String(body.method || 'GET').toUpperCase();
  const gw = await gatewaySettings();
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${gw.url}${path}${body.query ? `?${String(body.query).replace(/^\?/, '')}` : ''}`, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body.body || undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw badRequest(`gateway unreachable: ${e.message}`);
  }
  const buf = await res.arrayBuffer();
  const out = Object.fromEntries([...res.headers].filter(([k]) => !['set-cookie'].includes(k.toLowerCase())));
  return {
    status: res.status,
    durationMs: Math.round(performance.now() - started),
    headers: out,
    body: new TextDecoder().decode(buf.slice(0, 256 * 1024)),
    truncated: buf.byteLength > 256 * 1024,
    size: buf.byteLength,
  };
});

r.post('/subscriptions/:sub/close', async ({ ctx, params }) => subscriptions.closeSubscription(ctx, await mySub(ctx, params.sub)));

// what the consumer is billed for its usage: the calls reported to the payment provider
r.get('/subscriptions/:sub/usage', async ({ ctx, params }) => {
  const sub = await mySub(ctx, params.sub);
  const u = await usageOf(sub.id);
  return { sent: u.sent, pending: u.pending, reports: u.reports.filter((r) => r.status !== 'failed').map(({ error, ...r }) => r) };
});

// from the consumer's side: ask to move to an equivalent plan, or answer a proposal
r.post('/subscriptions/:sub/transfer', async ({ ctx, params, body }) => {
  const sub = await mySub(ctx, params.sub);
  const entry = await findEntry(ctx, body.api_id || sub.api_id);
  return subscriptions.transferSubscription(ctx, sub, { plan_id: body.plan_id, api_id: entry.row.id }, { initiator: 'consumer' });
});
r.post('/subscriptions/:sub/transfer/consent', async ({ ctx, params, body }) =>
  subscriptions.answerTransfer(ctx, await mySub(ctx, params.sub), { accept: !!body.accept }, { side: 'consumer' })
);

r.get('/notifications', async ({ ctx }) => {
  requireUser(ctx);
  return { unread: await notifications.unreadCount(ctx.user, ctx.workspace.id, 'portal'), items: await notifications.listFor(ctx.user, ctx.workspace.id, 'portal') };
});
r.post('/notifications/read', async ({ ctx }) => {
  requireUser(ctx);
  await notifications.markRead(ctx.user, ctx.workspace.id, 'portal');
  return { ok: true };
});

// a paid plan: the Checkout of Stripe, on the account of the workspace — the key is made once Stripe says it is paid
r.post('/subscriptions/:sub/checkout', async ({ ctx, params }) => billing.checkout(ctx, ctx.workspace, await mySub(ctx, params.sub)));
// the portal of Stripe: the invoices, the cards and the cancellation of the team's subscriptions
r.post('/subscriptions/:sub/billing', async ({ ctx, params }) => {
  const sub = await mySub(ctx, params.sub);
  return billing.manage(ctx, ctx.workspace, sub, { back: `${portalUrl(ctx.workspace.slug).replace(/\/$/, '')}/apps/${sub.application_id}` });
});

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

// ---------------------------------------------------------------- test proxy (Scalar's requests)
// Scalar sends its requests through `proxyUrl?scalar_url=<target>`. The proxy only talks to the hosts
// of the workspace's deployed apis and never forwards the portal cookies.
export async function testProxy(req, ctx) {
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
  const hosts = new Set(await Promise.all(list.map((e) => resolveLocal(normalizeDraft(e.row.content.draft).entrypoint.domain))));
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
