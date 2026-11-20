// `otoroshi-apim setup`: the setup of the gateway run by the binary itself, in process — no server
// needed, only the databases of the product and an Otoroshi admin key. Re-runnable at will.
//
//   otoroshi-apim setup --admin-client-id … --admin-client-secret … [--dry-run] [--only exporter,portals]

import { SETUP_HELP, failed, formatSetup, setupRequest } from '../cli/setup.js';

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') flags.output = argv[++i];
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    }
  }
  return flags;
}

export async function setupCommand(argv) {
  const flags = parse(argv);
  if (flags.help) {
    console.log(`otoroshi-apim setup — what the product needs on the gateway, created or repaired\n\n${SETUP_HELP}\n  [-o json]`);
    return 0;
  }
  const { checkProductionConfig } = await import('./config.js');
  try {
    checkProductionConfig();
  } catch (e) {
    if (!e.config) throw e;
    console.error(e.message);
    return 1;
  }
  const { migrateAll } = await import('./db/index.js');
  const { runSetup } = await import('./domain/setup.js');
  await migrateAll();
  const req = setupRequest(flags);
  const report = await runSetup({ only: req.only, dryRun: req.dryRun, creds: req.otoroshi, options: req.options, actor: 'otoroshi-apim setup' });
  console.log(flags.output === 'json' ? JSON.stringify(report, null, 2) : formatSetup(report));
  return failed(report) ? 1 : 0;
}
