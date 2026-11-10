import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArbiter } from '../src/schedule/arbiter.ts';
import { reserve, holderUnits, transition } from '../src/resources/reserve.ts';
import { DB, newRun, openPoolRun } from './fixtures/pool-plan.ts';
import { stageHolder, stageParent } from './fixtures/res-plan.ts';
import { unitId } from '../src/core/ids.ts';
import type { ResourceRequest, Rank } from '../src/schedule/types.ts';

const request = (r: Partial<ResourceRequest>): ResourceRequest => ({ cpu: 0, named: [], pools: [], publication: false, ...r });
const rank = (unit: string): Rank => ({ unit: unitId(unit), priority: 'normal', origin: 'planned', waitStartSeq: 1, bypassMerges: 0, promoted: false, planIndex: 0 });
const holder = (unit: string) => stageHolder('lanes', 1, unitId(unit));

test('reasons accumulate per tick and change; simultaneous blockers are non-additive', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { ctx, journal } = openPoolRun(newRun());
  try {
    const cpu = holder('cpu'); const named = holder('named'); const waiter = holder('waiter');
    reserve(ctx, cpu, request({ cpu: 4 }), stageParent(cpu));
    reserve(ctx, named, request({ named: [DB] }), stageParent(named));
    const arb = createArbiter(ctx);
    const granted = arb.acquire(request({ cpu: 1, named: [DB] }), waiter, () => rank('waiter'), new AbortController().signal);
    t.mock.timers.tick(100); arb.wake();
    const release = (h: typeof cpu) => {
      const units = holderUnits(journal.view, h);
      transition(ctx, h, units, { type: 'clean', from: 'reserved' }, stageParent(h));
      transition(ctx, h, units, { type: 'release' }, stageParent(h));
    };
    release(cpu); arb.wake();
    t.mock.timers.tick(200); arb.wake();
    release(named); arb.wake();
    assert.equal((await granted).kind, 'granted');
    const intent = journal.view.opsOf('resource.transition').find((i) => i.expect.holder.type === 'stage' && i.expect.holder.unit === waiter.unit && i.expect.edge.type === 'reserve')!;
    assert.deepEqual(intent.expect.waited, { totalMs: 300, byReasonMs: { 'cpu-tokens': 100, 'named-resource:db': 300 } });
  } finally { journal.close(); }
});

test('immediate grant is measured zero; cancellation records no grant', async () => {
  const { ctx, journal } = openPoolRun(newRun());
  try {
    const arb = createArbiter(ctx); const h = holder('instant');
    assert.equal((await arb.acquire(request({ named: [DB] }), h, () => rank('instant'), new AbortController().signal)).kind, 'granted');
    assert.deepEqual(journal.view.opsOf('resource.transition')[0]!.expect.waited, { totalMs: 0, byReasonMs: {} });
    const abort = new AbortController();
    const cancelled = arb.acquire(request({ named: [DB] }), holder('cancel'), () => rank('cancel'), abort.signal);
    abort.abort();
    assert.equal((await cancelled).kind, 'cancelled');
    assert.equal(journal.view.opsOf('resource.transition').length, 1);
  } finally { journal.close(); }
});
