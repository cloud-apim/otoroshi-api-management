// Drift detection and adopt mode. Both sides are administrable, so drift is certain, not
// probable: it is detected periodically and rendered readably. Adopt mode takes over an existing
// Otoroshi Api without overwriting it — without it the product is unusable for anyone already in
// production.

import { db, newId } from '../db/index.js';
import { diff } from '../domain/diff.js';
import { normalizeDraft, defaultPlan } from '../domain/model.js';
import { META, OWNER_MARKER, oto } from './client.js';
import { IDENTITY_KINDS, buildOtoroshiApi, buildOtoroshiSubscription, comparableApi, comparableDerived, derivedEntities } from './projection.js';

async function saveReport(r) {
  await db`insert into drift_reports (id, workspace_id, entity_kind, entity_id, otoroshi_kind, otoroshi_id, status, diff, checked_at)
    values (${newId('drift')}, ${r.workspace_id}, ${r.entity_kind}, ${r.entity_id}, ${r.otoroshi_kind}, ${r.otoroshi_id}, ${r.status}, ${r.diff}, now())
    on conflict (entity_kind, entity_id, otoroshi_kind, otoroshi_id)
    do update set status = excluded.status, diff = excluded.diff, checked_at = now(), workspace_id = excluded.workspace_id`;
}

export async function checkApi(api) {
  const dep = (await db`select d.*, s.content, s.number from api_deployments d join api_snapshots s on s.id = d.snapshot_id
    where d.api_id = ${api.id} and d.status = 'deployed' and d.action = 'deploy' order by d.finished_at desc limit 1`)[0];
  const lastAction = (await db`select action from api_deployments where api_id = ${api.id} and status = 'deployed' order by finished_at desc limit 1`)[0];
  if (!dep || lastAction?.action === 'undeploy') {
    await db`delete from drift_reports where entity_kind = 'api' and entity_id = ${api.id}`;
    return null;
  }
  const expected = buildOtoroshiApi(dep.content, { snapshotId: dep.snapshot_id, snapshotNumber: dep.number, lifecycle: api.lifecycle });
  const actual = await oto.getApi(api.id);
  const changes = actual ? diff(comparableApi(expected), comparableApi(actual)) : [];
  // the derived objects drift too: they are the product's, even though they live apart
  for (const d of derivedEntities(dep.content)) {
    const got = await oto.getEntity(d.path, d.id);
    if (!got) changes.push({ op: 'remove', path: `derived[${d.kind} ${d.id}]`, before: 'present' });
    else diff(comparableDerived(d.entity), comparableDerived(got), `derived[${d.kind} ${d.entity.name}]`, changes);
  }
  const report = {
    workspace_id: api.workspace_id,
    entity_kind: 'api',
    entity_id: api.id,
    otoroshi_kind: 'Api',
    otoroshi_id: api.id,
    status: !actual ? 'missing' : changes.length ? 'drifted' : 'in_sync',
    diff: changes,
  };
  await saveReport(report);
  return report;
}

export async function checkSubscription(sub) {
  if (!['active', 'suspended'].includes(sub.status)) return null;
  const actual = await oto.getSubscription(sub.id);
  const changes = [];
  if (actual) {
    const wanted = sub.status === 'active' ? 'enabled' : 'disabled';
    if (actual.status !== wanted) changes.push({ op: 'change', path: 'status', before: wanted, after: actual.status });
    if (actual.plan_ref !== sub.plan_id) changes.push({ op: 'change', path: 'plan_ref', before: sub.plan_id, after: actual.plan_ref });
    if (actual.api_ref !== sub.api_id) changes.push({ op: 'change', path: 'api_ref', before: sub.api_id, after: actual.api_ref });
    const app = (await db`select id, name, client_id from applications where id = ${sub.application_id}`)[0];
    const wantedClientId = buildOtoroshiSubscription(sub, { application: app }).client_id ?? null;
    const actualClientId = actual.client_id ?? null;
    if (actualClientId !== wantedClientId) changes.push({ op: 'change', path: 'client_id', before: wantedClientId, after: actualClientId });
    // the key Otoroshi provisioned for the client id of a token or certificate subscription
    if (IDENTITY_KINDS.includes(sub.auth_kind))
      for (const ref of actual.token_refs || []) {
        const key = ref.apikey ? await oto.getApikey(ref.apikey) : null;
        if (!key) changes.push({ op: 'remove', path: `apikey[${ref.apikey}]`, before: 'present' });
        else if (key.enabled !== (sub.status === 'active'))
          changes.push({ op: 'change', path: `apikey[${ref.apikey}].enabled`, before: sub.status === 'active', after: key.enabled });
      }
    const creds = await db`select * from credentials where subscription_id = ${sub.id} and status = 'active'`;
    for (const c of creds) {
      const key = await oto.getApikey(c.client_id);
      if (!key) changes.push({ op: 'remove', path: `apikey[${c.client_id}]`, before: 'present' });
      else {
        if (key.enabled !== (sub.status === 'active'))
          changes.push({ op: 'change', path: `apikey[${c.client_id}].enabled`, before: sub.status === 'active', after: key.enabled });
        if (key.apiRef?.plan && key.apiRef.plan !== sub.plan_id)
          changes.push({ op: 'change', path: `apikey[${c.client_id}].apiRef.plan`, before: sub.plan_id, after: key.apiRef.plan });
        if (key.clientSecret !== c.client_secret)
          changes.push({ op: 'change', path: `apikey[${c.client_id}].clientSecret`, before: '(product secret)', after: '(changed on the gateway)' });
      }
    }
  }
  const report = {
    workspace_id: sub.workspace_id,
    entity_kind: 'subscription',
    entity_id: sub.id,
    otoroshi_kind: 'ApiSubscription',
    otoroshi_id: sub.id,
    status: !actual ? 'missing' : changes.length ? 'drifted' : 'in_sync',
    diff: changes,
  };
  await saveReport(report);
  return report;
}

export async function runDriftDetection({ workspaceId = null } = {}) {
  const started = Date.now();
  const apis = await db`select * from apis where (${workspaceId}::text is null or workspace_id = ${workspaceId})`;
  const results = { apis: 0, subscriptions: 0, drifted: 0, missing: 0, errors: [] };
  for (const api of apis) {
    try {
      const r = await checkApi(api);
      if (r) {
        results.apis++;
        if (r.status === 'drifted') results.drifted++;
        if (r.status === 'missing') results.missing++;
      }
    } catch (e) {
      results.errors.push({ api: api.id, error: e.message });
    }
  }
  const subs = await db`select * from subscriptions where status in ('active', 'suspended') and (${workspaceId}::text is null or workspace_id = ${workspaceId})`;
  for (const s of subs) {
    try {
      const r = await checkSubscription(s);
      if (r) {
        results.subscriptions++;
        if (r.status === 'drifted') results.drifted++;
        if (r.status === 'missing') results.missing++;
      }
    } catch (e) {
      results.errors.push({ subscription: s.id, error: e.message });
    }
  }
  // unmanaged apis on the gateway: candidates for adopt mode
  try {
    const all = (await oto.listApis()) || [];
    const unmanaged = all.filter((a) => a.metadata?.[META.createdBy] !== OWNER_MARKER);
    await db`delete from drift_reports where status = 'unmanaged'`;
    for (const a of unmanaged) {
      await saveReport({ workspace_id: null, entity_kind: 'gateway', entity_id: a.id, otoroshi_kind: 'Api', otoroshi_id: a.id, status: 'unmanaged', diff: [] });
    }
    results.unmanaged = unmanaged.length;
  } catch (e) {
    results.errors.push({ gateway: e.message });
  }
  // the reports of objects that no longer exist, or no longer run, go with them
  await db`delete from drift_reports where entity_kind = 'api' and entity_id not in (select id from apis)`;
  await db`delete from drift_reports where entity_kind = 'subscription'
    and entity_id not in (select id from subscriptions where status in ('active', 'suspended'))`;
  results.durationMs = Date.now() - started;
  await db`insert into settings (key, value) values ('drift.last_run', ${{ at: new Date().toISOString(), ...results }})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return results;
}

export async function driftReports(workspaceId) {
  return db`select r.*, coalesce(a.name || ' ' || a.version, app.name || ' → ' || coalesce(s.request->>'plan_name', s.plan_id), r.entity_id) as label
    from drift_reports r
    left join apis a on r.entity_kind = 'api' and a.id = r.entity_id
    left join subscriptions s on r.entity_kind = 'subscription' and s.id = r.entity_id
    left join applications app on app.id = s.application_id
    where (${workspaceId}::text is null or r.workspace_id = ${workspaceId} or r.workspace_id is null)
    order by case r.status when 'missing' then 0 when 'drifted' then 1 when 'unmanaged' then 2 else 3 end, r.checked_at desc`;
}

// ---------------------------------------------------------------- adopt mode

export async function unmanagedApis() {
  const all = (await oto.listApis()) || [];
  return all
    .filter((a) => a.metadata?.[META.createdBy] !== OWNER_MARKER)
    .map((a) => ({
      id: a.id,
      name: a.name,
      domain: a.domain,
      contextPath: a.contextPath,
      state: a.state,
      version: a.version,
      plans: (a.plans || []).map((p) => ({ id: p.id, name: p.name, kind: p.access_mode_configuration_type, status: p.status })),
      routes: (a.routes || []).length,
      created_by: a.metadata?.created_by || null,
    }));
}

function planFromOtoroshi(p) {
  const kind = p.access_mode_configuration_type || 'keyless';
  const amc = p.access_mode_configuration || {};
  const config = {
    apikey: { readOnly: !!amc.readOnly },
    jwt: { verifier: amc.verifier || '', clientIdPath: amc.client_id_path || 'client_id' },
    mtls: { regexSubjectDNs: amc.regex_subject_dns || [], regexIssuerDNs: amc.regex_issuer_dns || [], clientIdField: amc.client_id_field || '' },
    'oauth2-local': { defaultKeyPair: amc.default_key_pair || 'otoroshi-jwt-signing', expiration: amc.expiration || 3600 },
    'oauth2-remote': { verifier: amc.verifier || '', clientIdPath: amc.client_id_path || 'client_id', fetchUser: !!amc.fetch_user },
    keyless: { expr: amc.expr || '${req.ip}' },
  }[kind];
  const q = p.rate_limiting?.strategy?.quota || {};
  const MAX = 10000000;
  return defaultPlan({
    id: p.id,
    name: p.name,
    description: p.description || '',
    status: p.status || 'published',
    auth: { kind, config },
    validation: p.validation?.kind === 'manual' ? 'manual' : 'auto',
    rateLimit: { enabled: !!q.window && q.window < MAX, calls: q.window && q.window < MAX ? q.window : 10, windowMs: p.rate_limiting?.strategy?.windowDurationMs || 1000 },
    quota: { daily: q.daily && q.daily < MAX ? q.daily : null, monthly: q.monthly && q.monthly < MAX ? q.monthly : null },
    flowRef: p.plugins?.flow_ref || null,
  });
}

// Converts an Otoroshi Api into a product draft without writing anything to the gateway. The ids
// are kept, so that the first deployment updates the entity in place instead of duplicating it.
export function draftFromOtoroshi(a) {
  return normalizeDraft({
    entrypoint: { domain: a.domain, contextPath: a.contextPath || '/' },
    backends: (a.backends || []).map((b) => ({
      id: b.id,
      name: b.name,
      targets: (b.backend?.targets || []).map((t) => ({ hostname: t.hostname, port: t.port, tls: !!t.tls, weight: t.weight || 1 })),
      root: b.backend?.root || '/',
      rewrite: !!b.backend?.rewrite,
      loadBalancing: b.backend?.load_balancing?.type || 'RoundRobin',
    })),
    flows: (a.flows || []).map((f) => ({ id: f.id, name: f.name, plugins: f.plugins || [] })),
    resources: (a.routes || []).map((r) => ({
      id: r.id,
      name: r.name || r.id,
      path: (r.frontend?.domains || ['/'])[0] || '/',
      methods: r.frontend?.methods || [],
      exact: !!r.frontend?.exact,
      stripPath: r.frontend?.strip_path !== false,
      backendId: r.backend,
      flowId: r.flow_ref || r.plugin_chain || null,
      enabled: r.enabled !== false,
    })),
    plans: (a.plans || []).map(planFromOtoroshi),
    settings: { capture: !!a.capture, debugFlow: !!a.debug_flow, exportReporting: !!a.export_reporting },
  });
}
