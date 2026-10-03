// `roadmap chain status --repo <path>` (M4a, OR-Q19, K10, H20): read-only, no host lock. The chain as `src/chain.ts`
// derives it (the one derivation): the plans in `refs/roadmap/*`, the committed acks and `config.chain.k`, with each
// arc's pull request looked up on the forge by head (non-fatal: `unavailable{reason}`). `status` (its own arc's chain)
// and the brief read the chain through this module too.
//
// - **The head.** The chain ends at the newest tip: of the arcs with a ref that no other arc's plan names as its
//   previous arc, the one whose log began last (its first event's `at`; ties by id). A running arc is in the chain once
//   its first snapshot is published (its first ff or docs publication); until then the chain ends before it.
// - **The PR** of an arc (`prsOf`): its integration branch's pull request by head (`gh pr list --head`): the open one,
//   else the merged one, else a closed one, else `none`; `main` as the integration branch has none. An open PR's
//   `needsRebase` is `roadmap pr`'s base walk (src/commands/pr.ts `baseOf`): a previous arc whose PR was merged by
//   squash or rebase (OR-L5). A forge or git failure is the arc's `unavailable{reason}`, never an error.
import { type ArcRef, arcsWithRefs, chainBack, committedAcks, readArcRef, unackedStarts } from '../chain.ts';
import type { ArcId } from '../core/ids.ts';
import type { AbsPath, BranchName } from '../core/values.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { type Pull, onlyIn, pullsByHead } from '../forge/pr.ts';
import { MAIN_BRANCH, PushError } from '../forge/push.ts';
import type { RepoIdentity } from '../forge/types.ts';
import { GitError } from '../git/git.ts';
import { CliError } from '../input/cli.ts';
import type { BriefPr } from '../phase0/types.ts';
import { readRepoConfig } from '../preflight/checks.ts';
import { baseOf } from './pr.ts';

export type ChainStatusArgs = Readonly<{ repo: AbsPath }>;
/** The chain oldest first: each arc's previous arc, whether its start is acked, and its PR; K and the unacked starts. */
export type ChainStatus = Readonly<{
  arcs: readonly Readonly<{ arc: ArcId; previousArc: ArcId | null; acked: boolean; pr: BriefPr }>[];
  k: number | null;
  unackedStarts: readonly ArcId[];
}>;

/** An arc of the chain as the PR lookup needs it. */
export type ChainLink = Readonly<{ arc: ArcId; branch: BranchName; previousArc: ArcId | null }>;

export const linkOf = (ref: ArcRef): ChainLink => ({ arc: ref.arc, branch: ref.plan.integrationBranch, previousArc: ref.plan.chain?.previousArc ?? null });

/** The chain's newest tip (see the header), or null when no arc has a ref. */
export function chainHead(repo: AbsPath): ArcRef | null {
  const refs = arcsWithRefs(repo).map((arc) => {
    const ref = readArcRef(repo, arc);
    if (ref === null) throw new Error(`refs/roadmap/${arc} vanished while the chain was read`);
    return ref;
  });
  const named = new Set(refs.flatMap((r) => (r.plan.chain === undefined ? [] : [r.plan.chain.previousArc])));
  const began = (r: ArcRef): string => r.events[0]?.at ?? '';
  const tips = refs.filter((r) => !named.has(r.arc)).sort((a, b) => (began(a) < began(b) ? -1 : began(a) > began(b) ? 1 : a.arc < b.arc ? -1 : 1));
  return tips.at(-1) ?? null;
}

/** The chain ending at `head` (inclusive), oldest first; an arc without a ref ends the walk back. */
export function chainTo(repo: AbsPath, head: ArcRef): readonly ArcRef[] {
  const back = head.plan.chain === undefined ? [] : chainBack(repo, head.plan.chain.previousArc).arcs;
  return [...back, head];
}

const prOf = (p: Pull, needsRebase: boolean): BriefPr => ({
  type: 'pr', number: p.number, url: p.url, state: p.state === 'OPEN' ? 'open' : p.state === 'MERGED' ? 'merged' : 'closed', base: p.base, needsRebase,
});

const forgeFailure = (error: unknown): string | null =>
  error instanceof GhError || error instanceof PushError || error instanceof GitError ? error.message : null;

/** Each link's pull request (see the header), by arc. */
export function prsOf(repo: AbsPath, links: readonly ChainLink[]): ReadonlyMap<ArcId, BriefPr> {
  const out = new Map<ArcId, BriefPr>();
  let forge: RepoIdentity;
  try {
    forge = resolveRepo(repo);
  } catch (error) {
    const reason = forgeFailure(error);
    if (reason === null) throw error;
    for (const l of links) out.set(l.arc, { type: 'unavailable', reason });
    return out;
  }
  for (const l of links) {
    if (l.branch === MAIN_BRANCH) {
      out.set(l.arc, { type: 'none' });
      continue;
    }
    try {
      const pulls = pullsByHead(repo, forge, l.branch);
      const open = onlyIn(pulls, 'OPEN');
      const merged = onlyIn(pulls, 'MERGED');
      const closed = pulls.find((p) => p.state === 'CLOSED');
      if (open !== null) out.set(l.arc, prOf(open, baseOf(repo, forge, l).needsRebase));
      else if (merged !== null) out.set(l.arc, prOf(merged, false));
      else out.set(l.arc, closed === undefined ? { type: 'none' } : prOf(closed, false));
    } catch (error) {
      const reason = forgeFailure(error);
      if (reason === null) throw error;
      out.set(l.arc, { type: 'unavailable', reason });
    }
  }
  return out;
}

/** The chain of `links` (oldest first) with K, the acks and the PRs. */
export function chainStatusOf(repo: AbsPath, links: readonly ChainLink[]): ChainStatus {
  const ids = links.map((l) => l.arc);
  const unacked = unackedStarts(ids, committedAcks(repo));
  const prs = prsOf(repo, links);
  return {
    arcs: links.map((l) => ({ arc: l.arc, previousArc: l.previousArc, acked: !unacked.includes(l.arc), pr: prs.get(l.arc)! })),
    k: readRepoConfig(repo)?.chain?.k ?? null,
    unackedStarts: unacked,
  };
}

export async function chainStatus(args: ChainStatusArgs): Promise<ChainStatus> {
  const head = chainHead(args.repo);
  if (head === null) throw new CliError(`chain status: no arc of ${args.repo} has published a snapshot (refs/roadmap/*)`);
  return chainStatusOf(args.repo, chainTo(args.repo, head).map(linkOf));
}
