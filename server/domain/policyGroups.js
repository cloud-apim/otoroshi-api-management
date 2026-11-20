// Shared policy groups: the product names a composition of Otoroshi plugins so that it can
// be governed — "here is our company policy" — instead of being rebuilt by hand on thirty apis.
//
// It creates no gateway capability: a group is projected inline, in the flows of the apis that
// use it. An api pins a published version; publishing a group never republishes the apis that
// reference it — their snapshots are immutable. The console shows which apis lag behind.

import { db, newId } from '../db/index.js';
import { badRequest, conflict, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { diff } from './diff.js';
import { requireFreeName } from './references.js';

function normalizePlugins(plugins) {
  return (Array.isArray(plugins) ? plugins : []).map((p) => ({
    plugin: p.plugin,
    enabled: p.enabled !== false,
    include: Array.isArray(p.include) ? p.include : [],
    exclude: Array.isArray(p.exclude) ? p.exclude : [],
    config: p.config || {},
  }));
}

export async function listGroups(workspaceId) {
  return db`select g.*, (select max(number) from policy_group_versions v where v.group_id = g.id) as last_version
    from policy_groups g where g.workspace_id = ${workspaceId} order by g.name`;
}

export async function getGroup(workspaceId, id) {
  const rows = await db`select g.*, (select max(number) from policy_group_versions v where v.group_id = g.id) as last_version
    from policy_groups g where g.workspace_id = ${workspaceId} and g.id = ${id}`;
  if (!rows[0]) throw notFound('policy group not found');
  return rows[0];
}

export async function createGroup(ctx, workspaceId, { name, description = '', plugins = [] }) {
  if (!name) throw badRequest('name is required');
  await requireFreeName('group', workspaceId, name);
  const id = newId('pg');
  const rows = await db`insert into policy_groups (id, workspace_id, name, description, draft)
    values (${id}, ${workspaceId}, ${name}, ${description}, ${{ plugins: normalizePlugins(plugins) }}) returning *`;
  await audit(ctx, { action: 'policy_group.create', workspaceId, entityKind: 'policy_group', entityId: id, summary: `policy group ${name} created` });
  return rows[0];
}

export async function updateGroup(ctx, group, patch) {
  if (patch.name && patch.name !== group.name) await requireFreeName('group', group.workspace_id, patch.name, group.id);
  const draft = patch.plugins ? { plugins: normalizePlugins(patch.plugins) } : group.draft;
  const rows = await db`update policy_groups set name = ${patch.name ?? group.name}, description = ${patch.description ?? group.description},
    draft = ${draft}, updated_at = now() where id = ${group.id} returning *`;
  await audit(ctx, { action: 'policy_group.update', workspaceId: group.workspace_id, entityKind: 'policy_group', entityId: group.id, summary: `draft of policy group ${rows[0].name} updated` });
  return rows[0];
}

export async function publishGroup(ctx, group, { comment = '' } = {}) {
  if (!group.draft.plugins?.length) throw badRequest('an empty group cannot be published');
  const last = (await db`select * from policy_group_versions where group_id = ${group.id} order by number desc limit 1`)[0];
  if (last && diff(last.plugins, group.draft.plugins).length === 0) throw conflict('nothing to publish: the draft is identical to the last version');
  const number = (last?.number || 0) + 1;
  const rows = await db`insert into policy_group_versions (id, group_id, number, plugins, comment, published_by)
    values (${newId('pgv')}, ${group.id}, ${number}, ${group.draft.plugins}, ${comment}, ${ctx.user?.id || null}) returning *`;
  await audit(ctx, { action: 'policy_group.publish', workspaceId: group.workspace_id, entityKind: 'policy_group', entityId: group.id, summary: `policy group ${group.name} v${number} published` });
  return rows[0];
}

export async function listVersions(groupId) {
  return db`select v.id, v.number, v.plugins, v.comment, v.published_at, u.email as published_by_email
    from policy_group_versions v left join users u on u.id = v.published_by where v.group_id = ${groupId} order by v.number desc`;
}

export async function deleteGroup(ctx, group) {
  const usage = await groupUsage(group.workspace_id, group.id);
  if (usage.length) throw badRequest(`still used by ${usage.map((u) => `${u.name} ${u.version}`).join(', ')}`);
  await db`delete from policy_groups where id = ${group.id}`;
  await audit(ctx, { action: 'policy_group.delete', workspaceId: group.workspace_id, entityKind: 'policy_group', entityId: group.id, summary: `policy group ${group.name} deleted` });
}

// the group references of a draft: flow plugin entries of the shape { group, version }
export function groupRefs(draft) {
  const refs = [];
  for (const f of draft?.flows || []) for (const p of f.plugins || []) if (p.group) refs.push({ flow: f.id, group: p.group, version: p.version });
  return refs;
}

export async function groupUsage(workspaceId, groupId) {
  const apis = await db`select id, name, version, draft from apis where workspace_id = ${workspaceId}`;
  const last = (await db`select max(number) as n from policy_group_versions where group_id = ${groupId}`)[0]?.n || 0;
  return apis
    .map((a) => ({ id: a.id, name: a.name, version: a.version, pinned: groupRefs(a.draft).filter((r) => r.group === groupId).map((r) => r.version) }))
    .filter((a) => a.pinned.length)
    .map((a) => ({ ...a, latest: last, behind: a.pinned.some((v) => v < last) }));
}

// freezes the pinned versions a draft references, for its snapshot: the projection never reads a
// group again, it reads what the snapshot froze
export async function resolveGroups(draft) {
  const out = {};
  for (const r of groupRefs(draft)) {
    if (!r.version) throw badRequest(`flow ${r.flow} references policy group ${r.group} without a version: pin one`);
    const key = `${r.group}@${r.version}`;
    if (out[key]) continue;
    const v = (await db`select v.plugins, g.name from policy_group_versions v join policy_groups g on g.id = v.group_id
      where v.group_id = ${r.group} and v.number = ${r.version}`)[0];
    if (!v) throw badRequest(`policy group ${r.group} has no version ${r.version}`);
    out[key] = { name: v.name, plugins: v.plugins };
  }
  return out;
}
