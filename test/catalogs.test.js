// Remote catalogs: the git source reads every api document of a repository directory.
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchGit } from '../server/domain/catalogs.js';

function git(cwd, ...args) {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

describe('git remote catalog', () => {
  test('reads the yaml and json documents of a directory, on a branch, with the commit as revision', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'apim-catalog-test-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      await mkdir(join(repo, 'apis', 'team-a'), { recursive: true });
      await writeFile(join(repo, 'apis', 'one.yaml'), 'apiVersion: otoroshi-apim.io/v1\nkind: Api\nmetadata: { name: one }\n---\napiVersion: otoroshi-apim.io/v1\nkind: Api\nmetadata: { name: two }\n');
      await writeFile(join(repo, 'apis', 'team-a', 'three.json'), JSON.stringify({ apiVersion: 'otoroshi-apim.io/v1', kind: 'Api', metadata: { name: 'three' } }));
      await writeFile(join(repo, 'README.md'), 'not a document');
      await writeFile(join(repo, 'outside.yaml'), 'kind: Api\nmetadata: { name: outside }\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'catalog');
      const head = git(repo, 'rev-parse', 'HEAD');
      const res = await fetchGit({ url: `file://${repo}`, ref: 'main', path: 'apis' });
      expect(res.revision).toBe(head);
      expect(res.docs.map((d) => d.metadata.name).sort()).toEqual(['one', 'three', 'two']);
      expect(res.docs.find((d) => d.metadata.name === 'three')._source).toBe('apis/team-a/three.json');
      await expect(fetchGit({ url: `file://${repo}`, path: '../..' })).rejects.toThrow(/leaves the repository/);
      await expect(fetchGit({ url: `file://${repo}`, ref: 'nope' })).rejects.toThrow(/git clone failed/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('the portal of the workspace: its pages, templates and assets read from the repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'apim-catalog-test-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      await mkdir(join(repo, 'portal', 'templates'), { recursive: true });
      await mkdir(join(repo, 'portal', 'assets'), { recursive: true });
      await writeFile(join(repo, 'portal', 'templates', 'home.en.md'), '# From git');
      await writeFile(join(repo, 'portal', 'styles.css'), 'body { color: #222; }');
      await writeFile(join(repo, 'portal', 'assets', 'logo.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
      await writeFile(
        join(repo, 'portal', 'portal.yaml'),
        'apiVersion: otoroshi-apim.io/v1\nkind: Portal\nmetadata: { name: default }\nspec:\n  mode: templates\n  templates:\n    home: { en: { file: templates/home.en.md } }\n  css: { file: styles.css }\n  assets:\n    - { path: assets/logo.png, file: assets/logo.png }\n'
      );
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'portal');
      const [doc] = (await fetchGit({ url: `file://${repo}` })).docs;
      expect(doc.kind).toBe('Portal');
      expect(doc.spec.templates.home.en).toBe('# From git');
      expect(doc.spec.css).toBe('body { color: #222; }');
      expect(doc.spec.assets[0]).toEqual({ path: 'assets/logo.png', contentType: 'image/png', data: 'iVBORw0KGgo=' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('the content of a page given by a file beside the document, read from the repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'apim-catalog-test-'));
    const page = (file) => `apiVersion: otoroshi-apim.io/v1\nkind: Api\nmetadata: { name: docs }\nspec:\n  version: 1.0.0\n  pages:\n    - slug: start\n      title: { en: Start }\n      content: { en: { file: ${file} } }\n`;
    try {
      git(repo, 'init', '-q', '-b', 'main');
      await mkdir(join(repo, 'apis', 'docs'), { recursive: true });
      await writeFile(join(repo, 'apis', 'docs', 'start.en.md'), '# Started from a file');
      await writeFile(join(repo, 'apis', 'docs.yaml'), page('docs/start.en.md'));
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', 'catalog');
      const res = await fetchGit({ url: `file://${repo}`, path: 'apis' });
      expect(res.docs[0].spec.pages[0].content.en).toBe('# Started from a file');
      // a path that leaves the document is refused, the source with it
      await writeFile(join(repo, 'apis', 'docs.yaml'), page('../../etc/passwd'));
      git(repo, 'commit', '-q', '-am', 'escape');
      await expect(fetchGit({ url: `file://${repo}`, path: 'apis' })).rejects.toThrow(/within its source/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// an object store that speaks the api of S3, enough of it: the listing (two keys a page) and the objects
function fakeS3(objects) {
  const requests = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      requests.push({ path: u.pathname, auth: req.headers.get('authorization') || '' });
      const [, bucket, ...rest] = u.pathname.split('/');
      if (bucket !== 'catalog') return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
      if (!rest.join('')) {
        const prefix = u.searchParams.get('prefix') || '';
        const keys = Object.keys(objects).filter((k) => k.startsWith(prefix)).sort();
        const from = Number(u.searchParams.get('continuation-token') || 0);
        const page = keys.slice(from, from + 2);
        const more = from + 2 < keys.length;
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ''}${page
          .map((k) => `<Contents><Key>${k}</Key><LastModified>2026-11-20T00:00:00.000Z</LastModified><ETag>"${Bun.hash(objects[k]).toString(16)}"</ETag><Size>${objects[k].length}</Size></Contents>`)
          .join('')}</ListBucketResult>`;
        return new Response(xml, { headers: { 'content-type': 'application/xml' } });
      }
      const key = decodeURIComponent(rest.join('/'));
      return key in objects ? new Response(objects[key]) : new Response('', { status: 404 });
    },
  });
  return { server, requests, endpoint: `http://127.0.0.1:${server.port}` };
}

describe('s3 remote catalog', () => {
  test('reads every yaml and json object under the prefix, page by page, signed with its keys', async () => {
    const { fetchS3 } = await import('../server/domain/catalogs.js');
    const doc = (name) => `apiVersion: otoroshi-apim.io/v1\nkind: Api\nmetadata: { name: ${name} }\n`;
    const objects = {
      'apis/one.yaml': `${doc('one')}---\n${doc('two')}`,
      'apis/team-a/three.json': JSON.stringify({ apiVersion: 'otoroshi-apim.io/v1', kind: 'Api', metadata: { name: 'three' } }),
      'apis/README.md': 'not a document',
      'apis/.drafts/hidden.yaml': doc('hidden'),
      'other/outside.yaml': doc('outside'),
    };
    const s3 = fakeS3(objects);
    try {
      const cat = { url: 's3://catalog/apis/', options: { endpoint: s3.endpoint, region: 'us-east-1' }, headers: { access_key_id: 'AKIACATALOG', secret_access_key: 'catalog-secret' } };
      const res = await fetchS3(cat);
      expect(res.docs.map((d) => d.metadata.name).sort()).toEqual(['one', 'three', 'two']);
      expect(res.docs.find((d) => d.metadata.name === 'three')._source).toBe('apis/team-a/three.json');
      // the listing went over its pages; every request signed with the access key
      expect(s3.requests.filter((r) => r.path === '/catalog/').length).toBe(2);
      expect(s3.requests.every((r) => r.auth.includes('Credential=AKIACATALOG/'))).toBe(true);
      // the revision follows the objects: the same source, the same revision; an object changed, another
      expect((await fetchS3(cat)).revision).toBe(res.revision);
      objects['apis/one.yaml'] = doc('one');
      expect((await fetchS3(cat)).revision).not.toBe(res.revision);
      await expect(fetchS3({ ...cat, url: 'https://not-s3' })).rejects.toThrow(/s3:\/\//);
    } finally {
      s3.server.stop(true);
    }
  });

  test('the content of a page given by a file beside the document, under the prefix', async () => {
    const { fetchS3 } = await import('../server/domain/catalogs.js');
    const objects = {
      'apis/docs.yaml': 'apiVersion: otoroshi-apim.io/v1\nkind: Api\nmetadata: { name: docs }\nspec:\n  pages:\n    - slug: start\n      content: { en: { file: docs/start.en.md } }\n',
      'apis/docs/start.en.md': '# From the bucket',
    };
    const s3 = fakeS3(objects);
    try {
      const cat = { url: 's3://catalog/apis/', options: { endpoint: s3.endpoint, region: 'us-east-1' }, headers: { access_key_id: 'AKIACATALOG', secret_access_key: 'catalog-secret' } };
      expect((await fetchS3(cat)).docs[0].spec.pages[0].content.en).toBe('# From the bucket');
    } finally {
      s3.server.stop(true);
    }
  });
});
