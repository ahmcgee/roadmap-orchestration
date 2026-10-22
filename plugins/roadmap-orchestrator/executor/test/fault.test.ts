// 1.0.0-dev.17 fault isolation (src/schedule/fault.ts) over real arcs (real git, real processes, fake backends). A throw is
// induced from outside the executor: a lane leaves a file its evidence glob matches unreadable (mode 000), so the lane's
// evidence snapshot throws EACCES inside its op; the lane removes its marker as it does, so the next run is clean. Named
// tests: fault.unit-confined, fault.replay-after-crash, fault.slot-crashes, fault.job, fault.symlink-in-evidence-glob.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, test } from 'node:test';
import type { Fact, StageOutcomeFact } from '../src/core/events.ts';
import { unitId } from '../src/core/ids.ts';
import { readManifest } from '../src/git/evidence.ts';
import { laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { jobFaultOpen } from '../src/schedule/fault.ts';
import { baselineOwed } from '../src/schedule/scheduler.ts';
import { reached, release } from './helpers/barrier.ts';
import { writeTrigger, assertFired } from './helpers/crash.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { EXEC_TIMEOUT_MS, SMOKE_DEFAULT, journalOf, reasonOf, setupExec, startExec, until } from './fixtures/exec-common.ts';
import { haltItem, receiptOf, startScheduler, stopScheduler, submit } from './fixtures/sched-common.ts';
import { startHolistic } from './fixtures/sched-m3-common.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, MUL, U1, codexStep, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';

after(assertNoSurvivors);

const T = { timeout: SCENARIO_TIMEOUT_MS };
const WAIT_MS = 90_000;
const U2 = unitId('u2');
const UP_TO_LANES = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'];
const FROM_GATE = ['gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

/** Each step keyed to `unit`: its calls take only these, in order (independent units run at once). */
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const straight = (unit: string): readonly Step[] => of(unit, [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })]);

/** A file the fault lanes check for: armed until the lane that fires removes it. */
function armedMarker(): string {
  // A mode the kernel enforces: root reads any file, so the fault could not be induced.
  assert.notEqual(process.getuid?.(), 0, 'the fault tests induce EACCES with a mode-000 file, which binds no root user');
  const marker = join(tmpDir('fault-marker'), 'armed');
  writeFileSync(marker, '');
  return marker;
}

/** Shell that, while `marker` exists, removes it and leaves `out/locked` unreadable for the `out/**` evidence glob. */
const lockOnce = (marker: string): string => `if [ -e '${marker}' ]; then rm '${marker}'; mkdir -p out; echo x > out/locked; chmod 000 out/locked; fi`;

/** The unit's spec lane: mul's test, then the one-shot unreadable evidence file. */
const faultLane = (marker: string): LaneJson => ({
  id: 'mul', argv: ['sh', '-c', `node --test test/mul.test.js || exit 1; ${lockOnce(marker)}`], evidenceGlobs: ['out/**'],
});

const heldBy = (r: ArcRun, unit: string): readonly string[] =>
  [...resourceTable(r.journal.view)].flatMap(([name, e]) => (e.status.state !== 'free' && 'unit' in e.status.holder && e.status.holder.unit === unit ? [name] : []));
const allFree = (r: ArcRun): boolean => [...resourceTable(r.journal.view).values()].every((e) => e.status.state === 'free');
const faultOf = (facts: readonly Fact[], unit: string): StageOutcomeFact | undefined =>
  facts.find((f): f is StageOutcomeFact => f.kind === 'stage-outcome' && f.unit === unit && f.outcome === 'executor-fault');
function journalFacts(r: ArcRun): readonly Fact[] {
  return readFileSync(join(r.ctx.runDir, 'events.jsonl'), 'utf8').trim().split('\n').flatMap((l) => {
    const e = JSON.parse(l) as { type: string; fact?: Fact };
    return e.type === 'fact' && e.fact !== undefined ? [e.fact] : [];
  });
}

test('fault.unit-confined: a throw inside u1\'s lanes parks it executor-fault (uncharged, its stack on a non-blocking item, nothing left open or held) while u2 merges; resume u1 re-enters lanes', T, async () => {
  const marker = armedMarker();
  // u2's commit message is its own: u1's build commits the same files on the same base, so commits within one second
  // would be the same commit, u1's merge would carry u2's branch and u2's gate would park `empty-diff`.
  const u2Build = codexStep([{ type: 'commit', message: 'add mul (u2)', files: MUL },{ type: 'barrier', name: 'u2build', timeoutMs: 120_000 }], { argv: ['exec', '-C'] });
  const d = setupArc({
    units: [{ id: 'u1', lanes: [faultLane(marker)] }, { id: 'u2' }],
    steps: [...straight('u1'), ...of('u2', [planCheckStep({ decision: 'approve' }), u2Build, gateStep({ decision: 'approve' })])],
  });
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    await reached(d.scenarioDir, 'u2build', WAIT_MS);
    const item = await haltItem(r, U1, WAIT_MS);
    assert.equal(existsSync(marker), false, 'the lane fired');
    assert.deepEqual(outcomes(d, 'u1'), [...UP_TO_LANES, 'lanes:executor-fault']);
    const u = r.journal.view.unit(U1);
    assert.deepEqual(u.park?.park, { class: 'operator', kind: 'env' });
    assert.equal(u.counters.chargeableFailures, 0, 'uncharged');
    const fault = faultOf(journalFacts(r), 'u1');
    assert.ok(fault?.detail?.kind === 'executor-fault' && fault.detail.stack.includes('EACCES'), JSON.stringify(fault?.detail));
    const record = readNeedsUser(r.ctx.runDir, item);
    assert.ok(record !== null);
    assert.deepEqual([record.reason, record.blocking, record.subject], ['executor-fault', false, { type: 'unit', unit: 'u1' }]);
    assert.ok(record.summary.includes('EACCES') && record.recommendation.includes('roadmap resume u1'), record.summary);
    // Settled as a dead holder's: nothing of u1 open, every reservation free; the faulted snapshot closed `fault`.
    assert.deepEqual(r.journal.view.openIntents().filter((i) => i.parent.type === 'stage' && i.parent.unit === 'u1'), []);
    assert.deepEqual(heldBy(r, 'u1'), [], 'u1 holds nothing');
    const aborts = readFileSync(join(r.ctx.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; reason?: { code: string } })
      .filter((e) => e.type === 'abort');
    assert.ok(aborts.length >= 1 && aborts.every((e) => e.reason?.code === 'fault'), JSON.stringify(aborts));

    await receiptOf(r, submit(r, { type: 'resume', target: { type: 'unit', unit: U1 } }));
    await until(() => r.journal.view.unit(U1).status === 'retired', WAIT_MS, 'u1 to merge after its resume');
    assert.deepEqual(outcomes(d, 'u1'), [...UP_TO_LANES, 'lanes:executor-fault', 'lanes:green', ...FROM_GATE], 'resume re-entered lanes, no new plan-check or build');
    release(d.scenarioDir, 'u2build');
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
  } finally {
    r.journal.close();
  }
});

test('fault.replay-after-crash: an executor killed right after the fault park restarts to the park (its item raised once, the stage not re-run), and u2 still merges', { timeout: EXEC_TIMEOUT_MS }, async (t) => {
  const marker = armedMarker();
  const r = setupExec(t, {
    units: [{ id: 'u1', lanes: [faultLane(marker)] }, { id: 'u2' }],
    steps: [...SMOKE_DEFAULT, ...SMOKE_DEFAULT, ...straight('u1'), ...straight('u2')],
  });
  const trigger = writeTrigger(tmpDir('fault-crash'), { label: 'fault.after-park', occurrence: 1, unit: 'u1' });
  const run = startExec(r, [], { ROADMAP_TEST_CRASH: trigger });
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assertFired(trigger);
  const { view, events } = journalOf(r);
  const facts = events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
  assert.deepEqual(facts.flatMap((f) => (f.kind === 'executor-started' ? [f.generation] : [])), [1, 2], 'one crash, one restart');
  assert.deepEqual(outcomes(r, 'u1'), [...UP_TO_LANES, 'lanes:executor-fault'], 'the restart replayed the park: lanes never ran again');
  const raised = view.opsOf('needsuser.raise').filter((i) => i.parent.type === 'stage' && i.parent.unit === 'u1');
  assert.equal(raised.length, 1, 'its item raised once, by the restart');
  const item = raised[0]!.expect.id;
  assert.equal(readNeedsUser(r.runDir as never, item)?.reason, 'executor-fault');
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'parked', needsUser: item }, { unit: 'u2', result: 'merged' }] });
});

test('fault.slot-crashes: a throw while the unit\'s publication holds the integration slot (a candidate lane) is no contained fault: the scheduler crashes with it', T, async () => {
  const marker = armedMarker();
  const suite: LaneJson = { id: 'suite', argv: ['sh', '-c', `node --test || exit 1; ${lockOnce(marker)}`], tier: 'estate', evidenceGlobs: ['out/**'] };
  const d = setupArc({ suite: [suite], steps: straight('u1') });
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    await assert.rejects(s.end, /EACCES/);
    assert.equal(existsSync(marker), false, 'the candidate lane fired');
    assert.equal(faultOf(journalFacts(r), 'u1'), undefined, 'no executor-fault park');
    assert.equal(outcomes(d, 'u1').at(-1), 'gate:approve', 'the candidate recorded nothing: the crash left it to recovery');
    const slot = [...resourceTable(r.journal.view).values()].find((e) => e.status.state !== 'free' && 'holder' in e.status && e.status.holder.type === 'publication');
    assert.ok(slot !== undefined, 'the publication still holds the slot, as a crash leaves it');
  } finally {
    r.journal.close();
  }
});

test('fault.job: a throw inside the baseline job ends it faulted (a non-blocking item, its own state settled, the executor still running); it is due again only once the item is acknowledged', T, async () => {
  const marker = armedMarker();
  const { d } = holisticArc({
    steps: of('u1', [{ ...planCheckStep({ decision: 'approve' }), acts: [{ type: 'barrier', name: 'u1check', timeoutMs: 120_000 }] } as Step]),
    obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [], trees: { '*': { outcomes: { t1: 'pass' } } },
    beforeStart: (x) => {
      // The journey lane, wrapped to lock its evidence once; its proof judgment re-pinned to the wrapped lane's revision.
      const path = join(x.planPath, '..', 'obligations.json');
      const o = JSON.parse(readFileSync(path, 'utf8')) as { lanes: Record<string, unknown>[]; obligations: { proofJudgment: { laneRev: string } | null }[] };
      const lane = o.lanes[0]!;
      o.lanes[0] = { ...lane, argv: ['sh', '-c', `${lockOnce(marker)}; exec "$@"`, 'sh', ...(lane['argv'] as string[])], evidenceGlobs: ['out/**'] };
      const rev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: o.lanes, obligations: [], mapping: { paths: [] } }).lanes[0]!);
      for (const ob of o.obligations) if (ob.proofJudgment !== null) ob.proofJudgment.laneRev = rev;
      writeFileSync(path, JSON.stringify(o));
    },
  });
  const r = contextFor(d);
  const journeys = (): number => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length;
  try {
    const s = startHolistic(r);
    await until(() => jobFaultOpen(r.journal.view, r.ctx.runDir), WAIT_MS, 'the baseline job to fault');
    assert.equal(existsSync(marker), false, 'the journey lane fired');
    const raise = r.journal.view.opsOf('needsuser.raise').find((i) => i.parent.type === 'arc')!;
    const record = readNeedsUser(r.ctx.runDir, raise.expect.id);
    assert.deepEqual([record?.reason, record?.blocking], ['executor-fault', false]);
    assert.ok(record?.summary.includes('baseline') && record.summary.includes('EACCES'), record?.summary);
    assert.deepEqual(r.journal.view.openIntents().filter((i) => i.parent.type === 'job'), [], 'nothing of the job left open');
    assert.ok(allFree(r), 'the job\'s reservations cleaned');
    assert.equal(journeys(), 1);
    await sleep(3_000);
    assert.equal(journeys(), 1, 'the faulted job is not asked again while its item is open');
    assert.notEqual(baselineOwed(s.stage), null, 'the baseline is still owed');

    await receiptOf(r, submit(r, { type: 'ack', needsUser: raise.expect.id, choice: null }));
    await until(() => baselineOwed(s.stage) === null, WAIT_MS, 'the baseline to run again and hold');
    assert.equal(journeys(), 2);
    await reached(d.scenarioDir, 'u1check', WAIT_MS);
    assert.equal((await stopScheduler(r, s)).kind, 'stop', 'the executor ran on through the fault');
  } finally {
    r.journal.close();
  }
});

test('fault.symlink-in-evidence-glob: a symlink a lane leaves under its declared evidence glob is named on the snapshot (notRegular), not captured, and the unit merges', T, async () => {
  const lane: LaneJson = { id: 'mul', argv: ['sh', '-c', 'node --test test/mul.test.js || exit 1; mkdir -p out; echo x > out/real; ln -s real out/link'], evidenceGlobs: ['out/**'] };
  const d = setupArc({ units: [{ id: 'u1', lanes: [lane] }], steps: straight('u1') });
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
    // The lane's own tree snapshots, of its verification checkout; the build's evidence stage snapshots the unit worktree,
    // where the lane never ran.
    const trees = r.journal.view.opsOf('evidence.snapshot').filter((i) => i.expect.source.includes('.verify-'));
    assert.ok(trees.length >= 1);
    for (const snap of trees) {
      assert.deepEqual(snap.expect.notRegular, ['out/link']);
      assert.deepEqual(readManifest(snap.expect.dest)?.files.map((f) => f.path), ['out/real']);
    }
  } finally {
    r.journal.close();
  }
});
