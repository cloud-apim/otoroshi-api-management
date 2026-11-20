// Projection: from a frozen snapshot to the Otoroshi entities that enforce it.
//
// Synchronisation is selective, never 1:1: only what the gateway needs to enforce is pushed.
// Documentation, plan visibility, terms, usage statements, pricing and metadata stay in the product.

import { normalizeDraft } from '../domain/model.js';
import { certificateKey, readCertificate } from '../domain/pki.js';
import { DERIVED_PATHS, META, OWNER_MARKER } from './client.js';

const MAX = 10000000; // what Otoroshi uses as "no limit" in a quota
const DAY = 86400000;

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

// a policy group reference is expanded inline, from the version the snapshot froze
function expandGroups(plugins, groups = {}) {
  return plugins.flatMap((p) => {
    if (!p.group) return [p];
    const g = groups[`${p.group}@${p.version}`];
    if (!g) throw new Error(`the snapshot does not carry policy group ${p.group} v${p.version}`);
    return g.plugins;
  });
}

// the request id of the gateway, sent to the backends: the one the caller gets back
// (Otoroshi-Request-Id) and the request log keeps — a request followed beyond the gateway
export const CORRELATION_PLUGIN = 'cp:otoroshi.next.plugins.OtoroshiHeadersIn';

function flowJson(f, groups, { correlationId = true } = {}) {
  const plugins = expandGroups(f.plugins, groups);
  if (correlationId && !plugins.some((p) => p.plugin === CORRELATION_PLUGIN)) plugins.push({ plugin: CORRELATION_PLUGIN, enabled: true, include: [], exclude: [], config: {} });
  return {
    id: f.id,
    name: f.name,
    plugins: plugins.map((p) => ({
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

// the path of a resource as a restriction: a regex Otoroshi matches against the whole request path —
// the path itself when exact, the path and what is under it otherwise; a named segment matches one
// segment
export function restrictionPath(base, exact) {
  const re = base
    .split('/')
    .map((seg) => (/^(:\w+|\{\w+\})$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return exact ? re || '/' : `${re}(/.*)?`;
}

// resource filtering of a plan becomes the restrictions of its consumers, on the full request path
export function restrictionsFor(plan, draft) {
  if (plan.resourceFilter?.mode !== 'only') return { enabled: false, allowLast: true, allowed: [], forbidden: [], notFound: [] };
  const cp = contextPath(draft.entrypoint.contextPath);
  const allowed = [];
  for (const rid of plan.resourceFilter.resources) {
    const r = draft.resources.find((x) => x.id === rid);
    if (!r) continue;
    const path = restrictionPath(`${cp}${r.path === '/' ? '' : r.path}`, r.exact);
    const methods = r.methods?.length ? r.methods : ['*'];
    methods.forEach((m) => allowed.push({ method: m, path, authorized_entity: null }));
  }
  // allowLast=false: the allowed list is checked first, every other path falls on the forbidden
  // one (403). With allowLast=true Otoroshi never reads the allowed list.
  return { enabled: true, allowLast: false, allowed, forbidden: [{ method: '*', path: '/.*', authorized_entity: null }], notFound: [] };
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
        // each key valid that long from the first time it is enabled: the subscription, or its acceptance
        ...(Number(c.validityDays) > 0 ? { validity: Math.round(Number(c.validityDays) * DAY) } : {}),
        tags: [],
        metadata: {},
      };
    // jwt, mtls and oauth2-remote plans serve only the consumers an enabled subscription provisioned,
    // for the client id they call with: a valid token or certificate alone is not a subscription
    case 'jwt':
      return {
        verifier: c.derive?.enabled ? derivedVerifierId(draft.__apiId, plan.id) : c.verifier || null,
        client_id_path: c.clientIdPath || 'client_id',
        subscription_required: true,
        restrictions: restrictionsFor(plan, draft),
      };
    case 'mtls':
      return {
        // the chain of a client certificate has to lead to one of the CAs of the plan
        trusted_ca_refs: (c.trustedCAs || []).map((pem) => derivedCaId(draft.__apiId, plan.id, pem)),
        regex_subject_dns: c.regexSubjectDNs || [],
        regex_issuer_dns: c.regexIssuerDNs || [],
        dn_match: 'all',
        client_id_field: c.clientIdField || null,
        subscription_required: true,
        restrictions: restrictionsFor(plan, draft),
      };
    case 'oauth2-local':
      return { default_key_pair: c.defaultKeyPair || 'otoroshi-jwt-signing', expiration: c.expiration || 3600 };
    case 'oauth2-remote':
      return {
        // an auth module id, whatever Otoroshi calls the field
        verifier: c.derive?.enabled ? derivedAuthModuleId(draft.__apiId, plan.id) : c.verifier || null,
        client_id_path: c.clientIdPath || 'client_id',
        fetch_user: !!c.fetchUser,
        user_metadata_key: 'user_profile',
        ...(c.issuer ? { issuer: c.issuer } : {}),
        audiences: c.audiences || [],
        subscription_required: true,
        restrictions: restrictionsFor(plan, draft),
      };
    case 'keyless':
      return { expr: c.expr || '${req.ip}', create_if_missing: c.createIfMissing === true, restrictions: restrictionsFor(plan, draft) };
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
    // a label in Otoroshi 18, nothing reads it: the approval workflow is the product's
    validation: { kind: plan.validation === 'manual' ? 'manual' : 'auto', config: {} },
    visibility: { kind: 'public', config: {} },
    tags: [],
    metadata: { apim_unit: plan.unit },
    // the calls the plan applies to, between plans of the same kind
    ...(plan.selection?.length ? { selection: plan.selection.map((c) => ({ path: c.path, value: c.value })) } : {}),
    // when the counter of the quotas cannot be reached: availability (allow) or protection (deny)
    counter_failure: { mode: plan.counterFailure === 'deny' ? 'deny' : 'allow' },
    // one circuit breaker per route, shared by every caller, or one per consumer
    circuit_breaker_scope: plan.circuitBreaker === 'subscription' ? 'consumer' : 'route',
    plugins: planPlugins(plan),
  };
}

// the preset of the Threat Protection Suite: one plugin, expanded by the gateway into its modules
export const THREAT_PRESET = 'cp:otoroshi_plugins.com.cloud.apim.otoroshi.extensions.waf.plugins.CloudApimSecuritySuitePreset';

export function threatPresetConfig(tp) {
  return {
    threat_policy: tp.threatPolicy || null,
    gate: !!tp.gate,
    response: !!tp.response,
    waf: !!tp.waf,
    waf_config: tp.wafConfig || null,
    bots: !!tp.bots,
    bot_policy: tp.botPolicy || null,
    reputation: !!tp.reputation,
    reputation_mode: tp.reputationMode,
    fail2ban: !!tp.fail2ban,
    fail2ban_dry_run: !!tp.fail2banDryRun,
    sensitive_data: !!tp.sensitiveData,
    sensitive_data_mode: tp.sensitiveDataMode,
    error_leakage: !!tp.errorLeakage,
    error_leakage_mode: tp.errorLeakageMode,
    uploads: !!tp.uploads,
    uploads_mode: tp.uploadsMode,
    login: !!tp.login,
    login_paths: tp.loginPaths || [],
    api_contract: !!tp.apiContract,
    api_contract_id: tp.apiContractId || null,
    api_contract_mode: tp.apiContractMode,
  };
}

// the threat protection a preset of the gateway describes (adopt mode)
export function threatFromPreset(c = {}) {
  return {
    enabled: true,
    threatPolicy: c.threat_policy || '',
    gate: c.gate !== false,
    response: c.response !== false,
    waf: c.waf !== false,
    wafConfig: c.waf_config || '',
    bots: c.bots !== false,
    botPolicy: c.bot_policy || '',
    reputation: c.reputation !== false,
    reputationMode: c.reputation_mode || 'block',
    fail2ban: !!c.fail2ban,
    fail2banDryRun: c.fail2ban_dry_run !== false,
    sensitiveData: !!c.sensitive_data,
    sensitiveDataMode: c.sensitive_data_mode || 'enforce',
    errorLeakage: !!c.error_leakage,
    errorLeakageMode: c.error_leakage_mode || 'mask',
    uploads: !!c.uploads,
    uploadsMode: c.uploads_mode || 'enforce',
    login: !!c.login,
    loginPaths: c.login_paths || [],
    apiContract: !!c.api_contract,
    apiContractId: c.api_contract_id || '',
    apiContractMode: c.api_contract_mode || 'monitor',
  };
}

// the plugins of a plan: the flow it references, extended by the threat protection it carries
function planPlugins(plan) {
  const slots = plan.threatProtection?.enabled ? [{ plugin: THREAT_PRESET, enabled: true, debug: false, include: [], exclude: [], config: threatPresetConfig(plan.threatProtection) }] : [];
  if (!plan.flowRef && !slots.length) return null;
  return { plugins: slots, overrides: false, flow_ref: plan.flowRef || null };
}

// ---------------------------------------------------------------- derived objects
// Objects that follow from the description of an api are derived by the product, marked as its
// own, reconciled with the api and removed with it: the JWT verifiers of jwt plans that describe
// how their tokens are validated, the trusted CAs of mtls plans (certificates of the gateway), the
// auth modules of oauth2-remote plans that describe their authorization server.

export function derivedVerifierId(apiId, planId) {
  return `apim_jwt_${apiId}_${planId}`;
}

export function derivedAuthModuleId(apiId, planId) {
  return `apim_auth_${apiId}_${planId}`;
}

export function derivedCaId(apiId, planId, pem) {
  return `apim_ca_${apiId}_${planId}_${certificateKey(pem)}`;
}

const derivedMetadata = (api, p) => ({ [META.createdBy]: OWNER_MARKER, [META.api]: api.id, apim_plan_id: p.id, apim_derived: 'true' });

function derivedCertificates(api, p) {
  return (p.auth.config.trustedCAs || []).map((pem) => {
    const c = readCertificate(pem);
    const cn = /CN=([^,]+)/.exec(c.subject)?.[1] || c.subject;
    const id = derivedCaId(api.id, p.id, pem);
    return {
      kind: 'Certificate',
      path: DERIVED_PATHS.Certificate,
      id,
      entity: {
        _loc: { tenant: 'default', teams: ['default'] },
        id,
        domain: cn,
        name: `${api.name} ${api.version} — ${p.name} — ${cn}`,
        description: `trusted CA derived by otoroshi-api-management from plan ${p.name} of ${api.name} ${api.version}`,
        chain: String(pem).trim(),
        privateKey: '',
        caRef: null,
        selfSigned: c.subject === c.issuer,
        ca: c.ca,
        client: false,
        keypair: false,
        valid: true,
        exposed: false,
        revoked: false,
        autoRenew: false,
        letsEncrypt: false,
        sans: [],
        metadata: derivedMetadata(api, p),
        tags: [],
      },
    };
  });
}

function derivedAuthModule(api, p) {
  const d = p.auth.config.derive;
  const id = derivedAuthModuleId(api.id, p.id);
  return {
    kind: 'AuthModule',
    path: DERIVED_PATHS.AuthModule,
    id,
    entity: {
      _loc: { tenant: 'default', teams: ['default'] },
      type: 'oauth2',
      id,
      name: `${api.name} ${api.version} — ${p.name}`,
      desc: `derived by otoroshi-api-management from plan ${p.name} of ${api.name} ${api.version}`,
      clientSideSessionEnabled: true,
      sessionMaxAge: 86400,
      userValidators: [],
      remoteValidators: [],
      clientId: d.clientId || '',
      clientSecret: d.clientSecret || '',
      authorizeUrl: '',
      tokenUrl: '',
      userInfoUrl: d.userInfoUrl || '',
      introspectionUrl: '',
      loginUrl: '',
      logoutUrl: '',
      scope: d.scope || 'openid',
      claims: '',
      useCookie: false,
      useJson: false,
      pkce: null,
      noWildcardRedirectURI: false,
      readProfileFromToken: false,
      accessTokenField: 'access_token',
      // what the plan's extractor validates the tokens with
      jwtVerifier: { type: 'JWKSAlgoSettings', url: d.jwksUrl, headers: {}, timeout: 2000, ttl: 3600000, kty: 'RSA' },
      nameField: 'name',
      emailField: 'email',
      apiKeyMetaField: 'apkMeta',
      apiKeyTagsField: 'apkTags',
      otoroshiDataField: 'app_metadata|otoroshi_data',
      callbackUrl: '',
      oidConfig: d.discoveryUrl || null,
      mtlsConfig: { certs: [], trustedCerts: [], mtls: false, loose: false, trustAll: false },
      proxy: null,
      extraMetadata: {},
      metadata: derivedMetadata(api, p),
      tags: [],
      refreshTokens: false,
      sessionCookieValues: { httpOnly: true, secure: true },
      superAdmins: false,
      rightsOverride: {},
      dataOverride: {},
      otoroshiRightsField: 'otoroshi_rights',
      allowedUsers: [],
      deniedUsers: [],
      adminEntityValidatorsOverride: {},
    },
  };
}

export function derivedEntities(snapshot) {
  const api = snapshot.api;
  const draft = normalizeDraft(snapshot.draft);
  const out = [];
  for (const p of draft.plans) {
    if (p.auth.kind === 'mtls') out.push(...derivedCertificates(api, p));
    if (p.auth.kind === 'oauth2-remote' && p.auth.config.derive?.enabled) out.push(derivedAuthModule(api, p));
    const d = p.auth.kind === 'jwt' ? p.auth.config.derive : null;
    if (!d?.enabled) continue;
    const fields = {};
    if (d.issuer) fields.iss = d.issuer;
    if (d.audience) fields.aud = d.audience;
    out.push({
      kind: 'JwtVerifier',
      path: DERIVED_PATHS.JwtVerifier,
      id: derivedVerifierId(api.id, p.id),
      entity: {
        _loc: { tenant: 'default', teams: ['default'] },
        type: 'global',
        id: derivedVerifierId(api.id, p.id),
        name: `${api.name} ${api.version} — ${p.name}`,
        desc: `derived by otoroshi-api-management from plan ${p.name} of ${api.name} ${api.version}`,
        strict: true,
        source: { type: 'InHeader', name: d.header || 'Authorization', remove: d.prefix ?? 'Bearer ' },
        algoSettings:
          d.kind === 'hmac'
            ? { type: 'HSAlgoSettings', size: parseInt(d.size || 256, 10), secret: d.secret, base64: false }
            : { type: 'JWKSAlgoSettings', url: d.jwksUrl, headers: {}, timeout: 2000, ttl: 3600000, kty: 'RSA' },
        strategy: { type: 'PassThrough', verificationSettings: { fields, arrayFields: {} } },
        metadata: derivedMetadata(api, p),
        tags: [],
      },
    });
  }
  return out;
}

// the client certificates of an application, derived as certificates of the gateway so that the
// TLS handshake of an mtls plan accepts them (a self-signed one in particular)
export function derivedApplicationCertId(appId, pem) {
  return `apim_appcert_${appId}_${certificateKey(pem)}`;
}

export function applicationCertificates(app) {
  return (app.certificates || []).map((pem) => {
    const c = readCertificate(pem);
    const cn = /CN=([^,]+)/.exec(c.subject)?.[1] || c.subject;
    const id = derivedApplicationCertId(app.id, pem);
    return {
      kind: 'Certificate',
      path: DERIVED_PATHS.Certificate,
      id,
      entity: {
        _loc: { tenant: 'default', teams: ['default'] },
        id,
        domain: cn,
        name: `${app.name} — ${cn}`,
        description: `client certificate of the application ${app.name}, derived by otoroshi-api-management while it subscribes to an mtls plan`,
        chain: String(pem).trim(),
        privateKey: '',
        caRef: null,
        selfSigned: c.subject === c.issuer,
        ca: c.ca,
        client: false,
        keypair: false,
        valid: true,
        exposed: false,
        revoked: false,
        autoRenew: false,
        letsEncrypt: false,
        sans: [],
        metadata: { [META.createdBy]: OWNER_MARKER, apim_application_id: app.id, [META.workspace]: app.workspace_id, apim_derived: 'true' },
        tags: [],
      },
    };
  });
}

// what of a derived object the product owns, by kind (the gateway adds its own fields: the
// subject and dates of a certificate, the secret of a module it may not give back)
export function comparableDerived(e) {
  if (!e) return null;
  const owner = e.metadata?.[META.createdBy];
  if ('chain' in e) return { chain: String(e.chain || '').replace(/\s+/g, ''), ca: !!e.ca, revoked: !!e.revoked, owner };
  if ('jwtVerifier' in e)
    return {
      type: e.type,
      jwks: e.jwtVerifier ? { type: e.jwtVerifier.type, url: e.jwtVerifier.url } : null,
      userInfoUrl: e.userInfoUrl || '',
      clientId: e.clientId || '',
      scope: e.scope || '',
      discovery: e.oidConfig || null,
      owner,
    };
  return { source: e.source, algoSettings: e.algoSettings, verification: e.strategy?.verificationSettings || null, owner };
}

// snapshot = { api: {...}, draft: {...}, docs: {...} } — see apis.publish()
export function buildOtoroshiApi(snapshot, { snapshotId, snapshotNumber, lifecycle } = {}) {
  const api = snapshot.api;
  const draft = normalizeDraft(snapshot.draft);
  draft.__apiId = api.id;
  return {
    _loc: { tenant: 'default', teams: ['default'] }, // never an otoroshi tenant
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
    flows: draft.flows.map((f) => flowJson(f, snapshot.policyGroups, { correlationId: draft.settings.correlationId !== false })),
    clients_backend_config: draft.backends.map(clientJson),
    // the documentation stays in the product, even though Otoroshi has ApiDocumentation
    documentation: null,
    testing: { enabled: false, headerKey: 'X-OTOROSHI-TESTING' },
    clients: [],
    hooks: [],
  };
}

function ms(d) {
  return d ? new Date(d).getTime() : Date.now();
}

// the kinds whose consumer the gateway builds at call time, from a token or a certificate
export const IDENTITY_KINDS = ['jwt', 'mtls', 'oauth2-remote'];

// on apikey / oauth2-local plans Otoroshi mints the key from the ApiSubscription; the application is
// projected as an id_ref metadata on the key. On jwt / mtls / oauth2-remote plans the subscription
// carries the client id the application declares: Otoroshi provisions the key the plan resolves for
// that consumer, enabled while the subscription is. The client id of a subscription never changes on
// the gateway: when the application declares another one, the subscription is made again.
export function buildOtoroshiSubscription(sub, { application }) {
  const enabled = sub.status === 'active';
  const clientId = IDENTITY_KINDS.includes(sub.auth_kind) && application?.client_id ? application.client_id : null;
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
    // only an effective subscription is projected: active, or suspended (its key disabled)
    status: enabled ? 'enabled' : 'disabled',
    ...(clientId ? { client_id: clientId } : {}),
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
      subscription_required: IDENTITY_KINDS.includes(p.access_mode_configuration_type) ? !!p.access_mode_configuration?.subscription_required : undefined,
      selection: (p.selection || []).map((c) => ({ path: c.path, value: c.value })),
      counter_failure: p.counter_failure?.mode || 'deny',
      circuit_breaker_scope: p.circuit_breaker_scope || 'route',
      trusted_ca_refs: p.access_mode_configuration_type === 'mtls' ? p.access_mode_configuration?.trusted_ca_refs || [] : undefined,
      dn_match: p.access_mode_configuration_type === 'mtls' ? p.access_mode_configuration?.dn_match || 'any' : undefined,
      issuer: p.access_mode_configuration_type === 'oauth2-remote' ? p.access_mode_configuration?.issuer || null : undefined,
      audiences: p.access_mode_configuration_type === 'oauth2-remote' ? p.access_mode_configuration?.audiences || [] : undefined,
      validity: p.access_mode_configuration_type === 'apikey' ? p.access_mode_configuration?.validity || null : undefined,
      restrictions: p.access_mode_configuration?.restrictions?.enabled
        ? (({ allowLast, allowed, forbidden, notFound }) => ({ allowLast, allowed, forbidden, notFound }))(p.access_mode_configuration.restrictions)
        : null,
      flow_ref: p.plugins?.flow_ref || null,
      plugins: stripPlugins(p.plugins?.plugins),
    })),
  };
}
