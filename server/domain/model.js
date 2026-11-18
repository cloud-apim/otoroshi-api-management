// The API description model: what a producer edits in the draft and what a snapshot freezes.
//
// Policy lives in the plan, the route is a projection detail: resources, backends and flows
// are infrastructure; auth, rate limit, quota, resource filtering and visibility are the offer.

import { newId } from '../db/index.js';
import { issuerPatterns, readCertificate } from './pki.js';

export const AUTH_KINDS = ['keyless', 'apikey', 'jwt', 'mtls', 'oauth2-local', 'oauth2-remote'];

// the extractor index each kind gets in Otoroshi (next/models/Api.scala, pluginsForPlan): this is the
// effective resolution order, it is not freely chosen, and the product shows it
export const AUTH_KIND_ORDER = {
  apikey: 2.0,
  'oauth2-local': 2.0,
  jwt: 2.01,
  mtls: 2.02,
  'oauth2-remote': 2.03,
  keyless: 900,
};

// kinds whose subscription carries a credential minted by the product. On the other kinds the
// gateway builds the consumer at call time from a token or a certificate.
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
      return { readOnly: false, rotation: { enabled: false, everyHours: 744, graceHours: 168 } };
    case 'jwt':
      // either a reference to an existing Otoroshi verifier, or a description the product derives
      // the verifier from and keeps reconciled
      return {
        verifier: '',
        clientIdPath: 'client_id',
        derive: { enabled: false, kind: 'jwks', jwksUrl: '', secret: '', size: 256, issuer: '', audience: '', header: 'Authorization', prefix: 'Bearer ' },
      };
    case 'mtls':
      // trustedCAs: the CA certificates the plan trusts, derived as certificates of the gateway;
      // without issuer patterns, the plan accepts what they signed and nothing else
      return { regexSubjectDNs: [], regexIssuerDNs: [], clientIdField: '', trustedCAs: [] };
    case 'oauth2-local':
      return { defaultKeyPair: 'otoroshi-jwt-signing', expiration: 3600 };
    case 'oauth2-remote':
      // verifier: an existing auth module of the gateway (Otoroshi names the field verifier), or
      // the description of the authorization server the product derives the module from
      return {
        verifier: '',
        clientIdPath: 'client_id',
        fetchUser: false,
        derive: { enabled: false, discoveryUrl: '', jwksUrl: '', userInfoUrl: '', clientId: '', clientSecret: '', scope: 'openid' },
      };
    case 'keyless':
      // ephemeral identity: no apikey per visitor, quotas still counted per caller
      return { expr: '${req.ip}', createIfMissing: false };
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
    // EL expression that disambiguates two plans of the same kind
    selectionRule: '',
    // calls | tokens | budget — tokens and budget need an LLM backend, out of the MVP
    unit: 'calls',
    rateLimit: { enabled: true, calls: 10, windowMs: 1000 },
    quota: { daily: null, monthly: null },
    // what to do when the distributed counter is unreachable
    counterFailure: 'allow',
    // per api or per subscription
    circuitBreaker: 'api',
    resourceFilter: { mode: 'all', resources: [] },
    // plugins of the plan, by reference to a flow of the api (ApiPlanPlugins.flowRef)
    flowRef: null,
    // catalogue: never projected
    visibility: 'public',
    acl: [],
    subscribable: true,
    validation: 'auto', // auto | manual
    terms: { enabled: false, url: '', pageSlug: '' },
    usageStatement: { enabled: false, required: false, prompt: 'What do you plan to build with this API?' },
    // free, or a price held by a payment provider. Frozen in the snapshot, never projected.
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
    plugins: asArray(f.plugins).map((p) =>
      // a reference to a shared policy group, pinned to a published version
      p.group
        ? { group: p.group, version: p.version ? parseInt(p.version, 10) : null }
        : {
            plugin: p.plugin,
            enabled: p.enabled !== false,
            include: asArray(p.include),
            exclude: asArray(p.exclude),
            config: p.config || {},
          }
    ),
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
// The abstraction does not promise what the gateway cannot hold.
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
  d.flows.forEach((f) =>
    f.plugins.forEach((p) => {
      if (p.group && !p.version) errors.push({ path: `flows[${f.name}]`, message: `flow "${f.name}" references a policy group without pinning a version` });
      if (!p.group && !p.plugin) errors.push({ path: `flows[${f.name}]`, message: `flow "${f.name}" has a plugin without id` });
    })
  );
  const active = d.plans.filter((p) => p.status === 'published');
  if (!active.length) {
    warnings.push({
      path: 'plans',
      code: 'open_routes',
      message:
        'no published plan: Otoroshi 18 serves the routes of an api without published plan to anyone (open routes). Publish at least one plan, or a keyless plan if the api is meant to be open.',
    });
  }
  // Otoroshi 18 only installs the extractors of published plans (G-13)
  const apikeyExtractor = active.some((p) => ['apikey', 'oauth2-local'].includes(p.auth.kind));
  d.plans
    .filter((p) => p.status === 'deprecated' && !(['apikey', 'oauth2-local'].includes(p.auth.kind) && apikeyExtractor))
    .forEach((p) =>
      warnings.push({
        path: `plans[${p.name}]`,
        code: 'deprecated_without_extractor',
        message: `plan "${p.name}" is deprecated: Otoroshi 18 no longer installs its extractor, so its consumers are no longer identified (upstream gap G-13).`,
      })
    );
  d.plans.forEach((p, i) => {
    if (!AUTH_KINDS.includes(p.auth.kind)) errors.push({ path: `plans[${i}].auth.kind`, message: 'unknown auth kind' });
    if (p.unit !== 'calls')
      errors.push({
        path: `plans[${i}].unit`,
        message: `plan "${p.name}" meters ${p.unit}: tokens and budget need an LLM backend, not available in this version`,
      });
    const derive = ['jwt', 'oauth2-remote'].includes(p.auth.kind) && p.auth.config.derive?.enabled ? p.auth.config.derive : null;
    if (derive && p.auth.kind === 'jwt') {
      if (derive.kind === 'jwks' && !derive.jwksUrl) errors.push({ path: `plans[${i}].auth.config.derive.jwksUrl`, message: `plan "${p.name}" derives its verifier from a JWKS: give its url` });
      if (derive.kind === 'hmac' && !derive.secret) errors.push({ path: `plans[${i}].auth.config.derive.secret`, message: `plan "${p.name}" derives an HMAC verifier: give its secret (or a vault reference)` });
    } else if (derive && p.auth.kind === 'oauth2-remote') {
      if (!derive.jwksUrl) errors.push({ path: `plans[${i}].auth.config.derive.jwksUrl`, message: `plan "${p.name}" derives its auth module: give the JWKS url of the authorization server` });
      if (p.auth.config.fetchUser && !derive.userInfoUrl)
        errors.push({ path: `plans[${i}].auth.config.derive.userInfoUrl`, message: `plan "${p.name}" fetches the user profile: give the userinfo url of the authorization server` });
    } else if (p.auth.kind === 'jwt' && !p.auth.config.verifier)
      errors.push({ path: `plans[${i}].auth.config.verifier`, message: `plan "${p.name}" needs a verifier: reference one, or describe how its tokens are validated` });
    else if (p.auth.kind === 'oauth2-remote' && !p.auth.config.verifier)
      errors.push({ path: `plans[${i}].auth.config.verifier`, message: `plan "${p.name}" needs an auth module: reference one, or describe the authorization server` });
    if (p.auth.kind === 'mtls') {
      const cas = p.auth.config.trustedCAs || [];
      cas.forEach((pem, j) => {
        try {
          const c = readCertificate(pem);
          if (!c.ca) warnings.push({ path: `plans[${i}].auth.config.trustedCAs[${j}]`, code: 'not_a_ca', message: `plan "${p.name}": ${c.subject} is not a CA certificate — it is trusted as is` });
        } catch (e) {
          errors.push({ path: `plans[${i}].auth.config.trustedCAs[${j}]`, message: `plan "${p.name}": trusted CA #${j + 1} is not a readable PEM certificate` });
        }
      });
      const issuers = p.auth.config.regexIssuerDNs || [];
      if (cas.length && !issuers.length && issuerPatterns(cas) === null)
        warnings.push({
          path: `plans[${i}].auth.config.regexIssuerDNs`,
          code: 'issuer_not_derived',
          message: `plan "${p.name}": the subject of a trusted CA cannot be predicted in Otoroshi's form — give the issuer patterns, or any certificate the gateway trusts passes`,
        });
      if ((p.auth.config.regexSubjectDNs || []).length && !issuers.length && !cas.length && p.status === 'published')
        warnings.push({
          path: `plans[${i}].auth.config.regexSubjectDNs`,
          code: 'subject_without_issuer',
          message: `plan "${p.name}": a subject pattern alone accepts a certificate from any authority the gateway trusts (JDK CAs included) — add trusted CAs or issuer patterns (upstream gap G-16)`,
        });
    }
    if (p.auth.kind === 'oauth2-remote' && p.status === 'published')
      warnings.push({
        path: `plans[${i}]`,
        code: 'token_claims_not_checked',
        message: `plan "${p.name}" (oauth2-remote): Otoroshi 18 checks the signature and the dates of the token, not its issuer nor its audience — a token the same server issued for another client passes (upstream gap G-15)`,
      });
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
        } passes, subscribed or not (upstream gap).`,
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
  // two plans of the same kind whose extractors can both succeed need a selection rule
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

// effective plan resolution order, as the gateway will evaluate it
export function resolutionOrder(draft) {
  const d = normalizeDraft(draft);
  return d.plans
    .filter((p) => p.status === 'published')
    .map((p) => ({ id: p.id, name: p.name, kind: p.auth.kind, index: AUTH_KIND_ORDER[p.auth.kind] ?? 999, selectionRule: p.selectionRule }))
    .sort((a, b) => a.index - b.index);
}

// a transfer is only possible between plans of the same auth mechanism
export function plansAreEquivalent(a, b) {
  return a?.auth?.kind === b?.auth?.kind;
}
