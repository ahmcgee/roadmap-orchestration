// Where a command's run is: the named one (`--repo` and `--arc`), or the arc holding this host (its claim).
import { resolve } from 'node:path';
import type { ArcId } from '../core/ids.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { readClaim } from '../host/lock.ts';
import { CliError, type RunLocator, runDir } from '../input/cli.ts';
import { gitCommonDir } from '../preflight/checks.ts';

export type Run = Readonly<{ runDir: AbsPath; arc: ArcId }>;

export function locate(locator: RunLocator, hostDir: AbsPath): Run {
  if (locator.type === 'explicit') {
    const repo = absPath(resolve(locator.repo));
    return { runDir: runDir(gitCommonDir(repo), locator.arc), arc: locator.arc };
  }
  const claim = readClaim(hostDir);
  if (claim === null) throw new CliError(`no arc holds this host (${hostDir}); name the run with --repo and --arc`);
  return { runDir: claim.runDir, arc: claim.arc };
}
