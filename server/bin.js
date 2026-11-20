#!/usr/bin/env bun
// otoroshi-apim — one program, compiled into one executable (scripts/build-binary.js):
//   otoroshi-apim                  the server, with the roles of APIM_ROLES
//   otoroshi-apim serve            the same
//   otoroshi-apim version          its version
//   otoroshi-apim setup …          what the product needs on the gateway (server/setup-command.js)
//   otoroshi-apim health           0 when the server of this machine answers (a probe for docker)
//   otoroshi-apim <command> …      the command line (otoroshi-apim help)

import pkg from '../package.json';

globalThis.__APIM_BIN__ = true;
const cmd = process.argv[2];

if (!cmd || cmd === 'serve') {
  const { start, stopOnSignals } = await import('./main.js');
  try {
    stopOnSignals(await start());
  } catch (e) {
    console.error('[apim] failed to start:', e.config ? e.message : e);
    process.exit(1);
  }
} else if (cmd === 'setup') {
  const { setupCommand } = await import('./setup-command.js');
  process.exit(await setupCommand(process.argv.slice(3)));
} else if (cmd === 'health') {
  // the server of this machine, on its port: an image has no curl
  const port = process.env.APIM_PORT || process.env.PORT || '9000';
  const ok = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) })
    .then((r) => r.ok)
    .catch(() => false);
  if (!ok) console.error(`no server answering on 127.0.0.1:${port}/health`);
  process.exit(ok ? 0 : 1);
} else if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
  console.log(`otoroshi-apim ${pkg.version}`);
} else {
  // the command line reads its own arguments
  await import('../cli/apim.js');
}
