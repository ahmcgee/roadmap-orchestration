// `roadmap resume-arc --repo <repo>` (M4a rev 3, F9): a host act for a boot hook. Reads the host claim: no claim, another
// repo, an `alive` owner, or a run `complete` or `refused` is `{resumed: false, reason}` (exit 0); a claim naming this
// repo with a `dead` owner relaunches its supervisor with start.json's plan and profile (`launchSupervisor`, whose own
// refusals apply). The racing loser's `host-busy` reads as `already-resumed`.
// PLACEHOLDER (step N0, H3): step N6 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { AbsPath } from '../core/values.ts';

export const RESUME_ARC_NOOPS = ['no-claim', 'other-repo', 'alive', 'complete', 'refused', 'already-resumed'] as const;
export type ResumeArcNoop = (typeof RESUME_ARC_NOOPS)[number];
export type ResumeArcArgs = Readonly<{ hostDir: AbsPath; repo: AbsPath }>;
/** `resumed`: the supervisor's start line; else why nothing was done. */
export type ResumeArcOutcome = Readonly<{ resumed: true; line: string; code: number }> | Readonly<{ resumed: false; reason: ResumeArcNoop }>;

export async function resumeArc(_args: ResumeArcArgs): Promise<ResumeArcOutcome> {
  return notYet('roadmap resume-arc', 'N6');
}
