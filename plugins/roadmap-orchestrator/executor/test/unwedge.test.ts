// Arc feedback 2026-10-15 (#4, the crash wedge): a unit whose admission-stage attempt a crash cut short, with nothing
// recorded to consume, and that is paused, used to keep that attempt open for good: its spec could not change, it could
// not be cut or re-entered. The executor's startup now closes such an attempt with an uncharged recovery hold
// (src/pipeline/unit.ts `holdAbandoned`), so the unit is held while paused and active otherwise. Over real processes and
// real git: the driver is SIGKILLed right after its build's spawn intent (crashPoint `spawn.after-intent`; recovery closes
// the call lost, which nothing consumes). The log it leaves, plus a pause, is the state an adopted 1.0.0-dev.9 arc is
// wedged in: the startup below is the new executor's. Named tests: unwedge.recovery-holds-then-resume,
// unwedge.unpaused-runs-on, unwedge.spec-edit-and-reentry, unwedge.cut.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { consume, holdAbandoned, runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { recoveryContext } from './fixtures/rec-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, U1, applyBody, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

const command = async (r: ArcRun, body: CommandBody): Promise<void> => {
  const out = await applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.journal.view.arc, body));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
};
const stageOutcomes = (r: ArcRun) => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) =>
  (e.type === 'fact' && e.fact.kind === 'stage-outcome' ? [e.fact] : [] as Extract<Fact, { kind: 'stage-outcome' }>[]));
const specPath = (d: ArcDescriptor, unit: string): string => join(d.planPath, '..', `${unit}.json`);
const editPlan = (d: ArcDescriptor, edit: (plan: Json & { units: Json[] }) => void): void => {
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
  edit(plan);
  writeFileSync(d.planPath, JSON.stringify(plan));
};

/**
 * u1 killed in its build (attempt 2) right after the spawn intent, optionally paused, then the executor's startup: a new
 * `executor-started`, recovery, then each unit's recorded call consumed and anything else left open held (as
 * src/executor.ts `consumeRecovered`).
 */
async function crashedInBuild(paused: boolean): Promise<ArcRun> {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const trigger = writeTrigger(tmpDir('unwedge-crash'), { label: 'spawn.after-intent', occurrence: 2, unit: 'u1' });
  const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assertFired(trigger);
  const r = contextFor(d);
  assert.deepEqual(r.journal.view.unit(U1).open, { stage: 'build', attempt: 2, seq: r.journal.view.unit(U1).open?.seq }, 'the build attempt is open');
  if (paused) await command(r, { type: 'pause', target: { type: 'unit', unit: U1 } });
  // The fixture's start.json is generation 1, which the snapshot binds to the latest start.
  r.journal.fact({ kind: 'executor-started', generation: 1 });
  await recover(recoveryContext(r));
  assert.equal(await consume(r.ctx, r.unit('u1')), null, 'the build call was lost before its runner: nothing to consume');
  holdAbandoned(r.ctx, r.unit('u1'));
  return r;
}

/** What the startup's recovery hold leaves: the attempt closed, uncharged, nothing else of the unit moved. */
function assertRecoveryHold(r: ArcRun, status: 'held' | 'active'): void {
  const u = r.journal.view.unit(U1);
  assert.equal(u.status, status);
  assert.equal(u.open, null, 'no attempt is open');
  assert.deepEqual([u.decided?.stage, u.decided?.outcome, u.decided?.attempt], ['plan-check', 'approve', 1], 'the decision before is kept');
  assert.equal(u.interrupted, null, 'nothing to continue');
  assert.deepEqual([u.counters.chargeableFailures, u.counters.retries.build, u.counters.attempts], [0, 0, 2]);
  const last = stageOutcomes(r).at(-1);
  assert.deepEqual(last, { kind: 'stage-outcome', unit: 'u1', stage: 'build', attempt: 2, outcome: 'interrupted', class: 'hold', chargeable: false, cause: { type: 'recovery' } });
  holdAbandoned(r.ctx, r.unit('u1'));
  assert.equal(stageOutcomes(r).length, 2, 'a second pass records nothing');
}

describe('a crash-abandoned attempt is held at startup (arc feedback 2026-10-15)', () => {
  test('unwedge.recovery-holds-then-resume: a paused unit is held; `resume` releases it and the build runs again as a fresh round, then merges', T, async () => {
    const r = await crashedInBuild(true);
    try {
      assertRecoveryHold(r, 'held');
      await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } });
      assert.equal(r.journal.view.unit(U1).status, 'active');
      // The scenario's build step expects a fresh session (`exec -C`): a continue round would not match it.
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(outcomes(r.d).slice(0, 3), ['plan-check:approve', 'build:interrupted', 'build:success']);
    } finally {
      r.journal.close();
    }
  });

  test('unwedge.unpaused-runs-on: an unpaused unit stays active after the hold; its driver re-runs the build at once', T, async () => {
    const r = await crashedInBuild(false);
    try {
      assertRecoveryHold(r, 'active');
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    } finally {
      r.journal.close();
    }
  });

  test('unwedge.spec-edit-and-reentry: the held unit takes a spec revision (pending), then a re-entry under a new id supersedes it', T, async () => {
    const r = await crashedInBuild(true);
    try {
      assertRecoveryHold(r, 'held');
      const spec = JSON.parse(readFileSync(specPath(r.d, 'u1'), 'utf8')) as Json;
      const acceptance = [...(spec['acceptance'] as Json[]), { id: 'A2', clause: 'mul(0, 5) is 0', failLoudIfUndelivered: true, state: 'active' }];
      writeFileSync(specPath(r.d, 'u1'), JSON.stringify({ ...spec, rev: 2, acceptance }));
      await command(r, applyBody(r.d));
      assert.equal(r.journal.view.unit(U1).pendingRevision?.rev, 2);
      writeFileSync(specPath(r.d, 'u2'), JSON.stringify({ ...spec, unit: 'u2', rev: 1 }));
      editPlan(r.d, (p) => void p.units.push({ ...p.units[0]!, id: 'u2', spec: 'u2.json', reenters: { unit: 'u1' } }));
      await command(r, applyBody(r.d));
      assert.deepEqual([r.journal.view.unit(U1).status, r.journal.view.unit(U1).supersededBy], ['superseded', 'u2']);
    } finally {
      r.journal.close();
    }
  });

  test('unwedge.cut: the held unit is cut', T, async () => {
    const r = await crashedInBuild(true);
    try {
      assertRecoveryHold(r, 'held');
      editPlan(r.d, (p) => void (p.units[0]!['cut'] = { reason: 'superseded by a hand-built unit' }));
      await command(r, applyBody(r.d));
      assert.equal(r.journal.view.unit(U1).status, 'cut');
    } finally {
      r.journal.close();
    }
  });
});
