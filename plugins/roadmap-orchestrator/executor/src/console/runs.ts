import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../cli/locate.ts';
import { arcId } from '../core/ids.ts';
import { readJson } from '../core/fsx.ts';
import { runStart } from '../core/records.ts';
import { absPath, type AbsPath } from '../core/values.ts';
import { readClaim } from '../host/lock.ts';
import { commonDirOfRun } from '../answers.ts';
import { ConsoleError } from '../observation/protocol.ts';
export function retainedRuns(common: AbsPath, hostDir: AbsPath) {
  const root = join(common, 'roadmap-runtime');
  const runs = !existsSync(root) ? [] : readdirSync(root).filter((id) => {
    const s = lstatSync(join(root, id));
    return s.isDirectory() && ['events.jsonl', 'start.json', 'status.rejection.json'].some((name) => existsSync(join(root, id, name)));
  }).map((id) => {
    const arc = arcId(id); const runDir = absPath(join(root, id));
    const path = join(runDir, 'start.json');
    const at = existsSync(path) ? runStart(readJson(path), path).at : new Date(statSync(runDir).birthtimeMs).toISOString();
    return { arc, runDir, at };
  }).sort((a, b) => b.at.localeCompare(a.at) || a.arc.localeCompare(b.arc));
  const claim = readClaim(hostDir);
  const live = claim && realpathSync(commonDirOfRun(claim.runDir)) === realpathSync(common) ? runs.find((r) => r.arc === claim.arc) : null;
  return { runs, selected: live?.arc ?? runs[0]?.arc ?? null };
}
export function retainedRun(common: AbsPath, hostDir: AbsPath, id: string): Run {
  const found = retainedRuns(common, hostDir).runs.find((r) => r.arc === id);
  if (!found) throw new ConsoleError('not-found', 'run is absent or pruned');
  return found;
}
