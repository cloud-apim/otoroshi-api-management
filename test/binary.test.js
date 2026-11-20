// The compiled executable (mise run build:binary), started away from the repository: the server
// answers with the files of its two faces embedded, the same program is the command line.
//
// Needs the docker stack (mise run up). Skipped when the executable is not built.

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json';

setDefaultTimeout(30000);

const BIN = join(import.meta.dir, '..', 'dist', 'bin', 'otoroshi-apim');
const built = existsSync(BIN);
const PORT = process.env.APIM_BINARY_TEST_PORT || '9118';
const ROOT = `http://localhost:${PORT}`;
const TOKEN = 'binary-test-token';
let cwd;
let server;

// a run of the executable, from a directory where there is nothing of the product
const run = async (...args) => {
  const proc = Bun.spawn([BIN, ...args], { cwd, env: { ...process.env, APIM_URL: ROOT, APIM_TOKEN: TOKEN }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
};

beforeAll(async () => {
  if (!built) return;
  cwd = mkdtempSync(join(tmpdir(), 'otoroshi-apim-'));
  server = Bun.spawn([BIN, 'serve'], { cwd, env: { ...process.env, APIM_PORT: PORT, APIM_WORKERS_ENABLED: 'false', APIM_ADMIN_TOKEN: TOKEN }, stdout: 'pipe', stderr: 'pipe' });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${ROOT}/health`).then((r) => r.ok).catch(() => false)) return;
    await Bun.sleep(100);
  }
  throw new Error('the executable did not start');
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe.skipIf(!built)('the executable', () => {
  test('the server: its roles, the console and the portal from the files it embeds', async () => {
    expect(await (await fetch(`${ROOT}/health`)).json()).toEqual({ status: 'ok', roles: ['ingester', 'api', 'backoffice', 'portal'] });
    const console = await fetch(`${ROOT}/backoffice/`);
    expect(console.headers.get('content-type')).toContain('text/html');
    const html = await console.text();
    const script = html.match(/assets\/index-[\w-]+\.js/)[0];
    const asset = await fetch(`${ROOT}/backoffice/${script}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${ROOT}/backoffice/assets/missing.js`)).status).toBe(404);
    // the portal of a workspace, and its assets
    const portal = await (await fetch(`${ROOT}/default/`)).text();
    expect(portal).toContain('window.__APIM__');
    const css = portal.match(/\/_portal\/assets\/[\w.-]+\.css/)[0];
    expect((await fetch(`${ROOT}${css}`)).headers.get('content-type')).toContain('text/css');
  });

  test('the command line: the same program', async () => {
    expect((await run('version')).out.trim()).toBe(`otoroshi-apim ${pkg.version}`);
    const help = await run('help');
    expect(help.code).toBe(0);
    expect(help.out).toContain('otoroshi-apim [serve]');
    const list = await run('workspaces', 'list', '-o', 'json');
    expect(list.code).toBe(0);
    expect(JSON.parse(list.out).map((w) => w.slug)).toContain('default');
    const unknown = await run('frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('unknown command frobnicate');
  });

  test('without DEV=true, a start for production: an incomplete configuration is refused, every gap named', async () => {
    // nothing of the development: no DEV, no variable of the product
    const bare = { PATH: process.env.PATH, HOME: process.env.HOME, APIM_PORT: '9119' };
    const start = async (env, ...args) => {
      const proc = Bun.spawn([BIN, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { err, code };
    };
    const refused = await start(bare, 'serve');
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('the configuration is incomplete for a production start');
    for (const name of ['APIM_PUBLIC_URL', 'APIM_DATABASE_URL', 'APIM_SECRETS_KEY', 'APIM_ADMIN_TOKEN', 'APIM_INGEST_TOKEN', 'OTOROSHI_CLIENT_SECRET'])
      expect(refused.err).toContain(`${name} is missing`);
    expect(refused.err).not.toContain('    at '); // a message, not a stack
    // a secret of the development stack is refused too; the setup checks the same
    const setup = await start({ ...bare, APIM_ADMIN_TOKEN: 'apim-admin-token' }, 'setup', '--dry-run');
    expect(setup.code).toBe(1);
    expect(setup.err).toContain('APIM_ADMIN_TOKEN has the value of the development stack');
  });
});
