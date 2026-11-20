// Deployment: the described state is not the deployed state. A deployment pushes a
// frozen snapshot to the installation's single Otoroshi cluster, as an Api managed as code (each
// write is a deploy, recorded by Otoroshi with the snapshot as its ref), and shows its diff before
// acting. Rollback is the redeployment of an earlier snapshot.

import { db, newId } from '../db/index.js';
import { likePattern } from '../http/paging.js';
import { threatWarnings } from '../otoroshi/threats.js';
import { badRequest, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { diff } from './diff.js';
import { getSnapshot, lastSnapshot } from './apis.js';
import { enqueue, registerTaskHandler, PermanentError } from './tasks.js';
import { normalizeDraft, SERVED_STATUSES, validateDraft } from './model.js';
import { oto } from '../otoroshi/client.js';
import { buildOtoroshiApi, comparableApi, comparableDerived, derivedEntities } from '../otoroshi/projection.js';
import { DERIVED_PATHS, META } from '../otoroshi/client.js';

// the kinds of objects the product derives from api descriptions (JWT verifiers, certificates,
// auth modules), each recognised by its markers
const DERIVED_KINDS = [
  { path: DERIVED_PATHS.JwtVerifier, list: () => oto.listJwtVerifiers() },
  { path: DERIVED_PATHS.Certificate, list: () => oto.listCertificates() },
  { path: DERIVED_PATHS.AuthModule, list: () => oto.listAuthModules() },
];

// the derived objects are written before the Api (it references them); `between` writes the Api;
// the stale derived objects of this api are removed after it, when nothing references them
async function syncDerived(apiId, snapshotContent, between = async () => null) {
  const wanted = snapshotContent ? derivedEntities(snapshotContent) : [];
  for (const d of wanted) await oto.upsertEntity(d.path, d.entity);
  const written = await between();
  const removed = [];
  for (const k of DERIVED_KINDS) {
    const all = (await k.list()) || [];
    const stale = all.filter((v) => v.metadata?.[META.api] === apiId && v.metadata?.apim_derived === 'true' && !wanted.some((w) => w.path === k.path && w.id === v.id));
    for (const v of stale) {
      await oto.deleteEntity(k.path, v.id).catch(() => null);
      removed.push(v.id);
    }
  }
  return { derived: wanted.map((w) => w.id), removed, written };
}

// what the gateway's own settings make of the snapshot: they are infrastructure the product
// consumes and does not change, so it says when they defeat a plan
async function gatewayWarnings(content, derived) {
  return [...(await tlsWarnings(content, derived)), ...(await threatWarnings(content.draft).catch(() => []))];
}

async function tlsWarnings(content, derived) {
  const mtls = (normalizeDraft(content.draft).plans || []).filter((p) => SERVED_STATUSES.includes(p.status) && p.auth.kind === 'mtls');
  if (!mtls.length) return [];
  const tls = (await oto.globalConfig().catch(() => null))?.tlsSettings;
  if (!tls) return [];
  const out = [];
  if (!['Want', 'Need'].includes(tls.clientAuth))
    out.push({
      path: 'plans',
      code: 'gateway_no_client_auth',
      message: `the gateway does not ask callers for a client certificate (TLS client auth: ${tls.clientAuth}): nobody can use the mtls plan${mtls.length > 1 ? 's' : ''} ${mtls.map((p) => `"${p.name}"`).join(', ')} until an operator sets it to Want or Need`,
    });
  const trusted = tls.trustedCAsServer || [];
  const cas = derived.filter((d) => d.kind === 'Certificate');
  if (trusted.length && cas.some((c) => !trusted.includes(c.id)))
    out.push({
      path: 'plans',
      code: 'ca_not_trusted_by_gateway',
      message: 'the gateway trusts a fixed list of CAs (trustedCAsServer) that does not hold the CAs derived from the mtls plans: an operator has to add them',
    });
  return out;
}

export async function currentDeployment(apiId) {
  const rows = await db`select d.*, s.number as snapshot_number from api_deployments d left join api_snapshots s on s.id = d.snapshot_id
    where d.api_id = ${apiId} and d.status = 'deployed' order by d.finished_at desc limit 1`;
  const d = rows[0];
  if (!d || d.action === 'undeploy') return null;
  return d;
}

// the deployments of an api, newest first, searched (action, status, snapshot number, who, error) and paged
export async function listDeployments(apiId, { limit = 50, offset = 0, q = '' } = {}) {
  const pattern = q ? likePattern(q.replace(/^#/, '')) : null;
  const matches = db`(${pattern}::text is null or d.action ilike ${pattern} or d.status ilike ${pattern} or s.number::text ilike ${pattern}
    or coalesce(u.email, '') ilike ${pattern} or coalesce(d.error, '') ilike ${pattern})`;
  const from = db`api_deployments d left join api_snapshots s on s.id = d.snapshot_id left join users u on u.id = d.requested_by`;
  const [items, [{ total }]] = await Promise.all([
    db`select d.*, s.number as snapshot_number, u.email as requested_by_email from ${from}
      where d.api_id = ${apiId} and ${matches} order by d.requested_at desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from ${from} where d.api_id = ${apiId} and ${matches}`,
  ]);
  return { items, total, limit, offset };
}

export async function deployedSnapshot(apiId) {
  const d = await currentDeployment(apiId);
  if (!d?.snapshot_id) return null;
  const rows = await db`select * from api_snapshots where id = ${d.snapshot_id}`;
  return rows[0] || null;
}

async function resolveSnapshot(api, snapshotRef) {
  if (snapshotRef) return getSnapshot(api.id, snapshotRef);
  const last = await lastSnapshot(api.id);
  if (!last) throw badRequest('nothing to deploy: publish a snapshot first');
  return last;
}

// the diff of a deployment: between the snapshot that runs and the one about to be pushed, both
// frozen, plus the gateway-level diff against what Otoroshi actually holds
export async function planDeployment(api, snapshotRef) {
  const snapshot = await resolveSnapshot(api, snapshotRef);
  const running = await deployedSnapshot(api.id);
  const preview = await previewContent(api, snapshot.content, { snapshotId: snapshot.id, snapshotNumber: snapshot.number });
  return {
    snapshot: { id: snapshot.id, number: snapshot.number, published_at: snapshot.published_at, comment: snapshot.comment },
    running: running ? { id: running.id, number: running.number } : null,
    changes: running ? diff(running.content, snapshot.content) : null,
    ...preview,
  };
}

// what deploying a content would change on the gateway, and what the gateway's own settings make
// of it — for a stored snapshot, or for one about to be promoted
export async function previewContent(api, content, { snapshotId = null, snapshotNumber = null } = {}) {
  const entity = buildOtoroshiApi(content, { snapshotId, snapshotNumber, lifecycle: api.lifecycle });
  let gateway = null;
  let gatewayError = null;
  try {
    gateway = await oto.getApi(api.id);
  } catch (e) {
    gatewayError = e.message;
  }
  const validation = validateDraft(content.draft);
  const gatewayChanges = diff(comparableApi(gateway), comparableApi(entity));
  const derived = derivedEntities(content);
  if (!gatewayError) {
    for (const d of derived) {
      const got = await oto.getEntity(d.path, d.id).catch(() => null);
      if (!got) gatewayChanges.push({ op: 'add', path: `derived[${d.kind} ${d.entity.name}]`, after: d.id });
      else diff(comparableDerived(got), comparableDerived(d.entity), `derived[${d.kind} ${d.entity.name}]`, gatewayChanges);
    }
  }
  const warnings = [...validation.warnings, ...(gatewayError ? [] : await gatewayWarnings(content, derived))];
  return {
    gatewayChanges,
    derived: derived.map((d) => ({ kind: d.kind, id: d.id, name: d.entity.name })),
    gatewayExists: !!gateway,
    gatewayError,
    warnings,
    entity,
  };
}

export async function deploy(ctx, api, { snapshot: snapshotRef, dryRun = false } = {}) {
  if (api.lifecycle === 'archived') throw badRequest('an archived api cannot be deployed');
  const plan = await planDeployment(api, snapshotRef);
  if (dryRun) return { dryRun: true, ...plan };
  const id = newId('dep');
  await db`insert into api_deployments (id, api_id, snapshot_id, action, status, requested_by)
    values (${id}, ${api.id}, ${plan.snapshot.id}, 'deploy', 'pending', ${ctx.user?.id || null})`;
  await audit(ctx, {
    action: 'api.deploy',
    workspaceId: api.workspace_id,
    entityKind: 'api',
    entityId: api.id,
    summary: `${api.name} ${api.version}: deployment of snapshot #${plan.snapshot.number} requested`,
    data: { deployment_id: id, changes: (plan.changes || []).slice(0, 50) },
  });
  const task = await enqueue('deploy_api', { deployment_id: id }, { dedupeKey: `deploy:${api.id}` });
  const dep = (await db`select * from api_deployments where id = ${id}`)[0];
  return { deployment: dep, task: { id: task.id, status: task.status, last_error: task.last_error }, ...plan, entity: undefined };
}

export async function undeploy(ctx, api) {
  const id = newId('dep');
  await db`insert into api_deployments (id, api_id, snapshot_id, action, status, requested_by)
    values (${id}, ${api.id}, null, 'undeploy', 'pending', ${ctx.user?.id || null})`;
  await audit(ctx, { action: 'api.undeploy', workspaceId: api.workspace_id, entityKind: 'api', entityId: api.id, summary: `${api.name} ${api.version}: undeploy requested` });
  const task = await enqueue('undeploy_api', { deployment_id: id, api_id: api.id }, { dedupeKey: `deploy:${api.id}` });
  return { deployment: (await db`select * from api_deployments where id = ${id}`)[0], task: { id: task.id, status: task.status, last_error: task.last_error } };
}

// ---------------------------------------------------------------- task handlers

registerTaskHandler('deploy_api', async ({ deployment_id }) => {
  const dep = (await db`select * from api_deployments where id = ${deployment_id}`)[0];
  if (!dep) throw new PermanentError('deployment not found');
  if (dep.status !== 'pending') return { skipped: dep.status };
  const api = (await db`select * from apis where id = ${dep.api_id}`)[0];
  const snap = (await db`select * from api_snapshots where id = ${dep.snapshot_id}`)[0];
  if (!api || !snap) throw new PermanentError('api or snapshot not found');
  const entity = buildOtoroshiApi(snap.content, { snapshotId: snap.id, snapshotNumber: snap.number, lifecycle: api.lifecycle });
  try {
    const { written, ...derived } = await syncDerived(api.id, snap.content, () => oto.upsertApi(entity));
    const result = {
      derived,
      otoroshi_api_id: written?.id,
      otoroshi_state: written?.state,
      otoroshi_deployments: (written?.deployments || []).length,
    };
    await db`update api_deployments set status = 'deployed', finished_at = now(), error = null, result = ${result} where id = ${dep.id}`;
    // subscriptions that waited for the api are projected now
    const subs = await db`select id from subscriptions where api_id = ${api.id} and status in ('active', 'suspended', 'expired')`;
    for (const s of subs) await enqueue('sync_subscription', { subscription_id: s.id }, { dedupeKey: `sub:${s.id}`, runNow: false });
    return result;
  } catch (e) {
    await db`update api_deployments set error = ${e.message} where id = ${dep.id}`;
    // a gateway refusal (4xx) will not fix itself by retrying
    if (e.status >= 400 && e.status < 500) {
      await db`update api_deployments set status = 'failed', finished_at = now() where id = ${dep.id}`;
      throw new PermanentError(e.message);
    }
    throw e;
  }
});

// undeploying stops serving the api: the Api is disabled (no route), not deleted — deleting it would
// delete its subscriptions and their keys with it, and the consumers would get new keys at the next
// deployment. The derived objects it references stay with it.
registerTaskHandler('undeploy_api', async ({ deployment_id, api_id }) => {
  const dep = (await db`select * from api_deployments where id = ${deployment_id}`)[0];
  try {
    const actual = await oto.getApi(api_id);
    if (actual?.enabled) await oto.upsertApi({ ...actual, enabled: false });
  } catch (e) {
    if (dep) await db`update api_deployments set error = ${e.message} where id = ${dep.id}`;
    throw e;
  }
  if (dep) await db`update api_deployments set status = 'deployed', finished_at = now(), error = null where id = ${dep.id}`;
  return { removed: api_id };
});

// removing an api from the gateway, used when the api is deleted from the product: Otoroshi deletes
// its subscriptions, their keys and the keys its plans minted with it; the derived objects follow
registerTaskHandler('purge_api', async ({ api_id }) => {
  await oto.deleteApi(api_id);
  await syncDerived(api_id, null);
  return { purged: api_id };
});

export async function purgeFromGateway(api) {
  return enqueue('purge_api', { api_id: api.id }, { dedupeKey: `deploy:${api.id}` });
}

export async function deploymentStatus(api) {
  const current = await currentDeployment(api.id);
  const last = (await db`select d.*, s.number as snapshot_number from api_deployments d left join api_snapshots s on s.id = d.snapshot_id
    where d.api_id = ${api.id} order by d.requested_at desc limit 1`)[0];
  const lastSnap = await lastSnapshot(api.id);
  return {
    deployed: !!current,
    // an undeployed api stays on the gateway, disabled: removing it from the product purges it there
    on_gateway: !!last,
    current: current ? { id: current.id, snapshot_id: current.snapshot_id, snapshot_number: current.snapshot_number, at: current.finished_at } : null,
    last: last || null,
    latest_snapshot: lastSnap ? { id: lastSnap.id, number: lastSnap.number } : null,
    out_of_sync: !!lastSnap && (!current || current.snapshot_id !== lastSnap.id),
  };
}
