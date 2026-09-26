// The `proc.spawn` and `proc.kill` operations over the journal (plan "Runner and containment", R13-R15).
//
// proc.spawn, on the normal path:
//   intent{subject, launchSha256, deadlineAt} (durable) → launch.json → start the runner → await it (its
//   own deadline, the executor's backstop at deadlineAt + 2·grace) → quiescence → adapter (result.json)
//   → usage fact → done.
//
// Quiescence before certification (R13): nothing reads a terminal file, and nothing is certified, while a
// workload member lives. Members left after the runner is gone are killed by their own journaled
// `proc.kill{recovery}` op first. The adapter runs here, in the executor, after the runner has exited
// (lead ruling, 1a); recovery re-runs it through the same `settle`.
//
// The usage fact precedes the done, so a crash between them cannot lose it; recovery asks the journal
// (`usageRecorded`) before writing one, so it is never written twice. `invoke` never retries: a retry is
// the caller's second call with `origin: retry`, which the journal gives the next ordinal and the op's
// original deadline.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeResult } from '../backends/adapter.ts';
import { scan } from '../contain/proc.ts';
import { ENV_INV, ENV_ROLE } from '../contain/session.ts';
import { crashPoint } from '../core/crash.ts';
import type { Fact, IntentOf, MeterSubject, OpExpect, OpOutcome, Parent, RecoveredBy, ResultSummary, SpawnSubject } from '../core/events.ts';
import {
  type InvocationId, type OpId, type OpKey, type RoutingRev, type Sha256Hex, invocationDirName, invocationId, opKey,
  parseInvocationId, parseOpId, sha256,
} from '../core/ids.ts';
import type { Containment, IntentBody, Journal, JournalView, RunnerFiles, WorkloadRef } from '../core/interfaces.ts';
import { sha256Hex } from '../core/json.ts';
import {
  type CancelReason, type LaunchFile, type LaunchTerminal, type ProcIdentity, type ResultFile, type Usage, STDOUT_FILE,
} from '../core/records.ts';
import { type AbsPath, type IsoTime, absPath } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type SeatRef, seatRef } from '../routing/types.ts';
import { runnerFiles } from '../runner/files.ts';
import { awaitRunner, cancel, launchSha256, prepareLaunch, startRunner } from '../runner/launch.ts';

/** Where an invocation's files live: `<runDir>/inv/<seq>-<ordinal>/` (SCHEMAS.md "Runner files"). */
export function invocationDir(runDir: AbsPath, inv: InvocationId): AbsPath {
  return absPath(join(runDir, 'inv', invocationDirName(inv)));
}

export type ProcContext = Readonly<{ journal: Journal; containment: Containment; runDir: AbsPath }>;

/** What launch.json says beyond its binding, deadline, containment mode and crash trigger. */
export type LaunchContent = Readonly<{
  argv: readonly string[];
  cwd: AbsPath;
  env: Readonly<Record<string, string>>;
  stdinPath: AbsPath | null;
  graceMs: number;
  terminal: LaunchTerminal;
}>;

/** A first invocation opens a new op; a retry takes the next ordinal of a closed one and inherits its deadline. */
export type SpawnOrigin =
  | Readonly<{ type: 'new'; key: OpKey; parent: Parent; deadlineAt: IsoTime }>
  | Readonly<{ type: 'retry'; op: OpId }>;

/** `launch` is given the invocation dir, which output paths in argv and terminal name; it runs once, inside the intent. */
export type LaunchSpec = Readonly<{
  runDir: AbsPath;
  origin: SpawnOrigin;
  subject: SpawnSubject;
  launch: (invDir: AbsPath) => LaunchContent;
}>;

export type InvocationOutcome =
  | Readonly<{ kind: 'result'; op: OpId; inv: InvocationId; result: ResultFile; resultSha256: Sha256Hex }>
  /** The runner is gone without exit.json; `treeEffects`: a workload was started, so it may have changed the tree. */
  | Readonly<{ kind: 'lost'; op: OpId; inv: InvocationId; treeEffects: boolean }>;

/** How the invocation's runner ended before `settle`: awaited by the live executor, adopted, or already gone at recovery. */
export type SettleMode = 'live' | 'adopted' | 'recovered';

export type Settled = Readonly<{ outcome: InvocationOutcome; recoveredBy: RecoveredBy }>;

// ---------------------------------------------------------------------------------------------------
// proc.spawn

export async function invoke(journal: Journal, containment: Containment, spec: LaunchSpec): Promise<InvocationOutcome> {
  let launch: LaunchFile | undefined;
  const body = (op: OpId, inv: InvocationId, deadlineAt: IsoTime): IntentBody<'proc.spawn'> => {
    const content = spec.launch(invocationDir(spec.runDir, inv));
    assertPairing(spec.subject, content.terminal);
    launch = prepareLaunch({ v: SCHEMA_VERSION, arc: parseOpId(op).arc, op, inv, ...content, deadlineAt, containment: containment.mode });
    return { expect: { subject: spec.subject, launchSha256: launchSha256(launch) }, post: null };
  };
  const { origin } = spec;
  const durable = origin.type === 'new'
    ? journal.begin({ kind: 'proc.spawn', key: origin.key, parent: origin.parent, deadlineAt: origin.deadlineAt, body: (op, inv) => body(op, inv, origin.deadlineAt) })
    : journal.retry(origin.op, 'proc.spawn', (inv) => body(origin.op, inv, spawnDeadline(journal.view, origin.op)));
  if (launch === undefined) throw new Error(`the journal opened ${durable.inv} without asking for its body`);
  crashPoint('spawn.after-intent');

  const handle = startRunner(invocationDir(spec.runDir, durable.inv), launch);
  await awaitRunner(handle);
  crashPoint('spawn.after-runner-exit');
  const settled = await settle({ journal, containment, runDir: spec.runDir }, spawnIntent(journal.view, durable.op), 'live');
  return settled.outcome;
}

/** The op's deadline, which every retry inherits. A spawn always has one: launch.json requires it. */
function spawnDeadline(view: JournalView, op: OpId): IsoTime {
  const deadlineAt = spawnIntent(view, op).deadlineAt;
  if (deadlineAt === null) throw new Error(`proc.spawn ${op} has no deadlineAt`);
  return deadlineAt;
}

export function spawnIntent(view: JournalView, op: OpId): IntentOf<'proc.spawn'> {
  const intent = view.latestIntent(op);
  if (intent.kind !== 'proc.spawn') throw new Error(`${op} is a ${intent.kind} op, not proc.spawn`);
  return intent;
}

/**
 * Closes a spawn intent whose runner is gone: kill any members left (R13), then certify. With exit.json
 * the adapter writes result.json, or re-derives it byte for byte when it already exists (a conflict is a
 * loud ResultConflictError); without exit.json the invocation is lost. Then the usage fact, then done.
 *
 * `recoveredBy`: live → null; adopted → `adopted`; recovered → `reconciled` when result.json already
 * existed, `redone` when the adapter ran again. A lost invocation found by recovery is `reconciled`.
 */
export async function settle(ctx: ProcContext, intent: IntentOf<'proc.spawn'>, mode: SettleMode): Promise<Settled> {
  const inv = invocationId(intent.op, intent.ordinal);
  const dir = invocationDir(ctx.runDir, inv);
  const files = runnerFiles(dir, inv);
  // Recovery kills by op, which also reaches stray workloads of earlier ordinals; the runner of every
  // ordinal is dead by then (the latest was just checked, earlier ones were closed lost or aborted).
  const target: KillTarget = { inv, scope: mode === 'recovered' ? 'op' : 'invocation', reason: 'recovery' };
  if (!quiescent(ctx, target)) await killWorkload(ctx, target);

  const resultPath = join(dir, 'result.json');
  const hadResult = files.read('result.json') !== null;
  const exit = files.read('exit.json');
  let outcome: InvocationOutcome;
  let usage: Usage | null;
  let recoveredBy: RecoveredBy;
  if (exit !== null) {
    const launch = files.read('launch.json');
    if (launch === null) throw new Error(`${dir}: exit.json without launch.json`);
    if (launchSha256(launch) !== intent.expect.launchSha256) throw new Error(`${dir}/launch.json does not hash to the intent's launchSha256 ${intent.expect.launchSha256}`);
    const result = writeResult(dir);
    crashPoint('spawn.after-result');
    outcome = { kind: 'result', op: intent.op, inv, result, resultSha256: sha256(sha256Hex(readFileSync(resultPath))) };
    usage = result.type === 'backend' ? result.usage : null;
    recoveredBy = mode === 'live' ? null : mode === 'adopted' ? 'adopted' : hadResult ? 'reconciled' : 'redone';
  } else {
    if (hadResult) throw new Error(`${dir}: result.json without exit.json`);
    outcome = { kind: 'lost', op: intent.op, inv, treeEffects: existsSync(join(dir, STDOUT_FILE)) };
    usage = { kind: 'unavailable', reason: 'no-result' };
    recoveredBy = mode === 'live' ? null : 'reconciled';
  }

  const charge = chargeOf(intent.expect.subject);
  if (charge !== null && !ctx.journal.view.usageRecorded(inv)) {
    if (usage === null) throw new Error(`${inv}: a backend spawn produced a command result`);
    ctx.journal.fact(usageFact(charge, inv, usage));
  }
  crashPoint('spawn.after-usage');
  ctx.journal.done(intent.op, 'proc.spawn', doneOutcome(outcome), recoveredBy);
  crashPoint('spawn.after-done');
  return { outcome, recoveredBy };
}

function doneOutcome(outcome: InvocationOutcome): OpOutcome['proc.spawn'] {
  if (outcome.kind === 'lost') return { kind: 'lost', treeEffects: outcome.treeEffects };
  const { result } = outcome;
  const summary: ResultSummary = result.type === 'backend'
    ? { type: 'backend', outcome: result.outcome.kind }
    : { type: 'command', verdict: result.verdict };
  return { kind: 'result', resultSha256: outcome.resultSha256, summary };
}

type Charge = Readonly<{ routingRev: RoutingRev; subject: MeterSubject }>;

/** Whom a backend spawn's usage is charged to (a unit's seat, or its backend's smoke); commands carry no usage. */
export function chargeOf(subject: SpawnSubject): Charge | null {
  switch (subject.purpose) {
    case 'backend':
      return { routingRev: subject.routingRev, subject: { type: 'seat', ...seatRef(subject.role, subject.tier), unit: subject.unit, attempt: subject.attempt } };
    case 'smoke':
      return subject.target.type === 'backend' ? { routingRev: subject.target.routingRev, subject: { type: 'smoke', backend: subject.target.backend } } : null;
    case 'lane':
    case 'teardown':
    case 'probe':
      return null;
  }
}

/** The one usage fact of a backend invocation. */
export function usageFact(charge: Charge, inv: InvocationId, usage: Usage): Fact {
  return usage.kind === 'known'
    ? { kind: 'meter', inv, ...charge, usage: usage.tokens }
    : { kind: 'usage-unavailable', inv, ...charge, reason: usage.reason };
}

/** The intent's subject and launch.json's terminal must describe the same thing; a mismatch is a caller bug. */
function assertPairing(subject: SpawnSubject, terminal: LaunchTerminal): void {
  const fail = (): never => {
    throw new Error(`proc.spawn subject ${JSON.stringify(subject)} does not match launch terminal ${JSON.stringify(terminal)}`);
  };
  switch (subject.purpose) {
    case 'backend':
      if (terminal.type !== 'backend' || terminal.purpose !== 'backend' || terminal.role !== subject.role || terminal.routingRev !== subject.routingRev) fail();
      return;
    case 'smoke':
      if (subject.target.type === 'command') {
        if (terminal.type !== 'command' || terminal.purpose !== 'smoke') fail();
      } else if (terminal.type !== 'backend' || terminal.purpose !== 'smoke' || terminal.role !== subject.target.role || terminal.routingRev !== subject.target.routingRev) {
        fail();
      }
      return;
    case 'lane':
    case 'teardown':
    case 'probe':
      if (terminal.type !== 'command' || terminal.purpose !== subject.purpose) fail();
  }
}

// ---------------------------------------------------------------------------------------------------
// proc.kill

export type KillTarget = OpExpect['proc.kill'];

/**
 * The runner of `inv` if it is alive: a process of this uid whose environment says ROADMAP_ROLE=runner and
 * ROADMAP_INV=<inv>. Found by scan rather than from runner.json alone, so a runner that exists but has not
 * written runner.json yet is still seen; when runner.json exists, its (pid, start) must be that process.
 */
export function liveRunner(files: RunnerFiles): ProcIdentity | null {
  const found = scan().filter((p) => p.env?.get(ENV_ROLE) === 'runner' && p.env.get(ENV_INV) === files.inv);
  if (found.length > 1) throw new Error(`${files.inv} has ${found.length} live runners: ${found.map((p) => p.pid).join(', ')}`);
  const runner = found[0];
  if (runner === undefined) return null;
  const file = files.read('runner.json');
  if (file !== null && (file.runner.pid !== runner.pid || file.runner.start !== runner.start)) {
    throw new Error(`${files.invDir}/runner.json names runner ${file.runner.pid}@${file.runner.start}, but ${runner.pid}@${runner.start} is the live runner of ${files.inv}`);
  }
  return { pid: runner.pid, start: runner.start };
}

/** Every invocation a kill reaches: the one named, or with scope `op` every ordinal up to it. */
function targetInvocations(target: KillTarget): readonly InvocationId[] {
  if (target.scope === 'invocation') return [target.inv];
  const { op, ordinal } = parseInvocationId(target.inv);
  return Array.from({ length: ordinal }, (_, i) => invocationId(op, i + 1));
}

function workloadRef(files: RunnerFiles): WorkloadRef {
  return { inv: files.inv, child: files.read('runner.json')?.child ?? null };
}

/** No member of any targeted invocation is alive. An invocation without launch.json never started a process. */
export function quiescent(ctx: Pick<ProcContext, 'containment' | 'runDir'>, target: KillTarget): boolean {
  return targetInvocations(target).every((inv) => {
    const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
    return files.read('launch.json') === null || ctx.containment.empty(workloadRef(files));
  });
}

const CANCEL_REASONS: Readonly<Record<KillTarget['reason'], CancelReason | null>> = {
  pause: 'pause', stop: 'stop', recovery: 'recovery', deadline: null, 'external-unknown': null,
};

/**
 * The act of proc.kill, re-runnable. A live runner is asked to stop through cancel.json (so exit.json names
 * the cause) and awaited, up to its backstop; then whatever members remain are killed directly. Resolves
 * only when every targeted invocation is empty.
 */
export async function quiesce(ctx: Pick<ProcContext, 'containment' | 'runDir'>, target: KillTarget): Promise<void> {
  for (const inv of targetInvocations(target)) {
    const files = runnerFiles(invocationDir(ctx.runDir, inv), inv);
    const launch = files.read('launch.json');
    if (launch === null) continue;
    const runner = liveRunner(files);
    if (runner !== null) {
      const reason = CANCEL_REASONS[target.reason];
      // The runner enforces its own deadline; nothing else kills around a live runner.
      if (reason === null) throw new Error(`proc.kill{${target.reason}} of ${inv}: its runner is alive; only pause, stop or recovery cancel a live runner`);
      const handle = { files, launch, runner };
      if (files.read('cancel.json') === null) cancel(handle, reason);
      crashPoint('kill.after-cancel');
      await awaitRunner(handle);
    }
    // Read runner.json after the runner is gone: it names the child once the runner has spawned it.
    await ctx.containment.kill(workloadRef(files), target.reason, launch.graceMs);
  }
  if (!quiescent(ctx, target)) throw new Error(`proc.kill ${JSON.stringify(target)}: members remain after the kill`);
}

/** proc.kill as a journaled op: intent → quiesce → done. Its parent is the spawn op it kills for. */
export async function killWorkload(ctx: ProcContext, target: KillTarget): Promise<void> {
  const spawnOp = parseInvocationId(target.inv).op;
  const { op } = ctx.journal.begin({
    kind: 'proc.kill',
    key: killKey(target),
    parent: { type: 'op', op: spawnOp },
    deadlineAt: null,
    body: () => ({ expect: target, post: null }),
  });
  crashPoint('kill.after-intent');
  await quiesce(ctx, target);
  crashPoint('kill.after-quiesced');
  ctx.journal.done(op, 'proc.kill', { kind: 'quiesced' }, null);
  crashPoint('kill.after-done');
}

/** Kills of one invocation for one reason must not overlap; a pause and a recovery kill of it may. */
export function killKey(target: KillTarget): OpKey {
  return opKey(`kill:${target.inv}:${target.reason}`);
}
