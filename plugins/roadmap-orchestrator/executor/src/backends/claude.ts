// Reads what `claude -p --output-format stream-json --verbose --json-schema <s>` leaves on stdout: JSONL
// events, `system/init` first, then the session's `assistant` / `user` messages, and one `result` object
// last. Shape pinned by the captures in test/fixtures/backend-output/claude-* (Claude Code 2.1.283):
// `{type:'result', subtype, is_error, api_error_status, stop_reason, session_id, num_turns, total_cost_usd,
// result, structured_output, usage{input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens, ...}, modelUsage, ...}` is the object `--output-format json` prints alone.
// With `--json-schema` the validated value is `structured_output`; `result` carries the same JSON as
// text, and is not read. On an API failure the CLI prints the same object with `is_error: true`,
// `result` = the CLI's error text and exits 1 (captured: an unknown model, api_error_status 404).
//
// A session that ends a turn while something it started is pending (a Monitor) runs on and prints a `result` per turn
// (`result_index` 0, 1, ...; Claude Code 2.1.288), each with `structured_output`, since `--json-schema` forces one at
// every turn end; the build answer's `final` tells the interim ones from the report (src/runner/report.ts).
// The last `result` event is the reading; a stream without one (the CLI died or was killed first) has no
// output and usage `no-result`. The `assistant` events' tool_use blocks of Read, Grep and Glob are the
// session's reads (reads.json). The result's `permission_denials` (`[{tool_name, tool_use_id, tool_input}]`,
// on every result the CLI prints, an is_error one included) lists the tool calls the CLI refused: in a judgment,
// a read of a path outside the cwd and every `--add-dir` (paid M4b run 5 captured one: a gate's Glob of the
// parent of its evidence dirs). Its Read, Grep and Glob entries are reads.json's `denied`.
import type { TokenUsage, ToolRead, Usage } from '../core/records.ts';
import type { BackendReading } from './adapter.ts';
import { MalformedOutputError, classifyBackendError } from './errors.ts';
import { type StreamEvent, jsonLines } from './jsonl.ts';

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function readUsage(r: StreamEvent): Usage {
  const u = r['usage'];
  if (u === undefined) return { kind: 'unavailable', reason: 'absent' };
  if (typeof u !== 'object' || u === null) return { kind: 'unavailable', reason: 'malformed' };
  const t = u as Record<string, unknown>;
  const fields = [t['input_tokens'], t['output_tokens'], t['cache_read_input_tokens'], t['cache_creation_input_tokens']];
  if (!fields.every(count)) return { kind: 'unavailable', reason: 'malformed' };
  const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = fields as [number, number, number, number];
  // The turn count and cost ride beside `usage` on the result; either may be absent without spoiling the tokens.
  const turns = count(r['num_turns']) ? r['num_turns'] : null;
  const costUsd = cost(r['total_cost_usd']) ? r['total_cost_usd'] : null;
  const tokens: TokenUsage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns, costUsd };
  return { kind: 'known', tokens };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The Read/Grep/Glob calls in the stream's assistant messages, in order. A call whose required argument is
 * not a string is left out: the CLI validates tool input and refuses such a call without running it.
 */
function readsOf(events: readonly StreamEvent[]): readonly ToolRead[] {
  const out: ToolRead[] = [];
  for (const e of events) {
    if (e['type'] !== 'assistant') continue;
    const content = (e['message'] as Record<string, unknown> | undefined)?.['content'];
    if (!Array.isArray(content)) throw new MalformedOutputError('stdout', 'an assistant event without message.content[]');
    for (const block of content as Record<string, unknown>[]) {
      if (block['type'] !== 'tool_use') continue;
      const read = toolRead(block['name'], block['input']);
      if (read !== null) out.push(read);
    }
  }
  return out;
}

/** A Read, Grep or Glob call from its tool name and input; null for another tool, or an input the CLI refuses unrun. */
function toolRead(name: unknown, rawInput: unknown): ToolRead | null {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  if (name === 'Read') {
    const path = str(input['file_path']);
    return path === null ? null : { tool: 'Read', path };
  }
  if (name === 'Grep' || name === 'Glob') {
    const pattern = str(input['pattern']);
    return pattern === null ? null : { tool: name, pattern, path: str(input['path']) };
  }
  return null;
}

/** The result's refused Read, Grep and Glob calls (`permission_denials`), in order. */
function deniedOf(r: StreamEvent): readonly ToolRead[] {
  const denials = r['permission_denials'];
  if (!Array.isArray(denials)) throw new MalformedOutputError('stdout', 'a result without permission_denials[]');
  return (denials as Record<string, unknown>[]).flatMap((d) => {
    const read = toolRead(d['tool_name'], d['tool_input']);
    return read === null ? [] : [read];
  });
}

/** @param stdout the invocation's stdout file: empty when the CLI died before printing anything. */
export function readClaude(stdout: string): BackendReading {
  const events = jsonLines(stdout, 'stdout');
  const reads = readsOf(events);
  const r = events.findLast((e) => e['type'] === 'result');
  if (r === undefined) {
    return {
      sessionId: null, output: { kind: 'absent', why: 'no result event on stdout' }, usage: { kind: 'unavailable', reason: 'no-result' }, backendErrors: [], stopReason: null,
      access: { reads, denied: [] },
    };
  }
  const sessionId = r['session_id'];
  if (typeof sessionId !== 'string') throw new MalformedOutputError('stdout', 'result without a string session_id');
  const stopReason = typeof r['stop_reason'] === 'string' ? r['stop_reason'] : null;
  const usage = readUsage(r);
  const denied = deniedOf(r);
  if (r['is_error'] === true) {
    const message = typeof r['result'] === 'string' ? r['result'] : JSON.stringify(r['result'] ?? null);
    const status = typeof r['api_error_status'] === 'number' ? r['api_error_status'] : null;
    return {
      sessionId,
      output: { kind: 'absent', why: 'the CLI reported an error result' },
      usage,
      backendErrors: [{ class: classifyBackendError(message, status), message }],
      stopReason,
      access: { reads, denied },
    };
  }
  const output: BackendReading['output'] = Object.hasOwn(r, 'structured_output')
    ? { kind: 'present', value: r['structured_output'] }
    : { kind: 'absent', why: 'no structured_output in the result' };
  return { sessionId, output, usage, backendErrors: [], stopReason, access: { reads, denied } };
}
