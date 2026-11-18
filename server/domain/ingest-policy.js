// What the ingester keeps, and how long. Two paths:
//  - computed: exhaustive — a call, a quota, an attribution, a token count are counted, never
//    sampled. Each call for `callsDays`, then hourly rollups for `rollupsDays`;
//  - raw: optional — sampled (errors kept), lightened, for `rawDays`.
// Personal data are pseudonymised at ingestion, before anything is stored, in both paths: the
// address of the caller, the identity of a signed-in user, its user agent, the identifiers in the
// paths. Settings key `ingest`; the key of the hashes never leaves the product.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { badRequest } from '../http/router.js';

export const IP_MODES = ['keep', 'truncate', 'hash', 'drop'];
export const USER_MODES = ['keep', 'hash', 'drop'];
export const AGENT_MODES = ['keep', 'drop'];
export const HEADER_MODES = ['keep', 'drop'];
export const PATH_MODES = ['keep', 'template'];

export const DEFAULTS = {
  storeRaw: true,
  raw: { sampleRate: 1, keepErrors: true, headers: 'keep' },
  privacy: { ip: 'keep', user: 'keep', userAgent: 'keep', paths: 'keep' },
  retention: { callsDays: 30, rollupsDays: 400, aiDays: 90, rawDays: 7 },
};

const num = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
};
const oneOf = (v, list, name) => {
  if (!list.includes(v)) throw badRequest(`${name} must be one of ${list.join(', ')}`);
  return v;
};

// the settings as stored, completed and checked
export function normalize(input = {}, current = {}) {
  const base = merge(current);
  const s = {
    storeRaw: input.storeRaw ?? base.storeRaw,
    raw: { ...base.raw, ...(input.raw || {}) },
    privacy: { ...base.privacy, ...(input.privacy || {}) },
    retention: { ...base.retention, ...(input.retention || {}) },
    key: base.key,
  };
  s.storeRaw = !!s.storeRaw;
  s.raw.sampleRate = num(s.raw.sampleRate, 0, 1, 'raw.sampleRate');
  s.raw.keepErrors = !!s.raw.keepErrors;
  s.raw.headers = oneOf(s.raw.headers, HEADER_MODES, 'raw.headers');
  s.privacy.ip = oneOf(s.privacy.ip, IP_MODES, 'privacy.ip');
  s.privacy.user = oneOf(s.privacy.user, USER_MODES, 'privacy.user');
  s.privacy.userAgent = oneOf(s.privacy.userAgent, AGENT_MODES, 'privacy.userAgent');
  s.privacy.paths = oneOf(s.privacy.paths, PATH_MODES, 'privacy.paths');
  s.retention.callsDays = num(s.retention.callsDays, 1, 3650, 'retention.callsDays');
  s.retention.rollupsDays = num(s.retention.rollupsDays, s.retention.callsDays, 3650, 'retention.rollupsDays');
  s.retention.aiDays = num(s.retention.aiDays, 1, 3650, 'retention.aiDays');
  s.retention.rawDays = num(s.retention.rawDays, 1, 3650, 'retention.rawDays');
  // the key of the hashes: made once, kept; a new one (rotateKey) breaks the link with the past
  if (!s.key || input.rotateKey) s.key = randomBytes(32).toString('hex');
  return s;
}

function merge(stored = {}) {
  return {
    storeRaw: stored.storeRaw ?? config.ingest.storeRaw ?? DEFAULTS.storeRaw,
    raw: { ...DEFAULTS.raw, ...(stored.raw || {}) },
    privacy: { ...DEFAULTS.privacy, ...(stored.privacy || {}) },
    retention: { ...DEFAULTS.retention, ...(stored.retention || {}) },
    key: stored.key || null,
  };
}

// what the admin api shows: everything but the key
export const publicPolicy = (p) => ({ storeRaw: p.storeRaw, raw: p.raw, privacy: p.privacy, retention: p.retention, keyed: !!p.key });

let cached = null;
export async function policy() {
  if (cached && cached.at > Date.now() - 10000) return cached.value;
  const rows = await db`select value from settings where key = 'ingest'`;
  let value = merge(rows[0]?.value);
  // a hash needs a key: made at first use
  if (!value.key) {
    value = normalize({}, rows[0]?.value || {});
    await db`insert into settings (key, value) values ('ingest', ${{ ...(rows[0]?.value || {}), key: value.key }})
      on conflict (key) do update set value = settings.value || jsonb_build_object('key', ${value.key}::text), updated_at = now()`;
  }
  cached = { at: Date.now(), value };
  return value;
}

export function invalidatePolicy() {
  cached = null;
}

// ---------------------------------------------------------------- urls and paths

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

// the segments of a path that name someone or something — a number, a uuid, an email, an id —
// replaced by a placeholder: what the rollups group by, and what is kept with `paths: template`
const SEGMENTS = [
  [/^\d+$/, '{n}'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '{uuid}'],
  [/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/, '{email}'],
  [/^[0-9a-f]{16,}$/i, '{id}'],
];
const idLike = (s) => s.length >= 12 && (s.match(/\d/g) || []).length >= 4 && /^[\w.~:-]+$/.test(s);

export function templatePath(path) {
  if (!path) return path;
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch (e) {}
      for (const [re, placeholder] of SEGMENTS) if (re.test(s)) return placeholder;
      return idLike(s) ? '{id}' : seg;
    })
    .join('/');
}

// a url as the raw path keeps it: its secrets masked; with `paths: template`, its path templated
// and the values of its query left out
export function urlOf(p, url) {
  const masked = maskUrl(url);
  if (!masked || p.privacy.paths !== 'template') return masked;
  try {
    const u = new URL(masked, 'http://x');
    u.pathname = templatePath(u.pathname);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, '*');
    const out = decodeURI(u.toString());
    return masked.startsWith('http') ? out : out.replace(/^http:\/\/x/, '');
  } catch (e) {
    return masked;
  }
}

// ---------------------------------------------------------------- pseudonymisation

// a value replaced by a token: always the same for the same value and the same key — a caller can
// still be counted — never the value back without the key
export const pseudonym = (key, kind, value) => `${kind}:${createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 16)}`;

// an address cut to its network: /24 for IPv4, /48 for IPv6
export function truncateIp(ip) {
  const v = String(ip || '').trim();
  if (!v) return v;
  if (v.includes(':') && !v.includes('.')) {
    const parts = v.split('::')[0].split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':')}::`;
  }
  const four = v.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return four ? `${four[1]}.${four[2]}.${four[3]}.0` : v;
}

export function ipOf(p, ip) {
  if (ip === null || ip === undefined || ip === '') return ip ?? null;
  switch (p.privacy.ip) {
    case 'truncate':
      // a list of proxies (x-forwarded-for) is cut address by address
      return String(ip)
        .split(',')
        .map((a) => truncateIp(a))
        .join(', ');
    case 'hash':
      return pseudonym(p.key, 'ip', ip);
    case 'drop':
      return null;
    default:
      return ip;
  }
}

export function userOf(p, user) {
  if (!user) return user;
  if (p.privacy.user === 'hash') return pseudonym(p.key, 'user', user);
  if (p.privacy.user === 'drop') return null;
  return user;
}

export const agentOf = (p, agent) => (p.privacy.userAgent === 'drop' ? null : agent);

// the headers that carry the address of the caller, or its agent
const IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip', 'cf-connecting-ip', 'x-client-ip'];

function headers(p, list) {
  if (!Array.isArray(list)) return list;
  return list
    .map((h) => {
      const k = String(h?.key || '').toLowerCase();
      if (IP_HEADERS.includes(k)) {
        const v = ipOf(p, h.value);
        return v === null ? null : { ...h, value: v };
      }
      if (k === 'user-agent') return p.privacy.userAgent === 'drop' ? null : h;
      return h;
    })
    .filter(Boolean);
}

// an event of the raw path, its personal data pseudonymised
export function pseudonymise(p, event) {
  const e = { ...event };
  if ('from' in e) e.from = ipOf(p, e.from);
  if (e.headers) e.headers = headers(p, e.headers);
  if (e.headersOut) e.headersOut = headers(p, e.headersOut);
  // a signed-in user: its email, its name
  if (e.identity && e.identity.identityType && e.identity.identityType !== 'APIKEY') e.identity = { ...e.identity, identity: userOf(p, e.identity.identity), label: userOf(p, e.identity.label) };
  if (e.user && typeof e.user === 'object') e.user = { ...e.user, email: userOf(p, e.user.email), name: userOf(p, e.user.name) };
  // derived from the address and the agent: they go with them
  if (p.privacy.ip !== 'keep') delete e.geolocationInfo;
  if (p.privacy.userAgent === 'drop') delete e.userAgentInfo;
  return e;
}

// ---------------------------------------------------------------- sampling

// the raw path keeps a share of the events, decided by their request: the events of one request
// (its call, its AI audit) are kept together. Errors are kept whatever the share
export function sampled(p, event) {
  if (p.raw.keepErrors && (event.err || Number(event.status) >= 400)) return true;
  const rate = p.raw.sampleRate;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const id = String(event.reqId || event['@id'] || Math.random());
  return parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) / 0xffffffff < rate;
}
