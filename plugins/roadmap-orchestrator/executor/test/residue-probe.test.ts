// Residue probing at executor level (SCHEMAS.md "M2: parks", residue probing): a failed cleanup that no stage
// outcome parked is probed all the same, and the arc does not end `complete` while it is left.
//
// The scenario: u1's estate lane (cm-pin.ts) holds estate#1 at a barrier when the executor is SIGKILLed. The
// supervisor's respawn adopts the lane, and recovery's cleanup of the dead lanes holder runs estate#1's
// teardown, which the estate fake fails (its per-instance counted marker). estate#1 goes cleanup-failed with a
// residue, and the killed lanes attempt gets no stage outcome, so nothing parks. The unit runs its lanes again
// on estate#2 and merges; the residue is the prober's.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Fact, IntentOf } from '../src/core/events.ts';
import { parseOpId, poolInstance, resourceName } from '../src/core/ids.ts';
import { openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues, undispositioned } from '../src/host/residues.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { raiseDue, residueEscalationsDue } from '../src/park/schedule.ts';
import { PARK_ESCALATE_MS } from '../src/schedule/types.ts';
import { reached, release } from './helpers/barrier.ts';
import { fixture } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, cli, executorPid, journalOf, reasonOf, setupExec, startExec, statusOf, until,
} from './fixtures/exec-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { MUL_LANE, U1, gateStep, mulBuild, outcomes } from './fixtures/unit-common.ts';

after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };
const WAIT_MS = 90_000;
const PIN = 'pin';
const ESTATE1 = poolInstance(resourceName('estate'), 1);
const ESTATE1_TARGET = { type: 'resource', instance: ESTATE1 } as const;

const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const facts = (r: ExecRun): readonly Fact[] => journalOf(r).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const started = (r: ExecRun): number => facts(r).filter((f) => f.kind === 'executor-started').length;
const probesOf = (r: ExecRun) => facts(r).flatMap((f) => (f.kind === 'probe' ? [f] : []));
const transitions = (r: ExecRun): readonly IntentOf<'resource.transition'>[] => journalOf(r).view.opsOf('resource.transition');
const command = (argv: readonly string[]) => ({ argv, cwd: '.', env: { set: {}, pass: ['PATH'] } });

type Laid = Readonly<{ r: ExecRun; estate: string; barriers: string }>;

/** u1 with the mul lane and an estate lane pinned at `pin` holding its instance; the pool `estate` of 2 instances. */
function layout(t: Parameters<typeof setupExec>[0]): Laid {
  const estate = tmpDir('residue-estate');
  const barriers = tmpDir('residue-barriers');
  const lanes = [MUL_LANE, { id: 'estate', tier: 'estate' as const, resources: ['estate'], argv: [process.execPath, fixture('cm-pin.ts'), barriers, PIN, estate, 'estate'] }];
  const r = setupExec(t, {
    units: [{ id: 'u1', lanes }],
    steps: [
      ...SMOKE_DEFAULT,
      ...of('u1', [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })]),
      // The respawn's smoke.
      ...SMOKE_DEFAULT,
    ],
  });
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as Record<string, unknown>;
  const tool = (cmd: string) => command([process.execPath, fixture('../fakes/estate.ts'), cmd, estate, 'estate']);
  plan['resources'] = [{ name: 'estate', pool: { size: 2 }, probe: tool('probe'), teardown: tool('teardown') }];
  writeFileSync(r.planPath, JSON.stringify(plan));
  return { r, estate, barriers };
}

/**
 * Starts the arc, and once the estate lane holds estate#1 at its pin: arms `failures` failing teardowns of
 * estate#1, SIGKILLs the executor, and releases the pin once the supervisor's respawn has started.
 */
async function killHolder(l: Laid, failures: number): Promise<ReturnType<typeof startExec>> {
  const run = startExec(l.r);
  await reached(l.barriers, PIN, WAIT_MS);
  writeFileSync(join(l.estate, `${ESTATE1}.teardown-fails-once`), String(failures));
  process.kill(executorPid(l.r), 'SIGKILL');
  await until(() => started(l.r) === 2, WAIT_MS, 'the supervisor\'s respawn');
  release(l.barriers, PIN);
  return run;
}

/** The failed cleanup recovery recorded: one fail of estate#1, by the killed lanes attempt, parked by no outcome. */
function recoveryFail(r: ExecRun): IntentOf<'resource.transition'> {
  const fails = transitions(r).filter((i) => i.expect.edge.type === 'fail');
  assert.equal(fails.length, 1, 'one failed cleanup');
  const fail = fails[0]!;
  const { holder, edge } = fail.expect;
  assert.ok(holder.type === 'stage' && holder.unit === U1 && holder.stage === 'lanes', JSON.stringify(holder));
  assert.ok(edge.type === 'fail' && edge.residues.length === 1 && edge.residues[0]!.resource === ESTATE1, JSON.stringify(edge));
  assert.deepEqual(fail.parent, { type: 'arc' }, 'recovery\'s cleanup of the dead holder');
  const outcome = facts(r).find((f) => f.kind === 'stage-outcome' && f.unit === U1 && f.stage === 'lanes' && f.attempt === holder.attempt);
  assert.equal(outcome, undefined, 'the killed lanes attempt has no stage outcome: nothing parked');
  return fail;
}

test('residue.recovery-orphan-reclaimed: a killed lane holder\'s teardown fails in recovery; the unit merges on estate#2, a residue probe reclaims estate#1 (cleaned, free), the run ends complete only then, and the next start is not refused', T, async (t) => {
  const l = layout(t);
  // Recovery's teardown fails, and so does the first probe's: the pass comes a backoff step later.
  const run = await killHolder(l, 2);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });

  const { r } = l;
  const fail = recoveryFail(r);
  const holder = fail.expect.holder as Extract<typeof fail.expect.holder, { type: 'stage' }>;
  const failSeq = parseOpId(fail.op).seq;
  const retry = { type: 'retry', unit: U1, stage: 'lanes', attempt: holder.attempt } as const;
  const retried = transitions(r).filter((i) => i.expect.holder.type === 'retry');
  assert.ok(retried.every((i) => JSON.stringify(i.expect.holder) === JSON.stringify(retry)), 'the retry holder is the residue\'s attempt');
  assert.deepEqual(retried.map((i) => i.expect.edge.type), ['reclaim', 'release'], 'reclaimed once, released after the second teardown');
  const probes = probesOf(r);
  assert.deepEqual(probes.map((p) => [p.target, p.covers, p.result]), [[ESTATE1_TARGET, [failSeq], 'fail'], [ESTATE1_TARGET, [failSeq], 'pass']]);

  const hostDir = absPath(r.hostDir);
  assert.deepEqual(undispositioned(hostDir), []);
  const disposed = readResidues(hostDir).filter((x) => x.type === 'disposition');
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]!.disposition, 'cleaned');
  assert.equal(disposed[0]!.key.inv, (fail.expect.edge as Extract<typeof fail.expect.edge, { type: 'fail' }>).residues[0]!.teardown);
  const { view, events } = journalOf(r);
  assert.deepEqual(view.resources().get(ESTATE1)?.status, { state: 'free' });
  assert.deepEqual(view.residues(), []);
  assert.ok(outcomes(r, 'u1').includes('lanes:green'), 'the unit ran its lanes again');
  const passSeq = events.find((e) => e.type === 'fact' && e.fact.kind === 'probe' && e.fact.result === 'pass')!.seq;
  const respawned = events.filter((e) => e.type === 'fact' && e.fact.kind === 'executor-started').at(-1)!.seq;
  assert.ok(passSeq > respawned, 'the respawned executor\'s prober reclaimed it');
  t.diagnostic(`merged ${outcomes(r, 'u1').at(-1)}; residue probe pass at seq ${passSeq} of ${view.highWater()}`);

  // The next arc on this host starts: no residue refuses it.
  const next = { ...setupExec(t, { steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] }), hostDir: r.hostDir };
  const nextExit = await startExec(next).exit;
  assert.equal(nextExit.code, 0, nextExit.stderr);
  assert.deepEqual(reasonOf(nextExit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
});

test('residue.recovery-orphan-stays: a residue whose teardown keeps failing keeps the run from ending complete after the unit merged; status shows its probe, and it escalates at 6 h (non-blocking, once)', T, async (t) => {
  const l = layout(t);
  const run = await killHolder(l, 1000);
  const { r } = l;
  await until(() => journalOf(r).view.unit(U1).status === 'retired', WAIT_MS, 'u1 to merge');
  await until(() => probesOf(r).some((p) => p.result === 'fail'), WAIT_MS, 'a failed residue probe');
  const status = await statusOf(r);
  assert.equal(status.run.state, 'blocked', 'every unit merged, a residue left: blocked, not complete');
  const probe = status.host.probes.find((p) => p.target.type === 'resource' && p.target.instance === ESTATE1);
  assert.ok(probe !== undefined && probe.lastResult === 'fail' && probe.nextProbeAt !== null, JSON.stringify(status.host.probes));
  assert.equal(await Promise.race([run.exit.then(() => 'ended'), new Promise((resolve) => setTimeout(resolve, 3_000, 'running'))]), 'running', 'the run waits for the residue');

  await cli(r, ['stop']);
  const exit = await run.exit;
  assert.equal(reasonOf(exit).kind, 'stop', exit.stdout + exit.stderr);
  const fail = recoveryFail(r);
  assert.equal(transitions(r).filter((i) => i.expect.holder.type === 'retry' && i.expect.edge.type === 'release').length, 0, 'never released');
  assert.deepEqual(undispositioned(absPath(r.hostDir)).map((k) => k.resource), [ESTATE1]);

  // The escalation, by the schedule's injected clock.
  const journal = openJournal(absPath(r.runDir), journalOf(r).view.arc);
  try {
    const [residue] = journal.view.residues();
    assert.ok(residue !== undefined && residue.fail === fail.op);
    const at6h = new Date(Date.parse(residue.at) + PARK_ESCALATE_MS);
    assert.deepEqual(residueEscalationsDue(journal.view, new Date(at6h.getTime() - 1)), []);
    const raised = raiseDue(journal, absPath(r.runDir), at6h);
    assert.equal(raised.length, 1);
    const item = readNeedsUser(absPath(r.runDir), raised[0]!);
    assert.ok(item !== null && item.reason === 'park-escalated' && !item.blocking, JSON.stringify(item));
    assert.deepEqual(item.subject, { type: 'arc' });
    assert.match(item.summary, /estate#1/);
    assert.deepEqual(raiseDue(journal, absPath(r.runDir), new Date(at6h.getTime() + 60 * 60_000)), [], 'raised once');
  } finally {
    journal.close();
  }
});
