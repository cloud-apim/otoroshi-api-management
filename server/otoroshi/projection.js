// Projection: from a frozen snapshot (D-35) to the Otoroshi entities that enforce it.
//
// Synchronisation is selective, never 1:1 (D-2): only what the gateway needs to enforce is pushed.
// Documentation, plan visibility, terms, usage statements, pricing and metadata stay in the product.

import { normalizeDraft } from '../domain/model.js';
import { META, OWNER_MARKER } from './client.js';

const MAX = 10000000; // what Otoroshi uses as "no limit" in a quota

function contextPath(cp) {
  if (!cp || cp === '/') return '';
  return cp.endsWith('/') ? cp.slice(0, -1) : cp;
}

function backendJson(b) {
  return {
    id: b.id,
    name: b.name,
    backend: {
      targets: b.targets.map((t, i) => ({
        id: `target_${i + 1}`,
        hostname: t.hostname,
        port: t.port,
        tls: t.tls,
        weight: t.weight || 1,
        backup: false,
        predicate: { type: 'AlwaysMatch' },
        protocol: 'HTTP/1.1',
        ip_address: null,
        tls_config: { certs: [], trusted_certs: [], enabled: false, loose: false, trust_all: false },
      })),
      root: b.root || '/',
      rewrite: !!b.rewrite,
      load_balancing: { type: b.loadBalancing || 'RoundRobin' },
      health_check: null,
    },
    client: `client_${b.id}`,
  };
}

function clientJson(b) {
  return {
    id: `client_${b.id}`,
    name: `client of ${b.name}`,
    client: {
      retries: b.retries ?? 1,
      max_errors: 20,
      retry_initial_delay: 50,
      backoff_factor: 2,
      call_timeout: b.timeouts?.callMs ?? 30000,
      call_and_stream_timeout: 120000,
      connection_timeout: b.timeouts?.connectionMs ?? 10000,
      idle_timeout: b.timeouts?.idleMs ?? 60000,
      global_timeout: b.timeouts?.callMs ?? 30000,
      sample_interval: 2000,
      proxy: {},
      custom_timeouts: [],
      cache_connection_settings: { enabled: false, queue_size: 2048 },
    },
  };
}

function flowJson(f) {
  return {
    id: f.id,
    name: f.name,
    plugins: f.plugins.map((p) => ({
      enabled: p.enabled !== false,
      debug: false,
      plugin: p.plugin,
      include: p.include || [],
      exclude: p.exclude || [],
      config: p.config || {},
      bound_listeners: [],
    })),
  };
}

function routeJson(r) {
  return {
    id: r.id,
    enabled: r.enabled !== false,
    name: r.name,
    frontend: {
      // relative to the api domain + context path
      domains: [r.path || '/'],
      strip_path: r.stripPath !== false,
      exact: !!r.exact,
      headers: r.headers || {},
      cookies: {},
      query: {},
      methods: r.methods || [],
    },
    backend: r.backendId,
    flow_ref: r.flowId || '',
  };
}

// resource filtering of a plan (D-5) becomes apikey restrictions, on the full request path
export function restrictionsFor(plan, draft) {
  if (plan.resourceFilter?.mode !== 'only') return { enabled: false, allowLast: true, allowed: [], forbidden: [], notFound: [] };
  const cp = contextPath(draft.entrypoint.contextPath);
  const allowed = [];
  for (const rid of plan.resourceFilter.resources) {
    const r = draft.resources.find((x) => x.id === rid);
    if (!r) continue;
    const base = `${cp}${r.path === '/' ? '' : r.path}`;
    const path = r.exact ? base || '/' : `${base}*`;
    const methods = r.methods?.length ? r.methods : ['*'];
    methods.forEach((m) => allowed.push({ method: m, path, authorized_entity: null }));
  }
  // allowLast=false: the allowed list is checked first, everything else falls on the forbidden
  // wildcard (403). With allowLast=true Otoroshi never reads the allowed list.
  return { enabled: true, allowLast: false, allowed, forbidden: [{ method: '*', path: '*', authorized_entity: null }], notFound: [] };
}

export function rateLimitingFor(plan) {
  const rl = plan.rateLimit || {};
  const q = plan.quota || {};
  return {
    strategy: {
      id: 'FixedWindowStrategyConfig',
      windowDurationMs: rl.enabled ? rl.windowMs || 1000 : 1000,
      quota: {
        window: rl.enabled ? rl.calls || MAX : MAX,
        daily: q.daily || MAX,
        monthly: q.monthly || MAX,
      },
    },
  };
}

function accessModeConfiguration(plan, draft) {
  const c = plan.auth.config || {};
  switch (plan.auth.kind) {
    case 'apikey':
      return {
        clientNamePattern: null,
        description: `subscription to ${plan.name}`,
        enabled: true,
        readOnly: !!c.readOnly,
        allowClientIdOnly: false,
        constrainedServicesOnly: false,
        restrictions: restrictionsFor(plan, draft),
        rotation: {
          enabled: !!c.rotation?.enabled,
          rotationEvery: c.rotation?.everyHours || 744,
          gracePeriod: c.rotation?.graceHours || 168,
          nextSecret: null,
        },
        validUntil: null,
        tags: [],
        metadata: {},
      };
    case 'jwt':
      return { verifier: c.verifier || null, client_id_path: c.clientIdPath || 'client_id', create_if_missing: true };
    case 'mtls':
      return {
        regex_subject_dns: c.regexSubjectDNs || [],
        regex_issuer_dns: c.regexIssuerDNs || [],
        client_id_field: c.clientIdField || null,
        create_if_missing: true,
      };
    case 'oauth2-local':
      return { default_key_pair: c.defaultKeyPair || 'otoroshi-jwt-signing', expiration: c.expiration || 3600 };
    case 'oauth2-remote':
      return {
        verifier: c.verifier || null,
        client_id_path: c.clientIdPath || 'client_id',
        fetch_user: !!c.fetchUser,
        user_metadata_key: 'user_profile',
        create_if_missing: true,
      };
    case 'keyless':
      return { expr: c.expr || '${req.ip}', create_if_missing: c.createIfMissing === true };
    default:
      return {};
  }
}

export function planJson(plan, draft) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || '',
    status: plan.status,
    access_mode_configuration_type: plan.auth.kind,
    access_mode_configuration: accessModeConfiguration(plan, draft),
    rate_limiting: rateLimitingFor(plan),
    // a label in Otoroshi 18, nothing reads it: the approval workflow is the product's (D-1)
    validation: { kind: plan.validation === 'manual' ? 'manual' : 'auto', config: {} },
    visibility: { kind: 'public', config: {} },
    tags: [],
    // enforcement attributes Otoroshi 18 does not read yet: projected so that they are visible
    // on the gateway side, flagged as not enforced in the console (upstream work)
    metadata: {
      apim_unit: plan.unit,
      apim_counter_failure: plan.counterFailure,
      apim_circuit_breaker: plan.circuitBreaker,
      ...(plan.selectionRule ? { apim_selection_rule: plan.selectionRule } : {}),
    },
    plugins: plan.flowRef ? { plugins: [], overrides: false, flow_ref: plan.flowRef } : null,
  };
}

// snapshot = { api: {...}, draft: {...}, docs: {...} } — see apis.publish()
export function buildOtoroshiApi(snapshot, { snapshotId, snapshotNumber, lifecycle } = {}) {
  const api = snapshot.api;
  const draft = normalizeDraft(snapshot.draft);
  return {
    _loc: { tenant: 'default', teams: ['default'] }, // D-24: never an otoroshi tenant
    kind: 'Api',
    id: api.id,
    name: `${api.name} ${api.version}`,
    description: api.description || '',
    domain: draft.entrypoint.domain,
    contextPath: contextPath(draft.entrypoint.contextPath),
    metadata: {
      [META.createdBy]: OWNER_MARKER,
      [META.api]: api.id,
      [META.workspace]: api.workspace_id,
      ...(snapshotId ? { [META.snapshot]: snapshotId } : {}),
      ...(snapshotNumber ? { [META.snapshotNumber]: String(snapshotNumber) } : {}),
    },
    tags: api.tags || [],
    visibility: { kind: 'public', config: {} },
    owner: { ref: 'owner', config: {} },
    members: [],
    version: api.version,
    versions: [api.version],
    debug_flow: !!draft.settings.debugFlow,
    capture: !!draft.settings.capture,
    export_reporting: !!draft.settings.exportReporting,
    groups: [],
    state: lifecycle === 'deprecated' ? 'deprecated' : 'published',
    enabled: true,
    blueprint: 'REST',
    plans: draft.plans.map((p) => planJson(p, draft)),
    routes: draft.resources.map(routeJson),
    backends: draft.backends.map(backendJson),
    flows: draft.flows.map(flowJson),
    clients_backend_config: draft.backends.map(clientJson),
    // D-2: the documentation stays in the product, even though Otoroshi has ApiDocumentation
    documentation: null,
    testing: { enabled: false, headerKey: 'X-OTOROSHI-TESTING' },
    clients: [],
    hooks: [],
  };
}

function ms(d) {
  return d ? new Date(d).getTime() : Date.now();
}

// D-6: a subscription is always an Otoroshi apikey; on apikey / oauth2-local plans Otoroshi mints it
// from the ApiSubscription. The application is projected as an id_ref metadata on the key (D-26).
export function buildOtoroshiSubscription(sub, { application }) {
  const enabled = sub.status === 'active';
  return {
    _loc: { tenant: 'default', teams: ['default'] },
    id: sub.id,
    name: `${application?.name || sub.application_id} → ${sub.plan_id}`,
    description: `managed by otoroshi-api-management`,
    tags: [],
    metadata: {
      [META.application]: sub.application_id,
      [META.subscription]: sub.id,
      [META.workspace]: sub.workspace_id,
      [META.managedBy]: 'otoroshi-api-management',
    },
    // never project a pending subscription as enabled: Otoroshi 18 enables the key of a pending one
    status: enabled ? 'enabled' : 'disabled',
    dates: {
      created_at: ms(sub.created_at),
      processed_at: ms(sub.dates?.processed_at),
      started_at: ms(sub.dates?.started_at),
      paused_at: ms(sub.dates?.suspended_at),
      ending_at: ms(sub.dates?.ending_at),
      closed_at: ms(sub.dates?.closed_at),
    },
    owner_ref: sub.application_id,
    plan_ref: sub.plan_id,
    api_ref: sub.api_id,
    payment_ref: {},
    subscription_kind: sub.auth_kind,
    token_refs: sub.projection?.token_refs || [],
  };
}

// what we compare to detect drift on an Api: the fields the product owns
export function comparableApi(entity) {
  if (!entity) return null;
  const stripPlugins = (plugins) =>
    (plugins || []).map((p) => ({ plugin: p.plugin, enabled: p.enabled !== false, include: p.include || [], exclude: p.exclude || [], config: p.config || {} }));
  return {
    name: entity.name,
    domain: entity.domain,
    contextPath: entity.contextPath,
    state: entity.state,
    enabled: entity.enabled,
    owner_marker: entity.metadata?.[META.createdBy],
    snapshot: entity.metadata?.[META.snapshot] || null,
    routes: (entity.routes || []).map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      domains: r.frontend?.domains,
      methods: r.frontend?.methods || [],
      exact: !!r.frontend?.exact,
      strip_path: r.frontend?.strip_path !== false,
      backend: r.backend,
      flow_ref: r.flow_ref,
    })),
    backends: (entity.backends || []).map((b) => ({
      id: b.id,
      targets: (b.backend?.targets || []).map((t) => `${t.tls ? 'https' : 'http'}://${t.hostname}:${t.port}`),
      root: b.backend?.root,
    })),
    flows: (entity.flows || []).map((f) => ({ id: f.id, plugins: stripPlugins(f.plugins) })),
    plans: (entity.plans || []).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      kind: p.access_mode_configuration_type,
      rate_limiting: p.rate_limiting?.strategy?.quota || null,
      window_ms: p.rate_limiting?.strategy?.windowDurationMs || null,
      restrictions: p.access_mode_configuration?.restrictions?.enabled
        ? (({ allowLast, allowed, forbidden, notFound }) => ({ allowLast, allowed, forbidden, notFound }))(p.access_mode_configuration.restrictions)
        : null,
    })),
  };
}
