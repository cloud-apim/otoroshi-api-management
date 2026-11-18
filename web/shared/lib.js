// Shared front helpers: http client, theme, formatting.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `http ${status}`);
    this.status = status;
    this.body = body;
    this.details = body?.details;
  }
}

export function client(base) {
  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { error: text };
    }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b = {}) => call('PUT', p, b),
    del: (p) => call('DELETE', p, {}),
  };
}

// ---------------------------------------------------------------- theme: light / dark / system

const THEME_KEY = 'apim.theme';

export function getThemePref() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch (e) {
    return 'system';
  }
}

export function applyTheme(pref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setThemePref(pref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch (e) {}
  applyTheme(pref);
}

export function initTheme() {
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
}

// ---------------------------------------------------------------- formatting

export function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(d) {
  if (!d) return '—';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(d);
}

export function fmtNumber(n, digits = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

export function fmtWindow(ms) {
  if (!ms) return '';
  if (ms % 86400000 === 0) return ms === 86400000 ? 'day' : `${ms / 86400000} days`;
  if (ms % 3600000 === 0) return ms === 3600000 ? 'hour' : `${ms / 3600000} h`;
  if (ms % 60000 === 0) return ms === 60000 ? 'minute' : `${ms / 60000} min`;
  if (ms % 1000 === 0) return ms === 1000 ? 'second' : `${ms / 1000} s`;
  return `${ms} ms`;
}

export const AUTH_LABELS = {
  keyless: 'Keyless',
  apikey: 'API key',
  jwt: 'JWT',
  mtls: 'mTLS',
  'oauth2-local': 'OAuth2 (client credentials)',
  'oauth2-remote': 'OAuth2 (remote IdP)',
};

export function copyText(text) {
  try {
    navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}
