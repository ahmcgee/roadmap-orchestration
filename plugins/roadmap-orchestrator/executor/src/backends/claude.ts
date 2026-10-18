// Reads what `claude -p --output-format stream-json --verbose --json-schema <s>` leaves on stdout: JSONL
// events, `system/init` first, then the session's `assistant` / `user` messages, and one `result` object
// last. Shape pinned by the captures in test/fixtures/backend-output/claude-* (Claude Code 2.1.283):
// `{type:'result', subtype, is_error, api_error_status, stop_reason, session_id, num_turns, total_cost_usd,
// result, structured_output, usage{input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens, ...}, modelUsage, ...}` is the object `--output-format json` prints alone.
// With `--json-schema` the validated value is `structured_output`; `result` carries the same JSON as
// text, and is not read. On an API failure the CLI prints the same object with `is_error: true`,
// `result` = the CLI's error text and exits 1 (captured: an unknown model, api_error_status 404; a prompt over the
// model's window, `result` "Prompt is too long", api_error_status null, Claude Code 2.1.301: claude-prompt-too-long).
//
// A session that ends a turn while something it started is pending (a Monitor; a judge's background subagent) runs on
// and prints a `result` per turn (`result_index` 0, 1, ...; Claude Code 2.1.288), each with `structured_output`, since
// `--json-schema` forces one at every turn end; the build answer's `final` tells the interim ones from the report
// (src/runner/report.ts). The last `result` event is the reading (its usage: `readUsage`); a stream without one (the CLI
// died or was killed first) has no output and usage `no-result`. The `assistant` events' tool_use blocks of Read, Grep
// and Glob are the session's reads (reads.json), its subagents' included (their events carry `parent_tool_use_id`). The result's `permission_denials` (`[{tool_name, tool_use_id, tool_input}]`,
// on every result the CLI prints, an is_error one included) lists the tool calls the CLI refused: in a judgment,
// a read of a path outside the cwd and every `--add-dir` (paid M4b run 5 captured one: a gate's Glob of the
// parent of its evidence dirs). Its Read, Grep and Glob entries are reads.json's `denied`.
import type { ClassUsage, TokenUsage, ToolRead, Usage, UsageUnavailableReason } from '../core/records.ts';
import { delegateClass } from '../routing/classes.ts';
import { MODEL_CLASSES, type ModelClass } from '../routing/types.ts';
import type { BackendReading } from './adapter.ts';
import { MalformedOutputError, UsageMismatchError, classifyBackendError } from './errors.ts';
import { type StreamEvent, jsonLines } from './jsonl.ts';

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const cost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Float slack when per-model list prices are summed against the CLI's own total (observed: 1e-17). */
const COST_EPSILON = 1e-9;

type ModelTokens = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>;
const ZERO_TOKENS: ModelTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const plus = (a: ModelTokens, b: ModelTokens): ModelTokens =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost });

/** A result's `modelUsage` per model id, or why it has none usable. */
function modelUsageOf(r: StreamEvent): ReadonlyMap<string, ModelTokens> | UsageUnavailableReason {
  const m = r['modelUsage'];
  if (m === undefined) return 'absent';
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return 'malformed';
  const out = new Map<string, ModelTokens>();
  for (const [model, raw] of Object.entries(m as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) return 'malformed';
    const u = raw as Record<string, unknown>;
    const fields = [u['inputTokens'], u['outputTokens'], u['cacheReadInputTokens'], u['cacheCreationInputTokens']];
    if (!fields.every(count) || !cost(u['costUSD'])) return 'malformed';
    const [input, output, cacheRead, cacheWrite] = fields as [number, number, number, number];
    out.set(model, { input, output, cacheRead, cacheWrite, cost: u['costUSD'] });
  }
  return out;
}

/** Each result's per-model costs sum to its `total_cost_usd` (when it reports one); otherwise the reading is refused. */
function crossCheck(r: StreamEvent, models: ReadonlyMap<string, ModelTokens>): void {
  const total = r['total_cost_usd'];
  if (!cost(total)) return;
  const sum = [...models.values()].reduce((a, t) => a + t.cost, 0);
  if (Math.abs(sum - total) > COST_EPSILON) {
    throw new UsageMismatchError(`result_index ${String(r['result_index'])}: modelUsage costUSD sums to ${sum}, total_cost_usd is ${total}`);
  }
}

/**
 * The session's usage from its result events (2026-10-16; shapes pinned by test/fixtures/backend-output/
 * claude-judgment-subagents, Claude Code 2.1.301). Every result carries `modelUsage` per model id, its subagents' models
 * included, and `total_cost_usd`, both cumulative over the session (identical on every result of one process; a resume's
 * include the earlier processes'); `num_turns` is the result's own turn's, so the turns are summed. The top-level `usage`
 * is the last turn's own model's alone, so it is not read. Every result is checked (`crossCheck`, its models catalogued);
 * the last one is the reading. `ownModel` (the init event's `model`) is metered to the call's seat; every other model is
 * `delegated`, per class (classes.ts `delegateClass`, which fails loud on a model it does not know).
 */
function readUsage(results: readonly StreamEvent[], ownModel: string | null): Usage {
  let models: ReadonlyMap<string, ModelTokens> | null = null;
  let turns: number | null = 0;
  for (const r of results) {
    const m = modelUsageOf(r);
    if (typeof m === 'string') return { kind: 'unavailable', reason: m };
    // Without an init event naming the session's model, no model's usage can be told the seat's from a subagent's.
    if (ownModel === null && m.size > 0) return { kind: 'unavailable', reason: 'malformed' };
    crossCheck(r, m);
    for (const model of m.keys()) if (model !== ownModel) delegateClass(model);
    models = m;
    turns = turns !== null && count(r['num_turns']) ? turns + r['num_turns'] : null;
  }
  const last = results.at(-1);
  if (models === null || last === undefined) return { kind: 'unavailable', reason: 'no-result' };
  const all = [...models.values()].reduce(plus, ZERO_TOKENS);
  const costUsd = cost(last['total_cost_usd']) ? last['total_cost_usd'] : null;
  const tokens: TokenUsage = { inputTokens: all.input, outputTokens: all.output, cacheReadTokens: all.cacheRead, cacheWriteTokens: all.cacheWrite, turns, costUsd };
  const byClass = new Map<ModelClass, ModelTokens>();
  for (const [model, t] of models) {
    if (model === ownModel) continue;
    const c = delegateClass(model);
    byClass.set(c, plus(byClass.get(c) ?? ZERO_TOKENS, t));
  }
  const delegated: ClassUsage[] = MODEL_CLASSES.flatMap((c) => {
    const t = byClass.get(c);
    return t === undefined ? [] : [{ class: c, inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite, costUsd: t.cost }];
  });
  return { kind: 'known', tokens, delegated };
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
  const results = events.filter((e) => e['type'] === 'result');
  const r = results.at(-1);
  if (r === undefined) {
    return {
      sessionId: null, output: { kind: 'absent', why: 'no result event on stdout' }, usage: { kind: 'unavailable', reason: 'no-result' }, backendErrors: [], stopReason: null,
      access: { reads, denied: [] },
    };
  }
  const sessionId = r['session_id'];
  if (typeof sessionId !== 'string') throw new MalformedOutputError('stdout', 'result without a string session_id');
  const stopReason = typeof r['stop_reason'] === 'string' ? r['stop_reason'] : null;
  const init = events.find((e) => e['type'] === 'system' && e['subtype'] === 'init');
  const usage = readUsage(results, typeof init?.['model'] === 'string' ? init['model'] : null);
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
