// `roadmap pr --repo <path> --arc <arc>` (M4a, OR-Q19, OR-L5, OR-L7): a host act, idempotent, the forge its only record.
//
// It reads the arc from its verified `refs/roadmap/<arc>` alone, through the chain's one derivation (src/chain.ts, H20):
// the plan in force (integration branch, `chain`), the latest `arc-completed` head (no plan revision after it), and the
// `corpus-amendment` facts. Then:
// 1. pushes the completed head to `origin`'s integration branch by a leased fast-forward, never `main` (src/forge/push.ts);
// 2. derives the base: `main` for the chain's first arc, else the previous arc's branch. A previous arc whose PR merged
//    with a merge commit (its head in the merge's history) hands its own base down, walking the chain; one merged by
//    squash or rebase stops the walk at its branch and flags `needsRebase`;
// 3. finds the arc's PR by head: an open one is re-targeted when its base differs; a merged one is reported as is; none
//    is created with a code-rendered body that lists the arc's amendments and says to merge with merge commits.
// A closed, unmerged PR is the owner's decision and is refused, as is any forge or git failure (a CLI error).
import { type ArcRef, ArcRefError, amendmentsOf, completedHeadOf, readArcRef } from '../chain.ts';
import type { ArcId, Sha } from '../core/ids.ts';
import { type AbsPath, type BranchName, branchName } from '../core/values.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { type Pull, createPull, onlyIn, pullBody, pullTitle, pullsByHead, retargetPull } from '../forge/pr.ts';
import { MAIN_BRANCH, PushError, inHistoryOnOrigin, pushBranch } from '../forge/push.ts';
import type { RepoIdentity } from '../forge/types.ts';
import { GitError } from '../git/git.ts';
import { snapshotRef } from '../git/snapshot.ts';
import { CliError } from '../input/cli.ts';

export type PrArgs = Readonly<{ repo: AbsPath; arc: ArcId }>;
export type PrOutcome = Readonly<{ number: number; url: string; base: string; created: boolean; retargeted: boolean; needsRebase: boolean }>;

/** What `roadmap pr` needs of a completed arc, read from its verified ref. */
type CompletedArc = Readonly<{
  arc: ArcId;
  branch: BranchName;
  head: Sha;
  previousArc: ArcId | null;
  amendments: ReturnType<typeof amendmentsOf>;
}>;

function completedArc(repo: AbsPath, arc: ArcId): CompletedArc {
  let ref: ArcRef | null;
  try {
    ref = readArcRef(repo, arc);
  } catch (error) {
    if (error instanceof ArcRefError) throw new CliError(`pr: ${error.message}`);
    throw error;
  }
  if (ref === null) throw new CliError(`pr: no ${snapshotRef(arc)}; arc ${arc} has published no snapshot`);
  const completed = completedHeadOf(ref);
  if (completed === null) throw new CliError(`pr: arc ${arc} has not completed (${snapshotRef(arc)} holds no arc-completed after its latest plan revision)`);
  return {
    arc,
    branch: ref.plan.integrationBranch,
    head: completed.head,
    previousArc: ref.plan.chain?.previousArc ?? null,
    amendments: amendmentsOf(ref),
  };
}

export type Base = Readonly<{ branch: string; needsRebase: boolean }>;

/** The branch the arc's PR targets now (step 2 of the header); the brief and `chain status` read its `needsRebase` (C4). */
export function baseOf(repo: AbsPath, forge: RepoIdentity, arc: Pick<CompletedArc, 'arc' | 'branch' | 'previousArc'>): Base {
  const seen = new Set<ArcId>([arc.arc]);
  for (let previous = arc.previousArc; previous !== null;) {
    if (seen.has(previous)) throw new CliError(`pr: the chain of ${arc.arc} loops at ${previous}`);
    seen.add(previous);
    const p = completedArc(repo, previous);
    if (p.branch === arc.branch) throw new CliError(`pr: arcs ${previous} and ${arc.arc} share the integration branch ${arc.branch}; stacked arcs need their own`);
    const merged = onlyIn(pullsByHead(repo, forge, p.branch), 'MERGED');
    if (merged === null) return { branch: p.branch, needsRebase: false };
    if (!inHistoryOnOrigin(repo, p.head, merged.mergeCommit as Sha)) return { branch: p.branch, needsRebase: true };
    previous = p.previousArc;
  }
  return { branch: MAIN_BRANCH, needsRebase: false };
}

const outcome = (pull: Pull, created: boolean, retargeted: boolean, needsRebase: boolean): PrOutcome => ({
  number: pull.number, url: pull.url, base: pull.base, created, retargeted, needsRebase,
});

export async function openPr(args: PrArgs): Promise<PrOutcome> {
  try {
    const arc = completedArc(args.repo, args.arc);
    if (arc.branch === branchName(MAIN_BRANCH)) throw new CliError(`pr: arc ${arc.arc} integrates on ${MAIN_BRANCH}; a PR needs an arc branch`);
    const forge = resolveRepo(args.repo);
    pushBranch(args.repo, arc.branch, arc.head);
    const base = baseOf(args.repo, forge, arc);
    const pulls = pullsByHead(args.repo, forge, arc.branch);
    const open = onlyIn(pulls, 'OPEN');
    if (open !== null) {
      if (open.base === base.branch) return outcome(open, false, false, base.needsRebase);
      retargetPull(args.repo, forge, open.number, base.branch);
      return outcome({ ...open, base: base.branch }, false, true, base.needsRebase);
    }
    const merged = onlyIn(pulls, 'MERGED');
    if (merged !== null) return outcome(merged, false, false, base.needsRebase);
    const closed = pulls.find((p) => p.state === 'CLOSED');
    if (closed !== undefined) throw new CliError(`pr: ${closed.url} for ${arc.branch} was closed unmerged; reopen it or delete it, then re-run`);
    const body = pullBody({
      arc: arc.arc, branch: arc.branch, head: arc.head, previousArc: arc.previousArc,
      amendments: arc.amendments.map((a) => ({ ref: a.id, rules: a.fact.rules, proposal: a.fact.proposal, why: a.fact.why })),
    });
    return outcome(createPull(args.repo, forge, { base: base.branch, head: arc.branch, title: pullTitle(arc.arc), body }), true, false, base.needsRebase);
  } catch (error) {
    if (error instanceof GhError || error instanceof PushError || error instanceof GitError) throw new CliError(`pr: ${error.message}`);
    throw error;
  }
}
