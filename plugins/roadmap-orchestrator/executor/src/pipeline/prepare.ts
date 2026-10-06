// The stage `prepare` (M2; DESIGN-1.0.md §4 Re-entry, SCHEMAS.md "M2", amendments A6 and F14): a re-entered unit's
// first stage, which readies its worktree before the pipeline takes it on; and (M4a rev 3, F4) a unit's way back from a
// known defect (its decided outcome is lanes `known-defect`), once admission lets it in (the defect's fixer merged, or
// the entry was removed or retargeted).
//
// Cause `re-entry`:
//
//   1. worktree.create   the unit worktree on a new branch `roadmap/<arc>/<unit>` at the tip of the unit it
//                        re-enters (the integration tip when that unit never had a branch: it parked before
//                        its first build);
//   2. dispatch          the unit's first `dispatch` fact: its scope must lie within the lineage's envelope (every
//                        scope a member was dispatched with, src/input/envelope.ts) or the patterns its
//                        `unit-reentered` change widened it by on a ruling (F5); apply refuses anything else, so a
//                        violation here is a bug; its risk floor is the higher of the plan's and the lineage's inherited one; its
//                        routing, bounds and transient rules are its own, as any first pin's (M3, `firstPin`);
//   3. mergein.prepare   of the integration tip T into the branch, unless the branch already contains T;
//   4. evidence.snapshot of the prepared worktree: what it holds beyond its commit (a conflicted merge's
//                        files; a clean preparation's manifest has zero files). `retire` cites it (F14).
//
// Outcomes (all `advance`, transitions.ts): `conflicted` when the merge-in conflicted (MERGE_HEAD = T is kept,
// A6: a resolve round in a fresh session, since no session inherits), else the plan's `enterAt`:
// `clean-plan-check` (also when absent: approvals do not inherit, so the spec is checked again),
// `clean-build` (a fresh round) or `clean-verify` (lanes at the prepared head).
//
// Cause `known-defect` (F4): steps 3 and 4 only, in the unit's own worktree (it built), scoped to the prepare attempts
// after the known-defect outcome (never an earlier preparation's merge, e.g. the re-entry's), with crash label
// `prepare.known-defect-after-mergein` after the merge-in. Outcomes: `conflicted` (a resolve round), else `clean-verify`
// (lanes at the prepared head).
//
// Re-entry after a crash: the attempt a crash cut short runs again as a new attempt once `recover()` has
// closed its open intent through the op's own M1 reconciler. Each step the log shows done (a created
// worktree, the dispatch fact, a done merge-in, a done snapshot) is read back, never repeated.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpKind, ReentryWidening } from '../core/events.ts';
import type { OpId, Sha, UnitId } from '../core/ids.ts';
import { readJournal } from '../core/log.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { DispatchRecord } from '../core/records.ts';
import { type Lineage, maxTier } from '../core/state.ts';
import { type AbsPath, type RefName, type RepoPattern, absPath, branchRef } from '../core/values.ts';
import { pathPattern } from '../git/evidence.ts';
import { isAncestor } from '../git/ff.ts';
import { refTarget, revParse } from '../git/git.ts';
import { lineageEnvelope, withinEnvelope } from '../input/envelope.ts';
import type { PlanUnit, ReentryPoint } from '../input/plan.ts';
import { evidenceSnapshotOp, mergeinOp, worktreeCreateOp } from '../recover/ops.ts';
import { type StageContext, evidenceRoot, firstPin, runOp, unitBranch, unitWorktree } from './dispatch.ts';
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

/** The unit's done ops of `kind` from its `prepare` attempts after attempt `after` (0: any), in log order. */
function preparedOps<K extends OpKind>(view: JournalView, unit: UnitId, kind: K, after = 0): readonly IntentOf<K>[] {
  return view.opsOf(kind).filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.parent.stage === 'prepare' && i.parent.attempt > after
    && view.doneOf(i.op) !== null);
}

/** The widening the `unit-reentered` change that added `unit` recorded (F5), or null; fails loud when no such change is in the log. */
function reentryWidening(ctx: StageContext, unit: UnitId): ReentryWidening | null {
  for (const e of readJournal(ctx.runDir, ctx.journal.view.arc).events) {
    if (e.type !== 'fact' || e.fact.kind !== 'plan-applied') continue;
    const c = e.fact.changes.find((x) => x.type === 'unit-reentered' && x.unit === unit);
    if (c !== undefined && c.type === 'unit-reentered') return c.widened ?? null;
  }
  throw new Error(`re-entry ${unit}: no plan-applied fact records its unit-reentered change`);
}

/**
 * The re-entered unit's dispatch record: the one already pinned (an earlier attempt's), or its first pin,
 * recorded now within the lineage's envelope (or the patterns its re-entry widened it by) at no less than the
 * inherited floor.
 */
function pinReentry(ctx: StageContext, unit: PlanUnit, lineage: Lineage): DispatchRecord {
  const view = ctx.journal.view;
  const current = view.dispatchOf(unit.id);
  if (current !== null) return current;
  const envelope = lineageEnvelope(view, lineage.root);
  if (envelope.length === 0) throw new Error(`re-entry ${unit.id}: its lineage (root ${lineage.root}) was never dispatched, so it has no envelope`);
  const allowed: readonly RepoPattern[] = [...envelope, ...(reentryWidening(ctx, unit.id)?.patterns ?? [])];
  const outside = unit.scope.filter((p) => !withinEnvelope(p, allowed));
  if (outside.length > 0) {
    throw new Error(`re-entry ${unit.id}: scope ${outside.join(', ')} lies outside its lineage's envelope ${allowed.join(', ')} (${lineage.root}'s lineage, and its widening)`);
  }
  const { spec, sha256 } = loadUnitSpec(ctx, unit);
  const pinned = firstPin(ctx, unit, { rev: spec.rev, sha256 }, maxTier(unit.risk, view.unit(unit.id).risk));
  ctx.journal.fact({ kind: 'dispatch', record: pinned });
  return pinned;
}

export async function prepare(ctx: StageContext, unit: PlanUnit): Promise<PrepareDone> {
  const view = ctx.journal.view;
  const u = view.unit(unit.id);
  const decided = u.decided;
  if (decided?.stage === 'lanes' && decided.outcome === 'known-defect') return prepareKnownDefect(ctx, unit, decided.attempt);
  const lineage = u.lineage;
  if (lineage === null) throw new Error(`prepare of ${unit.id}, which re-enters no unit and hit no known defect`);
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

/**
 * F4: the unit's way back from a known defect: the integration tip merged into its branch unless the branch holds it
 * already, then the snapshot; both only from the prepare attempts after the known-defect outcome (`since`, its attempt).
 */
async function prepareKnownDefect(ctx: StageContext, unit: PlanUnit, since: number): Promise<PrepareDone> {
  const view = ctx.journal.view;
  const parent = at(start(ctx, unit.id, 'prepare'), 'prepare');
  const { arc, worktreeRoot, integrationBranch } = ctx.plan();
  const worktree = unitWorktree(worktreeRoot, arc, unit.id);
  const branch = unitBranch(arc, unit.id);
  if (!existsSync(worktree)) throw new Error(`prepare of ${unit.id} after a known defect: its worktree ${worktree} does not exist, yet the unit built`);

  let merged = preparedOps(view, unit.id, 'mergein.prepare', since).at(-1) ?? null;
  if (merged === null && !isAncestor(ctx.repo, integrationTip(ctx), revParse(worktree, 'HEAD'))) {
    merged = await runOp(ctx.journal, mergeinOp(ctx.repo), `mergein:${unit.id}`, parent, {
      worktree, branch, integration: branchRef(integrationBranch), identity: executorIdentity(),
      message: `roadmap ${arc}: merge ${integrationBranch} into unit ${unit.id} (after a known defect)\n`,
    });
    crashPoint('prepare.known-defect-after-mergein', unit.id);
  }
  const snapped = preparedOps(view, unit.id, 'evidence.snapshot', since).at(-1)
    ?? await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit.id}`, parent, {
      source: worktree, globs: dirtyPaths(worktree).map(pathPattern), dest: absPath(join(evidenceRoot(ctx.runDir, parent), 'prepared')),
    });
  const kind = merged?.post.type === 'conflicted' ? 'conflicted' : 'clean-verify';
  return { ...record(ctx, parent, kind), worktree, branch, head: revParse(worktree, 'HEAD'), evidence: snapped.op };
}
