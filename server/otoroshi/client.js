// The Otoroshi Admin API client. One installation drives one Otoroshi cluster, reached with
// an administration key. The settings are installation-level and editable at runtime.

import { config } from '../config.js';
import { db } from '../db/index.js';

export const OWNER_MARKER = 'remote_catalog=otoroshi-apim-deployment';
export const META = {
  createdBy: 'created_by',
  api: 'apim_api_id',
  snapshot: 'apim_snapshot_id',
  snapshotNumber: 'apim_snapshot_number',
  workspace: 'apim_workspace',
  subscription: 'apim_subscription_id',
  application: 'id_ref', // the application is projected as an id_ref metadata on the apikey
  managedBy: 'apim_managed_by',
  setupPart: 'apim_setup_part', // the part of the setup that made an entity of the gateway
  clientId: 'apim_client_id', // the client id an application declares, on the subscriptions that have no key
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

// where the derived objects are written: the generic api, which has an upsert; the certificates
// through their controller until the generic api enriches them (subject, issuer, validity from
// the chain), as the controller does
export const DERIVED_PATHS = {
  JwtVerifier: '/apis/security.otoroshi.io/v1/jwt-verifiers',
  AuthModule: '/apis/security.otoroshi.io/v1/auth-modules',
  Certificate: '/api/certificates',
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
  // a catalog-marked write is a deploy: production_readonly is lifted, the api may be created
  // already published, and the write is recorded as an ApiDeployment. The upsert of the generic
  // api: a POST on the id creates or replaces (a PUT refuses an entity that does not exist yet).
  upsertApi: (entity) => otoroshi('POST', `${API_BASE}/${entity.id}`, entity),
  deleteApi: (id) => otoroshi('DELETE', `${API_BASE}/${id}`),
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
  // the upsert of the generic api, one call; a controller has none: GET, then PUT or POST
  upsertEntity: async (path, entity) => {
    if (path.startsWith('/apis/')) return otoroshi('POST', `${path}/${entity.id}`, entity);
    const existing = await otoroshi('GET', `${path}/${entity.id}`);
    if (existing) return otoroshi('PUT', `${path}/${entity.id}`, entity);
    return otoroshi('POST', path, entity);
  },
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
