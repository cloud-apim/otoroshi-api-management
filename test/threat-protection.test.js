// The Threat Protection Suite on a plan, end to end on the gateway: the plan carries the preset of
// the extension in its plugins, referencing the policies an operator made in the extension; the
// drift detection reads it back as it was projected. With the extension, an attack on the api is
// refused and its security event reaches the ingester, attributed to the api and — through the key
// that called — to the plan, the subscription and the application. Without it, the gateway ignores a
// plugin it does not know and lets the calls through unprotected: the draft and the deployment are
// warned.
//
// Needs the docker stack (mise run up); the extension case needs the gateway started with the
// extension (OTOROSHI_EXTENSIONS, see the install documentation).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(120000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'threats-test-token';

const { start } = await import('../server/main.js');
const { otoroshi } = await import('../server/otoroshi/client.js');
const { THREAT_PRESET } = await import('../server/otoroshi/projection.js');
const { threatProtectionInstalled } = await import('../server/otoroshi/threats.js');

const INSTALLED = (await threatProtectionInstalled()) === true;
const RUN = Date.now().toString(36);
const WS = `threats-${RUN}`;
const DOMAIN = `threats-${RUN}.oto.tools`;
const GROUP = '/apis/waf.extensions.cloud-apim.com/v1';
const POLICY = `tp_strict_${RUN}`;
const WAF = `waf_crs_${RUN}`;
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer threats-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}
const ws = (p) => `/workspaces/${WS}${p}`;

const hit = async (path = '/', key = state.key) =>
  (await fetch(`http://localhost:8080${path}`, { headers: { Host: DOMAIN, ...(key ? { 'Otoroshi-Client-Id': key.client_id, 'Otoroshi-Client-Secret': key.client_secret } : {}) } })).status;
async function until(fn, wanted, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (wanted(last)) return last;
    await Bun.sleep(500);
  }
  return last;
}

beforeAll(async () => {
  server = await start();
  await call('POST', '/workspaces', { name: `Threats ${RUN}`, slug: WS });
  const team = await call('POST', ws('/teams'), { name: 'Guards' });
  if (INSTALLED) {
    // what an operator makes in the extension: a policy that refuses, a firewall with the core rule set
    // (from the templates of the extension, the fields that matter set)
    const policy = await otoroshi('GET', `${GROUP}/threat-policies/_template`);
    // a refusal at 90 — the weight of a block of the firewall — and nothing below: every call of a
    // ruleset with the core rule set scores a match already (waf#62)
    const tier = { ...policy.tiers[0], min_score: 90, action: 'deny', status: 403 };
    await otoroshi('POST', `${GROUP}/threat-policies/${POLICY}`, { ...policy, id: POLICY, name: 'Strict', dry_run: false, waf_block_decisive: true, tiers: [tier] });
    const waf = await otoroshi('GET', `${GROUP}/waf-configs/_template`);
    // the firewall reports, the threat response decides: the fabric of the extension
    await otoroshi('POST', `${GROUP}/waf-configs/${WAF}`, { ...waf, id: WAF, name: 'Core rule set', block: false, rules: ['@import_preset crs', 'SecRuleEngine On'] });
  }
  const api = await call('POST', ws('/apis'), { name: 'Vault', version: '1.0.0', team_id: team.id, domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
  state.api = api;
  const draft = api.draft;
  draft.plans = [
    {
      id: `plan_guarded_${RUN}`,
      name: 'Guarded',
      status: 'published',
      auth: { kind: 'apikey' },
      validation: 'auto',
      threatProtection: INSTALLED
        ? { enabled: true, threatPolicy: POLICY, gate: true, response: true, waf: true, wafConfig: WAF, bots: false, reputation: false }
        : { enabled: true, waf: true, bots: true, reputation: true, reputationMode: 'monitor', login: true, loginPaths: ['/login'] },
    },
  ];
  state.validation = (await call('PUT', ws(`/apis/${api.id}/draft`), { draft })).validation;
  state.published = await call('POST', ws(`/apis/${api.id}/publish`), { comment: 'guarded', deploy: true });
  const app = await call('POST', ws('/applications'), { name: 'Safe client', team_id: team.id });
  state.app = app;
  const sub = await call('POST', ws('/subscriptions'), { api_id: api.id, plan_id: draft.plans[0].id, application_id: app.id });
  await call('POST', ws(`/subscriptions/${sub.id}/resync`));
  state.sub = sub;
  state.key = (await call('GET', ws(`/subscriptions/${sub.id}`))).credentials[0];
});

afterAll(async () => {
  try {
    if (state.api) await call('DELETE', ws(`/apis/${state.api.id}`));
    await call('DELETE', `/workspaces/${WS}`);
    if (INSTALLED) {
      await otoroshi('DELETE', `${GROUP}/threat-policies/${POLICY}`).catch(() => null);
      await otoroshi('DELETE', `${GROUP}/waf-configs/${WAF}`).catch(() => null);
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

const codes = (list) => (list || []).map((w) => w.code);
const refused = (e) => ['deny', 'ban', 'block'].includes(e.action);

describe('threat protection on a plan', () => {
  test('the plan carries the preset of the extension, which the gateway keeps as it was written', async () => {
    const entity = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${state.api.id}`);
    const plugins = entity.plans[0].plugins;
    expect(plugins.plugins.map((p) => p.plugin)).toEqual([THREAT_PRESET]);
    expect(plugins.plugins[0].config).toMatchObject(INSTALLED ? { threat_policy: POLICY, waf: true, waf_config: WAF, bots: false } : { threat_policy: null, waf: true, login_paths: ['/login'] });
    await call('POST', ws('/drift'));
    const mine = (await call('GET', ws('/drift'))).find((r) => r.entity_kind === 'api' && r.entity_id === state.api.id);
    expect(mine.status).toBe('in_sync');
  });

  test.if(!INSTALLED)('without the extension, the draft and the deployment are warned: the plan would run unprotected', async () => {
    expect(await call('GET', '/gateway/threat-protection')).toEqual({ installed: false, plugin: THREAT_PRESET });
    expect(codes(state.validation.warnings)).toContain('threat_protection_unavailable');
    // no threat policy named: the built-in one records and never refuses
    expect(codes(state.validation.warnings)).toContain('threat_protection_dry_run');
    expect(codes(state.published.warnings)).toContain('threat_protection_unavailable');
    // the gateway ignores the plugin it does not know: the calls go through, the warning is the only guard
    expect(await until(() => hit(), (s) => s === 200)).toBe(200);
  });

  test.if(INSTALLED)('with the extension, the console offers its policies, and nothing is warned', async () => {
    const catalog = await call('GET', '/gateway/threat-protection');
    expect(catalog.installed).toBe(true);
    expect(catalog.threat_policies.find((p) => p.id === POLICY)).toMatchObject({ name: 'Strict', dry_run: false, challenge: false });
    expect(catalog.waf_configs.map((w) => w.id)).toContain(WAF);
    expect(codes(state.validation.warnings)).not.toContain('threat_protection_unavailable');
    expect(codes(state.validation.warnings)).not.toContain('threat_protection_dry_run');
  });

  test.if(INSTALLED)('an attack is refused, a legitimate call served; the security event is attributed to the api and the plan', async () => {
    expect(await until(() => hit('/?q=books'), (s) => s === 200)).toBe(200);
    const attack = `/?id=${encodeURIComponent("1' OR '1'='1' UNION SELECT password FROM users --")}`;
    // refused by the threat response, the firewall having reached a block decision
    expect(await until(() => hit(attack), (s) => s === 403, 20)).toBe(403);
    // the event, exported by the gateway to the ingester of the stack
    const found = await until(
      () => call('GET', ws(`/analytics/security?api=${state.api.id}`)),
      (r) => r.items.some((e) => e.client_id === state.key.client_id && refused(e)),
      90
    );
    const event = found.items.find((e) => e.client_id === state.key.client_id && refused(e));
    expect(event).toMatchObject({ api_id: state.api.id, plan_id: `plan_guarded_${RUN}`, subscription_id: state.sub.id, application_id: state.app.id, application_name: 'Safe client' });
  });
});
