// Fake `codex` / `claude` CLI, run through the PATH shims in shim.ts:
//   node fake-backend.ts --scenario /abs/scenario.json --as codex|claude <the CLI's own argv...>
// It reads the scenario (test/helpers/scenario.ts), logs the call to calls.jsonl beside it, matches the call
// to the next unconsumed step and performs that step's acts. Output acts write each CLI's real format:
// Claude's result objects are the captured fixtures (test/fixtures/backend-output) with fields replaced,
// Codex's event stream follows the captured event vocabulary, so what the fake emits is what the adapter
// was pinned against.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitAtBarrier } from '../helpers/barrier.ts';
import { git, writeFiles, type FileSet } from '../helpers/repo.ts';
import {
  type Act, CALLS_FILE, CAPACITY_TEXT, CLAUDE_USAGE_LIMIT, CODEX_RESUME_COLLISION, CODEX_USAGE_LIMIT, type CallRecord, type Expect, type FakeName, type ScenarioFile, type Step, readCalls,
} from '../helpers/scenario.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/backend-output/', import.meta.url));

type Call = Readonly<{ as: FakeName; argv: readonly string[]; cwd: string; stdin: string; env: Record<string, string> }>;

function parseArgs(raw: readonly string[]): { scenario: string; as: FakeName; argv: readonly string[] } {
  if (raw[0] !== '--scenario' || raw[2] !== '--as' || (raw[3] !== 'codex' && raw[3] !== 'claude') || raw[1] === undefined) {
    throw new Error(`fake-backend: usage: --scenario <path> --as codex|claude <argv...>; got ${JSON.stringify(raw)}`);
  }
  return { scenario: raw[1], as: raw[3], argv: raw.slice(4) };
}

/** `want` appears in `argv` in order, not necessarily adjacent. */
function hasSubsequence(argv: readonly string[], want: readonly string[]): boolean {
  let i = 0;
  for (const token of argv) if (token === want[i]) i += 1;
  return i === want.length;
}

function mismatch(step: Step | undefined, call: Call): string | null {
  if (step === undefined) return 'no step left in the scenario';
  if (step.as !== call.as) return `step is for ${step.as}, the call is ${call.as}`;
  const e: Expect = step.expect;
  if (e.argv !== undefined && !hasSubsequence(call.argv, e.argv)) return `argv lacks ${JSON.stringify(e.argv)} in order`;
  for (const t of e.argvLacks ?? []) if (call.argv.includes(t)) return `argv contains ${JSON.stringify(t)}`;
  if (e.cwd !== undefined && e.cwd !== call.cwd) return `cwd is ${call.cwd}, expected ${e.cwd}`;
  for (const s of e.stdinContains ?? []) if (!call.stdin.includes(s)) return `stdin lacks ${JSON.stringify(s)}`;
  return null;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function out(text: string): void {
  writeFileSync(1, text);
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => void Atomics.wait(sleepCell, 0, 0, ms);

// ---------------------------------------------------------------------------------------------------
// Codex: JSONL events on stdout, the final message in the -o file.

const CODEX_USAGE = { input_tokens: 14524, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 15, reasoning_output_tokens: 0 };

function codexThread(argv: readonly string[], step: Extract<Step, { as: 'codex' }>, index: number): string {
  if (argv[0] === 'exec' && argv[1] === 'resume' && argv[2] !== undefined) return argv[2];
  return step.threadId ?? `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function codexEmit(argv: readonly string[], thread: string, message: string, extras: readonly object[], usage: boolean): void {
  const o = flagValue(argv, '-o');
  if (o === undefined) throw new Error('fake codex: an output act needs -o in argv');
  const events: object[] = [
    { type: 'thread.started', thread_id: thread },
    { type: 'turn.started' },
    ...extras,
    { type: 'item.completed', item: { id: `item_${extras.length}`, type: 'agent_message', text: message } },
    usage ? { type: 'turn.completed', usage: CODEX_USAGE } : { type: 'turn.completed' },
  ];
  out(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  writeFileSync(o, message);
}

function codexUsageLimit(thread: string): never {
  const events = [
    { type: 'thread.started', thread_id: thread },
    { type: 'turn.started' },
    { type: 'error', message: CODEX_USAGE_LIMIT },
    { type: 'turn.failed', error: { message: CODEX_USAGE_LIMIT } },
  ];
  out(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------
// Claude: one result object on stdout, built from the captured fixtures.

function template(name: 'claude-judgment' | 'claude-api-error'): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name, 'stdout'), 'utf8')) as Record<string, unknown>;
}

function claudeSession(argv: readonly string[]): string {
  const id = flagValue(argv, '--session-id') ?? flagValue(argv, '--resume');
  if (id === undefined) throw new Error('fake claude: argv has neither --session-id nor --resume');
  return id;
}

function claudeResult(session: string, fields: Readonly<Record<string, unknown>>, drop: readonly string[] = []): void {
  const r: Record<string, unknown> = { ...template('claude-judgment'), session_id: session, ...fields };
  for (const k of drop) delete r[k];
  out(`${JSON.stringify(r)}\n`);
}

function claudeUsageLimit(session: string): never {
  const r = { ...template('claude-api-error'), session_id: session, result: CLAUDE_USAGE_LIMIT, api_error_status: 429 };
  out(`${JSON.stringify(r)}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------

function paths(files: FileSet): string[] {
  return Object.keys(files);
}

function perform(act: Act, call: Call, step: Step, index: number, scenarioDir: string): void {
  const codex = step.as === 'codex';
  const thread = (): string => (step.as === 'codex' ? codexThread(call.argv, step, index) : '');
  const session = (): string => claudeSession(call.argv);
  switch (act.type) {
    case 'emit':
    case 'noUsage': {
      const text = JSON.stringify(act.value);
      if (codex) codexEmit(call.argv, thread(), text, [], act.type === 'emit');
      else claudeResult(session(), { result: text, structured_output: act.value }, act.type === 'noUsage' ? ['usage'] : []);
      return;
    }
    case 'capacityText': {
      const text = JSON.stringify(act.value);
      if (codex) {
        const command = { type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'npm test', aggregated_output: CAPACITY_TEXT, exit_code: 0, status: 'completed' } };
        const note = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `The log said: ${CAPACITY_TEXT}` } };
        codexEmit(call.argv, thread(), text, [command, note], true);
      } else {
        claudeResult(session(), { result: `The log said: ${CAPACITY_TEXT}`, structured_output: act.value });
      }
      return;
    }
    case 'malformed':
      if (codex) codexEmit(call.argv, thread(), 'not json', [], true);
      else claudeResult(session(), { result: 'not json' }, ['structured_output']);
      return;
    case 'usageLimit':
      if (codex) codexUsageLimit(thread());
      claudeUsageLimit(session());
    case 'refusal':
      claudeResult(session(), { result: "I can't help with that.", stop_reason: 'refusal' }, ['structured_output']);
      return;
    case 'exitZeroNoop':
      process.exit(0);
    case 'commit':
      writeFiles(call.cwd, act.files);
      git(call.cwd, 'add', '--all', '--', ...paths(act.files));
      git(call.cwd, 'commit', '--quiet', '--message', act.message);
      return;
    case 'stage':
      writeFiles(call.cwd, act.files);
      git(call.cwd, 'add', '--all', '--', ...paths(act.files));
      return;
    case 'dirty':
      writeFiles(call.cwd, act.files);
      return;
    case 'exit':
      process.exit(act.code);
    case 'hang':
      sleepSync(act.ms);
      return;
    case 'forkSetsid': {
      const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${act.lifeMs})`], {
        detached: true,
        stdio: 'ignore',
        env: act.env === 'keepEnv' ? process.env : {},
      });
      if (child.pid === undefined) throw new Error('fake: forkSetsid spawn failed');
      writeFileSync(act.pidFile, `${child.pid}\n`, { flag: 'wx' });
      child.unref();
      return;
    }
    case 'barrier':
      waitAtBarrier(scenarioDir, act.name, act.timeoutMs);
      return;
    case 'resumeCollision':
      process.stderr.write(`${CODEX_RESUME_COLLISION}\n`);
      process.exit(1);
    case 'writeToPrompt': {
      const dir = new RegExp(act.pattern).exec(call.stdin)?.[1];
      if (dir === undefined) {
        process.stderr.write(`fake ${call.as}: writeToPrompt ${act.pattern}: no match in stdin\n`);
        process.exit(99);
      }
      writeFileSync(join(dir, act.file), act.text);
      return;
    }
    case 'readFromPrompt': {
      const dir = new RegExp(act.pattern).exec(call.stdin)?.[1];
      const fail = (why: string): never => {
        process.stderr.write(`fake ${call.as}: readFromPrompt ${act.pattern}: ${why}\n`);
        process.exit(99);
      };
      if (dir === undefined) return fail('no match in stdin');
      let text: string;
      try {
        text = readFileSync(join(dir, act.file), 'utf8');
      } catch (error) {
        return fail(`cannot read ${join(dir, act.file)}: ${(error as Error).message}`);
      }
      if (!text.includes(act.contains)) fail(`${join(dir, act.file)} lacks ${JSON.stringify(act.contains)}`);
      return;
    }
  }
}

function main(): void {
  const { scenario, as, argv } = parseArgs(process.argv.slice(2));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('ROADMAP_') && v !== undefined) env[k] = v;
  const call: Call = { as, argv, cwd: process.cwd(), stdin: readFileSync(0, 'utf8'), env };
  const file = JSON.parse(readFileSync(scenario, 'utf8')) as ScenarioFile;
  const index = readCalls(scenario).filter((c) => c.step !== null).length;
  const step = file.steps[index];
  const problem = mismatch(step, call);
  const record: CallRecord = { ...call, step: problem === null ? index : null };
  const dir = dirname(scenario);
  appendFileSync(join(dir, CALLS_FILE), `${JSON.stringify(record)}\n`);
  if (problem !== null || step === undefined) {
    process.stderr.write(`fake ${as}: call ${JSON.stringify(argv)} in ${call.cwd} does not match step ${index}: ${problem}\n`);
    process.exit(99);
  }
  for (const act of step.acts) perform(act, call, step, index, dir);
  process.exit(0);
}

main();
