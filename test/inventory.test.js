// The inventory of the Otoroshi entities (D-15) against the gateway of the stack: every kind it
// declares is in the inventory, with a treatment, and in the documentation.
//
// Needs the docker stack (mise run up).

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const { INVENTORY, TREATMENTS } = await import('../server/otoroshi/inventory.js');
const { otoroshi } = await import('../server/otoroshi/client.js');

describe('the inventory of the Otoroshi entities', () => {
  test('every kind the gateway declares is in it, with a treatment', async () => {
    const declared = (await otoroshi('GET', '/apis/entities')).resources.map((r) => `${r.kind} ${r.group}`);
    const known = new Set(INVENTORY.map((e) => `${e.kind} ${e.group}`));
    expect(declared.filter((k) => !known.has(k))).toEqual([]);
    for (const e of INVENTORY) expect(TREATMENTS).toContain(e.treatment);
  });

  test('the documentation lists every kind of it', () => {
    const doc = readFileSync(new URL('../documentation/docs/gateway/inventory.mdx', import.meta.url), 'utf8');
    expect(INVENTORY.filter((e) => !doc.includes(`| \`${e.kind}\` | \`${e.group}\` |`)).map((e) => e.kind)).toEqual([]);
  });

  test('the derived and projected kinds are the ones the product writes', async () => {
    const { DERIVED_PATHS } = await import('../server/otoroshi/client.js');
    const derived = INVENTORY.filter((e) => e.treatment === 'derived').map((e) => e.kind).sort();
    expect(derived).toEqual(Object.keys(DERIVED_PATHS).sort());
  });
});
