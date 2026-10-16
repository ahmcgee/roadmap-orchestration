// The lens-range fix (src/holistic/lensdiff.ts), over real git: a long range splits into chunks at published heads.
// The attachment itself is src/git/boundeddiff.ts (test/boundeddiff.test.ts). Named test: lensdiff.chunks.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Sha, sha } from '../src/core/ids.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { LENS_DIFF_BUDGET, chunkEnd } from '../src/holistic/lensdiff.ts';
import { commitAll, makeRepo, revParse, tmpDir, writeFiles } from './helpers/repo.ts';

/** `n` bytes of source: numbered lines of 50 bytes. */
const source = (tag: string, n: number): string =>
  Array.from({ length: Math.ceil(n / 50) }, (_, i) => `${`export const ${tag}${i.toString().padStart(6, '0')} = 1;`.padEnd(49)}\n`).join('');
const at = (repo: string, files: Record<string, string>, message: string): Sha => {
  writeFiles(repo, files);
  return sha(commitAll(repo, message));
};

describe('lens diffs', () => {
  test('lensdiff.chunks: a range over the budget ends at the furthest published head whose diff attaches whole; a single publication over it is a chunk of its own', () => {
    const dir = makeRepo(tmpDir('lensdiff-chunks'), { files: { 'README.md': 'x\n' } });
    const c0 = sha(revParse(dir, 'HEAD'));
    const c1 = at(dir, { 'src/one.js': source('one', 50_000) }, 'c1');
    const c2 = at(dir, { 'src/two.js': source('two', 50_000) }, 'c2');
    const c3 = at(dir, { 'src/three.js': source('three', 50_000) }, 'c3');
    const c4 = at(dir, { 'src/huge.js': source('huge', 300_000) }, 'c4');
    const repo = absPath(dir);
    const all = new Set([c1, c2, c3, c4]);
    assert.equal(chunkEnd(repo, c0, c3, LENS_DIFF_BUDGET, [], all), c2, 'two publications fit, three do not');
    assert.equal(chunkEnd(repo, c2, c3, LENS_DIFF_BUDGET, [], all), c3, 'the rest fits whole');
    assert.equal(chunkEnd(repo, c0, c3, LENS_DIFF_BUDGET, [], new Set([c1, c3])), c1, 'a chunk ends only at a published head');
    assert.equal(chunkEnd(repo, c3, c4, LENS_DIFF_BUDGET, [], all), c4, 'one publication over the budget is a chunk');
    assert.equal(chunkEnd(repo, c0, c4, LENS_DIFF_BUDGET, [repoPattern('src/huge.js'), repoPattern('src/three.js')], all), c4, 'derived outputs are only listed, so everything else fits');
    assert.equal(chunkEnd(repo, c4, c4, LENS_DIFF_BUDGET, [], all), c4, 'an empty range');
  });
});
