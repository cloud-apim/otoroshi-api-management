// The public form of the portal URLs, one for the whole installation:
//  - path      <portal url>/<workspace>/         no wildcard DNS nor certificate per workspace
//  - hostname  <scheme>://<workspace>.<domain>/   one host per workspace
//  - root      <portal url>/                      single tenancy: one workspace, no prefix, no selector
// The workspace is read from the URL, never from a session. Changing the form changes every public
// URL — links in documentation, mails, tickets — so the forms served before are remembered, and
// their URLs redirected to the same page in the current form.

import { config } from './config.js';
import { db } from './db/index.js';

export const EXPOSURES = ['path', 'hostname'];
export const TENANCIES = ['multi', 'single'];

// the first path segments of the portal's own pages: in a root portal they are pages, never the
// workspace of an older path URL
const PORTAL_PAGES = ['apis', 'apps', 'signin', 'signup', 'usage', 'teams', 'front', '_portal'];

const KEEP = 5;

export function checkConfig(cfg = config) {
  if (!TENANCIES.includes(cfg.tenancy)) throw new Error(`APIM_TENANCY must be one of ${TENANCIES.join(', ')} (got "${cfg.tenancy}")`);
  if (!EXPOSURES.includes(cfg.portal.exposure)) throw new Error(`APIM_PORTAL_EXPOSURE must be one of ${EXPOSURES.join(', ')} (got "${cfg.portal.exposure}")`);
  if (cfg.tenancy === 'multi' && cfg.portal.exposure === 'hostname' && !cfg.portal.domain) throw new Error('APIM_PORTAL_DOMAIN is required with APIM_PORTAL_EXPOSURE=hostname');
}

export function currentForm(cfg = config) {
  if (cfg.tenancy === 'single') return { kind: 'root', workspace: cfg.bootstrap.workspace };
  if (cfg.portal.exposure === 'hostname') return { kind: 'hostname', domain: cfg.portal.domain.toLowerCase() };
  return { kind: 'path' };
}

export const sameForm = (a, b) => !!a && !!b && a.kind === b.kind && (a.domain || null) === (b.domain || null) && (a.workspace || null) === (b.workspace || null);

export function describeForm(f) {
  if (f.kind === 'hostname') return `by hostname, <workspace>.${f.domain}`;
  if (f.kind === 'root') return `at the root, the single workspace ${f.workspace}`;
  return 'by root path, /<workspace>/';
}

// the history after a start serving `current`: the form served until then becomes a previous one
export function nextHistory(stored, current, now = new Date().toISOString()) {
  if (!stored?.current) return { current: { ...current, since: now }, previous: [] };
  if (sameForm(stored.current, current)) return stored;
  const previous = [];
  for (const f of [{ ...stored.current, until: now }, ...(stored.previous || [])])
    if (!sameForm(f, current) && !previous.some((p) => sameForm(p, f))) previous.push(f);
  return { current: { ...current, since: now }, previous: previous.slice(0, KEEP) };
}

const hostOf = (h) =>
  String(h || '')
    .split(',')[0]
    .trim()
    .split(':')[0]
    .toLowerCase();

// what a request designates in a form: a workspace slug and the path inside its portal
export function match(form, { host, pathname }) {
  if (form.kind === 'hostname') {
    const h = hostOf(host);
    const suffix = `.${form.domain}`;
    if (!h.endsWith(suffix)) return null;
    const slug = h.slice(0, -suffix.length);
    if (!slug || slug.includes('.')) return null;
    return { slug, rest: pathname };
  }
  if (form.kind === 'root') return { slug: form.workspace, rest: pathname };
  const [, first, ...rest] = pathname.split('/');
  if (!first) return null;
  return { slug: decodeURIComponent(first), rest: '/' + rest.join('/') };
}

export const isBareDomain = (form, host) => form.kind === 'hostname' && hostOf(host) === form.domain;

export function portalBase(cfg = config) {
  return (cfg.portal.url || cfg.publicUrl).replace(/\/$/, '');
}

// the public URL of the portal of a workspace in a form; null when the form does not serve it
export function portalUrl(slug, form = currentForm(), cfg = config) {
  if (form.kind === 'root') return slug === form.workspace ? `${portalBase(cfg)}/` : null;
  if (form.kind === 'hostname') {
    const base = new URL(portalBase(cfg));
    return `${base.protocol}//${slug}.${form.domain}${base.port ? `:${base.port}` : ''}/`;
  }
  return `${portalBase(cfg)}/${slug}/`;
}

// where the URL of a previous form leads in the current one
export async function redirectFrom(previous, at, { findWorkspace, form = currentForm(), search = '', cfg = config }) {
  const order = [...previous.filter((f) => f.kind === 'hostname'), ...previous.filter((f) => f.kind === 'path'), ...previous.filter((f) => f.kind === 'root')];
  for (const prev of order) {
    const m = match(prev, at);
    if (!m) continue;
    if (prev.kind === 'path' && form.kind === 'root' && PORTAL_PAGES.includes(m.slug)) continue;
    const ws = await findWorkspace(m.slug);
    const target = ws && portalUrl(ws.slug, form, cfg);
    if (target) return `${target.replace(/\/$/, '')}${m.rest}${search}`;
  }
  return null;
}

let history = null;

export function portalHistory() {
  return history || { current: currentForm(), previous: [] };
}

// called at start: records the form served now, and what it replaces
export async function recordPortalForm() {
  const rows = await db`select value from settings where key = 'portal.forms'`;
  const stored = rows[0]?.value || null;
  const next = nextHistory(stored, currentForm());
  if (next !== stored) {
    await db`insert into settings (key, value) values ('portal.forms', ${next})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    if (stored?.current)
      console.log(`[apim] portal exposure changed: ${describeForm(stored.current)} -> ${describeForm(next.current)}; the URLs of the previous forms are redirected`);
  }
  history = next;
  return next;
}
