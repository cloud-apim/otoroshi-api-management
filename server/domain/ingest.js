// The ingester: receives GatewayEvent, the CloudApimSecurityEvent of the Threat Protection Suite and
// the LLMUsageAudit and McpAudit audits of the LLM extension (generic AuditEvents) from an Otoroshi
// data exporter, and stores them twice:
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

async function refreshCache({ maxAgeMs = 15000 } = {}) {
  if (Date.now() - cache.at < maxAgeMs) return;
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

// the api, the subscription and the client id an event names, whatever its type
function refsOf(e) {
  const type = e?.['@type'];
  if (type === 'GatewayEvent')
    return { api: e.identity?.apiRef?.api || e.route?.metadata?.['Otoroshi-Api-Ref'] || e.route?.api_ref, sub: e.identity?.apiRef?.sub, client: e.identity?.identityType === 'APIKEY' ? e.identity.identity : null };
  if (type === 'CloudApimSecurityEvent') return { api: e.otoroshi?.api_id, client: e.source?.apikey };
  // the audits of the LLM extension
  return { api: e?.apikey?.apiRef?.api || e?.route?.metadata?.['Otoroshi-Api-Ref'], sub: e?.apikey?.apiRef?.sub, client: e?.apikey?.clientId || e?.consumer?.apikey || e?.user?.apikey };
}

// an event of an api, a subscription or a key made since the cache was read: read it again, once a
// second at most — the first calls of a new api are attributed like the others
async function knowEvery(events) {
  const missing = events.some((e) => {
    const r = refsOf(e);
    return (r.api && !cache.apis.has(r.api)) || (r.sub && !cache.subs.has(r.sub)) || (r.client && r.api && cache.apis.has(r.api) && !cache.byClientId.has(r.client) && !r.sub);
  });
  if (missing) await refreshCache({ maxAgeMs: 1000 });
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

// an AI audit as it is kept: its usage, never its content — the prompt and the answer leave, and the
// key and the provider are named, not copied (the key would carry its secret)
function aiPayload(e) {
  const { input_prompt, output, apikey, provider_details, mcp_request_payload, mcp_response, ...rest } = e;
  return {
    ...rest,
    output: output && typeof output === 'object' ? { metadata: output.metadata || null } : null,
    // an MCP call: its method and its tool, not its arguments nor its result
    ...(mcp_request_payload !== undefined ? { mcp_request_payload: mcp_request_payload?.params?.name ? { params: { name: mcp_request_payload.params.name } } : null, mcp_response: null } : {}),
    apikey: apikey ? { clientId: apikey.clientId, clientName: apikey.clientName, apiRef: apikey.apiRef || null } : null,
    provider_details: provider_details ? { id: provider_details.id, name: provider_details.name, provider: provider_details.provider } : null,
  };
}
const AI_TYPES = ['LLMUsageAudit', 'McpAudit'];

export async function ingest(events) {
  await refreshCache();
  await knowEvery(events);
  const p = await policy();
  const calls = [];
  const ai = [];
  const security = [];
  const raws = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    // the audits of the LLM extension are generic audit events: their kind is their `audit`
    const type = e['@type'] === 'AuditEvent' ? e.audit || 'AuditEvent' : e['@type'];
    const at = ts(e['@timestamp']);
    if (type === 'GatewayEvent') {
      const otoApiId = e.route?.metadata?.['Otoroshi-Api-Ref'] || e.route?.api_ref || null;
      // a call made with the credential of an application is identified as the alias of its
      // subscription on this api: the client id kept is the one the consumer called with
      const clientId = e.identity?.identityType === 'APIKEY' ? e.identity.apiRef?.credential || e.identity.identity : null;
      const attr = attribute(clientId, otoApiId, e.identity?.apiRef);
      // a subscription the product no longer knows: the key still names its application (id_ref)
      const md = e.identity?.metadata || {};
      if (!attr.subscription_id && e.identity?.apiRef?.sub) attr.subscription_id = e.identity.apiRef.sub;
      if (!attr.application_id && md.id_ref) attr.application_id = md.id_ref;
      let path = null;
      let host = null;
      try {
        const u = new URL(maskUrl(e.url || ''), 'http://x');
        path = u.pathname;
        host = u.hostname && u.hostname !== 'x' ? u.hostname : null;
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
        host,
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
    } else if (AI_TYPES.includes(type)) {
      // the key that called names its subscription (apiRef); the route its api
      const clientId = e.apikey?.apiRef?.credential || e.apikey?.clientId || e.consumer?.apikey || e.user?.apikey || null;
      const apiRef = e.apikey?.apiRef?.api ? e.apikey.apiRef : null;
      const attr = attribute(clientId, e.route?.metadata?.['Otoroshi-Api-Ref'] || null, apiRef);
      const usage = e.usage || e.output?.metadata?.usage || e.output?.usage || {};
      // the costs of the extension are in dollars
      const cost = e.costs?.total_cost ?? null;
      ai.push({
        at,
        type,
        workspace_id: attr.workspace_id,
        api_id: attr.api_id,
        client_id: clientId,
        subscription_id: attr.subscription_id,
        provider: e.provider_kind || e.provider || null,
        model: e.model || e.request?.model || null,
        // the tool an MCP call called
        tool: e.mcp_method === 'tools/call' ? e.mcp_request_payload?.params?.name || null : null,
        input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
        output_tokens: usage.generation_tokens ?? usage.completion_tokens ?? usage.output_tokens ?? null,
        cost_micro_usd: cost === null || cost === undefined || !Number.isFinite(Number(cost)) ? null : Math.round(Number(cost) * 1e6),
        payload: lighten(p, aiPayload(e)),
      });
    } else if (type === 'CloudApimSecurityEvent') {
      // the event names the api of the route; the plan comes from the key that called, when one did
      const clientId = e.source?.apikey || null;
      const otoApiId = e.otoroshi?.api_id || null;
      const attr = attribute(null, otoApiId);
      // the key of a subscription to this api says the plan; a key of another api says nothing of it
      const cred = clientId ? cache.byClientId.get(clientId) : null;
      if (cred && (!attr.api_id || cred.api_id === attr.api_id)) Object.assign(attr, cred);
      security.push({
        at,
        workspace_id: attr.workspace_id,
        api_id: attr.api_id,
        otoroshi_api_id: otoApiId,
        route_id: e.otoroshi?.route_id || null,
        plan_id: attr.plan_id,
        subscription_id: attr.subscription_id,
        application_id: attr.application_id,
        client_id: clientId,
        category: String(e.event?.category || 'unknown'),
        action: String(e.event?.action || 'log'),
        outcome: e.event?.outcome || null,
        severity: Number.isFinite(e.event?.severity) ? e.event.severity : null,
        score: Number.isFinite(e.threat?.score) ? e.threat.score : null,
        from_ip: ipOf(p, e.source?.ip || null),
        incident_id: e.incident?.id || null,
        message: e.message ? String(e.message).slice(0, 1000) : null,
        payload: lighten(p, e),
      });
    }
    // the raw path: a share of the requests, their errors always
    if (p.storeRaw && sampled(p, e)) raws.push({ at, type: type || 'unknown', payload: lighten(p, AI_TYPES.includes(type) ? aiPayload(e) : e, { headers: p.raw.headers }) });
  }
  if (calls.length) await adb`insert into calls ${adb(calls)}`;
  if (ai.length) await adb`insert into ai_usage ${adb(ai)}`;
  if (security.length) await adb`insert into security_events ${adb(security)}`;
  if (raws.length) await adb`insert into raw_events ${adb(raws)}`;
  return { received: events.length, calls: calls.length, ai: ai.length, security: security.length, raw: raws.length };
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
