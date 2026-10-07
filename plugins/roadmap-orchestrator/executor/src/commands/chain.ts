// `roadmap chain status --repo <path>` (M4a, OR-Q19, K10, H20): read-only, no host lock. The chain as `src/chain.ts`
// derives it (the one derivation): the plans in `refs/roadmap/*`, the committed acks and `config.chain.k`, with each
// arc's pull request looked up on the forge by head (non-fatal: `unavailable{reason}`). `status` (its own arc's chain)
// and the brief read the chain through this module too.
//
// - **K and the next start** (`chainQuota`, paid M4a run 12): K is `chain.k` of the config committed at the chain head's
//   baseline (`committedRepoConfig`), never the live file; `nextStart` is src/chain.ts `nextStartOf` for a start chained
//   on the head, the predicate `start` applies. The root agent reads it and never computes K itself.
// - **The head.** The chain ends at the newest tip: of the arcs with a ref that no other arc's plan names as its
//   previous arc, the one whose log began last (its first event's `at`; ties by id). A running arc is in the chain once
//   its first snapshot is published (its first ff or docs publication); until then the chain ends before it.
// - **The PR** of an arc (`prsOf`): its integration branch's pull request by head (`gh pr list --head`): the open one,
//   else the merged one, else a closed one, else `none`; `main` as the integration branch has none. An open PR's
//   `needsRebase` is `roadmap pr`'s base walk (src/commands/pr.ts `baseOf`): a previous arc whose PR was merged by
//   squash or rebase (OR-L5). A forge or git failure is the arc's `unavailable{reason}`, never an error.
import { type ArcRef, arcsWithRefs, chainBack, committedAcks, nextStartOf, readArcRef, unackedStarts } from '../chain.ts';
import type { ArcId } from '../core/ids.ts';
import type { AbsPath, BranchName } from '../core/values.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { type Pull, onlyIn, pullsByHead } from '../forge/pr.ts';
import { MAIN_BRANCH, PushError } from '../forge/push.ts';
import type { RepoIdentity } from '../forge/types.ts';
import { GitError } from '../git/git.ts';
import { CliError } from '../input/cli.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { AckMarker, BriefPr, NextStart } from '../phase0/types.ts';
import { committedRepoConfig } from '../preflight/checks.ts';
import { baseOf } from './pr.ts';

export type ChainStatusArgs = Readonly<{ repo: AbsPath }>;
/** K in force, the unacked starts and the next start of a chain (see the header). */
export type ChainQuota = Readonly<{ k: number | null; unackedStarts: readonly ArcId[]; nextStart: NextStart }>;
/** The chain oldest first: each arc's previous arc, whether its start is acked, and its PR; K, the unacked starts and the next start. */
export type ChainStatus = Readonly<{ arcs: readonly Readonly<{ arc: ArcId; previousArc: ArcId | null; acked: boolean; pr: BriefPr }>[] }> & ChainQuota;

/** The chain's head as the quota reads it: its plan (K at its baseline) and its verified ref (null: none published yet). */
export type ChainEnd = Readonly<{ plan: PlanM1; ref: ArcRef | null }>;

/** The quota of the chain `ids` (oldest first) ending at `head` (see the header). */
export function chainQuota(repo: AbsPath, ids: readonly ArcId[], head: ChainEnd, acks: readonly AckMarker[]): ChainQuota {
  if (ids.at(-1) !== head.plan.arc) throw new Error(`the chain ${ids.join(', ')} does not end at ${head.plan.arc}`);
  const k = committedRepoConfig(repo, head.plan.baseline)?.chain?.k ?? null;
  return { k, unackedStarts: unackedStarts(ids, acks), nextStart: nextStartOf(ids, head.ref, k, acks) };
}

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

/** The chain of `links` (oldest first, ending at `head`) with its quota, the acks and the PRs. */
export function chainStatusOf(repo: AbsPath, links: readonly ChainLink[], head: ChainEnd): ChainStatus {
  const quota = chainQuota(repo, links.map((l) => l.arc), head, committedAcks(repo));
  const prs = prsOf(repo, links);
  return {
    arcs: links.map((l) => ({ arc: l.arc, previousArc: l.previousArc, acked: !quota.unackedStarts.includes(l.arc), pr: prs.get(l.arc)! })),
    ...quota,
  };
}

export async function chainStatus(args: ChainStatusArgs): Promise<ChainStatus> {
  const head = chainHead(args.repo);
  if (head === null) throw new CliError(`chain status: no arc of ${args.repo} has published a snapshot (refs/roadmap/*)`);
  return chainStatusOf(args.repo, chainTo(args.repo, head).map(linkOf), { plan: head.plan, ref: head });
}
