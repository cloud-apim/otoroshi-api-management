// Shared resources (the resources of D-16, not the endpoints of an api): a dependency a plan consumes, named once for the workspace and referenced by the plans
// rather than described again on each — an authorization server: its issuer, its keys, its
// endpoints, the client the gateway uses with it. Like a shared policy group, it creates no gateway
// capability: a plan pins a published version, the snapshot freezes it, and the projection derives
// from it the very entities a plan describing its server derives (the JWT verifier of a jwt plan,
// the auth module of an oauth2-remote plan). Publishing a resource never changes what runs until an
// api is upgraded to the new version: its snapshots are immutable.

import { db, newId } from '../db/index.js';
import { badRequest, conflict, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { diff } from './diff.js';
import { requireFreeName } from './references.js';
import { notifyBehind, upgradePins } from './pins.js';

export const RESOURCE_KINDS = ['authorization-server'];
// the kinds of plan a kind of resource serves
export const SERVES = { 'authorization-server': ['jwt', 'oauth2-remote'] };

// an authorization server: what a jwt plan validates its tokens with (the keys, the issuer), and what
// an oauth2-remote plan reaches it with (its discovery, its user info, the client of the gateway)
export function normalizeContent(kind, c = {}) {
  if (kind !== 'authorization-server') throw badRequest(`a resource is one of ${RESOURCE_KINDS.join(', ')}`);
  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  return {
    issuer: str(c.issuer),
    jwksUrl: str(c.jwksUrl),
    discoveryUrl: str(c.discoveryUrl),
    userInfoUrl: str(c.userInfoUrl),
    clientId: str(c.clientId),
    clientSecret: str(c.clientSecret),
    scope: str(c.scope) || 'openid',
  };
}

function checkContent(kind, c) {
  if (!c.jwksUrl) throw badRequest('an authorization server needs the url of its keys (jwks): the tokens are validated with them');
}

export async function listResources(workspaceId) {
  return db`select r.*, (select max(number) from resource_versions v where v.resource_id = r.id) as last_version
    from resources r where r.workspace_id = ${workspaceId} order by r.name`;
}

export async function getResource(workspaceId, id) {
  const rows = await db`select r.*, (select max(number) from resource_versions v where v.resource_id = r.id) as last_version
    from resources r where r.workspace_id = ${workspaceId} and r.id = ${id}`;
  if (!rows[0]) throw notFound('resource not found');
  return rows[0];
}

export async function createResource(ctx, workspaceId, { name, description = '', kind = 'authorization-server', content = {} }) {
  if (!name) throw badRequest('name is required');
  if (!RESOURCE_KINDS.includes(kind)) throw badRequest(`a resource is one of ${RESOURCE_KINDS.join(', ')}`);
  await requireFreeName('resource', workspaceId, name);
  const id = newId('res');
  const rows = await db`insert into resources (id, workspace_id, name, description, kind, draft)
    values (${id}, ${workspaceId}, ${name}, ${description}, ${kind}, ${normalizeContent(kind, content)}) returning *`;
  await audit(ctx, { action: 'resource.create', workspaceId, entityKind: 'resource', entityId: id, summary: `resource ${name} created` });
  return rows[0];
}

export async function updateResource(ctx, r, patch = {}) {
  if (patch.name && patch.name !== r.name) await requireFreeName('resource', r.workspace_id, patch.name, r.id);
  const draft = patch.content ? normalizeContent(r.kind, patch.content) : r.draft;
  const rows = await db`update resources set name = ${patch.name ?? r.name}, description = ${patch.description ?? r.description},
    draft = ${draft}, updated_at = now() where id = ${r.id} returning *`;
  await audit(ctx, { action: 'resource.update', workspaceId: r.workspace_id, entityKind: 'resource', entityId: r.id, summary: `draft of resource ${rows[0].name} updated` });
  return rows[0];
}

export async function publishResource(ctx, r, { comment = '' } = {}) {
  checkContent(r.kind, r.draft);
  const last = (await db`select * from resource_versions where resource_id = ${r.id} order by number desc limit 1`)[0];
  if (last && diff(last.content, r.draft).length === 0) throw conflict('nothing to publish: the draft is identical to the last version');
  const number = (last?.number || 0) + 1;
  const rows = await db`insert into resource_versions (id, resource_id, number, content, comment, published_by)
    values (${newId('resv')}, ${r.id}, ${number}, ${r.draft}, ${comment}, ${ctx.user?.id || null}) returning *`;
  await audit(ctx, { action: 'resource.publish', workspaceId: r.workspace_id, entityKind: 'resource', entityId: r.id, summary: `resource ${r.name} v${number} published` });
  // nothing runs differently: the teams of the apis behind are told, the upgrade is theirs
  await notifyBehind({ workspaceId: r.workspace_id, label: 'shared resource', name: r.name, number, usage: await resourceUsage(r.workspace_id, r.id), link: `/shared-resources/${r.id}` });
  return rows[0];
}

// the apis behind moved to the latest version of the resource, each by its own draft — and, when
// asked, its own snapshot and deployment
export async function upgradeResource(ctx, r, { publish = false, deploy = false, apis = null } = {}) {
  const latest = (await db`select max(number) as n from resource_versions where resource_id = ${r.id}`)[0]?.n || 0;
  const rewrite = (draft) => ({
    ...draft,
    plans: draft.plans.map((p) => {
      const pin = p.auth?.config?.sharedResource;
      return pin?.id === r.id && pin.version < latest ? { ...p, auth: { ...p.auth, config: { ...p.auth.config, sharedResource: { ...pin, version: latest } } } } : p;
    }),
  });
  return upgradePins(ctx, { workspaceId: r.workspace_id, kind: 'resource', label: 'shared resource', name: r.name, entityId: r.id, latest, usage: await resourceUsage(r.workspace_id, r.id), rewrite, publish, deploy, apiIds: apis });
}

export async function listVersions(resourceId) {
  return db`select v.id, v.number, v.content, v.comment, v.published_at, u.email as published_by_email
    from resource_versions v left join users u on u.id = v.published_by where v.resource_id = ${resourceId} order by v.number desc`;
}

export async function deleteResource(ctx, r) {
  const usage = await resourceUsage(r.workspace_id, r.id);
  if (usage.length) throw badRequest(`still used by ${usage.map((u) => `${u.name} ${u.version}`).join(', ')}`);
  await db`delete from resources where id = ${r.id}`;
  await audit(ctx, { action: 'resource.delete', workspaceId: r.workspace_id, entityKind: 'resource', entityId: r.id, summary: `resource ${r.name} deleted` });
}

// the shared resource references of a draft: plans whose auth config is { sharedResource: { id, version } }
export function resourceRefs(draft) {
  return (draft?.plans || []).filter((p) => p.auth?.config?.sharedResource?.id).map((p) => ({ plan: p.id, planName: p.name, kind: p.auth.kind, id: p.auth.config.sharedResource.id, version: p.auth.config.sharedResource.version }));
}

export async function resourceUsage(workspaceId, resourceId) {
  const apis = await db`select id, name, version, draft from apis where workspace_id = ${workspaceId}`;
  const last = (await db`select max(number) as n from resource_versions where resource_id = ${resourceId}`)[0]?.n || 0;
  return apis
    .map((a) => ({ id: a.id, name: a.name, version: a.version, pinned: resourceRefs(a.draft).filter((r) => r.id === resourceId).map((r) => r.version) }))
    .filter((a) => a.pinned.length)
    .map((a) => ({ ...a, latest: last, behind: a.pinned.some((v) => v < last) }));
}

// freezes the pinned versions a draft references, for its snapshot: the projection never reads a
// resource again, it reads what the snapshot froze
export async function resolveResources(draft) {
  const out = {};
  for (const r of resourceRefs(draft)) {
    if (!r.version) throw badRequest(`plan ${r.planName} references resource ${r.id} without a version: pin one`);
    const key = `${r.id}@${r.version}`;
    if (out[key]) continue;
    const v = (await db`select v.content, r.name, r.kind from resource_versions v join resources r on r.id = v.resource_id
      where v.resource_id = ${r.id} and v.number = ${r.version}`)[0];
    if (!v) throw badRequest(`resource ${r.id} has no version ${r.version}`);
    if (!(SERVES[v.kind] || []).includes(r.kind)) throw badRequest(`plan ${r.planName} (${r.kind}) cannot use resource ${v.name}, a ${v.kind}`);
    out[key] = { name: v.name, kind: v.kind, content: v.content };
  }
  return out;
}
