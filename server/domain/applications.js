// Application: groups the subscriptions and the technical identity of a consumer — its
// expected client_id (oauth2, mtls) and client certificates. It groups identity, never counters.
// Whoever can see an application can see its credentials.

import { db, newId } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { findTeam, isTeamMember } from './identity.js';
import { checkValues } from './metadata.js';
import { readCertificate } from './pki.js';
import { enqueue, registerTaskHandler } from './tasks.js';
import { DERIVED_PATHS, oto } from '../otoroshi/client.js';
import { IDENTITY_KINDS, applicationCertificates } from '../otoroshi/projection.js';

export async function listApplications(workspaceId, { userId = null, teamId = null } = {}) {
  return db`select a.*, t.name as team_name, t.personal as team_personal,
      (select count(*)::int from subscriptions s where s.application_id = a.id and s.status = 'active') as active_subscriptions,
      (select count(*)::int from subscriptions s where s.application_id = a.id and s.status = 'pending') as pending_subscriptions
    from applications a join teams t on t.id = a.team_id
    where a.workspace_id = ${workspaceId}
      and (${userId}::text is null or exists (select 1 from team_members tm where tm.team_id = a.team_id and tm.user_id = ${userId}))
      and (${teamId}::text is null or a.team_id = ${teamId})
    order by a.name`;
}

export async function getApplication(workspaceId, id) {
  const rows = await db`select a.*, t.name as team_name from applications a join teams t on t.id = a.team_id
    where a.workspace_id = ${workspaceId} and a.id = ${id}`;
  if (!rows[0]) throw notFound('application not found');
  return rows[0];
}

export async function canSeeApplication(ctx, app) {
  if (ctx.user?.is_admin || ctx.role === 'admin') return true;
  if (!ctx.user) return false;
  return isTeamMember(app.team_id, ctx.user.id);
}

export async function requireSeeApplication(ctx, app) {
  if (!(await canSeeApplication(ctx, app))) throw forbidden('you cannot see this application');
}

// the client certificates of an application: readable PEM certificates, never a private key
export function normalizeCertificates(list) {
  const out = [];
  for (const raw of list || []) {
    const pem = String(raw || '').trim();
    if (!pem) continue;
    if (/PRIVATE KEY/.test(pem)) throw badRequest('a client certificate is given without its private key: paste the certificate only');
    try {
      readCertificate(pem);
    } catch (e) {
      throw badRequest(`not a readable PEM certificate: ${e.message}`);
    }
    if (!out.includes(pem)) out.push(pem);
  }
  return out;
}

const syncCertificates = (app) =>
  enqueue('sync_application_certificates', { application_id: app.id, workspace_id: app.workspace_id }, { dedupeKey: `appcerts:${app.id}` });

// the certificates of an application reach the gateway while it has an active subscription to an
// mtls plan, and leave it otherwise: suspending or closing removes the trust in a self-signed one
registerTaskHandler('sync_application_certificates', async ({ application_id }) => {
  const app = (await db`select * from applications where id = ${application_id}`)[0];
  const subscribed = app ? (await db`select 1 from subscriptions where application_id = ${app.id} and auth_kind = 'mtls' and status = 'active' limit 1`).length > 0 : false;
  const wanted = app && subscribed ? applicationCertificates(app) : [];
  for (const d of wanted) await oto.upsertEntity(d.path, d.entity);
  const stale = ((await oto.listCertificates()) || []).filter(
    (c) => c.metadata?.apim_application_id === application_id && c.metadata?.apim_derived === 'true' && !wanted.some((w) => w.id === c.id),
  );
  for (const c of stale) await oto.deleteEntity(DERIVED_PATHS.Certificate, c.id).catch(() => null);
  return { projected: wanted.map((w) => w.id), removed: stale.map((c) => c.id) };
});

export async function createApplication(ctx, workspaceId, input) {
  if (!input.name) throw badRequest('name is required');
  if (!input.team_id) throw badRequest('team_id is required');
  const team = await findTeam(workspaceId, input.team_id);
  if (!team) throw badRequest('unknown team');
  if (!(ctx.user?.is_admin || ctx.role === 'admin') && !(await isTeamMember(team.id, ctx.user.id)))
    throw forbidden('you are not a member of this team');
  // a consumer only fills the fields the portal shows; the producer side fills the others later
  const metadata = await checkValues(workspaceId, 'application', input.metadata || {}, { only: ctx.via === 'portal' ? (f) => f.portal : null, requireAll: ctx.via === 'portal' });
  const id = newId('app');
  const rows = await db`insert into applications (id, workspace_id, team_id, name, description, client_id, certificates, metadata, created_by)
    values (${id}, ${workspaceId}, ${team.id}, ${input.name}, ${input.description || ''}, ${input.client_id || null},
      ${normalizeCertificates(input.certificates)}, ${metadata}, ${ctx.user?.id || null}) returning *`;
  await audit(ctx, { action: 'application.create', workspaceId, entityKind: 'application', entityId: id, summary: `application ${input.name} created` });
  return rows[0];
}

// what a Kubernetes resource describes changes there: the console refuses, the controller does not
export function requireUnmanaged(ctx, obj, what) {
  if (obj.managed_by && ctx.managedBy !== obj.managed_by) throw conflict(`this ${what} is managed by ${obj.managed_by}: change it at its source`, { managed_by: obj.managed_by });
}

export async function updateApplication(ctx, app, patch) {
  requireUnmanaged(ctx, app, 'application');
  // the gateway serves one consumer per client id and plan: not the client id another application
  // already subscribed with to a plan this one subscribes to
  const nextClientId = patch.client_id !== undefined ? patch.client_id || null : app.client_id;
  if (nextClientId && nextClientId !== app.client_id) {
    const taken = await db`select p.name from subscriptions s join subscriptions o on o.api_id = s.api_id and o.plan_id = s.plan_id
        join applications other on other.id = o.application_id
        cross join lateral (select coalesce(s.request->>'plan_name', s.plan_id) as name) p
      where s.application_id = ${app.id} and other.id <> ${app.id} and other.client_id = ${nextClientId}
        and s.auth_kind = any(${'{' + IDENTITY_KINDS.join(',') + '}'}::text[])
        and s.status in ('pending', 'pending_payment', 'active', 'suspended', 'expired') and o.status in ('pending', 'pending_payment', 'active', 'suspended', 'expired')
      limit 1`;
    if (taken.length) throw conflict(`another application subscribed to ${taken[0].name} with the client_id ${nextClientId}: the gateway serves one consumer per client id and plan`);
  }
  if (patch.metadata !== undefined)
    patch = { ...patch, metadata: await checkValues(app.workspace_id, 'application', { ...app.metadata, ...patch.metadata }, { only: ctx.via === 'portal' ? (f) => f.portal : null }) };
  const rows = await db`update applications set name = ${patch.name ?? app.name}, description = ${patch.description ?? app.description},
      client_id = ${patch.client_id !== undefined ? patch.client_id || null : app.client_id},
      certificates = ${patch.certificates !== undefined ? normalizeCertificates(patch.certificates) : app.certificates}, metadata = ${patch.metadata ?? app.metadata}, updated_at = now()
    where id = ${app.id} returning *`;
  await audit(ctx, { action: 'application.update', workspaceId: app.workspace_id, entityKind: 'application', entityId: app.id, summary: `application ${rows[0].name} updated` });
  if (patch.certificates !== undefined || patch.name !== undefined) await syncCertificates(rows[0]);
  // the subscriptions to token and certificate plans carry the client id the application declares
  if ((rows[0].client_id || null) !== (app.client_id || null)) {
    const subs = await db`select id from subscriptions where application_id = ${app.id} and status in ('active', 'suspended', 'expired')
      and auth_kind = any(${'{' + IDENTITY_KINDS.join(',') + '}'}::text[])`;
    for (const s of subs) await enqueue('sync_subscription', { subscription_id: s.id }, { dedupeKey: `sub:${s.id}` });
  }
  return rows[0];
}

export async function deleteApplication(ctx, app) {
  requireUnmanaged(ctx, app, 'application');
  const active = await db`select count(*)::int as c from subscriptions where application_id = ${app.id} and status in ('active', 'suspended', 'expired', 'pending', 'pending_payment')`;
  if (active[0].c > 0) throw badRequest('close the subscriptions of this application first');
  await db`delete from applications where id = ${app.id}`;
  await syncCertificates(app);
  await audit(ctx, { action: 'application.delete', workspaceId: app.workspace_id, entityKind: 'application', entityId: app.id, summary: `application ${app.name} deleted` });
}
