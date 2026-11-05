import { WorktreeRecoveryError } from '../src/git/worktree.ts';
import { certification,workRuns } from '../src/status-work.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { systemName } from '../src/core/ids.ts';
// M4a rev 3 step N1 (src/pipeline/lanes.ts, src/pipeline/redlane.ts, src/host/signatures.ts), integrated over real
// processes and real git: series certificates, spec lane reuse (F1a), the repeat-signature rerun skip and the
// persisted red class (F2), host-suspected failures (F3), the series' own checkout (Q3) and certified-only journey
// reuse (R51). Named tests: lanes.reuse-*, lanes.no-reuse-after-dirty, lanes.inputs-*, lanes.no-inputs-reruns-on-new-sha,
// lanes.estate-same-sha-only, lanes.unresolvable-argv0-reruns, lanes.full-reuse-creates-checkout, lanes.series-tree-own-path,
// lanes.ledger-readback-with-reuse, e2e.gate-after-full-reuse, redlane.*, lanes.journey-reuse-certified-only, and the crash
// rows LANE_REUSE, SERIES_CERTIFIED and RED_CLASS (labels lanes.after-reused, lanes.after-census-before-certified,
// redlane.after-class).
import assert from 'node:assert/strict';
import { chmodSync,existsSync,readFileSync,rmSync,statSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import type { Fact,IntentOf } from '../src/core/events.ts';
import { type Sha,invocationId,jobId,opKey,resourceName,sha } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { readJournal } from '../src/core/log.ts';
import { type LaneDef,RED_FILE,redFile } from '../src/core/records.ts';
import { absPath,isoTimeOf } from '../src/core/values.ts';
import { parseObligations } from '../src/holistic/types.ts';
import type { HostSample } from '../src/host/sample.ts';
import { parsePlan } from '../src/input/plan.ts';
import { type StageContext,type StageParent,pinDispatch,runOp,verificationWorktree } from '../src/pipeline/dispatch.ts';
import { unitTip } from '../src/pipeline/gate.ts';
import { invocationDir,invoke } from '../src/pipeline/invoke.ts';
import {
LANE_DEADLINE_MS,LANE_GRACE_MS,LANE_STALL_MS,type LaneRuntime,type Series,arcJourneyLane,
laneOrder,
latestSpecSeries,
presentCheckouts,removeCheckout,reserveNow,runJourneySeries,runLaneSeries,
seriesLedger,seriesOrder,seriesTree,specSeriesRoot,suiteJourneyLane,
} from '../src/pipeline/lanes.ts';
import { readRedClass } from '../src/pipeline/redlane.ts';
import { holisticInForce,lanes,loadUnitSpec } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { worktreeCreateOp } from '../src/recover/ops.ts';
import type { Acquire } from '../src/schedule/types.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { wire } from './fixtures/publish-common.ts';
import { DB,type LaneJson,SCENARIO_TIMEOUT_MS,type StageRun,U1,admitAll,keptSpec,planCheckStep,setupUnit,spawnIntents,started } from './fixtures/stage-common.ts';
import { MUL,codexStep,contextFor,gateStep,mulBuild,outcomes,setupArc,stepUntil } from './fixtures/unit-common.ts';
import { assertFired,writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll,git,tmpDir,writeFiles } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { LANE_PRIORITY,LANE_REUSE,RED_CLASS,SERIES_CERTIFIED,crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const sample = (load1: number): HostSample => ({ load1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 });
const CLEAR = sample(1);
const BUSY = sample(20);

const parentOf = (attempt: number): StageParent => ({ type: 'stage', unit: U1, stage: 'lanes', attempt });

function unitRun(lanesJson: readonly LaneJson[], resources: readonly string[] = []): StageRun {
  const run = setupUnit({ steps: [], lanes: lanesJson, resources });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  return run;
}

/** A unit run whose first revision records `systemsMap` (dev.17). */
function unitRunWith(lanesJson: readonly LaneJson[], systemsMap: JsonValue): StageRun {
  const run = setupUnit({ steps: [], lanes: lanesJson, systemsMap });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  return run;
}

const specLanes = (run: StageRun): readonly LaneDef[] => laneOrder(loadUnitSpec(run.ctx, run.unit).spec);

const runtime = (ctx: StageContext, sampleHost: () => HostSample = () => CLEAR, signal: AbortSignal = new AbortController().signal, acquire: Acquire = reserveNow(ctx)): LaneRuntime => ({
  acquire, rank: () => { throw new Error('not ranked'); }, signal, sampleHost,
});

type SeriesOpts = Readonly<{ ctx?: StageContext; rt?: LaneRuntime }>;

/** The unit's spec series as stage attempt `attempt` of lanes runs it, at `at`, straight through `runLaneSeries`. */
function series(run: StageRun, attempt: number, defs: readonly LaneDef[], at: Sha, opts: SeriesOpts = {}): Promise<Series> {
  const ctx = opts.ctx ?? run.ctx;
  const parent = parentOf(attempt);
  const checkout = { path: absPath(join(tmpDir('rev3-tree'), 'tree')), checkout: { type: 'detached', at } } as const;
  return runLaneSeries(ctx, parent, seriesOrder(defs), 'spec', checkout, specSeriesRoot(ctx.runDir, parent), opts.rt ?? runtime(ctx), false);
}

const readBack = (run: StageRun, attempt: number, at: Sha) =>
  seriesLedger(run.ctx, parentOf(attempt), specLanes(run), 'spec', at, specSeriesRoot(run.runDir, parentOf(attempt)));

const laneSpawns = (run: StageRun, lane: string, attempt?: number): readonly IntentOf<'proc.spawn'>[] => spawnIntents(run).filter((i) => {
  const s = i.expect.subject;
  return s.purpose === 'lane' && s.lane === lane && (attempt === undefined || (i.parent.type === 'stage' && i.parent.attempt === attempt));
});

const factsOf = (runDir: string, arc: string): readonly Fact[] => readJournal(absPath(runDir), arc as never).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const runFacts = (run: StageRun) => factsOf(run.runDir, run.ctx.plan().arc);
const reuses = (run: StageRun) => runFacts(run).filter((f) => f.kind === 'lane-reused');
const certificates = (run: StageRun) => runFacts(run).filter((f) => f.kind === 'series-certified');

/** Commits `files` on the repo's branch; returns the new commit. */
const commit = (run: StageRun, files: Readonly<Record<string, string>>): Sha => {
  writeFiles(run.repo, files);
  return sha(commitAll(run.repo, 'more'));
};

/**
 * A lane whose n-th run (counted in `counter`) ends `steps[n-1]` (the last repeats): `pass`, or a red whose stderr's
 * last line is the text.
 */
function seqLane(id: string, counter: string, steps: readonly string[]): LaneJson {
  const arms = steps.map((s, i) => `${i === steps.length - 1 ? '*' : i + 1}) ${s === 'pass' ? 'exit 0' : `echo "${s}" >&2; exit 1`};;`).join(' ');
  return { id, argv: ['sh', '-c', `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; case $n in ${arms} esac`] };
}

describe('series certificates and lane reuse (F1a)', () => {
  test('lanes.reuse-same-sha-after-pause: a pause ends a series after its first lane passed; the next attempt reuses that pass at the same SHA and runs only the rest', T, async () => {
    const run = unitRun([{ id: 'first', argv: ['true'] }, { id: 'second', argv: ['true'], resources: [DB] }], [DB]);
    const controller = new AbortController();
    const now = reserveNow(run.ctx);
    const pausing: Acquire = (request, holder, rank, signal) => {
      if (!request.named.includes(resourceName(DB))) return now(request, holder, rank, signal);
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
        setImmediate(() => controller.abort('pause'));
      });
    };
    const paused = await series(run, 1, specLanes(run), run.base, { rt: runtime(run.ctx, () => CLEAR, controller.signal, pausing) });
    assert.deepEqual(paused.end, { kind: 'interrupted', reason: 'pause' });
    assert.deepEqual(certificates(run).map((c) => c.kind === 'series-certified' && [c.parent, c.at]), [[parentOf(1), run.base]], 'the paused series was clean: certified');

    const resumed = await series(run, 2, specLanes(run), run.base);
    assert.equal(resumed.end.kind, 'green');
    assert.equal(laneSpawns(run, 'first').length, 1, 'the first lane ran once, in attempt 1');
    assert.equal(laneSpawns(run, 'second').length, 1);
    const first = laneSpawns(run, 'first')[0]!;
    const inv = `${first.op}#${first.ordinal}`;
    assert.deepEqual(resumed.ledger.map((l) => [l.lane, l.verdict, l.reused]), [['first', 'pass', { at: run.base, inv }], ['second', 'pass', null]]);
    assert.deepEqual(reuses(run).map((f) => f.kind === 'lane-reused' && [f.parent, f.lane, f.from]), [[parentOf(2), 'first', { parent: parentOf(1), inv, at: run.base }]]);
    // lanes.ledger-readback-with-reuse: the journal reads the same ledger back, reused entry included, in series order.
    assert.deepEqual(readBack(run, 2, run.base), resumed.ledger);
    assert.deepEqual(latestSpecSeries(run.ctx, U1), parentOf(2));
    // The spawn carries its reuse identity and the red protocol revision.
    const s = first.expect.subject;
    assert.ok(s.purpose === 'lane' && s.identity !== undefined && s.redRev === 2);
    assert.ok(s.identity.argv0 !== null && s.identity.argv0.path.endsWith('true'));
  });

  test('lanes.reuse-requires-identity: a changed lane rev, environment, argv[0] path or argv[0] content reruns; an unchanged identity reuses', T, async () => {
    const bins = [tmpDir('rev3-bin-a'), tmpDir('rev3-bin-b')];
    for (const dir of bins) {
      writeFileSync(join(dir, 'rev3-tool'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, 'rev3-tool'), 0o755);
    }
    const run = unitRun([{ id: 'tool', argv: ['rev3-tool'], env: { pass: ['PATH', 'REV3_MODE'] } }]);
    const [lane] = specLanes(run);
    const ctxWith = (bin: string, mode: string): StageContext => ({ ...run.ctx, hostEnv: { ...run.ctx.hostEnv, PATH: `${bin}:${run.ctx.hostEnv['PATH']}`, REV3_MODE: mode } });
    const ran = async (attempt: number, def: LaneDef, ctx: StageContext): Promise<boolean> => {
      const s = await series(run, attempt, [def], run.base, { ctx, rt: runtime(ctx) });
      assert.equal(s.end.kind, 'green', `attempt ${attempt}`);
      return s.ledger[0]!.reused === null;
    };
    assert.equal(await ran(1, lane!, ctxWith(bins[0]!, 'a')), true, 'the first run');
    assert.equal(await ran(2, lane!, ctxWith(bins[0]!, 'a')), false, 'the same identity: reused');
    assert.equal(await ran(3, { ...lane!, env: { ...lane!.env, set: { EXTRA: '1' } } }, ctxWith(bins[0]!, 'a')), true, 'another lane rev');
    assert.equal(await ran(4, lane!, ctxWith(bins[0]!, 'a')), false, 'back to the first rev: the reuse key of attempt 1, reused (dev.17)');
    assert.equal(await ran(5, lane!, ctxWith(bins[0]!, 'b')), true, 'a passed-through variable changed: another environment');
    assert.equal(await ran(6, lane!, ctxWith(bins[1]!, 'b')), true, 'argv[0] resolves to another path');
    writeFileSync(join(bins[1]!, 'rev3-tool'), '#!/bin/sh\n# changed\nexit 0\n');
    assert.equal(await ran(7, lane!, ctxWith(bins[1]!, 'b')), true, 'argv[0] content changed');
    assert.equal(await ran(8, lane!, ctxWith(bins[1]!, 'b')), false, 'unchanged again: reused');
    assert.equal(laneSpawns(run, 'tool').length, 5);
  });

  test('lanes.no-reuse-after-dirty: a series whose checkout a lane dirtied is never certified; its passes rerun', T, async () => {
    const run = unitRun([{ id: 'clean', argv: ['true'] }, { id: 'writer', argv: ['sh', '-c', 'echo stray > src/stray.txt'] }]);
    const dirty = await series(run, 1, specLanes(run), run.base);
    assert.equal(dirty.end.kind, 'green');
    assert.deepEqual(dirty.dirty, ['src/stray.txt']);
    assert.deepEqual(certificates(run), [], 'a dirty series is not certified');
    const again = await series(run, 2, specLanes(run), run.base);
    assert.deepEqual(again.ledger.map((l) => l.reused), [null, null]);
    assert.equal(laneSpawns(run, 'clean').length, 2);
    assert.deepEqual(reuses(run), []);
  });

  test('lanes.systems-untouched-reused / lanes.systems-touched-reruns / lanes.explicit-whole-input-reruns-on-new-sha: systems reuse and explicit whole-tree input invalidation across SHAs', T, async () => {
    const run = unitRunWith([{ id: 'add', argv: ['node', '--test', 'test/add.test.js'], systems: ['add'] }, { id: 'plain', argv: ['true'], inputs: ['**'] }], {
      systems: { add: { paths: ['src/add.js'], tests: ['test/add.test.js'] }, other: { paths: ['src/other.js'] } },
    });
    writeFiles(run.repo, { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' });
    const fixed = sha(commitAll(run.repo, 'fix add'));
    const first = await series(run, 1, specLanes(run), fixed);
    assert.equal(first.end.kind, 'green');
    const other = commit(run, { 'src/other.js': 'export const other = 1;\n' });
    const second = await series(run, 2, specLanes(run), other);
    assert.deepEqual(second.ledger.map((l) => [l.lane, l.reused?.at ?? null]), [['add', fixed], ['plain', null]], 'add reused from the earlier SHA; plain, declaring whole-tree inputs, reran');
    const touched = commit(run, { 'test/add.test.js': `${readFileSync(join(run.repo, 'test', 'add.test.js'), 'utf8')}\n// touched\n` });
    const third = await series(run, 3, specLanes(run), touched);
    assert.deepEqual(third.ledger.map((l) => l.reused), [null, null], 'its system changed: add reran');
    assert.equal(laneSpawns(run, 'add').length, 2);
    assert.equal(laneSpawns(run, 'plain').length, 3);
  });

  test('lanes.no-map-same-tree-only (dev.17): without a systems map a lane reads the whole tree, so it reuses only on the same tree', T, async () => {
    const run = unitRun([{ id: 'estate', cadence: 'unit', argv: ['true'] }]);
    await series(run, 1, specLanes(run), run.base);
    const same = await series(run, 2, specLanes(run), run.base);
    assert.notEqual(same.ledger[0]!.reused, null, 'same SHA: reused');
    const moved = commit(run, { 'src/other.js': 'export const other = 1;\n' });
    const next = await series(run, 3, specLanes(run), moved);
    assert.equal(next.ledger[0]!.reused, null, 'another tree: the lane reruns');
    assert.equal(laneSpawns(run, 'estate').length, 2);
  });

  test('lanes.unresolvable-argv0-reruns: argv[0] a repository file has no program identity: reused at the same SHA, rerun on another', T, async () => {
    const run = unitRun([{ id: 'script', argv: ['scripts/ok.sh'] }]);
    writeFiles(run.repo, { 'scripts/ok.sh': '#!/bin/sh\nexit 0\n' });
    chmodSync(join(run.repo, 'scripts', 'ok.sh'), 0o755);
    const withScript = sha(commitAll(run.repo, 'script'));
    await series(run, 1, specLanes(run), withScript);
    const s = laneSpawns(run, 'script')[0]!.expect.subject;
    assert.ok(s.purpose === 'lane' && s.identity?.argv0 === null, 'a repository-file argv[0] resolves to no program');
    assert.notEqual((await series(run, 2, specLanes(run), withScript)).ledger[0]!.reused, null);
    const moved = commit(run, { 'src/other.js': 'export const other = 1;\n' });
    assert.equal((await series(run, 3, specLanes(run), moved)).ledger[0]!.reused, null);
    assert.equal(laneSpawns(run, 'script').length, 2);
  });

  test('lanes.inputs-kept: suite and arc lanes retain declared reuse inputs', () => {
    const lane = { id: 'l', argv: ['true'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, cadence: 'build', resources: [], evidenceGlobs: [], inputs: ['src/**'] };
    const plan = {
      schema: 'roadmap/plan-m1', arc: 'arc-1', integrationBranch: 'main', baseline: 'a'.repeat(40), worktreeRoot: '/tmp/wt', contracts: [], rulings: 'r.md',
      architectureDoc: 'A.md', direction: 'd', suite: { lanes: [lane] }, resources: [], units: [{ id: 'u1', spec: 'u1.json', risk: 'low', systems: [systemName('app')], resources: [] }],
    };
    assert.deepEqual(parsePlan(plan).suite.lanes[0]!.inputs, ['src/**']);
    assert.deepEqual(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [{ ...lane, reporter: 'jsonl' }], obligations: [], mapping: { systems: [] } }).lanes[0]!.inputs, ['src/**']);
  });

  test('lanes.full-reuse-creates-checkout / lanes.series-tree-own-path: a series reusing every lane still makes, censuses and certifies its checkout; seriesTree finds the series\' own checkout among others its attempt made', T, async () => {
    const run = unitRun([{ id: 'a', argv: ['true'] }, { id: 'b', argv: ['true'] }]);
    const first = started(await lanes(run.ctx, run.unit, run.base));
    assert.equal(first.outcome.kind, 'green');
    const second = started(await lanes(run.ctx, run.unit, run.base));
    assert.equal(second.outcome.kind, 'green');
    assert.deepEqual(second.ledger.map((l) => l.reused !== null), [true, true]);
    assert.equal(spawnIntents(run).filter((i) => i.expect.subject.purpose === 'lane').length, 2, 'nothing ran in attempt 2');
    const parent = latestSpecSeries(run.ctx, U1)!;
    assert.equal(parent.attempt, 2);
    const path = verificationWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1, parent.attempt);
    assert.equal(second.verification?.path, path);
    assert.equal(git(path, 'rev-parse', 'HEAD'), run.base, 'the checkout of the commit, for the gate');
    assert.ok(existsSync(join(specSeriesRoot(run.runDir, parent), '_reused')), 'its evidence snapshot');
    assert.deepEqual(certificates(run).map((c) => c.kind === 'series-certified' && [c.parent, c.checkout]).at(-1), [parent, path]);
    // Another checkout the same attempt makes after its series (D1's journey checkout, N3) never hides the series' own.
    await runOp(run.ctx.journal, worktreeCreateOp(run.ctx.repo), `worktree:${U1}:witness`, parent, { path: absPath(join(tmpDir('rev3-other'), 'w')), checkout: { type: 'detached', at: run.base } });
    assert.equal(seriesTree(run.journal.view, parent, path)?.path, path);
    assert.deepEqual(readBack(run, 2, run.base), second.ledger);
  });
});

describe('the gate after a full reuse (Q3)', () => {
  test('e2e.gate-after-full-reuse: a second lanes attempt reuses every lane; the gate finds that attempt\'s checkout and the unit merges', T, async () => {
    const r = contextFor(setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] }));
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
      const again = started(await lanes(r.ctx, r.unit('u1'), unitTip(r.ctx, U1)));
      assert.equal(again.outcome.kind, 'green');
      assert.deepEqual(again.ledger.map((l) => l.reused !== null), [true]);
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(outcomes(r.d).slice(6), ['lanes:green', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
      assert.equal(readCalls(r.d.scenarioPath).filter((c) => c.as === 'claude').length, 2, 'one pre-build, one gate');
    } finally {
      r.journal.close();
    }
  });
});

describe('the red class and the repeat skip (F2, F3)', () => {
  test('redlane.repeat-skips-rerun / redlane.class-persisted: a red repeating the unit\'s confirmed red with the same specific signature is red without a rerun; every class is persisted before the decision', T, async () => {
    const counter = join(tmpDir('rev3-count'), 'n');
    const run = unitRun([seqLane('broken', counter, ['AssertionError: expected widget 3 to equal 4 at 2026-10-06T09:00:00Z'])]);
    const first = await series(run, 1, specLanes(run), run.base);
    assert.equal(first.end.kind, 'red');
    assert.equal(laneSpawns(run, 'broken', 1).length, 2, 'the first red: a diagnostic rerun');
    const firstClass = readRedClass(first.ledger[0]!.evidenceDir)!;
    assert.deepEqual([firstClass.class, firstClass.redRev], [{ kind: 'diagnostic' }, 2]);
    const moved = commit(run, { 'src/other.js': 'export const other = 1;\n' });
    const second = await series(run, 2, specLanes(run), moved);
    assert.equal(second.end.kind, 'red');
    assert.equal(laneSpawns(run, 'broken', 2).length, 1, 'a repeat: no rerun');
    const [record] = second.ledger;
    const earlier = laneSpawns(run, 'broken', 1)[0]!;
    assert.deepEqual([record!.repeat, record!.flaky, record!.diagnostic], [{ attempt: 1, inv: `${earlier.op}#${earlier.ordinal}` }, false, null]);
    const persisted = redFile(JSON.parse(readFileSync(join(record!.evidenceDir, RED_FILE), 'utf8')), RED_FILE);
    assert.deepEqual(persisted.class, { kind: 'repeat', attempt: 1, inv: `${earlier.op}#${earlier.ordinal}` });
    assert.equal(persisted.failure, firstClass.failure, 'the same signature, timestamps masked');
    assert.deepEqual(readBack(run, 2, moved), second.ledger, 'read back from red.json');
    // A third red repeats the repeat.
    const third = await series(run, 3, specLanes(run), moved);
    assert.equal(laneSpawns(run, 'broken', 3).length, 1);
    assert.equal(third.ledger[0]!.repeat?.attempt, 2);
  });

  test('redlane.repeat-needs-specific-signature / redlane.intermittent-identical-summary-reruns: a summary line of generic words and numbers is never a repeat', T, async () => {
    const counter = join(tmpDir('rev3-count'), 'n');
    const run = unitRun([seqLane('summary', counter, ['Tests: 1 failed, 12 passed, 13 total'])]);
    await series(run, 1, specLanes(run), run.base);
    await series(run, 2, specLanes(run), run.base);
    assert.equal(laneSpawns(run, 'summary', 2).length, 2, 'the same generic summary: rerun');
    assert.deepEqual(readRedClass(readBack(run, 2, run.base)[0]!.evidenceDir)?.class, { kind: 'diagnostic' });
  });

  test('redlane.repeat-after-flaky-reruns: after a flaky red the next identical red reruns', T, async () => {
    const counter = join(tmpDir('rev3-count'), 'n');
    const text = 'Error: widget registry lost entry alpha';
    const run = unitRun([seqLane('flaky', counter, [text, 'pass', text])]);
    const first = await series(run, 1, specLanes(run), run.base);
    assert.equal(first.ledger[0]!.flaky, true);
    await series(run, 2, specLanes(run), run.base);
    assert.equal(laneSpawns(run, 'flaky', 2).length, 2);
  });

  test('redlane.repeat-after-pass-reruns / redlane.new-signature-reruns: a pass since, or another failure, reruns', T, async () => {
    const counter = join(tmpDir('rev3-count'), 'n');
    const text = 'Error: widget registry lost entry alpha';
    const run = unitRun([seqLane('lane', counter, [text, text, 'pass', text, text, 'Error: gadget registry lost entry beta'])]);
    await series(run, 1, specLanes(run), run.base);
    const passed = await series(run, 2, specLanes(run), run.base);
    assert.equal(passed.end.kind, 'green');
    // The pass at attempt 2 would be reused at the same SHA: run the next ones on new commits, without inputs.
    await series(run, 3, specLanes(run), commit(run, { 'src/x.js': '1\n' }));
    assert.equal(laneSpawns(run, 'lane', 3).length, 2, 'a pass since the earlier red: rerun');
    await series(run, 4, specLanes(run), commit(run, { 'src/x.js': '2\n' }));
    assert.equal(laneSpawns(run, 'lane', 4).length, 2, 'another failure line: rerun');
  });

  test('redlane.repeat-env-changed-reruns / redlane.busy-host-reruns: another environment, or a busy host, reruns', T, async () => {
    const counter = join(tmpDir('rev3-count'), 'n');
    const run = unitRun([{ ...seqLane('lane', counter, ['Error: widget registry lost entry alpha']), env: { pass: ['PATH', 'REV3_MODE'] } }]);
    const ctxWith = (mode: string): StageContext => ({ ...run.ctx, hostEnv: { ...run.ctx.hostEnv, REV3_MODE: mode } });
    await series(run, 1, specLanes(run), run.base, { ctx: ctxWith('a'), rt: runtime(ctxWith('a')) });
    await series(run, 2, specLanes(run), run.base, { ctx: ctxWith('b'), rt: runtime(ctxWith('b')) });
    assert.equal(laneSpawns(run, 'lane', 2).length, 2, 'another environment: rerun');
    await series(run, 3, specLanes(run), run.base, { ctx: ctxWith('b'), rt: runtime(ctxWith('b'), () => BUSY) });
    assert.equal(laneSpawns(run, 'lane', 3).length, 2, 'a busy host: rerun');
    await series(run, 4, specLanes(run), run.base, { ctx: ctxWith('b'), rt: runtime(ctxWith('b')) });
    assert.equal(laneSpawns(run, 'lane', 4).length, 1, 'the same environment on a clear host: a repeat');
  });

  test('redlane.stamped-missing-red-json-fails-loud: a stamped run that was rerun without its red.json does not read back', T, async () => {
    const run = unitRun([{ id: 'broken', argv: ['sh', '-c', 'echo "Error: widget broke" >&2; exit 1'] }]);
    const done = await series(run, 1, specLanes(run), run.base);
    assert.equal(laneSpawns(run, 'broken').length, 2);
    rmSync(join(done.ledger[0]!.evidenceDir, RED_FILE));
    assert.throws(() => readBack(run, 1, run.base), /red class \(red\.json\) was never written/);
  });

  test('redlane.unstamped-refused: a pre-break rerun without schema-2 evidence fails loudly', T, async () => {
    const run = unitRun([{ id: 'oom', argv: ['sh', '-c', 'echo "Out of memory: Killed process 42" >&2; exit 1'] }]);
    const [lane] = specLanes(run);
    const parent = parentOf(1);
    const tree = absPath(tmpDir('rev3-unstamped'));
    // Two dev.6 spawns (no redRev, no identity): the red run and its diagnostic rerun, as 1.0.0-dev.6 wrote them.
    const once = async (argv: readonly string[]) => invoke(run.ctx.journal, run.ctx.containment, {
      runDir: run.ctx.runDir,
      origin: { type: 'new', key: opKey(`lane:${U1}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
      subject: { purpose: 'lane', unit: U1, lane: lane!.id, set: 'spec', at: run.base },
      launch: () => ({ argv, cwd: tree, env: { PATH: process.env['PATH'] ?? '' }, stdinPath: null, stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS, terminal: { type: 'command', purpose: 'lane', expectedExit: 0 } }),
    });
    await once(lane!.argv);
    await once(['true']);
    assert.throws(() => readBack(run, 1, run.base), /ENOENT:.*ignored\.json/, 'a pre-break rerun receives no historical classification');
  });

  test('lanes.host-suspected: a red run whose output carries a host signature records it with the host evidence', T, async () => {
    const run = unitRun([{ id: 'etcd', argv: ['sh', '-c', 'echo "Error from server: etcdserver: request timed out" >&2; exit 1'] }]);
    const done = await series(run, 1, specLanes(run), run.base);
    assert.equal(done.end.kind, 'blocked', 'a signature on a clear host: no verdict');
    assert.deepEqual(done.ledger[0]!.hostSuspected, { signatures: ['etcd-request-timeout'], busy: false });
    assert.deepEqual(readRedClass(done.ledger[0]!.evidenceDir)?.class, { kind: 'signature-without-evidence', signatures: ['etcd-request-timeout'] });
    assert.deepEqual(readBack(run, 1, run.base), done.ledger);
    assert.deepEqual(certificates(run), [], 'a blocked series is never certified');
  });
});

describe('certified-only journey reuse (R51)', () => {
  test('lanes.journey-reuse-certified-only: an observation whose series left its checkout dirty is never reused; a clean series\' is', T, async () => {
    const dirtying = ['sh', '-c', 'echo \'{"testId":"t1","selected":1,"outcome":"pass"}\' >> "$ROADMAP_WITNESS_FILE"; echo stray > stray.txt'];
    const { d } = holisticArc({ steps: [], mapping: [], obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: {}, laneExtra: { journey: { argv: dirtying } } });
    const r = contextFor(d);
    try {
      const w = wire(r);
      const ctx = { ...r.ctx, acquireFirst: w.arbiter.acquireFirst };
      const lane = arcJourneyLane(holisticInForce(r.ctx).obligations!.lanes[0]!);
      const tip = sha(git(d.repo, 'rev-parse', 'main'));
      const go = (n: number) => runJourneySeries(ctx, { type: 'job', job: jobId('audit', 1), acquireFirst: ctx.acquireFirst }, [lane], {
        path: absPath(join(tmpDir('rev3-journey'), `checkout-${n}`)), checkout: { type: 'detached', at: tip },
      }, { reuse: true, stop: () => false });
      const first = await go(1);
      assert.deepEqual(first.checkout?.dirty, ['stray.txt']);
      const second = await go(2);
      assert.notEqual(second.runs[0]!.inv, null, 'an uncertified observation: run again');
      assert.deepEqual(factsOf(d.runDir, d.arc).filter((f) => f.kind === 'series-certified'), []);
      const spawned = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey');
      assert.equal(spawned.length, 2);
      assert.ok(spawned.every((i) => i.expect.subject.purpose === 'journey' && i.expect.subject.redRev === 2));
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash rows (identical replay: no duplicate spawn, the same outcomes as an uncrashed run)

const STABLE: LaneJson = { id: 'stable', argv: ['node', '--test', 'test/add.test.js'], systems: ['add'] };
/** The fix commit touches only `mul`'s system, so the stable lane (system `add`) reads the same input across it. */
const CRASH_MAP: JsonValue = { systems: { add: { paths: ['src/add.js', 'test/add.test.js'] }, mul: { paths: ['src/mul.js', 'test/mul.test.js'] } } };
const MUL_LANE: LaneJson = { id: 'mul', argv: ['node', '--test', 'test/mul.test.js'], systems: ['mul'] };
const MUL_BROKEN = { ...MUL, 'src/mul.js': 'export function mul(a, b) {\n  return a + b;\n}\n' };

/** The one label a crash row's cell crashes (test/matrix.ts). */
const labelOf = (row: string): string => crashCells(row).map((c) => c.label).join();

async function crashThenResume(steps: Parameters<typeof setupArc>[0]['steps'], label: string): Promise<Readonly<{ d: ReturnType<typeof setupArc> }>> {
  const d = setupArc({ steps, units: [{ id: 'u1', lanes: [STABLE, MUL_LANE] }], systemsMap: CRASH_MAP });
  const trigger = writeTrigger(tmpDir('rev3-crash'), { label, occurrence: 1, unit: 'u1' });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
  const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', `killed at ${label}: ${first.stderr}`);
  assertFired(trigger);
  const second = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
  return { d };
}

const arcSpawns = (d: ReturnType<typeof setupArc>, lane: string) => readJournal(absPath(d.runDir), d.arc as never).events
  .filter((e): e is typeof e & IntentOf<'proc.spawn'> => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'lane' && e.expect.subject.lane === lane);

const FIX_STEPS = [
  planCheckStep({ decision: 'approve' }),
  codexStep([{ type: 'commit', message: 'add mul', files: MUL_BROKEN }], { argv: ['exec', '-C'] }),
  codexStep([{ type: 'commit', message: 'fix mul', files: { 'src/mul.js': MUL['src/mul.js'] } }], { argv: ['exec', 'resume'] }),
  gateStep({ decision: 'approve' }),
];
const FIX_OUTCOMES = [
  'pre-build:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:red',
  'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve',
  'candidate:green', 'ff:published', 'snapshot:published',
];

describe('crash rows', () => {
  for (const cell of crashCells(LANE_PRIORITY)) test(`crash LANE_PRIORITY (${cell.label}): first lane reused, incomplete attempt excluded from ordering`, T, async () => {
    const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(),
      gateStep({ decision: 'revise', directives: ['Explain the implementation.'] }),
      codexStep([{ type: 'commit', message: 'explain mul', files: { 'src/mul.js': `// Multiply the inputs.\n${MUL['src/mul.js']}` } }], { argv: ['exec', 'resume'] }),
      gateStep({ decision: 'approve' })], units: [{ id: 'u1', lanes: [STABLE, MUL_LANE] }], systemsMap: CRASH_MAP });
    const r = contextFor(d);
    let completed: number;
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
      completed = r.journal.view.unit(U1).decided!.attempt;
      await stepUntil(r, 'u1', (f) => f.stage === 'teardown' && f.attempt > completed);
    } finally { r.journal.close(); }
    const trigger = writeTrigger(tmpDir('priority-crash'), { label: cell.label, occurrence: 1, unit: 'u1' });
    const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
    const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    assertFired(trigger);
    const crashed = contextFor(d);
    try {
      const open = crashed.journal.view.unit(U1).open!;
      assert.equal(open.stage, 'lanes');
      assert.equal(crashed.journal.view.completedLanes(U1), completed);
      const reuse = factsOf(d.runDir, d.arc).filter((f) => f.kind === 'lane-reused' && f.lane === 'stable' && f.parent.type === 'stage' && f.parent.attempt === open.attempt);
      assert.equal(reuse.length, 1, 'the first lane was reused before the crash');
      const spawns = arcSpawns(d, 'mul').filter((i) => i.parent.type === 'stage' && i.parent.attempt === open.attempt);
      if (cell.label === 'spawn.after-intent') {
        assert.equal(spawns.length, 1);
        assert.equal(existsSync(join(invocationDir(absPath(d.runDir), invocationId(spawns[0]!.op, spawns[0]!.ordinal)), 'launch.json')), false);
      } else {
        assert.equal(spawns.length, 0);
        assert.equal(crashed.journal.view.opsOf('worktree.create').some((i) => i.parent.type === 'stage' && i.parent.attempt === open.attempt && i.expect.path === verificationWorktree(crashed.ctx.plan().worktreeRoot, crashed.ctx.plan().arc, U1, open.attempt)), false);
      }
    } finally { crashed.journal.close(); }
    const resumed = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout), { kind: 'merged' });
    assert.deepEqual(outcomes(d), [...FIX_OUTCOMES.slice(0, 6), 'lanes:green', 'gate:revise', ...FIX_OUTCOMES.slice(7)]);
    assert.equal(arcSpawns(d, 'stable').length, 1, 'both incomplete and restarted attempts reuse the first lane');
    assert.equal(readCalls(d.scenarioPath).length, 5, 'no backend call twice');
  });

  test('crash LANE_REUSE (lanes.after-reused): killed after recording a reuse across the fix commit; the restart reuses again, never runs the lane twice', T, async () => {
    const { d } = await crashThenResume(FIX_STEPS, labelOf(LANE_REUSE));
    assert.deepEqual(outcomes(d), FIX_OUTCOMES, 'the same outcomes as an uncrashed run');
    assert.equal(arcSpawns(d, 'stable').length, 1, 'the stable lane ran once: reused after the fix, and again after the crash');
    const reused = factsOf(d.runDir, d.arc).filter((f) => f.kind === 'lane-reused' && f.lane === 'stable');
    assert.equal(reused.length, 2, 'the crashed attempt\'s reuse and the restart\'s');
    const ran = arcSpawns(d, 'stable')[0]!;
    assert.ok(reused.every((f) => f.kind === 'lane-reused' && JSON.stringify(f.from.parent) === JSON.stringify(ran.parent)), 'both from the one execution');
    assert.equal(readCalls(d.scenarioPath).length, 4, 'no backend call twice');
  });

  test('lanes.reuse-requires-certificate / crash SERIES_CERTIFIED (lanes.after-census-before-certified): killed before the certificate; the restart reruns every lane', T, async () => {
    const { d } = await crashThenResume([planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], labelOf(SERIES_CERTIFIED));
    assert.deepEqual(outcomes(d), [
      'pre-build:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released',
      'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published',
    ]);
    assert.equal(arcSpawns(d, 'stable').length, 2, 'uncertified: run again');
    assert.equal(arcSpawns(d, 'mul').length, 2);
    const reused = factsOf(d.runDir, d.arc).filter((f) => f.kind === 'lane-reused');
    assert.deepEqual(reused.filter((f) => f.kind === 'lane-reused' && f.set !== 'suite'), [], 'no spec lane reused from the uncertified series');
    // dev.17: one reuse key for every series lane: the candidate's suite lane reuses the certified lanes-stage run on its input.
    assert.deepEqual(reused.map((f) => f.kind === 'lane-reused' && [f.lane, f.set, f.parent.type === 'stage' && f.parent.stage, f.from.parent.type === 'stage' && f.from.parent.stage]),
      [['suite', 'suite', 'candidate', 'lanes']], 'the candidate\'s suite lane reused the lanes stage\'s');
  });

  test('crash RED_CLASS (redlane.after-class): killed after the class is persisted, before the rerun; the restart reruns the series, the class kept', T, async () => {
    const { d } = await crashThenResume(FIX_STEPS, labelOf(RED_CLASS));
    assert.deepEqual(outcomes(d), FIX_OUTCOMES);
    const muls = arcSpawns(d, 'mul');
    // The crashed lanes attempt ran mul once; the next ran it and its diagnostic rerun; the one after the fix once.
    const [a, b, c, e] = muls.map((i) => (i.parent.type === 'stage' ? i.parent.attempt : 0));
    assert.ok(muls.length === 4 && a! < b! && b === c && c! < e!, JSON.stringify(muls.map((i) => i.parent)));
    const crashed = muls[0]!;
    const dir = join(specSeriesRoot(absPath(d.runDir), crashed.parent as StageParent), 'mul');
    assert.deepEqual(readRedClass(dir)?.class, { kind: 'diagnostic' }, 'the crashed attempt\'s class stays on disk');
  });
});

test('redlane make wrapper repeats the specific stdout failure, not the final make target', T, async () => {
  const run = unitRun([{ id: 'make', argv: ['sh', '-c', 'echo "src/check.go:12: G104 unchecked error"; echo "make: *** [Makefile:8: check] Error 2" >&2; exit 2'] }]);
  const first = await series(run, 1, specLanes(run), run.base);
  const second = await series(run, 2, specLanes(run), run.base);
  assert.equal(first.end.kind, 'red');
  assert.equal(second.end.kind, 'red');
  assert.equal(laneSpawns(run, 'make', 1).length, 2);
  assert.equal(laneSpawns(run, 'make', 2).length, 1);
  assert.equal(readRedClass(second.ledger[0]!.evidenceDir)?.class.kind, 'repeat');
});

test('redlane optional deterministic patterns skip reruns; absence keeps diagnostics', T, async () => {
  const run = unitRun([{ id: 'lint', argv: ['sh', '-c', 'echo "G104 unchecked error"; exit 1'] }]);
  const defs = specLanes(run).map((l) => ({ ...l, noRerunPatterns: ['G104 unchecked error'] }));
  const first = await series(run, 1, defs, run.base);
  assert.equal(first.end.kind, 'red');
  assert.equal(laneSpawns(run, 'lint', 1).length, 1);
  assert.deepEqual(readRedClass(first.ledger[0]!.evidenceDir)?.class, { kind: 'no-rerun', reason: 'deterministic' });
  assert.deepEqual(seriesLedger(run.ctx, parentOf(1), defs, 'spec', run.base, specSeriesRoot(run.runDir, parentOf(1))), first.ledger);
  await series(run, 2, specLanes(run), run.base);
  assert.equal(laneSpawns(run, 'lint', 2).length, 2);
});

test('redlane a recorded failing base skips diagnostics for that unit/lane/base only', T, async () => {
  const run = unitRun([{ id: 'broken', argv: ['sh', '-c', 'echo "Tests: 2 failed"; exit 1'] }]);
  run.journal.fact({ kind: 'lane-base-compared', unit: U1, attempt: 1, lane: specLanes(run)[0]!.id, base: run.base, evidence: run.runDir, result: 'fail' });
  const first = await series(run, 2, specLanes(run), run.base);
  assert.equal(laneSpawns(run, 'broken', 2).length, 1, 'generic signature still skips: the base fact suffices');
  assert.deepEqual(readRedClass(first.ledger[0]!.evidenceDir)?.class, { kind: 'no-rerun', reason: 'base-red' });
  const next = commit(run, { 'base-change': 'new baseline' });
  const second = await series(run, 3, specLanes(run), next);
  assert.equal(second.end.kind, 'red');
  assert.equal(laneSpawns(run, 'broken', 3).length, 2, 'a different diffBase reruns');
});

test('stable verification keeps cache/path/mtime across series and invalidates an older gate tree; legacy numbered trees still read and remove', T, async () => {
  const run = unitRun([{ id: 'cache', argv: ['true'] }]);
  const stable = verificationWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1, 1);
  const old = absPath(`${stable}-1`);
  const defs = specLanes(run);
  const first = await runLaneSeries(run.ctx, parentOf(1), defs, 'spec', { path: old, checkout: { type: 'detached', at: run.base } }, specSeriesRoot(run.runDir, parentOf(1)), runtime(run.ctx), false);
  assert.equal(seriesTree(run.journal.view, parentOf(1), stable)?.path, old, 'upgrade read-time fallback');
  const created = presentCheckouts(run.journal.view, U1).find((c) => c.expect.path === old)!;
  await removeCheckout(run.ctx, created, parentOf(2), []);
  assert.equal(existsSync(old), false, 'legacy path removed by existing journaled lifecycle');
  const checkout = { path: stable, checkout: { type: 'detached', at: run.base } } as const;
  await runLaneSeries(run.ctx, parentOf(2), defs, 'spec', checkout, specSeriesRoot(run.runDir, parentOf(2)), runtime(run.ctx), false);
  const file = join(stable, 'src/add.js');
  const mtime = statSync(file).mtimeMs;
  writeFiles(stable, { 'out/cache.log': 'cache' });
  writeFileSync(join(stable, 'scratch.tmp'), 'untracked');
  const moved = commit(run, { 'src/new-commit.js': 'export const changed = true;\n' });
  const third = await runLaneSeries(run.ctx, parentOf(3), defs, 'spec', { ...checkout, checkout: { type: 'detached', at: moved } }, specSeriesRoot(run.runDir, parentOf(3)), runtime(run.ctx), false);
  assert.equal(third.tree?.path, stable);
  assert.equal(statSync(file).mtimeMs, mtime);
  assert.equal(readFileSync(join(stable, 'out/cache.log'), 'utf8'), 'cache');
  assert.equal(existsSync(join(stable, 'scratch.tmp')), false);
  assert.equal(seriesTree(run.journal.view, parentOf(2), stable), null, 'a reset prevents stale gate checkout binding');
  assert.equal(presentCheckouts(run.journal.view, U1).filter((c) => c.expect.path === stable).length, 1, 'retirement removes the latest create once');
  assert.ok(first.tree !== null);
  const events = readJournal(run.runDir, run.ctx.plan().arc).events;
  assert.equal(certification(run.ctx, run.unit, events, workRuns(run.ctx, events), 3).lanes[0]!.state, 'green', 'status reads this attempt at its commit, not the first create at the stable path');
});


test('deterministic patterns apply to job-owned journey suites without treating them as unit repeats', T, async () => {
  const run = unitRun([{ id: 'compile', argv: ['sh', '-c', 'echo "compile error: missing symbol"; exit 1'] }]);
  const lane = suiteJourneyLane({ ...specLanes(run)[0]!, noRerunPatterns: ['compile error:'] });
  const arbiter = createArbiter(run.ctx);
  const result = await runJourneySeries(run.ctx, { type: 'job', job: jobId('audit', 1), acquireFirst: arbiter.acquireFirst }, [lane], {
    path: absPath(join(tmpDir('deterministic-journey'), 'checkout')), checkout: { type: 'detached', at: run.base },
  }, { reuse: false, stop: () => true });
  assert.equal(result.end.kind, 'ran');
  assert.equal(result.runs[0]!.verdict, 'fail');
  assert.equal(result.runs[0]!.flaky, false);
  assert.equal(run.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length, 1);
  assert.deepEqual(readRedClass(result.runs[0]!.dir!)?.class, { kind: 'no-rerun', reason: 'deterministic' });
});

test('deterministic output patterns leave timeout reruns available', T, async () => {
  const run = unitRun([{ id: 'slow', argv: ['sh', '-c', 'echo "compile error: transient setup"; sleep 5'], timeoutMin: 0.002 }]);
  const defs = specLanes(run).map((l) => ({ ...l, noRerunPatterns: ['compile error:'] }));
  const result = await series(run, 1, defs, run.base);
  assert.equal(result.end.kind, 'red');
  assert.equal(result.ledger[0]!.verdict, 'timeout');
  assert.equal(laneSpawns(run, 'slow', 1).length, 2, 'timeouts remain diagnostic even with a matching deterministic pattern');
  assert.equal(readRedClass(result.ledger[0]!.evidenceDir)?.class.kind, 'diagnostic');
});


test('a queued series cannot reset a stable checkout while an earlier permission park has an open intent', T, async () => {
  const run = unitRun([{ id: 'check', argv: ['true'] }]);
  const path = verificationWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1);
  const checkout = { path, checkout: { type: 'detached', at: run.base } } as const;
  await runLaneSeries(run.ctx, parentOf(1), specLanes(run), 'spec', checkout, specSeriesRoot(run.runDir, parentOf(1)), runtime(run.ctx), false);
  writeFiles(path, { 'out/cache': 'retained', 'pending-output': 'must survive until the older intent settles' });
  const body = await worktreeCreateOp(run.repo).prepare({ ...checkout, reset: true });
  run.journal.begin({ kind: 'worktree.create', key: opKey('worktree:old:verify'), parent: parentOf(2), deadlineAt: null, body: () => body });
  const count = run.journal.view.opsOf('worktree.create').length;
  await assert.rejects(runLaneSeries(run.ctx, parentOf(3), specLanes(run), 'spec', checkout, specSeriesRoot(run.runDir, parentOf(3)), runtime(run.ctx), false), WorktreeRecoveryError);
  assert.equal(run.journal.view.opsOf('worktree.create').length, count, 'no second reset intent competes with recovery');
  assert.equal(readFileSync(join(path, 'pending-output'), 'utf8'), 'must survive until the older intent settles');
});

test('a pending first create is parked before the stable-checkout ownership check', T, async () => {
  const run = unitRun([{ id: 'check', argv: ['true'] }]);
  const path = verificationWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1);
  const checkout = { path, checkout: { type: 'detached', at: run.base }, reset: true } as const;
  const op = worktreeCreateOp(run.repo);
  const body = await op.prepare(checkout);
  const { op: id } = run.journal.begin({ kind: 'worktree.create', key: opKey('worktree:old:verify'), parent: parentOf(1), deadlineAt: null, body: () => body });
  await op.act(run.journal.view.latestIntent(id) as IntentOf<'worktree.create'>);
  await assert.rejects(runLaneSeries(run.ctx, parentOf(2), specLanes(run), 'spec', checkout, specSeriesRoot(run.runDir, parentOf(2)), runtime(run.ctx), false), WorktreeRecoveryError);
  assert.equal(run.journal.view.opsOf('worktree.create').length, 1);
  assert.equal(run.journal.view.doneOf(id), null, 'the older intent remains available to recovery');
});
