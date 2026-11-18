// The payments of a paid plan, end to end, with the fake Stripe of the development: a workspace
// links its Stripe account (Connect), a consumer pays on the Checkout, the key reaches the gateway
// once Stripe says it is paid; then the events of Stripe — signed, kept once — and the
// reconciliation follow the subscription: past due within its grace, suspended past it or unpaid,
// resumed once paid, closed when cancelled; closing it cancels it at Stripe.
//
// Needs the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'payments-test-token';
config.publicUrl = `http://localhost:${config.port}`;
const provider = config.payments.provider;
config.payments.provider = 'fake';

const { start } = await import('../server/main.js');
const { db } = await import('../server/db/index.js');
const billing = await import('../server/payments/billing.js');
const { signPayload } = await import('../server/payments/stripe.js');
const { FAKE_SECRET } = await import('../server/payments/fake.js');
const { otoroshi } = await import('../server/otoroshi/client.js');

const RUN = Date.now().toString(36);
const WS = `pay-${RUN}`;
const ROOT = `http://localhost:${config.port}`;
const DOMAIN = `pay-${RUN}.oto.tools`;
const PLAN = `plan_premium_${RUN}`;
const email = `buyer-${RUN}@payments.test`;
const PASSWORD = `pw-${RUN}-secret`;
let server;
const state = {};

async function call(method, path, body) {
  const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer payments-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const portal = (path, init = {}) => fetch(`${ROOT}/${WS}/front/api${path}`, { ...init, headers: { cookie: state.cookie, 'content-type': 'application/json', ...(init.headers || {}) } });
const sub = async () => (await db`select * from subscriptions where id = ${state.subId}`)[0];

// an event of Stripe about the linked account, as its webhook receives it
async function webhook(event, secret = FAKE_SECRET) {
  const body = JSON.stringify(event);
  return fetch(`${ROOT}/payments/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signPayload(secret, body) }, body });
}

async function gatewayStatus(creds, wanted) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 30000) {
    last = (await fetch('http://localhost:8080/premium', { headers: { Host: DOMAIN, 'Otoroshi-Client-Id': creds.client_id, 'Otoroshi-Client-Secret': creds.client_secret } })).status;
    if (last === wanted) return last;
    await Bun.sleep(500);
  }
  return last;
}

beforeAll(async () => {
  server = await start();
  await ok('POST', '/workspaces', { name: `Payments ${RUN}`, slug: WS });
  const team = await ok('POST', `/workspaces/${WS}/teams`, { name: 'Sellers' });
  const api = await ok('POST', `/workspaces/${WS}/apis`, { name: 'Premium data', version: '1.0.0', team_id: team.id, domain: DOMAIN, contextPath: '/', withDefaultPlan: false });
  state.apiId = api.id;
  const draft = api.draft;
  draft.resources = [{ id: 'res_premium', name: 'Premium', path: '/premium', methods: ['GET'], backendId: draft.backends[0].id, flowId: draft.flows[0].id }];
  draft.plans = [
    { id: PLAN, name: 'Premium', status: 'published', auth: { kind: 'apikey' }, validation: 'auto', pricing: { kind: 'paid', amount: 49, currency: 'EUR', interval: 'month', graceDays: 7 } },
    { id: `plan_gold_${RUN}`, name: 'Gold', status: 'published', auth: { kind: 'apikey' }, validation: 'auto', pricing: { kind: 'paid', amount: 99, currency: 'EUR', interval: 'month', graceDays: 7 } },
  ];
  await ok('PUT', `/workspaces/${WS}/apis/${api.id}/draft`, { draft });
  await ok('POST', `/workspaces/${WS}/apis/${api.id}/publish`, { comment: 'paid', deploy: true });
  // a consumer of the portal, with an application of its own
  await ok('POST', `/workspaces/${WS}/members`, { email, name: 'Buyer', password: PASSWORD, role: 'consumer' });
  const login = await fetch(`${ROOT}/${WS}/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  state.cookie = login.headers.get('set-cookie').split(';')[0];
  state.appId = (await (await portal('/applications', { method: 'POST', body: JSON.stringify({ name: 'Buyer app' }) })).json()).id;
});

afterAll(async () => {
  try {
    await call('DELETE', `/workspaces/${WS}/apis/${state.apiId}`);
    await db`delete from applications where workspace_id = (select id from workspaces where slug = ${WS})`;
    await db`delete from payment_events where account = ${state.account || ''}`;
    await call('DELETE', `/workspaces/${WS}`);
    for (const u of await db`select id from users where email = ${email}`) {
      for (const t of ['sessions', 'team_members', 'workspace_members', 'notification_states', 'api_tokens']) await db.unsafe(`delete from ${t} where user_id = $1`, [u.id]);
      await db`delete from teams where personal = true and id not in (select team_id from team_members)`.catch(() => null);
      await db`delete from users where id = ${u.id}`.catch(() => null);
    }
  } catch (e) {
    console.error('cleanup', e.message);
  }
  config.payments.provider = provider;
  server?.stop(true);
});

describe('selling the paid plans of a workspace', () => {
  test('nothing is sold before the workspace links its Stripe account', async () => {
    const r = await portal('/subscriptions', { method: 'POST', body: JSON.stringify({ api_id: state.apiId, plan_id: PLAN, application_id: state.appId }) });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('link a Stripe account first');
  });

  test('an administrator links it, through Stripe: the product keeps its id only', async () => {
    const { url } = await ok('POST', `/workspaces/${WS}/payments/connect`);
    const authorize = await fetch(url, { redirect: 'manual' });
    const callback = await fetch(authorize.headers.get('location'), { redirect: 'manual' });
    expect(callback.headers.get('location')).toBe(`${ROOT}/backoffice/ws/${WS}/settings/payments?payments=connected`);
    const status = await ok('GET', `/workspaces/${WS}/payments`);
    expect(status).toMatchObject({ available: true, provider: 'fake', account: { name: 'Fake Stripe account', livemode: false } });
    expect(status.account.id).toMatch(/^acct_fake_/);
    expect(Object.keys(status.account).sort()).toEqual(['connected_at', 'connected_by', 'id', 'livemode', 'name']);
    state.account = status.account.id;
    // a link forged, or replayed by someone else, is refused
    const forged = await fetch(`${ROOT}/payments/stripe/callback?code=x&state=forged.state`, { redirect: 'manual' });
    expect(forged.status).toBe(400);
  });

  test('a consumer pays on the Checkout; the key is made once Stripe says it is paid', async () => {
    const created = await (await portal('/subscriptions', { method: 'POST', body: JSON.stringify({ api_id: state.apiId, plan_id: PLAN, application_id: state.appId }) })).json();
    expect(created.status).toBe('pending_payment');
    state.subId = created.id;
    const { url } = await (await portal(`/subscriptions/${state.subId}/checkout`, { method: 'POST', body: '{}' })).json();
    // the price comes from the plan, the subscription id goes in the metadata
    const session = billing.paymentProvider().sessions.get(url.split('/').pop());
    expect(session.lineItem).toEqual({ price_data: { currency: 'eur', unit_amount: 4900, recurring: { interval: 'month' }, product_data: { name: 'Premium data 1.0.0 · Premium' } }, quantity: 1 });
    expect(session.metadata).toMatchObject({ apim_subscription_id: state.subId, apim_workspace: WS });
    expect((await fetch(url)).status).toBe(200);
    // nothing is projected before the payment
    expect((await sub()).projection.status).not.toBe('synced');
    const paid = await fetch(`${url}/pay`, { method: 'POST', redirect: 'manual' });
    expect(paid.status).toBe(303);
    expect(paid.headers.get('location')).toContain(`/apps/${state.appId}?checkout=success`);
    const s = await sub();
    expect(s.status).toBe('active');
    expect(s.payment).toMatchObject({ provider: 'fake', account: state.account, status: 'paid', stripe_status: 'active' });
    state.stripeSub = s.payment.provider_subscription;
    state.creds = (await ok('GET', `/workspaces/${WS}/subscriptions/${state.subId}`)).credentials[0];
    expect(await gatewayStatus(state.creds, 200)).toBe(200);
  });

  test('a webhook is checked by its signature, and handled once', async () => {
    const event = billing.paymentProvider().change(state.stripeSub, 'past_due');
    expect((await webhook(event, 'whsec_not_the_secret')).status).toBe(400);
    const r = await webhook(event);
    expect(await r.json()).toEqual({ received: true, duplicate: false });
    expect(await (await webhook(event)).json()).toEqual({ received: true, duplicate: true });
    const stored = (await db`select outcome, processed_at from payment_events where id = ${event.id}`)[0];
    expect(stored.processed_at).toBeTruthy();
    // past due: the key keeps working while Stripe retries
    const s = await sub();
    expect(s.status).toBe('active');
    expect(s.payment.status).toBe('past_due');
    expect(s.payment.past_due_since).toBeTruthy();
  });

  test('past its grace, the subscription is suspended; paid again, resumed', async () => {
    await db`update subscriptions set payment = payment || ${{ past_due_since: new Date(Date.now() - 8 * 86400000).toISOString() }}::jsonb where id = ${state.subId}`;
    expect(await billing.graceSweep()).toBeGreaterThanOrEqual(1);
    expect((await sub()).status).toBe('suspended');
    expect(await gatewayStatus(state.creds, 401)).not.toBe(200);
    await webhook(billing.paymentProvider().change(state.stripeSub, 'active'));
    const s = await sub();
    expect(s.status).toBe('active');
    expect(s.payment).toMatchObject({ status: 'paid', suspended_for_payment: false, past_due_since: null });
    expect(await gatewayStatus(state.creds, 200)).toBe(200);
  });

  test('unpaid at Stripe: suspended at once; a producer’s suspension is not lifted by a payment', async () => {
    await webhook(billing.paymentProvider().change(state.stripeSub, 'unpaid'));
    expect((await sub()).status).toBe('suspended');
    await webhook(billing.paymentProvider().change(state.stripeSub, 'active'));
    expect((await sub()).status).toBe('active');
    await ok('POST', `/workspaces/${WS}/subscriptions/${state.subId}/suspend`, { message: 'abuse' });
    await webhook(billing.paymentProvider().change(state.stripeSub, 'active'));
    expect((await sub()).status).toBe('suspended');
    await ok('POST', `/workspaces/${WS}/subscriptions/${state.subId}/resume`, {});
  });

  test('the team reaches its invoices and cards on the portal of Stripe', async () => {
    const { url } = await (await portal(`/subscriptions/${state.subId}/billing`, { method: 'POST', body: '{}' })).json();
    expect(url).toContain(`/apps/${state.appId}`);
    expect(url).toContain('stripe-portal=fake');
  });

  test('a lost webhook is caught up by the reconciliation: cancelled at Stripe, closed here', async () => {
    billing.paymentProvider().subscriptions.get(state.stripeSub).status = 'canceled';
    const r = await ok('POST', `/workspaces/${WS}/payments/reconcile`);
    expect(r.changed).toEqual([{ subscription: state.subId, outcome: 'subscription closed' }]);
    expect((await sub()).status).toBe('closed');
  });

  test('closed in the product, it is cancelled at Stripe; the account then unlinks', async () => {
    const created = await (await portal('/subscriptions', { method: 'POST', body: JSON.stringify({ api_id: state.apiId, plan_id: PLAN, application_id: state.appId }) })).json();
    const { url } = await (await portal(`/subscriptions/${created.id}/checkout`, { method: 'POST', body: '{}' })).json();
    await fetch(`${url}/pay`, { method: 'POST', redirect: 'manual' });
    const paid = (await db`select * from subscriptions where id = ${created.id}`)[0];
    expect(paid.status).toBe('active');
    // a paid subscription keeps the account linked
    expect((await call('DELETE', `/workspaces/${WS}/payments`)).status).toBe(409);
    await portal(`/subscriptions/${created.id}/close`, { method: 'POST', body: '{}' });
    expect(billing.paymentProvider().subscriptions.get(paid.payment.provider_subscription).status).toBe('canceled');
    expect((await db`select payment from subscriptions where id = ${created.id}`)[0].payment.status).toBe('canceled');
    expect((await call('DELETE', `/workspaces/${WS}/payments`)).status).toBe(200);
    expect((await ok('GET', `/workspaces/${WS}/payments`)).account).toBeNull();
  });
});
