// The Kubernetes controller (role `controller`): the product's entities as resources of the
// cluster — Api (the declarative document), Application, Subscription — reconciled into the
// product, which projects them on the gateway as it does any other. A resource owns what it
// describes (marked `kubernetes:<namespace>/<plural>/<name>`): the console refuses to change it,
// the resource is where it changes. The credentials of a subscription are written to a Secret of
// its namespace, owned by the resource.
//
// Its workspace: the annotation otoroshi-apim.io/workspace of the resource, else the label of the
// same name on its namespace, else the name of the namespace.

import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { audit } from '../domain/audit.js';
import * as identity from '../domain/identity.js';
import * as apis from '../domain/apis.js';
import * as deployments from '../domain/deployments.js';
import * as applications from '../domain/applications.js';
import * as subscriptions from '../domain/subscriptions.js';
import { MODES } from '../domain/catalogs.js';
import { API_KIND, API_VERSION, applyApiDocument } from '../domain/exchange.js';
import { normalizeDraft } from '../domain/model.js';
import { gatewayBaseUrl } from '../roles/portal-api.js';
import { GROUP, VERSION, kubeClient, kubeConfig } from './client.js';

export const FINALIZER = `${GROUP}/cleanup`;
export const ANNOTATIONS = { workspace: `${GROUP}/workspace`, mode: `${GROUP}/mode`, deletion: `${GROUP}/deletion-policy` };
const OPEN = ['pending', 'pending_payment', 'active', 'suspended'];

export const markerOf = (plural, cr) => `kubernetes:${cr.metadata.namespace}/${plural}/${cr.metadata.name}`;

// not a failure: something to wait for, such as the application of a subscription not reconciled yet
class Waiting extends Error {}

// the declarative document a resource Api describes: its spec is the document's spec
export function documentOf(cr) {
  const { slug, version, ...spec } = cr.spec || {};
  return { apiVersion: API_VERSION, kind: API_KIND, metadata: { name: slug || cr.metadata.name, version: version || '1.0.0' }, spec };
}

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const digest = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const messageOf = (e) => (e.details?.errors?.length ? `${e.message}: ${e.details.errors.map((x) => x.message).join('; ')}` : e.message);

export function createController(kube) {
  let namespaces = new Map();

  async function workspaceOf(cr) {
    const ns = cr.metadata.namespace;
    let slug = cr.metadata.annotations?.[ANNOTATIONS.workspace];
    if (!slug) {
      if (!namespaces.has(ns)) namespaces.set(ns, await kube.namespace(ns).catch(() => null));
      slug = namespaces.get(ns)?.metadata?.labels?.[ANNOTATIONS.workspace] || ns;
    }
    const ws = await identity.findWorkspace(slug);
    if (!ws) throw new Error(`the workspace "${slug}" does not exist in the product: create it, or name another one with the label ${ANNOTATIONS.workspace} on the namespace`);
    return ws;
  }

  // the controller acts as an administrator of the workspace, and as the owner of what it marks
  const ctxFor = (ws, marker) => ({ user: null, via: 'kubernetes', role: 'admin', workspace: ws, managedBy: marker });

  // written only when it changes: a status patch on every pass would be noise in the cluster
  // a failure does not mark the generation as observed: it is tried again at the next pass
  async function setStatus(plural, cr, s, { observed = true } = {}) {
    const next = observed ? { ...s, observedGeneration: cr.metadata.generation } : s;
    const cur = cr.status || {};
    if (Object.keys(next).every((k) => JSON.stringify(cur[k] ?? null) === JSON.stringify(next[k] ?? null))) return;
    await kube.patchStatus(plural, cr, { ...next, lastSyncTime: new Date().toISOString() });
  }

  async function ensureFinalizer(plural, cr) {
    const f = cr.metadata.finalizers || [];
    return f.includes(FINALIZER) ? cr : kube.patchMetadata(plural, cr, { finalizers: [...f, FINALIZER] });
  }
  const release = (plural, cr) => kube.patchMetadata(plural, cr, { finalizers: (cr.metadata.finalizers || []).filter((f) => f !== FINALIZER) });
  const detaching = (cr) => (cr.metadata.annotations?.[ANNOTATIONS.deletion] || 'delete') === 'detach';
  const deleting = (cr) => !!cr.metadata.deletionTimestamp;

  // ---------------------------------------------------------------- Api

  async function reconcileApi(cr) {
    const marker = markerOf('apis', cr);
    const owned = (await db`select * from apis where managed_by = ${marker}`)[0];
    if (deleting(cr)) {
      if (!(cr.metadata.finalizers || []).includes(FINALIZER)) return;
      if (owned) {
        const ctx = ctxFor({ id: owned.workspace_id }, marker);
        if (detaching(cr)) await db`update apis set managed_by = null where id = ${owned.id}`;
        else {
          if ((await deployments.deploymentStatus(owned)).deployed) await deployments.purgeFromGateway(owned);
          await apis.deleteApiRow(ctx, owned);
        }
      }
      return release('apis', cr);
    }
    cr = await ensureFinalizer('apis', cr);
    const ws = await workspaceOf(cr);
    const mode = cr.metadata.annotations?.[ANNOTATIONS.mode] || 'deploy';
    if (!MODES.includes(mode)) throw new Error(`${ANNOTATIONS.mode} must be one of ${MODES.join(', ')}`);
    const ctx = ctxFor(ws, marker);
    let api = owned;
    // a generation already reconciled is not applied again; its deployment is followed
    if (!(owned && cr.status?.observedGeneration === cr.metadata.generation && cr.status?.phase === 'Ready')) {
      const res = await applyApiDocument(ctx, ws, documentOf(cr), { managedBy: marker });
      api = await apis.getApi(ws.id, res.api.id);
      if (mode !== 'draft' && (await apis.pendingChanges(api)).hasChanges)
        await apis.publish(ctx, api, { comment: `kubernetes ${cr.metadata.namespace}/${cr.metadata.name}, generation ${cr.metadata.generation}` });
      if (mode === 'deploy') {
        api = await apis.getApi(ws.id, api.id);
        const st = await deployments.deploymentStatus(api);
        const running = st.last?.status === 'pending' && st.last?.snapshot_id === st.latest_snapshot?.id;
        if (st.latest_snapshot && st.out_of_sync && !running) await deployments.deploy(ctx, api, { snapshot: st.latest_snapshot.id });
      }
    }
    api = await apis.getApi(ws.id, api.id);
    const st = await deployments.deploymentStatus(api);
    const snapshot = st.latest_snapshot?.number ?? null;
    let phase = 'Ready';
    let message = null;
    if (mode === 'deploy') {
      if (st.last?.status === 'failed') {
        phase = 'Error';
        message = `deployment of snapshot #${st.last.snapshot_number} failed: ${st.last.error || 'see the projection queue'}`;
      } else if (st.out_of_sync) {
        phase = 'Deploying';
        message = 'the deployment waits for the gateway';
      }
    }
    await setStatus('apis', cr, {
      phase,
      message,
      workspace: ws.slug,
      apiId: api.id,
      snapshot,
      deployed: st.current?.snapshot_number ?? null,
      url: st.deployed ? await gatewayBaseUrl(normalizeDraft(api.draft)) : null,
    });
  }

  // ---------------------------------------------------------------- Application

  async function teamOf(ws, team) {
    if (!team) throw new Error('spec.team: the team that owns the application is required');
    const t = (await db`select id from teams where workspace_id = ${ws.id} and (id = ${team} or name = ${team})`)[0];
    if (!t) throw new Error(`unknown team ${team} in the workspace ${ws.slug}`);
    return t.id;
  }

  async function reconcileApplication(cr) {
    const marker = markerOf('applications', cr);
    const owned = (await db`select * from applications where managed_by = ${marker}`)[0];
    if (deleting(cr)) {
      if (!(cr.metadata.finalizers || []).includes(FINALIZER)) return;
      if (owned) {
        if (detaching(cr)) await db`update applications set managed_by = null where id = ${owned.id}`;
        // its subscriptions are closed first: the application waits for them
        else await applications.deleteApplication(ctxFor({ id: owned.workspace_id }, marker), owned);
      }
      return release('applications', cr);
    }
    cr = await ensureFinalizer('applications', cr);
    const ws = await workspaceOf(cr);
    const ctx = ctxFor(ws, marker);
    const spec = cr.spec || {};
    const input = {
      name: spec.name || cr.metadata.name,
      description: spec.description || '',
      team_id: await teamOf(ws, spec.team),
      client_id: spec.clientId || null,
      certificates: spec.certificates || [],
      metadata: spec.metadata || {},
    };
    let app = owned;
    if (!app) {
      app = await applications.createApplication(ctx, ws.id, input);
      await db`update applications set managed_by = ${marker} where id = ${app.id}`;
    } else if (cr.status?.observedGeneration !== cr.metadata.generation) {
      if (app.team_id !== input.team_id) await db`update applications set team_id = ${input.team_id} where id = ${app.id}`;
      app = await applications.updateApplication(ctx, app, input);
    }
    await setStatus('applications', cr, { phase: 'Ready', message: null, workspace: ws.slug, applicationId: app.id, clientId: app.client_id || null });
  }

  // ---------------------------------------------------------------- Subscription

  async function applicationOf(ws, cr) {
    const spec = cr.spec || {};
    if (spec.applicationId) {
      const app = (await db`select * from applications where workspace_id = ${ws.id} and id = ${spec.applicationId}`)[0];
      if (!app) throw new Error(`unknown application ${spec.applicationId}`);
      return app;
    }
    if (!spec.application) throw new Error('spec.application: the Application resource of this namespace, or spec.applicationId');
    const app = (await db`select * from applications where managed_by = ${`kubernetes:${cr.metadata.namespace}/applications/${spec.application}`}`)[0];
    if (!app) throw new Waiting(`waiting for the Application ${spec.application}`);
    return app;
  }

  async function secretFor(cr, sub, ws) {
    const name = cr.spec?.credentialsSecret || `${cr.metadata.name}-credentials`;
    const creds = (await subscriptions.credentialsOf(sub.id)).filter((c) => c.status === 'active');
    if (sub.status !== 'active' || !creds.length) return null;
    const api = (await db`select * from apis where id = ${sub.api_id}`)[0];
    const snap = await deployments.deployedSnapshot(api.id);
    const c = creds[creds.length - 1];
    const data = {
      clientId: c.client_id,
      clientSecret: c.client_secret,
      kind: c.kind,
      url: snap ? await gatewayBaseUrl(normalizeDraft(snap.content.draft)) : '',
    };
    const version = digest(data);
    const existing = await kube.secret(cr.metadata.namespace, name);
    if (existing?.metadata?.annotations?.[`${GROUP}/credentials`] === version) return name;
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name,
        namespace: cr.metadata.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'otoroshi-api-management' },
        annotations: { [`${GROUP}/credentials`]: version, [`${GROUP}/subscription`]: sub.id },
        // deleted with the resource, by the cluster
        ownerReferences: [{ apiVersion: `${GROUP}/${VERSION}`, kind: 'Subscription', name: cr.metadata.name, uid: cr.metadata.uid, controller: true }],
        ...(existing ? { resourceVersion: existing.metadata.resourceVersion } : {}),
      },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])),
    };
    if (existing) await kube.replaceSecret(cr.metadata.namespace, name, secret);
    else await kube.createSecret(cr.metadata.namespace, secret);
    await audit(ctxFor(ws, null), { action: 'credential.export', workspaceId: ws.id, entityKind: 'subscription', entityId: sub.id, summary: `credentials of ${sub.id} written to the secret ${cr.metadata.namespace}/${name}` });
    return name;
  }

  async function reconcileSubscription(cr) {
    const marker = markerOf('subscriptions', cr);
    const latest = (await db`select * from subscriptions where managed_by = ${marker} order by created_at desc limit 1`)[0];
    if (deleting(cr)) {
      if (!(cr.metadata.finalizers || []).includes(FINALIZER)) return;
      if (latest) {
        if (detaching(cr)) await db`update subscriptions set managed_by = null where managed_by = ${marker}`;
        else if (OPEN.includes(latest.status)) await subscriptions.closeSubscription(ctxFor({ id: latest.workspace_id }, marker), latest);
      }
      return release('subscriptions', cr);
    }
    cr = await ensureFinalizer('subscriptions', cr);
    const ws = await workspaceOf(cr);
    const ctx = ctxFor(ws, marker);
    const spec = cr.spec || {};
    const api = (await db`select * from apis where workspace_id = ${ws.id} and (id = ${spec.api || ''} or (slug = ${spec.api || ''} and version = ${spec.version || '1.0.0'}))`)[0];
    if (!api) throw new Waiting(`waiting for the api ${spec.api} ${spec.version || '1.0.0'}`);
    if (!spec.plan) throw new Error('spec.plan: the id of the plan');
    const app = await applicationOf(ws, cr);
    let sub = latest;
    const fresh = cr.status?.observedGeneration !== cr.metadata.generation;
    // a rejected or closed subscription is asked again only when the resource changes
    if (!sub || (!OPEN.includes(sub.status) && fresh)) {
      sub = await subscriptions.requestSubscription(ctx, ws.id, {
        api_id: api.id,
        plan_id: spec.plan,
        application_id: app.id,
        usage: spec.usage || '',
        terms_accepted: !!spec.termsAccepted,
        metadata: spec.metadata || {},
      });
      await db`update subscriptions set managed_by = ${marker} where id = ${sub.id}`;
      sub = (await db`select * from subscriptions where id = ${sub.id}`)[0];
    } else if (OPEN.includes(sub.status) && fresh && sub.plan_id !== spec.plan && !sub.pending_transfer) {
      await subscriptions.transferSubscription(ctx, sub, { plan_id: spec.plan });
      sub = (await db`select * from subscriptions where id = ${sub.id}`)[0];
    }
    const secret = await secretFor(cr, sub, ws);
    const phase = { active: 'Active', pending: 'Pending', pending_payment: 'Pending', suspended: 'Suspended', rejected: 'Rejected', closed: 'Closed' }[sub.status] || sub.status;
    await setStatus('subscriptions', cr, {
      phase,
      message: sub.status === 'pending' ? 'waiting for a producer to accept it' : sub.status === 'rejected' ? sub.review?.message || 'rejected' : null,
      workspace: ws.slug,
      subscriptionId: sub.id,
      plan: sub.plan_id,
      credentialsSecret: secret,
    });
  }

  const KINDS = [
    ['apis', reconcileApi],
    ['applications', reconcileApplication],
    ['subscriptions', reconcileSubscription],
  ];

  // one pass over every resource, in the order of their dependencies
  async function reconcileOnce() {
    namespaces = new Map();
    const out = [];
    for (const [plural, fn] of KINDS) {
      let items = [];
      try {
        items = await kube.list(plural);
      } catch (e) {
        out.push({ plural, error: e.message });
        continue;
      }
      for (const cr of items) {
        try {
          await fn(cr);
          out.push({ plural, name: `${cr.metadata.namespace}/${cr.metadata.name}`, ok: true });
        } catch (e) {
          const waiting = e instanceof Waiting;
          out.push({ plural, name: `${cr.metadata.namespace}/${cr.metadata.name}`, error: e.message });
          if (deleting(cr)) continue;
          const fresh = (await kube.get(plural, cr.metadata.namespace, cr.metadata.name).catch(() => null)) || cr;
          await setStatus(plural, fresh, { phase: waiting ? 'Waiting' : 'Error', message: messageOf(e) }, { observed: false }).catch(() => null);
        }
      }
    }
    return out;
  }
  return { reconcileOnce };
}

// the role: a pass every APIM_KUBE_RESYNC_MS, one at a time
export function startController() {
  const cfg = kubeConfig();
  if (!cfg) {
    console.error('[apim] controller: no Kubernetes api (not in a cluster, and APIM_KUBE_URL is not set)');
    return null;
  }
  const controller = createController(kubeClient(cfg));
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const out = await controller.reconcileOnce();
      for (const r of out.filter((x) => x.error)) console.error(`[apim] controller: ${r.plural} ${r.name || ''} ${r.error}`);
    } catch (e) {
      console.error('[apim] controller failed', e.message);
    } finally {
      busy = false;
    }
  };
  setInterval(tick, config.kube.resyncMs);
  setTimeout(tick, 1000);
  console.log(`[apim] controller watching ${GROUP}/${VERSION} on ${cfg.url}, every ${config.kube.resyncMs} ms`);
  return controller;
}
