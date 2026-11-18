// "Via Otoroshi" authentication: the gateway authenticated the user upstream (an auth module
// on the route that exposes the console) and passes its identity in the Otoroshi info token
// (`OtoroshiInfos` plugin, legacy version), a JWT signed with a secret shared with the route.
// This mode is exclusive: with the identity coming from a header, there is no login form, and no
// fallback entry — a gateway outage locks the console, which is the documented trade-off.

import { createHmac, timingSafeEqual } from 'node:crypto';

const HASH = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };

export function verifyOtoroshiClaim(token, { secret, issuer }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('no otoroshi claim');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const hash = HASH[header.alg];
  if (!hash) throw new Error(`unsupported alg ${header.alg}`);
  const expected = createHmac(hash, secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('invalid otoroshi claim signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  // exp is in ms in the legacy info token, in s in standard jwts
  const exp = claims.exp > 1e12 ? claims.exp / 1000 : claims.exp;
  if (exp && exp < Date.now() / 1000 - 30) throw new Error('otoroshi claim expired');
  if (issuer && claims.iss !== issuer) throw new Error(`unexpected issuer ${claims.iss}`);
  const email = claims.email || (String(claims.sub || '').startsWith('pa:') ? claims.sub.slice(3) : null);
  if (!email) throw new Error('the otoroshi claim carries no user (is an auth module set on the route?)');
  return { email: String(email).toLowerCase(), name: claims.name || email.split('@')[0], claims };
}
