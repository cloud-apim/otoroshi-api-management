// APIs: one per version (D-29). Three objects with three lifetimes (D-35):
//  - the draft (the api row, its draft document and its documentation pages) — the only editable thing
//  - the snapshots, immutable and append-only — what gets projected
//  - the deployment state, which references a snapshot (see deployments.js)

import { db, newId, slugify } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { diff } from './diff.js';
import { defaultDraft, defaultPlan, normalizeDraft, validateDraft, VISIBILITIES } from './model.js';
import { isTeamMember } from './identity.js';

export function apiSummary(row) {
  if (!row) return null;
  const { draft, ...rest } = row;
  return rest;
}

export async function listApis(workspaceId, { q, teamId, lifecycle } = {}) {
  const like = q ? `%${q.toLowerCase()}%` : null;
  return db`select a.id, a.workspace_id, a.team_id, a.slug, a.name, a.version, a.description, a.tags, a.visibility, a.acl,
      a.lifecycle, a.previous_version_id, a.managed_by, a.created_at, a.updated_at, a.draft_updated_at,
      t.name as team_name,
      (select max(number) from api_snapshots s where s.api_id = a.id) as last_snapshot,
      (select jsonb_build_object('status', d.status, 'snapshot_id', d.snapshot_id, 'action', d.action, 'at', d.finished_at)
         from api_deployments d where d.api_id = a.id order by d.requested_at desc limit 1) as deployment,
      a.draft->'entrypoint' as entrypoint,
      jsonb_array_length(a.draft->'plans') as plans_count,
      (select count(*)::int from subscriptions s where s.api_id = a.id and s.status = 'active') as active_subscriptions,
      (select count(*)::int from subscriptions s where s.api_id = a.id and s.status = 'pending') as pending_subscriptions
    from apis a left join teams t on t.id = a.team_id
    where a.workspace_id = ${workspaceId}
      and (${like}::text is null or lower(a.name) like ${like} or lower(a.description) like ${like} or a.tags::text ilike ${like})
      and (${teamId || null}::text is null or a.team_id = ${teamId || null})
      and (${lifecycle || null}::text is null or a.lifecycle = ${lifecycle || null})
    order by a.name, a.version`;
}

export async function getApi(workspaceId, idOrSlug) {
  const rows = await db`select * from apis where workspace_id = ${workspaceId} and (id = ${idOrSlug} or slug = ${idOrSlug})
    order by created_at desc limit 1`;
  if (!rows[0]) throw notFound('api not found');
  return rows[0];
}

export async function canManageApi(ctx, api) {
  if (ctx.user?.is_admin || ctx.role === 'admin') return true;
  if (ctx.role !== 'producer') return false;
  if (!api.team_id) return true;
  return isTeamMember(api.team_id, ctx.user.id);
}

export async function requireManageApi(ctx, api) {
  if (!(await canManageApi(ctx, api))) throw forbidden('you cannot manage this api');
}

export async function createApi(ctx, workspaceId, input) {
  const name = (input.name || '').trim();
  if (!name) throw badRequest('name is required');
  const version = (input.version || '1.0.0').trim();
  const slug = slugify(input.slug || name);
  const exists = await db`select 1 from apis where workspace_id = ${workspaceId} and slug = ${slug} and version = ${version}`;
  if (exists.length) throw conflict(`api ${slug} ${version} already exists`);
  const draft = normalizeDraft(
    input.draft ||
      defaultDraft({
        domain: input.domain || `${slug}.oto.tools`,
        contextPath: input.contextPath ?? `/`,
      })
  );
  if (!input.draft && input.withDefaultPlan !== false) {
    draft.plans.push(defaultPlan({ name: 'Default', status: 'published', auth: { kind: 'apikey' } }));
  }
  if (input.visibility && !VISIBILITIES.includes(input.visibility)) throw badRequest('invalid visibility');
  const id = input.id || newId('api');
  const rows = await db`insert into apis (id, workspace_id, team_id, slug, name, version, description, tags, visibility, acl,
      previous_version_id, draft, draft_updated_by, managed_by, metadata)
    values (${id}, ${workspaceId}, ${input.team_id || null}, ${slug}, ${name}, ${version}, ${input.description || ''},
      ${input.tags || []}, ${input.visibility || 'public'}, ${input.acl || []}, ${input.previous_version_id || null},
      ${draft}, ${ctx.user?.id || null}, ${input.managed_by || null}, ${input.metadata || {}}) returning *`;
  await audit(ctx, { action: 'api.create', workspaceId, entityKind: 'api', entityId: id, summary: `api ${name} ${version} created` });
  if (input.pages?.length) {
    for (const p of input.pages) await createPage(ctx, rows[0], p, { silent: true });
  } else if (!input.draft) {
    await createPage(ctx, rows[0], {
      slug: 'getting-started',
      title: { en: 'Getting started', fr: 'Démarrage' },
      content: {
        en: `# ${name}\n\nWelcome to the ${name} API.\n\n## Authentication\n\nSubscribe to a plan from an application to get your credentials, then call the API with them.\n`,
        fr: `# ${name}\n\nBienvenue sur l'API ${name}.\n\n## Authentification\n\nSouscrivez à un plan depuis une application pour obtenir vos identifiants, puis appelez l'API avec.\n`,
      },
    }, { silent: true });
  }
  return rows[0];
}

const IDENTITY_FIELDS = ['name', 'description', 'tags', 'visibility', 'acl', 'team_id', 'metadata'];

export async function updateApi(ctx, api, patch) {
  if (api.managed_by && !patch.force) throw conflict(`this api is managed by ${api.managed_by}: edit it at its source of truth (D-28)`, { managed_by: api.managed_by });
  const next = { ...api };
  IDENTITY_FIELDS.forEach((k) => {
    if (patch[k] !== undefined) next[k] = patch[k];
  });
  if (!VISIBILITIES.includes(next.visibility)) throw badRequest('invalid visibility');
  if (patch.draft) next.draft = normalizeDraft(patch.draft);
  const rows = await db`update apis set name = ${next.name}, description = ${next.description}, tags = ${next.tags},
      visibility = ${next.visibility}, acl = ${next.acl}, team_id = ${next.team_id}, metadata = ${next.metadata},
      draft = ${next.draft}, draft_updated_at = now(), draft_updated_by = ${ctx.user?.id || null}, updated_at = now()
    where id = ${api.id} returning *`;
  await audit(ctx, {
    action: patch.draft ? 'api.draft.update' : 'api.update',
    workspaceId: api.workspace_id,
    entityKind: 'api',
    entityId: api.id,
    summary: `draft of ${next.name} ${next.version} updated`,
    data: { changes: diff(draftView(api), draftView(rows[0])).slice(0, 50) },
  });
  return rows[0];
}

export async function setLifecycle(ctx, api, lifecycle) {
  if (!['published', 'deprecated', 'archived'].includes(lifecycle)) throw badRequest('invalid lifecycle');
  if (api.lifecycle === 'created') throw badRequest('publish the api first');
  const rows = await db`update apis set lifecycle = ${lifecycle}, updated_at = now() where id = ${api.id} returning *`;
  await audit(ctx, { action: `api.lifecycle.${lifecycle}`, workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `${api.name} ${api.version} is now ${lifecycle}` });
  return rows[0];
}

export async function deleteApiRow(ctx, api) {
  await db`delete from apis where id = ${api.id}`;
  await audit(ctx, { action: 'api.delete', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `api ${api.name} ${api.version} deleted` });
}

// ---------------------------------------------------------------- documentation pages (D-11)

export async function listPages(apiId, { withContent = false } = {}) {
  if (withContent) return db`select * from api_doc_pages where api_id = ${apiId} order by position, created_at`;
  return db`select id, api_id, parent_id, slug, position, title, created_at, updated_at from api_doc_pages where api_id = ${apiId} order by position, created_at`;
}

export async function getPage(apiId, idOrSlug) {
  const rows = await db`select * from api_doc_pages where api_id = ${apiId} and (id = ${idOrSlug} or slug = ${idOrSlug})`;
  if (!rows[0]) throw notFound('page not found');
  return rows[0];
}

export async function createPage(ctx, api, input, { silent = false } = {}) {
  const slug = slugify(input.slug || input.title?.en || Object.values(input.title || {})[0] || 'page');
  const pos = input.position ?? (await db`select coalesce(max(position), -1) + 1 as p from api_doc_pages where api_id = ${api.id}`)[0].p;
  const rows = await db`insert into api_doc_pages (id, api_id, parent_id, slug, position, title, content)
    values (${newId('page')}, ${api.id}, ${input.parent_id || null}, ${slug}, ${pos}, ${input.title || {}}, ${input.content || {}}) returning *`;
  await touchDraft(ctx, api);
  if (!silent) await audit(ctx, { action: 'api.page.create', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `page ${slug} created` });
  return rows[0];
}

export async function updatePage(ctx, api, page, patch) {
  const rows = await db`update api_doc_pages set slug = ${patch.slug ? slugify(patch.slug) : page.slug}, position = ${patch.position ?? page.position},
      parent_id = ${patch.parent_id !== undefined ? patch.parent_id : page.parent_id}, title = ${patch.title ?? page.title},
      content = ${patch.content ?? page.content}, updated_at = now()
    where id = ${page.id} returning *`;
  await touchDraft(ctx, api);
  await audit(ctx, { action: 'api.page.update', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `page ${rows[0].slug} updated` });
  return rows[0];
}

export async function deletePage(ctx, api, page) {
  await db`delete from api_doc_pages where id = ${page.id}`;
  await touchDraft(ctx, api);
  await audit(ctx, { action: 'api.page.delete', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `page ${page.slug} deleted` });
}

async function touchDraft(ctx, api) {
  await db`update apis set draft_updated_at = now(), draft_updated_by = ${ctx.user?.id || null} where id = ${api.id}`;
}

// ---------------------------------------------------------------- snapshots (D-35)

function draftView(row) {
  return {
    api: {
      id: row.id,
      workspace_id: row.workspace_id,
      team_id: row.team_id,
      slug: row.slug,
      name: row.name,
      version: row.version,
      description: row.description,
      tags: row.tags,
      visibility: row.visibility,
      acl: row.acl,
      previous_version_id: row.previous_version_id,
    },
    draft: normalizeDraft(row.draft),
  };
}

export async function composeDraft(api) {
  const pages = await listPages(api.id, { withContent: true });
  return {
    ...draftView(api),
    docs: {
      pages: pages.map((p) => ({ id: p.id, parent_id: p.parent_id, slug: p.slug, position: p.position, title: p.title, content: p.content })),
    },
  };
}

export async function lastSnapshot(apiId) {
  const rows = await db`select * from api_snapshots where api_id = ${apiId} order by number desc limit 1`;
  return rows[0] || null;
}

export async function listSnapshots(apiId) {
  return db`select s.id, s.api_id, s.number, s.comment, s.published_by, s.published_at, u.email as published_by_email
    from api_snapshots s left join users u on u.id = s.published_by where s.api_id = ${apiId} order by number desc`;
}

export async function getSnapshot(apiId, idOrNumber) {
  const n = /^\d+$/.test(String(idOrNumber)) ? parseInt(idOrNumber, 10) : -1;
  const rows = await db`select * from api_snapshots where api_id = ${apiId} and (id = ${String(idOrNumber)} or number = ${n})`;
  if (!rows[0]) throw notFound('snapshot not found');
  return rows[0];
}

export async function pendingChanges(api) {
  const last = await lastSnapshot(api.id);
  const current = await composeDraft(api);
  if (!last) return { snapshot: null, changes: null, hasChanges: true };
  const changes = diff(last.content, current);
  return { snapshot: { id: last.id, number: last.number }, changes, hasChanges: changes.length > 0 };
}

export async function publish(ctx, api, { comment = '' } = {}) {
  const content = await composeDraft(api);
  const validation = validateDraft(content.draft);
  if (!validation.ok) throw badRequest('the draft has errors, it cannot be published', validation);
  const last = await lastSnapshot(api.id);
  if (last && diff(last.content, content).length === 0) throw conflict('nothing to publish: the draft is identical to the last snapshot');
  const number = (last?.number || 0) + 1;
  const id = newId('snap');
  const rows = await db`insert into api_snapshots (id, api_id, number, content, comment, published_by)
    values (${id}, ${api.id}, ${number}, ${content}, ${comment}, ${ctx.user?.id || null}) returning *`;
  if (api.lifecycle === 'created') await db`update apis set lifecycle = 'published', updated_at = now() where id = ${api.id}`;
  await audit(ctx, {
    action: 'api.publish',
    workspaceId: api.workspace_id,
    entityKind: 'api',
    entityId: api.id,
    summary: `${api.name} ${api.version}: snapshot #${number} published${comment ? ` (${comment})` : ''}`,
    data: { snapshot_id: id, number, warnings: validation.warnings },
  });
  return { snapshot: rows[0], warnings: validation.warnings };
}

// D-29: a new version is a new api, pre-filled from the previous one. Subscriptions do not follow:
// that is what transfer (D-30) pays back.
export async function newVersion(ctx, api, { version }) {
  if (!version) throw badRequest('version is required');
  const draft = normalizeDraft(api.draft);
  // fresh plan ids: two versions share nothing (D-29)
  draft.plans = draft.plans.map((p) => ({ ...p, id: newId('plan'), status: p.status === 'closed' ? 'closed' : 'staging' }));
  const pages = await listPages(api.id, { withContent: true });
  const created = await createApi(ctx, api.workspace_id, {
    name: api.name,
    slug: api.slug,
    version,
    description: api.description,
    team_id: api.team_id,
    tags: api.tags,
    visibility: api.visibility,
    acl: api.acl,
    previous_version_id: api.id,
    draft,
    pages: pages.map((p) => ({ slug: p.slug, title: p.title, content: p.content, position: p.position })),
  });
  await audit(ctx, { action: 'api.version.create', workspaceId: api.workspace_id, entityKind: 'api', entityId: created.id, summary: `${api.name} ${version} created from ${api.version}` });
  return created;
}

export async function versionsOf(workspaceId, slug) {
  return db`select id, version, lifecycle, previous_version_id, created_at from apis where workspace_id = ${workspaceId} and slug = ${slug} order by created_at`;
}
