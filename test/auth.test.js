// Authentication (D-25): the Otoroshi info token, and OIDC id_token verification against a JWKS.
import { describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync, createSign } from 'node:crypto';
import { verifyOtoroshiClaim } from '../server/auth/otoroshi.js';
import { verifyJwt } from '../server/auth/oidc.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function hs(claims, secret, alg = 'HS512') {
  const h = b64({ alg, typ: 'JWT' });
  const p = b64(claims);
  const hash = { HS256: 'sha256', HS512: 'sha512' }[alg];
  return `${h}.${p}.${createHmac(hash, secret).update(`${h}.${p}`).digest('base64url')}`;
}

describe('otoroshi info token', () => {
  const secret = 'route-secret';
  const now = Date.now();
  test('a legacy info token with a user is accepted', () => {
    const t = hs({ iss: 'Otoroshi', sub: 'pa:jane@corp.eu', email: 'Jane@Corp.eu', name: 'Jane', exp: now + 30000 }, secret);
    expect(verifyOtoroshiClaim(t, { secret })).toMatchObject({ email: 'jane@corp.eu', name: 'Jane' });
  });
  test('a wrong signature, an expired token or an apikey caller are refused', () => {
    expect(() => verifyOtoroshiClaim(hs({ email: 'a@b.c', exp: now + 30000 }, 'other'), { secret })).toThrow(/signature/);
    expect(() => verifyOtoroshiClaim(hs({ email: 'a@b.c', exp: now - 120000 }, secret), { secret })).toThrow(/expired/);
    expect(() => verifyOtoroshiClaim(hs({ sub: 'apikey:abc', exp: now + 30000 }, secret), { secret })).toThrow(/no user/);
    expect(() => verifyOtoroshiClaim(undefined, { secret })).toThrow();
  });
});

describe('oidc id_token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const jwksUri = `http://localhost:${server.port}/jwks`;
  const sign = (claims, kid = 'k1') => {
    const h = b64({ alg: 'RS256', typ: 'JWT', kid });
    const p = b64(claims);
    const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
    return `${h}.${p}.${s}`;
  };
  const base = { iss: 'http://idp', aud: 'apim', nonce: 'n1', email: 'jane@corp.eu', exp: Math.floor(Date.now() / 1000) + 300 };
  const opts = { jwksUri, issuer: 'http://idp', audience: 'apim', nonce: 'n1' };

  test('a token signed by the provider is verified', async () => {
    expect((await verifyJwt(sign(base), opts)).email).toBe('jane@corp.eu');
  });
  test('issuer, audience, nonce, expiry and signature are all checked', async () => {
    await expect(verifyJwt(sign({ ...base, iss: 'http://evil' }), opts)).rejects.toThrow(/issuer/);
    await expect(verifyJwt(sign({ ...base, aud: 'other' }), opts)).rejects.toThrow(/client/);
    await expect(verifyJwt(sign({ ...base, nonce: 'n2' }), opts)).rejects.toThrow(/nonce/);
    await expect(verifyJwt(sign({ ...base, exp: 1000 }), opts)).rejects.toThrow(/expired/);
    const t = sign(base).split('.');
    await expect(verifyJwt(`${t[0]}.${b64({ ...base, email: 'admin@corp.eu' })}.${t[2]}`, opts)).rejects.toThrow(/signature/);
  });
});
