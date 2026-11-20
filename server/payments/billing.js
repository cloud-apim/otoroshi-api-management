// The payments of the paid plans. The product decides access; Stripe decides the money: a
// workspace links its own Stripe account (Stripe Connect), a consumer pays a paid plan there
// (Checkout), and the subscription is active while Stripe says it is paid. Nothing of this is in
// the request path: the gateway sees an apikey, enabled or disabled.
//
// - the events of Stripe about every linked account come on one endpoint, signed; each is kept
//   once and handled by the task queue — a lost or failed one is replayed, a redelivered one is not
//   handled twice;
// - the subscriptions are reconciled with Stripe periodically: a webhook can be lost;
// - past due, the key keeps working while Stripe retries the payment, for the grace period of the
//   plan at most; unpaid past it, the subscription is suspended, and resumed once paid;
// - the team pays: its billing account at Stripe groups the invoices of its applications.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { audit } from '../domain/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../http/router.js';
import { enqueue, registerTaskHandler, PermanentError } from '../domain/tasks.js';
import * as subscriptions from '../domain/subscriptions.js';
import { portalUrl } from '../portal-exposure.js';
import { lineItemsOf, PaymentError, stripeProvider } from './stripe.js';
import { fakeProvider } from './fake.js';

// the statuses of a Stripe subscription its key works in (past_due: Stripe retries the payment)
export const PAID = ['active', 'trialing', 'past_due'];
// the ones it is suspended in, waiting for a payment
const UNPAID = ['unpaid', 'incomplete_expired', 'paused'];
const OPEN = ['pending', 'pending_payment', 'active', 'suspended'];
const STATE_TTL = 30 * 60 * 1000;

// at start: a provider set completely, and never the fake one in production
export function checkPaymentsConfig(cfg = config, env = process.env) {
  const p = cfg.payments.provider;
  if (!['stripe', 'fake', 'off'].includes(p)) throw new Error('APIM_PAYMENTS_PROVIDER must be stripe, fake or off');
  if (p === 'stripe' && (!cfg.payments.stripe.secretKey || !cfg.payments.stripe.clientId || !cfg.payments.stripe.webhookSecret))
    throw new Error('APIM_STRIPE_SECRET_KEY, APIM_STRIPE_CLIENT_ID and APIM_STRIPE_WEBHOOK_SECRET are required with APIM_PAYMENTS_PROVIDER=stripe');
  if (p === 'fake' && env.NODE_ENV === 'production') throw new Error('the fake Stripe is refused when NODE_ENV=production: set APIM_PAYMENTS_PROVIDER=stripe and its keys');
}

let built = null;
export function paymentProvider() {
  const p = config.payments.provider;
  if (built?.for === p) return built.provider;
  const provider = p === 'stripe' ? stripeProvider(config.payments.stripe) : p === 'fake' ? fakeProvider(config.payments.stripe, { publicUrl: config.publicUrl }) : null;
  built = { for: p, provider };
  return provider;
}

const stateKey = () => createHmac('sha256', `${config.adminToken}:${config.ingest.token}`).update('apim-payments-state').digest();
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}
function readState(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = Buffer.from(createHmac('sha256', stateKey()).update(body).digest('base64url'));
  if (expected.length !== Buffer.from(mac).length || !timingSafeEqual(expected, Buffer.from(mac))) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString());
    return v.exp > Date.now() ? v : null;
  } catch (e) {
    return null;
  }
}

const system = (ws, sub) => ({ user: null, via: 'payments', role: 'admin', workspace: ws, managedBy: sub?.managed_by || null });
const accountOf = (ws) => ws?.payments?.account?.id || null;
const consoleLink = (ws, query) => `${config.publicUrl}/backoffice/ws/${ws.slug}/settings/payments?${query}`;
export const webhookUrl = () => `${config.publicUrl}/payments/stripe/webhook`;

// ---------------------------------------------------------------- the account of a workspace

export function availability() {
  const p = paymentProvider();
  return p ? { available: true, provider: p.name, reason: null } : { available: false, provider: null, reason: 'payments are not set up on this installation (APIM_PAYMENTS_PROVIDER)' };
}

export async function status(ws) {
  return { ...availability(), account: ws.payments?.account || null, webhook: webhookUrl() };
}

export function connectUrl(ctx, ws) {
  const p = paymentProvider();
  if (!p) throw forbidden(availability().reason);
  return p.authorizeUrl({ state: sign({ ws: ws.id, user: ctx.user?.id || null, exp: Date.now() + STATE_TTL }), redirectUri: `${config.publicUrl}/payments/stripe/callback` });
}

// back from Stripe: the account linked to the workspace, by who asked for it — still one of its administrators
export async function connected({ code, state, error }) {
  const s = readState(state);
  if (!s) throw badRequest('this link of a Stripe account is not yours, or too old: start again from the console');
  const ws = (await db`select * from workspaces where id = ${s.ws}`)[0];
  if (!ws) throw notFound('no such workspace');
  const user = s.user ? (await db`select * from users where id = ${s.user}`)[0] : null;
  const member = user ? (await db`select role from workspace_members where workspace_id = ${ws.id} and user_id = ${user.id}`)[0] : null;
  if (!user || !(user.is_admin || member?.role === 'admin')) throw forbidden('only an administrator of the workspace links its Stripe account');
  if (error || !code) return consoleLink(ws, 'payments=denied');
  const account = await paymentProvider().exchange(code);
  const linked = { id: account.accountId, name: account.name, livemode: account.livemode, connected_by: user.email, connected_at: new Date().toISOString() };
  await db`update workspaces set payments = ${{ provider: paymentProvider().name, account: linked }} where id = ${ws.id}`;
  await audit({ user, via: 'backoffice' }, { action: 'payments.connect', workspaceId: ws.id, entityKind: 'workspace', entityId: ws.id, summary: `Stripe account ${linked.id} linked`, data: { account: linked.id, livemode: linked.livemode } });
  return consoleLink(ws, 'payments=connected');
}

export async function disconnect(ctx, ws) {
  const account = accountOf(ws);
  if (!account) throw notFound('no Stripe account is linked to this workspace');
  const live = (await db`select count(*)::int as c from subscriptions where workspace_id = ${ws.id} and status = any(${'{active,suspended,pending_payment}'}::text[]) and payment->>'account' = ${account}`)[0].c;
  if (live) throw conflict(`${live} subscription(s) are paid through this account: close them first`);
  await db`update workspaces set payments = '{}' where id = ${ws.id}`;
  // the account may sell for another workspace: the access of the installation stays then
  if (!(await db`select 1 from workspaces where payments->'account'->>'id' = ${account}`).length) await paymentProvider()?.deauthorize(account);
  await audit(ctx, { action: 'payments.disconnect', workspaceId: ws.id, entityKind: 'workspace', entityId: ws.id, summary: `Stripe account ${account} unlinked` });
  return { done: true };
}

// ---------------------------------------------------------------- paying

async function customerOf(p, ws, account, team, email) {
  const key = `${p.name}:${account}`;
  const found = (await db`select customer_ref from payment_customers where team_id = ${team.id} and provider = ${key}`)[0];
  if (found) return found.customer_ref;
  const ref = await p.customer(account, { team, email, workspace: ws });
  await db`insert into payment_customers (team_id, provider, customer_ref) values (${team.id}, ${key}, ${ref}) on conflict do nothing`;
  return ref;
}

// a Checkout for a subscription waiting for its payment, on the Stripe account of the workspace
export async function checkout(ctx, ws, sub, { email } = {}) {
  const p = paymentProvider();
  if (!p) throw forbidden(availability().reason);
  // a new paid subscription, or the move of a free one to a paid plan
  const moving = sub.pending_transfer?.status === 'awaiting_payment';
  if (sub.status !== 'pending_payment' && !moving) throw badRequest('this subscription is not waiting for a payment');
  const account = accountOf(ws);
  if (!account) throw forbidden('this portal does not sell its plans yet: its administrators link a Stripe account first');
  const api = (await db`select * from apis where id = ${moving ? sub.pending_transfer.to.api_id : sub.api_id}`)[0];
  const { plan } = await subscriptions.findPlan(api, moving ? sub.pending_transfer.to.plan_id : sub.plan_id);
  if (plan.pricing?.kind !== 'paid') throw badRequest(`the plan ${plan.name} is free`);
  const app = (await db`select * from applications where id = ${sub.application_id}`)[0];
  const team = (await db`select * from teams where id = ${app.team_id}`)[0];
  const customer = await customerOf(p, ws, account, team, email || ctx.user?.email);
  const attempt = (sub.payment?.checkouts || 0) + 1;
  const back = `${portalUrl(ws.slug).replace(/\/$/, '')}/apps/${app.id}`;
  const metadata = { apim_subscription_id: sub.id, apim_workspace: ws.slug, apim_api: api.id, apim_plan: plan.id, ...(moving ? { apim_transfer: 'true' } : {}) };
  const session = await p.checkout(account, {
    lineItems: lineItemsOf(plan, `${api.name} ${api.version} · ${plan.name}`),
    customer,
    metadata,
    reference: sub.id,
    successUrl: `${back}?checkout=success`,
    cancelUrl: `${back}?checkout=canceled`,
    idempotencyKey: `apim-checkout-${sub.id}-${attempt}`,
  });
  // a subscription that moves keeps working on its plan: its payment is not awaited, the move is
  await db`update subscriptions set payment = ${{ ...(sub.payment || {}), provider: p.name, account, customer, checkout_session: session.id, checkouts: attempt, grace_days: Number(plan.pricing.graceDays ?? 7), ...(moving ? {} : { status: 'awaiting_payment' }) }}, updated_at = now() where id = ${sub.id}`;
  await audit(ctx, { action: 'subscription.checkout', workspaceId: ws.id, entityKind: 'subscription', entityId: sub.id, summary: `checkout of ${plan.name} opened for ${app.name}` });
  return { url: session.url };
}

// the portal of Stripe of the team: its invoices, its cards, the cancellation
export async function manage(ctx, ws, sub, { back }) {
  const p = paymentProvider();
  if (!p || !sub.payment?.customer || !sub.payment?.account) throw notFound('this subscription is not paid through Stripe');
  return { url: await p.portalUrl(sub.payment.account, sub.payment.customer, back) };
}

// ---------------------------------------------------------------- the events of Stripe

// an event about a linked account: checked, kept once, handled by the task queue
export async function receive(payload, headers) {
  const p = paymentProvider();
  if (!p) throw notFound('payments are not set up on this installation');
  let event;
  try {
    event = p.verifyEvent(payload, headers);
  } catch (e) {
    throw badRequest(e.message);
  }
  if (!event?.id || !event?.type) throw badRequest('not an event');
  return store(p, event);
}

async function store(p, event) {
  const inserted = await db`insert into payment_events (id, provider, account, type, data) values (${event.id}, ${p.name}, ${event.account || null}, ${event.type}, ${event})
    on conflict do nothing returning id`;
  if (inserted.length) await enqueue('payment_event', { provider: p.name, event_id: event.id }, { dedupeKey: `payment-event:${event.id}` });
  return { received: true, duplicate: !inserted.length };
}

// what Stripe says of a subscription, followed: paid, past due, unpaid, cancelled
async function follow(ws, sub, s) {
  const ctx = system(ws, sub);
  const payment = { status: s.status === 'canceled' ? 'canceled' : PAID.includes(s.status) ? (s.status === 'past_due' ? 'past_due' : 'paid') : 'unpaid', stripe_status: s.status, current_period_end: s.currentPeriodEnd ?? sub.payment?.current_period_end ?? null };
  if (s.status === 'canceled') {
    if (OPEN.includes(sub.status)) {
      await subscriptions.applyPayment(ctx, sub, { payment, action: 'subscription.payment.canceled', summary: `the payment of subscription ${sub.id} was cancelled at Stripe` });
      await subscriptions.closeSubscription(ctx, (await db`select * from subscriptions where id = ${sub.id}`)[0]);
      return 'subscription closed';
    }
    return 'already closed';
  }
  if (s.status === 'past_due') payment.past_due_since = sub.payment?.past_due_since || new Date().toISOString();
  else payment.past_due_since = null;
  if (PAID.includes(s.status)) {
    // paid again: what a missing payment suspended is resumed — not what a producer suspended
    if (sub.status === 'suspended' && sub.payment?.suspended_for_payment && s.status !== 'past_due') {
      await subscriptions.applyPayment(ctx, sub, { status: 'active', payment: { ...payment, suspended_for_payment: false }, datesPatch: { resumed_at: new Date().toISOString() }, action: 'subscription.payment.resumed', summary: `subscription ${sub.id} paid again: resumed` });
      return 'subscription resumed';
    }
    if (sub.status === 'pending_payment') {
      await subscriptions.applyPayment(ctx, sub, { status: 'active', payment, datesPatch: { started_at: new Date().toISOString() }, action: 'subscription.payment', summary: `payment received for subscription ${sub.id}` });
      return 'subscription active';
    }
    await subscriptions.applyPayment(ctx, sub, { payment, action: `subscription.payment.${payment.status}`, summary: `subscription ${sub.id}: ${s.status} at Stripe` });
    return s.status;
  }
  if (sub.status === 'active') {
    await subscriptions.applyPayment(ctx, sub, { status: 'suspended', payment: { ...payment, suspended_for_payment: true }, datesPatch: { suspended_at: new Date().toISOString() }, review: { ...sub.review, suspension_message: `unpaid (${s.status} at Stripe)` }, action: 'subscription.payment.suspended', summary: `subscription ${sub.id} suspended: ${s.status} at Stripe` });
    return 'subscription suspended';
  }
  return 'unchanged';
}

const workspaceOf = async (event, metadata) => {
  if (metadata?.apim_workspace) return (await db`select * from workspaces where slug = ${metadata.apim_workspace} and payments->'account'->>'id' = ${event.account || ''}`)[0] || null;
  return (await db`select * from workspaces where payments->'account'->>'id' = ${event.account || ''} limit 1`)[0] || null;
};

export async function handleEvent(event) {
  const p = paymentProvider();
  const o = event.data?.object || {};
  if (!event.account) return 'not an event of a linked account';
  switch (event.type) {
    case 'checkout.session.completed': {
      const m = o.metadata || {};
      if (o.mode !== 'subscription' || !m.apim_subscription_id) return 'not a payment of a plan';
      const ws = await workspaceOf(event, m);
      if (!ws) return 'no workspace for this account';
      const sub = (await db`select * from subscriptions where id = ${m.apim_subscription_id} and workspace_id = ${ws.id}`)[0];
      if (!sub) return 'no such subscription';
      // the payment of a move to a paid plan: the move is applied, then the payment followed
      if (m.apim_transfer) {
        if (sub.pending_transfer?.status !== 'awaiting_payment' || sub.pending_transfer.to.plan_id !== m.apim_plan) return 'no move waits for this payment';
        await db`update subscriptions set payment = ${{ ...(sub.payment || {}), provider_subscription: o.subscription, customer: o.customer || sub.payment?.customer }} where id = ${sub.id}`;
        await subscriptions.completePaidTransfer(system(ws, sub), (await db`select * from subscriptions where id = ${sub.id}`)[0]);
        return follow(ws, (await db`select * from subscriptions where id = ${sub.id}`)[0], await p.subscription(event.account, o.subscription));
      }
      if (sub.payment?.provider_subscription === o.subscription && sub.status !== 'pending_payment') return 'already';
      await db`update subscriptions set payment = ${{ ...(sub.payment || {}), provider_subscription: o.subscription, customer: o.customer || sub.payment?.customer }} where id = ${sub.id}`;
      const fresh = (await db`select * from subscriptions where id = ${sub.id}`)[0];
      return follow(ws, fresh, await p.subscription(event.account, o.subscription));
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = (await db`select * from subscriptions where payment->>'provider_subscription' = ${o.id} and payment->>'account' = ${event.account}`)[0];
      if (!sub) return 'not a subscription of a plan';
      const ws = (await db`select * from workspaces where id = ${sub.workspace_id}`)[0];
      const item = o.items?.data?.[0];
      const end = item?.current_period_end || o.current_period_end;
      return follow(ws, sub, { status: event.type === 'customer.subscription.deleted' ? 'canceled' : o.status, currentPeriodEnd: end ? new Date(end * 1000).toISOString() : null });
    }
    // the workspace took back the access of the installation to its account, from Stripe
    case 'account.application.deauthorized': {
      const rows = await db`update workspaces set payments = '{}' where payments->'account'->>'id' = ${event.account} returning id`;
      for (const r of rows) await audit({ via: 'payments' }, { action: 'payments.deauthorized', workspaceId: r.id, entityKind: 'workspace', entityId: r.id, summary: `Stripe account ${event.account} unlinked from Stripe` });
      return 'account unlinked';
    }
    default:
      return 'ignored';
  }
}

registerTaskHandler('payment_event', async ({ provider, event_id }) => {
  const stored = (await db`select * from payment_events where provider = ${provider} and id = ${event_id}`)[0];
  if (!stored || stored.processed_at) return { skipped: true };
  try {
    const outcome = await handleEvent(stored.data);
    await db`update payment_events set processed_at = now(), outcome = ${outcome}, error = null,
      subscription_id = ${stored.data?.data?.object?.metadata?.apim_subscription_id || null}, workspace_id = coalesce(workspace_id, (select id from workspaces where payments->'account'->>'id' = ${stored.account || ''} limit 1))
      where provider = ${provider} and id = ${event_id}`;
    return { outcome };
  } catch (e) {
    await db`update payment_events set error = ${e.message} where provider = ${provider} and id = ${event_id}`;
    if (e.status >= 400 && e.status < 500 && e.status !== 404) throw new PermanentError(e.message);
    throw e;
  }
});

// the provider stops charging what the product closed or moved to a free plan
registerTaskHandler('payment_cancel', async ({ subscription_id }) => {
  const sub = (await db`select * from subscriptions where id = ${subscription_id}`)[0];
  const p = paymentProvider();
  if (!sub?.payment?.provider_subscription || sub.payment.status === 'canceled' || !p) return { skipped: true };
  await p.cancel(sub.payment.account, sub.payment.provider_subscription);
  await db`update subscriptions set payment = ${{ ...sub.payment, status: 'canceled', stripe_status: 'canceled' }} where id = ${sub.id}`;
  return { canceled: sub.payment.provider_subscription };
});

// a move between two paid plans: the price of the subscription at Stripe follows, prorated
registerTaskHandler('payment_change_price', async ({ subscription_id }) => {
  const sub = (await db`select * from subscriptions where id = ${subscription_id}`)[0];
  const p = paymentProvider();
  if (!sub?.payment?.provider_subscription || !p) return { skipped: true };
  const api = (await db`select * from apis where id = ${sub.api_id}`)[0];
  const { plan } = await subscriptions.findPlan(api, sub.plan_id);
  await p.changePrice(sub.payment.account, sub.payment.provider_subscription, plan, `${api.name} ${api.version} · ${plan.name}`);
  return { price: plan.id };
});

// ---------------------------------------------------------------- reconciliation

// past due for longer than the grace of its plan: suspended, until it is paid
export async function graceSweep() {
  const due = await db`select * from subscriptions where status = 'active' and payment->>'status' = 'past_due'
    and (payment->>'past_due_since')::timestamptz + make_interval(days => coalesce((payment->>'grace_days')::int, 7)) < now()`;
  for (const sub of due) {
    const ws = (await db`select * from workspaces where id = ${sub.workspace_id}`)[0];
    await subscriptions.applyPayment(system(ws, sub), sub, {
      status: 'suspended',
      payment: { suspended_for_payment: true },
      datesPatch: { suspended_at: new Date().toISOString() },
      review: { ...sub.review, suspension_message: `unpaid for ${sub.payment.grace_days ?? 7} days` },
      action: 'subscription.payment.suspended',
      summary: `subscription ${sub.id} suspended: the grace period of its plan is over`,
    });
  }
  return due.length;
}

// a webhook can be lost: every paid subscription is read again from Stripe
export async function reconcile({ workspaceId = null } = {}) {
  const p = paymentProvider();
  if (!p) return { checked: 0, changed: [] };
  const subs = await db`select * from subscriptions where payment->>'provider_subscription' is not null and status = any(${'{active,suspended,pending_payment}'}::text[])
    and (${workspaceId}::text is null or workspace_id = ${workspaceId})`;
  const changed = [];
  const errors = [];
  for (const sub of subs) {
    try {
      const s = await p.subscription(sub.payment.account, sub.payment.provider_subscription);
      if (s.status === sub.payment.stripe_status) continue;
      const ws = (await db`select * from workspaces where id = ${sub.workspace_id}`)[0];
      changed.push({ subscription: sub.id, outcome: await follow(ws, sub, s) });
    } catch (e) {
      errors.push({ subscription: sub.id, error: e.message });
    }
  }
  const suspended = await graceSweep();
  return { checked: subs.length, changed, errors, suspended };
}

export async function events(ws, { limit = 50, offset = 0, q = '' } = {}) {
  const account = accountOf(ws);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const where = () => db`(workspace_id = ${ws.id} or (${account}::text is not null and account = ${account}))
    and (${pattern}::text is null or type ilike ${pattern} or coalesce(outcome, '') ilike ${pattern} or coalesce(error, '') ilike ${pattern} or id ilike ${pattern})`;
  const [items, [{ total }]] = await Promise.all([
    db`select id, provider, account, type, subscription_id, received_at, processed_at, outcome, error from payment_events where ${where()} order by received_at desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from payment_events where ${where()}`,
  ]);
  return { items, total, limit, offset };
}

// ---------------------------------------------------------------- the fake provider's pages

export async function fakeAuthorize(query) {
  if (paymentProvider()?.name !== 'fake') throw notFound('no fake payments here');
  const code = Math.random().toString(36).slice(2, 14);
  return `${query.get('redirect_uri')}?${new URLSearchParams({ code, state: query.get('state') || '' })}`;
}

export function fakeCheckoutPage(id) {
  const p = paymentProvider();
  const s = p?.name === 'fake' ? p.sessions.get(id) : null;
  if (!s) throw notFound('no such checkout');
  const describe = (i) => (i.price_data ? `${(i.price_data.unit_amount / 100).toFixed(2)} ${i.price_data.currency.toUpperCase()} / ${i.price_data.recurring.interval}` : `${i.price}${i.quantity ? '' : ' (metered usage)'}`);
  const items = (s.lineItems || [s.lineItem]).map(describe).join('<br>');
  const name = (s.lineItems || [s.lineItem]).find((i) => i.price_data)?.price_data?.product_data?.name || '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fake Checkout</title>
<style>body{font:15px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#111}main{background:#fff;border:1px solid #ddd;border-radius:12px;padding:28px;max-width:420px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}button.pay{background:#0061bd;color:#fff;border-color:#0061bd}p{color:#555}</style></head>
<body><main><h1 style="margin-top:0">Fake Checkout</h1><p>Stands for Stripe Checkout in the development: no money is involved.</p>
<p><strong>${name.replace(/</g, '&lt;')}</strong><br>${String(items).replace(/</g, '&lt;').replace(/&lt;br>/g, '<br>')}</p>
<form method="post" action="/payments/fake/checkout/${s.id}/pay" style="display:inline"><button class="pay">Pay</button></form>
<form method="post" action="/payments/fake/checkout/${s.id}/cancel" style="display:inline;margin-left:8px"><button>Cancel</button></form></main></body></html>`;
}

// paid or cancelled: the event Stripe would send, received and handled as one, then back to the portal
export async function fakeCheckout(id, action) {
  const p = paymentProvider();
  const s = p?.name === 'fake' ? p.sessions.get(id) : null;
  if (!s) throw notFound('no such checkout');
  if (action !== 'pay') return s.cancelUrl;
  const event = p.pay(id);
  if (event) await store(p, event);
  return s.successUrl;
}

export { PaymentError };
