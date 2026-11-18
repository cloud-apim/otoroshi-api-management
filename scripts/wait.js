#!/usr/bin/env bun
// Waits for the stack: the Otoroshi admin api, then the product. Used by `mise run up`.
const OTOROSHI = process.env.OTOROSHI_URL || 'http://localhost:8080';
const APIM = process.env.APIM_URL || 'http://localhost:9000';
const deadline = Date.now() + 180000;

async function until(label, fn) {
  process.stdout.write(`waiting for ${label} `);
  while (Date.now() < deadline) {
    try {
      if (await fn()) {
        console.log('ok');
        return;
      }
    } catch (e) {}
    process.stdout.write('.');
    await Bun.sleep(2000);
  }
  console.log('timeout');
  process.exit(1);
}

await until('otoroshi', async () => {
  const r = await fetch(`${OTOROSHI}/api/verifiers`, {
    headers: { Host: 'otoroshi-api.oto.tools', Authorization: 'Basic ' + btoa('apim-admin-client:apim-admin-secret') },
    signal: AbortSignal.timeout(2000),
  });
  return r.status === 200;
});
await until('the product', async () => (await fetch(`${APIM}/health`, { signal: AbortSignal.timeout(2000) })).ok);
console.log(`console http://localhost:9000/backoffice/ · portal http://localhost:9000/default/`);
