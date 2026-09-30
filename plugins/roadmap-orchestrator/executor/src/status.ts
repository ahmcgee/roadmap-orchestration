// `roadmap status`: DESIGN-1.0.md §2.4, as one agent-facing JSON object (M2's view plus M3's holistic keys).
//
// Read only, from anywhere, while an executor runs or when none does: the log is folded without the host
// lock (`readJournal`: no tail repair, no fact, no cache write), and the run dir's files are only read.
// Nothing here names a model except `spend.byModel`, which looks each seat's model up in its revision's
// routing table at render time: each plan revision's table is resolved from the routing provenance it recorded
// (H7; a 1.0.0-dev.5 revision's from the record its adoption persisted, `routing-provenance/<rev>.json`), for the
// arc and for each unit, never from the live repo config; a revision with no provenance (a dev.5 arc not yet
// adopted by a start of this release, or one adopted as unreconstructable) is listed as unresolved.
// `plan` is the plan in force (its revision and hash, src/input/inforce.ts), and `units` are its units, not
// the live plan.json: an edit nobody applied does not show. `routing` is the arc's routing in force (the plan in
// force under its revision's provenance), as classes per seat with the layer that named each and where each
// class's binding came from: no model. Admission reads each unit's own routing (its layer on top).
//
// What only the running scheduler knows (each unit's task, the arbiter's queue, the pending mutations'
// scopes) comes from its derived `sched.json` (src/schedule/scheduler.ts), read only while the executor that
// wrote it owns the run; everything else is derived from the log.
//
// A unit's `state`, the first that holds:
//   merged | cut | superseded   its status says so
//   parked                      park-pending (`park` says which park, what it waits on, when it is probed)
//   blocked                     stop-pending; an open blocking needs-user about it; or an `after` dependency is
//                               dead (parked, stopped or cut: D1, only the architect releases it)
//   held                        an interrupted stage (a pause, a parked backend); or admission waits on a pause
//   running | preparing         its task is in a stage or chain (`preparing`: a re-entry's `prepare`); with no
//                               sched.json, an attempt is open while the executor lives
//   waiting                     its task waits for its stage's entry reservation (`waitingFor.resources`), or it
//                               waits on `after` dependencies or contingent edges (a legacy arc: on its serial
//                               frontier)
//   awaiting-admission          its next stage is not admitted now (`waitingFor.admission`, `drainFor`)
//   ready                       it may start now (the scheduler starts it on its next tick)
//
// `run.state` (§2.10), the first that holds:
//   no live executor: refused (the latest start was refused), complete (every unit merged, cut, superseded or
//   parked for the architect, no own-arc residue left, and no blocking needs-user open), no-owner (work remains);
//   a live executor:
//     running   some unit runs, prepares, is ready, waits for resources, or waits only on a draining mutation
//     held      nothing moves, and some unit is held or waits on a pause
//     parked    nothing moves, and a blocking needs-user is open
//     blocked   nothing moves, and work remains (parks or own-arc residues being probed, run-only, an
//               unresolved edge, a dead dependency, a tripped breaker)
//     running   otherwise (every unit settled: the executor is about to end)
//
// `needsUser` lists every unacknowledged item: those the log raised, and the file-only ones outside it (the
// supervisor's `sup-<gen>-<n>`, a refused claim's `host-<kind>-<n>`), read from `needs-user/`; an item is
// acknowledged once the log holds its ack fact, as the executor reads it.
//
// M3 (§2.4 additions; the holistic keys are vacuous in an arc without the layer, a 1.0.0-dev.5 one included):
//   run.state     `draining` (a live executor that would run, with admissions closed); in a holistic arc `complete`
//                 only while its `arc-completed` is active (A20), and `completion.unmet` names what the completion
//                 predicate lacks now
//   target        the obligations' cut line, the next milestone (R13: the future obligation with the fewest
//                 unmerged `deliveredBy`), the critical path (the longest `after` chain of unsettled units), counts
//   nowTrue       each non-exempt obligation whose witness holds on the integration head's tree; `notYetTrue` the
//                 rest, with its verdict (or `not-covered`), the units it waits on and why (see `ObligationReason`)
//                 and the witness evidence dirs. The observation read is completion's (the scheduler's
//                 `dischargingObservation`): on the head's tree, the lane at its current rev, in the environment the
//                 executor recorded for it (`recordedLaneEnv`), so status never shows true what completion counts unmet
//   waived/deferred  exempt obligations with the ruling that exempted each
//   vision        the vision in force and its coverage both ways (A1 `visionCoverage`; citers: the sidecars in
//                 force and the divergences)
//   divergences   every divergence no acknowledged digest covers (H11), with what differed, the clauses cited,
//                 evidence, its bundle and its compensation hint (H13)
//   decisionsSince  what was decided since the architect last acknowledged a divergence digest (the whole arc
//                 before one): rulings, bundles, patches, re-entries, cuts, steers, divergences and reversals
//   convergence   K, the applied bundles counted against it since the counter last cleared, the open brake items
//   findings      the active findings and `findingMetrics` (B3)
//   audit         per lens in L: its watermark and the docs edges pending a gap (B5 `coverageOf`), the uncovered
//                 range, the generation, and the minutes of lanes run under checkpoint jobs
//   owed          the open `audit-owed` items
//   completion    the latest `arc-completed` (A20 `active`), whether it is sealed (A5b `sealingOf`), the unmet
//                 clauses of the completion predicate now (the scheduler's `completionBlockers`: one rule)
//   host.log      the event log's size and fold time: the deferred compaction's trigger (50 MB or 2 s)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { COMMANDS_DIR, incomingPath, pendingCommandIds, readCommand, terminalReceipt } from './commands/queue.ts';
import { type Sealing, sealingOf } from './commands/gc.ts';
import {
  type Event, JUDGMENT_STAGES, type JudgmentStage, type Holder, type OperatorParkKind, type PlanAppliedFact, type ProbeTarget, holderUnit, parentUnit,
  probeTargetKey,
} from './core/events.ts';
import { readJson } from './core/fsx.ts';
import {
  type ArcId, CPU_POOL, type CommandId, type DivergenceId, type EdgeId, type FindingId, type JobId, type NeedsUserId, type ObligationId, type PlanRev,
  type ResourceUnit, type RoutingRev, type RulingId, type Sha, type Sha256Hex, type UnitId, type VisionClauseId,
  commandId, compareResourceUnits, cpuToken, parseJobId, parseOpId,
} from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import { EVENTS_FILE, type LogSnapshot, readJournal } from './core/log.ts';
import type { HolisticFold, Lineage, ResourceEntry, UnitState } from './core/state.ts';
import { legacyNext, legacySettled, revisionSourceOf, routingProvenanceOf, warnPlanFromFile } from './core/upgrade.ts';
import {
  type InForce, PLAN_INPUT, RULING_INPUT, type RevisionInForce, keptInput, keptPayload, planInForce, revisionInForce,
  routingProvenanceOf as rebuiltProvenance,
} from './input/inforce.ts';
import {
  type CommandBody, type ContainmentMode, type NeedsUserReason, type Receipt, type RunStart, type Stage, heartbeat, runStart,
} from './core/records.ts';
import { type AbsPath, type IsoTime, absPath, branchRef, isoTimeOf } from './core/values.ts';
import { HEARTBEAT_FILE, REJECTION_FILE, START_FILE } from './executor.ts';
import { type BlockingItem, blockingItems, fileNeedsUser, holdsUnit, recordOf } from './needsuser.ts';
import { type PlanM1, type PlanUnit, lensSetOf, parsePlan } from './input/plan.ts';
import { type JobTotal, type ModelTotal, type RoleTotal, type SmokeTotal, byModel, meterOf } from './meter.ts';
import { escalateAt, probeTargets, trippedTargets } from './park/schedule.ts';
import { readRepoConfig } from './preflight/checks.ts';
import { type RejectionFile, rejectionFile } from './preflight/startup.ts';
import { judgmentSeat } from './pipeline/transitions.ts';
import { cpuCapacity, isDirty, poolUnits } from './resources/pool.ts';
import { effectiveDependency } from './schedule/graph.ts';
import { type SpecFactsOf, admitter, nextStage, rankOf } from './schedule/ready.ts';
import { specFacts } from './pipeline/reproduce.ts';
import { observations } from './pipeline/lanes.ts';
import { type CompletionBlocker, type QueueEntry, SCHED_FILE, type SchedFile, arcSettled, completionBlockers, dischargingObservation, readOnlyContexts, recordedLaneEnv, schedFile, unitSettled } from './schedule/scheduler.ts';
import type { AdmissionConstraint, Rank, ResourceRequest } from './schedule/types.ts';
import { type ResolvedRouting, type SeatSources, planStack, provenanceStack, resolveRouting } from './routing/layers.ts';
import {
  type Backend, type ClassSource, type ClassTable, type ModelClass, type ProfileName, type RiskTier, type RoutingProvenance, type SeatRef,
  type RoutingTable,
} from './routing/types.ts';
import { readClaim } from './host/lock.ts';
import { isAlive } from './host/liveness.ts';
import { readOwner } from './host/owner.ts';
import { revParse } from './git/git.ts';
import { readLegacyProvenance, legacyProvenancePath, witnessDir } from './git/snapshot.ts';
import { coverageBase, coverageOf } from './holistic/coverage.ts';
import { type AppliedBundle, brakesOf } from './holistic/convergence.ts';
import { uncoveredDivergences } from './holistic/divergence.ts';
import { type FindingMetric, findingMetrics, isActive } from './holistic/findings.ts';
import { type Observation, verdictOf } from './holistic/observe.ts';
import {
  type ClauseState, type Compensation, type DivergenceKind, type FindingLens, type FindingSeverity, type FindingStateName, type LensKind,
  type ArcLaneDef, type ObligationDef, type Obligations, type ObservationVerdict, type Vision, type VisionClauseKind, type VisionCoverage, isExempt,
  observationKeyText, parseRulingSidecar,
} from './holistic/types.ts';
import { visionCoverage } from './holistic/vision.ts';

export type OwnerState = Readonly<{ state: 'alive' | 'dead' | 'none'; generation: number | null; pid: number | null }>;

/**
 * The host claim's owner liveness: this run's claim (host.lock names this run dir) with host.owner.json naming
 * a live executor on the claim's boot is `alive`; a claim for this run whose executor is gone (or never
 * spawned) is `dead`; no claim for this run is `none`.
 */
export function ownerState(runDir: AbsPath, hostDir: AbsPath): OwnerState {
  const claim = readClaim(hostDir);
  if (claim === null || claim.runDir !== runDir) return { state: 'none', generation: null, pid: null };
  const owner = readOwner(hostDir);
  const executor = owner !== null && owner.nonce === claim.nonce ? owner.executor : null;
  if (executor === null) return { state: 'dead', generation: claim.generation, pid: null };
  return { state: isAlive(executor, claim.bootId) ? 'alive' : 'dead', generation: claim.generation, pid: executor.pid };
}

export type ArcState = 'running' | 'draining' | 'held' | 'parked' | 'blocked' | 'complete' | 'refused' | 'no-owner';

/** A unit's place in the schedule (see the header). */
export type UnitRunState =
  | 'running' | 'awaiting-admission' | 'waiting' | 'ready' | 'blocked' | 'held' | 'parked' | 'preparing' | 'merged' | 'cut' | 'superseded';

/**
 * Session containment's narrowed guarantee (plan "Runtime components"), stated as the plan states it. cgroup
 * mode is not selectable in M1 builds.
 */
export const SESSION_GUARANTEE = 'Every process that keeps ROADMAP_INV in its exec-time environment, or stays in the workload session, is '
  + 'stopped and killed before output is certified, resources are released or a stage advances. Not guaranteed: a descendant '
  + 'that calls setsid() and execs with a cleared environment; it may keep writing the original unit worktree, touch external '
  + 'resources, or write after every check. Partial backstops: the verification-tree dirty assertion and the occupancy probe. '
  + 'Original-worktree writes, external undeclared residue and delayed writes are not caught.';

/**
 * What an unstarted or waiting unit waits on; null for a unit that waits on nothing. `deps`: its `after`
 * dependencies not merged yet (each followed to its lineage head, F15; a legacy arc's serial frontier);
 * `edges`: its unresolved contingent edges; `resources`: the entry reservation its task waits for (from the
 * arbiter's queue), and `envBlocked` when a residue keeps it from healthy capacity (F8); `admission`: what
 * keeps its next stage from being admitted (A17), `drainFor` the pending mutations among them (A12).
 */
export type WaitingFor = Readonly<{
  deps: readonly UnitId[];
  edges: readonly EdgeId[];
  resources: ResourceRequest | null;
  envBlocked: boolean;
  admission: readonly AdmissionConstraint[];
  drainFor: readonly CommandId[];
}>;

/**
 * A park-pending unit's park: `class` and, for an operator park, its `kind`; for a retryable park, its
 * `targets`, those still `outstanding`, the earliest `nextProbeAt` among them (null: due now, no failed probe
 * backs it off) and `escalateAt` (6 h after the park, D2). A 1.0.0-dev.4 park reads as operator.
 */
export type UnitPark = Readonly<{
  class: 'retryable' | 'operator';
  kind?: OperatorParkKind;
  targets: readonly ProbeTarget[];
  outstanding: readonly ProbeTarget[];
  nextProbeAt: IsoTime | null;
  escalateAt: IsoTime | null;
}>;

/**
 * A running unit's stage attempt: `elapsed` ms since its first journaled op (null before one: between ops), the
 * earliest deadline of its open ops, and the resource units the unit holds.
 */
export type UnitRunning = Readonly<{ stage: Stage; attempt: number; elapsed: number | null; deadline: IsoTime | null; resources: readonly ResourceUnit[] }>;

export type UnitStatusLine = Readonly<{
  unit: UnitId;
  stage: Stage;
  /** The fold's `UnitStatus`, or `held-after:<ids>` for an active unit its `after` units still hold. */
  status: string;
  attempts: number;
  chargeableFailures: number;
  risk: RiskTier | null;
  /** The seat the unit's current stage dispatches on, when that stage calls a backend and the unit is dispatched. */
  seat: SeatRef | null;
  state: UnitRunState;
  waitingFor: WaitingFor | null;
  /** Every resource unit a holder of this unit holds or is transitioning (its stages, publication, retry), ascending. */
  holds: readonly ResourceUnit[];
  /** The unit's rank now (F17), while it is active; null otherwise. */
  priority: Readonly<Pick<Rank, 'origin' | 'waitStartSeq' | 'bypassMerges' | 'promoted'>> | null;
  park: UnitPark | null;
  /** Set on a unit that re-enters another. */
  lineage: Lineage | null;
  /** The unit that re-entered this one, once it is superseded. */
  supersededBy: UnitId | null;
  /** The implementer's seat tier (A11), a tier, never a model; null before the first dispatch. */
  buildTier: RiskTier | null;
  running: UnitRunning | null;
}>;

/** The routing in force for the latest start, as classes: never a model. */
export type RoutingView = Readonly<{
  profile: ProfileName;
  rev: RoutingRev;
  seats: ClassTable;
  sources: SeatSources;
  bindings: { readonly [C in ModelClass]: ClassSource };
}>;

/** One edge of the plan in force: an `after` (its dependency and where it points now) or a contingent edge. */
export type EdgeView =
  | Readonly<{ type: 'after'; unit: UnitId; on: UnitId; effective: UnitId; met: boolean }>
  | Readonly<{ type: 'contingent'; unit: UnitId; edge: EdgeId; condition: string; resolved: boolean }>;

/**
 * A probe target with current parks or an own-arc residue: the seqs a probe now covers (`parks`: park seqs, and a
 * residue's fail seq), its backoff, last result and breaker.
 */
export type ProbeView = Readonly<{ target: ProbeTarget; parks: readonly number[]; nextProbeAt: IsoTime | null; lastResult: 'pass' | 'fail' | null; tripped: boolean }>;

export type HostView = Readonly<{
  containment: Readonly<{ mode: ContainmentMode | null; guarantee: string }>;
  /** Every resource unit that is not free, or has a transition open, ascending. */
  resources: readonly Readonly<{ resource: ResourceUnit; state: string; holder: Holder | null; pending: boolean }>[];
  /** `@cpu` and each declared pool: instances, those in use (held or transitioning) and those dirty (a residue). */
  pools: Readonly<Record<string, Readonly<{ size: number; used: number; dirty: number }>>>;
  /** The arbiter's waiters, served first to last (sched.json; empty without a live executor). */
  queue: readonly QueueEntry[];
  probes: readonly ProbeView[];
  /** Backends parked now, with their park epoch and class (F12). */
  backends: readonly Readonly<{ backend: Backend; parkSeq: number; class: string }>[];
}>;

// ---------------------------------------------------------------------------------------------------
// M3: the holistic keys (§2.4)

/**
 * Why an obligation is not yet true, from the units it waits on (the first that holds): `supervision` (a unit held,
 * paused, blocked on a needs-user or parked for the architect), `host` (a unit parked retryable, env-blocked, or held
 * by a parked backend or a tripped breaker), `waiting-dep` (a unit waiting on or blocked by its dependencies or
 * contingent edges), `code` (a unit runs, is ready or waits for admission); `spec` when no unit of the plan delivers
 * or repairs it.
 */
export const OBLIGATION_REASONS = ['supervision', 'host', 'waiting-dep', 'code', 'spec'] as const;
export type ObligationReason = (typeof OBLIGATION_REASONS)[number];

/** An obligation on the integration head: its witness verdict there (`not-covered`: no observation), and the evidence dirs of the records read. */
export type ObligationTruth = Readonly<{
  obligation: ObligationId;
  statement: string;
  /** The effective activation: a latched future obligation is must-hold. */
  activation: 'future' | 'must-hold';
  /** A split parent's is its children's (held when every non-exempt child holds). */
  verdict: ObservationVerdict | 'not-covered';
  evidence: readonly AbsPath[];
}>;
export type ObligationPending = ObligationTruth & Readonly<{ blockingUnits: readonly UnitId[]; reason: ObligationReason }>;

export type TargetView = Readonly<{
  cutLine: string;
  /** R13: the future obligation with the fewest unmerged `deliveredBy` (ties: the lowest id); null when none is pending. */
  nextMilestone: Readonly<{ obligation: ObligationId; statement: string; unmerged: readonly UnitId[] }> | null;
  /** The longest chain of unsettled units along their effective `after` edges, first to last (ties: plan order). */
  criticalPath: readonly UnitId[];
  obligations: Readonly<{
    total: number; nowTrue: number; notYetTrue: number; latched: number; split: number; waived: number; deferred: number; retired: number;
  }>;
}>;

export type VisionView = Readonly<{
  rev: number;
  confirmation: Vision['confirmation'];
  clauses: readonly Readonly<{ id: VisionClauseId; kind: VisionClauseKind; text: string; rank: number | null; state: ClauseState }>[];
  coverage: VisionCoverage;
}>;

/** A divergence no acknowledged digest covers (H11): `digest` the open digest item that binds it, if any. */
export type DivergenceView = Readonly<{
  id: DivergenceId;
  type: DivergenceKind;
  from: string;
  what: string;
  cites: readonly VisionClauseId[];
  evidence: readonly string[];
  bundle: JobId;
  compensation: Compensation;
  digest: NeedsUserId | null;
}>;

export const DECISION_KINDS = ['ruling', 'bundle', 'patch', 'reenter', 'cut', 'steer', 'divergence', 'reverse'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
/** Who decided: the architect (a command, or a start's edited files: null), a checkpoint job, plan-check's redirect, or the executor. */
export type RuledBy =
  | Readonly<{ type: 'architect'; command: CommandId | null }>
  | Readonly<{ type: 'checkpoint'; job: JobId }>
  | Readonly<{ type: 'judgment'; role: 'planCheck' }>
  | Readonly<{ type: 'executor' }>;
/** One decision: its log seq, what it is, the id it names (C-n, ckpt-n, a unit, D-n), one line, and who ruled. */
export type Decision = Readonly<{ seq: number; kind: DecisionKind; id: string; oneLine: string; ruledBy: RuledBy }>;

export type ConvergenceView = Readonly<{
  k: number;
  /** Bundles applied since the counter last cleared (a publication, a latch, or an acknowledged `convergence-bound`). */
  counter: number;
  /** The seq the counter counts from. */
  since: number;
  /** Open `convergence-bound` and `convergence-identity` items. */
  open: readonly NeedsUserId[];
}>;

export type FindingLine = Readonly<{
  id: FindingId; lens: FindingLens; severity: FindingSeverity; state: FindingStateName; owner: UnitId | null; obligation: ObligationId | null; claim: string;
}>;

export type AuditView = Readonly<{
  /** The required lens set L. */
  lenses: readonly LensKind[];
  coverage: readonly Readonly<{ lens: LensKind; coveredTo: Sha; outstanding: boolean; pendingDocs: readonly Readonly<{ pub: JobId; from: Sha; to: Sha }>[] }>[];
  /** Each lens's range not covered yet: from its watermark to the integration head. */
  uncovered: readonly Readonly<{ lens: LensKind; from: Sha; to: Sha }>[];
  /** The highest generation any audit or checkpoint recorded (0 before one). */
  generation: number;
  running: JobId | null;
  /** Wall-clock minutes of the journey lanes checkpoint jobs ran (a running one's up to now). */
  checkpointLaneMinutes: number;
}>;

export type CompletionView = Readonly<{
  /** The latest `arc-completed`'s plan rev and head; null before one. */
  planRev: PlanRev | null;
  head: Sha | null;
  active: boolean;
  sealed: boolean;
  /** Why it is not sealed (A5b `sealingOf`); null when sealed. */
  notSealed: string | null;
  /** The completion predicate's clauses that fail now (src/schedule/scheduler.ts `completionBlockers`, the one rule). */
  unmet: readonly CompletionBlocker[];
}>;

/** The event log's growth (the deferred compaction's trigger): its bytes, its events and how long this fold took. */
export type LogView = Readonly<{ bytes: number; events: number; foldMs: number; compactionDue: boolean }>;
/** The deferred event-log compaction triggers (plan "Growth controls"). */
export const LOG_COMPACTION_BYTES = 50 * 1024 * 1024;
export const LOG_COMPACTION_FOLD_MS = 2_000;

export type Status = Readonly<{
  arc: ArcId;
  run: Readonly<{ state: ArcState; owner: OwnerState; heartbeatAt: IsoTime | null }>;
  units: readonly UnitStatusLine[];
  edges: readonly EdgeView[];
  /** The `run-only` allowlist in force, or null when admission is unlimited. */
  runOnly: readonly UnitId[] | null;
  /** An arc started before M2: its serial frontier and its resources' dev.4 meaning (src/core/upgrade.ts). */
  legacy: boolean;
  /** Raised and not acknowledged, ascending id: the log's items and the file-only `sup-*` / `host-*` ones. */
  needsUser: readonly Readonly<{ id: NeedsUserId; reason: NeedsUserReason; blocking: boolean }>[];
  commands: Readonly<{
    /** Submitted, no terminal receipt yet, in submission order. */
    pending: readonly Readonly<{ id: CommandId; type: CommandBody['type'] }>[];
    /** The latest terminal receipts, oldest first. */
    receipts: readonly Receipt[];
  }>;
  spend: Readonly<{
    byRole: readonly RoleTotal[];
    byModel: Readonly<{ models: readonly ModelTotal[]; unresolvedRevs: readonly RoutingRev[] }>;
    /** M3: each job's lens and checkpoint calls (also in `byRole` and `byModel`). */
    byJob: readonly JobTotal[];
    /** Start-up smokes per backend: in neither `byRole` nor `byModel`. */
    bySmoke: readonly SmokeTotal[];
  }>;
  host: HostView & Readonly<{ log: LogView }>;
  parkedBackends: readonly Backend[];
  /** The plan in force: its revision and plan.json hash; null before a start recorded one. */
  plan: Readonly<{ rev: PlanRev; planSha256: Sha256Hex }> | null;
  /** Null before any start. */
  routing: RoutingView | null;
  rejection: RejectionFile | null;
  /** M3: the holistic layer is on (the plan in force names a vision). Every key below is vacuous when it is off. */
  holistic: boolean;
  /** Null without obligations in force. */
  target: TargetView | null;
  nowTrue: readonly ObligationTruth[];
  notYetTrue: readonly ObligationPending[];
  waived: readonly Readonly<{ obligation: ObligationId; ruling: RulingId }>[];
  deferred: readonly Readonly<{ obligation: ObligationId; ruling: RulingId }>[];
  vision: VisionView | null;
  divergences: readonly DivergenceView[];
  decisionsSince: readonly Decision[];
  convergence: ConvergenceView | null;
  findings: Readonly<{ active: readonly FindingLine[]; metrics: readonly FindingMetric[] }>;
  audit: AuditView | null;
  owed: Readonly<{ audits: readonly NeedsUserId[] }>;
  completion: CompletionView;
}>;

/** How many terminal receipts `status` shows. */
export const RECEIPTS_SHOWN = 10;

const readIf = <T>(path: string, read: (value: unknown, path: string) => T): T | null => (existsSync(path) ? read(readJson(path), path) : null);

function seatOf(view: JournalView, unit: UnitId): UnitStatusLine['seat'] {
  const u = view.unit(unit);
  if (u.risk === null) return null;
  if ((JUDGMENT_STAGES as readonly string[]).includes(u.stage)) {
    const stage = u.stage as JudgmentStage;
    return { role: stage === 'plan-check' ? 'planCheck' : 'gate', tier: judgmentSeat(u, stage) };
  }
  return u.stage === 'build' ? { role: 'build', tier: u.risk } : null;
}

/** The terminal receipts' dir (src/commands/queue.ts writes `<id>.<applied|rejected>.json` there). */
const TERMINAL_RECEIPT = /^(cmd-[0-9a-f]{16})\.(?:applied|rejected)\.json$/;

function commandsOf(runDir: AbsPath, arc: ArcId): Status['commands'] {
  const pending = pendingCommandIds(runDir).map((id) => ({ id, type: readCommand(runDir, id, arc).file.body.type }));
  const dir = join(runDir, COMMANDS_DIR, 'receipts');
  const done = existsSync(dir) ? readdirSync(dir).flatMap((n) => {
    const m = TERMINAL_RECEIPT.exec(n);
    return m === null ? [] : [commandId(m[1])];
  }).sort() : [];
  const receipts = done.map((id) => {
    const r = terminalReceipt(runDir, id);
    if (r === null) throw new Error(`command ${id}'s terminal receipt vanished while status read it; receipts are write-once`);
    return r;
  });
  return { pending, receipts: receipts.slice(-RECEIPTS_SHOWN) };
}

/**
 * A plan revision's routing provenance as recorded: its own (M3), or a 1.0.0-dev.5 revision's as its adoption persisted
 * it (H7); null when none was persisted (no start of this release adopted the arc yet) or it is unreconstructable.
 */
function recordedProvenance(runDir: AbsPath, f: PlanAppliedFact): RoutingProvenance | null {
  if (f.routingProvenance !== undefined) return f.routingProvenance;
  if (!existsSync(legacyProvenancePath(runDir, f.rev))) return null;
  const adopted = readLegacyProvenance(runDir, f.rev);
  return adopted.kind === 'reconstructed' ? adopted.provenance : null;
}

/** The kept plan of a revision. */
function keptPlan(runDir: AbsPath, f: PlanAppliedFact): PlanM1 {
  const bytes = keptInput(runDir, f.planSha256, PLAN_INPUT);
  if (bytes === null) throw new Error(`plan revision ${f.rev} is ${f.planSha256}, which the run dir does not keep`);
  return parsePlan(JSON.parse(bytes.toString('utf8')));
}

/**
 * The routing table of every routing revision the log's plan revisions resolve to (the arc's and each unit layer's), from
 * their recorded provenance only: what `spend.byModel` renders historical usage with (never the live repo config).
 */
function routingTables(runDir: AbsPath, events: readonly Event[]): ReadonlyMap<RoutingRev, RoutingTable> {
  const out = new Map<RoutingRev, RoutingTable>();
  for (const e of events) {
    if (e.type !== 'fact' || e.fact.kind !== 'plan-applied') continue;
    const provenance = recordedProvenance(runDir, e.fact);
    if (provenance === null) continue;
    const holistic = keptPlan(runDir, e.fact).holistic !== undefined;
    for (const unit of [null, ...(Object.keys(provenance.unitLayers) as UnitId[])]) {
      const r = resolveRouting(provenanceStack(provenance, holistic, unit));
      out.set(r.rev, r.table);
    }
  }
  return out;
}

/**
 * The routing provenance of the plan in force: as recorded, else (a 1.0.0-dev.5 revision no start of this release has
 * adopted) rebuilt from the plan, start.json's profile and the repo config, warned (src/core/upgrade.ts, scaffolding).
 */
function provenanceInForce(runDir: AbsPath, inForce: InForce, record: RunStart): RoutingProvenance {
  return recordedProvenance(runDir, inForce.fact)
    ?? routingProvenanceOf(inForce.fact, () => rebuiltProvenance({ profile: record.profile, config: readRepoConfig(record.repo) }, inForce.plan));
}

function routingView(profile: ProfileName, r: ResolvedRouting): RoutingView {
  return { profile, rev: r.rev, seats: r.classes, sources: r.sources, bindings: r.bindings };
}

/** An arc with no plan in force (started before plan revisions): its plan file, as that release read it. */
function planFile(arc: ArcId, path: AbsPath): PlanM1 {
  warnPlanFromFile(arc, path);
  return parsePlan(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------------------------------------------
// The parallel view

/** The holder a resource unit is held by or transitioning under, or null when it is free with nothing open. */
function holderOf(e: ResourceEntry): Holder | null {
  if (e.status.state !== 'free') return e.status.holder;
  return e.pending?.expect.holder ?? null;
}


function hostResources(view: JournalView): HostView['resources'] {
  return [...view.resources()].filter(([, e]) => e.status.state !== 'free' || e.pending !== null)
    .sort(([a], [b]) => compareResourceUnits(a, b))
    .map(([resource, e]) => ({ resource, state: e.status.state, holder: holderOf(e), pending: e.pending !== null }));
}

function pools(view: JournalView, plan: PlanM1): HostView['pools'] {
  const table = view.resources();
  const count = (units: readonly ResourceUnit[]): Readonly<{ size: number; used: number; dirty: number }> => {
    const entries = units.flatMap((u) => {
      const e = table.get(u);
      return e === undefined ? [] : [e];
    });
    return { size: units.length, used: entries.filter((e) => holderOf(e) !== null).length, dirty: entries.filter(isDirty).length };
  };
  const out: Record<string, Readonly<{ size: number; used: number; dirty: number }>> = {
    [CPU_POOL]: count(Array.from({ length: cpuCapacity(plan) }, (_, i) => cpuToken(i + 1))),
  };
  for (const d of plan.resources) if (d.pool !== undefined) out[d.name] = count(poolUnits(plan, d.name));
  return out;
}

function probesOf(view: JournalView): readonly ProbeView[] {
  const tripped = new Set(trippedTargets(view).map(probeTargetKey));
  return probeTargets(view).map((job) => {
    const key = probeTargetKey(job.target);
    const last = view.probes().find((p) => probeTargetKey(p.target) === key) ?? null;
    const backedOff = last !== null && last.result === 'fail' && job.covers.every((seq) => last.covers.includes(seq));
    return { target: job.target, parks: job.covers, nextProbeAt: backedOff ? last.nextProbeAt : null, lastResult: last?.result ?? null, tripped: tripped.has(key) };
  });
}

function parkOf(view: JournalView, u: UnitState): UnitPark | null {
  if (u.status !== 'park-pending' || u.park === null) return null;
  const { park } = u.park;
  if (park.class === 'operator') return { class: 'operator', kind: park.kind, targets: [], outstanding: [], nextProbeAt: null, escalateAt: null };
  const passed = new Set(u.park.passed.map(probeTargetKey));
  const outstanding = park.targets.filter((t) => !passed.has(probeTargetKey(t)));
  // Each outstanding target is next probed at its last failed probe's backoff if that covered this park, else at once.
  const times = outstanding.map((t) => {
    const last = view.probes().find((p) => probeTargetKey(p.target) === probeTargetKey(t)) ?? null;
    return last !== null && last.result === 'fail' && last.covers.includes(u.park!.seq) ? last.nextProbeAt : null;
  });
  const nextProbeAt = times.length === 0 || times.includes(null) ? null : (times as IsoTime[]).sort()[0]!;
  return { class: 'retryable', targets: park.targets, outstanding, nextProbeAt, escalateAt: isoTimeOf(escalateAt(u.park)) };
}

/** When each stage attempt journaled its first op, by `<unit>/<stage>#<attempt>`. */
function attemptStarts(events: readonly Event[]): ReadonlyMap<string, IsoTime> {
  const out = new Map<string, IsoTime>();
  for (const e of events) {
    if (e.type !== 'intent' || e.parent.type !== 'stage') continue;
    const key = `${e.parent.unit}/${e.parent.stage}#${e.parent.attempt}`;
    if (!out.has(key)) out.set(key, e.at);
  }
  return out;
}

function runningOf(view: JournalView, u: UnitState, starts: ReadonlyMap<string, IsoTime>, holds: readonly ResourceUnit[], now: number): UnitRunning {
  const { stage, attempt } = u.open ?? { stage: u.stage, attempt: u.counters.attempts };
  const started = starts.get(`${u.unit}/${stage}#${attempt}`);
  const deadlines = view.openIntents().flatMap((i) => (i.parent.type === 'stage' && i.parent.unit === u.unit && i.parent.stage === stage
    && i.parent.attempt === attempt && i.deadlineAt !== null ? [i.deadlineAt] : [])).sort();
  return { stage, attempt, elapsed: started === undefined ? null : now - Date.parse(started), deadline: deadlines[0] ?? null, resources: holds };
}

/** What the per-unit derivation reads besides the log: the scheduler's view (null without a live executor). */
type Inputs = Readonly<{
  view: JournalView;
  plan: PlanM1;
  sched: SchedFile | null;
  alive: boolean;
  blocking: readonly BlockingItem[];
  /** Each unit's routing in force (its layer over the arc's), for admission's backend constraints; null before any start. */
  routing: ((unit: UnitId) => RoutingTable) | null;
  legacy: boolean;
  /** What admission and the next stage read from each unit's spec in force (M3 B3). */
  spec: SpecFactsOf;
}>;

const NO_WAIT: Omit<WaitingFor, 'deps' | 'edges' | 'admission'> = { resources: null, envBlocked: false, drainFor: [] };
const waitFor = (w: Partial<WaitingFor>): WaitingFor => ({ deps: [], edges: [], admission: [], ...NO_WAIT, ...w });

/** A dependency that only the architect can release: parked, stopped or cut (D1). */
const dead = (view: JournalView, id: UnitId): boolean => ['park-pending', 'stop-pending', 'cut'].includes(view.unit(id).status);

/** The state of an active unit without a running task, and what it waits on. */
function idleState(x: Inputs, unit: PlanUnit, u: UnitState): Readonly<{ state: UnitRunState; waitingFor: WaitingFor | null }> {
  const { view, plan } = x;
  const item = x.blocking.find((b) => holdsUnit(b, unit.id));
  if (item !== undefined) return { state: 'blocked', waitingFor: waitFor({ admission: [{ type: 'blocking-item', id: item.id, reason: item.reason }] }) };
  if (x.legacy) {
    const f = legacyNext(view, plan.units);
    if (f !== null && f.unit !== unit.id) return { state: 'waiting', waitingFor: waitFor({ deps: [f.unit] }) };
    // The frontier blocked other than by a pause (which admission reports): its `after` units not settled by dev.4's rule.
    const deps = unit.after.filter((d) => !legacySettled(view, d));
    if (deps.length > 0) return { state: 'waiting', waitingFor: waitFor({ deps }) };
  } else {
    const deps = unit.after.map((d) => effectiveDependency(view, d)).filter((d) => view.unit(d).status !== 'retired');
    const edges = unit.contingent.filter((e) => view.edgeResolved(e.id) === null).map((e) => e.id);
    if (deps.some((d) => dead(view, d))) return { state: 'blocked', waitingFor: waitFor({ deps, edges }) };
    if (deps.length > 0 || edges.length > 0) return { state: 'waiting', waitingFor: waitFor({ deps, edges }) };
  }
  const next = nextStage(u, x.spec(unit).reproduces);
  const routing = x.routing;
  if (next?.kind === 'admission' && routing !== null) {
    const a = admitter(routing, x.spec)({
      view, plan, unit, stage: next.stage, blocking: x.blocking, drains: x.sched?.drains ?? [], tripped: trippedTargets(view),
    });
    if (a.kind === 'wait') {
      const state = a.constraints.some((c) => c.type === 'paused') ? 'held' : 'awaiting-admission';
      const drainFor = a.constraints.flatMap((c) => (c.type === 'drain' ? [c.command] : []));
      return { state, waitingFor: waitFor({ admission: a.constraints, drainFor }) };
    }
  }
  // Admitted, or a chain or retire next: a live executor starts (or admits) it on its next tick.
  return { state: 'ready', waitingFor: null };
}

function unitLine(x: Inputs, unit: PlanUnit, starts: ReadonlyMap<string, IsoTime>, now: number): UnitStatusLine {
  const { view, plan } = x;
  const u = view.unit(unit.id);
  const holds = [...view.resources()].filter(([, e]) => {
    const h = holderOf(e);
    return h !== null && holderUnit(h) === unit.id;
  }).map(([r]) => r).sort(compareResourceUnits);
  const task = x.sched?.tasks.find((t) => t.unit === unit.id) ?? null;
  const queued = x.sched?.queue.find((q) => q.unit === unit.id) ?? null;

  let state: UnitRunState;
  let waitingFor: WaitingFor | null = null;
  switch (u.status) {
    case 'retired':
      state = 'merged';
      break;
    case 'cut':
    case 'superseded':
      state = u.status;
      break;
    case 'park-pending':
      state = 'parked';
      break;
    case 'stop-pending':
      state = 'blocked';
      break;
    case 'held':
      state = 'held';
      break;
    case 'active': {
      const inTask = task !== null && (task.state === 'in-stage' || task.state === 'in-chain');
      if (queued !== null) {
        state = 'waiting';
        waitingFor = waitFor({ resources: queued.request, envBlocked: queued.envBlocked });
      } else if (inTask || (x.sched === null && x.alive && u.open !== null)) {
        state = u.lineage !== null && !u.lineage.prepared ? 'preparing' : 'running';
      } else {
        ({ state, waitingFor } = idleState(x, unit, u));
      }
      break;
    }
  }
  const rank = u.status === 'active' ? rankOf(view, plan, unit.id) : null;
  const after = u.status === 'active' ? unit.after.filter((d) => view.unit(effectiveDependency(view, d)).status !== 'retired') : [];
  return {
    unit: unit.id, stage: u.stage, status: after.length > 0 ? `held-after:${after.join(',')}` : u.status, attempts: u.counters.attempts,
    chargeableFailures: u.counters.chargeableFailures, risk: u.risk, seat: seatOf(view, unit.id),
    state,
    waitingFor,
    holds,
    priority: rank === null ? null : { origin: rank.origin, waitStartSeq: rank.waitStartSeq, bypassMerges: rank.bypassMerges, promoted: rank.promoted },
    park: parkOf(view, u),
    lineage: u.lineage,
    supersededBy: u.supersededBy,
    buildTier: u.buildTier,
    running: state === 'running' || state === 'preparing' ? runningOf(view, u, starts, holds, now) : null,
  };
}

function edgesOf(view: JournalView, plan: PlanM1): readonly EdgeView[] {
  return plan.units.flatMap((u) => [
    ...u.after.map((on): EdgeView => {
      const effective = effectiveDependency(view, on);
      return { type: 'after', unit: u.id, on, effective, met: view.unit(effective).status === 'retired' };
    }),
    ...u.contingent.map((e): EdgeView => ({ type: 'contingent', unit: u.id, edge: e.id, condition: e.condition, resolved: view.edgeResolved(e.id) !== null })),
  ]);
}

/** A unit that moves the run along: it runs, prepares, may start, waits for resources, or waits only on a drain. */
function moving(l: UnitStatusLine): boolean {
  if (l.state === 'running' || l.state === 'preparing' || l.state === 'ready') return true;
  if (l.state === 'waiting') return l.waitingFor?.resources !== null;
  return l.state === 'awaiting-admission' && (l.waitingFor?.admission ?? []).every((c) => c.type === 'drain');
}

function runStateOf(view: JournalView, lines: readonly UnitStatusLine[], owner: OwnerState, blocking: readonly BlockingItem[], rejection: RejectionFile | null): ArcState {
  const h = view.holistic();
  if (owner.state === 'alive') {
    // §2.10: admissions closed (`close-admissions`) and nothing held, parked or blocked: the arc drains.
    const running: ArcState = h.draining === null ? 'running' : 'draining';
    if (lines.some(moving)) return running;
    if (lines.some((l) => l.state === 'held')) return 'held';
    if (blocking.length > 0) return 'parked';
    if (lines.some((l) => !unitSettled(view, l.unit)) || view.residues().length > 0) return 'blocked';
    return running;
  }
  if (rejection !== null) return 'refused';
  // A holistic arc is complete only through its `arc-completed` (§2.10: obligations, coverage and quiescence too), while active (A20).
  if (h.on) return h.completion?.active === true && blocking.length === 0 ? 'complete' : 'no-owner';
  const settled = lines.length > 0 && arcSettled(view, lines.map((l) => ({ id: l.unit })));
  return settled && blocking.length === 0 ? 'complete' : 'no-owner';
}

/** sched.json, while the executor that wrote it owns the run; null otherwise (it is stale or absent). */
function liveSched(runDir: AbsPath, arc: ArcId, owner: OwnerState): SchedFile | null {
  if (owner.state !== 'alive') return null;
  const sched = readIf(join(runDir, SCHED_FILE), schedFile);
  if (sched === null || sched.pid !== owner.pid) return null;
  if (sched.arc !== arc) throw new Error(`${join(runDir, SCHED_FILE)} is for arc ${sched.arc}, not ${arc}`);
  return sched;
}

type Derived = Readonly<{
  log: LogSnapshot;
  events: readonly Event[];
  view: JournalView;
  /** How long folding the log took (`host.log.foldMs`). */
  foldMs: number;
  plan: PlanM1 | null;
  start: Readonly<{ record: RunStart; plan: PlanM1 }> | null;
  inForce: InForce | null;
  /** The arc's routing in force, and the profile it resolves under. */
  resolved: Readonly<{ profile: ProfileName; arc: ResolvedRouting }> | null;
  owner: OwnerState;
  rejection: RejectionFile | null;
  blocking: readonly BlockingItem[];
  sched: SchedFile | null;
  units: readonly UnitStatusLine[];
  state: ArcState;
}>;

/**
 * Each unit's routing in force and the arc's: the plan in force under its revision's provenance (per unit, its layer on
 * top); an arc with no plan in force (started before plan revisions) resolves its plan file under the repo config.
 */
function routingInForce(runDir: AbsPath, start: Readonly<{ record: RunStart; plan: PlanM1 }>, inForce: InForce | null): Readonly<{
  profile: ProfileName; of: (unit: UnitId | null) => ResolvedRouting;
}> {
  if (inForce === null) {
    const r = resolveRouting(planStack(start.record.profile, readRepoConfig(start.record.repo), start.plan));
    return { profile: start.record.profile, of: () => r };
  }
  const provenance = provenanceInForce(runDir, inForce, start.record);
  const holistic = inForce.plan.holistic !== undefined;
  const cache = new Map<UnitId | null, ResolvedRouting>();
  return {
    profile: provenance.profile,
    of: (unit) => {
      let r = cache.get(unit);
      if (r === undefined) {
        r = resolveRouting(provenanceStack(provenance, holistic, unit));
        cache.set(unit, r);
      }
      return r;
    },
  };
}

/** The log folded, the plan in force, and every unit's line with the run's state: what `status` and `watch` share. */
function derive(runDir: AbsPath, arc: ArcId, hostDir: AbsPath): Derived {
  const began = performance.now();
  const log = readJournal(runDir, arc);
  const foldMs = Math.round(performance.now() - began);
  const { view, events } = log;
  const record = readIf(join(runDir, START_FILE), runStart);
  const inForce = planInForce(runDir, view);
  const plan = inForce?.plan ?? (record === null ? null : planFile(arc, record.planFile));
  const start = record === null || plan === null ? null : { record, plan };
  const rejection = readIf(join(runDir, REJECTION_FILE), rejectionFile);
  const owner = ownerState(runDir, hostDir);
  const sched = liveSched(runDir, arc, owner);
  const blocking = blockingItems(runDir, view);
  const routing = start === null ? null : routingInForce(runDir, start, inForce);
  const resolved = routing === null ? null : { profile: routing.profile, arc: routing.of(null) };
  const scheduling = view.scheduling();
  // The specs in force are read only once a finding is active, which a started arc (start.json written first) alone has.
  const spec: SpecFactsOf = record === null
    ? (u) => {
      if (view.holistic().findings.length > 0) throw new Error(`status: arc ${arc} has findings but no ${START_FILE}, so the spec of ${u.id} cannot be read`);
      return { reproduces: false, repairs: new Set() };
    }
    : specFacts({ journal: { view }, runDir, planDir: absPath(dirname(record.planFile)) });
  const inputs: Inputs | null = plan === null || scheduling === null ? null : {
    view, plan, sched, alive: owner.state === 'alive', blocking, routing: routing === null ? null : (u) => routing.of(u).table, legacy: scheduling === 'legacy', spec,
  };
  const starts = attemptStarts(events);
  const now = Date.now();
  const units = inputs === null ? [] : inputs.plan.units.map((u) => unitLine(inputs, u, starts, now));
  return {
    log, events, view, foldMs, plan, start, inForce, resolved, owner, rejection, blocking, sched, units, state: runStateOf(view, units, owner, blocking, rejection),
  };
}

/** The run's state and each unit's, compactly: what `watch` streams. */
export function unitStates(runDir: AbsPath, arc: ArcId, hostDir: AbsPath): Readonly<{ run: ArcState; units: Readonly<Record<string, string>> }> {
  const d = derive(runDir, arc, hostDir);
  const units: Record<string, string> = {};
  for (const l of d.units) units[l.unit] = compactState(l);
  return { run: d.state, units };
}

/** `running:build#3`, `waiting:deps=u1,u2`, `waiting:resources`, `awaiting-admission:paused,drain`, `parked:retryable`, or the bare state. */
export function compactState(l: UnitStatusLine): string {
  const w = l.waitingFor;
  if (l.running !== null) return `${l.state}:${l.running.stage}#${l.running.attempt}`;
  if (l.park !== null) return `parked:${l.park.class}${l.park.kind === undefined ? '' : `-${l.park.kind}`}`;
  if (w === null) return l.state;
  const parts = [
    ...(w.deps.length > 0 ? [`deps=${w.deps.join(',')}`] : []),
    ...(w.edges.length > 0 ? [`edges=${w.edges.join(',')}`] : []),
    ...(w.resources !== null ? [w.envBlocked ? 'resources(env-blocked)' : 'resources'] : []),
    ...[...new Set(w.admission.map((c) => c.type))],
  ];
  return parts.length === 0 ? l.state : `${l.state}:${parts.join(',')}`;
}

// ---------------------------------------------------------------------------------------------------
// M3: the holistic view (§2.4; see the header)

/** The numeric part of an `X-<n>` id: ids of one kind order by it. */
const idNumber = (id: string): number => Number(id.slice(id.lastIndexOf('-') + 1));
const TERMINAL_UNIT: readonly string[] = ['retired', 'cut', 'superseded'];

/** What an open needs-user item is about: status lists them, and the M3 keys pick theirs by reason. */
type OpenItem = Readonly<{ id: NeedsUserId; reason: NeedsUserReason; blocking: boolean }>;

/** The seq of every `needs-user-acked` fact, by item. */
function ackSeqs(events: readonly Event[]): ReadonlyMap<NeedsUserId, number> {
  const out = new Map<NeedsUserId, number>();
  for (const e of events) if (e.type === 'fact' && e.fact.kind === 'needs-user-acked') out.set(e.fact.id, e.seq);
  return out;
}

/** What one unit's state says about an obligation waiting on it (see `ObligationReason`); null for a settled unit. */
function unitReason(l: UnitStatusLine): Exclude<ObligationReason, 'spec'> | null {
  const w = l.waitingFor;
  switch (l.state) {
    case 'merged':
    case 'cut':
    case 'superseded':
      return null;
    case 'parked':
      return l.park?.class === 'retryable' ? 'host' : 'supervision';
    case 'held':
      return 'supervision';
    case 'blocked':
      return w !== null && (w.deps.length > 0 || w.edges.length > 0) ? 'waiting-dep' : 'supervision';
    case 'waiting':
      if (w?.resources !== null && w?.resources !== undefined) return w.envBlocked ? 'host' : 'code';
      return 'waiting-dep';
    case 'awaiting-admission': {
      const types = new Set((w?.admission ?? []).map((c) => c.type));
      if (types.has('paused') || types.has('blocking-item') || types.has('run-only')) return 'supervision';
      if (types.has('backend-parked') || types.has('breaker')) return 'host';
      return 'code';
    }
    case 'running':
    case 'preparing':
    case 'ready':
      return 'code';
  }
}

/** The effective (lineage-head) units of `units` not merged yet, ascending, each once. */
function unmergedOf(view: JournalView, units: readonly UnitId[]): readonly UnitId[] {
  return [...new Set(units.map((u) => effectiveDependency(view, u)).filter((u) => view.unit(u).status !== 'retired'))].sort();
}

/** Each non-exempt obligation on the integration head's tree: now true, or not yet with what it waits on. */
function truths(
  runDir: AbsPath, view: JournalView, lines: readonly UnitStatusLine[], obligations: Obligations, tree: Sha,
): Readonly<{ nowTrue: readonly ObligationTruth[]; notYetTrue: readonly ObligationPending[] }> {
  const fold = view.holistic();
  // The completion predicate's rule (strict reuse): the observation on the tree in the environment the executor
  // recorded for the lane, whatever this process's environment is.
  const store = observations({ journal: { view }, runDir });
  const onTree = (lane: ArcLaneDef): Observation | null => dischargingObservation(store, tree, lane, (l) => recordedLaneEnv(view, l));
  const witnessed = new Map(fold.witnessed.map((w) => [w.seq, w]));
  const lanes = new Map(obligations.lanes.map((l) => [l.id, l]));
  const defs = new Map(obligations.obligations.map((o) => [o.id, o]));
  const latched = new Set(fold.latched.map((l) => l.obligation));
  const byUnit = new Map(lines.map((l) => [l.unit, l]));
  const owners = (id: ObligationId): readonly UnitId[] =>
    fold.findings.flatMap((f) => (isActive(f) && f.obligation === id && f.owner !== null ? [f.owner] : []));

  type Leaf = Readonly<{ verdict: ObligationTruth['verdict']; evidence: readonly AbsPath[]; units: readonly UnitId[] }>;
  const leaf = (o: ObligationDef): Leaf => {
    if (o.state.type === 'split') {
      const kids = o.state.children.map((c) => defs.get(c)).filter((c): c is ObligationDef => c !== undefined && !isExempt(c)).map(leaf);
      const verdicts = new Set(kids.map((k) => k.verdict));
      const verdict: Leaf['verdict'] = kids.every((k) => k.verdict === 'held') ? 'held'
        : (['not-held', 'partial', 'unwitnessed', 'not-covered'] as const).find((v) => verdicts.has(v))!;
      return { verdict, evidence: kids.flatMap((k) => k.evidence), units: [...new Set(kids.flatMap((k) => k.units))].sort() };
    }
    if (o.witness === null) throw new Error(`obligation ${o.id} has no witness and is not a split parent`);
    const lane = lanes.get(o.witness.lane);
    if (lane === undefined) throw new Error(`obligation ${o.id} is witnessed on lane ${o.witness.lane}, which the obligations in force do not have`);
    const future = o.activation === 'future' && !latched.has(o.id);
    const units = future ? unmergedOf(view, o.deliveredBy) : unmergedOf(view, owners(o.id));
    const found = onTree(lane);
    if (found === null) return { verdict: 'not-covered', evidence: [], units };
    const entry = witnessed.get(found.seq);
    if (entry === undefined) throw new Error(`observation ${observationKeyText(found.key)} names seq ${found.seq}, which no witnessed fact has`);
    return { verdict: verdictOf(found.record, o.witness), evidence: [witnessDir(runDir, entry)], units };
  };

  const nowTrue: ObligationTruth[] = [];
  const notYetTrue: ObligationPending[] = [];
  for (const o of [...obligations.obligations].sort((a, b) => idNumber(a.id) - idNumber(b.id))) {
    if (isExempt(o)) continue;
    const l = leaf(o);
    const truth: ObligationTruth = {
      obligation: o.id, statement: o.statement, activation: o.activation === 'future' && !latched.has(o.id) ? 'future' : 'must-hold', verdict: l.verdict,
      evidence: l.evidence,
    };
    if (l.verdict === 'held') {
      nowTrue.push(truth);
      continue;
    }
    const reasons = new Set(l.units.map((u) => {
      const line = byUnit.get(u);
      if (line === undefined) throw new Error(`obligation ${o.id} waits on unit ${u}, which the plan in force does not have`);
      return unitReason(line);
    }));
    const reason = l.units.length === 0 ? 'spec' : OBLIGATION_REASONS.find((r) => reasons.has(r as never)) ?? 'code';
    notYetTrue.push({ ...truth, blockingUnits: l.units, reason });
  }
  return { nowTrue, notYetTrue };
}

/** The longest chain of unsettled units along their effective `after` edges (ties: the first in plan order). */
function criticalPath(view: JournalView, plan: PlanM1): readonly UnitId[] {
  const units = new Map(plan.units.map((u) => [u.id, u]));
  const open = (id: UnitId): boolean => units.has(id) && !TERMINAL_UNIT.includes(view.unit(id).status);
  const memo = new Map<UnitId, readonly UnitId[]>();
  const chainTo = (id: UnitId): readonly UnitId[] => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    let best: readonly UnitId[] = [];
    for (const dep of units.get(id)!.after.map((d) => effectiveDependency(view, d)).filter(open)) {
      const c = chainTo(dep);
      if (c.length > best.length) best = c;
    }
    const chain = [...best, id];
    memo.set(id, chain);
    return chain;
  };
  let path: readonly UnitId[] = [];
  for (const u of plan.units) {
    if (!open(u.id)) continue;
    const c = chainTo(u.id);
    if (c.length > path.length) path = c;
  }
  return path;
}

function targetOf(view: JournalView, plan: PlanM1, obligations: Obligations, t: ReturnType<typeof truths>): TargetView {
  const latched = new Set(view.holistic().latched.map((l) => l.obligation));
  const count = (type: ObligationDef['state']['type']): number => obligations.obligations.filter((o) => o.state.type === type).length;
  const pending = obligations.obligations
    .filter((o) => !isExempt(o) && o.state.type !== 'split' && o.activation === 'future' && !latched.has(o.id))
    .map((o) => ({ obligation: o.id, statement: o.statement, unmerged: unmergedOf(view, o.deliveredBy) }))
    .filter((m) => m.unmerged.length > 0)
    .sort((a, b) => a.unmerged.length - b.unmerged.length || idNumber(a.obligation) - idNumber(b.obligation));
  return {
    cutLine: obligations.cutLine,
    nextMilestone: pending[0] ?? null,
    criticalPath: criticalPath(view, plan),
    obligations: {
      total: obligations.obligations.length, nowTrue: t.nowTrue.length, notYetTrue: t.notYetTrue.length, latched: latched.size, split: count('split'),
      waived: count('waived'), deferred: count('deferred'), retired: count('retired'),
    },
  };
}

function exemptBy(obligations: Obligations | null, type: 'waived' | 'deferred'): readonly Readonly<{ obligation: ObligationId; ruling: RulingId }>[] {
  return (obligations?.obligations ?? []).flatMap((o) => (o.state.type === type ? [{ obligation: o.id, ruling: o.state.ruling }] : []))
    .sort((a, b) => idNumber(a.obligation) - idNumber(b.obligation));
}

function visionOf(revision: RevisionInForce, fold: HolisticFold): VisionView | null {
  if (revision.vision === null) return null;
  const v = revision.vision.value;
  const citers = [
    ...[...revision.sidecars].map(([id, s]) => ({ id: id as string, cites: s.sidecar.cites })),
    ...fold.divergences.map((d) => ({ id: d.id as string, cites: d.cites })),
  ];
  return {
    rev: v.rev, confirmation: v.confirmation,
    clauses: v.clauses.map((c) => ({ id: c.id, kind: c.kind, text: c.text, rank: c.rank, state: c.state })),
    coverage: visionCoverage(v, revision.obligations?.value ?? null, citers),
  };
}

/** Every divergence no acknowledged digest covers (H11), ascending. */
function divergencesOf(view: JournalView): readonly DivergenceView[] {
  const open = new Map(view.holistic().digests.filter((g) => view.ackOf(g.needsUser) === null).flatMap((g) => g.ids.map((id) => [id, g.needsUser] as const)));
  return uncoveredDivergences(view).map((d) => ({
    id: d.id, type: d.type, from: d.from, what: d.what, cites: d.cites, evidence: d.evidence, bundle: d.job, compensation: d.compensation,
    digest: open.get(d.id) ?? null,
  }));
}

/** A revision's source as the one who ruled it. */
function rulerOf(f: PlanAppliedFact): RuledBy {
  const source = revisionSourceOf(f);
  switch (source.type) {
    case 'start':
      return { type: 'architect', command: null };
    case 'command':
      return { type: 'architect', command: source.command };
    case 'bundle':
      return { type: 'checkpoint', job: source.job };
    case 'executor':
      return { type: 'executor' };
  }
}

/** A command's body, when its incoming file is in the run dir (a run dir restored from a snapshot has none: commands are outside its closure). */
function commandBody(runDir: AbsPath, arc: ArcId, id: CommandId): CommandBody | null {
  return existsSync(incomingPath(runDir, id)) ? readCommand(runDir, id, arc).file.body : null;
}

/**
 * The decisions since the architect last acknowledged a divergence digest (the whole arc before one), in log order: each
 * revision's rulings, bundle or reversal, cuts, re-entries and spec patches; the executor's spec patches; steers; and
 * divergences.
 */
function decisionsSince(runDir: AbsPath, arc: ArcId, view: JournalView, events: readonly Event[], acks: ReadonlyMap<NeedsUserId, number>): readonly Decision[] {
  const since = Math.max(0, ...view.holistic().digests.flatMap((g) => {
    const seq = acks.get(g.needsUser);
    return seq === undefined ? [] : [seq];
  }));
  const out: Decision[] = [];
  let sidecars = new Set<string>();
  for (const e of events) {
    if (e.type === 'done' && e.kind === 'spec.patch' && e.seq > since) {
      const intent = view.latestIntent(e.op);
      if (intent.kind !== 'spec.patch') throw new Error(`${e.op} is done as spec.patch but its intent is ${intent.kind}`);
      const unit = parentUnit(intent.parent) ?? 'arc';
      const ruledBy: RuledBy = intent.expect.patch.by.role === 'planCheck' ? { type: 'judgment', role: 'planCheck' } : { type: 'executor' };
      out.push({ seq: e.seq, kind: 'patch', id: unit, oneLine: `${unit} spec rev ${intent.post.newRev} (${intent.expect.patch.ops.length} ops)`, ruledBy });
      continue;
    }
    if (e.type !== 'fact') continue;
    const f = e.fact;
    if (f.kind === 'plan-applied') {
      const added = new Set<string>();
      let ids = sidecars;
      if (f.payloadSha256 !== undefined) {
        const payload = keptPayload(runDir, f.payloadSha256);
        const rulings = payload.manifest.rulings.sidecars;
        ids = new Set(Object.keys(rulings));
        // The arc's first revision states its starting rulings: nothing was decided in the arc yet.
        if (payload.base !== 0) for (const id of ids) if (!sidecars.has(id)) added.add(id);
        if (e.seq > since) {
          for (const id of [...added].sort((a, b) => idNumber(a) - idNumber(b))) {
            const bytes = keptInput(runDir, rulings[id as RulingId]!, RULING_INPUT);
            if (bytes === null) throw new Error(`plan rev ${f.rev} names ruling ${id}, whose bytes the run dir does not keep`);
            const r = parseRulingSidecar(JSON.parse(bytes.toString('utf8')));
            const ruledBy: RuledBy = r.ruledBy.type === 'checkpoint' ? { type: 'checkpoint', job: r.ruledBy.job } : { type: 'architect', command: f.command };
            out.push({ seq: e.seq, kind: 'ruling', id, oneLine: r.statement, ruledBy });
          }
        }
      }
      sidecars = ids;
      if (e.seq <= since) continue;
      const ruledBy = rulerOf(f);
      const summary = f.changes.length === 0 ? 'no change' : f.changes.map((c) => ('unit' in c && c.unit !== undefined && c.unit !== null ? `${c.type} ${c.unit}` : c.type)).join(', ');
      if (ruledBy.type === 'checkpoint') out.push({ seq: e.seq, kind: 'bundle', id: ruledBy.job, oneLine: `plan rev ${f.rev}: ${summary}`, ruledBy });
      const body = ruledBy.type === 'architect' && ruledBy.command !== null ? commandBody(runDir, arc, ruledBy.command) : null;
      if (body?.type === 'reverse') out.push({ seq: e.seq, kind: 'reverse', id: body.divergence, oneLine: `plan rev ${f.rev} reverses ${body.divergence}: ${summary}`, ruledBy });
      for (const c of f.changes) {
        if (c.type === 'unit-cut') out.push({ seq: e.seq, kind: 'cut', id: c.unit, oneLine: `${c.unit} cut (plan rev ${f.rev})`, ruledBy });
        if (c.type === 'unit-reentered') {
          out.push({ seq: e.seq, kind: 'reenter', id: c.unit, oneLine: `${c.unit} re-enters ${c.reenters}${c.reset ? ', counters reset' : ''} (plan rev ${f.rev})`, ruledBy });
        }
        if (c.type === 'spec' && c.edit !== 'evidence') {
          out.push({ seq: e.seq, kind: 'patch', id: c.unit, oneLine: `${c.unit} spec rev ${c.specRev} (${c.edit}, plan rev ${f.rev})`, ruledBy });
        }
      }
      continue;
    }
    if (e.seq <= since) continue;
    if (f.kind === 'steered') {
      out.push({
        seq: e.seq, kind: 'steer', id: f.unit, oneLine: `${f.unit} steered for ${f.budgetMin} min${f.resume ? ', then resumes' : ', then parks'}`,
        ruledBy: { type: 'architect', command: f.command },
      });
    }
    if (f.kind === 'divergence') out.push({ seq: e.seq, kind: 'divergence', id: f.id, oneLine: `${f.type}: ${f.what}`, ruledBy: { type: 'checkpoint', job: f.job } });
  }
  return out;
}

/**
 * The convergence brakes (§2.8, A9; B6 `brakesOf`): the applied bundles counted against K since the counter last cleared,
 * and the open brake items. The bundles are the log's committed bundle revisions; their ops (read from the checkpoint's
 * recorded call) only feed the identity bound, which the checkpoint applies and status does not render.
 */
function convergenceOf(runDir: AbsPath, view: JournalView, plan: PlanM1): ConvergenceView {
  const applied: AppliedBundle[] = view.opsOf('revision.commit').flatMap((commit) => (commit.expect.source.type !== 'bundle' || view.doneOf(commit.op) === null
    ? [] : [{ job: commit.expect.source.job, seq: parseOpId(commit.op).seq, ops: [] }]));
  const brakes = brakesOf(view, runDir, plan, applied, new Set(), (u) => u);
  return { k: brakes.k, counter: brakes.count, since: brakes.since, open: brakes.open };
}

/** Minutes of the journey lanes checkpoint jobs ran: each spawn from its intent to its done (a running one's to now). */
function checkpointLaneMinutes(events: readonly Event[], now: number): number {
  const started = new Map<string, number>();
  let ms = 0;
  for (const e of events) {
    if (e.type === 'intent' && e.kind === 'proc.spawn' && e.ordinal === 1) {
      const s = e.expect.subject;
      if (s.purpose === 'journey' && s.owner.type === 'job' && parseJobId(s.owner.job).kind === 'ckpt') started.set(e.op, Date.parse(e.at));
    }
    if (e.type === 'done' && started.has(e.op)) {
      ms += Date.parse(e.at) - started.get(e.op)!;
      started.delete(e.op);
    }
  }
  for (const at of started.values()) ms += now - at;
  return ms / 60_000;
}

function auditOf(runDir: AbsPath, view: JournalView, events: readonly Event[], plan: PlanM1, head: Sha, now: number): AuditView {
  const fold = view.holistic();
  const holistic = plan.holistic;
  if (holistic === undefined) throw new Error('the audit view of an arc whose plan in force has no holistic layer');
  const lenses = lensSetOf(holistic);
  const base = coverageBase({ journal: { view }, runDir }, head);
  if (base === null) throw new Error(`arc ${view.arc} is holistic but no applied revision names a vision`);
  const coverage = coverageOf(fold, base, lenses, head);
  const latest = fold.audits.at(-1) ?? null;
  return {
    lenses,
    coverage: coverage.map((c) => ({ lens: c.lens, coveredTo: c.watermark, outstanding: c.outstanding, pendingDocs: c.pendingDocs })),
    uncovered: coverage.filter((c) => c.outstanding).map((c) => ({ lens: c.lens, from: c.watermark, to: head })),
    generation: generationOf(fold),
    running: latest !== null && latest.ended === null ? latest.started.job : null,
    checkpointLaneMinutes: checkpointLaneMinutes(events, now),
  };
}

/** The highest generation any audit or checkpoint recorded; 0 before one. */
const generationOf = (fold: HolisticFold): number =>
  Math.max(0, ...fold.audits.map((a) => a.started.generation), ...fold.checkpoints.map((c) => c.inputs.generation));

type CompletionInputs = Readonly<{ d: Derived; hostDir: AbsPath; pending: number }>;

/**
 * The completion predicate's unmet clauses now: the scheduler's `completionBlockers` over a read-only view of the arc
 * (`readOnlyContexts`), so status and the executor read one rule. Without a passed start or a plan in force nothing is
 * evaluable: the units are open.
 */
function unmetOf(runDir: AbsPath, x: CompletionInputs): readonly CompletionBlocker[] {
  const { view, start, inForce, blocking } = x.d;
  if (start === null || inForce === null) return ['units-open'];
  const h = readOnlyContexts({
    view, runDir, repo: start.record.repo, hostDir: x.hostDir, planFile: start.record.planFile, plan: () => inForce.plan, hostEnv: process.env,
    routingBase: { profile: start.record.profile, config: readRepoConfig(start.record.repo) },
  });
  return completionBlockers(h, { blocking: blocking.length, pending: x.pending });
}

function completionOf(runDir: AbsPath, d: Derived, x: CompletionInputs): CompletionView {
  const c = d.view.holistic().completion;
  const sealing: Sealing = c === null || d.start === null ? { kind: 'open', reason: 'not completed' } : sealingOf(d.start.record.repo, runDir, d.log);
  return {
    planRev: c?.planRev ?? null, head: c?.head ?? null, active: c?.active ?? false, sealed: sealing.kind === 'sealed',
    notSealed: sealing.kind === 'sealed' ? null : sealing.kind === 'open' ? sealing.reason : sealing.detail,
    unmet: unmetOf(runDir, x),
  };
}

function logOf(runDir: AbsPath, d: Derived): LogView {
  const path = join(runDir, EVENTS_FILE);
  const bytes = existsSync(path) ? statSync(path).size : 0;
  return { bytes, events: d.events.length, foldMs: d.foldMs, compactionDue: bytes >= LOG_COMPACTION_BYTES || d.foldMs >= LOG_COMPACTION_FOLD_MS };
}

export function status(runDir: AbsPath, arc: ArcId, hostDir: AbsPath): Status {
  const d = derive(runDir, arc, hostDir);
  const { view, events, start, inForce } = d;
  const now = Date.now();
  const meter = meterOf(events);
  const tables = routingTables(runDir, events);
  const resolvable = meter.bySeat.filter((t) => tables.has(t.routingRev));
  const unresolvedRevs = [...new Set(meter.bySeat.filter((t) => !tables.has(t.routingRev)).map((t) => t.routingRev))].sort();

  const needsUser: readonly OpenItem[] = [
    ...view.needsUser().filter((n) => n.ack === null).map((n) => ({ id: n.id, reason: recordOf(runDir, n.id).reason, blocking: n.blocking })),
    ...fileNeedsUser(runDir, view).map((r) => ({ id: r.id, reason: r.reason, blocking: r.blocking })),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const commands = commandsOf(runDir, arc);
  const acks = ackSeqs(events);

  // The holistic keys: only an arc whose plan in force names a vision (A5) has them; a dev.5 revision has no payload.
  const fold = view.holistic();
  const plan = inForce?.plan ?? null;
  const on = fold.on && plan !== null && start !== null && inForce !== null && inForce.fact.payloadSha256 !== undefined
    ? { plan, repo: start.record.repo, revision: revisionInForce(runDir, inForce, start.record.planFile) } : null;
  const holistic = on !== null;
  const revision = on?.revision ?? null;
  const head = on === null ? null : revParse(on.repo, branchRef(on.plan.integrationBranch));
  const obligations = revision?.obligations?.value ?? null;
  const t = on === null || head === null || obligations === null ? { nowTrue: [], notYetTrue: [] }
    : truths(runDir, view, d.units, obligations, revParse(on.repo, `${head}^{tree}`));
  const audit = on === null || head === null ? null : auditOf(runDir, view, events, on.plan, head, now);
  const owed = needsUser.filter((n) => n.reason === 'audit-owed').map((n) => n.id);

  return {
    arc,
    run: { state: d.state, owner: d.owner, heartbeatAt: readIf(join(runDir, HEARTBEAT_FILE), heartbeat)?.at ?? null },
    units: d.units,
    edges: d.plan === null || view.scheduling() === null ? [] : edgesOf(view, d.plan),
    runOnly: view.runOnly(),
    legacy: view.scheduling() === 'legacy',
    needsUser,
    commands,
    spend: { byRole: meter.byRole, byModel: { models: byModel(resolvable, tables), unresolvedRevs }, byJob: meter.byJob, bySmoke: meter.bySmoke },
    host: {
      containment: { mode: view.containmentMode(), guarantee: SESSION_GUARANTEE },
      resources: hostResources(view),
      pools: d.plan === null ? {} : pools(view, d.plan),
      queue: d.sched?.queue ?? [],
      probes: probesOf(view),
      backends: view.backendParks().map((b) => ({ backend: b.backend, parkSeq: b.seq, class: b.class })),
      log: logOf(runDir, d),
    },
    parkedBackends: view.parkedBackends(),
    plan: inForce === null ? null : { rev: inForce.rev, planSha256: inForce.manifest.planSha256 },
    routing: d.resolved === null ? null : routingView(d.resolved.profile, d.resolved.arc),
    rejection: d.rejection,
    holistic,
    target: on === null || obligations === null ? null : targetOf(view, on.plan, obligations, t),
    nowTrue: t.nowTrue,
    notYetTrue: t.notYetTrue,
    waived: exemptBy(obligations, 'waived'),
    deferred: exemptBy(obligations, 'deferred'),
    vision: revision === null ? null : visionOf(revision, fold),
    divergences: divergencesOf(view),
    decisionsSince: decisionsSince(runDir, arc, view, events, acks),
    convergence: on === null ? null : convergenceOf(runDir, view, on.plan),
    findings: {
      active: fold.findings.filter(isActive).map((f) => ({ id: f.id, lens: f.lens, severity: f.severity, state: f.state, owner: f.owner, obligation: f.obligation, claim: f.claim })),
      metrics: findingMetrics(events, fold.findings),
    },
    audit,
    owed: { audits: owed },
    completion: completionOf(runDir, d, { d, hostDir, pending: commands.pending.length }),
  };
}
