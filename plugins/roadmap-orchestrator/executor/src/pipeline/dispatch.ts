// Dispatch: who acts for a unit, on which seat, under which pinned authority, and the backend call that
// puts them to work (plan "Authority", R2; DESIGN-1.0.md §4 Independence, Actors are roles).
//
// - The dispatch record (a `dispatch` fact) pins the unit's scope envelope and risk floor once, with the
//   unit's routingRev in force and the hash of the implementer seat's triple (`implementerSeatRev`). A plan-check
//   that raises the risk re-pins it with a new fact (same scope, higher floor); nothing lowers it. The scope grows
//   only by a ruled scope-growth apply (src/input/classify.ts), which the next dispatch check re-pins; the fold
//   refuses any other change of it.
// - M3: the routing is the unit's (`StageContext.routing(unit)`: the arc's stack with the unit's `route` or
//   `steer --class` layer on top, src/routing/layers.ts). Every record since 1.0.0-dev.6 pins the unit's bounds
//   (`bounds`: `boundsOf` its plan `limits`, the transition table's counters and the backend windows) and the
//   transient rules its candidate runs under (`transientRules: 'm3'`, H15). A `limits` or scope-growth revision
//   re-pins at the next dispatch check, as a routing change does; a re-pin copies `transientRules`.
// - A routing change mid-unit (a new routingRev at a later dispatch; lead ruling, arc-1 feedback item 7):
//   every judgment is a fresh session, so a judgment seat may change harmlessly; the implementer's session
//   resumes, so its session key (`implementerSessionKey`: backend and model, R4) may not change. The unit is re-pinned
//   under the new rev (a new dispatch fact, scope and floor unchanged) when no build has started for it or its
//   implementer seat keeps its key under both revs (an effort-only change re-pins, and the session resumes with the new
//   `--effort`; OR-L3); otherwise the stage parks it (`routing-changed`) with a needs-user naming the seat, never a
//   model. The pinned seat's triple is read back from its `implementerSeatRev` (`seatTripleOf`).
//   A steer round (R11) starts a fresh implementer session, so it re-pins whatever the seat (`steerDispatch`):
//   `steer --class` moves the implementer seat on purpose.
// - Seats: the implementer sits on the unit's risk tier for the whole unit (it keeps its model); a
//   judgment stage sits on `judgmentSeat` (transitions.ts): the role's `escalation` seat once it routed up
//   (for the rest of the unit) or while a risk trigger is pending (the next judgment dispatch only).
// - The backend call: prompt text and schema are content-addressed input files written before the spawn
//   intent; the launch names the role and routingRev, never the model, except in argv (launch.json is the
//   one executor-written file allowed a model id). The workload env is `backendEnv(host)`; the implementer's
//   adds the unit's owner label and the pool instances its build holds (F7), so whatever it starts carries them.
// - The verdict: a cancel for pause or stop is an interruption, not a fault; a failed call whose backend
//   reported a usage limit or capacity error parks that backend arc-wide (`backend-park`, its seq the park's
//   epoch) and holds the stage with that park as the hold's cause (G5; lead ruling: outcome != success AND
//   class in {usage-limit, capacity}); platform or backend error entries on a success are informational.
// - An implementer call that resumes a session and ends `process-fault` with no complete JSON line on stdout
//   never had its session persisted (`sessionNeverPersisted`; rounds.ts `callRound` re-runs it fresh).
// - M3 (LR-d): the arc roles' call (`callArcRole`): a lens of an audit or a checkpoint, a job's fresh read-only session
//   on the judgment profile at the role's one seat `arc` of the arc's routing, spawned as `arc-backend` under `job{job}`
//   and metered to the job by role and routingRev. A resumed job reads a call it made back (`recordedArcCall`); its
//   verdict is read as a unit judgment's (`verdictOf` takes a job parent: a usage limit parks the backend arc-wide).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BackendCall, type ClaudeTriple, type CodexTriple, backendArgv, freshJudgmentSession, promptBytes } from '../backends/argv.ts';
import {
  BACKEND_PARK_CLASSES, type BackendParkClass, type HoldCause, type IntentOf, type JudgmentStage, type OpKind, type OpOutcome, type Parent,
} from '../core/events.ts';
import { type ArcId, type InvocationId, type JobId, type RoutingRev, type SeatRev, type UnitId, invocationId, opKey, seatRev } from '../core/ids.ts';
import type { IntentBody, Journal, JournalView } from '../core/interfaces.ts';
import type { SpecState } from '../core/state.ts';
import { type JsonValue, canonicalJson, sha256Hex } from '../core/json.ts';
import {
  type BackendErrorClass, type BackendResult, type Bounds, type DispatchRecord, type ImplementerSession, type JudgmentSession, type LaunchTerminal, STDERR_FILE,
  STDOUT_FILE, type NeedsUserContent, boundsOfRecord,
} from '../core/records.ts';
import { type AbsPath, type BranchName, type IsoTime, type RefName, type RepoPattern, absPath, branchName, isoTimeOf, refName } from '../core/values.ts';
import { inputPath, keepInput } from '../input/inforce.ts';
import { type PlanUnit, boundsOf } from '../input/plan.ts';
import { backendEnv, CODEX_OUTPUT_FILE } from '../preflight/smoke.ts';
import { instanceEnv } from '../resources/pool.ts';
import { type ResourceContext, type UnitAcquiringHolder, holderUnits } from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import { routingChangedRecommendation } from '../needsuser.ts';
import {
  type ArcRole, type ArcSeatRef, type Backend, CLAUDE_EFFORTS, CLAUDE_MODELS, CODEX_EFFORTS, CODEX_MODELS, RISK_TIERS, type Triple, type JudgmentRole, type JudgmentSeat, type RiskTier, type Role, type UnitSeatRef, seatRef,
} from '../routing/types.ts';
import { runnerFiles } from '../runner/files.ts';
import type { Acquire, Rank, ResourceRequest } from '../schedule/types.ts';
import { abortReason } from './redlane.ts';
import { type LaunchSpec, type SpawnOrigin, invocationDir, invoke } from './invoke.ts';
import { judgmentSeat } from './transitions.ts';

/**
 * Everything a unit's stages need: processes, resources, the resolved routing and the host environment. In the
 * executor `plan()` and `routing(unit)` are the plan in force and a unit's routing in force (the arc's for null),
 * read from the log at each call (src/executor.ts `contexts`).
 */
export type StageContext = ResourceContext & Readonly<{
  /** A unit's routing in force: the arc's stack with the unit's own layer on top (layers.ts); the arc's for null. */
  routing: (unit: UnitId | null) => ResolvedRouting;
  /** The executor's own environment; backends get `backendEnv(hostEnv)`, lanes their declared `pass` names. */
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** The plan file's directory: unit spec paths and the rulings ledger are relative to it. */
  planDir: AbsPath;
  /**
   * How a stage takes a reservation (its entry reservation, a lane's set, a publication): the scheduler's
   * arbiter (`createArbiter(...).acquire`), or in a test `reserveNow` (lanes.ts), which grants at once and fails
   * loud on a busy resource.
   */
  acquire: Acquire;
  /** The rank a unit's waiter is served by, read fresh at each arbiter evaluation (`rankOf` over the log). */
  rank: (unit: UnitId) => Rank;
  /**
   * The unit's task signal, aborted with reason `pause` or `stop` (`abortReason`, redlane.ts): it cancels a
   * stage's waits (an entry reservation, a later lane's set, a clear host). Never aborted outside a unit's task.
   */
  signal: AbortSignal;
}>;

/** Whole minutes (a bound's unit) in milliseconds. */
export const minutesMs = (min: number): number => min * 60_000;

/** A judgment's deadline per invocation: the unit's pinned `judgmentDeadlineMin` (default 45, unmeasured). */
export const judgmentDeadlineMs = (record: DispatchRecord): number => minutesMs(boundsOfRecord(record).judgmentDeadlineMin);
/** Grace between TERM and KILL when a backend workload is ended. */
export const BACKEND_GRACE_MS = 10_000;

// ---------------------------------------------------------------------------------------------------
// The dispatch record

const now = (): IsoTime => isoTimeOf(new Date());

/** The hash of the implementer seat's triple for risk `floor` under `routing`. */
export function implementerSeatRev(routing: ResolvedRouting, floor: RiskTier): SeatRev {
  return tripleSeatRev(routing.table.build[floor]);
}

const tripleSeatRev = (triple: Triple): SeatRev => seatRev(sha256Hex(canonicalJson(triple)).slice(0, 16));

/** Every triple the closed `Triple` union admits, by its seat rev: a seat rev names exactly one (test dispatch.seat-triples). */
export const SEAT_TRIPLES: ReadonlyMap<SeatRev, Triple> = new Map([
  ...CLAUDE_MODELS.flatMap((model) => CLAUDE_EFFORTS.map((effort): Triple => ({ backend: 'claude', model, effort }))),
  ...CODEX_MODELS.flatMap((model) => CODEX_EFFORTS.map((effort): Triple => ({ backend: 'codex', model, effort }))),
].map((t) => [tripleSeatRev(t), t]));

/**
 * The triple a pinned `implementerSeatRev` hashes (R4). The seat rev is a hash over a closed, finite set of triples, so it
 * is read back by lookup whatever routing (or release: a 1.0.0-dev.6 record included) pinned it. A rev no triple hashes
 * to is a bug.
 */
export function seatTripleOf(rev: SeatRev): Triple {
  const triple = SEAT_TRIPLES.get(rev);
  if (triple === undefined) throw new Error(`implementer seat rev ${rev} is the hash of no triple`);
  return triple;
}

/** What an implementer session is bound to (R4): its backend and model. Effort is a per-call flag, so it is not part of it. */
export type ImplementerSessionKey = Readonly<{ backend: Backend; model: Triple['model'] }>;
export const implementerSessionKey = (t: Triple): ImplementerSessionKey => ({ backend: t.backend, model: t.model });

/** Whether a session that ran on `a` may resume on `b`: the same session key. */
export function sameSession(a: Triple, b: Triple): boolean {
  return same(implementerSessionKey(a), implementerSessionKey(b));
}

/**
 * A dispatch the routing in force allows, or the park of a unit whose implementer seat a routing change
 * moved after its build started: the stage records `routing-changed` with this needs-user.
 */
export type Pinned<D> = Readonly<{ kind: 'pinned'; dispatch: D }> | Readonly<{ kind: 'routing-changed'; needsUser: NeedsUserContent }>;

function routingChanged(record: DispatchRecord): Pinned<never> {
  const seat = `build.${record.riskFloor}`;
  return {
    kind: 'routing-changed',
    needsUser: {
      blocking: true,
      subject: { type: 'unit', unit: record.unit },
      reason: 'routing-changed',
      summary: `Unit ${record.unit}: the routing changed since it was dispatched (routingRev ${record.routingRev}), and its implementer seat `
        + `${seat} now resolves to a different backend or model. Its build session resumes on its seat, so it cannot move mid-unit.`,
      recommendation: routingChangedRecommendation(record.unit, record.riskFloor),
      options: [],
      evidence: [],
    },
  };
}

/** Whether any implementer call was ever started for `unit`. */
function buildStarted(view: JournalView, unit: UnitId): boolean {
  return view.opsOf('proc.spawn').some((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build' && i.expect.subject.unit === unit);
}

/**
 * `record` re-pinned under `routing` (a new dispatch fact, same scope and floor) when the unit can absorb the
 * change: no build has started for it, or the seat it builds on (`build.<buildTier>`) keeps its session key (R4: an
 * effort-only change is absorbed, and the session resumes with the new effort); null when it cannot. On the floor the
 * seat is the pinned `implementerSeatRev` (`seatTripleOf`). An escalated unit (A11) no longer
 * builds on its floor, so a change there is absorbed; its `build.high` seat is not pinned, and its session
 * resumes only under the routing it ran on (rounds.ts `spawnSeatRev`), else a fresh one is told the worktree
 * holds the work. The stages call it when the rev in force differs from the pinned one, and so does
 * `resume <unit>` of a unit parked `routing-changed` (commands/apply.ts).
 */
export function repin(journal: Journal, routing: ResolvedRouting, record: DispatchRecord, update: PinUpdate = {}): DispatchRecord | null {
  const seat = routing.table.build[update.riskFloor ?? record.riskFloor];
  const onFloor = (journal.view.unit(record.unit).buildTier ?? record.riskFloor) === record.riskFloor;
  if (onFloor && !sameSession(seatTripleOf(record.implementerSeatRev), seat) && buildStarted(journal.view, record.unit)) return null;
  return pin(journal, routing, record, update);
}

/**
 * What a re-pin changes besides the routing: the bounds a `limits` revision set, a ruled scope growth, a risk the plan
 * raised above the floor (`route`: risk may rise).
 */
export type PinUpdate = Readonly<{ bounds?: Bounds; scope?: readonly RepoPattern[]; riskFloor?: RiskTier }>;

/** Records `record` re-pinned under `routing` with `update` (a new dispatch fact), whatever its implementer seat. */
function pin(journal: Journal, routing: ResolvedRouting, record: DispatchRecord, update: PinUpdate): DispatchRecord {
  const riskFloor = update.riskFloor ?? record.riskFloor;
  const next: DispatchRecord = {
    ...record, ...update, routingRev: routing.rev, implementerSeatRev: implementerSeatRev(routing, riskFloor), at: now(),
  };
  journal.fact({ kind: 'dispatch', record: next });
  return next;
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * What the plan in force changes of `record` besides its routing: the unit's bounds (a `limits` revision), and its
 * scope once a ruled scope-growth apply grew it (the classifier refuses any other scope change of a dispatched unit,
 * so a plan scope that does not contain the pinned one is a bug).
 */
function pinUpdate(ctx: StageContext, record: DispatchRecord): PinUpdate {
  const unit = ctx.plan().units.find((u) => u.id === record.unit);
  if (unit === undefined) throw new Error(`unit ${record.unit} is dispatched but not in the plan in force`);
  const bounds = boundsOf(ctx.plan(), unit);
  const scope = [...unit.scope].sort();
  if (record.scope.some((p) => !scope.includes(p))) {
    throw new Error(`unit ${record.unit}: the plan in force scopes it ${scope.join(', ')}, which drops part of its pinned scope ${record.scope.join(', ')}`);
  }
  return {
    ...(same(bounds, boundsOfRecord(record)) ? {} : { bounds }), ...(same(scope, record.scope) ? {} : { scope }),
    ...(riskAbove(unit.risk, record.riskFloor) ? { riskFloor: unit.risk } : {}),
  };
}

const unchanged = (update: PinUpdate): boolean => update.bounds === undefined && update.scope === undefined && update.riskFloor === undefined;

/** `record` under the plan and routing in force: itself when neither changed it; else re-pinned, or the park. */
function inForce(ctx: StageContext, record: DispatchRecord): Pinned<DispatchRecord> {
  const routing = ctx.routing(record.unit);
  const update = pinUpdate(ctx, record);
  if (record.routingRev === routing.rev && unchanged(update)) return { kind: 'pinned', dispatch: record };
  const next = repin(ctx.journal, routing, record, update);
  return next === null ? routingChanged(record) : { kind: 'pinned', dispatch: next };
}

/**
 * The unit's dispatch record under the plan and routing in force: the latest `dispatch` fact (re-pinned if the
 * routing, the bounds or the scope changed and the unit can absorb it), or the first one, recorded now
 * (`firstPin`) from the plan (scope envelope and Phase-0 risk floor) and the spec revision being dispatched.
 */
export function pinDispatch(ctx: StageContext, unit: PlanUnit, spec: SpecState): Pinned<DispatchRecord> {
  const current = ctx.journal.view.dispatchOf(unit.id);
  if (current !== null) return inForce(ctx, current);
  const record = firstPin(ctx, unit, spec, unit.risk);
  ctx.journal.fact({ kind: 'dispatch', record });
  return { kind: 'pinned', dispatch: record };
}

/**
 * A unit's first dispatch record at risk floor `riskFloor`: its plan scope, its routing in force, its bounds (`boundsOf`
 * the plan in force) and the M3 transient rules (H15). prepare.ts pins a re-entry with it too.
 */
export function firstPin(ctx: StageContext, unit: PlanUnit, spec: SpecState, riskFloor: RiskTier): DispatchRecord {
  const routing = ctx.routing(unit.id);
  return {
    unit: unit.id, specRev: spec.rev, specSha256: spec.sha256, scope: [...unit.scope].sort(), riskFloor, routingRev: routing.rev,
    implementerSeatRev: implementerSeatRev(routing, riskFloor), at: now(), transientRules: 'm3', bounds: boundsOf(ctx.plan(), unit),
  };
}

/** The pinned record, which every stage after plan-check requires. */
export function dispatchOf(view: JournalView, unit: UnitId): DispatchRecord {
  const record = view.dispatchOf(unit);
  if (record === null) throw new Error(`unit ${unit} has no dispatch record: plan-check pins it first`);
  return record;
}

export const riskAbove = (a: RiskTier, b: RiskTier): boolean => RISK_TIERS.indexOf(a) > RISK_TIERS.indexOf(b);

/**
 * A plan-check raised the risk: re-pin with the same scope and the higher floor (a new dispatch fact) at the
 * spec it read, under the routing in force, so the implementer seat's hash is the raised seat's.
 */
export function raiseRisk(ctx: StageContext, record: DispatchRecord, risk: RiskTier, spec: SpecState): DispatchRecord {
  if (!riskAbove(risk, record.riskFloor)) throw new Error(`raiseRisk: ${risk} is not above the floor ${record.riskFloor} of ${record.unit}`);
  const routing = ctx.routing(record.unit);
  const next: DispatchRecord = {
    ...record, specRev: spec.rev, specSha256: spec.sha256, riskFloor: risk, routingRev: routing.rev, implementerSeatRev: implementerSeatRev(routing, risk), at: now(),
  };
  ctx.journal.fact({ kind: 'dispatch', record: next });
  return next;
}

// ---------------------------------------------------------------------------------------------------
// Seats

export type JudgmentDispatch = Readonly<{ role: JudgmentRole; tier: JudgmentSeat; triple: ClaudeTriple; routingRev: RoutingRev }>;
/** `seatRev`: the pinned `implementerSeatRev`, the hash of `triple`: a session resumes only on its session key (R4). */
export type ImplementerDispatch = Readonly<{ role: 'build'; tier: RiskTier; triple: ClaudeTriple | CodexTriple; routingRev: RoutingRev; seatRev: SeatRev }>;

const ROLE_OF: Readonly<Record<JudgmentStage, JudgmentRole>> = { 'plan-check': 'planCheck', gate: 'gate' };

/** The seat of a judgment dispatch: the unit's risk, or the escalation seat after a route-up or a risk trigger. */
export function judgmentDispatch(ctx: StageContext, unit: UnitId, stage: JudgmentStage): Pinned<JudgmentDispatch> {
  const pinned = inForce(ctx, dispatchOf(ctx.journal.view, unit));
  if (pinned.kind !== 'pinned') return pinned;
  const role = ROLE_OF[stage];
  const tier = judgmentSeat(ctx.journal.view.unit(unit), stage);
  const triple = ctx.routing(unit).table[role][tier];
  // Startup refuses every Codex judgment seat (unsupported-routing), so this is a bug if it happens.
  if (triple.backend !== 'claude') throw new Error(`the ${role} seat ${tier} resolves to ${triple.backend}; judgment is Claude only in M1`);
  return { kind: 'pinned', dispatch: { role, tier, triple, routingRev: pinned.dispatch.routingRev } };
}

/**
 * The implementer's seat: the unit's build tier (`UnitState.buildTier`), which is its (possibly plan-check-raised)
 * risk floor until an `implementer-escalated` fact moves it to `high` (A11, G1: journaled by
 * `escalateImplementer` before this is called). On the floor the seat's rev is the pinned `implementerSeatRev`;
 * escalated, it is `build.high`'s under the routing in force.
 */
export function implementerDispatch(ctx: StageContext, unit: UnitId): Pinned<ImplementerDispatch> {
  const pinned = inForce(ctx, dispatchOf(ctx.journal.view, unit));
  return pinned.kind === 'pinned' ? { kind: 'pinned', dispatch: seated(ctx, pinned.dispatch) } : pinned;
}

/**
 * The implementer's seat for a steer round (R11): its session is fresh, so the unit is re-pinned under the plan and
 * routing in force whatever its implementer seat (`steer --class` moves the seat on purpose; a later round resumes
 * the steer session on the new seat).
 */
export function steerDispatch(ctx: StageContext, unit: UnitId): ImplementerDispatch {
  const record = dispatchOf(ctx.journal.view, unit);
  const routing = ctx.routing(unit);
  const update = pinUpdate(ctx, record);
  const kept = record.routingRev === routing.rev && unchanged(update);
  return seated(ctx, kept ? record : pin(ctx.journal, routing, record, update));
}

/** The implementer's seat under a pinned record: its build tier, on the floor's pinned seat or `build.<tier>`'s. */
function seated(ctx: StageContext, record: DispatchRecord): ImplementerDispatch {
  const { unit, riskFloor, routingRev, implementerSeatRev: floorSeat } = record;
  const tier = ctx.journal.view.unit(unit).buildTier;
  if (tier === null) throw new Error(`unit ${unit} is dispatched but has no build tier`);
  const routing = ctx.routing(unit);
  const seat = tier === riskFloor ? floorSeat : implementerSeatRev(routing, tier);
  return { role: 'build', tier, triple: routing.table.build[tier], routingRev, seatRev: seat };
}

// ---------------------------------------------------------------------------------------------------
// The backend call

export type BackendRequest =
  | Readonly<{ kind: 'judgment'; dispatch: JudgmentDispatch; session: JudgmentSession; evidenceDirs: readonly AbsPath[] }>
  | Readonly<{ kind: 'implementer'; dispatch: ImplementerDispatch; session: ImplementerSession; evidenceDirs: readonly AbsPath[] }>;

export type BackendCallSpec = Readonly<{
  unit: UnitId;
  parent: Extract<Parent, { type: 'stage' }>;
  request: BackendRequest;
  system: string;
  rendered: string;
  schema: JsonValue;
  /** The session's working directory: the tree a judge reads, or the worktree an implementer edits. */
  cwd: AbsPath;
  deadlineAt: IsoTime;
}>;

export type BackendCallOutcome =
  | Readonly<{ kind: 'result'; inv: InvocationId; invDir: AbsPath; result: BackendResult }>
  /** Lost with its runner (no exit.json); `treeEffects`: its workload was started, so it may have changed the tree. */
  | Readonly<{ kind: 'lost'; inv: InvocationId; invDir: AbsPath; treeEffects: boolean }>;

/** Keeps `text` once under `<runDir>/inputs/<sha256>.<ext>` (`keepInput`) and returns its path. */
export function inputFile(runDir: AbsPath, text: string, ext: string): AbsPath {
  return inputPath(runDir, keepInput(runDir, Buffer.from(text, 'utf8'), ext), ext);
}

function call(spec: BackendCallSpec, schemaText: string, schemaPath: AbsPath, invDir: AbsPath): BackendCall {
  const r = spec.request;
  if (r.kind === 'judgment') {
    return { kind: 'claude-judgment', role: r.dispatch.role, triple: r.dispatch.triple, session: r.session, schemaText, system: spec.system, evidenceDirs: r.evidenceDirs };
  }
  const { triple } = r.dispatch;
  const s = r.session;
  if (triple.backend === 'claude') {
    if (s.backend !== 'claude') throw new Error(`a ${s.backend} session on the Claude implementer seat`);
    return { kind: 'claude-build', triple, session: s, schemaText, system: spec.system, evidenceDirs: r.evidenceDirs };
  }
  if (s.backend !== 'codex') throw new Error(`a ${s.backend} session on the Codex implementer seat`);
  return { kind: 'codex-build', triple, session: s, cwd: spec.cwd, outputPath: absPath(join(invDir, CODEX_OUTPUT_FILE)), schemaPath, system: spec.system };
}

function terminal(spec: BackendCallSpec, c: BackendCall, schemaPath: AbsPath, invDir: AbsPath): LaunchTerminal {
  const base = { type: 'backend', purpose: 'backend', routingRev: spec.request.dispatch.routingRev, schemaPath } as const;
  const stdout = absPath(join(invDir, STDOUT_FILE));
  switch (c.kind) {
    case 'claude-judgment':
      return { ...base, outputPath: stdout, role: c.role, session: c.session };
    case 'claude-build':
      return { ...base, outputPath: stdout, role: 'build', session: c.session };
    case 'codex-build':
      return { ...base, outputPath: c.outputPath, role: 'build', session: c.session };
  }
}

/** `RESOURCE_INSTANCE_<POOL>` for each pool instance the build attempt `parent` holds (none outside a build). */
function buildInstanceEnv(ctx: StageContext, parent: StageParent): Readonly<Record<string, string>> {
  if (parent.stage !== 'build') return {};
  return instanceEnv(holderUnits(ctx.journal.view, { type: 'stage', unit: parent.unit, stage: 'build', attempt: parent.attempt }));
}

/**
 * An implementer call that resumed a session (a fix, resume, resolve or continue round, or a reopen's respec
 * round) and ended `process-fault` with no complete JSON line on its stdout: the CLI never got as far as its
 * session, so the session it was told to resume was never persisted. Such a round re-runs once, uncharged, as a
 * fresh session on the kept worktree (rounds.ts `callRound`). A fresh session has nothing to resume.
 */
export function sessionNeverPersisted(spec: BackendCallSpec, called: BackendCallOutcome): boolean {
  const { request } = spec;
  if (request.kind !== 'implementer' || request.session.mode !== 'resume') return false;
  if (called.kind !== 'result' || called.result.outcome.kind !== 'process-fault') return false;
  const path = join(called.invDir, STDOUT_FILE);
  return !existsSync(path) || !readFileSync(path, 'utf8').split('\n').slice(0, -1).some(isJsonLine);
}

/** A line holding one JSON object or array: an event or result a backend prints. */
function isJsonLine(line: string): boolean {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/**
 * One backend call of a unit's stage, through `invoke` (proc.spawn{purpose: backend}). A call lost with its
 * runner is retried once, uncharged, as the op's next invocation with the same deadline (the plan's
 * recovery table); the outcome is the retry's. An implementer call that may have changed the tree is not
 * retried: its work is salvaged and verified (`lost-tree-effects`).
 */
export async function callBackend(ctx: StageContext, spec: BackendCallSpec): Promise<BackendCallOutcome> {
  const r = spec.request;
  const seat: UnitSeatRef = r.kind === 'judgment' ? { role: r.dispatch.role, tier: r.dispatch.tier } : { role: 'build', tier: r.dispatch.tier };
  const role: Role = seat.role;
  const schemaText = canonicalJson(spec.schema);
  const schemaPath = inputFile(ctx.runDir, `${schemaText}\n`, 'schema.json');
  // promptBytes reads only the call's kind and system text, neither of which depends on the invocation dir.
  const stdin = inputFile(ctx.runDir, promptBytes(call(spec, schemaText, schemaPath, ctx.runDir), spec.rendered), 'prompt.txt');
  // Only the implementer may create resources (its builds run the unit's tooling); a judgment holds none. It
  // is bound to the pool instances its build holds (F7), as its lanes, probes and teardowns are.
  const env = role === 'build' ? { ...backendEnv(ctx.hostEnv), [OWNER_ENV]: ownerLabel(ctx.plan().arc, spec.unit), ...buildInstanceEnv(ctx, spec.parent) } : backendEnv(ctx.hostEnv);
  const launch = (origin: SpawnOrigin): LaunchSpec => ({
    runDir: ctx.runDir,
    origin,
    subject: { purpose: 'backend', ...seat, routingRev: spec.request.dispatch.routingRev, unit: spec.unit, attempt: spec.parent.attempt },
    launch: (invDir) => {
      const c = call(spec, schemaText, schemaPath, invDir);
      return { argv: backendArgv(c), cwd: spec.cwd, env, stdinPath: stdin, stallMs: null, graceMs: BACKEND_GRACE_MS, terminal: terminal(spec, c, schemaPath, invDir) };
    },
  });
  const key = opKey(`backend:${spec.unit}:${spec.parent.stage}`);
  const first = await invoke(ctx.journal, ctx.containment, launch({ type: 'new', key, parent: spec.parent, deadlineAt: spec.deadlineAt }));
  const retry = first.kind === 'lost' && !(role === 'build' && first.treeEffects);
  const outcome = retry ? await invoke(ctx.journal, ctx.containment, launch({ type: 'retry', op: first.op })) : first;
  const invDir = invocationDir(ctx.runDir, outcome.inv);
  if (outcome.kind === 'lost') return { kind: 'lost', inv: outcome.inv, invDir, treeEffects: outcome.treeEffects };
  if (outcome.result.type !== 'backend') throw new Error(`${outcome.inv}: a backend spawn produced a ${outcome.result.type} result`);
  return { kind: 'result', inv: outcome.inv, invDir, result: outcome.result };
}

// ---------------------------------------------------------------------------------------------------
// The arc roles' call (M3, LR-d): a lens of an audit, a checkpoint

/** A durable job's parent: its ops, spawns and reservations. */
export type JobParent = Extract<Parent, { type: 'job' }>;

/** The seat an arc role's call sits on: the role's one seat `arc` of the arc's routing in force (never a unit's layer). */
export function arcSeat(ctx: StageContext, role: ArcRole): Readonly<{ seat: ArcSeatRef; triple: ClaudeTriple; routingRev: RoutingRev }> {
  const routing = ctx.routing(null);
  const triple = routing.table[role].arc;
  // Startup refuses a Codex arc seat (unsupported-routing: no Codex judgment profile), so this is a bug if it happens.
  if (triple.backend !== 'claude') throw new Error(`the ${role} seat arc resolves to ${triple.backend}; the arc roles are Claude only in M3`);
  return { seat: seatRef(role, 'arc') as ArcSeatRef, triple, routingRev: routing.rev };
}

/**
 * One arc-role call of a job. `attempt` is the call's place among the job's calls of `role` (1-based): the key a
 * resumed job finds it by (`recordedArcCall`) and its meter subject's attempt. `cwd` is the tree the session reads.
 */
export type ArcCallSpec = Readonly<{
  job: JobId;
  role: ArcRole;
  attempt: number;
  system: string;
  rendered: string;
  schema: JsonValue;
  cwd: AbsPath;
  evidenceDirs: readonly AbsPath[];
  deadlineAt: IsoTime;
}>;

/**
 * An arc-role call through `invoke`: a fresh read-only session on the judgment profile (the unit judgments' argv),
 * spawned as `arc-backend{role, tier: arc, routingRev, job, attempt}` under `job{job}`, so its usage is metered to the
 * job by role and routingRev, never a model. Its workload env is `backendEnv` alone (a judgment holds no resource).
 * A call lost with its runner is retried once, uncharged, as the op's next invocation, as a unit judgment's is.
 */
export async function callArcRole(ctx: StageContext, spec: ArcCallSpec): Promise<BackendCallOutcome> {
  const { seat, triple, routingRev } = arcSeat(ctx, spec.role);
  const session = freshJudgmentSession();
  const schemaText = canonicalJson(spec.schema);
  const schemaPath = inputFile(ctx.runDir, `${schemaText}\n`, 'schema.json');
  const c: BackendCall = { kind: 'claude-judgment', role: spec.role, triple, session, schemaText, system: spec.system, evidenceDirs: spec.evidenceDirs };
  const stdin = inputFile(ctx.runDir, promptBytes(c, spec.rendered), 'prompt.txt');
  const env = backendEnv(ctx.hostEnv);
  const launch = (origin: SpawnOrigin): LaunchSpec => ({
    runDir: ctx.runDir,
    origin,
    subject: { purpose: 'arc-backend', ...seat, routingRev, job: spec.job, attempt: spec.attempt },
    launch: (invDir) => ({
      argv: backendArgv(c), cwd: spec.cwd, env, stdinPath: stdin, stallMs: null, graceMs: BACKEND_GRACE_MS,
      terminal: { type: 'backend', purpose: 'backend', routingRev, schemaPath, outputPath: absPath(join(invDir, STDOUT_FILE)), role: spec.role, session },
    }),
  });
  const parent: JobParent = { type: 'job', job: spec.job };
  const first = await invoke(ctx.journal, ctx.containment, launch({ type: 'new', key: opKey(`backend:${spec.job}`), parent, deadlineAt: spec.deadlineAt }));
  const outcome = first.kind === 'lost' ? await invoke(ctx.journal, ctx.containment, launch({ type: 'retry', op: first.op })) : first;
  const invDir = invocationDir(ctx.runDir, outcome.inv);
  if (outcome.kind === 'lost') return { kind: 'lost', inv: outcome.inv, invDir, treeEffects: outcome.treeEffects };
  if (outcome.result.type !== 'backend') throw new Error(`${outcome.inv}: an arc-backend spawn produced a ${outcome.result.type} result`);
  return { kind: 'result', inv: outcome.inv, invDir, result: outcome.result };
}

/**
 * The call a job made as `attempt` of `role`, read back from the log (a resumed job consumes it rather than asking
 * again): its result, or lost; null when the job made none. An open one is a bug here: recovery settles every open
 * spawn before a job resumes.
 */
export function recordedArcCall(ctx: StageContext, job: JobId, role: ArcRole, attempt: number): BackendCallOutcome | null {
  const spawn = ctx.journal.view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    return s.purpose === 'arc-backend' && s.job === job && s.role === role && s.attempt === attempt;
  }).at(-1);
  if (spawn === undefined) return null;
  const done = ctx.journal.view.doneOf(spawn.op);
  if (done === null || done.kind !== 'proc.spawn') throw new Error(`${spawn.op}: ${job}'s ${role} call ${attempt} is still open; recovery settles it before the job resumes`);
  const inv = invocationId(spawn.op, spawn.ordinal);
  const invDir = invocationDir(ctx.runDir, inv);
  if (done.outcome.kind === 'lost') return { kind: 'lost', inv, invDir, treeEffects: done.outcome.treeEffects };
  const result = runnerFiles(invDir, inv).read('result.json');
  if (result === null || result.type !== 'backend') throw new Error(`${inv}: a done arc-backend spawn without its backend result`);
  return { kind: 'result', inv, invDir, result };
}

/** Why a stage attempt was interrupted rather than failed. */
export type Interruption = 'pause' | 'stop' | BackendParkClass;

/**
 * A call read for the transition table. `interrupted` never charges. A backend park is already recorded
 * when this returns: `cause` names it (G5), and the stage records it in its hold, so a passing probe of that
 * park, or `resume --backend`, releases exactly this hold; null for a pause or stop. `needsUser` is the one
 * arc-wide item a usage-limit park calls for (the caller has it written); a capacity park is retryable, so
 * the prober recovers it and nobody is asked.
 */
export type BackendVerdict =
  | Readonly<{ kind: 'success'; value: JsonValue; result: BackendResult }>
  | Readonly<{ kind: 'refusal' | 'malformed' | 'process-fault'; detail: string }>
  | Readonly<{ kind: 'interrupted'; reason: Interruption; cause: HoldCause | null; needsUser: NeedsUserContent | null }>;

/** Who a backend call ran for: a unit's stage attempt, or (M3) a job's arc-role call. */
export type CallParent = StageParent | JobParent;

/** The arc-wide needs-user of a usage-limit park (D4: no auto-retry). Names the backend and the role's stage or job, never a model. */
function usageLimitNeedsUser(parent: CallParent, backend: Backend, called: BackendCallOutcome): NeedsUserContent {
  const where = parent.type === 'stage' ? `at ${parent.stage} of unit ${parent.unit}` : `in ${parent.job}`;
  const holds = parent.type === 'stage'
    ? `Stages that need it wait; unit ${parent.unit} holds at ${parent.stage}, uncharged.`
    : `Stages and jobs that need it wait; ${parent.job} ends and what it did not cover stays owed.`;
  return {
    blocking: true,
    subject: { type: 'arc' },
    reason: 'usage-limit',
    summary: `The ${backend} backend reported a usage-limit error ${where} (${called.inv}); it is parked arc-wide. ${holds}`,
    recommendation: `When the limit has reset, run \`roadmap resume --backend ${backend}\`: it re-runs the ${backend} smoke before unparking.`,
    options: [],
    evidence: [absPath(join(called.invDir, STDOUT_FILE)), absPath(join(called.invDir, STDERR_FILE))],
  };
}

/** The backend a call ran on, from its launch.json (argv[0]): what a backend park or a `process-fault` park targets. */
export function backendOf(called: BackendCallOutcome): Backend {
  const backend = runnerFiles(called.invDir, called.inv).read('launch.json')?.argv[0];
  if (backend !== 'claude' && backend !== 'codex') throw new Error(`${called.invDir}: a backend launch whose argv[0] is ${String(backend)}`);
  return backend;
}

/**
 * Reads a finished call. Order: an interruption (outcome `cancelled`: a pause or stop) first, then the
 * usage-limit/capacity park (outcome != success with such an error: a `backend-park` fact, arc-wide, whose seq
 * is the park's epoch and the hold's cause), then the outcome itself.
 */
export function verdictOf(ctx: StageContext, parent: CallParent, called: BackendCallOutcome): BackendVerdict {
  if (called.kind === 'lost') return { kind: 'process-fault', detail: `${called.inv} was lost with its runner` };
  const { result } = called;
  if (result.outcome.kind === 'cancelled') return { kind: 'interrupted', reason: result.outcome.reason, cause: null, needsUser: null };
  if (result.outcome.kind !== 'success') {
    const park = result.backendErrors.map((e) => e.class).find((c): c is BackendParkClass & BackendErrorClass => (BACKEND_PARK_CLASSES as readonly string[]).includes(c));
    if (park !== undefined) {
      const backend = backendOf(called);
      const parkSeq = ctx.journal.fact({ kind: 'backend-park', backend, class: park, inv: called.inv });
      const needsUser = park === 'usage-limit' ? usageLimitNeedsUser(parent, backend, called) : null;
      return { kind: 'interrupted', reason: park, cause: { type: 'backend', backend, parkSeq }, needsUser };
    }
  }
  switch (result.outcome.kind) {
    case 'success':
      return { kind: 'success', value: result.outcome.value, result };
    case 'refusal':
      return { kind: 'refusal', detail: `stop reason ${result.outcome.stopReason}` };
    case 'malformed':
    case 'process-fault':
      return { kind: result.outcome.kind, detail: result.outcome.detail };
  }
}

// ---------------------------------------------------------------------------------------------------
// Where a unit's work lives, and the journaled ops its stages run

/** The branch path every unit branch of the arc sits under; no branch may exist at it or at `roadmap`. */
export const unitBranchPrefix = (arc: ArcId): BranchName => branchName(`roadmap/${arc}`);
/** The unit's branch: every build round commits here, and the candidate merges it. */
export const unitBranch = (arc: ArcId, unit: UnitId): RefName => refName(`refs/heads/${unitBranchPrefix(arc)}/${unit}`);
export const unitWorktree = (root: AbsPath, arc: ArcId, unit: UnitId): AbsPath => absPath(join(root, arc, unit));
/** A lanes attempt's clean detached checkout of the salvage SHA. */
export const verificationWorktree = (root: AbsPath, arc: ArcId, unit: UnitId, attempt: number): AbsPath =>
  absPath(join(root, arc, `${unit}.verify-${attempt}`));

export type StageParent = Extract<Parent, { type: 'stage' }>;

// ---------------------------------------------------------------------------------------------------
// Entry reservations (A1, F6)

/**
 * A stage attempt that never started: the unit's task signal was aborted (pause or stop) before its entry
 * reservation was granted, so nothing was journaled: no attempt, no counter, no `interrupted` fact. The stage
 * runs again, fresh, when the unit is admitted again.
 */
export type Cancelled = Readonly<{ kind: 'cancelled'; reason: 'pause' | 'stop' }>;

export const isCancelled = <T extends object>(done: T | Cancelled): done is Cancelled => 'kind' in done && done.kind === 'cancelled';

/** A request, or null when it asks for nothing (a build of a unit with no resources and no `@cpu`). */
export const nonEmpty = (r: ResourceRequest): ResourceRequest | null =>
  r.named.length === 0 && r.pools.length === 0 && r.cpu === 0 && !r.publication ? null : r;

/**
 * Takes a stage attempt's entry reservation (A1, F6) under `holder`, before the attempt's first journaled op:
 * the grant's `reserve` transition is that op, parented by the attempt. `entered` once it is granted (at once
 * when `request` is null); `cancelled` when the task's signal is aborted first, with nothing journaled.
 */
export async function enter(ctx: StageContext, holder: UnitAcquiringHolder, request: ResourceRequest | null): Promise<Readonly<{ kind: 'entered' }> | Cancelled> {
  const cancelled = cancelledNow(ctx);
  if (cancelled !== null) return cancelled;
  if (request === null) return { kind: 'entered' };
  const grant = await ctx.acquire(request, holder, () => ctx.rank(holder.unit), ctx.signal);
  return grant.kind === 'cancelled' ? { kind: 'cancelled', reason: abortReason(ctx.signal) } : { kind: 'entered' };
}

/** The task's cancellation when its signal is already aborted (pause, stop), else null. */
export const cancelledNow = (ctx: StageContext): Cancelled | null => (ctx.signal.aborted ? { kind: 'cancelled', reason: abortReason(ctx.signal) } : null);

/** Where a stage attempt's evidence snapshots go. */
export const evidenceRoot = (runDir: AbsPath, parent: StageParent): AbsPath =>
  absPath(join(runDir, 'evidence', parent.unit, `${parent.attempt}-${parent.stage}`));
/** The implementer's own evidence dir for a build attempt (its decisions.json), outside the worktree. */
export const workDir = (runDir: AbsPath, parent: StageParent): AbsPath =>
  absPath(join(runDir, 'work', parent.unit, `${parent.attempt}-${parent.stage}`));

/** A file or git op shaped like `GitOp` (git kinds) or its file-op twins (evidence.snapshot, spec.patch). */
export type StageOp<K extends OpKind, R> = Readonly<{
  kind: K;
  prepare(request: R): Promise<IntentBody<K>>;
  act(intent: IntentOf<K>): Promise<void>;
  verify(intent: IntentOf<K>): Promise<OpOutcome[K]>;
}>;

/**
 * An op on the normal path: durable intent → act → verify → done. `body` comes from the op's own
 * `prepare`, which the caller runs first, so a refusal there (before any intent) stays the caller's.
 */
export async function runPrepared<K extends OpKind, R>(
  journal: Journal, op: StageOp<K, R>, key: string, parent: Parent, body: IntentBody<K>,
): Promise<IntentOf<K>> {
  const { op: id } = journal.begin({ kind: op.kind, key: opKey(key), parent, deadlineAt: null, body: () => body });
  const intent = journal.view.latestIntent(id);
  if (intent.kind !== op.kind) throw new Error(`${id} is a ${intent.kind} op, not ${op.kind}`);
  const typed = intent as IntentOf<K>;
  await op.act(typed);
  journal.done(id, op.kind, await op.verify(typed), null);
  return typed;
}

export async function runOp<K extends OpKind, R>(journal: Journal, op: StageOp<K, R>, key: string, parent: Parent, request: R): Promise<IntentOf<K>> {
  return runPrepared(journal, op, key, parent, await op.prepare(request));
}
