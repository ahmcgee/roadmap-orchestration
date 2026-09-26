// Dispatch: who acts for a unit, on which seat, under which pinned authority, and the backend call that
// puts them to work (plan "Authority", R2; DESIGN-1.0.md §4 Independence, Actors are roles).
//
// - The dispatch record (a `dispatch` fact) pins the unit's scope envelope and risk floor once, with the
//   routingRev in force and the hash of the implementer seat's triple (`implementerSeatRev`). A plan-check
//   that raises the risk re-pins it with a new fact (same scope, higher floor); nothing lowers it and
//   nothing widens the scope (the fold refuses both).
// - A routing change mid-unit (a new routingRev at a later dispatch; lead ruling, arc-1 feedback item 7):
//   every judgment is a fresh session, so a judgment seat may change harmlessly; the implementer's session
//   resumes, so its seat may not. The unit is re-pinned under the new rev (a new dispatch fact, scope and
//   floor unchanged) when no build has started for it or its implementer seat hashes the same under both
//   revs; otherwise the stage parks it (`routing-changed`) with a needs-user naming the seat, never a model.
// - Seats: the implementer sits on the unit's risk tier for the whole unit (it keeps its model); a
//   judgment stage sits on `judgmentSeat` (transitions.ts): the role's `escalation` seat once it routed up
//   (for the rest of the unit) or while a risk trigger is pending (the next judgment dispatch only).
// - The backend call: prompt text and schema are content-addressed input files written before the spawn
//   intent; the launch names the role and routingRev, never the model, except in argv (launch.json is the
//   one executor-written file allowed a model id). The workload env is `backendEnv(host)` plus the unit's
//   owner label, so whatever the backend starts carries it.
// - The verdict: a cancel for pause or stop is an interruption, not a fault; a failed call whose backend
//   reported a usage limit or capacity error parks that backend arc-wide (`backend-park`) and holds the
//   stage (lead ruling: outcome != success AND class in {usage-limit, capacity}); platform or backend
//   error entries on a success are informational.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BackendCall, type ClaudeTriple, type CodexTriple, backendArgv, promptBytes } from '../backends/argv.ts';
import {
  BACKEND_PARK_CLASSES, type BackendParkClass, type IntentOf, type JudgmentStage, type OpKind, type OpOutcome, type Parent,
} from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type ArcId, type InvocationId, type RoutingRev, type SeatRev, type UnitId, opKey, seatRev } from '../core/ids.ts';
import type { IntentBody, Journal, JournalView } from '../core/interfaces.ts';
import type { SpecState } from '../core/state.ts';
import { type JsonValue, canonicalJson, sha256Hex } from '../core/json.ts';
import {
  type BackendResult, type DispatchRecord, type ImplementerSession, type JudgmentSession, type LaunchTerminal, STDERR_FILE, STDOUT_FILE, type NeedsUserContent,
} from '../core/records.ts';
import { type AbsPath, type IsoTime, type RefName, absPath, isoTimeOf, refName } from '../core/values.ts';
import type { PlanUnit } from '../input/plan.ts';
import { backendEnv, CODEX_OUTPUT_FILE } from '../preflight/smoke.ts';
import type { ResourceContext } from '../resources/reserve.ts';
import { OWNER_ENV, ownerLabel } from '../resources/teardown.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import { type Backend, RISK_TIERS, type JudgmentRole, type JudgmentSeat, type RiskTier, type Role, type SeatRef } from '../routing/types.ts';
import { runnerFiles } from '../runner/files.ts';
import { type LaunchSpec, type SpawnOrigin, invocationDir, invoke } from './invoke.ts';
import { judgmentSeat } from './transitions.ts';

/** Everything a unit's stages need: processes, resources, the resolved routing and the host environment. */
export type StageContext = ResourceContext & Readonly<{
  routing: ResolvedRouting;
  /** The executor's own environment; backends get `backendEnv(hostEnv)`, lanes their declared `pass` names. */
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** The plan file's directory: unit spec paths and the rulings ledger are relative to it. */
  planDir: AbsPath;
}>;

/** Judgment deadline per invocation. Default, unmeasured: re-derive once arc 2 has measured judgments. */
export const JUDGMENT_DEADLINE_MS = 45 * 60_000;
/** Grace between TERM and KILL when a backend workload is ended. */
export const BACKEND_GRACE_MS = 10_000;

// ---------------------------------------------------------------------------------------------------
// The dispatch record

const now = (): IsoTime => isoTimeOf(new Date());

/** The hash of the implementer seat's triple for risk `floor` under `routing`. */
export function implementerSeatRev(routing: ResolvedRouting, floor: RiskTier): SeatRev {
  return seatRev(sha256Hex(canonicalJson(routing.table.build[floor])).slice(0, 16));
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
        + `${seat} now resolves to a different binding. Its build session resumes on its seat, so it cannot move mid-unit.`,
      recommendation: `Restore the previous routing of ${seat} and resume, or re-enter the unit under a new id.`,
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
 * `record` under the routing in force: itself when the rev is unchanged; re-pinned (a new dispatch fact,
 * same scope and floor) when no build has started or the implementer seat hashes the same; else the park.
 */
function inForce(ctx: StageContext, record: DispatchRecord): Pinned<DispatchRecord> {
  if (record.routingRev === ctx.routing.rev) return { kind: 'pinned', dispatch: record };
  const seat = implementerSeatRev(ctx.routing, record.riskFloor);
  if (seat !== record.implementerSeatRev && buildStarted(ctx.journal.view, record.unit)) return routingChanged(record);
  const next: DispatchRecord = { ...record, routingRev: ctx.routing.rev, implementerSeatRev: seat, at: now() };
  ctx.journal.fact({ kind: 'dispatch', record: next });
  return { kind: 'pinned', dispatch: next };
}

/**
 * The unit's dispatch record under the routing in force: the latest `dispatch` fact (re-pinned if the
 * routing changed and the unit can absorb it), or the first one, recorded now from the plan (scope envelope
 * and Phase-0 risk floor) and the spec revision being dispatched (its rev and file hash).
 */
export function pinDispatch(ctx: StageContext, unit: PlanUnit, spec: SpecState): Pinned<DispatchRecord> {
  const current = ctx.journal.view.dispatchOf(unit.id);
  if (current !== null) return inForce(ctx, current);
  const record: DispatchRecord = {
    unit: unit.id, specRev: spec.rev, specSha256: spec.sha256, scope: [...unit.scope].sort(), riskFloor: unit.risk, routingRev: ctx.routing.rev,
    implementerSeatRev: implementerSeatRev(ctx.routing, unit.risk), at: now(),
  };
  ctx.journal.fact({ kind: 'dispatch', record });
  return { kind: 'pinned', dispatch: record };
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
  const next: DispatchRecord = {
    ...record, specRev: spec.rev, specSha256: spec.sha256, riskFloor: risk, routingRev: ctx.routing.rev,
    implementerSeatRev: implementerSeatRev(ctx.routing, risk), at: now(),
  };
  ctx.journal.fact({ kind: 'dispatch', record: next });
  return next;
}

// ---------------------------------------------------------------------------------------------------
// Seats

export type JudgmentDispatch = Readonly<{ role: JudgmentRole; tier: JudgmentSeat; triple: ClaudeTriple; routingRev: RoutingRev }>;
export type ImplementerDispatch = Readonly<{ role: 'build'; tier: RiskTier; triple: ClaudeTriple | CodexTriple; routingRev: RoutingRev }>;

const ROLE_OF: Readonly<Record<JudgmentStage, JudgmentRole>> = { 'plan-check': 'planCheck', gate: 'gate' };

/** The seat of a judgment dispatch: the unit's risk, or the escalation seat after a route-up or a risk trigger. */
export function judgmentDispatch(ctx: StageContext, unit: UnitId, stage: JudgmentStage): Pinned<JudgmentDispatch> {
  const pinned = inForce(ctx, dispatchOf(ctx.journal.view, unit));
  if (pinned.kind !== 'pinned') return pinned;
  const role = ROLE_OF[stage];
  const tier = judgmentSeat(ctx.journal.view.unit(unit), stage);
  const triple = ctx.routing.table[role][tier];
  // Startup refuses every Codex judgment seat (unsupported-routing), so this is a bug if it happens.
  if (triple.backend !== 'claude') throw new Error(`the ${role} seat ${tier} resolves to ${triple.backend}; judgment is Claude only in M1`);
  return { kind: 'pinned', dispatch: { role, tier, triple, routingRev: pinned.dispatch.routingRev } };
}

/** The implementer's seat: the unit's (possibly plan-check-raised) risk floor, for every round of the unit. */
export function implementerDispatch(ctx: StageContext, unit: UnitId): Pinned<ImplementerDispatch> {
  const pinned = inForce(ctx, dispatchOf(ctx.journal.view, unit));
  if (pinned.kind !== 'pinned') return pinned;
  const { riskFloor, routingRev } = pinned.dispatch;
  return { kind: 'pinned', dispatch: { role: 'build', tier: riskFloor, triple: ctx.routing.table.build[riskFloor], routingRev } };
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

/** Writes `text` once under `<runDir>/inputs/<sha256>.<ext>`; the name certifies the content. */
export function inputFile(runDir: AbsPath, text: string, ext: string): AbsPath {
  const path = absPath(join(runDir, 'inputs', `${sha256Hex(text)}.${ext}`));
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) {
    durableMkdir(join(runDir, 'inputs'));
    durableWrite(path, text);
  }
  return path;
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

/**
 * One backend call of a unit's stage, through `invoke` (proc.spawn{purpose: backend}). A call lost with its
 * runner is retried once, uncharged, as the op's next invocation with the same deadline (the plan's
 * recovery table); the outcome is the retry's. An implementer call that may have changed the tree is not
 * retried: its work is salvaged and verified (`lost-tree-effects`).
 */
export async function callBackend(ctx: StageContext, spec: BackendCallSpec): Promise<BackendCallOutcome> {
  const r = spec.request;
  const seat: SeatRef = r.kind === 'judgment' ? { role: r.dispatch.role, tier: r.dispatch.tier } : { role: 'build', tier: r.dispatch.tier };
  const role: Role = seat.role;
  const schemaText = canonicalJson(spec.schema);
  const schemaPath = inputFile(ctx.runDir, `${schemaText}\n`, 'schema.json');
  // promptBytes reads only the call's kind and system text, neither of which depends on the invocation dir.
  const stdin = inputFile(ctx.runDir, promptBytes(call(spec, schemaText, schemaPath, ctx.runDir), spec.rendered), 'prompt.txt');
  // Only the implementer may create resources (its builds run the unit's tooling); a judgment holds none.
  const env = role === 'build' ? { ...backendEnv(ctx.hostEnv), [OWNER_ENV]: ownerLabel(ctx.plan.arc, spec.unit) } : backendEnv(ctx.hostEnv);
  const launch = (origin: SpawnOrigin): LaunchSpec => ({
    runDir: ctx.runDir,
    origin,
    subject: { purpose: 'backend', ...seat, routingRev: spec.request.dispatch.routingRev, unit: spec.unit, attempt: spec.parent.attempt },
    launch: (invDir) => {
      const c = call(spec, schemaText, schemaPath, invDir);
      return { argv: backendArgv(c), cwd: spec.cwd, env, stdinPath: stdin, graceMs: BACKEND_GRACE_MS, terminal: terminal(spec, c, schemaPath, invDir) };
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

/** Why a stage attempt was interrupted rather than failed. */
export type Interruption = 'pause' | 'stop' | BackendParkClass;

/**
 * A call read for the transition table. `interrupted` never charges. A backend park is already recorded
 * when this returns, and carries the one arc-wide needs-user it calls for (the caller has it written).
 */
export type BackendVerdict =
  | Readonly<{ kind: 'success'; value: JsonValue; result: BackendResult }>
  | Readonly<{ kind: 'refusal' | 'malformed' | 'process-fault'; detail: string }>
  | Readonly<{ kind: 'interrupted'; reason: Interruption; needsUser: NeedsUserContent | null }>;

/** The arc-wide needs-user of a backend park. Names the backend and the role's stage, never a model. */
function backendParkNeedsUser(parent: StageParent, backend: Backend, park: BackendParkClass, called: BackendCallOutcome): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'arc' },
    reason: 'usage-limit',
    summary: `The ${backend} backend reported a ${park} error at ${parent.stage} of unit ${parent.unit} (${called.inv}); it is parked arc-wide. `
      + `Stages that need it wait; unit ${parent.unit} holds at ${parent.stage}, uncharged.`,
    recommendation: `When the limit has reset, run \`roadmap resume --backend ${backend}\`: it re-runs the ${backend} smoke before unparking.`,
    options: [],
    evidence: [absPath(join(called.invDir, STDOUT_FILE)), absPath(join(called.invDir, STDERR_FILE))],
  };
}

/**
 * The pause or stop that cancelled a command invocation (a lane), if its runner ended it for one. A backend
 * call's result.json records the same as outcome `cancelled`, which `verdictOf` reads instead.
 */
export function cancelledFor(invDir: AbsPath, inv: InvocationId): 'pause' | 'stop' | null {
  const files = runnerFiles(invDir, inv);
  const exit = files.read('exit.json');
  if (exit === null || exit.cause !== 'cancel') return null;
  const reason = files.read('cancel.json')?.reason;
  if (reason === undefined) throw new Error(`${invDir}: exit cause cancel without cancel.json`);
  return reason === 'recovery' ? null : reason;
}

/**
 * Reads a finished call. Order: an interruption (outcome `cancelled`: a pause or stop) first, then the
 * usage-limit/capacity park (outcome != success with such an error: `backend-park` fact, arc-wide), then the
 * outcome itself.
 */
export function verdictOf(ctx: StageContext, parent: StageParent, called: BackendCallOutcome): BackendVerdict {
  if (called.kind === 'lost') return { kind: 'process-fault', detail: `${called.inv} was lost with its runner` };
  const { result } = called;
  if (result.outcome.kind === 'cancelled') return { kind: 'interrupted', reason: result.outcome.reason, needsUser: null };
  if (result.outcome.kind !== 'success') {
    const park = result.backendErrors.map((e) => e.class).find((c): c is BackendParkClass => (BACKEND_PARK_CLASSES as readonly string[]).includes(c));
    if (park !== undefined) {
      const backend = runnerFiles(called.invDir, called.inv).read('launch.json')?.argv[0];
      if (backend !== 'claude' && backend !== 'codex') throw new Error(`${called.invDir}: a backend launch whose argv[0] is ${String(backend)}`);
      ctx.journal.fact({ kind: 'backend-park', backend, class: park, inv: called.inv });
      return { kind: 'interrupted', reason: park, needsUser: backendParkNeedsUser(parent, backend, park, called) };
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

/** The unit's branch: every build round commits here, and the candidate merges it. */
export const unitBranch = (arc: ArcId, unit: UnitId): RefName => refName(`refs/heads/roadmap/${arc}/${unit}`);
export const unitWorktree = (root: AbsPath, arc: ArcId, unit: UnitId): AbsPath => absPath(join(root, arc, unit));
/** A lanes attempt's clean detached checkout of the salvage SHA. */
export const verificationWorktree = (root: AbsPath, arc: ArcId, unit: UnitId, attempt: number): AbsPath =>
  absPath(join(root, arc, `${unit}.verify-${attempt}`));

export type StageParent = Extract<Parent, { type: 'stage' }>;

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
  journal: Journal, op: StageOp<K, R>, key: string, parent: StageParent, body: IntentBody<K>,
): Promise<IntentOf<K>> {
  const { op: id } = journal.begin({ kind: op.kind, key: opKey(key), parent, deadlineAt: null, body: () => body });
  const intent = journal.view.latestIntent(id);
  if (intent.kind !== op.kind) throw new Error(`${id} is a ${intent.kind} op, not ${op.kind}`);
  const typed = intent as IntentOf<K>;
  await op.act(typed);
  journal.done(id, op.kind, await op.verify(typed), null);
  return typed;
}

export async function runOp<K extends OpKind, R>(journal: Journal, op: StageOp<K, R>, key: string, parent: StageParent, request: R): Promise<IntentOf<K>> {
  return runPrepared(journal, op, key, parent, await op.prepare(request));
}
