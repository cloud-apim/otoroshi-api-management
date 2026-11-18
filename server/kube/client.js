// The Kubernetes API, as far as the controller needs it: its custom resources, their status and
// finalizers, the secrets it writes, the namespaces it reads. In the cluster it uses the service
// account of its pod; outside, APIM_KUBE_URL and APIM_KUBE_TOKEN (and APIM_KUBE_CA, or
// APIM_KUBE_INSECURE=true).

import { existsSync, readFileSync } from 'node:fs';

export const GROUP = 'otoroshi-apim.io';
export const VERSION = 'v1';
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

export function kubeConfig(env = process.env) {
  if (env.APIM_KUBE_URL)
    return {
      url: env.APIM_KUBE_URL.replace(/\/$/, ''),
      token: env.APIM_KUBE_TOKEN_FILE ? () => readFileSync(env.APIM_KUBE_TOKEN_FILE, 'utf8').trim() : env.APIM_KUBE_TOKEN || '',
      ca: env.APIM_KUBE_CA ? readFileSync(env.APIM_KUBE_CA, 'utf8') : null,
      insecure: env.APIM_KUBE_INSECURE === 'true',
    };
  if (env.KUBERNETES_SERVICE_HOST && existsSync(`${SA}/token`))
    return {
      url: `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT || 443}`,
      // a projected token is rotated: read at each call
      token: () => readFileSync(`${SA}/token`, 'utf8').trim(),
      ca: readFileSync(`${SA}/ca.crt`, 'utf8'),
      insecure: false,
    };
  return null;
}

export class KubeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function kubeClient(cfg) {
  async function call(method, path, body, contentType = 'application/json') {
    const token = typeof cfg.token === 'function' ? cfg.token() : cfg.token;
    const res = await fetch(`${cfg.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': contentType } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      tls: { ca: cfg.ca || undefined, rejectUnauthorized: !cfg.insecure },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 && method === 'GET') return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new KubeError(res.status, `kubernetes ${method} ${path}: ${res.status} ${data?.message || res.statusText}`);
    return data;
  }
  const crs = (plural, ns) => `/apis/${GROUP}/${VERSION}${ns ? `/namespaces/${ns}` : ''}/${plural}`;
  return {
    list: async (plural) => (await call('GET', crs(plural)))?.items || [],
    get: (plural, ns, name) => call('GET', `${crs(plural, ns)}/${name}`),
    // a merge patch on the metadata (the finalizers), checked against the version read
    patchMetadata: (plural, cr, metadata) => call('PATCH', `${crs(plural, cr.metadata.namespace)}/${cr.metadata.name}`, { metadata: { resourceVersion: cr.metadata.resourceVersion, ...metadata } }, 'application/merge-patch+json'),
    patchStatus: (plural, cr, status) => call('PATCH', `${crs(plural, cr.metadata.namespace)}/${cr.metadata.name}/status`, { status }, 'application/merge-patch+json'),
    namespace: (name) => call('GET', `/api/v1/namespaces/${name}`),
    secret: (ns, name) => call('GET', `/api/v1/namespaces/${ns}/secrets/${name}`),
    createSecret: (ns, secret) => call('POST', `/api/v1/namespaces/${ns}/secrets`, secret),
    replaceSecret: (ns, name, secret) => call('PUT', `/api/v1/namespaces/${ns}/secrets/${name}`, secret),
  };
}
