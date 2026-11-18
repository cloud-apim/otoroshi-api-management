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
  await click(page, 'notifications');
  await shot(page, 'console-notifications', 'Notifications of the producers', { full: false });

  await go(page, `${W}/apis`);
  await shot(page, 'console-apis', 'APIs — lifecycle, deployment state, plans and subscriptions');
  await click(page, 'New API');
  await shot(page, 'console-new-api', 'New API — created as a draft, end to end', { full: false });
  await go(page, `${W}/apis`);
  await click(page, 'Adopt from gateway');
  await shot(page, 'console-adopt', 'Adopt mode — take over an Api that already runs on the gateway', { full: false });

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
  await editors(page);
  await shot(page, 'console-api-plugin-edit', 'Editing a plugin of a flow — its native configuration, where it applies', { full: false });
  await click(page, 'Cancel');
  await click(page, 'Add plugin');
  await page.type('[aria-label="search plugins"]', 'compression');
  await click(page, 'Brotli compression', { selector: '.palette-item' });
  await editors(page);
  await shot(page, 'console-api-plugin-add', "Adding a plugin — the gateway's catalog, and the default configuration of the plugin chosen", { full: false });
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
    ['Access', 'console-plan-access', 'Plan editor — access: auth mechanism, selection rule'],
    ['Limits', 'console-plan-limits', 'Plan editor — limits: rate, quotas, resources, failure strategies'],
    ['Catalogue & approval', 'console-plan-catalogue', 'Plan editor — catalogue and approval: never projected'],
    ['Pricing', 'console-plan-pricing', 'Plan editor — pricing'],
  ]) {
    await click(page, tab, { selector: '[role=tab]' });
    await shot(page, name, title, { full: false });
  }

  await go(page, `${A}/documentation`);
  await shot(page, 'console-api-docs', 'API — multilingual documentation pages');
  await go(page, `${A}/openapi`);
  await editors(page);
  await shot(page, 'console-api-openapi', 'API — OpenAPI specification, in a code editor', { full: false });
  await go(page, `${A}/subscriptions`);
  await shot(page, 'console-api-subscriptions', 'API — its subscriptions');
  if (bookSub) {
    await go(page, `${A}/subscriptions?open=${bookSub.id}`);
    await shot(page, 'console-subscription-drawer', 'Subscription — request, credentials, lifecycle, transfer', { full: false });
  }
  await go(page, `${A}/deployment`);
  await shot(page, 'console-api-deployment', 'API — deployed state, gateway drift, snapshots (rollback), history');
  await click(page, 'View');
  await shot(page, 'console-snapshot', 'An immutable snapshot', { full: false });
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

  await go(page, `${A}/tryit`);
  await click(page, 'Send');
  await sleep(800);
  await shot(page, 'console-api-tryit', 'Try it — replay a request through the gateway');
  await go(page, `${A}/analytics?range=24h`);
  await shot(page, 'console-api-analytics', 'API — analytics, in the catalogue vocabulary');
  await go(page, `${A}/settings`);
  await click(page, 'Technical details', { selector: 'summary' });
  await shot(page, 'console-api-settings', 'API — settings, versions, technical details (the escape hatch), danger zone');

  await go(page, `${W}/policy-groups`);
  await shot(page, 'console-policy-groups', 'Shared policy groups');
  if (groups[0]) {
    await go(page, `${W}/policy-groups/${groups[0].id}`);
    await shot(page, 'console-policy-group', 'A policy group — draft, versions, the apis that use it and lag behind');
  }

  await go(page, `${W}/applications`);
  await shot(page, 'console-applications', 'Applications');
  if (app) {
    await go(page, `${W}/applications/${app.id}`);
    await shot(page, 'console-application', 'An application and its subscriptions');
    await click(page, 'Identity', { selector: 'button' });
    await shot(page, 'console-application-identity', 'An application — expected client_id, certificates, metadata');
  }
  await go(page, `${W}/subscriptions?status=pending`);
  await shot(page, 'console-subscriptions', 'Subscriptions waiting for review');
  if (pendingSub) {
    await go(page, `${W}/subscriptions?status=pending&open=${pendingSub.id}`);
    await shot(page, 'console-review', 'Reviewing a request: usage statement, request form, terms', { full: false });
  }
  await go(page, `${W}/observability?range=24h`);
  await page.setViewport({ width: 1440, height: 1500 });
  await shot(page, 'console-observability', 'Observability — traffic by api, plan, application, status, endpoint', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await go(page, `${W}/audit`);
  await shot(page, 'console-audit', 'Audit — writes, and reads of credentials and request logs', { full: false });
  await click(page, '', { selector: 'tr.clickable' });
  await shot(page, 'console-audit-event', 'An audit event', { full: false });

  for (const [tab, name, title] of [
    ['general', 'console-ws-general', 'Workspace settings — general'],
    ['portal', 'console-ws-portal', 'Workspace settings — its developer portal, its identity provider'],
    ['members', 'console-ws-members', 'Workspace settings — members and roles'],
    ['teams', 'console-ws-teams', 'Workspace settings — teams'],
    ['metadata', 'console-ws-metadata', 'Workspace settings — typed metadata fields'],
    ['export', 'console-ws-export', 'Workspace settings — export and import'],
  ]) {
    await go(page, `${W}/settings/${tab}`);
    if (tab === 'export') await editors(page);
    await shot(page, name, title);
  }
  await go(page, '/backoffice/ws/gitops/settings/catalogs');
  await shot(page, 'console-ws-catalogs', 'Workspace settings — remote catalogs');
  await click(page, 'Preview & sync');
  await sleep(800);
  await shot(page, 'console-catalog-preview', 'A catalog sync, previewed as a dry run', { full: false });
  await go(page, '/backoffice/ws/gitops/apis/weather');
  await shot(page, 'console-managed-api', 'An api managed by a catalog: edited at its source, operable here', { full: false });

  for (const [path, name, title] of [
    ['/backoffice/gateway/status', 'console-gateway-status', 'Gateway — health, projection queue, ingestion'],
    ['/backoffice/gateway/drift', 'console-gateway-drift', 'Gateway — drift reports'],
    ['/backoffice/gateway/connection', 'console-gateway-connection', 'Gateway — connection, data exporter, raw path'],
    ['/backoffice/settings/workspaces', 'console-global-workspaces', 'Global settings — workspaces, portal exposure'],
    ['/backoffice/settings/users', 'console-global-users', 'Global settings — users'],
    ['/backoffice/settings/authentication', 'console-global-auth', 'Global settings — authentication'],
    ['/backoffice/settings/audit', 'console-global-audit-export', 'Global settings — audit trail exporters'],
    ['/backoffice/settings/tokens', 'console-global-tokens', 'Global settings — api tokens for the cli and ci'],
  ]) {
    await go(page, path);
    await shot(page, name, title, { full: path !== '/backoffice/gateway/status' });
  }

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
  await editors(page);
  await shot(page, 'console-dark-plugin-edit', 'Dark theme — the plugin editor, its code editor following the theme', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await theme(page, 'light');
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
  await shot(page, 'portal-catalogue', 'Portal — catalogue');
  await go(page, `${P}/apis/books`);
  await shot(page, 'portal-api', 'Portal — an api: base url, quickstart, resources');
  await go(page, `${P}/apis/books/docs`);
  await shot(page, 'portal-docs', 'Portal — documentation, in the languages of the api');
  await go(page, `${P}/apis/books/reference`);
  await sleep(1500);
  await shot(page, 'portal-reference', 'Portal — API reference and try-it (Scalar)');
  await go(page, `${P}/apis/books/plans`);
  await shot(page, 'portal-plans', 'Portal — plans: what really applies, per credential');
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
    await shot(page, 'portal-app', 'Portal — an application: credentials, live quotas, transfer consent');
    // answer the pending proposal, so that the subscription can ask for a move itself
    const sub = (await api(page, `${P}/front/api/applications/${app.id}`)).subscriptions?.find((s) => s.pending_transfer?.status === 'awaiting_consent');
    if (sub) await api(page, `${P}/front/api/subscriptions/${sub.id}/transfer/consent`, 'POST', { accept: false });
    await go(page, `${P}/apps/${app.id}`);
    await click(page, 'Change plan');
    await shot(page, 'portal-change-plan', 'Portal — asking to move to an equivalent plan', { full: false });
  }
  await go(page, `${P}/usage`);
  await shot(page, 'portal-usage', 'Portal — my consumption');
  await go(page, `${P}/teams`);
  await shot(page, 'portal-teams', 'Portal — my teams');
  await go(page, `${P}/apps`);
  await click(page, 'Notifications');
  await shot(page, 'portal-notifications', 'Portal — notifications', { full: false });

  await page.evaluate(() => localStorage.setItem('apim.portal.lang', 'fr'));
  await go(page, `${P}/apis/books/plans`);
  await shot(page, 'portal-french', 'Portal — in French');
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'dark');
    localStorage.setItem('apim.portal.lang', 'en');
  });
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
demo data (the Books, Petstore, Weather and Geocoding apis). Regenerate them with
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
