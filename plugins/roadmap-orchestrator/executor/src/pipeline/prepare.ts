// The re-entry stage `prepare` (M2; DESIGN-1.0.md §4 Re-entry, SCHEMAS.md "M2", amendments A6 and F14): a
// re-entered unit's first stage, which readies its worktree before the pipeline takes it on.
//
//   1. worktree.create   the unit worktree on a new branch `roadmap/<arc>/<unit>` at the tip of the unit it
//                        re-enters (the integration tip when that unit never had a branch: it parked before
//                        its first build);
//   2. dispatch          the unit's first `dispatch` fact: its scope must lie within the lineage's original
//                        envelope (the root's first pin; apply refuses anything else, so a violation here is
//                        a bug), its risk floor is the higher of the plan's and the lineage's inherited one;
//   3. mergein.prepare   of the integration tip T into the branch, unless the branch already contains T;
//   4. evidence.snapshot of the prepared worktree: what it holds beyond its commit (a conflicted merge's
//                        files; a clean preparation's manifest has zero files). `retire` cites it (F14).
//
// Outcomes (all `advance`, transitions.ts): `conflicted` when the merge-in conflicted (MERGE_HEAD = T is kept,
// A6: a resolve round in a fresh session, since no session inherits), else the plan's `enterAt`:
// `clean-plan-check` (also when absent: approvals do not inherit, so the spec is checked again),
// `clean-build` (a fresh round) or `clean-verify` (lanes at the prepared head).
//
// Re-entry after a crash: the attempt a crash cut short runs again as a new attempt once `recover()` has
// closed its open intent through the op's own M1 reconciler. Each step the log shows done (a created
// worktree, the dispatch fact, a done merge-in, a done snapshot) is read back, never repeated.
import { join, matchesGlob } from 'node:path';
import type { IntentOf, OpKind } from '../core/events.ts';
import type { OpId, Sha, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { DispatchRecord } from '../core/records.ts';
import { type Lineage, maxTier } from '../core/state.ts';
import { type AbsPath, type RefName, type RepoPattern, absPath, branchRef, isoTimeOf } from '../core/values.ts';
import { pathPattern } from '../git/evidence.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget, revParse } from '../git/git.ts';
import type { PlanUnit, ReentryPoint } from '../input/plan.ts';
import { evidenceSnapshotOp, mergeinOp, worktreeCreateOp } from '../recover/ops.ts';
import { type StageContext, evidenceRoot, implementerSeatRev, runOp, unitBranch, unitWorktree } from './dispatch.ts';
import { dirtyPaths } from './lanes.ts';
import { type StageDone, at, executorIdentity, integrationTip, loadUnitSpec, record, start } from './stages.ts';

/** A preparation, recorded: where the prepared worktree is and what `retire` cites. */
export type PrepareDone = StageDone<'prepare'> & Readonly<{
  worktree: AbsPath;
  branch: RefName;
  /** The branch head once prepared: the clean merge, or the re-entered tip (conflicted, or already containing T). */
  head: Sha;
  /** The done `evidence.snapshot` of the prepared worktree. */
  evidence: OpId;
}>;

const CLEAN: Readonly<Record<ReentryPoint, 'clean-plan-check' | 'clean-build' | 'clean-verify'>> = {
  'plan-check': 'clean-plan-check',
  build: 'clean-build',
  verify: 'clean-verify',
};

/** The unit's done ops of `kind` from any of its `prepare` attempts, in log order. */
function preparedOps<K extends OpKind>(view: JournalView, unit: UnitId, kind: K): readonly IntentOf<K>[] {
  return view.opsOf(kind).filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'prepare' && view.doneOf(i.op) !== null);
}

/**
 * Whether `pattern` lies within `envelope`: one of its patterns, or matched by one as a path. The apply
 * classifier's re-entry row uses this same rule (src/input/classify.ts).
 */
export const withinEnvelope = (pattern: RepoPattern, envelope: readonly RepoPattern[]): boolean =>
  envelope.some((e) => pattern === e || matchesGlob(pattern, e));

/**
 * The re-entered unit's dispatch record: the one already pinned (an earlier attempt's), or its first pin,
 * recorded now within the lineage's original envelope at no less than the inherited floor.
 */
function pinReentry(ctx: StageContext, unit: PlanUnit, lineage: Lineage): DispatchRecord {
  const view = ctx.journal.view;
  const current = view.dispatchOf(unit.id);
  if (current !== null) return current;
  const root = view.dispatchesOf(lineage.root)[0];
  if (root === undefined) throw new Error(`re-entry ${unit.id}: its lineage's root ${lineage.root} was never dispatched, so it has no envelope`);
  const outside = unit.scope.filter((p) => !withinEnvelope(p, root.scope));
  if (outside.length > 0) {
    throw new Error(`re-entry ${unit.id}: scope ${outside.join(', ')} lies outside its lineage's envelope ${root.scope.join(', ')} (${lineage.root}'s first pin)`);
  }
  const { spec, sha256 } = loadUnitSpec(ctx, unit);
  const riskFloor = maxTier(unit.risk, view.unit(unit.id).risk);
  const pinned: DispatchRecord = {
    unit: unit.id, specRev: spec.rev, specSha256: sha256, scope: [...unit.scope].sort(), riskFloor, routingRev: ctx.routing().rev,
    implementerSeatRev: implementerSeatRev(ctx.routing(), riskFloor), at: isoTimeOf(new Date()),
  };
  ctx.journal.fact({ kind: 'dispatch', record: pinned });
  return pinned;
}

export async function prepare(ctx: StageContext, unit: PlanUnit): Promise<PrepareDone> {
  const view = ctx.journal.view;
  const lineage = view.unit(unit.id).lineage;
  if (lineage === null) throw new Error(`prepare of ${unit.id}, which re-enters no unit`);
  if (unit.reenters?.unit !== lineage.reenters) {
    throw new Error(`prepare of ${unit.id}: the plan says it re-enters ${unit.reenters?.unit ?? 'nothing'}, the log ${lineage.reenters}`);
  }
  const parent = at(start(ctx, unit.id, 'prepare'), 'prepare');
  const { arc, worktreeRoot, integrationBranch } = ctx.plan();
  const worktree = unitWorktree(worktreeRoot, arc, unit.id);
  const branch = unitBranch(arc, unit.id);

  // 1. The worktree, on a new branch at the re-entered unit's tip.
  const created = view.opsOf('worktree.create').some((i) => i.expect.path === worktree && view.doneOf(i.op) !== null);
  if (!created) {
    const from = refTarget(ctx.repo, unitBranch(arc, lineage.reenters)) ?? integrationTip(ctx);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${unit.id}:unit`, parent, {
      path: worktree, checkout: { type: 'branch', branch, at: from, createBranch: true },
    });
  }

  // 2. The dispatch fact.
  pinReentry(ctx, unit, lineage);

  // 3. The integration tip merged in, unless the branch already holds it.
  let merged = preparedOps(view, unit.id, 'mergein.prepare').at(-1) ?? null;
  if (merged === null && !isAncestor(ctx.repo, integrationTip(ctx), revParse(worktree, 'HEAD'))) {
    merged = await runOp(ctx.journal, mergeinOp(ctx.repo), `mergein:${unit.id}`, parent, {
      worktree, branch, integration: branchRef(integrationBranch), identity: executorIdentity(),
      message: `roadmap ${arc}: merge ${integrationBranch} into unit ${unit.id} (re-entry of ${lineage.reenters})\n`,
    });
  }
  const conflicted = merged?.post.type === 'conflicted';

  // 4. The snapshot of the prepared worktree.
  const snapped = preparedOps(view, unit.id, 'evidence.snapshot').at(-1)
    ?? await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit.id}`, parent, {
      source: worktree, globs: dirtyPaths(worktree).map(pathPattern), dest: absPath(join(evidenceRoot(ctx.runDir, parent), 'prepared')),
    });

  const kind = conflicted ? 'conflicted' : CLEAN[unit.reenters.enterAt ?? 'plan-check'];
  return { ...record(ctx, parent, kind), worktree, branch, head: revParse(worktree, 'HEAD'), evidence: snapped.op };
}
