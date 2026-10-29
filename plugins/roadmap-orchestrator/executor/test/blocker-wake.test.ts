// Explicit dependency waits are re-evaluated after publication, without an owner command.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJournal } from '../src/core/log.ts';
import { arcId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { reached, release } from './helpers/barrier.ts';
import { startScheduler } from './fixtures/sched-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { MUL, codexStep, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';

test('blocker.merge-wakes-dependent: an explicit after wait proceeds at its blocker merge without resume or a checkpoint', { timeout: SCENARIO_TIMEOUT_MS }, async () => {
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    steps: [
      ...[planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'mul', files: MUL }, { type: 'barrier', name: 'blocker', timeoutMs: 60_000 }], { argv: ['exec', '-C'] }), gateStep({ decision: 'approve' })].map((s) => ({ ...s, unit: 'u1' })),
      ...[planCheckStep({ decision: 'approve' }), mulBuild({ 'src/dependent.js': 'export const ready = true;\n' }), gateStep({ decision: 'approve' })].map((s) => ({ ...s, unit: 'u2' })),
    ],
  });
  const r = contextFor(d);
  try {
    const scheduler = startScheduler(r);
    await reached(d.scenarioDir, 'blocker', 60_000);
    assert.deepEqual(outcomes(d, 'u2'), [], 'no stage is dispatched while its prerequisite is unmerged');
    release(d.scenarioDir, 'blocker');
    assert.deepEqual(await scheduler.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });
    const { events } = readJournal(absPath(d.runDir), arcId(d.arc));
    const merged = events.find((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === 'u1' && e.fact.stage === 'snapshot');
    const admitted = events.find((e) => e.type === 'intent' && e.parent.type === 'stage' && e.parent.unit === 'u2');
    assert.ok(merged !== undefined && admitted !== undefined && merged.seq < admitted.seq);
    assert.equal(events.some((e) => e.type === 'intent' && e.kind === 'command.apply'), false, 'no operator command was needed');
  } finally {
    r.journal.close();
  }
});
