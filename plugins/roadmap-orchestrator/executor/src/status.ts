// `roadmap status`: DESIGN-1.0.md §2.4's M2 subset, as one agent-facing JSON object.
//
// Read only, from anywhere, while an executor runs or when none does: the log is folded without the host
// lock (`readJournal`: no tail repair, no fact, no cache write), and the run dir's files are only read.
// Nothing here names a model except `spend.byModel`, which looks each seat's model up in its revision's
// routing table at render time: the tables are re-resolved from every plan revision the log applied and the
// repo config under every built-in profile, and a revision none of them yields is listed as unresolved.
// `plan` is the plan in force (its revision and hash, src/input/inforce.ts), and `units` are its units, not
// the live plan.json: an edit nobody applied does not show. `routing` is the routing the latest start's
// profile resolves the plan in force to under the current repo config, as classes per seat with the layer
// that named each and where each class's binding came from: no model.
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
//   parked for the architect, and no blocking needs-user open), no-owner (work remains);
//   a live executor:
//     running   some unit runs, prepares, is ready, waits for resources, or waits only on a draining mutation
//     held      nothing moves, and some unit is held or waits on a pause
//     parked    nothing moves, and a blocking needs-user is open
//     blocked   nothing moves, and work remains (parks being probed, run-only, an unresolved edge, a dead
//               dependency, a tripped breaker)
//     running   otherwise (every unit settled: the executor is about to end)
//
// `needsUser` lists every unacknowledged item: those the log raised, and the file-only ones outside it (the
// supervisor's `sup-<gen>-<n>`, a refused claim's `host-<kind>-<n>`), read from `needs-user/`; an item is
// acknowledged once the log holds its ack fact, as the executor reads it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { terminalReceipt, readCommand } from './commands/queue.ts';
import { type Event, JUDGMENT_STAGES, type JudgmentStage, type Holder, type OperatorParkKind, type ProbeTarget, probeTargetKey } from './core/events.ts';
import { readJson } from './core/fsx.ts';
import {
  type ArcId, CPU_POOL, type CommandId, type EdgeId, type NeedsUserId, type PlanRev, type ResourceUnit, type RoutingRev, type Sha256Hex, type UnitId,
  commandId, compareResourceUnits, cpuToken,
} from './core/ids.ts';
import type { JournalView } from './core/interfaces.ts';
import { readJournal } from './core/log.ts';
import type { Lineage, ResourceEntry, UnitState } from './core/state.ts';
import { legacyNext, legacySettled, warnPlanFromFile } from './core/upgrade.ts';
import { PLAN_INPUT, keptInput, planInForce } from './input/inforce.ts';
import {
  type CommandBody, type ContainmentMode, type NeedsUserReason, type Receipt, type RunStart, type Stage, heartbeat, runStart,
} from './core/records.ts';
import { type AbsPath, type IsoTime, isoTimeOf } from './core/values.ts';
import { HEARTBEAT_FILE, REJECTION_FILE, START_FILE } from './executor.ts';
import { type BlockingItem, blockingItems, fileNeedsUser, holdsUnit, recordOf } from './needsuser.ts';
import { type PlanM1, type PlanUnit, parsePlan } from './input/plan.ts';
import { type ModelTotal, type RoleTotal, type SmokeTotal, byModel, meterOf } from './meter.ts';
import { escalateAt, probeTargets, trippedTargets } from './park/schedule.ts';
import { readRepoConfig } from './preflight/checks.ts';
import { type RejectionFile, rejectionFile } from './preflight/startup.ts';
import { judgmentSeat } from './pipeline/transitions.ts';
import { cpuCapacity, isDirty, poolUnits } from './resources/pool.ts';
import { effectiveDependency } from './schedule/graph.ts';
import { admitter, nextStage, rankOf } from './schedule/ready.ts';
import { type QueueEntry, SCHED_FILE, type SchedFile, schedFile, unitSettled } from './schedule/scheduler.ts';
import type { AdmissionConstraint, Rank, ResourceRequest } from './schedule/types.ts';
import { type ResolvedRouting, type SeatSources, arcStack, resolveRouting } from './routing/layers.ts';
import {
  type Backend, type ClassSource, type ClassTable, type ModelClass, PROFILES, type ProfileName, type RiskTier, type SeatRef,
  type RoutingTable,
} from './routing/types.ts';
import { readClaim } from './host/lock.ts';
import { isAlive } from './host/liveness.ts';
import { readOwner } from './host/owner.ts';

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

export type ArcState = 'running' | 'held' | 'parked' | 'blocked' | 'complete' | 'refused' | 'no-owner';

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

/** A probe target with current parks: the park seqs a probe now covers, its backoff, last result and breaker. */
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
    /** Start-up smokes per backend: in neither `byRole` nor `byModel`. */
    bySmoke: readonly SmokeTotal[];
  }>;
  host: HostView;
  parkedBackends: readonly Backend[];
  /** The plan in force: its revision and plan.json hash; null before a start recorded one. */
  plan: Readonly<{ rev: PlanRev; planSha256: Sha256Hex }> | null;
  /** Null before any start. */
  routing: RoutingView | null;
  rejection: RejectionFile | null;
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

function commandsOf(runDir: AbsPath, arc: ArcId): Status['commands'] {
  const dir = join(runDir, 'commands', 'incoming');
  const ids = existsSync(dir) ? readdirSync(dir).flatMap((n) => (/^cmd-[0-9a-f]{16}\.json$/.test(n) ? [commandId(n.slice(0, -5))] : [])).sort() : [];
  const pending: { id: CommandId; type: CommandBody['type'] }[] = [];
  const receipts: Receipt[] = [];
  for (const id of ids) {
    const r = terminalReceipt(runDir, id);
    if (r === null) pending.push({ id, type: readCommand(runDir, id, arc).file.body.type });
    else receipts.push(r);
  }
  return { pending, receipts: receipts.slice(-RECEIPTS_SHOWN) };
}

/** Every built-in profile's table over each plan revision (`plans`) and the repo config, by revision. */
function routingTables(start: Readonly<{ record: RunStart; plan: PlanM1 }> | null, plans: readonly PlanM1[]): ReadonlyMap<RoutingRev, RoutingTable> {
  if (start === null) return new Map();
  const config = readRepoConfig(start.record.repo);
  return new Map([start.plan, ...plans].flatMap((plan) => PROFILES.map((profile) => {
    const r = resolveRouting(arcStack(profile, config, plan.routing ?? null));
    return [r.rev, r.table] as const;
  })));
}

/** Every plan revision the log applied, from the kept bytes, in log order. */
function appliedPlans(runDir: AbsPath, events: readonly Event[]): readonly PlanM1[] {
  return events.flatMap((e) => {
    if (e.type !== 'fact' || e.fact.kind !== 'plan-applied') return [];
    const bytes = keptInput(runDir, e.fact.planSha256, PLAN_INPUT);
    if (bytes === null) throw new Error(`plan revision ${e.fact.rev} is ${e.fact.planSha256}, which the run dir does not keep`);
    return [parsePlan(JSON.parse(bytes.toString('utf8')))];
  });
}

function routingView(start: Readonly<{ record: RunStart }>, r: ResolvedRouting): RoutingView {
  return { profile: start.record.profile, rev: r.rev, seats: r.classes, sources: r.sources, bindings: r.bindings };
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

const holderUnit = (h: Holder): UnitId | null => (h.type === 'sweep' ? null : h.unit);

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
  /** The routing in force, for admission's backend constraints; null before any start. */
  routing: RoutingTable | null;
  legacy: boolean;
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
  const next = nextStage(u);
  if (next?.kind === 'admission' && x.routing !== null) {
    const a = admitter(x.routing)({
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
  if (owner.state === 'alive') {
    if (lines.some(moving)) return 'running';
    if (lines.some((l) => l.state === 'held')) return 'held';
    if (blocking.length > 0) return 'parked';
    if (lines.some((l) => !unitSettled(view, l.unit))) return 'blocked';
    return 'running';
  }
  if (rejection !== null) return 'refused';
  const settled = lines.length > 0 && lines.every((l) => unitSettled(view, l.unit));
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
  events: readonly Event[];
  view: JournalView;
  plan: PlanM1 | null;
  start: Readonly<{ record: RunStart; plan: PlanM1 }> | null;
  inForce: ReturnType<typeof planInForce>;
  resolved: ResolvedRouting | null;
  owner: OwnerState;
  rejection: RejectionFile | null;
  blocking: readonly BlockingItem[];
  sched: SchedFile | null;
  units: readonly UnitStatusLine[];
  state: ArcState;
}>;

/** The log folded, the plan in force, and every unit's line with the run's state: what `status` and `watch` share. */
function derive(runDir: AbsPath, arc: ArcId, hostDir: AbsPath): Derived {
  const { view, events } = readJournal(runDir, arc);
  const record = readIf(join(runDir, START_FILE), runStart);
  const inForce = planInForce(runDir, view);
  const plan = inForce?.plan ?? (record === null ? null : planFile(arc, record.planFile));
  const start = record === null || plan === null ? null : { record, plan };
  const rejection = readIf(join(runDir, REJECTION_FILE), rejectionFile);
  const owner = ownerState(runDir, hostDir);
  const sched = liveSched(runDir, arc, owner);
  const blocking = blockingItems(runDir, view);
  const resolved = start === null ? null : resolveRouting(arcStack(start.record.profile, readRepoConfig(start.record.repo), start.plan.routing ?? null));
  const scheduling = view.scheduling();
  const inputs: Inputs | null = plan === null || scheduling === null ? null : {
    view, plan, sched, alive: owner.state === 'alive', blocking, routing: resolved?.table ?? null, legacy: scheduling === 'legacy',
  };
  const starts = attemptStarts(events);
  const now = Date.now();
  const units = inputs === null ? [] : inputs.plan.units.map((u) => unitLine(inputs, u, starts, now));
  return { events, view, plan, start, inForce, resolved, owner, rejection, blocking, sched, units, state: runStateOf(view, units, owner, blocking, rejection) };
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

export function status(runDir: AbsPath, arc: ArcId, hostDir: AbsPath): Status {
  const d = derive(runDir, arc, hostDir);
  const { view, events, start, inForce } = d;
  const meter = meterOf(events);
  const tables = routingTables(start, appliedPlans(runDir, events));
  const resolvable = meter.bySeat.filter((t) => tables.has(t.routingRev));
  const unresolvedRevs = [...new Set(meter.bySeat.filter((t) => !tables.has(t.routingRev)).map((t) => t.routingRev))].sort();

  return {
    arc,
    run: { state: d.state, owner: d.owner, heartbeatAt: readIf(join(runDir, HEARTBEAT_FILE), heartbeat)?.at ?? null },
    units: d.units,
    edges: d.plan === null || view.scheduling() === null ? [] : edgesOf(view, d.plan),
    runOnly: view.runOnly(),
    legacy: view.scheduling() === 'legacy',
    needsUser: [
      ...view.needsUser().filter((n) => n.ack === null).map((n) => ({ id: n.id, reason: recordOf(runDir, n.id).reason, blocking: n.blocking })),
      ...fileNeedsUser(runDir, view).map((r) => ({ id: r.id, reason: r.reason, blocking: r.blocking })),
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    commands: commandsOf(runDir, arc),
    spend: { byRole: meter.byRole, byModel: { models: byModel(resolvable, tables), unresolvedRevs }, bySmoke: meter.bySmoke },
    host: {
      containment: { mode: view.containmentMode(), guarantee: SESSION_GUARANTEE },
      resources: hostResources(view),
      pools: d.plan === null ? {} : pools(view, d.plan),
      queue: d.sched?.queue ?? [],
      probes: probesOf(view),
      backends: view.backendParks().map((b) => ({ backend: b.backend, parkSeq: b.seq, class: b.class })),
    },
    parkedBackends: view.parkedBackends(),
    plan: inForce === null ? null : { rev: inForce.rev, planSha256: inForce.manifest.planSha256 },
    routing: start === null || d.resolved === null ? null : routingView(start, d.resolved),
    rejection: d.rejection,
  };
}
