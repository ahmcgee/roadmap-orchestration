// dev.76: an idle executor's tick costs near nothing while nothing changes. The field arc (134k events, 683 obligations,
// 2,568 witness records, ~310 terminal commands) spent seconds a tick re-reading, re-hashing and re-parsing the same kept
// inputs, witness records and receipts, every second, with every unit paused. Here, over real arcs under the scheduler (real
// git, the fake witness lanes): an arc of that shape in small (many obligations over many arc lanes, each witnessed by
// the baseline; several units; many terminal commands), every unit paused and nothing running, ticks with no kept input,
// witness record or terminal receipt read and a fixed few git calls, however large the arc; and completion is still taken
// on the tick that applies what made it true.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import { type CommandId, unitId } from '../src/core/ids.ts';
import type { CommandBody } from '../src/core/records.ts';
import { HOST_SCHEDSTAT } from '../src/host/pressure.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { checkpointArc } from './fixtures/checkpoint-common.ts';
import { until } from './fixtures/exec-common.ts';
import { completingArc, startHolistic } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, contextFor } from './fixtures/unit-common.ts';
import { tmpDir } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const WAIT_MS = 120_000;
const LANES = 12;
const OBLIGATIONS = 120;
const UNITS = ['u1', 'u2', 'u3', 'u4'];
const COMMANDS = 40;

const submit = (r: ArcRun, body: CommandBody): CommandId => submitCommand(r.ctx.runDir, r.journal.view.arc, body).id;
const settled = (r: ArcRun, ids: readonly CommandId[]): boolean => ids.every((id) => terminalReceipt(r.ctx.runDir, id) !== null);
const pauseAll = (r: ArcRun): readonly CommandId[] => UNITS.map((u) => submit(r, { type: 'pause', target: { type: 'unit', unit: unitId(u) } }));

/** The arc: OBLIGATIONS must-hold obligations spread over LANES arc lanes, every test passing on every tree. */
function wideArc() {
  const lanes = Array.from({ length: LANES }, (_, i) => `lane-${i}`);
  const obligations = Array.from({ length: OBLIGATIONS }, (_, i) => ({ id: `I-${i + 1}`, testIds: [`t${i}`], lane: lanes[i % LANES]! }));
  const outcomes = Object.fromEntries(obligations.map((o) => [o.testIds[0]!, 'pass' as const]));
  return checkpointArc([], { units: UNITS.map((id) => ({ id })), obligations, lanes, trees: { '*': { outcomes } } });
}

/**
 * What the executor's thread does from now on: its loop's iterations (each reads the host's schedstat once), the kept
 * inputs, witness records and command receipts it reads, and the git processes it starts (through a PATH shim that
 * counts them, then runs the real git).
 */
function meter(t: TestContext) {
  const bin = tmpDir('git-count');
  const count = join(bin, 'count');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(real.startsWith('/'), `git is on PATH (${real})`);
  fs.writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf x >> '${count}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(count, '');
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path}`;
  const reads = { ticks: 0, inputs: 0, witness: 0, receipts: 0 };
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    const p = String(args[0]);
    if (p === HOST_SCHEDSTAT) reads.ticks++;
    else if (p.includes('/inputs/')) reads.inputs++;
    else if (p.endsWith('witness.json')) reads.witness++;
    else if (p.includes('/receipts/')) reads.receipts++;
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  return {
    reads,
    git: (): number => read(count, 'utf8').length,
    stop: (): void => {
      process.env['PATH'] = path;
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

test('idle.bounded-tick: every unit paused, nothing running: no kept input, witness record or terminal receipt is read, and the same few git calls per tick, whatever the arc holds', T, async (t) => {
  const r = contextFor(wideArc());
  const paused = pauseAll(r);
  const s = startHolistic(r);
  try {
    // The baseline witnesses every arc lane (A6), then nothing is left to run.
    await until(() => r.journal.view.holistic().witnessed.length >= LANES && r.journal.view.openIntents().length === 0 && settled(r, paused), WAIT_MS, 'baseline witnessed');
    const extra = Array.from({ length: COMMANDS }, (_, i) => submit(r, { type: 'pause', target: { type: 'unit', unit: unitId(UNITS[i % UNITS.length]!) } }));
    await until(() => settled(r, extra), WAIT_MS, 'the extra commands settled');
    const before = r.journal.view.highWater();
    // Two iterations to settle (a command's last receipt read, the holistic retry), then the window.
    const warm = meter(t);
    await until(() => warm.reads.ticks >= 2, WAIT_MS, 'two iterations');
    warm.stop();
    const m = meter(t);
    await until(() => m.reads.ticks >= 5, WAIT_MS, 'five iterations');
    const ticks = m.reads.ticks, git = m.git();
    m.stop();
    t.diagnostic(`${ticks} idle iterations: ${git} git calls; reads ${JSON.stringify(m.reads)}`);
    assert.equal(r.journal.view.highWater(), before, 'nothing was written: the arc is idle');
    assert.deepEqual({ inputs: m.reads.inputs, witness: m.reads.witness, receipts: m.reads.receipts }, { inputs: 0, witness: 0, receipts: 0 },
      `over ${ticks} idle iterations of an arc with ${OBLIGATIONS} obligations, ${r.journal.view.holistic().witnessed.length} witness records and ${COMMANDS + UNITS.length} terminal commands`);
    // The iteration's own git reads (the integration head and the baseline's and the cadence's) do not depend on how many
    // obligations, lanes, units, witness records or commands the arc has.
    assert.ok(git <= 8 * ticks, `${git} git calls over ${ticks} iterations`);
  } finally {
    submit(r, { type: 'stop' });
    await s.end;
    r.journal.close();
  }
});

test('idle.completion-next-tick: an idle complete arc held by one blocking item completes on the iteration that applies its ack', T, async (t) => {
  const r = contextFor(completingArc());
  try {
    assert.equal((await startHolistic(r).end).kind, 'complete');
    const item = raiseNeedsUser(r.journal, r.ctx.runDir, {
      blocking: true, subject: { type: 'arc' }, reason: 'plan-defect', summary: 'A held completion.', recommendation: 'Acknowledge it.', options: [], evidence: [],
    }, { type: 'arc' });
    const m = meter(t);
    const s = startHolistic(r);
    let ended = false;
    void s.end.then(() => { ended = true; });
    await until(() => m.reads.ticks >= 3, WAIT_MS, 'three idle iterations');
    assert.equal(ended, false, 'the blocking item holds the completion');
    submit(r, { type: 'ack', needsUser: item, choice: null });
    const at = m.reads.ticks;
    assert.deepEqual((await s.end).kind, 'complete');
    // The iteration under way when the ack was submitted may have polled before it; the next applies it and completes.
    assert.ok(m.reads.ticks - at <= 1, `completed ${m.reads.ticks - at} iterations after the ack`);
    m.stop();
  } finally {
    r.journal.close();
  }
});
