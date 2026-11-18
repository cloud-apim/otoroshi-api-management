#!/usr/bin/env bun
// otoroshi-apim — one program, compiled into one executable (scripts/build-binary.js):
//   otoroshi-apim                  the server, with the roles of APIM_ROLES
//   otoroshi-apim serve            the same
//   otoroshi-apim version          its version
//   otoroshi-apim setup …          what the product needs on the gateway (server/setup-command.js)
//   otoroshi-apim <command> …      the command line (otoroshi-apim help)

import pkg from '../package.json';

globalThis.__APIM_BIN__ = true;
const cmd = process.argv[2];

if (!cmd || cmd === 'serve') {
  const { start } = await import('./main.js');
  try {
    await start();
  } catch (e) {
    console.error('[apim] failed to start', e);
    process.exit(1);
  }
} else if (cmd === 'setup') {
  const { setupCommand } = await import('./setup-command.js');
  process.exit(await setupCommand(process.argv.slice(3)));
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  console.log(`otoroshi-apim ${pkg.version}`);
} else {
  // the command line reads its own arguments
  await import('../cli/apim.js');
}
