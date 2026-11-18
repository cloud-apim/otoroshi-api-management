// The ingester: receives GatewayEvent, LLMUsageAudit and McpAudit from an Otoroshi data
// exporter, and stores them twice:
//  - computed (mandatory, exhaustive): attributed to the catalogue — api, plan, subscription,
//    application — at ingestion time. A quota, an attribution, a token count are counted, not sampled.
//  - raw (optional): where lightening, sampling and masking belong.

import { adb, db } from '../db/index.js';
import { config } from '../config.js';

const SECRET_QUERY = /^(.*token.*|.*secret.*|.*password.*|.*passwd.*|api[_-]?key|apikey|key|sig|signature|code|auth.*)$/i;

// what Otoroshi does not mask at export: a secret in the url
export function maskUrl(url) {
  if (!url || !url.includes('?')) return url;
  try {
    const u = new URL(url, 'http://x');
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY.test(k)) {
        u.searchParams.set(k, '********');
        changed = true;
      }
    }
    if (!changed) return url;
    const masked = u.toString();
    return url.startsWith('http') ? masked : masked.replace(/^http:\/\/x/, '');
  } catch (e) {
    return url;
  }
}

// ------------------------------------------------------------- attribution cache

const cache = { at: 0, byClientId: new Map(), apis: new Map(), plansByPrefix: [] };

async function refreshCache() {
  if (Date.now() - cache.at < 15000) return;
  const creds = await db`select c.client_id, s.id as subscription_id, s.application_id, s.plan_id, s.api_id, s.workspace_id
    from credentials c join subscriptions s on s.id = c.subscription_id`;
  const apis = await db`select id, workspace_id from apis`;
  // gateway-minted consumers (jwt, mtls, oauth2-remote, keyless) are named <kind>_<planId>_<clientId>
  const subsByApp = await db`select s.id as subscription_id, s.application_id, s.plan_id, s.api_id, s.workspace_id, a.client_id
    from subscriptions s join applications a on a.id = s.application_id where s.status in ('active', 'suspended')`;
  cache.byClientId = new Map(creds.map((c) => [c.client_id, c]));
  cache.apis = new Map(apis.map((a) => [a.id, a]));
  cache.subsByApp = subsByApp;
  // <planId>_<clientId> → the subscription: a plan id can itself hold underscores
  cache.byPlanClient = new Map(subsByApp.filter((s) => s.client_id).map((s) => [`${s.plan_id}_${s.client_id}`, s]));
  cache.at = Date.now();
}

export function invalidateAttributionCache() {
  cache.at = 0;
}

function attribute(clientId, otoroshiApiId) {
  const out = { api_id: null, workspace_id: null, plan_id: null, subscription_id: null, application_id: null };
  const api = otoroshiApiId ? cache.apis.get(otoroshiApiId) : null;
  if (api) {
    out.api_id = api.id;
    out.workspace_id = api.workspace_id;
  }
  if (!clientId) return out;
  const c = cache.byClientId.get(clientId);
  if (c) return { ...out, ...c };
  const m = /^(jwt|mtls|oauth2|keyless)_(.+)$/.exec(clientId);
  if (m) {
    const sub = cache.byPlanClient?.get(m[2]);
    if (sub) return { ...out, ...sub };
    // not a subscribed consumer: at least the plan, when the api is known
    const plan = (cache.subsByApp || []).find((s) => m[2].startsWith(`${s.plan_id}_`));
    if (plan) out.plan_id = plan.plan_id;
  }
  return out;
}

function ts(v) {
  if (!v) return new Date();
  if (typeof v === 'number') return new Date(v);
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date() : d;
}

function lighten(event) {
  // the raw path keeps the event, minus the heavy embedded configurations
  const { route, descriptor, matcheJwtVerifier, viz, ...rest } = event;
  return {
    ...rest,
    url: maskUrl(rest.url),
    route: route ? { id: route.id, name: route.name, metadata: route.metadata } : null,
  };
}

let rawEnabled = null;
async function storeRaw() {
  if (rawEnabled && rawEnabled.at > Date.now() - 10000) return rawEnabled.value;
  const rows = await db`select value from settings where key = 'ingest'`;
  const value = rows[0]?.value?.storeRaw ?? config.ingest.storeRaw;
  rawEnabled = { at: Date.now(), value };
  return value;
}

export async function ingest(events) {
  await refreshCache();
  const raw = await storeRaw();
  const calls = [];
  const ai = [];
  const raws = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const type = e['@type'];
    const at = ts(e['@timestamp']);
    if (type === 'GatewayEvent') {
      const otoApiId = e.route?.metadata?.['Otoroshi-Api-Ref'] || e.route?.api_ref || null;
      const clientId = e.identity?.identityType === 'APIKEY' ? e.identity.identity : null;
      const attr = attribute(clientId, otoApiId);
      // the key carries the subscription and the application itself (apiRef + id_ref)
      const md = e.identity?.metadata || {};
      if (!attr.subscription_id && md.apim_subscription_id) attr.subscription_id = md.apim_subscription_id;
      if (!attr.application_id && md.id_ref) attr.application_id = md.id_ref;
      let path = null;
      try {
        path = new URL(maskUrl(e.url || ''), 'http://x').pathname;
      } catch (err) {}
      calls.push({
        at,
        req_id: e.reqId ? String(e.reqId) : null,
        workspace_id: attr.workspace_id,
        api_id: attr.api_id,
        otoroshi_api_id: otoApiId,
        route_id: e.route?.id || null,
        plan_id: attr.plan_id,
        subscription_id: attr.subscription_id,
        application_id: attr.application_id,
        client_id: clientId,
        method: e.method || null,
        path,
        status: e.status ?? null,
        duration_ms: e.duration ?? null,
        overhead_ms: e.overhead ?? null,
        backend_duration_ms: e.backendDuration ?? null,
        bytes_in: e.data?.dataIn ?? null,
        bytes_out: e.data?.dataOut ?? null,
        err: !!e.err,
        from_ip: e.from || null,
        user_agent: (e.headers || []).find((h) => (h.key || '').toLowerCase() === 'user-agent')?.value || null,
      });
    } else if (type === 'LLMUsageAudit' || type === 'McpAudit') {
      const clientId = e.apikey?.clientId || e.consumer?.apikey || e.user?.apikey || null;
      const attr = attribute(clientId, e.route?.metadata?.['Otoroshi-Api-Ref'] || null);
      const usage = e.usage || e.output?.usage || {};
      ai.push({
        at,
        type,
        workspace_id: attr.workspace_id,
        api_id: attr.api_id,
        client_id: clientId,
        subscription_id: attr.subscription_id,
        provider: e.provider_kind || e.provider || null,
        model: e.model || e.request?.model || null,
        tool: e.tool_name || e.tool || null,
        input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
        output_tokens: usage.generation_tokens ?? usage.completion_tokens ?? usage.output_tokens ?? null,
        cost_micro_usd: e.cost?.micro_usd ?? null,
        payload: lighten(e),
      });
    }
    if (raw) raws.push({ at, type: type || 'unknown', payload: type === 'GatewayEvent' ? lighten(e) : e });
  }
  if (calls.length) await adb`insert into calls ${adb(calls)}`;
  if (ai.length) await adb`insert into ai_usage ${adb(ai)}`;
  if (raws.length) await adb`insert into raw_events ${adb(raws)}`;
  return { received: events.length, calls: calls.length, ai: ai.length, raw: raws.length };
}

export function parseEvents(text) {
  const t = (text || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t);
  if (t.startsWith('{') && !t.includes('\n{')) {
    const one = JSON.parse(t);
    return Array.isArray(one.events) ? one.events : [one];
  }
  return t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
