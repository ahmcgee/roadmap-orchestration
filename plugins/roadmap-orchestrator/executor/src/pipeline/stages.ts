// The unit stages from plan-check through lanes (plan "Pipeline for one serial unit", R3), one function
// per stage. Each starts a new attempt, does its work through journaled ops, records exactly one
// `stage-outcome` fact (`outcomeFact`) and returns the `Next` that `transition` decides from the unit state
// the fold derives. Counters are never kept here: the attempt number and every counter come from
// `JournalView.unit`, so a restart sees exactly what the log says.
//
//   plan-check  fresh judgment session (never a resume) → approve | redirect (spec.patch, rev+1) |
//               infeasible | escalate; a redirect may neither lower the risk floor nor widen the unit's
//               envelope; a raised risk re-pins the dispatch record.
//   build       the implementer round (rounds.ts) under the unit's declared resources, held from reserve
//               to teardown; prompt: fast lanes only, the worktree, the evidence dir, the pinned scope. A
//               resolve round must leave the merge-in committed.
//   quiesce     the build invocation's workload is empty (invoke already guarantees it; asserted).
//   evidence    `evidence.snapshot` of the build's stdout, stderr and evidence dir, and the fast lanes'
//               declared outputs in the worktree; then the implementer's decisions.json is appended to
//               the spec's decisions (spec.patch by the executor).
//   salvage     `salvage.commit` under the pinned scope; a contract path in the unit's merge-base diff is
//               a risk trigger; a merge left in progress parks.
//   teardown    cleanup of the build's reservation.
//   lanes       lanes.ts in a detached checkout of the salvage SHA; the lane ledger for the gate.
//
// Needs-user content the table does not carry (occupancy detail, a backend park) is returned as
// `needsUser` for the caller to write (step 13 owns the writer). Nothing written here names a model.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import type { IntentOf, OutcomeStage, StageOutcomeKind } from '../core/events.ts';
import { durableMkdir } from '../core/fsx.ts';
import {
  type InvocationId, type JudgmentSessionId, type Sha, type SpecRev, type UnitId, rulingId,
} from '../core/ids.ts';
import type { SpecM1, SpecPatchOp, NeedsUserContent } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import {
  type AbsPath, type RefName, type RepoPath, type RepoPattern, absPath, branchRef, gitDate, isoTimeOf, repoPath, repoPattern,
} from '../core/values.ts';
import { FILES_DIR, evidenceSnapshotOp } from '../git/evidence.ts';
import { GitError, type Identity, git, revParse } from '../git/git.ts';
import { MergeinStateError, mergeHead, mergeinCompleted } from '../git/mergein.ts';
import {
  SalvageStateError, SalvageUnmergedError, planSalvage, salvageCommitOp, type SalvageRules,
} from '../git/salvage.ts';
import { unitDiffPaths } from '../git/transient.ts';
import type { PlanUnit } from '../input/plan.ts';
import { promptFor } from '../prompts/index.ts';
import type { DocText, FastLane, RulingText } from '../prompts/inputs.ts';
import {
  DECISIONS_FILE, type DecisionsFile, type PlanCheckOutput, validateBuildOutput, validateDecisionsFile, validatePlanCheckOutput,
} from '../prompts/schemas.ts';
import { probe } from '../resources/probe.ts';
import { type Reservation, type StageHolder, cleanup, fastLanes, reserve, run } from '../resources/reserve.ts';
import { renderSpec } from '../spec/render.ts';
import { SpecPatchOpError, SpecPatchStaleError, applySpecPatch, specPatchFileOp } from '../spec/patch.ts';
import { loadSpec } from '../spec/spec.ts';
import {
  type BackendVerdict, JUDGMENT_DEADLINE_MS, type StageContext, type StageParent, callBackend, dispatchOf, evidenceRoot,
  implementerDispatch, judgmentDispatch, pinDispatch, raiseRisk, riskAbove, runOp, runPrepared, verdictOf, verificationWorktree, workDir,
} from './dispatch.ts';
import { quiescent } from './invoke.ts';
import { type LaneRecord, type VerificationTree, laneOrder, removeVerificationTree, runLaneSeries, specSeriesRoot } from './lanes.ts';
import { type RoundInput, callImplementer, laneFixRound, prepareRound } from './rounds.ts';
import { type Next, type StageOutcome, outcomeFact, transition } from './transitions.ts';

/** One stage attempt, recorded. `needsUser`: content beyond the table's own, for the caller to write. */
export type StageDone<S extends OutcomeStage> = Readonly<{
  attempt: number;
  outcome: Extract<StageOutcome, Readonly<{ stage: S }>>;
  next: Next;
  needsUser: NeedsUserContent | null;
}>;

/** A new attempt of `stage`: attempts are numbered across the unit's stages, from the fold's count. */
export function start(ctx: StageContext, unit: UnitId, stage: OutcomeStage): StageParent {
  return { type: 'stage', unit, stage, attempt: ctx.journal.view.unit(unit).counters.attempts + 1 };
}

/** Records the attempt's stage-outcome fact and returns the decision the table makes from the fold's state. */
export function record<S extends OutcomeStage>(
  ctx: StageContext, parent: StageParent & Readonly<{ stage: S }>, kind: StageOutcomeKind<S>, needsUser: NeedsUserContent | null = null,
): StageDone<S> {
  const outcome = { stage: parent.stage, kind } as Extract<StageOutcome, Readonly<{ stage: S }>>;
  const u = ctx.journal.view.unit(parent.unit);
  const next = transition(u, outcome);
  ctx.journal.fact(outcomeFact(u, outcome, parent.attempt));
  return { attempt: parent.attempt, outcome, next, needsUser };
}

export const at = <S extends OutcomeStage>(p: StageParent, stage: S): StageParent & Readonly<{ stage: S }> => {
  if (p.stage !== stage) throw new Error(`a ${p.stage} attempt used as ${stage}`);
  return p as StageParent & Readonly<{ stage: S }>;
};

// ---------------------------------------------------------------------------------------------------
// Inputs, snapshotted by revision

export function loadUnitSpec(ctx: StageContext, unit: PlanUnit): Readonly<{ path: AbsPath; spec: SpecM1 }> {
  const path = absPath(join(ctx.planDir, unit.spec));
  const spec = loadSpec(path);
  if (spec.unit !== unit.id) throw new Error(`${path} is the spec of ${spec.unit}, not of ${unit.id}`);
  return { path, spec };
}

export function integrationTip(ctx: StageContext): Sha {
  return revParse(ctx.repo, branchRef(ctx.plan.integrationBranch));
}

/** A product document as committed at `tip`. */
export function docAt(ctx: StageContext, tip: Sha, path: RepoPath): DocText {
  return { path, text: git(ctx.repo, ['cat-file', 'blob', `${tip}:${path}`]) };
}

const RULING_LINE = /^(C-[0-9]+) — (.+)$/;

/**
 * The C-nn ledger (plan `rulings`, relative to the plan dir): one ruling per line, `C-<n> — <rule>`
 * (DESIGN-1.0.md §2.6); blank lines and `#` headings are skipped, anything else is refused. M1 specs cite
 * no subset, so every ruling is cited.
 */
export function loadRulings(ctx: StageContext): readonly RulingText[] {
  const path = join(ctx.planDir, ctx.plan.rulings);
  return readFileSync(path, 'utf8').split('\n').flatMap((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return [];
    const m = RULING_LINE.exec(line);
    if (m === null) throw new SchemaError(`${path}:${i + 1}`, 'a ruling line "C-<n> — <rule>"', line);
    return [{ id: rulingId(m[1]), text: m[2]! }];
  });
}

/** The cited contracts (M1: every plan contract) and the architecture doc at `tip`, by default the integration tip. */
export function documents(ctx: StageContext, tip: Sha = integrationTip(ctx)): Readonly<{ contracts: readonly DocText[]; architectureDoc: DocText }> {
  return { contracts: ctx.plan.contracts.map((c) => docAt(ctx, tip, c)), architectureDoc: docAt(ctx, tip, ctx.plan.architectureDoc) };
}

export const inMs = (ms: number) => isoTimeOf(new Date(Date.now() + ms));

type JudgmentOrBuild = 'plan-check' | 'build' | 'gate';

/** Records a call that did not succeed: interrupted (hold), refusal, malformed or process fault. */
export function verdictKind<S extends JudgmentOrBuild>(
  ctx: StageContext, parent: StageParent & Readonly<{ stage: S }>, v: Exclude<BackendVerdict, Readonly<{ kind: 'success' }>>,
): StageDone<S> {
  if (v.kind === 'interrupted') return record(ctx, parent, 'interrupted' as StageOutcomeKind<S>, v.needsUser);
  return record(ctx, parent, v.kind as StageOutcomeKind<S>);
}

// ---------------------------------------------------------------------------------------------------
// plan-check

export type PlanCheckDone = StageDone<'plan-check'> & Readonly<{ session: JudgmentSessionId; specRev: SpecRev }>;

/** The resources a patch's lanes would take beyond the unit's declared set: widening its envelope. */
function widenedResources(unit: PlanUnit, patch: PlanCheckOutput['patch']): readonly string[] {
  return (patch ?? []).flatMap((op) => (op.op === 'add' || op.op === 'replace') && op.section === 'lanes'
    ? op.item.resources.filter((r) => !unit.resources.includes(r))
    : []);
}

export async function planCheck(ctx: StageContext, unit: PlanUnit): Promise<PlanCheckDone> {
  const { path, spec } = loadUnitSpec(ctx, unit);
  const pinned = pinDispatch(ctx, unit, spec.rev);
  const parent = at(start(ctx, unit.id, 'plan-check'), 'plan-check');
  const seat = judgmentDispatch(ctx, unit.id, 'plan-check');
  const prompt = promptFor('planCheck', seat.triple.model);
  const session = freshJudgmentSession();
  const { contracts, architectureDoc } = documents(ctx);
  const rendered = prompt.render({
    spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec) }, contracts, rulings: loadRulings(ctx), architectureDoc,
    direction: ctx.plan.direction, scope: pinned.scope, risk: pinned.riskFloor,
  });
  const called = await callBackend(ctx, {
    unit: unit.id, parent, request: { kind: 'judgment', dispatch: seat, session, evidenceDirs: [] },
    system: prompt.system, rendered, schema: prompt.schema, cwd: ctx.repo, deadlineAt: inMs(JUDGMENT_DEADLINE_MS),
  });
  const done = (d: StageDone<'plan-check'>): PlanCheckDone => ({ ...d, session: session.id, specRev: spec.rev });
  const v = verdictOf(ctx, parent, called);
  if (v.kind !== 'success') return done(verdictKind(ctx, parent, v));

  let out: PlanCheckOutput;
  try {
    out = validatePlanCheckOutput(v.value);
  } catch (error) {
    if (error instanceof SchemaError) return done(record(ctx, parent, 'malformed'));
    throw error;
  }
  // R2: the judgment may raise the floor, never lower it, and a redirect may not widen the envelope.
  if (riskAbove(pinned.riskFloor, out.risk)) return done(record(ctx, parent, 'risk-lowered'));
  if (widenedResources(unit, out.patch).length > 0) return done(record(ctx, parent, 'scope-widened'));
  const patch = out.patch === null ? null : { expectRev: spec.rev, by: { role: 'planCheck', routingRev: seat.routingRev, inv: called.inv }, ops: out.patch } as const;
  if (patch !== null) {
    try {
      applySpecPatch(spec, patch);
    } catch (error) {
      // A patch against ids that do not exist, or reusing one, is an unusable judgment.
      if (error instanceof SpecPatchOpError || error instanceof SpecPatchStaleError) return done(record(ctx, parent, 'malformed'));
      throw error;
    }
  }
  if (riskAbove(out.risk, pinned.riskFloor)) raiseRisk(ctx.journal, pinned, out.risk, spec.rev);
  // A redirect beyond its bound escalates instead; only a redirect the table takes patches the spec.
  if (patch !== null && outcomeFact(ctx.journal.view.unit(unit.id), { stage: 'plan-check', kind: 'redirect' }, parent.attempt).class === 'redirect') {
    await runOp(ctx.journal, specPatchFileOp, `spec:${unit.id}`, parent, { path, patch });
  }
  return done(record(ctx, parent, out.decision));
}

// ---------------------------------------------------------------------------------------------------
// build

/** What the stages after a successful build work on. */
export type BuildRun = Readonly<{
  inv: InvocationId;
  invDir: AbsPath;
  worktree: AbsPath;
  branch: RefName;
  /** The implementer's evidence dir (decisions.json). */
  workDir: AbsPath;
  /** Held from reserve to teardown; null when the unit declares no resources. */
  reservation: Reservation<'running', StageHolder> | null;
}>;

export type BuildDone = StageDone<'build'> & Readonly<{ run: BuildRun | null }>;

const activeFastLanes = (spec: SpecM1): readonly FastLane[] =>
  fastLanes(spec).filter((l) => l.state === 'active') as readonly (FastLane & Readonly<{ state: 'active' }>)[];

export async function build(ctx: StageContext, unit: PlanUnit, input: RoundInput): Promise<BuildDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const dispatch = implementerDispatch(ctx, unit.id);
  const parent = at(start(ctx, unit.id, 'build'), 'build');
  const round = await prepareRound(ctx, dispatch, input, parent);
  const failed = (d: StageDone<'build'>): BuildDone => ({ ...d, run: null });

  let held: Reservation<'running', StageHolder> | null = null;
  if (unit.resources.length > 0) {
    const holder: StageHolder = { type: 'stage', unit: unit.id, stage: 'build', attempt: parent.attempt };
    const reserved = reserve(ctx, holder, unit.resources, parent);
    // M1 runs one unit at a time and every holder releases before its stage ends: a busy resource is a leak.
    if (reserved.state === 'refused') throw new Error(`build of ${unit.id}: resources ${reserved.busy.join(', ')} are held by another`);
    const occupancy = await probe(ctx, reserved, parent);
    if (occupancy.kind === 'parked') {
      const cleaned = await cleanup(ctx, reserved, parent);
      return failed(cleaned.kind === 'cleanup-failed' ? record(ctx, parent, 'cleanup-failed') : record(ctx, parent, 'occupied', occupancy.needsUser));
    }
    held = run(ctx, reserved, parent);
  }

  const work = workDir(ctx.runDir, parent);
  durableMkdir(work);
  const prompt = promptFor('build', dispatch.triple.model);
  const { contracts } = documents(ctx);
  const rendered = prompt.render({
    spec: { unit: unit.id, rev: spec.rev, markdown: renderSpec(spec, { fastLanesOnly: true }) }, contracts, rulings: loadRulings(ctx),
    fastLanes: activeFastLanes(spec), evidenceDir: work, worktree: round.worktree, scope: pinned.scope, fixRound: round.fixRound,
  });
  const called = await callImplementer(ctx, {
    unit: unit.id, parent,
    request: { kind: 'implementer', dispatch, session: round.session, evidenceDirs: [work, ...(round.fixRound?.failingEvidenceDirs ?? [])] },
    system: prompt.system, rendered, schema: prompt.schema, cwd: round.worktree, deadlineAt: round.deadlineAt,
  });
  const v = verdictOf(ctx, parent, called);
  let malformed = false;
  if (v.kind === 'success') {
    try {
      validateBuildOutput(v.value);
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      malformed = true;
    }
  }
  // A resolve round must end with the merge committed: HEAD with parents [old, T] (mergeinCompleted). A
  // report of success without it does not describe the tree, so it is read as a malformed report.
  if (v.kind === 'success' && !malformed && round.kind === 'resolve') malformed = !mergeinResolved(ctx, unit.id);
  if (v.kind === 'success' && !malformed && called.kind === 'result') {
    return {
      ...record(ctx, parent, 'success'),
      run: { inv: called.inv, invDir: called.invDir, worktree: round.worktree, branch: round.branch, workDir: work, reservation: held },
    };
  }
  // Nothing downstream runs after a failed build, so its resources are cleaned now (the workload is quiescent).
  if (held !== null && (await cleanup(ctx, held, parent)).kind === 'cleanup-failed') return failed(record(ctx, parent, 'cleanup-failed'));
  return failed(v.kind === 'success' ? record(ctx, parent, 'malformed') : verdictKind(ctx, parent, v));
}

/** The unit's latest merge-in: the conflicted one a resolve round resolves. */
export function latestMergein(ctx: StageContext, unit: UnitId): IntentOf<'mergein.prepare'> | null {
  return ctx.journal.view.opsOf('mergein.prepare').filter((i) => i.parent.type === 'stage' && i.parent.unit === unit).at(-1) ?? null;
}

function mergeinResolved(ctx: StageContext, unit: UnitId): boolean {
  const intent = latestMergein(ctx, unit);
  if (intent === null) throw new Error(`a resolve round of ${unit} without a merge-in`);
  try {
    mergeinCompleted(intent);
    return true;
  } catch (error) {
    if (error instanceof MergeinStateError) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// quiesce → evidence → salvage → teardown

export function quiesce(ctx: StageContext, unit: UnitId, run: BuildRun): StageDone<'quiesce'> {
  const parent = at(start(ctx, unit, 'quiesce'), 'quiesce');
  // invoke settles only once the workload is empty (R13); this re-checks every ordinal of the op.
  if (!quiescent(ctx, { inv: run.inv, scope: 'op', reason: 'recovery' })) throw new Error(`build ${run.inv} of ${unit} has live workload members after it settled`);
  return record(ctx, parent, 'empty');
}

export type EvidenceDone = StageDone<'evidence'> & Readonly<{ evidence: readonly AbsPath[] }>;

const unique = (patterns: readonly RepoPattern[]): readonly RepoPattern[] => [...new Set(patterns)].sort();

export async function evidence(ctx: StageContext, unit: PlanUnit, run: BuildRun): Promise<EvidenceDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const parent = at(start(ctx, unit.id, 'evidence'), 'evidence');
  const root = evidenceRoot(ctx.runDir, parent);
  const inv = relative(ctx.runDir, run.invDir);
  const work = relative(ctx.runDir, run.workDir);
  const dirs: AbsPath[] = [absPath(join(root, 'build'))];
  await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit.id}`, parent, {
    source: ctx.runDir, globs: [`${inv}/stdout`, `${inv}/stderr`, `${work}/**`].map((g) => repoPattern(g)), dest: dirs[0]!,
  });
  const globs = unique(activeFastLanes(spec).flatMap((l) => l.evidenceGlobs));
  if (globs.length > 0) {
    dirs.push(absPath(join(root, 'tree')));
    await runOp(ctx.journal, evidenceSnapshotOp, `evidence:${unit.id}`, parent, { source: run.worktree, globs, dest: dirs[1]! });
  }
  await appendDecisions(ctx, unit, run, absPath(join(dirs[0]!, FILES_DIR, work, DECISIONS_FILE)), parent);
  return { ...record(ctx, parent, 'captured'), evidence: dirs };
}

/**
 * The implementer's decisions.json, as captured by the snapshot, appended to the spec's decisions section
 * (lead ruling, step 12): one `spec.patch` by the executor, so the gate grades against every decision taken
 * and the new revision is part of the approval fingerprint. A new id is added, a decision restated with new
 * text replaces the active one, a decision restated verbatim is already there. A file that does not
 * validate, or an entry naming an item that is not an active decision, is not appended: it stays in the
 * build's evidence dir, which the gate reads.
 */
async function appendDecisions(ctx: StageContext, unit: PlanUnit, run: BuildRun, file: AbsPath, parent: StageParent): Promise<void> {
  if (!existsSync(file)) return;
  let decisions: DecisionsFile;
  try {
    decisions = validateDecisionsFile(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof SchemaError) return;
    throw error;
  }
  const { path, spec } = loadUnitSpec(ctx, unit);
  const ops = decisions.decisions.flatMap((d): SpecPatchOp[] => {
    const other = [...spec.lanes, ...spec.acceptance, ...spec.facts].some((i) => i.id === d.id);
    const decided = spec.decisions.find((i) => i.id === d.id);
    if (other || (decided !== undefined && decided.state !== 'active')) return [];
    if (decided === undefined) return [{ op: 'add', section: 'decisions', item: d }];
    return decided.text === d.text ? [] : [{ op: 'replace', section: 'decisions', item: d }];
  });
  if (ops.length === 0) return;
  await runOp(ctx.journal, specPatchFileOp, `spec:${unit.id}`, parent, { path, patch: { expectRev: spec.rev, by: { role: 'executor', inv: run.inv }, ops } });
}

export type SalvageDone = StageDone<'salvage'> & Readonly<{ sha: Sha | null }>;

const EXECUTOR = { name: 'Roadmap Executor', email: 'executor@roadmap.invalid' } as const;

/** The identity of every commit the executor makes (salvage, merge-in, candidate, snapshot), dated now. */
export function executorIdentity(): Identity {
  const date = gitDate(`${Math.floor(Date.now() / 1000)} +0000`);
  return { author: { ...EXECUTOR, date }, committer: { ...EXECUTOR, date } };
}

export async function salvage(ctx: StageContext, unit: PlanUnit, run: BuildRun): Promise<SalvageDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const pinned = dispatchOf(ctx.journal.view, unit.id);
  const parent = at(start(ctx, unit.id, 'salvage'), 'salvage');
  const rules: SalvageRules = {
    scope: pinned.scope,
    excluded: unique(spec.lanes.flatMap((l) => l.evidenceGlobs)),
    rejectedRoot: absPath(join(ctx.runDir, 'rejected', unit.id)),
  };
  const request = {
    worktree: run.worktree, branch: run.branch,
    identity: executorIdentity(),
    message: `roadmap ${ctx.plan.arc}: salvage of unit ${unit.id} (build ${run.inv})\n`,
  };
  const op = salvageCommitOp(rules);
  let prepared;
  try {
    // A merge left in progress (a resolve round that never committed) is never salvaged as a plain commit.
    if (mergeHead(run.worktree) !== null) throw new SalvageUnmergedError(run.worktree, [repoPath('MERGE_HEAD')]);
    const decision = planSalvage(rules, request);
    prepared = decision.kind === 'no-change' ? null : await op.prepare(decision.plan);
  } catch (error) {
    const kind = error instanceof SalvageUnmergedError ? 'unmerged'
      : error instanceof SalvageStateError || error instanceof GitError ? 'commit-failed' : null;
    if (kind === null) throw error;
    // Refused before any intent: the tree is untouched and preserved for the architect. The unit parks, so
    // teardown never runs: the build's resources are cleaned here (a failure leaves its residue durable).
    if (run.reservation !== null) await cleanup(ctx, run.reservation, parent);
    return { ...record(ctx, parent, kind), sha: null };
  }
  const next = prepared === null
    ? revParse(run.worktree, 'HEAD')
    : (await runPrepared(ctx.journal, op, `salvage:${unit.id}`, parent, prepared)).post.new;
  // A risk trigger when the unit's diff (merge-base with the integration tip, so what a merge-in brought
  // is not the unit's) touches a contract or the architecture doc.
  const contracts = new Set<string>([...ctx.plan.contracts, ctx.plan.architectureDoc]);
  const touched = unitDiffPaths(ctx.repo, integrationTip(ctx), next).some((p) => contracts.has(p));
  return { ...record(ctx, parent, touched ? 'committed-contract-touched' : 'committed'), sha: next };
}

export async function teardown(ctx: StageContext, unit: UnitId, run: BuildRun): Promise<StageDone<'teardown'>> {
  const parent = at(start(ctx, unit, 'teardown'), 'teardown');
  if (run.reservation === null) return record(ctx, parent, 'released');
  const cleaned = await cleanup(ctx, run.reservation, parent);
  return record(ctx, parent, cleaned.kind === 'released' ? 'released' : 'cleanup-failed');
}

// ---------------------------------------------------------------------------------------------------
// lanes

export type LanesDone = StageDone<'lanes'> & Readonly<{
  /** The salvage SHA the lanes ran at. */
  at: Sha;
  /** Every lane that ran, in order: the gate's lane ledger. */
  ledger: readonly LaneRecord[];
  /** The checkout the gate reads, kept only on green; every other outcome removes it here. */
  verification: VerificationTree | null;
  /** The fix round a red or not-certified series calls for (rounds.ts), else null. */
  fix: RoundInput | null;
}>;

export async function lanes(ctx: StageContext, unit: PlanUnit, salvaged: Sha): Promise<LanesDone> {
  const { spec } = loadUnitSpec(ctx, unit);
  const parent = at(start(ctx, unit.id, 'lanes'), 'lanes');
  const checkout = { path: verificationWorktree(ctx.plan.worktreeRoot, ctx.plan.arc, unit.id, parent.attempt), checkout: { type: 'detached', at: salvaged } } as const;
  const series = await runLaneSeries(ctx, parent, laneOrder(spec), 'spec', checkout, specSeriesRoot(ctx.runDir, parent));
  const { end } = series;
  const kind: StageOutcomeKind<'lanes'> = end.kind === 'green' ? (series.dirty.length > 0 ? 'not-certified' : 'green') : end.kind;
  const keep = kind === 'green' ? series.tree : null;
  if (series.tree !== null && keep === null) await removeVerificationTree(ctx, series.tree, parent);
  const fix = kind === 'red' || kind === 'not-certified' ? laneFixRound(series.ledger, series.dirty, salvaged) : null;
  const needsUser = end.kind === 'occupied' ? end.needsUser : null;
  return { ...record(ctx, parent, kind, needsUser), at: salvaged, ledger: series.ledger, verification: keep, fix };
}
