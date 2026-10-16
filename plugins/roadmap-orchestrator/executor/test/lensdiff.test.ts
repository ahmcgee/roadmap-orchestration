// The lens-range fix (src/holistic/lensdiff.ts), over real git: a range's attachment stays within the budget whatever
// the range holds, every file not shown is listed with the command that prints it, and a long range splits into
// chunks at published heads. Named tests: lensdiff.bounded, lensdiff.many-files, lensdiff.chunks.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { type Sha, sha } from '../src/core/ids.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { LENS_DIFF_BUDGET, boundedDiff, chunkEnd } from '../src/holistic/lensdiff.ts';
import { boundedDiffText } from '../src/prompts/inputs.ts';
import { commitAll, makeRepo, revParse, tmpDir, writeFiles } from './helpers/repo.ts';

/** `n` bytes of source: numbered lines of 50 bytes. */
const source = (tag: string, n: number): string =>
  Array.from({ length: Math.ceil(n / 50) }, (_, i) => `${`export const ${tag}${i.toString().padStart(6, '0')} = 1;`.padEnd(49)}\n`).join('');
const at = (repo: string, files: Record<string, string>, message: string): Sha => {
  writeFiles(repo, files);
  return sha(commitAll(repo, message));
};

describe('lens diffs', () => {
  test('lensdiff.bounded: path order, a file over what remains skipped (a later one still inlined), a derived output only listed; the command prints what was not shown', () => {
    const dir = makeRepo(tmpDir('lensdiff-bounded'), { files: { 'src/a.js': 'a\n', 'src/z.js': 'z\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const to = at(dir, { 'src/a.js': 'a2\n', 'src/z.js': 'z2\n', 'src/big.js': source('big', 200_000), 'dist/bundle.js': 'bundled\n' }, 'one publication');
    const d = boundedDiff(absPath(dir), from, to, LENS_DIFF_BUDGET, [repoPattern('dist/**')]);
    assert.equal(d.stat.full, true);
    assert.match(d.stat.text, /src\/big\.js/);
    assert.deepEqual(d.omitted, [{ path: 'dist/bundle.js', why: 'derived' }, { path: 'src/big.js', why: 'size' }]);
    assert.equal(d.unlisted, 0);
    const files = [...d.inlined.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(files, ['src/a.js', 'src/z.js'], 'the file after the one skipped is still inlined');
    const text = boundedDiffText('range', d);
    assert.ok(text.length < LENS_DIFF_BUDGET && !text.includes('big000100'), 'the oversized file is not attached');
    const command = /- src\/big\.js \(not inlined: over the budget\): (git diff \S+ \S+ -- 'src\/big\.js')/.exec(text)?.[1];
    assert.ok(command !== undefined, text);
    assert.match(execSync(command, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 24 }), /^\+export const big000100/m, 'the listed command prints the file\'s diff in the checkout');
    assert.ok(text.includes(`- dist/bundle.js (derived output): git diff ${from} ${to} -- 'dist/bundle.js'`));
  });

  test('lensdiff.many-files: a range of many files keeps within the budget: the shortstat in place of the stat, the listing cut short and counted', () => {
    const dir = makeRepo(tmpDir('lensdiff-many'), { files: { 'README.md': 'x\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const files = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`src/generated/module-${i.toString().padStart(5, '0')}.js`, source(`m${i}_`, 400)]));
    const to = at(dir, files, 'many files');
    const d = boundedDiff(absPath(dir), from, to, LENS_DIFF_BUDGET, []);
    assert.equal(d.stat.full, false);
    assert.match(d.stat.text, /1500 files changed/);
    assert.ok(d.omitted.length > 0 && d.unlisted > 0 && d.omitted.every((o) => o.why === 'size'));
    const inlined = [...d.inlined.matchAll(/^diff --git /gm)].length;
    assert.equal(inlined + d.omitted.length + d.unlisted, 1500, 'every file is inlined, listed or counted');
    const text = boundedDiffText('range', d);
    assert.ok(text.length <= LENS_DIFF_BUDGET + 1_024, `${text.length} bytes`);
    assert.ok(text.includes(`- ${d.unlisted} more files not inlined, not listed here: \`git diff --name-only ${from} ${to}\``));
    assert.ok(text.includes(`\`git diff --stat ${from} ${to}\` prints it`));
  });

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
