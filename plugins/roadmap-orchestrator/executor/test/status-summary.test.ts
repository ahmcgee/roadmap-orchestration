import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { arcId, laneId, unitId } from '../src/core/ids.ts';
import type { Event, StageOutcomeFact } from '../src/core/events.ts';
import { parseCommand } from '../src/input/cli.ts';
import { parsePlan } from '../src/input/plan.ts';
import { statusSummary, summarize } from '../src/status/summary.ts';
import { status } from '../src/status.ts';
import { absPath } from '../src/core/values.ts';
import { contextFor, setupArc } from './fixtures/unit-common.ts';
import { tmpDir } from './helpers/repo.ts';

const event = (fact: StageOutcomeFact): Event => ({ type: 'fact', fact }) as Event;

test('status summary golden: progress, expectations, caught and notices with no blocking budget policy', () => {
  const d = setupArc({ steps: [] });
  const plan = parsePlan({ ...JSON.parse(readFileSync(d.planPath, 'utf8')), expectations: { arcUsd: 10, perMilestoneUsd: 2 } });
  contextFor(d).journal.close();
  const s = status(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
  const events = [event({ kind: 'stage-outcome', unit: unitId('u1'), stage: 'gate', attempt: 1, outcome: 'revise', class: 'revise', chargeable: true })];
  events.push(...[
    { type: 'intent', kind: 'proc.spawn', op: 'golden/1', at: '2026-10-31T00:00:00.000Z', parent: { type: 'stage', unit: 'u1', stage: 'lanes', attempt: 1 },
      expect: { subject: { purpose: 'lane', unit: 'u1', lane: 'unit', set: 'spec', at: 'a'.repeat(40) } } },
    { type: 'done', kind: 'proc.spawn', op: 'golden/1', at: '2026-10-31T00:01:00.000Z', outcome: { kind: 'result', summary: { type: 'command', verdict: 'fail' } } },
    { type: 'fact', fact: { kind: 'finding-opened', key: 'first', lens: 'invariants' } },
    { type: 'fact', fact: { kind: 'finding-opened', key: 'second', lens: 'vacuity' } },
    { type: 'fact', fact: { kind: 'finding-opened', key: 'first', lens: 'invariants' } },
  ] as unknown as Event[]);
  for (let attempt = 1; attempt <= 8; attempt++) events.push(event({ kind: 'stage-outcome', unit: unitId('u1'), stage: 'build', attempt, outcome: 'success', class: 'advance', chargeable: false }));
  const summary = summarize({ ...s, arc: arcId('golden'), spend: { ...s.spend, byRole: [{ role: 'build', routingRev: '0123456789abcdef' as never, calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, turns: 1, costUsd: 12, unavailable: 0 }] } }, events, plan);
  assert.deepEqual(summary, JSON.parse(readFileSync(new URL('./fixtures/status-summary.golden.json', import.meta.url), 'utf8')));
  assert.deepEqual(summary.waste.map((f) => f.detector), ['grinding']);
  assert.deepEqual(parseCommand(['status', '--summary']), { command: 'status', run: { type: 'host' }, summary: true });
});

test('expectations are optional finite nonnegative USD and can be exceeded without a cap', () => {
  const d = setupArc({ steps: [] }); const raw = JSON.parse(readFileSync(d.planPath, 'utf8'));
  assert.equal(parsePlan(raw).expectations, undefined);
  assert.deepEqual(parsePlan({ ...raw, expectations: { arcUsd: 0 } }).expectations, { arcUsd: 0 });
  for (const n of [-1, Infinity, '2']) assert.throws(() => parsePlan({ ...raw, expectations: { arcUsd: n } }));
});

test('status --summary reads expectations from the recorded plan and bounds the feed to the status snapshot', () => {
  const d = setupArc({ steps: [] });
  writeFileSync(d.planPath, JSON.stringify({ ...JSON.parse(readFileSync(d.planPath, 'utf8')), expectations: { arcUsd: 5, perMilestoneUsd: 1 } }));
  contextFor(d).journal.close();
  const summary = statusSummary(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
  assert.equal(summary.planRev, 1); assert.equal(summary.progress.total, 1);
  assert.equal(summary.spend.expectedUsd, 5); assert.equal(summary.spend.differenceUsd, -5); assert.equal(summary.spend.costUsd, 0);
});

test('waiting totals by unit and job stage are shared by summary and full status', async () => {
  const { reserve } = await import('../src/resources/reserve.ts');
  const { jobId } = await import('../src/core/ids.ts');
  const d = setupArc({ steps: [] }); const r = contextFor(d);
  const { git } = await import('./helpers/repo.ts');
  git(d.repo, 'update-ref', `refs/heads/roadmap/${d.arc}/u1`, git(d.repo, 'rev-parse', 'main'));
  const measured = { totalMs: 30, byReasonMs: { 'cpu-tokens': 30, 'memory-pressure': 20 } } as const;
  reserve(r.ctx, { type: 'stage', unit: unitId('u1'), stage: 'lanes', attempt: 1 }, { named: [], pools: [], cpu: 1, publication: false }, { type: 'stage', unit: unitId('u1'), stage: 'lanes', attempt: 1 }, 30, measured);
  reserve(r.ctx, { type: 'job', job: jobId('audit', 1) }, { named: [], pools: [], cpu: 1, publication: false }, { type: 'job', job: jobId('audit', 1) }, 30, measured);
  r.journal.fact({ kind: 'stage-admitted', unit: unitId('u1'), stage: 'lanes', waited: { totalMs: 10, byReasonMs: { 'admission-hold:baseline': 10 } } });
  r.journal.close();
  const full = status(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
  const summary = statusSummary(absPath(d.runDir), arcId(d.arc), absPath(d.hostDir));
  assert.deepEqual(full.waiting, { unmeasuredReservations: 0, byUnitStage: [{ unit: 'u1', stage: 'lanes', totalMs: 40, byReasonMs: { 'cpu-tokens': 30, 'memory-pressure': 20, 'admission-hold:baseline': 10 } }], byJobStage: [{ job: 'audit-1', stage: 'audit', ...measured }] });
  assert.deepEqual(summary.waiting, full.waiting);
});
