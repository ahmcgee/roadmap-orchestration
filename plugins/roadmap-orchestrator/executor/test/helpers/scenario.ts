// Scenarios for the fake backends (test/fakes/fake-backend.ts). A scenario is an ordered list of steps;
// each backend call consumes the next step, checks the call against its `expect` and performs its `acts`.
// Every call, matched or not, is appended to `calls.jsonl` beside the scenario file. An unmatched call
// exits 99 with the mismatch on stderr, so the code under test sees a failed backend and the test sees why.
//
// Also here: invocation dirs for adapter-level tests. `runLaunch` is a minimal stand-in for the runner
// (step 3a) that executes a launch.json's argv with stdout/stderr to files and writes exit.json;
// `fixtureInvocation` lays out a captured real CLI run (test/fixtures/backend-output) as an invocation dir.
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { implementerSessionId, judgmentSessionId, routingRev } from '../../src/core/ids.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { type ExitFile, type LaunchFile, type LaunchTerminal, RUNNER_FILE_READERS } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';
import { writeShims } from '../fakes/shim.ts';
import { type FileSet, tmpDir } from './repo.ts';

export type FakeName = 'codex' | 'claude';

/** How a call must look. `argv` tokens must appear in this order (not necessarily adjacent). */
export type Expect = Readonly<{
  argv?: readonly string[];
  argvLacks?: readonly string[];
  cwd?: string;
  stdinContains?: readonly string[];
}>;

/**
 * Output acts write the CLI's real output format (faithful to test/fixtures/backend-output):
 * `emit` a schema-conforming answer; `capacityText` the same with capacity and usage-limit text inside the
 * normal answer; `noUsage` an answer without a usage block; `malformed` a final message that is not JSON;
 * `usageLimit` the CLI's usage-limit error (and exit 1); `exitZeroNoop` exit 0 having printed nothing.
 */
export type OutputAct =
  | Readonly<{ type: 'emit'; value: JsonValue }>
  | Readonly<{ type: 'capacityText'; value: JsonValue }>
  | Readonly<{ type: 'noUsage'; value: JsonValue }>
  | Readonly<{ type: 'malformed' }>
  | Readonly<{ type: 'usageLimit' }>
  | Readonly<{ type: 'exitZeroNoop' }>;

/** Side effects on the world. File paths are relative to the call's cwd. */
export type WorldAct =
  | Readonly<{ type: 'commit'; message: string; files: FileSet }>
  | Readonly<{ type: 'stage'; files: FileSet }>
  | Readonly<{ type: 'dirty'; files: FileSet }>
  | Readonly<{ type: 'exit'; code: number }>
  | Readonly<{ type: 'hang'; ms: number }>
  /** A detached (setsid) child that outlives the fake for `lifeMs`; its pid goes to `pidFile`. */
  | Readonly<{ type: 'forkSetsid'; env: 'keepEnv' | 'envClear'; lifeMs: number; pidFile: string }>
  /** Park at a file barrier in the scenario's directory (test/helpers/barrier.ts). */
  | Readonly<{ type: 'barrier'; name: string; timeoutMs: number }>
  /**
   * Read a file the prompt points at: `pattern` (a regex source with one capture group) finds a directory
   * in stdin, and `<dir>/<file>` must contain `contains`; otherwise the call fails (exit 99). How a fake
   * implementer proves it read the evidence a fix round named, whose path is known only at run time.
   */
  | Readonly<{ type: 'readFromPrompt'; pattern: string; file: string; contains: string }>
  /**
   * Write `<dir>/<file>` with `text`, where `pattern` (a regex source with one capture group) finds `dir`
   * in stdin: how a fake implementer writes into the evidence dir its prompt names (decisions.json).
   */
  | Readonly<{ type: 'writeToPrompt'; pattern: string; file: string; text: string }>;

/** Claude reports a stop reason; Codex has no refusal signal, so a Codex refusal is unrepresentable. */
export type ClaudeOnlyAct = Readonly<{ type: 'refusal' }>;
/**
 * `resumeCollision`: `codex exec resume` onto a thread another live session holds (CODEX_RESUME_COLLISION on
 * stderr, exit 1). `threadStarted`: print the `thread.started` event now, as the real CLI does first, so a
 * call killed later has reported its thread; an output act then does not print it again.
 */
export type CodexOnlyAct = Readonly<{ type: 'resumeCollision' }> | Readonly<{ type: 'threadStarted' }>;

export type CodexAct = OutputAct | WorldAct | CodexOnlyAct;
export type ClaudeAct = OutputAct | WorldAct | ClaudeOnlyAct;
export type Act = CodexAct | ClaudeAct;

export type Step =
  | Readonly<{ as: 'codex'; expect: Expect; acts: readonly CodexAct[]; /** fresh thread id; default derived from the step index */ threadId?: string }>
  | Readonly<{ as: 'claude'; expect: Expect; acts: readonly ClaudeAct[] }>;

export type ScenarioFile = Readonly<{ steps: readonly Step[] }>;

export type CallRecord = Readonly<{
  as: FakeName;
  argv: readonly string[];
  cwd: string;
  stdin: string;
  env: Readonly<Record<string, string>>;
  /** The step this call matched, or null when it matched none. */
  step: number | null;
}>;

export type Scenario = Readonly<{ path: string; dir: string; binDir: string }>;

export const CALLS_FILE = 'calls.jsonl';

/** Error texts the fakes emit. Codex's is hand-written from the CLI's usage-limit message (never captured). */
export const CODEX_USAGE_LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.";
/** Hand-written: Claude Code's subscription limit text; the object around it is the captured api-error result. */
export const CLAUDE_USAGE_LIMIT = "You've hit your limit · resets 3am (UTC)";
/**
 * Hand-written, never captured: a resume collision as 0.x saw it on the Codex CLI's stderr in arc 1
 * ("thread already has a..."); the executor matches `thread already` (src/pipeline/rounds.ts).
 */
export const CODEX_RESUME_COLLISION = 'Error: thread already has an active turn held by another codex process';
/** Outage-looking text inside a normal answer: must never be classified as a backend error. */
export const CAPACITY_TEXT = 'Selected model is at capacity. Please try a different model. (Also: usage limit reached, rate limit, quota.)';

/** Write `<dir>/scenario.json` and the `bin/{codex,claude}` shims that run it. Put `binDir` first on PATH. */
export function writeScenario(dir: string, steps: readonly Step[]): Scenario {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'scenario.json');
  const file: ScenarioFile = { steps };
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' });
  const binDir = join(dir, 'bin');
  writeShims(binDir, path);
  return { path, dir, binDir };
}

export function readCalls(scenarioPath: string): readonly CallRecord[] {
  const path = join(dirname(scenarioPath), CALLS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as CallRecord);
}

// ---------------------------------------------------------------------------------------------------
// Runner stand-in for adapter-level tests.

const BIND = { v: 1, arc: 'arc-1', op: 'arc-1/7', inv: 'arc-1/7#1' } as const;
const DEADLINE = '2026-09-25T13:00:00.000Z';

/** Write a valid launch.json into `invDir` (bound to arc-1/7#1) and return it as read back. */
export function writeLaunch(invDir: string, spec: Readonly<{ argv: readonly string[]; cwd: string; terminal: LaunchTerminal; stdinPath: string | null; env?: Readonly<Record<string, string>> }>): LaunchFile {
  const launch = {
    ...BIND, argv: spec.argv, cwd: spec.cwd, env: spec.env ?? {}, stdinPath: spec.stdinPath, deadlineAt: DEADLINE,
    graceMs: 1000, containment: 'session', test: null, terminal: spec.terminal,
  };
  const parsed = RUNNER_FILE_READERS['launch.json'](launch, 'launch.json');
  writeFileSync(join(invDir, 'launch.json'), JSON.stringify(launch));
  return parsed;
}

/** Write exit.json into `invDir` (bound to arc-1/7#1). */
export function writeExit(invDir: string, child: ExitFile['child'], cause: ExitFile['cause'] = 'exited'): ExitFile {
  const exit = { ...BIND, child, cause, endedAt: '2026-09-25T12:00:00.000Z', quiescedAt: '2026-09-25T12:00:01.000Z' };
  const parsed = RUNNER_FILE_READERS['exit.json'](exit, 'exit.json');
  writeFileSync(join(invDir, 'exit.json'), JSON.stringify(exit));
  return parsed;
}

/**
 * Execute `launch.argv` in `launch.cwd` with stdin from `stdinPath`, stdout and stderr to files in `invDir`,
 * and `env` as the whole environment; then write exit.json. Throws if the process outlives `timeoutMs`.
 */
export function runLaunch(invDir: string, launch: LaunchFile, env: Readonly<Record<string, string>>, timeoutMs: number): ExitFile {
  const out = openSync(join(invDir, 'stdout'), 'w');
  const err = openSync(join(invDir, 'stderr'), 'w');
  const input = openSync(launch.stdinPath ?? '/dev/null', 'r');
  const [cmd, ...args] = launch.argv as [string, ...string[]];
  const r = spawnSync(cmd, args, { cwd: launch.cwd, env: { ...env, ...launch.env }, stdio: [input, out, err], timeout: timeoutMs, killSignal: 'SIGKILL' });
  closeSync(out);
  closeSync(err);
  closeSync(input);
  if (r.error !== undefined) throw r.error;
  if (r.signal !== null) return writeExit(invDir, { type: 'signalled', signal: r.signal });
  return writeExit(invDir, { type: 'exited', code: r.status as number });
}

// ---------------------------------------------------------------------------------------------------
// Captured real CLI runs as invocation dirs.

export const BACKEND_FIXTURES = fileURLToPath(new URL('../fixtures/backend-output/', import.meta.url));
/** The strict schema every capture was run with: `{ok: boolean}`, every key required. */
export const OK_SCHEMA = join(BACKEND_FIXTURES, 'schema.json');
export const ROUTING_REV = routingRev('0123456789abcdef');

export function capturedArgv(name: string): readonly string[] {
  return JSON.parse(readFileSync(join(BACKEND_FIXTURES, name, 'argv.json'), 'utf8')) as string[];
}

function after(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * The launch terminal an argv implies: Codex resume or fresh by `exec resume <sid>` (output file
 * `<invDir>/last.json`); Claude judgment (role gate) when it has `--tools`, implementer otherwise (output
 * file `<invDir>/stdout`). Every Claude capture names its session.
 */
export function terminalFor(argv: readonly string[], invDir: string, schemaPath: string = OK_SCHEMA): LaunchTerminal {
  const base = { type: 'backend', purpose: 'backend', routingRev: ROUTING_REV, schemaPath: absPath(schemaPath) } as const;
  if (argv[0] === 'codex') {
    const outputPath = absPath(join(invDir, 'last.json'));
    if (argv[2] === 'resume') return { ...base, outputPath, role: 'build', session: { backend: 'codex', mode: 'resume', id: implementerSessionId(argv[3]) } };
    return { ...base, outputPath, role: 'build', session: { backend: 'codex', mode: 'fresh' } };
  }
  const outputPath = absPath(join(invDir, 'stdout'));
  const fresh = after(argv, '--session-id');
  const resume = after(argv, '--resume');
  if (argv.includes('--tools')) return { ...base, outputPath, role: 'gate', session: { backend: 'claude', mode: 'fresh', id: judgmentSessionId(fresh) } };
  const session = resume === undefined
    ? { backend: 'claude', mode: 'fresh', id: implementerSessionId(fresh) } as const
    : { backend: 'claude', mode: 'resume', id: implementerSessionId(resume) } as const;
  return { ...base, outputPath, role: 'build', session };
}

/**
 * A fresh invocation dir holding capture `name`'s stdout, stderr and `-o` file (as `last.json`), a
 * launch.json derived from its argv, and an exit.json with `child` and `cause` (cause `cancel` also writes
 * the cancel.json the executor writes first, reason `pause`). Returns the dir.
 */
export function fixtureInvocation(name: string, child: ExitFile['child'], cause: ExitFile['cause'] = 'exited', schemaPath: string = OK_SCHEMA): string {
  const invDir = tmpDir('inv');
  const src = join(BACKEND_FIXTURES, name);
  for (const f of ['stdout', 'stderr', 'last.json']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(invDir, f));
  const argv = capturedArgv(name);
  writeLaunch(invDir, { argv, cwd: invDir, terminal: terminalFor(argv, invDir, schemaPath), stdinPath: null });
  if (cause === 'cancel') writeFileSync(join(invDir, 'cancel.json'), JSON.stringify({ ...BIND, reason: 'pause', at: '2026-09-25T11:59:59.000Z' }));
  writeExit(invDir, child, cause);
  return invDir;
}

const streamEvents = (text: string): Record<string, unknown>[] =>
  text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);

/** Rewrite the `result` event of the Claude stream-json stdout in `invDir`, keeping every other line. */
export function editClaudeResult(invDir: string, edit: (result: Record<string, unknown>) => Record<string, unknown>): string {
  const path = join(invDir, 'stdout');
  const events = streamEvents(readFileSync(path, 'utf8'));
  const i = events.findLastIndex((e) => e['type'] === 'result');
  if (i === -1) throw new Error(`${path}: no result event`);
  events[i] = edit(events[i]!);
  writeFileSync(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return invDir;
}

/** The `result` event of Claude capture `name`'s stdout. */
export function capturedClaudeResult(name: string): Record<string, unknown> {
  const r = streamEvents(readFileSync(join(BACKEND_FIXTURES, name, 'stdout'), 'utf8')).findLast((e) => e['type'] === 'result');
  if (r === undefined) throw new Error(`capture ${name}: no result event`);
  return r;
}
