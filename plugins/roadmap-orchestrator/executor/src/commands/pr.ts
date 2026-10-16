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
//
// Supersession (owner ruling 2026-10-16): when arc N+1 started on arc N's head before N's PR merged, fixes N's PR needs
// (its CI, the owner's review) land as priority units of N+1, and `roadmap pr --arc <N+1> --supersede-previous` makes
// N+1's PR supersede N's: its body opens with `Supersedes <N's PR url>` (the forge is the only record), it targets N's
// base, and N's PR is closed with a comment naming it. Every later run, with or without the flag, keeps that: the base
// walk passes a superseded PR as it passes one merged with a merge commit, and a run finishes a close a crash cut short.
// Refused: no previous arc, the previous arc's PR merged already, or no open PR of it to supersede.
import { type ArcRef, ArcRefError, amendmentsOf, completedHeadOf, readArcRef } from '../chain.ts';
import type { ArcId, Sha } from '../core/ids.ts';
import { type AbsPath, type BranchName, branchName } from '../core/values.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { type Pull, closePull, createPull, onlyIn, pullBody, pullTitle, pullsByHead, retargetPull, rewritePull } from '../forge/pr.ts';
import { MAIN_BRANCH, PushError, inHistoryOnOrigin, pushBranch } from '../forge/push.ts';
import type { RepoIdentity } from '../forge/types.ts';
import { GitError } from '../git/git.ts';
import { snapshotRef } from '../git/snapshot.ts';
import { CliError } from '../input/cli.ts';

/** `supersedePrevious`: `--supersede-previous` (see the header). */
export type PrArgs = Readonly<{ repo: AbsPath; arc: ArcId; supersedePrevious: boolean }>;
/** `supersedes`: the URL of the previous arc's PR this one supersedes, or null. */
export type PrOutcome = Readonly<{ number: number; url: string; base: string; created: boolean; retargeted: boolean; needsRebase: boolean; supersedes: string | null }>;

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

/**
 * The branch the arc's PR targets now (step 2 of the header); the brief and `chain status` read its `needsRebase` (C4).
 * A previous arc's PR that a PR of the walk supersedes (the arc's own, `supersedes` before it records it, or a merged
 * one walked past) hands its own base down.
 */
export function baseOf(repo: AbsPath, forge: RepoIdentity, arc: Pick<CompletedArc, 'arc' | 'branch' | 'previousArc'>, supersedes: string | null = null): Base {
  const superseded = new Set<string>(pullsByHead(repo, forge, arc.branch).flatMap((p) => (p.state !== 'CLOSED' && p.supersedes !== null ? [p.supersedes] : [])));
  if (supersedes !== null) superseded.add(supersedes);
  const seen = new Set<ArcId>([arc.arc]);
  for (let previous = arc.previousArc; previous !== null;) {
    if (seen.has(previous)) throw new CliError(`pr: the chain of ${arc.arc} loops at ${previous}`);
    seen.add(previous);
    const p = completedArc(repo, previous);
    if (p.branch === arc.branch) throw new CliError(`pr: arcs ${previous} and ${arc.arc} share the integration branch ${arc.branch}; stacked arcs need their own`);
    const pulls = pullsByHead(repo, forge, p.branch);
    const merged = onlyIn(pulls, 'MERGED');
    if (merged === null) {
      if (!pulls.some((x) => superseded.has(x.url))) return { branch: p.branch, needsRebase: false };
    } else {
      if (merged.supersedes !== null) superseded.add(merged.supersedes);
      if (!inHistoryOnOrigin(repo, p.head, merged.mergeCommit as Sha)) return { branch: p.branch, needsRebase: true };
    }
    previous = p.previousArc;
  }
  return { branch: MAIN_BRANCH, needsRebase: false };
}

const outcome = (pull: Pull, created: boolean, retargeted: boolean, needsRebase: boolean): PrOutcome => ({
  number: pull.number, url: pull.url, base: pull.base, created, retargeted, needsRebase, supersedes: pull.supersedes,
});

/** The previous arc's open PR that `--supersede-previous` supersedes; refused when there is none to supersede. */
function supersessionTarget(repo: AbsPath, forge: RepoIdentity, arc: CompletedArc, merged: Pull | null): Pull {
  if (arc.previousArc === null) throw new CliError(`pr: arc ${arc.arc} is the first of its chain; --supersede-previous needs a previous arc's PR`);
  if (merged !== null) throw new CliError(`pr: ${merged.url} for ${arc.branch} is merged; a merged PR supersedes nothing`);
  const p = completedArc(repo, arc.previousArc);
  const pulls = pullsByHead(repo, forge, p.branch);
  const pMerged = onlyIn(pulls, 'MERGED');
  if (pMerged !== null) throw new CliError(`pr: arc ${p.arc}'s PR ${pMerged.url} merged already; there is nothing to supersede: run roadmap pr without --supersede-previous`);
  const open = onlyIn(pulls, 'OPEN');
  if (open === null) throw new CliError(`pr: arc ${p.arc} has no open PR for ${p.branch} to supersede`);
  return open;
}

/** Closes the superseded PR when it is still open (a run after a crash between the rewrite and the close finishes it). */
function closeSuperseded(repo: AbsPath, forge: RepoIdentity, arc: CompletedArc, url: string, by: string): void {
  if (arc.previousArc === null) throw new Error(`arc ${arc.arc}'s PR ${by} supersedes ${url}, but the arc has no previous arc`);
  const target = pullsByHead(repo, forge, completedArc(repo, arc.previousArc).branch).find((p) => p.url === url);
  if (target === undefined) throw new CliError(`pr: ${by} supersedes ${url}, which is no PR of arc ${arc.previousArc}`);
  if (target.state === 'OPEN') closePull(repo, forge, target.number, `Superseded by ${by} (arc ${arc.arc}), which carries this arc's commits and the fixes this PR needed.`);
}

export async function openPr(args: PrArgs): Promise<PrOutcome> {
  try {
    const arc = completedArc(args.repo, args.arc);
    if (arc.branch === branchName(MAIN_BRANCH)) throw new CliError(`pr: arc ${arc.arc} integrates on ${MAIN_BRANCH}; a PR needs an arc branch`);
    const forge = resolveRepo(args.repo);
    pushBranch(args.repo, arc.branch, arc.head);
    const pulls = pullsByHead(args.repo, forge, arc.branch);
    const open = onlyIn(pulls, 'OPEN');
    const merged = onlyIn(pulls, 'MERGED');
    const declared = open?.supersedes ?? merged?.supersedes ?? null;
    const supersedes = declared ?? (args.supersedePrevious ? supersessionTarget(args.repo, forge, arc, merged).url : null);
    const base = baseOf(args.repo, forge, arc, supersedes);
    const body = (): string => pullBody({
      arc: arc.arc, branch: arc.branch, head: arc.head, previousArc: arc.previousArc,
      amendments: arc.amendments.map((a) => ({ ref: a.id, rules: a.fact.rules, proposal: a.fact.proposal, why: a.fact.why })),
      supersedes: supersedes === null || arc.previousArc === null ? null : { url: supersedes, arc: arc.previousArc },
    });
    let result: PrOutcome;
    if (open !== null) {
      if (open.supersedes !== supersedes) {
        rewritePull(args.repo, forge, open.number, base.branch, body());
        result = outcome({ ...open, base: base.branch, supersedes }, false, open.base !== base.branch, base.needsRebase);
      } else if (open.base !== base.branch) {
        retargetPull(args.repo, forge, open.number, base.branch);
        result = outcome({ ...open, base: base.branch }, false, true, base.needsRebase);
      } else result = outcome(open, false, false, base.needsRebase);
    } else if (merged !== null) result = outcome(merged, false, false, base.needsRebase);
    else {
      const closed = pulls.find((p) => p.state === 'CLOSED');
      if (closed !== undefined) {
        throw new CliError(`pr: ${closed.url} for ${arc.branch} was closed unmerged; when a later arc's PR superseded it, that PR carries this arc (roadmap pr --arc <later arc>); otherwise reopen it or delete it, then re-run`);
      }
      result = outcome(createPull(args.repo, forge, { base: base.branch, head: arc.branch, title: pullTitle(arc.arc), body: body() }), true, false, base.needsRebase);
    }
    if (supersedes !== null) closeSuperseded(args.repo, forge, arc, supersedes, result.url);
    return result;
  } catch (error) {
    if (error instanceof GhError || error instanceof PushError || error instanceof GitError) throw new CliError(`pr: ${error.message}`);
    throw error;
  }
}
