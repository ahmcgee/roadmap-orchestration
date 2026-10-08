// `roadmap issues --repo <path> [--out <file>]` (M4a, OR-L6, H8, H13): a host act, no host lock. Resolves the repo
// identity once, queries the issue policy, refuses an untrusted one (`issue-policy-untrusted`, nothing fetched), and
// captures the open `roadmap:bug` and `roadmap:feedback` issues as the canonical issue capture (src/forge/issues.ts):
// to stdout, or `out` by atomic rename. A forge failure is a CLI error.
import type { Sha256Hex } from '../core/ids.ts';
import { durableWrite } from '../core/fsx.ts';
import type { AbsPath } from '../core/values.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { captureBytes, captureSha256, fetchIssueCapture } from '../forge/issues.ts';
import { queryPolicy } from '../forge/policy.ts';
import { trusted } from '../forge/trust.ts';
import type { IssueCapture } from '../forge/types.ts';
import { CliError } from '../input/cli.ts';
import type { StartupRejection } from '../preflight/startup.ts';

export type IssuesArgs = Readonly<{ repo: AbsPath; out: AbsPath | null }>;
/** `captured`: the capture and its canonical bytes' sha256 (written to `out` when given); `refused`: exit 78. */
export type IssuesOutcome =
  | Readonly<{ kind: 'captured'; capture: IssueCapture; sha256: Sha256Hex }>
  | Readonly<{ kind: 'refused'; rejection: Extract<StartupRejection, { kind: 'issue-policy-untrusted' }> }>;

export async function captureIssues(args: IssuesArgs): Promise<IssuesOutcome> {
  try {
    const repo = resolveRepo(args.repo);
    const trust = trusted(queryPolicy(args.repo, repo));
    if (trust.kind === 'untrusted') return { kind: 'refused', rejection: { kind: 'issue-policy-untrusted', ...trust.untrusted } };
    const capture = fetchIssueCapture(args.repo, repo, trust);
    if (args.out !== null) durableWrite(args.out, captureBytes(capture));
    return { kind: 'captured', capture, sha256: captureSha256(capture) };
  } catch (error) {
    if (error instanceof GhError) throw new CliError(`issues: ${error.message}`);
    throw error;
  }
}
