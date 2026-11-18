// UI-only DTOs, intentionally separate from canonical ObservationData/status. Browser imports types only.
// D1–D11 refer to the source-field register in phase2-plan.md. No executor record/schema changes.
import type { OutsideGroup } from './milestones.ts';
export type { OutsideGroup };
export const CONSOLE_UI_SCHEMA = 2;
export type ViewVersions = Record<'shell' | 'graph' | 'timeline' | 'activity' | 'holistic' | 'effort' | 'resources' | 'attention' | 'endgame', string>;
/** `lastEventAt`: the time of the journal's last event at this position (null for an empty journal). It moves with every event,
 * so it rides on the notice rather than in any view's version. */
export type Metadata = Omit<ViewEnvelope<never>, 'data'> & {uiSchema: number; selected: string | null; lastEventAt: string | null; viewVersions: ViewVersions};
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
  /** The arc's recorded start and end (null while it runs); the last event's time is the notice's `lastEventAt`. */
  availableRange: {from: string | null; to: string | null};
  /** dev.83: where the arc is (status `phase`): in the body, the planned units still open and the milestones awaiting their
   * checkpoint; in the endgame, its step and worklist counts; `episodes`: how many were recorded (the Endgame view exists
   * once one was). */
  phase: ShellPhase;
};
export type ShellPhase =
  | {kind: 'body'; planned: number; milestones: number; episodes: number}
  | {kind: 'endgame'; step: 'settling' | 'open' | 'closing'; episode: number; required: number; optional: number; episodes: number}
  | {kind: 'closed-out'; episodes: number};
export type GraphEdge =
  | {kind: 'after'; source: string; target: string; on: string; met: boolean}
  | {kind: 'milestone'; source: string; target: string; passed: boolean}
  | {kind: 'feeds'; source: string; target: string}
  | {kind: 'contingent'; target: string; edge: string; condition: Preview; resolved: boolean};
export type GraphView = View & {
  /** dev.81: `origin` the plan's (D1); `supersededBy` and `carriedBy` the status line's, what a hidden withdrawn unit's
   * edges are re-pointed to and a shown one is placed beside (D2). */
  units: {id: string; title: string; titleTruncated: boolean; signal: Signal; state: string; stage: string; stageFinished: boolean; systems: string[]; lineageRef: string | null;
    origin: 'planned' | 'repair' | 'polish' | 'deflake'; supersededBy: string | null; carriedBy: string[];
    /** dev.83: what the endgame did with it (status `endgame.units`): held at admission and handed over to the architect,
     * sent back in by `resume`, or closed by a fix (its command and commit); null when the endgame never took it over. */
    endgame: GraphEndgame | null}[];
  /** `signal`: running only while its walkthrough runs or is due on a live arc; a stopped arc runs nothing.
   * Counts and reasons come from console/milestones.ts, the one membership source: `memberIds` every member, `total` the live ones
   * (superseded and cut members are withdrawn, `withdrawn` of them), `merged` the live ones merged. `costUsd`: status summary spend (its units, their re-entries and its walkthroughs). */
  milestones: {id: string; name?: string; state: string; passed: boolean; memberIds: string[]; total: number; merged: number; withdrawn: number; signal: Signal; reason: string | null; costUsd: number}[];
  /** Units in no milestone: the station that is not a gate. Counted as a milestone's members are. */
  noMilestone: {ids: string[]; total: number; merged: number; withdrawn: number};
  /** dev.81 (D1): every unit of `noMilestone`, once, in the group the Graph draws it in, in drawing order (console/milestones.ts `outsideGroups`). */
  groups: OutsideGroup[];
  edges: GraphEdge[];
  focus: {activeIds: string[]; firstUncleared: string | null};
};
export type GraphEndgame = {relation: 'handed-over' | 'released' | 'closed'; command: string | null; commit: string | null};
/** dev.83: one worklist entry. `fixes`: the open episode's fixes naming it (landed or not); `closed`: no longer on the
 * worklist, closed by those fixes. `detail`: the entry's page (a unit's drawer, a finding's opening event), or none. */
export type EndgameEntry = {kind: 'finding' | 'obligation' | 'unit' | 'polish-refused'; id: string; required: boolean; closed: boolean; text: string;
  severity: string | null; detail: DetailRef | null; fixes: {command: string; commit: string; landed: boolean}[]};
export type EndgameRef = {id: string; detail: DetailRef | null};
export type EndgameEpisodeView = {
  episode: number; planRev: number; enteredAt: string | null;
  /** `open` while not left; `reversed` when a planned unit returned the arc to the body; `complete` when the arc completed in it. */
  state: 'open' | 'reversed' | 'complete'; leftAt: string | null;
  opened: {at: string | null; base: string; handover: {text: string | null; truncated: boolean}; advisory: string | null; sizeGuard: boolean} | null;
  fixes: {command: string; at: string | null; commit: string; closes: EndgameRef[]; note: string; landed: boolean}[];
  landings: {job: string; at: string | null; old: string; head: string; lanes: string[]}[];
  reviews: {job: string; at: string | null; from: string; to: string; findings: (EndgameRef & {severity: string | null; claim: string})[]}[];
  jobs: {job: string; request: string; command: string | null; startedAt: string | null; outcome: string | null; detail: string | null}[];
  released: EndgameRef[];
};
/** dev.83: the Endgame view: the phase, the endgame branch and its range, the exit checklist (null unless an opened episode
 * is open), the worklist, the audited range, the current episode (the open one, else the latest) and the earlier ones. */
export type EndgameView = View & {
  phase: ShellPhase;
  branch: string | null; tip: string | null; landed: boolean;
  exit: {key: 'worklist' | 'review' | 'audit' | 'obligations'; label: string; met: boolean}[] | null;
  worklist: EndgameEntry[];
  audited: {from: string; to: string} | null;
  current: EndgameEpisodeView | null;
  history: EndgameEpisodeView[];
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
