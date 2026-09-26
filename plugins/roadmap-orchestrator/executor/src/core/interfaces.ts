// Frozen cross-module interfaces. Implementations land in later steps: Journal (2), Containment (3a/3b),
// RunnerFiles (3a), Adapter (4), GitOp (8a/8b), Reconciler per op kind (3c, 7, 8a, 8b, 9, 10, 13). The
// reservation cycle's typed handles live beside their one implementation, src/resources/reserve.ts (10).
// Interfaces only; no behaviour here.
import type {
  AbortCode, DoneRecord, Fact, GitOpKind, IntentOf, IntentRecord, OpExpect, OpKind, OpOutcome, OpPost, Parent,
  RecoveredBy,
} from './events.ts';
import type { ArcId, CommandId, InvocationId, NeedsUserId, OpId, OpKey, UnitId } from './ids.ts';
import type {
  ChildEnd, ContainmentMode, DispatchRecord, ExitFile, KillReason, LaunchFile, ProcIdentity, ResultFile, RunnerFileMap,
  RunnerFileName,
} from './records.ts';
import type { UnitState } from './state.ts';
import type { Backend } from '../routing/types.ts';
import type { AbsPath, IsoTime } from './values.ts';

// ---------------------------------------------------------------------------------------------------
// Journal: the one serialised writer of events.jsonl. Every append returns only after the full line is
// written and fsynced; no act may begin before `begin`/`retry` returns.

export type IntentBody<K extends OpKind> = Readonly<{ expect: OpExpect[K]; post: OpPost[K] }>;

/** A new op: the journal allocates `op = <arc>/<seq>` and ordinal 1, then asks for the body (which may embed the op). */
export type NewIntent<K extends OpKind> = Readonly<{
  kind: K;
  key: OpKey;
  parent: Parent;
  deadlineAt: IsoTime | null;
  body: (op: OpId, inv: InvocationId) => IntentBody<K>;
}>;

export type Durable = Readonly<{ op: OpId; inv: InvocationId; seq: number }>;

export interface JournalView {
  readonly arc: ArcId;
  /** Seq of the last durable line; 0 for an empty log. */
  highWater(): number;
  /** Intents with no matching done or abort, in log order. At most one per key. */
  openIntents(): readonly IntentRecord[];
  /** The latest intent (highest ordinal) of an op. Throws for an unknown op. */
  latestIntent(op: OpId): IntentRecord;
  /** The done record that closed an op's latest intent, or null while open or aborted. */
  doneOf(op: OpId): DoneRecord | null;
  /** The latest intent of every op of `kind`, open or closed, in the order the ops began. */
  opsOf<K extends OpKind>(kind: K): readonly IntentOf<K>[];
  /**
   * Whether a `meter` or `usage-unavailable` fact exists for `inv`. Recovery asks before recording one,
   * since the fact precedes the spawn's done and a crash between them leaves it already written.
   */
  usageRecorded(inv: InvocationId): boolean;
  /**
   * A unit's state as the fold derives it from its stage-outcome facts, stage-parented intents and dispatch
   * facts; a unit the log has not named yet is fresh at plan-check. The only source of a unit's counters.
   */
  unit(unit: UnitId): UnitState;
  /** The unit's latest `dispatch` fact (its pinned scope envelope and risk floor), or null before one. */
  dispatchOf(unit: UnitId): DispatchRecord | null;
  /** Backends parked arc-wide by a `backend-park` fact and not since resumed, ascending. */
  parkedBackends(): readonly Backend[];
  /** Every needs-user item a done `needsuser.raise` recorded, ascending id, with its acknowledgement. */
  needsUser(): readonly NeedsUserState[];
  /** The `needs-user-acked` fact of any id (journal-raised or not), or null while unacknowledged. */
  ackOf(id: NeedsUserId): NeedsUserAckState | null;
  /** The durable pause and stop markers the commands recorded; the driver consults them. */
  control(): ControlState;
  /** The latest `containment-mode` fact, or null before one. */
  containmentMode(): ContainmentMode | null;
}

export type NeedsUserAckState = Readonly<{ command: CommandId; choice: string | null }>;
export type NeedsUserState = Readonly<{ id: NeedsUserId; blocking: boolean; ack: NeedsUserAckState | null }>;
/** `stop`: the stop command recorded, if any. A pause of every unit and pauses of single units are kept apart. */
export type ControlState = Readonly<{ stop: CommandId | null; pausedAll: boolean; pausedUnits: readonly UnitId[] }>;

export interface Journal {
  readonly view: JournalView;
  begin<K extends OpKind>(intent: NewIntent<K>): Durable;
  /**
   * Opens the next ordinal of a closed op (the previous ordinal must be done `lost` or aborted). Key,
   * parent and deadlineAt are inherited from the op's first intent, never passed.
   */
  retry<K extends OpKind>(op: OpId, kind: K, body: (inv: InvocationId) => IntentBody<K>): Durable;
  done<K extends OpKind>(op: OpId, kind: K, outcome: OpOutcome[K], recoveredBy: RecoveredBy): number;
  abort(op: OpId, code: AbortCode, detail: string): number;
  fact(fact: Fact): number;
}

// ---------------------------------------------------------------------------------------------------
// Containment: session mode ships; cgroup mode is experimental and not selectable in M1 builds.

/** A workload is found by its invocation; the child identity is null until the runner has spawned it. */
export type WorkloadRef = Readonly<{ inv: InvocationId; child: (ProcIdentity & Readonly<{ sid: number }>) | null }>;

/**
 * The runner's view of its spawned child. `ended` settles when the child itself exits (its descendants may
 * live on); only the runner, the child's parent, can observe the code or signal.
 */
export type SpawnedWorkload =
  | Readonly<{
    kind: 'spawned';
    child: ProcIdentity & Readonly<{ sid: number }>;
    ended: Promise<Extract<ChildEnd, { type: 'exited' | 'signalled' }>>;
  }>
  | Readonly<{ kind: 'spawn-failed'; error: string }>;

export interface Containment {
  readonly mode: ContainmentMode;
  /** Runner side: spawns launch.argv as the workload (stdio to files, env per launch.json). */
  launch(launch: LaunchFile, invDir: AbsPath): Promise<SpawnedWorkload>;
  /** Every member by (pid, start): `ROADMAP_INV=<inv>` in its environ, or the child's session. Never the runner. */
  members(workload: WorkloadRef): readonly ProcIdentity[];
  /** Stop → rescan until stable → TERM → grace → KILL → rescan until empty. Resolves only when empty. */
  kill(workload: WorkloadRef, reason: KillReason, graceMs: number): Promise<void>;
  empty(workload: WorkloadRef): boolean;
}

// ---------------------------------------------------------------------------------------------------
// Runner files: typed, invocation-bound, durable (`fsx.durable()`), write-once except runner.json.

export interface RunnerFiles {
  readonly invDir: AbsPath;
  readonly inv: InvocationId;
  /** null when absent; throws when present but invalid or bound to another {arc, op, inv}. */
  read<N extends RunnerFileName>(name: N): RunnerFileMap[N] | null;
  write<N extends RunnerFileName>(name: N, content: RunnerFileMap[N]): void;
}

// ---------------------------------------------------------------------------------------------------
// Adapter: pure over the invocation's files, run only after exit.json (workload quiescent). Re-runnable.

export type AdapterInput = Readonly<{ launch: LaunchFile; exit: ExitFile; stdoutPath: AbsPath; stderrPath: AbsPath }>;
export type Adapter = (input: AdapterInput) => ResultFile;

// ---------------------------------------------------------------------------------------------------
// Reconcilers: one per op kind, run by recovery on each open intent. Each re-reads postconditions first
// and trusts no file's mere existence.

export type Disposition<K extends OpKind> =
  | Readonly<{ kind: 'done'; outcome: OpOutcome[K] }>
  | Readonly<{ kind: 'redo' }>
  | Readonly<{ kind: 'park'; detail: string }>
  | Readonly<{ kind: 'abort'; detail: string }>
  | Readonly<{ kind: 'adopt' }>
  | Readonly<{ kind: 'lost'; treeEffects: boolean }>
  | Readonly<{ kind: 'recovery-required'; detail: string }>;
export type DispositionKind = Disposition<OpKind>['kind'];

/** Which dispositions each kind's reconciler may return (the plan's reconciliation table). */
export type AllowedDisposition = {
  'proc.spawn': 'done' | 'adopt' | 'lost';
  'proc.kill': 'done' | 'redo';
  'worktree.create': 'done' | 'redo' | 'park';
  'worktree.remove': 'done' | 'redo' | 'park';
  'evidence.snapshot': 'done' | 'redo';
  'salvage.commit': 'done' | 'redo' | 'park';
  'mergein.prepare': 'done' | 'redo' | 'park';
  'candidate.merge': 'done' | 'redo' | 'abort';
  'snapshot.publish': 'done' | 'redo' | 'abort';
  'integration.ff': 'done' | 'redo' | 'recovery-required';
  'resource.transition': 'done' | 'redo';
  'spec.patch': 'done' | 'redo' | 'park';
  'needsuser.raise': 'done' | 'redo';
  'command.apply': 'done' | 'redo';
};

export type Reconciler<K extends OpKind> = (
  intent: IntentOf<K>,
  view: JournalView,
) => Promise<Extract<Disposition<K>, { kind: AllowedDisposition[K] }>>;

export type Reconcilers = { readonly [K in OpKind]: Reconciler<K> };

// ---------------------------------------------------------------------------------------------------
// Git operations: prepare computes every recorded input and the expected new id without moving a ref;
// act performs it after the intent is durable; verify re-reads the postcondition into an outcome.

export interface GitOp<K extends GitOpKind, Request> {
  readonly kind: K;
  prepare(request: Request): Promise<IntentBody<K>>;
  act(intent: IntentOf<K>): Promise<void>;
  verify(intent: IntentOf<K>): Promise<OpOutcome[K]>;
  readonly reconcile: Reconciler<K>;
}
