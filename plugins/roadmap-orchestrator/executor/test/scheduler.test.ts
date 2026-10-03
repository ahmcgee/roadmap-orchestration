// The scheduler (src/schedule/scheduler.ts), in the test process over fake-backed arcs (real processes, real
// git): units run in parallel, one task per unit, pause and stop at admission boundaries while chains finish,
// restarts continue pending chains first (G2), jobs never apply a command twice, a limited backend holds only
// the stages that call it, a capacity park recovers through its probe, a re-entry runs its whole path, and the
// settled predicate. Named tests: sched.parallel, sched.one-task-per-unit, sched.pause-holds-nothing,
// sched.chain-completes-under-pause, sched.restart-paused-green-before-ff, sched.restart-paused-ff-before-snapshot,
// sched.stop-during-smoke, sched.stop-during-teardown, sched.no-double-apply, sched.backend-limit-others-run,
// probe.capacity-recovers-held-unit, reenter.clean-verify-to-retire, arc.state-predicates.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import { type Event, type Fact, type LogRecord, prevHash, serializeEvent } from '../src/core/events.ts';
import { type UnitId, arcId, invocationId, opId, planRev, seatRev, specRev, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { Fold } from '../src/core/state.ts';
import { absPath, isoTime, repoPattern } from '../src/core/values.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { CONTINUE_DIRECTIVE } from '../src/pipeline/rounds.ts';
import { recover } from '../src/recover/recover.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { unitSettled } from '../src/schedule/scheduler.ts';
import { reached, release } from './helpers/barrier.ts';
import { fixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Step, capturedClaudeResult, readCalls } from './helpers/scenario.ts';
import { ARC, H, REV, appliedFields, chain } from './fixtures/log-records.ts';
import { recoveryContext } from './fixtures/rec-common.ts';
import { haltItem, receiptOf, startScheduler, submit } from './fixtures/sched-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import {
  type ArcDescriptor, type ArcRun, MUL, U1, codexStep, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil,
} from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const WAIT_MS = 60_000;
const U2 = unitId('u2');
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];
const OK = { ok: true } as const;

type Json = Record<string, unknown>;

/** Each step keyed to `unit`: its calls take only these, in order (independent units run at once). */
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));

/** Edits the arc's plan file before its first revision is recorded (`contextFor`). */
function editPlan(d: ArcDescriptor, edit: (plan: Json & { units: Json[] }) => void): void {
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
  edit(plan);
  writeFileSync(d.planPath, JSON.stringify(plan));
}

/**
 * Declares resource `db`, held by every unit's build: its probe is res-tool.ts (free), its teardown parks at
 * barrier `teardown` in `dir` for up to 10 minutes, as a slow estate teardown would.
 */
function slowTeardown(d: ArcDescriptor, dir: string, stateDir: string): void {
  editPlan(d, (p) => {
    p['resources'] = [{
      name: 'db',
      probe: { argv: [process.execPath, fixture('res-tool.ts'), 'probe', stateDir, 'db'], cwd: '.', env: { set: {}, pass: [] } },
      teardown: { argv: [process.execPath, fixture('barrier-child.ts'), dir, 'teardown', '600000'], cwd: '.', env: { set: {}, pass: [] } },
    }];
    for (const u of p.units) u['resources'] = ['db'];
  });
}

const eventsOf = (d: ArcDescriptor): readonly Event[] => readJournal(absPath(d.runDir), arcId(d.arc)).events;
const factSeq = (d: ArcDescriptor, match: (f: Fact) => boolean): number => {
  const e = eventsOf(d).find((x) => x.type === 'fact' && match(x.fact));
  if (e === undefined) throw new Error('no such fact');
  return e.seq;
};
const outcomeSeq = (d: ArcDescriptor, unit: string, stage: string): number =>
  factSeq(d, (f) => f.kind === 'stage-outcome' && f.unit === unit && f.stage === stage);
const allFree = (r: ArcRun): boolean => [...resourceTable(r.journal.view).values()].every((e) => e.status.state === 'free');
const heldBy = (r: ArcRun, unit: UnitId): readonly string[] =>
  [...resourceTable(r.journal.view)].flatMap(([name, e]) => (e.status.state !== 'free' && 'holder' in e.status && 'unit' in e.status.holder && e.status.holder.unit === unit ? [name] : []));

/** Applies one command in the test process, as a scheduler would, before one runs. */
async function command(r: ArcRun, body: Parameters<typeof submit>[1]): Promise<void> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  assert.equal((await applyCommand(commandContextFor(r), file)).kind, 'applied');
}

// ---------------------------------------------------------------------------------------------------
// Parallel units

test('sched.parallel, sched.one-task-per-unit: two independent units build at once (their build intervals overlap in the log), each unit has at most one stage attempt open at any point, and both merge', T, async () => {
  const build = codexStep([{ type: 'commit', message: 'add mul', files: MUL }, { type: 'barrier', name: 'build', timeoutMs: 120_000, perUnit: true }], { argv: ['exec', '-C'] });
  const units = ['u1', 'u2'];
  const d = setupArc({
    units: units.map((id) => ({ id })),
    steps: units.flatMap((u) => of(u, [planCheckStep({ decision: 'approve' }), build, gateStep({ decision: 'approve' })])),
  });
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    for (const u of units) await reached(d.scenarioDir, `${u}.build`, WAIT_MS);
    for (const u of units) release(d.scenarioDir, `${u}.build`);
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
    for (const u of units) assert.deepEqual(outcomes(d, u), STRAIGHT, u);

    const events = eventsOf(d);
    const spawnSeq = (unit: string): number => {
      const e = events.find((x) => x.type === 'intent' && x.kind === 'proc.spawn' && x.parent.type === 'stage' && x.parent.unit === unit && x.parent.stage === 'build');
      assert.ok(e !== undefined, `${unit}'s build spawn`);
      return e.seq;
    };
    // sched.parallel: each build began before the other one's outcome.
    assert.ok(spawnSeq('u1') < outcomeSeq(d, 'u2', 'build') && spawnSeq('u2') < outcomeSeq(d, 'u1', 'build'), 'the two builds overlap');

    // sched.one-task-per-unit: per unit, one stage attempt open at a time: from its first intent to its outcome
    // (a publication's release after its snapshot's outcome reopens nothing; a retire records no outcome, and is last).
    const open = new Map<string, Set<number>>();
    const closed = new Set<string>();
    let most = 0;
    for (const e of events) {
      if (e.type === 'intent' && e.parent.type === 'stage' && !closed.has(`${e.parent.unit}#${e.parent.attempt}`)) {
        const set = open.get(e.parent.unit) ?? new Set<number>();
        set.add(e.parent.attempt);
        open.set(e.parent.unit, set);
        assert.ok(set.size <= 1, `unit ${e.parent.unit} has attempts ${[...set].join(', ')} open at seq ${e.seq}`);
      }
      if (e.type === 'fact' && e.fact.kind === 'stage-outcome') {
        open.get(e.fact.unit)?.delete(e.fact.attempt);
        closed.add(`${e.fact.unit}#${e.fact.attempt}`);
      }
      most = Math.max(most, [...open.values()].filter((s) => s.size > 0).length);
    }
    assert.equal(most, 2, 'both units had an attempt open at once');
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Pause and stop

test('sched.pause-holds-nothing: a pause ends a unit\'s task at its admission boundary: a wait for its build\'s entry reservation is cancelled with nothing journaled, and a paused live build is interrupted and its reservation released', T, async () => {
  const check = planCheckStep({ decision: 'approve' });
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      ...of('u1', [check, codexStep([{ type: 'commit', message: 'add mul', files: MUL }, { type: 'barrier', name: 'b1', timeoutMs: 120_000 }], { argv: ['exec', '-C'] })]),
      ...of('u2', [{ ...check, acts: [{ type: 'barrier', name: 'u2check', timeoutMs: 120_000 }, ...check.acts] } as Step]),
    ],
  });
  // Five @cpu tokens: both plan-checks (1 each), then u1's build (4); u2's build (4) must wait for u1's.
  editPlan(d, (p) => void (p['capacity'] = { cpu: 5 }));
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    await reached(d.scenarioDir, 'b1', WAIT_MS);
    release(d.scenarioDir, 'u2check');
    await until(() => r.journal.view.unit(U2).decided?.stage === 'plan-check', 'u2 to pass its plan-check');
    await sleep(2_000);
    assert.equal(outcomes(d, 'u2').length, 1, 'u2 waits for its build\'s entry reservation');
    assert.deepEqual(heldBy(r, U2), [], 'waiting, u2 holds nothing');

    await receiptOf(r, submit(r, { type: 'pause', target: { type: 'unit', unit: U2 } }));
    await receiptOf(r, submit(r, { type: 'pause', target: { type: 'unit', unit: U1 } }));
    await until(() => outcomes(d).includes('build:interrupted'), 'u1\'s build to be interrupted');
    await until(() => allFree(r), 'every reservation released');
    await sleep(2_000);
    assert.ok(allFree(r), 'paused, neither unit holds anything');
    assert.deepEqual(outcomes(d, 'u2'), ['plan-check:approve'], 'the cancelled wait journaled no build attempt, no hold');
    assert.equal(r.journal.view.unit(U2).counters.attempts, 1);
    assert.equal(r.journal.view.unit(U2).status, 'active', 'not held: its build never started');
    assert.equal(r.journal.view.unit(U1).status, 'held');
    const end = await stopAfter(r, s);
    assert.deepEqual(end, { kind: 'stop', cause: 'command', needsUser: null });
  } finally {
    r.journal.close();
  }
});

test('sched.chain-completes-under-pause: a pause while a build\'s chain runs (its teardown slow) lets the chain finish; the unit then stops at its next admission boundary holding nothing, and a resume runs it to merge', T, async () => {
  const dir = tmpDir('teardown-barrier');
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  slowTeardown(d, dir, tmpDir('res-state'));
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    await reached(dir, 'teardown', WAIT_MS);
    await receiptOf(r, submit(r, { type: 'pause', target: { type: 'unit', unit: U1 } }));
    release(dir, 'teardown');
    await until(() => outcomes(d).includes('teardown:released'), 'the chain to finish');
    await sleep(2_500);
    assert.deepEqual(outcomes(d), STRAIGHT.slice(0, 6), 'the chain ran to its end, then nothing: lanes are an admission boundary');
    assert.ok(allFree(r), 'the chain released the build\'s reservation');
    assert.deepEqual(r.journal.view.opsOf('proc.kill'), [], 'nothing of the chain was killed');
    await receiptOf(r, submit(r, { type: 'resume', target: { type: 'unit', unit: U1 } }));
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
    assert.deepEqual(outcomes(d), STRAIGHT);
  } finally {
    r.journal.close();
  }
});

test('sched.stop-during-teardown: a stop while a teardown runs (a 10-min fake) never kills it: control commands still apply while the scheduler waits for it, and the run ends stop once it finishes', T, async () => {
  const dir = tmpDir('teardown-barrier');
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild()] });
  slowTeardown(d, dir, tmpDir('res-state'));
  const r = contextFor(d);
  try {
    const item = raiseNeedsUser(r.journal, r.ctx.runDir, {
      blocking: false, subject: { type: 'arc' }, reason: 'env-blocked', summary: 'seeded', recommendation: 'ack it', options: [], evidence: [],
    }, { type: 'arc' });
    const s = startScheduler(r);
    await reached(dir, 'teardown', WAIT_MS);
    const stop = submit(r, { type: 'stop' });
    assert.equal((await receiptOf(r, stop)).state, 'applied');
    // Stopping, the scheduler still applies control commands.
    assert.equal((await receiptOf(r, submit(r, { type: 'ack', needsUser: item, choice: null }))).state, 'applied');
    assert.notEqual(r.journal.view.ackOf(item), null);
    await sleep(2_000);
    assert.ok(!outcomes(d).includes('teardown:released'), 'the teardown still runs');
    let ended = false;
    void s.end.then(() => (ended = true));
    await sleep(1_500);
    assert.equal(ended, false, 'the run waits for the teardown');
    release(dir, 'teardown');
    assert.deepEqual(await s.end, { kind: 'stop', cause: 'command', needsUser: null });
    assert.deepEqual(outcomes(d), STRAIGHT.slice(0, 6), 'the chain finished; lanes never started');
    assert.deepEqual(r.journal.view.opsOf('proc.kill'), [], 'the teardown was not killed');
    assert.ok(allFree(r));
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Restart: pending chains first (G2)

for (const [name, stage, rest] of [
  ['sched.restart-paused-green-before-ff', 'candidate', ['ff:published', 'snapshot:published']],
  ['sched.restart-paused-ff-before-snapshot', 'ff', ['snapshot:published']],
] as const) {
  test(`${name}: a paused unit whose green publication stopped before ${rest[0]!.split(':')[0]} continues its chain at the restart, whatever the pause, and merges`, T, async () => {
    const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === stage);
      assert.deepEqual(outcomes(d), STRAIGHT.slice(0, STRAIGHT.length - rest.length));
      await command(r, { type: 'pause', target: { type: 'unit', unit: U1 } });
      // The restart: recovery keeps the publication's slot (its chain is pending), then the scheduler.
      await recover(recoveryContext(r));
      assert.equal(resourceTable(r.journal.view).get('integration-slot' as never)?.status.state, 'running', 'the slot is kept for the chain');
      assert.deepEqual(await startScheduler(r).end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
      assert.deepEqual(outcomes(d), STRAIGHT);
      assert.deepEqual(r.journal.view.control().pausedUnits, [U1], 'still paused: the chain ran under the pause');
      assert.ok(allFree(r));
    } finally {
      r.journal.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Jobs: a command applied once; a stop ends a smoke

/** A usage-limit park of `backend`, as a failed call records it (the call's invocation, here a stand-in). */
const usageLimit = (r: ArcRun, backend: 'claude' | 'codex'): number =>
  r.journal.fact({ kind: 'backend-park', backend, class: 'usage-limit', inv: invocationId(opId(r.journal.view.arc, 1), 1) });
/** Parks `claude` on a usage limit: never probed (D4); `resume --backend claude` smokes it through the prober. */
const parkClaude = (r: ArcRun): number => usageLimit(r, 'claude');
const smokeAt = (name: string): Step => ({ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'barrier', name, timeoutMs: 120_000 }, { type: 'emit', value: OK }] });

test('sched.no-double-apply: a mutation whose job is still running (resume --backend, its smoke parked) is never started again, poll after poll; it applies once', T, async () => {
  const d = setupArc({ steps: [smokeAt('smoke')] });
  const r = contextFor(d);
  try {
    await command(r, { type: 'pause', target: { type: 'all' } });
    parkClaude(r);
    const s = startScheduler(r);
    const id = submit(r, { type: 'resume', target: { type: 'backend', backend: 'claude' } });
    await reached(d.scenarioDir, 'smoke', WAIT_MS);
    await sleep(3_500);
    const ops = (): number => r.journal.view.opsOf('command.apply').filter((i) => i.expect.command === id).length;
    assert.equal(ops(), 1, 'one command.apply op while its job runs');
    assert.equal(readCalls(d.scenarioPath).length, 1, 'one smoke');
    release(d.scenarioDir, 'smoke');
    assert.equal((await receiptOf(r, id)).state, 'applied');
    assert.deepEqual(r.journal.view.parkedBackends(), []);
    await sleep(2_500);
    assert.equal(ops(), 1, 'applied once');
    assert.equal(readCalls(d.scenarioPath).length, 1);
    await stopAfter(r, s);
  } finally {
    r.journal.close();
  }
});

test('sched.stop-during-smoke: a stop kills a running smoke (resume --backend); the run ends stop without a verdict on that command, whose open op the next start\'s recovery applies once', T, async () => {
  const d = setupArc({ steps: [smokeAt('smoke'), { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] }] });
  const r = contextFor(d);
  try {
    await command(r, { type: 'pause', target: { type: 'all' } });
    parkClaude(r);
    const s = startScheduler(r);
    const id = submit(r, { type: 'resume', target: { type: 'backend', backend: 'claude' } });
    await reached(d.scenarioDir, 'smoke', WAIT_MS);
    submit(r, { type: 'stop' });
    assert.deepEqual(await s.end, { kind: 'stop', cause: 'command', needsUser: null });
    const kills = r.journal.view.opsOf('proc.kill');
    assert.deepEqual(kills.map((k) => k.expect.reason), ['stop'], 'the smoke was killed');
    const smoke = r.journal.view.opsOf('proc.spawn').find((i) => i.expect.subject.purpose === 'smoke');
    assert.ok(smoke !== undefined && kills[0]!.expect.inv.startsWith(smoke.op));
    assert.equal(terminalReceipt(r.ctx.runDir, id), null, 'no verdict: the stop cut the smoke short');
    assert.deepEqual(r.journal.view.parkedBackends(), ['claude']);
    const open = r.journal.view.opsOf('command.apply').filter((i) => i.expect.command === id && r.journal.view.doneOf(i.op) === null);
    assert.equal(open.length, 1, 'its op is left open');
    // The next start: recovery applies it once, from its open op.
    await recover(recoveryContext(r));
    assert.equal(terminalReceipt(r.ctx.runDir, id)?.state, 'applied');
    assert.deepEqual(r.journal.view.parkedBackends(), []);
    assert.equal(r.journal.view.opsOf('command.apply').filter((i) => i.expect.command === id).length, 1);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Backends

test('sched.backend-limit-others-run: with codex parked on a usage limit, u1 (building on codex) waits at its build\'s admission while u2 (building on claude) runs to merge; resume --backend releases u1', T, async () => {
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2', risk: 'high' }],
    steps: [
      // u1 builds after u2 merged mul: its own file too, so its commit is not empty.
      ...of('u1', [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/one.js': 'export const one = 1;\n' }), gateStep({ decision: 'approve' })]),
      ...of('u2', [
        planCheckStep({ decision: 'approve', risk: 'high' }),
        { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'] }, acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: { summary: 'Did the work.', changedPaths: [], lanesRun: [], blockers: [] } }] },
        gateStep({ decision: 'approve' }),
      ]),
      { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'emit', value: OK }] },
    ],
  });
  const r = contextFor(d);
  try {
    usageLimit(r, 'codex');
    const s = startScheduler(r);
    await until(() => r.journal.view.unit(U2).status === 'retired', 'u2 to merge');
    assert.deepEqual(outcomes(d, 'u1'), ['plan-check:approve'], 'u1\'s plan-check (claude) ran; its build (codex) was not admitted');
    assert.equal(r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.unit === U1 && i.expect.subject.role === 'build').length, 0);
    assert.equal((await receiptOf(r, submit(r, { type: 'resume', target: { type: 'backend', backend: 'codex' } }))).state, 'applied');
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
    assert.deepEqual(outcomes(d, 'u1'), STRAIGHT);
  } finally {
    r.journal.close();
  }
});

test('probe.capacity-recovers-held-unit: end to end, a capacity error at plan-check parks claude with an epoch and holds the unit; the scheduler\'s probe job passes and releases the hold, and the unit runs to merge', T, async () => {
  const d = setupArc({
    steps: [{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: OK }] }, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
  });
  // A `claude` whose first call answers with the CLI's capacity error (HTTP 529); every later call is the fake's.
  const bin = tmpDir('capacity-bin');
  const out = join(bin, 'stdout.jsonl');
  writeFileSync(out, `${JSON.stringify({ ...capturedClaudeResult('claude-api-error'), result: 'Overloaded', api_error_status: 529 })}\n`);
  const marker = join(bin, 'failed-once');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nif [ ! -e ${JSON.stringify(marker)} ]; then : > ${JSON.stringify(marker)}; cat ${JSON.stringify(out)}; exit 1; fi\nexec ${JSON.stringify(join(d.binDir, 'claude'))} "$@"\n`, { mode: 0o755 });
  const r = contextFor(d);
  const ctx = { ...r.ctx, hostEnv: { ...r.ctx.hostEnv, PATH: `${bin}:${r.ctx.hostEnv['PATH'] ?? ''}` } };
  try {
    assert.deepEqual(await startScheduler({ ...r, ctx }).end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
    const events = eventsOf(d);
    const park = events.find((e) => e.type === 'fact' && e.fact.kind === 'backend-park');
    assert.ok(park?.type === 'fact' && park.fact.kind === 'backend-park' && park.fact.class === 'capacity');
    const hold = events.find((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.class === 'hold');
    assert.ok(hold?.type === 'fact' && hold.fact.kind === 'stage-outcome');
    assert.deepEqual(hold.fact.cause, { type: 'backend', backend: 'claude', parkSeq: park.seq }, 'the hold names the park epoch');
    const probe = events.find((e) => e.type === 'fact' && e.fact.kind === 'probe');
    assert.ok(probe?.type === 'fact' && probe.fact.kind === 'probe');
    assert.deepEqual([probe.fact.result, probe.fact.covers], ['pass', [park.seq]]);
    assert.deepEqual(outcomes(d), ['plan-check:interrupted', ...STRAIGHT], 'the held plan-check ran again once the probe passed');
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Re-entry, the full path

test('reenter.clean-verify-to-retire: a unit parked at its gate is re-entered (`apply` of a unit that reenters it at verify): prepare, lanes, gate, candidate, publication, and the retire cites the preparation\'s snapshot', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const s = startScheduler(r);
    const item = await haltItem(r, U1);
    assert.deepEqual(outcomes(d), [...STRAIGHT.slice(0, 7), 'gate:escalate', 'gate:escalate']);
    // The architect re-enters u1 as u1b, at verify: its branch already holds the work.
    cpSync(join(d.planPath, '..', 'u1.json'), join(d.planPath, '..', 'u1b.json'));
    const spec = JSON.parse(readFileSync(join(d.planPath, '..', 'u1b.json'), 'utf8')) as Json;
    writeFileSync(join(d.planPath, '..', 'u1b.json'), JSON.stringify({ ...spec, unit: 'u1b' }));
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
    plan.units.push({ ...plan.units[0]!, id: 'u1b', spec: 'u1b.json', reenters: { unit: 'u1', enterAt: 'verify' } });
    writeFileSync(d.planPath, JSON.stringify(plan));
    const { applyBody } = await import('./fixtures/unit-common.ts');
    const applied = await receiptOf(r, submit(r, applyBody(d)));
    assert.equal(applied.state, 'applied', JSON.stringify(applied));
    await receiptOf(r, submit(r, { type: 'ack', needsUser: item, choice: null }));
    const end = await s.end;
    assert.deepEqual(end, { kind: 'complete', units: [{ unit: 'u1', result: 'superseded', by: 'u1b' }, { unit: 'u1b', result: 'merged' }] });
    assert.deepEqual(outcomes(d, 'u1b'), ['prepare:clean-verify', ...STRAIGHT.slice(6)]);
    // The retire cited the preparation's evidence (F14): u1b never built.
    const view = r.journal.view;
    const prepared = view.opsOf('evidence.snapshot').find((i) => i.parent.type === 'stage' && i.parent.unit === 'u1b' && i.parent.stage === 'prepare');
    assert.ok(prepared !== undefined);
    const removed = view.opsOf('worktree.remove').filter((i) => i.parent.type === 'stage' && i.parent.unit === 'u1b' && i.parent.stage === 'retire');
    assert.ok(removed.some((i) => JSON.stringify(i.expect.evidence).includes(prepared.op)), JSON.stringify(removed.map((i) => i.expect.evidence)));
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// The settled predicate

describe('arc.state-predicates', () => {
  const U3 = unitId('u3');
  const LATER = isoTime('2026-09-25T12:30:00.000Z');
  const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
  const outcome = (unit: UnitId, stage: string, attempt: number, out: string, cls: string, extra: object = {}): LogRecord =>
    fact({ kind: 'stage-outcome', unit, stage, attempt, outcome: out, class: cls, chargeable: false, ...extra });
  const dispatch = (unit: UnitId): LogRecord => fact({
    kind: 'dispatch', record: { unit, specRev: specRev(1), specSha256: H, scope: [repoPattern('src/**')], riskFloor: 'med', routingRev: REV, implementerSeatRev: seatRev('fedcba9876543210'), at: LATER, transientRules: 'm3' },
  });
  const planApplied = (rev: number, units: readonly UnitId[], changes: readonly object[] = []): LogRecord => fact({
    kind: 'plan-applied', rev: planRev(rev), command: rev === 1 ? null : `cmd-${String(rev).padStart(16, '0')}`, planSha256: H,
    specs: Object.fromEntries(units.map((u) => [u, H])), changes, ...appliedFields(rev, rev === 1 ? null : `cmd-${String(rev).padStart(16, '0')}`),
  });
  const folded = (records: readonly LogRecord[]): Fold => {
    const f = new Fold(ARC);
    for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
    return f;
  };

  it('a unit is settled when merged, cut, superseded, or parked for the architect; never while active, held or parked retryable', () => {
    const base = [planApplied(1, [U1, U2]), dispatch(U1), dispatch(U2)];
    assert.equal(unitSettled(folded(base), U1), false, 'active');
    assert.equal(unitSettled(folded([...base, outcome(U1, 'snapshot', 1, 'published', 'retire')]), U1), true, 'merged');
    assert.equal(unitSettled(folded([...base, outcome(U1, 'build', 1, 'interrupted', 'hold')]), U1), false, 'held');
    assert.equal(unitSettled(folded([...base, outcome(U1, 'plan-check', 1, 'escalate', 'park', { park: { class: 'operator', kind: 'design' } })]), U1), true, 'an operator park');
    assert.equal(unitSettled(folded([...base, outcome(U1, 'plan-check', 1, 'escalate', 'park')]), U1), true, 'a park without its class (the interim M2 shim), read as operator');
    const retry = outcome(U1, 'build', 1, 'process-fault', 'park', { park: { class: 'retryable', targets: [{ type: 'backend', backend: 'codex' }] } });
    assert.equal(unitSettled(folded([...base, retry]), U1), false, 'a retryable park is probed until it recovers');
    const cut = folded([planApplied(1, [U1, U2]), planApplied(2, [U1, U2], [{ type: 'unit-cut', unit: U2 }])]);
    assert.equal(unitSettled(cut, U2), true, 'cut');
    const parked = [...base, outcome(U1, 'plan-check', 1, 'escalate', 'park', { park: { class: 'operator', kind: 'design' } })];
    const superseded = folded([...parked, planApplied(2, [U1, U2, U3], [{ type: 'unit-added', unit: U3 }, { type: 'unit-reentered', unit: U3, reenters: U1, reset: false }])]);
    assert.equal(unitSettled(superseded, U1), true, 'superseded');
    assert.equal(unitSettled(superseded, U3), false, 'its successor is active');
  });
});

// ---------------------------------------------------------------------------------------------------

async function until(check: () => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
}

/** Ends a scheduler still running with a stop command. */
async function stopAfter(r: ArcRun, s: ReturnType<typeof startScheduler>) {
  submit(r, { type: 'stop' });
  return s.end;
}
