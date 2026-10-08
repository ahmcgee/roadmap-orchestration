// Mutation smoke before the gate (M4a rev 3, D2, Q15, Q16, Q17, Q25, R38, R54; corpus arcs only, LR-h).
//
// After witness presence is green (src/pipeline/witnesscheck.ts), the unit's production change is reverted in a detached
// worktree and its smoke targets (`smokeTargets`: the `target` rows of its required witnesses; preservation must-holds are
// never smoked) run again under `purpose: mutant`. A target that still passes did not need the change: it does not prove
// what the change does.
//
//   bound      the unit's pinned risk floor is `med` or `high` (`low-risk`); it has targets (`no-targets`); each target
//              lane declares `testPaths` (`no-test-paths`); the production diff (`diffBase(T, salvaged)..salvaged` minus the
//              paths any target lane's `testPaths` match) is not empty (`tests-only-diff`). Otherwise `notRun{reason}`.
//   mutant     `git diff --numstat -M` of the production paths: a binary path or a rename makes every target inconclusive
//              (Q25). Else the reverse patch `git diff -R --no-renames --full-index base salvaged -- <prod>`, kept as
//              `inputs/<sha256>.patch`. A patch git cannot parse (`corrupt`) or that does not apply at `salvaged` makes every
//              target inconclusive.
//   allowance  (Q17) key = sha256 of {the patch's sha256, each target lane's rev, env id and target test ids}. A
//              `smoke-ran` of the unit with the same key is reused: its verdict is this attempt's, nothing runs. Executions
//              per unit (its smoke `mutant.apply` intents: blocked runs and crash retries count) are capped by the pinned
//              `smokeRuns`; past it `notRun{allowance}`.
//   run        `mutant.apply{of: smoke{unit, attempt}}` at `salvaged` in `smokeWorktree`, then each target lane (ascending)
//              under the attempt's holder, its record named by `witnessed{purpose: mutant, for: smoke{unit, attempt, of:
//              salvaged}}` (G13: never certifies), then `worktree.remove` citing the last run's evidence, then
//              `smoke-ran{unit, attempt, key, verdict}`.
//   verdict    per target test: killed = the record is not malformed, selected > 0 and the outcome `fail`; survived = not
//              malformed, selected > 0 and `pass`; inconclusive = anything else (missing, zero-selected, skipped, malformed,
//              its lane blocked or faulted).
//
// The lanes stage then records `smoke-survived{obligations, testIds}` (the table's bounded smoke round: `smokeRounds` fix
// rounds, then the gate decides with the survivors in `checks.smoke`, R38) or goes on to the gate. The gate's
// `checks.smoke` (`gateSmokeChecks`) reads the attempt's `smoke-ran`, or recomputes why smoke did not run.
//
// Crash safety (MUTATION_SMOKE): an open `mutant.apply` closes through its reconciler; a smoke worktree a crash left is
// removed first (`removeMutantLeftovers`); a crashed attempt's `smoke-ran` is found by key on the next attempt and reused
// (no rerun); a crash before it counts the execution against `smokeRuns` and runs again.
import { basename } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { type SmokeVerdict, type TestRef, testRefKey } from '../core/events.ts';
import { type LaneId, type ObligationId, type ResourceInstance, type Sha, type Sha256Hex, compareIds } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import type { NeedsUserContent } from '../core/records.ts';
import { type RepoPath, matchesPattern, repoPath } from '../core/values.ts';
import { gitRun } from '../git/git.ts';
import { MUTANT_PATCH_INPUT, mutantPatchPath, patchedTree } from '../git/mutant.ts';
import { smokeLaneDir } from '../git/snapshot.ts';
import { diffBase } from '../git/transient.ts';
import { type RequiredWitness, smokeTargets } from '../holistic/required.ts';
import { type ArcLaneDef, type WitnessRecord, laneRevOf } from '../holistic/types.ts';
import { keepInput } from '../input/inforce.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { GateChecks, SmokeNotRun } from '../prompts/inputs.ts';
import { probe } from '../resources/probe.ts';
import { type Reservation, type StageHolder, cleanup, heldReservation, run } from '../resources/reserve.ts';
import { type StageContext, type StageParent, dispatchOf, smokeWorktree } from './dispatch.ts';
import { type LaneRuntime, laneEnvId, laneRequest } from './lanes.ts';
import { type LaneCancel, laneAbortReason } from './redlane.ts';
import { applyMutant, removeMutantLeftovers, removeMutantWorktree, runMutantLane } from './reproduce.ts';
import { integrationTip, stageHolder } from './stages.ts';
import { checksApply, requiredLanes } from './witnesscheck.ts';

/** What the smoke of one lanes attempt came to. */
export type SmokeEnd =
  | Readonly<{ kind: 'not-run'; reason: SmokeNotRun }>
  | Readonly<{ kind: 'ran'; verdict: SmokeVerdict; targets: readonly RequiredWitness[] }>
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>;

/** What a smoke would run, once its bound holds: the targets, their lanes, the production paths and the diff base. */
type SmokePlan = Readonly<{ targets: readonly RequiredWitness[]; refs: readonly TestRef[]; lanes: readonly ArcLaneDef[]; base: Sha; prod: readonly RepoPath[] }>;

/** Each target test once, ascending by lane then test id. */
const refsOf = (targets: readonly RequiredWitness[]): readonly TestRef[] =>
  [...new Map(targets.map((t) => [testRefKey(t), { lane: t.lane, testId: t.testId }] as const)).entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, r]) => r);

/** The paths `base..salvaged` adds, modifies or deletes (renames split in two), ascending. */
function changedPaths(ctx: StageContext, base: Sha, salvaged: Sha): readonly RepoPath[] {
  const out = gitRun(ctx.repo, ['diff', '--name-only', '-z', '--no-renames', base, salvaged]).stdout;
  return out.split('\0').filter((p) => p !== '').map((p) => repoPath(p)).sort();
}

/** Literal pathspecs of `paths` (no glob magic). */
const literal = (paths: readonly RepoPath[]): readonly string[] => paths.map((p) => `:(literal)${p}`);

/** The smoke's plan at `salvaged`, or why it does not run (the bound; the allowance is checked after the key). */
function smokePlan(ctx: StageContext, unit: PlanUnit, salvaged: Sha, required: readonly RequiredWitness[]): SmokePlan | Readonly<{ notRun: SmokeNotRun }> {
  if (dispatchOf(ctx.journal.view, unit.id).riskFloor === 'low') return { notRun: 'low-risk' };
  const targets = smokeTargets(required);
  if (targets.length === 0) return { notRun: 'no-targets' };
  const lanes = requiredLanes(ctx, targets);
  if (lanes.some((l) => l.testPaths === undefined)) return { notRun: 'no-test-paths' };
  const testPaths = lanes.flatMap((l) => l.testPaths ?? []);
  const base = diffBase(ctx.repo, integrationTip(ctx), salvaged);
  const prod = changedPaths(ctx, base, salvaged).filter((p) => !testPaths.some((t) => matchesPattern(p, t)));
  if (prod.length === 0) return { notRun: 'tests-only-diff' };
  return { targets, refs: refsOf(targets), lanes, base, prod };
}

/** Whether the production diff holds a binary path or a rename (Q25: the smoke is inconclusive). */
function binaryOrRename(ctx: StageContext, plan: SmokePlan, salvaged: Sha): boolean {
  const out = gitRun(ctx.repo, ['diff', '--numstat', '-z', '-M', plan.base, salvaged, '--', ...literal(plan.prod)]).stdout;
  // -z numstat: `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`.
  return out.split('\0').some((field) => /^-\t-\t/.test(field) || /^\d+\t\d+\t$/.test(field));
}

/** The reverse patch of the production diff: the change undone, the tests kept. */
function reversePatch(ctx: StageContext, plan: SmokePlan, salvaged: Sha): Buffer {
  return Buffer.from(gitRun(ctx.repo, ['diff', '-R', '--no-renames', '--full-index', plan.base, salvaged, '--', ...literal(plan.prod)]).stdout, 'utf8');
}

/** The allowance key (Q17): the patch, each target lane's rev and environment, and the target test ids. */
function smokeKey(ctx: StageContext, plan: SmokePlan, patchSha256: Sha256Hex): Sha256Hex {
  const lanes = plan.lanes.map((l) => ({ lane: l.id, laneRev: laneRevOf(l), envId: laneEnvId(ctx, l), testIds: plan.refs.filter((r) => r.lane === l.id).map((r) => r.testId) }));
  return sha256Hex(canonicalJson({ patch: patchSha256, lanes })) as Sha256Hex;
}

/** Every target inconclusive (the mutant could not be made). */
const allInconclusive = (refs: readonly TestRef[]): SmokeVerdict => ({ killed: [], survived: [], inconclusive: refs });

/** The executions of `unit`'s smoke so far: its smoke `mutant.apply` intents (a blocked run and a crash retry count). */
function executions(ctx: StageContext, unit: PlanUnit): number {
  return ctx.journal.view.opsOf('mutant.apply').filter((i) => 'of' in i.expect && i.expect.of.type === 'smoke' && i.expect.of.unit === unit.id).length;
}

/** One target's verdict from its lane's record (null: the lane gave no record). */
function targetVerdict(record: WitnessRecord | null, ref: TestRef): 'killed' | 'survived' | 'inconclusive' {
  if (record === null || record.malformed) return 'inconclusive';
  const r = record.records.find((x) => x.testId === ref.testId);
  if (r === undefined || r.selected === 0) return 'inconclusive';
  if (r.outcome === 'fail') return 'killed';
  return r.outcome === 'pass' ? 'survived' : 'inconclusive';
}

/** A smoke lane's reservation under the attempt's holder, probed and running (null: it reserves nothing), or why not. */
async function reserve(
  ctx: StageContext, parent: StageParent, lane: ArcLaneDef, rt: LaneRuntime,
): Promise<Readonly<{ kind: 'held'; reservation: Reservation<'running', StageHolder> | null }> | Exclude<SmokeEnd, Readonly<{ kind: 'not-run' | 'ran' }>>> {
  const request = laneRequest(ctx, lane);
  if (request === null) return { kind: 'held', reservation: null };
  const holder = stageHolder(parent);
  const grant = await rt.acquire(request, holder, rt.rank, rt.signal);
  if (grant.kind === 'cancelled') return { kind: 'interrupted', reason: laneAbortReason(rt.signal) };
  const reserved = heldReservation(ctx, holder, 'reserved');
  const occupancy = await probe(ctx, reserved, parent);
  if (occupancy.kind === 'parked') {
    const cleaned = await cleanup(ctx, reserved, parent);
    return cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser };
  }
  return { kind: 'held', reservation: run(ctx, reserved, parent) };
}

/** Records the attempt's `smoke-ran` and returns its end. */
function ran(ctx: StageContext, unit: PlanUnit, parent: StageParent, key: Sha256Hex, verdict: SmokeVerdict, targets: readonly RequiredWitness[]): SmokeEnd {
  ctx.journal.fact({ kind: 'smoke-ran', unit: unit.id, attempt: parent.attempt, key, verdict });
  crashPoint('smoke.after-ran-before-outcome', unit.id);
  return { kind: 'ran', verdict, targets };
}

/**
 * The mutation smoke of lanes attempt `parent` at `salvaged` (D2), after a green witness presence check over `required`.
 * Nothing applies outside a corpus arc.
 */
export async function mutationSmoke(ctx: StageContext, unit: PlanUnit, parent: StageParent, salvaged: Sha, required: readonly RequiredWitness[], rt: LaneRuntime): Promise<SmokeEnd> {
  const plan = smokePlan(ctx, unit, salvaged, required);
  if ('notRun' in plan) return { kind: 'not-run', reason: plan.notRun };
  const view = ctx.journal.view;
  if (binaryOrRename(ctx, plan, salvaged)) {
    // Nothing is made or run: the verdict is every target inconclusive, keyed by the production diff itself.
    const key = sha256Hex(canonicalJson({ inconclusive: 'binary-or-rename', base: plan.base, salvaged, refs: plan.refs })) as Sha256Hex;
    return ran(ctx, unit, parent, key, allInconclusive(plan.refs), plan.targets);
  }
  const patch = reversePatch(ctx, plan, salvaged);
  const patchSha256 = keepInput(ctx.runDir, patch, MUTANT_PATCH_INPUT);
  crashPoint('smoke.after-patch-kept', unit.id);
  const key = smokeKey(ctx, plan, patchSha256);
  const earlier = view.holistic().smokeRuns.filter((r) => r.unit === unit.id && r.key === key).at(-1);
  if (earlier !== undefined) return ran(ctx, unit, parent, key, earlier.verdict, plan.targets);
  if (executions(ctx, unit) >= view.unit(unit.id).bounds.smokeRuns) return { kind: 'not-run', reason: 'allowance' };
  const made = patchedTree(ctx.repo, salvaged, mutantPatchPath(ctx.runDir, patchSha256));
  if (made.kind !== 'applied') return ran(ctx, unit, parent, key, allInconclusive(plan.refs), plan.targets);
  await removeMutantLeftovers(ctx, unit.id, parent);
  const worktree = smokeWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, parent.attempt);
  const of = { type: 'smoke', unit: unit.id, attempt: parent.attempt } as const;
  const applied = await applyMutant(ctx, parent, { worktree, at: salvaged, of, patchSha256 });
  crashPoint('smoke.after-apply', unit.id);
  if (applied.kind === 'inapplicable') return ran(ctx, unit, parent, key, allInconclusive(plan.refs), plan.targets);
  const records = new Map<LaneId, WitnessRecord | null>();
  let last = null as Parameters<typeof removeMutantWorktree>[3];
  for (const lane of plan.lanes) {
    const held = await reserve(ctx, parent, lane, rt);
    if (held.kind !== 'held') {
      await removeMutantWorktree(ctx, parent, worktree, last);
      return held;
    }
    const r = await runMutantLane(ctx, parent, {
      of, lane, worktree, tree: applied.tree, dirOf: (invDir) => smokeLaneDir(ctx.runDir, unit.id, parent.attempt, lane.id, basename(invDir)),
      for: { type: 'smoke', unit: unit.id, attempt: parent.attempt, of: salvaged }, held: held.reservation?.resources ?? [],
    });
    last = r.evidence;
    const released = held.reservation === null ? null : await cleanup(ctx, held.reservation, parent);
    if (released?.kind === 'cleanup-failed') {
      await removeMutantWorktree(ctx, parent, worktree, last);
      return { kind: 'cleanup-failed', failed: released.failed };
    }
    if (r.kind === 'interrupted') {
      await removeMutantWorktree(ctx, parent, worktree, last);
      return { kind: 'interrupted', reason: r.reason };
    }
    records.set(lane.id, r.kind === 'ran' ? r.record : null);
  }
  crashPoint('smoke.after-witnessed', unit.id);
  await removeMutantWorktree(ctx, parent, worktree, last);
  const verdict: { killed: TestRef[]; survived: TestRef[]; inconclusive: TestRef[] } = { killed: [], survived: [], inconclusive: [] };
  for (const ref of plan.refs) verdict[targetVerdict(records.get(ref.lane) ?? null, ref)].push(ref);
  return ran(ctx, unit, parent, key, verdict, plan.targets);
}

/** The obligations whose witness tests survived, ascending, each once (a witness item has none). */
export function survivingObligations(targets: readonly RequiredWitness[], survived: readonly TestRef[]): readonly ObligationId[] {
  const keys = new Set(survived.map(testRefKey));
  const ids = targets.flatMap((t) => (t.source.type === 'obligation' && keys.has(testRefKey(t)) ? [t.source.id] : []));
  return [...new Set(ids)].sort(compareIds);
}

/**
 * The gate's `checks.smoke` for the lanes attempt `series` that ran at `head` (null where the checks do not apply): the
 * attempt's `smoke-ran` verdict, or why the smoke did not run there (recomputed: nothing between that attempt and its gate
 * changes the bound or the allowance).
 */
export function gateSmokeChecks(ctx: StageContext, unit: PlanUnit, series: StageParent, head: Sha, required: readonly RequiredWitness[]): GateChecks['smoke'] {
  if (!checksApply(ctx)) return null;
  const done = ctx.journal.view.holistic().smokeRuns.find((r) => r.unit === unit.id && r.attempt === series.attempt);
  if (done !== undefined) return { ...done.verdict, notRun: null };
  const plan = smokePlan(ctx, unit, head, required);
  return { killed: [], survived: [], inconclusive: [], notRun: 'notRun' in plan ? plan.notRun : 'allowance' };
}
