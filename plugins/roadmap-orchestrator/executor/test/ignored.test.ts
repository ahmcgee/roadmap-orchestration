// A lane's ignored output (src/git/ignored.ts) and the exact globs its capture uses (src/git/evidence.ts):
// selection rules and caps over synthetic writes, the census groups, literal globs against real files and
// node's globSync, and detection by ctime in a real git checkout. The lane-level capture and census are in
// lanes.test.ts. Named tests: ignored.select, ignored.census-groups, ignored.literal-globs, ignored.detect.
import assert from 'node:assert/strict';
import { symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { absPath, repoPath, repoPattern } from '../src/core/values.ts';
import { listEvidence, literalPattern, pathPattern, patternPath } from '../src/git/evidence.ts';
import {
  CENSUS_GROUPS, type IgnoredRules, type IgnoredWrite, MAX_FILE_BYTES, MAX_LANE_BYTES, MAX_LANE_FILES, ignoredWrites, planIgnored,
} from '../src/git/ignored.ts';
import { makeRepo, tmpDir, writeFiles } from './helpers/repo.ts';

const w = (path: string, bytes = 10, regular = true): IgnoredWrite => ({ path: repoPath(path), bytes, regular });
const FAILED: IgnoredRules = { passed: false, declared: new Set(), excludes: [] };
const captured = (writes: readonly IgnoredWrite[], rules: IgnoredRules = FAILED): readonly string[] => planIgnored(writes, rules).capture.map(patternPath);

test('ignored.select: declared, not-regular, build output, secrets and lane excludes are never captured; caps skip what does not fit', () => {
  const writes = [
    w('.local/demo/run.log', 100),
    w('.local/demo/tls.key'), w('.env'), w('a/.env.local'), w('x/.kube/config'), w('.kubeconfig'), w('keys/id_ed25519.pub'),
    w('a/node_modules/dep/index.js'), w('dist/app.js'), w('svc/obj/Debug/x.dll'), w('dist'),
    w('link.log', 5, false),
    w('out/declared.log', 7),
    w('private/notes.txt'),
    w('f\\g.log'),
    w('huge.bin', MAX_FILE_BYTES + 1),
  ];
  const rules: IgnoredRules = { passed: false, declared: new Set([repoPath('out/declared.log')]), excludes: [repoPattern('private')] };
  const plan = planIgnored(writes, rules);
  // `dist` is a top-level file named like a build dir: only a path under one is build output.
  assert.deepEqual(plan.capture.map(patternPath), ['.local/demo/run.log', 'dist']);
  const reasons = Object.fromEntries(plan.census.uncaptured.map((g) => [`${g.dir} ${g.reason}`, g.files]));
  assert.deepEqual(reasons, {
    '(root) excluded': 2, '.local/demo/ excluded': 1, 'a/ excluded': 1, 'x/.kube/ excluded': 1, 'keys/ excluded': 1, 'private/ excluded': 1,
    'a/node_modules/ build-output': 1, 'dist/ build-output': 1, 'svc/obj/ build-output': 1,
    '(root) not-regular': 1, '(root) unglobbable': 1, '(root) over-file-cap': 1,
  });
  assert.deepEqual(plan.census.written, { files: writes.length, bytes: writes.reduce((n, x) => n + x.bytes, 0) });
  assert.deepEqual(plan.census.captured, { files: 3, bytes: 100 + 10 + 7 }, 'the declared file counts as captured');

  // A passing lane captures nothing: what nothing declared is `not-declared`, the other reasons as before.
  const passed = planIgnored(writes, { ...rules, passed: true });
  assert.deepEqual(passed.capture, []);
  assert.deepEqual(passed.census.uncaptured.filter((g) => g.reason === 'not-declared').map((g) => [g.dir, g.files]), [['(root)', 3], ['.local/demo/', 1]]);
  assert.deepEqual(passed.census.captured, { files: 1, bytes: 7 });

  // The byte cap skips a file that does not fit and keeps trying the ones after it.
  const big = Array.from({ length: 13 }, (_, i) => w(`big/${String(i).padStart(2, '0')}.bin`, MAX_FILE_BYTES));
  const bytes = captured([...big, w('big/zz-small.txt', 1)]);
  assert.equal(bytes.length, Math.floor(MAX_LANE_BYTES / MAX_FILE_BYTES) + 1);
  assert.ok(!bytes.includes('big/12.bin') && bytes.includes('big/zz-small.txt'));
  // The count cap: the first MAX_LANE_FILES in path order.
  const many = Array.from({ length: MAX_LANE_FILES + 5 }, (_, i) => w(`m/${String(i).padStart(4, '0')}.log`, 1));
  const counted = planIgnored(many, FAILED);
  assert.equal(counted.capture.length, MAX_LANE_FILES);
  assert.equal(patternPath(counted.capture.at(-1)!), `m/${String(MAX_LANE_FILES - 1).padStart(4, '0')}.log`);
  assert.deepEqual(counted.census.uncaptured, [{ dir: 'm/', reason: 'over-lane-cap', files: 5, bytes: 5 }]);
});

test('ignored.census-groups: dirs grouped two segments deep, the largest kept, the tail folded per reason', () => {
  const writes = Array.from({ length: CENSUS_GROUPS + 3 }, (_, i) => w(`g${String(i).padStart(2, '0')}/deep/er/f.txt`)).concat(
    [w('g00/deep/other.txt'), w('top.txt')],
  );
  const { uncaptured } = planIgnored(writes, { ...FAILED, passed: true }).census;
  assert.equal(uncaptured.length, CENSUS_GROUPS + 1);
  assert.deepEqual(uncaptured[0], { dir: 'g00/deep/', reason: 'not-declared', files: 2, bytes: 20 });
  assert.deepEqual(uncaptured.at(-1), { dir: '(other)', reason: 'not-declared', files: 4, bytes: 40 });
  assert.equal(uncaptured.reduce((n, g) => n + g.files, 0), writes.length);
});

test('ignored.literal-globs: a snapshot glob names exactly one file whatever its name holds', () => {
  const dir = tmpDir('literal');
  const names = ['a[1]*.log', 'c?.t', 'h(1)+@.txt', '!e', 'q{a}', 'd/[ab]', '.hid/x.log', 'plain'];
  const decoys = ['a1x.log', 'a[1]zz.log', 'cx.t', 'h1.txt', 'e', 'd/a', 'd/b', 'qa'];
  writeFiles(dir, Object.fromEntries([...names, ...decoys].map((n) => [n, n])));
  for (const name of names) {
    const pattern = literalPattern(repoPath(name));
    assert.ok(pattern !== null, name);
    assert.deepEqual(listEvidence(absPath(dir), [pattern]).map((e) => e.path), [name], name);
    assert.equal(patternPath(pattern), name);
  }
  // No exact glob: a backslash is a separator to globSync, and a brace group is expanded.
  for (const name of ['f\\g', 'b{x,y}.txt', 'r{1..3}']) {
    assert.equal(literalPattern(repoPath(name)), null, name);
    assert.equal(pathPattern(repoPath(name)), name, 'a dirty path without one is snapshotted as itself');
  }
});

test('ignored.detect: the ignored files a lane created or changed since its start, one by one, as lstat sees them', async () => {
  const repo = makeRepo(tmpDir('ignored-repo'), { files: { '.gitignore': 'out/\n*.log\n', 'src/a.ts': 'x\n' } });
  writeFiles(repo, { 'out/before.txt': 'old\n' });
  await sleep(50);
  const since = Date.now();
  await sleep(50);
  writeFiles(repo, { 'out/deep/new.txt': 'new\n', 'run.log': 'log\n', 'src/untracked.ts': 'not ignored\n', 'src/a.ts': 'changed tracked\n' });
  // `cp -p` keeps an old mtime; ctime still says the file arrived now.
  writeFileSync(join(repo, 'out/copied.txt'), 'copied\n');
  utimesSync(join(repo, 'out/copied.txt'), new Date(0), new Date(0));
  symlinkSync('/etc/hostname', join(repo, 'out/link'));
  assert.deepEqual(ignoredWrites(absPath(repo), since), [
    { path: 'out/copied.txt', bytes: 7, regular: true },
    { path: 'out/deep/new.txt', bytes: 4, regular: true },
    { path: 'out/link', bytes: '/etc/hostname'.length, regular: false },
    { path: 'run.log', bytes: 4, regular: true },
  ]);
});
