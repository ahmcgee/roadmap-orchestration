// M4b rev 3: cpu wait (src/host/pressure.ts): a thread's and the host's schedstat parsed, a launch's pressure from its
// cpu totals, a real workload's wait read through its process tree, the host's pressure over the tick history, and
// this host's files read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { statOf } from '../src/contain/proc.ts';
import {
  HOST_WINDOW_MS, PRESSURE_MIN_WALL_MS, PRESSURE_SATURATED, PRESSURE_TICKS_MS, type PressureTick, PressureTicks, STARVED_MAX, WorkloadCpu,
  hostPressure, launchPressure, parseHostSchedstat, parseTaskSchedstat, pressureAvailability, readHostCpu, readHostCpuAt,
} from '../src/host/pressure.ts';
import { tmpDir } from './helpers/repo.ts';

const SCHEDSTAT = [
  'version 17', 'timestamp 4788975902',
  'cpu0 0 0 0 0 0 0 1000 3000 786583281', 'domain0 SMT 0003 0 0 0 0',
  'cpu1 0 0 0 0 0 0 2000 4000 12', 'domain0 SMT 0003 0 0 0 0', '',
].join('\n');
const tick = (atMs: number, runNs: number, waitNs: number): PressureTick => ({ atMs, runNs, waitNs });

describe('pressure.parse', () => {
  it('a thread\'s schedstat: ns on a cpu, ns waiting; anything else refused', () => {
    assert.deepEqual(parseTaskSchedstat('p', '83596 120 1\n'), { runNs: 83596, waitNs: 120 });
    for (const bad of ['', '1 2\n', 'a 2 3\n', '1 2 3 4\n']) assert.throws(() => parseTaskSchedstat('p', bad), /^Error: p: /, JSON.stringify(bad));
  });
  it('the host\'s schedstat: fields 7 and 8 of each cpu line, summed; an old version, no cpu line or a short one refused', () => {
    assert.deepEqual(parseHostSchedstat(SCHEDSTAT), { runNs: 3000, waitNs: 7000 });
    for (const bad of ['cpu0 0 0 0 0 0 0 1 2 3\n', 'version 14\ncpu0 0 0 0 0 0 0 1 2 3\n', 'version 17\n', 'version 17\ncpu0 0 0 0 0 0 0 1\n']) {
      assert.throws(() => parseHostSchedstat(bad), /\/proc\/schedstat/, JSON.stringify(bad));
    }
  });
});

describe('pressure.launch', () => {
  it('is wait over the larger of wall and run + wait: a cpu-bound launch\'s runnable share, an idle one\'s wall share', () => {
    assert.equal(launchPressure({ wallMs: 10_000, runMs: 4_000, waitMs: 6_000 }), 0.6);
    assert.equal(launchPressure({ wallMs: 10_000, runMs: 30_000, waitMs: 10_000 }), 0.25, 'parallel: the share of runnable time');
    assert.equal(launchPressure({ wallMs: 60_000, runMs: 100, waitMs: 900 }), 0.015, 'a sleeping launch is not starved however its start-up waited');
    assert.equal(launchPressure({ wallMs: PRESSURE_MIN_WALL_MS, runMs: 0, waitMs: 0 }), 0);
  });
  it('is null without a reading or under the minimum wall time (its reading is its start-up)', () => {
    assert.equal(launchPressure(null), null);
    assert.equal(launchPressure({ wallMs: PRESSURE_MIN_WALL_MS - 1, runMs: 100, waitMs: 900 }), null);
  });
  it('the constants of RC-10 and RC-11', () => {
    assert.deepEqual([PRESSURE_SATURATED, PRESSURE_MIN_WALL_MS, STARVED_MAX], [0.5, 5_000, 3]);
  });
  it('a real workload: its tree\'s threads are read, a busy one\'s run grows, the totals keep a reading past the process', async () => {
    // 400 ms of cpu time (not wall time: on a busy host the loop waits for a cpu), then idle.
    const busy = 'while (process.cpuUsage().user < 400_000) {} require("node:fs").writeFileSync(process.argv[1], "done"); setTimeout(() => {}, 30_000)';
    const marker = join(tmpDir('pressure-busy'), 'done');
    const child = spawn(process.execPath, ['-e', busy, marker], { stdio: 'ignore' });
    try {
      for (const end = Date.now() + 60_000; !existsSync(marker); await sleep(50)) assert.ok(Date.now() < end, 'the busy loop ended within a minute');
      const stat = statOf(child.pid!);
      assert.ok(stat !== null);
      const cpu = new WorkloadCpu();
      cpu.observeTree({ pid: child.pid!, start: stat.start });
      const t = cpu.total(1_000);
      assert.ok(t.runMs >= 300, `the busy loop ran on a cpu: ${JSON.stringify(t)}`);
      child.kill('SIGKILL');
      await sleep(100);
      cpu.observeTree({ pid: child.pid!, start: stat.start });
      assert.deepEqual(cpu.total(1_000), t, 'a gone process keeps its last reading');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('pressure.host', () => {
  it('is the wait share between the newest tick and the latest one a window before it, since the given time', () => {
    const ticks = [tick(0, 0, 0), tick(30_000, 100, 100), tick(60_000, 200, 200), tick(90_000, 400, 200)];
    assert.equal(hostPressure(ticks, 0), 0.25, 'newest less the 30 s tick: run 300, wait 100');
    assert.equal(hostPressure(ticks, 31_000), null, 'the ticks since 31 s span less than the window');
    assert.equal(hostPressure([], 0), null);
    assert.equal(hostPressure([tick(0, 5, 5), tick(HOST_WINDOW_MS, 5, 5)], 0), 0, 'an idle host');
  });
  it('the ticks keep each available reading, newest last, for PRESSURE_TICKS_MS, and refuse totals going back', () => {
    const t = new PressureTicks();
    t.record(tick(1_000, 1, 1));
    t.record('unavailable');
    t.record(tick(3_000, 2, 2));
    assert.deepEqual(t.ticks(), [tick(1_000, 1, 1), tick(3_000, 2, 2)]);
    t.record(tick(2_000 + PRESSURE_TICKS_MS, 3, 3));
    assert.deepEqual(t.ticks(), [tick(3_000, 2, 2), tick(2_000 + PRESSURE_TICKS_MS, 3, 3)]);
    assert.throws(() => t.record(tick(3_000 + PRESSURE_TICKS_MS, 2, 3)), /went back/);
  });
});

describe('pressure.read', () => {
  it('absent files are unavailable; present malformed ones fail loud', () => {
    const dir = tmpDir('pressure');
    assert.equal(readHostCpuAt(join(dir, 'none'), 0), 'unavailable');
    assert.equal(pressureAvailability(join(dir, 'none')), 'unavailable');
    writeFileSync(join(dir, 'garbage'), 'garbage\n');
    assert.throws(() => readHostCpuAt(join(dir, 'garbage'), 0), /version/);
    writeFileSync(join(dir, 'schedstat'), SCHEDSTAT);
    assert.deepEqual(readHostCpuAt(join(dir, 'schedstat'), 7), tick(7, 3000, 7000));
  });
  it('reads this host\'s /proc/schedstat (totals only grow)', () => {
    assert.equal(pressureAvailability(), 'available', 'this host reports schedstat');
    const a = readHostCpu();
    const b = readHostCpu();
    assert.ok(a !== 'unavailable' && b !== 'unavailable');
    assert.ok(b.runNs >= a.runNs && b.waitNs >= a.waitNs && b.atMs >= a.atMs);
  });
});
