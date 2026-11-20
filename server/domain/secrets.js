// Secrets at rest: what the product keeps that opens something — the secret of a credential, the
// key the product calls the gateway with, the secrets of the identity providers, the tokens of the
// remote catalogs and of the audit exporters, the key of the pseudonyms — is sealed before it is
// stored (AES-256-GCM), with the key of the installation, APIM_SECRETS_KEY.
//
//   enc:v1:<key id>:<base64url(iv | tag | ciphertext)>
//
// The key id says which key sealed a value: a rotation sets a new key and lists the previous ones in
// APIM_SECRETS_PREVIOUS_KEYS; at start, every value sealed with another key, or stored in clear before
// a key was set, is sealed again with the current one (resealAll). A vault reference (`${vault://…}`)
// is not a secret: it is kept as it is. Without a key, secrets are stored in clear, and the setup
// check says so.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';

const material = (k) => createHash('sha256').update(String(k)).digest();
const idOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 8);

function keys() {
  const current = config.secrets.key ? material(config.secrets.key) : null;
  const previous = (config.secrets.previousKeys || []).filter(Boolean).map(material);
  const all = new Map([...(current ? [current] : []), ...previous].map((k) => [idOf(k), k]));
  return { current, currentId: current ? idOf(current) : null, all };
}

export const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);
const isVaultRef = (v) => typeof v === 'string' && /^\$\{vault:\/\/.+\}$/.test(v.trim());

// the value sealed with the current key; nothing to seal without a key, nor for an empty value or a
// vault reference
export function seal(value) {
  if (value === null || value === undefined || value === '' || isVaultRef(value)) return value;
  const { current, currentId } = keys();
  if (!current) return value;
  if (isSealed(value)) {
    if (value.startsWith(`${PREFIX}${currentId}:`)) return value;
    value = open(value);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${PREFIX}${currentId}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
}

// the value in clear: a value stored before encryption is read as it is
export function open(value) {
  if (!isSealed(value)) return value;
  const [kid, payload] = value.slice(PREFIX.length).split(':');
  const key = keys().all.get(kid);
  if (!key) throw new Error(`a secret is sealed with the key ${kid}, which this instance does not have: set APIM_SECRETS_KEY, or list it in APIM_SECRETS_PREVIOUS_KEYS`);
  const buf = Buffer.from(payload, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

// whether a value is as the current key would store it: sealed with it, or nothing to seal
export const current = (value) => seal(value) === value;

// the values of a map (headers) sealed, or opened
export const sealValues = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, seal(v)]));
export const openValues = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, open(v)]));

export function secretsStatus() {
  const { current: key, currentId, all } = keys();
  return { encrypted: !!key, keyId: currentId, previousKeys: Math.max(0, all.size - (key ? 1 : 0)) };
}
