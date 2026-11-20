// Promotion: the same snapshot published on the next installation — recette, then production. One
// installation drives one cluster, so an environment is an installation, and promoting is not
// deploying elsewhere: the snapshot is exported as a document, and the next installation takes it
// as one of its own snapshots, unchanged, then deploys it like any other.
//
// What is promoted is the snapshot without what only names the api in its installation (its id,
// its workspace, its team). Its digest proves it arrives unchanged. What differs from one
// environment to the next is not in it: Otoroshi vault references, resolved by each cluster.

import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db, newId } from '../db/index.js';
import { badRequest, forbidden } from '../http/router.js';
import { audit } from './audit.js';
import { diff, stable } from './diff.js';
import { isTeamMember } from './identity.js';
import { normalizeDraft } from './model.js';
import { resolveGroups } from './policyGroups.js';
import { resolveResources } from './resources.js';
import * as apis from './apis.js';
import * as deployments from './deployments.js';
import { checkRefs, vaultRefs } from '../otoroshi/vault-refs.js';

export const PROMOTION_KIND = 'otoroshi-apim.io/SnapshotPromotion';

// what names the api in its installation: not promoted
const LOCAL = ['id', 'workspace_id', 'team_id', 'previous_version_id'];

export function portable(content) {
  const api = Object.fromEntries(Object.entries(content?.api || {}).filter(([k]) => !LOCAL.includes(k)));
  return { ...content, api };
}

export const digest = (content) => `sha256:${createHash('sha256').update(stable(portable(content))).digest('hex')}`;

export function installationName() {
  if (config.installationName) return config.installationName;
  try {
    return new URL(config.publicUrl).host;
  } catch (e) {
    return config.publicUrl;
  }
}

// ---------------------------------------------------------------- export

export async function exportSnapshot(ctx, ws, api, snapshot) {
  const team = api.team_id ? (await db`select id, name from teams where id = ${api.team_id}`)[0] : null;
  const by = snapshot.published_by ? (await db`select email from users where id = ${snapshot.published_by}`)[0]?.email : null;
  await audit(ctx, {
    action: 'api.promotion.export',
    workspaceId: ws.id,
    entityKind: 'api',
    entityId: api.id,
    summary: `${api.name} ${api.version}: snapshot #${snapshot.number} exported for promotion`,
  });
  return {
    kind: PROMOTION_KIND,
    version: 1,
    exported_at: new Date().toISOString(),
    source: {
      installation: installationName(),
      url: config.publicUrl,
      workspace: ws.slug,
      api: { id: api.id, slug: api.slug, name: api.name, version: api.version },
      team: team ? { id: team.id, name: team.name } : null,
      snapshot: { id: snapshot.id, number: snapshot.number, published_at: snapshot.published_at, published_by: by, comment: snapshot.comment },
      // a snapshot promoted itself keeps the trace of where it was first published
      origin: snapshot.origin || null,
    },
    digest: digest(snapshot.content),
    content: portable(snapshot.content),
  };
}

// ---------------------------------------------------------------- promote

function check(doc) {
  if (doc?.kind !== PROMOTION_KIND) throw badRequest(`expected a document of kind ${PROMOTION_KIND}`);
  if (doc.version !== 1) throw badRequest(`unknown version ${doc.version} of ${PROMOTION_KIND}`);
  if (!doc.content?.draft || !doc.source?.api?.slug || !doc.source?.snapshot) throw badRequest('incomplete promotion document');
  if (digest(doc.content) !== doc.digest) throw badRequest('the snapshot was changed after its export: a promotion carries the very snapshot that was published, unchanged');
}

// the api this promotion lands in: the same id when the installations share it (a previous
// promotion, an import), else the same slug and version
async function targetOf(ws, doc) {
  const byId = (await db`select * from apis where id = ${doc.source.api.id}`)[0];
  if (byId?.workspace_id === ws.id) return { api: byId, idFree: false };
  const bySlug = (await db`select * from apis where workspace_id = ${ws.id} and slug = ${doc.source.api.slug} and version = ${doc.content.api.version}`)[0];
  return { api: bySlug || null, idFree: !byId };
}

async function teamOf(ws, doc) {
  const t = doc.source.team;
  if (!t) return null;
  return (await db`select * from teams where workspace_id = ${ws.id} and (id = ${t.id} or name = ${t.name}) order by (id = ${t.id}) desc limit 1`)[0] || null;
}

// the content as this installation stores it: the promoted document, named after the local api
const localContent = (doc, api) => ({
  ...doc.content,
  api: { ...doc.content.api, id: api.id, workspace_id: api.workspace_id, team_id: api.team_id || null, previous_version_id: api.previous_version_id || null },
});

async function alreadyPromoted(apiId, doc) {
  const rows = await db`select id, number from api_snapshots where api_id = ${apiId} and (id = ${doc.source.snapshot.id} or origin->>'digest' = ${doc.digest})
    order by number desc limit 1`;
  return rows[0] || null;
}

// the team acl tags name teams by id: they only match where the teams were imported with theirs
async function aclWarnings(ws, content) {
  const tags = [...(content.api?.acl || []), ...normalizeDraft(content.draft).plans.flatMap((p) => p.acl || [])].filter((t) => String(t).startsWith('team:'));
  const out = [];
  for (const tag of new Set(tags)) {
    const id = tag.slice('team:'.length);
    if (!(await db`select 1 from teams where workspace_id = ${ws.id} and id = ${id}`)[0])
      out.push({ code: 'acl_team_unknown', message: `the access tag ${tag} names a team this workspace does not have: nobody here matches it` });
  }
  return out;
}

export async function promote(ctx, ws, doc, { dryRun = false, deploy = false, replaceDraft = false } = {}) {
  check(doc);
  const { api: existing, idFree } = await targetOf(ws, doc);
  const team = existing ? null : await teamOf(ws, doc);
  // rights: who manages the api; creating one by promotion, an administrator or a member of its team
  if (existing) await apis.requireManageApi(ctx, existing);
  else if (!(ctx.user?.is_admin || ctx.role === 'admin' || (ctx.role === 'producer' && team && (await isTeamMember(team.id, ctx.user.id)))))
    throw forbidden('only the administrators of the workspace, or the members of its team, create an api by promotion');

  const target = existing || {
    id: idFree ? doc.source.api.id : newId('api'),
    workspace_id: ws.id,
    team_id: team?.id || null,
    slug: doc.source.api.slug,
    version: doc.content.api.version,
    name: doc.content.api.name,
    lifecycle: 'created',
    previous_version_id: null,
  };
  const content = localContent(doc, target);
  const already = existing ? await alreadyPromoted(existing.id, doc) : null;
  const running = existing ? await deployments.deployedSnapshot(existing.id) : null;
  const pending = existing ? (await apis.pendingChanges(existing)).hasChanges : false;
  const validation = await apis.validateWithMetadata(ws.id, content.draft, { apiId: target.id });
  const warnings = [...validation.warnings, ...(await aclWarnings(ws, content))];
  try {
    await resolveGroups(content.draft);
  } catch (e) {
    warnings.push({
      code: 'policy_group_unknown',
      message: `${e.message}: the snapshot carries the frozen version it was published with, but a snapshot published here from this draft will not resolve it`,
    });
  }
  try {
    await resolveResources(content.draft);
  } catch (e) {
    warnings.push({
      code: 'shared_resource_unknown',
      message: `${e.message}: the snapshot carries the frozen version it was published with, but a snapshot published here from this draft will not resolve it`,
    });
  }
  const refs = await checkRefs(vaultRefs(doc.content));
  for (const r of refs.filter((r) => r.status === 'missing'))
    warnings.push({ code: 'vault_ref_missing', message: `${r.ref} does not resolve on this gateway: set "${r.path}" in the env of its global config` });
  // a new api is published by its first snapshot
  const preview = await deployments.previewContent({ ...target, lifecycle: existing ? existing.lifecycle : 'published' }, content);
  const plan = {
    source: doc.source,
    digest: doc.digest,
    api: { id: target.id, slug: target.slug, version: target.version, name: target.name, created: !existing, team: existing ? undefined : team?.name || null },
    already: already ? { id: already.id, number: already.number } : null,
    running: running ? { id: running.id, number: running.number } : null,
    // what changes compared with what runs here
    changes: running ? diff(portable(running.content), doc.content) : null,
    draft: { pending, replaced: !existing || !pending || replaceDraft },
    validation: { errors: validation.errors },
    vault_refs: refs,
    gateway: { changes: preview.gatewayChanges, derived: preview.derived, error: preview.gatewayError },
    warnings: [...warnings, ...preview.warnings.filter((w) => !warnings.some((x) => x.message === w.message))],
  };
  if (dryRun) return { dryRun: true, ...plan };
  if (validation.errors.length) throw badRequest('the snapshot does not validate on this installation', { errors: validation.errors });
  if (already && !deploy) return { promoted: false, ...plan, snapshot: plan.already };
  if (pending && !replaceDraft && !already)
    throw badRequest('the draft of this api has changes that are not in a snapshot: publish them first, or replace the draft (replace_draft)');

  let snapshot = already;
  if (!already) {
    snapshot = await db.begin(async (tx) => {
      if (!existing) {
        await tx`insert into apis (id, workspace_id, team_id, slug, name, version, description, tags, visibility, acl, lifecycle, draft)
          values (${target.id}, ${ws.id}, ${target.team_id}, ${target.slug}, ${content.api.name}, ${target.version}, ${content.api.description || ''},
            ${content.api.tags || []}, ${content.api.visibility || 'public'}, ${content.api.acl || []}, 'published', ${normalizeDraft(content.draft)})`;
      }
      if (existing && plan.draft.replaced) {
        await tx`update apis set draft = ${normalizeDraft(content.draft)}, name = ${content.api.name}, description = ${content.api.description || ''},
          tags = ${content.api.tags || []}, visibility = ${content.api.visibility || 'public'}, acl = ${content.api.acl || []},
          lifecycle = case when lifecycle = 'created' then 'published' else lifecycle end, draft_updated_at = now(), updated_at = now()
          where id = ${target.id}`;
      }
      if (plan.draft.replaced) {
        // the documentation pages are the snapshot's, under their ids when they are free
        await tx`delete from api_doc_pages where api_id = ${target.id}`;
        const ids = {};
        for (const p of content.docs?.pages || []) ids[p.id] = (await tx`select 1 from api_doc_pages where id = ${p.id}`)[0] ? newId('page') : p.id;
        for (const p of content.docs?.pages || [])
          await tx`insert into api_doc_pages (id, api_id, parent_id, slug, position, title, content)
            values (${ids[p.id]}, ${target.id}, ${p.parent_id ? ids[p.parent_id] || null : null}, ${p.slug}, ${p.position || 0}, ${p.title || {}}, ${p.content || {}})`;
      }
      const number = ((await tx`select max(number)::int as n from api_snapshots where api_id = ${target.id}`)[0].n || 0) + 1;
      const id = (await tx`select 1 from api_snapshots where id = ${doc.source.snapshot.id}`)[0] ? newId('snap') : doc.source.snapshot.id;
      const s = doc.source.snapshot;
      const origin = {
        installation: doc.source.installation,
        url: doc.source.url,
        workspace: doc.source.workspace,
        api_id: doc.source.api.id,
        snapshot_id: s.id,
        number: s.number,
        published_at: s.published_at,
        published_by: s.published_by,
        digest: doc.digest,
        promoted_at: new Date().toISOString(),
        // the installations it went through before
        via: [...(doc.source.origin?.via || []), ...(doc.source.origin ? [{ installation: doc.source.origin.installation, number: doc.source.origin.number }] : [])],
      };
      const comment = `promoted from ${doc.source.installation} #${s.number}${s.comment ? `: ${s.comment}` : ''}`;
      return (await tx`insert into api_snapshots (id, api_id, number, content, comment, published_by, origin)
        values (${id}, ${target.id}, ${number}, ${content}, ${comment}, ${ctx.user?.id || null}, ${origin}) returning *`)[0];
    });
    await audit(ctx, {
      action: 'api.promote',
      workspaceId: ws.id,
      entityKind: 'api',
      entityId: target.id,
      summary: `${content.api.name} ${target.version}: snapshot #${doc.source.snapshot.number} of ${doc.source.installation} promoted as #${snapshot.number}`,
      data: { digest: doc.digest, source: doc.source, changes: (plan.changes || []).slice(0, 50) },
    });
  }
  const out = { promoted: !already, ...plan, snapshot: { id: snapshot.id, number: snapshot.number } };
  if (deploy) {
    const row = (await db`select * from apis where id = ${target.id}`)[0];
    out.deployment = await deployments.deploy(ctx, row, { snapshot: snapshot.id });
  }
  return out;
}
