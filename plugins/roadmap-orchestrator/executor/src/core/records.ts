// File-backed records other than the event log: the five runner files, the approval fingerprint and
// dispatch record, spec.json (M1) and SpecPatch, host files, commands and receipts, needs-user. Each has
// a type and a validator from `unknown`. SCHEMAS.md is the prose twin of this module.
import {
  type ArcId, type ClauseId, type CommandId, type ImplementerSessionId, type InvocationId, type JudgmentSessionId,
  type LaneId, type NeedsUserId, type OpId, type ResourceName, type RoutingRev, type RulingId, type Sha, type SpecRev,
  type UnitId, arcId, clauseId, commandId, implementerSessionId, invocationIdOf, judgmentSessionId,
  laneId, needsUserId, opIdOf, parseInvocationId, resourceName, routingRev, rulingId, sha, specRev, unitId,
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
import type { SchemaVersion } from './version.ts';
import {
  type Backend, type ImplementerRole, type JudgmentRole, type RiskTier, type Role, backend, riskTier,
} from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// Shared vocabulary

export type ProcIdentity = Readonly<{ pid: number; start: number }>;
export const procIdentity: Read<ProcIdentity> = object((f) => ({ pid: f.get('pid', positive), start: f.get('start', nat) }));

export const KILL_REASONS = ['deadline', 'pause', 'stop', 'recovery', 'external-unknown'] as const;
export type KillReason = (typeof KILL_REASONS)[number];
export const killReason: Read<KillReason> = oneOf(KILL_REASONS);

/** What the executor writes into cancel.json. `deadline` is the runner's own; `external-unknown` kills are not invocation cancels. */
export const CANCEL_REASONS = ['pause', 'stop', 'recovery'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const SPAWN_PURPOSES = ['backend', 'lane', 'teardown', 'probe', 'smoke'] as const;
export type SpawnPurpose = (typeof SPAWN_PURPOSES)[number];
export const COMMAND_PURPOSES = ['lane', 'teardown', 'probe', 'smoke'] as const;
export type CommandPurpose = (typeof COMMAND_PURPOSES)[number];

export const CONTAINMENT_MODES = ['session', 'cgroup'] as const;
export type ContainmentMode = (typeof CONTAINMENT_MODES)[number];
export const containmentMode: Read<ContainmentMode> = oneOf(CONTAINMENT_MODES);

/** Pipeline stages of one unit (the transition table is step 11). Fix rounds are `build` attempts. */
export const STAGES = ['plan-check', 'build', 'quiesce', 'evidence', 'salvage', 'teardown', 'lanes', 'gate', 'candidate', 'ff', 'snapshot', 'retire'] as const;
export type Stage = (typeof STAGES)[number];
export const stage: Read<Stage> = oneOf(STAGES);

export const RESOURCE_STATES = ['free', 'reserved', 'running', 'cleaning', 'cleanup-failed'] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

const role: Read<Role> = oneOf(['planCheck', 'build', 'gate'] as const);
const opId: Read<OpId> = (v, p) => opIdOf(v, p);
const inv: Read<InvocationId> = (v, p) => invocationIdOf(v, p);
const arc: Read<ArcId> = (v, p) => arcId(v, p);
const unit: Read<UnitId> = (v, p) => unitId(v, p);
const commitSha: Read<Sha> = (v, p) => sha(v, p);
const rev: Read<RoutingRev> = (v, p) => routingRev(v, p);
const abs: Read<AbsPath> = (v, p) => absPath(v, p);
const time: Read<IsoTime> = (v, p) => isoTime(v, p);
const resource: Read<ResourceName> = (v, p) => resourceName(v, p);
const argv: Read<readonly string[]> = arrayOf(str, { nonEmpty: true });
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
  /** Codex: the `-o` file. Claude: the invocation's stdout file (its `--output-format json` result). */
  outputPath: AbsPath;
}>;
export type BackendTerminal =
  | (BackendTerminalBase & Readonly<{ role: JudgmentRole; session: JudgmentSession }>)
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
        : { ...base, role: f.get('role', oneOf(['planCheck', 'gate'] as const)), session: f.get('session', judgmentSession) };
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

export const launchFile: Read<LaunchFile> = object((f) => ({
  ...binding(f),
  argv: f.get('argv', argv),
  cwd: f.get('cwd', abs),
  env: f.get('env', declaredEnv),
  stdinPath: f.get('stdinPath', nullable(abs)),
  deadlineAt: f.get('deadlineAt', time),
  graceMs: f.get('graceMs', positive),
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
export type ExitCause = 'exited' | 'deadline' | 'cancel' | 'recovery-kill';

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
    cause: f.get('cause', oneOf(['exited', 'deadline', 'cancel', 'recovery-kill'] as const)),
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
}>;
export const USAGE_UNAVAILABLE_REASONS = ['no-result', 'absent', 'malformed'] as const;
export type UsageUnavailableReason = (typeof USAGE_UNAVAILABLE_REASONS)[number];
/** Usage validity is independent of the outcome: missing usage never invalidates a judgment. */
export type Usage = Readonly<{ kind: 'known'; tokens: TokenUsage }> | Readonly<{ kind: 'unavailable'; reason: UsageUnavailableReason }>;

export const tokenUsage: Read<TokenUsage> = object((f) => ({
  inputTokens: f.get('inputTokens', nat),
  outputTokens: f.get('outputTokens', nat),
  cacheReadTokens: f.get('cacheReadTokens', nullable(nat)),
  cacheWriteTokens: f.get('cacheWriteTokens', nullable(nat)),
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
  | Readonly<{ kind: 'process-fault'; detail: string }>;
export type BackendOutcomeKind = BackendOutcome['kind'];
/** What the precedence rule alone decides; refusal is the adapter's reading of a backend stop reason. */
export type TerminalOutcome = Exclude<BackendOutcome, { kind: 'refusal' }>;

export type CommandVerdict = 'pass' | 'fail' | 'process-fault';

type BackendResultBase = InvocationBinding & Readonly<{
  type: 'backend';
  routingRev: RoutingRev;
  outcome: BackendOutcome;
  usage: Usage;
  backendErrors: readonly BackendError[];
}>;
/** A judgment session is assigned at launch; an implementer's may be unknown if it died before reporting one. */
export type BackendResult =
  | (BackendResultBase & Readonly<{ role: JudgmentRole; session: JudgmentSessionId }>)
  | (BackendResultBase & Readonly<{ role: ImplementerRole; session: ImplementerSessionId | null }>);
export type CommandResult = InvocationBinding & Readonly<{
  type: 'command';
  purpose: CommandPurpose;
  /** null when the child never exited with a code (signalled, spawn failure). */
  exitCode: number | null;
  expectedExit: number;
  verdict: CommandVerdict;
}>;
export type ResultFile = BackendResult | CommandResult;

const backendOutcome: Read<BackendOutcome> = tagged('kind', {
  success: object((f): BackendOutcome => ({ kind: f.get('kind', literal('success')), value: f.get('value', (v, p) => {
    if (v === undefined) throw new SchemaError(p, 'a JSON value', v);
    return v as JsonValue;
  }) })),
  refusal: object((f): BackendOutcome => ({ kind: f.get('kind', literal('refusal')), stopReason: f.get('stopReason', str) })),
  malformed: object((f): BackendOutcome => ({ kind: f.get('kind', literal('malformed')), detail: f.get('detail', str) })),
  'process-fault': object((f): BackendOutcome => ({ kind: f.get('kind', literal('process-fault')), detail: f.get('detail', str) })),
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
        : { ...base, role: f.get('role', oneOf(['planCheck', 'gate'] as const)), session: f.get('session', (v, p) => judgmentSessionId(v, p)) };
    })(value, path);
  },
  command: object((f): ResultFile => {
    const out: CommandResult = {
      ...binding(f),
      type: f.get('type', literal('command')),
      purpose: f.get('purpose', oneOf(COMMAND_PURPOSES)),
      exitCode: f.get('exitCode', nullable(exitCode)),
      expectedExit: f.get('expectedExit', exitCode),
      verdict: f.get('verdict', oneOf(['pass', 'fail', 'process-fault'] as const)),
    };
    if (out.exitCode === null && out.verdict !== 'process-fault') throw new SchemaError(`${f.path}.verdict`, '"process-fault" when exitCode is null', out.verdict);
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
 * 1. cause deadline/cancel/recovery-kill, a signal, or a failed spawn → process-fault, whatever the output;
 * 2. non-zero exit with schema-valid output → malformed; non-zero exit without it → process-fault;
 * 3. exit 0 without schema-valid output → malformed;
 * 4. exit 0 with schema-valid output → success.
 */
export function classifyTerminal(exit: ExitFile, output: unknown, schemaValid: boolean): TerminalOutcome {
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

/** The same precedence for commands: a runner kill or signal is a process fault; otherwise the exit code decides. */
export function classifyCommand(exit: ExitFile, expectedExit: number): Readonly<{ exitCode: number | null; verdict: CommandVerdict }> {
  const exitCode = exit.child.type === 'exited' ? exit.child.code : null;
  if (processFault(exit) !== null) return { exitCode, verdict: 'process-fault' };
  return { exitCode, verdict: exitCode === expectedExit ? 'pass' : 'fail' };
}

export const RUNNER_FILES = ['launch.json', 'runner.json', 'cancel.json', 'exit.json', 'result.json'] as const;
export type RunnerFileName = (typeof RUNNER_FILES)[number];
export type RunnerFileMap = {
  'launch.json': LaunchFile;
  'runner.json': RunnerFile;
  'cancel.json': CancelFile;
  'exit.json': ExitFile;
  'result.json': ResultFile;
};
export const RUNNER_FILE_READERS: { readonly [N in RunnerFileName]: Read<RunnerFileMap[N]> } = {
  'launch.json': launchFile,
  'runner.json': runnerFile,
  'cancel.json': cancelFile,
  'exit.json': exitFile,
  'result.json': resultFile,
};
/** The workload's stdout and stderr go to these files in the invocation dir; never pipes. */
export const STDOUT_FILE = 'stdout';
export const STDERR_FILE = 'stderr';

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
}>;

export const approvalFingerprint: Read<ApprovalFingerprint> = object((f) => ({
  unitCommit: f.get('unitCommit', commitSha),
  specRev: f.get('specRev', (v, p) => specRev(v, p)),
  contractRevs: f.get('contractRevs', sortedBy(object((g) => ({ path: g.get('path', (v, p) => repoPath(v, p)), blob: g.get('blob', commitSha) })), (e) => e.path)),
  rulingRevs: f.get('rulingRevs', sortedBy(object((g) => ({ id: g.get('id', (v, p) => rulingId(v, p)), rev: g.get('rev', positive) })), (e) => e.id)),
}));

/** Pinned once when a unit is dispatched; a redirect can neither widen `scope` nor lower `riskFloor`. */
export type DispatchRecord = Readonly<{
  unit: UnitId;
  specRev: SpecRev;
  scope: readonly RepoPattern[];
  riskFloor: RiskTier;
  routingRev: RoutingRev;
  at: IsoTime;
}>;

export const dispatchRecord: Read<DispatchRecord> = object((f) => ({
  unit: f.get('unit', unit),
  specRev: f.get('specRev', (v, p) => specRev(v, p)),
  scope: f.get('scope', sortedBy((v, p) => repoPattern(v, p), (s) => s, { nonEmpty: true })),
  riskFloor: f.get('riskFloor', riskTier),
  routingRev: f.get('routingRev', rev),
  at: f.get('at', time),
}));

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
  };
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  return out;
}
export const laneDef: Read<LaneDef> = object(laneFields);

/** Items keep their id forever; strike and defer change state, never delete, so ids are never reused. */
export type ItemState = 'active' | 'struck' | 'deferred';
export type AcceptanceDef = Readonly<{ id: ClauseId; clause: string; failLoudIfUndelivered: boolean }>;
export type NoteDef = Readonly<{ id: ClauseId; text: string }>;
type Stated<T> = T & Readonly<{ state: ItemState }>;

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
}>;

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
  };
  assertUnique([...out.lanes, ...out.acceptance, ...out.decisions, ...out.facts], (i) => i.id, `${f.path}.<item ids>`);
  assertUnique(out.scope, (s) => s, `${f.path}.scope`);
  assertUnique(out.resources, (r) => r, `${f.path}.resources`);
  return out;
});

export const SPEC_SECTIONS = ['lanes', 'acceptance', 'decisions', 'facts'] as const;
export type SpecSection = (typeof SPEC_SECTIONS)[number];
type SectionItem = { lanes: LaneDef; acceptance: AcceptanceDef; decisions: NoteDef; facts: NoteDef };

/** Scope and resources are pinned at dispatch and are not patchable in M1. */
export type SpecPatchOp =
  | { readonly [S in SpecSection]: Readonly<{ op: 'add'; section: S; item: SectionItem[S] }> }[SpecSection]
  | { readonly [S in SpecSection]: Readonly<{ op: 'replace'; section: S; item: SectionItem[S] }> }[SpecSection]
  | Readonly<{ op: 'strike' | 'defer'; id: LaneId | ClauseId }>;

/** M1 patches come only from plan-check redirects. */
export type SpecPatch = Readonly<{
  expectRev: SpecRev;
  by: Readonly<{ role: 'planCheck'; routingRev: RoutingRev; inv: InvocationId }>;
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

export const specPatchOp: Read<SpecPatchOp> = tagged('op', {
  add: itemOp('add'),
  replace: itemOp('replace'),
  strike: idOp('strike'),
  defer: idOp('defer'),
});

export const specPatch: Read<SpecPatch> = object((f) => ({
  expectRev: f.get('expectRev', (v, p) => specRev(v, p)),
  by: f.get('by', object((g) => ({ role: g.get('role', literal('planCheck')), routingRev: g.get('routingRev', rev), inv: g.get('inv', inv) }))),
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

/** supervisor.state.json: the crash window survives supervisor restarts. */
export type SupervisorState = Readonly<{ v: SchemaVersion; generation: number; crashes: readonly IsoTime[] }>;
export const supervisorState: Read<SupervisorState> = object((f) => ({
  v: f.get('v', version),
  generation: f.get('generation', positive),
  crashes: f.get('crashes', sortedBy(time, (t) => t)),
}));

/** exit.reason.json: intentional executor exits, which the supervisor does not count as crashes. */
export type ExecutorExitReason = Readonly<{ v: SchemaVersion; generation: number; reason: 'stop' | 'complete' | 'refused' }>;
export const executorExitReason: Read<ExecutorExitReason> = object((f) => ({
  v: f.get('v', version),
  generation: f.get('generation', positive),
  reason: f.get('reason', oneOf(['stop', 'complete', 'refused'] as const)),
}));

/** heartbeat.json in the run dir, every 10 s; stale after 5 min. */
export type Heartbeat = Readonly<{ v: SchemaVersion; generation: number; at: IsoTime }>;
export const heartbeat: Read<Heartbeat> = object((f) => ({ v: f.get('v', version), generation: f.get('generation', positive), at: f.get('at', time) }));

/** A residue is keyed per resource. */
export type ResidueKey = Readonly<{ arc: ArcId; unit: UnitId; inv: InvocationId; resource: ResourceName }>;
export const residueKey: Read<ResidueKey> = object((f) => ({
  arc: f.get('arc', arc),
  unit: f.get('unit', unit),
  inv: f.get('inv', inv),
  resource: f.get('resource', resource),
}));

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
export type CommandBody =
  | Readonly<{ type: 'pause'; target: PauseTarget }>
  | Readonly<{ type: 'stop' }>
  | Readonly<{ type: 'ack'; needsUser: NeedsUserId; choice: string | null }>
  | Readonly<{ type: 'resume'; target: ResumeTarget }>
  | Readonly<{ type: 'sweep'; resource: ResourceName | null }>;
/** Control commands apply immediately (waiting only for an integration.ff critical section); mutations at safe points. */
export const CONTROL_COMMANDS = ['pause', 'stop', 'ack'] as const;

export type CommandFile = Readonly<{ v: SchemaVersion; id: CommandId; arc: ArcId; at: IsoTime; body: CommandBody }>;

const cmdId: Read<CommandId> = (v, p) => commandId(v, p);
const optionId: Read<string> = (value, path) => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new SchemaError(path, 'an option id (lowercase slug)', value);
  return value;
};

const unitTarget = object((f) => ({ type: f.get('type', literal('unit')), unit: f.get('unit', unit) }));
const allTarget = object((f) => ({ type: f.get('type', literal('all')) }));
export const commandBody: Read<CommandBody> = tagged('type', {
  pause: object((f): CommandBody => ({
    type: f.get('type', literal('pause')),
    target: f.get('target', tagged<'unit' | 'all', PauseTarget>('type', { unit: unitTarget, all: allTarget })),
  })),
  stop: object((f): CommandBody => ({ type: f.get('type', literal('stop')) })),
  ack: object((f): CommandBody => ({
    type: f.get('type', literal('ack')),
    needsUser: f.get('needsUser', (v, p) => needsUserId(v, p)),
    choice: f.get('choice', nullable(optionId)),
  })),
  resume: object((f): CommandBody => ({
    type: f.get('type', literal('resume')),
    target: f.get('target', tagged<'all' | 'unit' | 'backend', ResumeTarget>('type', {
      all: allTarget,
      unit: unitTarget,
      backend: object((g) => ({ type: g.get('type', literal('backend')), backend: g.get('backend', backend) })),
    })),
  })),
  sweep: object((f): CommandBody => ({ type: f.get('type', literal('sweep')), resource: f.get('resource', nullable(resource)) })),
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
  'recovery-holder-dead', 'previous-arc-unreconciled',
] as const;
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
