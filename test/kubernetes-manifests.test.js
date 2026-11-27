// The deployment artefacts, without a cluster: the custom resources are the same for kustomize
// and the Helm chart, the variables the manifests set are those the product reads, and a resource
// Api is the declarative document it carries.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { documentOf, markerOf } from '../server/kube/controller.js';

const ROOT = join(import.meta.dir, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const KUSTOMIZE = 'deploy/kubernetes';
const CHART = 'deploy/helm/otoroshi-api-management';

describe('the custom resources', () => {
  test('the chart carries the very CRDs of the manifests', () => {
    const files = readdirSync(join(ROOT, KUSTOMIZE, 'crds')).filter((f) => f.endsWith('.yaml') && f !== 'kustomization.yaml');
    expect(files.sort()).toEqual(['apis.yaml', 'applications.yaml', 'subscriptions.yaml']);
    for (const f of files) expect(read(`${CHART}/crds/${f}`)).toBe(read(`${KUSTOMIZE}/crds/${f}`));
  });

  test('one group, a status subresource each, and the plural the controller lists', () => {
    for (const [file, plural, kind] of [
      ['apis.yaml', 'apis', 'Api'],
      ['applications.yaml', 'applications', 'Application'],
      ['subscriptions.yaml', 'subscriptions', 'Subscription'],
    ]) {
      const crd = YAML.parse(read(`${KUSTOMIZE}/crds/${file}`));
      expect(crd.metadata.name).toBe(`${plural}.otoroshi-apim.io`);
      expect(crd.spec.names).toMatchObject({ plural, kind });
      expect(crd.spec.versions[0]).toMatchObject({ name: 'v1', served: true, storage: true, subresources: { status: {} } });
    }
  });
});

describe('the configuration', () => {
  const read_ = new Set([...read('server/config.js').matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]));
  const set = (text) => [...text.matchAll(/\b((?:APIM|OTOROSHI)_[A-Z_]+)\b/g)].map((m) => m[1]);

  test('every variable the manifests set is one the product reads', () => {
    const manifests = ['base/configmap.yaml', 'base/apim.yaml', 'base/controller.yaml'].map((f) => read(`${KUSTOMIZE}/${f}`)).join('\n');
    const chart = ['templates/configmap.yaml', 'templates/deployment.yaml', 'templates/controller.yaml', 'templates/_helpers.tpl'].map((f) => read(`${CHART}/${f}`)).join('\n');
    for (const v of new Set([...set(manifests), ...set(chart)])) expect([v, read_.has(v)]).toEqual([v, true]);
  });
});

describe('a resource Api', () => {
  const cr = { metadata: { name: 'forecasts', namespace: 'weather' }, spec: { version: '2.0.0', name: 'Forecasts', team: 'Weather team', draft: { plans: [] } } };

  test('is the declarative document it carries', () => {
    expect(documentOf(cr)).toEqual({
      apiVersion: 'otoroshi-apim.io/v1',
      kind: 'Api',
      metadata: { name: 'forecasts' },
      spec: { version: '2.0.0', name: 'Forecasts', team: 'Weather team', draft: { plans: [] } },
    });
    // the slug may differ from the name of the resource; the version defaults as in a document
    const other = documentOf({ ...cr, spec: { slug: 'weather-forecasts' } });
    expect([other.metadata, other.spec.version]).toEqual([{ name: 'weather-forecasts' }, '1.0.0']);
  });

  test('marks what it owns with its namespace, its kind and its name', () => {
    expect(markerOf('apis', cr)).toBe('kubernetes:weather/apis/forecasts');
  });
});

describe('the pods', () => {
  const uid = Number(read('Dockerfile').match(/--uid (\d+)/)[1]);
  const base = ['base/apim.yaml', 'base/controller.yaml'].map((f) => YAML.parseAllDocuments(read(`${KUSTOMIZE}/${f}`)).map((d) => d.toJSON()).find((d) => d.kind === 'Deployment'));

  test("run as the user of the image, whose home is the working directory", () => {
    expect(uid).toBe(10001);
    for (const d of base) expect(d.spec.template.spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: uid, runAsGroup: uid });
    expect(YAML.parse(read(`${CHART}/values.yaml`)).podSecurityContext).toMatchObject({ runAsNonRoot: true, runAsUser: uid, runAsGroup: uid });
  });

  test('get no variables of the services of their namespace: a service named apim would set APIM_PORT', () => {
    for (const d of base) expect(d.spec.template.spec.enableServiceLinks).toBe(false);
    for (const f of ['templates/deployment.yaml', 'templates/controller.yaml']) expect(read(`${CHART}/${f}`)).toContain('enableServiceLinks: false');
  });
});

describe('the documentation of the chart', () => {
  // a Kubernetes structure is documented as a whole; every other value, one by one
  const WHOLE = new Set(['resources', 'controller.resources', 'podSecurityContext', 'securityContext', 'nodeSelector', 'tolerations', 'affinity', 'ingress.hosts', 'ingress.tls', 'ingress.annotations', 'config.extraEnv', 'secrets.extraEnv']);
  const paths = (o, prefix = '') =>
    Object.entries(o).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && !WHOLE.has(p) ? paths(v, p) : [p];
    });

  test('describes every value of the chart', () => {
    const page = read('documentation/docs/install-kubernetes.mdx');
    const values = paths(YAML.parse(read(`${CHART}/values.yaml`)));
    expect(values.length).toBeGreaterThan(40);
    expect(values.filter((p) => !page.includes(`\`${p}\``))).toEqual([]);
  });
});
