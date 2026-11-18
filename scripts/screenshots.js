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
  await shot(page, 'console-01-login', 'Console — sign in (local accounts and the OIDC provider)', { full: false });
  await api(page, '/backoffice/api/auth/login', 'POST', ADMIN);

  const books = await api(page, `/backoffice/api/workspaces/${WS}/apis/books`);
  const subs = await api(page, `/backoffice/api/workspaces/${WS}/subscriptions`);
  const bookSub = subs.find((s) => s.api_slug === 'books' && s.status === 'active') || subs[0];
  const pendingSub = subs.find((s) => s.status === 'pending');
  const apps = await api(page, `/backoffice/api/workspaces/${WS}/applications`);
  const app = apps.find((a) => a.name === 'Carol shop') || apps[0];
  const groups = await api(page, `/backoffice/api/workspaces/${WS}/policy-groups`);

  await go(page, W);
  await shot(page, 'console-02-home', 'Home — what needs attention, traffic, recent activity');
  await page.keyboard.down('Control');
  await page.keyboard.press('k');
  await page.keyboard.up('Control');
  await sleep(300);
  await page.keyboard.type('book', { delay: 40 });
  await shot(page, 'console-03-search', 'Search (⌘K) — workspaces, pages and objects', { full: false });
  await page.keyboard.press('Escape');
  await click(page, 'switch workspace');
  await shot(page, 'console-04-workspace-selector', 'The workspace selector opens the sidebar', { full: false });
  await page.keyboard.press('Escape');
  await go(page, W);
  await click(page, 'notifications');
  await shot(page, 'console-05-notifications', 'Notifications of the producers', { full: false });

  await go(page, `${W}/apis`);
  await shot(page, 'console-06-apis', 'APIs — lifecycle, deployment state, plans and subscriptions');
  await click(page, 'New API');
  await shot(page, 'console-07-new-api', 'New API — created as a draft, end to end', { full: false });
  await go(page, `${W}/apis`);
  await click(page, 'Adopt from gateway');
  await shot(page, 'console-08-adopt', 'Adopt mode — take over an Api that already runs on the gateway', { full: false });

  const A = `${W}/apis/${books.id}`;
  await go(page, A);
  await shot(page, 'console-10-api-overview', 'API — how to call it, plans, effective resolution order');
  await go(page, `${A}/resources`);
  await shot(page, 'console-11-api-resources', 'API — entrypoint and resources (projected as routes)');
  await click(page, 'edit');
  await shot(page, 'console-12-api-resource-edit', 'API — editing a resource', { full: false });
  await go(page, `${A}/backends`);
  await shot(page, 'console-13-api-backends', 'API — backends (infrastructure, never the offer)');
  await click(page, 'edit');
  await shot(page, 'console-14-api-backend-edit', 'API — editing a backend', { full: false });
  await go(page, `${W}/apis/petstore/flows`);
  await shot(page, 'console-15-api-flows', 'API — policy flows: Otoroshi plugins, and a shared policy group pinned to a version');
  await click(page, 'edit');
  await shot(page, 'console-16-api-plugin-edit', 'API — a plugin of a flow, with the gateway catalog', { full: false });

  await go(page, `${A}/plans`);
  await shot(page, 'console-17-api-plans', 'API — plans: the policy lives here');
  await click(page, 'Edit');
  await shot(page, 'console-18-plan-general', 'Plan editor — general', { full: false });
  for (const [tab, name, title] of [
    ['Access', 'console-19-plan-access', 'Plan editor — access: auth mechanism, selection rule'],
    ['Limits', 'console-20-plan-limits', 'Plan editor — limits: rate, quotas, resources, failure strategies'],
    ['Catalogue & approval', 'console-21-plan-catalogue', 'Plan editor — catalogue and approval: never projected'],
    ['Pricing', 'console-22-plan-pricing', 'Plan editor — pricing'],
  ]) {
    await click(page, tab, { selector: '[role=tab]' });
    await shot(page, name, title, { full: false });
  }

  await go(page, `${A}/documentation`);
  await shot(page, 'console-23-api-docs', 'API — multilingual documentation pages');
  await go(page, `${A}/openapi`);
  await shot(page, 'console-24-api-openapi', 'API — OpenAPI specification');
  await go(page, `${A}/subscriptions`);
  await shot(page, 'console-25-api-subscriptions', 'API — its subscriptions');
  if (bookSub) {
    await go(page, `${A}/subscriptions?open=${bookSub.id}`);
    await shot(page, 'console-26-subscription-drawer', 'Subscription — request, credentials, lifecycle, transfer', { full: false });
  }
  await go(page, `${A}/deployment`);
  await shot(page, 'console-27-api-deployment', 'API — deployed state, gateway drift, snapshots (rollback), history');
  await click(page, 'View');
  await shot(page, 'console-28-snapshot', 'An immutable snapshot', { full: false });
  await go(page, A);
  await click(page, 'Deploy');
  await shot(page, 'console-29-deploy-dry-run', 'Deploy — the diff is always shown first', { full: false });

  // a harmless pending change, to show the publication dialog, then reverted
  const original = books.description;
  await api(page, `/backoffice/api/workspaces/${WS}/apis/${books.id}`, 'PUT', { description: `${original} — reference API` });
  await go(page, A);
  await shot(page, 'console-30-api-out-of-sync', 'The gap between the draft and what runs is always shown', { full: false });
  await click(page, 'Publish');
  await shot(page, 'console-31-publish', 'Publish — changes since the last snapshot, validation', { full: false });
  await api(page, `/backoffice/api/workspaces/${WS}/apis/${books.id}`, 'PUT', { description: original });

  await go(page, `${A}/tryit`);
  await click(page, 'Send');
  await sleep(800);
  await shot(page, 'console-32-api-tryit', 'Try it — replay a request through the gateway');
  await go(page, `${A}/analytics?range=24h`);
  await shot(page, 'console-33-api-analytics', 'API — analytics, in the catalogue vocabulary');
  await go(page, `${A}/settings`);
  await click(page, 'Technical details', { selector: 'summary' });
  await shot(page, 'console-34-api-settings', 'API — settings, versions, technical details (the escape hatch), danger zone');

  await go(page, `${W}/policy-groups`);
  await shot(page, 'console-35-policy-groups', 'Shared policy groups');
  if (groups[0]) {
    await go(page, `${W}/policy-groups/${groups[0].id}`);
    await shot(page, 'console-36-policy-group', 'A policy group — draft, versions, the apis that use it and lag behind');
  }

  await go(page, `${W}/applications`);
  await shot(page, 'console-37-applications', 'Applications');
  if (app) {
    await go(page, `${W}/applications/${app.id}`);
    await shot(page, 'console-38-application', 'An application and its subscriptions');
    await click(page, 'Identity', { selector: 'button' });
    await shot(page, 'console-39-application-identity', 'An application — expected client_id, certificates, metadata');
  }
  await go(page, `${W}/subscriptions?status=pending`);
  await shot(page, 'console-40-subscriptions', 'Subscriptions waiting for review');
  if (pendingSub) {
    await go(page, `${W}/subscriptions?status=pending&open=${pendingSub.id}`);
    await shot(page, 'console-41-review', 'Reviewing a request: usage statement, request form, terms', { full: false });
  }
  await go(page, `${W}/observability?range=24h`);
  await page.setViewport({ width: 1440, height: 1500 });
  await shot(page, 'console-42-observability', 'Observability — traffic by api, plan, application, status, endpoint', { full: false });
  await page.setViewport({ width: 1440, height: 900 });
  await go(page, `${W}/audit`);
  await shot(page, 'console-43-audit', 'Audit — writes, and reads of credentials and request logs', { full: false });
  await click(page, '', { selector: 'tr.clickable' });
  await shot(page, 'console-44-audit-event', 'An audit event', { full: false });

  for (const [tab, name, title] of [
    ['general', 'console-45-ws-general', 'Workspace settings — general'],
    ['portal', 'console-46-ws-portal', 'Workspace settings — its developer portal, its identity provider'],
    ['members', 'console-47-ws-members', 'Workspace settings — members and roles'],
    ['teams', 'console-48-ws-teams', 'Workspace settings — teams'],
    ['metadata', 'console-49-ws-metadata', 'Workspace settings — typed metadata fields'],
    ['export', 'console-50-ws-export', 'Workspace settings — export and import'],
  ]) {
    await go(page, `${W}/settings/${tab}`);
    await shot(page, name, title);
  }
  await go(page, '/backoffice/ws/gitops/settings/catalogs');
  await shot(page, 'console-51-ws-catalogs', 'Workspace settings — remote catalogs');
  await click(page, 'Preview & sync');
  await sleep(800);
  await shot(page, 'console-52-catalog-preview', 'A catalog sync, previewed as a dry run', { full: false });
  await go(page, '/backoffice/ws/gitops/apis/weather');
  await shot(page, 'console-53-managed-api', 'An api managed by a catalog: edited at its source, operable here', { full: false });

  for (const [path, name, title] of [
    ['/backoffice/gateway/status', 'console-54-gateway-status', 'Gateway — health, projection queue, ingestion'],
    ['/backoffice/gateway/drift', 'console-55-gateway-drift', 'Gateway — drift reports'],
    ['/backoffice/gateway/connection', 'console-56-gateway-connection', 'Gateway — connection, data exporter, raw path'],
    ['/backoffice/settings/workspaces', 'console-57-global-workspaces', 'Global settings — workspaces, portal exposure'],
    ['/backoffice/settings/users', 'console-58-global-users', 'Global settings — users'],
    ['/backoffice/settings/authentication', 'console-59-global-auth', 'Global settings — authentication'],
    ['/backoffice/settings/audit', 'console-60-global-audit-export', 'Global settings — audit trail exporters'],
    ['/backoffice/settings/tokens', 'console-61-global-tokens', 'Global settings — api tokens for the cli and ci'],
  ]) {
    await go(page, path);
    await shot(page, name, title, { full: path !== '/backoffice/gateway/status' });
  }

  await theme(page, 'dark');
  await go(page, W);
  await shot(page, 'console-62-dark-home', 'Dark theme — home');
  await go(page, `${A}/plans`);
  await click(page, 'Edit');
  await click(page, 'Limits', { selector: '[role=tab]' });
  await shot(page, 'console-63-dark-plan', 'Dark theme — plan editor', { full: false });
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
  await shot(page, 'portal-01-home', 'Portal — home of a workspace portal (anonymous visitor)');
  await go(page, `${P}/apis`);
  await shot(page, 'portal-02-catalogue', 'Portal — catalogue');
  await go(page, `${P}/apis/books`);
  await shot(page, 'portal-03-api', 'Portal — an api: base url, quickstart, resources');
  await go(page, `${P}/apis/books/docs`);
  await shot(page, 'portal-04-docs', 'Portal — documentation, in the languages of the api');
  await go(page, `${P}/apis/books/reference`);
  await sleep(1500);
  await shot(page, 'portal-05-reference', 'Portal — API reference and try-it (Scalar)');
  await go(page, `${P}/apis/books/plans`);
  await shot(page, 'portal-06-plans', 'Portal — plans: what really applies, per credential');
  await go(page, `${P}/signin`);
  await shot(page, 'portal-07-signin', 'Portal — sign in, with the IdP of the workspace', { full: false });
  await go(page, `${P}/signup`);
  await shot(page, 'portal-08-signup', 'Portal — self signup', { full: false });

  await api(page, `${P}/front/api/auth/login`, 'POST', CONSUMER);
  const apps = await api(page, `${P}/front/api/applications`);
  const app = apps.find((a) => a.name === 'Carol shop') || apps[0];
  await go(page, `${P}/apis/petstore/plans`);
  await click(page, 'Subscribe');
  await shot(page, 'portal-09-subscribe', 'Portal — subscribing: application, usage statement, request form, terms', { full: false });
  await go(page, `${P}/apps`);
  await shot(page, 'portal-10-apps', 'Portal — my applications');
  if (app) {
    await go(page, `${P}/apps/${app.id}`);
    await shot(page, 'portal-11-app', 'Portal — an application: credentials, live quotas, transfer consent');
    // answer the pending proposal, so that the subscription can ask for a move itself
    const sub = (await api(page, `${P}/front/api/applications/${app.id}`)).subscriptions?.find((s) => s.pending_transfer?.status === 'awaiting_consent');
    if (sub) await api(page, `${P}/front/api/subscriptions/${sub.id}/transfer/consent`, 'POST', { accept: false });
    await go(page, `${P}/apps/${app.id}`);
    await click(page, 'Change plan');
    await shot(page, 'portal-12-change-plan', 'Portal — asking to move to an equivalent plan', { full: false });
  }
  await go(page, `${P}/usage`);
  await shot(page, 'portal-13-usage', 'Portal — my consumption');
  await go(page, `${P}/teams`);
  await shot(page, 'portal-14-teams', 'Portal — my teams');
  await go(page, `${P}/apps`);
  await click(page, 'Notifications');
  await shot(page, 'portal-15-notifications', 'Portal — notifications', { full: false });

  await page.evaluate(() => localStorage.setItem('apim.portal.lang', 'fr'));
  await go(page, `${P}/apis/books/plans`);
  await shot(page, 'portal-16-french', 'Portal — in French');
  await page.evaluate(() => {
    localStorage.setItem('apim.theme', 'dark');
    localStorage.setItem('apim.portal.lang', 'en');
  });
  await go(page, `${P}/`);
  await shot(page, 'portal-17-dark-home', 'Portal — dark theme');
  await go(page, `${P}/apis/books/reference`);
  await sleep(1500);
  await shot(page, 'portal-18-dark-reference', 'Portal — dark theme, API reference');
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
