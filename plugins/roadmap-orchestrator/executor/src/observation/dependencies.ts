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
export function dependencyStamp(paths: readonly string[], exclude: ReadonlySet<string> = new Set()): string {
  const rows: string[] = [];
  const visit = (path: string): void => {
    if (exclude.has(path)) return;
    let s;
    try { s = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { rows.push(`${path}:missing`); return; } throw e; }
    if (s.isDirectory()) {
      const names = readdirSync(path).sort().filter((n) => !exclude.has(join(path, n)) && !n.endsWith('.tmp'));
      rows.push(`${path}:${s.dev}:${s.ino}:${names.join('\0')}`);
      for (const name of names) visit(join(path, name));
    } else rows.push(`${path}:${fileStamp(path)}`);
  };
  paths.forEach(visit);
  return sha256Hex(rows.join('\n'));
}

/** Only observation records participate in admission. Streaming output is read independently by log readers. */
export function observationStamp(runDir: string, common: string, hostDir: string): string {
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
  return dependencyStamp([
    ...['start.json', 'status.rejection.json', 'sched.json', 'inputs', 'commands/incoming', 'commands/receipts', 'needs-user'].map(p => join(runDir, p)),
    ...records.sort(), join(hostDir, 'host.lock'), join(hostDir, 'host.owner.json'), join(hostDir, DEMO_FILE),
    join(common, 'roadmap', 'answers'), join(common, 'refs'), join(common, 'packed-refs'), join(common, 'HEAD'),
  ]) + JSON.stringify(demoLiveness);
}
