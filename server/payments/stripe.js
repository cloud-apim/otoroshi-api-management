// Stripe, through Stripe Connect: a workspace links its own Stripe account by OAuth, and the
// product keeps its id only — no key of it. The calls are made with the key of the installation,
// on behalf of the linked account (Stripe-Account). The http api on fetch, no SDK.
//
// A provider, the interface the product asks of a payment provider:
//   authorizeUrl({ state, redirectUri })      exchange(code) → { accountId, name, livemode }
//   deauthorize(accountId)
//   customer(accountId, { team, email, workspace })         the billing account of a team
//   checkout(accountId, { lineItem, customer, metadata, reference, successUrl, cancelUrl }) → { id, url }
//   subscription(accountId, id) → { id, status, customerId, currentPeriodEnd, cancelAtPeriodEnd }
//   portalUrl(accountId, customerId, returnUrl)              invoices, cards, cancellation
//   cancel(accountId, id)                                    at once
//   changePrice(accountId, id, lineItem)                     a move between paid plans, prorated
//   verifyEvent(payload, headers) → event                    its signature checked

import { createHmac, timingSafeEqual } from 'node:crypto';

export class PaymentError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// `{ a: { b: [1, { c: 2 }] } }` as `a[b][0]=1&a[b][1][c]=2`, the encoding of the Stripe api
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === null) out.append(name, '');
    else if (Array.isArray(value)) value.forEach((v, i) => (typeof v === 'object' && v !== null ? formEncode(v, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(v))));
    else if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export function signPayload(secret, payload, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
}

// a webhook, when its signature is the one of the endpoint's secret and it is recent enough (five
// minutes, against a replay)
export function verifyWebhook(payload, header, secret, { tolerance = 300, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) throw new PaymentError('the webhook secret is not set (APIM_STRIPE_WEBHOOK_SECRET)', 400);
  const parts = String(header || '')
    .split(',')
    .map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !signatures.length) throw new PaymentError('the webhook is not signed', 400);
  if (Math.abs(now - t) > tolerance) throw new PaymentError('the webhook is too old', 400);
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex'));
  if (!signatures.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected))) throw new PaymentError('the signature of the webhook is wrong', 400);
  return JSON.parse(payload);
}

// the currencies Stripe counts without decimals
const ZERO_DECIMAL = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'];
export const minorUnits = (amount, currency) => Math.round(Number(amount || 0) * (ZERO_DECIMAL.includes(String(currency).toLowerCase()) ? 1 : 100));

// the price of a plan: its price at Stripe when it names one, else the price the plan carries
export function lineItemOf(plan, productName, { product } = {}) {
  const p = plan.pricing || {};
  if (p.priceRef) return { price: p.priceRef, quantity: 1 };
  const recurring = { interval: p.interval || 'month' };
  const price_data = { currency: String(p.currency || 'EUR').toLowerCase(), unit_amount: minorUnits(p.amount, p.currency), recurring };
  // a subscription item names an existing product; a Checkout may describe a new one
  return { price_data: product ? { ...price_data, product } : { ...price_data, product_data: { name: productName } }, quantity: 1 };
}

// what a subscription to a plan is billed: its recurring price, and the metered price of its usage.
// A plan billed by its usage only has no recurring price
export function lineItemsOf(plan, productName, { product } = {}) {
  const p = plan.pricing || {};
  const usage = p.usage?.enabled ? p.usage : null;
  const flat = !usage || p.priceRef || Number(p.amount) > 0;
  // a metered item has no quantity: the meter says it
  return [...(flat ? [lineItemOf(plan, productName, { product })] : []), ...(usage ? [{ price: usage.priceRef }] : [])];
}

const date = (s) => (s ? new Date(Number(s) * 1000).toISOString() : null);

export function subscriptionOf(s) {
  const item = s.items?.data?.[0];
  return {
    id: s.id,
    status: s.status,
    customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id || null,
    currentPeriodEnd: date(item?.current_period_end || s.current_period_end),
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
    metadata: s.metadata || {},
    item: item ? { id: item.id, product: typeof item.price?.product === 'string' ? item.price.product : item.price?.product?.id } : null,
    items: (s.items?.data || []).map((i) => ({ id: i.id, price: i.price?.id || null, metered: i.price?.recurring?.usage_type === 'metered' })),
  };
}

export function stripeProvider(cfg, { fetchImpl = fetch } = {}) {
  async function call(method, path, params, { idempotencyKey, account, base = cfg.apiUrl } = {}) {
    if (!cfg.secretKey) throw new PaymentError('the Stripe key of the installation is not set (APIM_STRIPE_SECRET_KEY)', 503);
    const headers = { authorization: `Bearer ${cfg.secretKey}`, 'stripe-version': cfg.apiVersion };
    if (account) headers['stripe-account'] = account;
    let url = `${base}${path}`;
    let body;
    if (method === 'GET' || method === 'DELETE') {
      const qs = formEncode(params).toString();
      if (qs) url += `?${qs}`;
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = formEncode(params).toString();
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    }
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw new PaymentError(`Stripe is unreachable: ${e.message}`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {}
    if (!res.ok) throw new PaymentError(json?.error?.message || `Stripe answered ${res.status}`, res.status >= 500 ? 502 : 400);
    return json;
  }
  return {
    name: 'stripe',
    authorizeUrl({ state, redirectUri }) {
      return `${cfg.connectUrl}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, scope: 'read_write', state, redirect_uri: redirectUri })}`;
    },
    async exchange(code) {
      const token = await call('POST', '/oauth/token', { grant_type: 'authorization_code', code }, { base: cfg.connectUrl });
      const account = await call('GET', `/v1/accounts/${token.stripe_user_id}`).catch(() => null);
      return { accountId: token.stripe_user_id, name: account?.settings?.dashboard?.display_name || account?.business_profile?.name || account?.email || null, livemode: !!token.livemode };
    },
    async deauthorize(accountId) {
      await call('POST', '/oauth/deauthorize', { client_id: cfg.clientId, stripe_user_id: accountId }, { base: cfg.connectUrl }).catch(() => null);
    },
    async customer(accountId, { team, email, workspace }) {
      const c = await call('POST', '/v1/customers', { name: team.name, email, metadata: { apim_team_id: team.id, apim_workspace: workspace.slug } }, { account: accountId, idempotencyKey: `apim-customer-${accountId}-${team.id}` });
      return c.id;
    },
    async checkout(accountId, { lineItems, customer, metadata, reference, successUrl, cancelUrl, idempotencyKey }) {
      const s = await call(
        'POST',
        '/v1/checkout/sessions',
        { mode: 'subscription', line_items: lineItems, customer, client_reference_id: reference, success_url: successUrl, cancel_url: cancelUrl, metadata, subscription_data: { metadata } },
        { account: accountId, idempotencyKey }
      );
      return { id: s.id, url: s.url };
    },
    async subscription(accountId, id) {
      return subscriptionOf(await call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`, {}, { account: accountId }));
    },
    // the portal of Stripe for the customer, on the linked account: its configuration made the
    // first time, when the account has none
    async portalUrl(accountId, customerId, returnUrl) {
      const open = (configuration) => call('POST', '/v1/billing_portal/sessions', { customer: customerId, return_url: returnUrl, configuration }, { account: accountId });
      try {
        return (await open(undefined)).url;
      } catch (e) {
        if (!/configuration/i.test(e.message)) throw e;
        const made = await call(
          'POST',
          '/v1/billing_portal/configurations',
          { features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: 'at_period_end' } }, metadata: { apim: 'portal' } },
          { account: accountId, idempotencyKey: `apim-portal-configuration-${accountId}` }
        );
        return (await open(made.id)).url;
      }
    },
    async cancel(accountId, id) {
      await call('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`, {}, { account: accountId });
    },
    async changePrice(accountId, id, plan, productName) {
      const s = await this.subscription(accountId, id);
      if (!s.item) throw new PaymentError(`the Stripe subscription ${id} has no item`, 400);
      // a recurring price for a recurring price: the item changes its price. Otherwise the items of the
      // subscription are replaced by the ones of the plan (a metered price comes or goes)
      const simple = s.items.length <= 1 && !s.items[0]?.metered && !plan.pricing?.usage?.enabled;
      const items = simple
        ? [{ id: s.item.id, ...lineItemOf(plan, productName, { product: s.item.product }) }]
        : [...s.items.map((i) => ({ id: i.id, deleted: true })), ...lineItemsOf(plan, productName, { product: s.item.product })];
      await call('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, { items, proration_behavior: 'create_prorations' }, { account: accountId, idempotencyKey: `apim-price-${id}-${plan.id}` });
    },
    // the usage of a subscription, a batch at a time, to the meter of the linked account: the
    // identifier is the report's, so that a report sent twice is counted once
    canMeter: true,
    async reportUsage(accountId, { eventName, customer, value, identifier, timestamp }) {
      const e = await call(
        'POST',
        '/v1/billing/meter_events',
        { event_name: eventName, payload: { stripe_customer_id: customer, value: String(value) }, identifier, timestamp: Math.floor(new Date(timestamp).getTime() / 1000) },
        { account: accountId, idempotencyKey: `apim-usage-${identifier}` }
      );
      return { identifier: e?.identifier || identifier };
    },
    verifyEvent(payload, headers) {
      return verifyWebhook(payload, headers.get('stripe-signature'), cfg.webhookSecret);
    },
  };
}
