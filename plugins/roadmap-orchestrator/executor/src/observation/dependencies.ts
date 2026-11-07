// File identity and membership, independent of journal highWater. Never traverse symlinks.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
