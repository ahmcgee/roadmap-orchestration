// The one judge of an issue policy (OR-L6): trusted = issues disabled (no intake), or a PRIVATE repository, or issue
// creation restricted to collaborators (COLLABORATORS_ONLY). Anything else (e.g. PUBLIC + ALL) is untrusted: `start`
// and `roadmap issues` refuse it and a checkpoint capture raises a blocking needs-user. There is no confirmation path
// and nothing about it in config. Only a trusted policy's issues are ever read into an arc (LR-d): the fetch takes a
// `Trusted`, which only this function makes.
import type { UntrustedPolicy } from '../phase0/types.ts';
import type { IssuePolicy } from './types.ts';

/** `intake`: false when issues are disabled (the capture is empty, nothing is fetched). */
export type Trust =
  | Readonly<{ kind: 'trusted'; policy: IssuePolicy; intake: boolean }>
  | Readonly<{ kind: 'untrusted'; policy: IssuePolicy; untrusted: UntrustedPolicy }>;
export type Trusted = Extract<Trust, { kind: 'trusted' }>;

export function trusted(policy: IssuePolicy): Trust {
  if (!policy.hasIssuesEnabled) return { kind: 'trusted', policy, intake: false };
  if (policy.visibility === 'PRIVATE' || policy.issueCreationPolicy === 'COLLABORATORS_ONLY') return { kind: 'trusted', policy, intake: true };
  return { kind: 'untrusted', policy, untrusted: { visibility: policy.visibility, policy: policy.issueCreationPolicy } };
}
