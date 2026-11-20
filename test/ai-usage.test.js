// The AI usage of an api, end to end, with the LLM extension of the gateway: an api whose flow
// proxies an LLM provider (OpenAiCompatProxy), called with the key of a subscription; the extension
// audits the call (LLMUsageAudit), the data exporter sends it, the ingester attributes it to the
// api, the subscription and the application, its tokens counted. The provider is a fake one, a route
// of the gateway answering as an OpenAI api would.
//
// Needs the docker stack (mise run up), its gateway started with the LLM extension
// (OTOROSHI_EXTENSIONS, see the install documentation); skipped otherwise.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(120000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'ai-usage-test-token';

const { start } = await import('../server/main.js');
const { adb } = await import('../server/db/index.js');
const { otoroshi, gatewayPlugins } = await import('../server/otoroshi/client.js');

const PROXY = 'cp:otoroshi_plugins.com.cloud.apim.otoroshi.extensions.aigateway.plugins.OpenAiCompatProxy';
const MCP = 'cp:otoroshi_plugins.com.cloud.apim.otoroshi.extensions.aigateway.plugins.McpRespEndpoint';
const TOOLS = '/apis/ai-gateway.extensions.cloud-apim.com/v1/tool-functions';
const INSTALLED = (await gatewayPlugins()).some((p) => p.id === PROXY);
const RUN = Date.now().toString(36);
const WS = `ai-${RUN}`;
const DOMAIN = `ai-${RUN}.oto.tools`;
const MOCK = `llm-mock-${RUN}.oto.tools`;
const MOCK_ROUTE = `route_llm_mock_${RUN}`;
const TOOL = `tool_answer_${RUN}`;
const MCP_DOMAIN = `mcp-${RUN}.oto.tools`;
const PROVIDER = `provider_mock_${RUN}`;
const PROVIDERS = '/apis/ai-gateway.extensions.cloud-apim.com/v1/providers';
let server;
const state = {};

// what an OpenAI api answers to a chat completion
const COMPLETION = {
  id: 'chatcmpl-mock',
  object: 'chat.completion',
  created: 1795000000,
  model: 'mock-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'The answer is 42.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};

async function call(method, path, body) {
  const res = await fetch(`http://localhost:${config.port}/api${path}`, {
    method,
    headers: { authorization: 'Bearer ai-usage-test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => null);
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
  return out;
}
const ws = (p) => `/workspaces/${WS}${p}`;
async function until(fn, wanted, tries = 60) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (wanted(last)) return last;
    await Bun.sleep(500);
  }
  return last;
}
const chat = (key) =>
  fetch('http://localhost:8080/v1/chat/completions', {
    method: 'POST',
    headers: { Host: DOMAIN, 'content-type': 'application/json', 'Otoroshi-Client-Id': key.client_id, 'Otoroshi-Client-Secret': key.client_secret },
    body: JSON.stringify({ model: 'mock-1', messages: [{ role: 'user', content: 'What is the answer?' }] }),
  });

beforeAll(async () => {
  if (!INSTALLED) return;
  server = await start();
  // the fake provider: a route of the gateway answering a chat completion
  const route = await otoroshi('GET', '/apis/proxy.otoroshi.io/v1/routes/_template');
  await otoroshi('POST', `/apis/proxy.otoroshi.io/v1/routes/${MOCK_ROUTE}`, {
    ...route,
    id: MOCK_ROUTE,
    name: 'a fake llm',
    frontend: { ...route.frontend, domains: [MOCK] },
    plugins: [{ plugin: 'cp:otoroshi.next.plugins.StaticResponse', enabled: true, include: [], exclude: [], config: { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(COMPLETION) } }],
  });
  const provider = await otoroshi('GET', `${PROVIDERS}/_template`);
  // reached from inside the gateway: *.oto.tools is its own loopback
  await otoroshi('POST', `${PROVIDERS}/${PROVIDER}`, { ...provider, id: PROVIDER, name: 'a fake llm', provider: 'openai', connection: { ...provider.connection, base_url: `http://${MOCK}:8080/v1`, token: 'mock' }, options: { ...provider.options, model: 'mock-1' } });
  // the api of the product: its flow proxies the provider
  await call('POST', '/workspaces', { name: `AI ${RUN}`, slug: WS });
  const team = await call('POST', ws('/teams'), { name: 'Builders' });
  const api = await call('POST', ws('/apis'), { name: 'Assistant', version: '1.0.0', team_id: team.id, domain: DOMAIN, contextPath: '/' });
  state.api = api;
  const draft = api.draft;
  draft.flows[0].plugins.push({ plugin: PROXY, enabled: true, include: [], exclude: [], config: { refs: [PROVIDER] } });
  draft.plans = [{ ...draft.plans[0], status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  await call('PUT', ws(`/apis/${api.id}/draft`), { draft });
  await call('POST', ws(`/apis/${api.id}/publish`), { comment: 'an llm', deploy: true });
  state.app = await call('POST', ws('/applications'), { name: 'Chat client', team_id: team.id });
  state.sub = await call('POST', ws('/subscriptions'), { api_id: api.id, plan_id: draft.plans[0].id, application_id: state.app.id });
  await call('POST', ws(`/subscriptions/${state.sub.id}/resync`));
  state.key = (await call('GET', ws(`/subscriptions/${state.sub.id}`))).credentials[0];
  // an MCP server: a tool calling the fake api, served by the flow of another api, its calls audited
  const tool = await otoroshi('GET', `${TOOLS}/_template`);
  await otoroshi('POST', `${TOOLS}/${TOOL}`, { ...tool, id: TOOL, name: 'get_answer', description: 'the answer', parameters: {}, backend: { kind: 'Http', options: { url: `http://${MOCK}:8080/answer`, method: 'GET' } } });
  const tools = await call('POST', ws('/apis'), { name: 'Tools', version: '1.0.0', team_id: team.id, domain: MCP_DOMAIN, contextPath: '/' });
  state.tools = tools;
  const td = tools.draft;
  td.flows[0].plugins.push({ plugin: MCP, enabled: true, include: [], exclude: [], config: { refs: [TOOL], name: 'tools', version: '1.0.0', emit_audit_events: true } });
  td.plans = [{ ...td.plans[0], status: 'published', validation: 'auto', auth: { kind: 'apikey' } }];
  await call('PUT', ws(`/apis/${tools.id}/draft`), { draft: td });
  await call('POST', ws(`/apis/${tools.id}/publish`), { comment: 'an mcp server', deploy: true });
  state.toolSub = await call('POST', ws('/subscriptions'), { api_id: tools.id, plan_id: td.plans[0].id, application_id: state.app.id });
  await call('POST', ws(`/subscriptions/${state.toolSub.id}/resync`));
  state.toolKey = (await call('GET', ws(`/subscriptions/${state.toolSub.id}`))).credentials[0];
});

afterAll(async () => {
  if (!INSTALLED) return;
  try {
    if (state.api) await call('DELETE', ws(`/apis/${state.api.id}`));
    if (state.tools) await call('DELETE', ws(`/apis/${state.tools.id}`));
    await adb`delete from ai_usage where client_id = ${state.toolKey?.client_id || ''}`;
    await call('DELETE', `/workspaces/${WS}`);
    await adb`delete from ai_usage where client_id = ${state.key?.client_id || ''}`;
  } catch (e) {
    console.error('cleanup', e.message);
  }
  await otoroshi('DELETE', `${PROVIDERS}/${PROVIDER}`).catch(() => null);
  await otoroshi('DELETE', `${TOOLS}/${TOOL}`).catch(() => null);
  await otoroshi('DELETE', `/apis/proxy.otoroshi.io/v1/routes/${MOCK_ROUTE}`).catch(() => null);
  server?.stop(true);
});

describe('the AI usage of an api', () => {
  test.if(INSTALLED)('a chat completion through the api is audited, exported, attributed and its tokens counted', async () => {
    const res = await until(
      async () => {
        const r = await chat(state.key);
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      (r) => r.status === 200,
      40
    );
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('The answer is 42.');
    const [row] = await until(() => adb`select * from ai_usage where client_id = ${state.key.client_id} order by id desc limit 1`, (rows) => rows.length > 0, 60);
    state.row = row;
    expect(row).toMatchObject({ type: 'LLMUsageAudit', api_id: state.api.id, subscription_id: state.sub.id, model: 'mock-1' });
    expect([Number(row.input_tokens), Number(row.output_tokens)]).toEqual([12, 5]);
    // its usage is kept, never its content: neither the prompt nor the answer, nor the secret of the key
    const kept = JSON.stringify(row.payload);
    expect(row.payload.input_prompt).toBeUndefined();
    expect(row.payload.output).toEqual({ metadata: expect.objectContaining({ usage: { prompt_tokens: 12, reasoning_tokens: 0, generation_tokens: 5 } }) });
    expect(kept).not.toContain('What is the answer?');
    expect(kept).not.toContain('The answer is 42.');
    expect(kept).not.toContain(state.key.client_secret);
    expect(row.payload.apikey).toEqual({ clientId: state.key.client_id, clientName: expect.any(String), apiRef: { api: state.api.id, plan: state.api.draft.plans[0].id, sub: state.sub.id } });
  });

  test.if(INSTALLED)('a tool called through an MCP server of an api is audited, attributed, its tool named, its content left out', async () => {
    const rpc = async (body, session) => {
      const r = await fetch('http://localhost:8080/mcp', {
        method: 'POST',
        headers: {
          Host: MCP_DOMAIN,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'Otoroshi-Client-Id': state.toolKey.client_id,
          'Otoroshi-Client-Secret': state.toolKey.client_secret,
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, session: r.headers.get('mcp-session-id'), text: await r.text() };
    };
    const init = await until(
      () => rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } }),
      (r) => r.status === 200,
      40
    );
    expect(init.status).toBe(200);
    const called = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_answer', arguments: {} } }, init.session);
    expect(called.status).toBe(200);
    expect(called.text).toContain('The answer is 42.');
    const rows = await until(
      () => adb`select * from ai_usage where client_id = ${state.toolKey.client_id} and type = 'McpAudit' order by id`,
      (rows) => rows.some((r) => r.tool === 'get_answer'),
      60
    );
    const row = rows.find((r) => r.tool === 'get_answer');
    expect(row).toMatchObject({ type: 'McpAudit', api_id: state.tools.id, subscription_id: state.toolSub.id, tool: 'get_answer' });
    expect(row.payload.mcp_method).toBe('tools/call');
    expect(JSON.stringify(row.payload)).not.toContain('The answer is 42.');
    expect(JSON.stringify(row.payload)).not.toContain(state.toolKey.client_secret);
    // the other methods are audited too, with no tool
    expect(rows.some((r) => r.payload.mcp_method === 'initialize' && r.tool === null)).toBe(true);
  });
});
