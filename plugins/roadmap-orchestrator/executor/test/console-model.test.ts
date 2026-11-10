import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphStatus } from '../src/console/signals.ts';
import { waitingCategory, waitingBreakdown } from '../src/console/waiting.ts';
import { ConsoleViews, graphView, arcBounds } from '../src/console/views.ts';
import { ConsoleMetadata } from '../src/console/metadata.ts';
import { effortRows, timelineIntervals, attentionSummaries, bookingSummaries, cpuSummaries } from '../src/console/tab-projections.ts';
import { graphData } from '../web-src/app/graph-data.ts';
import { invocationSummaries } from '../src/console/details.ts';
import { ConsoleEffort } from '../src/console/effort-query.ts';
import { ConsoleResources } from '../src/console/resource-query.ts';
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

test('typed views use explicit executor milestone gates and include nonblocking owner attention', () => {
  const f = parityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const graph = graphView(e), attention = attentionSummaries(e);
  assert.equal(graph.units.length + graph.milestones.length, 4);
  const gate = graph.milestones[0]!;
  assert.equal(gate.passed, false);
  assert.equal(graphData({...e,data:graph}).graph.units.find(u=>u.id===`milestone:${gate.id}`)!.status,'pending');
  assert.equal(gate.state,e.data.display.status.milestones[0]!.state);
  assert.ok(graph.edges.some(edge => edge.kind === 'feeds' && edge.target === `milestone:${gate.id}`), 'explicit milestone gate');
  assert.equal(attention.length, 1);
  assert.equal(attention[0]!.blocking, false);
  assert.equal(attention[0]!.summary.text, 'Review the plan');
  const effort = new ConsoleEffort().read(e,{window:'arc'});
  assert.equal(effort.rows.filter(r => r.subject.type === 'unit').length, e.data.display.status.units.length);
  assert.equal(effort.totals.agentMs,null);assert.equal(effort.totals.commandMs,null);
  assert.equal(effort.totals.coverage.execution.measured,0,'partial recorded effort exposes measurement coverage, not invented wall coverage');
  assert.equal(effort.scope.basis,'recorded-arc');
});

test('CPU uses recorded reservation and measured run/wall duration, never demand or synthetic peak', async () => {
  const f = await enrichedParityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const work = [...e.data.display.status.host.work,...e.data.display.status.units.flatMap(u=>u.work)].filter(w=>w.reservedCpu!==null||w.measured!==null);
  assert.equal(work.length, 2);
  assert.ok(work.every(r => r.measured!.runMs / r.measured!.wallMs === 80 / 120 && !('peak' in r)));
  const groups=cpuSummaries(e),cpu=groups.filter(r=>r.measuredCalls>0||r.unreservedCalls>0);assert.equal(cpu.length,2);
  assert.equal(groups.find(r=>r.parent.type==='job')!.unmeasuredCalls,1);assert.ok(cpu.every(r=>r.unreservedAverageCores===80/120&&!('peak' in r)));
  assert.equal(effortRows(e).find(r => r.subject.id === 'u1')!.commandMs, 120);
  assert.equal(new ConsoleEffort().read(e,{window:'arc',unit:'u1'}).totals.commandMs,120);
  const intervals = timelineIntervals(e);
  assert.ok(intervals.every(r => !('tests' in r) && !('startedAtMs' in r)));
  assert.ok(invocationSummaries(e).filter(a=>a.unit==='u1').every(a=>a.status==='passed'&&a.outcome.includes('pass')));
  assert.ok(intervals.filter(a => a.subject.id === 'u1').every(a => a.outcome === 'pass'), 'pruned terminal results retain their recorded verdict and never appear queued');
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
    const captured = { ...e, data: { ...e.data, events: log.events } };
    const booking = bookingSummaries(log.events).find((r) => r.resource === DB)!;
    assert.equal(booking.state, 'done'); assert.equal((Date.parse(booking.endedAt!) - Date.parse(booking.startedAt)) / 1000, 0.5);
    assert.equal((booking as unknown as {waitFrom?:number}).waitFrom, undefined, 'completed reservation waits do not invent historical queue-start timestamps');
    assert.equal(effortRows(captured).find(r=>r.subject.id==='u1')!.queuedMs, 120);
    assert.equal(completedWaiting(log.events).measurements[0]!.waited.totalMs, 120);
    // Projection of an ownership handover: a reclaim must close its predecessor, not leave two current bookings.
    const reclaimed = log.events.map((event) => event.type === 'intent' && event.kind === 'resource.transition' && event.expect.edge.type === 'clean'
      ? { ...event, expect: { ...event.expect, edge: { type: 'reclaim' as const } } } : event);
    const handover = bookingSummaries(reclaimed).filter((r) => r.resource === DB);
    assert.equal(handover.length, 2); assert.ok(handover.every((r) => r.state === 'done'));
    assert.equal(handover[0]!.endedAt, handover[1]!.startedAt);
  } finally { journal.close(); }
});


test('stable graph, formatted activities and effort survive heartbeat-only checks while resource time advances', () => {
  const f = parityArc(); const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const views = new ConsoleViews(), metadata = new ConsoleMetadata(), first = metadata.read(e, views, e.arc);
  const laterEnvelope = {...e, checkedAt:new Date(Date.parse(e.checkedAt)+2000).toISOString()};
  const later = metadata.read(laterEnvelope, views, e.arc);
  assert.equal(views.graph(laterEnvelope), views.graph(e));
  assert.equal(later.viewVersions.effort, first.viewVersions.effort); assert.equal(later.viewVersions.timeline, first.viewVersions.timeline);
  assert.deepEqual(effortRows(laterEnvelope), effortRows(e)); assert.deepEqual(timelineIntervals(laterEnvelope), timelineIntervals(e));
  const resources=new ConsoleResources(), original=resources.read(e,{window:'arc'}), checked=resources.read(laterEnvelope,{window:'arc'});
  assert.equal(Date.parse(checked.bounds.to)-Date.parse(original.bounds.to),2000);
  assert.equal(Date.parse(later.checkedAt)-Date.parse(first.checkedAt),2000);
  assert.equal(arcBounds(laterEnvelope).from, arcBounds(e).from);
});

test('completed lane fixture is ready between stages despite unfinished-unit status active', async () => {
  const f = await enrichedParityArc();
  const e = new ObservationCache(f.hostDir, 'i', 'r').read({ runDir: f.runDir, arc: arcId(f.d.arc) });
  const unit = e.data.display.status.units.find(u => u.unit === 'u1')!;
  assert.equal(unit.status, 'active'); assert.equal(unit.stage, 'lanes'); assert.equal(unit.state, 'ready'); assert.equal(unit.running, null);
  assert.equal(graphView(e).units.find(u => u.id === 'u1')!.signal, 'pending');
});
