// The Threat Protection Suite on a plan, end to end on the gateway: the plan carries the preset of
// the extension in its plugins, the drift detection reads it back as it was projected — and a
// gateway without the extension, which ignores a plugin it does not know and lets the calls through
// unprotected, gets the draft and the deployment warned.
//
// Needs the docker stack (mise run up). The gateway of the stack has no Threat Protection Suite;
// with one, the warning is gone and the calls are judged by the extension.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(90000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'threats-test-token';

const { start } = await import('../server/main.js');
const { otoroshi } = await import('../server/otoroshi/client.js');
const { THREAT_PRESET } = await import('../server/otoroshi/projection.js');
const { threatProtectionInstalled } = await import('../server/otoroshi/threats.js');

const RUN = Date.now().toString(36);
const WS = `threats-${RUN}`;
const DOMAIN = `threats-${RUN}.oto.tools`;
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

async function gatewayStatus(wanted) {
  let last;
  for (let i = 0; i < 60; i++) {
    last = (await fetch('http://localhost:8080/', { headers: { Host: DOMAIN } })).status;
    if (last === wanted) return last;
    await Bun.sleep(500);
  }
  return last;
}

beforeAll(async () => {
  server = await start();
  await call('POST', '/workspaces', { name: `Threats ${RUN}`, slug: WS });
  const team = await call('POST', ws('/teams'), { name: 'Guards' });
  const api = await call('POST', ws('/apis'), { name: 'Vault', version: '1.0.0', team_id: team.id, domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
  state.api = api;
  const draft = api.draft;
  draft.plans = [
    {
      id: `plan_open_${RUN}`,
      name: 'Open',
      status: 'published',
      auth: { kind: 'keyless' },
      threatProtection: { enabled: true, waf: true, bots: true, reputation: true, reputationMode: 'monitor', login: true, loginPaths: ['/login'] },
    },
  ];
  state.validation = (await call('PUT', ws(`/apis/${api.id}/draft`), { draft })).validation;
  state.published = await call('POST', ws(`/apis/${api.id}/publish`), { comment: 'guarded', deploy: true });
});

afterAll(async () => {
  try {
    if (state.api) await call('DELETE', ws(`/apis/${state.api.id}`));
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('threat protection on a plan', () => {
  test('the gateway of the stack has no Threat Protection Suite', async () => {
    expect(await threatProtectionInstalled()).toBe(false);
    expect(await call('GET', '/gateway/threat-protection')).toEqual({ installed: false, plugin: THREAT_PRESET });
  });

  test('the draft and the deployment are warned: the plan would run unprotected', async () => {
    const codes = (list) => (list || []).map((w) => w.code);
    expect(codes(state.validation.warnings)).toContain('threat_protection_unavailable');
    // no threat policy named: the built-in one records and never refuses
    expect(codes(state.validation.warnings)).toContain('threat_protection_dry_run');
    expect(codes(state.published.warnings)).toContain('threat_protection_unavailable');
  });

  test('the plan carries the preset of the extension, which the gateway keeps as it was written', async () => {
    const entity = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${state.api.id}`);
    const plugins = entity.plans[0].plugins;
    expect(plugins.plugins.map((p) => p.plugin)).toEqual([THREAT_PRESET]);
    expect(plugins.plugins[0].config).toMatchObject({ threat_policy: null, waf: true, bots: true, reputation: true, reputation_mode: 'monitor', login: true, login_paths: ['/login'] });
    await call('POST', ws('/drift'));
    const reports = await call('GET', ws('/drift'));
    const mine = reports.find((r) => r.entity_kind === 'api' && r.entity_id === state.api.id);
    expect(mine.status).toBe('in_sync');
  });

  test('a gateway without the extension lets the calls through: the warning is the only guard', async () => {
    expect(await gatewayStatus(200)).toBe(200);
  });
});
