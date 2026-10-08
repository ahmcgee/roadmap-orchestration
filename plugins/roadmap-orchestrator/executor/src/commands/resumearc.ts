// `roadmap resume-arc --repo <repo>` (M4a rev 3, F9): a host act for a boot hook (reference.md: a devcontainer's
// `postStartCommand`). Reads the host claim: no claim, a claim of another repo, an `alive` owner (`ownerState`), or a run
// `complete` or `refused` (status's run state) is `{resumed: false, reason}` (exit 0). A claim naming this repo whose
// owner is `dead` relaunches its supervisor with start.json's plan file and profile (`launchSupervisor`, whose own
// refusals apply: an unapplied plan edit fails loud there). Two racing calls: the loser's supervisor finds the host
// claimed (`host-busy`, exit 75), which reads as `already-resumed`. Idempotent; it holds no lock itself.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../core/fsx.ts';
import { runStart } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { START_FILE } from '../executor.ts';
import { readClaim } from '../host/lock.ts';
import { CliError } from '../input/cli.ts';
import { EXIT_HOST_BUSY } from '../preflight/startup.ts';
import { ownerState, unitStates } from '../status.ts';
import { START_WAIT_MS, launchSupervisor } from '../supervisor.ts';

export const RESUME_ARC_NOOPS = ['no-claim', 'other-repo', 'alive', 'complete', 'refused', 'already-resumed'] as const;
export type ResumeArcNoop = (typeof RESUME_ARC_NOOPS)[number];
export type ResumeArcArgs = Readonly<{ hostDir: AbsPath; repo: AbsPath }>;
/** `resumed`: the supervisor's start line and exit code; else why nothing was done. */
export type ResumeArcOutcome = Readonly<{ resumed: true; line: string; code: number }> | Readonly<{ resumed: false; reason: ResumeArcNoop }>;

export async function resumeArc(args: ResumeArcArgs): Promise<ResumeArcOutcome> {
  const claim = readClaim(args.hostDir);
  if (claim === null) return { resumed: false, reason: 'no-claim' };
  if (claim.repo !== args.repo) return { resumed: false, reason: 'other-repo' };
  if (ownerState(claim.runDir, args.hostDir).state === 'alive') return { resumed: false, reason: 'alive' };
  const run = unitStates(claim.runDir, claim.arc, args.hostDir).run;
  if (run === 'complete' || run === 'refused') return { resumed: false, reason: run };
  const path = join(claim.runDir, START_FILE);
  if (!existsSync(path)) throw new CliError(`resume-arc: arc ${claim.arc} holds the host but never started (no ${path}); start it with roadmap start`);
  const start = runStart(readJson(path), path);
  const outcome = await launchSupervisor({ hostDir: args.hostDir, repo: start.repo, planFile: start.planFile, profile: start.profile, heartbeatStaleMs: null }, process.env, START_WAIT_MS);
  return outcome.code === EXIT_HOST_BUSY ? { resumed: false, reason: 'already-resumed' } : { resumed: true, line: outcome.line, code: outcome.code };
}
