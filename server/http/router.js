// A deliberately small router: method + path pattern -> handler.
// Patterns use `:name` params and a trailing `*` wildcard.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'unauthorized') => new HttpError(401, msg);
export const forbidden = (msg = 'forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'not found') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);

function compile(pattern) {
  const keys = [];
  const src = pattern
    .split('/')
    .map((part) => {
      if (part === '*') {
        keys.push('wildcard');
        return '(.*)';
      }
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${src}/?$`), keys };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  on(method, pattern, handler) {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, pattern, regex, keys, handler });
    return this;
  }

  get(p, h) {
    return this.on('GET', p, h);
  }
  post(p, h) {
    return this.on('POST', p, h);
  }
  put(p, h) {
    return this.on('PUT', p, h);
  }
  patch(p, h) {
    return this.on('PATCH', p, h);
  }
  delete(p, h) {
    return this.on('DELETE', p, h);
  }

  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message, details: err.details }, err.status);
  }
  console.error('[apim] unexpected error', err);
  return json({ error: 'internal error', details: String(err?.message || err) }, 500);
}

export async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw badRequest('invalid json body');
  }
}

export function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
