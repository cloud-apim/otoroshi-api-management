// The demo, second half: what the screens have to show beyond the apis themselves, idempotently.
//  - the gateway caught up: a gateway that lost its state (a reset, another one) misses what was
//    deployed, so what the drift detection finds missing is deployed again (the snapshot that ran)
//    and provisioned again
//  - an event-driven api with its AsyncAPI specification, a dictionary, a shared authorization server
//  - the catalogue of the portal: categories, a featured api, a review
//  - activity for every dashboard: calls through the gateway now (statuses mixed), and fourteen days
//    of calls and of security events fed to the ingester once, as the data exporter would have
const URL = (process.env.APIM_URL || 'http://localhost:9000').replace(/\/$/, '');
const TOKEN = process.env.APIM_TOKEN || 'apim-admin-token';
const INGEST = process.env.APIM_INGEST_TOKEN || 'ingest-secret';
const GATEWAY = (process.env.APIM_DEMO_GATEWAY || 'http://localhost:8080').replace(/\/$/, '');
const CONSUMER = { email: process.env.APIM_PORTAL_EMAIL || 'carol@shop.test', password: process.env.APIM_PORTAL_PASSWORD || 'carol-password' };
const IDP = 'http://oidc.oto.tools:8090/default';
const DAY = 86400e3;

async function call(method, path, body) {
  const res = await fetch(`${URL}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error || ''}`);
  return data;
}
const W = '/workspaces/default';
// a pseudo-random sequence, the same at each run: the history looks the same every time
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (list) => list[Math.floor(rnd() * list.length)];

// ---------------------------------------------------------------- the gateway caught up
// what the gateway lost, as the drift detection sees it: an api deployed again on the snapshot that
// ran, then the keys of its subscriptions
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the workspaces of the demo (the showcase made after this script, on a first run: nothing to catch up)
for (const ws of ['default', 'gitops', 'showcase']) {
  const found = await call('POST', `/workspaces/${ws}/drift`).catch(() => null);
  if (!found?.missing) continue;
  const reports = await call('GET', `/workspaces/${ws}/drift`);
  const missing = (kind) => reports.filter((r) => r.entity_kind === kind && r.status === 'missing').map((r) => r.entity_id);
  for (const id of missing('api')) {
    const a = await call('GET', `/workspaces/${ws}/apis/${id}`);
    const running = a.deployment?.current?.snapshot_number;
    if (!running) continue;
    await call('POST', `/workspaces/${ws}/apis/${id}/deploy`, { snapshot: running }).catch((e) => console.log(`${ws.padEnd(9)} api ${a.slug}: ${e.message}`));
    console.log(`${ws.padEnd(9)} api ${a.slug} ${a.version}: snapshot #${running} deployed again, the gateway had lost it`);
  }
  if (missing('api').length) await sleep(3000);
  for (const id of missing('subscription')) await call('POST', `/workspaces/${ws}/subscriptions/${id}/resync`).catch(() => null);
  if (missing('subscription').length) console.log(`${ws.padEnd(9)} ${missing('subscription').length} keys provisioned again on the gateway`);
}

// ---------------------------------------------------------------- an event-driven api
const ASYNCAPI = `asyncapi: 3.0.0
info:
  title: Orders events
  version: 1.0.0
  description: |
    The events of the order lifecycle. **Subscribe** to the orders the shop takes, **send** the returns.
servers:
  kafka:
    host: kafka.internal:9092
    protocol: kafka
channels:
  orders:
    address: orders.created
    description: One event per order, once it is paid.
    messages:
      created:
        $ref: '#/components/messages/OrderCreated'
  returns:
    address: returns.requested
    messages:
      requested:
        $ref: '#/components/messages/ReturnRequested'
operations:
  publishOrders:
    action: send
    channel:
      $ref: '#/channels/orders'
    summary: The api publishes the orders it took.
  takeReturns:
    action: receive
    channel:
      $ref: '#/channels/returns'
    summary: A consumer asks for the return of an order.
components:
  messages:
    OrderCreated:
      name: OrderCreated
      title: An order was created
      contentType: application/json
      payload:
        $ref: '#/components/schemas/Order'
      examples:
        - payload: { id: ord_42, total: 49.9, currency: EUR }
    ReturnRequested:
      name: ReturnRequested
      title: A return is requested
      contentType: application/json
      payload:
        type: object
        properties:
          order: { type: string }
          reason: { type: string }
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
        total: { type: number }
        currency: { type: string }
`;
let orders = (await call('GET', `${W}/apis`)).find((a) => a.slug === 'orders-events');
if (!orders) {
  const team = (await call('GET', `${W}/teams`)).find((t) => !t.personal);
  const created = await call('POST', `${W}/apis`, {
    name: 'Orders events',
    version: '1.0.0',
    description: 'The events of the order lifecycle, through the gateway',
    team_id: team?.id,
    domain: 'orders-events.oto.tools',
    contextPath: '/',
  });
  const draft = created.draft;
  draft.plans = [{ ...draft.plans[0], name: 'Events', status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  draft.asyncapi = { format: 'yaml', content: ASYNCAPI };
  await call('PUT', `${W}/apis/${created.id}/draft`, { draft });
  await call('POST', `${W}/apis/${created.id}/publish`, { comment: 'its events', deploy: true });
  orders = created;
  console.log('default   api orders-events 1.0.0: created with its AsyncAPI specification, deployed');
}

// ---------------------------------------------------------------- a dictionary, a shared resource
if (!(await call('GET', `${W}/dictionaries`)).some((d) => d.name === 'regions')) {
  await call('POST', `${W}/dictionaries`, {
    name: 'regions',
    description: 'the backend of each region, and its limits',
    entries: { eu: 'https://eu.backend.internal', us: 'https://us.backend.internal', limits: { eu: 1000, us: 500 } },
  });
  console.log('default   dictionary regions: projected into the global env of the gateway');
}
let idp = (await call('GET', `${W}/shared-resources`)).find((r) => r.name === 'Demo identity provider');
if (!idp) {
  idp = await call('POST', `${W}/shared-resources`, {
    name: 'Demo identity provider',
    description: 'the identity provider of the development stack',
    kind: 'authorization-server',
    content: { issuer: IDP, jwksUrl: `${IDP}/jwks`, discoveryUrl: `${IDP}/.well-known/openid-configuration`, userInfoUrl: `${IDP}/userinfo`, scope: 'openid' },
  });
  await call('POST', `${W}/shared-resources/${idp.id}/publish`, { comment: 'the development identity provider' });
  console.log('default   shared resource Demo identity provider: v1 published');
}
// an api whose partners sign in with it pins v1; a v2 asks for the profile too: the api is behind
const ordersApi = await call('GET', `${W}/apis/orders-events`);
if (!ordersApi.draft.plans.some((p) => p.auth?.config?.sharedResource)) {
  const draft = ordersApi.draft;
  draft.plans.push({
    id: 'plan_orders_partners',
    name: 'Partners (SSO)',
    description: 'The partners sign in with the identity provider of the company.',
    status: 'published',
    validation: 'manual',
    auth: { kind: 'oauth2-remote', config: { clientIdPath: 'sub', audiences: ['orders-events'], sharedResource: { id: idp.id, version: 1 } } },
  });
  await call('PUT', `${W}/apis/${ordersApi.id}/draft`, { draft });
  await call('POST', `${W}/apis/${ordersApi.id}/publish`, { comment: 'the partners sign in with the identity provider', deploy: true });
  console.log('default   api orders-events: a Partners (SSO) plan pinning Demo identity provider v1');
}
if ((await call('GET', `${W}/shared-resources/${idp.id}`)).versions.length < 2) {
  const { draft } = await call('GET', `${W}/shared-resources/${idp.id}`);
  await call('PUT', `${W}/shared-resources/${idp.id}`, { content: { ...draft, scope: 'openid profile' } });
  await call('POST', `${W}/shared-resources/${idp.id}/publish`, { comment: 'the profile scope too' });
  console.log('default   shared resource Demo identity provider: v2 published, orders-events behind');
}

// ---------------------------------------------------------------- the catalogue of the portal
const ws = await call('GET', W);
if (!(ws.portal?.categories || []).length) {
  await call('PUT', W, {
    portal: {
      categories: [
        { slug: 'retail', name: { en: 'Retail', fr: 'Commerce' } },
        { slug: 'events', name: { en: 'Events', fr: 'Événements' } },
      ],
    },
  });
  const apis = await call('GET', `${W}/apis`);
  const place = async (slug, body) => {
    const a = apis.find((x) => x.slug === slug);
    if (a) await call('PUT', `${W}/apis/${a.id}/placement`, body);
  };
  await place('books', { categories: ['retail'], featured: true });
  await place('petstore', { categories: ['retail'] });
  await place('orders-events', { categories: ['events'] });
  console.log('default   portal categories: Retail (books featured, petstore), Events (orders-events)');
}
// a review of a consumer who subscribed
const login = await fetch(`${URL}/default/front/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CONSUMER) });
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (login.ok && cookie) {
  const reviews = await (await fetch(`${URL}/default/front/api/apis/books/reviews`, { headers: { cookie } })).json().catch(() => null);
  if (reviews?.can_review && !reviews.reviews.some((r) => r.mine)) {
    await fetch(`${URL}/default/front/api/apis/books/reviews/mine`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ rating: 4, comment: 'Clear documentation, quick to start with. The search could take more filters.' }),
    });
    console.log('default   a review of books by its consumer');
  }
}
// an announcement of books, its subscribers told: once
const announced = await call('GET', `${W}/apis/books/announcements`).catch(() => []);
if (Array.isArray(announced) && !announced.length) {
  await call('POST', `${W}/apis/books/announcements`, {
    title: 'Search by author, from June',
    body: 'The \`/books\` resource takes an \`author\` parameter from **June 2**: no change for the calls that do not use it.\n\nThe plans and their quotas stay the same.',
  });
  console.log('default   an announcement of books, its subscribers told');
}

// ---------------------------------------------------------------- activity
// the apis whose subscriptions call: their base url, their paths, the keys of their consumers
const apis = await call('GET', `${W}/apis`);
const callers = [];
for (const s of (await call('GET', `${W}/subscriptions`)).filter((x) => x.status === 'active' && x.auth_kind === 'apikey')) {
  const a = await call('GET', `${W}/apis/${s.api_id}`);
  const detail = await call('GET', `${W}/subscriptions/${s.id}`);
  // the key in use: a rotation leaves the revoked ones in the list
  const key = detail.credentials?.find((c) => c.status === 'active');
  if (!key) continue;
  const base = new globalThis.URL(a.base_url);
  const paths = a.draft.resources.filter((r) => r.enabled !== false).map((r) => r.path.replace(/\{[^}]+\}/g, '42'));
  callers.push({ sub: s, api: a, key, base, paths: paths.length ? paths : ['/'] });
}

// calls through the gateway now, the status asked of the echo backend: the statuses of a healthy api,
// mostly answered, a few not found or refused, rarely failing. The consumers take turns, a few calls a
// second each, under the rate limit of their plan
const STATUSES = [...Array(84).fill(200), 201, 201, 204, 204, 304, 304, 400, 404, 404, 404, 401, 429, 429, 500, 503, 502];
let live = 0;
// a caller without a key, once per api: refused by the gateway
for (const base of new Set(callers.map((c) => c.base.href)))
  await fetch(`${GATEWAY}${new globalThis.URL(base).pathname}`, { headers: { Host: new globalThis.URL(base).hostname } }).catch(() => null);
for (let i = 0; i < 12; i++) {
  for (const c of callers) {
    const status = pick(STATUSES);
    const path = `${c.base.pathname.replace(/\/$/, '')}${pick(c.paths)}`.replace(/\/+/g, '/');
    await fetch(`${GATEWAY}${path}?page=${1 + (i % 4)}`, {
      headers: {
        Host: c.base.hostname,
        'Otoroshi-Client-Id': c.key.client_id,
        'Otoroshi-Client-Secret': c.key.client_secret,
        'User-Agent': 'demo-client/1.0',
        ...(status !== 200 ? { 'x-set-response-status-code': String(status) } : {}),
      },
    }).catch(() => null);
    live++;
  }
  await sleep(400);
}
console.log(`default   ${live} calls through the gateway, exported to the ingester`);

async function ingest(events) {
  for (let i = 0; i < events.length; i += 500) {
    const res = await fetch(`${URL}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST}` },
      body: events
        .slice(i, i + 500)
        .map((e) => JSON.stringify(e))
        .join('\n'),
    });
    if (!res.ok) throw new Error(`ingest: ${res.status}`);
  }
}

// fourteen days of history, fed once: the calls of each consumer, by day and by hour, with the
// rhythm of a working week, up to an hour ago
const past = await call('GET', `${W}/analytics?from=${new Date(Date.now() - 14 * DAY).toISOString()}&to=${new Date(Date.now() - DAY).toISOString()}`);
if (past.totals.calls < 1000 && callers.length) {
  const events = [];
  const now = Date.now();
  let n = 0;
  for (let d = 14; d >= 0; d--) {
    const day = new Date(now - d * DAY);
    const weekend = [0, 6].includes(day.getUTCDay());
    for (const c of callers) {
      const volume = Math.round((weekend ? 30 : 110) * (0.6 + rnd()) * (c.api.slug === 'books' ? 1.6 : 1));
      for (let i = 0; i < volume; i++) {
        const hour = Math.min(23, Math.max(0, Math.round(8 + rnd() * 10 + (rnd() - 0.5) * 6)));
        const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, Math.floor(rnd() * 60), Math.floor(rnd() * 60));
        if (at > now - 3600e3) continue;
        const status = pick(STATUSES);
        // a few tens of milliseconds, a long tail, a failure slower
        const backend = status >= 500 ? Math.round(300 + rnd() * 900) : Math.round(12 + rnd() * 40 + (rnd() < 0.08 ? rnd() * 400 : 0));
        const path = `${c.base.pathname.replace(/\/$/, '')}${pick(c.paths)}`.replace(/\/+/g, '/');
        events.push({
          '@type': 'GatewayEvent',
          '@id': `demo-${c.sub.id}-${d}-${i}`,
          '@timestamp': at,
          reqId: `demo-${c.sub.id.slice(-8)}-${d}-${i}`,
          url: `http://${c.base.host}${path}?page=${1 + (i % 4)}`,
          method: pick(['GET', 'GET', 'GET', 'GET', 'POST', 'PUT']),
          from: `203.0.113.${1 + Math.floor(rnd() * 200)}`,
          status,
          duration: backend + 2,
          overhead: 1 + Math.round(rnd() * 3),
          backendDuration: backend,
          data: { dataIn: Math.round(rnd() * 400), dataOut: Math.round(200 + rnd() * 4000) },
          headers: [{ key: 'User-Agent', value: pick(['demo-client/1.0', 'curl/8.9', 'Mozilla/5.0']) }],
          identity: {
            identityType: 'APIKEY',
            identity: c.key.client_id,
            label: c.sub.application_name,
            metadata: {},
            apiRef: { api: c.api.id, plan: c.sub.plan_id, sub: c.sub.id },
          },
          route: { id: `demo_route_${c.api.id}`, name: c.api.name, metadata: { 'Otoroshi-Api-Ref': c.api.id } },
          err: false,
        });
        n++;
      }
    }
  }
  // the security events of the Threat Protection Suite on the most called api, a few a day
  const target = callers.find((c) => c.api.slug === 'books') || callers[0];
  const kinds = [
    ['waf', 'deny', 'blocked', 'SQL injection in the query string'],
    ['waf', 'log', 'observed', 'rules matched without blocking'],
    ['bots', 'log', 'observed', 'an automated client'],
    ['reputation', 'deny', 'blocked', 'an address on a threat feed'],
    ['threat', 'deny', 'blocked', 'score 95 reached tier 90 (deny)'],
  ];
  const security = [];
  for (let d = 14; d >= 1; d--)
    for (let i = 0; i < 3 + Math.floor(rnd() * 6); i++) {
      const [category, action, outcome, message] = pick(kinds);
      const c = pick(callers.filter((x) => x.api.id === target.api.id));
      security.push({
        '@type': 'CloudApimSecurityEvent',
        '@id': `demo-sec-${d}-${i}`,
        '@timestamp': now - d * DAY + Math.floor(rnd() * DAY),
        event: { kind: 'alert', module: 'cloud-apim.security-suite', dataset: `cloud-apim.${category}`, category, action, outcome, severity: action === 'deny' ? 7 : 3 },
        source: { ip: `198.51.100.${1 + Math.floor(rnd() * 200)}`, apikey: rnd() < 0.7 ? c.key.client_id : null, user: null },
        threat: { score: action === 'deny' ? 90 + Math.floor(rnd() * 10) : 45, tags: [`${category}:${action}`], signals: [] },
        otoroshi: { route_id: `demo_route_${c.api.id}`, route_name: c.api.name, node: 'demo', tenant: 'default', teams: ['default'], api_id: c.api.id, groups: [] },
        incident: { id: `demo-incident-${d}`, count: 1 },
        message,
      });
    }
  await ingest(events);
  await ingest(security);
  console.log(`default   ${n} calls and ${security.length} security events of the last fourteen days, fed to the ingester`);
}
