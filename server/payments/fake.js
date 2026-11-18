// Stripe, as the development and the tests see it: the link of an account answers at once, a
// Checkout is a page of the product that pays or cancels, and the events are the ones Stripe would
// send — signed with the webhook secret, or `whsec_fake`, and received on the same endpoint.

import { randomBytes } from 'node:crypto';
import { PaymentError, verifyWebhook } from './stripe.js';

export const FAKE_SECRET = 'whsec_fake';
const token = (n) => randomBytes(n).toString('hex').slice(0, n);

export function fakeProvider(cfg, { publicUrl }) {
  const sessions = new Map();
  const subscriptions = new Map();
  const secret = cfg.webhookSecret || FAKE_SECRET;
  const event = (account, type, object) => ({ id: `evt_fake_${token(12)}`, object: 'event', type, account, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
  const subscriptionObject = (s) => ({
    id: s.id,
    object: 'subscription',
    status: s.status,
    customer: s.customerId,
    cancel_at_period_end: false,
    metadata: s.metadata,
    items: { data: [{ id: `si_fake_${s.id}`, price: { product: `prod_fake_${s.id}` }, current_period_end: Math.floor(s.currentPeriodEnd.getTime() / 1000) }] },
  });
  return {
    name: 'fake',
    secret,
    sessions,
    subscriptions,
    authorizeUrl: ({ state, redirectUri }) => `${publicUrl}/payments/fake/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`,
    exchange: async (code) => ({ accountId: `acct_fake_${String(code).slice(0, 12)}`, name: 'Fake Stripe account', livemode: false }),
    deauthorize: async () => {},
    customer: async (accountId, { team }) => `cus_fake_${team.id.slice(-12)}`,
    async checkout(accountId, { lineItem, customer, metadata, successUrl, cancelUrl }) {
      const id = `cs_fake_${token(12)}`;
      sessions.set(id, { id, accountId, lineItem, customer, metadata, successUrl, cancelUrl, status: 'open' });
      return { id, url: `${publicUrl}/payments/fake/checkout/${id}` };
    },
    async subscription(accountId, id) {
      const s = subscriptions.get(id);
      if (!s || s.accountId !== accountId) throw new PaymentError('no such subscription', 404);
      return { id, status: s.status, customerId: s.customerId, currentPeriodEnd: s.currentPeriodEnd.toISOString(), cancelAtPeriodEnd: false, metadata: s.metadata };
    },
    portalUrl: async (accountId, customerId, returnUrl) => `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}stripe-portal=fake`,
    async cancel(accountId, id) {
      const s = subscriptions.get(id);
      if (s) s.status = 'canceled';
    },
    async changePrice(accountId, id, plan) {
      const s = subscriptions.get(id);
      if (s) s.plan = plan.id;
    },
    verifyEvent: (payload, headers) => verifyWebhook(payload, headers.get('stripe-signature'), secret),

    // a Checkout paid: its subscription made, and the event Stripe sends for it
    pay(sessionId) {
      const s = sessions.get(sessionId);
      if (!s || s.status !== 'open') return null;
      s.status = 'complete';
      const sub = { id: `sub_fake_${token(12)}`, accountId: s.accountId, customerId: s.customer, status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86400 * 1000), metadata: s.metadata };
      subscriptions.set(sub.id, sub);
      return event(s.accountId, 'checkout.session.completed', { id: s.id, object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', client_reference_id: s.metadata.apim_subscription_id, subscription: sub.id, customer: sub.customerId, metadata: s.metadata });
    },
    // a subscription changed on the linked account (a status, or deleted): the event Stripe sends
    change(subscriptionId, status) {
      const sub = subscriptions.get(subscriptionId);
      if (!sub) return null;
      sub.status = status;
      return event(sub.accountId, status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated', subscriptionObject(sub));
    },
    event,
  };
}
