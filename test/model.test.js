// Unit tests of the model and the projection — no database, no gateway.
import { describe, expect, test } from 'bun:test';
import { normalizeDraft, validateDraft, resolutionOrder, plansAreEquivalent, defaultPlan } from '../server/domain/model.js';
import { buildOtoroshiApi, buildOtoroshiSubscription, restrictionsFor, rateLimitingFor, comparableApi } from '../server/otoroshi/projection.js';
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
  test('an api without a published plan is flagged as open', () => {
    const v = validateDraft(draft([defaultPlan({ status: 'staging' })]));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toContain('open_routes');
  });

  test('two keyless or jwt plans that can both match need a selection rule', () => {
    const jwt = (id) => defaultPlan({ id, status: 'published', auth: { kind: 'jwt', config: { verifier: 'v' } } });
    expect(validateDraft(draft([jwt('a'), jwt('b')])).ok).toBe(false);
    const withRule = { ...jwt('b'), selectionRule: "${token.aud} == 'x'" };
    expect(validateDraft(draft([jwt('a'), withRule])).ok).toBe(true);
    // two apikey plans are told apart by the key itself
    const key = (id) => defaultPlan({ id, status: 'published' });
    expect(validateDraft(draft([key('a'), key('b')])).ok).toBe(true);
  });

  test('a token or budget plan is refused without an llm backend (D-41)', () => {
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

  test('transfer equivalence is the auth mechanism (D-30)', () => {
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
    expect(r.allowed).toEqual([
      { method: 'GET', path: '/v1/pets*', authorized_entity: null },
      { method: '*', path: '/v1/store', authorized_entity: null },
    ]);
    expect(r.forbidden).toEqual([{ method: '*', path: '*', authorized_entity: null }]);
    expect(restrictionsFor({ resourceFilter: { mode: 'all', resources: [] } }, d).enabled).toBe(false);
  });

  test('rate limit and quotas become a fixed window strategy', () => {
    const s = rateLimitingFor({ rateLimit: { enabled: true, calls: 500, windowMs: 60000 }, quota: { daily: 1000, monthly: null } }).strategy;
    expect(s).toEqual({ id: 'FixedWindowStrategyConfig', windowDurationMs: 60000, quota: { window: 500, daily: 1000, monthly: 10000000 } });
  });

  test('the api entity is catalog-marked and never carries portal-only data (D-2, D-38)', () => {
    const plan = defaultPlan({ id: 'p', status: 'published', usageStatement: { enabled: true, required: true, prompt: 'SECRET-PROMPT' }, pricing: { kind: 'paid', amount: 42 } });
    const d = draft([plan]);
    const e = buildOtoroshiApi({ api: { id: 'api_1', name: 'Pets', version: '1.0.0', workspace_id: 'ws', tags: [] }, draft: d }, { snapshotId: 'snap_1', snapshotNumber: 3 });
    expect(e.metadata.created_by).toBe('remote_catalog=otoroshi-apim-deployment');
    expect(e.metadata.apim_snapshot_id).toBe('snap_1');
    expect(e.contextPath).toBe('/v1');
    expect(e.state).toBe('published');
    expect(e.documentation).toBeNull();
    expect(JSON.stringify(e)).not.toContain('SECRET-PROMPT');
    expect(JSON.stringify(e.plans)).not.toContain('"price"');
    expect(e.routes.map((r) => r.frontend.domains[0])).toEqual(['/pets', '/store']);
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

describe('ingestion', () => {
  test('secrets in the url are masked on the raw path (D-33)', () => {
    expect(maskUrl('http://x.oto.tools/v1/books?page=2&api_key=abc&access_token=t')).toBe('http://x.oto.tools/v1/books?page=2&api_key=********&access_token=********');
    expect(maskUrl('/v1/books?q=x')).toBe('/v1/books?q=x');
  });
});
