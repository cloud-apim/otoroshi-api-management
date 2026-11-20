// The design of a portal: what it looks like and what it says. Three modes —
//  - `default`: the template of the product, as it is (its texts, its accent color, its logo, its
//    home markdown, its pages);
//  - `themed`: the same pages, themed (colors, font, radius, favicon, navigation), the home made of
//    blocks, custom css;
//  - `templates`: the home, the page of an api and the free pages written as templates (Markdoc,
//    the components of the portal as tags), on top of the theme.
// The transactional pages — subscribing, the applications, the usage, signing in — stay the
// product's in every mode, themed.
//
// The design is edited as a draft and published by immutable versions; the portal shows the last
// published one (or, before any, the one its settings describe). A script of the design runs only if
// the administrators of the workspace allowed scripts on the portal — off by default: a script runs
// in the session of the consumers, their credentials on the page.
//
// Never projected: nothing of the design reaches the gateway.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { db, newId } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../http/router.js';
import { config } from '../config.js';
import { audit } from './audit.js';
import { diff } from './diff.js';
import { normalizePages } from './identity.js';

export const PORTAL_KIND = 'Portal';
export const MODES = ['default', 'themed', 'templates'];
export const BLOCK_KINDS = ['hero', 'featured', 'catalogue', 'categories', 'markdown'];
const RADII = ['none', 'small', 'medium', 'large'];
const COLOR_KEYS = ['background', 'surface', 'text', 'muted', 'border'];
const TEMPLATE_KEYS = ['home', 'api'];

export const LIMITS = { text: 500, markdown: 64 * 1024, template: 256 * 1024, css: 200 * 1024, script: 500 * 1024, design: 2 * 1024 * 1024, asset: 2 * 1024 * 1024, assets: 20 * 1024 * 1024, links: 20, blocks: 30 };

// the files a design may carry, by type: never a script (a script is the design's own, gated)
export const ASSET_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css',
};
const ASSET_PATH = /^assets\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

// ---------------------------------------------------------------- normalization

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const sizeOf = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v ?? ''));

// a text per language — a plain string is the text of every language
function localized(v, max, what) {
  const out = typeof v === 'string' ? { en: v } : isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, t]) => typeof t === 'string')) : {};
  for (const [lang, t] of Object.entries(out)) {
    if (!/^[a-z]{2}(-[A-Za-z]{2})?$/.test(lang)) throw badRequest(`${what}: ${lang} is not a language`);
    if (sizeOf(t) > max) throw badRequest(`${what} (${lang}) is larger than ${Math.round(max / 1024) || max} ${max >= 1024 ? 'KB' : 'characters'}`);
  }
  return out;
}

function color(v, what) {
  if (v === undefined || v === null || v === '') return '';
  if (!/^#[0-9a-fA-F]{3,8}$/.test(String(v))) throw badRequest(`${what} is a color: #rgb, #rrggbb or #rrggbbaa`);
  return String(v);
}

// a link of the navigation: the web, a mail, a path of the portal, a page of the design
function href(v, what) {
  const s = String(v || '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(s) || /^\/(?!\/)/.test(s) || /^#/.test(s) || /^page:[a-z0-9-]+$/.test(s)) return s;
  throw badRequest(`${what}: a link is an http(s) or mailto url, a path of the portal (/…), an anchor (#…) or a page (page:<slug>) — not ${s || 'empty'}`);
}

// an image of the theme: an url of the web, or an asset of the design
function image(v, assets, what) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (ASSET_PATH.test(s)) {
    if (!(s in assets)) throw badRequest(`${what}: ${s} is not an asset of the design`);
    return s;
  }
  throw badRequest(`${what} is an http(s) url or an asset of the design (assets/…)`);
}

function links(list, what) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw badRequest(`${what} is a list`);
  if (list.length > LIMITS.links) throw badRequest(`${what} holds ${LIMITS.links} links at most`);
  return list.map((l, i) => {
    const label = localized(l?.label, LIMITS.text, `${what} #${i + 1}`);
    if (!Object.values(label).some((t) => t.trim())) throw badRequest(`${what} #${i + 1}: give it a label`);
    return { label, href: href(l?.href, `${what} #${i + 1}`) };
  });
}

function blocks(list) {
  if (list === undefined || list === null) return DEFAULT_BLOCKS;
  if (!Array.isArray(list)) throw badRequest('the blocks of the home are a list');
  if (list.length > LIMITS.blocks) throw badRequest(`the home holds ${LIMITS.blocks} blocks at most`);
  return list.map((b, i) => {
    if (!BLOCK_KINDS.includes(b?.kind)) throw badRequest(`block #${i + 1} of the home: its kind is one of ${BLOCK_KINDS.join(', ')}`);
    const out = { kind: b.kind };
    if (b.kind === 'hero') Object.assign(out, { title: localized(b.title, LIMITS.text, 'the title of the hero'), tagline: localized(b.tagline, LIMITS.text, 'the tagline of the hero') });
    if (b.kind === 'markdown') out.content = localized(b.content, LIMITS.markdown, `block #${i + 1} of the home`);
    if (['featured', 'catalogue'].includes(b.kind)) out.limit = Math.max(1, Math.min(24, parseInt(b.limit, 10) || 6));
    if (b.kind === 'catalogue') Object.assign(out, { category: String(b.category || ''), tag: String(b.tag || '') });
    if (b.title !== undefined && b.kind !== 'hero') out.title = localized(b.title, LIMITS.text, `the title of block #${i + 1}`);
    return out;
  });
}

const DEFAULT_BLOCKS = [{ kind: 'hero', title: {}, tagline: {} }, { kind: 'featured', limit: 6 }, { kind: 'categories' }];

function assetMap(v) {
  if (v === undefined || v === null) return {};
  const entries = Array.isArray(v) ? v.map((a) => [a?.path, a?.hash]) : isObject(v) ? Object.entries(v) : null;
  if (!entries) throw badRequest('the assets of the design are a map of their paths to their digests');
  const out = {};
  for (const [path, hash] of entries) {
    if (!ASSET_PATH.test(String(path || '')) || String(path).split('/').includes('..')) throw badRequest(`the asset ${path} has a path assets/<name>, of letters, digits, dots, dashes and underscores`);
    if (!/^[0-9a-f]{64}$/.test(String(hash || ''))) throw badRequest(`the asset ${path} is not uploaded (its digest is missing)`);
    out[path] = hash;
  }
  return out;
}

// the design, completed and checked; `input` may be partial, `base` is what it completes
export function normalizeDesign(input = {}, base = emptyDesign()) {
  const d = { ...base, ...(isObject(input) ? input : {}) };
  if (!MODES.includes(d.mode)) throw badRequest(`the mode of the portal is one of ${MODES.join(', ')}`);
  const assets = assetMap(d.assets);
  const t = isObject(d.texts) ? d.texts : {};
  const theme = isObject(d.theme) ? d.theme : {};
  const colors = isObject(theme.colors) ? theme.colors : {};
  const nav = isObject(d.navigation) ? d.navigation : {};
  const home = isObject(d.home) ? d.home : {};
  const templates = isObject(d.templates) ? d.templates : {};
  const font = String(theme.font || '');
  if (font.length > 200 || /[;{}<>]/.test(font)) throw badRequest('the font of the theme is a css font-family, without ; { } < >');
  const radius = theme.radius || 'medium';
  if (!RADII.includes(radius)) throw badRequest(`the radius of the theme is one of ${RADII.join(', ')}`);
  const palette = (side) =>
    Object.fromEntries(
      COLOR_KEYS.map((k) => [k, color(colors?.[side]?.[k], `the ${k} color of the ${side} theme`)]).filter(([, v]) => v)
    );
  const css = String(d.css || '');
  if (sizeOf(css) > LIMITS.css) throw badRequest(`the style sheet of the design is larger than ${LIMITS.css / 1024} KB`);
  if (/<\/style/i.test(css)) throw badRequest('the style sheet of the design holds a </style>');
  const script = String(d.script || '');
  if (sizeOf(script) > LIMITS.script) throw badRequest(`the script of the design is larger than ${LIMITS.script / 1024} KB`);
  const out = {
    mode: d.mode,
    texts: { title: localized(t.title, LIMITS.text, 'the title of the portal'), tagline: localized(t.tagline, LIMITS.text, 'the tagline of the portal') },
    theme: {
      accent: color(theme.accent, 'the accent color') || '#0061bd',
      logo: image(theme.logo, assets, 'the logo'),
      favicon: image(theme.favicon, assets, 'the favicon'),
      font,
      radius,
      colors: { light: palette('light'), dark: palette('dark') },
    },
    navigation: { header: links(nav.header, 'the links of the header'), footer: links(nav.footer, 'the links of the footer') },
    home: { markdown: localized(home.markdown, LIMITS.markdown, 'the home page'), blocks: blocks(home.blocks) },
    pages: normalizePages(d.pages),
    templates: Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, localized(templates[k], LIMITS.template, `the template ${k}`)])),
    css,
    script,
    assets,
  };
  for (const p of out.pages) for (const [lang, c] of Object.entries(p.content)) if (sizeOf(c) > LIMITS.template) throw badRequest(`page ${p.slug} (${lang}) is larger than ${LIMITS.template / 1024} KB`);
  if (sizeOf(out) > LIMITS.design) throw badRequest(`a design holds ${LIMITS.design / 1024 / 1024} MB at most, its assets aside`);
  return out;
}

export function emptyDesign() {
  return { mode: 'default', texts: {}, theme: {}, navigation: {}, home: {}, pages: [], templates: {}, css: '', script: '', assets: {} };
}

// the design the settings of a portal describe: what the portal showed before designs
export function legacyDesign(portal = {}) {
  return normalizeDesign({
    mode: 'default',
    texts: { title: portal.title, tagline: portal.tagline },
    theme: { accent: /^#[0-9a-fA-F]{3,8}$/.test(portal.accentColor || '') ? portal.accentColor : '#0061bd', logo: /^https?:\/\//i.test(portal.logoUrl || '') ? portal.logoUrl : '' },
    home: { markdown: portal.homeMarkdown },
    pages: portal.pages || [],
  });
}

// ---------------------------------------------------------------- the draft, the versions

async function workspaceRow(ws) {
  const rows = await db`select * from workspaces where id = ${ws.id}`;
  if (!rows[0]) throw notFound('workspace not found');
  return rows[0];
}

export async function draftOf(ws) {
  const row = await workspaceRow(ws);
  return row.portal_design ? normalizeDesign(row.portal_design) : legacyDesign(row.portal);
}

export async function lastVersion(workspaceId) {
  return (await db`select * from portal_versions where workspace_id = ${workspaceId} order by number desc limit 1`)[0] || null;
}

// what the portal shows: the last published design, or the one its settings describe
export async function publishedDesign(ws) {
  const last = await lastVersion(ws.id);
  return last ? { number: last.number, design: normalizeDesign(last.design) } : { number: 0, design: legacyDesign(ws.portal) };
}

export async function designState(ws) {
  const [draft, published, versions] = await Promise.all([draftOf(ws), publishedDesign(ws), db`select count(*)::int as n from portal_versions where workspace_id = ${ws.id}`]);
  return {
    draft,
    published: { number: published.number, design: published.design },
    changes: diff(published.design, draft).slice(0, 200),
    versions: versions[0].n,
    managedBy: ws.portal?.designManagedBy || null,
    scripts: scriptsOf(ws),
  };
}

const requireUnmanaged = (ws, force) => {
  if (ws.portal?.designManagedBy && !force) throw conflict(`the design of this portal is managed by ${ws.portal.designManagedBy}: edit it at its source`, { managed_by: ws.portal.designManagedBy });
};

export async function saveDraft(ctx, ws, input, { force = false } = {}) {
  requireUnmanaged(ws, force);
  const current = await draftOf(ws);
  const next = normalizeDesign(input, current);
  await requireAssets(ws.id, next.assets);
  await db`update workspaces set portal_design = ${next}, updated_at = now() where id = ${ws.id}`;
  await audit(ctx, { action: 'portal.design.update', workspaceId: ws.id, entityKind: 'portal', entityId: ws.id, summary: `draft of the portal design updated`, data: { changes: diff(current, next).slice(0, 50) } });
  return next;
}

export async function publishDesign(ctx, ws, { comment = '' } = {}) {
  const draft = await draftOf(ws);
  const last = await lastVersion(ws.id);
  if (last && diff(normalizeDesign(last.design), draft).length === 0) throw conflict('nothing to publish: the draft is identical to the last version');
  const number = (last?.number || 0) + 1;
  const [row] = await db`insert into portal_versions (id, workspace_id, number, design, comment, published_by)
    values (${newId('pdv')}, ${ws.id}, ${number}, ${draft}, ${String(comment || '')}, ${ctx.user?.id || null}) returning *`;
  // the draft is kept as it is: it is the published design until the next edit
  await db`update workspaces set portal_design = ${draft} where id = ${ws.id}`;
  await audit(ctx, { action: 'portal.design.publish', workspaceId: ws.id, entityKind: 'portal', entityId: ws.id, summary: `portal design v${number} published` });
  return { number: row.number, published_at: row.published_at, comment: row.comment };
}

export async function listVersions(workspaceId, { limit = 50, offset = 0 } = {}) {
  const [items, [{ total }]] = await Promise.all([
    db`select v.number, v.comment, v.published_at, u.email as published_by_email, v.design->>'mode' as mode
      from portal_versions v left join users u on u.id = v.published_by where v.workspace_id = ${workspaceId} order by v.number desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from portal_versions where workspace_id = ${workspaceId}`,
  ]);
  return { items, total, limit, offset };
}

export async function getVersion(workspaceId, number) {
  const row = (await db`select * from portal_versions where workspace_id = ${workspaceId} and number = ${parseInt(number, 10) || 0}`)[0];
  if (!row) throw notFound(`no version ${number} of the portal design`);
  return { number: row.number, comment: row.comment, published_at: row.published_at, design: normalizeDesign(row.design) };
}

// a version brought back into the draft: publishing it is the rollback
export async function restoreVersion(ctx, ws, number) {
  requireUnmanaged(ws, false);
  const v = await getVersion(ws.id, number);
  await db`update workspaces set portal_design = ${v.design}, updated_at = now() where id = ${ws.id}`;
  await audit(ctx, { action: 'portal.design.restore', workspaceId: ws.id, entityKind: 'portal', entityId: ws.id, summary: `portal design v${v.number} restored into the draft` });
  return v.design;
}

// ---------------------------------------------------------------- assets

export const assetType = (path, given) => {
  const ext = String(path || '').split('.').pop().toLowerCase();
  const type = ASSET_TYPES[ext];
  if (!type) throw badRequest(`${path}: an asset is an image, a font or a style sheet (${Object.keys(ASSET_TYPES).join(', ')})`);
  if (given && given !== type) throw badRequest(`${path}: its type is ${type}, not ${given}`);
  return type;
};

export async function storeAsset(ctx, ws, { path, contentType, data }) {
  if (!ASSET_PATH.test(String(path || ''))) throw badRequest(`the asset ${path} has a path assets/<name>`);
  const type = assetType(path, contentType);
  const bytes = Buffer.from(String(data || ''), 'base64');
  if (!bytes.length) throw badRequest(`${path}: the asset is empty`);
  if (bytes.length > LIMITS.asset) throw badRequest(`${path}: an asset is ${LIMITS.asset / 1024 / 1024} MB at most`);
  const [{ used }] = await db`select coalesce(sum(size), 0)::int as used from portal_assets where workspace_id = ${ws.id}`;
  if (used + bytes.length > LIMITS.assets) throw badRequest(`the assets of a portal are ${LIMITS.assets / 1024 / 1024} MB at most`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  await db`insert into portal_assets (workspace_id, hash, content_type, size, data) values (${ws.id}, ${hash}, ${type}, ${bytes.length}, ${bytes})
    on conflict (workspace_id, hash) do nothing`;
  await audit(ctx, { action: 'portal.asset.upload', workspaceId: ws.id, entityKind: 'portal', entityId: ws.id, summary: `asset ${path} uploaded (${bytes.length} bytes)` });
  return { path, hash, contentType: type, size: bytes.length };
}

async function requireAssets(workspaceId, assets) {
  const hashes = [...new Set(Object.values(assets || {}))];
  if (!hashes.length) return;
  const found = new Set((await db`select hash from portal_assets where workspace_id = ${workspaceId} and hash in ${db(hashes)}`).map((r) => r.hash));
  const missing = Object.entries(assets).filter(([, h]) => !found.has(h));
  if (missing.length) throw badRequest(`not uploaded: ${missing.map(([p]) => p).join(', ')}`);
}

export async function getAsset(workspaceId, hash) {
  const row = (await db`select content_type, size, data from portal_assets where workspace_id = ${workspaceId} and hash = ${String(hash || '')}`)[0];
  if (!row) throw notFound('asset not found');
  return row;
}

// ---------------------------------------------------------------- scripts

export const SCRIPTS_WARNING =
  'A script of the design runs in the portal, in the session of every consumer who opens it: it can read what they see — their applications, their credentials — and act on their behalf. Allow it only for a script you wrote or reviewed, served by this portal alone.';

export function scriptsOf(ws) {
  const s = ws.portal?.scripts || {};
  return { enabled: !!s.enabled, by: s.by || null, at: s.at || null };
}

// allowing scripts is an act of its own: an administrator, the warning acknowledged, in the audit
export async function setScripts(ctx, ws, { enabled, acknowledge } = {}) {
  if (ctx.role !== 'admin' && !ctx.user?.is_admin) throw forbidden('the administrators of the workspace allow scripts on its portal');
  if (enabled && acknowledge !== true) throw badRequest(`acknowledge it: ${SCRIPTS_WARNING}`, { warning: SCRIPTS_WARNING });
  const scripts = enabled ? { enabled: true, by: ctx.user?.email || null, at: new Date().toISOString() } : { enabled: false };
  const row = await workspaceRow(ws);
  await db`update workspaces set portal = ${{ ...row.portal, scripts }}, updated_at = now() where id = ${ws.id}`;
  await audit(ctx, {
    action: enabled ? 'portal.scripts.allow' : 'portal.scripts.forbid',
    workspaceId: ws.id,
    entityKind: 'portal',
    entityId: ws.id,
    summary: enabled ? 'scripts ALLOWED on the portal: the script of its design runs in the session of the consumers' : 'scripts forbidden on the portal',
  });
  return scripts;
}

// ---------------------------------------------------------------- preview

const previewKey = () => createHmac('sha256', `${config.secrets?.key || ''}:${config.adminToken}`).update('apim-portal-preview').digest();

// a link to the draft, for an hour: the console opens the portal on it
export function previewToken(ws, ttlMs = 3600e3) {
  const body = Buffer.from(JSON.stringify({ ws: ws.id, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${createHmac('sha256', previewKey()).update(body).digest('base64url')}`;
}

export function readPreviewToken(token, ws) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return false;
  const expected = Buffer.from(createHmac('sha256', previewKey()).update(body).digest('base64url'));
  if (expected.length !== Buffer.from(mac).length || !timingSafeEqual(expected, Buffer.from(mac))) return false;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.ws === ws.id && p.exp > Date.now();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the public form

// what the portal receives: the design without its script (served apart, when allowed), its assets
// as the urls of the portal
export function publicDesign(design, ws, number) {
  const { script, assets, ...rest } = design;
  const url = (p) => (p && p in assets ? `_design/assets/${assets[p]}` : p);
  return {
    ...rest,
    number,
    theme: { ...rest.theme, logo: url(rest.theme.logo), favicon: url(rest.theme.favicon) },
    assets: Object.fromEntries(Object.entries(assets).map(([p, h]) => [p, `_design/assets/${h}`])),
    script: !!script && scriptsOf(ws).enabled,
  };
}

// ---------------------------------------------------------------- the declarative document

export async function portalDocument(ws) {
  const draft = await draftOf(ws);
  const hashes = Object.values(draft.assets);
  const types = hashes.length ? new Map((await db`select hash, content_type from portal_assets where workspace_id = ${ws.id} and hash in ${db(hashes)}`).map((r) => [r.hash, r.content_type])) : new Map();
  return {
    apiVersion: 'otoroshi-apim.io/v1',
    kind: PORTAL_KIND,
    metadata: { name: ws.slug },
    spec: { ...draft, assets: Object.entries(draft.assets).map(([path, hash]) => ({ path, hash, contentType: types.get(hash) || null })) },
  };
}

// a document applied: its assets stored (given inline) or found (given by digest), its draft written;
// a file it names is the client's to inline (the cli, a remote catalog)
export async function applyPortalDocument(ctx, ws, doc, { managedBy = null, publish = false, comment = '' } = {}) {
  if (doc?.kind !== PORTAL_KIND) throw badRequest(`expected kind ${PORTAL_KIND}`);
  if (doc.metadata?.name && doc.metadata.name !== ws.slug) throw badRequest(`this document is the portal of ${doc.metadata.name}, not of ${ws.slug}`);
  if (ws.portal?.designManagedBy && managedBy && ws.portal.designManagedBy !== managedBy) throw badRequest(`the design of this portal is managed by ${ws.portal.designManagedBy}, not ${managedBy}`);
  const spec = isObject(doc.spec) ? doc.spec : {};
  const assets = {};
  for (const a of Array.isArray(spec.assets) ? spec.assets : []) {
    if (a?.file) throw badRequest(`asset ${a.path}: it is a file — the client that holds the file inlines it (apim portal push, a remote catalog do)`);
    if (a?.data) assets[a.path] = (await storeAsset(ctx, ws, a)).hash;
    else assets[a?.path] = a?.hash;
  }
  const fileLeft = JSON.stringify({ ...spec, assets: [] }).includes('"file":');
  if (fileLeft) throw badRequest('the document names files — the client that holds the files inlines them (apim portal push, a remote catalog do)');
  const next = normalizeDesign({ ...emptyDesign(), ...spec, assets });
  await requireAssets(ws.id, next.assets);
  const current = await draftOf(ws);
  const changed = diff(current, next).length > 0;
  await db`update workspaces set portal_design = ${next}, portal = ${{ ...(await workspaceRow(ws)).portal, designManagedBy: managedBy || null }}, updated_at = now() where id = ${ws.id}`;
  if (changed) await audit(ctx, { action: 'portal.design.apply', workspaceId: ws.id, entityKind: 'portal', entityId: ws.id, summary: `portal design applied${managedBy ? ` by ${managedBy}` : ''}`, data: { changes: diff(current, next).slice(0, 50) } });
  const out = { action: changed ? 'updated' : 'unchanged' };
  if (publish) {
    const last = await lastVersion(ws.id);
    if (!last || diff(normalizeDesign(last.design), next).length) out.version = (await publishDesign(ctx, { ...ws, portal: { ...ws.portal, designManagedBy: managedBy || null } }, { comment: comment || 'apply' })).number;
    else out.version = 'unchanged';
  }
  return out;
}
