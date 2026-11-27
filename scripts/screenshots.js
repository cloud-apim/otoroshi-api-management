#!/usr/bin/env bun
// Captures every screen of the console and of the portal, for the documentation's screens tour.
// Re-run it whenever the ui changes:
//
//   bun run screenshots            (needs the dev stack with demo data, and a local chromium)
//
// env: APIM_URL (http://localhost:9000), CHROMIUM (/usr/bin/chromium), OUT (documentation/static/img/screens)
//      APIM_ADMIN_EMAIL / APIM_ADMIN_PASSWORD, APIM_PORTAL_EMAIL / APIM_PORTAL_PASSWORD

import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.APIM_URL || 'http://localhost:9000';
const OUT = process.env.OUT || join(import.meta.dir, '..', 'documentation', 'static', 'img', 'screens');
const ADMIN = { email: process.env.APIM_ADMIN_EMAIL || 'admin@otoroshi.io', password: process.env.APIM_ADMIN_PASSWORD || 'password' };
const CONSUMER = { email: process.env.APIM_PORTAL_EMAIL || 'carol@shop.test', password: process.env.APIM_PORTAL_PASSWORD || 'carol-password' };
const WS = 'default';

const shots = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(page, ms = 700) {
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
  await sleep(ms);
}

// file names are stable, so the documentation pages can show a screen; the order of the tour is
// the order of capture, kept in index.json
async function shot(page, name, title, { full = true } = {}) {
  await settle(page);
  const file = `${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: full });
  shots.push({ file, title });
  console.log(`  ${file} — ${title}`);
}

async function go(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
}

// clicks the first visible element whose text (or aria-label) matches
async function click(page, text, { selector = 'button, a, [role=tab], summary, tr.clickable' } = {}) {
  const done = await page.evaluate(
    (text, selector) => {
      const els = [...document.querySelectorAll(selector)].filter((e) => e.offsetParent !== null);
      const label = (e) => e.getAttribute('aria-label') || '';
      const el =
        els.find((e) => label(e) === text || e.innerText.trim() === text) ||
        els.find((e) => e.innerText.trim().startsWith(text) || (text && label(e).startsWith(text)));
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    selector
  );
  if (!done) console.warn(`    ! nothing to click for "${text}"`);
  await settle(page, 500);
  return done;
}

// clicks the n-th visible element matching a selector (and a text, when given)
async function clickNth(page, selector, n, text = null) {
  const done = await page.evaluate(
    (selector, n, text) => {
      const els = [...document.querySelectorAll(selector)].filter((e) => e.offsetParent !== null && (text === null || e.innerText.trim() === text));
      if (!els[n]) return false;
      els[n].click();
      return true;
    },
    selector,
    n,
    text
  );
  if (!done) console.warn(`    ! nothing to click for ${selector} #${n}`);
  await settle(page, 500);
  return done;
}

// waits for the code editors (Monaco, loaded on first use) to be rendered
async function editors(page) {
  await page.waitForSelector('.code-editor .monaco-editor .view-lines', { timeout: 15000 }).catch(() => console.warn('    ! no code editor rendered'));
  await settle(page, 600);
}

async function scrollTo(page, text) {
  await page.evaluate((text) => {
    const el = [...document.querySelectorAll('label, .bold, h3')].find((e) => e.innerText.trim() === text);
    el?.scrollIntoView({ block: 'center' });
  }, text);
  await settle(page, 300);
}

async function api(page, path, method = 'GET', body) {
  return page.evaluate(
    async (path, method, body) => {
      const r = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return r.json();
    },
    path,
    method,
    body
  );
}

async function theme(page, value) {
  await page.evaluate((v) => localStorage.setItem('apim.theme', v), value);
}

async function consoleTour(page) {
  const W = `/backoffice/ws/${WS}`;
  await go(page, '/backoffice/');
  await theme(page, 'light');
  // the tour is in English, whatever the language of the browser that takes it
  await page.evaluate(() => localStorage.setItem('apim.console.lang', 'en'));
  await api(page, '/backoffice/api/auth/logout', 'POST', {});
  await go(page, '/backoffice/');
  await shot(page, 'console-login', 'Console — sign in (local accounts and the OIDC provider)', { full: false });
  await api(page, '/backoffice/api/auth/login', 'POST', ADMIN);

  const books = await api(page, `/backoffice/api/workspaces/${WS}/apis/books`);
  const subs = await api(page, `/backoffice/api/workspaces/${WS}/subscriptions`);
  const bookSub = subs.find((s) => s.api_slug === 'books' && s.status === 'active') || subs[0];
  const pendingSub = subs.find((s) => s.status === 'pending');
  const apps = await api(page, `/backoffice/api/workspaces/${WS}/applications`);
  const app = apps.find((a) => a.name === 'Carol shop') || apps[0];
  const groups = await api(page, `/backoffice/api/workspaces/${WS}/policy-groups`);

  await go(page, W);
  await shot(page, 'console-home', 'Home — what needs attention, traffic, recent activity');
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  await sleep(300);
  await page.keyboard.type('book', { delay: 40 });
  await shot(page, 'console-search', 'Search (⌘K) — workspaces, pages and objects', { full: false });
  await page.keyboard.press('Escape');
  await click(page, 'switch workspace');
  await shot(page, 'console-workspace-selector', 'The workspace selector opens the sidebar', { full: false });
  await page.keyboard.press('Escape');
  await go(page, W);
  await click(page, 'user menu', { selector: 'button[aria-haspopup=menu]' });
  await shot(page, 'console-user-menu', 'The menu of the person signed in — notifications (with their indicator), theme, tokens, sign out', { full: false });
  await page.keyboard.press('Escape');
  await page.mouse.click(900, 450);
  await go(page, `${W}/notifications?filter=all`);
  await shot(page, 'console-notifications', 'Notifications — read and marked done by each person, even those addressed to a team');

  await go(page, `${W}/apis`);
  await shot(page, 'console-apis', 'APIs — lifecycle, deployment state, plans and subscriptions');
  await click(page, 'New API');
  await shot(page, 'console-new-api', 'New API — created as a draft, end to end', { full: false });
  await go(page, `${W}/apis`);
  await click(page, 'Adopt from gateway');
  await shot(page, 'console-adopt', 'Adopt mode — take over an Api that already runs on the gateway', { full: false });
  // promotion: the deployed snapshot of Petstore, taken by another workspace as by the next
  // installation — the dry run only
  const promotion = await api(page, `/backoffice/api/workspaces/${WS}/apis/petstore/snapshots/deployed/promotion`);
  const promotionFile = join(OUT, '..', 'petstore-promotion.json');
  await writeFile(promotionFile, JSON.stringify(promotion));
  await go(page, '/backoffice/ws/gitops/apis');
  await click(page, 'Promote a snapshot');
  await (await page.$('.modal input[type=file]')).uploadFile(promotionFile);
  await sleep(1500);
  await shot(page, 'console-promote', 'Promotion — the same snapshot on the next installation, after its dry run', { full: false });
  await (await import('node:fs/promises')).unlink(promotionFile);

  const A = `${W}/apis/${books.id}`;
  await go(page, A);
  await shot(page, 'console-api-overview', 'API — how to call it, plans, effective resolution order');
  await go(page, `${A}/resources`);
  await shot(page, 'console-api-resources', 'API — entrypoint and resources (projected as routes)');
  await click(page, 'edit');
  await shot(page, 'console-api-resource-edit', 'API — editing a resource', { full: false });
  await go(page, `${A}/backends`);
  await shot(page, 'console-api-backends', 'API — backends (infrastructure, never the offer)');
  await click(page, 'edit');
  await shot(page, 'console-api-backend-edit', 'API — editing a backend', { full: false });
  await go(page, `${W}/apis/petstore/flows`);
  await shot(page, 'console-api-flows', 'API — policy flows: Otoroshi plugins in order, a shared policy group pinned to a version, a flow for one plan');
  await page.setViewport({ width: 1440, height: 1080 });
  await clickNth(page, '[aria-label=edit]', 1);
  await shot(page, 'console-api-plugin-edit', 'Editing a plugin of a flow — a form generated from the description the gateway gives of the plugin', { full: false });
  await clickNth(page, '.seg button', 0, 'JSON');
  await editors(page);
  await shot(page, 'console-api-plugin-json', 'Editing a plugin — the same configuration as JSON, in a code editor', { full: false });
  await click(page, 'Cancel');
  await click(page, 'Add plugin');
  await page.type('[aria-label="search plugins"]', 'compression');
  await click(page, 'Brotli compression', { selector: '.palette-item' });
  await shot(page, 'console-api-plugin-add', "Adding a plugin — the gateway's catalog, and the plugin chosen with its default configuration", { full: false });
  await click(page, 'Cancel');
  await click(page, 'Add plugin');
  await page.type('[aria-label="search plugins"]', 'apikeys');
  await click(page, 'Apikeys', { selector: '.palette-item' });
  await click(page, 'Extractors', { selector: 'button' });
  await shot(page, 'console-api-plugin-form', 'A generated form — nested groups, switches, lists, as the gateway describes the plugin', { full: false });
  await click(page, 'Cancel');
  await page.setViewport({ width: 1440, height: 900 });
  await go(page, `${W}/apis/petstore/plans`);
  await clickNth(page, 'button', 1, 'Edit');
  await scrollTo(page, 'Plan plugins');
  await shot(page, 'console-plan-flow', 'Plan editor — the flow a plan adds on top of the route, for its consumers only', { full: false });

  await go(page, `${A}/plans`);
  await shot(page, 'console-api-plans', 'API — plans: the policy lives here');
  await click(page, 'Edit');
  await shot(page, 'console-plan-general', 'Plan editor — general', { full: false });
  for (const [tab, name, title] of [
    ['Access', 'console-plan-access', 'Plan editor — access: auth mechanism, selection'],
    ['Limits', 'console-plan-limits', 'Plan editor — limits: rate, quotas, resources, failure strategies'],
    ['Threat protection', 'console-plan-threats', 'Plan editor — threat protection: the Threat Protection Suite on the calls of the plan, its policies referenced'],
    ['Catalogue & approval', 'console-plan-catalogue', 'Plan editor — catalogue and approval: never projected'],
    ['Pricing', 'console-plan-pricing', 'Plan editor — pricing'],
  ]) {
    await click(page, tab, { selector: '[role=tab]' });
    await shot(page, name, title, { full: false });
  }
  // the gateway objects a plan derives, shown on the editor without saving: the trusted CA of an
  // mtls plan, the authorization server of an oauth2-remote plan
  await click(page, 'Access', { selector: '[role=tab]' });
  await page.select('.drawer .setting select', 'mtls');
  await click(page, 'Trust a CA');
  await page.waitForSelector('.modal .code-editor .monaco-editor .view-lines', { timeout: 15000 }).catch(() => console.warn('    ! no code editor rendered'));
  // pasted, as a person does: Monaco reads the clipboard of the focused edit context
  await page.click('.modal .code-editor .monaco-editor .view-lines');
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, readFileSync(join(import.meta.dir, '..', 'test', 'fixtures', 'atlas-partner-ca.pem'), 'utf8').trim());
  await settle(page, 900);
  await shot(page, 'console-plan-trust-ca', 'Trusting a CA in an mtls plan — read by the product, with the DN Otoroshi will compare', { full: false });
  await click(page, 'Trust it');
  await shot(page, 'console-plan-mtls', 'An mtls plan — its trusted CAs, derived as certificates of the gateway', { full: false });
  await page.select('.drawer .setting select', 'oauth2-remote');
  await clickNth(page, '.drawer .seg button', 0, 'Describe it');
  await page.type('.drawer input[placeholder="https://idp.example/realms/partners"]', 'http://oidc.oto.tools:8090/default');
  await click(page, 'Discover');
  await shot(page, 'console-plan-oauth2-remote', 'An oauth2-remote plan — the authorization server described, its auth module derived', { full: false });

  await go(page, `${A}/documentation`);
  await editors(page);
  await shot(page, 'console-api-docs', 'API — multilingual documentation pages, in Markdown in a code editor');
  await go(page, `${A}/openapi`);
  await editors(page);
  await shot(page, 'console-api-openapi', 'API — OpenAPI specification, in a code editor', { full: false });
  const orders = await api(page, `/backoffice/api/workspaces/${WS}/apis/orders-events`);
  if (orders?.id) {
    await go(page, `${W}/apis/${orders.id}/asyncapi`);
    await editors(page);
    await shot(page, 'console-api-asyncapi', 'API — AsyncAPI specification of an event-driven api, and its channels', { full: false });
  }
  await go(page, `${A}/catalogue`);
  await shot(page, 'console-api-catalogue', 'API — its place in the catalogue of the portal (categories, featured), and the reviews of its consumers');
  await go(page, `${A}/announcements`);
  await shot(page, 'console-api-announcements', 'API — its announcements, like a blog on its page in the portal, its subscribers told');
  const announced = await api(page, `/backoffice/api/workspaces/${WS}/apis/${books.id}/announcements`);
  // the one of the demo, whatever else was published by hand since
  const announcement = announced?.find((n) => n.title.startsWith('Search by author')) || announced?.at(-1);
  if (announcement) {
    await go(page, `${A}/announcements/${announcement.id}`);
    await click(page, 'Edit');
    await editors(page);
    await shot(page, 'console-api-announcement', 'API — an announcement on its page, written in Markdown — Edit, Preview —', { full: false });
  }
  await go(page, `${A}/subscriptions`);
  await shot(page, 'console-api-subscriptions', 'API — its subscriptions');
  if (bookSub) {
    await go(page, `${A}/subscriptions?open=${bookSub.id}`);
    await shot(page, 'console-subscription-drawer', 'Subscription — request, credentials, lifecycle, transfer', { full: false });
  }
  await go(page, `${A}/deployment`);
  await shot(page, 'console-api-deployment', 'API — deployed state, gateway drift, snapshots (rollback), history');
  await click(page, 'View');
  await editors(page);
  await shot(page, 'console-snapshot', 'A snapshot on its page — immutable, read only, exported, deployed or rolled back to', { full: false });
  await go(page, A);
  await click(page, 'Deploy');
  await shot(page, 'console-deploy-dry-run', 'Deploy — the diff is always shown first', { full: false });

  // a harmless pending change, to show the publication dialog, then reverted
  const original = books.description;
  await api(page, `/backoffice/api/workspaces/${WS}/apis/${books.id}`, 'PUT', { description: `${original} — reference API` });
  await go(page, A);
  await shot(page, 'console-api-out-of-sync', 'The gap between the draft and what runs is always shown', { full: false });
  await click(page, 'Publish');
  await shot(page, 'console-publish', 'Publish — changes since the last snapshot, validation', { full: false });
  await api(page, `/backoffice/api/workspaces/${WS}/apis/${books.id}`, 'PUT', { description: original });

  await go(page, `${A}/test`);
  await click(page, 'Send');
  await sleep(800);
  await editors(page);
  await shot(page, 'console-api-test', 'Test — a request tried through the gateway, with the credentials of a subscription and the trace of the policies');
  await go(page, `${A}/analytics?range=7d`);
  await page.setViewport({ width: 1440, height: 1500 });
  await shot(page, 'console-api-analytics', 'API — analytics, in the catalogue vocabulary', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await go(page, `${A}/settings`);
  await click(page, 'Technical details', { selector: 'summary' });
  await shot(page, 'console-api-settings', 'API — settings, versions, technical details (the escape hatch), danger zone');

  await go(page, `${W}/policy-groups`);
  await shot(page, 'console-policy-groups', 'Shared policy groups');
  if (groups[0]) {
    await go(page, `${W}/policy-groups/${groups[0].id}`);
    await shot(page, 'console-policy-group', 'A policy group — draft, versions, the apis that use it and lag behind');
  }
  await go(page, `${W}/shared-resources`);
  await shot(page, 'console-shared-resources', 'Shared resources — an authorization server described once, pinned by the plans');
  const resources = await api(page, `/backoffice/api/workspaces/${WS}/shared-resources`);
  if (resources[0]) {
    await go(page, `${W}/shared-resources/${resources[0].id}`);
    await shot(page, 'console-shared-resource', 'A shared resource — its draft, its versions, the plans that pin it');
  }
  await go(page, `${W}/dictionaries`);
  await shot(page, 'console-dictionaries', 'Dictionaries — named values given to the expression language of the gateway');
  const dicts = await api(page, `/backoffice/api/workspaces/${WS}/dictionaries`);
  if (dicts[0]) {
    await go(page, `${W}/dictionaries/${dicts[0].id}`);
    await editors(page);
    await shot(page, 'console-dictionary', 'A dictionary — its values, and the expression that reads each of them');
  }

  await go(page, `${W}/applications`);
  await shot(page, 'console-applications', 'Applications');
  if (app) {
    await go(page, `${W}/applications/${app.id}`);
    await shot(page, 'console-application', 'An application and its subscriptions');
    await click(page, 'Identity', { selector: 'button' });
    await shot(page, 'console-application-identity', 'An application — expected client_id, one API key for every API, certificates, metadata');
  }
  await go(page, `${W}/subscriptions?status=pending`);
  await shot(page, 'console-subscriptions', 'Subscriptions waiting for review');
  if (pendingSub) {
    await go(page, `${W}/subscriptions?status=pending&open=${pendingSub.id}`);
    await shot(page, 'console-review', 'Reviewing a request: usage statement, request form, terms', { full: false });
  }
  await go(page, `${W}/messages?status=all`);
  await shot(page, 'console-messages', 'Messages — the conversations of the people of the portal, routed to the team that answers');
  const convs = await api(page, `/backoffice/api/workspaces/${WS}/conversations`);
  if (convs?.items?.[0]) {
    await go(page, `${W}/messages/${convs.items[0].id}`);
    await shot(page, 'console-conversation', 'A conversation — its messages, an answer, closed or reopened');
  }
  await go(page, `${W}/observability?range=7d`);
  await page.setViewport({ width: 1440, height: 1500 });
  await shot(page, 'console-observability', 'Observability — the figures, responses and latency over time, hits by application and api', { full: false });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
  await settle(page, 400);
  await shot(page, 'console-observability-tops', 'Observability — the tops: failed and slow apis, applications, plans, hosts, paths', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await go(page, `${W}/observability?view=logs&range=24h`);
  await shot(page, 'console-logs', 'Observability — the request log, filtered like the dashboards, exported as CSV', { full: false });
  await click(page, '', { selector: 'tr.clickable' });
  await shot(page, 'console-log-call', 'A call of the request log — where its time went', { full: false });
  await page.keyboard.press('Escape');
  await go(page, `${W}/observability?view=security&range=14d`);
  await shot(page, 'console-security', 'Observability — the security events of the Threat Protection Suite, by category, action and plan', { full: false });
  await go(page, `${W}/audit`);
  await shot(page, 'console-audit', 'Audit — writes, and reads of credentials and request logs', { full: false });
  await click(page, '', { selector: 'tr.clickable' });
  await editors(page);
  await shot(page, 'console-audit-event', 'An audit event, read-only', { full: false });

  for (const [tab, name, title] of [
    ['general', 'console-ws-general', 'Workspace settings — general'],
    ['members', 'console-ws-members', 'Workspace settings — members and roles'],
    ['teams', 'console-ws-teams', 'Workspace settings — teams'],
    ['metadata', 'console-ws-metadata', 'Workspace settings — typed metadata fields'],
    ['payments', 'console-ws-payments', 'Workspace settings — payments: the Stripe account the paid plans are sold with, and what Stripe said'],
    ['email', 'console-ws-email', 'Workspace settings — email: the notifications sent by email, to the people of the portal and to the producers, kind by kind'],
    ['webhooks', 'console-ws-webhooks', 'Workspace settings — webhooks: the events of the workspace sent to endpoints, signed, retried'],
    ['export', 'console-ws-export', 'Workspace settings — export and import'],
  ]) {
    await go(page, `${W}/settings/${tab}`);
    if (tab === 'export') await editors(page);
    await shot(page, name, title);
  }
  const teams = await api(page, `/backoffice/api/workspaces/${WS}/teams`);
  const platform = teams?.find((t) => !t.personal) || teams?.[0];
  if (platform) {
    await go(page, `${W}/settings/teams/${platform.id}`);
    await shot(page, 'console-ws-team', 'A team — its members, owners or members, and the APIs and applications it owns');
  }
  const hooks = await api(page, `/backoffice/api/workspaces/${WS}/webhooks`);
  if (hooks?.[0]) {
    await go(page, `${W}/settings/webhooks/${hooks[0].id}`);
    await shot(page, 'console-ws-webhook', 'A webhook — its page: its secret, a test, its deliveries, replayed one by one or since a date');
  }
  // the page of a developer portal: the showcase workspace, its portal themed, its next design
  // written as templates in the draft
  const D = '/backoffice/ws/showcase/portal';
  for (const [section, name, title, edit] of [
    ['', 'console-portal-overview', 'Developer portal — the published design, the changes of the draft, publish and preview'],
    ['settings', 'console-portal-settings', 'Developer portal — its settings: languages, signup, identity provider, categories'],
    ['design', 'console-portal-design', 'Developer portal — its design: the mode (default, themed, templates), the texts, the theme'],
    ['home', 'console-portal-home', 'Developer portal — the home written as a template (Markdoc), the tags of the portal beside it', true],
    ['templates', 'console-portal-templates', 'Developer portal — the template of an api, its variables', true],
    ['navigation', 'console-portal-navigation', 'Developer portal — the links of its header and its footer'],
    ['styles', 'console-portal-styles', 'Developer portal — its style sheet and its script, scripts off by default', true],
    ['assets', 'console-portal-assets', 'Developer portal — its assets: images, fonts, style sheets'],
    ['versions', 'console-portal-versions', 'Developer portal — the versions of its design, restored into the draft'],
    ['sync', 'console-portal-sync', 'Developer portal — a folder synchronised with the cli, or a remote catalog'],
  ]) {
    await go(page, section ? `${D}/${section}` : D);
    if (edit) await editors(page);
    await shot(page, name, title, { full: section !== 'home' && section !== 'templates' });
  }
  await go(page, `${D}/versions/1`);
  await editors(page);
  await shot(page, 'console-portal-version', 'Developer portal — a version of its design on its page, restored into the draft from there', { full: false });
  // allowing scripts is an act of its own: the warning, never accepted by the tour
  await go(page, `${D}/styles`);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.setting, .card-body > div')].find((e) => e.innerText.includes('Allow scripts on this portal'));
    row?.querySelector('input[type=checkbox]')?.click();
  });
  await settle(page, 500);
  await shot(page, 'console-portal-scripts', 'Allowing scripts on a portal — the warning, to acknowledge', { full: false });
  await page.keyboard.press('Escape');

  await go(page, '/backoffice/ws/gitops/settings/catalogs');
  await shot(page, 'console-ws-catalogs', 'Workspace settings — remote catalogs');
  const gitopsCatalogs = await api(page, '/backoffice/api/workspaces/gitops/catalogs');
  if (gitopsCatalogs?.[0]) {
    await go(page, `/backoffice/ws/gitops/settings/catalogs/${gitopsCatalogs[0].id}`);
    await shot(page, 'console-catalog', 'A remote catalog on its page — its settings, its last sync, the APIs it manages');
    await click(page, 'Preview a sync');
    await sleep(1500);
    await shot(page, 'console-catalog-preview', 'A catalog sync, previewed as a dry run, on the page of the catalog');
  }
  await go(page, '/backoffice/ws/gitops/apis/weather');
  await shot(page, 'console-managed-api', 'An api managed by a catalog: edited at its source, operable here', { full: false });

  for (const [path, name, title] of [
    ['/backoffice/gateway/status', 'console-gateway-status', 'Gateway — health, projection queue, ingestion'],
    ['/backoffice/gateway/drift', 'console-gateway-drift', 'Gateway — drift reports'],
    ['/backoffice/gateway/connection', 'console-gateway-connection', 'Gateway — connection and data exporter'],
    ['/backoffice/gateway/ingestion', 'console-gateway-ingestion', 'Gateway — ingestion: the sampling of the raw path, the pseudonymisation of personal data, the retention of each path'],
    ['/backoffice/settings/workspaces', 'console-global-workspaces', 'Global settings — workspaces, portal exposure'],
    ['/backoffice/settings/users', 'console-global-users', 'Global settings — users'],
    ['/backoffice/settings/authentication', 'console-global-auth', 'Global settings — authentication'],
    ['/backoffice/settings/email', 'console-global-email', 'Global settings — email: the transport of the installation, a test, the emails sent'],
    ['/backoffice/settings/audit', 'console-global-audit-export', 'Global settings — audit trail exporters'],
    ['/backoffice/settings/tokens', 'console-global-tokens', 'Global settings — api tokens for the cli and ci'],
  ]) {
    await go(page, path);
    await shot(page, name, title, { full: path !== '/backoffice/gateway/status' });
  }
  // the setup of the gateway, and what a dry run of it says
  await go(page, '/backoffice/gateway/setup');
  await click(page, 'Dry run');
  await sleep(1500);
  await shot(page, 'console-gateway-setup', 'Gateway — setup: what the product needs on the gateway, a dry run first');

  await theme(page, 'dark');
  await go(page, W);
  await shot(page, 'console-dark-home', 'Dark theme — home');
  await go(page, `${A}/plans`);
  await click(page, 'Edit');
  await click(page, 'Limits', { selector: '[role=tab]' });
  await shot(page, 'console-dark-plan', 'Dark theme — plan editor', { full: false });
  await go(page, `${W}/apis/petstore/flows`);
  await page.setViewport({ width: 1440, height: 1080 });
  await clickNth(page, '[aria-label=edit]', 1);
  await clickNth(page, '.seg button', 0, 'JSON');
  await editors(page);
  await shot(page, 'console-dark-plugin-edit', 'Dark theme — the plugin editor, its code editor following the theme', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await theme(page, 'light');
  await page.evaluate(() => localStorage.setItem('apim.console.lang', 'fr'));
  await go(page, `${A}/plans`);
  await click(page, 'Modifier');
  await shot(page, 'console-french', 'The console in French — the language of the browser, or the one chosen in the user menu', { full: false });
  await page.evaluate(() => localStorage.setItem('apim.console.lang', 'en'));
  // a consumer who signs in to the console is sent to its portal
  await api(page, '/backoffice/api/auth/logout', 'POST', {});
  await api(page, '/backoffice/api/auth/login', 'POST', CONSUMER);
  await go(page, '/backoffice/');
  await shot(page, 'console-consumer', 'A consumer signed in to the console: its place is the developer portal', { full: false });
  await api(page, '/backoffice/api/auth/logout', 'POST', {});
}

async function portalTour(page) {
  const P = `/${WS}`;
  await go(page, `${P}/`);
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'light');
    localStorage.setItem('apim.portal.lang', 'en');
  });
  await api(page, `${P}/front/api/auth/logout`, 'POST', {});
  await go(page, `${P}/`);
  await shot(page, 'portal-home', 'Portal — home of a workspace portal (anonymous visitor)');
  await go(page, `${P}/apis`);
  await shot(page, 'portal-catalogue', 'Portal — catalogue: categories, featured apis, ratings, usage');
  await go(page, `${P}/apis/books`);
  await shot(page, 'portal-api', 'Portal — an api: base url, quickstart, resources');
  await go(page, `${P}/apis/books/docs`);
  await shot(page, 'portal-docs', 'Portal — documentation, in the languages of the api');
  await go(page, `${P}/apis/books/reference`);
  await sleep(1500);
  await shot(page, 'portal-reference', 'Portal — API reference, and testing from it (Scalar)');
  await go(page, `${P}/apis/books/plans`);
  await shot(page, 'portal-plans', 'Portal — plans: what really applies, per credential');
  await go(page, `${P}/apis/books/reviews`);
  await shot(page, 'portal-reviews', 'Portal — the reviews of the consumers who subscribed');
  await go(page, `${P}/apis/books/announcements`);
  await shot(page, 'portal-announcements', 'Portal — the announcements of an api, each one its first lines');
  await click(page, '', { selector: 'a.pt-announce' });
  await shot(page, 'portal-announcement', 'Portal — an announcement, opened');
  await go(page, `${P}/apis/orders-events/events`);
  await shot(page, 'portal-events', 'Portal — the events of an event-driven api, from its AsyncAPI specification');
  await go(page, `${P}/signin`);
  await shot(page, 'portal-signin', 'Portal — sign in, with the IdP of the workspace', { full: false });
  await go(page, `${P}/signup`);
  await shot(page, 'portal-signup', 'Portal — self signup', { full: false });

  await api(page, `${P}/front/api/auth/login`, 'POST', CONSUMER);
  const apps = await api(page, `${P}/front/api/applications`);
  const app = apps.find((a) => a.name === 'Carol shop') || apps[0];
  await go(page, `${P}/apis/petstore/plans`);
  await click(page, 'Subscribe');
  await shot(page, 'portal-subscribe', 'Portal — subscribing: application, usage statement, request form, terms', { full: false });
  await go(page, `${P}/apps`);
  await shot(page, 'portal-apps', 'Portal — my applications');
  if (app) {
    await go(page, `${P}/apps/${app.id}`);
    await shot(page, 'portal-app', 'Portal — an application: credentials, live quotas, transfer consent, one API key for every API');
    // answer the pending proposal, so that the subscription can ask for a move itself
    const sub = (await api(page, `${P}/front/api/applications/${app.id}`)).subscriptions?.find((s) => s.pending_transfer?.status === 'awaiting_consent');
    if (sub) await api(page, `${P}/front/api/subscriptions/${sub.id}/transfer/consent`, 'POST', { accept: false });
    await go(page, `${P}/apps/${app.id}`);
    await click(page, 'Change plan');
    await shot(page, 'portal-change-plan', 'Portal — asking to move to an equivalent plan', { full: false });
  }
  await go(page, `${P}/usage?range=7d`);
  await page.setViewport({ width: 1440, height: 1400 });
  await shot(page, 'portal-usage', 'Portal — the analytics of my applications', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await go(page, `${P}/usage?view=logs&range=24h`);
  await shot(page, 'portal-logs', 'Portal — the request log of my applications, exported as CSV', { full: false });
  await go(page, `${P}/teams`);
  await shot(page, 'portal-teams', 'Portal — my teams');
  await go(page, `${P}/messages`);
  await shot(page, 'portal-messages', 'Portal — messages: the conversations of a person with the workspace');
  const mine = await api(page, `${P}/front/api/conversations`);
  if (mine?.items?.[0]) {
    await go(page, `${P}/messages/${mine.items[0].id}`);
    await shot(page, 'portal-conversation', 'Portal — a conversation, about an API, answered');
  }
  await go(page, `${P}/messages/new?about=api:books`);
  await shot(page, 'portal-conversation-new', 'Portal — a new conversation, about an API: what routes it');
  await go(page, `${P}/apps`);
  await click(page, 'Notifications');
  await shot(page, 'portal-notifications', 'Portal — notifications', { full: false });

  await page.evaluate(() => localStorage.setItem('apim.portal.lang', 'fr'));
  await go(page, `${P}/apis/books/plans`);
  await shot(page, 'portal-french', 'Portal — in French');
  // a designed portal: the showcase workspace, themed and published, its next design in templates
  await api(page, '/showcase/front/api/auth/logout', 'POST', {});
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'light');
    localStorage.setItem('apim.portal.lang', 'en');
  });
  await go(page, '/showcase/');
  await shot(page, 'portal-themed-home', 'A themed portal — its colors, font, radius and logo, its links, a home made of blocks');
  await go(page, '/showcase/apis');
  await shot(page, 'portal-themed-catalogue', 'A themed portal — its catalogue, themed');
  await go(page, '/showcase/pages/guide');
  await shot(page, 'portal-themed-page', 'A themed portal — a page of its own, linked from its header');
  // the preview link is the console's: signed in again as an administrator (the console tour ended as a consumer)
  await api(page, '/backoffice/api/auth/login', 'POST', ADMIN);
  const preview = await api(page, '/backoffice/api/workspaces/showcase/portal/preview', 'POST', {});
  if (!preview?.url) console.warn(`    ! no preview link: ${JSON.stringify(preview).slice(0, 160)}`);
  if (preview?.url) {
    await go(page, new URL(preview.url).pathname + new URL(preview.url).search);
    await sleep(800);
    await shot(page, 'portal-templates-home', 'A portal written as templates (Markdoc) — its home, previewed before it is published');
    await go(page, '/showcase/apis/forecasts');
    await sleep(1500);
    await shot(page, 'portal-templates-api', 'A portal written as templates — the overview of an api, its variables and its reference as tags');
    await page.evaluate(() => sessionStorage.removeItem('apim.portal.preview'));
  }
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'dark');
    localStorage.setItem('apim.portal.lang', 'en');
  });
  await go(page, '/showcase/');
  await shot(page, 'portal-themed-dark', 'A themed portal — its colors for the dark theme');
  await go(page, `${P}/`);
  await shot(page, 'portal-dark-home', 'Portal — dark theme');
  await go(page, `${P}/apis/books/reference`);
  await sleep(1500);
  await shot(page, 'portal-dark-reference', 'Portal — dark theme, API reference');
  await page.evaluate(() => localStorage.setItem('apim.theme', 'light'));
}

// the documentation page listing every screen, generated with the screenshots so they never drift
function galleryPage(list) {
  const section = (prefix) =>
    list
      .filter((x) => x.file.startsWith(prefix))
      .map((x) => `### ${x.title.replace(/^(Console|Portal) — /, '')}\n\n![${x.title}](/img/screens/${x.file})\n`)
      .join('\n');
  return `---
sidebar_position: 2
title: Screens tour
description: Every screen of the console and of the developer portal, captured from a running installation.
---

{/* generated by scripts/screenshots.js — run \`bun run screenshots\` to refresh, do not edit by hand */}

# Screens tour

Every screen of the console and of the developer portal, captured from a running installation with
demo data (the Books, Petstore, Weather and Geocoding apis, and the Weather Co workspace for the design
of a portal). Regenerate them with
\`bun run screenshots\` after a change of the interface.

## Console

${section('console-')}
## Developer portal

${section('portal-')}`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--force-color-profile=srgb'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    page.on('pageerror', (e) => console.warn(`    ! page error: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.warn(`    ! console: ${m.text().slice(0, 200)}`));
    console.log('console');
    await consoleTour(page);
    console.log('portal');
    await portalTour(page);
  } finally {
    await browser.close();
  }
  await writeFile(join(OUT, 'index.json'), JSON.stringify(shots, null, 2));
  await writeFile(join(import.meta.dir, '..', 'documentation', 'docs', 'screens.mdx'), galleryPage(shots));
  console.log(`${shots.length} screens in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
