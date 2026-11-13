import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { statusCostArc } from '../fixtures/status-cost.ts';

// Each child times only the call after static imports (main-thread CPU plus waited-for Git CPU).
// Alternating fresh children and taking each minimum damps GC and host noise, as in log.test.ts.
// Completed audit edges make the former quadratic scan dominate fixed per-call costs.
// At origin/main 327204ae these cases cost 36–43x CPU; the optimized branch costs 5–8x.
// The 15x bound leaves ample room for both the linear 10x workload and host noise.
test('status and summary scale below 15x CPU for 10x journal input, with fixed and growing unit/history counts', { timeout: 360_000 }, async (t) => {
  const small = await statusCostArc(10_000, 8, 8);
  const growing = await statusCostArc(100_000, 80, 80);
  const fixed = await statusCostArc(100_000, 8, 8);
  const child = fileURLToPath(new URL('../fixtures/status-cost-child.ts', import.meta.url));
  const measure = (mode: string, fixture: typeof small): { cpuMs: number; wallMs: number } => {
    const got = spawnSync(process.execPath, [child, mode, fixture.runDir, fixture.arc, fixture.hostDir, String(fixture.units), String(fixture.lines)], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, PATH: fixture.forgePath } });
    assert.equal(got.status, 0, `${got.stderr}\n${got.stdout}`);
    return JSON.parse(got.stdout);
  };
  for (const mode of ['status', 'summary']) for (const [name, large] of [['growing', growing], ['fixed', fixed]] as const) await t.test(`${mode} ${name}`, () => {
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < 2; i++) { a.push(measure(mode, small).cpuMs); b.push(measure(mode, large).cpuMs); }
    const ratio = Math.min(...b) / Math.min(...a);
    t.diagnostic(`${mode} ${name}: ${a.map(Math.round)} / ${b.map(Math.round)} ms CPU (including Git); ratio ${ratio.toFixed(2)}`);
    assert.ok(ratio < 15, `${mode} ${name}: 10x input costs ${ratio.toFixed(2)}x CPU`);
    assert.ok(Math.min(...b) < 60_000, `${mode} ${name}: catastrophic CPU regression`);
  });
});

// dev.79 (T12): a capture after an append folds only the appended events in every pass status makes over the journal.
test('a capture after a 12-event append on a 60,000-event journal folds 12 events in every pass', { timeout: 360_000 }, async () => {
  const { readJournal } = await import('../../src/core/log.ts');
  const { captureStatus } = await import('../../src/status.ts');
  const { StatusPasses } = await import('../../src/status/passes.ts');
  const { Fold } = await import('../../src/core/state.ts');
  const { prevHash, serializeEvent } = await import('../../src/core/events.ts');
  const f = await statusCostArc(60_000, 8, 8);
  const events = readJournal(f.runDir, f.arc).events;
  assert.ok(events.length >= 60_000);
  const view = new Fold(f.arc);
  for (const e of events.slice(0, -12)) view.apply(e, prevHash(Buffer.from(serializeEvent(e), 'utf8')));
  const timing = { clock: Date.now(), foldMs: 0 };
  // One pass from nothing over the whole journal, timed: what extending by 12 must beat by far.
  const full = Math.min(...Array.from({ length: 3 }, () => { const t = performance.now(); StatusPasses.of(events); return performance.now() - t; }));
  const kept = new StatusPasses();
  captureStatus(f.runDir, f.arc, f.hostDir, { view, events: events.slice(0, -12) }, timing, kept);
  assert.equal(kept.folded, events.length - 12);
  for (const e of events.slice(-12)) view.apply(e, prevHash(Buffer.from(serializeEvent(e), 'utf8')));
  const began = performance.now();
  kept.extend(events);
  const step = performance.now() - began;
  assert.equal(kept.folded, events.length, 'the 12 appended events are folded');
  captureStatus(f.runDir, f.arc, f.hostDir, { view, events }, timing, kept);
  assert.equal(kept.folded, events.length, 'and the capture folds nothing again');
  assert.ok(step < full / 20, `extending by 12 took ${step.toFixed(2)} ms against ${full.toFixed(1)} ms for every event`);
});
