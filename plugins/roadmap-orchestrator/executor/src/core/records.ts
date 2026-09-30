// File-backed records other than the event log: the five runner files, the approval fingerprint and
// dispatch record, spec.json (M1) and SpecPatch, host files, commands and receipts, needs-user. Each has
// a type and a validator from `unknown`. SCHEMAS.md is the prose twin of this module.
import {
  type ArcId, type ClauseId, type CommandId, type DivergenceId, type FindingId, type ImplementerSessionId, type InvocationId, type JobId,
  type JudgmentSessionId, type EdgeId, type LaneId, type NeedsUserId, type ObligationId, type OpId, type PlanRev, type ResourceInstance,
  type ResourceName, type RoutingRev, type RulingId, type SeatRev, type Sha, type Sha256Hex, type SpecRev, type UnitId, arcId, clauseId,
  commandId, divergenceId, edgeId, findingId, implementerSessionId, invocationIdOf, jobIdOf, judgmentSessionId, laneId, needsUserId,
  obligationId, opIdOf, parseInvocationId, planRev, resourceInstance, resourceName, routingRev, rulingId, seatRev, sha, sha256, specRev, unitId,
} from './ids.ts';
import type { JsonValue } from './json.ts';
import {
  type AbsPath, type BootId, type IsoTime, type Nonce, type RepoPath, type RepoPattern, absPath, bootId, isoTime, nonce,
  repoPath, repoPattern,
} from './values.ts';
import {
  type Read, Fields, SchemaError, arrayOf, assertUnique, bool, envName, int, literal, nat, nullable, object, oneOf,
  positive, sortedBy, str, stringMap, tagged, text, version,
} from './validate.ts';
import { launchStallMs } from './upgrade.ts';
import type { SchemaVersion } from './version.ts';
import {
  type Backend, type FreshRole, type ImplementerRole, type ModelClass, type ProfileName, type RiskTier, type Role, ROLES, backend, modelClass,
  profileName, riskTier,
} from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary

export type ProcIdentity = Readonly<{ pid: number; start: number }>;
export const procIdentity: Read<ProcIdentity> = object((f) => ({ pid: f.get('pid', positive), start: f.get('start', nat) }));

/** `preempt` (M3, A7): a docs publication abandons a unit candidate before green; uncharged. */
export const KILL_REASONS = ['deadline', 'stall', 'pause', 'stop', 'recovery', 'external-unknown', 'preempt'] as const;
export type KillReason = (typeof KILL_REASONS)[number];
export const killReason: Read<KillReason> = oneOf(KILL_REASONS);

/** What the executor writes into cancel.json. `deadline` and `stall` are the runner's own; `external-unknown` kills are not invocation cancels. */
export const CANCEL_REASONS = ['pause', 'stop', 'recovery', 'preempt'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
/** The cancel reasons that end a workload with exit cause `cancel` (the runner turns `recovery` into `recovery-kill`). */
export const INTERRUPT_REASONS = ['pause', 'stop'] as const;
export type InterruptReason = (typeof INTERRUPT_REASONS)[number];
/** A command (a lane) may also be cancelled by a preempting docs publication (M3, A7); a backend call never is. */
export const LANE_INTERRUPT_REASONS = [...INTERRUPT_REASONS, 'preempt'] as const;
export type LaneInterruptReason = (typeof LANE_INTERRUPT_REASONS)[number];

export const SPAWN_PURPOSES = ['backend', 'lane', 'teardown', 'probe', 'smoke'] as const;
export type SpawnPurpose = (typeof SPAWN_PURPOSES)[number];
export const COMMAND_PURPOSES = ['lane', 'teardown', 'probe', 'smoke'] as const;
export type CommandPurpose = (typeof COMMAND_PURPOSES)[number];

export const CONTAINMENT_MODES = ['session', 'cgroup'] as const;
export type ContainmentMode = (typeof CONTAINMENT_MODES)[number];
export const containmentMode: Read<ContainmentMode> = oneOf(CONTAINMENT_MODES);

/**
 * Pipeline stages of one unit (the transition table is step 11). Fix rounds are `build` attempts. `prepare`
 * (M2) is a re-entered unit's first stage: its worktree, pin, merge-in of the integration tip and snapshot.
 * `reproduce` (M3) is a vacuity repair's first stage: the finding's mutant applied in a detached worktree and
 * its lane run under `purpose: mutant`.
 */
export const STAGES = ['prepare', 'reproduce', 'plan-check', 'build', 'quiesce', 'evidence', 'salvage', 'teardown', 'lanes', 'gate', 'candidate', 'ff', 'snapshot', 'retire'] as const;
export type Stage = (typeof STAGES)[number];
export const stage: Read<Stage> = oneOf(STAGES);

export const RESOURCE_STATES = ['free', 'reserved', 'running', 'cleaning', 'cleanup-failed'] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

const role: Read<Role> = oneOf(ROLES);
/** The roles whose call runs a fresh judgment session: every role but `build`. */
const FRESH_ROLES = ROLES.filter((r): r is FreshRole => r !== 'build');
const opId: Read<OpId> = (v, p) => opIdOf(v, p);
const inv: Read<InvocationId> = (v, p) => invocationIdOf(v, p);
const arc: Read<ArcId> = (v, p) => arcId(v, p);
const unit: Read<UnitId> = (v, p) => unitId(v, p);
const commitSha: Read<Sha> = (v, p) => sha(v, p);
const rev: Read<RoutingRev> = (v, p) => routingRev(v, p);
const abs: Read<AbsPath> = (v, p) => absPath(v, p);
const time: Read<IsoTime> = (v, p) => isoTime(v, p);
const resource: Read<ResourceName> = (v, p) => resourceName(v, p);
/** argv[0] names the program; a later argument may be empty (`claude --setting-sources ''`). */
const argv: Read<readonly string[]> = (v, p) => {
  const out = arrayOf(text, { nonEmpty: true })(v, p);
  str(out[0], `${p}[0]`);
  return out;
};
const exitCode = int(0, 255);

// ---------------------------------------------------------------------------------------------------
// Runner files: every one is bound to one invocation by {v, arc, op, inv}, with inv = op#ordinal.

export type InvocationBinding = Readonly<{ v: SchemaVersion; arc: ArcId; op: OpId; inv: InvocationId }>;

function binding(f: Fields): InvocationBinding {
  const b = { v: f.get('v', version), arc: f.get('arc', arc), op: f.get('op', opId), inv: f.get('inv', inv) };
  if (parseInvocationId(b.inv).op !== b.op) throw new SchemaError(`${f.path}.inv`, `an invocation of ${b.op}`, b.inv);
  if (!b.op.startsWith(`${b.arc}/`)) throw new SchemaError(`${f.path}.op`, `an op of arc ${b.arc}`, b.op);
  return b;
}

export type JudgmentSession = Readonly<{ backend: 'claude'; mode: 'fresh'; id: JudgmentSessionId }>;
/** Codex assigns its own thread id on a fresh exec, so a fresh Codex session carries no id until its result. */
export type ImplementerSession =
  | Readonly<{ backend: 'claude'; mode: 'fresh' | 'resume'; id: ImplementerSessionId }>
  | Readonly<{ backend: 'codex'; mode: 'fresh' }>
  | Readonly<{ backend: 'codex'; mode: 'resume'; id: ImplementerSessionId }>;

type BackendTerminalBase = Readonly<{
  type: 'backend';
  purpose: 'backend' | 'smoke';
  routingRev: RoutingRev;
  schemaPath: AbsPath;
  /** Codex: the `-o` file. Claude: the invocation's stdout file (its stream-json events, the result last). */
  outputPath: AbsPath;
}>;
export type BackendTerminal =
  | (BackendTerminalBase & Readonly<{ role: FreshRole; session: JudgmentSession }>)
  | (BackendTerminalBase & Readonly<{ role: ImplementerRole; session: ImplementerSession }>);
export type CommandTerminal = Readonly<{ type: 'command'; purpose: CommandPurpose; expectedExit: number }>;
export type LaunchTerminal = BackendTerminal | CommandTerminal;

/**
 * launch.json: the only executor-written file that may contain a model id, and only inside `argv`.
 * `env` is the declared environment; the runner adds ROADMAP_OP, ROADMAP_INV and ROADMAP_ROLE=workload.
 */
export type LaunchFile = InvocationBinding & Readonly<{
  argv: readonly string[];
  cwd: AbsPath;
  env: Readonly<Record<string, string>>;
  stdinPath: AbsPath | null;
  deadlineAt: IsoTime;
  /**
   * The stall watchdog: the runner kills the workload once it has made no progress (no CPU time, no output,
   * no member started or ended) for this long. null: no watchdog, the deadline alone (every non-lane launch).
   */
  stallMs: number | null;
  graceMs: number;
  containment: ContainmentMode;
  test: Readonly<{ crash: AbsPath }> | null;
  terminal: LaunchTerminal;
}>;

const judgmentSession: Read<JudgmentSession> = object((f) => ({
  backend: f.get('backend', literal('claude')),
  mode: f.get('mode', literal('fresh')),
  id: f.get('id', (v, p) => judgmentSessionId(v, p)),
}));

const implementerSession: Read<ImplementerSession> = (value, path) => {
  const g = new Fields(value, path);
  const b = g.get('backend', backend);
  const mode = g.get('mode', oneOf(['fresh', 'resume'] as const));
  const id = (v: unknown, p: string): ImplementerSessionId => implementerSessionId(v, p);
  if (b === 'codex' && mode === 'fresh') return object((f): ImplementerSession => ({ backend: f.get('backend', literal('codex')), mode: f.get('mode', literal('fresh')) }))(value, path);
  if (b === 'codex') return object((f): ImplementerSession => ({ backend: f.get('backend', literal('codex')), mode: f.get('mode', literal('resume')), id: f.get('id', id) }))(value, path);
  return object((f): ImplementerSession => ({ backend: f.get('backend', literal('claude')), mode: f.get('mode', oneOf(['fresh', 'resume'] as const)), id: f.get('id', id) }))(value, path);
};

const launchTerminal: Read<LaunchTerminal> = tagged('type', {
  command: object((f): LaunchTerminal => ({
    type: f.get('type', literal('command')),
    purpose: f.get('purpose', oneOf(COMMAND_PURPOSES)),
    expectedExit: f.get('expectedExit', exitCode),
  })),
  backend: (value, path) => {
    const r = new Fields(value, path).get('role', role);
    return object((f): LaunchTerminal => {
      const base = {
        type: f.get('type', literal('backend')),
        purpose: f.get('purpose', oneOf(['backend', 'smoke'] as const)),
        routingRev: f.get('routingRev', rev),
        schemaPath: f.get('schemaPath', abs),
        outputPath: f.get('outputPath', abs),
      };
      return r === 'build'
        ? { ...base, role: f.get('role', literal('build')), session: f.get('session', implementerSession) }
        : { ...base, role: f.get('role', oneOf(FRESH_ROLES)), session: f.get('session', judgmentSession) };
    })(value, path);
  },
});

const declaredEnv: Read<Readonly<Record<string, string>>> = (value, path) => {
  const env = stringMap(value, path);
  for (const k of Object.keys(env)) {
    if (k.startsWith('ROADMAP_')) throw new SchemaError(`${path}.${k}`, 'a declared variable (ROADMAP_* are set by the runner)', env[k]);
  }
  return env;
};

/**
 * The smallest grace a launch may carry. The executor's backstop kills a hung runner at deadline + 2 * grace
 * and the runner polls cancel and deadline every 500 ms, so a shorter grace could let the backstop fire
 * before the runner has written exit.json (lead ruling, step 13).
 */
export const MIN_GRACE_MS = 1_000;
const graceMs = int(MIN_GRACE_MS, Number.MAX_SAFE_INTEGER);

export const launchFile: Read<LaunchFile> = object((f) => ({
  ...binding(f),
  argv: f.get('argv', argv),
  cwd: f.get('cwd', abs),
  env: f.get('env', declaredEnv),
  stdinPath: f.get('stdinPath', nullable(abs)),
  deadlineAt: f.get('deadlineAt', time),
  stallMs: launchStallMs(f.optional('stallMs', nullable(positive)), f.path),
  graceMs: f.get('graceMs', graceMs),
  containment: f.get('containment', containmentMode),
  test: f.get('test', nullable(object((g) => ({ crash: g.get('crash', abs) })))),
  terminal: f.get('terminal', launchTerminal),
}));

/** runner.json: written with `child: null` before the spawn, rewritten with the child after. */
export type RunnerFile = InvocationBinding & Readonly<{
  runner: ProcIdentity & Readonly<{ bootId: BootId }>;
  child: (ProcIdentity & Readonly<{ sid: number }>) | null;
}>;

export const runnerFile: Read<RunnerFile> = object((f) => ({
  ...binding(f),
  runner: f.get('runner', object((g) => ({ pid: g.get('pid', positive), start: g.get('start', nat), bootId: g.get('bootId', (v, p) => bootId(v, p)) }))),
  child: f.get('child', nullable(object((g) => ({ pid: g.get('pid', positive), start: g.get('start', nat), sid: g.get('sid', positive) })))),
}));

/** cancel.json: written by the executor before it signals the workload. */
export type CancelFile = InvocationBinding & Readonly<{ reason: CancelReason; at: IsoTime }>;
export const cancelFile: Read<CancelFile> = object((f) => ({
  ...binding(f),
  reason: f.get('reason', oneOf(CANCEL_REASONS)),
  at: f.get('at', time),
}));

export type ChildEnd =
  | Readonly<{ type: 'exited'; code: number }>
  | Readonly<{ type: 'signalled'; signal: string }>
  | Readonly<{ type: 'spawn-failed'; error: string }>;
/** `exited` = the child ended on its own; the others name why the runner killed the workload. */
export type ExitCause = 'exited' | 'deadline' | 'stall' | 'cancel' | 'recovery-kill';

/** exit.json: written by the runner after the workload is empty, before the adapter runs. */
export type ExitFile = InvocationBinding & Readonly<{ child: ChildEnd; cause: ExitCause; endedAt: IsoTime; quiescedAt: IsoTime }>;

const childEnd: Read<ChildEnd> = tagged('type', {
  exited: object((f): ChildEnd => ({ type: f.get('type', literal('exited')), code: f.get('code', exitCode) })),
  signalled: object((f): ChildEnd => ({
    type: f.get('type', literal('signalled')),
    signal: f.get('signal', (v, p) => {
      const s = str(v, p);
      if (!/^SIG[A-Z0-9]+$/.test(s)) throw new SchemaError(p, 'a signal name (SIG...)', v);
      return s;
    }),
  })),
  'spawn-failed': object((f): ChildEnd => ({ type: f.get('type', literal('spawn-failed')), error: f.get('error', str) })),
});

export const exitFile: Read<ExitFile> = object((f) => {
  const out: ExitFile = {
    ...binding(f),
    child: f.get('child', childEnd),
    cause: f.get('cause', oneOf(['exited', 'deadline', 'stall', 'cancel', 'recovery-kill'] as const)),
    endedAt: f.get('endedAt', time),
    quiescedAt: f.get('quiescedAt', time),
  };
  if (out.child.type === 'spawn-failed' && out.cause !== 'exited') throw new SchemaError(`${f.path}.cause`, '"exited" for a child that never spawned', out.cause);
  if (out.quiescedAt < out.endedAt) throw new SchemaError(`${f.path}.quiescedAt`, `not before endedAt ${out.endedAt}`, out.quiescedAt);
  return out;
});

// result.json -----------------------------------------------------------------------------------------

export type TokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  /** null: the backend did not report this figure (both CLIs report cache writes as of the captured fixtures; older Codex output omitted it). */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** The CLI's own turn count (Claude `num_turns`: each model request of the tool loop); null when not reported (Codex). */
  turns: number | null;
  /** The CLI's own list-price cost estimate in USD (Claude `total_cost_usd`); null when not reported (Codex). */
  costUsd: number | null;
}>;
export const USAGE_UNAVAILABLE_REASONS = ['no-result', 'absent', 'malformed'] as const;
export type UsageUnavailableReason = (typeof USAGE_UNAVAILABLE_REASONS)[number];
/** Usage validity is independent of the outcome: missing usage never invalidates a judgment. */
export type Usage = Readonly<{ kind: 'known'; tokens: TokenUsage }> | Readonly<{ kind: 'unavailable'; reason: UsageUnavailableReason }>;

const usd: Read<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SchemaError(path, 'a finite non-negative number', value);
  return value;
};
export const tokenUsage: Read<TokenUsage> = object((f) => ({
  inputTokens: f.get('inputTokens', nat),
  outputTokens: f.get('outputTokens', nat),
  cacheReadTokens: f.get('cacheReadTokens', nullable(nat)),
  cacheWriteTokens: f.get('cacheWriteTokens', nullable(nat)),
  turns: f.get('turns', nullable(nat)),
  costUsd: f.get('costUsd', nullable(usd)),
}));
export const usageUnavailableReason: Read<UsageUnavailableReason> = oneOf(USAGE_UNAVAILABLE_REASONS);
const usage: Read<Usage> = tagged('kind', {
  known: object((f): Usage => ({ kind: f.get('kind', literal('known')), tokens: f.get('tokens', tokenUsage) })),
  unavailable: object((f): Usage => ({ kind: f.get('kind', literal('unavailable')), reason: f.get('reason', usageUnavailableReason) })),
});

export const BACKEND_ERROR_CLASSES = ['usage-limit', 'capacity', 'platform', 'backend'] as const;
export type BackendErrorClass = (typeof BACKEND_ERROR_CLASSES)[number];
/** Classified only from `turn.failed` / CLI error events, never from command output. */
export type BackendError = Readonly<{ class: BackendErrorClass; message: string }>;

export type BackendOutcome =
  | Readonly<{ kind: 'success'; value: JsonValue }>
  | Readonly<{ kind: 'refusal'; stopReason: string }>
  | Readonly<{ kind: 'malformed'; detail: string }>
  | Readonly<{ kind: 'process-fault'; detail: string }>
  /**
   * The executor cancelled the workload for a pause or stop (exit cause `cancel`); `reason` is cancel.json's.
   * Not a failure of the call. A recovery cancel ends as cause `recovery-kill`, a process fault.
   */
  | Readonly<{ kind: 'cancelled'; reason: InterruptReason }>;
export type BackendOutcomeKind = BackendOutcome['kind'];
/** What the precedence rule alone decides; refusal is the adapter's reading of a backend stop reason. */
export type TerminalOutcome = Exclude<BackendOutcome, { kind: 'refusal' }>;

/**
 * `stall`: the runner's stall watchdog killed the workload; a verdict on the command (it hung), not a process
 * fault. `cancelled`: the executor cancelled it for a pause or stop, the reason beside it (`CommandEnd`), as a
 * backend call's `cancelled{reason}` outcome.
 */
export const COMMAND_VERDICTS = ['pass', 'fail', 'stall', 'process-fault', 'cancelled'] as const;
export type CommandVerdict = (typeof COMMAND_VERDICTS)[number];
/** How a command ended: its exit code (null when the child never exited with one) and verdict. */
export type CommandEnd = Readonly<{ exitCode: number | null }> & (
  | Readonly<{ verdict: Exclude<CommandVerdict, 'cancelled'> }>
  | Readonly<{ verdict: 'cancelled'; reason: LaneInterruptReason }>
);

type BackendResultBase = InvocationBinding & Readonly<{
  type: 'backend';
  routingRev: RoutingRev;
  outcome: BackendOutcome;
  usage: Usage;
  backendErrors: readonly BackendError[];
}>;
/** A judgment session is assigned at launch; an implementer's may be unknown if it died before reporting one. */
export type BackendResult =
  | (BackendResultBase & Readonly<{ role: FreshRole; session: JudgmentSessionId }>)
  | (BackendResultBase & Readonly<{ role: ImplementerRole; session: ImplementerSessionId | null }>);
export type CommandResult = InvocationBinding & Readonly<{
  type: 'command';
  purpose: CommandPurpose;
  expectedExit: number;
}> & CommandEnd;
export type ResultFile = BackendResult | CommandResult;

const backendOutcome: Read<BackendOutcome> = tagged('kind', {
  success: object((f): BackendOutcome => ({ kind: f.get('kind', literal('success')), value: f.get('value', (v, p) => {
    if (v === undefined) throw new SchemaError(p, 'a JSON value', v);
    return v as JsonValue;
  }) })),
  refusal: object((f): BackendOutcome => ({ kind: f.get('kind', literal('refusal')), stopReason: f.get('stopReason', str) })),
  malformed: object((f): BackendOutcome => ({ kind: f.get('kind', literal('malformed')), detail: f.get('detail', str) })),
  'process-fault': object((f): BackendOutcome => ({ kind: f.get('kind', literal('process-fault')), detail: f.get('detail', str) })),
  cancelled: object((f): BackendOutcome => ({ kind: f.get('kind', literal('cancelled')), reason: f.get('reason', oneOf(INTERRUPT_REASONS)) })),
});

const backendError: Read<BackendError> = object((f) => ({
  class: f.get('class', oneOf(BACKEND_ERROR_CLASSES)),
  message: f.get('message', text),
}));

export const resultFile: Read<ResultFile> = tagged('type', {
  backend: (value, path) => {
    const r = new Fields(value, path).get('role', role);
    return object((f): ResultFile => {
      const base = {
        ...binding(f),
        type: f.get('type', literal('backend')),
        routingRev: f.get('routingRev', rev),
        outcome: f.get('outcome', backendOutcome),
        usage: f.get('usage', usage),
        backendErrors: f.get('backendErrors', arrayOf(backendError)),
      };
      return r === 'build'
        ? { ...base, role: f.get('role', literal('build')), session: f.get('session', nullable((v, p) => implementerSessionId(v, p))) }
        : { ...base, role: f.get('role', oneOf(FRESH_ROLES)), session: f.get('session', (v, p) => judgmentSessionId(v, p)) };
    })(value, path);
  },
  command: object((f): ResultFile => {
    const base = {
      ...binding(f),
      type: f.get('type', literal('command')),
      purpose: f.get('purpose', oneOf(COMMAND_PURPOSES)),
      exitCode: f.get('exitCode', nullable(exitCode)),
      expectedExit: f.get('expectedExit', exitCode),
    };
    const verdict = f.get('verdict', oneOf(COMMAND_VERDICTS));
    const out: CommandResult = verdict === 'cancelled'
      ? { ...base, verdict, reason: f.get('reason', oneOf(LANE_INTERRUPT_REASONS)) }
      : { ...base, verdict };
    if (out.exitCode === null && (out.verdict === 'pass' || out.verdict === 'fail')) {
      throw new SchemaError(`${f.path}.verdict`, '"stall", "process-fault" or "cancelled" when exitCode is null', out.verdict);
    }
    return out;
  }),
});

/** True when the runner ended the workload, or the child ended by a signal or never started. */
function processFault(exit: ExitFile): string | null {
  if (exit.cause !== 'exited') return `workload ended by ${exit.cause}`;
  if (exit.child.type === 'signalled') return `child killed by ${exit.child.signal}`;
  if (exit.child.type === 'spawn-failed') return `spawn failed: ${exit.child.error}`;
  return null;
}

/**
 * The result.json precedence rule for backends, pure over the terminal files:
 * 1. cause cancel → cancelled{cancel.json's reason: pause|stop}, whatever the output (cancel.json must say so);
 * 2. cause deadline/stall/recovery-kill, a signal, or a failed spawn → process-fault, whatever the output;
 * 3. non-zero exit with schema-valid output → malformed; non-zero exit without it → process-fault;
 * 4. exit 0 without schema-valid output → malformed;
 * 5. exit 0 with schema-valid output → success.
 */
export function classifyTerminal(exit: ExitFile, cancel: CancelFile | null, output: unknown, schemaValid: boolean): TerminalOutcome {
  if (exit.cause === 'cancel') {
    if (cancel === null || cancel.reason === 'recovery' || cancel.reason === 'preempt') {
      throw new Error(`${exit.inv}: exit cause cancel with cancel.json ${JSON.stringify(cancel?.reason ?? null)}, expected pause or stop (a backend call is never preempted)`);
    }
    return { kind: 'cancelled', reason: cancel.reason };
  }
  const fault = processFault(exit);
  if (fault !== null) return { kind: 'process-fault', detail: fault };
  const code = (exit.child as Extract<ChildEnd, { type: 'exited' }>).code;
  if (code !== 0) {
    return schemaValid
      ? { kind: 'malformed', detail: `exit ${code} with schema-valid output` }
      : { kind: 'process-fault', detail: `exit ${code} without schema-valid output` };
  }
  if (!schemaValid) return { kind: 'malformed', detail: 'exit 0 without schema-valid output' };
  return { kind: 'success', value: output as JsonValue };
}

/**
 * The same precedence for commands: a cancel is `cancelled{cancel.json's reason}`, as for a backend; a stall
 * kill is a stall; any other runner kill or a signal is a process fault; otherwise the exit code decides.
 */
export function classifyCommand(exit: ExitFile, cancel: CancelFile | null, expectedExit: number): CommandEnd {
  const exitCode = exit.child.type === 'exited' ? exit.child.code : null;
  if (exit.cause === 'cancel') {
    if (cancel === null || cancel.reason === 'recovery') throw new Error(`${exit.inv}: exit cause cancel with cancel.json ${JSON.stringify(cancel?.reason ?? null)}, expected pause or stop`);
    return { exitCode, verdict: 'cancelled', reason: cancel.reason };
  }
  if (exit.cause === 'stall') return { exitCode, verdict: 'stall' };
  if (processFault(exit) !== null) return { exitCode, verdict: 'process-fault' };
  return { exitCode, verdict: exitCode === expectedExit ? 'pass' : 'fail' };
}

// reads.json -------------------------------------------------------------------------------------------

/**
 * One read-only tool call a Claude session made, as its tool_use input named it: Read's `file_path`;
 * Grep's and Glob's `pattern` and optional `path` (null: the session's cwd).
 */
export type ToolRead =
  | Readonly<{ tool: 'Read'; path: string }>
  | Readonly<{ tool: 'Grep' | 'Glob'; pattern: string; path: string | null }>;
/** What a Claude session read, in call order, from its stream-json stdout. Audit only: nothing binds it. */
export type ReadsFile = InvocationBinding & Readonly<{ reads: readonly ToolRead[] }>;

const toolRead: Read<ToolRead> = tagged('tool', {
  Read: object((f): ToolRead => ({ tool: f.get('tool', literal('Read')), path: f.get('path', str) })),
  Grep: object((f): ToolRead => ({ tool: f.get('tool', literal('Grep')), pattern: f.get('pattern', str), path: f.get('path', nullable(str)) })),
  Glob: object((f): ToolRead => ({ tool: f.get('tool', literal('Glob')), pattern: f.get('pattern', str), path: f.get('path', nullable(str)) })),
});
export const readsFile: Read<ReadsFile> = object((f) => ({ ...binding(f), reads: f.get('reads', arrayOf(toolRead)) }));

export const RUNNER_FILES = ['launch.json', 'runner.json', 'cancel.json', 'exit.json', 'result.json', 'reads.json'] as const;
export type RunnerFileName = (typeof RUNNER_FILES)[number];
export type RunnerFileMap = {
  'launch.json': LaunchFile;
  'runner.json': RunnerFile;
  'cancel.json': CancelFile;
  'exit.json': ExitFile;
  'result.json': ResultFile;
  'reads.json': ReadsFile;
};
export const RUNNER_FILE_READERS: { readonly [N in RunnerFileName]: Read<RunnerFileMap[N]> } = {
  'launch.json': launchFile,
  'runner.json': runnerFile,
  'cancel.json': cancelFile,
  'exit.json': exitFile,
  'result.json': resultFile,
  'reads.json': readsFile,
};
/** The workload's stdout and stderr go to these files in the invocation dir; never pipes. */
export const STDOUT_FILE = 'stdout';
export const STDERR_FILE = 'stderr';

// ---------------------------------------------------------------------------------------------------
// A lane's ignored-output census (`<laneDir>/ignored.json`, src/git/ignored.ts)

/**
 * Why a gitignored file a lane wrote was not captured. `not-declared`: the lane passed, and nothing
 * captures a passing lane's undeclared ignored output. `unglobbable`: its name has no exact glob under
 * node's `fs.globSync` (a backslash, or a brace group), so no snapshot can name it alone.
 */
export const IGNORED_REASONS = ['not-declared', 'build-output', 'excluded', 'over-file-cap', 'over-lane-cap', 'not-regular', 'unglobbable'] as const;
export type IgnoredReason = (typeof IGNORED_REASONS)[number];
export type FileCount = Readonly<{ files: number; bytes: number }>;
/** `dir`: the files' directory, at most two segments deep (`a/b/`), `(root)` for top-level files, `(other)` for the folded tail. */
export type IgnoredGroup = FileCount & Readonly<{ dir: string; reason: IgnoredReason }>;
/** The gitignored files a lane created or changed; `captured` counts its declared evidence and the default capture. */
export type IgnoredCensus = Readonly<{ v: SchemaVersion; written: FileCount; captured: FileCount; uncaptured: readonly IgnoredGroup[] }>;

const fileCount: Read<FileCount> = object((f) => ({ files: f.get('files', nat), bytes: f.get('bytes', nat) }));
export const ignoredCensus: Read<IgnoredCensus> = object((f) => ({
  v: f.get('v', version),
  written: f.get('written', fileCount),
  captured: f.get('captured', fileCount),
  uncaptured: f.get('uncaptured', arrayOf(object((g) => ({
    dir: g.get('dir', str), files: g.get('files', positive), bytes: g.get('bytes', nat), reason: g.get('reason', oneOf(IGNORED_REASONS)),
  })))),
}));

// ---------------------------------------------------------------------------------------------------
// Approval fingerprint and dispatch record

/** Approval binds to this; any field differing at the gated tip invalidates the gate. Lists are sorted. */
export type ApprovalFingerprint = Readonly<{
  unitCommit: Sha;
  specRev: SpecRev;
  /** Blob SHAs at the gated tip of every cited contract and the architecture doc, ascending by path. */
  contractRevs: readonly Readonly<{ path: RepoPath; blob: Sha }>[];
  /** Revisions of every cited C-nn, ascending by id. */
  rulingRevs: readonly Readonly<{ id: RulingId; rev: number }>[];
  /**
   * M3: the normative revisions of the selected, non-exempt obligations at the gated tip, ascending by id.
   * Absent exactly when there are none (non-empty when present), so a fingerprint with no obligations is
   * byte-identical to a 1.0.0-dev.5 one and compares equal to it (`obligationRevsOf`).
   */
  obligationRevs?: readonly ObligationRev[];
}>;
export type ObligationRev = Readonly<{ id: ObligationId; rev: number }>;

const obligationRev: Read<ObligationRev> = object((g) => ({ id: g.get('id', (v, p) => obligationId(v, p)), rev: g.get('rev', positive) }));

export const approvalFingerprint: Read<ApprovalFingerprint> = object((f) => {
  const obligationRevs = f.optional('obligationRevs', sortedBy(obligationRev, (e) => e.id, { nonEmpty: true }));
  return {
    unitCommit: f.get('unitCommit', commitSha),
    specRev: f.get('specRev', (v, p) => specRev(v, p)),
    contractRevs: f.get('contractRevs', sortedBy(object((g) => ({ path: g.get('path', (v, p) => repoPath(v, p)), blob: g.get('blob', commitSha) })), (e) => e.path)),
    rulingRevs: f.get('rulingRevs', sortedBy(object((g) => ({ id: g.get('id', (v, p) => rulingId(v, p)), rev: g.get('rev', positive) })), (e) => e.id)),
    ...(obligationRevs === undefined ? {} : { obligationRevs }),
  };
});

/** The fingerprint's obligation revisions; none when the field is absent (its one encoding of none). */
export const obligationRevsOf = (fp: ApprovalFingerprint): readonly ObligationRev[] => fp.obligationRevs ?? [];

/**
 * A unit's bounds (M3, `limits`): the counters' limits and the backend deadlines the transition table and the
 * stages read, resolved from the built-in defaults, the plan's `limits` and the unit's (`boundsOf`,
 * src/input/plan.ts). Deadlines are whole minutes.
 */
export type Bounds = Readonly<{
  /** The chargeable failure that reaches this parks the unit (design). */
  chargeable: number;
  /** Plan-check redirects since the architect's latest spec revision. */
  redirects: number;
  reviseRounds: number;
  candidateReds: number;
  /** Uncharged retries per retry stage. */
  retries: number;
  judgmentDeadlineMin: number;
  freshBuildMin: number;
  /** What a fix, resume or resolve round may spend editing on top of the lane series. */
  editAllowanceMin: number;
}>;
export const BOUND_FIELDS = ['chargeable', 'redirects', 'reviseRounds', 'candidateReds', 'retries', 'judgmentDeadlineMin', 'freshBuildMin', 'editAllowanceMin'] as const satisfies readonly (keyof Bounds)[];
/** The built-in bounds: M2's constants (unmeasured defaults). */
export const DEFAULT_BOUNDS: Bounds = {
  chargeable: 3, redirects: 2, reviseRounds: 2, candidateReds: 1, retries: 1, judgmentDeadlineMin: 45, freshBuildMin: 180, editAllowanceMin: 60,
};
export const bounds: Read<Bounds> = object((f) => Object.fromEntries(BOUND_FIELDS.map((k) => [k, f.get(k, positive)])) as Bounds);

/** H15: the transient-check rules a unit's lineage attempt runs under; absent on a 1.0.0-dev.5 dispatch (`transientRulesOf`). */
export const TRANSIENT_RULES = ['m3'] as const;
export type TransientRules = (typeof TRANSIENT_RULES)[number];

/**
 * Pinned once when a unit is dispatched; a redirect can neither widen `scope` nor lower `riskFloor`.
 * `specRev` and `specSha256` are the spec revision the dispatching plan-check read and its file's hash.
 * `implementerSeatRev` hashes the triple of the implementer's seat (`build.<riskFloor>`) under `routingRev`,
 * so a routing change can be judged by whether it moves the implementer without naming a model.
 */
export type DispatchRecord = Readonly<{
  unit: UnitId;
  specRev: SpecRev;
  specSha256: Sha256Hex;
  scope: readonly RepoPattern[];
  riskFloor: RiskTier;
  routingRev: RoutingRev;
  implementerSeatRev: SeatRev;
  at: IsoTime;
  /**
   * M3 (H15): `m3` on every dispatch since 1.0.0-dev.6: the unit's candidate may touch only its pinned scope and
   * ruling-added paths, and no in-tree `.roadmap/` path. Absent (a 1.0.0-dev.5 dispatch): dev.5's rules for the
   * lineage attempt (`transientRulesOf`, src/core/upgrade.ts). A re-pin copies it.
   */
  transientRules?: TransientRules;
  /** M3 (`limits`): the unit's bounds in force since this pin; absent: `DEFAULT_BOUNDS` (`boundsOfRecord`). */
  bounds?: Bounds;
}>;

export const dispatchRecord: Read<DispatchRecord> = object((f) => {
  const transientRules = f.optional('transientRules', oneOf(TRANSIENT_RULES));
  const b = f.optional('bounds', bounds);
  return {
    unit: f.get('unit', unit),
    specRev: f.get('specRev', (v, p) => specRev(v, p)),
    specSha256: f.get('specSha256', (v, p) => sha256(v, p)),
    scope: f.get('scope', sortedBy((v, p) => repoPattern(v, p), (s) => s, { nonEmpty: true })),
    riskFloor: f.get('riskFloor', riskTier),
    routingRev: f.get('routingRev', rev),
    implementerSeatRev: f.get('implementerSeatRev', (v, p) => seatRev(v, p)),
    at: f.get('at', time),
    ...(transientRules === undefined ? {} : { transientRules }),
    ...(b === undefined ? {} : { bounds: b }),
  };
});

/** The bounds a dispatch record pins: its own, or the built-in ones when it names none. */
export const boundsOfRecord = (record: DispatchRecord | null): Bounds => record?.bounds ?? DEFAULT_BOUNDS;

// ---------------------------------------------------------------------------------------------------
// spec.json (M1 subset) and SpecPatch

/** `set`: literal values. `pass`: names copied from the executor's environment; absent → spec-lane-unrunnable. */
export type LaneEnv = Readonly<{ set: Readonly<Record<string, string>>; pass: readonly string[] }>;
export type LaneTier = 'fast' | 'estate';

export type LaneDef = Readonly<{
  id: LaneId;
  /** argv[0] is a PATH-resolvable name or a path; there is no shell. */
  argv: readonly string[];
  /** Relative to the worktree the lane runs in. */
  cwd: RepoPath;
  env: LaneEnv;
  expectedExit: number;
  tier: LaneTier;
  resources: readonly ResourceName[];
  evidenceGlobs: readonly RepoPattern[];
  /**
   * Kept out of the capture of a failing lane's undeclared ignored output, beside the default secret
   * excludes; declared `evidenceGlobs` are never filtered. Optional in spec.json, read as [] when absent.
   */
  evidenceExcludes: readonly RepoPattern[];
  /** `@cpu` tokens the lane takes (M2); absent: its tier's default (fast 2, estate 4). Absent stays absent. */
  cpu?: number;
}>;

export const laneEnv: Read<LaneEnv> = object((f) => {
  const out = { set: f.get('set', stringMap), pass: f.get('pass', arrayOf(envName)) };
  assertUnique(out.pass, (s) => s, `${f.path}.pass`);
  for (const name of out.pass) {
    if (Object.hasOwn(out.set, name)) throw new SchemaError(`${f.path}.pass`, `names not also in set`, name);
  }
  return out;
});

function laneFields(f: Fields): LaneDef {
  const out = {
    id: f.get('id', (v, p) => laneId(v, p)),
    argv: f.get('argv', argv),
    cwd: f.get('cwd', (v, p) => repoPath(v, p)),
    env: f.get('env', laneEnv),
    expectedExit: f.get('expectedExit', exitCode),
    tier: f.get('tier', oneOf(['fast', 'estate'] as const)),
    resources: f.get('resources', arrayOf(resource)),
    evidenceGlobs: f.get('evidenceGlobs', arrayOf((v, p) => repoPattern(v, p))),
    evidenceExcludes: f.optional('evidenceExcludes', arrayOf((v, p) => repoPattern(v, p))) ?? [],
  };
  const cpu = f.optional('cpu', positive);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  return cpu === undefined ? out : { ...out, cpu };
}
export const laneDef: Read<LaneDef> = object(laneFields);

/** Items keep their id forever; strike and defer change state, never delete, so ids are never reused. */
export type ItemState = 'active' | 'struck' | 'deferred';
export type AcceptanceDef = Readonly<{ id: ClauseId; clause: string; failLoudIfUndelivered: boolean }>;
export type NoteDef = Readonly<{ id: ClauseId; text: string }>;
type Stated<T> = T & Readonly<{ state: ItemState }>;

/**
 * What a unit's judgment and build prompts embed in full: plan contracts and C-nn rulings (arc-1 feedback
 * item 12). Every other contract and ruling reaches a prompt as a one-line index entry, readable on demand.
 * Filled at spec authoring; a plan-check redirect may add to it (the `cite` op), nothing removes from it.
 */
export type SpecCites = Readonly<{ contracts: readonly RepoPath[]; rulings: readonly RulingId[] }>;

function citesFields(f: Fields): SpecCites {
  const out = { contracts: f.get('contracts', arrayOf((v, p) => repoPath(v, p))), rulings: f.get('rulings', arrayOf((v, p) => rulingId(v, p))) };
  assertUnique(out.contracts, (c) => c, `${f.path}.contracts`);
  assertUnique(out.rulings, (r) => r, `${f.path}.rulings`);
  return out;
}
export const specCites: Read<SpecCites> = object(citesFields);

export const SPEC_SCHEMA = 'roadmap/spec-m1';
export type SpecM1 = Readonly<{
  schema: typeof SPEC_SCHEMA;
  unit: UnitId;
  rev: SpecRev;
  lanes: readonly Stated<LaneDef>[];
  acceptance: readonly Stated<AcceptanceDef>[];
  scope: readonly RepoPattern[];
  resources: readonly ResourceName[];
  decisions: readonly Stated<NoteDef>[];
  facts: readonly Stated<NoteDef>[];
  cites: SpecCites;
  /**
   * M3 (A13): the obligations the unit declares it serves (non-empty when present; absent: none). The
   * classifier checks them against the impact mapping (prefix-conservative over its scope).
   */
  obligations?: readonly ObligationId[];
  /** M3 (A13): what a repair unit repairs, findings or obligations (non-empty when present; required with `origin: repair`). */
  repairs?: readonly RepairRef[];
}>;

/** What a repair names: a finding (`F-<n>`) or an obligation (`I-<n>`). */
export type RepairRef = FindingId | ObligationId;
export const repairRef: Read<RepairRef> = (v, p) => (typeof v === 'string' && v.startsWith('F-') ? findingId(v, p) : obligationId(v, p));

/** A spec's declared obligations and repairs; none when absent. */
export const specObligations = (spec: SpecM1): readonly ObligationId[] => spec.obligations ?? [];
export const specRepairs = (spec: SpecM1): readonly RepairRef[] => spec.repairs ?? [];

const itemState: Read<ItemState> = oneOf(['active', 'struck', 'deferred'] as const);
const cid: Read<ClauseId> = (v, p) => clauseId(v, p);
function acceptanceFields(f: Fields): AcceptanceDef {
  return { id: f.get('id', cid), clause: f.get('clause', str), failLoudIfUndelivered: f.get('failLoudIfUndelivered', bool) };
}
function noteFields(f: Fields): NoteDef {
  return { id: f.get('id', cid), text: f.get('text', str) };
}
function stated<T>(fields: (f: Fields) => T): Read<Stated<T>> {
  return object((f) => ({ ...fields(f), state: f.get('state', itemState) }));
}

export const specM1: Read<SpecM1> = object((f) => {
  const obligations = f.optional('obligations', arrayOf((v, p) => obligationId(v, p), { nonEmpty: true }));
  const repairs = f.optional('repairs', arrayOf(repairRef, { nonEmpty: true }));
  const out: SpecM1 = {
    schema: f.get('schema', literal(SPEC_SCHEMA)),
    unit: f.get('unit', unit),
    rev: f.get('rev', (v, p) => specRev(v, p)),
    lanes: f.get('lanes', arrayOf(stated(laneFields))),
    acceptance: f.get('acceptance', arrayOf(stated(acceptanceFields), { nonEmpty: true })),
    scope: f.get('scope', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })),
    resources: f.get('resources', arrayOf(resource)),
    decisions: f.get('decisions', arrayOf(stated(noteFields))),
    facts: f.get('facts', arrayOf(stated(noteFields))),
    cites: f.get('cites', specCites),
    ...(obligations === undefined ? {} : { obligations }),
    ...(repairs === undefined ? {} : { repairs }),
  };
  assertUnique([...out.lanes, ...out.acceptance, ...out.decisions, ...out.facts], (i) => i.id, `${f.path}.<item ids>`);
  assertUnique(specObligations(out), (o) => o, `${f.path}.obligations`);
  assertUnique(specRepairs(out), (r) => r, `${f.path}.repairs`);
  assertUnique(out.scope, (s) => s, `${f.path}.scope`);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  return out;
});

export const SPEC_SECTIONS = ['lanes', 'acceptance', 'decisions', 'facts'] as const;
export type SpecSection = (typeof SPEC_SECTIONS)[number];
type SectionItem = { lanes: LaneDef; acceptance: AcceptanceDef; decisions: NoteDef; facts: NoteDef };

/**
 * Scope and resources are pinned at dispatch and are not patchable in M1. `cite` adds contracts and rulings
 * to the spec's cites (at least one); there is no op that removes one.
 */
export type SpecPatchOp =
  | { readonly [S in SpecSection]: Readonly<{ op: 'add'; section: S; item: SectionItem[S] }> }[SpecSection]
  | { readonly [S in SpecSection]: Readonly<{ op: 'replace'; section: S; item: SectionItem[S] }> }[SpecSection]
  | Readonly<{ op: 'strike' | 'defer'; id: LaneId | ClauseId }>
  | Readonly<{ op: 'cite' } & SpecCites>;

/**
 * Who patched: a plan-check redirect (the judgment invocation), or the executor appending the implementer's
 * `decisions.json` after a build round's evidence snapshot (`inv` is the build invocation that wrote it).
 */
export type SpecPatchBy =
  | Readonly<{ role: 'planCheck'; routingRev: RoutingRev; inv: InvocationId }>
  | Readonly<{ role: 'executor'; inv: InvocationId }>;

export type SpecPatch = Readonly<{
  expectRev: SpecRev;
  by: SpecPatchBy;
  ops: readonly SpecPatchOp[];
}>;

const sectionItem: { readonly [S in SpecSection]: Read<SectionItem[S]> } = {
  lanes: laneDef,
  acceptance: object(acceptanceFields),
  decisions: object(noteFields),
  facts: object(noteFields),
};

function itemOp(op: 'add' | 'replace'): Read<SpecPatchOp> {
  return (value, path) => {
    const section = new Fields(value, path).get('section', oneOf(SPEC_SECTIONS));
    const item: Read<unknown> = sectionItem[section];
    return object((f) => ({
      op: f.get('op', literal(op)),
      section: f.get('section', literal(section)),
      item: f.get('item', item),
    }) as SpecPatchOp)(value, path);
  };
}
function idOp(op: 'strike' | 'defer'): Read<SpecPatchOp> {
  return object((f) => ({ op: f.get('op', literal(op)), id: f.get('id', (v, p): LaneId | ClauseId => clauseId(v, p)) }));
}

const citeOp: Read<SpecPatchOp> = (value, path) => {
  const op = object((f) => ({ op: f.get('op', literal('cite')), ...citesFields(f) }))(value, path);
  if (op.contracts.length + op.rulings.length === 0) throw new SchemaError(path, 'a cite op naming at least one contract or ruling', value);
  return op;
};

export const specPatchOp: Read<SpecPatchOp> = tagged('op', {
  add: itemOp('add'),
  replace: itemOp('replace'),
  strike: idOp('strike'),
  defer: idOp('defer'),
  cite: citeOp,
});

export const specPatch: Read<SpecPatch> = object((f) => ({
  expectRev: f.get('expectRev', (v, p) => specRev(v, p)),
  by: f.get('by', tagged<'planCheck' | 'executor', SpecPatchBy>('role', {
    planCheck: object((g): SpecPatchBy => ({ role: g.get('role', literal('planCheck')), routingRev: g.get('routingRev', rev), inv: g.get('inv', inv) })),
    executor: object((g): SpecPatchBy => ({ role: g.get('role', literal('executor')), inv: g.get('inv', inv) })),
  })),
  ops: f.get('ops', arrayOf(specPatchOp, { nonEmpty: true })),
}));

// ---------------------------------------------------------------------------------------------------
// Host files under /var/tmp/roadmap/

/** host.lock, claimed by link(tmp, host.lock). */
export type HostLockClaim = Readonly<{
  v: SchemaVersion;
  nonce: Nonce;
  generation: number;
  bootId: BootId;
  supervisor: ProcIdentity;
  arc: ArcId;
  runDir: AbsPath;
  repo: AbsPath;
}>;
const nonceR: Read<Nonce> = (v, p) => nonce(v, p);
const bootR: Read<BootId> = (v, p) => bootId(v, p);
export const hostLockClaim: Read<HostLockClaim> = object((f) => ({
  v: f.get('v', version),
  nonce: f.get('nonce', nonceR),
  generation: f.get('generation', positive),
  bootId: f.get('bootId', bootR),
  supervisor: f.get('supervisor', procIdentity),
  arc: f.get('arc', arc),
  runDir: f.get('runDir', abs),
  repo: f.get('repo', abs),
}));

/** host.owner.json, published atomically by the supervisor; `executor: null` before the spawn. */
export type HostOwner = Readonly<{ v: SchemaVersion; nonce: Nonce; generation: number; executor: ProcIdentity | null }>;
export const hostOwner: Read<HostOwner> = object((f) => ({
  v: f.get('v', version),
  nonce: f.get('nonce', nonceR),
  generation: f.get('generation', positive),
  executor: f.get('executor', nullable(procIdentity)),
}));

/** host.recovery.lock, claimed by link() before any takeover side effect. */
export type RecoveryLockClaim = Readonly<{ v: SchemaVersion; nonce: Nonce; bootId: BootId; holder: ProcIdentity; at: IsoTime }>;
export const recoveryLockClaim: Read<RecoveryLockClaim> = object((f) => ({
  v: f.get('v', version),
  nonce: f.get('nonce', nonceR),
  bootId: f.get('bootId', bootR),
  holder: f.get('holder', procIdentity),
  at: f.get('at', time),
}));

/** `handshake.<generation>`: the executor performs no effect until this exists and matches host.owner.json. */
export type HandshakeFile = Readonly<{ v: SchemaVersion; nonce: Nonce; generation: number }>;
export const handshakeFile: Read<HandshakeFile> = object((f) => ({
  v: f.get('v', version),
  nonce: f.get('nonce', nonceR),
  generation: f.get('generation', positive),
}));

/** `supervisor.ready.<generation>` or `supervisor.failed.<generation>`; `start` waits ≤30 s for its own generation. */
export type ReadinessFile =
  | Readonly<{ v: SchemaVersion; generation: number; state: 'ready'; at: IsoTime }>
  | Readonly<{ v: SchemaVersion; generation: number; state: 'failed'; at: IsoTime; reason: string }>;
export const readinessFile: Read<ReadinessFile> = tagged('state', {
  ready: object((f): ReadinessFile => ({ v: f.get('v', version), generation: f.get('generation', positive), state: f.get('state', literal('ready')), at: f.get('at', time) })),
  failed: object((f): ReadinessFile => ({ v: f.get('v', version), generation: f.get('generation', positive), state: f.get('state', literal('failed')), at: f.get('at', time), reason: f.get('reason', str) })),
});

/**
 * supervisor.state.json: the crash window survives supervisor restarts. `heartbeatStaleMs` is the stale
 * threshold in force: 5 min unless the supervisor was started with `--heartbeat-stale-ms` (step 14a).
 */
export type SupervisorState = Readonly<{ v: SchemaVersion; generation: number; crashes: readonly IsoTime[]; heartbeatStaleMs: number }>;
export const supervisorState: Read<SupervisorState> = object((f) => ({
  v: f.get('v', version),
  generation: f.get('generation', positive),
  crashes: f.get('crashes', sortedBy(time, (t) => t)),
  heartbeatStaleMs: f.get('heartbeatStaleMs', positive),
}));

/** exit.reason.json: intentional executor exits, which the supervisor does not count as crashes. */
export type ExecutorExitReason = Readonly<{ v: SchemaVersion; generation: number; reason: 'stop' | 'complete' | 'refused' }>;
export const executorExitReason: Read<ExecutorExitReason> = object((f) => ({
  v: f.get('v', version),
  generation: f.get('generation', positive),
  reason: f.get('reason', oneOf(['stop', 'complete', 'refused'] as const)),
}));

/**
 * start.json in the run dir, rewritten by every start that passed its checks (step 13b): what the executor
 * runs. `status` reads it to re-resolve the routing tables its by-model view names models from, since no
 * record carries a model. `profile` is the resolved one.
 */
export type RunStart = Readonly<{ v: SchemaVersion; generation: number; at: IsoTime; repo: AbsPath; planFile: AbsPath; profile: ProfileName }>;
export const runStart: Read<RunStart> = object((f) => ({
  v: f.get('v', version),
  generation: f.get('generation', positive),
  at: f.get('at', time),
  repo: f.get('repo', abs),
  planFile: f.get('planFile', abs),
  profile: f.get('profile', profileName),
}));

/** heartbeat.json in the run dir, every 10 s; stale after 5 min. */
export type Heartbeat = Readonly<{ v: SchemaVersion; generation: number; at: IsoTime }>;
export const heartbeat: Read<Heartbeat> = object((f) => ({ v: f.get('v', version), generation: f.get('generation', positive), at: f.get('at', time) }));

/**
 * A residue is keyed per resource instance: a named resource or a pool instance (never an `@cpu` token). Its
 * owner (M3, G4) is the unit whose stage failed its cleanup (`unit`, every residue before M3) or the durable job
 * whose lane did (`job`); exactly one of the two is present (`residueOwner`).
 */
export type ResidueKey = Readonly<{ arc: ArcId; inv: InvocationId; resource: ResourceInstance }>
  & (Readonly<{ unit: UnitId; job?: never }> | Readonly<{ job: JobId; unit?: never }>);
export type ResidueOwner = Readonly<{ type: 'unit'; unit: UnitId }> | Readonly<{ type: 'job'; job: JobId }>;
export const residueKey: Read<ResidueKey> = (value, path) => {
  const job = typeof value === 'object' && value !== null && Object.hasOwn(value, 'job');
  return object((f): ResidueKey => {
    const base = { arc: f.get('arc', arc), inv: f.get('inv', inv), resource: f.get('resource', (v, p) => resourceInstance(v, p)) };
    return job ? { ...base, job: f.get('job', (v, p) => jobIdOf(v, p)) } : { ...base, unit: f.get('unit', unit) };
  })(value, path);
};
export function residueOwner(key: ResidueKey): ResidueOwner {
  if (key.job !== undefined) return { type: 'job', job: key.job };
  if (key.unit !== undefined) return { type: 'unit', unit: key.unit };
  throw new Error(`residue key ${JSON.stringify(key)} names no owner`);
}

export type TeardownRecipe = Readonly<{ argv: readonly string[]; cwd: AbsPath; env: Readonly<Record<string, string>> }>;

/**
 * The body of one residues.jsonl line (`ResidueLine` in events.ts: same chain and tail rules as events.jsonl, no `arc`).
 * `cleaned` comes only from a sweep; `isolated | transferred` only from a needs-user disposition.
 */
export type ResidueRecord =
  | Readonly<{ type: 'residue'; key: ResidueKey; teardown: TeardownRecipe; label: string }>
  | Readonly<{ type: 'disposition'; key: ResidueKey; disposition: 'cleaned'; by: Readonly<{ arc: ArcId; inv: InvocationId }> }>
  | Readonly<{ type: 'disposition'; key: ResidueKey; disposition: 'isolated' | 'transferred'; by: Readonly<{ arc: ArcId; needsUser: NeedsUserId }> }>;

/** Reads the record body of a residue line; the chain envelope is read by `parseChainLine` (events.ts). */
export const residueRecord: Read<ResidueRecord> = tagged('type', {
  residue: object((f): ResidueRecord => ({
    type: f.get('type', literal('residue')),
    key: f.get('key', residueKey),
    teardown: f.get('teardown', object((g) => ({ argv: g.get('argv', argv), cwd: g.get('cwd', abs), env: g.get('env', stringMap) }))),
    label: f.get('label', str),
  })),
  disposition: (value, path) => {
    const d = new Fields(value, path).get('disposition', oneOf(['cleaned', 'isolated', 'transferred'] as const));
    return object((f): ResidueRecord => {
      const type = f.get('type', literal('disposition'));
      const key = f.get('key', residueKey);
      if (d === 'cleaned') {
        return { type, key, disposition: f.get('disposition', literal('cleaned')), by: f.get('by', object((g) => ({ arc: g.get('arc', arc), inv: g.get('inv', inv) }))) };
      }
      return { type, key, disposition: f.get('disposition', oneOf(['isolated', 'transferred'] as const)), by: f.get('by', object((g) => ({ arc: g.get('arc', arc), needsUser: g.get('needsUser', (v, p) => needsUserId(v, p)) }))) };
    })(value, path);
  },
});

// ---------------------------------------------------------------------------------------------------
// Commands and receipts: `commands/incoming/<id>.json`, `commands/receipts/<id>.<state>.json`

export type PauseTarget = Readonly<{ type: 'unit'; unit: UnitId }> | Readonly<{ type: 'all' }>;
export type ResumeTarget = PauseTarget | Readonly<{ type: 'backend'; backend: Backend }>;

/**
 * What a plan revision is made of: the sha256 of plan.json's bytes and of each unit's spec.json bytes, keyed by
 * unit id (every unit of that plan). `roadmap apply` hashes the files into one; the `plan-applied` fact
 * records the one in force. The bytes are kept content-addressed in the run dir (`inputs/<sha256>.plan.json`,
 * `inputs/<sha256>.spec.json`).
 */
export type PlanManifest = Readonly<{ planSha256: Sha256Hex; specs: Readonly<Record<UnitId, Sha256Hex>> }>;

export const manifestSpecs: Read<Readonly<Record<UnitId, Sha256Hex>>> = (value, path) => {
  const f = new Fields(value, path);
  const out: Record<UnitId, Sha256Hex> = {};
  for (const key of Object.keys(value as object)) out[unitId(key, `${path}.${key}`)] = f.get(key, (v, p) => sha256(v, p));
  f.end();
  if (Object.keys(out).length === 0) throw new SchemaError(path, 'at least one unit', value);
  return out;
};
export const planManifest: Read<PlanManifest> = object((f) => ({
  planSha256: f.get('planSha256', (v, p) => sha256(v, p)),
  specs: f.get('specs', manifestSpecs),
}));

/**
 * M3 (G1, A3, A14): the revisioned set beyond plan and specs. `rulings`: the ledger's bytes and each ruling
 * sidecar's (kept as `inputs/<sha256>.rulings.md` and `inputs/<sha256>.ruling.json`); `obligations` and `vision`:
 * the obligations and vision files' (`inputs/<sha256>.obligations.json`, `.vision.json`), null when the plan
 * names none.
 */
export type RevisionInputs = Readonly<{
  rulings: Readonly<{ ledgerSha256: Sha256Hex; sidecars: Readonly<Record<RulingId, Sha256Hex>> }>;
  obligations: Sha256Hex | null;
  vision: Sha256Hex | null;
}>;
/** What an M3 `apply` hashes (A2): the plan manifest and the revision inputs. */
export type RevisionManifest = PlanManifest & RevisionInputs;
/**
 * An `apply` body's manifest: a `RevisionManifest` since 1.0.0-dev.6, or a 1.0.0-dev.5 command's `PlanManifest`
 * (G15), which is read as the ledger live and no obligations or vision (`applyInputsOf`, src/core/upgrade.ts). The
 * command's bytes and `commandSha256` are never rewritten.
 */
export type ApplyManifest = PlanManifest | RevisionManifest;

const sidecarShas: Read<Readonly<Record<RulingId, Sha256Hex>>> = (value, path) => {
  const f = new Fields(value, path);
  const out: Record<RulingId, Sha256Hex> = {};
  for (const key of Object.keys(value as object)) out[rulingId(key, `${path}.${key}`)] = f.get(key, (v, p) => sha256(v, p));
  f.end();
  return out;
};
export const revisionInputs = (f: Fields): RevisionInputs => ({
  rulings: f.get('rulings', object((g) => ({ ledgerSha256: g.get('ledgerSha256', (v, p) => sha256(v, p)), sidecars: g.get('sidecars', sidecarShas) }))),
  obligations: f.get('obligations', nullable((v, p) => sha256(v, p))),
  vision: f.get('vision', nullable((v, p) => sha256(v, p))),
});
export const applyManifest: Read<ApplyManifest> = (value, path) => {
  const m3 = typeof value === 'object' && value !== null && Object.hasOwn(value, 'rulings');
  return object((f): ApplyManifest => ({
    planSha256: f.get('planSha256', (v, p) => sha256(v, p)),
    specs: f.get('specs', manifestSpecs),
    ...(m3 ? revisionInputs(f) : {}),
  }))(value, path);
};
export const isRevisionManifest = (m: ApplyManifest): m is RevisionManifest => 'rulings' in m;

export type CommandBody =
  | Readonly<{ type: 'pause'; target: PauseTarget }>
  | Readonly<{ type: 'stop' }>
  | Readonly<{ type: 'ack'; needsUser: NeedsUserId; choice: string | null }>
  | Readonly<{ type: 'resume'; target: ResumeTarget }>
  | Readonly<{ type: 'sweep'; resource: ResourceName | null }>
  /**
   * `roadmap apply`: make the plan and specs the manifest hashes the plan in force (the executor re-reads the
   * files and requires these hashes). `expectRev`: the plan revision the architect built on (`--expect-rev`),
   * or null to apply over whatever is in force. A mutation.
   */
  | Readonly<{ type: 'apply'; expectRev: PlanRev | null; manifest: ApplyManifest }>
  /** `roadmap resolve-edge` (M2): a contingent edge's condition is met, on the architect's evidence. Scope ∅. */
  | Readonly<{ type: 'resolve-edge'; edge: EdgeId; evidence: string }>
  /** `roadmap run-only <ids>` / `--clear` (M2): admission is limited to these units (sorted), or unlimited (null). Scope ∅. */
  | Readonly<{ type: 'run-only'; units: readonly UnitId[] | null }>
  /**
   * `roadmap rule <record.json>` (M3): a ruling sidecar, hashed by the CLI (`sha256` over the file's bytes at
   * `path`), validated and published through the revision fence. Scope ∅.
   */
  | Readonly<{ type: 'rule'; path: AbsPath; sha256: Sha256Hex }>
  /** `roadmap reverse <D-n>` (M3, H13): the compensating revision built from the divergence's preimage. Scope: the arc. */
  | Readonly<{ type: 'reverse'; divergence: DivergenceId }>
  /**
   * `roadmap steer <u> --brief <f> --budget <min> [--class <c>] [--resume]` (M3): the brief hashed like a rule
   * record; `class` null keeps the unit's routing; `resume`: a green steer continues instead of parking (R11).
   * Scope {u}.
   */
  | Readonly<{ type: 'steer'; unit: UnitId; brief: Readonly<{ path: AbsPath; sha256: Sha256Hex }>; budgetMin: number; class: ModelClass | null; resume: boolean }>
  /** `roadmap merge-in <u>` (M3): the integration head into the unit branch. Scope {u}. */
  | Readonly<{ type: 'merge-in'; unit: UnitId }>
  /** `roadmap audit [--lens <k,…>]` (M3): an audit of those lenses (ascending), or of the arc's lens set L (null). Scope ∅. */
  | Readonly<{ type: 'audit'; lenses: readonly LensKindName[] | null }>
  /** `roadmap close-admissions` (M3): latch `draining`. Scope ∅. */
  | Readonly<{ type: 'close-admissions' }>;

/** The lens names a command may carry; `LensKind` in src/holistic/types.ts is the same closed list. */
export const LENS_KIND_NAMES = ['invariants', 'drift', 'vacuity', 'vision'] as const;
export type LensKindName = (typeof LENS_KIND_NAMES)[number];
/** Control commands apply immediately (waiting only for an integration.ff critical section); mutations at safe points. */
export const CONTROL_COMMANDS = ['pause', 'stop', 'ack'] as const;

export type CommandFile = Readonly<{ v: SchemaVersion; id: CommandId; arc: ArcId; at: IsoTime; body: CommandBody }>;

const cmdId: Read<CommandId> = (v, p) => commandId(v, p);
export const optionId: Read<string> = (value, path) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new SchemaError(path, 'an option id (lowercase slug)', value);
  return value;
};

const unitTarget = object((f) => ({ type: f.get('type', literal('unit')), unit: f.get('unit', unit) }));
const allTarget = object((f) => ({ type: f.get('type', literal('all')) }));
export const pauseTarget: Read<PauseTarget> = tagged<'unit' | 'all', PauseTarget>('type', { unit: unitTarget, all: allTarget });
export const resumeTarget: Read<ResumeTarget> = tagged<'all' | 'unit' | 'backend', ResumeTarget>('type', {
  all: allTarget,
  unit: unitTarget,
  backend: object((g) => ({ type: g.get('type', literal('backend')), backend: g.get('backend', backend) })),
});
export const commandBody: Read<CommandBody> = tagged('type', {
  pause: object((f): CommandBody => ({ type: f.get('type', literal('pause')), target: f.get('target', pauseTarget) })),
  stop: object((f): CommandBody => ({ type: f.get('type', literal('stop')) })),
  ack: object((f): CommandBody => ({
    type: f.get('type', literal('ack')),
    needsUser: f.get('needsUser', (v, p) => needsUserId(v, p)),
    choice: f.get('choice', nullable(optionId)),
  })),
  resume: object((f): CommandBody => ({ type: f.get('type', literal('resume')), target: f.get('target', resumeTarget) })),
  sweep: object((f): CommandBody => ({ type: f.get('type', literal('sweep')), resource: f.get('resource', nullable(resource)) })),
  apply: object((f): CommandBody => ({
    type: f.get('type', literal('apply')),
    expectRev: f.get('expectRev', nullable((v, p) => planRev(v, p))),
    manifest: f.get('manifest', applyManifest),
  })),
  'resolve-edge': object((f): CommandBody => ({
    type: f.get('type', literal('resolve-edge')), edge: f.get('edge', (v, p) => edgeId(v, p)), evidence: f.get('evidence', str),
  })),
  'run-only': object((f): CommandBody => ({
    type: f.get('type', literal('run-only')), units: f.get('units', nullable(sortedBy(unit, (u) => u, { nonEmpty: true }))),
  })),
  rule: object((f): CommandBody => ({ type: f.get('type', literal('rule')), path: f.get('path', abs), sha256: f.get('sha256', (v, p) => sha256(v, p)) })),
  reverse: object((f): CommandBody => ({ type: f.get('type', literal('reverse')), divergence: f.get('divergence', (v, p) => divergenceId(v, p)) })),
  steer: object((f): CommandBody => ({
    type: f.get('type', literal('steer')),
    unit: f.get('unit', unit),
    brief: f.get('brief', object((g) => ({ path: g.get('path', abs), sha256: g.get('sha256', (v, p) => sha256(v, p)) }))),
    budgetMin: f.get('budgetMin', positive),
    class: f.get('class', nullable(modelClass)),
    resume: f.get('resume', bool),
  })),
  'merge-in': object((f): CommandBody => ({ type: f.get('type', literal('merge-in')), unit: f.get('unit', unit) })),
  audit: object((f): CommandBody => ({
    type: f.get('type', literal('audit')), lenses: f.get('lenses', nullable(sortedBy(oneOf(LENS_KIND_NAMES), (l) => l, { nonEmpty: true }))),
  })),
  'close-admissions': object((f): CommandBody => ({ type: f.get('type', literal('close-admissions')) })),
});

export const commandFile: Read<CommandFile> = object((f) => ({
  v: f.get('v', version),
  id: f.get('id', cmdId),
  arc: f.get('arc', arc),
  at: f.get('at', time),
  body: f.get('body', commandBody),
}));

/** `applied` names the op that applied it and the postconditions verified; `accepted` is never done. */
export type Receipt =
  | Readonly<{ v: SchemaVersion; command: CommandId; state: 'accepted'; at: IsoTime }>
  | Readonly<{ v: SchemaVersion; command: CommandId; state: 'applied'; at: IsoTime; op: OpId; verified: readonly string[] }>
  | Readonly<{ v: SchemaVersion; command: CommandId; state: 'rejected'; at: IsoTime; reason: string }>;

export const receipt: Read<Receipt> = tagged('state', {
  accepted: object((f): Receipt => ({ v: f.get('v', version), command: f.get('command', cmdId), state: f.get('state', literal('accepted')), at: f.get('at', time) })),
  applied: object((f): Receipt => ({
    v: f.get('v', version), command: f.get('command', cmdId), state: f.get('state', literal('applied')), at: f.get('at', time),
    op: f.get('op', opId), verified: f.get('verified', arrayOf(str, { nonEmpty: true })),
  })),
  rejected: object((f): Receipt => ({
    v: f.get('v', version), command: f.get('command', cmdId), state: f.get('state', literal('rejected')), at: f.get('at', time), reason: f.get('reason', str),
  })),
});

// ---------------------------------------------------------------------------------------------------
// needs-user: `needs-user/<id>.json` (write-once) and `needs-user/<id>.ack.json`

export const NEEDS_USER_REASONS = [
  'chargeable-bound', 'escalation', 'refusal', 'process-fault', 'malformed', 'salvage-failed', 'empty-diff',
  'occupancy-unlabelled', 'lane-blocked', 'base-red', 'candidate-red', 'foreign-ref-move', 'recovery-required',
  'reconcile-park', 'residue', 'usage-limit', 'supervisor-crash-limit', 'log-corrupt', 'owner-mismatch',
  'recovery-holder-dead', 'previous-arc-unreconciled', 'build-lost', 'routing-changed',
  // M2: non-blocking. A retryable park unrecovered after 6 h (probing continues); a tripped probe breaker or a
  // repeat park on one target.
  'park-escalated', 'env-blocked',
  // M3, blocking: a must-hold obligation not held at the baseline (A6); a parked owner's P1 at the park deadline;
  // a new P1 or P2 while draining; a steer's park; a mutant not reproduced; an owner-only act the checkpoint
  // requested (A16); a second design park on one lineage (OR-Q1).
  'obligation-baseline', 'finding-p1-escalated', 'new-finding-draining', 'steered', 'not-reproduced', 'owner-request', 'respec-second',
  // M3, non-blocking: a bundle held for the architect (A9: `apply | reject`); the convergence brakes; an owed audit;
  // the divergence digest (H11).
  'bundle-request', 'convergence-bound', 'convergence-identity', 'audit-owed', 'divergence-digest',
] as const;
/** The M3 reasons raised non-blocking; every other M3 reason is raised blocking. */
export const NON_BLOCKING_M3_REASONS = ['bundle-request', 'convergence-bound', 'convergence-identity', 'audit-owed', 'divergence-digest'] as const satisfies readonly NeedsUserReason[];
export type NeedsUserReason = (typeof NEEDS_USER_REASONS)[number];

export type NeedsUserSubject = Readonly<{ type: 'unit'; unit: UnitId }> | Readonly<{ type: 'arc' }> | Readonly<{ type: 'host' }>;

export type NeedsUserRecord = Readonly<{
  v: SchemaVersion;
  id: NeedsUserId;
  arc: ArcId;
  raisedAt: IsoTime;
  blocking: boolean;
  subject: NeedsUserSubject;
  reason: NeedsUserReason;
  summary: string;
  recommendation: string;
  /** An ack may choose one of these by id; empty when acknowledgement alone is the answer. */
  options: readonly Readonly<{ id: string; label: string }>[];
  evidence: readonly AbsPath[];
}>;

/** A needs-user record without what the writer assigns (`v`, `id`, `arc`, `raisedAt`): what stages produce. */
export type NeedsUserContent = Omit<NeedsUserRecord, 'v' | 'id' | 'arc' | 'raisedAt'>;

export const needsUserRecord: Read<NeedsUserRecord> = object((f) => {
  const out: NeedsUserRecord = {
    v: f.get('v', version),
    id: f.get('id', (v, p) => needsUserId(v, p)),
    arc: f.get('arc', arc),
    raisedAt: f.get('raisedAt', time),
    blocking: f.get('blocking', bool),
    subject: f.get('subject', tagged<'unit' | 'arc' | 'host', NeedsUserSubject>('type', {
      unit: unitTarget,
      arc: object((g) => ({ type: g.get('type', literal('arc')) })),
      host: object((g) => ({ type: g.get('type', literal('host')) })),
    })),
    reason: f.get('reason', oneOf(NEEDS_USER_REASONS)),
    summary: f.get('summary', str),
    recommendation: f.get('recommendation', str),
    options: f.get('options', arrayOf(object((g) => ({ id: g.get('id', optionId), label: g.get('label', str) })))),
    evidence: f.get('evidence', arrayOf(abs)),
  };
  assertUnique(out.options, (o) => o.id, `${f.path}.options`);
  return out;
});

export type NeedsUserAck = Readonly<{ v: SchemaVersion; id: NeedsUserId; command: CommandId; choice: string | null; at: IsoTime }>;
export const needsUserAck: Read<NeedsUserAck> = object((f) => ({
  v: f.get('v', version),
  id: f.get('id', (v, p) => needsUserId(v, p)),
  command: f.get('command', cmdId),
  choice: f.get('choice', nullable(optionId)),
  at: f.get('at', time),
}));
