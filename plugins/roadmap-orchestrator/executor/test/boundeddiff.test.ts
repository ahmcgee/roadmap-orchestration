// The one bounded diff (src/git/boundeddiff.ts) over real git and genuinely large diffs: its representation (moves
// collapsed, deletions named and labelled, long-line files as word diffs), its priority order, its budget, and the
// readable files that hold what it does not inline, each exactly what `git diff` prints. Named tests:
// boundeddiff.bounded, boundeddiff.many-files, boundeddiff.mass-move, boundeddiff.long-lines, boundeddiff.deletions,
// boundeddiff.test-sweep, boundeddiff.leftover-first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type Sha, sha } from '../src/core/ids.ts';
import { type RepoPattern, absPath, repoPattern } from '../src/core/values.ts';
import { type BoundedDiff, boundedDiff, diffPaths } from '../src/git/boundeddiff.ts';
import { LENS_DIFF_BUDGET } from '../src/holistic/lensdiff.ts';
import { GATE_DIFF_BUDGET } from '../src/pipeline/gate.ts';
import { boundedDiffText } from '../src/prompts/inputs.ts';
import { commitAll, makeRepo, revParse, tmpDir, writeFiles } from './helpers/repo.ts';

/** `n` bytes of source: numbered lines of 50 bytes. */
const source = (tag: string, n: number): string =>
  Array.from({ length: Math.ceil(n / 50) }, (_, i) => `${`export const ${tag}${i.toString().padStart(6, '0')} = 1;`.padEnd(49)}\n`).join('');
const at = (repo: string, files: Record<string, string | null>, message: string): Sha => {
  writeFiles(repo, files);
  return sha(commitAll(repo, message));
};
/** What `git diff -M <from> <to> -- <paths>` prints, untrimmed. */
const gitDiff = (repo: string, from: Sha, to: Sha, ...paths: string[]): string => {
  const r = spawnSync('git', ['-C', repo, 'diff', '--no-color', '-M', from, to, '--', ...paths], {
    encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const attach = (repo: string, from: Sha, to: Sha, budget: number, opts: Readonly<{ derived?: RepoPattern[]; removes?: string[] | null }> = {}): BoundedDiff =>
  boundedDiff(absPath(repo), from, to, { budget, derived: opts.derived ?? [], removes: opts.removes ?? null, dir: absPath(join(repo, '..', `${repo.split('/').at(-1)}-attach`)) });
const inlinedFiles = (d: BoundedDiff): string[] => [...d.text.matchAll(/^diff --git a\/\S+ b\/(\S+)/gm)].map((m) => m[1]!);
/** The rendered attachment, within the budget and a fixed allowance for its fixed text. */
const rendered = (d: BoundedDiff, budget: number): string => {
  const text = boundedDiffText('diff', d, null);
  assert.ok(Buffer.byteLength(text) <= budget + 2_048, `${Buffer.byteLength(text)} bytes rendered over a ${budget}-byte budget`);
  return text;
};

describe('bounded diffs', () => {
  test('boundeddiff.bounded: a file over what remains skipped (a later one still inlined), a derived output only listed, each readable file what git diff prints', () => {
    const dir = makeRepo(tmpDir('bd-bounded'), { files: { 'src/a.js': 'a\n', 'src/z.js': 'z\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const to = at(dir, { 'src/a.js': 'a2\n', 'src/z.js': 'z2\n', 'src/big.js': source('big', 200_000), 'dist/bundle.js': 'bundled\n' }, 'one publication');
    const d = attach(dir, from, to, LENS_DIFF_BUDGET, { derived: [repoPattern('dist/**')] });
    assert.equal(d.orientation.stat.full, true);
    assert.match(d.orientation.stat.text, /src\/big\.js/);
    assert.deepEqual(d.omitted.shown.map((o) => [o.path, o.kind, o.why]), [['src/big.js', 'new-source', 'size'], ['dist/bundle.js', 'derived', 'derived']], 'by kind: source before derived');
    assert.deepEqual(inlinedFiles(d), ['src/a.js', 'src/z.js'], 'the file after the one skipped is still inlined');
    for (const o of d.omitted.shown) assert.equal(readFileSync(o.diff, 'utf8'), gitDiff(dir, from, to, o.path), o.path);
    assert.ok(readFileSync(join(d.dir, 'not-inlined.txt'), 'utf8').includes(`src/big.js\tnew-source\tsize\t`));
    const text = rendered(d, LENS_DIFF_BUDGET);
    assert.ok(!text.includes('big000100'), 'the oversized file is not attached');
    assert.ok(text.includes(`- src/big.js (new source, over the budget, `) && text.includes(d.omitted.shown[0]!.diff));
    assert.deepEqual(d.notInlined, ['dist/bundle.js', 'src/big.js']);
    assert.equal(d.overflow, 1, 'the oversized file overflowed; a derived output never inlines, so it is no overflow');
  });

  test('boundeddiff.many-files: the shortstat in place of the stat, the listing cut short and counted, every file inlined, listed or counted', () => {
    const dir = makeRepo(tmpDir('bd-many'), { files: { 'README.md': 'x\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const files = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`src/generated/module-${i.toString().padStart(5, '0')}.js`, source(`m${i}_`, 400)]));
    const to = at(dir, files, 'many files');
    const d = attach(dir, from, to, LENS_DIFF_BUDGET);
    assert.equal(d.orientation.stat.full, false);
    assert.match(d.orientation.stat.text, /1500 files changed/);
    assert.match(readFileSync(join(d.dir, 'stat.txt'), 'utf8'), /module-01499\.js/);
    assert.ok(d.omitted.shown.length > 0 && d.omitted.more > 0);
    assert.equal(d.inlined.length + d.omitted.shown.length + d.omitted.more, 1500, 'every file is inlined, listed or counted');
    assert.equal(d.overflow, d.omitted.shown.length + d.omitted.more, 'every file left out was left out for size');
    assert.equal(readFileSync(join(d.dir, 'not-inlined.txt'), 'utf8').split('\n').filter((l) => l !== '').length, d.omitted.shown.length + d.omitted.more);
    const text = rendered(d, LENS_DIFF_BUDGET);
    assert.ok(text.includes(`- and ${d.omitted.more} more, all listed in ${d.dir}/not-inlined.txt`));
    assert.ok(text.includes(`the full stat is in ${d.dir}/stat.txt`));
  });

  test('boundeddiff.mass-move: files moved unchanged are move lines with no diff; a file moved and edited is diffed as a rename', () => {
    const files = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`src/old/mod-${i.toString().padStart(4, '0')}.ts`, source(`v${i}_`, 2_000)]));
    const dir = makeRepo(tmpDir('bd-move'), { files });
    const from = sha(revParse(dir, 'HEAD'));
    const moved: Record<string, string | null> = {};
    for (const [path, content] of Object.entries(files)) {
      moved[path] = null;
      moved[path.replace('src/old/', 'src/new/')] = path.endsWith('mod-0007.ts') ? content.replace('v7_000003', 'v7_RENAMED') : content;
    }
    const to = at(dir, moved, 'move the package');
    const d = attach(dir, from, to, GATE_DIFF_BUDGET);
    const moves = d.orientation.moves;
    assert.equal(moves.shown.length + moves.more, 399);
    assert.deepEqual(moves.shown[0], { from: 'src/old/mod-0000.ts', to: 'src/new/mod-0000.ts' });
    assert.equal(readFileSync(join(d.dir, 'moves.txt'), 'utf8').split('\n').filter((l) => l !== '').length, 399);
    assert.deepEqual(inlinedFiles(d), ['src/new/mod-0007.ts'], 'only the file changed beyond its move has a diff');
    assert.match(d.text, /^rename from src\/old\/mod-0007\.ts$/m);
    assert.match(d.text, /^-export const v7_000003 = 1;\s*$/m);
    assert.match(d.text, /^@@ -3,3 \+3,3 @@/m, 'one line of context');
    assert.deepEqual(d.orientation.deletions.shown, [], 'a move is no deletion');
    assert.deepEqual(d.notInlined, []);
    assert.equal(d.overflow, 0);
    const paths = diffPaths(absPath(dir), from, to);
    assert.equal(paths.length, 400, 'diffPaths: a move is its new path only');
    assert.ok(paths.every((p) => p.startsWith('src/new/')));
    const text = rendered(d, GATE_DIFF_BUDGET);
    assert.ok(Buffer.byteLength(text) < 64 * 1024, `${Buffer.byteLength(text)} bytes for a mass move`);
    assert.ok(text.includes('- src/old/mod-0000.ts → src/new/mod-0000.ts'));
  });

  test('boundeddiff.long-lines: regenerated goldens with long lines are word diffs, their unchanged runs cut; the whole line diff is readable', () => {
    const golden = (seed: number, changed: number | null): string =>
      Array.from({ length: 12 }, (_, line) => `${JSON.stringify(Array.from({ length: 900 }, (_, i) => (line === 5 && i === 450 && changed !== null ? changed : seed + line * 1000 + i)))}\n`).join('');
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, g) => [`test/goldens/case-${g.toString().padStart(2, '0')}.json`, golden(g, null)]));
    const dir = makeRepo(tmpDir('bd-long'), { files: { ...files, 'src/render.ts': 'export const scale = 1;\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const regenerated = Object.fromEntries(Object.keys(files).map((path, g) => [path, golden(g, 424242)]));
    const to = at(dir, { ...regenerated, 'src/render.ts': 'export const scale = 2;\n' }, 'regenerate the goldens');
    const lineDiff = gitDiff(dir, from, to);
    assert.ok(lineDiff.length > 300_000, `${lineDiff.length} bytes as a line diff`);
    const d = attach(dir, from, to, GATE_DIFF_BUDGET);
    assert.deepEqual(d.inlined.map((f) => [f.path, f.kind, f.representation]).slice(0, 2), [['src/render.ts', 'modified-source', 'line'], ['test/goldens/case-00.json', 'fixture', 'word']]);
    assert.equal(d.inlined.length, 31, 'every golden inlined once cut to its changed words');
    assert.ok(d.text.length < 60_000, `${d.text.length} bytes inlined`);
    const first = d.inlined[1]!;
    assert.ok(first.full !== null && existsSync(first.full));
    assert.equal(readFileSync(first.full, 'utf8'), gitDiff(dir, from, to, first.path), 'the whole line diff, as git prints it');
    assert.ok(d.text.includes(`word diff of test/goldens/case-00.json; its whole line diff: ${first.full}\n`));
    assert.match(d.text, /^-5450$/m);
    assert.match(d.text, /^\+424242$/m);
    assert.match(d.text, /…\[\d+ chars\]…/, 'an unchanged run cut to its ends');
    rendered(d, GATE_DIFF_BUDGET);
  });

  test('boundeddiff.deletions: deleted files are named with their line counts, never inlined, those outside the spec removes first; their content readable', () => {
    const legacy = Object.fromEntries(Array.from({ length: 38 }, (_, i) => [`src/legacy/part-${i.toString().padStart(2, '0')}.ts`, source(`l${i}_`, 12_000)]));
    const dir = makeRepo(tmpDir('bd-del'), { files: { ...legacy, 'src/keep/util.ts': source('u', 4_000), 'src/OldWidget.tsx': 'export {};\n', 'src/app.ts': 'export const app = 1;\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const gone: Record<string, null | string> = Object.fromEntries(Object.keys(legacy).map((p) => [p, null]));
    const to = at(dir, { ...gone, 'src/keep/util.ts': null, 'src/OldWidget.tsx': null, 'src/app.ts': 'export const app = 2;\n' }, 'drop the legacy package');
    const d = attach(dir, from, to, GATE_DIFF_BUDGET, { removes: ['src/legacy/', 'OldWidget'] });
    const dels = d.orientation.deletions;
    assert.equal(dels.labelled, true);
    assert.equal(dels.shown.length + dels.more, 40);
    assert.deepEqual(dels.shown[0], { path: 'src/keep/util.ts', lines: 80, removes: null, diff: absPath(join(d.dir, 'files', 'src/keep/util.ts.diff')) }, 'the unexpected deletion first');
    assert.equal(dels.shown.find((x) => x.path === 'src/OldWidget.tsx')?.removes, 'OldWidget', 'a symbol names its file');
    assert.ok(dels.shown.slice(1).every((x) => x.removes !== null));
    assert.equal(dels.shown.find((x) => x.path === 'src/legacy/part-00.ts')?.removes, 'src/legacy/');
    for (const x of dels.shown) assert.equal(readFileSync(x.diff, 'utf8'), gitDiff(dir, from, to, x.path), x.path);
    assert.deepEqual(inlinedFiles(d), ['src/app.ts'], 'no deletion inlined');
    assert.equal(d.notInlined.length, 40);
    assert.equal(d.overflow, 0, 'a deletion is never inlined, so it is no overflow');
    assert.equal(diffPaths(absPath(dir), from, to).length, 41, 'diffPaths: each deleted file by its path, and the edit');
    assert.match(readFileSync(join(d.dir, 'deletions.txt'), 'utf8'), /^src\/keep\/util\.ts\t80\tunexpected\t/);
    const text = rendered(d, GATE_DIFF_BUDGET);
    assert.ok(text.includes(`- src/keep/util.ts (80 lines, not in the spec's removes): ${dels.shown[0]!.diff}`));
    assert.ok(!text.includes('l0_000001'), 'no deleted content attached');
    // A lens's diff has no spec: nothing labelled, path order.
    const lens = attach(dir, from, to, LENS_DIFF_BUDGET);
    assert.equal(lens.orientation.deletions.labelled, false);
    assert.equal(lens.orientation.deletions.shown[0]!.path, 'src/OldWidget.tsx');
  });

  test('boundeddiff.test-sweep: within a tight budget, what the sweep\'s substitution does not explain first (by kind), then examples of it, then the rest; the substitution named and its files counted', () => {
    const tests = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`test/unit/case-${i.toString().padStart(3, '0')}.test.ts`,
      `import { oldHelper } from '../../src/helper.ts';\n${source(`t${i}_`, 1_500)}test('x', () => oldHelper(${i}));\nconst again = oldHelper;\n`]));
    const dir = makeRepo(tmpDir('bd-sweep'), {
      files: { ...tests, 'src/helper.ts': `export function oldHelper(n: number) { return n; }\n${source('h', 3_000)}`, 'test/fixtures/input.txt': 'one\n', 'docs/notes.md': 'old\n', 'dist/bundle.js': 'oldHelper();\n'.repeat(50) },
    });
    const from = sha(revParse(dir, 'HEAD'));
    const swept = Object.fromEntries(Object.entries(tests).map(([p, c]) => [p, c.replaceAll('oldHelper', 'newHelper')]));
    const to = at(dir, {
      ...swept, 'src/helper.ts': `export function newHelper(n: number) { return n; }\n${source('h', 3_000)}`, 'src/added.ts': source('added', 2_000),
      'test/fixtures/input.txt': 'two\n', 'docs/notes.md': 'new\n', 'dist/bundle.js': 'newHelper();\n'.repeat(50),
    }, 'rename the helper');
    const budget = 64 * 1024;
    const d = attach(dir, from, to, budget, { derived: [repoPattern('dist')] });
    // Leftover first: what the rename does not explain (by kind: new source, then fixtures and other by path), then three
    // examples of the rename (the source before the tests), then the rest of the sweep by kind and path.
    assert.deepEqual(d.inlined.slice(0, 6).map((f) => [f.path, f.kind]), [
      ['src/added.ts', 'new-source'], ['docs/notes.md', 'other'], ['test/fixtures/input.txt', 'fixture'],
      ['src/helper.ts', 'modified-source'], ['test/unit/case-000.test.ts', 'test'], ['test/unit/case-001.test.ts', 'test'],
    ]);
    const rest = d.inlined.slice(6).map((f) => f.path);
    assert.deepEqual(rest, [...rest].sort(), 'the rest in path order');
    assert.ok(d.inlined.slice(6).every((f) => f.kind === 'test'));
    assert.ok(d.omitted.shown.length + d.omitted.more > 0, 'the sweep does not fit');
    assert.equal(d.orientation.explained, 201, 'the helper and every test are the rename alone');
    const listing = readFileSync(join(d.dir, 'not-inlined.txt'), 'utf8');
    assert.ok(d.inlined.some((f) => f.path === 'test/fixtures/input.txt' && f.kind === 'fixture') || listing.includes('test/fixtures/input.txt\tfixture\t'), 'the fixture classed as one');
    assert.match(listing, /^dist\/bundle\.js\tderived\tderived\t/m, 'the derived output never inlined');
    assert.deepEqual(d.orientation.substitutions[0], { from: 'oldHelper', to: 'newHelper', count: 601 }, 'three uses in each of 200 tests and one in the source; the derived output\'s fifty not counted');
    assert.deepEqual(d.orientation.packages.shown.map((p) => [p.name, p.files]), [['test', 201], ['dist', 1], ['src', 2], ['docs', 1]]);
    for (const o of d.omitted.shown) assert.equal(readFileSync(o.diff, 'utf8'), gitDiff(dir, from, to, o.path), o.path);
    const text = rendered(d, budget);
    assert.ok(text.includes('- oldHelper → newHelper ×601'));
    assert.ok(text.includes('- 201 changed files with every changed line explained by these substitutions'));
  });

  test('boundeddiff.leftover-first: among many files one substitution explains, the one with a hand edit is inlined first though it sorts last; examples of the substitution follow', () => {
    const mod = (i: number, call: string, arg: number): string =>
      `import { ${call} } from '../helper.ts';\n${source(`m${i}_`, 1_500)}export const r${i} = ${call}(${arg});\nexport const again${i} = ${call};\n`;
    const n = 300;
    const path = (i: number): string => `src/mods/mod-${i.toString().padStart(3, '0')}.ts`;
    const files = Object.fromEntries(Array.from({ length: n }, (_, i) => [path(i), mod(i, 'oldHelper', i)]));
    const dir = makeRepo(tmpDir('bd-leftover'), { files: { ...files, 'src/helper.ts': 'export function oldHelper(n: number) { return n; }\n' } });
    const from = sha(revParse(dir, 'HEAD'));
    const swept = Object.fromEntries(Array.from({ length: n }, (_, i) => [path(i), mod(i, 'newHelper', i)]));
    // The last file's call also changes its argument, on the line the rename changes: what the rename does not explain.
    const last = path(n - 1);
    swept[last] = mod(n - 1, 'newHelper', n);
    const to = at(dir, { ...swept, 'src/helper.ts': 'export function newHelper(n: number) { return n; }\n' }, 'rename the helper');
    const budget = 32 * 1024;
    const d = attach(dir, from, to, budget);
    assert.deepEqual(d.orientation.substitutions.map((s) => [s.from, s.to]), [['oldHelper', 'newHelper']]);
    assert.equal(d.inlined[0]!.path, last, 'the unexplained file first, though it sorts last');
    assert.match(d.text, new RegExp(`^\\+export const r${n - 1} = newHelper\\(${n}\\);$`, 'm'));
    assert.deepEqual(d.inlined.slice(1, 4).map((f) => f.path), ['src/helper.ts', path(0), path(1)], 'three examples of the substitution');
    const rest = d.inlined.slice(4).map((f) => f.path);
    assert.deepEqual(rest, [...rest].sort(), 'then the rest in path order');
    assert.ok(rest.length > 0 && rest[0]! > path(1));
    assert.ok(d.inlined.length < n / 2 && d.omitted.shown.length + d.omitted.more === n + 1 - d.inlined.length, 'most of the sweep is listed, not inlined');
    assert.equal(d.orientation.explained, n, 'every file but the hand-edited one is the rename alone');
    assert.ok(!d.notInlined.some((p) => p === last));
    const text = rendered(d, budget);
    assert.ok(text.includes(`- ${n} changed files with every changed line explained by these substitutions`));
    // Deterministic: the same diff and budget give the same attachment.
    const again = attach(dir, from, to, budget);
    assert.equal(again.text, d.text);
    assert.deepEqual(again.notInlined, d.notInlined);
  });
});
