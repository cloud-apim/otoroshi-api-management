// The setup of the gateway, on the command line: its flags, and how a report reads. Shared by
// `apim gateway setup` (through the admin api) and `otoroshi-apim setup` (in the binary, in process).

export const SETUP_HELP = `  [--only key,exporter,console,portals,tls]   some parts only (default: all)
  [--dry-run]                                 what it would change, changing nothing
  [--admin-client-id id --admin-client-secret s]   an Otoroshi admin key, for this run only
                                              (env OTOROSHI_ADMIN_CLIENT_ID, OTOROSHI_ADMIN_CLIENT_SECRET)
  [--product-url u]                           the product as the gateway reaches it
  [--exporter-url u]                          the ingester as the gateway reaches it (default <product url>/ingest)
  [--console-host h] [--console-auth-module id]   the host of the console, the auth module in front of it
  [--portal-host h]                           the host of the portals (*.domain in hostname form)
  [--client-auth Want|Need]                   the gateway asks callers for a client certificate
  [--rotate-key]                              a new secret for the key of the product`;

const OPTION_FLAGS = {
  'product-url': 'productUrl',
  'exporter-url': 'exporterUrl',
  'console-host': 'consoleHost',
  'console-auth-module': 'consoleAuthModule',
  'portal-host': 'portalHost',
  'client-auth': 'clientAuth',
};

export function setupRequest(flags, env = process.env) {
  const options = {};
  for (const [flag, key] of Object.entries(OPTION_FLAGS)) if (typeof flags[flag] === 'string') options[key] = flags[flag];
  if (flags['rotate-key']) options.rotateKey = true;
  const clientId = flags['admin-client-id'] || env.OTOROSHI_ADMIN_CLIENT_ID;
  const clientSecret = flags['admin-client-secret'] || env.OTOROSHI_ADMIN_CLIENT_SECRET;
  return {
    only: typeof flags.only === 'string' ? flags.only.split(',').map((x) => x.trim()).filter(Boolean) : null,
    dryRun: !!flags['dry-run'],
    otoroshi: clientId && clientSecret ? { clientId, clientSecret } : null,
    options,
  };
}

const MARK = { ok: '✓', changed: '✓', would_change: '~', skipped: '–', error: '✗', warning: '!' };
const OPS = { create: '+', update: '~', unchanged: '=', remove: '-' };

export function formatSetup(report) {
  const lines = [report.dryRun ? 'Gateway setup — dry run, nothing changed' : 'Gateway setup'];
  for (const p of report.parts) {
    lines.push(`${MARK[p.status] || '?'} ${p.part.padEnd(9)} ${p.status.replace('_', ' ')}`);
    for (const a of p.actions) {
      lines.push(`    ${OPS[a.op] || a.op} ${a.kind} ${a.id}${a.name ? ` (${a.name})` : ''}`);
      for (const c of a.changes || []) lines.push(`        ${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
    }
    for (const n of p.notes) lines.push(`    ${n}`);
  }
  if (report.checks?.length) {
    lines.push('Checks');
    for (const c of report.checks) lines.push(`${MARK[c.level] || '?'} ${c.message}`);
  }
  return lines.join('\n');
}

// a run that failed somewhere: a part in error, or a check in error
export const failed = (report) => report.parts.some((p) => p.status === 'error') || (report.checks || []).some((c) => c.level === 'error');
