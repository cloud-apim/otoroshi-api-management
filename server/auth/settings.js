// Authentication settings. Console: installation-level; portal: per workspace.
//
// | mode     | what                                            | composable |
// |----------|-------------------------------------------------|------------|
// | local    | bootstrap admins + accounts stored here         | yes        |
// | oidc     | delegated to the customer's IdP                 | yes, with local |
// | otoroshi | identity read in the Otoroshi info token header | no: exclusive |

import { config } from '../config.js';
import { db } from '../db/index.js';
import { open } from '../domain/secrets.js';

const env = process.env;

let cached = null;

export async function consoleAuth() {
  if (cached && cached.at > Date.now() - 5000) return cached.value;
  const stored = (await db`select value from settings where key = 'auth'`)[0]?.value || {};
  const value = {
    mode: stored.mode || env.APIM_CONSOLE_AUTH || 'local', // local | otoroshi
    oidc: {
      enabled: stored.oidc?.enabled ?? !!env.APIM_OIDC_ISSUER,
      label: stored.oidc?.label || env.APIM_OIDC_LABEL || 'single sign-on',
      issuer: stored.oidc?.issuer || env.APIM_OIDC_ISSUER || '',
      clientId: stored.oidc?.clientId || env.APIM_OIDC_CLIENT_ID || '',
      clientSecret: open(stored.oidc?.clientSecret) || env.APIM_OIDC_CLIENT_SECRET || '',
      scopes: stored.oidc?.scopes || env.APIM_OIDC_SCOPES || 'openid email profile',
      emailClaim: stored.oidc?.emailClaim || 'email',
      nameClaim: stored.oidc?.nameClaim || 'name',
      // the local form can be hidden once the IdP is the norm; bootstrap admins keep their entry
      localLogin: stored.oidc?.localLogin ?? true,
    },
    otoroshi: {
      header: stored.otoroshi?.header || env.APIM_OTOROSHI_CLAIM_HEADER || 'Otoroshi-Claim',
      secret: open(stored.otoroshi?.secret) || env.APIM_OTOROSHI_CLAIM_SECRET || '',
      issuer: stored.otoroshi?.issuer || '',
    },
  };
  cached = { at: Date.now(), value };
  return value;
}

export function invalidateAuthSettings() {
  cached = null;
}

export function publicAuthConfig(a) {
  return {
    mode: a.mode,
    local: a.mode === 'local' && (a.oidc.localLogin || !a.oidc.enabled),
    oidc: a.mode === 'local' && a.oidc.enabled ? { label: a.oidc.label } : null,
  };
}

export function portalAuth(ws) {
  const o = ws.portal?.oidc || {};
  return {
    oidc: { enabled: !!(o.enabled && o.issuer && o.clientId), label: o.label || 'single sign-on', issuer: o.issuer, clientId: o.clientId, clientSecret: open(o.clientSecret), scopes: o.scopes || 'openid email profile', emailClaim: o.emailClaim || 'email', nameClaim: o.nameClaim || 'name' },
    localLogin: ws.portal?.localLogin !== false,
  };
}

export function redirectBase() {
  return config.publicUrl.replace(/\/$/, '');
}
