// Vacuity repairs and the repair side of findings (DESIGN-1.0.md §2.5 "Mutants are executed, never judged by reading",
// §2.8 "Findings and repair"; plan "Mutant reproduction"; M3 step B3).
//
// A vacuity finding carries a mutant: a patch the lens claims the obligation's witness does not catch. A unit whose spec
// repairs such a finding (a vacuity repair) starts with the `reproduce` stage, an admission stage whose first
// executor-verified obligation is reproducing the mutant: `mutant.apply` in a detached worktree at the integration tip
// (src/git/mutant.ts), then the mutant's lane there under `purpose: mutant` (a `mutant` spawn, a `witnessed{purpose:
// mutant, for: mutant{finding, of}}` fact naming the patched tree's real id: G13, never certifying). The old witness
// permitting the mutant (its tests held) is `reproduced` → plan-check. Tests that kill it: `not-reproduced`, the unit
// parks and code dismisses the finding (`syncRepairs` reads it from the log). A patch that no longer applies, or a lane
// no longer in force, or a run that witnessed nothing definite: `inapplicable`, the unit parks and the next audit
// re-evaluates. Each mutant lane runs under the attempt's stage holder with the lane's own reservation (the first one as
// the stage's entry reservation, A1/F6), and every mutant worktree is removed before the stage records, citing the run's
// evidence (`<runDir>/evidence/mutants/<finding>/<lane>-<inv>/`, src/git/snapshot.ts `mutantLaneDir`).
//
// Acceptance (`mutantAcceptance`, from the candidate stage after the held-claims brake is green): the candidate must
// kill every mutant its unit repairs: the same run on the candidate commit, and a survivor (the witness still held, or
// nothing definite) is `red` (charged; `mutantFix` names it in the fix round). A mutant that no longer applies to the
// candidate (the repair rewrote what it mutated) is not a survivor: the next audit's vacuity lens re-evaluates.
//
// The repair side of the findings store: `specFacts` (what admission and `nextStage` read from a unit's spec: whether it
// reproduces first, which obligations it repairs), and `syncRepairs`, which writes the findings' moves the log calls for
// (src/holistic/findings.ts `ownershipMoves`: owned, fixed-on-branch, resolved, open again) and code's dismissal of a
// finding whose mutant a `reproduce` killed. It is re-runnable, so the driver calls it around every stage and a
// restart writes only what is missing.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { MutantOf, OutcomeStage, WitnessFor } from '../core/events.ts';
import { mutantSubjectDefault } from '../core/upgrade.ts';
import { type FindingId, type OpId, type ResourceInstance, type ResourceUnit, type Sha, type Sha256Hex, type UnitId, invocationId, opKey } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { type NeedsUserContent, STDERR_FILE, STDOUT_FILE, specRepairs } from '../core/records.ts';
import type { FindingState, UnitState } from '../core/state.ts';
import { type AbsPath, absPath, isoTimeOf, repoPattern } from '../core/values.ts';
import { capturedEvidence } from '../git/evidence.ts';
import { mutantPatchPath, patchedTree } from '../git/mutant.ts';
import { mutantLaneDir } from '../git/snapshot.ts';
import { type RepairProgress, type RepairUnit, isActive, repairedObligations, ruleFinding, syncFindings } from '../holistic/findings.ts';
import { verdictOf } from '../holistic/observe.ts';
import { type ArcLaneDef, type MutantRef, type ObservationVerdict, type WitnessRecord, type WitnessRef, laneRevOf, witnessRecord } from '../holistic/types.ts';
import { WITNESS_LINES, WITNESS_RECORD_FILE, collectWitness, witnessEnv, witnessRecordOf, writeWitnessRecord } from '../holistic/witness.ts';
import type { PlanUnit } from '../input/plan.ts';
import type { FixRound } from '../prompts/inputs.ts';
import { type Reservation, type StageHolder, cleanup, heldReservation, run } from '../resources/reserve.ts';
import { probe } from '../resources/probe.ts';
import type { SpecFacts, SpecFactsOf } from '../schedule/ready.ts';
import { type Cancelled, type StageContext, type StageParent, enter, evidenceRoot, isCancelled, pinDispatch, runOp } from './dispatch.ts';
import { invocationDir, invoke } from './invoke.ts';
import { LANE_DEADLINE_MS, LANE_GRACE_MS, LANE_STALL_MS, laneEnv, laneEnvId, laneRequest } from './lanes.ts';
import { type LaneCancel, laneAbortReason } from './redlane.ts';
import { type StageDone, at, failedFacts, holdEntry, holisticInForce, integrationTip, loadUnitSpec, record, stageHolder, start } from './stages.ts';
import { decidedBy } from './transitions.ts';
import { evidenceSnapshotOp, mutantApplyOp, worktreeRemoveOp } from '../recover/ops.ts';

type SpecReader = Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath; planDir: AbsPath }>;

// ---------------------------------------------------------------------------------------------------
// What a unit's spec says about its repairs

/** A vacuity finding a spec repairs that is still active and carries a mutant. */
type VacuityFinding = FindingState & Readonly<{ mutant: MutantRef }>;

/** The active vacuity findings with a mutant that `repairs` names, in id order. */
function vacuityTargets(findings: readonly FindingState[], repairs: readonly string[]): readonly VacuityFinding[] {
  return findings.filter((f): f is VacuityFinding => f.mutant !== null && isActive(f) && repairs.includes(f.id));
}

/**
 * What admission and `nextStage` read from each unit's spec in force (src/schedule/ready.ts `SpecFacts`). With no
 * active finding in the arc nothing in a spec matters to either, and no spec is read.
 */
export function specFacts(ctx: SpecReader): SpecFactsOf {
  return (unit: PlanUnit): SpecFacts => {
    const findings = ctx.journal.view.holistic().findings;
    if (!findings.some(isActive)) return { reproduces: false, repairs: new Set() };
    const repairs = specRepairs(loadUnitSpec(ctx, unit).spec);
    return { reproduces: vacuityTargets(findings, repairs).length > 0, repairs: repairedObligations(findings, repairs) };
  };
}

// ---------------------------------------------------------------------------------------------------
// One mutant run

/** A mutant ready to run: its finding, the arc lane in force that should kill it, and the witness its verdict reads. */
type MutantTarget = Readonly<{ finding: VacuityFinding; lane: ArcLaneDef; witness: WitnessRef | null }>;

/**
 * The lane in force a finding's mutant runs on, and the witness its verdict reads: the finding's obligation's witness
 * when it is on that lane, else every test the run reports (`witness` null). A lane no longer in force: why not.
 */
function mutantTarget(ctx: StageContext, finding: VacuityFinding): MutantTarget | Readonly<{ inapplicable: string }> {
  const { obligations } = holisticInForce(ctx);
  const lane = obligations?.lanes.find((l) => l.id === finding.mutant.lane);
  if (obligations === null || lane === undefined) return { inapplicable: `the mutant of ${finding.id} names lane ${finding.mutant.lane}, which is not an arc lane in force` };
  const o = finding.obligation === null ? undefined : obligations.obligations.find((d) => d.id === finding.obligation);
  const witness = o?.witness !== undefined && o.witness !== null && o.witness.lane === lane.id ? o.witness : null;
  return { finding, lane, witness };
}

/** How a mutant run came out: its verdict on the patched tree, or why it has none. */
export type MutantRun =
  | Readonly<{ kind: 'inapplicable'; detail: string }>
  | Readonly<{ kind: 'ran'; verdict: ObservationVerdict; dir: AbsPath }>
  | Readonly<{ kind: 'blocked'; detail: string }>
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>;

/** The worktree a stage attempt applies a finding's mutant in. */
const mutantWorktree = (ctx: StageContext, parent: StageParent, finding: FindingId): AbsPath =>
  absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${parent.unit}.mutant-${parent.attempt}-${finding}`));

/** The verdict a mutant run's record gives: its target's witness, or every test it reports. */
function mutantVerdict(record: WitnessRecord, witness: WitnessRef | null, lane: ArcLaneDef): ObservationVerdict {
  if (witness !== null) return verdictOf(record, witness);
  const testIds = record.records.map((r) => r.testId);
  return testIds.length === 0 ? 'unwitnessed' : verdictOf(record, { lane: lane.id, testIds });
}

/** Removes a mutant worktree, citing `evidence` (the run's output, or a snapshot of nothing when no lane ran). */
export async function removeMutantWorktree(ctx: StageContext, parent: StageParent, path: AbsPath, evidence: OpId | null): Promise<void> {
  const cited = evidence ?? (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
    source: path, globs: [], dest: absPath(join(evidenceRoot(ctx.runDir, parent), `_mutant-${basename(path)}`)),
  })).op;
  await runOp(ctx.journal, worktreeRemoveOp(ctx.repo), `worktree:${parent.unit}:mutant`, parent, { path, evidence: capturedEvidence(ctx.journal.view, cited) });
}

/**
 * Removes every mutant worktree of `unit` an earlier attempt applied and a crash left (its `mutant.apply` done, no done
 * `worktree.remove` of its path), each citing a snapshot of nothing: a finding's or a smoke's.
 */
export async function removeMutantLeftovers(ctx: StageContext, unit: UnitId, parent: StageParent): Promise<void> {
  const view = ctx.journal.view;
  const removed = new Set(view.opsOf('worktree.remove').filter((i) => view.doneOf(i.op) !== null).map((i) => i.expect.path));
  const left = view.opsOf('mutant.apply').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit && view.doneOf(i.op) !== null && !removed.has(i.expect.worktree));
  for (const i of left) if (existsSync(i.expect.worktree)) await removeMutantWorktree(ctx, parent, i.expect.worktree, null);
}

/** A mutant applied in its worktree: the patched tree, or why the patch does not apply (the worktree is then removed). */
export type AppliedMutant = Readonly<{ kind: 'applied'; tree: Sha }> | Readonly<{ kind: 'inapplicable'; detail: string }>;

/**
 * `mutant.apply` of the kept patch `patchSha256` at `at`, `of` a finding or a smoke, in `worktree`. A patch that does not
 * apply leaves a clean checkout, removed here citing a snapshot of nothing. The patch must not be corrupt (callers check
 * `patchedTree` first; `prepare` refuses one).
 */
export async function applyMutant(
  ctx: StageContext, parent: StageParent, request: Readonly<{ worktree: AbsPath; at: Sha; of: MutantOf; patchSha256: Sha256Hex }>,
): Promise<AppliedMutant> {
  const intent = await runOp(ctx.journal, mutantApplyOp(ctx.repo, ctx.runDir), `mutant:${parent.unit}`, parent, request);
  crashPoint('mutant.after-done', parent.unit);
  const applied = ctx.journal.view.doneOf(intent.op);
  if (applied === null || applied.kind !== 'mutant.apply') throw new Error(`${intent.op}: mutant.apply is not done`);
  if (applied.outcome.kind === 'inapplicable') {
    await removeMutantWorktree(ctx, parent, request.worktree, null);
    return { kind: 'inapplicable', detail: applied.outcome.detail };
  }
  return { kind: 'applied', tree: applied.outcome.tree };
}

/** One lane's run on a patched tree: its witness record and evidence, or why it has no record. */
export type MutantLaneRun =
  | Readonly<{ kind: 'ran'; record: WitnessRecord; dir: AbsPath; evidence: OpId }>
  | Readonly<{ kind: 'blocked'; detail: string; dir: AbsPath; evidence: OpId }>
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel; dir: AbsPath; evidence: OpId }>;

/**
 * Runs arc lane `lane` in the mutant worktree (the patched `tree`, made `of` a finding or a smoke) under the attempt's
 * holder (`held`: the pool instances its reservation holds), keeping the run's evidence and witness record under
 * `dirOf(invDir)` and naming the record by a `witnessed{purpose: mutant, for}` fact (G13: never certifying).
 */
export async function runMutantLane(
  ctx: StageContext, parent: StageParent,
  run: Readonly<{ of: MutantOf; lane: ArcLaneDef; worktree: AbsPath; tree: Sha; dirOf: (invDir: string) => AbsPath; for: WitnessFor; held: readonly ResourceUnit[] }>,
): Promise<MutantLaneRun> {
  const { lane, worktree, tree } = run;
  const outcome = await invoke(ctx.journal, ctx.containment, {
    runDir: ctx.runDir,
    origin: { type: 'new', key: opKey(`lane:${parent.unit}`), parent, deadlineAt: isoTimeOf(new Date(Date.now() + LANE_DEADLINE_MS)) },
    subject: { purpose: 'mutant', of: run.of, lane: lane.id, laneRev: laneRevOf(lane), tree },
    launch: (invDir) => {
      mkdirSync(run.dirOf(invDir), { recursive: true });
      return {
        argv: lane.argv, cwd: absPath(join(worktree, lane.cwd)), env: mutantEnv(ctx, parent.unit, lane, run.held, absPath(join(run.dirOf(invDir), WITNESS_LINES))), stdinPath: null,
        stallMs: LANE_STALL_MS, graceMs: LANE_GRACE_MS, terminal: { type: 'command', purpose: 'lane', expectedExit: lane.expectedExit },
      };
    },
  });
  const invDir = invocationDir(ctx.runDir, outcome.inv);
  const dir = run.dirOf(invDir);
  mkdirSync(dir, { recursive: true });
  const evidence = (await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${parent.unit}`, parent, {
    source: invDir, globs: [repoPattern(STDOUT_FILE), repoPattern(STDERR_FILE)], dest: absPath(join(dir, 'output')),
  })).op;
  if (outcome.kind === 'lost') return { kind: 'blocked', detail: `${outcome.inv} was lost with its runner`, dir, evidence };
  if (outcome.result.type !== 'command') throw new Error(`${outcome.inv}: a mutant lane produced a ${outcome.result.type} result`);
  if (outcome.result.verdict === 'cancelled') return { kind: 'interrupted', reason: outcome.result.reason, dir, evidence };
  if (outcome.result.verdict === 'process-fault') return { kind: 'blocked', detail: `${outcome.inv} ended by a process fault`, dir, evidence };
  const tests = collectWitness(lane.reporter, { witnessFile: absPath(join(dir, WITNESS_LINES)), stdoutFile: absPath(join(invDir, STDOUT_FILE)) });
  const record = witnessRecordOf({ lane, envId: laneEnvId(ctx, lane), treeSha: tree, inv: outcome.inv, purpose: 'mutant' }, tests);
  const recordsSha256 = writeWitnessRecord(dir, record);
  ctx.journal.fact({
    kind: 'witnessed', lane: record.lane, laneRev: record.laneRev, envId: record.envId, treeSha: tree, inv: outcome.inv, recordsSha256, purpose: 'mutant', for: run.for,
  });
  return { kind: 'ran', record, dir, evidence };
}

/**
 * Applies the target's mutant at `commit` and runs its lane on the patched tree under the attempt's holder (`held`),
 * keeping the run's evidence and witness record in its own dir; the worktree is removed before it returns. A corrupt
 * patch (H6) is inapplicable here, with git's reason, and nothing is applied.
 */
async function runMutant(ctx: StageContext, parent: StageParent, target: MutantTarget, commit: Sha, held: readonly ResourceUnit[]): Promise<MutantRun> {
  const { finding, lane } = target;
  const made = patchedTree(ctx.repo, commit, mutantPatchPath(ctx.runDir, finding.mutant.patchSha256));
  if (made.kind === 'corrupt') return { kind: 'inapplicable', detail: made.detail };
  const worktree = mutantWorktree(ctx, parent, finding.id);
  const of: MutantOf = { type: 'finding', finding: finding.id };
  const applied = await applyMutant(ctx, parent, { worktree, at: commit, of, patchSha256: finding.mutant.patchSha256 });
  if (applied.kind === 'inapplicable') return applied;
  const ran = await runMutantLane(ctx, parent, {
    of, lane, worktree, tree: applied.tree, dirOf: (invDir) => mutantLaneDir(ctx.runDir, finding.id, lane.id, basename(invDir)),
    for: { type: 'mutant', finding: finding.id, of: commit }, held,
  });
  await removeMutantWorktree(ctx, parent, worktree, ran.evidence);
  switch (ran.kind) {
    case 'ran': return { kind: 'ran', verdict: mutantVerdict(ran.record, target.witness, lane), dir: ran.dir };
    case 'blocked': return { kind: 'blocked', detail: ran.detail };
    case 'interrupted': return { kind: 'interrupted', reason: ran.reason };
  }
}

/** The reporter's file of a mutant run, in its execution's dir (as a journey lane's). */

/** The unit lane environment plus the reporter's witness file; a lane declaring what the executor sets is a bug the reader refuses. */
function mutantEnv(ctx: StageContext, unit: UnitId, lane: ArcLaneDef, held: readonly ResourceUnit[], witnessFile: AbsPath): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...laneEnv(ctx, unit, lane, held) };
  for (const [name, value] of Object.entries(witnessEnv(lane.reporter, witnessFile))) {
    if (Object.hasOwn(env, name)) throw new Error(`lane ${lane.id} declares ${name}, which the executor sets`);
    env[name] = value;
  }
  return env;
}

/** A lane's reservation for the attempt, probed and running (null: it reserves nothing), or why the mutant cannot run. */
type Reserved =
  | Readonly<{ kind: 'held'; reservation: Reservation<'running', StageHolder> | null }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Cancelled;

/** Releases a mutant lane's reservation after its run; the instances a failed cleanup names. */
async function release(ctx: StageContext, parent: StageParent, held: Reservation<'running', StageHolder> | null): Promise<readonly ResourceInstance[]> {
  if (held === null) return [];
  const cleaned = await cleanup(ctx, held, parent);
  return cleaned.kind === 'cleanup-failed' ? cleaned.failed : [];
}

// ---------------------------------------------------------------------------------------------------
// The reproduce stage

/** Why a vacuity repair parked at `reproduce`, for the architect. */
function reproduceNeedsUser(ctx: StageContext, unit: PlanUnit, finding: FindingId, how: 'not-reproduced' | 'inapplicable', detail: string): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'unit', unit: unit.id },
    reason: 'not-reproduced',
    summary: how === 'not-reproduced'
      ? `Unit ${unit.id}: the mutant of ${finding} does not survive at the integration tip (${detail}): the witness already kills it, so code dismissed ${finding} and the repair parked.`
      : `Unit ${unit.id}: the mutant of ${finding} could not be reproduced at the integration tip (${detail}); ${finding} stays open for the next audit to re-evaluate, and the repair parked.`,
    recommendation: `The checkpoint respecs or cuts ${unit.id}; or cut it with \`roadmap apply\`. \`roadmap resume ${unit.id}\` after a spec edit re-runs it from its first stage.`,
    options: [],
    evidence: [mutantPatchPath(ctx.runDir, ctx.journal.view.holistic().findings.find((f) => f.id === finding)!.mutant!.patchSha256)],
  };
}

/**
 * A vacuity repair's first stage: each mutant its spec repairs (in finding order) applied at the integration tip and
 * run on its lane. Every one surviving → `reproduced`. The first killed → `not-reproduced` (code dismisses its finding,
 * `syncRepairs`); the first that does not apply or witnesses nothing definite → `inapplicable`.
 */
export async function reproduce(ctx: StageContext, unit: PlanUnit): Promise<StageDone<'reproduce'> | Cancelled> {
  const { spec, sha256 } = loadUnitSpec(ctx, unit);
  const targets = vacuityTargets(ctx.journal.view.holistic().findings, specRepairs(spec));
  if (targets.length === 0) throw new Error(`unit ${unit.id}: reproduce, but it repairs no active vacuity finding with a mutant`);
  const parent = at(start(ctx, unit.id, 'reproduce'), 'reproduce');
  // The unit's first stage pins its dispatch record (scope envelope, risk floor, routing), as plan-check does for any
  // other unit; after a re-open the record exists, and plan-check re-pins it.
  if (ctx.journal.view.dispatchOf(unit.id) === null) pinDispatch(ctx, unit, { rev: spec.rev, sha256 });
  let first = true;
  for (const finding of targets) {
    const target = mutantTarget(ctx, finding);
    if ('inapplicable' in target) return record(ctx, parent, 'inapplicable', reproduceNeedsUser(ctx, unit, finding.id, 'inapplicable', target.inapplicable));
    const reserved = await reserveLane(ctx, parent, target.lane, first);
    if (reserved.kind === 'cancelled') return reserved;
    if (reserved.kind === 'interrupted') return record(ctx, parent, 'interrupted');
    if (reserved.kind === 'occupied') return record(ctx, parent, 'blocked', reserved.needsUser);
    if (reserved.kind === 'cleanup-failed') return record(ctx, parent, 'cleanup-failed', null, failedFacts(reserved.failed));
    if (first) await removeMutantLeftovers(ctx, unit.id, parent);
    first = false;
    const ran = await runMutant(ctx, parent, target, integrationTip(ctx), reserved.reservation?.resources ?? []);
    const failed = await release(ctx, parent, reserved.reservation);
    if (failed.length > 0) return record(ctx, parent, 'cleanup-failed', null, failedFacts(failed));
    switch (ran.kind) {
      case 'inapplicable':
        return record(ctx, parent, 'inapplicable', reproduceNeedsUser(ctx, unit, finding.id, 'inapplicable', ran.detail));
      case 'blocked':
        return record(ctx, parent, 'blocked');
      case 'interrupted':
        return record(ctx, parent, 'interrupted');
      case 'ran':
        if (ran.verdict === 'held') continue;
        // The unit driver's `syncRepairs` then dismisses the finding (derived from this outcome).
        if (ran.verdict === 'not-held') return record(ctx, parent, 'not-reproduced', reproduceNeedsUser(ctx, unit, finding.id, 'not-reproduced', `its witness is ${ran.verdict} on the patched tree`));
        return record(ctx, parent, 'inapplicable', reproduceNeedsUser(ctx, unit, finding.id, 'inapplicable', `its witness is ${ran.verdict} on the patched tree`));
    }
  }
  return record(ctx, parent, 'reproduced');
}

/**
 * A mutant lane's reservation under the attempt's stage holder: the stage's entry reservation for its first lane
 * (`entry`: a cancelled wait starts nothing), else a wait inside the stage (a cancelled one interrupts it); then the
 * occupancy probe and `run`.
 */
async function reserveLane(ctx: StageContext, parent: StageParent, lane: ArcLaneDef, entry: boolean): Promise<Reserved> {
  const entered = await enter(ctx, stageHolder(parent), laneRequest(ctx, lane));
  if (isCancelled(entered)) return entry ? entered : { kind: 'interrupted', reason: entered.reason };
  const held = await holdEntry(ctx, parent);
  return held;
}

// ---------------------------------------------------------------------------------------------------
// Acceptance in the candidate

/** What the kill check makes of a candidate that was otherwise green. */
export type MutantEnd =
  | Readonly<{ kind: 'green' | 'red' | 'blocked' }>
  | Readonly<{ kind: 'interrupted'; reason: LaneCancel }>
  | Readonly<{ kind: 'occupied'; needsUser: NeedsUserContent }>
  | Readonly<{ kind: 'cleanup-failed'; failed: readonly ResourceInstance[] }>;

/**
 * The candidate `commit` of `unit` must kill every mutant its spec repairs: each run on it, under the candidate attempt's
 * stage holder (the lane's reservation taken through the context's `acquire`, as a journey lane's). A survivor → `red`.
 */
export async function mutantAcceptance(ctx: StageContext, unit: PlanUnit, parent: StageParent, commit: Sha): Promise<MutantEnd> {
  const targets = vacuityTargets(ctx.journal.view.holistic().findings, specRepairs(loadUnitSpec(ctx, unit).spec));
  if (targets.length === 0) return { kind: 'green' };
  await removeMutantLeftovers(ctx, unit.id, parent);
  let survived = false;
  for (const finding of targets) {
    const target = mutantTarget(ctx, finding);
    if ('inapplicable' in target) continue;
    const request = laneRequest(ctx, target.lane);
    const holder = stageHolder(parent);
    let reservation: Reservation<'running', StageHolder> | null = null;
    if (request !== null) {
      const grant = await ctx.acquire(request, holder, () => ctx.rank(unit.id), ctx.signal);
      if (grant.kind === 'cancelled') return { kind: 'interrupted', reason: laneAbortReason(ctx.signal) };
      const reserved = heldReservation(ctx, holder, 'reserved');
      const occupancy = await probe(ctx, reserved, parent);
      if (occupancy.kind === 'parked') {
        const cleaned = await cleanup(ctx, reserved, parent);
        return cleaned.kind === 'cleanup-failed' ? { kind: 'cleanup-failed', failed: cleaned.failed } : { kind: 'occupied', needsUser: occupancy.needsUser };
      }
      reservation = run(ctx, reserved, parent);
    }
    const ran = await runMutant(ctx, parent, target, commit, reservation?.resources ?? []);
    const failed = await release(ctx, parent, reservation);
    if (failed.length > 0) return { kind: 'cleanup-failed', failed };
    if (ran.kind === 'blocked') return { kind: 'blocked' };
    if (ran.kind === 'interrupted') return ran;
    if (ran.kind === 'ran' && ran.verdict !== 'not-held') survived = true;
  }
  return { kind: survived ? 'red' : 'green' };
}

/**
 * The fix round after a candidate red on a surviving mutant, or null when no mutant survived in candidate attempt
 * `parent`: each survivor's finding, lane and patch, with its run's evidence.
 */
export function mutantFix(ctx: StageContext, parent: StageParent): FixRound | null {
  const view = ctx.journal.view;
  const key = canonicalJson(parent);
  const runs = new Set(view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'mutant' && canonicalJson(i.parent) === key).map((i) => invocationId(i.op, i.ordinal)));
  const findings = view.holistic().findings;
  const directives: string[] = [];
  const dirs: AbsPath[] = [];
  for (const w of view.holistic().witnessed) {
    if (w.for.type !== 'mutant' || !runs.has(w.inv)) continue;
    const id = w.for.finding;
    const finding = findings.find((f): f is VacuityFinding => f.id === id && f.mutant !== null);
    if (finding === undefined) throw new Error(`mutant run ${w.inv} names ${id}, which is no finding with a mutant`);
    const target = mutantTarget(ctx, finding);
    if ('inapplicable' in target) continue;
    const dir = mutantLaneDir(ctx.runDir, id, w.lane, basename(invocationDir(ctx.runDir, w.inv)));
    const record = witnessRecord(JSON.parse(readFileSync(join(dir, WITNESS_RECORD_FILE), 'utf8')), WITNESS_RECORD_FILE);
    const verdict = mutantVerdict(record, target.witness, target.lane);
    if (verdict === 'not-held') continue;
    const tests = target.witness === null ? 'every test it runs' : `tests ${target.witness.testIds.join(', ')}`;
    directives.push(`The repair must kill the mutant of ${id} ("${finding.claim}"): with this patch applied to the candidate, lane ${w.lane} (${tests}) still ${verdict === 'held' ? 'passes' : `reports ${verdict}`}. `
      + `Strengthen the witness so the mutant fails, without weakening it. The patch:\n${readFileSync(mutantPatchPath(ctx.runDir, finding.mutant.patchSha256), 'utf8')}`);
    dirs.push(dir);
  }
  return directives.length === 0 ? null : { failingEvidenceDirs: dirs, directives };
}

// ---------------------------------------------------------------------------------------------------
// The findings' moves the repairs call for

/** Where a repairing unit is (src/holistic/findings.ts `RepairProgress`). */
function progressOf(u: UnitState, publishedSeq: number | undefined): RepairProgress {
  if (publishedSeq !== undefined) return { kind: 'published', seq: publishedSeq };
  if (u.status === 'cut' || u.status === 'superseded') return { kind: 'gone' };
  if (u.decided === null) return { kind: 'working' };
  const d = decidedBy(u.decided);
  const approved: readonly OutcomeStage[] = ['candidate', 'ff', 'snapshot'];
  return d.kind === 'stage' && approved.includes(d.target.stage) ? { kind: 'approved' } : { kind: 'working' };
}

/** The units of the plan whose specs repair something, in plan order, with their progress. */
export function repairUnits(ctx: StageContext): readonly RepairUnit[] {
  const view = ctx.journal.view;
  const published = new Map(view.publications().map((p) => [p.unit, p.seq] as const));
  return ctx.plan().units.flatMap((unit) => {
    const repairs = specRepairs(loadUnitSpec(ctx, unit).spec);
    return repairs.length === 0 ? [] : [{ unit: unit.id, repairs, progress: progressOf(view.unit(unit.id), published.get(unit.id)) }];
  });
}

/**
 * The findings code dismisses: each still active whose mutant a unit's latest `reproduce` killed (the attempt decided
 * `not-reproduced`, its last mutant run naming the finding).
 */
function codeDismissals(ctx: StageContext): readonly FindingId[] {
  const view = ctx.journal.view;
  const out: FindingId[] = [];
  for (const unit of ctx.plan().units) {
    const d = view.unit(unit.id).decided;
    if (d === null || d.stage !== 'reproduce' || d.outcome !== 'not-reproduced') continue;
    const killed = view.opsOf('proc.spawn').flatMap((i) => {
      const s = i.expect.subject;
      if (!(i.parent.type === 'stage' && i.parent.unit === unit.id && i.parent.stage === 'reproduce' && i.parent.attempt === d.attempt && s.purpose === 'mutant')) return [];
      const of = mutantSubjectDefault(s);
      return of.type === 'finding' ? [of.finding] : [];
    }).at(-1);
    if (killed === undefined) throw new Error(`unit ${unit.id}: reproduce attempt ${d.attempt} decided not-reproduced without a mutant run`);
    const finding = view.holistic().findings.find((f) => f.id === killed);
    if (finding !== undefined && isActive(finding)) out.push(finding.id);
  }
  return out;
}

/**
 * Writes every finding move the log calls for: code's dismissals (a killed mutant), then ownership (owned,
 * fixed-on-branch, resolved, open again). Re-runnable; nothing when no finding is active.
 */
export function syncRepairs(ctx: StageContext): void {
  if (!ctx.journal.view.holistic().findings.some(isActive)) return;
  for (const id of codeDismissals(ctx)) ruleFinding(ctx.journal, id, 'dismissed', { type: 'code', reason: 'not-reproduced' });
  syncFindings(ctx.journal, repairUnits(ctx));
}
