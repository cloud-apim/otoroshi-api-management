// Unit tests of the model and the projection — no database, no gateway.
import { describe, expect, test } from 'bun:test';
import { normalizeDraft, validateDraft, resolutionOrder, plansAreEquivalent, defaultPlan } from '../server/domain/model.js';
import { buildOtoroshiApi, buildOtoroshiSubscription, restrictionsFor, restrictionPath, rateLimitingFor, comparableApi, THREAT_PRESET, threatFromPreset, threatPresetConfig } from '../server/otoroshi/projection.js';
import { diff } from '../server/domain/diff.js';
import { maskUrl } from '../server/domain/ingest.js';

function draft(plans = []) {
  return normalizeDraft({
    entrypoint: { domain: 'pets.oto.tools', contextPath: '/v1' },
    backends: [{ id: 'b1', name: 'echo', targets: [{ hostname: 'echo', port: 8080 }] }],
    flows: [{ id: 'f1', name: 'flow', plugins: [] }],
    resources: [
      { id: 'r_pets', name: 'Pets', path: '/pets', methods: ['GET'], backendId: 'b1', flowId: 'f1' },
      { id: 'r_store', name: 'Store', path: '/store', backendId: 'b1', flowId: 'f1', exact: true },
    ],
    plans,
  });
}

describe('validation', () => {
  test('an api without a published or deprecated plan is closed, and says so', () => {
    const v = validateDraft(draft([defaultPlan({ status: 'staging' })]));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain('no_served_plan');
    // a deprecated plan is still served
    expect(validateDraft(draft([defaultPlan({ status: 'deprecated' })])).warnings.map((w) => w.code)).not.toContain('no_served_plan');
  });

  test('two keyless or jwt plans that can both match need a selection, the plan without one last', () => {
    const jwt = (id) => defaultPlan({ id, name: id, status: 'published', auth: { kind: 'jwt', config: { verifier: 'v' } } });
    expect(validateDraft(draft([jwt('a'), jwt('b')])).ok).toBe(false);
    const gold = { ...jwt('gold'), selection: [{ path: '$.token.tier', value: 'gold' }] };
    const v = validateDraft(draft([gold, jwt('free')]));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).not.toContain('selection_shadowed');
    // the plan without selection first would take every caller
    expect(validateDraft(draft([jwt('free'), gold])).warnings.map((w) => w.code)).toContain('selection_shadowed');
    // a deprecated plan is served: it counts
    expect(validateDraft(draft([jwt('a'), { ...jwt('b'), status: 'deprecated' }])).ok).toBe(false);
    // two apikey plans are told apart by the key itself, and take no selection
    const key = (id) => defaultPlan({ id, status: 'published' });
    expect(validateDraft(draft([key('a'), key('b')])).ok).toBe(true);
    expect(validateDraft(draft([{ ...key('a'), selection: [{ path: '$.request.ip', value: 'x' }] }])).ok).toBe(false);
  });

  test('the request id of the gateway is sent to the backends, unless the api says otherwise', () => {
    const snap = (settings) => ({ api: { id: 'api_1', name: 'x', version: '1' }, draft: { ...draft([]), settings: { ...draft([]).settings, ...settings } } });
    const plugins = (s) => buildOtoroshiApi(snap(s)).flows[0].plugins.map((p) => p.plugin);
    expect(plugins({})).toContain('cp:otoroshi.next.plugins.OtoroshiHeadersIn');
    expect(plugins({ correlationId: false })).not.toContain('cp:otoroshi.next.plugins.OtoroshiHeadersIn');
  });

  test('the selection, the counter failure strategy and the circuit breaker are projected on the plan', () => {
    const p = defaultPlan({ id: 'gold', status: 'published', auth: { kind: 'jwt', config: { verifier: 'v' } }, selection: [{ path: '$.token.tier', value: 'gold' }], counterFailure: 'deny', circuitBreaker: 'subscription' });
    const plan = buildOtoroshiApi({ api: { id: 'api_1', name: 'x', version: '1' }, draft: draft([p]) }).plans[0];
    expect(plan.selection).toEqual([{ path: '$.token.tier', value: 'gold' }]);
    expect(plan.counter_failure).toEqual({ mode: 'deny' });
    expect(plan.circuit_breaker_scope).toBe('consumer');
    expect(plan.metadata).toEqual({ apim_unit: 'calls' });
    expect(validateDraft(draft([p])).warnings.map((w) => w.code)).not.toContain('not_enforced');
  });

  test('a token or budget plan is refused without an llm backend', () => {
    const v = validateDraft(draft([defaultPlan({ status: 'published', unit: 'tokens' })]));
    expect(v.ok).toBe(false);
  });

  test('a resource pointing to an unknown backend is an error', () => {
    const d = draft([defaultPlan({ status: 'published' })]);
    d.resources[0].backendId = 'nope';
    expect(validateDraft(d).ok).toBe(false);
  });

  test('resolution order follows the extractor indexes, keyless last', () => {
    const order = resolutionOrder(
      draft([
        defaultPlan({ id: 'k', status: 'published', auth: { kind: 'keyless' } }),
        defaultPlan({ id: 'j', status: 'published', auth: { kind: 'jwt', config: { verifier: 'v' } } }),
        defaultPlan({ id: 'a', status: 'published', auth: { kind: 'apikey' } }),
      ])
    ).map((o) => o.id);
    expect(order).toEqual(['a', 'j', 'k']);
  });

  test('transfer equivalence is the auth mechanism', () => {
    expect(plansAreEquivalent(defaultPlan({ auth: { kind: 'apikey' } }), defaultPlan({ auth: { kind: 'apikey' } }))).toBe(true);
    expect(plansAreEquivalent(defaultPlan({ auth: { kind: 'apikey' } }), defaultPlan({ auth: { kind: 'jwt' } }))).toBe(false);
  });
});

describe('projection', () => {
  test('resource filtering: allowed list first, the rest is forbidden', () => {
    const d = draft();
    const r = restrictionsFor({ resourceFilter: { mode: 'only', resources: ['r_pets', 'r_store'] } }, d);
    expect(r.enabled).toBe(true);
    // with allowLast=true Otoroshi never reads the allowed list
    expect(r.allowLast).toBe(false);
    // the paths are regexes Otoroshi matches against the whole request path
    expect(r.allowed).toEqual([
      { method: 'GET', path: '/v1/pets(/.*)?', authorized_entity: null },
      { method: '*', path: '/v1/store', authorized_entity: null },
    ]);
    expect(r.forbidden).toEqual([{ method: '*', path: '/.*', authorized_entity: null }]);
    const matches = (re, path) => new RegExp(`^(?:${re})$`).test(path);
    expect(matches(r.allowed[0].path, '/v1/pets/42')).toBe(true);
    expect(matches(r.allowed[0].path, '/v1/pets')).toBe(true);
    expect(matches(r.allowed[0].path, '/v1/petshop')).toBe(false);
    expect(matches(restrictionPath('/v1/users/:id', true), '/v1/users/42')).toBe(true);
    expect(matches(restrictionPath('/v1.2/a+b', true), '/v1x2/a+b')).toBe(false);
    expect(matches(restrictionPath('', false), '/')).toBe(true);
    expect(restrictionsFor({ resourceFilter: { mode: 'all', resources: [] } }, d).enabled).toBe(false);
  });

  test('rate limit and quotas become a fixed window strategy', () => {
    const s = rateLimitingFor({ rateLimit: { enabled: true, calls: 500, windowMs: 60000 }, quota: { daily: 1000, monthly: null } }).strategy;
    expect(s).toEqual({ id: 'FixedWindowStrategyConfig', windowDurationMs: 60000, quota: { window: 500, daily: 1000, monthly: 10000000 } });
  });

  test('the api entity is managed as code and never carries portal-only data', () => {
    const plan = defaultPlan({ id: 'p', status: 'published', usageStatement: { enabled: true, required: true, prompt: 'SECRET-PROMPT' }, pricing: { kind: 'paid', amount: 42 } });
    const d = draft([plan]);
    const e = buildOtoroshiApi({ api: { id: 'api_1', name: 'Pets', version: '1.0.0', workspace_id: 'ws', tags: [] }, draft: d }, { snapshotId: 'snap_1', snapshotNumber: 3 });
    expect(e.metadata.created_by).toBe('external=otoroshi-api-management');
    expect(e.metadata.deployment_ref).toBe('snap_1');
    expect(e.contextPath).toBe('/v1');
    expect(e.state).toBe('published');
    expect(e.documentation).toBeNull();
    expect(JSON.stringify(e)).not.toContain('SECRET-PROMPT');
    expect(JSON.stringify(e.plans)).not.toContain('"price"');
    expect(e.routes.map((r) => r.frontend.domains[0])).toEqual(['/pets', '/store']);
  });

  test('a shared policy group is expanded inline from the version the snapshot froze', () => {
    const d = draft([defaultPlan({ status: 'published' })]);
    d.flows[0].plugins = [{ plugin: 'cp:a', config: {} }, { group: 'pg_1', version: 2 }];
    const groups = { 'pg_1@2': { name: 'company', plugins: [{ plugin: 'cp:headers', config: { v: 2 } }, { plugin: 'cp:cors', config: {} }] } };
    const e = buildOtoroshiApi({ api: { id: 'a', name: 'x', version: '1', workspace_id: 'ws' }, draft: d, policyGroups: groups });
    expect(e.flows[0].plugins.map((p) => p.plugin)).toEqual(['cp:a', 'cp:headers', 'cp:cors', 'cp:otoroshi.next.plugins.OtoroshiHeadersIn']);
    // a snapshot that does not carry the pinned version cannot be projected
    expect(() => buildOtoroshiApi({ api: { id: 'a', name: 'x', version: '1', workspace_id: 'ws' }, draft: d, policyGroups: {} })).toThrow(/pg_1 v2/);
    // a floating reference is refused at validation
    d.flows[0].plugins[1].version = null;
    expect(validateDraft(d).ok).toBe(false);
  });

  test('only an active subscription is projected as enabled', () => {
    for (const [status, wanted] of [['active', 'enabled'], ['suspended', 'disabled'], ['pending', 'disabled']]) {
      const s = buildOtoroshiSubscription({ id: 's', status, application_id: 'app', workspace_id: 'ws', plan_id: 'p', api_id: 'a', auth_kind: 'apikey', dates: {} }, { application: { name: 'x' } });
      expect(s.status).toBe(wanted);
      expect(s.metadata.id_ref).toBe('app');
    }
  });

  test('drift comparison ignores what the gateway adds and key order', () => {
    const d = draft([defaultPlan({ id: 'p', status: 'published' })]);
    const e = buildOtoroshiApi({ api: { id: 'api_1', name: 'Pets', version: '1', workspace_id: 'ws' }, draft: d });
    const fromGateway = JSON.parse(JSON.stringify({ ...e, deployments: [{ id: 'x' }], metadata: { ...e.metadata, created_at: 'now' } }));
    fromGateway.backends[0].backend.targets[0] = Object.fromEntries(Object.entries(fromGateway.backends[0].backend.targets[0]).reverse());
    expect(diff(comparableApi(e), comparableApi(fromGateway))).toEqual([]);
    fromGateway.routes[0].frontend.methods = ['GET', 'DELETE'];
    expect(diff(comparableApi(e), comparableApi(fromGateway)).map((c) => c.path)).toEqual(['routes[Pets].methods']);
  });
});

describe('threat protection', () => {
  const api = { id: 'a', name: 'x', version: '1', workspace_id: 'ws' };
  const protectedPlan = (tp, extra = {}) => defaultPlan({ id: 'p_tp', name: 'guarded', status: 'published', threatProtection: { enabled: true, threatPolicy: 'tp_strict', ...tp }, ...extra });

  test('a plan carries the preset of the Threat Protection Suite in its plugins, after the flow it references', () => {
    const e = buildOtoroshiApi({ api, draft: draft([protectedPlan({ waf: true, wafConfig: 'waf_api', login: true, loginPaths: ['/login'] }, { flowRef: 'f1' })]) });
    const plugins = e.plans[0].plugins;
    expect(plugins.flow_ref).toBe('f1');
    expect(plugins.plugins.map((p) => p.plugin)).toEqual([THREAT_PRESET]);
    expect(plugins.plugins[0].config).toMatchObject({ threat_policy: 'tp_strict', waf: true, waf_config: 'waf_api', login: true, login_paths: ['/login'], reputation_mode: 'block', fail2ban: false });
    // nothing when the plan asks for nothing
    expect(buildOtoroshiApi({ api, draft: draft([defaultPlan({ status: 'published' })]) }).plans[0].plugins).toBeNull();
    expect(buildOtoroshiApi({ api, draft: draft([defaultPlan({ status: 'published', flowRef: 'f1' })]) }).plans[0].plugins).toEqual({ plugins: [], overrides: false, flow_ref: 'f1' });
  });

  test('a change of its protection is drift on the gateway, and adopt mode takes it back as it was', () => {
    const tp = normalizeDraft({ plans: [protectedPlan({ fail2ban: true, apiContract: true, apiContractId: 'c1', apiContractMode: 'enforce' })] }).plans[0].threatProtection;
    expect(threatFromPreset(threatPresetConfig(tp))).toEqual(tp);
    const a = comparableApi(buildOtoroshiApi({ api, draft: draft([protectedPlan({ fail2ban: false })]) }));
    const b = comparableApi(buildOtoroshiApi({ api, draft: draft([protectedPlan({ fail2ban: true })]) }));
    expect(diff(a, b).map((c) => c.path)).toEqual(['plans[guarded].plugins[0].config.fail2ban']);
  });

  test('a protection that records only, or a guard with nothing to guard, is said; a wrong mode is refused', () => {
    const codes = (tp) => validateDraft(draft([protectedPlan(tp)])).warnings.map((w) => w.code);
    expect(codes({ threatPolicy: '' })).toContain('threat_protection_dry_run');
    expect(codes({})).not.toContain('threat_protection_dry_run');
    expect(codes({ login: true })).toContain('login_guard_idle');
    expect(codes({ apiContract: true })).toContain('api_contract_idle');
    const v = validateDraft(draft([protectedPlan({ reputationMode: 'shout' })]));
    expect(v.ok).toBe(false);
    expect(v.errors[0].message).toContain('reputationMode is one of block, monitor');
    // a plan that is not protected says nothing of it
    expect(validateDraft(draft([defaultPlan({ status: 'published', threatProtection: { enabled: false, reputationMode: 'shout' } })])).ok).toBe(true);
  });
});

describe('ingestion', () => {
  test('secrets in the url are masked on the raw path', () => {
    expect(maskUrl('http://x.oto.tools/v1/books?page=2&api_key=abc&access_token=t')).toBe('http://x.oto.tools/v1/books?page=2&api_key=********&access_token=********');
    expect(maskUrl('/v1/books?q=x')).toBe('/v1/books?q=x');
  });
});
