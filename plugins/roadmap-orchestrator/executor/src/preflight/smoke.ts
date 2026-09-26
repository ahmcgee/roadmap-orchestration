// The backend smoke: the `backend-smoke` startup row, and the targeted probe's core (evals/probe.ts).
// Both call this module, so what the probe verifies against the real CLIs is what `roadmap start` runs.
//
// For each backend the resolved routing uses, one minimal real call goes through the production path:
// the argv builder (backends/argv.ts), a `proc.spawn{purpose: smoke}` intent, the runner (runner/launch.ts),
// the adapter (backends/adapter.ts), a usage fact charged to the backend's smoke (not to a seat, so seat
// spend is the units' own) and the spawn's done record. Nothing is special-cased beyond the purpose. The smoke runs after the journal is open (lead ruling, 1a), so a refused start still
// leaves an audit trail.
//
// `claude-only` never runs the Codex smoke; instead it requires that no seat resolves to Codex. A backend
// whose binary is not on the host PATH fails to spawn: that is `missing`; any other non-success is `failed`.
// The report and the rejections never name a model; only the recorded argv does.
import { join } from 'node:path';
import { resultBytes, writeResult } from '../backends/adapter.ts';
import {
  type Argv, type BackendCall, type ClaudeImplementerSession, type ClaudeTriple, type CodexSession, type CodexTriple,
  backendArgv, freshClaudeImplementerSession, freshJudgmentSession, promptBytes,
} from '../backends/argv.ts';
import { detectContainmentMode } from '../contain/detect.ts';
import type { SpawnSubject } from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type InvocationId, type RoutingRev, invocationDirName, opKey, sha256 } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import { type JsonValue, canonicalJson, sha256Hex } from '../core/json.ts';
import {
  type BackendErrorClass, type BackendOutcome, type BackendResult, type CommandPurpose, type CommandResult, type ExitFile,
  type JudgmentSession, type LaunchFile, type LaunchTerminal, type ResultFile, type Usage, STDOUT_FILE,
} from '../core/records.ts';
import { type AbsPath, absPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import { BACKENDS, type Backend, type JudgmentRole, type ProfileName, RISK_TIERS, ROLES, type RiskTier, type Role } from '../routing/types.ts';
import { chargeOf, usageFact } from '../pipeline/invoke.ts';
import { awaitRunner, launchSha256, prepareLaunch, startRunner } from '../runner/launch.ts';
import type { StartupRejection } from './startup.ts';

/** A smoke call is one trivial turn; a CLI that cannot answer within this is not healthy. */
export const SMOKE_DEADLINE_MS = 180_000;
const SMOKE_GRACE_MS = 5_000;

/** Files the executor writes into an invocation dir before starting the runner. */
export const STDIN_FILE = 'stdin';
export const SCHEMA_FILE = 'schema.json';
/** Codex's `-o` file. */
export const CODEX_OUTPUT_FILE = 'last.json';

/** The smoke's strict schema: the answer must be exactly `{ok: true}`. */
export const SMOKE_SCHEMA: JsonValue = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean', enum: [true] } },
  required: ['ok'],
};
const SMOKE_SYSTEM = 'You are a health check for an unattended build orchestrator. Use no tools. Answer in the structured format requested.';
const SMOKE_PROMPT = 'Reply with the JSON object {"ok": true}.';

/** Where the executor's side of an invocation lives: the run's journal and dir, and the workload's env. */
export type InvocationContext = Readonly<{
  journal: Journal;
  runDir: AbsPath;
  /** The workload's whole declared environment (launch.json `env`); for backends, `backendEnv(process.env)`. */
  hostEnv: Readonly<Record<string, string>>;
}>;

/**
 * The environment every backend workload gets from the executor's: PATH (resolves the CLI) and HOME, both
 * required, plus the CLIs' own config-dir variables when the host sets them, since that is where their logins
 * live (verified 2026-09-25: without CLAUDE_CONFIG_DIR, `claude -p` answers "Not logged in"; without
 * CODEX_HOME, `codex exec` gets HTTP 401). Nothing else passes: in particular no CLAUDE_CODE_* variable of
 * an enclosing session.
 *
 * The operator's config dir is used as it is, never an arc-private copy: the CLI rotates the OAuth refresh
 * token on refresh and writes `.credentials.json` by temp file and rename (Claude Code 2.1.283), which
 * would replace a symlink to the operator's file with a private file and leave the operator's login on a
 * spent token. The context it would otherwise load is cut by flags (backends/argv.ts) and by
 * `BACKEND_ENV_SET`.
 */
export const BACKEND_ENV_PASS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;

/**
 * Set for every backend workload. Claude: no auto-memory, so no session reads the operator's project memory
 * or writes one that a later unit would read (verified 2026-09-26: the init event's `memory_paths` is absent
 * with it). Codex ignores it.
 */
export const BACKEND_ENV_SET: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

export function backendEnv(host: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = { ...BACKEND_ENV_SET };
  for (const name of ['PATH', 'HOME']) {
    const value = host[name];
    if (value === undefined) throw new Error(`the executor's environment has no ${name}; backend CLIs need it`);
    out[name] = value;
  }
  for (const name of BACKEND_ENV_PASS) {
    const value = host[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export type SmokeSubject = Extract<SpawnSubject, { purpose: 'smoke' }>;

/** A backend call before its invocation dir exists: the builder fills in the paths that live there. */
export type CallRequest =
  | Readonly<{ kind: 'claude-judgment'; role: JudgmentRole; triple: ClaudeTriple; session: JudgmentSession; evidenceDirs: readonly AbsPath[] }>
  | Readonly<{ kind: 'claude-build'; triple: ClaudeTriple; session: ClaudeImplementerSession; evidenceDirs: readonly AbsPath[] }>
  | Readonly<{ kind: 'codex-build'; triple: CodexTriple; session: CodexSession }>;

export type BackendInvocation = Readonly<{
  check: string;
  routingRev: RoutingRev;
  /** The seat's risk tier: which seat a probe call stands for (smoke usage is charged to the backend, not the seat). */
  tier: RiskTier;
  request: CallRequest;
  system: string;
  rendered: string;
  schema: JsonValue;
  /** The session's working directory. A resume must run where its session was created. */
  cwd: AbsPath;
}>;

export type CommandInvocation = Readonly<{
  check: string;
  argv: Argv;
  cwd: AbsPath;
  purpose: CommandPurpose;
  expectedExit: number;
}>;

export type Invoked<R extends ResultFile> = Readonly<{ inv: InvocationId; invDir: AbsPath; argv: Argv; exit: ExitFile; result: R }>;

type Prepared = Readonly<{
  argv: Argv;
  cwd: AbsPath;
  terminal: LaunchTerminal;
  /** Input files written into the invocation dir before the runner starts, by name. */
  inputs: Readonly<Record<string, string>>;
}>;

/**
 * One invocation, end to end: the spawn intent (durable before any act), its inputs and launch.json, the
 * runner, the adapter's result.json, for a backend the usage fact, then the done record.
 */
async function run(ctx: InvocationContext, subject: SmokeSubject, prepare: (invDir: AbsPath) => Prepared): Promise<Invoked<ResultFile>> {
  const deadlineAt = isoTimeOf(new Date(Date.now() + SMOKE_DEADLINE_MS));
  let planned: Readonly<{ invDir: AbsPath; prepared: Prepared; launch: LaunchFile }> | null = null;
  const { op, inv } = ctx.journal.begin({
    kind: 'proc.spawn',
    key: opKey(`smoke/${subject.check}`),
    parent: { type: 'arc' },
    deadlineAt,
    body: (op, inv) => {
      const invDir = absPath(join(ctx.runDir, 'inv', invocationDirName(inv)));
      const prepared = prepare(invDir);
      const launch = prepareLaunch({
        v: SCHEMA_VERSION, arc: ctx.journal.view.arc, op, inv, argv: prepared.argv, cwd: prepared.cwd, env: ctx.hostEnv,
        stdinPath: STDIN_FILE in prepared.inputs ? absPath(join(invDir, STDIN_FILE)) : null,
        deadlineAt, graceMs: SMOKE_GRACE_MS, containment: detectContainmentMode(), terminal: prepared.terminal,
      });
      planned = { invDir, prepared, launch };
      return { expect: { subject, launchSha256: launchSha256(launch) }, post: null };
    },
  });
  if (planned === null) throw new Error(`journal.begin returned ${inv} without calling the intent body`);
  const { invDir, prepared, launch } = planned as { invDir: AbsPath; prepared: Prepared; launch: LaunchFile };
  durableMkdir(invDir);
  for (const [name, text] of Object.entries(prepared.inputs)) durableWrite(join(invDir, name), text);
  const end = await awaitRunner(startRunner(invDir, launch));
  if (end.kind !== 'exited') throw new Error(`smoke ${subject.check}: the runner of ${inv} ended without exit.json (${end.kind}); see ${invDir}/runner.log`);
  const result = writeResult(invDir);
  const summary = result.type === 'backend'
    ? { type: 'backend', outcome: result.outcome.kind } as const
    : { type: 'command', verdict: result.verdict } as const;
  // The usage fact precedes the done, as in pipeline/invoke.ts, so a crash between them cannot lose it.
  const charge = chargeOf(subject);
  if (result.type === 'backend') {
    if (charge === null) throw new Error(`${inv}: a command smoke produced a backend result`);
    ctx.journal.fact(usageFact(charge, inv, result.usage));
  }
  ctx.journal.done(op, 'proc.spawn', { kind: 'result', resultSha256: sha256(sha256Hex(resultBytes(result))), summary }, null);
  return { inv, invDir, argv: prepared.argv, exit: end.exit, result };
}

function backendCall(b: BackendInvocation, invDir: AbsPath): BackendCall {
  const schemaText = canonicalJson(b.schema);
  const r = b.request;
  switch (r.kind) {
    case 'claude-judgment':
    case 'claude-build':
      return { ...r, system: b.system, schemaText };
    case 'codex-build':
      return {
        ...r, system: b.system, cwd: b.cwd,
        outputPath: absPath(join(invDir, CODEX_OUTPUT_FILE)), schemaPath: absPath(join(invDir, SCHEMA_FILE)),
      };
  }
}

function backendTerminal(b: BackendInvocation, call: BackendCall, invDir: AbsPath): LaunchTerminal {
  const base = { type: 'backend', purpose: 'smoke', routingRev: b.routingRev, schemaPath: absPath(join(invDir, SCHEMA_FILE)) } as const;
  switch (call.kind) {
    case 'claude-judgment':
      return { ...base, outputPath: absPath(join(invDir, STDOUT_FILE)), role: call.role, session: call.session };
    case 'claude-build':
      return { ...base, outputPath: absPath(join(invDir, STDOUT_FILE)), role: 'build', session: call.session };
    case 'codex-build':
      return { ...base, outputPath: call.outputPath, role: 'build', session: call.session };
  }
}

const roleOf = (r: CallRequest): Role => (r.kind === 'claude-judgment' ? r.role : 'build');

/** One backend call through the production path, journaled as `proc.spawn{purpose: smoke}`. */
export async function invokeBackend(ctx: InvocationContext, b: BackendInvocation): Promise<Invoked<BackendResult>> {
  const subject: SmokeSubject = {
    purpose: 'smoke',
    check: b.check,
    target: { type: 'backend', backend: b.request.triple.backend, role: roleOf(b.request), tier: b.tier, routingRev: b.routingRev },
  };
  const done = await run(ctx, subject, (invDir) => {
    const call = backendCall(b, invDir);
    return {
      argv: backendArgv(call),
      cwd: b.cwd,
      terminal: backendTerminal(b, call, invDir),
      inputs: { [STDIN_FILE]: promptBytes(call, b.rendered), [SCHEMA_FILE]: `${canonicalJson(b.schema)}\n` },
    };
  });
  if (done.result.type !== 'backend') throw new Error(`${done.inv}: a backend launch produced a ${done.result.type} result`);
  return { ...done, result: done.result };
}

/** One command through the runner, graded on its exit code; the caller grades its output files. */
export async function invokeCommand(ctx: InvocationContext, c: CommandInvocation): Promise<Invoked<CommandResult>> {
  const subject: SmokeSubject = { purpose: 'smoke', check: c.check, target: { type: 'command' } };
  const done = await run(ctx, subject, () => ({
    argv: c.argv,
    cwd: c.cwd,
    terminal: { type: 'command', purpose: c.purpose, expectedExit: c.expectedExit },
    inputs: {},
  }));
  if (done.result.type !== 'command') throw new Error(`${done.inv}: a command launch produced a ${done.result.type} result`);
  return { ...done, result: done.result };
}

// ---------------------------------------------------------------------------------------------------
// The smoke proper.

export type Seat = Readonly<{ role: Role; tier: RiskTier }>;
const seatName = (s: Seat): string => `${s.role}.${s.tier}`;

export type BackendSmoke =
  /** No seat resolves to this backend. */
  | Readonly<{ backend: Backend; ran: false; reason: 'unused' }>
  /** `claude-only` runs no Codex smoke; `seats` are the seats that resolve to Codex anyway (must be none). */
  | Readonly<{ backend: Backend; ran: false; reason: 'profile-excludes'; seats: readonly Seat[] }>
  /** The CLI could not be spawned: not on the host PATH. `inv` is the invocation that tried. */
  | Readonly<{ backend: Backend; ran: false; reason: 'missing'; inv: InvocationId; detail: string }>
  | Readonly<{
    backend: Backend;
    ran: true;
    seat: Seat;
    inv: InvocationId;
    /** The only place a model id appears: what was launched. */
    argv: Argv;
    outcome: BackendOutcome;
    usage: Usage;
    /** Classes only: a CLI's error text can name the model. */
    errorClasses: readonly BackendErrorClass[];
  }>;

export type SmokeReport = Readonly<{ profile: ProfileName; routingRev: RoutingRev; backends: readonly BackendSmoke[] }>;

export type SmokeRouting = Readonly<{ profile: ProfileName; resolved: ResolvedRouting }>;

function seatsOn(resolved: ResolvedRouting, backend: Backend): readonly Seat[] {
  return ROLES.flatMap((role) => RISK_TIERS.filter((tier) => resolved.table[role][tier].backend === backend).map((tier) => ({ role, tier })));
}

/**
 * The call a backend's smoke makes: the first seat in table order that resolves to it, so the smoke runs a
 * model the arc will actually use. Codex runs build seats only (a Codex judgment seat is refused by the
 * `unsupported-routing` row, which runs before the smoke).
 */
function smokeRequest(resolved: ResolvedRouting, backend: Backend): Readonly<{ seat: Seat; request: CallRequest }> | null {
  const seats = seatsOn(resolved, backend);
  const seat = seats[0];
  if (seat === undefined) return null;
  const triple = resolved.table[seat.role][seat.tier];
  if (triple.backend === 'claude') {
    if (seat.role === 'build') return { seat, request: { kind: 'claude-build', triple, session: freshClaudeImplementerSession(), evidenceDirs: [] } };
    return { seat, request: { kind: 'claude-judgment', role: seat.role, triple, session: freshJudgmentSession(), evidenceDirs: [] } };
  }
  if (seat.role !== 'build') throw new Error(`seat ${seatName(seat)} resolves to Codex judgment, which the unsupported-routing row refuses before the smoke`);
  return { seat, request: { kind: 'codex-build', triple, session: { backend: 'codex', mode: 'fresh' } } };
}

async function smokeBackend(routing: SmokeRouting, ctx: InvocationContext, backend: Backend, cwd: AbsPath): Promise<BackendSmoke> {
  if (routing.profile === 'claude-only' && backend === 'codex') {
    return { backend, ran: false, reason: 'profile-excludes', seats: seatsOn(routing.resolved, backend) };
  }
  const planned = smokeRequest(routing.resolved, backend);
  if (planned === null) return { backend, ran: false, reason: 'unused' };
  const done = await invokeBackend(ctx, {
    check: `backend-${backend}`,
    routingRev: routing.resolved.rev,
    tier: planned.seat.tier,
    request: planned.request,
    system: SMOKE_SYSTEM,
    rendered: SMOKE_PROMPT,
    schema: SMOKE_SCHEMA,
    cwd,
  });
  if (done.exit.child.type === 'spawn-failed') return { backend, ran: false, reason: 'missing', inv: done.inv, detail: done.exit.child.error };
  const r = done.result;
  return {
    backend, ran: true, seat: planned.seat, inv: done.inv, argv: done.argv, outcome: r.outcome, usage: r.usage,
    errorClasses: r.backendErrors.map((e) => e.class),
  };
}

/** Smoke every backend the resolved routing uses, one after another, in the order of BACKENDS. */
export function smoke(routing: SmokeRouting, ctx: InvocationContext): Promise<SmokeReport> {
  return smokeBackends(routing, ctx, BACKENDS);
}

/** Smoke the listed backends only, in the order given: `resume --backend` re-runs its backend's smoke alone. */
export async function smokeBackends(routing: SmokeRouting, ctx: InvocationContext, only: readonly Backend[]): Promise<SmokeReport> {
  // The smoke's calls run in their own empty dir: a smoke touches no tree.
  const cwd = absPath(join(ctx.runDir, 'smoke'));
  durableMkdir(cwd);
  const backends: BackendSmoke[] = [];
  for (const backend of only) backends.push(await smokeBackend(routing, ctx, backend, cwd));
  return { profile: routing.profile, routingRev: routing.resolved.rev, backends };
}

/** The `backend-smoke` startup row over a report: one rejection per backend the profile needs that is missing or failed. */
export function smokeRejections(report: SmokeReport): Extract<StartupRejection, { kind: 'backend-smoke' }>[] {
  const out: Extract<StartupRejection, { kind: 'backend-smoke' }>[] = [];
  const reject = (backend: Backend, problem: 'missing' | 'failed', detail: string): void => {
    out.push({ kind: 'backend-smoke', profile: report.profile, backend, problem, detail });
  };
  for (const b of report.backends) {
    if (!b.ran) {
      if (b.reason === 'missing') reject(b.backend, 'missing', `the CLI did not spawn (${b.inv}): ${b.detail}`);
      if (b.reason === 'profile-excludes' && b.seats.length > 0) {
        reject(b.backend, 'missing', `profile ${report.profile} runs no ${b.backend} smoke, but seats ${b.seats.map(seatName).join(', ')} resolve to ${b.backend}`);
      }
      continue;
    }
    if (b.outcome.kind === 'success') continue;
    const o = b.outcome;
    const why = o.kind === 'refusal' ? `stop reason ${o.stopReason}` : o.kind === 'cancelled' ? `cancelled for ${o.reason}` : o.detail;
    const errors = b.errorClasses.length === 0 ? '' : `; backend errors: ${b.errorClasses.join(', ')}`;
    reject(b.backend, 'failed', `seat ${seatName(b.seat)} (${b.inv}): ${b.outcome.kind}: ${why}${errors}`);
  }
  return out;
}
