// Full export, re-importable elsewhere (PX-07, D-9 n°4). The declarative unit is the API-version
// (Q-11, unblocked by D-29): one document per api, carrying its plans, with the documentation pages
// beside it and its snapshot history.

import { db, newId } from '../db/index.js';
import { badRequest } from '../http/router.js';
import { audit } from './audit.js';
import { normalizeDraft } from './model.js';

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
      draft: normalizeDraft(a.draft),
      pages,
      snapshots,
    });
  }
  const applications = await db`select id, team_id, name, description, client_id, certificates, metadata from applications where workspace_id = ${ws.id}`;
  const subscriptions = await db`select id, api_id, plan_id, application_id, auth_kind, status, request, review, payment, dates, history, metadata
    from subscriptions where workspace_id = ${ws.id}`;
  return {
    kind: EXPORT_KIND,
    version: 1,
    exported_at: new Date().toISOString(),
    workspace: { slug: ws.slug, name: ws.name, description: ws.description, portal: ws.portal },
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
      await tx`insert into apis (id, workspace_id, team_id, slug, name, version, description, tags, visibility, acl, lifecycle, previous_version_id, draft, metadata)
        values (${a.id}, ${ws.id}, ${a.team_id || null}, ${a.slug}, ${a.name}, ${a.version}, ${a.description || ''}, ${a.tags || []}, ${a.visibility || 'public'},
          ${a.acl || []}, ${a.lifecycle || 'created'}, ${a.previous_version_id || null}, ${normalizeDraft(a.draft)}, ${a.metadata || {}})
        on conflict (id) do update set name = excluded.name, description = excluded.description, tags = excluded.tags, visibility = excluded.visibility,
          acl = excluded.acl, draft = excluded.draft, team_id = excluded.team_id, draft_updated_at = now()`;
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
      await tx`insert into applications (id, workspace_id, team_id, name, description, client_id, certificates, metadata)
        values (${app.id}, ${ws.id}, ${app.team_id}, ${app.name}, ${app.description || ''}, ${app.client_id || null}, ${app.certificates || []}, ${app.metadata || {}})
        on conflict (id) do update set name = excluded.name, description = excluded.description, client_id = excluded.client_id`;
      stats.applications++;
    }
    for (const s of doc.subscriptions || []) {
      await tx`insert into subscriptions (id, workspace_id, api_id, plan_id, application_id, auth_kind, status, request, review, payment, dates, history, metadata, projection)
        values (${s.id}, ${ws.id}, ${s.api_id}, ${s.plan_id}, ${s.application_id}, ${s.auth_kind}, ${s.status}, ${s.request || {}}, ${s.review || {}},
          ${s.payment || {}}, ${s.dates || {}}, ${s.history || []}, ${s.metadata || {}}, ${{ status: 'none' }})
        on conflict (id) do nothing`;
      stats.subscriptions++;
    }
  });
  await audit(ctx, { action: 'workspace.import', workspaceId: ws.id, entityKind: 'workspace', entityId: ws.id, summary: `import: ${JSON.stringify(stats)}` });
  return { imported: stats };
}
