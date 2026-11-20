// Remote catalogs: an external source — HTTP or git — becomes the source of truth of a set
// of apis, reconciled periodically, in the manner of Otoroshi's remote catalogs.
//
// - every api a catalog writes is marked `managed_by = catalog:<id>`: the console refuses to edit it, the source is where it changes;
// - what a sync does is explicit, per catalog: `draft` writes the drafts only,
//   `publish` freezes snapshots, `deploy` also projects them on the gateway;
// - a preview (dry run) shows what a sync would change before any mass projection;
// - apis that disappeared from the source are reported, and only removed if the catalog prunes.

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { db, newId } from '../db/index.js';
import { badRequest, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { openValues, sealValues } from './secrets.js';
import { diff } from './diff.js';
import { normalizeDraft } from './model.js';
import { API_KIND, apiDocument, applyApiDocument } from './exchange.js';

export const MODES = ['draft', 'publish', 'deploy'];

// the headers of a catalog (a token of the git host...) are sealed at rest
const opened = (c) => c && { ...c, headers: openValues(c.headers) };

export async function listCatalogs(workspaceId) {
  return (await db`select * from remote_catalogs where workspace_id = ${workspaceId} order by name`).map(opened);
}

export async function getCatalog(workspaceId, id) {
  const rows = await db`select * from remote_catalogs where workspace_id = ${workspaceId} and id = ${id}`;
  if (!rows[0]) throw notFound('catalog not found');
  return opened(rows[0]);
}

export const KINDS = ['http', 'git', 's3'];

function checkInput(input) {
  if (!KINDS.includes(input.kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
  if (!input.url) throw badRequest('url is required');
  if (input.kind === 's3' && !/^s3:\/\/[^/]+/.test(input.url)) throw badRequest('the url of an s3 catalog is s3://<bucket>[/<prefix>]');
  if (input.mode && !MODES.includes(input.mode)) throw badRequest(`mode must be one of ${MODES.join(', ')}`);
}

// an object store: its endpoint (empty for AWS) and its region
const optionsOf = (c) => (c.kind === 's3' ? { endpoint: c.options?.endpoint || '', region: c.options?.region || '' } : {});

export async function createCatalog(ctx, workspaceId, input) {
  checkInput(input);
  const id = newId('cat');
  const rows = await db`insert into remote_catalogs (id, workspace_id, name, kind, url, ref, path, headers, options, mode, prune, interval_seconds, enabled)
    values (${id}, ${workspaceId}, ${input.name || input.url}, ${input.kind}, ${input.url}, ${input.ref || null}, ${input.path || null},
      ${sealValues(input.headers)}, ${optionsOf(input)}, ${input.mode || 'draft'}, ${!!input.prune}, ${input.interval_seconds || 300}, ${input.enabled !== false}) returning *`;
  await audit(ctx, { action: 'catalog.create', workspaceId, entityKind: 'catalog', entityId: id, summary: `remote catalog ${rows[0].name} (${input.kind}) created` });
  return opened(rows[0]);
}

export async function updateCatalog(ctx, cat, patch) {
  const next = { ...cat, ...patch };
  checkInput(next);
  const rows = await db`update remote_catalogs set name = ${next.name}, kind = ${next.kind}, url = ${next.url}, ref = ${next.ref || null},
      path = ${next.path || null}, headers = ${sealValues(next.headers)}, options = ${optionsOf(next)}, mode = ${next.mode}, prune = ${!!next.prune},
      interval_seconds = ${next.interval_seconds || 300}, enabled = ${next.enabled !== false}, updated_at = now()
    where id = ${cat.id} returning *`;
  await audit(ctx, { action: 'catalog.update', workspaceId: cat.workspace_id, entityKind: 'catalog', entityId: cat.id, summary: `remote catalog ${next.name} updated` });
  return opened(rows[0]);
}

export async function deleteCatalog(ctx, cat) {
  // the apis stay, released: they become editable by hand again
  await db`update apis set managed_by = null where managed_by = ${`catalog:${cat.id}`}`;
  await db`delete from remote_catalogs where id = ${cat.id}`;
  await audit(ctx, { action: 'catalog.delete', workspaceId: cat.workspace_id, entityKind: 'catalog', entityId: cat.id, summary: `remote catalog ${cat.name} deleted, its apis released` });
}

// ---------------------------------------------------------------- fetching the source

function parseDocuments(text, name = '') {
  const t = text.trim();
  if (!t) return [];
  if (name.endsWith('.json') || t.startsWith('[') || t.startsWith('{')) {
    const d = JSON.parse(t);
    return Array.isArray(d) ? d : d.items || [d];
  }
  return YAML.parseAllDocuments(t)
    .map((d) => d.toJSON())
    .filter(Boolean)
    .flatMap((d) => (Array.isArray(d) ? d : d.items ? d.items : [d]));
}

async function fetchHttp(cat) {
  const res = await fetch(cat.url, { headers: cat.headers || {}, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${cat.url} answered ${res.status}`);
  const docs = parseDocuments(await res.text(), cat.url);
  return { docs, revision: res.headers.get('etag') || res.headers.get('last-modified') || null };
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ya?ml|json)$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function fetchGit(cat) {
  if (!Bun.which('git')) throw new Error('git is not available on this instance');
  const dir = await mkdtemp(join(tmpdir(), 'apim-catalog-'));
  try {
    const args = ['clone', '--depth', '1', '--quiet'];
    if (cat.ref) args.push('--branch', cat.ref);
    args.push(cat.url, dir);
    const clone = Bun.spawn(['git', ...args], { stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if ((await clone.exited) !== 0) throw new Error(`git clone failed: ${(await new Response(clone.stderr).text()).trim()}`);
    const rev = Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim();
    const root = cat.path ? join(dir, cat.path) : dir;
    if (relative(dir, root).startsWith('..')) throw new Error('the catalog path leaves the repository');
    await stat(root);
    const docs = [];
    for (const f of await walk(root)) {
      for (const d of parseDocuments(await readFile(f, 'utf8'), f)) docs.push({ ...d, _source: relative(dir, f) });
    }
    return { docs, revision: rev };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// an object store (S3, or one that speaks its api): every yaml and json object under the prefix of
// the url; the credentials are the access key id and secret kept with the headers, sealed at rest.
// The revision is the digest of the keys and their etags: it changes when an object does.
export async function fetchS3(cat) {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(cat.url);
  if (!m) throw new Error('the url of an s3 catalog is s3://<bucket>[/<prefix>]');
  const [, bucket, prefix] = m;
  const h = cat.headers || {};
  const client = new Bun.S3Client({
    bucket,
    ...(cat.options?.endpoint ? { endpoint: cat.options.endpoint } : {}),
    ...(cat.options?.region ? { region: cat.options.region } : {}),
    ...(h.access_key_id ? { accessKeyId: h.access_key_id, secretAccessKey: h.secret_access_key } : {}),
  });
  const objects = [];
  let token;
  do {
    const page = await client.list({ prefix, ...(token ? { continuationToken: token } : {}) });
    objects.push(...(page.contents || []));
    token = page.isTruncated ? page.nextContinuationToken : null;
  } while (token);
  const files = objects.filter((o) => /\.(ya?ml|json)$/.test(o.key) && !o.key.split('/').some((s) => s.startsWith('.'))).sort((a, b) => a.key.localeCompare(b.key));
  const docs = [];
  for (const o of files) for (const d of parseDocuments(await client.file(o.key).text(), o.key)) docs.push({ ...d, _source: o.key });
  const revision = new Bun.CryptoHasher('sha256').update(files.map((o) => `${o.key}:${o.eTag}`).join('\n')).digest('hex').slice(0, 16);
  return { docs, revision };
}

async function fetchSource(cat) {
  const res = cat.kind === 'git' ? await fetchGit(cat) : cat.kind === 's3' ? await fetchS3(cat) : await fetchHttp(cat);
  // only api documents are reconciled; anything else in the source is reported, not guessed at
  const apis = res.docs.filter((d) => d?.kind === API_KIND);
  const ignored = res.docs.length - apis.length;
  return { ...res, apis, ignored };
}

// ---------------------------------------------------------------- preview and sync

function specOf(doc) {
  const s = doc.spec || {};
  return { name: s.name, description: s.description || '', tags: s.tags || [], visibility: s.visibility || 'public', acl: s.acl || [], draft: normalizeDraft(s.draft || {}), pages: (s.pages || []).map(({ slug, title, content }) => ({ slug, title, content })) };
}

// what a sync would do, without writing anything
export async function preview(cat, fetched = null) {
  const src = fetched || (await fetchSource(cat));
  const ws = (await db`select * from workspaces where id = ${cat.workspace_id}`)[0];
  const marker = `catalog:${cat.id}`;
  const items = [];
  const seen = new Set();
  for (const doc of src.apis) {
    const slug = doc.metadata?.name;
    const version = doc.metadata?.version || '1.0.0';
    seen.add(`${slug}@${version}`);
    const existing = (await db`select * from apis where workspace_id = ${ws.id} and slug = ${slug} and version = ${version}`)[0];
    if (!existing) {
      items.push({ slug, version, action: 'create', source: doc._source || null });
      continue;
    }
    if (existing.managed_by && existing.managed_by !== marker) {
      items.push({ slug, version, action: 'conflict', reason: `managed by ${existing.managed_by}` });
      continue;
    }
    const current = await apiDocument(existing);
    const changes = diff(specOf(current), specOf(doc));
    items.push({ slug, version, action: changes.length ? 'update' : 'unchanged', changes: changes.slice(0, 30), adopt: !existing.managed_by, source: doc._source || null });
  }
  const managed = await db`select slug, version from apis where workspace_id = ${ws.id} and managed_by = ${marker}`;
  for (const m of managed) if (!seen.has(`${m.slug}@${m.version}`)) items.push({ slug: m.slug, version: m.version, action: cat.prune ? 'delete' : 'orphaned' });
  return { revision: src.revision, ignored: src.ignored, mode: cat.mode, items, docs: src.apis };
}

export async function sync(ctx, cat, { deployments, apis }) {
  const started = Date.now();
  const marker = `catalog:${cat.id}`;
  const ws = (await db`select * from workspaces where id = ${cat.workspace_id}`)[0];
  const sysCtx = { ...ctx, via: ctx?.via || `catalog:${cat.id}`, workspace: ws };
  let result;
  try {
    const plan = await preview(cat, await fetchSource(cat));
    const out = [];
    for (const item of plan.items) {
      if (['unchanged', 'conflict', 'orphaned'].includes(item.action)) {
        out.push(item);
        continue;
      }
      try {
        if (item.action === 'delete') {
          const api = await apis.getApi(ws.id, item.slug);
          if ((await deployments.deploymentStatus(api)).on_gateway) await deployments.purgeFromGateway(api);
          await apis.deleteApiRow(sysCtx, api);
          out.push(item);
          continue;
        }
        const doc = plan.docs.find((d) => d.metadata?.name === item.slug && (d.metadata?.version || '1.0.0') === item.version);
        const res = await applyApiDocument(sysCtx, ws, doc, { managedBy: marker });
        if (cat.mode !== 'draft') {
          const api = await apis.getApi(ws.id, res.api.id);
          const pending = await apis.pendingChanges(api);
          if (pending.hasChanges) {
            const pub = await apis.publish(sysCtx, api, { comment: `catalog ${cat.name}${plan.revision ? ` @ ${String(plan.revision).slice(0, 12)}` : ''}` });
            item.snapshot = pub.snapshot.number;
            if (cat.mode === 'deploy') {
              const dep = await deployments.deploy(sysCtx, await apis.getApi(ws.id, api.id), { snapshot: pub.snapshot.id });
              item.deployment = dep.deployment.status;
            }
          }
        }
        out.push(item);
      } catch (e) {
        out.push({ ...item, action: 'error', error: e.details?.errors?.map((x) => x.message).join(', ') || e.message });
      }
    }
    result = { ok: !out.some((i) => i.action === 'error'), at: new Date().toISOString(), revision: plan.revision, ignored: plan.ignored, items: out, durationMs: Date.now() - started };
  } catch (e) {
    result = { ok: false, at: new Date().toISOString(), error: e.message, items: [], durationMs: Date.now() - started };
  }
  await db`update remote_catalogs set last_sync = ${result}, last_sync_at = now() where id = ${cat.id}`;
  const changed = result.items.filter((i) => !['unchanged', 'orphaned'].includes(i.action));
  if (changed.length || !result.ok)
    await audit(sysCtx, { action: 'catalog.sync', workspaceId: ws.id, entityKind: 'catalog', entityId: cat.id, summary: `catalog ${cat.name}: ${result.ok ? `${changed.length} change(s)` : `failed: ${result.error || 'see items'}`}`, data: result });
  return result;
}

export async function syncDue(deps) {
  const due = await db`select * from remote_catalogs where enabled = true
    and (last_sync_at is null or last_sync_at < now() - make_interval(secs => interval_seconds))`;
  for (const cat of due.map(opened)) await sync({ via: 'catalog-scheduler' }, cat, deps).catch((e) => console.error('[apim] catalog sync failed', e.message));
}
