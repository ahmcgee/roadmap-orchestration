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
