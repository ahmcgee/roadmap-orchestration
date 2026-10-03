// `roadmap pr --repo <path> --arc <arc>` (M4a, OR-Q19, OR-L5, OR-L7): a host act, idempotent, the forge its only record.
//
// It reads the arc from its verified `refs/roadmap/<arc>` alone: the plan in force (integration branch, `chain`), the
// latest `arc-completed` head (no plan revision after it), and the `corpus-amendment` facts. Then:
// 1. pushes the completed head to `origin`'s integration branch by a leased fast-forward, never `main` (src/forge/push.ts);
// 2. derives the base: `main` for the chain's first arc, else the previous arc's branch. A previous arc whose PR merged
//    with a merge commit (its head in the merge's history) hands its own base down, walking the chain; one merged by
//    squash or rebase stops the walk at its branch and flags `needsRebase`;
// 3. finds the arc's PR by head: an open one is re-targeted when its base differs; a merged one is reported as is; none
//    is created with a code-rendered body that lists the arc's amendments and says to merge with merge commits.
// A closed, unmerged PR is the owner's decision and is refused, as is any forge or git failure (a CLI error).
import { type ArcId, type Sha, amendmentRefOf } from '../core/ids.ts';
import { type Event, type Fact, parseEventLine } from '../core/events.ts';
import { type AbsPath, type BranchName, branchName } from '../core/values.ts';
import { GhError, resolveRepo } from '../forge/gh.ts';
import { type Pull, createPull, onlyIn, pullBody, pullTitle, pullsByHead, retargetPull } from '../forge/pr.ts';
import { MAIN_BRANCH, PushError, inHistoryOnOrigin, pushBranch } from '../forge/push.ts';
import type { RepoIdentity } from '../forge/types.ts';
import { GitError, git, refTarget } from '../git/git.ts';
import { snapshotRef, verifySnapshot } from '../git/snapshot.ts';
import { PLAN_INPUT } from '../input/inforce.ts';
import { CliError } from '../input/cli.ts';
import { parsePlan } from '../input/plan.ts';
import { EVENTS_FILE } from '../core/log.ts';

export type PrArgs = Readonly<{ repo: AbsPath; arc: ArcId }>;
export type PrOutcome = Readonly<{ number: number; url: string; base: string; created: boolean; retargeted: boolean; needsRebase: boolean }>;

/** What `roadmap pr` needs of a completed arc, read from its verified ref. */
type CompletedArc = Readonly<{
  arc: ArcId;
  branch: BranchName;
  head: Sha;
  previousArc: ArcId | null;
  amendments: readonly Extract<Fact, { kind: 'corpus-amendment' }>[];
}>;

function completedArc(repo: AbsPath, arc: ArcId): CompletedArc {
  const ref = snapshotRef(arc);
  const commit = refTarget(repo, ref);
  if (commit === null) throw new CliError(`pr: no ${ref}; arc ${arc} has published no snapshot`);
  const check = verifySnapshot(repo, commit);
  if (check.kind === 'mismatch') throw new CliError(`pr: ${ref} at ${commit} does not verify: ${check.detail}`);
  if (check.manifest.arc !== arc) throw new CliError(`pr: ${ref} at ${commit} is a snapshot of arc ${check.manifest.arc}`);
  const events: readonly Event[] = git(repo, ['cat-file', 'blob', `${commit}:${EVENTS_FILE}`]).split('\n').filter((l) => l !== '').map(parseEventLine);
  const facts = events.flatMap((e) => (e.type === 'fact' ? [{ seq: e.seq, fact: e.fact }] : []));
  const applied = facts.findLast((f) => f.fact.kind === 'plan-applied');
  const completed = facts.findLast((f) => f.fact.kind === 'arc-completed');
  if (applied === undefined || applied.fact.kind !== 'plan-applied') throw new CliError(`pr: arc ${arc} has no plan in force in ${ref}`);
  if (completed === undefined || completed.fact.kind !== 'arc-completed' || completed.seq < applied.seq) {
    throw new CliError(`pr: arc ${arc} has not completed (${ref} holds no arc-completed after its latest plan revision)`);
  }
  const plan = parsePlan(JSON.parse(git(repo, ['cat-file', 'blob', `${commit}:inputs/${applied.fact.planSha256}.${PLAN_INPUT}`])));
  return {
    arc,
    branch: plan.integrationBranch,
    head: completed.fact.head,
    previousArc: plan.chain?.previousArc ?? null,
    amendments: facts.flatMap((f) => (f.fact.kind === 'corpus-amendment' ? [f.fact] : [])),
  };
}

type Base = Readonly<{ branch: string; needsRebase: boolean }>;

/** The branch the arc's PR targets now (step 2 of the header). */
function baseOf(repo: AbsPath, forge: RepoIdentity, arc: CompletedArc): Base {
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
      amendments: arc.amendments.map((a) => ({ ref: amendmentRefOf(arc.arc, a.id), rules: a.rules, proposal: a.proposal, why: a.why })),
    });
    return outcome(createPull(args.repo, forge, { base: base.branch, head: arc.branch, title: pullTitle(arc.arc), body }), true, false, base.needsRebase);
  } catch (error) {
    if (error instanceof GhError || error instanceof PushError || error instanceof GitError) throw new CliError(`pr: ${error.message}`);
    throw error;
  }
}
