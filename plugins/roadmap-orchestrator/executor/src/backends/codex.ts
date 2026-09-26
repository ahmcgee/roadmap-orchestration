// Reads what `codex exec --json -o <file>` leaves behind: the JSONL event stream on stdout and the final
// message in the `-o` file. Shape pinned by the captures in test/fixtures/backend-output/codex-* (codex-cli
// 0.157.0): `thread.started{thread_id}`, `turn.started`, `item.*{item}`, `turn.completed{usage}`, and on
// failure a top-level `error{message}` then `turn.failed{error{message}}` (exit 1). Codex can exit 0 on a
// sandbox failure, so a turn counts only by its events: the `-o` file is trusted only after a
// `turn.completed` with no `turn.failed`.
import type { BackendError, TokenUsage, Usage } from '../core/records.ts';
import type { BackendReading } from './adapter.ts';
import { MalformedOutputError, classifyBackendError } from './errors.ts';

type Event = Readonly<Record<string, unknown>>;

function events(stdout: string, file: string): readonly Event[] {
  return stdout.split('\n').filter((line) => line !== '').map((line, i) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new MalformedOutputError(file, `line ${i + 1} is not JSON: ${line.slice(0, 120)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as Event)['type'] !== 'string') {
      throw new MalformedOutputError(file, `line ${i + 1} is not an event object with a string type`);
    }
    return value as Event;
  });
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** `turn.completed.usage`: input/output always; cached input and cache writes when reported. */
function turnUsage(u: unknown): TokenUsage | null {
  if (typeof u !== 'object' || u === null) return null;
  const r = u as Record<string, unknown>;
  const read = r['cached_input_tokens'];
  const write = r['cache_write_input_tokens'];
  if (!count(r['input_tokens']) || !count(r['output_tokens'])) return null;
  if (read !== undefined && !count(read)) return null;
  if (write !== undefined && !count(write)) return null;
  return {
    inputTokens: r['input_tokens'],
    outputTokens: r['output_tokens'],
    cacheReadTokens: read === undefined ? null : read,
    cacheWriteTokens: write === undefined ? null : write,
  };
}

function sum(a: TokenUsage, b: TokenUsage): TokenUsage {
  const add = (x: number | null, y: number | null): number | null => (x === null || y === null ? null : x + y);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
  };
}

/** A Codex error message is often an API error body serialised as JSON; its `status` is the HTTP status. */
function httpStatus(message: string): number | null {
  try {
    const body: unknown = JSON.parse(message);
    const status = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['status'] : undefined;
    return typeof status === 'number' ? status : null;
  } catch {
    return null;
  }
}

function errorMessage(e: Event, file: string): string {
  const carrier = e['type'] === 'turn.failed' ? e['error'] : e;
  const message = typeof carrier === 'object' && carrier !== null ? (carrier as Record<string, unknown>)['message'] : undefined;
  if (typeof message !== 'string') throw new MalformedOutputError(file, `${String(e['type'])} event without a string message`);
  return message;
}

/**
 * @param stdout the `--json` event stream
 * @param lastMessage the `-o` file's text, or null when Codex wrote none
 */
export function readCodex(stdout: string, lastMessage: string | null): BackendReading {
  const file = 'stdout';
  let sessionId: string | null = null;
  let completed = 0;
  let failed = false;
  let usage: TokenUsage | null = null;
  let usageProblem: 'absent' | 'malformed' | null = null;
  const errors: BackendError[] = [];
  for (const e of events(stdout, file)) {
    switch (e['type']) {
      case 'thread.started':
        if (typeof e['thread_id'] !== 'string') throw new MalformedOutputError(file, 'thread.started without a string thread_id');
        sessionId = e['thread_id'];
        break;
      case 'turn.completed': {
        completed += 1;
        if (e['usage'] === undefined) {
          usageProblem ??= 'absent';
          break;
        }
        const u = turnUsage(e['usage']);
        if (u === null) usageProblem = 'malformed';
        else usage = usage === null ? u : sum(usage, u);
        break;
      }
      case 'turn.failed':
      case 'error': {
        // A failed turn is also an error event; Codex usually prints both with the same message.
        if (e['type'] === 'turn.failed') failed = true;
        const message = errorMessage(e, file);
        if (!errors.some((x) => x.message === message)) errors.push({ class: classifyBackendError(message, httpStatus(message)), message });
        break;
      }
    }
  }
  let output: BackendReading['output'];
  if (failed) output = { kind: 'absent', why: 'the turn failed' };
  else if (completed === 0) output = { kind: 'absent', why: 'no turn.completed event' };
  else if (lastMessage === null) output = { kind: 'absent', why: 'no -o file' };
  else {
    try {
      output = { kind: 'present', value: JSON.parse(lastMessage) };
    } catch {
      output = { kind: 'absent', why: 'the -o file is not JSON' };
    }
  }
  const usageOut: Usage = completed === 0
    ? { kind: 'unavailable', reason: 'no-result' }
    : usageProblem !== null || usage === null
      ? { kind: 'unavailable', reason: usageProblem ?? 'absent' }
      : { kind: 'known', tokens: usage };
  return { sessionId, output, usage: usageOut, backendErrors: errors, stopReason: null };
}
