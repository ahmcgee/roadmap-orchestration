import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphStatus, waitingCategory, waitingBreakdown, consoleModel } from '../src/console/model.ts';
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
});
