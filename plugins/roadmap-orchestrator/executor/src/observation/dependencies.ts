// File identity and membership, independent of journal highWater. Never traverse symlinks.
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readBootId } from '../contain/proc.ts';
import { absPath } from '../core/values.ts';
import { DEMO_FILE, readDemoRecord } from '../demo/records.ts';
import { detachedAlive } from '../walk/bringup.ts';
import { sha256Hex } from '../core/json.ts';
export function fileStamp(path: string): string {
  try { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw e; }
}
/** Each dependency's identity: a directory's identity and member names, a file's stamp, or `missing`. Never follows symlinks. */
export type DependencyRows = ReadonlyMap<string, string>;
export function dependencyRows(paths: readonly string[], exclude: ReadonlySet<string> = new Set()): DependencyRows {
  const rows = new Map<string, string>();
  const visit = (path: string): void => {
    if (exclude.has(path)) return;
    let s;
    try { s = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { rows.set(path, 'missing'); return; } throw e; }
    if (s.isDirectory()) {
      const names = readdirSync(path).sort().filter((n) => !exclude.has(join(path, n)) && !n.endsWith('.tmp'));
      rows.set(path, `dir:${s.dev}:${s.ino}:${names.join('\0')}`);
      for (const name of names) visit(join(path, name));
    } else rows.set(path, `file:${fileStamp(path)}`);
  };
  paths.forEach(visit);
  return rows;
}
export const rowsStamp = (rows: DependencyRows): string => sha256Hex([...rows].map(([path, stamp]) => `${path}:${stamp}`).join('\n'));

/** The records whose bytes are written once and then only read: a change to one already seen is a rewrite or a prune. */
const WRITE_ONCE = /\/(inv|evidence|inputs|needs-user|commands\/receipts)\//;
/** Whether `now` rewrote or removed a write-once record `before` held; new records and every other dependency are growth. */
export function rewritten(runDir: string, before: DependencyRows, now: DependencyRows): boolean {
  for (const [path, stamp] of before) {
    if (!stamp.startsWith('file:') || !path.startsWith(`${runDir}/`) || !WRITE_ONCE.test(path.slice(runDir.length))) continue;
    if (now.get(path) !== stamp) return true;
  }
  return false;
}
/** The dependencies whose identity differs between two sets of rows, including ones added or removed. */
export function changedPaths(before: DependencyRows, now: DependencyRows): string[] {
  const out: string[] = [];
  for (const [path, stamp] of now) if (before.get(path) !== stamp) out.push(path);
  for (const path of before.keys()) if (!now.has(path)) out.push(path);
  return out;
}

/** Only observation records participate in admission. Streaming output is read independently by log readers. */
export function observationRows(runDir: string, common: string, hostDir: string): { rows: DependencyRows; liveness: string } {
  const records: string[] = [];
  const collect = (dir: string, names: ReadonlySet<string>): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) collect(path, names);
      else if (names.has(basename(path))) records.push(path);
    }
  };
  collect(join(runDir, 'inv'), new Set(['launch.json', 'runner.json', 'result.json', 'exit.json']));
  collect(join(runDir, 'evidence'), new Set(['red.json', 'witness.json']));
  const demo = readDemoRecord(absPath(hostDir))?.serving;
  // Status uses boot + pid/start identity, including zombie detection, for demo serving.
  const demoLiveness = demo ? [demo.boot === readBootId(), ...demo.processes.map(detachedAlive)] : null;
  const rows = dependencyRows([
    ...['start.json', 'status.rejection.json', 'sched.json', 'inputs', 'commands/incoming', 'commands/receipts', 'needs-user'].map(p => join(runDir, p)),
    ...records.sort(), join(hostDir, 'host.lock'), join(hostDir, 'host.owner.json'), join(hostDir, DEMO_FILE),
    join(common, 'roadmap', 'answers'), join(common, 'refs'), join(common, 'packed-refs'), join(common, 'HEAD'),
  ]);
  return { rows, liveness: JSON.stringify(demoLiveness) };
}
