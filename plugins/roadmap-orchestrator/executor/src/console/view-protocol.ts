// UI-only DTOs, intentionally separate from canonical ObservationData/status. Browser imports types only.
// D1–D11 refer to the source-field register in phase2-plan.md. No executor record/schema changes.
export const CONSOLE_UI_SCHEMA = 1;
export type ViewVersions = Record<'shell' | 'graph' | 'timeline' | 'activity' | 'holistic' | 'effort' | 'resources' | 'attention', string>;
export type Metadata = Omit<ViewEnvelope<never>, 'data'> & {uiSchema: number; selected: string | null; viewVersions: ViewVersions};
/** The event stream's once-a-second word on an arc that has published: how old the latest published observation is, in the
 * server's clock (`now - checkedAt`, whole milliseconds), and whether the console is behind the arc's journal. No `id:`. */
export type Pulse = {arc: string; asOfAgeMs: number; behind: boolean};
export type Signal = 'passed' | 'active' | 'held' | 'pending' | 'failed' | 'withdrawn';
export type DetailRef = {type: 'unit' | 'invocation' | 'request' | 'event' | 'resource'; id: string};
export type Preview = {text: string; truncated: boolean; detail: DetailRef};
export type Scope = {basis: 'current' | 'recorded-arc'; from: string | null; to: string | null};
export type View = {uiSchema: number; viewVersion: string; scope: Scope};
export type ShellView = View & {
  /** The plan's recorded direction is the Arc's goal in words; bounded here, never derived. */
  identity: {arc: string; direction: {text: string; truncated: boolean} | null};
  lifecycle: {state: string; startedAt: string | null; endedAt: string | null};
  progress: {total: number; countsByState: Record<string, number>; merged: number; withdrawn: number};
  spend: {costUsd: number; estimatedCalls: number; unavailableCalls: number};
  attention: {total: number; blocking: number; informational: number};
  availableRange: {from: string | null; to: string | null};
};
export type GraphEdge =
  | {kind: 'after'; source: string; target: string; on: string; met: boolean}
  | {kind: 'milestone'; source: string; target: string; passed: boolean}
  | {kind: 'feeds'; source: string; target: string}
  | {kind: 'contingent'; target: string; edge: string; condition: Preview; resolved: boolean};
export type GraphView = View & {
  units: {id: string; title: string; titleTruncated: boolean; signal: Signal; state: string; stage: string; stageFinished: boolean; systems: string[]; lineageRef: string | null}[];
  /** `signal`: running only while its walkthrough runs or is due on a live arc; a stopped arc runs nothing.
   * Counts and reasons come from console/milestones.ts, the one membership source: `memberIds` every member, `total` the live ones
   * (superseded and cut members are withdrawn, `withdrawn` of them), `merged` the live ones merged. `costUsd`: status summary spend (its units, their re-entries and its walkthroughs). */
  milestones: {id: string; name?: string; state: string; passed: boolean; memberIds: string[]; total: number; merged: number; withdrawn: number; signal: Signal; reason: string | null; costUsd: number}[];
  /** Units in no milestone: the station that is not a gate. Counted as a milestone's members are. */
  noMilestone: {ids: string[]; total: number; merged: number; withdrawn: number};
  edges: GraphEdge[];
  focus: {activeIds: string[]; firstUncleared: string | null};
};
export type Subject = {type: 'unit' | 'arc' | 'job'; id: string; title: string};
export type Money = {costUsd: number | null; recorded: number; estimated: number; unavailable: number};
export type Interval = {
  id: string; invocation: string; subject: Subject; stage: string; attempt: number; round: number | null;
  actor: {role: string; backend: string | null; model: string | null}; outcome: string;
  startedAt: string; endedAt: string | null; wallMs: number | null; spend: Money;
};
export type RequestSummary = {
  id: string; raisedAt: string; blocking: boolean;
  subject: {type: 'unit'; id: string; title: string} | {type: 'arc' | 'host'} | {type: 'findings'; count: number};
  reason: string; summary: Preview; recommendationPreview: Preview; evidenceCount: number;
};
export type EffortRow = {
  subject: Subject; state: string | null; stage: string | null; systems: string[];
  currentBlockers: {preview: Preview; count: number};
  agentMs: number | null; commandMs: number | null;
  heldMs: number | null; queuedMs: number | null; unallocatedMs: number | null; spend: Money;
  lifetime: {startedAt: string | null; endedAt: string | null; rounds: number; redChecks: number};
};
export type CpuStageGroup = {
  id: string; parent: {type: 'unit' | 'arc' | 'job'; id: string; stage: string | null; attempt: number | null};
  measuredRunMs: number; measuredWallMs: number; reservedCoreMs: number;
  averageCores: number | null; weightedReservedCores: number | null; reservationPercent: number | null;
  measuredCalls: number; excludedCalls: number; unmeasuredCalls: number; zeroWallCalls: number; unreservedCalls: number;
  unreservedAverageCores: number | null; detailKey: string;
};
export type Booking = {
  id: string; resource: string; instance: string | null; holder: {type: string; id: string; unitId?: string};
  startedAt: string; endedAt: string | null; state: 'holding' | 'done'; startSeq: number; endSeq: number | null;
};
export type WaitMeasurement = {
  id: string; subject: Subject; stage: string | null; source: 'admission' | 'reservation'; at: string;
  totalMs: number; heldMs: number; queuedMs: number; unallocatedMs: number;
  reasons: {reason: string; ms: number}[];
};
// Query-specific scopes and anchors extend these row contracts in the tab protocols.
// Server-only collections are never sent as unpaged tab endpoints.
export type StageSummary = {
  id: string; unit: string; stage: string; attempt: number; round: number; at: string; endedAt: string | null;
  outcome: string; housekeeping: boolean; detail: DetailRef;
};
export type HolisticRow =
  /** `verdict`: the audit job's judged result (its campaign-audit stage-outcome: pass, revise or abandoned); null when none was recorded. */
  | {type: 'audit'; id: string; at: string; job: string; outcome: string; verdict: string | null; coverageCount: number; findingCount: number; detail: DetailRef}
  | {type: 'finding'; id: string; claim: Preview; state: string; detail: DetailRef}
  | {type: 'decision'; id: string; seq: number; at: string | null; kind: string; oneLine: Preview; ruledBy: {type: 'architect'; command: string | null} | {type: 'judgment'; role: 'verifier'} | {type: 'executor'}; detail: DetailRef};
export type ResourceNow = {
  queueAvailable: boolean | null;
  queues: {id: string; subject: string; unitId: string | null; queuedAt: string | null; publication: boolean; named: string[]; pools: string[]; cpu: number}[];
  resources: {resource: string; state: string; holder: string | null; pending: boolean}[];
  pools: {id: string; size: number; used: number; dirty: number}[];
  cpuReservation: {used: number; capacity: number} | null;
};

// Shared transport shapes. Anchors/cursors are implemented at the later query boundary, not by row builders.
export type ViewEnvelope<T> = {
  protocol: string; instance: string; repoId: string; arc: string; epoch: string;
  highWater: number; revision: number; observedAt: string; checkedAt: string; data: T;
};
export type Page<T> = {rows: T[]; page: {
  anchor: string; next: string | null; previous: string | null; limit: number; matching: number; returned: number;
  asOf: {epoch: string; highWater: number; observedAt: string};
}};
export type Coverage = {measured: number; unmeasured: number; estimated: number; unavailable: number};
export type TrackMark =
  | {type: 'interval'; id: string; startedAt: string; endedAt: string | null; stage: string; outcome: string; invocation: string}
  | {type: 'cluster'; from: string; to: string; count: number; countsByOutcome: Record<string, number>; subject: string};
export type EffortSort = 'plan' | 'work' | 'spend' | 'elapsed' | 'redChecks' | 'rounds' | 'held' | 'queued';
export type CpuSort = 'unit' | 'utilization' | 'coreTime';
export type WaitingSort = 'reason' | 'duration' | 'count';
export type BookingSort = 'resource' | 'start' | 'duration';
