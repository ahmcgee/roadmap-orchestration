// `roadmap issues --repo <path> [--out <file>]` (M4a, OR-L6, H8, H13): a host act. Resolves the repo identity once, queries
// the issue policy, refuses an untrusted one, and captures the open `roadmap:bug` and `roadmap:feedback` issues as the
// canonical issue capture (to stdout, or `out` by atomic rename). PLACEHOLDER (step 0a, H3): step A3 replaces it in place.
import { notYet } from '../core/notyet.ts';
import type { Sha256Hex } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import type { IssueCapture } from '../forge/types.ts';
import type { StartupRejection } from '../preflight/startup.ts';

export type IssuesArgs = Readonly<{ repo: AbsPath; out: AbsPath | null }>;
/** `captured`: the capture and its canonical bytes' sha256 (written to `out` when given); `refused`: exit 78. */
export type IssuesOutcome =
  | Readonly<{ kind: 'captured'; capture: IssueCapture; sha256: Sha256Hex }>
  | Readonly<{ kind: 'refused'; rejection: Extract<StartupRejection, { kind: 'issue-policy-untrusted' }> }>;

export async function captureIssues(_args: IssuesArgs): Promise<IssuesOutcome> {
  return notYet('roadmap issues', 'A3');
}
