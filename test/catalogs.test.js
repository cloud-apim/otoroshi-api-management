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
});
