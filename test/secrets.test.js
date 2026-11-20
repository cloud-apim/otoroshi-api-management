// Secrets at rest: sealed with the key of the installation before they are stored, read in clear by
// the product, sealed again with a new key at start; a plan secret in clear is flagged.
//
// The unit part needs nothing; the end-to-end part needs the docker stack (mise run up).

import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60000);

const { config } = await import('../server/config.js');
config.port = parseInt(process.env.APIM_TEST_PORT || '9117', 10);
config.workers.enabled = false;
config.adminToken = 'secrets-test-token';

const { isSealed, open, seal, secretsStatus } = await import('../server/domain/secrets.js');
const { validateDraft, normalizeDraft, defaultPlan } = await import('../server/domain/model.js');

const KEY = config.secrets.key;
function withKeys(current, previous, fn) {
  const saved = { ...config.secrets };
  config.secrets.key = current;
  config.secrets.previousKeys = previous ? previous.split(',') : [];
  try {
    return fn();
  } finally {
    Object.assign(config.secrets, saved);
  }
}

describe('sealing', () => {
  test('a secret is sealed, opened, and never stored twice the same', () => {
    const a = seal('s3cret');
    expect(isSealed(a)).toBe(true);
    expect(a).not.toContain('s3cret');
    expect(open(a)).toBe('s3cret');
    expect(seal('s3cret')).not.toBe(a);
    // sealed with the current key: left as it is
    expect(seal(a)).toBe(a);
    // a value stored before encryption is read as it is
    expect(open('legacy')).toBe('legacy');
  });

  test('nothing to seal: empty, or a vault reference', () => {
    expect(seal('')).toBe('');
    expect(seal(null)).toBe(null);
    expect(seal('${vault://local/stripe_key}')).toBe('${vault://local/stripe_key}');
  });

  test('a rotation reads the previous key, and seals again with the new one', () => {
    const old = withKeys('key-one', '', () => seal('s3cret'));
    withKeys('key-two', 'key-one', () => {
      expect(open(old)).toBe('s3cret');
      const again = seal(old);
      expect(again).not.toBe(old);
      expect(open(again)).toBe('s3cret');
      expect(secretsStatus()).toMatchObject({ encrypted: true, previousKeys: 1 });
    });
    // a key the instance does not have: said, not guessed
    withKeys('key-three', '', () => expect(() => open(old)).toThrow(/APIM_SECRETS_PREVIOUS_KEYS/));
    // tampered: refused
    withKeys('key-one', '', () => expect(() => open(old.slice(0, -4) + 'AAAA')).toThrow());
  });

  test('without a key, secrets are stored in clear, and the status says so', () => {
    withKeys(null, '', () => {
      expect(seal('s3cret')).toBe('s3cret');
      expect(secretsStatus().encrypted).toBe(false);
    });
  });

  test('a plan secret in clear is flagged: a vault reference keeps it out of the snapshots', () => {
    const plan = (secret) =>
      defaultPlan({ id: 'p', name: 'Partner', status: 'published', auth: { kind: 'jwt', config: { derive: { enabled: true, kind: 'hmac', secret } } } });
    const codes = (secret) => validateDraft(normalizeDraft({ plans: [plan(secret)] })).warnings.map((w) => w.code);
    expect(codes('plain-secret')).toContain('secret_in_clear');
    expect(codes('${vault://local/partner_hmac}')).not.toContain('secret_in_clear');
  });
});

describe('at rest, end to end', () => {
  const RUN = Date.now().toString(36);
  const WS = `secrets-${RUN}`;
  const ROOT = `http://localhost:${config.port}`;
  let server;
  let db;
  let saved;
  const call = async (method, path, body) => {
    const res = await fetch(`${ROOT}/api${path}`, { method, headers: { authorization: 'Bearer secrets-test-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const out = await res.json().catch(() => null);
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(out)}`);
    return out;
  };

  beforeAll(async () => {
    expect(KEY).toBeTruthy();
    const { start } = await import('../server/main.js');
    db = (await import('../server/db/index.js')).db;
    server = await start();
    saved = (await db`select value from settings where key = 'auth'`)[0]?.value ?? null;
    await call('POST', '/workspaces', { name: `Secrets ${RUN}`, slug: WS });
  });

  afterAll(async () => {
    if (saved === null) await db`delete from settings where key = 'auth'`;
    else await db`update settings set value = ${saved} where key = 'auth'`;
    (await import('../server/auth/settings.js')).invalidateAuthSettings();
    await call('DELETE', `/workspaces/${WS}`).catch(() => null);
    server?.stop(true);
  });

  test('the secrets of the settings and of a portal are sealed, and read in clear', async () => {
    await call('PUT', '/settings/auth', { oidc: { enabled: false, clientSecret: `idp-secret-${RUN}` } });
    const stored = (await db`select value from settings where key = 'auth'`)[0].value;
    expect(isSealed(stored.oidc.clientSecret)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(`idp-secret-${RUN}`);
    const { consoleAuth, invalidateAuthSettings } = await import('../server/auth/settings.js');
    invalidateAuthSettings();
    expect((await consoleAuth()).oidc.clientSecret).toBe(`idp-secret-${RUN}`);
    // a portal's identity provider
    await call('PUT', `/workspaces/${WS}`, { portal: { oidc: { enabled: false, issuer: 'https://idp.example.com', clientId: 'portal', clientSecret: `portal-secret-${RUN}` } } });
    const ws = (await db`select portal from workspaces where slug = ${WS}`)[0];
    expect(isSealed(ws.portal.oidc.clientSecret)).toBe(true);
    // masked in what the api answers, kept when the console sends the mask back
    const shown = await call('GET', `/workspaces/${WS}`);
    expect((shown.workspace || shown).portal.oidc.clientSecret).toMatch(/^por••/);
  });

  test('the headers of an audit exporter are sealed, and sent in clear', async () => {
    const ex = await call('POST', '/audit/exporters', { name: `siem ${RUN}`, url: 'http://127.0.0.1:9/siem', headers: { Authorization: `Bearer siem-${RUN}`, 'X-Source': 'apim' }, enabled: false });
    const row = (await db`select headers from audit_exporters where id = ${ex.id}`)[0];
    expect(isSealed(row.headers.Authorization)).toBe(true);
    expect(isSealed(row.headers['X-Source'])).toBe(true);
    const { getExporter } = await import('../server/domain/auditExport.js');
    expect((await getExporter(ex.id)).headers.Authorization).toBe(`Bearer siem-${RUN}`);
    await call('DELETE', `/audit/exporters/${ex.id}`);
  });

  test('the keys of an s3 catalog are sealed, masked in what the api answers, and open the store', async () => {
    const doc = 'apiVersion: otoroshi-apim.io/v1\nkind: Api\nmetadata: { name: harbour }\nspec: { name: Harbour, version: 1.0.0 }\n';
    const seen = [];
    const store = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        seen.push(req.headers.get('authorization') || '');
        if (u.pathname === '/catalog/')
          return new Response(`<ListBucketResult><Name>catalog</Name><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>apis/harbour.yaml</Key><ETag>"1"</ETag><Size>${doc.length}</Size></Contents></ListBucketResult>`);
        return new Response(doc);
      },
    });
    try {
      const cat = await call('POST', `/workspaces/${WS}/catalogs`, {
        name: 'store',
        kind: 's3',
        url: 's3://catalog/apis/',
        options: { endpoint: `http://127.0.0.1:${store.port}`, region: 'us-east-1' },
        headers: { access_key_id: `AKIA${RUN}`, secret_access_key: `s3-secret-${RUN}` },
        enabled: false,
      });
      expect(cat.headers).toEqual({ access_key_id: '••••••', secret_access_key: '••••••' });
      expect(cat.options).toEqual({ endpoint: `http://127.0.0.1:${store.port}`, region: 'us-east-1' });
      const row = (await db`select headers from remote_catalogs where id = ${cat.id}`)[0];
      expect(isSealed(row.headers.secret_access_key)).toBe(true);
      const preview = await call('POST', `/workspaces/${WS}/catalogs/${cat.id}/preview`);
      expect(preview.items.map((i) => i.slug)).toEqual(['harbour']);
      expect(seen.every((a) => a.includes(`Credential=AKIA${RUN}/`))).toBe(true);
      await call('DELETE', `/workspaces/${WS}/catalogs/${cat.id}`);
    } finally {
      store.stop(true);
    }
  });

  test('a secret stored in clear before the key was set is sealed at start', async () => {
    const { resealAll } = await import('../server/domain/secrets-store.js');
    const ex = await call('POST', '/audit/exporters', { name: `legacy ${RUN}`, url: 'http://127.0.0.1:9/legacy', headers: { Authorization: 'Bearer legacy' }, enabled: false });
    await db`update audit_exporters set headers = ${{ Authorization: 'Bearer legacy' }} where id = ${ex.id}`;
    const report = await resealAll();
    expect(report.errors).toEqual([]);
    expect(report.resealed).toBeGreaterThanOrEqual(1);
    expect(isSealed((await db`select headers from audit_exporters where id = ${ex.id}`)[0].headers.Authorization)).toBe(true);
    // a second pass has nothing left to do for it
    expect((await resealAll()).resealed).toBe(0);
    await call('DELETE', `/audit/exporters/${ex.id}`);
  });
});
