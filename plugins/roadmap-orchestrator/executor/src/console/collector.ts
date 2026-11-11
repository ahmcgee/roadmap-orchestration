// A collector worker: gathers one arc (src/observation/collect.ts) and publishes each change straight to the serve worker
// over its own port. It answers no requests, so nothing can starve its loop; main sends it only control messages.
import { existsSync, type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import { type MessagePort, parentPort, workerData } from 'node:worker_threads';
import type { Run } from '../cli/locate.ts';
import type { AbsPath } from '../core/values.ts';
import { ArcCollector, type CollectorMessage } from '../observation/collect.ts';
import type { ToCollector } from './messages.ts';

/** What a collector tells main besides its observations: progress, log lines, and each capture's work counts. */
export type CollectorReport =
  | Extract<CollectorMessage, { kind: 'progress' | 'log' }>
  | Readonly<{ kind: 'captured'; arc: string; at: number; seq: number | null; offset: number | null; work: Extract<CollectorMessage, { kind: 'observation' }>['work'] }>;

const { run, hostDir, common, port } = workerData as { run: Run; hostDir: AbsPath; common: AbsPath; port: MessagePort };
const report = (m: CollectorReport) => parentPort!.postMessage(m);
const collector = new ArcCollector(run, hostDir, common, (m) => {
  if (m.kind === 'progress' || m.kind === 'log') { report(m); return; }
  port.postMessage(m);
  if (m.kind === 'observation') report({ kind: 'captured', arc: m.arc, at: m.asOf, seq: m.journal.seq, offset: m.journal.offset, work: m.work });
  if (m.kind === 'rows') report({ kind: 'captured', arc: m.arc, at: m.asOf, seq: null, offset: null, work: m.work });
});
let timer: NodeJS.Timeout | null = null, dueAt = Infinity;
function schedule(delayMs: number): void {
  if (timer !== null) clearTimeout(timer);
  dueAt = Date.now() + delayMs; timer = setTimeout(loop, delayMs);
}
function loop(): void {
  timer = null; dueAt = Infinity;
  schedule(collector.step(Date.now()));
}
function poke(): void {
  const delay = collector.poke(Date.now());
  if (Date.now() + delay < dueAt) schedule(delay);
}
// Refs and answers are small trees, watched recursively. The run directory is watched flat: its journal, schedule and
// heartbeat land there. The one-second step covers the rest.
for (const dir of [join(common, 'refs'), join(common, 'roadmap')]) if (existsSync(dir)) watch(dir, { recursive: true }, poke).on('error', (e) => report({ kind: 'log', message: `console collector for arc ${run.arc}: watching ${dir} failed: ${e.message}` }));
if (existsSync(run.runDir)) watch(run.runDir, poke).on('error', (e) => report({ kind: 'log', message: `console collector for arc ${run.arc}: watching its run directory failed: ${e.message}` }));
// A followed history's invocation directory, watched flat: its output streams there.
const followed = new Map<string, FSWatcher>();
function follow(dirs: readonly string[]): void {
  for (const [dir, w] of followed) if (!dirs.includes(dir)) { w.close(); followed.delete(dir); }
  for (const dir of dirs) if (!followed.has(dir) && existsSync(dir)) followed.set(dir, watch(dir, poke).on('error', (e) => report({ kind: 'log', message: `console collector for arc ${run.arc}: watching ${dir} failed: ${e.message}` })));
}
parentPort!.on('message', (m: ToCollector) => { if (m.kind === 'check-now') poke(); else follow(m.dirs); });
schedule(0);
