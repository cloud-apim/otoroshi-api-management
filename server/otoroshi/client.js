// The Otoroshi Admin API client. One installation drives one Otoroshi cluster, reached with
// an administration key. The settings are installation-level and editable at runtime.

import { config } from '../config.js';
import { db } from '../db/index.js';

// an outside tool that manages its apis as code: each write of an Api so marked is a deploy, recorded
// in the deployment history of the Api, owned by this marker
export const TOOL_ID = 'otoroshi-api-management';
export const OWNER_MARKER = `external=${TOOL_ID}`;
export const META = {
  createdBy: 'created_by',
  api: 'apim_api_id',
  snapshot: 'deployment_ref', // the snapshot deployed: Otoroshi gives it to the deployment as its ref
  snapshotNumber: 'apim_snapshot_number',
  workspace: 'apim_workspace',
  subscription: 'apim_subscription_id',
  application: 'id_ref', // the application is projected as an id_ref metadata on the apikey
  managedBy: 'apim_managed_by',
  setupPart: 'apim_setup_part', // the part of the setup that made an entity of the gateway
};

let cached = null;

export async function gatewaySettings() {
  if (cached && cached.at > Date.now() - 5000) return cached.value;
  const rows = await db`select value from settings where key = 'gateway'`;
  const value = { ...config.otoroshi, ...(rows[0]?.value || {}) };
  cached = { at: Date.now(), value };
  return value;
}

export function invalidateGatewaySettings() {
  cached = null;
}

export class OtoroshiError extends Error {
  constructor(status, body, path) {
    super(`otoroshi ${status} on ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

// `creds` calls with another key than the product's own — the admin key given to the setup
export async function otoroshi(method, path, body, { timeoutMs = 10000, creds = null } = {}) {
  const s = { ...(await gatewaySettings()), ...(creds || {}) };
  const headers = {
    Host: s.host,
    Authorization: 'Basic ' + Buffer.from(`${s.clientId}:${s.clientSecret}`).toString('base64'),
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${s.url}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new OtoroshiError(0, `gateway unreachable: ${e.message}`, path);
  }
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {}
  if (res.status === 404) return null;
  if (res.status >= 300) throw new OtoroshiError(res.status, data, path);
  return data;
}

const API_BASE = '/apis/apis.otoroshi.io/v1/apis';
const SUB_BASE = '/apis/apis.otoroshi.io/v1/apisubscriptions';

// where the derived objects are written: the generic api, which has an upsert (and computes the
// subject and the validity of a certificate from its chain)
export const DERIVED_PATHS = {
  JwtVerifier: '/apis/security.otoroshi.io/v1/jwt-verifiers',
  AuthModule: '/apis/security.otoroshi.io/v1/auth-modules',
  Certificate: '/apis/pki.otoroshi.io/v1/certificates',
};

export const oto = {
  health: async () => {
    const s = await gatewaySettings();
    const started = Date.now();
    try {
      const r = await otoroshi('GET', '/api/health', undefined, { timeoutMs: 3000 });
      return { ok: true, latencyMs: Date.now() - started, url: s.url, details: r };
    } catch (e) {
      // /api/health may need specific rights: fall back on a cheap read
      try {
        await otoroshi('GET', `${API_BASE}?page=1&pageSize=1`, undefined, { timeoutMs: 3000 });
        return { ok: true, latencyMs: Date.now() - started, url: s.url };
      } catch (e2) {
        return { ok: false, error: e2.message, url: s.url };
      }
    }
  },
  getApi: (id) => otoroshi('GET', `${API_BASE}/${id}`),
  listApis: () => otoroshi('GET', API_BASE),
  // the write of an Api managed as code is a deploy: the api may be created already published, the
  // fields locked in production take the body, and a change is recorded as an ApiDeployment whose
  // ref is the snapshot. The upsert of the generic
  // api: a POST on the id creates or replaces (a PUT refuses an entity that does not exist yet).
  upsertApi: (entity) => otoroshi('POST', `${API_BASE}/${entity.id}`, entity),
  deleteApi: (id) => otoroshi('DELETE', `${API_BASE}/${id}`),
  // Otoroshi's request tester: the request sent through a route of the api, its response and the
  // execution report of the call (null when the gateway does not serve the route)
  tryRoute: (apiId, routeId, request) => otoroshi('POST', `${API_BASE}/${apiId}/routes/${routeId}/_tryit`, request, { timeoutMs: 35000 }),
  getSubscription: (id) => otoroshi('GET', `${SUB_BASE}/${id}`),
  listSubscriptions: () => otoroshi('GET', SUB_BASE),
  createSubscription: (entity) => otoroshi('POST', SUB_BASE, entity),
  updateSubscription: (entity) => otoroshi('PUT', `${SUB_BASE}/${entity.id}`, entity),
  deleteSubscription: (id) => otoroshi('DELETE', `${SUB_BASE}/${id}`),
  getApikey: (clientId) => otoroshi('GET', `/api/apikeys/${clientId}`),
  updateApikey: (key) => otoroshi('PUT', `/api/apikeys/${key.clientId}`, key),
  deleteApikey: (clientId) => otoroshi('DELETE', `/api/apikeys/${clientId}`),
  apikeyQuotas: (clientId) => otoroshi('GET', `/api/apikeys/${clientId}/quotas`),
  listJwtVerifiers: () => otoroshi('GET', '/api/verifiers'),
  // the upsert of the generic api: a POST on the id creates or replaces
  upsertEntity: (path, entity) => otoroshi('POST', `${path}/${entity.id}`, entity),
  getEntity: (path, id) => otoroshi('GET', `${path}/${id}`),
  deleteEntity: (path, id) => otoroshi('DELETE', `${path}/${id}`),
  listAuthModules: () => otoroshi('GET', '/api/auths'),
  listCertificates: () => otoroshi('GET', '/api/certificates'),
  globalConfig: () => otoroshi('GET', '/api/globalconfig'),
  listDataExporters: () => otoroshi('GET', '/api/data-exporter-configs'),
  createDataExporter: (e) => otoroshi('POST', '/api/data-exporter-configs', e),
  updateDataExporter: (e) => otoroshi('PUT', `/api/data-exporter-configs/${e.id}`, e),
  pluginsCatalog: () => otoroshi('GET', '/api/plugins/all'),
};
