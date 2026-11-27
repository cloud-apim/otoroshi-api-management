#!/usr/bin/env bun
// Plays the tutorial of the documentation (documentation/docs/tutorial.mdx) in a browser, from a
// clean workspace, and captures each of its steps: a producer exposes an api from the console, a
// consumer finds it on the portal, signs up, subscribes and calls it — self-service, end to end.
// Re-run it whenever the interface changes:
//
//   bun run screenshots:tutorial   (needs the dev stack, the data exporter installed, and a local chromium)
//
// It starts by deleting the workspace `acme` and the consumer of the tutorial, then makes the workspace
// again: the consumer signs up. The values it types are those of the tables of the tutorial; the
// specification it loads is the one the tutorial gives to copy.
// env: APIM_URL (http://localhost:9000), APIM_TOKEN (apim-admin-token), CHROMIUM (/usr/bin/chromium),
//      OUT (documentation/static/img/tutorial)

import puppeteer from 'puppeteer-core';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.APIM_URL || 'http://localhost:9000';
const TOKEN = process.env.APIM_TOKEN || 'apim-admin-token';
const OUT = process.env.OUT || join(import.meta.dir, '..', 'documentation', 'static', 'img', 'tutorial');
const TUTORIAL = join(import.meta.dir, '..', 'documentation', 'docs', 'tutorial.mdx');
const ADMIN = { email: process.env.APIM_ADMIN_EMAIL || 'admin@otoroshi.io', password: process.env.APIM_ADMIN_PASSWORD || 'password' };
const CONSUMER = { name: 'Dana', email: 'dana@example.com', password: 'dana-tutorial-password' };
const WS = 'acme';
const API = { name: 'Shipments', domain: 'shipments.oto.tools', contextPath: '/v1' };
const BACKEND = { host: 'request.otoroshi.io', port: '443' };
const GATEWAY = process.env.GATEWAY_URL || 'http://shipments.oto.tools:8080';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the admin api, for the setup

async function call(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}

async function reset() {
  const workspaces = await call('GET', '/workspaces');
  if ((workspaces.items || workspaces).some((w) => w.slug === WS)) {
    const apis = await call('GET', `/workspaces/${WS}/apis`);
    for (const a of apis.items || apis) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await call('DELETE', `/workspaces/${WS}`);
  }
  const users = await call('GET', `/users?q=${encodeURIComponent(CONSUMER.email)}`);
  for (const u of (users.items || users).filter((u) => u.email === CONSUMER.email)) await call('DELETE', `/users/${u.id}`);
  await call('POST', '/workspaces', { name: 'Acme', slug: WS });
  await call('POST', `/workspaces/${WS}/teams`, { name: 'Logistics' });
}

// ------------------------------------------------------------------ the browser

async function settle(page, ms = 600) {
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
  await sleep(ms);
}

async function go(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
}

let n = 0;
// one capture per step, numbered in the order of the tutorial
async function shot(page, name, { clip } = {}) {
  await settle(page);
  // the toasts of the step before say nothing of this one
  await page.evaluate(() => document.querySelectorAll('.toasts').forEach((t) => (t.style.visibility = 'hidden')));
  const file = `${String(++n).padStart(2, '0')}-${name}.jpg`;
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 88, ...(clip ? { clip } : {}) });
  await page.evaluate(() => document.querySelectorAll('.toasts').forEach((t) => (t.style.visibility = '')));
  console.log(`  ${file}`);
}

// the visible button, link or tab whose text (or aria-label) is the one given, else the first that starts with it
async function click(page, text, selector = 'button, a, [role=tab], tr.clickable') {
  const done = await page.evaluate(
    (text, selector) => {
      const els = [...document.querySelectorAll(selector)].filter((e) => e.offsetParent !== null);
      const label = (e) => e.getAttribute('aria-label') || '';
      const el = els.find((e) => e.innerText.trim() === text || label(e) === text) || els.find((e) => e.innerText.trim().startsWith(text));
      el?.click();
      return !!el;
    },
    text,
    selector
  );
  if (!done) throw new Error(`nothing to click for "${text}"`);
  await settle(page, 400);
}

// the input of the field whose label starts with the one given
async function fill(page, label, value, scope = '') {
  const handle = await page.evaluateHandle(
    (label, scope) => {
      const fields = [...document.querySelectorAll(`${scope} .field, ${scope} .setting`)].filter((f) => f.offsetParent !== null);
      const field = fields.find((f) => (f.querySelector('label, .s-label')?.innerText || '').trim().startsWith(label));
      return field?.querySelector('input, textarea') || null;
    },
    label,
    scope
  );
  const input = handle.asElement();
  if (!input) throw new Error(`no field "${label}"`);
  await input.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await input.type(value, { delay: 10 });
}

const until = (page, fn, timeout = 20000, ...args) => page.waitForFunction(fn, { timeout, polling: 250 }, ...args);

// ------------------------------------------------------------------ the producer, in the console

// the specification the tutorial gives to copy, written to a file
async function specification() {
  const doc = await readFile(TUTORIAL, 'utf8');
  const block = /```yaml title="shipments\.openapi\.yaml"\n([\s\S]*?)\n```/.exec(doc);
  if (!block) throw new Error('no shipments.openapi.yaml block in the tutorial');
  const file = join(await mkdtemp(join(tmpdir(), 'tutorial-')), 'shipments.openapi.yaml');
  await writeFile(file, `${block[1]}\n`);
  return file;
}

// an input found by a selector, emptied and typed again
async function retype(page, selector, value) {
  const input = await page.$(selector);
  if (!input) throw new Error(`no input ${selector}`);
  await input.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await input.type(value, { delay: 10 });
}

async function saveDraft(page) {
  await click(page, 'Save draft');
  await until(page, () => !document.body.innerText.includes('Saving…') && ![...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Save draft' && !b.disabled && b.offsetParent));
}

async function producer(page) {
  await go(page, '/backoffice/');
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'light');
    localStorage.setItem('apim.console.lang', 'en');
  });
  await go(page, '/backoffice/');
  await page.type('input[type=email]', ADMIN.email);
  await page.type('input[type=password]', ADMIN.password);
  await shot(page, 'console-sign-in');
  await click(page, 'Sign in');
  await until(page, () => location.pathname.startsWith('/backoffice/ws/'));

  await go(page, `/backoffice/ws/${WS}/apis`);
  await click(page, 'New API');
  await fill(page, 'Name', API.name, '.modal');
  await fill(page, 'Description', 'Follow the parcels you send', '.modal');
  await fill(page, 'Domain', API.domain, '.modal');
  await fill(page, 'Context path', API.contextPath, '.modal');
  await shot(page, 'console-new-api');
  await click(page, 'Create draft');
  await until(page, () => /\/apis\/api_/.test(location.pathname));
  const apiId = /\/apis\/(api_[^/]+)/.exec(new URL(page.url()).pathname)[1];
  await shot(page, 'console-api-draft');
  const W = `/backoffice/ws/${WS}/apis/${apiId}`;

  // where the calls go: a public service that answers with the request it received
  await go(page, `${W}/backends`);
  await shot(page, 'console-backends');
  await click(page, 'edit');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await retype(page, '.modal input[value="echo"]', BACKEND.host);
  await retype(page, '.modal input[value="8080"]', BACKEND.port);
  await click(page, 'TLS', '.modal label.switch');
  await shot(page, 'console-backend');
  await click(page, 'Apply', '.modal button');

  // its contract: the specification of the tutorial, as a file
  await click(page, 'Documentation', '[role=tab]');
  await click(page, 'OpenAPI', '[role=tab], a, button');
  const input = await page.$('input[type=file]');
  await input.uploadFile(await specification());
  await until(page, () => document.body.innerText.includes('/shipments/{id}'));
  await shot(page, 'console-openapi');
  await saveDraft(page);

  // the plan: who may call, how much, approved at once
  await click(page, 'Design', '[role=tab]');
  await click(page, 'Plans', '[role=tab], a, button');
  await click(page, 'Edit');
  await fill(page, 'Name', 'Free', '.drawer');
  await fill(page, 'Description', 'A thousand calls a day, a key at once.', '.drawer');
  await shot(page, 'console-plan');
  await click(page, 'Limits', '.drawer [role=tab], .drawer button');
  await fill(page, 'Daily', '1000', '.drawer');
  await shot(page, 'console-plan-limits');
  await click(page, 'Catalogue & approval', '.drawer [role=tab], .drawer button');
  await click(page, 'Ask for a usage statement', '.drawer label.switch');
  await shot(page, 'console-plan-approval');
  await click(page, 'Apply to the draft');
  await saveDraft(page);

  // a snapshot, frozen and deployed
  await click(page, 'Publish');
  await page.waitForSelector('.modal', { timeout: 10000 });
  await fill(page, 'Comment', 'First version', '.modal').catch(() => {});
  await shot(page, 'console-publish');
  await click(page, 'Publish and deploy', '.modal button');
  await until(page, () => /runs on the gateway|deployed/i.test(document.body.innerText) && !document.querySelector('.modal'), 60000);
  await click(page, 'Overview', '[role=tab], a, button');
  await settle(page, 1000);
  await shot(page, 'console-deployed');
  return { apiId };
}

// ------------------------------------------------------------------ the consumer, on the portal

async function consumer(page, { apiId }) {
  const P = `/${WS}`;
  await go(page, `${P}/`);
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'light');
    localStorage.setItem('apim.portal.lang', 'en');
  });
  await go(page, `${P}/`);
  await shot(page, 'portal-home');
  await go(page, `${P}/apis`);
  await shot(page, 'portal-catalogue');
  await page.click('.pt-api-card');
  await settle(page);
  await until(page, () => location.pathname.endsWith('/apis/shipments'));
  await shot(page, 'portal-api');
  await go(page, `${P}/apis/shipments/reference`);
  await until(page, () => document.body.innerText.includes('List your shipments'), 30000);
  await settle(page, 1500);
  await shot(page, 'portal-reference');
  await go(page, `${P}/apis/shipments/plans`);
  await shot(page, 'portal-plans');

  // signed out, subscribing asks to sign in — or to sign up
  await click(page, 'Sign in to subscribe');
  await until(page, () => location.pathname.endsWith('/signin'));
  await click(page, 'Create account', 'main a');
  await until(page, () => location.pathname.endsWith('/signup'));
  await page.type('input[autocomplete=name]', CONSUMER.name);
  await page.type('input[type=email]', CONSUMER.email);
  await page.type('input[type=password]', CONSUMER.password);
  await shot(page, 'portal-sign-up');
  await page.evaluate(() => document.querySelector('form button[type=submit]').click());
  // back on the plans, the subscription asked for
  await page.waitForSelector('.modal', { timeout: 20000 });
  await until(page, () => document.querySelector('.modal')?.innerText.includes('Intended usage'));
  await settle(page, 600);
  await fill(page, 'Application name', 'Parcel tracker', '.modal');
  await fill(page, 'Intended usage', 'A page where our customers follow their parcels', '.modal');
  await shot(page, 'portal-subscribe');
  await page.evaluate(() => document.querySelector('.modal button[type=submit]').click());
  await until(page, () => document.body.innerText.includes('You are subscribed!'));
  await shot(page, 'portal-subscribed');
  await click(page, 'Go to the application', '.modal button, .modal a');
  await until(page, () => /\/apps\/.+/.test(location.pathname));
  await shot(page, 'portal-app');

  // the credentials, as the gateway expects them
  const listed = await call('GET', `/workspaces/${WS}/subscriptions?api=${apiId}`);
  const subs = listed.items || listed;
  const sub = await call('GET', `/workspaces/${WS}/subscriptions/${subs[0].id}`);
  const { client_id, client_secret } = sub.credentials[0];
  return { client_id, client_secret, subscriptionId: sub.id };
}

// the calls of the consumer's application, through the gateway, under the rate limit of its plan (10
// a second); a new key is routable within seconds
async function calls({ client_id, client_secret }) {
  const auth = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`;
  const get = (path) => fetch(`${GATEWAY}${API.contextPath}${path}`, { headers: { authorization: auth } });
  await sleep(5000);
  let first;
  for (let i = 0; i < 30 && (first = await get('/shipments?status=in_transit')).status !== 200; i++) await sleep(2000);
  console.log(`  GET /v1/shipments -> ${first.status}`);
  for (let i = 0; i < 30; i++) {
    await get(i % 3 ? `/shipments/shp_${100 + i}` : '/shipments');
    await sleep(250);
  }
  await fetch(`${GATEWAY}${API.contextPath}/shipments`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ recipient: 'Ada', address: '1 rue de la Paix' }) });
  const refused = await fetch(`${GATEWAY}${API.contextPath}/shipments`);
  console.log(`  GET /v1/shipments without credentials -> ${refused.status}`);
}

// the calls, once the gateway exported them and the ingester stored them all: the count holds still
async function ingested() {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 120 && still < 4; i++) {
    const r = await call('GET', `/workspaces/${WS}/analytics/calls?limit=200`);
    const count = (r.items || r).length;
    still = count >= 32 && count === last ? still + 1 : 0;
    last = count;
    await sleep(1000);
  }
  if (still < 4) console.warn('    ! the calls did not all reach the ingester: is the data exporter installed (mise run demo)?');
}

// what each side sees of it: the consumer its usage, the producer its subscriber and its traffic
async function followUp(visitor, producerPage, { apiId }) {
  await ingested();
  await go(visitor, `/${WS}/usage?range=1h`);
  await until(visitor, () => document.body.innerText.includes('Calls'));
  await settle(visitor, 1500);
  await shot(visitor, 'portal-usage');
  const W = `/backoffice/ws/${WS}/apis/${apiId}`;
  await go(producerPage, `${W}/subscriptions`);
  await shot(producerPage, 'console-subscriptions');
  await go(producerPage, `${W}/analytics?range=1h`);
  await settle(producerPage, 1500);
  await shot(producerPage, 'console-analytics');
}

// ------------------------------------------------------------------ the run

await mkdir(OUT, { recursive: true });
await reset();
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => console.warn(`    ! ${e.message}`));
  page.on('dialog', (d) => {
    console.warn(`    ! dialog: ${d.message()}`);
    d.dismiss();
  });
  const made = await producer(page);
  const visitor = await (await browser.createBrowserContext()).newPage();
  await visitor.setViewport({ width: 1440, height: 900 });
  visitor.on('pageerror', (e) => console.warn(`    ! ${e.message}`));
  const creds = await consumer(visitor, made);
  await calls(creds);
  await followUp(visitor, page, made);
} catch (e) {
  // what the pages showed when it failed
  for (const [i, pg] of (await browser.pages()).entries()) await pg.screenshot({ path: join(OUT, `failed-${i}.jpg`), type: 'jpeg' }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
