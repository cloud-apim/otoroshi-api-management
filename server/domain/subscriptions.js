// Subscriptions: (application x plan) -> state + credentials. The approval workflow belongs entirely
// to the product (D-1): Otoroshi 18 only carries `validation` as a label.
//
// Projection rules learned from Otoroshi 18 (spec §5), fixed here by construction:
//  - a pending subscription gets an enabled key in Otoroshi -> pending subscriptions are never projected
//  - deleting a subscription revokes nothing -> keys are deleted explicitly before the subscription

import { db, newId } from '../db/index.js';
import { badRequest, conflict, forbidden, notFound } from '../http/router.js';
import { audit } from './audit.js';
import { CREDENTIAL_KINDS, normalizeDraft, plansAreEquivalent } from './model.js';
import { enqueue, registerTaskHandler, PermanentError } from './tasks.js';
import { currentDeployment, deployedSnapshot } from './deployments.js';
import { aclAllows, isTeamMember, userAclTags } from './identity.js';
import { oto } from '../otoroshi/client.js';
import { buildOtoroshiSubscription } from '../otoroshi/projection.js';
import { checkValues } from './metadata.js';

export const OPEN_STATUSES = ['pending', 'pending_payment', 'active', 'suspended'];

export async function listSubscriptions(workspaceId, { apiId, applicationId, status, userId, planId } = {}) {
  return db`select s.*, a.name as api_name, a.version as api_version, a.slug as api_slug, app.name as application_name,
      app.team_id as application_team_id, t.name as team_name, u.email as requested_by_email,
      (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'client_id', c.client_id, 'kind', c.kind, 'status', c.status)), '[]')
         from credentials c where c.subscription_id = s.id) as credentials_summary
    from subscriptions s join apis a on a.id = s.api_id join applications app on app.id = s.application_id
      join teams t on t.id = app.team_id left join users u on u.id = s.requested_by
    where s.workspace_id = ${workspaceId}
      and (${apiId || null}::text is null or s.api_id = ${apiId || null})
      and (${applicationId || null}::text is null or s.application_id = ${applicationId || null})
      and (${planId || null}::text is null or s.plan_id = ${planId || null})
      and (${status || null}::text is null or s.status = ${status || null})
      and (${userId || null}::text is null or exists (select 1 from team_members tm where tm.team_id = app.team_id and tm.user_id = ${userId || null}))
    order by s.created_at desc`;
}

export async function getSubscription(workspaceId, id) {
  const rows = await db`select s.*, a.name as api_name, a.version as api_version, app.name as application_name, app.team_id as application_team_id
    from subscriptions s join apis a on a.id = s.api_id join applications app on app.id = s.application_id
    where s.workspace_id = ${workspaceId} and s.id = ${id}`;
  if (!rows[0]) throw notFound('subscription not found');
  return rows[0];
}

export async function credentialsOf(subscriptionId) {
  return db`select * from credentials where subscription_id = ${subscriptionId} order by created_at`;
}

// the plans a consumer can subscribe to are those of the snapshot running on the gateway
export async function subscribablePlans(api) {
  const snap = await deployedSnapshot(api.id);
  if (!snap) return { snapshot: null, plans: [] };
  const draft = normalizeDraft(snap.content.draft);
  return { snapshot: snap, plans: draft.plans };
}

async function findPlan(api, planId) {
  const { snapshot, plans } = await subscribablePlans(api);
  if (!snapshot) throw badRequest('this api is not deployed: there is nothing to subscribe to');
  const plan = plans.find((p) => p.id === planId);
  if (!plan) throw badRequest('unknown plan for the deployed version of this api');
  return { plan, snapshot };
}

function now() {
  return new Date().toISOString();
}

export async function requestSubscription(ctx, workspaceId, input) {
  const { api_id, plan_id, application_id } = input;
  const api = (await db`select * from apis where id = ${api_id} and workspace_id = ${workspaceId}`)[0];
  if (!api) throw notFound('api not found');
  if (['deprecated', 'archived'].includes(api.lifecycle)) throw badRequest(`this api is ${api.lifecycle}: new subscriptions are closed`);
  const app = (await db`select * from applications where id = ${application_id} and workspace_id = ${workspaceId}`)[0];
  if (!app) throw notFound('application not found');
  const privileged = ctx.user?.is_admin || ctx.role === 'admin' || ctx.role === 'producer';
  if (!privileged && !(await isTeamMember(app.team_id, ctx.user.id))) throw forbidden('you are not a member of the team owning this application');
  const { plan } = await findPlan(api, plan_id);
  if (plan.status !== 'published') throw badRequest(`plan ${plan.name} is ${plan.status}: it does not accept subscriptions`);
  // a non subscribable plan is out of self-service: only a producer can put a consumer on it (a contract)
  if (!plan.subscribable && !privileged) throw badRequest(`plan ${plan.name} is not open to self-service subscription`);
  const tags = await userAclTags(ctx.user, workspaceId);
  if (!privileged && !aclAllows(plan.visibility, plan.acl, tags)) throw forbidden('this plan is not visible to you');
  if (plan.usageStatement?.enabled && plan.usageStatement?.required && !(input.usage || '').trim())
    throw badRequest('this plan asks you to describe your intended usage');
  if (plan.terms?.enabled && !input.terms_accepted) throw badRequest('you must accept the terms of use of this plan');
  if (['oauth2-remote', 'jwt', 'mtls'].includes(plan.auth.kind) && !app.client_id)
    throw badRequest(`a ${plan.auth.kind} plan identifies the consumer by its client_id: declare the expected client_id on the application first (D-26)`);
  const dup = await db`select id from subscriptions where application_id = ${app.id} and api_id = ${api.id} and plan_id = ${plan.id}
    and status = any(${'{' + OPEN_STATUSES.join(',') + '}'}::text[])`;
  if (dup.length) throw conflict('this application already has an open subscription to this plan');

  // the request form of the plan: the subscription-scoped fields asked to the requester (D-18)
  const metadata = await checkValues(workspaceId, 'subscription', input.metadata || {}, { only: (f) => f.portal });
  const paid = plan.pricing?.kind === 'paid';
  let status = plan.validation === 'manual' ? 'pending' : paid ? 'pending_payment' : 'active';
  const id = newId('sub');
  const dates = { created_at: now(), ...(status === 'active' ? { processed_at: now(), started_at: now() } : {}) };
  const request = {
    usage: input.usage || '',
    terms_accepted: !!input.terms_accepted,
    terms_url: plan.terms?.enabled ? plan.terms.url || plan.terms.pageSlug || '' : '',
    accepted_at: input.terms_accepted ? now() : null,
    plan_name: plan.name,
  };
  const rows = await db`insert into subscriptions (id, workspace_id, api_id, plan_id, application_id, auth_kind, status, request, dates,
      payment, projection, requested_by, metadata)
    values (${id}, ${workspaceId}, ${api.id}, ${plan.id}, ${app.id}, ${plan.auth.kind}, ${status}, ${request}, ${dates},
      ${paid ? { status: 'awaiting_payment', provider: plan.pricing.provider } : {}}, ${{ status: status === 'active' ? 'pending' : 'none' }},
      ${ctx.user?.id || null}, ${metadata}) returning *`;
  await audit(ctx, {
    action: 'subscription.request',
    workspaceId,
    entityKind: 'subscription',
    entityId: id,
    summary: `${app.name} requested ${api.name} ${api.version} / ${plan.name} (${status})`,
  });
  if (status === 'active') await enqueue('sync_subscription', { subscription_id: id }, { dedupeKey: `sub:${id}` });
  return (await db`select * from subscriptions where id = ${id}`)[0];
}

async function setStatus(ctx, sub, status, { review, datesPatch = {}, action, summary, payment } = {}) {
  const dates = { ...sub.dates, ...datesPatch };
  const rows = await db`update subscriptions set status = ${status}, dates = ${dates}, review = ${review ?? sub.review},
      payment = ${payment ?? sub.payment}, projection = ${{ ...sub.projection, status: 'pending' }}, updated_at = now()
    where id = ${sub.id} returning *`;
  await audit(ctx, { action, workspaceId: sub.workspace_id, entityKind: 'subscription', entityId: sub.id, summary });
  await enqueue('sync_subscription', { subscription_id: sub.id }, { dedupeKey: `sub:${sub.id}` });
  return (await db`select * from subscriptions where id = ${sub.id}`)[0] || rows[0];
}

export async function acceptSubscription(ctx, sub, { message = '' } = {}) {
  if (sub.status !== 'pending') throw badRequest(`a ${sub.status} subscription cannot be accepted`);
  const api = (await db`select * from apis where id = ${sub.api_id}`)[0];
  const { plan } = await findPlan(api, sub.plan_id);
  const paid = plan.pricing?.kind === 'paid';
  return setStatus(ctx, sub, paid ? 'pending_payment' : 'active', {
    review: { decision: 'accepted', by: ctx.user?.email, at: now(), message },
    datesPatch: { processed_at: now(), ...(paid ? {} : { started_at: now() }) },
    action: 'subscription.accept',
    summary: `subscription ${sub.id} accepted${message ? `: ${message}` : ''}`,
  });
}

export async function rejectSubscription(ctx, sub, { message = '' } = {}) {
  if (sub.status !== 'pending') throw badRequest(`a ${sub.status} subscription cannot be rejected`);
  return setStatus(ctx, sub, 'rejected', {
    review: { decision: 'rejected', by: ctx.user?.email, at: now(), message },
    datesPatch: { processed_at: now() },
    action: 'subscription.reject',
    summary: `subscription ${sub.id} rejected${message ? `: ${message}` : ''}`,
  });
}

export async function suspendSubscription(ctx, sub, { message = '' } = {}) {
  if (sub.status !== 'active') throw badRequest(`a ${sub.status} subscription cannot be suspended`);
  return setStatus(ctx, sub, 'suspended', {
    review: { ...sub.review, suspended_by: ctx.user?.email, suspension_message: message },
    datesPatch: { suspended_at: now() },
    action: 'subscription.suspend',
    summary: `subscription ${sub.id} suspended`,
  });
}

export async function resumeSubscription(ctx, sub) {
  if (sub.status !== 'suspended') throw badRequest(`a ${sub.status} subscription cannot be resumed`);
  return setStatus(ctx, sub, 'active', { datesPatch: { resumed_at: now() }, action: 'subscription.resume', summary: `subscription ${sub.id} resumed` });
}

export async function closeSubscription(ctx, sub) {
  if (!OPEN_STATUSES.includes(sub.status)) throw badRequest(`a ${sub.status} subscription cannot be closed`);
  return setStatus(ctx, sub, 'closed', { datesPatch: { closed_at: now() }, action: 'subscription.close', summary: `subscription ${sub.id} closed` });
}

// test payment connector (D-36): stands for Stripe's checkout.session.completed webhook
export async function confirmPayment(ctx, sub, { providerRef } = {}) {
  if (sub.status !== 'pending_payment') throw badRequest('this subscription is not waiting for a payment');
  return setStatus(ctx, sub, 'active', {
    datesPatch: { started_at: now() },
    payment: { ...sub.payment, status: 'paid', provider_ref: providerRef || newId('pay_test'), paid_at: now() },
    action: 'subscription.payment',
    summary: `payment received for subscription ${sub.id}`,
  });
}

// D-30: transfer to an equivalent plan (same auth mechanism). The key does not change, the
// subscription keeps its identity and its history. Works across versions (D-29).
export async function transferSubscription(ctx, sub, { plan_id, api_id }) {
  if (!['active', 'suspended'].includes(sub.status)) throw badRequest(`a ${sub.status} subscription cannot be transferred`);
  const fromApi = (await db`select * from apis where id = ${sub.api_id}`)[0];
  const toApi = (await db`select * from apis where id = ${api_id || sub.api_id} and workspace_id = ${sub.workspace_id}`)[0];
  if (!toApi) throw notFound('target api not found');
  const { plans: fromPlans } = await subscribablePlans(fromApi);
  const fromPlan = fromPlans.find((p) => p.id === sub.plan_id) || { auth: { kind: sub.auth_kind }, name: sub.plan_id };
  const { plan: toPlan } = await findPlan(toApi, plan_id);
  if (toApi.id === sub.api_id && toPlan.id === sub.plan_id) throw badRequest('the subscription is already on this plan');
  if (!plansAreEquivalent(fromPlan, toPlan))
    throw badRequest(`plans are not equivalent: ${fromPlan.auth.kind} -> ${toPlan.auth.kind}. Changing the auth mechanism changes the credential: that is a new subscription, not a transfer (D-30)`);
  if (toPlan.status !== 'published') throw badRequest(`target plan is ${toPlan.status}`);
  const history = [
    ...(sub.history || []),
    { at: now(), by: ctx.user?.email, from: { api_id: sub.api_id, plan_id: sub.plan_id, plan_name: fromPlan.name }, to: { api_id: toApi.id, plan_id: toPlan.id, plan_name: toPlan.name } },
  ];
  await db`update subscriptions set api_id = ${toApi.id}, plan_id = ${toPlan.id}, history = ${history},
      projection = ${{ ...sub.projection, status: 'pending' }}, updated_at = now() where id = ${sub.id}`;
  await audit(ctx, {
    action: 'subscription.transfer',
    workspaceId: sub.workspace_id,
    entityKind: 'subscription',
    entityId: sub.id,
    summary: `subscription ${sub.id} transferred from ${fromApi.name} ${fromApi.version}/${fromPlan.name} to ${toApi.name} ${toApi.version}/${toPlan.name}`,
  });
  await enqueue('sync_subscription', { subscription_id: sub.id }, { dedupeKey: `sub:${sub.id}` });
  return (await db`select * from subscriptions where id = ${sub.id}`)[0];
}

export async function rotateCredential(ctx, sub, credentialId) {
  const cred = (await db`select * from credentials where id = ${credentialId} and subscription_id = ${sub.id}`)[0];
  if (!cred) throw notFound('credential not found');
  const key = await oto.getApikey(cred.client_id);
  if (!key) throw badRequest('the key does not exist on the gateway yet');
  const secret = [...crypto.getRandomValues(new Uint8Array(40))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  await oto.updateApikey({ ...key, clientSecret: secret });
  await db`update credentials set client_secret = ${secret}, rotated_at = now() where id = ${cred.id}`;
  await audit(ctx, { action: 'credential.rotate', workspaceId: sub.workspace_id, entityKind: 'subscription', entityId: sub.id, summary: `secret of ${cred.client_id} rotated` });
  return (await db`select * from credentials where id = ${cred.id}`)[0];
}

// ---------------------------------------------------------------- projection (idempotent)

async function removeFromGateway(sub, existing) {
  const refs = existing?.token_refs || sub.projection?.token_refs || [];
  for (const ref of refs) if (ref.apikey) await oto.deleteApikey(ref.apikey).catch(() => null);
  const creds = await credentialsOf(sub.id);
  for (const c of creds) if (c.status === 'active') await oto.deleteApikey(c.client_id).catch(() => null);
  if (existing) await oto.deleteSubscription(sub.id);
  await db`update credentials set status = 'revoked', revoked_at = now() where subscription_id = ${sub.id} and status = 'active'`;
}

registerTaskHandler('sync_subscription', async ({ subscription_id }) => {
  const sub = (await db`select * from subscriptions where id = ${subscription_id}`)[0];
  if (!sub) return { skipped: 'deleted' };
  const app = (await db`select * from applications where id = ${sub.application_id}`)[0];
  const wanted = ['active', 'suspended'].includes(sub.status);
  const setProjection = (p) => db`update subscriptions set projection = ${p}, updated_at = now() where id = ${sub.id}`;
  try {
    const existing = await oto.getSubscription(sub.id);
    if (!wanted) {
      await removeFromGateway(sub, existing);
      await setProjection({ status: existing ? 'removed' : 'none', synced_at: now() });
      return { removed: !!existing };
    }
    const dep = await currentDeployment(sub.api_id);
    if (!dep) {
      await setProjection({ ...sub.projection, status: 'waiting', error: 'the api is not deployed yet: the subscription will be projected at deployment' });
      throw new Error('api not deployed');
    }
    const entity = buildOtoroshiSubscription(sub, { application: app });
    let written;
    if (!existing) {
      written = await oto.createSubscription(entity);
    } else {
      entity.token_refs = existing.token_refs || [];
      entity.dates.created_at = existing.dates?.created_at || entity.dates.created_at;
      written = await oto.updateSubscription(entity);
    }
    const tokenRefs = written?.token_refs || entity.token_refs || [];
    if (CREDENTIAL_KINDS.includes(sub.auth_kind)) {
      for (const ref of tokenRefs) {
        if (!ref.apikey) continue;
        const key = await oto.getApikey(ref.apikey);
        if (!key) continue;
        const found = (await db`select id from credentials where subscription_id = ${sub.id} and client_id = ${key.clientId}`)[0];
        const otoInfo = { enabled: key.enabled, apiRef: key.apiRef, authorizations: key.authorizations };
        if (found) {
          await db`update credentials set client_secret = ${key.clientSecret}, status = 'active', otoroshi = ${otoInfo}, revoked_at = null where id = ${found.id}`;
        } else {
          await db`insert into credentials (id, subscription_id, application_id, kind, client_id, client_secret, otoroshi)
            values (${newId('cred')}, ${sub.id}, ${sub.application_id}, ${sub.auth_kind === 'oauth2-local' ? 'client_credentials' : 'apikey'},
              ${key.clientId}, ${key.clientSecret}, ${otoInfo})`;
        }
      }
    }
    await setProjection({ status: 'synced', otoroshi_subscription_id: sub.id, token_refs: tokenRefs, synced_at: now(), error: null });
    return { synced: true, token_refs: tokenRefs };
  } catch (e) {
    if (e.message !== 'api not deployed') await setProjection({ ...sub.projection, status: 'error', error: e.message, synced_at: now() });
    if (e.status >= 400 && e.status < 500) throw new PermanentError(e.message);
    throw e;
  }
});

export async function setSubscriptionMetadata(ctx, sub, values) {
  const metadata = await checkValues(sub.workspace_id, 'subscription', { ...sub.metadata, ...values });
  await db`update subscriptions set metadata = ${metadata}, updated_at = now() where id = ${sub.id}`;
  await audit(ctx, { action: 'subscription.metadata', workspaceId: sub.workspace_id, entityKind: 'subscription', entityId: sub.id, summary: `metadata of ${sub.id} updated` });
  return (await db`select * from subscriptions where id = ${sub.id}`)[0];
}

export async function resync(ctx, sub) {
  return enqueue('sync_subscription', { subscription_id: sub.id }, { dedupeKey: `sub:${sub.id}` });
}
