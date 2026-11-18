#!/usr/bin/env bun
// Syntax-checks every javascript file of the server, the cli, the scripts and the tests.
import { Glob } from 'bun';

let failed = 0;
let count = 0;
for (const dir of ['server', 'cli', 'scripts', 'test']) {
  for await (const file of new Glob(`${dir}/**/*.js`).scan('.')) {
    count++;
    const out = Bun.spawnSync(['bun', 'build', '--no-bundle', file], { stdout: 'ignore', stderr: 'pipe' });
    if (out.exitCode !== 0) {
      failed++;
      console.error(`✗ ${file}\n${out.stderr.toString()}`);
    }
  }
}
console.log(`${count - failed}/${count} files ok`);
process.exit(failed ? 1 : 0);
