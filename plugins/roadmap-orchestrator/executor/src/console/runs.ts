import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../cli/locate.ts';
import { arcId } from '../core/ids.ts';
import { readJson } from '../core/fsx.ts';
import { runStart } from '../core/records.ts';
import { absPath, type AbsPath } from '../core/values.ts';
import { readClaim } from '../host/lock.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { commonDirOfRun } from '../answers.ts';
import { ConsoleError } from '../observation/protocol.ts';
export function retainedRuns(common: AbsPath, hostDir: AbsPath) {
  const root = join(common, 'roadmap-runtime');
  const runs = !existsSync(root) ? [] : readdirSync(root).filter((id) => {
    const s = lstatSync(join(root, id));
    return s.isDirectory() && ['events.jsonl', 'start.json', 'status.rejection.json'].some((name) => existsSync(join(root, id, name)));
  }).flatMap((id) => {
    const arc = arcId(id); const runDir = absPath(join(root, id));
    const path = join(runDir, 'start.json');
    if (!existsSync(path)) return [{ arc, runDir, at: new Date(statSync(runDir).birthtimeMs).toISOString() }];
    const raw = readJson(path);
    // An arc started before the schema cut stays in the runtime directory but this release can never read
    // it: leave it out of the listing rather than failing every other arc's reads. Anything else is strict.
    if (isOlderSchema(raw)) return [];
    return [{ arc, runDir, at: runStart(raw, path).at }];
  }).sort((a, b) => b.at.localeCompare(a.at) || a.arc.localeCompare(b.arc));
  const claim = readClaim(hostDir);
  const live = claim && realpathSync(commonDirOfRun(claim.runDir)) === realpathSync(common) ? runs.find((r) => r.arc === claim.arc) : null;
  return { arcs: runs, selected: live?.arc ?? runs[0]?.arc ?? null };
}
export function retainedRun(common: AbsPath, hostDir: AbsPath, id: string): Run {
  const found = retainedRuns(common, hostDir).arcs.find((r) => r.arc === id);
  if (!found) throw new ConsoleError('not-found', 'arc is absent or pruned');
  return found;
}
function isOlderSchema(raw: unknown): boolean {
  const v = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v < SCHEMA_VERSION;
}
