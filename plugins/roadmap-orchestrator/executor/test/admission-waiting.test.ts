import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { arcId } from '../src/core/ids.ts';
import { startScheduler, submit, receiptOf } from './fixtures/sched-common.ts';
import { setupArc, contextFor, commandContextFor, mulBuild, gateStep } from './fixtures/unit-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';

test('admission waits are recorded at stage start, including a unit never started under pause', { timeout: 180_000 }, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    const pause = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'pause', target: { type: 'all' } });
    await applyCommand(commandContextFor(r), pause);
    const scheduled = startScheduler(r);
    await sleep(200);
    const before = readJournal(absPath(d.runDir), arcId(d.arc));
    assert.equal(before.view.unit(r.ctx.plan().units[0]!.id).counters.attempts, 0);
    assert.equal(before.events.some((e) => e.type === 'fact' && e.fact.kind === 'stage-admitted'), false);
    await receiptOf(r, submit(r, { type: 'resume', target: { type: 'all' } }));
    assert.equal((await scheduled.end).kind, 'complete');
    const admissions = readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => e.type === 'fact' && e.fact.kind === 'stage-admitted' ? [e.fact] : []);
    assert.equal(admissions[0]?.stage, 'pre-build');
    assert.ok(admissions[0]!.waited.totalMs >= 200);
    assert.ok(admissions[0]!.waited.byReasonMs['admission-hold:paused']! >= 200);
    assert.equal(admissions.filter((a) => a.stage === 'pre-build').length, 1);
  } finally { r.journal.close(); }
});

test('review.sched-json-marks-compound-publication-wait', { timeout: 180_000 }, async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { unitId, INTEGRATION_SLOT } = await import('../src/core/ids.ts');
  const { reserve, transition } = await import('../src/resources/reserve.ts');
  const { stepUntil } = await import('./fixtures/unit-common.ts');
  const { until } = await import('./fixtures/exec-common.ts');
  const { stopScheduler } = await import('./fixtures/sched-common.ts');
  const r = contextFor(setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] }));
  let scheduled: ReturnType<typeof startScheduler> | null = null;
  let finished = false;
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
    const holder = { type: 'publication', unit: unitId('blocker'), attempt: 1 } as const;
    const parent = { type: 'stage', unit: holder.unit, stage: 'candidate', attempt: 1 } as const;
    reserve(r.ctx, holder, { named: [], pools: [], cpu: 0, publication: true }, parent);
    scheduled = startScheduler(r);
    const path = join(r.ctx.runDir, 'sched.json');
    let row: { publication: boolean; request: { publication: boolean }; reasons: string[] } | undefined;
    await until(() => {
      if (!existsSync(path)) return false;
      row = JSON.parse(readFileSync(path, 'utf8')).queue.find((q: { unit: string }) => q.unit === 'u1');
      return row !== undefined;
    }, 20_000, 'compound candidate queued behind the slot');
    assert.equal(row!.request.publication, true);
    assert.equal(row!.publication, true, 'the derived sched row exposes the compound publication wait');
    assert.ok(row!.reasons.includes('publication-slot'));
    transition(r.ctx, holder, [INTEGRATION_SLOT], { type: 'clean', from: 'reserved' }, parent);
    transition(r.ctx, holder, [INTEGRATION_SLOT], { type: 'release' }, parent);
    assert.equal((await scheduled.end).kind, 'complete'); finished = true;
  } finally {
    if (scheduled !== null && !finished) await stopScheduler(r, scheduled);
    r.journal.close();
  }
});
