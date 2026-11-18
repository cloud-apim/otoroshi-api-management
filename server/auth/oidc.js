// OpenID Connect, authorization code flow with PKCE (one IdP for the console, one per
// workspace portal). No library: discovery, token exchange and id_token verification against the
// IdP's JWKS with WebCrypto.

import { db } from '../db/index.js';

const discoveryCache = new Map();
const jwksCache = new Map();

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

export async function discover(issuer) {
  const key = issuer.replace(/\/$/, '');
  const hit = discoveryCache.get(key);
  if (hit && hit.at > Date.now() - 300000) return hit.value;
  const value = await getJson(`${key}/.well-known/openid-configuration`);
  discoveryCache.set(key, { at: Date.now(), value });
  return value;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// the state of a login in flight, single use, short-lived
async function saveState(data) {
  const id = randomToken(24);
  await db`insert into auth_states (id, data, expires_at) values (${id}, ${data}, now() + interval '10 minutes')`;
  return id;
}

export async function consumeState(id) {
  if (!id) return null;
  const rows = await db`delete from auth_states where id = ${id} and expires_at > now() returning data`;
  await db`delete from auth_states where expires_at < now()`;
  return rows[0]?.data || null;
}

export async function authorizeUrl(settings, { redirectUri, context }) {
  const meta = await discover(settings.issuer);
  const verifier = randomToken(48);
  const nonce = randomToken(16);
  const state = await saveState({ verifier, nonce, redirectUri, context, issuer: settings.issuer });
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', settings.scopes || 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', await sha256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

const ALGS = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
  PS256: { name: 'RSA-PSS', hash: 'SHA-256', saltLength: 32 },
  ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' },
  ES384: { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-384' },
};

async function jwks(uri, force = false) {
  const hit = jwksCache.get(uri);
  if (!force && hit && hit.at > Date.now() - 600000) return hit.value;
  const value = await getJson(uri);
  jwksCache.set(uri, { at: Date.now(), value });
  return value;
}

export async function verifyJwt(token, { jwksUri, issuer, audience, nonce }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const alg = ALGS[header.alg];
  if (!alg) throw new Error(`unsupported alg ${header.alg}`);
  let set = await jwks(jwksUri);
  let jwk = set.keys.find((k) => (header.kid ? k.kid === header.kid : true));
  if (!jwk) {
    set = await jwks(jwksUri, true); // key rotation
    jwk = set.keys.find((k) => (header.kid ? k.kid === header.kid : true));
  }
  if (!jwk) throw new Error('no matching key in the jwks');
  const importAlg = alg.name === 'ECDSA' ? { name: 'ECDSA', namedCurve: alg.namedCurve } : { name: alg.name, hash: alg.hash };
  const key = await crypto.subtle.importKey('jwk', jwk, importAlg, false, ['verify']);
  const verifyAlg = alg.name === 'ECDSA' ? { name: 'ECDSA', hash: alg.hash } : alg.name === 'RSA-PSS' ? { name: 'RSA-PSS', saltLength: alg.saltLength } : { name: alg.name };
  const ok = await crypto.subtle.verify(verifyAlg, key, Buffer.from(parts[2], 'base64url'), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('invalid token signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now - 30) throw new Error('token expired');
  if (issuer && claims.iss !== issuer && claims.iss !== issuer.replace(/\/$/, '')) throw new Error(`unexpected issuer ${claims.iss}`);
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error('token not issued for this client');
  }
  if (nonce && claims.nonce !== nonce) throw new Error('nonce mismatch');
  return claims;
}

// exchanges the code, verifies the id_token, and returns the identity it carries
export async function completeLogin(settings, { code, state: stateId }) {
  const state = await consumeState(stateId);
  if (!state) throw new Error('unknown or expired login state');
  const meta = await discover(state.issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: state.redirectUri,
    client_id: settings.clientId,
    code_verifier: state.verifier,
  });
  if (settings.clientSecret) body.set('client_secret', settings.clientSecret);
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok || !tokens.id_token) throw new Error(`token exchange failed: ${tokens.error_description || tokens.error || res.status}`);
  const claims = await verifyJwt(tokens.id_token, { jwksUri: meta.jwks_uri, issuer: meta.issuer, audience: settings.clientId, nonce: state.nonce });
  const emailClaim = settings.emailClaim || 'email';
  const email = claims[emailClaim] || (String(claims.sub || '').includes('@') ? claims.sub : null);
  if (!email) throw new Error(`the id_token carries no "${emailClaim}" claim`);
  return { email: String(email).toLowerCase(), name: claims[settings.nameClaim || 'name'] || claims.preferred_username || email.split('@')[0], claims, context: state.context };
}

