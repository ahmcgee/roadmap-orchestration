import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PressureTicks, hostPressure, memoryPressure } from '../src/host/pressure.ts';
import * as readings from '../src/host/pressure.ts';

test('CPU window and latest memory remain independent, including unavailable schedstat', () => {
  assert.equal(typeof readings.hostCpuPressure, 'function', 'CPU evidence has an independent projection');
  const pressure = new PressureTicks();
  pressure.record('unavailable');
  pressure.recordMemory(memoryPressure(0.01, null));
  assert.equal(pressure.memory(), 0.5);
  assert.equal(readings.hostCpuPressure(pressure.ticks(), 0), null);
  assert.equal(hostPressure(pressure.ticks(), 0, pressure.memory()), 0.5);
  pressure.record({ atMs: 0, runNs: 0, waitNs: 0, memory: 0.8 });
  pressure.record({ atMs: 60_000, runNs: 100, waitNs: 0, memory: 0.8 });
  assert.equal(readings.hostCpuPressure(pressure.ticks(), 0), 0);
  assert.equal(hostPressure(pressure.ticks(), 0), 0.8);
  pressure.recordMemory(0);
  assert.equal(pressure.memory(), 0);
});
