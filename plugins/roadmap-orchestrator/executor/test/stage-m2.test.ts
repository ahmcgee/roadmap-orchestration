// M2 step 7a: the stage functions on the M2 primitives, integrated over real processes and real git. Entry
// reservations before a stage's first journaled op and cancelled waits that journal nothing (A1, F6), durable
// judgment inputs and a recovered gate read against them (F1), the publication holder from candidate to
// snapshot (A2, F3), park outcomes with their targets (A7, G6) and the D4 escalation through the build stage
// (A11, G1). Named tests: stage.entry-before-first-op, stage.cancel-wait-journals-nothing, gate.judgment-inputs,
// gate.recovered-recorded-tip, publication.ownership (live, pause before and after green, a crash at each
// boundary), park.salvage-and-teardown-fail-restart, rounds.d4-through-driver; also stage.repeat-park.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it, test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type { Event, Fact, IntentOf, Parent, StageOutcomeFact } from '../src/core/events.ts';
import { INTEGRATION_SLOT, type ResourceUnit, arcId, cpuToken, resourceName, sha, unitId } from '../src/core/ids.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { createProber } from '../src/park/probe.ts';
import { backendEnv } from '../src/preflight/smoke.ts';
import { type StageContext, type StageParent, isCancelled, unitBranch } from '../src/pipeline/dispatch.ts';
import { consumeJudgment, fingerprintAt, gate } from '../src/pipeline/gate.ts';
import { candidate, ff, snapshot } from '../src/pipeline/integrate.ts';
import { reserveNow } from '../src/pipeline/lanes.ts';
import { NO_SESSION_NOTE } from '../src/pipeline/rounds.ts';
import {
  type BuildRun, type LanesDone, at, build, evidence, lanes, planCheck, quiesce, record, recordedCall, salvage, start, teardown,
} from '../src/pipeline/stages.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { DOCS_NOT_YET } from '../src/recover/revision.ts';
import { cpuCapacity } from '../src/resources/pool.ts';
import { cleanup, heldReservation, reserve, resourceTable } from '../src/resources/reserve.ts';
import { createArbiter } from '../src/schedule/arbiter.ts';
import type { Acquire } from '../src/schedule/types.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type CodexAct, type Expect, type Step, readCalls } from './helpers/scenario.ts';
import { release } from './helpers/barrier.ts';
import { BARRIER, recoveryContext, strandedCall } from './fixtures/rec-common.ts';
import {
  admitAll, testProbes,
  BUILD_REPORT, DB, SCENARIO_TIMEOUT_MS, type StageRun, U1, launchOf, planCheckStep, serialRuntime, setupUnit, spawnIntents, started, worktreeOf,
} from './fixtures/stage-common.ts';
import { type ArcDescriptor, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';
import { CLEAR } from './fixtures/probe-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = (): AbortSignal => new AbortController().signal;
const STRAIGHT: readonly Step[] = [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];
/** Every arc here but the stranded gate's is started on M2 (`scheduling: 'dag'`): its stages take `@cpu`. */
const DAG = true as const;
const ADMISSION = ['plan-check', 'build', 'lanes', 'gate', 'candidate'] as const;

const eventsOf = (d: ArcDescriptor): readonly Event[] => readJournal(absPath(d.runDir), arcId(d.arc)).events;
const runEvents = (run: StageRun): readonly Event[] => readJournal(run.runDir, run.journal.view.arc).events;
const ofAttempt = (p: Parent, f: Readonly<{ unit: string; stage: string; attempt: number }>): boolean =>
  p.type === 'stage' && p.unit === f.unit && p.stage === f.stage && p.attempt === f.attempt;
const outcomeOf = (e: Event): StageOutcomeFact | null => (e.type === 'fact' && e.fact.kind === 'stage-outcome' ? e.fact : null);
const transitions = (events: readonly Event[]): readonly (Event & IntentOf<'resource.transition'>)[] =>
  events.filter((e): e is Event & IntentOf<'resource.transition'> => e.type === 'intent' && e.kind === 'resource.transition');
const slotStatus = (ctx: StageContext) => resourceTable(ctx.journal.view).get(INTEGRATION_SLOT)?.status ?? { state: 'free' };
const tokens = (n: number): readonly ResourceUnit[] => Array.from({ length: n }, (_, i) => cpuToken(i + 1));
const codexBuild = (acts: readonly CodexAct[], expect: Expect = {}): Step => ({ as: 'codex', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] });
const ADD_FIX = { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' } as const;

/** build → quiesce → evidence → salvage → teardown at stage level; returns the salvage SHA. */
async function buildToLanes(run: StageRun, input: Parameters<typeof build>[2]): Promise<LanesDone['at']> {
  const b = started(await build(run.ctx, run.unit, input));
  assert.ok(b.run !== null, `build ${b.outcome.kind}`);
  quiesce(run.ctx, U1, b.run);
  await evidence(run.ctx, run.unit, b.run);
  const s = await salvage(run.ctx, run.unit, b.run);
  assert.ok(s.sha !== null, `salvage ${s.outcome.kind}`);
  await teardown(run.ctx, U1, b.run);
  return s.sha;
}

// ---------------------------------------------------------------------------------------------------
// Entry reservations and judgment inputs

test('stage.entry-before-first-op: every admitted stage\'s first journaled op is its entry reservation, released by its stage (a build\'s by teardown)', T, async () => {
  const d = setupArc({ steps: STRAIGHT, dag: DAG });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.ok([...resourceTable(r.journal.view).values()].every((e) => e.status.state === 'free'), 'nothing held once merged');
  } finally {
    r.journal.close();
  }
  const events = eventsOf(d);
  const expected: Readonly<Record<(typeof ADMISSION)[number], readonly ResourceUnit[]>> = {
    'plan-check': tokens(1), build: tokens(4), lanes: tokens(2), gate: tokens(1), candidate: [INTEGRATION_SLOT],
  };
  for (const stage of ADMISSION) {
    const f = events.map(outcomeOf).find((o) => o !== null && o.stage === stage);
    assert.ok(f !== undefined && f !== null, `${stage} recorded an outcome`);
    const ops = events.filter((e) => e.type === 'intent' && ofAttempt(e.parent, f));
    const first = ops[0];
    assert.ok(first !== undefined && first.type === 'intent' && first.kind === 'resource.transition', `${stage}: its first op is a resource transition`);
    assert.equal(first.expect.edge.type, 'reserve', `${stage}: the first op reserves`);
    assert.deepEqual(first.expect.holder, stage === 'candidate'
      ? { type: 'publication', unit: U1, attempt: f.attempt }
      : { type: 'stage', unit: U1, stage, attempt: f.attempt });
    assert.deepEqual(first.expect.resources, expected[stage], `${stage}'s entry reservation`);
    // Nothing the attempt wrote (a dispatch pin, its inputs, an escalation) comes before its reservation: no
    // fact since the previous outcome (or, for the first stage, since the plan revision).
    const since = events.findLast((x) => x.seq < first.seq && (outcomeOf(x) !== null || (x.type === 'fact' && x.fact.kind === 'plan-applied')))?.seq ?? 0;
    const facts = events.filter((e) => e.type === 'fact' && e.seq > since && e.seq < first.seq);
    assert.deepEqual(facts.map((e) => e.type === 'fact' && e.fact.kind), [], `${stage}: no fact between the previous outcome and the reservation`);
  }
  // The build's reservation is held through its chain and released by teardown.
  const buildHolder = transitions(events).find((t) => t.expect.holder.type === 'stage' && t.expect.holder.stage === 'build')!.expect.holder;
  const released = transitions(events).filter((t) => JSON.stringify(t.expect.holder) === JSON.stringify(buildHolder) && t.expect.edge.type === 'release');
  assert.equal(released.length, 1);
  assert.ok(released[0]!.parent.type === 'stage' && released[0]!.parent.stage === 'teardown', 'released under teardown');
});

test('gate.judgment-inputs: plan-check and gate write their inputs after the entry reservation and before the spawn', T, async () => {
  const d = setupArc({ steps: STRAIGHT, dag: DAG });
  const base = git(d.repo, 'rev-parse', 'main');
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    const events = eventsOf(d);
    const inputs = events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'judgment-inputs' ? [e] : []));
    assert.deepEqual(inputs.map((e) => e.type === 'fact' && e.fact.kind === 'judgment-inputs' && e.fact.stage), ['plan-check', 'gate']);
    const planRevNow = r.journal.view.planApplied()!.rev;
    for (const e of inputs) {
      assert.ok(e.type === 'fact' && e.fact.kind === 'judgment-inputs');
      const f = e.fact;
      assert.equal(f.tip, base, `${f.stage}: the integration tip it read`);
      assert.equal(f.head, f.stage === 'gate' ? git(d.repo, 'rev-parse', unitBranch(r.ctx.plan().arc, U1)) : null);
      assert.equal(f.specRev, 1);
      assert.equal(f.planRev, planRevNow);
      assert.equal(f.routingRev, r.ctx.routing(null).rev);
      assert.deepEqual(r.journal.view.judgmentInputs(U1, f.stage, f.attempt), { unit: f.unit, stage: f.stage, attempt: f.attempt, tip: f.tip, head: f.head, specRev: f.specRev, specSha256: f.specSha256, planRev: f.planRev, routingRev: f.routingRev });
      const ops = events.filter((x) => x.type === 'intent' && ofAttempt(x.parent, f));
      const reserve = ops.find((x) => x.type === 'intent' && x.kind === 'resource.transition' && x.expect.edge.type === 'reserve')!;
      const spawn = ops.find((x) => x.type === 'intent' && x.kind === 'proc.spawn')!;
      assert.ok(reserve.seq < e.seq && e.seq < spawn.seq, `${f.stage}: reserve ${reserve.seq} < inputs ${e.seq} < spawn ${spawn.seq}`);
    }
  } finally {
    r.journal.close();
  }
});

test('gate.recovered-recorded-tip: A\'s gate runs, B publishes a contract change, the executor crashes; A\'s approval is read at T_A and ff finds it fingerprint-invalid', T, async () => {
  // A's driver is killed while its gate call is in flight (the runner lives on).
  const d = await strandedCall('gate');
  const tipA = git(d.repo, 'rev-parse', 'main');
  // B's publication: integration moves on with a change to a contract A cites.
  writeFileSync(join(d.repo, 'contracts', 'api.md'), `${readFileSync(join(d.repo, 'contracts', 'api.md'), 'utf8')}\nB changed the contract.\n`);
  git(d.repo, 'commit', '--quiet', '-am', 'B publishes a contract change');
  const tipB = git(d.repo, 'rev-parse', 'main');
  release(d.scenarioDir, BARRIER);
  const r = contextFor(d);
  try {
    await recover(recoveryContext(r));
    const u1 = r.unit('u1');
    const open = r.journal.view.unit(U1).open;
    assert.ok(open !== null && open.stage === 'gate', 'the gate attempt is open, its call recovered');
    const parent: StageParent = { type: 'stage', unit: U1, stage: 'gate', attempt: open.attempt };
    const called = recordedCall(r.ctx, parent);
    assert.ok(called !== null && called.kind === 'result');
    const inputs = r.journal.view.judgmentInputs(U1, 'gate', open.attempt);
    assert.equal(inputs?.tip, tipA, 'the recorded tip is T_A');

    const done = await consumeJudgment(r.ctx, u1, parent, called);
    assert.equal(done.outcome.kind, 'approve');
    const approval = r.journal.view.unit(U1).approval;
    assert.ok(approval !== null);
    assert.deepEqual(approval.fingerprint, fingerprintAt(r.ctx, u1, sha(tipA)), 'the approval binds what the gate reviewed at T_A');
    assert.notDeepEqual(approval.fingerprint, fingerprintAt(r.ctx, u1, sha(tipB)), 'a read at the current tip would have bound T_B');

    const cand = started(await candidate(r.ctx, u1));
    assert.equal(cand.outcome.kind, 'green');
    const published = await ff(r.ctx, u1);
    assert.equal(published.outcome.kind, 'fingerprint-invalid', 'the contract B changed invalidates the approval before publication');
    assert.ok(published.next.kind === 'stage' && published.next.stage === 'gate', 're-gate');
    assert.deepEqual(slotStatus(r.ctx), { state: 'free' }, 'the publication ends with the invalid approval');
    assert.equal(git(d.repo, 'rev-parse', 'main'), tipB, 'nothing was published');
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Cancelled waits

/** A context whose acquire is a real arbiter over `run`, with a hog holding every `@cpu` token, and its pause. */
function blocked(run: StageRun): Readonly<{ ctx: StageContext; pause: AbortController; waiting: () => number; unblock: () => Promise<void> }> {
  const hog = { type: 'stage', unit: unitId('hog'), stage: 'build', attempt: 1 } as const;
  const got = reserve(run.ctx, hog, { named: [], pools: [], cpu: cpuCapacity(run.ctx.plan()), publication: false }, { type: 'arc' });
  assert.equal(got.state, 'reserved');
  const arbiter = createArbiter(run.ctx);
  const pause = new AbortController();
  return {
    ctx: { ...run.ctx, acquire: arbiter.acquire, signal: pause.signal },
    pause,
    waiting: () => arbiter.waiting().length,
    unblock: async () => {
      assert.equal((await cleanup(run.ctx, heldReservation(run.ctx, hog, 'reserved'), { type: 'arc' })).kind, 'released');
    },
  };
}

/** Pauses a stage waiting for its entry reservation; asserts the wait ended cancelled and journaled nothing. */
async function cancelWhileWaiting(run: StageRun, going: (ctx: StageContext) => Promise<unknown>): Promise<void> {
  const b = blocked(run);
  const high = run.journal.view.highWater();
  const unit = run.journal.view.unit(U1);
  const calls = readCalls(run.scenario.path).length;
  const waiting = going(b.ctx);
  for (let i = 0; i < 100 && b.waiting() === 0; i++) await tick();
  assert.equal(b.waiting(), 1, 'the stage waits for its entry reservation');
  b.pause.abort('pause');
  const done = await waiting;
  assert.ok(typeof done === 'object' && done !== null && isCancelled(done), 'the stage returns cancelled');
  assert.deepEqual(done, { kind: 'cancelled', reason: 'pause' });
  assert.equal(run.journal.view.highWater(), high, 'nothing was journaled');
  assert.deepEqual(run.journal.view.unit(U1), unit, 'no attempt, no counter, no interrupted');
  assert.equal(readCalls(run.scenario.path).length, calls, 'no backend call');
  await b.unblock();
}

test('stage.cancel-wait-journals-nothing: a first build paused while waiting for its reservation never started; resumed, it runs fresh', T, async () => {
  const run = setupUnit({ steps: [planCheckStep({ decision: 'approve' }), codexBuild([{ type: 'commit', message: 'fix add', files: ADD_FIX }], { argv: ['exec', '-C'] })], dag: DAG });
  started(await planCheck(run.ctx, run.unit));
  const attempts = run.journal.view.unit(U1).counters.attempts;
  await cancelWhileWaiting(run, (ctx) => build(ctx, run.unit, { kind: 'fresh' }));
  // Resumed: the driver runs the decided fresh build, as the next attempt.
  const s = await step(run.ctx, run.unit);
  assert.equal(s.kind, 'continue');
  const decided = run.journal.view.unit(U1).decided;
  assert.ok(decided !== null && decided.stage === 'build' && decided.outcome === 'success' && decided.attempt === attempts + 1);
  assert.ok(readCalls(run.scenario.path).every((c) => c.step !== null));
});

test('stage.cancel-wait-journals-nothing: a fix round paused while waiting for its reservation never started; resumed, it is the fix round again, never a continue', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([], { argv: ['exec', '-C'] }),
      codexBuild([{ type: 'commit', message: 'fix add', files: ADD_FIX }], { argv: ['exec', 'resume'] }),
    ],
    dag: DAG,
  });
  started(await planCheck(run.ctx, run.unit));
  const red = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.equal(red.outcome.kind, 'red');
  assert.ok(red.fix !== null);
  const fix = red.fix;
  await cancelWhileWaiting(run, (ctx) => build(ctx, run.unit, fix));
  assert.equal(run.journal.view.unit(U1).interrupted, null);
  const s = await step(run.ctx, run.unit);
  assert.equal(s.kind, 'continue');
  assert.equal(run.journal.view.unit(U1).decided?.outcome, 'success');
  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.step !== null));
  assert.ok(!calls[2]!.stdin.includes('You were paused'), 'a fix round, not a continue');
  assert.ok(calls[2]!.stdin.includes(fix.kind === 'fix' ? fix.fix.failingEvidenceDirs[0]! : ''), 'with the failing evidence');
});

// ---------------------------------------------------------------------------------------------------
// The publication holder

async function readyForCandidate(): Promise<ArcDescriptor> {
  const d = setupArc({ steps: STRAIGHT, dag: DAG });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
  } finally {
    r.journal.close();
  }
  return d;
}

test('publication.ownership: the candidate\'s publication holds the slot through ff and snapshot, which assert it; released after snapshot', T, async () => {
  const d = await readyForCandidate();
  const r = contextFor(d);
  try {
    const u1 = r.unit('u1');
    await assert.rejects(ff(r.ctx, u1), /not running under the unit's publication/, 'ff publishes only under the unit\'s publication');
    const c = started(await candidate(r.ctx, u1));
    assert.equal(c.outcome.kind, 'green');
    const holder = { type: 'publication', unit: U1, attempt: c.attempt };
    assert.deepEqual(slotStatus(r.ctx), { state: 'running', holder });
    assert.equal((await ff(r.ctx, u1)).outcome.kind, 'published');
    assert.deepEqual(slotStatus(r.ctx), { state: 'running', holder }, 'kept through ff');
    const s = await snapshot(r.ctx, u1);
    assert.equal(s.outcome.kind, 'published');
    assert.deepEqual(slotStatus(r.ctx), { state: 'free' }, 'released after snapshot');
    await assert.rejects(snapshot(r.ctx, u1), /not running under the unit's publication/, 'snapshot publishes only under the publication');
    const slot = transitions(eventsOf(d)).filter((t) => t.expect.resources.includes(INTEGRATION_SLOT));
    assert.deepEqual(slot.map((t) => [t.expect.holder, t.expect.edge.type, t.parent.type === 'stage' ? t.parent.stage : t.parent.type]), [
      [holder, 'reserve', 'candidate'], [holder, 'run', 'candidate'], [holder, 'clean', 'snapshot'], [holder, 'release', 'snapshot'],
    ]);
  } finally {
    r.journal.close();
  }
});

test('publication.ownership: a pause before green abandons the candidate (its suite wait cancelled) and releases the slot; resumed, it publishes', T, async () => {
  const d = await readyForCandidate();
  const r = contextFor(d);
  try {
    const u1 = r.unit('u1');
    const pause = new AbortController();
    const now = reserveNow(r.ctx);
    // The pause lands once the publication holds the slot: the suite lane's wait is the one it cancels.
    const acquire: Acquire = async (request, holder, rank, signal) => {
      const grant = await now(request, holder, rank, signal);
      if (holder.type === 'publication') pause.abort('pause');
      return grant;
    };
    const abandoned = started(await candidate({ ...r.ctx, acquire, signal: pause.signal }, u1));
    assert.equal(abandoned.outcome.kind, 'interrupted');
    assert.equal(abandoned.next.kind, 'hold');
    assert.deepEqual(slotStatus(r.ctx), { state: 'free' }, 'released before green');
    assert.equal(spawnsOf(d, abandoned.attempt, 'lane').length, 0, 'no suite lane ran');
    // Resumed.
    const c = started(await candidate(r.ctx, u1));
    assert.equal(c.outcome.kind, 'green');
    assert.equal((await ff(r.ctx, u1)).outcome.kind, 'published');
    assert.equal((await snapshot(r.ctx, u1)).outcome.kind, 'published');
    assert.deepEqual(slotStatus(r.ctx), { state: 'free' });
  } finally {
    r.journal.close();
  }
});

test('publication.ownership: after green, ff and snapshot run to their end under a pause, and the slot is released after snapshot', T, async () => {
  const d = await readyForCandidate();
  const r = contextFor(d);
  try {
    const u1 = r.unit('u1');
    const c = started(await candidate(r.ctx, u1));
    assert.equal(c.outcome.kind, 'green');
    const pause = new AbortController();
    pause.abort('pause');
    const paused: StageContext = { ...r.ctx, signal: pause.signal };
    assert.equal((await ff(paused, u1)).outcome.kind, 'published', 'a mandatory chain stage ignores the pause');
    assert.deepEqual(slotStatus(r.ctx), { state: 'running', holder: { type: 'publication', unit: U1, attempt: c.attempt } });
    assert.equal((await snapshot(paused, u1)).outcome.kind, 'published');
    assert.deepEqual(slotStatus(r.ctx), { state: 'free' });
    // An admission stage under the same pause never starts.
    const high = r.journal.view.highWater();
    assert.deepEqual(await gate(paused, u1), { kind: 'cancelled', reason: 'pause' });
    assert.equal(r.journal.view.highWater(), high);
  } finally {
    r.journal.close();
  }
});

const spawnsOf = (d: ArcDescriptor, attempt: number, purpose: 'lane' | 'backend'): readonly Event[] =>
  eventsOf(d).filter((e) => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === purpose && e.parent.type === 'stage' && e.parent.attempt === attempt);

const CHILD_TIMEOUT_MS = 120_000;
const childEnv = (d: ArcDescriptor): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${d.binDir}:${process.env['PATH'] ?? ''}` });

describe('publication.ownership: a crash at each boundary of the publication, then recovery and the driver', { timeout: 20 * 60_000 }, () => {
  // The recording run: which occurrences of resource.after-done, in a child that starts at the candidate, are
  // the publication's transitions (reserve, run under the candidate; clean, release under snapshot).
  const occurrences: { reserve: number; run: number; clean: number; release: number } = { reserve: 0, run: 0, clean: 0, release: 0 };
  before(async () => {
    const d = await readyForCandidate();
    const gated = eventsOf(d).length;
    const exit = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env: childEnv(d), timeoutMs: CHILD_TIMEOUT_MS });
    assert.equal(exit.code, 0, exit.stderr);
    const child = transitions(eventsOf(d).slice(gated));
    child.forEach((t, i) => {
      if (t.expect.holder.type === 'publication') occurrences[t.expect.edge.type as keyof typeof occurrences] = i + 1;
    });
    assert.ok(Object.values(occurrences).every((n) => n > 0), JSON.stringify(occurrences));
  });

  const cells: readonly Readonly<{ name: string; label: string; occurrence: () => number; greenFirst: boolean }>[] = [
    { name: 'after the publication reserved the slot', label: 'resource.after-done', occurrence: () => occurrences.reserve, greenFirst: false },
    { name: 'after the slot runs, before green', label: 'resource.after-done', occurrence: () => occurrences.run, greenFirst: false },
    { name: 'after green, before ff', label: 'unit.after-stage', occurrence: () => 1, greenFirst: true },
    { name: 'after ff published, before snapshot', label: 'unit.after-stage', occurrence: () => 2, greenFirst: true },
    { name: 'after snapshot, the slot cleaning', label: 'resource.after-done', occurrence: () => occurrences.clean, greenFirst: true },
    { name: 'after the slot was released', label: 'resource.after-done', occurrence: () => occurrences.release, greenFirst: true },
  ];
  for (const cell of cells) {
    it(`${cell.label}#${cell.name}: recovery keeps the slot exactly while ff or snapshot is next; one publication`, { timeout: 5 * 60_000 }, async () => {
      const d = await readyForCandidate();
      const trigger = writeTrigger(tmpDir('pub-crash'), { label: cell.label, occurrence: cell.occurrence() });
      const env = { ...childEnv(d), ROADMAP_TEST_CRASH: trigger };
      const first = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: CHILD_TIMEOUT_MS });
      assert.equal(first.signal, 'SIGKILL', `died at ${cell.label}#${cell.occurrence()}: ${first.stderr}`);
      assertFired(trigger);
      const second = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: CHILD_TIMEOUT_MS });
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });

      const events = eventsOf(d);
      const ffs = events.filter((e) => e.type === 'intent' && e.kind === 'integration.ff');
      assert.equal(ffs.length, 1, 'published once');
      const all = outcomes(d);
      assert.equal(all.filter((o) => o === 'candidate:green').length, 1, 'one green candidate');
      assert.equal(all.filter((o) => o === 'ff:published').length, 1);
      // The slot: only publications ever held it, one at a time, and the green one kept it to the end.
      const slot = transitions(events).filter((t) => t.expect.resources.includes(INTEGRATION_SLOT));
      assert.ok(slot.every((t) => t.expect.holder.type === 'publication'), 'only publications hold the slot');
      let holder: string | null = null;
      for (const t of slot) {
        const h = JSON.stringify(t.expect.holder);
        if (t.expect.edge.type === 'reserve') {
          assert.equal(holder, null, 'reserved only when free');
          holder = h;
        } else {
          assert.equal(h, holder, `${t.expect.edge.type} by the holder`);
          if (t.expect.edge.type === 'release') holder = null;
        }
      }
      assert.equal(holder, null, 'free at the end');
      const green = events.map(outcomeOf).find((o) => o !== null && o.stage === 'candidate' && o.outcome === 'green')!;
      const greenHolder = JSON.stringify({ type: 'publication', unit: U1, attempt: green.attempt });
      const afterGreen = slot.filter((t) => JSON.stringify(t.expect.holder) === greenHolder).map((t) => t.expect.edge.type);
      assert.deepEqual(afterGreen, ['reserve', 'run', 'clean', 'release'], 'the green publication kept the slot from candidate to its release');
      const reserves = slot.filter((t) => t.expect.edge.type === 'reserve').length;
      assert.equal(reserves, cell.greenFirst ? 1 : 2, cell.greenFirst ? 'nothing took the slot again' : 'the abandoned candidate was cleaned, the next one reserved');
    });
  }
});

// ---------------------------------------------------------------------------------------------------
// Parks

test('park.salvage-and-teardown-fail-restart: a failed salvage whose teardown fails parks on the host and the instance; after a restart both are probed and it re-runs', T, async () => {
  const run = setupUnit({
    steps: [planCheckStep({ decision: 'approve' }), codexBuild([{ type: 'commit', message: 'fix add', files: ADD_FIX }], { argv: ['exec', '-C'] })],
    resources: [DB],
    dag: DAG,
  });
  started(await planCheck(run.ctx, run.unit));
  const b = started(await build(run.ctx, run.unit, { kind: 'fresh' }));
  assert.ok(b.run !== null);
  assert.deepEqual(b.run.reservation?.resources, [resourceName(DB), ...tokens(4)], 'the build holds its resource and its @cpu');
  quiesce(run.ctx, U1, b.run);
  await evidence(run.ctx, run.unit, b.run);
  // The host breaks the salvage (HEAD detached), and the build's teardown fails.
  const branch = git(worktreeOf(run), 'rev-parse', '--abbrev-ref', 'HEAD');
  git(worktreeOf(run), 'checkout', '--quiet', '--detach');
  writeFileSync(join(run.stateDir, `${DB}.teardown-fails`), '');
  const s = await salvage(run.ctx, run.unit, b.run);
  assert.equal(s.outcome.kind, 'commit-failed');
  const db = resourceName(DB);
  const targets = [{ type: 'host' }, { type: 'resource', instance: db }];
  const parked = runEvents(run).map(outcomeOf).findLast((o) => o !== null)!;
  assert.deepEqual(parked.park, { class: 'retryable', targets }, 'G6: the failed instance joins the host target');
  assert.equal(resourceTable(run.journal.view).get(db)?.status.state, 'cleanup-failed');
  assert.ok(tokens(4).every((t) => (resourceTable(run.journal.view).get(t)?.status.state ?? 'free') === 'free'), 'the @cpu tokens are released');

  // A restart: the journal reopened and recovered; the park and its targets stand.
  const arc = run.journal.view.arc;
  run.journal.close();
  const journal = openJournal(run.runDir, arc);
  const resources = { ...run.ctx, journal };
  const ctx: StageContext = { ...resources, ...serialRuntime(resources) };
  try {
    await recover({
      stage: ctx,
      commands: {
        ...ctx, hostEnv: backendEnv(ctx.hostEnv), laneEnv: ctx.hostEnv, planFile: absPath(join(run.planDir, 'plan.json')),
        routingBase: { profile: 'default', config: null }, docs: DOCS_NOT_YET, routing: () => ({ profile: 'default', resolved: ctx.routing(null) }), probes: testProbes(ctx),
      },
    });
    const u = journal.view.unit(U1);
    assert.equal(u.status, 'park-pending');
    assert.deepEqual(u.park?.park, { class: 'retryable', targets });
    assert.deepEqual(u.park?.passed, [], 'nothing passed yet');
    // The environment is fixed; both targets are probed and pass.
    rmSync(join(run.stateDir, `${DB}.teardown-fails`));
    git(worktreeOf(run), 'checkout', '--quiet', branch);
    const prober = createProber({ ...ctx, profile: 'default', sample: () => CLEAR });
    const jobs = prober.due(journal.view, new Date());
    assert.deepEqual(jobs.map((j) => j.target).sort((a, b) => a.type.localeCompare(b.type)), targets);
    for (const job of jobs) assert.equal(await prober.run(job, live()), 'pass', JSON.stringify(job.target));
    assert.equal(journal.view.unit(U1).status, 'active', 'recovered once every target passed');
    assert.equal(resourceTable(journal.view).get(db)?.status.state, 'free');
    // The salvage re-runs (its reservation already cleaned) and the unit goes on.
    const rerun: BuildRun = { ...b.run, reservation: null };
    const again = await salvage(ctx, run.unit, rerun);
    assert.equal(again.outcome.kind, 'committed');
    assert.equal((await teardown(ctx, U1, rerun)).outcome.kind, 'released');
  } finally {
    journal.close();
  }
});

test('stage.repeat-park: a retryable park on a target the unit recovered on within 6 h is written operator, and its item is env-blocked', () => {
  const run = setupUnit({ steps: [], dag: DAG });
  const parent = at(start(run.ctx, U1, 'plan-check'), 'plan-check');
  const first = record(run.ctx, parent, 'process-fault', null, { backend: 'claude', failed: [] });
  assert.equal(first.next.kind, 'park');
  const park = runEvents(run).map(outcomeOf).findLast((o) => o !== null)!;
  assert.deepEqual(park.park, { class: 'retryable', targets: [{ type: 'backend', backend: 'claude' }] });
  run.journal.fact({ kind: 'probe', target: { type: 'backend', backend: 'claude' }, covers: [runEvents(run).findLast((e) => outcomeOf(e) !== null)!.seq], result: 'pass', nextProbeAt: null } as Fact);
  assert.equal(run.journal.view.unit(U1).status, 'active', 'recovered');
  const again = record(run.ctx, at(start(run.ctx, U1, 'plan-check'), 'plan-check'), 'process-fault', null, { backend: 'claude', failed: [] });
  assert.ok(again.next.kind === 'park');
  assert.equal(again.next.needsUser.reason, 'env-blocked');
  assert.deepEqual(runEvents(run).map(outcomeOf).findLast((o) => o !== null)!.park, { class: 'operator', kind: 'env' });
  run.journal.close();
});

// ---------------------------------------------------------------------------------------------------
// D4 through the build stage

test('rounds.d4-through-driver: red, a stalled fix round, then the next build launches on build.high with a fresh session', T, async () => {
  const run = setupUnit({
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([], { argv: ['exec', '-C'] }),
      codexBuild([{ type: 'commit', message: 'not the fix', files: { 'src/notes.md': 'Tried.\n' } }], { argv: ['exec', 'resume'] }),
      {
        as: 'claude',
        expect: { argv: ['-p', '--session-id'], argvLacks: ['--resume'], stdinContains: [NO_SESSION_NOTE] },
        acts: [{ type: 'commit', message: 'fix add', files: ADD_FIX }, { type: 'emit', value: BUILD_REPORT }],
      },
    ],
    dag: DAG,
  });
  started(await planCheck(run.ctx, run.unit));
  const red1 = started(await lanes(run.ctx, run.unit, await buildToLanes(run, { kind: 'fresh' })));
  assert.equal(red1.outcome.kind, 'red');
  assert.ok(red1.fix !== null);
  const red2 = started(await lanes(run.ctx, run.unit, await buildToLanes(run, red1.fix)));
  assert.equal(red2.outcome.kind, 'red');
  assert.ok(red2.fix !== null);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 2, 'inside the bound: 2 < 3');
  assert.equal(run.journal.view.unit(U1).buildTier, 'med');

  const green = started(await lanes(run.ctx, run.unit, await buildToLanes(run, red2.fix)));
  assert.equal(green.outcome.kind, 'green');
  const builds = spawnIntents(run).filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  assert.equal(builds.length, 3);
  const escalated = builds[2]!;
  assert.ok(escalated.parent.type === 'stage');
  const s = escalated.expect.subject;
  assert.ok(s.purpose === 'backend' && s.role === 'build');
  assert.equal(s.tier, 'high', 'the round sits on build.high');
  const launch = launchOf(run, escalated);
  assert.equal(launch.argv[0], 'claude');
  assert.ok(launch.argv.includes(run.ctx.routing(null).table.build.high.model), 'build.high\'s model');
  assert.ok(launch.terminal.type === 'backend' && 'session' in launch.terminal && launch.terminal.session.mode === 'fresh', 'a fresh session: the seat moved');
  const fact = runEvents(run).find((e) => e.type === 'fact' && e.fact.kind === 'implementer-escalated');
  assert.ok(fact !== undefined && fact.type === 'fact' && fact.fact.kind === 'implementer-escalated');
  assert.equal(fact.fact.attempt, escalated.parent.attempt);
  assert.ok(fact.seq < (escalated as Event).seq, 'journaled before the round\'s seat was chosen and spawned');
  assert.equal(run.journal.view.unit(U1).buildTier, 'high');
  assert.ok(readCalls(run.scenario.path).every((c) => c.step !== null));
});
