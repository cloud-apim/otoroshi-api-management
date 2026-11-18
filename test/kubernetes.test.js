// The product's resources on a real Kubernetes api: a k3s cluster in docker. The manifests are
// validated by its api server; the controller reconciles an Api, an Application and a
// Subscription into the product, which deploys them on the gateway, and writes the credentials of
// the subscription to a Secret of the namespace. Changed, the resources change the product;
// deleted, they close and delete what they owned.
//
// Needs docker (the rancher/k3s image) and the docker stack (mise run up). Run alone:
// mise run test:kubernetes

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

setDefaultTimeout(120000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'kubernetes-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const { otoroshi } = await import('../server/otoroshi/client.js');
const { kubeClient } = await import('../server/kube/client.js');
const { createController } = await import('../server/kube/controller.js');

const RUN = Date.now().toString(36);
const K3S = `apim-k3s-${RUN}`;
const WS = `k8s-${RUN}`;
const NS = `weather-${RUN}`;
const DOMAIN = `forecasts-${RUN}.oto.tools`;
const PLAN = `plan_forecasts_${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const DIR = mkdtempSync(join(tmpdir(), 'apim-k3s-'));
const KUBECONFIG = join(DIR, 'kubeconfig.yaml');

let server;
let controller;
const state = {};

function run(cmd, { input, allowFail = false } = {}) {
  const r = Bun.spawnSync(cmd, { stdin: input ? Buffer.from(input) : undefined, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KUBECONFIG } });
  if (r.exitCode !== 0 && !allowFail) throw new Error(`${cmd.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}
const kubectl = (...args) => run(['kubectl', ...args]);
const apply = (doc) => run(['kubectl', 'apply', '-f', '-'], { input: YAML.stringify(doc) });
const getCr = (plural, name) => JSON.parse(kubectl('-n', NS, 'get', `${plural}.otoroshi-apim.io`, name, '-o', 'json'));

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer kubernetes-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function until(fn, timeoutMs = 60000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn().catch((e) => e);
    if (last && !(last instanceof Error)) return last;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out${last instanceof Error ? `: ${last.message}` : ''}`);
}

const reconcile = async () => {
  const out = await controller.reconcileOnce();
  return out;
};

const api = (calls) => ({
  apiVersion: 'otoroshi-apim.io/v1',
  kind: 'Api',
  metadata: { name: 'forecasts', namespace: NS },
  spec: {
    version: '1.0.0',
    name: 'Forecasts',
    team: 'Weather team',
    draft: {
      entrypoint: { domain: DOMAIN, contextPath: '/' },
      backends: [{ id: 'backend_main', name: 'main', targets: [{ hostname: 'echo', port: 8080 }] }],
      flows: [{ id: 'flow_default', name: 'default', plugins: [] }],
      resources: [{ id: 'res_forecasts', name: 'Forecasts', path: '/forecasts', methods: ['GET'], backendId: 'backend_main', flowId: 'flow_default' }],
      plans: [{ id: PLAN, name: 'Free', status: 'published', auth: { kind: 'apikey' }, rateLimit: { enabled: true, calls, windowMs: 60000 }, validation: 'auto' }],
    },
  },
});

beforeAll(async () => {
  server = await start();
  // the product: a workspace and a team
  expect((await call('POST', '/workspaces', { name: `Kubernetes ${RUN}`, slug: WS })).status).toBe(200);
  expect((await call('POST', `/workspaces/${WS}/teams`, { name: 'Weather team' })).status).toBe(200);

  // the cluster
  run(['docker', 'run', '-d', '--name', K3S, '--privileged', '--tmpfs', '/run', '--tmpfs', '/var/run', '-p', '127.0.0.1::6443', 'rancher/k3s:v1.28.5-k3s1', 'server', '--disable=traefik,metrics-server,local-storage,servicelb', '--tls-san=127.0.0.1', '--write-kubeconfig-mode=644']);
  await until(async () => run(['docker', 'exec', K3S, 'kubectl', 'get', '--raw', '/readyz'], { allowFail: true }).trim() === 'ok' || null, 90000);
  const port = run(['docker', 'port', K3S, '6443/tcp']).trim().split(':').pop();
  const kubeconfig = run(['docker', 'exec', K3S, 'cat', '/etc/rancher/k3s/k3s.yaml']).replace('https://127.0.0.1:6443', `https://127.0.0.1:${port}`);
  writeFileSync(KUBECONFIG, kubeconfig);
  kubectl('apply', '-k', 'deploy/kubernetes/crds');
  kubectl('wait', '--for=condition=Established', '--timeout=60s', 'crd/apis.otoroshi-apim.io', 'crd/applications.otoroshi-apim.io', 'crd/subscriptions.otoroshi-apim.io');
  kubectl('create', 'namespace', 'apim');
  kubectl('-n', 'apim', 'apply', '-f', 'deploy/kubernetes/base/serviceaccount.yaml', '-f', 'deploy/kubernetes/base/rbac.yaml');
  // the namespace of the resources names the workspace by its label
  apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS, labels: { 'otoroshi-apim.io/workspace': WS } } });

  // the controller, with the rights of its service account and nothing more
  const token = kubectl('-n', 'apim', 'create', 'token', 'otoroshi-api-management-controller', '--duration=1h').trim();
  const ca = Buffer.from(YAML.parse(kubeconfig).clusters[0].cluster['certificate-authority-data'], 'base64').toString('utf8');
  controller = createController(kubeClient({ url: `https://127.0.0.1:${port}`, token, ca }));
});

afterAll(async () => {
  try {
    run(['docker', 'rm', '-f', K3S], { allowFail: true });
    const apis = (await call('GET', `/workspaces/${WS}/apis`)).body || [];
    for (const a of apis) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    for (const k of (await otoroshi('GET', '/api/apikeys')) || []) if (k.apiRef?.api && apis.some((a) => a.id === k.apiRef.api)) await otoroshi('DELETE', `/api/apikeys/${k.clientId}`);
    await db`delete from applications where workspace_id = (select id from workspaces where slug = ${WS})`;
    await call('DELETE', `/workspaces/${WS}`);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('the manifests', () => {
  test('are accepted by the api server, the product and its controller', () => {
    const out = kubectl('apply', '-k', 'deploy/kubernetes/base', '--dry-run=server');
    for (const what of ['deployment.apps/otoroshi-api-management ', 'deployment.apps/otoroshi-api-management-controller', 'clusterrole.rbac.authorization.k8s.io/otoroshi-api-management-controller', 'service/otoroshi-api-management'])
      expect(out).toContain(what);
  });
});

describe('the controller', () => {
  test('an Api resource becomes an api of the workspace, published and deployed', async () => {
    apply(api(100));
    await reconcile();
    const cr = getCr('apis', 'forecasts');
    expect(cr.metadata.finalizers).toContain('otoroshi-apim.io/cleanup');
    expect(cr.status).toMatchObject({ phase: 'Ready', workspace: WS, snapshot: 1, deployed: 1, observedGeneration: 1 });
    const product = (await call('GET', `/workspaces/${WS}/apis/${cr.status.apiId}`)).body;
    expect(product.managed_by).toBe(`kubernetes:${NS}/apis/forecasts`);
    state.apiId = cr.status.apiId;
    // the console refuses to edit it: the resource is its source
    expect((await call('PUT', `/workspaces/${WS}/apis/${state.apiId}/draft`, { draft: product.draft })).status).toBe(409);
    expect(await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`)).toBeTruthy();
  });

  test('an Application, then a Subscription whose credentials land in a Secret', async () => {
    apply({ apiVersion: 'otoroshi-apim.io/v1', kind: 'Application', metadata: { name: 'dashboard', namespace: NS }, spec: { name: 'Weather dashboard', team: 'Weather team' } });
    apply({ apiVersion: 'otoroshi-apim.io/v1', kind: 'Subscription', metadata: { name: 'dashboard-forecasts', namespace: NS }, spec: { api: 'forecasts', plan: PLAN, application: 'dashboard' } });
    await reconcile();
    const app = getCr('applications', 'dashboard');
    expect(app.status).toMatchObject({ phase: 'Ready', workspace: WS });
    const sub = getCr('subscriptions', 'dashboard-forecasts');
    expect(sub.status).toMatchObject({ phase: 'Active', plan: PLAN, credentialsSecret: 'dashboard-forecasts-credentials' });
    state.subId = sub.status.subscriptionId;
    state.appId = app.status.applicationId;

    const secret = JSON.parse(kubectl('-n', NS, 'get', 'secret', 'dashboard-forecasts-credentials', '-o', 'json'));
    expect(secret.metadata.ownerReferences[0]).toMatchObject({ kind: 'Subscription', name: 'dashboard-forecasts' });
    const read = (k) => Buffer.from(secret.data[k], 'base64').toString('utf8');
    state.creds = { id: read('clientId'), secret: read('clientSecret') };
    expect(read('url')).toBe(`http://${DOMAIN}:8080`);
    const res = await until(async () => {
      const r = await fetch('http://localhost:8080/forecasts', { headers: { Host: DOMAIN, 'Otoroshi-Client-Id': state.creds.id, 'Otoroshi-Client-Secret': state.creds.secret } });
      return r.status === 200 ? r : null;
    });
    expect(res.status).toBe(200);
    // what a resource owns, the console does not change
    expect((await call('PUT', `/workspaces/${WS}/applications/${state.appId}`, { name: 'renamed' })).status).toBe(409);
    expect((await call('POST', `/workspaces/${WS}/subscriptions/${state.subId}/close`, {})).status).toBe(409);
    // a second pass changes nothing, and writes no status
    const before = getCr('subscriptions', 'dashboard-forecasts').metadata.resourceVersion;
    await reconcile();
    expect(getCr('subscriptions', 'dashboard-forecasts').metadata.resourceVersion).toBe(before);
  });

  test('a changed resource is a new snapshot, deployed', async () => {
    apply(api(500));
    await reconcile();
    const cr = getCr('apis', 'forecasts');
    expect(cr.status).toMatchObject({ phase: 'Ready', snapshot: 2, deployed: 2, observedGeneration: 2 });
    const entity = await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`);
    expect(entity.plans.find((p) => p.id === PLAN).rate_limiting.strategy.quota.window).toBe(500);
  });

  test('a namespace that names no workspace of the product says so', async () => {
    apply({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: `nowhere-${RUN}` } });
    apply({ ...api(1), metadata: { name: 'lost', namespace: `nowhere-${RUN}` } });
    await reconcile();
    const cr = JSON.parse(kubectl('-n', `nowhere-${RUN}`, 'get', 'apis.otoroshi-apim.io', 'lost', '-o', 'json'));
    expect(cr.status.phase).toBe('Error');
    expect(cr.status.message).toContain(`the workspace "nowhere-${RUN}" does not exist`);
    kubectl('-n', `nowhere-${RUN}`, 'delete', 'apis.otoroshi-apim.io', 'lost', '--wait=false');
    await reconcile();
  });

  test('deleted, the resources close and delete what they owned', async () => {
    kubectl('-n', NS, 'delete', 'subscriptions.otoroshi-apim.io', 'dashboard-forecasts', '--wait=false');
    await reconcile();
    expect((await db`select status from subscriptions where id = ${state.subId}`)[0].status).toBe('closed');
    expect(run(['kubectl', '-n', NS, 'get', 'subscriptions.otoroshi-apim.io', 'dashboard-forecasts'], { allowFail: true })).toBe('');
    // the secret goes with its owner, collected by the cluster
    await until(async () => !run(['kubectl', '-n', NS, 'get', 'secret', 'dashboard-forecasts-credentials', '--ignore-not-found'], { allowFail: true }).trim() || null);

    kubectl('-n', NS, 'delete', 'applications.otoroshi-apim.io', 'dashboard', '--wait=false');
    kubectl('-n', NS, 'delete', 'apis.otoroshi-apim.io', 'forecasts', '--wait=false');
    await reconcile();
    expect((await db`select id from applications where id = ${state.appId}`).length).toBe(0);
    expect((await db`select id from apis where id = ${state.apiId}`).length).toBe(0);
    await until(async () => ((await otoroshi('GET', `/apis/apis.otoroshi.io/v1/apis/${state.apiId}`)) === null ? true : null));
  });
});
