// Lane topology at the lanes stage (dev.17; src/pipeline/lanes.ts, src/pipeline/stages.ts), integrated over real processes
// and real git: the one reuse key across commits (a lane's systems), suite lanes reused like spec lanes, test-only runs
// (`testArgv`), stochastic lanes, and the lanes a unit forces (its spec's `forces`, a repair of a batch lane's P1).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { type FindingId, type Sha, laneId, sha } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import { type LaneDef, type SpecM1 } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { type StageContext, type StageParent, pinDispatch } from '../src/pipeline/dispatch.ts';
import { type LaneRuntime, type Series, laneOrder, reserveNow, runLaneSeries, seriesLedger, seriesOrder, specSeriesRoot } from '../src/pipeline/lanes.ts';
import { forcedLanes, lanes, loadUnitSpec } from '../src/pipeline/stages.ts';
import { commitAll, tmpDir, writeFiles } from './helpers/repo.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, type SetupOptions, type StageRun, U1, keptSpec, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const MAP = {
  systems: {
    add: { paths: ['src/add.js'], tests: ['test/add*.test.js'] },
    other: { paths: ['src/other/**'], tests: ['test/other/*.test.js'] },
  },
  docs: ['*.md', 'docs/**'],
};
const PASSING = "import { test } from 'node:test';\ntest('ok', () => {});\n";

function unitRun(opts: Partial<SetupOptions>): StageRun {
  const run = setupUnit({ steps: [], ...opts });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  return run;
}

const parentOf = (attempt: number): StageParent => ({ type: 'stage', unit: U1, stage: 'lanes', attempt });
const runtime = (ctx: StageContext): LaneRuntime => ({ acquire: reserveNow(ctx), rank: () => { throw new Error('not ranked'); }, signal: new AbortController().signal, sampleHost: () => ({ load1: 1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 }) });
const specLanes = (run: StageRun): readonly LaneDef[] => laneOrder(loadUnitSpec(run.ctx, run.unit).spec);

function series(run: StageRun, attempt: number, defs: readonly LaneDef[], at: Sha, set: 'spec' | 'suite' = 'spec'): Promise<Series> {
  const parent = parentOf(attempt);
  const checkout = { path: absPath(join(tmpDir('topology-tree'), 'tree')), checkout: { type: 'detached', at } } as const;
  return runLaneSeries(run.ctx, parent, seriesOrder(defs), set, checkout, specSeriesRoot(run.ctx.runDir, parent), runtime(run.ctx), false);
}

const commit = (run: StageRun, files: Readonly<Record<string, string>>): Sha => {
  writeFiles(run.repo, files);
  return sha(commitAll(run.repo, 'more'));
};

const laneSpawns = (run: StageRun, lane: string): readonly IntentOf<'proc.spawn'>[] =>
  spawnIntents(run).filter((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.lane === lane);

describe('lanes.reuse-key (dev.17)', () => {
  test('lanes.reuse-by-systems: a lane listing systems is reused on a commit that changed only other systems or docs; a change in its own system, or an unmapped path, reruns it', T, async () => {
    const run = unitRun({ lanes: [{ id: 'add', cadence: 'build', argv: ['true'], systems: ['add'] }, { id: 'whole', cadence: 'build', argv: ['true'] }], systemsMap: MAP });
    const first = await series(run, 1, specLanes(run), run.base);
    assert.equal(first.end.kind, 'green');
    const other = commit(run, { 'src/other/x.js': 'export const x = 1;\n' });
    const second = await series(run, 2, specLanes(run), other);
    assert.deepEqual(second.ledger.map((l) => [l.lane, l.reused?.at ?? null]), [['add', run.base], ['whole', null]], 'another system changed: add reused; a lane listing none reads it');
    const docs = commit(run, { 'docs/guide.md': '# guide\n' });
    const third = await series(run, 3, specLanes(run), docs);
    assert.deepEqual(third.ledger.map((l) => [l.lane, l.reused?.at ?? null]), [['add', run.base], ['whole', other]], 'a docs-only change: every lane reused');
    const own = commit(run, { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' });
    const fourth = await series(run, 4, specLanes(run), own);
    assert.deepEqual(fourth.ledger.map((l) => l.reused), [null, null], 'its own system changed');
    const unmapped = commit(run, { 'scripts/x.sh': 'echo\n' });
    const fifth = await series(run, 5, specLanes(run), unmapped);
    assert.deepEqual(fifth.ledger.map((l) => l.reused), [null, null], 'an unmapped path is every lane\'s input');
    assert.equal(laneSpawns(run, 'add').length, 3);
    // The ledger read back names each reuse, set and commit included.
    assert.deepEqual(seriesLedger(run.ctx, parentOf(3), specLanes(run), 'spec', docs, specSeriesRoot(run.runDir, parentOf(3))), third.ledger);
  });

  test('lanes.suite-reuse: a suite series reuses a clean pass of the same lane and input, from a spec series or a suite series', T, async () => {
    const run = unitRun({ lanes: [{ id: 'shared', cadence: 'build', argv: ['true'], systems: ['add'] }], systemsMap: MAP });
    await series(run, 1, specLanes(run), run.base, 'spec');
    const other = commit(run, { 'src/other/y.js': '1\n' });
    const suite = await series(run, 2, specLanes(run), other, 'suite');
    assert.deepEqual(suite.ledger.map((l) => l.reused?.at ?? null), [run.base], 'the spec series\' pass, on the same input');
    assert.deepEqual(seriesLedger(run.ctx, parentOf(2), specLanes(run), 'suite', other, specSeriesRoot(run.runDir, parentOf(2))), suite.ledger);
    assert.equal(laneSpawns(run, 'shared').length, 1);
  });

  test('lanes.reuse-red-reruns: with no clean pass on the input a lane runs again; its pass is then reused on the same input', T, async () => {
    const counter = join(tmpDir('topology-counter'), 'n');
    const run = unitRun({ lanes: [{ id: 'seq', cadence: 'build', argv: ['sh', '-c', `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; [ $n -ne 1 ]`], systems: ['add'] }], systemsMap: MAP });
    assert.equal((await series(run, 1, specLanes(run), run.base)).end.kind, 'red');
    const b = commit(run, { 'src/other/b.js': '1\n' });
    const second = await series(run, 2, specLanes(run), b);
    assert.deepEqual([second.end.kind, second.ledger[0]!.reused], ['green', null], 'the newest run on the input was red: run again');
    const c = commit(run, { 'src/other/c.js': '1\n' });
    assert.deepEqual((await series(run, 3, specLanes(run), c)).ledger[0]!.reused?.at, b, 'reused from the pass');
    assert.equal(laneSpawns(run, 'seq').length, 3, 'red then a passing diagnostic rerun (flaky: red), then the run on b');
  });
});

describe('lanes.test-only (dev.17)', () => {
  test('lanes.test-only-run: only leaf test files changed since the clean pass: testArgv runs them; a helper change runs the whole lane', T, async () => {
    const run = unitRun({
      files: { 'test/add1.test.js': PASSING },
      lanes: [{ id: 'tests', cadence: 'build', argv: ['node', '--test', 'test/add1.test.js'], testArgv: ['node', '--test', '{files}'], systems: ['add'] }],
      systemsMap: MAP,
    });
    assert.equal((await series(run, 1, specLanes(run), run.base)).end.kind, 'green');
    const leaf = commit(run, { 'test/add2.test.js': PASSING });
    const partial = await series(run, 2, specLanes(run), leaf);
    assert.equal(partial.end.kind, 'green');
    assert.deepEqual(partial.ledger.map((l) => [l.reused, l.argv]), [[null, ['node', '--test', 'test/add2.test.js']]]);
    const s = laneSpawns(run, 'tests')[1]!.expect.subject;
    assert.ok(s.purpose === 'lane' && s.files !== undefined);
    assert.deepEqual(s.purpose === 'lane' ? s.files : null, ['test/add2.test.js']);
    // The partial run is the lane's clean pass on its input now: the same commit reuses it.
    assert.notEqual((await series(run, 3, specLanes(run), leaf)).ledger[0]!.reused, null);
    // The leaf test deleted again: the input is the base's, whose pass is reused.
    writeFiles(run.repo, { 'test/add2.test.js': null });
    const deleted = sha(commitAll(run.repo, 'drop add2'));
    assert.deepEqual((await series(run, 5, specLanes(run), deleted)).ledger.map((l) => l.reused?.at ?? null), [run.base]);
    // A helper (no tests glob matches it) changed: the whole lane.
    const helper = commit(run, { 'test/helpers/h.js': 'export const h = 1;\n' });
    const whole = await series(run, 6, specLanes(run), helper);
    assert.deepEqual(whole.ledger.map((l) => l.argv), [['node', '--test', 'test/add1.test.js']]);
    assert.equal(laneSpawns(run, 'tests').length, 3);
  });
});

describe('lanes.test-only-deletions (dev.17)', () => {
  test('lanes.test-only-deletion: only a leaf test file deleted since the clean pass: nothing runs, the pass carried over', T, async () => {
    const run = unitRun({
      files: { 'test/add1.test.js': PASSING, 'test/add0.test.js': PASSING },
      lanes: [{ id: 'tests', cadence: 'build', argv: ['node', '--test', 'test/add0.test.js', 'test/add1.test.js'], testArgv: ['node', '--test', '{files}'], systems: ['add'] }],
      systemsMap: MAP,
    });
    assert.equal((await series(run, 1, specLanes(run), run.base)).end.kind, 'green');
    writeFiles(run.repo, { 'test/add0.test.js': null });
    const dropped = sha(commitAll(run.repo, 'drop add0'));
    const s = await series(run, 2, specLanes(run), dropped);
    assert.deepEqual(s.ledger.map((l) => l.reused?.at ?? null), [run.base]);
    assert.equal(laneSpawns(run, 'tests').length, 1);
  });
});

describe('lanes.stochastic (dev.17)', () => {
  const counted = (counter: string, fails: readonly number[]): LaneJson['argv'] =>
    ['sh', '-c', `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; case " ${fails.join(' ')} " in *" $n "*) exit 1;; esac; exit 0`];

  test('lanes.stochastic-k-of-n: a red run among k passes is no red and never flaky; it stops once k passed', T, async () => {
    const counter = join(tmpDir('topology-stoch'), 'n');
    const run = unitRun({ lanes: [{ id: 'noisy', cadence: 'build', argv: counted(counter, [1]), stochastic: { runs: 3, minPasses: 2 } }] });
    const s = await series(run, 1, specLanes(run), run.base);
    assert.equal(s.end.kind, 'green');
    assert.equal(laneSpawns(run, 'noisy').length, 3, 'red, pass, pass');
    assert.deepEqual(s.ledger.map((l) => [l.verdict, l.flaky, l.diagnostic, l.voided]), [['pass', false, null, null]]);
    assert.deepEqual(seriesLedger(run.ctx, parentOf(1), specLanes(run), 'spec', run.base, specSeriesRoot(run.runDir, parentOf(1))), s.ledger);
  });

  test('lanes.stochastic-red: it stops once k passes can no longer be reached, red', T, async () => {
    const counter = join(tmpDir('topology-stoch'), 'n');
    const run = unitRun({ lanes: [{ id: 'noisy', cadence: 'build', argv: counted(counter, [1, 2]), stochastic: { runs: 3, minPasses: 2 } }] });
    const s = await series(run, 1, specLanes(run), run.base);
    assert.equal(s.end.kind, 'red');
    assert.equal(laneSpawns(run, 'noisy').length, 2, 'two reds: two passes of three are out of reach');
    assert.equal(s.ledger[0]!.flaky, false);
  });
});

describe('lanes.forces (dev.17)', () => {
  test('lanes.forces-run-at-lanes-stage: a suite lane of a later cadence runs at the unit\'s lanes stage only when its spec forces it', T, async () => {
    const suite: readonly LaneJson[] = [{ id: 'e2e', cadence: 'candidate', argv: ['sh', '-c', 'exit 0'] }, { id: 'lint', cadence: 'build', argv: ['sh', '-c', ': lint'] }];
    const lanesOf = [{ id: 'a', cadence: 'build' as const, argv: ['true'] }];
    const plain = unitRun({ lanes: lanesOf, suite });
    assert.equal(started(await lanes(plain.ctx, plain.unit, plain.base)).outcome.kind, 'green');
    assert.deepEqual([laneSpawns(plain, 'e2e').length, laneSpawns(plain, 'lint').length], [0, 1], 'a candidate lane waits for the candidate');
    const forced = unitRun({ lanes: lanesOf, suite, forces: ['e2e'] });
    assert.equal(started(await lanes(forced.ctx, forced.unit, forced.base)).outcome.kind, 'green');
    assert.deepEqual([laneSpawns(forced, 'e2e').length, laneSpawns(forced, 'lint').length], [1, 1]);
  });

  test('lanes.forced-by-batch-repair: a spec repairing a batch lane\'s P1 forces that lane; its forces besides', () => {
    const spec = { forces: [laneId('e2e')], repairs: ['F-1' as FindingId, 'F-2' as FindingId] } as unknown as SpecM1;
    const view = { holistic: () => ({ findings: [{ id: 'F-1', lane: laneId('soak') }, { id: 'F-2' }, { id: 'F-3', lane: laneId('other') }] }) } as unknown as JournalView;
    assert.deepEqual([...forcedLanes(view, spec)].sort(), ['e2e', 'soak']);
  });
});
