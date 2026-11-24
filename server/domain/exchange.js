// Full export, re-importable elsewhere. The declarative unit is the API-version
// (a version is an api): one document per api, carrying its plans, with the documentation pages
// beside it and its snapshot history.

import { db, newId, slugify } from '../db/index.js';
import { badRequest, forbidden } from '../http/router.js';
import { isTeamMember, maskWorkspace } from './identity.js';
import { audit } from './audit.js';
import { normalizeDraft } from './model.js';
import { refsToIds, refsToNames } from './references.js';
export { inlinePageFiles } from './page-files.js';

export const EXPORT_KIND = 'otoroshi-apim.io/WorkspaceExport';

export async function exportWorkspace(ws) {
  const teams = await db`select id, name, description, personal, metadata from teams where workspace_id = ${ws.id} order by created_at`;
  const apiRows = await db`select * from apis where workspace_id = ${ws.id} order by created_at`;
  const apis = [];
  for (const a of apiRows) {
    const pages = await db`select id, parent_id, slug, position, title, content from api_doc_pages where api_id = ${a.id} order by position`;
    const snapshots = await db`select id, number, content, comment, published_at from api_snapshots where api_id = ${a.id} order by number`;
    apis.push({
      kind: 'otoroshi-apim.io/Api',
      id: a.id,
      slug: a.slug,
      name: a.name,
      version: a.version,
      description: a.description,
      team_id: a.team_id,
      tags: a.tags,
      visibility: a.visibility,
      acl: a.acl,
      lifecycle: a.lifecycle,
      previous_version_id: a.previous_version_id,
      metadata: a.metadata,
      categories: a.categories || [],
      featured: !!a.featured,
      draft: normalizeDraft(a.draft),
      pages,
      snapshots,
    });
  }
  const applications = await db`select id, team_id, name, description, client_id, certificates, metadata, shared_credential from applications where workspace_id = ${ws.id}`;
  const subscriptions = await db`select id, api_id, plan_id, application_id, auth_kind, status, request, review, payment, dates, history, metadata, shares_credential
    from subscriptions where workspace_id = ${ws.id}`;
  return {
    kind: EXPORT_KIND,
    version: 1,
    exported_at: new Date().toISOString(),
    // the secret of the identity provider of the portal stays in the installation
    workspace: { slug: ws.slug, name: ws.name, description: ws.description, portal: maskWorkspace(ws).portal },
    teams,
    apis,
    applications,
    subscriptions,
  };
}

// Import is idempotent: objects are upserted by id. Snapshots are append-only, an existing one is
// never rewritten. Nothing is deployed: deploying stays an explicit act.
export async function importWorkspace(ctx, ws, doc) {
  if (doc?.kind !== EXPORT_KIND) throw badRequest(`expected a document of kind ${EXPORT_KIND}`);
  const stats = { teams: 0, apis: 0, pages: 0, snapshots: 0, applications: 0, subscriptions: 0 };
  await db.begin(async (tx) => {
    for (const t of doc.teams || []) {
      await tx`insert into teams (id, workspace_id, name, description, personal, metadata) values (${t.id}, ${ws.id}, ${t.name}, ${t.description || ''}, ${!!t.personal}, ${t.metadata || {}})
        on conflict (id) do update set name = excluded.name, description = excluded.description`;
      stats.teams++;
    }
    for (const a of doc.apis || []) {
      await tx`insert into apis (id, workspace_id, team_id, slug, name, version, description, tags, visibility, acl, lifecycle, previous_version_id, draft, metadata, categories, featured)
        values (${a.id}, ${ws.id}, ${a.team_id || null}, ${a.slug}, ${a.name}, ${a.version}, ${a.description || ''}, ${a.tags || []}, ${a.visibility || 'public'},
          ${a.acl || []}, ${a.lifecycle || 'created'}, ${a.previous_version_id || null}, ${normalizeDraft(a.draft)}, ${a.metadata || {}}, ${a.categories || []}, ${!!a.featured})
        on conflict (id) do update set name = excluded.name, description = excluded.description, tags = excluded.tags, visibility = excluded.visibility,
          acl = excluded.acl, draft = excluded.draft, team_id = excluded.team_id, categories = excluded.categories, featured = excluded.featured, draft_updated_at = now()`;
      stats.apis++;
      for (const p of a.pages || []) {
        await tx`insert into api_doc_pages (id, api_id, parent_id, slug, position, title, content)
          values (${p.id || newId('page')}, ${a.id}, ${p.parent_id || null}, ${p.slug}, ${p.position || 0}, ${p.title || {}}, ${p.content || {}})
          on conflict (id) do update set slug = excluded.slug, position = excluded.position, title = excluded.title, content = excluded.content`;
        stats.pages++;
      }
      for (const s of a.snapshots || []) {
        const r = await tx`insert into api_snapshots (id, api_id, number, content, comment, published_at)
          values (${s.id}, ${a.id}, ${s.number}, ${s.content}, ${s.comment || ''}, ${s.published_at || new Date()}) on conflict do nothing returning id`;
        stats.snapshots += r.length;
      }
    }
    for (const app of doc.applications || []) {
      await tx`insert into applications (id, workspace_id, team_id, name, description, client_id, certificates, metadata, shared_credential)
        values (${app.id}, ${ws.id}, ${app.team_id}, ${app.name}, ${app.description || ''}, ${app.client_id || null}, ${app.certificates || []}, ${app.metadata || {}}, ${!!app.shared_credential})
        on conflict (id) do update set name = excluded.name, description = excluded.description, client_id = excluded.client_id, shared_credential = excluded.shared_credential`;
      stats.applications++;
    }
    for (const s of doc.subscriptions || []) {
      await tx`insert into subscriptions (id, workspace_id, api_id, plan_id, application_id, auth_kind, status, request, review, payment, dates, history, metadata, projection, shares_credential)
        values (${s.id}, ${ws.id}, ${s.api_id}, ${s.plan_id}, ${s.application_id}, ${s.auth_kind}, ${s.status}, ${s.request || {}}, ${s.review || {}},
          ${s.payment || {}}, ${s.dates || {}}, ${s.history || []}, ${s.metadata || {}}, ${{ status: 'none' }}, ${!!s.shares_credential})
        on conflict (id) do nothing`;
      stats.subscriptions++;
    }
  });
  await audit(ctx, { action: 'workspace.import', workspaceId: ws.id, entityKind: 'workspace', entityId: ws.id, summary: `import: ${JSON.stringify(stats)}` });
  return { imported: stats };
}

// ---------------------------------------------------------------- declarative documents
// The declarative unit is the api-version: one document carries the api and its plans, with its
// documentation pages beside them. `apim get api -o yaml` and `apim apply -f` round-trip it.

export const API_KIND = 'Api';
export const API_VERSION = 'otoroshi-apim.io/v1';

// what identifies a document: its name (the slug) and its version, in `spec.version` — as a resource
// of Kubernetes, whose metadata cannot carry it — or, the first form of the format, `metadata.version`
export function docKey(doc) {
  const slug = doc?.metadata?.name;
  const inSpec = doc?.spec?.version;
  const inMeta = doc?.metadata?.version;
  if (inSpec && inMeta && String(inSpec) !== String(inMeta)) throw badRequest(`${slug}: spec.version (${inSpec}) and metadata.version (${inMeta}) differ`);
  return { slug, version: String(inSpec || inMeta || '1.0.0') };
}

export async function apiDocument(api) {
  const pages = await db`select slug, position, title, content from api_doc_pages where api_id = ${api.id} order by position`;
  const team = api.team_id ? (await db`select id, name from teams where id = ${api.team_id}`)[0] : null;
  return {
    apiVersion: API_VERSION,
    kind: API_KIND,
    metadata: { workspace: (await db`select slug from workspaces where id = ${api.workspace_id}`)[0]?.slug, name: api.slug, id: api.id },
    spec: {
      version: api.version,
      name: api.name,
      description: api.description,
      team: team?.name || null,
      tags: api.tags,
      visibility: api.visibility,
      acl: api.acl,
      // the policy groups and the shared resources it pins, by name: the document moves between installations
      draft: await refsToNames(normalizeDraft(api.draft)),
      pages: pages.map((p) => ({ slug: p.slug, position: p.position, title: p.title, content: p.content })),
    },
  };
}

// upsert by (workspace, slug, version). Writes the draft: publishing and deploying stay explicit
// acts, unless the caller asks for them (the GitOps gesture). A document that lists its pages is
// their truth: a page it no longer lists is deleted; a document without pages leaves them alone.
export async function applyApiDocument(ctx, ws, doc, { managedBy = null, checkManage = false } = {}) {
  if (doc?.kind !== API_KIND) throw badRequest(`expected kind ${API_KIND}`);
  const { slug, version } = docKey(doc);
  if (!slug) throw badRequest('metadata.name is required');
  const spec = doc.spec || {};
  for (const page of spec.pages || [])
    for (const [lang, c] of Object.entries(page.content || {}))
      if (c && typeof c === 'object') throw badRequest(`page ${page.slug}: its content in ${lang} is a file — the client that holds the file inlines it (apim apply, a remote catalog do)`);
  let teamId = null;
  if (spec.team) {
    const t = (await db`select id from teams where workspace_id = ${ws.id} and (id = ${spec.team} or name = ${spec.team})`)[0];
    if (!t) throw badRequest(`unknown team ${spec.team}`);
    teamId = t.id;
  }
  const draft = spec.draft ? normalizeDraft(await refsToIds(ws.id, spec.draft)) : null;
  const { createApi, updateApi, createPage, updatePage, deletePage, requireManageApi } = await import('./apis.js');
  const existing = (await db`select * from apis where workspace_id = ${ws.id} and slug = ${slug} and version = ${version}`)[0];
  let api;
  let action;
  if (!existing) {
    // as from the console: a producer creates apis for the teams it belongs to
    if (checkManage && teamId && ctx.role === 'producer' && !(await isTeamMember(teamId, ctx.user.id))) throw forbidden(`you are not a member of the team ${spec.team}`);
    api = await createApi(ctx, ws.id, {
      name: spec.name || slug,
      slug,
      version,
      description: spec.description || '',
      team_id: teamId,
      tags: spec.tags || [],
      visibility: spec.visibility || 'public',
      acl: spec.acl || [],
      draft: draft || normalizeDraft({}),
      managed_by: managedBy,
      pages: [],
    });
    action = 'created';
  } else {
    if (checkManage) await requireManageApi(ctx, existing);
    if (existing.managed_by && managedBy && existing.managed_by !== managedBy)
      throw badRequest(`this api is managed by ${existing.managed_by}, not ${managedBy}`);
    api = await updateApi(ctx, existing, {
      name: spec.name ?? existing.name,
      description: spec.description ?? existing.description,
      tags: spec.tags ?? existing.tags,
      visibility: spec.visibility ?? existing.visibility,
      acl: spec.acl ?? existing.acl,
      team_id: spec.team !== undefined ? teamId : existing.team_id,
      draft: draft || existing.draft,
      force: true,
    });
    if (managedBy !== existing.managed_by) await db`update apis set managed_by = ${managedBy} where id = ${api.id}`;
    action = 'updated';
  }
  if (Array.isArray(spec.pages)) {
    const listed = new Set();
    for (const p of spec.pages) {
      const pageSlug = slugify(p.slug || p.title?.en || Object.values(p.title || {})[0] || 'page');
      listed.add(pageSlug);
      const cur = (await db`select * from api_doc_pages where api_id = ${api.id} and slug = ${pageSlug}`)[0];
      if (cur) await updatePage(ctx, api, cur, { ...p, slug: pageSlug });
      else await createPage(ctx, api, { ...p, slug: pageSlug }, { silent: true });
    }
    for (const gone of await db`select * from api_doc_pages where api_id = ${api.id}`) if (!listed.has(gone.slug)) await deletePage(ctx, api, gone);
  }
  return { action, api: { id: api.id, slug: api.slug, version: api.version } };
}
