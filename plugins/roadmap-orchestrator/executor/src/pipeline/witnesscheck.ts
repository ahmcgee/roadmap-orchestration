// Witness presence before the gate (M4a rev 3, D1, R33, R51, R56; corpus arcs only, LR-h).
//
// After a green, certified spec series the lanes stage asks which witness test ids the unit must make pass at its salvage
// SHA (`requiredWitnesses`, src/holistic/required.ts). Nothing required: the check does not apply. Otherwise each
// required arc lane runs once at the salvage SHA as a journey series the unit's lanes attempt owns
// (`runJourneySeries`), in its own detached checkout (`witnessWorktree`, never the verification checkout the gate reads),
// reusing only observations of certified series (R51: a crash after `witnessed` and before the census leaves no
// certificate, so the lane reruns). Outcomes, distinct: a lane without a verdict is `blocked` or `interrupted` (or its
// reservation `occupied` / `cleanup-failed`); a checkout the lanes left dirty or moved is `not-certified`; otherwise
// `missingWitnesses` (the one comparator the stage and `roadmap witness-check` share) decides: nothing missing or failing
// is `green`, anything else `witnesses-missing{missing, failed}`, a charged fix round naming each id (no gate call).
// Plan defects (2026-10-16): before that round is charged, code asks why each missing id of an obligation's witness is
// missing (`missingWitnessDefects`): a declared witness file its lane never runs (src/holistic/witnessfiles.ts
// `laneMisses`), or one absent at the salvage SHA and outside the unit's effective scope, so no build of the unit could
// create it. Any such defect makes the outcome `plan-defect{defects}`: an uncharged park naming them, never a fix round.
//
// Implementer side (R56): before the build call the executor publishes, write-once, one lane file per fast required
// witness lane, `<evidenceDir>/witness/<lane>.json` (`WitnessLaneFile`), and gives the build the exact command that runs
// it (`roadmap witness-check --lane-file <file>`). The same attempt writes the same bytes (the spec rev and the required
// set fix them); a file that differs fails loud. Estate witness lanes stay the executor's.
//
// The gate's `checks.witnesses` (`gateWitnessChecks`) is the requirement at the head it judges: a gate only runs after a
// green check, so nothing is missing or failing there.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crashPoint } from '../core/crash.ts';
import { type TestRef, testRefKey } from '../core/events.ts';
import { durableMkdir, exclusivePublish } from '../core/fsx.ts';
import type { LaneId, ResourceInstance, Sha } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type NeedsUserContent, effectiveScope } from '../core/records.ts';
import { type AbsPath, type RepoPath, absPath, matchesPattern } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { isAncestor } from '../git/ff.ts';
import { type RequiredWitness, missingWitnesses, requiredWitnesses } from '../holistic/required.ts';
import { type ArcLaneDef, type PlanDefect, type WitnessLaneFile, planDefectText } from '../holistic/types.ts';
import { laneMisses } from '../holistic/witnessfiles.ts';
import { gitRun } from '../git/git.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { GateChecks, WitnessCheckCommand } from '../prompts/inputs.ts';
import { arcScopeOf } from '../routing/layers.ts';
import { type StageContext, type StageParent, dispatchOf, witnessWorktree } from './dispatch.ts';
import { type LaneRuntime, arcJourneyLane, intact, runJourneySeries } from './lanes.ts';
import type { LaneCancel } from './redlane.ts';
import { holisticInForce, loadUnitSpec } from './stages.ts';

/** The `roadmap` CLI an implementer runs a witness check with. */
export const ROADMAP_BIN: AbsPath = absPath(fileURLToPath(new URL('../../bin/roadmap', import.meta.url)));
/** Where a build attempt's lane files go, under its evidence dir. */
export const WITNESS_LANE_DIR = 'witness';

/** Whether the executable checks apply to the arc in force: a corpus arc (LR-h) with obligations in force. */
export function checksApply(ctx: StageContext): boolean {
  return arcScopeOf(ctx.plan()) === 'corpus' && holisticInForce(ctx).obligations !== null;
}

/** The witness test ids unit `unit` must make pass at `at` (`requiredWitnesses`, R33); empty where the checks do not apply. */
export function requiredAt(ctx: StageContext, unit: PlanUnit, at: Sha): readonly RequiredWitness[] {
  if (!checksApply(ctx)) return [];
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) throw new Error(`unit ${unit.id}: a corpus arc's checks without obligations in force`);
  return requiredWitnesses(ctx.journal.view, obligations, unit.id, loadUnitSpec(ctx, unit).spec, { sha: at, isAncestor: (c) => isAncestor(ctx.repo, c, at) });
}

/**
 * The arc lanes in force that `required` names, ascending by id; a required lane not in force is a bug: the classifier
 * refuses one at every revision, and the stages park a unit whose spec in force still holds one first (`witnessLanePark`).
 */
export function requiredLanes(ctx: StageContext, required: readonly RequiredWitness[]): readonly ArcLaneDef[] {
  const { obligations } = holisticInForce(ctx);
  const ids = [...new Set(required.map((r) => r.lane))].sort();
  return ids.map((id) => {
    const lane = obligations?.lanes.find((l) => l.id === id);
    if (lane === undefined) throw new Error(`a required witness names lane ${id}, which is not an arc lane in force`);
    return lane;
  });
}

/** The required test ids of one lane, ascending, each once. */
const testIdsOf = (required: readonly RequiredWitness[], lane: LaneId): readonly string[] =>
  [...new Set(required.filter((r) => r.lane === lane).map((r) => r.testId))].sort();

// ---------------------------------------------------------------------------------------------------
// The implementer's lane files (WITNESS_FILES)

/**
 * Publishes, write-once, the lane file of each build-cadence arc lane `required` names under `<evidenceDir>/witness/<lane>.json`, and
 * returns the command per lane the build is given. A file already there must hold the same bytes (a retry of the same
 * attempt); anything else fails loud.
 */
export function publishWitnessLaneFiles(ctx: StageContext, unit: PlanUnit, evidenceDir: AbsPath, required: readonly RequiredWitness[]): readonly WitnessCheckCommand[] {
  const fast = requiredLanes(ctx, required).filter((l) => l.cadence === 'build');
  if (fast.length === 0) return [];
  const dir = absPath(join(evidenceDir, WITNESS_LANE_DIR));
  durableMkdir(dir);
  const out = fast.map((lane): WitnessCheckCommand => {
    const file: WitnessLaneFile = {
      v: SCHEMA_VERSION, lane: lane.id, argv: lane.argv, cwd: lane.cwd, env: { set: lane.env.set, pass: [...lane.env.pass] }, reporter: lane.reporter,
      required: testIdsOf(required, lane.id),
    };
    const path = absPath(join(dir, `${lane.id}.json`));
    const bytes = `${canonicalJson(file)}\n`;
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') !== bytes) throw new Error(`unit ${unit.id}: the lane file ${path} already holds other bytes`);
    } else {
      exclusivePublish(path, bytes);
    }
    return { lane: lane.id, command: `${ROADMAP_BIN} witness-check --lane-file ${path}` };
  });
  crashPoint('witnesscheck.after-lane-files', unit.id);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The check itself (WITNESS_CHECK)

export type WitnessPresence =
  /** The check does not apply: not a corpus arc, or nothing is required. */
  | Readonly<{ kind: 'skip' }>
  | Readonly<{ kind: 'green'; required: readonly RequiredWitness[] }>
  | Readonly<{ kind: 'witnesses-missing'; required: readonly RequiredWitness[]; missing: readonly TestRef[]; failed: readonly TestRef[] }>
  | Readonly<{ kind: 'plan-defect'; defects: readonly PlanDefect[]; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'not-certified' }>
  | Readonly<{ kind: 'blocked' }>
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>;

/**
 * Runs the unit's required witness lanes at `salvaged` (D1) under lanes attempt `parent` and compares their records with
 * what is required.
 */
export async function witnessPresence(ctx: StageContext, unit: PlanUnit, parent: StageParent, salvaged: Sha, rt: LaneRuntime): Promise<WitnessPresence> {
  const required = requiredAt(ctx, unit, salvaged);
  if (required.length === 0) return { kind: 'skip' };
  const lanes = requiredLanes(ctx, required).map(arcJourneyLane);
  const checkout = { path: witnessWorktree(ctx.plan().worktreeRoot, ctx.plan().arc, unit.id, parent.attempt), checkout: { type: 'detached', at: salvaged } } as const;
  const series = await runJourneySeries(ctx, { type: 'unit', parent, rt }, lanes, checkout, { reuse: true, stop: () => false });
  crashPoint('witnesscheck.after-witnessed', unit.id);
  switch (series.end.kind) {
    case 'blocked':
      return { kind: 'blocked' };
    case 'interrupted':
      return { kind: 'interrupted', reason: series.end.reason };
    case 'occupied':
      return { kind: 'occupied', needsUser: series.end.needsUser };
    case 'cleanup-failed':
      return { kind: 'cleanup-failed', failed: series.end.failed };
    case 'ran':
      break;
  }
  if (!intact(series)) return { kind: 'not-certified' };
  const records = series.runs.flatMap((r) => (r.record === null ? [] : [r.record]));
  const { missing, failed } = missingWitnesses(records, required);
  if (missing.length === 0 && failed.length === 0) return { kind: 'green', required };
  const defects = missingWitnessDefects(ctx, unit, salvaged, missing, required);
  if (defects.length > 0) return { kind: 'plan-defect', defects, needsUser: planDefectNeedsUser(unit, salvaged, defects) };
  return { kind: 'witnesses-missing', required, missing, failed };
}

/**
 * The plan defects behind `missing` (plan defects, 2026-10-16): per obligation whose witness requires a missing id and
 * declares its files, each file its lane never runs (`witness-not-in-lane`), and each absent at `salvaged` and outside the
 * unit's effective scope (`witness-file-unreachable`, the unit named). Empty when every missing id is the build's to add.
 */
export function missingWitnessDefects(ctx: StageContext, unit: PlanUnit, salvaged: Sha, missing: readonly TestRef[], required: readonly RequiredWitness[]): readonly PlanDefect[] {
  const { obligations } = holisticInForce(ctx);
  if (obligations === null) return [];
  const keys = new Set(missing.map(testRefKey));
  const ids = new Set(required.flatMap((r) => (keys.has(testRefKey(r)) && r.source.type === 'obligation' ? [r.source.id] : [])));
  const scope = effectiveScope(dispatchOf(ctx.journal.view, unit.id));
  const present = (file: RepoPath): boolean => gitRun(ctx.repo, ['cat-file', '-e', `${salvaged}:${file}`], { okCodes: [0, 128] }).code === 0;
  return obligations.obligations.filter((o) => ids.has(o.id)).flatMap((o) => {
    const w = o.witness;
    if (w === null || w.files === undefined) return [];
    const lane = obligations.lanes.find((l) => l.id === w.lane);
    return w.files.flatMap((file): PlanDefect[] => {
      const misses = lane === undefined ? null : laneMisses(lane, file);
      if (misses !== null) return [{ type: 'witness-not-in-lane', obligation: o.id, lane: w.lane, file, missing: misses }];
      if (!present(file) && !scope.some((p) => matchesPattern(file, p))) return [{ type: 'witness-file-unreachable', obligation: o.id, file, units: [unit.id] }];
      return [];
    });
  });
}

/** The blocking item of a `plan-defect` park: the defects in sentences, and what fixes them. */
function planDefectNeedsUser(unit: PlanUnit, salvaged: Sha, defects: readonly PlanDefect[]): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'unit', unit: unit.id },
    reason: 'plan-defect',
    summary: `Unit ${unit.id}: its required witnesses are missing at ${salvaged} for a reason no build round can fix: ${defects.map(planDefectText).join(' ')} The unit is parked, uncharged.`,
    recommendation: `Fix the plan with \`roadmap apply\` (the lane's argv or testPaths, the witness's files or lane, or the obligation's deliveredBy), then \`roadmap resume ${unit.id}\` re-runs its lanes; or re-enter the unit with a scope that holds the witness file.`,
    options: [],
    evidence: [],
  };
}

/** The gate's `checks.witnesses` at the head it judges: null where the checks do not apply (a gate runs only after a green check). */
export function gateWitnessChecks(ctx: StageContext, unit: PlanUnit, head: Sha): GateChecks['witnesses'] {
  if (!checksApply(ctx)) return null;
  return { required: requiredAt(ctx, unit, head), missing: [], failed: [] };
}
