// The catalogue as a discovery system, against a real server: the editorial axis (the categories of
// the portal, where each api stands, the featured ones), the reviews of the consumers who subscribed
// — and only theirs, a producer hiding one — and the real usage; the portal sorts and filters on them.
//
// Needs the docker stack (mise run up): the catalogue lists what runs on the gateway.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'discovery-test-token';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');

const RUN = Date.now().toString(36);
const WS = `discovery-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const PASSWORD = 'a-long-enough-password';
const people = { alice: `alice-${RUN}@discovery.test`, bob: `bob-${RUN}@discovery.test` };
let server;
const state = { cookies: {} };

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, {
    method,
    headers: { authorization: 'Bearer discovery-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
// the portal, as one of its people (or anonymous)
async function portal(who, method, path, body) {
  const res = await fetch(`${ROOT}/${WS}/front/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { cookie: state.cookies[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const catalogue = async (query = '') => (await portal(null, 'GET', `/apis${query}`)).body;

async function anApi(team, name) {
  const api = await ok('POST', `/workspaces/${WS}/apis`, { name, version: '1.0.0', team_id: team.id, domain: `${name.toLowerCase()}-${RUN}.oto.tools`, contextPath: '/' });
  const draft = api.draft;
  draft.plans = [{ ...draft.plans[0], status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  await ok('PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok('POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'first', deploy: true });
  return { ...api, plan: draft.plans[0].id };
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Discovery ${RUN}`, slug: WS });
  const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Cartographers' });
  state.atlas = await anApi(team, 'Atlas');
  state.beacon = await anApi(team, 'Beacon');
  for (const [who, email] of Object.entries(people)) {
    await ok('POST', `/workspaces/${WS}/members`, { email, name: who, password: PASSWORD, role: 'consumer' });
    const login = await fetch(`${ROOT}/${WS}/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    state.cookies[who] = login.headers.get('set-cookie').split(';')[0];
  }
  // alice subscribes to Atlas; bob to nothing
  const app = (await portal('alice', 'POST', '/applications', { name: 'Alice app' })).body;
  const sub = await portal('alice', 'POST', '/subscriptions', { api_id: state.atlas.id, plan_id: state.atlas.plan, application_id: app.id });
  expect(sub.body.status).toBe('active');
});

afterAll(async () => {
  try {
    for (const a of [state.atlas, state.beacon]) if (a) await call('DELETE', `/workspaces/${WS}/apis/${a.id}`);
    await db`delete from applications where workspace_id = (select id from workspaces where slug = ${WS})`;
    await call('DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email in ${db(Object.values(people))}`) {
      for (const t of ['sessions', 'team_members', 'workspace_members', 'notification_states', 'api_tokens']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from teams where personal = true and id not in (select team_id from team_members)`.catch(() => null);
      await db`delete from users where id = ${u.id}`.catch(() => null);
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  server?.stop(true);
});

describe('the editorial axis', () => {
  test('the portal declares its categories: a slug and a name per language', async () => {
    const bad = await call('PUT', `/workspaces/${WS}`, { portal: { categories: [{ slug: 'Not A Slug', name: 'x' }] } });
    expect(bad.status).toBe(400);
    const ws = await ok('PUT', `/workspaces/${WS}`, { portal: { categories: [{ slug: 'maps', name: { en: 'Maps', fr: 'Cartes' } }, { slug: 'weather', name: 'Weather' }] } });
    expect(ws.portal.categories).toEqual([
      { slug: 'maps', name: { en: 'Maps', fr: 'Cartes' } },
      { slug: 'weather', name: { en: 'Weather' } },
    ]);
    expect((await portal(null, 'GET', '/portal')).body.portal.categories.map((c) => c.slug)).toEqual(['maps', 'weather']);
  });

  test('a producer places an api, across its versions, at once: no snapshot', async () => {
    const unknown = await call('PUT', `/workspaces/${WS}/apis/${state.beacon.id}/placement`, { categories: ['oceans'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('unknown categories: oceans');
    expect(await ok('PUT', `/workspaces/${WS}/apis/${state.beacon.id}/placement`, { categories: ['maps'], featured: true })).toEqual({ categories: ['maps'], featured: true });
    expect((await ok('GET', `/workspaces/${WS}/apis/${state.beacon.id}/snapshots`)).length).toBe(1);
  });

  test('the catalogue: the featured apis first, filtered by category', async () => {
    const list = await catalogue();
    expect(list.map((a) => [a.name, a.featured, a.categories])).toEqual([
      ['Beacon', true, ['maps']],
      ['Atlas', false, []],
    ]);
    expect((await catalogue('?category=maps')).map((a) => a.name)).toEqual(['Beacon']);
    expect((await catalogue('?featured=true')).map((a) => a.name)).toEqual(['Beacon']);
    expect((await catalogue('?sort=name')).map((a) => a.name)).toEqual(['Atlas', 'Beacon']);
  });
});

describe('the reviews of the consumers', () => {
  test('only a consumer whose applications subscribed reviews an api', async () => {
    expect((await portal(null, 'PUT', '/apis/atlas/reviews/mine', { rating: 5 })).status).toBe(401);
    const bob = await portal('bob', 'PUT', '/apis/atlas/reviews/mine', { rating: 1, comment: 'never used it' });
    expect(bob.status).toBe(403);
    expect((await portal('bob', 'GET', '/apis/atlas/reviews')).body.can_review).toBe(false);
    expect((await portal('alice', 'PUT', '/apis/atlas/reviews/mine', { rating: 6 })).status).toBe(400);
    expect((await portal('alice', 'PUT', '/apis/atlas/reviews/mine', { rating: 3, comment: 'good' })).status).toBe(200);
    // one review per consumer and api: a second one replaces the first
    expect((await portal('alice', 'PUT', '/apis/atlas/reviews/mine', { rating: 4, comment: 'very good maps' })).body).toMatchObject({ rating: 4, comment: 'very good maps' });
    const seen = (await portal('alice', 'GET', '/apis/atlas/reviews')).body;
    expect(seen).toMatchObject({ rating: { average: 4, count: 1 }, can_review: true });
    expect(seen.reviews.map((r) => [r.author, r.rating, r.comment, r.mine])).toEqual([['alice', 4, 'very good maps', true]]);
    expect(seen.reviews[0].user_id).toBeUndefined();
  });

  test('the rating and the usage sort the catalogue', async () => {
    const list = await catalogue('?sort=rating');
    expect(list.map((a) => [a.name, a.rating?.average ?? null])).toEqual([
      ['Atlas', 4],
      ['Beacon', null],
    ]);
    const popular = await catalogue('?sort=popular');
    expect(popular.map((a) => [a.name, a.usage.applications])).toEqual([
      ['Atlas', 1],
      ['Beacon', 0],
    ]);
    expect(popular[0].usage.calls_30d).toBeGreaterThanOrEqual(0);
  });

  test('a producer hides a review: off the portal and its rating, kept in the console', async () => {
    const all = await ok('GET', `/workspaces/${WS}/apis/${state.atlas.id}/reviews`);
    await ok('POST', `/workspaces/${WS}/apis/${state.atlas.id}/reviews/${all.reviews[0].id}/hide`, { hidden: true });
    expect((await portal(null, 'GET', '/apis/atlas/reviews')).body).toMatchObject({ rating: null, reviews: [] });
    expect((await catalogue()).find((a) => a.name === 'Atlas').rating).toBeNull();
    const kept = await ok('GET', `/workspaces/${WS}/apis/${state.atlas.id}/reviews`);
    expect(kept.reviews.map((r) => [r.hidden, !!r.hidden_by])).toEqual([[true, true]]);
    await ok('POST', `/workspaces/${WS}/apis/${state.atlas.id}/reviews/${all.reviews[0].id}/hide`, { hidden: false });
    expect((await portal(null, 'GET', '/apis/atlas/reviews')).body.rating).toEqual({ average: 4, count: 1 });
  });

  test('the consumer withdraws it', async () => {
    expect((await portal('alice', 'DELETE', '/apis/atlas/reviews/mine')).status).toBe(200);
    expect((await portal(null, 'GET', '/apis/atlas/reviews')).body.reviews).toEqual([]);
  });
});

describe('what the portal shows', () => {
  test('a workspace keeps its reviews or its usage off the portal', async () => {
    await ok('PUT', `/workspaces/${WS}`, { portal: { discovery: { reviews: false, usage: false } } });
    const [a] = await catalogue('?category=maps');
    expect(a.rating).toBeUndefined();
    expect(a.usage).toBeUndefined();
    expect((await portal(null, 'GET', '/apis/atlas/reviews')).status).toBe(404);
    expect((await portal('alice', 'PUT', '/apis/atlas/reviews/mine', { rating: 5 })).status).toBe(404);
    await ok('PUT', `/workspaces/${WS}`, { portal: { discovery: { reviews: true, usage: true } } });
  });

  test('a category removed from the portal leaves the apis placed in it', async () => {
    await ok('PUT', `/workspaces/${WS}`, { portal: { categories: [{ slug: 'weather', name: 'Weather' }] } });
    expect((await catalogue()).find((a) => a.name === 'Beacon').categories).toEqual([]);
  });
});
