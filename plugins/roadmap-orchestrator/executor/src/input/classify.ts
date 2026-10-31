import { ciReasons, lanePlacementReasons } from './ci.ts';
import { mayOverlap } from '../core/values.ts';
import { protectedPaths } from './protected.ts';
import { referenceCommit } from '../phase0/rows.ts';
// Classify a proposal against the plan in force. Every refused edit contributes its reason.
// Root applies authorize weakenings with their reason; automatic revisions retain the frozen contract gate.
import type { IntentOf,PlanChange } from '../core/events.ts';
import { PLAN_FIELDS } from '../core/events.ts';
import {
type JobId,type ObligationId,
type ResourceName,type ResourceUnit,type RulingId,type Sha256Hex,type UnitId,type VisionClauseId,
canonicalIds,
compareIds,
parseResourceUnit
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import { readJournal } from '../core/log.ts';
import {
BOUND_FIELDS,
type Bounds,
type ResidueKey,type RevisionManifest,type SpecM1,
specObligations,specRepairs,specWitnesses
} from '../core/records.ts';
import { type UnitState,maxTier,openAttempt } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import type { AbsPath,RepoPattern } from '../core/values.ts';
import { type CorpusPin,parseCorpusPin } from '../corpus/types.ts';
import { classifyObligations } from '../holistic/obligations.ts';
import { specCensusMismatches } from '../holistic/rederive.ts';
import { type BusyAttempt,type ClassifiedAdmit,type ObligationDisposition,type Obligations,type Vision,isExempt,parseObligations,parseVision } from '../holistic/types.ts';
import { advancesReasons,visionEditReasons } from '../holistic/vision.ts';
import { undispositioned } from '../host/residues.ts';
import type { Phase0Record } from '../phase0/types.ts';
import { citedFailure,laneFailures,outcomeRef } from '../pipeline/failures.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { environmentState } from '../resources/environments.ts';
import { cpuCapacity,overCapacity } from '../resources/pool.ts';
import { resourceTable } from '../resources/reserve.ts';
import { type ResolvedRouting,unsupportedSeats } from '../routing/layers.ts';
import { RISK_TIERS,type RiskTier,UNIT_ROLES } from '../routing/types.ts';
import { effectiveGraph,findCycle } from '../schedule/graph.ts';
import type { CommandScope,ScopeOf } from '../schedule/types.ts';
import { type Ruling,parseRulings } from '../spec/rulings.ts';
import { SpecFileError,bytesSha256,evidenceScopeConflicts,parseSpec } from '../spec/spec.ts';
import { baseFiles,compareAndSwap } from './cas.ts';
import {
type InForce,
type InputFiles,PLAN_INPUT,type RevisionInForce,type RoutingBase,SPEC_INPUT,
inForceFiles,
inputPath,keptInput,phase0RecordOf,planInForce,planRouting,
readInputFiles,revisionInForce,revisionManifestOf,
specShaInForce,unitRouting
} from './inforce.ts';
import {
type KnownDefect,type PlanM1,type PlanUnit,boundsOf,derivedOf,environmentOf,environmentsOf,hasMilestones,knownDefectsOf,milestonesNeedHolistic,milestonesOf,parsePlan,
planFieldValue,priorityOf,reservedUnitIdReason,
} from './plan.ts';

/**
 * Who proposes a revision (G1), as far as its rules differ: an architect's `apply`, `rule` or `reverse` command, a
 * start whose files differ, a checkpoint bundle (its cites back a split that drops text), or the executor's own
 * machine revision. Its source (`RevisionSource`) is the payload's.
 */
/**
 * Who proposes a revision. A bundle's `admits` (M4a rev 3, OR-A1): the classes code gave its admit ops (empty in an
 * `architecture-doc` arc, LR-h); an `opportunity` class's clauses are the only `holistic.advances` it may add. An
 * apply's `rulings` (M4a rev 3, I2): the ids its `--ruling` records land (absent: none), the only ledger change it may make.
 */
export type Proposer =
  | Readonly<{ type: 'apply'; reason?: string }>
  | Readonly<{ type: 'reverse' | 'start' | 'executor' }>
  /**
   * 2026-10-15 (arc feedback #3): a plan-check redirect's patch of its own unit's spec, validated (never committed: the
   * stage applies it as a machine `spec.patch`) by the same classifier every revision runs. Its unit is mid-attempt and
   * its patch takes the next rev, so the dispatched-spec rules do not apply to that unit's spec.
   */
  | Readonly<{ type: 'plan-check'; unit: UnitId }>
  /**
   * `fixesUnrecorded`: the units the bundle's `reenter` ops introduce from an answer recorded before `fixes` (a previous
   * release's, `reenterFixesDefault`): adopted as recorded, the `fixes` rows do not bind them (`fixesReasons`).
   */
  | Readonly<{
    type: 'bundle'; job: JobId; cites: readonly VisionClauseId[]; evidence: readonly string[]; admits: readonly ClassifiedAdmit[];
  }>
  /** dev.13 (agent D): the code-applied polish revision of walk `job` (src/walk/polish.ts): it only admits that walk's proposals. */
  | Readonly<{ type: 'walk'; job: JobId }>
  /** dev.13 (agent D): the cut of polish unit `unit` its compare judged `drop` (src/walk/compare.ts): it only cuts that unit. */
  | Readonly<{ type: 'compare'; unit: UnitId }>
  /**
   * dev.17 (design pass): the split revision of `unit`'s plan-check (src/pipeline/split.ts): it cuts `unit` (reason
   * `splitCutReason`), adds `children`, moves every unit waiting on `unit` onto all of them and every milestone listing `unit`
   * onto them (`splitRows`).
   */
  | Readonly<{ type: 'split'; unit: UnitId; children: readonly UnitId[] }>
  /** dev.17 (flaky ledger): the code-applied deflake revision (src/pipeline/deflake.ts): it only admits deflake units. */
  | Readonly<{ type: 'deflake' }>;
  /** dev.17: the code-applied propagation revision of the stale set plan rev `rev` recorded (src/holistic/propagation.ts): it only admits its propagation units. */

/** The revision's inputs beyond plan and specs, parsed (what renders and the payload are built from). */
export type NextInputs = Readonly<{
  reason?: string | undefined;
  ledger: readonly Ruling[];

  obligations: Obligations | null;
  vision: Vision | null;
  /** M4a: a corpus arc's pin and Phase-0 record (null when absent or not loading: the rows refuse them). */
  corpus: Readonly<{ pin: CorpusPin | null; phase0: Phase0Record | null }> | null;
  /** What changed against the inputs in force. */
  changed: Readonly<{ rulings: boolean; obligations: boolean; vision: boolean; corpus: boolean; phase0: boolean }>;
}>;

export type Classified =
  | Readonly<{ kind: 'unchanged' }>
  /**
   * `scoped`: the units whose plan entry or spec changed, for the startup rows an apply re-runs. `routings`: every
   * routing the revision changed (the plan's, and each re-routed unit's), for the smoke of newly seated backends.
   * `dispositions`: the weakenings and the rulings that allow them; `dropped`: a checkpoint split's dropped text.
   */
  | Readonly<{
    kind: 'accepted'; changes: readonly PlanChange[]; scoped: readonly UnitId[]; routings: readonly ResolvedRouting[];
    dispositions: readonly Readonly<{ obligation: ObligationId; disposition: ObligationDisposition; reason: string; rev: number }>[];
    dropped: readonly Readonly<{ obligation: ObligationId; sentences: readonly string[] }>[];
    inputs: NextInputs;
  }>
  | Readonly<{ kind: 'rejected'; reasons: readonly string[] }>
  /**
   * dev.17 (arc feedback 2026-10-23, item 7): nothing refused, but a spec edit of a unit running a stage attempt (`busy`), which
   * holds only at that attempt's boundary. An apply's scope then holds the busy units (`commandScope`), so the scheduler lands it
   * at their boundary and evaluates it again there; `changes`: the rest of its edits, for that scope. Any other proposer refuses it.
   */
  | Readonly<{ kind: 'busy'; busy: readonly BusyAttempt[]; changes: readonly PlanChange[] }>;

export type ClassifyInput = Readonly<{
  runDir: AbsPath;
  view: JournalView;
  inForce: InForce;
  /** The inputs in force beyond plan and specs (src/input/inforce.ts `revisionInForce`). */
  revision: RevisionInForce;
  next: InputFiles;
  /** Residues on this host not yet disposed of: a resource they name keeps its declaration. */
  residues: readonly ResidueKey[];
  /** The arc's profile and repo config: a plan's and a unit's routing resolve under them. */
  routing: RoutingBase;
  proposer: Proposer;
}>;

const FIXED = ['arc', 'integrationBranch', 'baseline', 'worktreeRoot'] as const;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Two specs equal but for their lanes' evidenceGlobs and evidenceExcludes. */
export function sameBesidesEvidence(a: SpecM1, b: SpecM1): boolean {
  const blank = (s: SpecM1): string => canonicalJson({ ...s, lanes: s.lanes.map((l) => ({ ...l, evidenceGlobs: [], evidenceExcludes: [] })) });
  return blank(a) === blank(b);
}

/** A unit whose gate approved it and which is publishing or merged: its spec is fixed. */
export function approvedOrPublishing(u: UnitState): boolean {
  if (u.status === 'retired') return true;
  if (u.decided === null) return false;
  const d = decidedBy(u.decided);
  return d.kind === 'retire' || (d.kind === 'stage' && ['candidate', 'ff', 'snapshot'].includes(d.target.stage));
}

/** Whether the unit ever started a stage or was pinned: it may no longer be removed. */
export const started = (view: JournalView, unit: UnitId): boolean => view.dispatchOf(unit) !== null || view.unit(unit).counters.attempts > 0;

/**
 * The executor's own revision that set the unit's recorded spec, or null when the architect's did: the
 * implementer's recorded decisions appended at the evidence stage (`spec.patch` by `executor`, lead ruling,
 * step 12). Since A12 it can land while an architect's revision is still unapplied, taking the rev that
 * revision meant to set.
 */
function machineRevision(view: JournalView, unit: UnitId, recorded: Readonly<{ sha256: string }>): IntentOf<'spec.patch'> | null {
  return view.opsOf('spec.patch').find((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.expect.patch.by.role === 'executor'
    && view.doneOf(i.op) !== null && i.post.newSha256 === recorded.sha256) ?? null;
}

/**
 * Why an architect's revision at `rev` is stale because the executor's machine revision took that rev first
 * (lead ruling: kept a rejection, no auto-rebase): it names the intervening revision and where its bytes are.
 */
function staleAfterMachineRevision(runDir: AbsPath, unit: UnitId, path: AbsPath, rev: number, machine: IntentOf<'spec.patch'>): string {
  const { newRev, newSha256 } = machine.post;
  const at = machine.parent.type === 'stage' ? `${machine.parent.stage} attempt ${machine.parent.attempt}` : 'a stage';
  return `unit ${unit}: its spec ${path} is at rev ${rev}, but the unit's spec is now rev ${newRev}, a revision the executor wrote from `
    + `the build's evidence (the implementer's recorded decisions, appended at ${at}) before your edit was applied; `
    + `re-apply your edit on top of rev ${newRev} (kept at ${inputPath(runDir, newSha256, SPEC_INPUT)}) and set rev ${newRev + 1}`;
}

/**
 * M4a rev 3 (OR-A1, B "advances carve-out"): a bundle may change `holistic.advances` only by adding exactly the clauses of
 * the `opportunity` classes its own admits record, removing none. Null when it does; else why not (appended to the
 * owner-only reason).
 */
function opportunityAdvancesReason(proposer: Extract<Proposer, { type: 'bundle' }>, was: readonly VisionClauseId[], next: readonly VisionClauseId[]): string | null {
  const opportunity = canonicalIds(proposer.admits.flatMap((a) => (a.class.type === 'opportunity' ? a.class.clauses : [])));
  const expected = canonicalIds([...was, ...opportunity]);
  if (opportunity.length > 0 && same(canonicalIds(next), expected)) return null;
  return opportunity.length === 0
    ? ' (a bundle adds only the clauses of an opportunity it admits, and this one admits none)'
    : ` (a bundle adds exactly its opportunities' clauses ${opportunity.join(', ')}, and removes none: expected ${expected.join(', ')})`;
}

/** The spec change of a dispatched unit, or why it is refused; null when the file is the unit's spec. */
function dispatchedSpec(
  input: ClassifyInput, unit: PlanUnit, u: UnitState, path: AbsPath, bytes: Buffer, spec: SpecM1, inputs: NextInputs,
): PlanChange | Readonly<{ busy: BusyAttempt }> | string | null {
  const recorded = u.spec;
  if (recorded === null) throw new Error(`unit ${unit.id} is dispatched without a recorded spec`);
  const sha = bytesSha256(bytes);
  const pending = u.pendingRevision;
  if (sha === pending?.sha256) return null;
  const change = (edit: Extract<PlanChange, { type: 'spec' }>['edit']): PlanChange => ({ type: 'spec', unit: unit.id, edit, specRev: spec.rev, specSha256: sha });
  if (sha === recorded.sha256) return pending === null ? null : change('withdrawn');
  const status = u.status;
  if (approvedOrPublishing(u)) return `unit ${unit.id} is ${status === 'retired' ? 'merged' : 'approved and publishing'}; its spec is fixed`;
  if (status === 'stop-pending') return `unit ${unit.id} stopped the arc; its spec is fixed`;
  if (status === 'park-pending' && (u.decided === null || !['plan-check', 'gate'].includes(u.decided.stage))) {
    return `unit ${unit.id} is parked at ${u.decided?.stage}, which is final in M1; re-enter the work under a new unit id`;
  }
  const kept = keptInput(input.runDir, recorded.sha256, SPEC_INPUT);
  if (kept === null) throw new Error(`unit ${unit.id}: the spec it was dispatched at (${recorded.sha256}) is not kept in the run dir`);
  const was = parseSpec(kept, path);
  if (!same(was.resources, spec.resources)) return `unit ${unit.id} is dispatched: its spec's resources may not change`;
  const machine = spec.rev <= recorded.rev && !(spec.rev === recorded.rev && sameBesidesEvidence(was, spec)) ? machineRevision(input.view, unit.id, recorded) : null;
  if (machine !== null) return staleAfterMachineRevision(input.runDir, unit.id, path, spec.rev, machine);
  if (spec.rev === recorded.rev) {
    if (!sameBesidesEvidence(was, spec)) {
      return `unit ${unit.id}: its spec ${path} changed but is still at rev ${recorded.rev}; a revision sets rev ${recorded.rev + 1} `
        + '(lane evidenceGlobs and evidenceExcludes may change at the current rev)';
    }
    if (pending !== null) return `unit ${unit.id} has revision ${pending.rev} pending; apply that revision, or the recorded spec to withdraw it, before an evidence-only edit`;
    return busyOr(input.view, unit.id, change('evidence'));
  }
  if (spec.rev !== recorded.rev + 1) {
    return `unit ${unit.id}: its spec ${path} is at rev ${spec.rev}, but the unit's recorded rev is ${recorded.rev}; a revision sets rev ${recorded.rev + 1}`;
  }
  return busyOr(input.view, unit.id, change('revision'));
}

/**
 * An edit of a dispatched unit's spec that holds now, or (dev.17, arc feedback 2026-10-23 item 7) the stage attempt the unit
 * is running: the apply waits for that attempt's boundary and is evaluated again there (`busy`). Arc feedback 2026-10-15: an
 * attempt a crash cut short is recorded at the executor's startup (a recovery hold, or its call), so only a running one waits.
 */
function busyOr(view: JournalView, unit: UnitId, change: PlanChange): PlanChange | Readonly<{ busy: BusyAttempt }> {
  const open = openAttempt(view, unit);
  return open?.live === true ? { busy: { unit, stage: open.stage, attempt: open.attempt } } : change;
}

/** What a busy unit is running, as a refusal or a queued receipt says it. */
export const busyText = (b: BusyAttempt): string => `unit ${b.unit} is running ${b.stage} attempt ${b.attempt}; the edit applies at its stage boundary`;

/**
 * A plan unit without its M2 lifecycle fields, its M3 routing layer and limits and its M4a rev 3 priority (their own edit
 * classes), for comparing the rest of its entry.
 */
function entryOf(u: PlanUnit): Omit<PlanUnit, 'cut' | 'reenters' | 'routing' | 'limits' | 'priority'> {
  const { cut: _cut, reenters: _reenters, routing: _routing, limits: _limits, priority: _priority, ...rest } = u;
  return rest;
}

/** The revision's ledger: its rulings, or why it does not load. */
type Ledger = Readonly<{ path: AbsPath; rulings: readonly Ruling[] }> | Readonly<{ path: AbsPath; error: string }>;

/** Why `ruling` may not back `what`: not in the revision's ledger, withdrawn, or the ledger does not load; null when it may. */
function rulingReason(ledger: Ledger, ruling: RulingId, what: string): string | null {
  if ('error' in ledger) return `${what} cites ruling ${ruling}, but the rulings ledger does not load: ${ledger.error}`;
  const r = ledger.rulings.find((x) => x.id === ruling);
  if (r === undefined) return `${what} cites ruling ${ruling}, which the ledger ${ledger.path} does not hold`;
  return r.status === 'withdrawn' ? `${what} cites ruling ${ruling}, which ${r.by} withdrew` : null;
}

const riskAbove = (a: RiskTier, b: RiskTier): boolean => RISK_TIERS.indexOf(a) > RISK_TIERS.indexOf(b);

/**
 * A unit's Phase-0 risk floor: its risk in the first plan revision that planned it (read from the kept plans the log's
 * revisions name); null for a unit the plan in force does not hold yet (its risk is its floor).
 */
function phase0Risk(input: ClassifyInput, unit: UnitId): RiskTier | null {
  for (const e of readJournal(input.runDir, input.view.arc).events) {
    if (e.type !== 'fact' || e.fact.kind !== 'plan-applied') continue;
    const bytes = keptInput(input.runDir, e.fact.planSha256, PLAN_INPUT);
    if (bytes === null) throw new Error(`plan rev ${e.fact.rev} names plan ${e.fact.planSha256}, which is not kept`);
    const planned = parsePlan(JSON.parse(bytes.toString('utf8'))).units.find((u) => u.id === unit);
    if (planned !== undefined) return planned.risk;
  }
  return null;
}

/**
 * Why `unit`'s risk may not be what the revision sets (DESIGN §2.3 `route`): below its Phase-0 floor without its spec
 * citing an active ruling that applies to it. Null when allowed.
 */
function riskFloorReason(input: ClassifyInput, unit: PlanUnit, spec: SpecM1 | null, inputs: NextInputs, ledger: Ledger): string | null {
  const floor = phase0Risk(input, unit.id);
  if (floor === null || !riskAbove(floor, unit.risk)) return null;
  return input.proposer.type === 'apply' && input.proposer.reason?.trim() ? null : `unit ${unit.id}: risk ${unit.risk} is below its Phase-0 floor ${floor}; lowering it needs apply --reason`;
}

/**
 * Whether the unit is in a task (A12, as the log shows it): active past its first dispatch and not paused, or running an
 * attempt. An attempt a crash cut short is not a task: startup records it (arc feedback 2026-10-15).
 */
function inTask(view: JournalView, u: UnitState): boolean {
  if (openAttempt(view, u.unit)?.live === true) return true;
  const c = view.control();
  return u.status === 'active' && started(view, u.unit) && !c.pausedAll && !c.pausedUnits.includes(u.unit);
}

/** Why `unit` may not be cut now, or null. */
function cutRefusal(view: JournalView, unit: UnitId): string | null {
  const u = view.unit(unit);
  switch (u.status) {
    case 'retired': return `unit ${unit} is merged; it cannot be cut`;
    case 'superseded': return `unit ${unit} is superseded by ${u.supersededBy}; cut its lineage's head instead`;
    case 'cut': throw new Error(`unit ${unit} is cut in the log but not in the plan in force`);
    default:
      if (!inTask(view, u)) return null;
      return `unit ${unit} is in a task (${u.open === null ? `past ${u.stage}` : `at ${u.open.stage}`}); pause it, or let it park, before cutting it`;
  }
}

/**
 * Why the split revision of `unit` may not cut it (dev.17), or null: its plan-check judges the split while the unit is in its
 * task and records the hold before the commit, so the in-a-task refusal does not apply; a merged or superseded unit is not
 * split.
 */
function splitCutRefusal(view: JournalView, unit: UnitId): string | null {
  const u = view.unit(unit);
  return u.status === 'retired' || u.status === 'superseded' || u.status === 'cut' ? `unit ${unit} is ${u.status}; it cannot be split` : null;
}

/**
 * The re-entry rows of `unit` (added now, `reenters` set): the old unit parked or held, the scope within the
 * lineage's envelope or widened beyond it on a ruling its spec cites (F5), the risk at least its floor, a `reset`
 * backed by an active ruling. Its change, or reasons.
 */
function reentryRow(
  input: ClassifyInput, plan: PlanM1, ledger: Ledger, unit: PlanUnit, spec: SpecM1 | null, inputs: NextInputs, cutNow: ReadonlySet<UnitId>,
): Extract<PlanChange, { type: 'unit-reentered' }> | readonly string[] {
  const view = input.view;
  const re = unit.reenters;
  if (re === undefined) throw new Error(`reentryRow of ${unit.id}, which re-enters nothing`);
  const old = view.unit(re.unit);
  if (cutNow.has(re.unit)) return [`unit ${unit.id} re-enters ${re.unit}, which this apply cuts`];
  switch (old.status) {
    case 'park-pending':
    case 'held':
      break;
    case 'retired': return [`unit ${unit.id} re-enters ${re.unit}, which is merged`];
    case 'cut': return [`unit ${unit.id} re-enters ${re.unit}, which is cut`];
    case 'superseded': throw new Error(`unit ${re.unit} is superseded, yet no other unit of the plan re-enters it`);
    default: return [`unit ${unit.id} re-enters ${re.unit}, which is ${old.status}; only a parked or held unit is re-entered`];
  }
  const reasons: string[] = [];
  const root = old.lineage?.root ?? re.unit;
  if (old.risk !== null && maxTier(unit.risk, old.risk) !== unit.risk) reasons.push(`unit ${unit.id}: risk ${unit.risk} is below its lineage's floor ${old.risk}`);
  if (re.reset !== undefined && !(input.proposer.type === 'apply' && input.proposer.reason?.trim())) reasons.push(`unit ${unit.id}: resetting counters needs apply --reason`);
  reasons.push(...fixesReasons(input, unit));
  if (reasons.length > 0) return reasons;
  const change = { type: 'unit-reentered', unit: unit.id, reenters: re.unit, reset: re.reset !== undefined } as const;
  return change;
}

/** The re-entered unit `old`, then each unit its lineage re-entered before it, back to the root. */
function lineageOf(view: JournalView, old: UnitId): readonly UnitId[] {
  const out = [old];
  for (let at = view.unit(old).lineage; at !== null; at = view.unit(at.reenters).lineage) out.push(at.reenters);
  return out;
}

/**
 * Arc feedback 2026-10-16 (a checkpoint re-entered a unit without finding the cause, one more doomed try): the re-entry rows
 * of `fixes`. It is required once the lineage recorded a failure (an outcome or a lane failure), and resolves to a failure
 * of the re-entered lineage (src/pipeline/failures.ts `citedFailure`). Whether the re-entry changes anything the failure ran
 * under is the proposer's method, not checked here (dev.12): the chargeable-failure bound brakes a doomed retry. A re-entry
 * recorded before `fixes` is never classified again (it is in force, not added), and neither row binds one a previous
 * release's checkpoint answer recorded before `fixes` (the bundle proposer's `fixesUnrecorded`).
 */
function fixesReasons(input: ClassifyInput, unit: PlanUnit): readonly string[] {
  const re = unit.reenters!;
  const lineage = lineageOf(input.view, re.unit);
  if (re.fixes === undefined) {
    // A lineage that recorded no failure (a unit held by a pause, re-entered to change course) has none to name.
    const known = lineage.flatMap((u) => [
      ...input.view.unit(u).failures.map(outcomeRef), ...laneFailures({ journal: { view: input.view }, runDir: input.runDir }, { id: u }).map((l) => l.ref),
    ]);
    return known.length === 0 ? [] : [`unit ${unit.id} re-enters ${re.unit} without \`fixes\`: name the failure it fixes, one of ${known.join(', ')}`];
  }
  const cited = citedFailure({ journal: { view: input.view }, runDir: input.runDir }, lineage, re.fixes);
  return typeof cited === 'string' ? [`unit ${unit.id}: \`fixes\` ${cited}`] : [];
}

/** Whether a resource unit belongs to declaration `name`: the name itself, or an instance of the pool. */
function unitOf(u: ResourceUnit, name: ResourceName): boolean {
  const p = parseResourceUnit(u);
  return (p.type === 'named' && p.name === name) || (p.type === 'instance' && p.pool === name);
}

/** Parses a revisioned JSON input for the classifier: its value, or the reason it does not load. */
function parsedInput<T>(what: string, path: AbsPath, bytes: Buffer | null, parse: (v: unknown) => T, reasons: string[]): T | null {
  if (bytes === null) {
    reasons.push(`the ${what} ${path} does not exist`);
    return null;
  }
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    reasons.push(`the ${what} ${path} does not load: ${error.message}`);
    return null;
  }
}

/** The revision's ledger, sidecars, obligations and vision, parsed, and what changed against the inputs in force. */
function nextInputsOf(input: ClassifyInput, reasons: string[]): Readonly<{ ledger: Ledger; inputs: NextInputs }> {
  const { next, revision } = input;
  let ledger: Ledger;
  if (next.ledger.bytes === null) ledger = { path: next.ledger.path, error: `${next.ledger.path} does not exist` };
  else {
    try {
      ledger = { path: next.ledger.path, rulings: parseRulings(next.ledger.bytes.toString('utf8'), next.ledger.path) };
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      ledger = { path: next.ledger.path, error: error.message };
    }
  }
  const obligations = next.obligations === null ? null : parsedInput('obligations file', next.obligations.path, next.obligations.bytes, parseObligations, reasons);
  const vision = next.vision === null ? null : parsedInput('vision file', next.vision.path, next.vision.bytes, parseVision, reasons);
  const sha = (bytes: Buffer | null | undefined): string | null => (bytes === null || bytes === undefined ? null : bytesSha256(bytes));
  const c = next.corpus;
  const m = revision.manifest;
  return {
    ledger,
    inputs: {
      reason: input.proposer.type === 'apply' ? input.proposer.reason : undefined,
      ledger: 'rulings' in ledger ? ledger.rulings : [],

      obligations,
      vision,
      corpus: c === null ? null : { pin: quietly(c.pin.bytes, parseCorpusPin), phase0: phase0RecordOf(c.phase0.bytes) },
      changed: {
        rulings: sha(next.ledger.bytes) !== revision.ledger.sha256,
        obligations: sha(next.obligations?.bytes) !== (revision.obligations?.sha256 ?? null),
        vision: sha(next.vision?.bytes) !== (revision.vision?.sha256 ?? null),
        corpus: sha(c?.pin.bytes) !== (m.corpus ?? null) || sha(c?.guide.bytes) !== (m.corpusGuide ?? null),
        phase0: sha(c?.phase0.bytes) !== (m.phase0 ?? null),
      },
    },
  };
}

/** `bytes` parsed, or null when absent or not loading (the shared Phase-0 rows say why). */
function quietly<T>(bytes: Buffer | null, parse: (v: unknown) => T): T | null {
  if (bytes === null) return null;
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof SchemaError || error instanceof SyntaxError) return null;
    throw error;
  }
}

export { mayOverlap } from '../core/values.ts';
/** What a unit has spent of each counted bound (the time bounds count nothing). */
function spentOf(u: UnitState): Readonly<Partial<Record<keyof Bounds, number>>> {
  return {
    chargeable: u.counters.chargeableFailures,
    redirects: u.counters.redirects - u.redirectBase,
    reviseRounds: u.counters.reviseRounds,
    candidateReds: u.counters.candidateReds,
    retries: Math.max(0, ...Object.values(u.counters.retries)),
  };
}

/** Classifies the files against the plan in force. */
export function classify(input: ClassifyInput): Classified {
  const { view, inForce, next, proposer } = input;
  const cur = inForce.plan;
  const plan = next.plan;
  const reasons: string[] = [];
  const changes: PlanChange[] = [];
  if (!same(cur.previousHead, plan.previousHead)) reasons.push('previousHead is immutable after revision 1');
  const scoped = new Set<UnitId>();
  const busy: BusyAttempt[] = [];
  const { ledger, inputs } = nextInputsOf(input, reasons);
  for (const unit of plan.units) { const was = cur.units.find((u) => u.id === unit.id); if (was !== undefined && !same(was.spike, unit.spike) && started(view, unit.id)) reasons.push(`unit ${unit.id}: spike question/kind is fixed once started`); }
  const ciSpecs = [...next.specs.values()].flatMap((f) => { if (f.bytes === null) return []; try { return [parseSpec(f.bytes, f.path)]; } catch { return []; } });
  reasons.push(...ciReasons(plan, ciSpecs), ...(inputs.obligations?.lanes ?? []).flatMap((l) => lanePlacementReasons(l)));

  for (const field of FIXED) {
    if (!same(cur[field], plan[field])) reasons.push(`${field} may never change (in force: ${String(cur[field])}; plan.json: ${String(plan[field])})`);
  }
  // M4a: the target kind (R17) and the chain (H7) are fixed.
  if (cur.target !== plan.target) reasons.push(`target-kind-changed: the plan target is ${cur.target} in force and ${plan.target} in plan.json; an apply never changes it`);
  if (!same(cur.chain, plan.chain)) reasons.push(`chain-immutable: plan.chain is fixed at revision 1 (in force: ${canonicalJson(cur.chain ?? null)}; plan.json: ${canonicalJson(plan.chain ?? null)})`);

  // Units: removals, additions, order.
  const curIds = cur.units.map((u) => u.id);
  const nextIds = plan.units.map((u) => u.id);
  const planned = new Set(view.plannedUnits());
  const reentering: PlanUnit[] = [];
  for (const u of cur.units) {
    if (nextIds.includes(u.id)) continue;
    if (started(view, u.id)) reasons.push(`unit ${u.id} has started; it cannot be removed`);
    else changes.push({ type: 'unit-removed', unit: u.id });
  }
  for (const u of plan.units) {
    if (curIds.includes(u.id)) continue;
    const reserved = reservedUnitIdReason(u.id);
    if (planned.has(u.id)) reasons.push(`unit id ${u.id} was planned before; ids are never reused`);
    else if (u.cut !== undefined) reasons.push(`unit ${u.id} is added cut; add it without \`cut\`, or leave it out`);
    else if (reserved !== null) reasons.push(reserved);
    else {
      changes.push({ type: 'unit-added', unit: u.id });
      scoped.add(u.id);
      if (u.reenters !== undefined) reentering.push(u);
    }
  }
  // G3: a DAG arc starts units out of plan order, so the started ones keep only their relative order. A re-entry
  // that has not prepared yet has started nothing of its own: its attempts are its lineage's.
  const startedIds = curIds.filter((id) => view.dispatchOf(id) !== null || (view.unit(id).lineage === null && started(view, id)));
  const keptStarted = startedIds.filter((id) => nextIds.includes(id));
  const orderReason = same(nextIds.filter((id) => keptStarted.includes(id)), keptStarted) ? null : `the units that have started must keep their relative order (${keptStarted.join(', ')})`;
  if (orderReason !== null) reasons.push(orderReason);
  else {
    const common = (ids: readonly UnitId[]) => ids.filter((id) => curIds.includes(id) && nextIds.includes(id));
    if (!same(common(curIds), common(nextIds))) changes.push({ type: 'order' });
  }

  // Units in both: their plan entries and their specs.
  const cutNow = new Set<UnitId>();
  const specs = new Map<UnitId, SpecM1>();
  for (const unit of plan.units) {
    const was = cur.units.find((u) => u.id === unit.id);
    const file = next.specs.get(unit.id);
    if (file === undefined) throw new Error(`classify: no spec entry for ${unit.id}`);
    let spec: SpecM1 | null = null;
    if (file.bytes === null) reasons.push(`unit ${unit.id}: its spec ${file.path} does not exist`);
    else {
      try {
        spec = parseSpec(file.bytes, file.path);
        if (spec.unit !== unit.id) {
          reasons.push(`unit ${unit.id}: ${file.path} is the spec of unit ${spec.unit}`);
          spec = null;
        }
      } catch (error) {
        if (!(error instanceof SchemaError || error instanceof SpecFileError)) throw error;
        reasons.push(`unit ${unit.id}: its spec does not load: ${error.message}`);
      }
    }
    if (spec !== null) specs.set(unit.id, spec);
    if (was === undefined) continue;
    if (!same(was.reenters, unit.reenters)) reasons.push(`unit ${unit.id}: \`reenters\` is set when a unit is added, never after`);
    if (was.cut !== undefined && unit.cut === undefined) reasons.push(`unit ${unit.id} is cut; a cut is final`);
    if (was.cut === undefined && unit.cut !== undefined) {
      cutNow.add(unit.id);
      const refusal = proposer.type === 'compare' && proposer.unit === unit.id ? droppedCutRefusal(view, unit)
        : proposer.type === 'split' && proposer.unit === unit.id ? splitCutRefusal(view, unit.id) : cutRefusal(view, unit.id);
      const authorization = (proposer.type === 'apply' && proposer.reason?.trim()) || proposer.type === 'split' || proposer.type === 'compare' ? null : 'cut needs apply --reason';
      if (refusal !== null) reasons.push(refusal);
      if (authorization !== null) reasons.push(authorization);
      if (refusal === null && authorization === null) {
        changes.push({ type: 'unit-cut', unit: unit.id });
        scoped.add(unit.id);
      }
    }
    // M4a rev 3 (F1b): a priority edit drains nothing; a merged unit's is fixed.
    if (priorityOf(was) !== priorityOf(unit)) {
      if (view.unit(unit.id).status === 'retired') reasons.push(`unit ${unit.id} is merged; its priority is fixed`);
      else changes.push({ type: 'unit-priority', unit: unit.id });
    }
    const pinned = view.dispatchOf(unit.id) !== null;
    if (!same(entryOf(was), entryOf(unit))) {
      // M3 (DESIGN §2.3 `route`, step A3): a unit's risk may rise at any time (a dispatched unit is re-pinned at the
      // higher floor, and one whose implementer seat that moves after its build started parks `routing-changed`); it
      // never goes below its Phase-0 floor (its risk when it was planned) without a ruling for it.
      // (A dispatched unit's lower risk is refused below as a fixed field.)
      const lowered = pinned ? null : riskFloorReason(input, unit, spec, inputs, ledger);
      if (lowered !== null) reasons.push(lowered);
      if (!pinned) {
        if (lowered === null) {
          changes.push({ type: 'unit-changed', unit: unit.id });
          scoped.add(unit.id);
        }
      } else {
        const fixed = (['spec', 'risk', 'resources'] as const).filter((k) => !same(was[k], unit[k]) && !(k === 'risk' && riskAbove(unit.risk, was.risk)));
        const added = unit.after.filter((a) => !was.after.includes(a));
        for (const k of fixed) reasons.push(`unit ${unit.id} is dispatched: its ${k} may not change`);
        if (added.length > 0) reasons.push(`unit ${unit.id} is dispatched: it may not run after ${added.join(', ')} as well`);
        if (fixed.length === 0 && added.length === 0) {
          changes.push({ type: 'unit-changed', unit: unit.id });
          scoped.add(unit.id);
        }
      }
    }
    if (file.bytes === null || spec === null) continue;
    if (!pinned) {
      if (bytesSha256(file.bytes) !== inForce.manifest.specs[unit.id]) {
        changes.push({ type: 'spec', unit: unit.id, edit: 'undispatched', specRev: spec.rev, specSha256: bytesSha256(file.bytes) });
        scoped.add(unit.id);
      }
      continue;
    }
    if (proposer.type === 'plan-check' && proposer.unit === unit.id) {
      if (bytesSha256(file.bytes) !== specShaInForce(view, unit.id)) {
        changes.push({ type: 'spec', unit: unit.id, edit: 'revision', specRev: spec.rev, specSha256: bytesSha256(file.bytes) });
        scoped.add(unit.id);
      }
      continue;
    }
    const c = dispatchedSpec(input, unit, view.unit(unit.id), file.path, file.bytes, spec, inputs);
    if (typeof c === 'string') reasons.push(c);
    else if (c !== null && 'busy' in c) busy.push(c.busy);
    else if (c !== null) {
      changes.push(c);
      scoped.add(unit.id);
    }
  }

  // Cuts: no unit left waiting on one (D1: a cut unit never merges).
  const cut = new Set(plan.units.filter((u) => u.cut !== undefined).map((u) => u.id));
  for (const u of plan.units) {
    const on = u.cut === undefined ? u.after.filter((a) => cut.has(a)) : [];
    if (on.length > 0) reasons.push(`unit ${u.id} runs after ${on.join(', ')}, which is cut: cut ${u.id} too, or drop its \`after\``);
  }

  // Re-entries (one successor per unit), then the effective graph (F15), the edges that activate only once a
  // successor prepared included.
  const byOld = new Map<UnitId, UnitId[]>();
  for (const u of plan.units) if (u.reenters !== undefined) byOld.set(u.reenters.unit, [...(byOld.get(u.reenters.unit) ?? []), u.id]);
  const chains = [...byOld].filter(([, units]) => units.length > 1);
  for (const [old, units] of chains) reasons.push(`units ${units.join(', ')} each re-enter ${old}; a lineage is a chain: re-enter its head`);
  for (const unit of reentering) {
    if (chains.some(([old]) => old === unit.reenters?.unit)) continue;
    const row = reentryRow(input, plan, ledger, unit, specs.get(unit.id) ?? null, inputs, cutNow);
    if ('type' in row) {
      changes.push(row);
      scoped.add(row.reenters);
    } else reasons.push(...row);
  }
  if (chains.length === 0) {
    const cycle = findCycle(effectiveGraph(plan.units));
    if (cycle !== null) reasons.push(`the unit graph has a cycle once each re-entered unit stands for its lineage's head: ${cycle.join(' → ')}`);
    else knownDefectRows(view, cur, plan, specs, cutNow, changes, reasons);
  }
  if (!same(derivedOf(cur), derivedOf(plan))) changes.push({ type: 'derived' });

  // dev.13: the milestones (an architect `apply` only), and the holistic layer they need before any routing resolves
  // (the walk roles are in force only in a holistic arc).
  const needsHolistic = milestonesNeedHolistic(plan);
  if (needsHolistic) reasons.push(canonicalJson({ kind: 'milestones-need-holistic' }));
  milestoneRows(view, cur, plan, proposer, changes, reasons);

  // Routing: the plan's layer, then each unit's (`route`, M3); dev.13: milestones added to a plan without any, or all
  // removed, move the walk seats in or out of force (no `routing` change, as for `holistic`: the arc's rev moves with
  // its plan), so the new routing is checked and its newly seated backends smoked.
  const routings: ResolvedRouting[] = [];
  if (!needsHolistic) routingRows(input, cur, plan, changes, routings, scoped, reasons);

  // Limits (M3): never below what a unit has spent.
  const limitsChecked = new Set<UnitId>();
  const checkLimits = (unit: PlanUnit): void => {
    const was = cur.units.find((u) => u.id === unit.id);
    if (limitsChecked.has(unit.id) || was === undefined) return;
    limitsChecked.add(unit.id);
    const before = boundsOf(cur, was);
    const bounds = boundsOf(plan, unit);
    const spent = spentOf(view.unit(unit.id));
    for (const k of BOUND_FIELDS) {
      const s = spent[k];
      if (s !== undefined && bounds[k] !== before[k] && bounds[k] < s) reasons.push(`unit ${unit.id}: its ${k} bound ${bounds[k]} is below what it has spent (${s})`);
    }
  };
  if (!same(cur.limits, plan.limits)) {
    changes.push({ type: 'limits', unit: null });
    for (const unit of plan.units) checkLimits(unit);
  }
  for (const unit of plan.units) {
    const was = cur.units.find((u) => u.id === unit.id);
    if (was === undefined || same(was.limits, unit.limits)) continue;
    changes.push({ type: 'limits', unit: unit.id });
    scoped.add(unit.id);
    checkLimits(unit);
  }

  // A spike can use a declaration through its unit, spec, lane or forced suite. Only Phase 0's
  // owner-reviewed start may introduce that declaration together with the experiment.
  const spikeUses = (name: ResourceName): boolean => plan.units.some((u) => {
    if (u.spike === undefined) return false;
    const spec = ciSpecs.find((s) => s.unit === u.id);
    const lanes = [...(spec?.lanes.filter((l) => l.state === 'active') ?? []), ...plan.suite.lanes.filter((l) => spec?.forces?.includes(l.id))];
    return u.resources.includes(name) || (spec?.resources.includes(name) ?? false) || lanes.some((l) => l.resources.includes(name) || l.environment === name);
  });
  // Resources and pools: a declaration's units are its name, or every instance of the pool.
  const table = resourceTable(view);
  const names = new Set<ResourceName>([...cur.resources, ...plan.resources].map((r) => r.name));
  for (const name of [...names].sort()) {
    const was = cur.resources.find((r) => r.name === name);
    const now = plan.resources.find((r) => r.name === name);
    if (was !== undefined && now !== undefined && same(was, now)) continue;
    if (was === undefined) {
      if (proposer.type !== 'start' && spikeUses(name)) reasons.push(`spike resource ${name} is new: escalate to the owner`);
      changes.push({ type: 'resource', resource: name, edit: 'added' });
      continue;
    }
    const held = [...table].filter(([u, e]) => unitOf(u, name) && (e.pending !== null || e.status.state !== 'free'));
    const residue = input.residues.some((k) => unitOf(k.resource, name));
    if (held.length > 0 || residue) {
      const detail = held.map(([u, e]) => (was.pool === undefined ? e.status.state : `${u} ${e.status.state}`)).join(', ');
      reasons.push(`resource ${name} is ${held.length > 0 ? `held (${detail})` : 'named by an undisposed residue'}; its declaration may not change until it is free and swept`);
    } else {
      changes.push({ type: 'resource', resource: name, edit: now === undefined ? 'removed' : 'changed' });
    }
  }
  // dev.17: environments, as resources (their unit is a named resource), and while not down never changed or removed: the
  // declaration in force is what brings it down.
  const envNames = new Set<ResourceName>([...environmentsOf(cur), ...environmentsOf(plan)].map((e) => e.name));
  for (const name of [...envNames].sort()) {
    const was = environmentOf(cur, name);
    const now = environmentOf(plan, name);
    if (was !== null && now !== null && same(was, now)) continue;
    if (was === null) {
      if (proposer.type !== 'start' && spikeUses(name)) reasons.push(`spike resource ${name} is new: escalate to the owner`);
      changes.push({ type: 'resource', resource: name, edit: 'added' });
      continue;
    }
    const entry = table.get(name);
    const held = entry !== undefined && (entry.pending !== null || entry.status.state !== 'free');
    const state = environmentState(view, name);
    if (held || state !== 'down') {
      reasons.push(`environment ${name} is ${held ? `held (${entry.status.state})` : state}; its declaration may not change until it is free and down`);
    } else {
      changes.push({ type: 'resource', resource: name, edit: now === null ? 'removed' : 'changed' });
    }
  }
  if (changes.some((c) => c.type === 'resource' && c.edit !== 'added')) for (const u of plan.units) scoped.add(u.id);

  // Capacity: no request above its pool's size.
  for (const row of overCapacity(plan, { cpu: cpuCapacity(plan) }, specs)) reasons.push(canonicalJson(row));

  // Suite lanes.
  if (!same(cur.suite, plan.suite)) {
    const atCandidate = cur.units.filter((u) => {
      const s = view.unit(u.id);
      return s.decided?.stage === 'candidate' && (s.status === 'active' || s.status === 'held');
    });
    const open = view.openIntents().some((i) => i.kind === 'candidate.merge' || (i.parent.type === 'stage' && i.parent.stage === 'candidate'));
    // A lanes attempt runs the fast suite lanes, and its fix round reads them back by their definitions in force.
    const atLanes = cur.units.filter((u) => {
      const s = view.unit(u.id);
      if (s.status !== 'active' && s.status !== 'held') return false;
      return s.open?.stage === 'lanes' || (s.decided?.stage === 'lanes' && (s.decided.outcome === 'red' || s.decided.outcome === 'not-certified'));
    });
    if (open || atCandidate.length > 0) {
      reasons.push(`the suite lanes may not change while a candidate is under way (${open ? 'a candidate op is open' : `unit ${atCandidate.map((u) => u.id).join(', ')} is past a candidate attempt`})`);
    } else if (atLanes.length > 0) {
      reasons.push(`the suite lanes may not change while a lanes attempt runs them or its fix round reads them (unit ${atLanes.map((u) => u.id).join(', ')})`);
    } else {
      changes.push({ type: 'suite' });
    }
  }

  // The other plan fields.
  for (const field of PLAN_FIELDS) {
    if (!same(planFieldValue(cur, field), planFieldValue(plan, field))) changes.push({ type: 'plan-field', field });
  }
  if (changes.some((c) => c.type === 'plan-field' && (c.field === 'contracts' || c.field === 'rulings'))) for (const u of plan.units) scoped.add(u.id);

  // M3: the rulings ledger and its sidecars (A3), holistic (A5), the vision (A14), the obligations.
  const landsRulings = proposer.type === 'apply';
  if (inputs.changed.rulings && !landsRulings) {
    reasons.push(`the rulings ledger ${next.ledger.path} changes only through apply`);
  }
  if (cur.holistic !== undefined && plan.holistic === undefined) reasons.push('holistic may be added, never removed (A5)');
  if (cur.holistic === undefined && plan.holistic !== undefined) changes.push({ type: 'holistic' });
  if (cur.holistic !== undefined && plan.holistic !== undefined && !same(cur.holistic.audit, plan.holistic.audit)) {
    reasons.push('holistic.audit may not change once holistic is in force');
  }
  const prevVision = input.revision.vision?.value ?? null;
  if (inputs.changed.vision && inputs.vision !== null && !same(prevVision, inputs.vision)) {
    if (proposer.type !== 'apply') reasons.push(`the vision is owner-only (A14): only an architect \`apply\` changes it, not a ${proposer.type}`);
    else {
      const why = visionEditReasons(prevVision, inputs.vision);
      reasons.push(...why);
      if (why.length === 0) changes.push({ type: 'vision', rev: inputs.vision.rev });
    }
  }
  // The arc's slice of the vision (owner-only, like the vision): it fits the revision's vision whatever changed.
  if (plan.holistic !== undefined && inputs.vision !== null) reasons.push(...advancesReasons(inputs.vision, plan.holistic.advances));
  if (cur.holistic !== undefined && plan.holistic !== undefined && !same(cur.holistic.advances, plan.holistic.advances)) {
    const why = proposer.type === 'apply' ? null : proposer.type === 'bundle' ? opportunityAdvancesReason(proposer, cur.holistic.advances, plan.holistic.advances) : '';
    if (why === null) changes.push({ type: 'advances' });
    else reasons.push(`holistic.advances is owner-only: only an architect \`apply\` changes it, not a ${proposer.type}${why}`);
  }
  const obligations = obligationRows(input, inputs, reasons);
  changes.push(...obligations.changes);
  specRows(input, inputs, specs, changes, reasons);
  censusRows(input, inputs, specs, reasons);
  corpusRows(input, inputs, changes, reasons);
  // dev.13 (agent D): polish units and the code proposers, over every change listed.
  polishRows(view, cur, plan, proposer, changes, reasons);
  splitRows(cur, plan, proposer, changes, reasons);
  // dev.17: deflake units and their code proposer.
  deflakeRows(cur, plan, proposer, changes, reasons);
  // dev.17: propagation units and their code proposer.

  if (reasons.length > 0) return { kind: 'rejected', reasons: [...reasons, ...busy.map(busyText)] };
  if (busy.length > 0) return { kind: 'busy', busy, changes };
  // No change but other bytes (whitespace, key order): the new bytes come into force with no change listed.
  const sameInputs = !inputs.changed.rulings && !inputs.changed.obligations && !inputs.changed.vision && !inputs.changed.corpus && !inputs.changed.phase0;
  if (changes.length === 0 && bytesSha256(next.planBytes) === inForce.manifest.planSha256 && sameSpecs(input) && sameInputs) return { kind: 'unchanged' };
  return {
    kind: 'accepted', changes, scoped: plan.units.map((u) => u.id).filter((id) => scoped.has(id)), routings,
    dispositions: obligations.dispositions, dropped: obligations.dropped, inputs,
  };
}

/** The members of `fixUnit`'s lineage in `plan`: the unit, then each unit re-entering the previous one. */
function planLineage(plan: PlanM1, fixUnit: UnitId): readonly UnitId[] {
  const out: UnitId[] = [fixUnit];
  for (let next = plan.units.find((u) => u.reenters?.unit === out.at(-1)); next !== undefined; next = plan.units.find((u) => u.reenters?.unit === out.at(-1))) {
    out.push(next.id);
  }
  return out;
}

/**
 * M4a rev 3 (F4, R49): the known-defect rows. An entry new or edited by this apply names a fixer the plan holds whose
 * lineage head is neither merged nor cut; a cut of a member of the lineage an unedited entry names is refused; every
 * entry's lane is an active lane of a spec in force; the effective graph with the hold edges is acyclic. Pushes
 * `known-defects` when the entries changed and nothing about them is refused.
 */
function knownDefectRows(
  view: JournalView, cur: PlanM1, plan: PlanM1, specs: ReadonlyMap<UnitId, SpecM1>, cutNow: ReadonlySet<UnitId>, changes: PlanChange[], reasons: string[],
): void {
  const was = knownDefectsOf(cur);
  const now = knownDefectsOf(plan);
  const ids = new Set(plan.units.map((u) => u.id));
  const unedited = (k: KnownDefect): boolean => was.some((w) => same(w, k));
  const before = reasons.length;
  const merged = (u: UnitId): boolean => view.unit(u).status === 'retired';
  for (const k of now) {
    if (!ids.has(k.fixUnit)) {
      reasons.push(`known-defect-fix-unit: ${k.id} names fixUnit ${k.fixUnit}, which the plan does not hold`);
      continue;
    }
    const lineage = planLineage(plan, k.fixUnit);
    if (unedited(k)) {
      const cut = lineage.filter((u) => cutNow.has(u));
      if (cut.length > 0) reasons.push(`known-defect-fix-unit: ${k.id} names fixUnit ${k.fixUnit}, whose lineage this apply cuts (${cut.join(', ')}); edit or remove ${k.id} in the same apply`);
      continue;
    }
    const head = lineage.at(-1)!;
    const headUnit = plan.units.find((u) => u.id === head)!;
    if (merged(head)) reasons.push(`known-defect-fix-unit: ${k.id} names fixUnit ${k.fixUnit}, whose lineage (head ${head}) is merged`);
    else if (headUnit.cut !== undefined) reasons.push(`known-defect-fix-unit: ${k.id} names fixUnit ${k.fixUnit}, whose lineage (head ${head}) is cut`);
  }
  const declares = (u: UnitId, lane: string): boolean => specs.get(u)?.lanes.some((l) => l.id === lane && l.state === 'active') === true;
  for (const k of now) {
    if (!plan.units.some((u) => declares(u.id, k.match.lane))) reasons.push(`known-defect-lane: ${k.id} matches lane ${k.match.lane}, which no spec in force declares`);
  }
  if (reasons.length > before) return;
  // The combined graph: the effective `after` edges, and a hold edge from every unit that may be held to the fixer's head.
  const graph = new Map([...effectiveGraph(plan.units)].map(([u, deps]) => [u, [...deps]]));
  for (const k of now) {
    const lineage = planLineage(plan, k.fixUnit);
    const head = lineage.at(-1)!;
    if (merged(head)) continue;
    for (const [u, deps] of graph) {
      const cut = plan.units.find((x) => x.id === u)?.cut !== undefined;
      if (lineage.includes(u) || merged(u) || cut || !declares(u, k.match.lane) || deps.includes(head)) continue;
      deps.push(head);
      deps.sort();
    }
  }
  const cycle = findCycle(graph);
  if (cycle !== null) {
    reasons.push(`known-defect-cycle: the unit graph with the known-defect holds (a unit declaring a defect's lane waits for its fixer) has a cycle: ${cycle.join(' → ')}`);
    return;
  }
  if (!same(was, now)) changes.push({ type: 'known-defects' });
}

/**
 * The routing rows (M3 `route`): the plan's layer, then each unit's, re-resolved; the unit seats an apply cannot support
 * refused. dev.13: a revision that gives a plan its first milestones, or removes its last, moves the walk seats in or out
 * of force without a layer edit; its routing is pushed for the routing check and the smoke of newly seated backends.
 */
function routingRows(
  input: ClassifyInput, cur: PlanM1, plan: PlanM1, changes: PlanChange[], routings: ResolvedRouting[], scoped: Set<UnitId>, reasons: string[],
): void {
  if (!same(cur.routing, plan.routing)) {
    const resolved = planRouting(input.routing, plan);
    if (resolved.rev !== planRouting(input.routing, cur).rev) {
      routings.push(resolved);
      changes.push({ type: 'routing', routingRev: resolved.rev });
    }
  }
  for (const unit of plan.units) {
    const was = cur.units.find((u) => u.id === unit.id);
    if (same(was?.routing, unit.routing)) continue;
    const resolved = unitRouting(input.routing, plan, unit);
    const unsupported = unsupportedSeats(resolved, unit.id).filter((r) => r.kind === 'unsupported-routing' && (UNIT_ROLES as readonly string[]).includes(r.role));
    reasons.push(...unsupported.map((r) => canonicalJson(r)));
    if (was === undefined || unsupported.length > 0 || resolved.rev === unitRouting(input.routing, cur, was).rev) continue;
    routings.push(resolved);
    changes.push({ type: 'routing', routingRev: resolved.rev, unit: unit.id });
    scoped.add(unit.id);
  }
  if (same(cur.routing, plan.routing) && hasMilestones(cur) !== hasMilestones(plan)) {
    const resolved = planRouting(input.routing, plan);
    if (resolved.rev !== planRouting(input.routing, cur).rev) routings.push(resolved);
  }
}

/**
 * dev.13: the milestones edit class (`milestones`, no drain: the milestone node gates readiness and a walk reads the plan
 * in force when it starts, so nothing running reads them). Only an architect `apply` changes them (the checkpoint cannot:
 * backlog). A milestone a walk started on stays in the plan (its walk facts name it) with the units and design it was
 * walked on; one being walked (started, not ended) does not change until its walk ends; a milestone added, or whose units
 * change, lists a unit still to merge (it is reached on the publication that retires its last unit). On every revision, by
 * any proposer: no milestone lists a cut unit, which never merges, so the milestone would never be reached and its
 * descendants would wait on it for ever.
 */
function milestoneRows(view: JournalView, cur: PlanM1, plan: PlanM1, proposer: Proposer, changes: PlanChange[], reasons: string[]): void {
  const cut = new Set(plan.units.filter((u) => u.cut !== undefined).map((u) => u.id));
  for (const m of milestonesOf(plan)) {
    const on = m.units.filter((u) => cut.has(u));
    if (on.length > 0) reasons.push(`milestone ${m.id} lists ${on.join(', ')}, cut: a cut unit never merges, so the milestone would never be reached; drop it from the milestone's units in the same apply`);
  }
  const was = milestonesOf(cur);
  const now = milestonesOf(plan);
  if (same(was, now)) return;
  // dev.17: a split moves the milestones listing its unit onto the children, and changes nothing else of them (`splitRows`).
  if (proposer.type === 'split' && same(was.map((m) => splitMembership(m, proposer)), now)) {
    changes.push({ type: 'milestones' });
    return;
  }
  if (proposer.type !== 'apply') {
    reasons.push(`the milestones change only through an architect \`apply\`, not a ${proposer.type}`);
    return;
  }
  const walks = view.walkFacts().flatMap((x) => (x.fact.kind === 'walk-started' ? [x.fact] : []));
  const ended = new Set(view.walkFacts().flatMap((x) => (x.fact.kind === 'walk-ended' ? [x.fact.job] : [])));
  const before = reasons.length;
  for (const m of was) {
    const started = walks.filter((w) => w.milestone === m.id);
    const next = now.find((x) => x.id === m.id);
    if (started.length === 0 || same(m, next)) continue;
    const jobs = started.map((w) => w.job).join(', ');
    const open = started.find((w) => !ended.has(w.job));
    if (next === undefined) reasons.push(`milestone ${m.id} has been walked (${jobs}); it cannot be removed`);
    else if (open !== undefined) reasons.push(`milestone ${m.id} is being walked (${open.job}); edit it once the walk ends`);
    else if (!same(m.units, next.units) || !same(m.design, next.design)) {
      reasons.push(`milestone ${m.id} has been walked (${jobs}): its units and design are fixed; plan another milestone for more`);
    }
  }
  const merged = (u: UnitId): boolean => view.unit(u).status === 'retired';
  for (const m of now) {
    const prior = was.find((x) => x.id === m.id);
    if ((prior !== undefined && same(prior.units, m.units)) || walks.some((w) => w.milestone === m.id)) continue;
    if (m.units.every(merged)) reasons.push(`milestone ${m.id}: every unit it lists has merged, so no publication would reach it; list a unit still to merge`);
  }
  if (reasons.length !== before) return;
  // A walked milestone whose bring-up or journeys the apply edits (allowed: a broken bring-up is fixed so) gets a fresh
  // walk attempt count (src/walk/milestones.ts, the walk abandonment brake).
  const rewalk = was.flatMap((m) => {
    const next = now.find((x) => x.id === m.id);
    return next !== undefined && walks.some((w) => w.milestone === m.id) && (!same(m.bringUp, next.bringUp) || !same(m.journeys, next.journeys)) ? [m.id] : [];
  });
  changes.push({ type: 'milestones', ...(rewalk.length === 0 ? {} : { rewalk }) });
}

/** The cut reason of a polish unit its compare judged `drop` (src/walk/compare.ts). */
export const POLISH_DROPPED = 'polish-dropped';

/**
 * Why the compare's cut of polish unit `unit` may not land, or null (dev.13, agent D). The unit waits at its candidate
 * admission, which a dropped tweak never passes (src/schedule/ready.ts `compare` constraint), so it is in no stage although
 * its task may be waiting there: the in-a-task refusal (`cutRefusal`) does not apply. Its `tweak-judged` is a `drop`, the
 * reason `polish-dropped`, and it has no open attempt.
 */
function droppedCutRefusal(view: JournalView, unit: PlanUnit): string | null {
  const judged = view.walkFacts().find((x) => x.fact.kind === 'tweak-judged' && x.fact.unit === unit.id)?.fact;
  if (judged?.kind !== 'tweak-judged' || judged.decision !== 'drop') return `unit ${unit.id}: a compare cuts only a tweak it judged drop`;
  if (unit.cut?.reason !== POLISH_DROPPED) return `unit ${unit.id}: a dropped tweak is cut with the reason ${POLISH_DROPPED}`;
  const u = view.unit(unit.id);
  if (u.status === 'retired' || u.status === 'superseded') return `unit ${unit.id} is ${u.status}; it cannot be cut`;
  const open = openAttempt(view, unit.id);
  return open === null ? null : `unit ${unit.id} has an open ${open.stage} attempt; a dropped tweak waits at its candidate admission`;
}

/**
 * dev.13 (agent D): polish units and the two code proposers (one admit path, two authors: the checkpoint's `admit` and a
 * walk's proposals go through the same admit validation and this classifier).
 * - A polish unit added (not a re-entry) is a walk's: its proposer is the polish revision of the walk whose proposal it
 *   carries, the proposal is of the unit's milestone, and the unit is the proposal's own (its id and scope).
 * - The polish revision (`walk{job}`) only adds such units: any other change is refused.
 * - The compare's cut (`compare{unit}`) only cuts that unit (`droppedCutRefusal` holds the rest).
 */
function polishRows(view: JournalView, cur: PlanM1, plan: PlanM1, proposer: Proposer, changes: readonly PlanChange[], reasons: string[]): void {
  const curIds = new Set(cur.units.map((u) => u.id));
  const proposals = new Map(view.walkFacts().flatMap((x) => (x.fact.kind === 'polish-proposed' ? [[x.fact.id, x.fact] as const] : [])));
  for (const u of plan.units) {
    if (curIds.has(u.id) || u.origin !== 'polish' || u.reenters !== undefined) continue;
    const origin = u.polish!;
    if (proposer.type !== 'walk') {
      reasons.push(`unit ${u.id} is a polish unit: only the executor admits one, from a walkthrough's proposal, not a ${proposer.type}`);
      continue;
    }
    const p = proposals.get(origin.proposal);
    if (p === undefined || p.job !== proposer.job) reasons.push(`unit ${u.id} carries proposal ${origin.proposal}, which is no proposal of ${proposer.job}`);
    else if (p.milestone !== origin.milestone) reasons.push(`unit ${u.id} names milestone ${origin.milestone}; its proposal ${p.id} is of ${p.milestone}`);
    else if (p.unit.id !== u.id || !same([...u.systems].sort(), p.unit.systems)) reasons.push(`unit ${u.id} is not the unit proposal ${p.id} names (${p.unit.id}, systems ${p.unit.systems.join(', ')})`);
  }
  if (proposer.type === 'walk') {
    const added = new Set(plan.units.filter((u) => !curIds.has(u.id) && u.origin === 'polish').map((u) => u.id as string));
    const other = changes.filter((c) => !(c.type === 'unit-added' && added.has(c.unit)));
    if (other.length > 0) reasons.push(`the polish revision of ${proposer.job} only admits its polish units; it also changes ${other.map((c) => canonicalJson(c)).join(', ')}`);
  }
  if (proposer.type === 'compare') {
    const other = changes.filter((c) => !(c.type === 'unit-cut' && c.unit === proposer.unit));
    if (other.length > 0) reasons.push(`the compare's cut of ${proposer.unit} only cuts it; it also changes ${other.map((c) => canonicalJson(c)).join(', ')}`);
  }
}

/** The cut reason of a unit its plan-check split (dev.17, src/pipeline/split.ts): it names the children. */
export const splitCutReason = (children: readonly UnitId[]): string => `split by its plan-check into ${children.join(', ')}`;

/** Milestone `m` with a split's unit replaced by its children in its units (unchanged when it does not list the unit). */
function splitMembership<M extends Readonly<{ units: readonly UnitId[] }>>(m: M, proposer: Extract<Proposer, { type: 'split' }>): M {
  if (!m.units.includes(proposer.unit)) return m;
  return { ...m, units: m.units.flatMap((u) => (u === proposer.unit ? [...proposer.children] : [u])) };
}

/**
 * dev.17 (design pass): the split revision (`split{unit, children}`) changes exactly this: `unit` cut with
 * `splitCutReason(children)`, the children added after it (none a re-entry, each of its origin), each unit that ran after
 * `unit` now after every child instead (and nothing else of it), and the milestones listing `unit` listing the children
 * (`milestoneRows`). The plan-check that split is held (the cut's `cutRefusal` passes). No other proposer adds a unit cut
 * with that reason, so a split is only ever the executor's.
 */
function splitRows(cur: PlanM1, plan: PlanM1, proposer: Proposer, changes: readonly PlanChange[], reasons: string[]): void {
  if (proposer.type !== 'split') return;
  const parent = plan.units.find((u) => u.id === proposer.unit);
  if (parent?.cut?.reason !== splitCutReason(proposer.children)) reasons.push(`the split of ${proposer.unit} cuts it with the reason "${splitCutReason(proposer.children)}"`);
  const children = new Set<string>(proposer.children);
  const curIds = new Set(cur.units.map((u) => u.id));
  for (const id of proposer.children) {
    const u = plan.units.find((x) => x.id === id);
    if (u === undefined || curIds.has(id)) reasons.push(`the split of ${proposer.unit} adds ${id}, a new unit`);
    else if (u.reenters !== undefined || u.origin !== parent?.origin) reasons.push(`child ${id} of ${proposer.unit} is no re-entry and takes its parent's origin`);
  }
  const parentSystems = cur.units.find((u) => u.id === proposer.unit)?.systems ?? [];
  for (const u of plan.units.filter((u) => children.has(u.id))) {
    const outside = u.systems.filter((s) => !parentSystems.includes(s));
    if (outside.length > 0) reasons.push(`child ${u.id} names systems outside parent ${proposer.unit}: ${outside.join(', ')}`);
  }
  for (const u of plan.units) {
    const was = cur.units.find((x) => x.id === u.id);
    if (was === undefined || u.id === proposer.unit) continue;
    const expected = was.after.includes(proposer.unit) ? [...was.after.filter((a) => a !== proposer.unit), ...proposer.children] : was.after;
    if (!same([...expected].sort(), [...u.after].sort()) || !same({ ...entryOf(was), after: [] }, { ...entryOf(u), after: [] })) {
      reasons.push(`the split of ${proposer.unit} moves ${u.id} onto its children only where ${u.id} ran after it, and changes nothing else of it`);
    }
  }
  const allowed = (c: PlanChange): boolean => (c.type === 'unit-cut' && c.unit === proposer.unit) || (c.type === 'unit-added' && children.has(c.unit))
    || (c.type === 'unit-changed') || c.type === 'order' || c.type === 'milestones' || (c.type === 'spec' && children.has(c.unit));
  const other = changes.filter((c) => !allowed(c));
  if (other.length > 0) reasons.push(`the split of ${proposer.unit} only cuts it and adds its children; it also changes ${other.map((c) => canonicalJson(c)).join(', ')}`);
}

/**
 * dev.17 (flaky ledger): a deflake unit added (not a re-entry) is the executor's, from its flaky ledger: only the deflake
 * revision (`deflake`) admits one, and that revision only adds deflake units. Which keys are due is the ledger's
 * (src/pipeline/deflake.ts `deflakeDue`), not a classifier row.
 */
function deflakeRows(cur: PlanM1, plan: PlanM1, proposer: Proposer, changes: readonly PlanChange[], reasons: string[]): void {
  const curIds = new Set(cur.units.map((u) => u.id));
  const added = plan.units.filter((u) => !curIds.has(u.id) && u.origin === 'deflake' && u.reenters === undefined);
  if (proposer.type !== 'deflake') {
    for (const u of added) reasons.push(`unit ${u.id} is a deflake unit: only the executor admits one, from its flaky ledger, not a ${proposer.type}`);
    return;
  }
  const ids = new Set<string>(added.map((u) => u.id));
  const other = changes.filter((c) => !(c.type === 'unit-added' && ids.has(c.unit)));
  if (other.length > 0) reasons.push(`the deflake revision only admits deflake units; it also changes ${other.map((c) => canonicalJson(c)).join(', ')}`);
}

type ObligationRows = Readonly<{
  changes: readonly PlanChange[];
  dispositions: Extract<Classified, { kind: 'accepted' }>['dispositions'];
  dropped: Extract<Classified, { kind: 'accepted' }>['dropped'];
}>;

/** The obligation edit classes (src/holistic/obligations.ts), mapped to plan changes; a split parent is never disposed. */
function obligationRows(input: ClassifyInput, inputs: NextInputs, reasons: string[]): ObligationRows {
  const prev = input.revision.obligations?.value ?? null;
  const next = inputs.obligations;
  const none = { changes: [], dispositions: [], dropped: [] };
  if (prev !== null && input.next.obligations === null) {
    if (input.next.plan.holistic !== undefined) reasons.push('the obligations file may not be dropped once in force; retire each obligation by a ruling instead');
    return none;
  }
  if (next === null || !inputs.changed.obligations) return none;
  const author = input.proposer.type === 'bundle' ? { type: 'checkpoint' as const, cites: input.proposer.cites } : { type: 'architect' as const, reason: input.proposer.type === 'apply' ? input.proposer.reason : undefined, rev: input.inForce.rev + 1 };
  const v = classifyObligations(prev, next, {
    vision: inputs.vision, author,
    latched: new Set(input.view.holistic().latched.map((l) => l.obligation)), published: new Set(input.view.publications().map((p) => p.unit)),
  });
  reasons.push(...v.reasons);
  const changes: PlanChange[] = [];
  const dispositions: ObligationRows['dispositions'][number][] = [];
  const dropped: ObligationRows['dropped'][number][] = [];
  const edited = new Set<string>();
  for (const c of v.changes) {
    if (c.type === 'disposed') {
      const was = prev?.obligations.find((o) => o.id === c.id);
      if (was?.state.type === 'split') {
        reasons.push(`${c.id} is split into ${was.state.children.join(', ')} and stays split: disposition its children instead (H14)`);
        continue;
      }
      dispositions.push({ obligation: c.id, disposition: c.disposition, reason: c.reason, rev: c.rev });
    }
    if (c.type === 'split' && c.dropped.length > 0) dropped.push({ obligation: c.id, sentences: c.dropped });
    changes.push({ type: 'obligation', id: c.id, edit: c.type });
    edited.add(`${c.id}\u0000${c.type}`);
  }
  // A changed arc lane re-witnesses every obligation it witnesses (their proof judgments bind its laneRev).
  for (const o of next.obligations) {
    if (o.witness === null || !v.lanes.includes(o.witness.lane) || edited.has(`${o.id}\u0000witness`) || edited.has(`${o.id}\u0000added`)) continue;
    if (prev?.obligations.some((p) => p.id === o.id) !== true) continue;
    changes.push({ type: 'obligation', id: o.id, edit: 'witness' });
  }
  if (v.mapping) changes.push({ type: 'mapping' });
  const units = new Set(input.next.plan.units.map((u) => u.id));
  for (const o of next.obligations) {
    const unknown = isExempt(o) ? [] : o.deliveredBy.filter((u) => !units.has(u));
    if (unknown.length > 0) reasons.push(`${o.id} is delivered by ${unknown.join(', ')}, which the plan does not list`);
  }
  return { changes, dispositions, dropped };
}

/**
 * The spec rows of every unit the revision adds or whose spec or entry it changes: its declared obligations exist and
 * cover every non-exempt obligation mapped to its declared systems; a `repair`
 * unit declares repairs, each an obligation or a finding of the arc; (2026-10-15) a witness item naming an obligation
 * restates that obligation's witness exactly (`witnessReuseReasons`). And (2026-10-15, arc feedback #3) every active
 * witness item names an arc lane in force (`witnessLaneReasons`): of those units, and of every unit that can still run
 * whenever the obligations change, so no revision leaves a required witness on a lane the lanes stage cannot run.
 */
function specRows(input: ClassifyInput, inputs: NextInputs, specs: ReadonlyMap<UnitId, SpecM1>, changes: readonly PlanChange[], reasons: string[]): void {
  const touched = new Set<UnitId>(changes.flatMap((c) => (c.type === 'spec' || c.type === 'unit-added' || c.type === 'unit-changed' ? [c.unit] : [])));
  const obligations = inputs.obligations;
  const findings = new Set<string>(input.view.holistic().findings.map((f) => f.id));
  const live = (unit: PlanUnit): boolean => unit.cut === undefined && !['retired', 'cut', 'superseded'].includes(input.view.unit(unit.id).status);
  for (const unit of input.next.plan.units) {
    const spec = specs.get(unit.id);
    if (spec === undefined) continue;
    if (touched.has(unit.id) || (inputs.changed.obligations && live(unit))) reasons.push(...witnessLaneReasons(unit.id, spec, obligations));
    if (!touched.has(unit.id)) continue;
    reasons.push(...evidenceScopeConflicts(unit.id, unit.systems, spec, {
      repo: input.next.repo, at: referenceCommit(input.next.repo, input.next.plan), map: input.routing.config?.systemsMap ?? null,
      protectedPaths: protectedPaths(input.next.corpus === null || inputs.corpus?.pin == null || input.next.corpus.guide.bytes === null ? null
        : { pin: { value: inputs.corpus.pin }, guide: { bytes: input.next.corpus.guide.bytes } }),
    }));
    reasons.push(...witnessReuseReasons(unit.id, spec, obligations));
    const declared = specObligations(spec);
    const byId = new Map((obligations?.obligations ?? []).map((o) => [o.id, o]));
    const unknown = declared.filter((id) => !byId.has(id));
    if (unknown.length > 0) reasons.push(`unit ${unit.id} declares obligations ${unknown.join(', ')}, which are not in force`);
    if (obligations !== null) {

      const owed = [...new Set(obligations.mapping.systems.filter((m) => unit.systems.includes(m.system)).flatMap((m) => m.obligations))]
        .filter((id) => !isExempt(byId.get(id)!) && !declared.includes(id)).sort(compareIds);
      if (owed.length > 0) reasons.push(`unit ${unit.id}'s systems map to ${owed.join(', ')}; its spec declares them in \`obligations\``);
    }
    const repairs = specRepairs(spec);
    if (unit.origin === 'repair' && repairs.length === 0) reasons.push(`unit ${unit.id} is a repair unit: its spec names what it repairs in \`repairs\``);
    const bad = repairs.filter((r) => (r.startsWith('F-') ? !findings.has(r) : !byId.has(r as ObligationId)));
    if (bad.length > 0) reasons.push(`unit ${unit.id} repairs ${bad.join(', ')}, which the arc does not hold`);
  }
}

/** 2026-10-15 (arc feedback #3): each active witness item of `spec` whose lane is no arc lane of `obligations`. */
export function witnessLaneReasons(unit: UnitId, spec: SpecM1, obligations: Obligations | null): readonly string[] {
  const lanes = new Set<string>(obligations?.lanes.map((l) => l.id) ?? []);
  const known = lanes.size === 0 ? 'the arc has no arc lanes' : `the arc lanes are ${[...lanes].sort().join(', ')}`;
  return specWitnesses(spec).filter((w) => w.state === 'active' && !lanes.has(w.lane))
    .map((w) => `unit ${unit}'s witness item ${w.id} names lane ${w.lane}, which is not an arc lane in force (${known}): name an arc lane, or strike the item`);
}

/**
 * Paid M4b run 6, a classifier row since 2026-10-15: each active witness item naming an obligation
 * (`WitnessItemDef.obligation`) names a binding obligation the unit delivers (its `deliveredBy` names the unit, or its
 * spec repairs it), and restates that obligation's witness exactly: its lane and one of its test ids. The build then
 * holds one required name per test, never two to rename between.
 */
function witnessReuseReasons(unit: UnitId, spec: SpecM1, obligations: Obligations | null): readonly string[] {
  const linked = specWitnesses(spec).filter((w) => w.state === 'active' && w.obligation !== undefined);
  if (linked.length === 0) return [];
  const repairs = new Set<string>(specRepairs(spec));
  const delivered = (obligations?.obligations ?? []).filter((o) => o.state.type === 'active' && !isExempt(o) && o.witness !== null && (o.deliveredBy.includes(unit) || repairs.has(o.id)));
  const tests = (o: (typeof delivered)[number]): string => `lane ${o.witness!.lane}, test ${o.witness!.testIds.map((t) => JSON.stringify(t)).join(' or ')}`;
  return linked.flatMap((w) => {
    const o = delivered.find((x) => x.id === w.obligation);
    if (o === undefined) {
      const named = delivered.length === 0 ? 'this unit delivers none, so set it to null' : `set it to null or to one of ${delivered.map((x) => x.id).join(', ')}`;
      return [`unit ${unit}'s witness item ${w.id} names obligation ${w.obligation}, which is not an obligation this unit delivers with a witness: ${named}`];
    }
    if (w.lane === o.witness!.lane && o.witness!.testIds.includes(w.testId)) return [];
    return [`unit ${unit}'s witness item ${w.id} names ${o.id}'s witness, so it takes that witness's exact lane and test id (${tests(o)}), not lane ${w.lane}, test ${JSON.stringify(w.testId)}`];
  });
}

/**
 * Run 10 (C): the specs against the census hold at every revision, not only at the start (src/holistic/rederive.ts
 * `specCensusMismatches`, the Phase-0 rows' predicate), over every spec of the revision. One reason, the Phase-0 row as
 * the start and `phase0 check` print it; a bundle's says how the checkpoint fixes it.
 */
function censusRows(input: ClassifyInput, inputs: NextInputs, specs: ReadonlyMap<UnitId, SpecM1>, reasons: string[]): void {
  const census = inputs.obligations?.census;
  if (input.next.plan.target !== 'corpus' || inputs.obligations === null || census === undefined) return;
  const problems = specCensusMismatches(input.next.plan.units.flatMap((u) => specs.get(u.id) ?? []), inputs.obligations, census);
  if (problems.length === 0) return;
  const row = canonicalJson({ kind: 'phase0-invalid', problems });
  if (input.proposer.type === 'plan-check') {
    // Run 10 (C): a plan-check redirect is told how to fix its own patch.
    reasons.push(`${row}: ${problems.map((p) => (p.item.startsWith('I-')
      ? `unit ${p.unit} declares ${p.item}, on ${p.rule}, whose census state is ${p.state}`
      : `unit ${p.unit}'s ${p.item.startsWith('W-') ? 'witness item' : 'acceptance clause'} ${p.item} names ${p.rule}, which the census puts out of slice: cite only in-slice rules in an acceptance clause or witness item, or leave ${p.rule} as a note (a facts item, or notes)`)).join('; ')}`);
    return;
  }
  if (input.proposer.type !== 'bundle') {
    reasons.push(row);
    return;
  }
  const fixes = problems.map((p) => (p.item.startsWith('I-')
    ? `unit ${p.unit} declares ${p.item}, on ${p.rule}, whose census state is ${p.state}: declare only obligations the census names for their rule`
    : `unit ${p.unit}'s ${p.item.startsWith('W-') ? 'witness item' : 'acceptance clause'} ${p.item} names ${p.rule}, which is out of slice: to work on ${p.rule}, admit it as a target of an opportunity whose obligation split anchors a child at ${p.rule} (the census moves), or drop the ${p.rule} citation from ${p.item}`));
  reasons.push(`${row}: ${fixes.join('; ')}`);
}

/**
 * M4a: a corpus arc's re-pin (`corpus`) and Phase-0 record edit (`phase0`), each an architect `apply` only (H7). Their
 * content is the shared Phase-0 rows' (the apply runs them); here: who may change them, and no new `promote`
 * disposition while the arc drains.
 */
function corpusRows(input: ClassifyInput, inputs: NextInputs, changes: PlanChange[], reasons: string[]): void {
  const c = input.next.corpus;
  if (c === null || inputs.corpus === null || input.next.plan.target !== input.inForce.plan.target) return;
  const sha = (bytes: Buffer | null | undefined): Sha256Hex | null => (bytes === null || bytes === undefined ? null : bytesSha256(bytes));
  const architectOnly = (what: string): void => void reasons.push(`${what} changes only through an architect \`apply\`, not a ${input.proposer.type}`);
  if (inputs.changed.corpus) {
    const pin = sha(c.pin.bytes);
    const guide = sha(c.guide.bytes);
    if (input.proposer.type !== 'apply') architectOnly('the corpus pin');
    else if (pin !== null && guide !== null) changes.push({ type: 'corpus', pinSha256: pin, guideSha256: guide });
  }
  if (inputs.changed.phase0) {
    const record = sha(c.phase0.bytes);
    if (input.proposer.type !== 'apply') architectOnly('the Phase-0 record');
    else if (record !== null) changes.push({ type: 'phase0', sha256: record });
    const before = new Set((input.revision.corpus?.phase0.value.debt ?? []).filter((d) => d.disposition.type === 'promote').map((d) => canonicalJson(d)));
    const promoted = (inputs.corpus.phase0?.debt ?? []).filter((d) => d.disposition.type === 'promote' && !before.has(canonicalJson(d)));
    if (input.view.holistic().draining !== null && promoted.length > 0) {
      reasons.push(`the arc is draining (close-admissions): a debt item may not be promoted now (${promoted.map((d) => d.id).join(', ')})`);
    }
  }
}

/** Whether every unit's spec file is its spec in force (by hash). */
function sameSpecs(input: ClassifyInput): boolean {
  return [...input.next.specs].every(([unit, file]) => {
    if (file.bytes === null) return false;
    const sha = bytesSha256(file.bytes);
    const u = input.view.unit(unit);
    return sha === (u.pendingRevision?.sha256 ?? u.spec?.sha256 ?? input.inForce.manifest.specs[unit]);
  });
}

// ---------------------------------------------------------------------------------------------------
// Command scopes (A12)

const ARC: CommandScope = { type: 'arc' };
const NONE: CommandScope = { type: 'none' };
const unitsScope = (units: Iterable<UnitId>): CommandScope => {
  const sorted = [...new Set(units)].sort();
  return sorted.length === 0 ? NONE : { type: 'units', units: sorted };
};

/** `scope` with `units` added (the arc holds every unit already). */
const unionScope = (scope: CommandScope, units: readonly UnitId[]): CommandScope =>
  (scope.type === 'arc' ? scope : unitsScope([...(scope.type === 'units' ? scope.units : []), ...units]));

/**
 * Whether a change drains the whole arc (A12): plan-wide routing or limits, a resource or pool, capacity and the other
 * plan-wide fields, the suite, and the holistic layer (obligations, mapping, vision, advances, the corpus pin). The flow
 * series (src/flow/series.ts) reads an applied command revision's drain from it.
 */
export function drainsArc(c: PlanChange): boolean {
  switch (c.type) {
    case 'routing':
    case 'limits':
      return c.unit === undefined || c.unit === null;
    case 'resource':
    case 'suite':
    case 'plan-field':
    case 'obligation':
    case 'mapping':
    case 'vision':
    case 'holistic':
    case 'advances':
    case 'corpus':
      return true;
    default:
      return false;
  }
}

/**
 * The scope of an accepted apply's changes: routing, resource and pool, capacity and the other plan-wide
 * fields, and suite edits → the arc; unit and spec edits, cuts and re-entries → those units (a re-entry's old
 * unit too); an order change → the units whose relative order moved.
 */
export function changesScope(changes: readonly PlanChange[], cur: PlanM1, next: PlanM1): CommandScope {
  if (changes.some(drainsArc)) return ARC;
  const units = new Set<UnitId>();
  for (const c of changes) {
    switch (c.type) {
      case 'routing':
      case 'limits':
        if (c.unit !== undefined && c.unit !== null) units.add(c.unit);
        break;
      // The arc-wide changes returned the arc above.
      case 'resource':
      case 'suite':
      case 'plan-field':
      case 'obligation':
      case 'mapping':
      case 'vision':
      case 'holistic':
      case 'advances':
      case 'corpus':
        break;
      // A Phase-0 record edit changes only the required-review key: nothing running is touched. M4a rev 3: a priority,
      // known-defect or (dev.16 and earlier) plan-check-shape edit drains nothing either (admission and rank read the plan in force).
      case 'phase0':
      case 'unit-priority':
      case 'known-defects':
      case 'plan-check-shape':
      case 'derived':
      // dev.13: a milestones edit drains nothing (the node gates readiness; a walk reads the plan in force when it starts).
      case 'milestones':
        break;
      case 'unit-added':
      case 'unit-removed':
      case 'unit-changed':
      case 'unit-cut':
      case 'spec':
        units.add(c.unit);
        break;
      case 'unit-reentered':
        units.add(c.unit).add(c.reenters);
        break;
      case 'order': {
        const nextIds = next.units.map((u) => u.id);
        const was = cur.units.map((u) => u.id).filter((id) => nextIds.includes(id));
        const now = nextIds.filter((id) => was.includes(id));
        was.forEach((id, i) => {
          if (now[i] !== id) units.add(id);
        });
        break;
      }
    }
  }
  return unitsScope(units);
}

// ---------------------------------------------------------------------------------------------------
// An apply's proposal (G15)

/** What an apply's proposal reads besides the owner's files: the log, the run dir and the revision in force. */
export type ProposalContext = Readonly<{ runDir: AbsPath; view: JournalView; inForce: InForce; revision: RevisionInForce }>;

/** An edit of an exported revision, composed with untouched files in force. */
export type ApplyProposal = Readonly<{ next: InputFiles }>;
export function applyProposal(ctx: ProposalContext, files: InputFiles, manifest: RevisionManifest | null, base: RevisionManifest): ApplyProposal | Readonly<{ reasons: readonly string[] }> {
  const actual = revisionManifestOf(files);
  if ('missing' in actual) return { reasons: actual.missing };
  if (manifest !== null && !same(actual, manifest)) return { reasons: [manifestMismatch(files, manifest, actual)] };
  const from = baseFiles(ctx.runDir, base, files.planFile, files.repo);
  if ('reasons' in from) return from;
  const current = inForceFiles(ctx.runDir, ctx.view, ctx.inForce, ctx.revision, files.planFile, files.repo);
  return compareAndSwap(from.files, files, current);
}

/** Which files no longer hash to what the command's manifest recorded. */
function manifestMismatch(files: InputFiles, expected: RevisionManifest, actual: RevisionManifest): string {
  const differ: string[] = [];
  if (expected.planSha256 !== actual.planSha256) differ.push(files.planFile);
  const units = new Set([...Object.keys(expected.specs), ...Object.keys(actual.specs)] as UnitId[]);
  for (const u of [...units].sort()) {
    if (expected.specs[u] !== actual.specs[u]) differ.push(files.specs.get(u)?.path ?? `the spec of ${u} (no longer in the plan)`);
  }
  if (!same(expected.rulings, actual.rulings)) differ.push(files.ledger.path);
  if (expected.obligations !== actual.obligations) differ.push(files.obligations?.path ?? 'the obligations file (no longer in the plan)');
  if (expected.vision !== actual.vision) differ.push(files.vision?.path ?? 'the vision file (no longer in the plan)');
  const c = files.corpus;
  if (expected.corpus !== actual.corpus) differ.push(c?.pin.path ?? 'the corpus pin (no longer in the plan)');
  if (expected.corpusGuide !== actual.corpusGuide) differ.push(c?.guide.path ?? 'the corpus guide (no longer in the plan)');
  if (expected.phase0 !== actual.phase0) differ.push(c?.phase0.path ?? 'the Phase-0 record (no longer in the plan)');
  return `the files changed since \`roadmap apply\` hashed them: ${differ.join(', ')}; run it again`;
}

// ---------------------------------------------------------------------------------------------------
// Command scopes, continued

/** What an apply's scope reads: its classification's inputs. */
export type ScopeContext = Readonly<{
  runDir: AbsPath;
  repo: AbsPath;
  hostDir: AbsPath;
  planFile: AbsPath;
  routingBase: RoutingBase;
}>;

/**
 * A12's `ScopeOf`, bound to what an apply's classification reads: `resume` (all) → the arc; `resume <u>` →
 * {u}; `resume --backend`, `sweep`, `resolve-edge`, `run-only` and (M4b) `flow-decide` and `flow-request` → none; `steer`, `merge-in` and
 * `note` → their unit; `apply` → its changes' scope
 * (`changesScope`) over its proposal (the files rebased onto the files in force, its `--ruling` records landed); none when it would be rejected (a ruling
 * record that no longer reads included) or change nothing (it then
 * touches nothing); the arc when the files no longer hash to its manifest (they may be restored before it
 * applies, so nothing narrower is safe).
 */
export function commandScope(sc: ScopeContext): ScopeOf {
  return (body, view) => {
    switch (body.type) {
      case 'resume':
        return body.target.type === 'all' ? ARC : body.target.type === 'unit' ? unitsScope([body.target.unit]) : NONE;
      case 'note':
      case 'sweep':
      case 'resolve-edge':
      case 'run-only':
      case 'audit':
      case 'close-admissions':
      case 'flow-decide':
      case 'flow-request':
      case 'demo':
        return NONE;
      // M3 (plan "Commands"): `reverse` restores revisions of any artifact; `steer` and `merge-in` touch their unit.
      case 'witness':
      case 'reverse':
        return ARC;
      case 'steer':
      case 'merge-in':
        return unitsScope([body.unit]);
      case 'apply': {
        const inForce = planInForce(sc.runDir, view);
        if (inForce === null) return NONE;
        let files: InputFiles;
        try {
          files = readInputFiles(body.planFile, sc.repo, true);
        } catch (error) {
          if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
          return NONE;
        }
        const revision = revisionInForce(sc.runDir, inForce);
        const proposal = applyProposal({ runDir: sc.runDir, view, inForce, revision }, files, body.manifest, body.base);
        if ('reasons' in proposal) return ARC;
        const verdict = classify({
          runDir: sc.runDir, view, inForce, revision, next: proposal.next, residues: undispositioned(sc.hostDir), routing: sc.routingBase,
          proposer: { type: 'apply', reason: body.reason },
        });
        if (verdict.kind === 'busy') return unionScope(changesScope(verdict.changes, inForce.plan, proposal.next.plan), verdict.busy.map((b) => b.unit));
        return verdict.kind === 'accepted' ? changesScope(verdict.changes, inForce.plan, proposal.next.plan) : NONE;
      }
    }
  };
}
