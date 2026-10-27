// JSON-only scale benchmark. Run from executor/: node test/fixtures/tui-scale-bench.ts <demo-directory>
// Profiling can shorten navigation with SCALE_BENCH_STEPS (default 100).
// Optional: SCALE_BENCH_PHASES=/absolute/phases.json node --cpu-prof ... (monotonic profile ranges).
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { arcId, invocationIdOf } from '../../src/core/ids.ts';
import { openJournal, readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { status } from '../../src/status.ts';
import { connect, estate } from '../../src/tui/estate.ts';
import { graph } from '../../src/tui/graph.ts';
import { Observer } from '../../src/tui/observer.ts';
import { ViewState } from '../../src/tui/state.ts';
import type { Display, LogRequest, ObserveReply, ObserveRequest } from '../../src/tui/types.ts';
import { contentHeight } from '../../src/tui/view.ts';
import type { ArcDescriptor } from './unit-common.ts';

const directory = process.argv[2];
assert.ok(directory, 'usage: node test/fixtures/tui-scale-bench.ts <demo-directory>');
const base = resolve(directory);
const d = JSON.parse(readFileSync(join(base, 'demo.json'), 'utf8')) as ArcDescriptor;
const runDir = absPath(d.runDir);
const arc = arcId(d.arc);
const hostDir = absPath(d.hostDir);
const request: ObserveRequest = { locator: { type: 'host' }, hostDir, pinned: { arc, runDir }, log: null, token: 1 };
const columns = 200;
const rows = 50;
const h = contentHeight(rows);
const repeats = 5;
const steps = Number(process.env['SCALE_BENCH_STEPS'] ?? 100);
assert.ok(Number.isSafeInteger(steps) && steps > 0, 'SCALE_BENCH_STEPS must be a positive integer');
const phaseFile = process.env['SCALE_BENCH_PHASES'];
const phases: { name: string; startUs: number; endUs: number }[] = [];
function phase<T>(name: string, fn: () => T): T {
  const startUs = Number(process.hrtime.bigint() / 1000n);
  try { return fn(); }
  finally {
    phases.push({ name, startUs, endUs: Number(process.hrtime.bigint() / 1000n) });
    if (phaseFile) writeFileSync(phaseFile, JSON.stringify(phases));
  }
}
function time(fn: () => unknown): number {
  const before = performance.now(); fn(); return performance.now() - before;
}
function median(samples: number[]): number { return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!; }
function measure(name: string, fn: () => unknown, n = repeats) {
  return phase(name, () => {
    const samplesMs = Array.from({ length: n }, () => time(fn));
    return { medianMs: median(samplesMs), samplesMs };
  });
}
function checked(reply: ObserveReply): ObserveReply & { display: NonNullable<ObserveReply['display']> } {
  assert.equal(reply.error, null); assert.ok(reply.display);
  return reply as ObserveReply & { display: NonNullable<ObserveReply['display']> };
}
const cold: number[] = [];
const warm: number[] = [];
let observer!: Observer;
let reply!: ReturnType<typeof checked>;
// Cold means a new Observer and its caches; the OS filesystem cache is deliberately uncontrolled.
for (let i = 0; i < 3; i++) {
  observer = new Observer();
  cold.push(phase('observer.cold', () => time(() => { reply = checked(observer.observe(request)); })));
  warm.push(phase('observer.warm', () => time(() => { reply = checked(observer.observe(request)); })));
}
const display = reply.display;
const selected = phase('setup.select-large-log', () => display.invocations.filter((inv) => inv.endedAt !== null)
  .map((inv) => ({ inv: inv.id, bytes: statSync(join(invocationDir(runDir, invocationIdOf(inv.id)), 'stdout')).size }))
  .sort((a, b) => b.bytes - a.bytes)[0]);
assert.ok(selected, 'fixture needs at least one ended invocation');
assert.ok(selected.bytes > 2 * 1024 * 1024, 'fixture needs an ended transcript of several MB');
const logRequest: LogRequest = { inv: selected.inv, source: 'transcript', before: null, expanded: false };
const observeLog = (log: LogRequest) => {
  const result = checked(observer.observe({ ...request, log }));
  assert.ok(result.log); assert.equal(result.log.error, null);
  return result;
};
const nextPoll = (() => {
  const journal = openJournal(runDir, arc);
  try {
    const samplesMs: number[] = [];
    for (let i = 0; i < 3; i++) {
      // This records an unchanged containment choice; it does not change any unit's state.
      journal.fact({ kind: 'containment-mode', mode: 'session' });
      samplesMs.push(phase('observer.next-poll', () => time(() => { reply = checked(observer.observe(request)); })));
    }
    return { medianMs: median(samplesMs), samplesMs, mutation: 'containment-mode fact', appendIncluded: false };
  } finally { journal.close(); }
})();
let logReply!: ReturnType<typeof observeLog>;
const logFirst = measure('observer.log-first', () => { logReply = observeLog(logRequest); }, 1);
const logTail = measure('observer.log-tail', () => { logReply = observeLog(logRequest); });
const page = logReply.log!;
assert.ok(page.start > 0, 'large log must have an older page');
const olderRequest = { ...logRequest, before: page.start };
let olderReply!: ReturnType<typeof observeLog>;
const logOlderFirst = measure('observer.log-older-first', () => { olderReply = observeLog(olderRequest); }, 1);
const logOlder = measure('observer.log-older', () => { olderReply = observeLog(olderRequest); });
assert.ok(olderReply.log!.start < page.start);
// The same before/after window ViewState.move uses when paging forward from the older page.
const newerRequest = { ...logRequest, after: olderReply.log!.end, before: Math.min(page.size, olderReply.log!.end + 64 * 1024) };
const logNewer = measure('observer.log-newer', () => { observeLog(newerRequest); });
const clone = measure('transfer.structured-clone', () => structuredClone(reply));
const cloneWithLog = measure('transfer.structured-clone-with-log', () => structuredClone(logReply));
let serialized = '';
const stringify = measure('transfer.stringify', () => { serialized = JSON.stringify(reply); });
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const sizes = { replyJsonLength: serialized.length, replyBytes: Buffer.byteLength(serialized),
  estateBytes: bytes(reply.display.estate), invocationsBytes: bytes(reply.display.invocations), logReplyBytes: bytes(logReply),
  pageBytes: page.end - page.start, pageLines: page.lines.length };

const makeUI = (snapshot: Display = display) => { const ui = new ViewState(); ui.accept(snapshot); return ui; };
// The retained fixture is stopped: its open invocations do not imply running unit states.
// For map jump timings only, model those recorded units as running in a fresh immutable snapshot.
const runningUnits = new Set(display.invocations.filter((inv) => inv.endedAt === null).map((inv) => inv.unit));
const runningDisplay: Display = { ...display, status: { ...display.status,
  units: display.status.units.map((unit) => runningUnits.has(unit.unit) ? { ...unit, state: 'running' } : unit) } };
const syntheticRunningUnits = runningDisplay.status.units.filter((unit) => unit.state === 'running').length;
assert.ok(syntheticRunningUnits > 1, 'fixture needs several open unit invocations for map cycling');
const ui = phase('setup.ui', makeUI);
const accept = measure('ui.accept', () => ui.accept(display));
const firstRender = measure('ui.render-first', () => ui.renderFrame(columns, rows, false), 1);
const repeatedRender = measure('ui.render-repeated', () => ui.renderFrame(columns, rows, false));
const navigation = [];
for (const full of [false, true]) {
  for (const pane of [0, 1]) {
    const state = phase('setup.navigation', makeUI);
    if (full) state.key('', 'c', h);
    state.pane = pane;
    state.renderFrame(columns, rows, false);
    const measurement = measure(`ui.down${steps}.${full ? 'full' : 'open'}.pane${pane}`, () => {
      for (let i = 0; i < steps; i++) { state.key('down', '', h); state.renderFrame(columns, rows, false); }
    }, 1);
    const runningState = pane === 0 ? makeUI(runningDisplay) : state;
    runningState.expandedGraph = full; runningState.pane = pane;
    runningState.renderFrame(columns, rows, false);
    const running = measure(`ui.running${steps}.${full ? 'full' : 'open'}.pane${pane}`, () => {
      for (let i = 0; i < steps; i++) { runningState.key('', 'r', h); runningState.renderFrame(columns, rows, false); }
    }, 1);
    navigation.push({ mode: full ? 'full' : 'open', pane, steps, totalMs: measurement.medianMs, perStepMs: measurement.medianMs / steps,
      nextRunning: { syntheticRunningUnits: pane === 0 ? syntheticRunningUnits : 0, totalMs: running.medianMs, perStepMs: running.medianMs / steps } });
  }
}
const estateSwitch = measure('ui.estate-switch-render', () => { ui.key('', '3', h); ui.renderFrame(columns, rows, false); }, 1);
assert.equal(ui.view, 2);
const estateRender = measure('ui.estate-render', () => ui.renderFrame(columns, rows, false));
const isolatedGraph = measure('isolated.graph-open', () => graph(display, false));
const isolatedExpanded = measure('isolated.graph-full', () => graph(display, true));
const snapshot = phase('setup.read-journal', () => readJournal(runDir, arc));
const isolatedEstate = measure('isolated.estate-including-connect', () => estate(runDir, snapshot.view, absPath(d.repo)), 3);
// Clear links outside timing: connect mutates entries, and needs the same input on every sample.
const connectSamples: number[] = [];
for (let i = 0; i < repeats; i++) {
  const entries = structuredClone(display.estate); for (const entry of entries) entry.links = [];
  connectSamples.push(phase('isolated.connect', () => time(() => connect(entries))));
}
const isolatedStatus = measure('isolated.status-with-snapshot', () => status(runDir, arc, hostDir, snapshot), 3);
const isolatedStatusDisk = measure('isolated.status-from-disk', () => status(runDir, arc, hostDir), 3);
const logUI = phase('setup.log-ui', makeUI);
logUI.logRequest = { ...logRequest };
const logOpen = measure('ui.accept-log-render-first', () => { logUI.acceptLog(page, h); logUI.renderFrame(columns, rows, false); }, 1);
const logRepeat = measure('ui.accept-log-render-repeated', () => { logUI.acceptLog(page, h); logUI.renderFrame(columns, rows, false); });
const output = {
  fixture: base, node: process.version, at: new Date().toISOString(), units: display.status.units.length, invocations: display.invocations.length,
  events: reply.display.seq, repeats, coldRepeats: cold.length, viewport: { columns, rows, contentHeight: h },
  observer: { cold: { medianMs: median(cold), samplesMs: cold }, warm: { medianMs: median(warm), samplesMs: warm }, nextPoll,
    largeLog: { inv: selected.inv, bytes: selected.bytes, first: logFirst, tail: logTail, olderFirst: logOlderFirst, older: logOlder, newer: logNewer } },
  transfer: { clone, cloneWithLog, stringify, ...sizes },
  ui: { accept, firstRender, repeatedRender, navigation, estateSwitch, estateRender, logOpen, logRepeat },
  isolated: { graph: isolatedGraph, fullGraph: isolatedExpanded, estateIncludingConnect: isolatedEstate,
    connect: { medianMs: median(connectSamples), samplesMs: connectSamples }, statusWithSnapshot: isolatedStatus, statusFromDisk: isolatedStatusDisk },
};
process.stdout.write(JSON.stringify(output) + '\n');
