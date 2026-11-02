import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fact } from '../src/core/events.ts';
import { jobId } from '../src/core/ids.ts';
import { jobStageOutcome } from '../src/stageoutcome.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';

test('job stage-outcome shape keeps verdict and severity counts outside the unit state machine', () => {
  const outcome = { kind: 'stage-outcome', stage: 'experience-verdict', job: 'walk-1', milestone: 'MS-1', verdict: 'revise', findings: { P1: 1, P2: 2, P3: 0, total: 3 } };
  assert.deepEqual(fact(outcome, 'f'), outcome);
  assert.throws(() => fact({ ...outcome, findings: { ...outcome.findings, total: 4 } }, 'f'), /severity counts/);
  assert.deepEqual(fact({ ...outcome, stage: 'campaign-audit', job: 'audit-1', milestone: null }, 'f'), { ...outcome, stage: 'campaign-audit', job: 'audit-1', milestone: null });
});
test('campaign outcomes are idempotent across replay and never create unit attempts', () => {
  const d = setupArc({ steps: [] }); const r = contextFor(d);
  try {
    jobStageOutcome(r.journal, jobId('audit', 1), 'campaign-audit', null, 'pass', []);
    jobStageOutcome(r.journal, jobId('audit', 1), 'campaign-audit', null, 'pass', []);
    assert.deepEqual(r.journal.view.stageJobOutcomes(), [{ kind: 'stage-outcome', stage: 'campaign-audit', job: jobId('audit', 1), milestone: null, verdict: 'pass', findings: { P1: 0, P2: 0, P3: 0, total: 0 } }]);
    assert.deepEqual(r.journal.view.plannedUnits().map((u) => r.journal.view.unit(u).counters.attempts), [0]);
  } finally { r.journal.close(); }
});
