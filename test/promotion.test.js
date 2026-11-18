// Promotion, between two real installations: the "recette" one is this test's server, on the
// database of the stack; the "production" one is a second server, started on a database of its
// own. The same snapshot goes from one to the other, unchanged — what differs between them is a
// vault reference, resolved by the gateway.
//
// Needs the docker stack (mise run up). Both installations share its gateway here, so the recette
// publishes without deploying, and only the production deploys.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'promotion-recette-token';
config.installationName = 'recette';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { otoroshi } = await import('../server/otoroshi/client.js');

const RUN = Date.now().toString(36);
const WS = `promo-${RUN}`;
const DOMAIN = `promo-${RUN}.oto.tools`;
const PROD_PORT = 9119;
const PROD_DB = `apim_promo_${RUN}`;
const PROD_TOKEN = 'promotion-production-token';
const ENV_KEY = `promo_${RUN}`;
const OPEN = `plan_promo_open_${RUN}`;

let recette;
let production;
const state = {};

const at = (base, token) => async (method, path, body) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rec = at(`http://localhost:${config.port}`, 'promotion-recette-token');
const prod = at(`http://localhost:${PROD_PORT}`, PROD_TOKEN);
async function ok(call, method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function gatewayEnv(update) {
  const gc = await otoroshi('GET', '/api/globalconfig');
  await otoroshi('PUT', '/api/globalconfig', { ...gc, env: update(gc.env || {}) });
}

async function until(fn, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await Bun.sleep(500);
  }
  return null;
}

beforeAll(async () => {
  // the values of this environment, read by the gateway's local vault
  await gatewayEnv((env) => ({ ...env, [ENV_KEY]: { domain: DOMAIN, backend: 'echo' } }));
  recette = await start();
  await db.unsafe(`create database ${PROD_DB}`);
  production = Bun.spawn(['bun', 'server/main.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      APIM_PORT: String(PROD_PORT),
      APIM_PUBLIC_URL: `http://localhost:${PROD_PORT}`,
      APIM_DATABASE_URL: `postgres://apim:apim@localhost:5442/${PROD_DB}`,
      APIM_ADMIN_TOKEN: PROD_TOKEN,
      APIM_WORKERS_ENABLED: 'false',
      APIM_INSTALLATION_NAME: 'production',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  expect(await until(async () => (await fetch(`http://localhost:${PROD_PORT}/health`)).ok)).toBe(true);

  // on the recette: an api whose domain and backend are those of the environment
  await ok(rec, 'POST', '/workspaces', { name: `Promotion ${RUN}`, slug: WS });
  const team = await ok(rec, 'POST', `/workspaces/${WS}/teams`, { name: 'Weather team' });
  const api = await ok(rec, 'POST', `/workspaces/${WS}/apis`, { name: 'Forecasts', version: '1.0.0', team_id: team.id, domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
  state.apiId = api.id;
  const draft = api.draft;
  draft.entrypoint.domain = `\${vault://local/${ENV_KEY}/domain}`;
  draft.backends[0].targets = [{ hostname: `\${vault://local/${ENV_KEY}/backend}`, port: 8080, tls: false, weight: 1 }];
  draft.resources = [{ id: 'res_today', name: 'Today', path: '/today', methods: ['GET'], backendId: draft.backends[0].id, flowId: draft.flows[0].id }];
  draft.plans = [{ id: OPEN, name: 'Open', status: 'published', auth: { kind: 'keyless', config: { expr: '${req.ip}', createIfMissing: false } }, rateLimit: { enabled: true, calls: 100, windowMs: 60000 } }];
  await ok(rec, 'PUT', `/workspaces/${WS}/apis/${api.id}`, { description: `Forecasts for \${vault://local/${ENV_KEY}/region} and \${vault://env/PROMO_REGION_${RUN}}` });
  await ok(rec, 'PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok(rec, 'POST', `/workspaces/${WS}/apis/${api.id}/pages`, { slug: 'start', title: { en: 'Getting started' }, content: { en: '# Getting started' } });
  await ok(rec, 'POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'first' });
  // a second snapshot: the numbers of the two installations are their own
  draft.plans[0].rateLimit.calls = 200;
  await ok(rec, 'PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok(rec, 'POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'more calls' });
  state.draft = draft;
});

afterAll(async () => {
  try {
    if (state.prodApi) await prod('DELETE', `/workspaces/default/apis/${state.prodApi}`);
    for (const k of (await otoroshi('GET', '/api/apikeys')) || [])
      if (k.apiRef?.api === state.apiId && k.metadata?.created_by === 'apikey-extractor') await otoroshi('DELETE', `/api/apikeys/${k.clientId}`);
    if (state.apiId) await rec('DELETE', `/workspaces/${WS}/apis/${state.apiId}`);
    await rec('DELETE', `/workspaces/${WS}`);
    await gatewayEnv((env) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== ENV_KEY)));
  } catch (e) {
    console.error('cleanup', e.message);
  }
  production?.kill();
  await production?.exited;
  try {
    await db.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${PROD_DB}'`);
    await db.unsafe(`drop database if exists ${PROD_DB}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  recette?.stop(true);
});

describe('promotion', () => {
  test('the recette exports a snapshot: the document, without what names it there, and its digest', async () => {
    const doc = await ok(rec, 'GET', `/workspaces/${WS}/apis/${state.apiId}/snapshots/2/promotion`);
    expect(doc.kind).toBe('otoroshi-apim.io/SnapshotPromotion');
    expect(doc.source).toMatchObject({ installation: 'recette', workspace: WS, team: { name: 'Weather team' }, snapshot: { number: 2, comment: 'more calls' } });
    expect(doc.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.content.api.id).toBeUndefined();
    expect(doc.content.api.workspace_id).toBeUndefined();
    expect(doc.content.docs.pages.map((p) => p.slug)).toContain('start');
    state.doc = doc;
  });

  test('a document changed after its export is refused', async () => {
    const changed = structuredClone(state.doc);
    changed.content.draft.plans[0].rateLimit.calls = 1000000;
    const r = await prod('POST', '/workspaces/default/promotions', { document: changed, dry_run: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('changed after its export');
  });

  test('the dry run on the production says what would happen, and changes nothing', async () => {
    const plan = await ok(prod, 'POST', '/workspaces/default/promotions', { document: state.doc, dry_run: true });
    expect(plan.dryRun).toBe(true);
    // the same id: the production has no api of that id yet
    expect(plan.api).toMatchObject({ id: state.apiId, slug: 'forecasts', created: true, team: null });
    expect(plan.running).toBeNull();
    const refs = Object.fromEntries(plan.vault_refs.map((r) => [r.ref, r.status]));
    expect(refs[`\${vault://local/${ENV_KEY}/domain}`]).toBe('resolved');
    expect(refs[`\${vault://local/${ENV_KEY}/backend}`]).toBe('resolved');
    expect(refs[`\${vault://local/${ENV_KEY}/region}`]).toBe('missing');
    expect(refs[`\${vault://env/PROMO_REGION_${RUN}}`]).toBe('unverifiable');
    expect(plan.warnings.map((w) => w.code)).toContain('vault_ref_missing');
    expect(plan.gateway.changes.length).toBeGreaterThan(0);
    expect(await ok(prod, 'GET', '/workspaces/default/apis')).toEqual([]);
  });

  test('promoted and deployed: the same snapshot, and the gateway resolves the values of its environment', async () => {
    const r = await ok(prod, 'POST', '/workspaces/default/promotions', { document: state.doc, deploy: true });
    expect(r.promoted).toBe(true);
    expect(r.snapshot.number).toBe(1);
    state.prodApi = r.api.id;
    const snap = await ok(prod, 'GET', `/workspaces/default/apis/${r.api.id}/snapshots/1`);
    expect(snap.origin).toMatchObject({ installation: 'recette', number: 2, digest: state.doc.digest, api_id: state.apiId });
    expect(snap.comment).toBe('promoted from recette #2: more calls');
    // the draft and the documentation of the production are the snapshot's: nothing pending
    expect((await ok(prod, 'GET', `/workspaces/default/apis/${r.api.id}/changes`)).changes).toEqual([]);
    const api = await ok(prod, 'GET', `/workspaces/default/apis/${r.api.id}`);
    expect(api.base_url).toBe(`http://${DOMAIN}:8080`);
    const res = await until(async () => {
      const x = await fetch('http://localhost:8080/today', { headers: { Host: DOMAIN } });
      return x.status === 200 ? x : null;
    });
    expect(res?.status).toBe(200);
  });

  test('promoting it again changes nothing', async () => {
    const r = await ok(prod, 'POST', '/workspaces/default/promotions', { document: state.doc });
    expect(r.promoted).toBe(false);
    expect(r.already.number).toBe(1);
  });

  test('the next one: its diff against what runs, and a draft changed here is not lost silently', async () => {
    state.draft.plans[0].rateLimit.calls = 300;
    await ok(rec, 'PUT', `/workspaces/${WS}/apis/${state.apiId}/draft`, { draft: state.draft });
    await ok(rec, 'POST', `/workspaces/${WS}/apis/${state.apiId}/publish`, { comment: 'even more' });
    const doc = await ok(rec, 'GET', `/workspaces/${WS}/apis/${state.apiId}/snapshots/3/promotion`);
    const plan = await ok(prod, 'POST', '/workspaces/default/promotions', { document: doc, dry_run: true });
    expect(plan.running.number).toBe(1);
    expect(plan.changes.map((c) => c.path).join(' ')).toContain('rateLimit.calls');

    // someone edited the draft of the production
    const prodApi = await ok(prod, 'GET', `/workspaces/default/apis/${state.prodApi}`);
    await ok(prod, 'PUT', `/workspaces/default/apis/${state.prodApi}/draft`, { draft: { ...prodApi.draft, resources: [] } });
    const refused = await prod('POST', '/workspaces/default/promotions', { document: doc });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('draft');
    const r = await ok(prod, 'POST', '/workspaces/default/promotions', { document: doc, replace_draft: true, deploy: true });
    expect(r.snapshot.number).toBe(2);
    expect((await ok(prod, 'GET', `/workspaces/default/apis/${state.prodApi}`)).draft.resources.length).toBe(1);
  });

  test('promoted on, it keeps the trace of where it was first published', async () => {
    const doc = await ok(prod, 'GET', `/workspaces/default/apis/${state.prodApi}/snapshots/deployed/promotion`);
    expect(doc.source.installation).toBe('production');
    expect(doc.source.origin).toMatchObject({ installation: 'recette', number: 3 });
    // the very same document
    const recDoc = await ok(rec, 'GET', `/workspaces/${WS}/apis/${state.apiId}/snapshots/3/promotion`);
    expect(doc.digest).toBe(recDoc.digest);
  });
});
