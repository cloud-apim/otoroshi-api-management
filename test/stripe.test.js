// The Stripe adapter against a local double of the Stripe api: what it sends (on behalf of the
// linked account, the pinned version, form encoded, idempotent), what it reads back, and the
// signatures of the webhooks. No infrastructure.
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { formEncode, lineItemOf, minorUnits, signPayload, stripeProvider, verifyWebhook } from '../server/payments/stripe.js';

let double;
const seen = [];
let portalConfigured = false;

beforeAll(() => {
  double = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? url.searchParams : new URLSearchParams(await req.text());
      seen.push({ method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers), body: Object.fromEntries(body) });
      const json = (o, status = 200) => Response.json(o, { status });
      if (url.pathname === '/oauth/token') return json({ stripe_user_id: 'acct_seller', livemode: false });
      if (url.pathname === '/v1/accounts/acct_seller') return json({ id: 'acct_seller', settings: { dashboard: { display_name: 'Seller Ltd' } } });
      if (url.pathname === '/v1/customers') return json({ id: 'cus_team' });
      if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
      if (url.pathname === '/v1/subscriptions/sub_1' && req.method === 'GET')
        return json({ id: 'sub_1', status: 'past_due', customer: 'cus_team', cancel_at_period_end: false, items: { data: [{ id: 'si_1', price: { product: 'prod_1' }, current_period_end: 1893456000 }] } });
      if (url.pathname === '/v1/subscriptions/sub_1') return json({ id: 'sub_1' });
      if (url.pathname === '/v1/billing_portal/sessions') return portalConfigured || body.get('configuration') ? json({ url: 'https://billing.stripe.test/p' }) : json({ error: { message: 'No configuration provided and your test mode default configuration has not been created.' } }, 400);
      if (url.pathname === '/v1/billing_portal/configurations') {
        portalConfigured = true;
        return json({ id: 'bpc_1' });
      }
      return json({ error: { message: 'no such route' } }, 404);
    },
  });
});
afterAll(() => double?.stop(true));

const provider = () => stripeProvider({ secretKey: 'sk_test_platform', clientId: 'ca_platform', apiVersion: '2025-03-31.basil', apiUrl: double.url.origin, connectUrl: double.url.origin, webhookSecret: 'whsec_x' });
const last = (path) => seen.filter((s) => s.path === path).pop();
const plan = { id: 'plan_premium', name: 'Premium', pricing: { kind: 'paid', amount: 49, currency: 'EUR', interval: 'month' } };

describe('the Stripe api', () => {
  test('a Stripe account is linked by OAuth, and named', async () => {
    const p = provider();
    expect(p.authorizeUrl({ state: 's1', redirectUri: 'https://apim/payments/stripe/callback' })).toBe(
      `${double.url.origin}/oauth/authorize?response_type=code&client_id=ca_platform&scope=read_write&state=s1&redirect_uri=https%3A%2F%2Fapim%2Fpayments%2Fstripe%2Fcallback`
    );
    expect(await p.exchange('code_1')).toEqual({ accountId: 'acct_seller', name: 'Seller Ltd', livemode: false });
    expect(last('/oauth/token').body).toEqual({ grant_type: 'authorization_code', code: 'code_1' });
  });

  test('a Checkout on the linked account: its key, its version, the price of the plan, idempotent', async () => {
    const out = await provider().checkout('acct_seller', {
      lineItem: lineItemOf(plan, 'Data 1.0.0 · Premium'),
      customer: 'cus_team',
      metadata: { apim_subscription_id: 'sub_apim' },
      reference: 'sub_apim',
      successUrl: 'https://portal/ok',
      cancelUrl: 'https://portal/ko',
      idempotencyKey: 'apim-checkout-sub_apim-1',
    });
    expect(out).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    const r = last('/v1/checkout/sessions');
    expect(r.headers).toMatchObject({ authorization: 'Bearer sk_test_platform', 'stripe-account': 'acct_seller', 'stripe-version': '2025-03-31.basil', 'idempotency-key': 'apim-checkout-sub_apim-1' });
    expect(r.body).toMatchObject({
      mode: 'subscription',
      customer: 'cus_team',
      client_reference_id: 'sub_apim',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': '4900',
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': 'Data 1.0.0 · Premium',
      'line_items[0][quantity]': '1',
      'metadata[apim_subscription_id]': 'sub_apim',
      'subscription_data[metadata][apim_subscription_id]': 'sub_apim',
    });
  });

  test('a subscription read back, its period; a price moved on the same product, prorated', async () => {
    expect(await provider().subscription('acct_seller', 'sub_1')).toMatchObject({ id: 'sub_1', status: 'past_due', customerId: 'cus_team', currentPeriodEnd: '2030-01-01T00:00:00.000Z', item: { id: 'si_1', product: 'prod_1' } });
    await provider().changePrice('acct_seller', 'sub_1', { ...plan, id: 'plan_gold', pricing: { ...plan.pricing, amount: 99 } }, 'Gold');
    const r = seen.filter((s) => s.path === '/v1/subscriptions/sub_1' && s.method === 'POST').pop();
    expect(r.body).toMatchObject({ 'items[0][id]': 'si_1', 'items[0][price_data][product]': 'prod_1', 'items[0][price_data][unit_amount]': '9900', proration_behavior: 'create_prorations' });
    await provider().cancel('acct_seller', 'sub_1');
    expect(seen.filter((s) => s.path === '/v1/subscriptions/sub_1').pop()).toMatchObject({ method: 'DELETE', headers: { 'stripe-account': 'acct_seller' } });
  });

  test('the portal of the customer: its configuration made when the account has none', async () => {
    expect(await provider().portalUrl('acct_seller', 'cus_team', 'https://portal/back')).toBe('https://billing.stripe.test/p');
    expect(last('/v1/billing_portal/configurations').body).toMatchObject({ 'features[invoice_history][enabled]': 'true', 'features[subscription_cancel][mode]': 'at_period_end' });
    expect(last('/v1/billing_portal/sessions').body).toMatchObject({ customer: 'cus_team', return_url: 'https://portal/back', configuration: 'bpc_1' });
  });

  test('a price named at Stripe is used as is; amounts in minor units', () => {
    expect(lineItemOf({ pricing: { priceRef: 'price_123' } }, 'x')).toEqual({ price: 'price_123', quantity: 1 });
    expect(minorUnits(49.9, 'EUR')).toBe(4990);
    expect(minorUnits(500, 'JPY')).toBe(500);
    expect(formEncode({ a: { b: [1, { c: 2 }] }, d: null }).toString()).toBe('a%5Bb%5D%5B0%5D=1&a%5Bb%5D%5B1%5D%5Bc%5D=2&d=');
  });
});

describe('the webhooks', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

  test('signed with the secret of the endpoint, recent: accepted', () => {
    expect(verifyWebhook(payload, signPayload('whsec_x', payload), 'whsec_x').id).toBe('evt_1');
    // several signatures while a secret rolls: one of them is enough
    const t = Math.floor(Date.now() / 1000);
    const header = `t=${t},v1=${'0'.repeat(64)},${signPayload('whsec_x', payload, t).split(',')[1]}`;
    expect(verifyWebhook(payload, header, 'whsec_x').id).toBe('evt_1');
  });

  test('unsigned, signed by another secret, changed, or too old: refused', () => {
    expect(() => verifyWebhook(payload, '', 'whsec_x')).toThrow(/not signed/);
    expect(() => verifyWebhook(payload, signPayload('whsec_other', payload), 'whsec_x')).toThrow(/signature/);
    expect(() => verifyWebhook(`${payload} `, signPayload('whsec_x', payload), 'whsec_x')).toThrow(/signature/);
    expect(() => verifyWebhook(payload, signPayload('whsec_x', payload, Math.floor(Date.now() / 1000) - 600), 'whsec_x')).toThrow(/too old/);
  });
});

describe('the configuration', () => {
  test('a provider set completely, never the fake one in production', async () => {
    const { checkPaymentsConfig } = await import('../server/payments/billing.js');
    const cfg = (provider, stripe = {}) => ({ payments: { provider, stripe: { secretKey: '', clientId: '', webhookSecret: '', ...stripe } } });
    expect(() => checkPaymentsConfig(cfg('off'), {})).not.toThrow();
    expect(() => checkPaymentsConfig(cfg('paypal'), {})).toThrow(/stripe, fake or off/);
    expect(() => checkPaymentsConfig(cfg('stripe', { secretKey: 'sk' }), {})).toThrow(/APIM_STRIPE_CLIENT_ID/);
    expect(() => checkPaymentsConfig(cfg('stripe', { secretKey: 'sk', clientId: 'ca', webhookSecret: 'wh' }), {})).not.toThrow();
    expect(() => checkPaymentsConfig(cfg('fake'), { NODE_ENV: 'production' })).toThrow(/refused/);
    expect(() => checkPaymentsConfig(cfg('fake'), {})).not.toThrow();
  });
});

