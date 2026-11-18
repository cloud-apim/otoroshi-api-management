// One binary, started with a comma-separated list of roles (APIM_ROLES):
//   ingester   -> /ingest
//   api        -> /api                     (bearer token)
//   backoffice -> /backoffice, /backoffice/api   (console session)
//   portal     -> /, /front/api             (one portal per workspace)
//   controller -> no route: reconciles the Kubernetes resources of the product (not a default role)

import { join, normalize } from 'node:path';
import { config, hasRole } from './config.js';
import { migrateAll } from './db/index.js';
import { errorResponse, json, parseCookies, readJson, HttpError } from './http/router.js';
import * as identity from './domain/identity.js';
import { adminRouter } from './roles/admin-api.js';
import { portalRouter, testProxy } from './roles/portal-api.js';
import { ingest, parseEvents } from './domain/ingest.js';
import { workOnce } from './domain/tasks.js';
import { runDriftDetection } from './otoroshi/drift.js';
import { consoleAuth, portalAuth, publicAuthConfig } from './auth/settings.js';
import { authorizeUrl, completeLogin } from './auth/oidc.js';
import { verifyOtoroshiClaim } from './auth/otoroshi.js';
import { checkConfig, currentForm, isBareDomain, match, portalHistory, portalUrl, recordPortalForm, redirectFrom } from './portal-exposure.js';

const DIST = join(import.meta.dir, '..', 'dist');
const BO_COOKIE = 'apim_bo';
const PORTAL_COOKIE = 'apim_portal';

function cookie(name, value, { path = '/', maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

// the origin the browser used: oidc redirect uris are built from it
function origin(req) {
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return `${proto}://${host}`;
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

function clientIp(req, server) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || server?.requestIP(req)?.address || null;
}

async function dispatch(router, req, path, ctx) {
  const m = router.match(req.method, path);
  if (!m) throw new HttpError(404, `no route for ${req.method} ${path}`);
  if (m.methodNotAllowed) throw new HttpError(405, 'method not allowed');
  const url = new URL(req.url);
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : {};
  const out = await m.route.handler({ req, ctx, params: m.params, query: url.searchParams, body });
  if (out instanceof Response) return out;
  return json(out ?? {});
}

// cookie-authenticated mutations must be json: a cross-site form cannot send that without a preflight
function checkCsrf(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const ct = req.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'json content-type required');
}

// ---------------------------------------------------------------- static files

async function serveStatic(root, relPath) {
  const clean = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = Bun.file(join(root, clean));
  if (clean && (await file.exists())) {
    const immutable = clean.startsWith('assets/');
    return new Response(file, { headers: immutable ? { 'cache-control': 'public, max-age=31536000, immutable' } : {} });
  }
  return null;
}

async function spaIndex(root, inject) {
  const file = Bun.file(join(root, 'index.html'));
  if (!(await file.exists())) {
    return new Response('ui not built: run `bun run build`', { status: 503 });
  }
  let html = await file.text();
  if (inject) html = html.replace('</head>', `<script>window.__APIM__ = ${JSON.stringify(inject).replace(/</g, '\\u003c')};</script></head>`);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
}

// ---------------------------------------------------------------- roles

async function handleIngest(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '') || req.headers.get('x-apim-ingest-token') || new URL(req.url).searchParams.get('token');
  if (token !== config.ingest.token) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const events = parseEvents(await req.text());
  return json(await ingest(events));
}

async function handleAdminApi(req, path, server) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const user = await identity.tokenUser(token);
  return dispatch(adminRouter, req, path, { user, via: 'api', ip: clientIp(req, server) });
}

async function handleBackofficeApi(req, path, server) {
  const cookies = parseCookies(req);
  const auth = await consoleAuth();
  if (path === '/auth/config') return json(publicAuthConfig(auth));
  // via Otoroshi: exclusive, the identity comes from the gateway on every request
  if (auth.mode === 'otoroshi') {
    if (path.startsWith('/auth/')) return json({ error: 'authentication is delegated to Otoroshi on this installation' }, 400);
    let user = null;
    try {
      const id = verifyOtoroshiClaim(req.headers.get(auth.otoroshi.header), auth.otoroshi);
      user = await identity.externalUser(id, 'otoroshi');
    } catch (e) {
      return json({ error: `unauthorized: ${e.message}` }, 401);
    }
    checkCsrf(req);
    return dispatch(adminRouter, req, path, { user, via: 'backoffice', ip: clientIp(req, server) });
  }
  if (path === '/auth/oidc/login' && auth.oidc.enabled) {
    try {
      return redirect(await authorizeUrl(auth.oidc, { redirectUri: `${origin(req)}/backoffice/api/auth/oidc/callback`, context: { face: 'backoffice' } }));
    } catch (e) {
      return redirect(`/backoffice/?error=${encodeURIComponent(`identity provider unreachable: ${e.message}`)}`);
    }
  }
  if (path === '/auth/oidc/callback' && auth.oidc.enabled) {
    const url = new URL(req.url);
    try {
      if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
      const id = await completeLogin(auth.oidc, { code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      const user = await identity.externalUser(id, 'oidc');
      const s = await identity.createSession(user.id, 'backoffice');
      return redirect('/backoffice/', { 'set-cookie': cookie(BO_COOKIE, s.id, { path: '/backoffice', maxAge: config.sessionTtlMs / 1000 }) });
    } catch (e) {
      return redirect(`/backoffice/?error=${encodeURIComponent(e.message)}`);
    }
  }
  if (path === '/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const user = await identity.checkPassword(body.email, body.password);
    if (!user) return json({ error: 'invalid credentials' }, 401);
    // with the IdP as the norm, the local form stays open to bootstrap administrators only
    if (!publicAuthConfig(auth).local && !config.bootstrap.admins.map((x) => x.toLowerCase()).includes(user.email)) return json({ error: 'sign in with the identity provider' }, 403);
    const s = await identity.createSession(user.id, 'backoffice');
    return json({ user: identity.publicUser(user) }, 200, { 'set-cookie': cookie(BO_COOKIE, s.id, { path: '/backoffice', maxAge: config.sessionTtlMs / 1000 }) });
  }
  if (path === '/auth/logout' && req.method === 'POST') {
    await identity.deleteSession(cookies[BO_COOKIE]);
    return json({ ok: true }, 200, { 'set-cookie': cookie(BO_COOKIE, '', { path: '/backoffice', maxAge: 0 }) });
  }
  const user = await identity.sessionUser(cookies[BO_COOKIE], 'backoffice');
  checkCsrf(req);
  return dispatch(adminRouter, req, path, { user, via: 'backoffice', ip: clientIp(req, server) });
}

const requestHost = (req, url) => req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;

// the workspace is read from the url — hostname, root path, or the root of a single-workspace
// installation — never from a session. The URLs of the forms served before are redirected.
async function resolvePortal(req, url) {
  const at = { host: requestHost(req, url), pathname: url.pathname };
  const form = currentForm();
  const { previous } = portalHistory();
  const opts = { findWorkspace: identity.findWorkspace, form, search: url.search };
  // the host of an older hostname form is an old URL whatever its path; in a root portal, so is
  // an older path URL
  const early = previous.filter((f) => f.kind === 'hostname' || form.kind === 'root');
  const before = early.length ? await redirectFrom(early, at, opts) : null;
  if (before) return { redirect: before };
  const m = match(form, at);
  if (m) {
    const ws = await identity.findWorkspace(m.slug);
    if (ws && portalUrl(ws.slug, form)) return { ws, base: form.kind === 'path' ? `/${ws.slug}` : '', rest: m.rest };
  }
  const after = await redirectFrom(previous, at, opts);
  return after ? { redirect: after } : null;
}

// a permanent redirect that keeps the method of a form or an api call. Not kept by the browsers:
// a form changed back would otherwise loop between their cached redirects and the new ones
const moved = (req, location) => new Response(null, { status: ['GET', 'HEAD'].includes(req.method) ? 301 : 308, headers: { location, 'cache-control': 'no-store' } });

async function handlePortal(req, url, server) {
  const resolved = await resolvePortal(req, url);
  if (resolved?.redirect) return moved(req, resolved.redirect);
  if (!resolved) {
    // there is no global portal: the root of the installation leads to the default workspace portal
    const form = currentForm();
    if ((url.pathname === '/' && form.kind === 'path') || isBareDomain(form, requestHost(req, url))) {
      const ws = await identity.findWorkspace(config.bootstrap.workspace);
      if (ws) return redirect(portalUrl(ws.slug, form));
    }
    return json({ error: 'no portal here' }, 404);
  }
  const { ws, base, rest } = resolved;
  const cookies = parseCookies(req);
  const user = await identity.sessionUser(cookies[PORTAL_COOKIE], 'portal');
  const role = user ? (user.is_admin ? 'admin' : await identity.membership(ws.id, user.id)) : null;
  const ctx = { user, workspace: ws, role, via: 'portal', ip: clientIp(req, server) };

  if (rest.startsWith('/front/api/')) {
    const path = rest.slice('/front/api'.length);
    if (path === '/test' || path.startsWith('/test?')) {
      return testProxy(req, ctx);
    }
    const pauth = portalAuth(ws);
    if (path === '/auth/config') return json({ local: pauth.localLogin, selfSignup: !!ws.portal?.selfSignup && pauth.localLogin, oidc: pauth.oidc.enabled ? { label: pauth.oidc.label } : null });
    if (path.startsWith('/auth/oidc/login') && pauth.oidc.enabled) {
      const next = new URL(req.url).searchParams.get('next') || '/';
      try {
        return redirect(await authorizeUrl(pauth.oidc, { redirectUri: `${origin(req)}${base}/front/api/auth/oidc/callback`, context: { face: 'portal', workspace: ws.id, next } }));
      } catch (e) {
        return redirect(`${base}/signin?error=${encodeURIComponent(`identity provider unreachable: ${e.message}`)}`);
      }
    }
    if (path.startsWith('/auth/oidc/callback') && pauth.oidc.enabled) {
      const url = new URL(req.url);
      try {
        if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error'));
        const id = await completeLogin(pauth.oidc, { code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        if (id.context?.workspace !== ws.id) throw new Error('this login was started on another portal');
        const u = await identity.externalUser(id, `oidc:${ws.slug}`);
        // the workspace's own IdP vouches for its members: they join the portal as consumers
        if (!u.is_admin && !(await identity.membership(ws.id, u.id))) await identity.addMember(ws.id, u.id, 'consumer');
        await identity.personalTeam({ user: u, via: 'portal' }, ws.id, u);
        const s = await identity.createSession(u.id, 'portal');
        const next = String(id.context?.next || '/').startsWith('/') ? id.context.next : '/';
        return redirect(`${base}${next}`, { 'set-cookie': cookie(PORTAL_COOKIE, s.id, { path: '/', maxAge: config.sessionTtlMs / 1000 }) });
      } catch (e) {
        return redirect(`${base}/signin?error=${encodeURIComponent(e.message)}`);
      }
    }
    if (path === '/auth/login' && req.method === 'POST') {
      if (!pauth.localLogin) return json({ error: 'sign in with the identity provider of this portal' }, 403);
      const body = await readJson(req);
      const u = await identity.checkPassword(body.email, body.password);
      if (!u) return json({ error: 'invalid credentials' }, 401);
      if (!u.is_admin && !(await identity.membership(ws.id, u.id))) {
        if (!ws.portal?.selfSignup) return json({ error: 'you are not a member of this portal' }, 403);
        await identity.addMember(ws.id, u.id, 'consumer');
      }
      const s = await identity.createSession(u.id, 'portal');
      return json({ user: identity.publicUser(u) }, 200, { 'set-cookie': cookie(PORTAL_COOKIE, s.id, { path: '/', maxAge: config.sessionTtlMs / 1000 }) });
    }
    if (path === '/auth/signup' && req.method === 'POST') {
      if (!ws.portal?.selfSignup || !pauth.localLogin) return json({ error: 'self signup is disabled on this portal' }, 403);
      const body = await readJson(req);
      if (!body.password || body.password.length < 8) return json({ error: 'the password must have at least 8 characters' }, 400);
      const u = await identity.createUser({ email: body.email, name: body.name, password: body.password });
      await identity.addMember(ws.id, u.id, 'consumer');
      await identity.personalTeam({ user: u, via: 'portal' }, ws.id, u);
      const s = await identity.createSession(u.id, 'portal');
      return json({ user: identity.publicUser(u) }, 200, { 'set-cookie': cookie(PORTAL_COOKIE, s.id, { path: '/', maxAge: config.sessionTtlMs / 1000 }) });
    }
    if (path === '/auth/logout' && req.method === 'POST') {
      await identity.deleteSession(cookies[PORTAL_COOKIE]);
      return json({ ok: true }, 200, { 'set-cookie': cookie(PORTAL_COOKIE, '', { path: '/', maxAge: 0 }) });
    }
    checkCsrf(req);
    return dispatch(portalRouter, req, path, ctx);
  }
  return spaIndex(join(DIST, 'portal'), { workspace: ws.slug, base, exposure: currentForm().kind });
}

async function fetchHandler(req, server) {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path === '/health') return json({ status: 'ok', roles: config.roles });
    if (path.startsWith('/ingest') && hasRole('ingester')) return await handleIngest(req);
    if (path.startsWith('/api/') && hasRole('api')) return await handleAdminApi(req, path.slice(4), server);
    if (hasRole('backoffice')) {
      if (path.startsWith('/backoffice/api/')) return await handleBackofficeApi(req, path.slice('/backoffice/api'.length), server);
      if (path === '/backoffice') return Response.redirect('/backoffice/', 302);
      if (path.startsWith('/backoffice/')) {
        const root = join(DIST, 'backoffice');
        return (await serveStatic(root, path.slice('/backoffice/'.length))) || (await spaIndex(root, { otoroshi: config.otoroshi.backofficeUrl }));
      }
    }
    if (hasRole('portal')) {
      if (path.startsWith('/_portal/')) return (await serveStatic(join(DIST, 'portal'), path.slice('/_portal/'.length))) || json({ error: 'not found' }, 404);
      return await handlePortal(req, url, server);
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}

async function start() {
  checkConfig();
  await migrateAll();
  await identity.bootstrap();
  await identity.checkTenancy();
  await recordPortalForm();
  if (hasRole('controller')) {
    const { startController } = await import('./kube/controller.js');
    startController();
  }
  const server = Bun.serve({ port: config.port, fetch: fetchHandler, idleTimeout: 60, maxRequestBodySize: 50 * 1024 * 1024 });
  console.log(`[apim] listening on ${server.url} with roles: ${config.roles.join(', ')}`);
  if (config.workers.enabled && (hasRole('api') || hasRole('backoffice'))) {
    setInterval(workOnce, config.workers.projectionIntervalMs);
    setInterval(() => runDriftDetection().catch((e) => console.error('[apim] drift detection failed', e.message)), config.workers.driftIntervalMs);
    // remote catalogs, each on its own interval
    const { syncDue } = await import('./domain/catalogs.js');
    const apisMod = await import('./domain/apis.js');
    const depsMod = await import('./domain/deployments.js');
    setInterval(() => syncDue({ apis: apisMod, deployments: depsMod }).catch((e) => console.error('[apim] catalogs failed', e.message)), 30000);
    const { deliverAll } = await import('./domain/auditExport.js');
    setInterval(() => deliverAll().catch((e) => console.error('[apim] audit export failed', e.message)), 5000);
    setTimeout(() => runDriftDetection().catch(() => null), 5000);
  }
  return server;
}

if (import.meta.main) {
  start().catch((e) => {
    console.error('[apim] failed to start', e);
    process.exit(1);
  });
}

export { start, fetchHandler };
