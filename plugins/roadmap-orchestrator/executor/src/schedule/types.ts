// The scheduler's frozen interfaces (M2 step 0a; SCHEMAS.md "Scheduling"). Types, constants and `compareRank`
// only: the arbiter (`acquire`), readiness and admission (`admit`), the prober and `commandScope` are
// implemented by later steps against these signatures. The records they read and write (facts, holders,
// `ProbeTarget`) live in src/core/events.ts.
import type { BackendParkClass, Holder, OutcomeStage, ProbeTarget } from '../core/events.ts';
import type { CommandId, FindingId, KnownDefectId, NeedsUserId, ObligationId, ResourceName, ResourceUnit, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { CommandBody, LaneTier, NeedsUserReason } from '../core/records.ts';
import type { PlanM1, PlanUnit, UnitOrigin, UnitPriority } from '../input/plan.ts';
import type { Backend } from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Stages: admission boundaries and chains (F5)

/** The stages a unit enters only through admission: pause, drain and A17 are re-checked before each. `reproduce` since M3. */
export const ADMISSION_STAGES = ['prepare', 'reproduce', 'plan-check', 'build', 'lanes', 'gate', 'candidate'] as const satisfies readonly OutcomeStage[];
export type AdmissionStage = (typeof ADMISSION_STAGES)[number];
/**
 * Mandatory chain stages: they run to completion whatever pause or drain says, so a build's retained
 * reservation is always released by its teardown and a green publication always reaches `snapshot` (A2).
 */
export const BUILD_CHAIN = ['quiesce', 'evidence', 'salvage', 'teardown'] as const satisfies readonly OutcomeStage[];
export const PUBLICATION_CHAIN = ['ff', 'snapshot'] as const satisfies readonly OutcomeStage[];
export type ChainStage = (typeof BUILD_CHAIN)[number] | (typeof PUBLICATION_CHAIN)[number];

/** A unit's task, in memory only (all `idle` after a restart). A mutation applies when its scope is idle or awaiting admission (A12). */
export type TaskState = 'idle' | 'awaiting-admission' | 'in-stage' | 'in-chain';

// ---------------------------------------------------------------------------------------------------
// Capacity (A3): token costs, all unmeasured defaults

/** `@cpu` tokens per holder kind. Probes and teardowns take none. */
export const CPU_COST = { judgment: 1, build: 4, lane: { fast: 2, estate: 4 } } as const satisfies Readonly<{
  judgment: number; build: number; lane: Readonly<Record<LaneTier, number>>;
}>;

/**
 * What one reservation asks for, all-or-none: named resources, one instance per pool request, `@cpu` tokens
 * and `integration-slot` for a publication. Its units are taken in lock order.
 */
export type ResourceRequest = Readonly<{
  named: readonly ResourceName[];
  /** Pools this request takes one instance of each, ascending. */
  pools: readonly ResourceName[];
  cpu: number;
  publication: boolean;
}>;

/**
 * Each stage's entry reservation (F6), taken before the stage's first journaled op: plan-check and gate
 * `@cpu`×1; build the unit's resources and `@cpu`×(`unit.cpu ?? 4`); lanes the first lane's set; candidate the
 * publication (`integration-slot`); prepare none. A wait cancelled by pause or stop journals nothing.
 */
export type EntryReservation = (plan: PlanM1, unit: PlanUnit, stage: AdmissionStage) => ResourceRequest | null;

/** The arbiter's answer to one waiter (src/schedule/arbiter.ts, step 1). */
export type Grant =
  | Readonly<{ kind: 'granted'; units: readonly ResourceUnit[] }>
  /** Cancelled while waiting (pause or stop): nothing was journaled. */
  | Readonly<{ kind: 'cancelled' }>;

/**
 * Waits for `request` under `holder`, ranked by `rank`, and reserves it all-or-none through the synchronous
 * `reserve()` (A1, F8): active waiters are granted in rank order, a lower rank passes a blocked higher one only
 * when the two requests are disjoint (one pool counts as overlapping), and environment-blocked waiters (a
 * named resource cleanup-failed or with an undisposed own residue, or more instances than a pool has healthy)
 * are set aside until the dirty unit is disposed.
 */
export type Acquire = (request: ResourceRequest, holder: Holder, rank: () => Rank, signal: AbortSignal) => Promise<Grant>;

// ---------------------------------------------------------------------------------------------------
// Priority and aging (F17)

/** R6: repair units first, then checkpoint-originated, then planned. */
export const ORIGIN_RANK = { repair: 0, checkpoint: 1, planned: 2 } as const satisfies Readonly<Record<UnitOrigin, number>>;
/** A waiter is promoted once this many other units published inside its current waiting interval. */
export const PROMOTION_BYPASS = 3;

/**
 * A waiter's rank, derived from the log. `waitStartSeq`: the seq of the fact that put the unit into its
 * current wait (the stage-outcome deciding the stage whose entry reservation it awaits; undispatched, the
 * latest of its `plan-applied` addition, its last dependency's `ff` done and its last `edge-resolved`).
 * `promoted`: `bypassMerges >= PROMOTION_BYPASS`, where `bypassMerges` counts `integration.ff{published}` by
 * other units inside the waiting interval.
 */
export type Rank = Readonly<{
  unit: UnitId;
  /** M4a rev 3 (F1b, R42): the unit's plan priority (`priorityOf`: absent is `normal`). */
  priority: UnitPriority;
  origin: UnitOrigin;
  waitStartSeq: number;
  bypassMerges: number;
  promoted: boolean;
  planIndex: number;
}>;

/**
 * M4a rev 3 (R42): `high` priority first; then promoted units, by age alone (`waitStartSeq`); then the rest by origin
 * (`checkpoint` before `planned`), then age. Plan index breaks ties, so the order is total. Negative: `a` is served first.
 */
export function compareRank(a: Rank, b: Rank): number {
  if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
  if (a.promoted !== b.promoted) return a.promoted ? -1 : 1;
  if (!a.promoted && a.origin !== b.origin) return ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin];
  if (a.waitStartSeq !== b.waitStartSeq) return a.waitStartSeq - b.waitStartSeq;
  return a.planIndex - b.planIndex;
}

// ---------------------------------------------------------------------------------------------------
// Admission (A12, A17)

/** Why a stage may not be admitted now. Each holds per stage, never arc-wide unless it says so (A17). */
export type AdmissionConstraint =
  | Readonly<{ type: 'paused'; scope: 'arc' | 'unit' }>
  /** A pending mutation whose scope covers the unit is draining it. */
  | Readonly<{ type: 'drain'; command: CommandId }>
  /** Outside the `run-only` allowlist. */
  | Readonly<{ type: 'run-only' }>
  /** The stage calls a parked backend; running calls finish. */
  | Readonly<{ type: 'backend-parked'; backend: Backend; class: BackendParkClass }>
  /** A tripped probe breaker on a target the stage needs (`host` blocks builds and lanes). */
  | Readonly<{ type: 'breaker'; target: ProbeTarget }>
  /** `base-red` blocks candidate admission. */
  | Readonly<{ type: 'base-red' }>
  /** An open blocking item that holds all admission: recovery-required, log-corrupt, a host subject, the supervisor crash limit. */
  | Readonly<{ type: 'blocking-item'; id: NeedsUserId; reason: NeedsUserReason }>
  /**
   * M3 (§2.8, G10): an active P1 over an obligation the candidate selects holds its candidate admission (a repair
   * declaring that obligation excepted); `finding-blocked` is also the pre-ff re-check's candidate outcome.
   */
  | Readonly<{ type: 'finding-blocked'; finding: FindingId; obligation: ObligationId }>
  /**
   * M4a rev 3 (F4, R49): a plan known defect holds the unit's `prepare` while `knownDefectActive` holds (until its
   * fixer's lineage merges); the fixer's own lineage is never held.
   */
  | Readonly<{ type: 'known-defect'; id: KnownDefectId; fixUnit: UnitId }>;

export type Admission = Readonly<{ kind: 'admit' }> | Readonly<{ kind: 'wait'; constraints: readonly AdmissionConstraint[] }>;

/** What admission reads besides the log: the open blocking items, pending mutations' scopes, tripped breakers. */
export type AdmitInput = Readonly<{
  view: JournalView;
  plan: PlanM1;
  unit: PlanUnit;
  stage: AdmissionStage;
  blocking: readonly Readonly<{ id: NeedsUserId; reason: NeedsUserReason; subject: 'unit' | 'arc' | 'host'; unit: UnitId | null }>[];
  drains: readonly Readonly<{ command: CommandId; scope: CommandScope }>[];
  tripped: readonly ProbeTarget[];
}>;

/** Re-checked at every admission boundary, for new and running tasks alike (F13); src/schedule/ready.ts, step 2. */
export type Admit = (input: AdmitInput) => Admission;

// ---------------------------------------------------------------------------------------------------
// Command scopes (A12)

/**
 * The units a mutation must find idle or awaiting admission before it applies: `arc` (resume all; resource,
 * pool, capacity and routing edits), `units` (`resume <u>`; spec and unit edits), or none (`sweep`, `resume
 * --backend`, `resolve-edge`, `run-only`). Control commands have no scope: they apply at once.
 */
export type CommandScope = Readonly<{ type: 'arc' }> | Readonly<{ type: 'units'; units: readonly UnitId[] }> | Readonly<{ type: 'none' }>;

/** A mutation's scope, from its body and the plan in force (an `apply`'s from its classification); src/input/classify.ts, step 5. */
export type ScopeOf = (body: Exclude<CommandBody, Readonly<{ type: 'pause' | 'stop' | 'ack' }>>, view: JournalView, plan: PlanM1) => CommandScope;

// ---------------------------------------------------------------------------------------------------
// Parks and probes (A7, A8, D2, G7)

/** Probe backoff after a retryable park: at once, then these minutes, then the last one repeatedly. */
export const PROBE_BACKOFF_MIN = [0, 1, 2, 4, 8, 16, 30] as const;
/** An unrecovered retryable park raises a non-blocking `park-escalated` item after this; probing goes on (D2). */
export const PARK_ESCALATE_MS = 6 * 60 * 60_000;
/** The same unit parked on the same target within this long of a recovery parks operator (`env-blocked`). */
export const PARK_REPEAT_MS = 6 * 60 * 60_000;
/** A target trips its breaker when this many distinct units parked on it within `BREAKER_WINDOW_MS`. */
export const BREAKER_UNITS = 2;
export const BREAKER_WINDOW_MS = 60 * 60_000;

/**
 * One probe run: a target and the park seqs it covers, fixed when the probe starts (G7: a park that arrives
 * while it runs waits for the next one). A host probe also runs each covered park's local check.
 */
export type ProbeJob = Readonly<{ target: ProbeTarget; covers: readonly number[] }>;

/** Runs one probe job to its `probe` fact (src/park/probe.ts, step 3); at most one job per target at a time. */
export type Prober = Readonly<{
  /** The jobs due now: every target of a current retryable park, or a parked backend, past its `nextProbeAt`. */
  due: (view: JournalView, now: Date) => readonly ProbeJob[];
  run: (job: ProbeJob, signal: AbortSignal) => Promise<'pass' | 'fail'>;
}>;
