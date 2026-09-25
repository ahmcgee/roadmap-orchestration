// Reads what `claude -p --output-format json --json-schema <s>` leaves on stdout: one result object.
// Shape pinned by the captures in test/fixtures/backend-output/claude-* (Claude Code 2.1.282):
// `{type:'result', subtype, is_error, api_error_status, stop_reason, session_id, result, structured_output,
// usage{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, ...}, ...}`.
// With `--json-schema` the validated value is `structured_output`; `result` carries the same JSON as
// text, and is not read. On an API failure the CLI prints the same object with `is_error: true`,
// `result` = the CLI's error text and exits 1 (captured: an unknown model, api_error_status 404).
import type { TokenUsage, Usage } from '../core/records.ts';
import type { BackendReading } from './adapter.ts';
import { MalformedOutputError, classifyBackendError } from './errors.ts';

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function readUsage(u: unknown): Usage {
  if (u === undefined) return { kind: 'unavailable', reason: 'absent' };
  if (typeof u !== 'object' || u === null) return { kind: 'unavailable', reason: 'malformed' };
  const r = u as Record<string, unknown>;
  const fields = [r['input_tokens'], r['output_tokens'], r['cache_read_input_tokens'], r['cache_creation_input_tokens']];
  if (!fields.every(count)) return { kind: 'unavailable', reason: 'malformed' };
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = fields as [number, number, number, number];
  const tokens: TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
  return { kind: 'known', tokens };
}

/** @param stdout the invocation's stdout file: empty when the CLI died before printing its result. */
export function readClaude(stdout: string): BackendReading {
  if (stdout.trim() === '') {
    return { sessionId: null, output: { kind: 'absent', why: 'no result object on stdout' }, usage: { kind: 'unavailable', reason: 'no-result' }, backendErrors: [], stopReason: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new MalformedOutputError('stdout', `not one JSON object: ${stdout.slice(0, 120)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || (value as Record<string, unknown>)['type'] !== 'result') {
    throw new MalformedOutputError('stdout', 'not a result object (type "result")');
  }
  const r = value as Record<string, unknown>;
  const sessionId = r['session_id'];
  if (typeof sessionId !== 'string') throw new MalformedOutputError('stdout', 'result without a string session_id');
  const stopReason = typeof r['stop_reason'] === 'string' ? r['stop_reason'] : null;
  const usage = readUsage(r['usage']);
  if (r['is_error'] === true) {
    const message = typeof r['result'] === 'string' ? r['result'] : JSON.stringify(r['result'] ?? null);
    const status = typeof r['api_error_status'] === 'number' ? r['api_error_status'] : null;
    return {
      sessionId,
      output: { kind: 'absent', why: 'the CLI reported an error result' },
      usage,
      backendErrors: [{ class: classifyBackendError(message, status), message }],
      stopReason,
    };
  }
  const output: BackendReading['output'] = Object.hasOwn(r, 'structured_output')
    ? { kind: 'present', value: r['structured_output'] }
    : { kind: 'absent', why: 'no structured_output in the result' };
  return { sessionId, output, usage, backendErrors: [], stopReason };
}
