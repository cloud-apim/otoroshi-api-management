// Dictionaries: a named set of values a workspace gives to the expression language of the gateway —
// a list of partners, the limits of a country, the url of a backend per region — static, or refreshed
// from an external source. The product names it, refreshes it and projects it; it creates no gateway
// capability: the values land in the global env of the gateway, under `apim.dictionaries`, where the
// expression language reads them (`${global_config.env.apim.dictionaries.<workspace>.<name>.<key>}`).
//
// Never in the request path: the gateway reads its own config; the product refreshes and projects
// through the task queue, and a source that cannot be reached keeps the last values it gave.

import { db, newId } from '../db/index.js';
import { badRequest, conflict, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { diff } from './diff.js';
import { enqueue, registerTaskHandler, PermanentError } from './tasks.js';
import { open, seal } from './secrets.js';
import { oto } from '../otoroshi/client.js';

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_BYTES = 256 * 1024;
const ROOT = ['apim', 'dictionaries'];

// the expression that reads a value of a dictionary in a plugin of the gateway
export const expressionOf = (workspaceSlug, name, key = '<key>') => `\${global_config.env.${ROOT.join('.')}.${workspaceSlug}.${name}.${key}}`;

// the values: an object whose keys hold no dot (the expression language reads a path of dots), its
// values strings, numbers, booleans, or objects of the same
export function normalizeEntries(entries, path = '') {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw badRequest(`the values of a dictionary${path ? ` at ${path}` : ''} are an object`);
  const out = {};
  for (const [k, v] of Object.entries(entries)) {
    if (!k || k.includes('.')) throw badRequest(`the key "${k}"${path ? ` at ${path}` : ''} is empty or holds a dot: the expression language reads a path of dots`);
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (typeof v === 'object' && !Array.isArray(v)) out[k] = normalizeEntries(v, path ? `${path}.${k}` : k);
    else out[k] = JSON.stringify(v);
  }
  if (!path && Buffer.byteLength(JSON.stringify(out)) > MAX_BYTES) throw badRequest(`a dictionary holds ${MAX_BYTES / 1024} KB at most`);
  return out;
}

// where the values come from: given in the product, or an url answering json, refreshed every few
// minutes, the object at a json pointer of the answer
function normalizeSource(source = {}, previous = {}) {
  if (!source || source.kind === 'static' || !source.kind) return { kind: 'static' };
  if (source.kind !== 'url') throw badRequest('the source of a dictionary is static or an url');
  let url;
  try {
    url = new URL(String(source.url || ''));
  } catch (e) {
    throw badRequest('the source of the dictionary needs an url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('the source of a dictionary is an http(s) url');
  const every = Number(source.everySeconds ?? 300);
  if (!Number.isInteger(every) || every < 30 || every > 86400) throw badRequest('a dictionary is refreshed every 30 seconds to 24 hours');
  // the headers of the source (a token) are a secret: sealed at rest, kept when given masked
  const headers = {};
  for (const [k, v] of Object.entries(source.headers || {})) headers[k] = String(v).includes('••') ? previous.headers?.[k] || '' : seal(String(v));
  return { kind: 'url', url: url.toString(), everySeconds: every, pointer: String(source.pointer || ''), headers };
}

const masked = (d) => ({
  ...d,
  source: d.source?.kind === 'url' ? { ...d.source, headers: Object.fromEntries(Object.keys(d.source.headers || {}).map((k) => [k, '••••••'])) } : d.source,
});

export async function listDictionaries(workspaceId) {
  return (await db`select * from dictionaries where workspace_id = ${workspaceId} order by name`).map(masked);
}

async function rowOf(workspaceId, id) {
  const rows = await db`select * from dictionaries where workspace_id = ${workspaceId} and (id = ${id} or name = ${id})`;
  if (!rows[0]) throw notFound('dictionary not found');
  return rows[0];
}

export async function getDictionary(workspaceId, id) {
  return masked(await rowOf(workspaceId, id));
}

const project = (d) => enqueue('project_dictionary', { dictionary_id: d.id }, { dedupeKey: `dictionary:${d.id}` }).catch(() => null);

export async function createDictionary(ctx, workspaceId, input = {}) {
  const name = String(input.name || '').trim();
  if (!NAME.test(name)) throw badRequest('the name of a dictionary is made of lowercase letters, digits, dashes and underscores: the expression language reads it');
  if ((await db`select 1 from dictionaries where workspace_id = ${workspaceId} and name = ${name}`).length) throw conflict(`a dictionary is already named ${name}`);
  const source = normalizeSource(input.source);
  const entries = source.kind === 'static' ? normalizeEntries(input.entries || {}) : {};
  const id = newId('dict');
  const [row] = await db`insert into dictionaries (id, workspace_id, name, description, source, entries, projection, created_by)
    values (${id}, ${workspaceId}, ${name}, ${String(input.description || '')}, ${source}, ${entries}, ${{ status: 'pending' }}, ${ctx.user?.id || null}) returning *`;
  await audit(ctx, { action: 'dictionary.create', workspaceId, entityKind: 'dictionary', entityId: id, summary: `dictionary ${name} created` });
  if (source.kind === 'url') await refresh(row).catch(() => null);
  else await project(row);
  return getDictionary(workspaceId, id);
}

export async function updateDictionary(ctx, d, input = {}) {
  const row = await rowOf(d.workspace_id, d.id);
  const source = input.source === undefined ? row.source : normalizeSource(input.source, row.source);
  const entries = source.kind === 'static' ? (input.entries === undefined ? row.entries : normalizeEntries(input.entries)) : row.entries;
  const [next] = await db`update dictionaries set description = ${input.description === undefined ? row.description : String(input.description)},
      source = ${source}, entries = ${entries}, updated_at = now() where id = ${row.id} returning *`;
  await audit(ctx, { action: 'dictionary.update', workspaceId: row.workspace_id, entityKind: 'dictionary', entityId: row.id, summary: `dictionary ${row.name} updated`, data: { changes: diff(row.entries, next.entries).slice(0, 50) } });
  if (source.kind === 'url' && (row.source?.kind !== 'url' || row.source.url !== source.url || row.source.pointer !== source.pointer)) await refresh(next).catch(() => null);
  else await project(next);
  return getDictionary(row.workspace_id, row.id);
}

export async function deleteDictionary(ctx, d) {
  const ws = (await db`select slug from workspaces where id = ${d.workspace_id}`)[0];
  await db`delete from dictionaries where id = ${d.id}`;
  await audit(ctx, { action: 'dictionary.delete', workspaceId: d.workspace_id, entityKind: 'dictionary', entityId: d.id, summary: `dictionary ${d.name} deleted` });
  await enqueue('unproject_dictionary', { workspace: ws?.slug, name: d.name }, { dedupeKey: `dictionary:${d.id}:gone` }).catch(() => null);
}

// the json pointer of the source: the object the values are taken from
function at(doc, pointer) {
  if (!pointer || pointer === '/') return doc;
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), doc);
}

// the values read again from the source; a source that fails keeps the last values it gave
export async function refresh(d) {
  if (d.source?.kind !== 'url') return d;
  const headers = Object.fromEntries(Object.entries(d.source.headers || {}).map(([k, v]) => [k, open(v)]));
  let entries;
  let error = null;
  try {
    const res = await fetch(d.source.url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`the source answered ${res.status}`);
    entries = normalizeEntries(at(await res.json(), d.source.pointer));
  } catch (e) {
    error = e.message;
  }
  const refreshed = { at: new Date().toISOString(), status: error ? 'error' : 'ok', error };
  const [row] = error
    ? await db`update dictionaries set refreshed = ${refreshed} where id = ${d.id} returning *`
    : await db`update dictionaries set entries = ${entries}, refreshed = ${refreshed}, updated_at = case when entries = ${entries} then updated_at else now() end where id = ${d.id} returning *`;
  if (!error && diff(d.entries || {}, entries).length) await project(row);
  else if (!error && row.projection?.status !== 'synced') await project(row);
  return row;
}

// the dictionaries whose source is due
export async function refreshSweep() {
  const due = await db`select * from dictionaries where source->>'kind' = 'url'
    and (refreshed->>'at' is null or (refreshed->>'at')::timestamptz < now() - make_interval(secs => (source->>'everySeconds')::int))`;
  for (const d of due) await refresh(d).catch(() => null);
  return due.length;
}

// ---------------------------------------------------------------- projection

const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

// the values of every dictionary of the gateway, as its global env holds them
async function gatewayDictionaries() {
  const gc = await oto.globalConfig();
  return { gc, all: gc?.env?.apim?.dictionaries || {} };
}

// the patch that sets the values of a dictionary, creating the path to it when it is missing
function setOps(gc, wsSlug, name, entries) {
  const ops = [];
  let node = gc || {};
  const path = ['env', ...ROOT, wsSlug];
  let pointer = '';
  for (const k of path) {
    pointer += `/${esc(k)}`;
    node = node && typeof node === 'object' ? node[k] : undefined;
    if (node === undefined || node === null || typeof node !== 'object') {
      ops.push({ op: 'add', path: pointer, value: {} });
      node = {};
    }
  }
  ops.push({ op: 'add', path: `${pointer}/${esc(name)}`, value: entries });
  return ops;
}

registerTaskHandler('project_dictionary', async ({ dictionary_id }) => {
  const d = (await db`select d.*, w.slug as workspace_slug from dictionaries d join workspaces w on w.id = d.workspace_id where d.id = ${dictionary_id}`)[0];
  if (!d) return { skipped: 'deleted' };
  try {
    const { gc } = await gatewayDictionaries();
    if (!gc) throw new PermanentError('the global config of the gateway cannot be read: the key of the product is not a super admin key');
    await oto.patchGlobalConfig(setOps(gc, d.workspace_slug, d.name, d.entries));
  } catch (e) {
    await db`update dictionaries set projection = ${{ status: 'error', error: e.message, at: new Date().toISOString() }} where id = ${d.id}`;
    if (e.status === 401 || e.status === 403) throw new PermanentError(`the key of the product cannot change the global config of the gateway (${e.status}): a super admin key is needed`);
    throw e;
  }
  await db`update dictionaries set projection = ${{ status: 'synced', synced_at: new Date().toISOString(), error: null }} where id = ${d.id}`;
  return { projected: d.name };
});

registerTaskHandler('unproject_dictionary', async ({ workspace, name }) => {
  const { all } = await gatewayDictionaries();
  if (!all?.[workspace] || !(name in all[workspace])) return { skipped: 'not on the gateway' };
  // the last dictionary of a workspace takes its entry with it
  const last = Object.keys(all[workspace]).length === 1;
  await oto.patchGlobalConfig([{ op: 'remove', path: `/env/${ROOT.map(esc).join('/')}/${esc(workspace)}${last ? '' : `/${esc(name)}`}` }]);
  return { removed: name };
});

// what the gateway holds of each dictionary of a workspace: in sync, drifted (changed on the gateway,
// or not projected yet), missing
export async function gatewayState(workspaceSlug, list) {
  const { all } = await gatewayDictionaries().catch(() => ({ all: null }));
  if (!all) return Object.fromEntries(list.map((d) => [d.id, 'unknown']));
  const mine = all[workspaceSlug] || {};
  return Object.fromEntries(list.map((d) => [d.id, !(d.name in mine) ? 'missing' : diff(d.entries || {}, mine[d.name] || {}).length ? 'drifted' : 'in_sync']));
}
