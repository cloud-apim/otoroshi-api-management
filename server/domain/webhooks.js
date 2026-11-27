// Outgoing webhooks: the events of a workspace — what its audit trail records — sent to the endpoints
// its administrators declare, each one filtered by the types of event it takes.
//
// Signed as Standard Webhooks (v1): `webhook-id` (the same on every attempt: an idempotency key),
// `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`, a `whsec_`
// secret per endpoint — sealed at rest —, the previous one signing beside it for a day after a rotation.
// A signature over the timestamp too, unlike a signature of the body alone: a request captured is not
// replayed for ever, its receiver refuses it a few minutes on.
//
// Never in the request path: a worker fans the new events of the trail out into deliveries — a cursor
// per endpoint, nothing lost while it is down —, then sends what is due. A delivery is tried at once,
// then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h later; only a 2xx within 15 s succeeds, a redirect
// fails, a Retry-After is honoured, a 410 Gone turns the endpoint off. Its attempts spent, it is kept
// — 30 days — and replayed by hand; the administrators of the workspace are told once. An endpoint
// failing for 5 days in a row is turned off. Endpoints on a private network are refused unless the
// installation allows them (APIM_WEBHOOKS_ALLOW_PRIVATE).

import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { db, newId } from '../db/index.js';
import { badRequest, notFound } from '../http/router.js';
import { likePattern } from '../http/paging.js';
import { audit } from './audit.js';
import { open, seal } from './secrets.js';
import { maskSecret } from './identity.js';
import { notifyApiTeam } from './notifications.js';

export const RETRY_DELAYS_MS = [5, 300, 1800, 7200, 18000, 36000, 36000].map((s) => s * 1000);
export const ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const TIMEOUT_MS = 15000;
export const KEEP_DAYS = 30;
export const DISABLE_AFTER_MS = 5 * 86400e3;
export const ROTATION_MS = 86400e3;
const RETRY_AFTER_MAX_MS = 86400e3;
const PAYLOAD_MAX = 20000;
const RESPONSE_MAX = 1000;

// ---------------------------------------------------------------- signature

export const newSecret = () => `whsec_${randomBytes(32).toString('base64')}`;
const keyOf = (secret) => Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');

// Standard Webhooks v1: base64 of HMAC-SHA256(key, "id.timestamp.body"), the key the base64 after whsec_
export function sign(secret, id, timestamp, body) {
  return createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
}

// ---------------------------------------------------------------- what an endpoint takes

// a read of the trail (a credential read, a request log exported) only when named: '*' is every write
const READS = /\.(read|export)$/;
export function matches(types, action) {
  return (types || []).some((t) => t === action || (t === '*' && !READS.test(action)) || (t.endsWith('.*') && action.startsWith(t.slice(0, -1))));
}

// a text[] for Postgres: the types are checked, quoted all the same
const pgArray = (list) => `{${list.map((t) => `"${t}"`).join(',')}}`;

function checkedTypes(types) {
  const list = [...new Set((Array.isArray(types) ? types : String(types || '').split(',')).map((t) => String(t).trim()).filter(Boolean))];
  if (!list.length) throw badRequest('a webhook takes one type of event at least: an action of the audit trail, a family (subscription.*), or * for every write');
  for (const t of list) if (!/^(\*|[a-z0-9_-]+(\.[a-z0-9_-]+)*(\.\*)?)$/.test(t)) throw badRequest(`not a type of event: ${t}`);
  return list;
}

// ---------------------------------------------------------------- where it is sent

function privateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

// an http(s) url, no credentials in it, and — unless the installation allows it — not on a private
// network: checked when it is set, and again before each attempt (a name may resolve elsewhere later)
export async function checkUrl(url, { allowPrivate = config.webhooks.allowPrivate } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw badRequest('the url of a webhook: an http or https url');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('the url of a webhook: an http or https url');
  if (u.username || u.password) throw badRequest('no credentials in the url of a webhook: its signature authenticates it');
  if (allowPrivate) return u.toString();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw badRequest(`${host} resolves to no address`);
  if (host === 'localhost' || addresses.some(privateAddress))
    throw badRequest(`${host} is on a private network: refused, unless the installation allows it (APIM_WEBHOOKS_ALLOW_PRIVATE)`);
  return u.toString();
}

// ---------------------------------------------------------------- endpoints

// an endpoint as shown: its secret masked, what it holds of deliveries
const view = (e) => {
  const { secret, previous_secret, cursor, ...rest } = e;
  return { ...rest, secret: maskSecret(open(secret)), rotating: !!(previous_secret && e.previous_until && new Date(e.previous_until) > new Date()) };
};

export async function listEndpoints(workspaceId) {
  const rows = await db`select e.*,
      (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pending') as pending,
      (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'failed') as failed,
      (select max(d.delivered_at) from webhook_deliveries d where d.endpoint_id = e.id) as last_success
    from webhook_endpoints e where e.workspace_id = ${workspaceId} order by e.name`;
  return rows.map(view);
}

export async function getEndpoint(workspaceId, id) {
  const row = (await db`select * from webhook_endpoints where workspace_id = ${workspaceId} and id = ${id}`)[0];
  if (!row) throw notFound('webhook not found');
  return row;
}

export const showEndpoint = (e) => view(e);

// created on the events that come next; its secret shown once here, and on demand afterwards
export async function createEndpoint(ctx, workspaceId, input = {}) {
  const name = String(input.name || '').trim() || 'webhook';
  const url = await checkUrl(String(input.url || ''));
  const types = checkedTypes(input.types ?? ['*']);
  const secret = newSecret();
  const id = newId('whk');
  await db`insert into webhook_endpoints (id, workspace_id, name, url, secret, types, enabled)
    values (${id}, ${workspaceId}, ${name}, ${url}, ${seal(secret)}, ${pgArray(types)}::text[], ${input.enabled !== false})`;
  await audit(ctx, { action: 'webhook.create', workspaceId, entityKind: 'webhook', entityId: id, summary: `webhook ${name} created: ${url}, ${types.join(', ')}` });
  // from the events after its own creation
  const rows = await db`update webhook_endpoints set cursor = (select coalesce(max(id), 0) from audit_events) where id = ${id} returning *`;
  return { ...view(rows[0]), secret };
}

export async function updateEndpoint(ctx, endpoint, patch = {}) {
  const name = patch.name !== undefined ? String(patch.name).trim() || endpoint.name : endpoint.name;
  const url = patch.url !== undefined ? await checkUrl(String(patch.url)) : endpoint.url;
  const types = patch.types !== undefined ? checkedTypes(patch.types) : endpoint.types;
  const enabled = patch.enabled !== undefined ? !!patch.enabled : endpoint.enabled;
  const turnedOn = enabled && !endpoint.enabled;
  const rows = await db`update webhook_endpoints set name = ${name}, url = ${url}, types = ${pgArray(types)}::text[], enabled = ${enabled},
      disabled_reason = ${enabled ? null : endpoint.disabled_reason || 'turned off'},
      failing_since = ${turnedOn ? null : endpoint.failing_since}, told_at = ${turnedOn ? null : endpoint.told_at}, updated_at = now()
    where id = ${endpoint.id} returning *`;
  if (!enabled && endpoint.enabled) await turnOff(endpoint.id, 'the webhook was turned off');
  await audit(ctx, { action: 'webhook.update', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `webhook ${name} updated${turnedOn ? ', turned on' : !enabled && endpoint.enabled ? ', turned off' : ''}` });
  return view(rows[0]);
}

export async function deleteEndpoint(ctx, endpoint) {
  await db`delete from webhook_endpoints where id = ${endpoint.id}`;
  await audit(ctx, { action: 'webhook.delete', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `webhook ${endpoint.name} deleted` });
}

export async function revealSecret(ctx, endpoint) {
  await audit(ctx, { action: 'webhook.secret.read', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `secret of the webhook ${endpoint.name} read` });
  return { secret: open(endpoint.secret) };
}

// a new secret; the previous one still signs beside it for a day, the time for the receiver to take it
export async function rotateSecret(ctx, endpoint) {
  const secret = newSecret();
  await db`update webhook_endpoints set previous_secret = ${endpoint.secret}, previous_until = ${new Date(Date.now() + ROTATION_MS)},
      secret = ${seal(secret)}, updated_at = now() where id = ${endpoint.id}`;
  await audit(ctx, { action: 'webhook.secret.rotate', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `secret of the webhook ${endpoint.name} rotated: the previous one signs for a day more` });
  return { secret, previous_until: new Date(Date.now() + ROTATION_MS) };
}

// ---------------------------------------------------------------- deliveries

// the event as it is sent: { type, timestamp, workspace, data } — its summary, the entity, the actor,
// what the trail keeps of it; never the address of the actor
export function payloadOf(ws, e) {
  const payload = {
    type: e.action,
    timestamp: new Date(e.at).toISOString(),
    workspace: { id: ws.id, slug: ws.slug },
    data: {
      event_id: Number(e.id),
      summary: e.summary,
      entity: e.entity_kind ? { kind: e.entity_kind, id: e.entity_id } : null,
      actor: { id: e.actor?.id || null, email: e.actor?.email || null, via: e.actor?.via || null },
      details: e.data || {},
    },
  };
  if (JSON.stringify(payload).length > PAYLOAD_MAX) payload.data.details = { truncated: true };
  return payload;
}

// the new events of the trail, into the deliveries of each endpoint that takes them — the endpoints on,
// or the one named, on or not, its deliveries due at `nextAt`
export async function fanOut({ endpointId = null, nextAt = null } = {}) {
  let made = 0;
  const endpoints = endpointId ? await db`select * from webhook_endpoints where id = ${endpointId}` : await db`select * from webhook_endpoints where enabled`;
  for (const ep of endpoints) {
    const events = await db`select * from audit_events where workspace_id = ${ep.workspace_id} and id > ${ep.cursor} order by id limit 500`;
    if (!events.length) continue;
    const ws = (await db`select id, slug from workspaces where id = ${ep.workspace_id}`)[0];
    const taken = events.filter((e) => matches(ep.types, e.action));
    await db.begin(async (tx) => {
      for (const e of taken) {
        const r = await tx`insert into webhook_deliveries (id, endpoint_id, workspace_id, event_id, type, payload, next_at)
          values (${newId('msg')}, ${ep.id}, ${ep.workspace_id}, ${e.id}, ${e.action}, ${payloadOf(ws, e)}, ${nextAt || new Date()})
          on conflict (endpoint_id, event_id) where event_id is not null do nothing returning id`;
        made += r.length;
      }
      await tx`update webhook_endpoints set cursor = greatest(cursor, ${events.at(-1).id}) where id = ${ep.id}`;
    });
  }
  return made;
}

const retryAfterMs = (value) => {
  if (!value) return null;
  const s = Number(value);
  const ms = Number.isFinite(s) ? s * 1000 : new Date(value).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : null;
};
const jitter = (ms) => Math.round(ms * (0.9 + Math.random() * 0.2));

const tell = (ep, kind, title, body) =>
  notifyApiTeam(null, { workspaceId: ep.workspace_id, face: 'console', kind, title, body, link: `/settings/webhooks/${ep.id}`, data: { webhook_id: ep.id } });

// an endpoint off: what waited for it fails, to be replayed once it is on again
async function turnOff(endpointId, reason) {
  await db`update webhook_deliveries set status = 'failed', last_error = ${reason}, updated_at = now() where endpoint_id = ${endpointId} and status = 'pending'`;
}

async function disable(ep, reason) {
  await db`update webhook_endpoints set enabled = false, disabled_reason = ${reason}, updated_at = now() where id = ${ep.id}`;
  await turnOff(ep.id, reason);
  await tell(ep, 'webhook.disabled', `Webhook ${ep.name} turned off`, `${reason}. Its events are kept: turn it on again once its endpoint answers, and replay what failed.`);
}

// one attempt of a delivery: signed now, sent, its outcome recorded
export async function attempt(d) {
  const ep = (await db`select * from webhook_endpoints where id = ${d.endpoint_id}`)[0];
  if (!ep) return null;
  const body = JSON.stringify(d.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const secrets = [open(ep.secret), ...(ep.previous_secret && ep.previous_until && new Date(ep.previous_until) > new Date() ? [open(ep.previous_secret)] : [])];
  const signature = secrets.map((s) => `v1,${sign(s, d.id, timestamp, body)}`).join(' ');
  const started = Date.now();
  let status = null;
  let error = null;
  let response = '';
  let wait = null;
  try {
    const url = await checkUrl(ep.url);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'otoroshi-api-management-webhooks', 'webhook-id': d.id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    response = (await res.text().catch(() => '')).slice(0, RESPONSE_MAX);
    if ([429, 503].includes(status)) wait = retryAfterMs(res.headers.get('retry-after'));
    if (status < 200 || status >= 300) error = `the endpoint answered ${status}`;
  } catch (e) {
    error = e.name === 'TimeoutError' ? `no answer within ${TIMEOUT_MS / 1000} s` : String(e.message || e);
  }
  const duration = Date.now() - started;
  const attempts = d.attempts + 1;
  if (!error) {
    await db`update webhook_deliveries set status = 'succeeded', attempts = ${attempts}, last_status = ${status}, last_error = null, last_response = ${response},
        duration_ms = ${duration}, delivered_at = now(), updated_at = now() where id = ${d.id}`;
    await db`update webhook_endpoints set failing_since = null, told_at = null where id = ${ep.id}`;
    return { ...d, status: 'succeeded', attempts, last_status: status };
  }
  // a test is tried once; a 410 says the endpoint is gone
  const spent = status === 410 || d.type === 'webhook.test' || attempts >= ATTEMPTS;
  const next = new Date(Date.now() + (wait ?? jitter(RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1])));
  await db`update webhook_deliveries set status = ${spent ? 'failed' : 'pending'}, attempts = ${attempts}, next_at = ${next}, last_status = ${status},
      last_error = ${error}, last_response = ${response}, duration_ms = ${duration}, updated_at = now() where id = ${d.id}`;
  if (d.type === 'webhook.test') return { ...d, status: 'failed', attempts, last_status: status, last_error: error };
  const failingSince = ep.failing_since ? new Date(ep.failing_since) : new Date();
  await db`update webhook_endpoints set failing_since = ${failingSince} where id = ${ep.id}`;
  if (status === 410) await disable(ep, 'its endpoint answered 410 Gone');
  else if (Date.now() - failingSince.getTime() > DISABLE_AFTER_MS) await disable(ep, 'its endpoint has failed for five days in a row');
  else if (spent && !ep.told_at) {
    // told once while it fails: the next time after a success
    await db`update webhook_endpoints set told_at = now() where id = ${ep.id}`;
    await tell(ep, 'webhook.failing', `Webhook ${ep.name}: a delivery failed`, `${error}, after ${attempts} attempt(s). The deliveries are kept ${KEEP_DAYS} days: replay them once the endpoint answers.`);
  }
  return { ...d, status: spent ? 'failed' : 'pending', attempts, last_status: status, last_error: error };
}

// the deliveries due of the endpoints on, claimed for a minute — another instance skips them —, sent
// side by side
export async function sendDue({ limit = 20 } = {}) {
  const due = await db`update webhook_deliveries set next_at = now() + interval '1 minute', updated_at = now()
    where id in (select d.id from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
      where d.status = 'pending' and d.next_at <= now() and e.enabled order by d.next_at limit ${limit} for update of d skip locked)
    returning *`;
  await Promise.all(due.map((d) => attempt(d).catch((e) => console.error('[apim] webhook delivery failed', e.message))));
  return due.length;
}

let lastPurge = 0;
export async function purge() {
  await db`delete from webhook_deliveries where status <> 'pending' and created_at < now() - make_interval(days => ${KEEP_DAYS})`;
  lastPurge = Date.now();
}

// what the worker runs, every few seconds
let running = false;
export async function runWebhooks() {
  if (running) return;
  running = true;
  try {
    await fanOut();
    await sendDue();
    if (Date.now() - lastPurge > 600e3) await purge();
  } finally {
    running = false;
  }
}

// a test: an event of its own, sent at once, tried once
export async function sendTest(ctx, endpoint) {
  const ws = (await db`select id, slug from workspaces where id = ${endpoint.workspace_id}`)[0];
  const payload = { type: 'webhook.test', timestamp: new Date().toISOString(), workspace: { id: ws.id, slug: ws.slug }, data: { webhook: { id: endpoint.id, name: endpoint.name }, message: 'A test of this webhook' } };
  const d = (await db`insert into webhook_deliveries (id, endpoint_id, workspace_id, type, payload, next_at)
    values (${newId('msg')}, ${endpoint.id}, ${endpoint.workspace_id}, 'webhook.test', ${payload}, now() + interval '1 minute') returning *`)[0];
  await audit(ctx, { action: 'webhook.test', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `test of the webhook ${endpoint.name}` });
  return delivery(endpoint, (await attempt(d)).id);
}

// one delivery replayed by hand: its attempts again, at once, with the same id
export async function redeliver(ctx, endpoint, deliveryId) {
  const d = await delivery(endpoint, deliveryId);
  const rows = await db`update webhook_deliveries set status = 'pending', attempts = 0, next_at = now() + interval '1 minute', updated_at = now() where id = ${d.id} returning *`;
  await audit(ctx, { action: 'webhook.redeliver', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `delivery ${d.id} (${d.type}) of the webhook ${endpoint.name} replayed` });
  await attempt(rows[0]);
  return delivery(endpoint, d.id);
}

// the failed deliveries since a date, replayed: back to the queue, their attempts again
export async function recover(ctx, endpoint, since) {
  const from = new Date(since);
  if (!since || Number.isNaN(from.getTime())) throw badRequest('since: a date');
  const rows = await db`update webhook_deliveries set status = 'pending', attempts = 0, next_at = now(), updated_at = now()
    where endpoint_id = ${endpoint.id} and status = 'failed' and type <> 'webhook.test' and created_at >= ${from} returning id`;
  await audit(ctx, { action: 'webhook.recover', workspaceId: endpoint.workspace_id, entityKind: 'webhook', entityId: endpoint.id, summary: `${rows.length} failed delivery(ies) of the webhook ${endpoint.name} since ${from.toISOString()} replayed` });
  return { replayed: rows.length };
}

export async function delivery(endpoint, id) {
  const row = (await db`select * from webhook_deliveries where endpoint_id = ${endpoint.id} and id = ${id}`)[0];
  if (!row) throw notFound('delivery not found');
  return row;
}

// the deliveries of an endpoint, the most recent first: searched by type and id, filtered by status
export async function listDeliveries(endpoint, { status = null, q = '', limit = 50, offset = 0 } = {}) {
  const pattern = q ? likePattern(q) : null;
  const where = () => db`endpoint_id = ${endpoint.id} and (${status}::text is null or status = ${status})
    and (${pattern}::text is null or type ilike ${pattern} or id ilike ${pattern} or last_error ilike ${pattern})`;
  const [items, [{ total }]] = await Promise.all([
    db`select id, event_id, type, status, attempts, next_at, last_status, last_error, duration_ms, created_at, updated_at, delivered_at
      from webhook_deliveries where ${where()} order by created_at desc, id desc limit ${limit} offset ${offset}`,
    db`select count(*)::int as total from webhook_deliveries where ${where()}`,
  ]);
  return { items, total, limit, offset };
}

// the types an endpoint may take: the actions its workspace's trail has recorded, the most frequent first
export async function eventTypes(workspaceId) {
  return (await db`select action, count(*)::int as n from audit_events where workspace_id = ${workspaceId} group by action order by n desc, action limit 300`).map((r) => r.action);
}
