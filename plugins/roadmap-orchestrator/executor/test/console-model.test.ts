import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleModels, graphStatus, waitingCategory, waitingBreakdown, consoleModel } from '../src/console/model.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { arcId } from '../src/core/ids.ts';
import { parityArc, enrichedParityArc } from './fixtures/status-parity.ts';

test('every executor state maps truthfully; withdrawn work cannot count as passed', () => {
  assert.deepEqual((['merged', 'running', 'preparing', 'held', 'blocked', 'parked', 'waiting', 'ready', 'awaiting-admission', 'cut', 'superseded'] as const).map(graphStatus),
    ['passed', 'active', 'active', 'held', 'held', 'held', 'pending', 'pending', 'held', 'pending', 'pending']);
  assert.equal(waitingCategory('admission-hold:dependency'), 'queued');
  assert.equal(waitingCategory('admission-hold:host-pressure'), 'queued');
  assert.equal(waitingCategory('admission-hold:paused'), 'held');
  assert.equal(waitingCategory('named-resource:db'), 'queued');
});

test('waiting totals are allocated once, never summed from overlapping reasons; mixed totals stay unallocated', () => {
  assert.deepEqual(waitingBreakdown({ totalMs: 100, byReasonMs: { 'cpu-tokens': 100, 'named-resource:db': 100 } }, 'reservation'), { held: 0, queued: 100, unallocated: 0 });
  assert.deepEqual(waitingBreakdown({ totalMs: 100, byReasonMs: { 'admission-hold:paused': 100, 'admission-hold:dependency': 80 } }, 'admission'), { held: 0, queued: 0, unallocated: 100 });
  assert.deepEqual(waitingBreakdown({ totalMs: 40, byReasonMs: { 'admission-hold:paused': 40 } }, 'admission'), { held: 40, queued: 0, unallocated: 0 });
});

test('model uses explicit executor milestone gates and includes nonblocking owner attention', () => {
  const f = parityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const m = consoleModel(e);
  assert.equal(m.graph.units.length, 4);
  const gate = m.graph.units.find((u) => u.id.startsWith('milestone:'))!;
  assert.equal(gate.status, 'pending');
  assert.match(gate.meta, /gate/);
  assert.equal(m.attention.length, 1);
  assert.equal(m.attention[0]!.blocking, false);
  assert.equal(m.attention[0]!.summary, 'Review the plan');
  assert.equal(m.time.caption.includes('partial recorded effort'), true);
});

test('CPU uses recorded reservation and measured run/wall duration, never demand or synthetic peak', async () => {
  const f = await enrichedParityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const m = consoleModel(e);
  assert.equal(m.cpu.length, 2);
  assert.ok(m.cpu.every((r) => r.average === 80 / 120 && !('peak' in r)));
  assert.equal(m.time.rows.find((r) => r.id === 'u1')!.deterministic, 120);
  assert.ok(m.activities.every((r) => !('tests' in r) && !('startedAtMs' in r)));
  assert.ok(m.activities.filter((a) => a.unit === 'u1').every((a) => a.status === 'passed' && a.name.includes('pass')), 'pruned terminal results retain their recorded verdict and never appear queued');
});


test('completed reservations become actual resource bookings; release closes the interval, not a guessed queue start', async (t) => {
  const { reserve, transition, holderUnits } = await import('../src/resources/reserve.ts');
  const { DB, newRun, openPoolRun } = await import('./fixtures/pool-plan.ts');
  const { stageHolder, stageParent } = await import('./fixtures/res-plan.ts');
  const { unitId } = await import('../src/core/ids.ts');
  const { readJournal } = await import('../src/core/log.ts');
  const { completedWaiting } = await import('../src/status/waiting.ts');
  const f = parityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const { ctx, journal } = openPoolRun(newRun());
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const holder = stageHolder('lanes', 1, unitId('u1'));
    reserve(ctx, holder, { named: [DB], pools: [], cpu: 1, publication: false }, stageParent(holder), 120, { totalMs: 120, byReasonMs: { 'cpu-tokens': 120, 'named-resource:db': 120 } });
    t.mock.timers.tick(500);
    const resources = holderUnits(journal.view, holder);
    transition(ctx, holder, resources, { type: 'clean', from: 'reserved' }, stageParent(holder));
    transition(ctx, holder, resources, { type: 'release' }, stageParent(holder));
    const log = readJournal(ctx.runDir, journal.view.arc);
    const m = consoleModel({ ...e, data: { ...e.data, events: log.events } });
    const booking = m.resources.bookings.find((r) => r.resource === DB)!;
    assert.equal(booking.state, 'done'); assert.equal(booking.to! - booking.from, 0.5);
    assert.equal(booking.waitFrom, undefined, 'completed reservation waits do not invent historical queue-start timestamps');
    assert.equal(m.time.rows.find((r) => r.id === 'u1')!.queued, 120);
    assert.equal(completedWaiting(log.events).measurements[0]!.waited.totalMs, 120);
    // Projection of an ownership handover: a reclaim must close its predecessor, not leave two current bookings.
    const reclaimed = log.events.map((event) => event.type === 'intent' && event.kind === 'resource.transition' && event.expect.edge.type === 'clean'
      ? { ...event, expect: { ...event.expect, edge: { type: 'reclaim' as const } } } : event);
    const handover = consoleModel({ ...e, data: { ...e.data, events: reclaimed } }).resources.bookings.filter((r) => r.resource === DB);
    assert.equal(handover.length, 2); assert.ok(handover.every((r) => r.state === 'done'));
    assert.equal(handover[0]!.to, handover[1]!.from);
  } finally { journal.close(); }
});


test('stable graph, formatted activities and effort survive heartbeat-only checks while resource time advances', () => {
  const f = parityArc(); const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const models = new ConsoleModels(); const first = models.read(e);
  const later = models.read({ ...e, checkedAt: new Date(Date.parse(e.checkedAt) + 2000).toISOString() });
  assert.equal(later.graph, first.graph); assert.equal(later.time, first.time); assert.equal(later.activities, first.activities);
  assert.equal(Math.round((later.resources.now - first.resources.now) * 1000), 2000);
});

test('completed lane fixture is ready between stages despite unfinished-unit status active', async () => {
  const f = await enrichedParityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const unit = e.data.display.status.units.find(u => u.unit === 'u1')!;
  assert.equal(unit.status, 'active'); assert.equal(unit.stage, 'lanes'); assert.equal(unit.state, 'ready'); assert.equal(unit.running, null);
  assert.equal(consoleModel(e).graph.units.find(u => u.id === 'u1')!.status, 'pending');
});
