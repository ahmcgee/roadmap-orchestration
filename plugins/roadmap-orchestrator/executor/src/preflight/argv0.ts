// Where a declared command's argv[0] resolves, as the runner's spawn would: a bare name on the command's
// own PATH (its declared `set.PATH`, or the host's when it passes PATH, else Node's default search path),
// followed to its real path, since a PATH entry is often a symlink into another tree. One reading for the
// startup row (`spec-lane-unrunnable`) and the plan-check's `<lane_programs>` block (arc-1 feedback item 3:
// a judge that cannot run `command -v`, and whose Glob does not follow symlinks, asserted a tool missing
// that was on the lane's PATH).
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { LaneEnv } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';

/** What Node's spawn searches when a workload's env has no PATH (and the runner passes only the declared env). */
const DEFAULT_SEARCH_PATH = '/usr/bin:/bin';

/**
 * `program`: an executable file, at its real path. `repository-file`: a relative path with a slash, which
 * names a file of the tree the command runs in (a lane's unit may create it), so it is not resolved here.
 */
export type Argv0 =
  | Readonly<{ kind: 'program'; realpath: AbsPath }>
  | Readonly<{ kind: 'repository-file' }>
  | Readonly<{ kind: 'not-found' }>;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveArgv0(command: Readonly<{ argv: readonly string[]; env: LaneEnv }>, hostEnv: Readonly<Record<string, string | undefined>>): Argv0 {
  const argv0 = command.argv[0];
  if (argv0 === undefined) throw new Error(`a declared command has an empty argv`); // the validators require non-empty
  const program = (path: string): Argv0 => ({ kind: 'program', realpath: absPath(realpathSync(path)) });
  if (isAbsolute(argv0)) return executable(argv0) ? program(argv0) : { kind: 'not-found' };
  if (argv0.includes('/')) return { kind: 'repository-file' };
  const path = command.env.set['PATH'] ?? (command.env.pass.includes('PATH') ? hostEnv['PATH'] : undefined) ?? DEFAULT_SEARCH_PATH;
  const dir = path.split(delimiter).find((d) => d !== '' && executable(join(d, argv0)));
  return dir === undefined ? { kind: 'not-found' } : program(join(dir, argv0));
}
