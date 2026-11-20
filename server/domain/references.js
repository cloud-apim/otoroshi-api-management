// The references of a declarative document to the shared objects of its workspace — the policy group
// a flow pins, the shared resource a plan pins — are written by name, so that a document moves from
// one installation to the next: the ids are each installation's own. The product keeps ids; a
// document says names (an id is accepted too, as for a team).

import { db } from '../db/index.js';
import { badRequest, conflict } from '../http/router.js';

const KINDS = {
  group: { table: 'policy_groups', label: 'policy group' },
  resource: { table: 'resources', label: 'shared resource' },
};

async function byNameOrId(kind, workspaceId, ref) {
  const { table, label } = KINDS[kind];
  const rows = await db`select id, name from ${db(table)} where workspace_id = ${workspaceId} and (id = ${ref} or name = ${ref})`;
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  if (rows.length > 1) throw badRequest(`several ${label}s are named ${ref}: name them apart, or reference it by its id`);
  if (!rows.length) throw badRequest(`unknown ${label} ${ref}`);
  return rows[0];
}

async function namesOf(table, ids) {
  if (!ids.length) return new Map();
  return new Map((await db`select id, name from ${db(table)} where id in ${db(ids)}`).map((r) => [r.id, r.name]));
}

// the draft with the ids of the product: what the document names, or already identifies
export async function refsToIds(workspaceId, draft) {
  const flows = [];
  for (const f of draft?.flows || []) {
    const plugins = [];
    for (const p of f.plugins || []) plugins.push(p.group ? { ...p, group: (await byNameOrId('group', workspaceId, p.group)).id } : p);
    flows.push({ ...f, plugins });
  }
  const plans = [];
  for (const p of draft?.plans || []) {
    const shared = p.auth?.config?.sharedResource;
    const ref = shared?.id || shared?.name;
    if (!ref) {
      plans.push(p);
      continue;
    }
    const { name, ...pin } = shared;
    plans.push({ ...p, auth: { ...p.auth, config: { ...p.auth.config, sharedResource: { ...pin, id: (await byNameOrId('resource', workspaceId, ref)).id } } } });
  }
  return { ...draft, ...(draft?.flows ? { flows } : {}), ...(draft?.plans ? { plans } : {}) };
}

// the draft as a document says it: the names of what it pins, the version pinned
export async function refsToNames(draft) {
  const groupIds = [...new Set((draft?.flows || []).flatMap((f) => (f.plugins || []).filter((p) => p.group).map((p) => p.group)))];
  const resourceIds = [...new Set((draft?.plans || []).map((p) => p.auth?.config?.sharedResource?.id).filter(Boolean))];
  const [groups, resources] = await Promise.all([namesOf('policy_groups', groupIds), namesOf('resources', resourceIds)]);
  return {
    ...draft,
    flows: (draft?.flows || []).map((f) => ({ ...f, plugins: (f.plugins || []).map((p) => (p.group && groups.has(p.group) ? { ...p, group: groups.get(p.group) } : p)) })),
    plans: (draft?.plans || []).map((p) => {
      const shared = p.auth?.config?.sharedResource;
      if (!shared?.id || !resources.has(shared.id)) return p;
      const { id, ...pin } = shared;
      return { ...p, auth: { ...p.auth, config: { ...p.auth.config, sharedResource: { name: resources.get(id), ...pin } } } };
    }),
  };
}

// a name names one object of its kind in a workspace
export async function requireFreeName(kind, workspaceId, name, exceptId = null) {
  const { table, label } = KINDS[kind];
  const taken = await db`select id from ${db(table)} where workspace_id = ${workspaceId} and name = ${name} and id <> ${exceptId || ''}`;
  if (taken.length) throw conflict(`a ${label} is already named ${name}: the declarative documents reference it by its name`);
}
