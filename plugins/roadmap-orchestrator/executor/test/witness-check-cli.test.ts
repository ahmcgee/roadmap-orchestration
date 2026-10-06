// M4a rev 3 step N6 (D1, R56): `roadmap witness-check --lane-file <file>` (src/commands/witnesscheck.ts), the real CLI as
// a child in a real git worktree, the lane a real `node --test` run (or a test2json printer): it runs the lane itself with
// a fresh reporter file per execution and compares the records with the file's required ids (`missingWitnesses`). Named
// tests: cli.witness-check-exit-codes, cli.witness-check-fresh-output, cli.witness-check-go-stdout.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { canonicalJson } from '../src/core/json.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { runUntilExit } from './helpers/proc.ts';
import { makeRepo, tmpDir } from './helpers/repo.ts';

const T = { timeout: 120_000 };
const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));

/** Two node tests in `test/w.test.mjs`: `adds` passes; `subtracts` passes only when `ok`. */
const nodeTests = (ok: boolean): string => `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('adds', () => assert.equal(1 + 1, 2));
test('subtracts', () => assert.equal(2 - 1, ${ok ? 1 : 0}));
`;

type LaneFile = Readonly<{ lane: string; argv: readonly string[]; cwd: string; reporter: 'node-test' | 'go-test-json' | 'jsonl'; required: readonly string[] }>;

/** A product repo with the tests, and a lane file outside it (as the executor publishes one under its evidence dir). */
function setup(files: Readonly<Record<string, string>>, lane: LaneFile): Readonly<{ repo: string; laneFile: string }> {
  const repo = makeRepo(tmpDir('wcheck-repo'), { files });
  const dir = join(tmpDir('wcheck-evidence'), 'witness');
  mkdirSync(dir, { recursive: true });
  const laneFile = join(dir, `${lane.lane}.json`);
  writeFileSync(laneFile, `${canonicalJson({ v: SCHEMA_VERSION, env: { set: {}, pass: [] }, ...lane, required: [...lane.required].sort() })}\n`);
  return { repo, laneFile };
}

/** The CLI run from `cwd` (a subdirectory works: the worktree is the git top level). */
const check = (cwd: string, laneFile: string) =>
  runUntilExit(process.execPath, [BIN, 'witness-check', '--lane-file', laneFile], { env: { HOME: process.env['HOME'] ?? '/' }, cwd, timeoutMs: 60_000 });

const NODE_LANE = (required: readonly string[]): LaneFile => ({ lane: 'unit', argv: [process.execPath, '--test', 'test/w.test.mjs'], cwd: '.', reporter: 'node-test', required });

describe('roadmap witness-check', () => {
  test('cli.witness-check-exit-codes: every required id passing exits 0 {passed}; a failing id and an absent id exit 78 naming each; an unknown file is a usage error', T, async () => {
    const { repo, laneFile } = setup({ 'test/w.test.mjs': nodeTests(false) }, NODE_LANE(['adds']));
    const passed = await check(repo, laneFile);
    assert.equal(passed.code, 0, passed.stderr);
    assert.deepEqual(JSON.parse(passed.stdout), { passed: true });

    const other = setup({ 'test/w.test.mjs': nodeTests(false) }, NODE_LANE(['adds', 'divides', 'subtracts']));
    mkdirSync(join(other.repo, 'test', 'deep'), { recursive: true });
    const missing = await check(join(other.repo, 'test', 'deep'), other.laneFile);
    assert.equal(missing.code, 78, missing.stderr);
    assert.deepEqual(JSON.parse(missing.stdout), {
      missing: [{ lane: 'unit', testId: 'divides' }], failed: [{ lane: 'unit', testId: 'subtracts' }], malformed: [],
    });
    assert.match(missing.stderr, /subtracts/, 'the lane\'s own output goes to stderr');

    const absent = await check(repo, join(repo, 'nope.json'));
    assert.equal(absent.code, 64);
    assert.match(absent.stderr, /no lane file/);
  });

  test('cli.witness-check-fresh-output: a failing run, then the fix, then a passing run: the second execution never reads the first\'s records', T, async () => {
    const { repo, laneFile } = setup({ 'test/w.test.mjs': nodeTests(false) }, NODE_LANE(['adds', 'subtracts']));
    const before = await check(repo, laneFile);
    assert.equal(before.code, 78, before.stderr);
    assert.deepEqual(JSON.parse(before.stdout).failed, [{ lane: 'unit', testId: 'subtracts' }]);
    writeFileSync(join(repo, 'test', 'w.test.mjs'), nodeTests(true));
    const after = await check(repo, laneFile);
    assert.equal(after.code, 0, after.stderr);
    assert.deepEqual(JSON.parse(after.stdout), { passed: true });
  });

  test('cli.witness-check-go-stdout: a go-test-json lane is read from its own stdout; a jsonl lane that writes no witness file is malformed', T, async () => {
    const events = [
      { Action: 'run', Package: 'p', Test: 'TestBerth' }, { Action: 'pass', Package: 'p', Test: 'TestBerth' },
      { Action: 'run', Package: 'p', Test: 'TestTide' }, { Action: 'fail', Package: 'p', Test: 'TestTide' },
    ].map((e) => JSON.stringify(e)).join('\n');
    const go = setup({ 'events.json': `${events}\n` }, { lane: 'go', argv: ['/bin/cat', 'events.json'], cwd: '.', reporter: 'go-test-json', required: ['TestBerth'] });
    const ok = await check(go.repo, go.laneFile);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout), { passed: true });
    const tide = setup({ 'events.json': `${events}\n` }, { lane: 'go', argv: ['/bin/cat', 'events.json'], cwd: '.', reporter: 'go-test-json', required: ['TestBerth', 'TestTide'] });
    const red = await check(tide.repo, tide.laneFile);
    assert.equal(red.code, 78);
    assert.deepEqual(JSON.parse(red.stdout), { missing: [], failed: [{ lane: 'go', testId: 'TestTide' }], malformed: [] });

    const silent = setup({ 'x.txt': 'x\n' }, { lane: 'wrap', argv: ['/bin/true'], cwd: '.', reporter: 'jsonl', required: ['t1'] });
    const malformed = await check(silent.repo, silent.laneFile);
    assert.equal(malformed.code, 78);
    assert.deepEqual(JSON.parse(malformed.stdout), { missing: [{ lane: 'wrap', testId: 't1' }], failed: [], malformed: ['wrap'] });
  });
});
