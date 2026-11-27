// The interface, in a real browser (headless Chromium): every page of the console opens without an
// error, a producer makes an api and a plan from the console, the console speaks French, a consumer
// subscribes from the portal and gets credentials. The admin api is tested elsewhere: here, what the
// person does on the screen, and what it leads to.
//
// Needs the docker stack (mise run up), the built interfaces (bun run build) and a local Chromium
// (CHROMIUM, /usr/bin/chromium by default): skipped without them.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

setDefaultTimeout(120000);

const CHROMIUM = process.env.CHROMIUM || '/usr/bin/chromium';
const DIST = new URL('../dist/backoffice/index.html', import.meta.url).pathname;
const ready = existsSync(CHROMIUM) && existsSync(DIST);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'ui-test-token';
config.publicUrl = `http://localhost:${config.port}`;
config.webhooks.allowPrivate = true;

const RUN = Date.now().toString(36);
const WS = `ui-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const CONSUMER = { email: `reader-${RUN}@example.com`, password: `reader-pass-${RUN}`, name: 'Reader' };
const state = {};
let server;
let browser;

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer ui-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}
const ws = (p) => `/workspaces/${WS}${p}`;

// a page that records what goes wrong: an uncaught error, an answer of the product in 5xx
async function watchedPage(context) {
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500 && r.url().startsWith(ROOT)) page.problems.push(`${r.status()} ${r.request().method()} ${r.url().slice(ROOT.length)}`);
  });
  return page;
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function go(page, path) {
  await page.goto(`${ROOT}${path}`, { waitUntil: 'networkidle0', timeout: 30000 });
  await settle();
}

// the visible button (or link, tab) whose text, or aria-label, is the one given
async function click(page, text, selector = 'button, a, [role=tab]') {
  const done = await page.evaluate(
    (text, selector) => {
      const el = [...document.querySelectorAll(selector)].find((e) => e.offsetParent !== null && (e.innerText.trim() === text || e.getAttribute('aria-label') === text));
      if (el) el.click();
      return !!el;
    },
    text,
    selector
  );
  if (!done) throw new Error(`nothing to click for "${text}"`);
  await settle();
}

// the input of the field whose label is the one given
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
  await input.type(value);
}

const text = (page) => page.evaluate(() => document.body.innerText);

beforeAll(async () => {
  if (!ready) return;
  const { start } = await import('../server/main.js');
  server = await start();
  // a workspace with an api deployed, an application and its subscription, and a consumer
  await call('POST', '/workspaces', { name: `Interface ${RUN}`, slug: WS });
  const team = await call('POST', ws('/teams'), { name: 'Readers' });
  state.teamId = team.id;
  const api = await call('POST', ws('/apis'), { name: 'Library', version: '1.0.0', domain: `ui-${RUN}.oto.tools`, contextPath: '/' });
  state.apiId = api.id;
  await call('POST', ws(`/apis/${api.id}/publish`), { comment: 'interface', deploy: true });
  const app = await call('POST', ws('/applications'), { name: 'Shelf', team_id: team.id });
  state.appId = app.id;
  state.subId = (await call('POST', ws('/subscriptions'), { api_id: api.id, plan_id: api.draft.plans[0].id, application_id: app.id })).id;
  // pages the workspace writes for its portal: one in the navigation, one reached by its link
  await call('PUT', ws(''), {
    portal: {
      pages: [
        { slug: 'terms', title: { en: 'Terms of use', fr: 'Conditions' }, content: { en: '# Terms\n\nBe kind to the library.' }, nav: true },
        { slug: 'contact', title: { en: 'Contact' }, content: { en: 'Write to the librarians.' }, nav: false },
      ],
    },
  });
  // a question of the request form, labelled in two languages
  await call('PUT', ws('/metadata-fields'), {
    fields: [{ scope: 'subscription', key: 'project', label: 'Your project', help: 'what you build', type: 'string', portal: true, translations: { fr: { label: 'Votre projet', help: 'ce que vous construisez' } } }],
  });
  // an announcement, told to nobody: its page
  state.annId = (await call('POST', ws(`/apis/${api.id}/announcements`), { title: 'Shelves moved', body: 'The **shelves** moved.', notify: false })).id;
  // a webhook, off: its page
  state.hookId = (await call('POST', ws('/webhooks'), { name: 'Shelf hook', url: 'http://127.0.0.1:9/hook', enabled: false })).id;
  const consumer = await call('POST', '/users', CONSUMER);
  await call('POST', ws('/members'), { user_id: consumer.id, role: 'consumer' });
  state.consumerId = consumer.id;
  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
});

afterAll(async () => {
  await browser?.close();
  if (!ready) return;
  try {
    for (const id of [state.apiId, state.createdApiId].filter(Boolean)) await call('DELETE', ws(`/apis/${id}`));
    await call('DELETE', `/workspaces/${WS}`);
    if (state.consumerId) await call('DELETE', `/users/${state.consumerId}`).catch(() => null);
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe.skipIf(!ready)('the console', () => {
  test('signing in, then every page opens without an error', async () => {
    const context = await browser.createBrowserContext();
    const page = await watchedPage(context);
    await go(page, '/backoffice/');
    await page.type('input[type=email]', 'admin@otoroshi.io');
    await page.type('input[type=password]', 'password');
    await click(page, 'Sign in');
    await page.waitForFunction(() => location.pathname.startsWith('/backoffice/ws/'), { timeout: 15000 });
    const W = `/backoffice/ws/${WS}`;
    const routes = [
      W,
      `${W}/apis`,
      ...['overview', 'resources', 'backends', 'flows', 'plans', 'documentation', 'openapi', 'asyncapi', 'catalogue', 'subscriptions', 'deployment', 'test', 'analytics', 'settings'].map((t) => `${W}/apis/${state.apiId}/${t}`),
      `${W}/policy-groups`,
      `${W}/dictionaries`,
      `${W}/shared-resources`,
      `${W}/applications`,
      `${W}/applications/${state.appId}`,
      `${W}/subscriptions`,
      `${W}/subscriptions?open=${state.subId}`,
      `${W}/observability`,
      `${W}/observability?view=logs&range=7d&status=4xx`,
      `${W}/observability?view=security`,
      `${W}/audit`,
      `${W}/notifications`,
      `${W}/portal`,
      ...['settings', 'design', 'home', 'pages', 'templates', 'navigation', 'styles', 'assets', 'versions', 'sync'].map((t) => `${W}/portal/${t}`),
      ...['general', 'members', 'teams', 'metadata', 'payments', 'catalogs', 'export'].map((t) => `${W}/settings/${t}`),
      `${W}/settings/webhooks/${state.hookId}`,
      `${W}/settings/teams/${state.teamId}`,
      `${W}/settings/catalogs/new`,
      `${W}/apis/${state.apiId}/announcements/${state.annId}`,
      `${W}/apis/${state.apiId}/announcements/new`,
      `${W}/apis/${state.apiId}/deployment/snapshots/1`,
      ...['status', 'drift', 'connection', 'ingestion', 'setup'].map((t) => `/backoffice/gateway/${t}`),
      ...['workspaces', 'users', 'authentication', 'audit', 'tokens'].map((t) => `/backoffice/settings/${t}`),
      '/backoffice/settings/audit/exporters/new',
    ];
    const failures = [];
    for (const route of routes) {
      page.problems = [];
      await go(page, route);
      const body = await text(page);
      if (body.includes('Page not found')) page.problems.push('page not found');
      if (!(await page.$('.page, main'))) page.problems.push('nothing rendered');
      if (page.problems.length) failures.push(`${route}: ${page.problems.join('; ')}`);
    }
    expect(failures).toEqual([]);
    await context.close();
  });

  test('a producer makes an api and a plan, and saves the draft', async () => {
    const context = await browser.createBrowserContext();
    const page = await watchedPage(context);
    await go(page, '/backoffice/');
    await page.type('input[type=email]', 'admin@otoroshi.io');
    await page.type('input[type=password]', 'password');
    await click(page, 'Sign in');
    await page.waitForFunction(() => location.pathname.startsWith('/backoffice/ws/'), { timeout: 15000 });
    await go(page, `/backoffice/ws/${WS}/apis`);
    await click(page, 'New API');
    await fill(page, 'Name', 'Lighthouse', '.modal');
    await fill(page, 'Domain', `lighthouse-${RUN}.oto.tools`, '.modal');
    await click(page, 'Create draft');
    await page.waitForFunction(() => /\/apis\/api_/.test(location.pathname), { timeout: 15000 });
    state.createdApiId = /\/apis\/(api_[^/]+)/.exec(new URL(page.url()).pathname)[1];
    const created = await call('GET', ws(`/apis/${state.createdApiId}`));
    expect(created.name).toBe('Lighthouse');
    expect(created.draft.entrypoint.domain).toBe(`lighthouse-${RUN}.oto.tools`);
    // a plan of its own, on the draft
    await go(page, `/backoffice/ws/${WS}/apis/${state.createdApiId}/plans`);
    // the tabs of an api on two levels: its group, then its page in the group
    expect(await page.evaluate(() => [...document.querySelectorAll('.tabs [aria-selected=true], .subtabs [aria-selected=true]')].map((t) => t.innerText.replace(/\s*\d+$/, '').trim()))).toEqual(['Design', 'Plans']);
    await click(page, 'Add plan');
    await fill(page, 'Name', 'Gold', '.drawer');
    await click(page, 'Apply to the draft');
    await click(page, 'Save draft');
    await page.waitForFunction(() => !document.body.innerText.includes('Saving…'), { timeout: 15000 });
    await settle(800);
    const saved = await call('GET', ws(`/apis/${state.createdApiId}`));
    expect(saved.draft.plans.map((p) => p.name)).toContain('Gold');
    expect(page.problems).toEqual([]);
    await context.close();
  });

  test('a dictionary created from a local file, its values on the page and on the gateway', async () => {
    const context = await browser.createBrowserContext();
    const page = await watchedPage(context);
    await go(page, '/backoffice/');
    await page.type('input[type=email]', 'admin@otoroshi.io');
    await page.type('input[type=password]', 'password');
    await click(page, 'Sign in');
    await page.waitForFunction(() => location.pathname.startsWith('/backoffice/ws/'), { timeout: 15000 });
    const file = join(mkdtempSync(join(tmpdir(), 'apim-ui-')), 'regions.yaml');
    writeFileSync(file, 'eu: https://eu.backend.internal\nus: https://us.backend.internal\nlimits:\n  eu: 1000\n');
    await go(page, `/backoffice/ws/${WS}/dictionaries`);
    await click(page, 'New dictionary');
    await fill(page, 'Name', 'regions', '.modal');
    const input = await page.$('.modal input[type=file]');
    await input.uploadFile(file);
    await input.evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })));
    await page.waitForFunction(() => document.querySelector('.modal')?.innerText.includes('3 values from regions.yaml'), { timeout: 10000 });
    await click(page, 'Create', '.modal button');
    await page.waitForFunction(() => /\/dictionaries\/dict_/.test(location.pathname), { timeout: 15000 });
    await page.waitForFunction(() => document.body.innerText.includes('limits.eu') && document.body.innerText.includes('on the gateway'), { timeout: 15000 });
    const d = (await call('GET', ws('/dictionaries'))).find((x) => x.name === 'regions');
    expect(d.entries).toEqual({ eu: 'https://eu.backend.internal', us: 'https://us.backend.internal', limits: { eu: 1000 } });
    await call('DELETE', ws(`/dictionaries/${d.id}`));
    expect(page.problems).toEqual([]);
    await context.close();
  });

  test('the console speaks French', async () => {
    const context = await browser.createBrowserContext();
    const page = await watchedPage(context);
    await go(page, '/backoffice/');
    await page.evaluate(() => localStorage.setItem('apim.console.lang', 'fr'));
    await page.type('input[type=email]', 'admin@otoroshi.io');
    await page.type('input[type=password]', 'password');
    await page.evaluate(() => document.querySelector('form button[type=submit]').click());
    await page.waitForFunction(() => location.pathname.startsWith('/backoffice/ws/'), { timeout: 15000 });
    await go(page, `/backoffice/ws/${WS}/subscriptions`);
    const body = await text(page);
    expect(body).toContain('Accueil');
    expect(body).toContain('Souscriptions');
    expect(page.problems).toEqual([]);
    await context.close();
  });
});

describe.skipIf(!ready)('the portal', () => {
  test('the pages a workspace writes: checked, in the navigation, reached by their link', async () => {
    // a slug of its own, a title
    await expect(call('PUT', ws(''), { portal: { pages: [{ slug: 'a', title: { en: 'A' } }, { slug: 'a', title: { en: 'B' } }] } })).rejects.toThrow(/400/);
    await expect(call('PUT', ws(''), { portal: { pages: [{ slug: 'Not A Slug', title: { en: 'A' } }] } })).rejects.toThrow(/400/);
    await expect(call('PUT', ws(''), { portal: { pages: [{ slug: 'untitled', title: {} }] } })).rejects.toThrow(/400/);
    const context = await browser.createBrowserContext();
    const page = await watchedPage(context);
    await go(page, `/${WS}/`);
    await click(page, 'Terms of use', 'nav a');
    await page.waitForFunction((ws) => location.pathname === `/${ws}/pages/terms`, { timeout: 10000 }, WS);
    await settle();
    expect(await text(page)).toContain('Be kind to the library.');
    // not in the navigation, still at its link
    expect(await page.evaluate(() => [...document.querySelectorAll('nav a')].map((a) => a.innerText.trim()))).not.toContain('Contact');
    await go(page, `/${WS}/pages/contact`);
    expect(await text(page)).toContain('Write to the librarians.');
    await go(page, `/${WS}/pages/nowhere`);
    expect(await text(page)).toContain('404');
    expect(page.problems).toEqual([]);
    await context.close();
  });

  test('a consumer subscribes from the portal, and gets its credentials', async () => {
    const context = await browser.createBrowserContext();
    const page = await watchedPage(context);
    await go(page, `/${WS}/`);
    // signed in as the consumer
    const login = await page.evaluate(
      async (ws, c) => (await fetch(`/${ws}/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: c.email, password: c.password }) })).status,
      WS,
      CONSUMER
    );
    expect(login).toBe(200);
    await go(page, `/${WS}/apis/${state.apiId}/plans`);
    await click(page, 'Subscribe');
    await page.waitForSelector('.modal', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.modal')?.innerText.includes('Your project'), { timeout: 10000 });
    await fill(page, 'Your project', 'a reading list', '.modal');
    await fill(page, 'Application name', 'My reading list', '.modal');
    await page.evaluate(() => document.querySelector('.modal button[type=submit]').click());
    await page.waitForFunction(() => document.body.innerText.includes('You are subscribed!'), { timeout: 20000 });
    // what the screen said is what happened
    const subs = (await call('GET', ws(`/subscriptions?api=${state.apiId}`))).filter((s) => s.application_name === 'My reading list');
    expect(subs.length).toBe(1);
    expect(subs[0].status).toBe('active');
    const detail = await call('GET', ws(`/subscriptions/${subs[0].id}`));
    expect(await text(page)).toContain(detail.credentials[0].client_id);
    expect(detail.metadata).toEqual({ project: 'a reading list' });
    // the api has no specification: the composer of the portal tries it, with these credentials
    await go(page, `/${WS}/apis/${state.apiId}/try`);
    expect(await page.evaluate(() => [...document.querySelectorAll('select option')].map((o) => o.innerText))).toContain('My reading list — Default');
    await click(page, 'Send');
    await page.waitForFunction(() => document.querySelector('.badge')?.innerText.match(/^\d{3}$/), { timeout: 30000 });
    // a key is routable a few seconds after it is minted
    for (let i = 0; i < 20 && !(await page.evaluate(() => [...document.querySelectorAll('.badge')].some((b) => b.innerText === '200'))); i++) {
      await settle(1000);
      await click(page, 'Send');
    }
    expect(await page.evaluate(() => [...document.querySelectorAll('.badge')].map((b) => b.innerText))).toContain('200');
    // subscribed, the consumer reviews the api: four stars and a word, on its card in the catalogue
    await go(page, `/${WS}/apis/${state.apiId}/reviews`);
    await page.waitForSelector('.stars-input', { timeout: 10000 });
    await click(page, '4 out of 5', '.stars-input button');
    await fill(page, 'Comment (optional)', 'clear and quick');
    await click(page, 'Publish my review');
    await page.waitForFunction(() => document.body.innerText.includes('clear and quick') && document.body.innerText.includes('1 review'), { timeout: 10000 });
    await go(page, `/${WS}/apis`);
    expect(await page.evaluate(() => document.querySelector('.pt-api-card .stars')?.getAttribute('aria-label'))).toBe('4 out of 5');
    // its consumption: the analytics of its applications, then their request log, without an error
    await go(page, `/${WS}/usage?range=1h`);
    await page.waitForFunction(() => document.body.innerText.includes('Calls'), { timeout: 10000 });
    await click(page, 'Logs');
    await page.waitForFunction(() => document.body.innerText.includes('Request log') && location.search.includes('view=logs'), { timeout: 10000 });
    expect(await page.evaluate(() => [...document.querySelectorAll('a')].some((a) => a.innerText.includes('Export as CSV') && a.href.includes('/front/api/analytics/calls/export?')))).toBe(true);
    // in French, the question is asked in French
    await page.evaluate(() => localStorage.setItem('apim.portal.lang', 'fr'));
    await go(page, `/${WS}/apis/${state.apiId}/plans`);
    await click(page, 'Souscrire');
    await page.waitForFunction(() => document.querySelector('.modal')?.innerText.includes('Votre projet'), { timeout: 10000 });
    expect(await page.evaluate(() => document.querySelector('.modal').innerText)).toContain('ce que vous construisez');
    expect(page.problems).toEqual([]);
    await context.close();
  });
});
