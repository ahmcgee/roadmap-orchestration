import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostPressure, memoryPressure, pressureHoldWaits } from '../src/host/pressure.ts';
import { isClear } from '../src/host/sample.ts';
import { killEvidence, oomForPid } from '../src/host/diagnostics.ts';

test('memory pressure holds admissions on an otherwise idle CPU, and releases after recovery', () => {
  assert.equal(memoryPressure(0.04, null), 0.5);
  assert.equal(memoryPressure(0.8, 'some avg10=90.00 avg60=0 avg300=0 total=1\nfull avg10=75.00 avg60=0 avg300=0 total=1\n'), 0.75);
  const ticks = [{ atMs: 0, runNs: 0, waitNs: 0 }, { atMs: 60000, runNs: 1000, waitNs: 0, memory: 0.5 }];
  assert.equal(hostPressure(ticks, 0), 0.5); assert.equal(pressureHoldWaits(0, { ticks, nowMs: 60000 }), true);
  assert.equal(pressureHoldWaits(0, { ticks: [...ticks, { atMs: 120000, runNs: 2000, waitNs: 0, memory: 0 }], nowMs: 120000 }), false);
  assert.equal(isClear({ load1: 0, cpus: 8, memAvailableKb: 1, memTotalKb: 100 }), false);
});
test('SIGKILL diagnostics attribute OOM only to matching kernel evidence and record readable or unavailable pressure', () => {
  assert.deepEqual(oomForPid('Out of memory: Killed process 123 (node)\nOut of memory: Killed process 1234 (node)', 123), ['Out of memory: Killed process 123 (node)']);
  assert.deepEqual(oomForPid('some unrelated pid=123', 123), []);
  const evidence = killEvidence(2147483647, null, false);
  assert.equal(evidence.cause, 'external-unknown');
  for (const r of Object.values(evidence.pressure)) assert.ok(r.kind === 'readable' || r.kind === 'unavailable');
  assert.equal(killEvidence(2147483647, null, true).cause, 'supervisor-watchdog');
});
