// The API description model: what a producer edits in the draft (D-35) and what a snapshot freezes.
//
// Policy lives in the plan, the route is a projection detail (D-5): resources, backends and flows
// are infrastructure; auth, rate limit, quota, resource filtering and visibility are the offer.

import { newId } from '../db/index.js';

export const AUTH_KINDS = ['keyless', 'apikey', 'jwt', 'mtls', 'oauth2-local', 'oauth2-remote'];

// the extractor index each kind gets in Otoroshi (next/models/Api.scala, pluginsForPlan): this is the
// effective resolution order, it is not freely chosen, and the product shows it (ADR-10, D-9 n°3)
export const AUTH_KIND_ORDER = {
  apikey: 2.0,
  'oauth2-local': 2.0,
  jwt: 2.01,
  mtls: 2.02,
  'oauth2-remote': 2.03,
  keyless: 900,
};

// kinds whose subscription carries a credential minted by the product. On the other kinds the
// gateway builds the consumer at call time from a token or a certificate (D-6).
export const CREDENTIAL_KINDS = ['apikey', 'oauth2-local'];

export const PLAN_STATUSES = ['staging', 'published', 'deprecated', 'closed'];
export const VISIBILITIES = ['public', 'authenticated', 'restricted'];

export function defaultBackend(overrides = {}) {
  return {
    id: newId('backend'),
    name: 'default',
    targets: [{ hostname: 'echo', port: 8080, tls: false, weight: 1 }],
    root: '/',
    rewrite: false,
    loadBalancing: 'RoundRobin',
    timeouts: { callMs: 30000, connectionMs: 10000, idleMs: 60000 },
    retries: 1,
    ...overrides,
  };
}

export function defaultFlow(overrides = {}) {
  return {
    id: 'default_flow',
    name: 'Default flow',
    plugins: [
      { plugin: 'cp:otoroshi.next.plugins.OverrideHost', enabled: true, include: [], exclude: [], config: {} },
    ],
    ...overrides,
  };
}

export function defaultResource(backendId, flowId, overrides = {}) {
  return {
    id: newId('res'),
    name: 'All endpoints',
    description: '',
    path: '/',
    methods: [],
    exact: false,
    stripPath: true,
    backendId,
    flowId,
    enabled: true,
    ...overrides,
  };
}

export function defaultAuthConfig(kind) {
  switch (kind) {
    case 'apikey':
      return { readOnly: false, validityDays: null, rotation: { enabled: false, everyHours: 744, graceHours: 168 } };
    case 'jwt':
      return { verifier: '', clientIdPath: 'client_id' };
    case 'mtls':
      return { regexSubjectDNs: [], regexIssuerDNs: [], clientIdField: '' };
    case 'oauth2-local':
      return { defaultKeyPair: 'otoroshi-jwt-signing', expiration: 3600 };
    case 'oauth2-remote':
      return { verifier: '', clientIdPath: 'client_id', fetchUser: false };
    case 'keyless':
      return { expr: '${req.ip}' };
    default:
      return {};
  }
}

export function defaultPlan(overrides = {}) {
  const kind = overrides?.auth?.kind || 'apikey';
  return {
    id: newId('plan'),
    name: 'Default plan',
    description: '',
    status: 'staging',
    auth: { kind, config: defaultAuthConfig(kind) },
    // EL expression that disambiguates two plans of the same kind (spec §4)
    selectionRule: '',
    // calls | tokens | budget (D-41) — tokens and budget need an LLM backend, out of the MVP
    unit: 'calls',
    rateLimit: { enabled: true, calls: 10, windowMs: 1000 },
    quota: { daily: null, monthly: null },
    // what to do when the distributed counter is unreachable (spec §4)
    counterFailure: 'allow',
    // per api or per subscription (spec §4)
    circuitBreaker: 'api',
    resourceFilter: { mode: 'all', resources: [] },
    // plugins of the plan, by reference to a flow of the api (ApiPlanPlugins.flowRef)
    flowRef: null,
    // catalogue: never projected (D-2)
    visibility: 'public',
    acl: [],
    subscribable: true,
    validation: 'auto', // auto | manual
    terms: { enabled: false, url: '', pageSlug: '' },
    usageStatement: { enabled: false, required: false, prompt: 'What do you plan to build with this API?' },
    // D-36: free, or a price held by a payment provider. Frozen in the snapshot, never projected.
    pricing: { kind: 'free', amount: 0, currency: 'EUR', interval: 'month', provider: 'stripe', priceRef: '', graceDays: 7 },
    metadata: {},
    ...overrides,
    auth: overrides.auth
      ? { kind, config: { ...defaultAuthConfig(kind), ...(overrides.auth.config || {}) } }
      : { kind, config: defaultAuthConfig(kind) },
  };
}

export function defaultDraft({ domain, contextPath } = {}) {
  const backend = defaultBackend();
  const flow = defaultFlow();
  return {
    entrypoint: { domain: domain || 'api.oto.tools', contextPath: contextPath ?? '/' },
    backends: [backend],
    flows: [flow],
    resources: [defaultResource(backend.id, flow.id)],
    plans: [],
    openapi: { content: '', format: 'yaml' },
    documentation: { languages: ['en'], defaultLanguage: 'en' },
    settings: { capture: false, debugFlow: false, exportReporting: false },
  };
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// fills defaults so that every reader of a draft or a snapshot sees the same shape
export function normalizeDraft(input = {}) {
  const base = defaultDraft();
  const d = { ...base, ...input };
  d.entrypoint = { ...base.entrypoint, ...(input.entrypoint || {}) };
  if (!d.entrypoint.contextPath) d.entrypoint.contextPath = '/';
  if (!d.entrypoint.contextPath.startsWith('/')) d.entrypoint.contextPath = '/' + d.entrypoint.contextPath;
  d.backends = asArray(input.backends ?? base.backends).map((b) => ({
    ...defaultBackend(),
    ...b,
    id: b.id || newId('backend'),
    targets: asArray(b.targets).map((t) => ({
      hostname: t.hostname || 'localhost',
      port: parseInt(t.port || (t.tls ? 443 : 80), 10),
      tls: !!t.tls,
      weight: parseInt(t.weight || 1, 10),
    })),
    timeouts: { ...defaultBackend().timeouts, ...(b.timeouts || {}) },
  }));
  d.flows = asArray(input.flows ?? base.flows).map((f) => ({
    id: f.id || newId('flow'),
    name: f.name || f.id || 'flow',
    plugins: asArray(f.plugins).map((p) => ({
      plugin: p.plugin,
      enabled: p.enabled !== false,
      include: asArray(p.include),
      exclude: asArray(p.exclude),
      config: p.config || {},
    })),
  }));
  d.resources = asArray(input.resources ?? base.resources).map((r) => ({
    ...defaultResource(d.backends[0]?.id, d.flows[0]?.id),
    ...r,
    id: r.id || newId('res'),
    methods: asArray(r.methods),
  }));
  d.plans = asArray(input.plans).map((p, i) => {
    const plan = defaultPlan({ ...p, id: p.id || newId('plan') });
    plan.rateLimit = { ...defaultPlan().rateLimit, ...(p.rateLimit || {}) };
    plan.quota = { ...defaultPlan().quota, ...(p.quota || {}) };
    plan.resourceFilter = { ...defaultPlan().resourceFilter, ...(p.resourceFilter || {}) };
    plan.terms = { ...defaultPlan().terms, ...(p.terms || {}) };
    plan.usageStatement = { ...defaultPlan().usageStatement, ...(p.usageStatement || {}) };
    plan.pricing = { ...defaultPlan().pricing, ...(p.pricing || {}) };
    plan.acl = asArray(p.acl);
    plan.order = p.order ?? i;
    return plan;
  });
  d.openapi = { ...base.openapi, ...(input.openapi || {}) };
  d.documentation = { ...base.documentation, ...(input.documentation || {}) };
  if (!asArray(d.documentation.languages).length) d.documentation.languages = ['en'];
  d.settings = { ...base.settings, ...(input.settings || {}) };
  return d;
}

// Validation returns errors (block publication) and warnings (shown, never silent).
// The abstraction does not promise what the gateway cannot hold (D-9 n°3).
export function validateDraft(draft) {
  const errors = [];
  const warnings = [];
  const d = normalizeDraft(draft);
  if (!d.entrypoint.domain) errors.push({ path: 'entrypoint.domain', message: 'a domain is required' });
  if (!d.backends.length) errors.push({ path: 'backends', message: 'at least one backend is required' });
  d.backends.forEach((b, i) => {
    if (!b.targets.length) errors.push({ path: `backends[${i}].targets`, message: `backend "${b.name}" has no target` });
  });
  if (!d.resources.length) errors.push({ path: 'resources', message: 'at least one resource is required' });
  d.resources.forEach((r, i) => {
    if (!d.backends.find((b) => b.id === r.backendId))
      errors.push({ path: `resources[${i}].backendId`, message: `resource "${r.name}" points to an unknown backend` });
    if (r.flowId && !d.flows.find((f) => f.id === r.flowId))
      errors.push({ path: `resources[${i}].flowId`, message: `resource "${r.name}" points to an unknown flow` });
    if (!r.path || !r.path.startsWith('/'))
      errors.push({ path: `resources[${i}].path`, message: `resource "${r.name}" path must start with /` });
  });
  const active = d.plans.filter((p) => p.status === 'published');
  if (!active.length) {
    warnings.push({
      path: 'plans',
      code: 'open_routes',
      message:
        'no published plan: Otoroshi 18 serves the routes of an api without published plan to anyone (open routes). Publish at least one plan, or a keyless plan if the api is meant to be open.',
    });
  }
  d.plans.forEach((p, i) => {
    if (!AUTH_KINDS.includes(p.auth.kind)) errors.push({ path: `plans[${i}].auth.kind`, message: 'unknown auth kind' });
    if (p.unit !== 'calls')
      errors.push({
        path: `plans[${i}].unit`,
        message: `plan "${p.name}" meters ${p.unit}: tokens and budget need an LLM backend (D-41), not available in this version`,
      });
    if (['jwt', 'oauth2-remote'].includes(p.auth.kind) && !p.auth.config.verifier)
      errors.push({ path: `plans[${i}].auth.config.verifier`, message: `plan "${p.name}" needs a verifier reference` });
    if (p.flowRef && !d.flows.find((f) => f.id === p.flowRef))
      errors.push({ path: `plans[${i}].flowRef`, message: `plan "${p.name}" references an unknown flow` });
    if (p.resourceFilter.mode === 'only' && !p.resourceFilter.resources.length)
      errors.push({ path: `plans[${i}].resourceFilter`, message: `plan "${p.name}" filters resources but allows none` });
    if (['jwt', 'mtls', 'oauth2-remote', 'keyless'].includes(p.auth.kind) && p.status === 'published') {
      warnings.push({
        path: `plans[${i}]`,
        code: 'any_token_passes',
        message: `plan "${p.name}" (${p.auth.kind}): Otoroshi 18 mints the consumer itself on first call, so any valid ${
          p.auth.kind === 'keyless' ? 'caller' : 'token or certificate'
        } passes, subscribed or not (upstream gap, D-6).`,
      });
    }
    if (p.selectionRule || p.counterFailure !== 'allow' || p.circuitBreaker !== 'api') {
      warnings.push({
        path: `plans[${i}]`,
        code: 'not_enforced',
        message: `plan "${p.name}": selection rule, counter failure strategy and circuit breaker granularity are recorded but not yet enforced by Otoroshi 18 (upstream work).`,
      });
    }
  });
  // two plans of the same kind whose extractors can both succeed need a selection rule (spec §4)
  const byKind = {};
  active.forEach((p) => (byKind[p.auth.kind] = [...(byKind[p.auth.kind] || []), p]));
  Object.entries(byKind).forEach(([kind, plans]) => {
    if (plans.length > 1 && ['jwt', 'oauth2-remote', 'mtls', 'keyless'].includes(kind) && plans.filter((p) => !p.selectionRule).length > 1) {
      errors.push({
        path: 'plans',
        message: `${plans.length} published ${kind} plans can match the same request: give at least all but one of them a selection rule`,
      });
    }
  });
  if (d.plans.filter((p) => p.status === 'published' && p.auth.kind === 'keyless').length && active.length > 1) {
    warnings.push({
      path: 'plans',
      code: 'keyless_last',
      message: 'a keyless plan always resolves an identity: it runs last (extractor index 900), after every credential based plan.',
    });
  }
  return { errors, warnings, ok: errors.length === 0 };
}

// effective plan resolution order, as the gateway will evaluate it (ADR-10)
export function resolutionOrder(draft) {
  const d = normalizeDraft(draft);
  return d.plans
    .filter((p) => p.status === 'published')
    .map((p) => ({ id: p.id, name: p.name, kind: p.auth.kind, index: AUTH_KIND_ORDER[p.auth.kind] ?? 999, selectionRule: p.selectionRule }))
    .sort((a, b) => a.index - b.index);
}

// D-30: a transfer is only possible between plans of the same auth mechanism
export function plansAreEquivalent(a, b) {
  return a?.auth?.kind === b?.auth?.kind;
}
