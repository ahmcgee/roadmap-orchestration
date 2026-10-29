// Actual operator-design parks with structured ordering waits, recovered by the real scheduler after publication.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderingReasons } from '../src/park/ordering.ts';
import { Fold } from '../src/core/state.ts';
import { type Event, prevHash, serializeEvent } from '../src/core/events.ts';
import { readJournal } from '../src/core/log.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { step } from '../src/pipeline/unit.ts';
import { reached, release } from './helpers/barrier.ts';
import { until } from './fixtures/exec-common.ts';
import { startScheduler, stopScheduler } from './fixtures/sched-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { MUL, codexStep, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const U2 = unitId('u2');

for (const stage of ['plan-check', 'gate'] as const) {
  test(`blocker.${stage}: an adopted ordering park wakes only after all blockers merge; an unrelated design park stays parked`, T, async () => {
    const ordering = { blockers: ['u1', 'u3'] };
    const escalation = () => stage === 'plan-check' ? planCheckStep({ decision: 'infeasible', ordering }) : gateStep({ decision: 'escalate', ordering });
    const d = setupArc({
      units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', after: ['u1'] }, { id: 'u4' }],
      steps: [
        ...[planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'mul', files: MUL }, { type: 'barrier', name: 'first', timeoutMs: 60_000 }], { argv: ['exec', '-C'] }), gateStep({ decision: 'approve' })].map((s) => ({ ...s, unit: 'u1' })),
        ...[planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'second', files: { 'src/second.js': 'export const second = true;\n' } }, { type: 'barrier', name: 'second', timeoutMs: 60_000 }], { argv: ['exec', '-C'] }), gateStep({ decision: 'approve' })].map((s) => ({ ...s, unit: 'u3' })),
        ...[
          ...(stage === 'gate' ? [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/dependent.js': 'export const ready = true;\n' })] : []),
          escalation(), escalation(),
          ...(stage === 'plan-check' ? [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/dependent.js': 'export const ready = true;\n' })] : []),
          gateStep({ decision: 'approve' }),
        ].map((s) => ({ ...s, unit: 'u2' })),
        ...[1, 2].map(() => ({ ...planCheckStep({ decision: 'infeasible', notes: 'u1 and u3 might help, but this is not a declared ordering wait' }), unit: 'u4' })),
      ],
    });
    // Start from real parked stages, then reopen the journal as an adopting executor would.
    const initial = contextFor(d);
    for (const id of ['u2', 'u4']) {
      for (let attempt = 0; initial.journal.view.unit(unitId(id)).status !== 'park-pending'; attempt++) {
        assert.ok(attempt < 20, `${id} must park within its scripted stages`);
        const result = await step(initial.ctx, initial.unit(id));
        assert.ok(result.kind === 'continue' || result.kind === 'parked', JSON.stringify(result));
      }
    }
    const parkSeq = initial.journal.view.unit(U2).park!.seq;
    assert.deepEqual(initial.journal.view.unit(U2).park!.park, { class: 'operator', kind: 'design', ordering });
    // A fresh fold rejects a premature or stale automatic wake before it can restore the stage.
    const recorded = readJournal(absPath(d.runDir), arcId(d.arc)).events;
    for (const [seq, message] of [[parkSeq, /before all ordering blockers merged/], [parkSeq + 1, /current ordering park/]] as const) {
      const fold = new Fold(arcId(d.arc));
      for (const event of recorded) fold.apply(event, prevHash(Buffer.from(serializeEvent(event))));
      const last = recorded.at(-1)!;
      const event: Event = { ...last, seq: last.seq + 1, prev: prevHash(Buffer.from(serializeEvent(last))), type: 'fact',
        fact: { kind: 'unparked', unit: U2, command: null, parkSeq: seq } };
      assert.throws(() => fold.apply(event, prevHash(Buffer.from(serializeEvent(event)))), message);
    }
    initial.journal.close();
    const r = contextFor(d);
    try {
      assert.equal(r.journal.view.unit(U2).park?.seq, parkSeq, 'adoption retains the exact ordering park');
      const scheduler = startScheduler(r);
      await reached(d.scenarioDir, 'first', 60_000);
      assert.equal(r.journal.view.unit(U2).status, 'park-pending');
      const before = outcomes(d, 'u2');
      release(d.scenarioDir, 'first');
      await reached(d.scenarioDir, 'second', 60_000);
      assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired');
      assert.equal(r.journal.view.unit(U2).status, 'park-pending', 'one merge is insufficient');
      assert.deepEqual(outcomes(d, 'u2'), before, 'no new attempt before the last blocker merges');
      release(d.scenarioDir, 'second');
      await until(() => r.journal.view.unit(U2).status === 'retired', 60_000, 'the woken unit to merge');
      assert.equal((await stopScheduler(r, scheduler)).kind, 'stop');
      assert.equal(r.journal.view.unit(U2).status, 'retired');
      assert.equal(r.journal.view.unit(unitId('u4')).status, 'park-pending', 'prose or an unrelated park never causes a wake');
      const { events } = readJournal(absPath(d.runDir), arcId(d.arc));
      const wakes = events.filter((e) => e.type === 'fact' && e.fact.kind === 'unparked');
      assert.equal(wakes.length, 1);
      const wake = wakes[0]!;
      assert.ok(wake.type === 'fact');
      assert.deepEqual(wake.fact, { kind: 'unparked', unit: 'u2', command: null, parkSeq });
      for (const id of ordering.blockers) {
        const merged = events.find((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === id && e.fact.stage === 'snapshot');
        assert.ok(merged !== undefined && merged.seq < wake.seq);
      }
      const retried = events.find((e) => e.seq > wake.seq && e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === 'u2');
      assert.ok(retried?.type === 'fact' && retried.fact.kind === 'stage-outcome' && retried.fact.stage === stage, 'the normal transition retries the parked stage');
      assert.equal(events.some((e) => e.seq < wake.seq && e.type === 'intent' && e.kind === 'command.apply'), false, 'no operator resume');
      assert.equal(events.some((e) => e.type === 'fact' && e.fact.kind === 'checkpoint-inputs'), false, 'no checkpoint needed');
    } finally { r.journal.close(); }
  });
}

test('ordering blockers must be known, different from the parked unit, and acyclic with plan dependencies', () => {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }] });
  const r = contextFor(d);
  try {
    const u1 = unitId('u1');
    assert.match(orderingReasons(r.ctx, u1, { blockers: [u1] }).join(';'), /itself/);
    assert.match(orderingReasons(r.ctx, u1, { blockers: [unitId('unknown')] }).join(';'), /not a unit/);
    assert.match(orderingReasons(r.ctx, u1, { blockers: [U2] }).join(';'), /cycle/);
    assert.deepEqual(orderingReasons(r.ctx, U2, { blockers: [u1] }), []);
  } finally { r.journal.close(); }
});
