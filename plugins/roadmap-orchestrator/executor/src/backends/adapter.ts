// The adapter: turns one finished invocation's files into its result.json. The executor runs it after the
// runner has exited with exit.json present (and recovery re-runs it whenever exit.json exists without a
// result). It is pure over the invocation's files, so a re-run yields the same bytes, and result.json is
// write-once: a second write of equal bytes is a no-op, a different one is a loud error.
//
// Order of decisions for a backend terminal:
// 1. read the CLI output (codex.ts / claude.ts) into a BackendReading;
// 2. validate the candidate output against the role's JSON schema (launch.json.terminal.schemaPath);
// 3. apply the precedence rule (`classifyTerminal`, records.ts);
// 4. a Claude `stop_reason: "refusal"` with no schema-valid output turns `malformed` into `refusal`;
// 5. a reported session id that differs from the launched one turns `success` into `malformed`.
//
// A Claude call's Read/Grep/Glob calls are written beside result.json as reads.json (`ReadsFile`), by the
// same write-once rule; Codex writes none.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableWrite } from '../core/fsx.ts';
import { implementerSessionId, type ImplementerSessionId } from '../core/ids.ts';
import type { AdapterInput } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import {
  type BackendError, type BackendOutcome, type BackendResult, type BackendTerminal, type CancelFile, type ExitFile, type ReadsFile, type ToolRead,
  type ResultFile, type Usage, RUNNER_FILE_READERS, STDERR_FILE, STDOUT_FILE, classifyCommand, classifyTerminal,
} from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { readClaude } from './claude.ts';
import { readCodex } from './codex.ts';
import { MalformedOutputError, ResultConflictError, UnsupportedSchemaError } from './errors.ts';

/** What one backend invocation reported, before schema validation and the precedence rule. */
export type BackendReading = Readonly<{
  /** The session id the CLI reported, unvalidated; null when it reported none. */
  sessionId: string | null;
  /** The candidate structured output, or why there is none. */
  output: Readonly<{ kind: 'present'; value: unknown }> | Readonly<{ kind: 'absent'; why: string }>;
  usage: Usage;
  backendErrors: readonly BackendError[];
  /** The backend's stop reason when it reports one (Claude); refusal is read from it. */
  stopReason: string | null;
  /** The session's read-only tool calls (Claude); null for Codex, or when the output could not be read. */
  reads: readonly ToolRead[] | null;
}>;

// ---------------------------------------------------------------------------------------------------
// JSON Schema: the subset role schemas use (OpenAI strict mode is a subset too). Any other keyword is
// refused loudly rather than silently not checked.

const ANNOTATIONS = new Set(['$schema', 'title', 'description']);
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'minimum', 'maximum',
]);

function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeMatches(type: unknown, v: unknown): boolean {
  switch (type) {
    case 'object': return isObject(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number';
    case 'integer': return Number.isInteger(v);
    case 'null': return v === null;
    default: throw new UnsupportedSchemaError('type', String(type));
  }
}

/** The first violation of `schema` by `value` (a description), or null when it conforms. */
export function schemaViolation(schema: unknown, value: unknown, at = '$'): string | null {
  if (!isObject(schema)) throw new UnsupportedSchemaError(at, 'a non-object schema');
  for (const k of Object.keys(schema)) {
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new UnsupportedSchemaError(at, k);
  }
  const s = schema;
  const fail = (what: string): string => `${at}: ${what}, got ${JSON.stringify(value)?.slice(0, 80)}`;
  if (s['type'] !== undefined) {
    const types = Array.isArray(s['type']) ? s['type'] : [s['type']];
    if (!types.some((t) => typeMatches(t, value))) return fail(`expected type ${types.join('|')}`);
  }
  if (s['const'] !== undefined && canonicalJson(s['const']) !== canonicalJson(value)) return fail(`expected ${JSON.stringify(s['const'])}`);
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => canonicalJson(e) === canonicalJson(value))) return fail('not in enum');
  if (Array.isArray(s['anyOf']) && !s['anyOf'].some((sub) => schemaViolation(sub, value, at) === null)) return fail('matches no anyOf branch');
  if (typeof value === 'string') {
    if (typeof s['minLength'] === 'number' && [...value].length < s['minLength']) return fail(`shorter than ${s['minLength']}`);
    if (typeof s['maxLength'] === 'number' && [...value].length > s['maxLength']) return fail(`longer than ${s['maxLength']}`);
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern'], 'u').test(value)) return fail(`does not match ${s['pattern']}`);
  }
  if (typeof value === 'number') {
    if (typeof s['minimum'] === 'number' && value < s['minimum']) return fail(`below ${s['minimum']}`);
    if (typeof s['maximum'] === 'number' && value > s['maximum']) return fail(`above ${s['maximum']}`);
  }
  if (Array.isArray(value)) {
    if (typeof s['minItems'] === 'number' && value.length < s['minItems']) return fail(`fewer than ${s['minItems']} items`);
    if (typeof s['maxItems'] === 'number' && value.length > s['maxItems']) return fail(`more than ${s['maxItems']} items`);
    if (s['items'] !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const v = schemaViolation(s['items'], value[i], `${at}[${i}]`);
        if (v !== null) return v;
      }
    }
  }
  if (isObject(value)) {
    const props = isObject(s['properties']) ? s['properties'] : {};
    if (Array.isArray(s['required'])) {
      for (const key of s['required']) if (!Object.hasOwn(value, key as string)) return `${at}.${String(key)}: required, missing`;
    }
    if (s['additionalProperties'] !== undefined && typeof s['additionalProperties'] !== 'boolean') {
      throw new UnsupportedSchemaError(at, 'additionalProperties (as a schema)');
    }
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) {
        const sub = schemaViolation(props[key], v, `${at}.${key}`);
        if (sub !== null) return sub;
      } else if (s['additionalProperties'] === false) {
        return `${at}.${key}: not allowed (additionalProperties false)`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The adapter proper.

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function read(terminal: BackendTerminal, stdoutPath: AbsPath): BackendReading {
  const backend = terminal.session.backend;
  try {
    if (backend === 'codex') return readCodex(readText(stdoutPath) ?? '', readText(terminal.outputPath));
    // Claude's output file is its stdout (launch.json.terminal.outputPath names it).
    return readClaude(readText(terminal.outputPath) ?? '');
  } catch (error) {
    if (!(error instanceof MalformedOutputError)) throw error;
    return { sessionId: null, output: { kind: 'absent', why: error.message }, usage: { kind: 'unavailable', reason: 'malformed' }, backendErrors: [], stopReason: null, reads: null };
  }
}

function backendOutcome(exit: ExitFile, cancel: CancelFile | null, terminal: BackendTerminal, reading: BackendReading): BackendOutcome {
  let valid = false;
  let why = reading.output.kind === 'absent' ? reading.output.why : '';
  if (reading.output.kind === 'present') {
    const schema: unknown = JSON.parse(readFileSync(terminal.schemaPath, 'utf8'));
    const violation = schemaViolation(schema, reading.output.value);
    valid = violation === null;
    if (violation !== null) why = `schema violation at ${violation}`;
  }
  const value = reading.output.kind === 'present' ? reading.output.value : null;
  const outcome = classifyTerminal(exit, cancel, value, valid);
  if (outcome.kind === 'malformed' && !valid && reading.stopReason === 'refusal') return { kind: 'refusal', stopReason: reading.stopReason };
  const launched = 'id' in terminal.session ? terminal.session.id : null;
  if (outcome.kind === 'success' && launched !== null && reading.sessionId !== null && reading.sessionId !== launched) {
    return { kind: 'malformed', detail: `the CLI reported session ${reading.sessionId}, launched as ${launched}` };
  }
  if ((outcome.kind === 'malformed' || outcome.kind === 'process-fault') && why !== '' && exit.cause === 'exited' && exit.child.type === 'exited') {
    return { ...outcome, detail: `${outcome.detail}: ${why}` };
  }
  return outcome;
}

/** Codex mints a fresh thread's id; every other session id is the one launch.json assigned. */
function implementerSession(terminal: Extract<BackendTerminal, { role: 'build' }>, reading: BackendReading): ImplementerSessionId | null {
  if ('id' in terminal.session) return terminal.session.id;
  if (reading.sessionId === null) return null;
  return implementerSessionId(reading.sessionId, 'stdout thread.started.thread_id');
}

type Adapted = Readonly<{ result: ResultFile; reads: ReadsFile | null }>;

function backendAdapted(input: AdapterInput, terminal: BackendTerminal): Adapted {
  const { launch, exit } = input;
  const reading = read(terminal, input.stdoutPath);
  const bound = { v: launch.v, arc: launch.arc, op: launch.op, inv: launch.inv };
  const base = {
    ...bound, type: 'backend' as const,
    routingRev: terminal.routingRev,
    outcome: backendOutcome(exit, input.cancel, terminal, reading),
    usage: reading.usage,
    backendErrors: reading.backendErrors,
  };
  const result: BackendResult = terminal.role === 'build'
    ? { ...base, role: terminal.role, session: implementerSession(terminal, reading) }
    : { ...base, role: terminal.role, session: terminal.session.id };
  return { result, reads: reading.reads === null ? null : { ...bound, reads: reading.reads } };
}

function adapted(input: AdapterInput): Adapted {
  const { launch, exit } = input;
  if (exit.arc !== launch.arc || exit.op !== launch.op || exit.inv !== launch.inv) {
    throw new Error(`exit.json is bound to ${exit.inv}, launch.json to ${launch.inv}`);
  }
  const terminal = launch.terminal;
  if (terminal.type === 'backend') return backendAdapted(input, terminal);
  return {
    result: {
      v: launch.v, arc: launch.arc, op: launch.op, inv: launch.inv, type: 'command',
      purpose: terminal.purpose, expectedExit: terminal.expectedExit, ...classifyCommand(exit, input.cancel, terminal.expectedExit),
    },
    reads: null,
  };
}

/** The `Adapter` of core/interfaces.ts: pure over the invocation's files. */
export function adapter(input: AdapterInput): ResultFile {
  return adapted(input).result;
}

function readRunnerJson(invDir: string, name: 'launch.json' | 'exit.json' | 'cancel.json' | 'result.json'): unknown {
  return JSON.parse(readFileSync(join(invDir, name), 'utf8'));
}

function inputOf(invDir: string): AdapterInput {
  const dir = absPath(invDir, 'invDir');
  return {
    launch: RUNNER_FILE_READERS['launch.json'](readRunnerJson(dir, 'launch.json'), 'launch.json'),
    exit: RUNNER_FILE_READERS['exit.json'](readRunnerJson(dir, 'exit.json'), 'exit.json'),
    cancel: existsSync(join(dir, 'cancel.json')) ? RUNNER_FILE_READERS['cancel.json'](readRunnerJson(dir, 'cancel.json'), 'cancel.json') : null,
    stdoutPath: absPath(join(dir, STDOUT_FILE)),
    stderrPath: absPath(join(dir, STDERR_FILE)),
  };
}

/** Read launch.json, exit.json and cancel.json (if any) from `invDir` and adapt. Throws if launch or exit is missing or invalid. */
export function adapt(invDir: string): ResultFile {
  return adapter(inputOf(invDir));
}

/** The bytes of a record the adapter writes: canonical JSON and a newline, validated by its own reader first. */
function recordBytes(name: 'result.json' | 'reads.json', record: ResultFile | ReadsFile): string {
  const text = canonicalJson(record);
  RUNNER_FILE_READERS[name](JSON.parse(text), name);
  return `${text}\n`;
}

export function resultBytes(result: ResultFile): string {
  return recordBytes('result.json', result);
}

/** Write-once: equal bytes already there are a no-op, different ones a loud error. */
function writeOnce(path: string, bytes: string): void {
  // The executor is the only writer, so check-then-write does not race; durableWrite never leaves a torn file.
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== bytes) throw new ResultConflictError(path);
  } else {
    durableWrite(path, bytes);
  }
}

/**
 * Adapt and write reads.json (a Claude call's) then result.json durably, once each. Re-running over the same
 * files is a no-op; result.json last, so its presence means both are written.
 */
export function writeResult(invDir: string): ResultFile {
  const input = inputOf(invDir);
  const { result, reads } = adapted(input);
  if (reads !== null) writeOnce(join(invDir, 'reads.json'), recordBytes('reads.json', reads));
  const path = join(invDir, 'result.json');
  writeOnce(path, resultBytes(result));
  return result;
}
