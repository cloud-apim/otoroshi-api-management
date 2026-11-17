// One binary, started with a comma-separated list of roles (APIM_ROLES):
//   ingester   -> /ingest
//   api        -> /api                     (bearer token)
//   backoffice -> /backoffice, /backoffice/api   (console session)
//   portal     -> /, /front/api             (one portal per workspace, D-20)

import { join, normalize } from 'node:path';
import { config, hasRole } from './config.js';
import { migrateAll } from './db/index.js';
import { errorResponse, json, parseCookies, readJson, HttpError } from './http/router.js';
import * as identity from './domain/identity.js';
import { adminRouter } from './roles/admin-api.js';
import { portalRouter, tryItProxy } from './roles/portal-api.js';
import { ingest, parseEvents } from './domain/ingest.js';
import { workOnce } from './domain/tasks.js';
import { runDriftDetection } from './otoroshi/drift.js';

const DIST = join(import.meta.dir, '..', 'dist');
const BO_COOKIE = 'apim_bo';
const PORTAL_COOKIE = 'apim_portal';

function cookie(name, value, { path = '/', maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
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
  if (path === '/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const user = await identity.checkPassword(body.email, body.password);
    if (!user) return json({ error: 'invalid credentials' }, 401);
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

// D-20: the workspace is read from the url — hostname or root path — never from a session
async function resolvePortal(req, url) {
  if (config.portal.exposure === 'hostname') {
    const host = (req.headers.get('host') || '').split(':')[0];
    const suffix = `.${config.portal.domain}`;
    if (!host.endsWith(suffix)) return null;
    const slug = host.slice(0, -suffix.length);
    const ws = await identity.findWorkspace(slug);
    return ws ? { ws, base: '', rest: url.pathname } : null;
  }
  const [, first, ...rest] = url.pathname.split('/');
  if (!first) return null;
  const ws = await identity.findWorkspace(first);
  return ws ? { ws, base: `/${ws.slug}`, rest: '/' + rest.join('/') } : null;
}

async function handlePortal(req, url, server) {
  const resolved = await resolvePortal(req, url);
  if (!resolved) {
    // there is no global portal: the root redirects to the default workspace portal
    if (url.pathname === '/' && config.portal.exposure === 'path') {
      const ws = (await identity.findWorkspace(config.bootstrap.workspace)) || null;
      if (ws) return Response.redirect(`/${ws.slug}/`, 302);
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
    if (path === '/tryit' || path.startsWith('/tryit?')) {
      return tryItProxy(req, ctx);
    }
    if (path === '/auth/login' && req.method === 'POST') {
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
      if (!ws.portal?.selfSignup) return json({ error: 'self signup is disabled on this portal' }, 403);
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
  return spaIndex(join(DIST, 'portal'), { workspace: ws.slug, base, exposure: config.portal.exposure });
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
  await migrateAll();
  await identity.bootstrap();
  const server = Bun.serve({ port: config.port, fetch: fetchHandler, idleTimeout: 60, maxRequestBodySize: 50 * 1024 * 1024 });
  console.log(`[apim] listening on ${server.url} with roles: ${config.roles.join(', ')}`);
  if (config.workers.enabled && (hasRole('api') || hasRole('backoffice'))) {
    setInterval(workOnce, config.workers.projectionIntervalMs);
    setInterval(() => runDriftDetection().catch((e) => console.error('[apim] drift detection failed', e.message)), config.workers.driftIntervalMs);
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
