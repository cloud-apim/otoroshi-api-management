// What changes from one environment to the next stays out of the product. A snapshot carries an
// Otoroshi vault reference — `${vault://local/<path>}`, `${vault://env/<NAME>}` — and each cluster
// resolves its own value: a promoted snapshot is the very same document in every installation.
//
// The `local` vault reads the `env` object of the gateway's global config, which the admin api
// serves: those references can be checked, and resolved for what the product shows (the base url
// of an api, the host of a test call). The other vaults live on the gateway nodes.

import { oto } from './client.js';

const REF = /\$\{vault:\/\/([^/}]+)\/([^}]+)\}/g;

// the references of a document, each once
export function vaultRefs(doc) {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc ?? null);
  const out = new Map();
  for (const m of text.matchAll(REF)) if (!out.has(m[0])) out.set(m[0], { ref: m[0], vault: m[1], path: m[2] });
  return [...out.values()];
}

let cached = null;
async function localEnv() {
  if (cached && cached.at > Date.now() - 30000) return cached.env;
  const env = (await oto.globalConfig().catch(() => null))?.env || {};
  cached = { at: Date.now(), env };
  return env;
}

export function invalidateLocalEnv() {
  cached = null;
}

// a path read as the local vault reads it: a JSON pointer into the env object
function lookup(env, path) {
  let cur = env;
  for (const part of path.split('/').map((s) => s.trim()).filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  if (cur === undefined) return undefined;
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

// a value with its local references resolved by this gateway; the others are left as they are
export async function resolveLocal(value) {
  if (typeof value !== 'string' || !value.includes('${vault://local/')) return value;
  const env = await localEnv();
  return value.replace(REF, (whole, vault, path) => (vault === 'local' ? (lookup(env, path) ?? whole) : whole));
}

// the references of a document, as this gateway resolves them
export async function checkRefs(refs) {
  const env = refs.some((r) => r.vault === 'local') ? await localEnv() : {};
  return refs.map((r) => ({ ...r, status: r.vault !== 'local' ? 'unverifiable' : lookup(env, r.path) === undefined ? 'missing' : 'resolved' }));
}
