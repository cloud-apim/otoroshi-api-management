// The ingester: receives GatewayEvent, LLMUsageAudit and McpAudit from an Otoroshi data
// exporter, and stores them twice:
//  - computed (mandatory, exhaustive): attributed to the catalogue — api, plan, subscription,
//    application — at ingestion time. A quota, an attribution, a token count are counted, not sampled.
//  - raw (optional): where lightening and sampling belong.
// Both are pseudonymised before they are stored (ingest-policy.js); what is kept and how long is
// in retention.js.

import { adb, db } from '../db/index.js';
import { agentOf, ipOf, maskUrl, policy, pseudonymise, sampled, templatePath, urlOf } from './ingest-policy.js';

// the masking of url secrets lives with the rest of the policy of the ingester
export { maskUrl } from './ingest-policy.js';

// ------------------------------------------------------------- attribution cache

const cache = { at: 0, byClientId: new Map(), apis: new Map(), subs: new Map() };

async function refreshCache() {
  if (Date.now() - cache.at < 15000) return;
  const creds = await db`select c.client_id, s.id as subscription_id, s.application_id, s.plan_id, s.api_id, s.workspace_id
    from credentials c join subscriptions s on s.id = c.subscription_id`;
  const apis = await db`select id, workspace_id from apis`;
  const subs = await db`select id as subscription_id, application_id, plan_id, api_id, workspace_id from subscriptions`;
  cache.byClientId = new Map(creds.map((c) => [c.client_id, c]));
  cache.apis = new Map(apis.map((a) => [a.id, a]));
  cache.subs = new Map(subs.map((s) => [s.subscription_id, s]));
  cache.at = Date.now();
}

export function invalidateAttributionCache() {
  cache.at = 0;
}

// the event names the api, the plan and the subscription of the key that called (`apiRef`, as the
// key said it at the time of the call); the ids are the product's. Without it (an event that does not
// carry it: an AI audit), the client id of a credential the product holds.
function attribute(clientId, otoroshiApiId, apiRef = null) {
  const out = { api_id: null, workspace_id: null, plan_id: null, subscription_id: null, application_id: null };
  const api = cache.apis.get(apiRef?.api || otoroshiApiId || '');
  if (api) {
    out.api_id = api.id;
    out.workspace_id = api.workspace_id;
  }
  if (apiRef?.api) {
    out.plan_id = apiRef.plan || null;
    // `sub` is empty for a consumer a keyless plan identified
    const sub = apiRef.sub ? cache.subs.get(apiRef.sub) : null;
    if (sub) return { ...out, ...sub };
    return out;
  }
  const c = clientId ? cache.byClientId.get(clientId) : null;
  return c ? { ...out, ...c } : out;
}

function ts(v) {
  if (!v) return new Date();
  if (typeof v === 'number') return new Date(v);
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date() : d;
}

// an event as it is kept: minus the heavy embedded configurations, its url masked, its personal
// data pseudonymised; the raw path can leave its headers out
function lighten(p, event, { headers = 'keep' } = {}) {
  const { route, descriptor, matcheJwtVerifier, viz, ...rest } = event;
  const out = {
    ...rest,
    ...('url' in rest ? { url: urlOf(p, rest.url) } : {}),
    route: route ? { id: route.id, name: route.name, metadata: route.metadata } : null,
  };
  if (headers === 'drop') {
    delete out.headers;
    delete out.headersOut;
    delete out.otoroshiHeadersIn;
    delete out.otoroshiHeadersOut;
  }
  return pseudonymise(p, out);
}

export async function ingest(events) {
  await refreshCache();
  const p = await policy();
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
      const attr = attribute(clientId, otoApiId, e.identity?.apiRef);
      // a subscription the product no longer knows: the key still names its application (id_ref)
      const md = e.identity?.metadata || {};
      if (!attr.subscription_id && e.identity?.apiRef?.sub) attr.subscription_id = e.identity.apiRef.sub;
      if (!attr.application_id && md.id_ref) attr.application_id = md.id_ref;
      let path = null;
      try {
        path = new URL(maskUrl(e.url || ''), 'http://x').pathname;
      } catch (err) {}
      const template = templatePath(path);
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
        path: p.privacy.paths === 'template' ? template : path,
        path_template: template,
        status: e.status ?? null,
        duration_ms: e.duration ?? null,
        overhead_ms: e.overhead ?? null,
        backend_duration_ms: e.backendDuration ?? null,
        bytes_in: e.data?.dataIn ?? null,
        bytes_out: e.data?.dataOut ?? null,
        err: !!e.err,
        from_ip: ipOf(p, e.from || null),
        user_agent: agentOf(p, (e.headers || []).find((h) => (h.key || '').toLowerCase() === 'user-agent')?.value || null),
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
        payload: lighten(p, e),
      });
    }
    // the raw path: a share of the requests, their errors always
    if (p.storeRaw && sampled(p, e)) raws.push({ at, type: type || 'unknown', payload: lighten(p, e, { headers: p.raw.headers }) });
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
