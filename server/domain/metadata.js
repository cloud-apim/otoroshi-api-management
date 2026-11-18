// One metadata mechanism, with the scope as a parameter: same model, same screen, same api
// for a workspace, an api, a plan, a subscription or an application. Fields are typed — the type
// drives rendering and validation — and values are never projected on the gateway.

import { db, newId } from '../db/index.js';
import { badRequest } from '../http/router.js';
import { audit } from './audit.js';

export const SCOPES = ['workspace', 'api', 'plan', 'subscription', 'application'];
export const TYPES = ['string', 'text', 'number', 'boolean', 'date', 'url', 'email', 'enum'];

export async function listFields(workspaceId, scope = null) {
  return db`select * from metadata_fields where workspace_id = ${workspaceId}
    and (${scope}::text is null or scope = ${scope}) order by scope, position, key`;
}

// the whole set is replaced at once: the field list is a document the admin edits
export async function saveFields(ctx, workspaceId, fields) {
  if (!Array.isArray(fields)) throw badRequest('expected a list of fields');
  const seen = new Set();
  for (const f of fields) {
    if (!SCOPES.includes(f.scope)) throw badRequest(`unknown scope ${f.scope}`);
    if (!TYPES.includes(f.type || 'string')) throw badRequest(`unknown type ${f.type}`);
    if (!/^[a-z][a-z0-9_.-]*$/.test(f.key || '')) throw badRequest(`invalid key "${f.key}": lowercase letters, digits, _ . -`);
    if (seen.has(`${f.scope}:${f.key}`)) throw badRequest(`duplicate key ${f.scope}:${f.key}`);
    if (f.type === 'enum' && !(f.options || []).length) throw badRequest(`enum field ${f.key} needs options`);
    seen.add(`${f.scope}:${f.key}`);
  }
  await db.begin(async (tx) => {
    await tx`delete from metadata_fields where workspace_id = ${workspaceId}`;
    for (const [i, f] of fields.entries()) {
      await tx`insert into metadata_fields (id, workspace_id, scope, key, label, type, options, required, portal, help, position)
        values (${f.id || newId('mf')}, ${workspaceId}, ${f.scope}, ${f.key}, ${f.label || f.key}, ${f.type || 'string'}, ${f.options || []},
          ${!!f.required}, ${!!f.portal}, ${f.help || ''}, ${f.position ?? i})`;
    }
  });
  await audit(ctx, { action: 'metadata.fields.update', workspaceId, entityKind: 'workspace', entityId: workspaceId, summary: `${fields.length} metadata fields defined` });
  return listFields(workspaceId);
}

function coerce(f, v) {
  if (v === undefined || v === null || v === '') return null;
  switch (f.type) {
    case 'number': {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error('must be a number');
      return n;
    }
    case 'boolean':
      return v === true || v === 'true';
    case 'date':
      if (Number.isNaN(new Date(v).getTime())) throw new Error('must be a date');
      return String(v).slice(0, 10);
    case 'url':
      try {
        new URL(v);
      } catch (e) {
        throw new Error('must be a url');
      }
      return String(v);
    case 'email':
      if (!/^[^@\s]+@[^@\s]+$/.test(v)) throw new Error('must be an email');
      return String(v);
    case 'enum':
      if (!f.options.includes(v)) throw new Error(`must be one of ${f.options.join(', ')}`);
      return v;
    default:
      return String(v);
  }
}

// validates the declared keys and keeps the undeclared ones untouched (an escape hatch must not
// destroy what it does not know). `only` restricts to a subset (e.g. the fields a requester fills).
export function validateValues(fields, values = {}, { only = null, requireAll = true } = {}) {
  const out = { ...(values || {}) };
  const errors = [];
  for (const f of fields) {
    if (only && !only(f)) continue;
    try {
      const v = coerce(f, values?.[f.key]);
      if (v === null) {
        delete out[f.key];
        if (f.required && requireAll) errors.push({ key: f.key, message: `${f.label} is required` });
      } else out[f.key] = v;
    } catch (e) {
      errors.push({ key: f.key, message: `${f.label} ${e.message}` });
    }
  }
  return { values: out, errors };
}

export async function checkValues(workspaceId, scope, values, opts) {
  const fields = await listFields(workspaceId, scope);
  const res = validateValues(fields, values, opts);
  if (res.errors.length) throw badRequest(`invalid metadata: ${res.errors.map((e) => e.message).join(', ')}`, { errors: res.errors });
  return res.values;
}
