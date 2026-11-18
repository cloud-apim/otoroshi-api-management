#!/usr/bin/env bun
// Loads the demo data, idempotently (used by `mise run demo`):
//  - examples/petstore.yaml in the default workspace, published and deployed, its default flow
//    pinning a shared policy group
//  - a gitops workspace with a remote catalog serving examples/catalog/apis.yaml, synchronised
//  - the texts of the default portal, in English and French
//  - the Otoroshi data exporter that feeds the ingester
//  - a (fake) Stripe account linked to the default workspace, for its paid plans
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

const URL = (process.env.APIM_URL || 'http://localhost:9000').replace(/\/$/, '');
const TOKEN = process.env.APIM_TOKEN || 'apim-admin-token';
const CATALOG_URL = process.env.APIM_DEMO_CATALOG_URL || 'http://catalog.oto.tools/catalog/apis.yaml';

async function call(method, path, body) {
  const res = await fetch(`${URL}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error || ''} ${data?.details?.errors?.map((e) => e.message).join(', ') || ''}`);
  return data;
}

// a shared policy group with two published versions; petstore pins the first one, so its flow
// shows that a newer version is available
const header = (value) => [{ plugin: 'cp:otoroshi.next.plugins.AdditionalHeadersOut', enabled: true, include: [], exclude: [], config: { headers: { 'X-Company-Policy': value } } }];
let group = (await call('GET', '/workspaces/default/policy-groups')).find((g) => g.name === 'Company security headers');
if (!group) {
  group = await call('POST', '/workspaces/default/policy-groups', { name: 'Company security headers', description: 'what every api sends back', plugins: header('v1') });
  await call('POST', `/workspaces/default/policy-groups/${group.id}/publish`, { comment: 'first version' });
  await call('PUT', `/workspaces/default/policy-groups/${group.id}`, { plugins: header('v2') });
  await call('POST', `/workspaces/default/policy-groups/${group.id}/publish`, { comment: 'policy v2' });
  console.log('default   policy group Company security headers: v1, v2 published');
}

const petstore = YAML.parseAllDocuments(readFileSync(new globalThis.URL('../examples/petstore.yaml', import.meta.url), 'utf8')).map((d) => d.toJSON());
for (const doc of petstore.filter((d) => d.kind === 'Api')) {
  doc.spec.draft.flows.find((f) => f.id === 'default_flow')?.plugins.push({ group: group.id, version: 1 });
}
const applied = await call('POST', '/workspaces/default/apply?publish=true&deploy=true&comment=demo', petstore);
applied.forEach((r) => console.log(`default   api ${r.api.slug} ${r.api.version}: ${r.action}${r.snapshot ? `, snapshot ${r.snapshot}` : ''}${r.deployment ? `, ${r.deployment}` : ''}`));

const workspaces = await call('GET', '/workspaces');
if (!workspaces.some((w) => w.slug === 'gitops')) {
  await call('POST', '/workspaces', { name: 'GitOps', slug: 'gitops' });
  console.log('gitops    workspace created');
}
const catalogs = await call('GET', '/workspaces/gitops/catalogs');
const catalog =
  catalogs.find((c) => c.url === CATALOG_URL) ||
  (await call('POST', '/workspaces/gitops/catalogs', { name: 'platform catalog', kind: 'http', url: CATALOG_URL, mode: 'deploy', interval_seconds: 60 }));
const sync = await call('POST', `/workspaces/gitops/catalogs/${catalog.id}/sync`, {});
if (!sync.ok) console.log(`gitops    catalog sync: ${sync.error || 'see items'}`);
sync.items.forEach((i) => console.log(`gitops    api ${i.slug} ${i.version}: ${i.action}${i.snapshot ? `, snapshot ${i.snapshot}` : ''}${i.deployment ? `, ${i.deployment}` : ''}${i.error ? ` (${i.error})` : ''}`));

// the default portal speaks the two languages of the portal; a text already written is kept
const OLD_TAGLINE = 'Discover, subscribe to and try our APIs.';
const texts = {
  title: { en: 'Default developer portal', fr: 'Portail développeur Default' },
  tagline: { en: 'Discover, subscribe to and test our APIs.', fr: 'Découvrez nos API, abonnez-vous et testez-les.' },
  homeMarkdown: {
    en: '## Welcome\n\nThe APIs of this workspace, documented and ready to be tested. Create an application, subscribe to a plan, and follow your consumption from your applications.',
    fr: '## Bienvenue\n\nLes API de cet espace, documentées et prêtes à être testées. Créez une application, abonnez-vous à un plan, et suivez votre consommation depuis vos applications.',
  },
};
const portal = (await call('GET', '/workspaces/default')).portal || {};
const localized = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : v ? { en: v } : {}).filter(([, t]) => t && t !== OLD_TAGLINE));
const merged = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, { ...v, ...localized(portal[k]) }]));
if (JSON.stringify(merged) !== JSON.stringify(Object.fromEntries(Object.keys(texts).map((k) => [k, portal[k]])))) {
  await call('PUT', '/workspaces/default', { portal: { ...portal, ...merged } });
  console.log('default   portal texts in en and fr');
}

const exporter = await call('POST', '/gateway/exporter', {});
console.log(`gateway   data exporter -> ${exporter.url}`);

// the paid plans of the default workspace are sold through a Stripe account — the fake Stripe of the
// development stack, linked the way an administrator links a real one
const payments = await call('GET', '/workspaces/default/payments');
if (payments.available && !payments.account) {
  const { url } = await call('POST', '/workspaces/default/payments/connect');
  const authorize = await fetch(url, { redirect: 'manual' });
  await fetch(authorize.headers.get('location'), { redirect: 'manual' });
  console.log(`default   payments through a ${payments.provider} Stripe account`);
}
