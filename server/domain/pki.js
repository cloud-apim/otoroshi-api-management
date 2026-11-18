// Certificates an api description carries (the trusted CAs of an mtls plan): read them, and say
// how Otoroshi will see their subject.
import { X509Certificate, createHash } from 'node:crypto';

export function readCertificate(pem) {
  const text = String(pem || '').trim();
  if (!text.includes('-----BEGIN CERTIFICATE-----')) throw new Error('not a PEM certificate');
  const c = new X509Certificate(text);
  return {
    subject: c.subject.split('\n').join(', '),
    issuer: c.issuer.split('\n').join(', '),
    ca: c.ca,
    validFrom: new Date(c.validFrom).toISOString(),
    validTo: new Date(c.validTo).toISOString(),
    fingerprint: c.fingerprint256,
    dn: otoroshiDn(c.subject),
  };
}

export const certificateKey = (pem) => createHash('sha256').update(String(pem || '').replace(/\s+/g, '')).digest('hex').slice(0, 16);

// Otoroshi compares DNs in its own normal form (`utils/httpclient.scala`, `DN.stringify`): the
// attributes split on ",", named in upper case, sorted by name in descending order, joined with
// ", ". Only plain DNs can be predicted: well-known attributes, values without the characters
// RFC 2253 escapes. Anything else returns null, and the plan has to give its issuer pattern.
const PLAIN_ATTRIBUTES = new Set(['cn', 'c', 'l', 'st', 'o', 'ou', 'dc', 'uid', 'street']);

export function otoroshiDn(subject) {
  const parts = String(subject || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('=');
      return i < 0 ? null : { name: l.slice(0, i).trim().toLowerCase(), value: l.slice(i + 1).trim() };
    });
  if (!parts.length || parts.some((p) => !p || !PLAIN_ATTRIBUTES.has(p.name) || /[,+"\\<>;=#]/.test(p.value) || !p.value)) return null;
  return parts
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    .map((p) => `${p.name.toUpperCase()}=${p.value}`)
    .join(', ');
}

// the issuer patterns that accept the certificates the given CAs signed, and nothing else
export function issuerPatterns(pems) {
  const out = [];
  for (const pem of pems || []) {
    let dn = null;
    try {
      dn = new X509Certificate(String(pem).trim()).subject;
    } catch (e) {
      return null;
    }
    const normal = otoroshiDn(dn);
    if (!normal) return null;
    out.push(`\\Q${normal}\\E`);
  }
  return out;
}
