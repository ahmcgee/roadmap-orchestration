// M2 lanes (src/pipeline/lanes.ts, src/pipeline/redlane.ts), integrated over real processes and real git: the
// red-lane protocol on real lanes, host samples, `@cpu` and pool-instance reservations with their binding, and
// cancelled waits. Named tests: lanes.flake-red-green, lanes.red-red, lanes.signature-no-evidence,
// lanes.signature-busy-rerun-pass, lanes.instance-env, lanes.pause-mid-series.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Holder } from '../src/core/events.ts';
import { arcId, planRev, resourceName, sha256, specRev, unitId } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import type { HostSample } from '../src/host/sample.ts';
import { parsePlan } from '../src/input/plan.ts';
import { type StageContext, type StageParent, pinDispatch } from '../src/pipeline/dispatch.ts';
import { type LaneRuntime, type Series, laneOrder, reserveNow, runLaneSeries, seriesLedger, specSeriesRoot } from '../src/pipeline/lanes.ts';
import { laneFixRound } from '../src/pipeline/rounds.ts';
import { lanes, loadUnitSpec } from '../src/pipeline/stages.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import type { Acquire, ResourceRequest } from '../src/schedule/types.ts';
import { tmpDir } from './helpers/repo.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { DB, type LaneJson, SCENARIO_TIMEOUT_MS, type StageRun, U1, launchOf, outcomeFacts, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const RED_GREEN = fileURLToPath(new URL('./fakes/red-green.ts', import.meta.url));
const ESTATE_FAKE = fileURLToPath(new URL('./fakes/estate.ts', import.meta.url));

const sample = (load1: number): HostSample => ({ load1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 });
const CLEAR = sample(1);
const BUSY = sample(20);

function laneRun(lanesJson: readonly LaneJson[], resources: readonly string[] = []): StageRun {
  const run = setupUnit({ steps: [], lanes: lanesJson, resources });
  pinDispatch(run.ctx, run.unit, { rev: specRev(1), sha256: sha256('1'.repeat(64)) });
  return run;
}

/** A lane that fails its first run (printing `text`) and passes every later one. */
const redGreen = (id: string, text: string): LaneJson => ({ id, argv: [process.execPath, RED_GREEN, join(tmpDir('red-green'), `${id}.marker`), text] });

const laneSpawns = (run: StageRun) => spawnIntents(run).filter((i) => i.expect.subject.purpose === 'lane');

const PARENT: StageParent = { type: 'stage', unit: U1, stage: 'lanes', attempt: 1 };

/** The unit's spec series at the base commit, run straight through `runLaneSeries` with `rt`. */
function series(run: StageRun, rt: LaneRuntime, ctx: StageContext = run.ctx): Promise<Series> {
  const checkout = { path: absPath(join(tmpDir('lanes-m2-tree'), 'tree')), checkout: { type: 'detached', at: run.base } } as const;
  return runLaneSeries(ctx, PARENT, laneOrder(loadUnitSpec(run.ctx, run.unit).spec), 'spec', checkout, specSeriesRoot(ctx.runDir, PARENT), rt, false);
}

const runtime = (ctx: StageContext, sampleHost: () => HostSample, signal: AbortSignal = new AbortController().signal, acquire: Acquire = reserveNow(ctx)): LaneRuntime => ({
  acquire, rank: () => { throw new Error('not ranked'); }, signal, sampleHost,
});

const readBack = (run: StageRun, ctx: StageContext = run.ctx) => seriesLedger(ctx, PARENT, loadUnitSpec(run.ctx, run.unit).spec.lanes, run.base, specSeriesRoot(ctx.runDir, PARENT));

test('lanes.flake-red-green: red then green on the diagnostic rerun is red, flaky, charged; both runs kept; the fix round is told', T, async () => {
  const run = laneRun([redGreen('flaky', 'expected 3, got 4')]);
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'red');
  assert.equal(done.next.kind === 'stage' && done.next.stage, 'build');
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome' && fact.outcome === 'red' && fact.chargeable, 'flaky is charged as red');
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 1);

  assert.equal(done.ledger.length, 1, 'one record per lane');
  const [record] = done.ledger;
  assert.ok(record !== undefined && record.diagnostic !== null);
  assert.equal(record.verdict, 'fail', 'the record is the failing run');
  assert.equal(record.flaky, true);
  assert.equal(record.voided, null);
  assert.equal(record.diagnostic.verdict, 'pass');
  assert.ok(record.evidenceDir.endsWith('/flaky'));
  assert.ok(record.diagnostic.evidenceDir.endsWith('/flaky.rerun'), record.diagnostic.evidenceDir);
  assert.match(readFileSync(join(record.evidenceDir, 'output', 'files', 'stderr'), 'utf8'), /expected 3, got 4/);
  assert.match(readFileSync(join(record.diagnostic.evidenceDir, 'output', 'files', 'stdout'), 'utf8'), /green/);
  for (const dir of [record.evidenceDir, record.diagnostic.evidenceDir]) assert.ok(existsSync(join(dir, 'host.json')), `${dir}/host.json`);
  assert.ok(record.host !== null && record.host.start.cpus > 0, 'the host samples read back');

  // Two runs of the lane, the same SHA, one attempt.
  const spawns = laneSpawns(run);
  assert.equal(spawns.length, 2);
  assert.ok(spawns.every((s) => s.expect.subject.purpose === 'lane' && s.expect.subject.at === run.base && s.expect.subject.lane === 'flaky'));

  // The fix round: the failing run's evidence, the passing rerun's, and the flake directive.
  assert.ok(done.fix !== null && done.fix.kind === 'fix');
  assert.deepEqual(done.fix.fix.failingEvidenceDirs, [...record.fixDirs, ...record.diagnostic.fixDirs]);
  assert.equal(done.fix.fix.directives.length, 1);
  assert.match(done.fix.fix.directives[0]!, /^Lane flaky is flaky: it failed, then passed when the executor reran it at the same commit; .*flaky\.rerun/);

  // Read back from the journal and the files: the same record.
  const spawnParent = spawns[0]!.parent;
  assert.ok(spawnParent.type === 'stage');
  const back = seriesLedger(run.ctx, spawnParent, loadUnitSpec(run.ctx, run.unit).spec.lanes, run.base, specSeriesRoot(run.runDir, spawnParent));
  assert.deepEqual(back, done.ledger);
  assert.deepEqual(laneFixRound(back, [], run.base), done.fix);
});

test('lanes.red-red: red on the diagnostic rerun too is red, not flaky; the fix round reads the first run', T, async () => {
  const run = laneRun([{ id: 'broken', argv: ['sh', '-c', 'echo "not ok 1 - add" >&2; exit 1'] }]);
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'red');
  const [record] = done.ledger;
  assert.ok(record !== undefined && record.diagnostic !== null);
  assert.equal(done.ledger.length, 1);
  assert.deepEqual([record.verdict, record.diagnostic.verdict, record.flaky], ['fail', 'fail', false]);
  assert.ok(record.diagnostic.evidenceDir.endsWith('/broken.rerun'));
  assert.equal(laneSpawns(run).length, 2);
  assert.ok(done.fix !== null && done.fix.kind === 'fix');
  assert.deepEqual(done.fix.fix.failingEvidenceDirs, record.fixDirs, 'the failing evidence is the first run\'s');
  assert.deepEqual(done.fix.fix.directives, []);
  const spawnParent = laneSpawns(run)[0]!.parent;
  assert.ok(spawnParent.type === 'stage');
  assert.deepEqual(seriesLedger(run.ctx, spawnParent, loadUnitSpec(run.ctx, run.unit).spec.lanes, run.base, specSeriesRoot(run.runDir, spawnParent)), done.ledger);
});

test('lanes.signature-no-evidence: a host signature on a host its samples show clear is blocked, not rerun and not red', T, async () => {
  const run = laneRun([{ id: 'forky', argv: ['sh', '-c', 'echo "sh: fork: Resource temporarily unavailable" >&2; exit 1'] }, { id: 'after', argv: ['true'] }]);
  const done = await series(run, runtime(run.ctx, () => CLEAR));
  assert.equal(done.end.kind, 'blocked');
  assert.ok(done.end.kind === 'blocked');
  assert.match(done.end.detail, /host signature eagain, but the host samples do not show a busy host/);
  assert.equal(done.end.lane?.lane, 'forky');
  assert.deepEqual(done.ledger.map((l) => [l.lane, l.verdict, l.signatures, l.diagnostic, l.voided]), [['forky', 'fail', ['eagain'], null, null]]);
  assert.equal(laneSpawns(run).length, 1, 'no rerun, and the series stopped');
  assert.ok(!existsSync(join(specSeriesRoot(run.runDir, PARENT), 'forky.rerun')));
  assert.deepEqual(readBack(run), done.ledger);
});

test('lanes.signature-busy-rerun-pass: a host signature on a busy host waits for a clear host, then passes on the same-SHA rerun', T, async () => {
  const run = laneRun([redGreen('lint', 'level=error msg="Running error: parallel golangci-lint is running"'), { id: 'after', argv: ['true'] }]);
  // Busy at the first run's start and end, busy once more in the wait, then clear.
  const samples = [BUSY, BUSY, BUSY];
  let sampled = 0;
  const done = await series(run, runtime(run.ctx, () => {
    sampled += 1;
    return samples.shift() ?? CLEAR;
  }));
  assert.equal(done.end.kind, 'green');
  assert.deepEqual(done.ledger.map((l) => [l.lane, l.verdict]), [['lint', 'pass'], ['after', 'pass']]);
  const [lint] = done.ledger;
  assert.ok(lint !== undefined && lint.voided !== null);
  assert.equal(lint.voided.verdict, 'fail');
  assert.deepEqual(lint.voided.signatures, ['golangci-lint-lock']);
  assert.deepEqual(lint.voided.host, { start: BUSY, end: BUSY }, 'the busy samples are the evidence, recorded in host.json');
  assert.ok(lint.evidenceDir.endsWith('/lint.rerun'), 'the record is the rerun');
  assert.equal(lint.flaky, false);
  assert.equal(sampled, 3 + 1 + 2 + 2, 'two samples per run, and the wait sampled until clear');
  const spawns = laneSpawns(run);
  assert.deepEqual(spawns.map((s) => s.expect.subject.purpose === 'lane' && [s.expect.subject.lane, s.expect.subject.at]), [['lint', run.base], ['lint', run.base], ['after', run.base]]);
  assert.deepEqual(readBack(run), done.ledger);
});

test('lanes.instance-env: a DAG arc\'s lanes reserve @cpu tokens and a pool instance, and the lane env binds the instance', T, async () => {
  const run = laneRun([
    { id: 'fast1', argv: ['sh', '-c', 'echo "instance=${RESOURCE_INSTANCE_ESTATE:-none}"'] },
    { id: 'estate1', tier: 'estate', resources: ['estate'], argv: [process.execPath, ESTATE_FAKE, 'hold', 'STATE', 'estate'] },
  ], []);
  // A DAG arc over the same repo: a fresh log whose rev-1 plan-applied has scheduling dag, and a plan with
  // capacity and an estate pool (test/fakes/estate.ts).
  const stateDir = join(tmpDir('lanes-m2-estate'), 'state');
  mkdirSync(stateDir, { recursive: true });
  const estate = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, ESTATE_FAKE, cmd, stateDir, 'estate'], cwd: '.', env: { set: {}, pass: ['PATH'] } });
  const raw = JSON.parse(readFileSync(join(run.planDir, 'plan.json'), 'utf8')) as Record<string, unknown> & { resources: unknown[] };
  const plan = parsePlan({ ...raw, capacity: { cpu: 8 }, resources: [...raw.resources, { name: 'estate', pool: { size: 2 }, probe: estate('probe'), teardown: estate('teardown') }] });
  const runDir = absPath(tmpDir('lanes-m2-run'));
  const journal = openJournal(runDir, arcId(plan.arc));
  journal.fact({ kind: 'plan-applied', rev: planRev(1), command: null, planSha256: sha256('2'.repeat(64)), specs: { [U1]: sha256('3'.repeat(64)) }, changes: [], scheduling: 'dag' });
  const ctx: StageContext = { ...run.ctx, journal, runDir, plan: () => plan };
  // The estate lane's argv names the state dir the pool's probe and teardown use.
  const spec = loadUnitSpec(run.ctx, run.unit).spec;
  const specLanes = laneOrder(spec).map((l) => (l.id === 'estate1' ? { ...l, argv: l.argv.map((a) => (a === 'STATE' ? stateDir : a)) } : l));
  const checkout = { path: absPath(join(tmpDir('lanes-m2-tree'), 'tree')), checkout: { type: 'detached', at: run.base } } as const;
  const done = await runLaneSeries(ctx, PARENT, specLanes, 'spec', checkout, specSeriesRoot(runDir, PARENT), runtime(ctx, () => CLEAR), false);
  try {
    assert.equal(done.end.kind, 'green', JSON.stringify(done.end));
    const spawns = journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'lane');
    const envs = spawns.map((s) => launchOf({ ...run, runDir }, s).env);
    assert.deepEqual(envs[0], { PATH: run.ctx.hostEnv['PATH'], RESOURCE_OWNER: `${plan.arc}/${U1}` }, 'a lane without a pool instance binds none');
    assert.equal(envs[1]?.['RESOURCE_INSTANCE_ESTATE'], '1');
    assert.match(readFileSync(join(done.ledger[0]!.evidenceDir, 'output', 'files', 'stdout'), 'utf8'), /instance=none/);
    // Reservations: the fast lane's 2 tokens, then the estate lane's instance and 4 tokens, each all at once.
    const reserved = journal.view.opsOf('resource.transition').filter((i) => i.expect.edge.type === 'reserve').map((i) => i.expect.resources);
    assert.deepEqual(reserved, [['@cpu#1', '@cpu#2'], ['estate#1', '@cpu#1', '@cpu#2', '@cpu#3', '@cpu#4']]);
    // The pool's probe and teardown ran with the same binding, and the instance had one owner.
    assert.deepEqual(readFileSync(join(stateDir, 'calls.log'), 'utf8').trim().split('\n'), [
      `probe estate#1 ${plan.arc}/${U1}`, `hold estate#1 ${plan.arc}/${U1}`, `teardown estate#1 ${plan.arc}/${U1}`,
    ]);
    for (const [unit, entry] of resourceTable(journal.view)) assert.equal(entry.status.state, 'free', `${unit} is released`);
    for (const l of done.ledger) assert.ok(l.host !== null, `${l.lane}: host samples`);
  } finally {
    journal.close();
  }
});

test('lanes.pause-mid-series: a pause while a later lane waits for its reservation, or while a red lane waits for a clear host, ends the series interrupted holding nothing', T, async () => {
  // A later lane's reservation: the wait is cancelled, nothing of it was journaled, the first lane is kept.
  const run = laneRun([{ id: 'first', argv: ['true'] }, { id: 'second', argv: ['true'], resources: [DB] }], [DB]);
  const controller = new AbortController();
  const now = reserveNow(run.ctx);
  const waits: ResourceRequest[] = [];
  const acquire: Acquire = (request, holder: Holder, rank, signal) => {
    if (!request.named.includes(resourceName(DB))) return now(request, holder, rank, signal);
    waits.push(request);
    // The arbiter would hold it; the stage is paused meanwhile.
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
      setImmediate(() => controller.abort('pause'));
    });
  };
  const paused = await series(run, runtime(run.ctx, () => CLEAR, controller.signal, acquire));
  assert.deepEqual(paused.end, { kind: 'interrupted', reason: 'pause' });
  assert.deepEqual(paused.ledger.map((l) => [l.lane, l.verdict]), [['first', 'pass']]);
  assert.equal(waits.length, 1);
  assert.deepEqual(intents(run.runDir, 'resource.transition'), [], 'the legacy arc\'s first lane reserves nothing, the second\'s wait journaled nothing');
  assert.equal(laneSpawns(run).length, 1);

  // A red lane's wait for a clear host: cancelled by a stop, no rerun, nothing held.
  const busy = laneRun([{ id: 'forky', argv: ['sh', '-c', 'echo "Error: spawn EAGAIN" >&2; exit 1'] }]);
  const stopper = new AbortController();
  let sampled = 0;
  const stopped = await series(busy, runtime(busy.ctx, () => {
    sampled += 1;
    // The two samples of the run are busy; the stop comes while the wait holds nothing.
    if (sampled === 3) setImmediate(() => stopper.abort('stop'));
    return BUSY;
  }, stopper.signal));
  assert.deepEqual(stopped.end, { kind: 'interrupted', reason: 'stop' });
  assert.deepEqual(stopped.ledger.map((l) => [l.lane, l.verdict, l.voided, l.diagnostic]), [['forky', 'fail', null, null]]);
  assert.equal(laneSpawns(busy).length, 1);
  assert.ok(sampled >= 3);
});
