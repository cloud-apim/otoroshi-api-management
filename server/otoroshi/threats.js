// The Threat Protection Suite (otoroshi-waf-extension) on the plans of an api. The product
// configures it and renders its events, it never implements it: a plan carries the preset of the
// extension in its plugins, and references the policies of the extension, which stay the
// operator's. A gateway without the extension ignores a plugin it does not know — the calls would
// go through unprotected — so a draft that asks for it on such a gateway is warned.

import { gatewayPlugins, oto } from './client.js';
import { THREAT_PRESET } from './projection.js';
import { SERVED_STATUSES, normalizeDraft } from '../domain/model.js';

const GROUP = '/apis/waf.extensions.cloud-apim.com/v1';
const KINDS = { threat_policies: 'threat-policies', bot_policies: 'bot-policies', waf_configs: 'waf-configs', api_contracts: 'api-contracts' };

// null when the catalog of the gateway cannot be read: nothing is said then
export async function threatProtectionInstalled() {
  const catalog = await gatewayPlugins();
  if (!catalog.length) return null;
  return catalog.some((p) => p.id === THREAT_PRESET);
}

export async function threatProtectionCatalog() {
  const installed = await threatProtectionInstalled();
  const out = { installed, plugin: THREAT_PRESET };
  if (installed === false) return out;
  for (const [key, kind] of Object.entries(KINDS)) {
    const list = await oto.listEntities(`${GROUP}/${kind}`).catch(() => null);
    out[key] = (Array.isArray(list) ? list : []).map((e) => ({
      id: e.id,
      name: e.name || e.id,
      description: e.description || '',
      // a threat policy in dry run records and never refuses; a challenge tier answers a page
      ...(kind === 'threat-policies'
        ? {
            dry_run: e.dry_run !== false,
            challenge: (e.tiers || []).some((t) => String(t.action || '').toLowerCase() === 'challenge'),
          }
        : {}),
    }));
  }
  return out;
}

// the warnings a draft gets from the gateway it would run on
export async function threatWarnings(draft) {
  const plans = normalizeDraft(draft).plans.filter((p) => SERVED_STATUSES.includes(p.status) && p.threatProtection.enabled);
  if (!plans.length) return [];
  const installed = await threatProtectionInstalled();
  if (installed !== false) return [];
  return [
    {
      path: 'plans',
      code: 'threat_protection_unavailable',
      message: `the gateway has no Threat Protection Suite: the plan${plans.length > 1 ? 's' : ''} ${plans.map((p) => `"${p.name}"`).join(', ')} would run unprotected — an operator installs the extension first`,
    },
  ];
}
