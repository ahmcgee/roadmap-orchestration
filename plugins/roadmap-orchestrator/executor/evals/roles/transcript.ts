// A role session's stream-json transcript (`claude -p --output-format stream-json --verbose`, one event per line), read
// for grading and the live trace: every tool call with its input, its result text, and the session it ran in (null: the
// main session; else the `parent_tool_use_id` of the Agent call whose subagent made it), the subagents spawned, the
// main session's turns, and the final result's per-model usage and cost.
//
// Cost comes from `result.modelUsage` (per model, subagents included), never the top-level `usage`, which excludes
// subagent tokens; the per-model costs must sum to `total_cost_usd`. A running session has no result yet, so `liveUsd`
// estimates its spend so far from each assistant message's tokens at list price (`PRICES`): what the role eval's per-trial
// cap reads (run.ts `--trial-cap`), never what a finished trial reports.

export type ToolCall = Readonly<{
  id: string;
  name: string;
  input: Readonly<Record<string, unknown>>;
  /** null: the main session; else the id of the Agent call whose subagent made this call. */
  parent: string | null;
  /** The tool result's text, once it arrived. */
  result: string | null;
}>;

export type Subagent = Readonly<{ id: string; type: string | null; model: string | null; outputTokens: number; inputTokens: number }>;

export type ModelUsage = Readonly<{ costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;

export type Usage = Readonly<{
  totalUsd: number;
  byModel: Readonly<Record<string, ModelUsage>>;
  /** Whether the per-model costs sum to total_cost_usd (within a micro-dollar and a tenth of a percent). */
  check: 'ok' | 'mismatch';
}>;

export type Transcript = Readonly<{
  tools: readonly string[];
  model: string | null;
  calls: readonly ToolCall[];
  subagents: readonly Subagent[];
  /** Main-session assistant messages (distinct message ids: the stream prints one event per content block). */
  turns: number;
  /**
   * Every assistant message's input, cache and output tokens summed, main session and subagents: the live proxy for cost
   * (the CLI reports cost only on its result), comparable between a running session and a finished one.
   */
  load: number;
  /** Main-session assistant messages that called a tool, in order, each with the ids of the calls it made. */
  toolTurns: readonly (readonly string[])[];
  usage: Usage | null;
  /** Spend so far at list price from every assistant message's tokens (main session and subagents): an estimate (`PRICES`). */
  liveUsd: number;
  denials: number;
  numTurns: number | null;
}>;

/** USD per million tokens: input, output, cache read, cache write (5-minute writes, 1.25x input). */
export type Price = Readonly<{ input: number; output: number; cacheRead: number; cacheWrite: number }>;

/**
 * List prices of the Claude models a role-eval session runs on (Anthropic first-party rates as of 2026-10-06), by model id
 * prefix (a message's `model` may carry a suffix). For the live estimate only: a finished call's cost is the CLI's own.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** The price of `model` (a loud failure for one `PRICES` does not list: the cap would silently undercount it). */
export function priceOf(model: string): Price {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`) || model.startsWith(`${k}[`));
  if (key === undefined) throw new Error(`no list price for model ${model} (evals/roles/transcript.ts PRICES)`);
  return PRICES[key]!;
}

type Event = Readonly<Record<string, unknown>>;
type Item = Readonly<{ type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; text?: unknown }>;

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** A tool result's content as text: a string, or the text of its text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof (c as Item).text === 'string' ? (c as Item).text as string : JSON.stringify(c))).join('\n');
  return JSON.stringify(content ?? null);
}

/**
 * The events of a stream-json stdout (blank lines skipped). A line that is not JSON is a loud failure. `live`: the stdout of
 * a running session, whose last line may still be partial (it is dropped until its newline arrives).
 */
export function parseEvents(text: string, live = false): readonly Event[] {
  const lines = text.split('\n');
  if (live) lines.pop();
  return lines.filter((l) => l.trim() !== '').map((l, i) => {
    try {
      return JSON.parse(l) as Event;
    } catch {
      throw new Error(`transcript line ${i + 1} is not JSON: ${l.slice(0, 120)}`);
    }
  });
}

/** Reads `modelUsage` and `total_cost_usd` of a result event into `Usage`; null when the result has no modelUsage. */
export function usageOf(result: Event): Usage | null {
  const mu = result['modelUsage'];
  if (mu === undefined || mu === null || typeof mu !== 'object') return null;
  const byModel: Record<string, ModelUsage> = {};
  for (const [model, u] of Object.entries(mu as Record<string, Record<string, unknown>>)) {
    byModel[model] = {
      costUsd: num(u['costUSD']), inputTokens: num(u['inputTokens']), outputTokens: num(u['outputTokens']),
      cacheReadTokens: num(u['cacheReadInputTokens']), cacheWriteTokens: num(u['cacheCreationInputTokens']),
    };
  }
  const totalUsd = num(result['total_cost_usd']);
  const sum = Object.values(byModel).reduce((a, u) => a + u.costUsd, 0);
  return { totalUsd, byModel, check: Math.abs(sum - totalUsd) <= 1e-6 + 1e-3 * totalUsd ? 'ok' : 'mismatch' };
}

/** Sums usages (one per call of a trial); the check holds when every one held. */
export function sumUsage(us: readonly Usage[]): Usage | null {
  if (us.length === 0) return null;
  const byModel: Record<string, ModelUsage> = {};
  for (const u of us) {
    for (const [m, x] of Object.entries(u.byModel)) {
      const y = byModel[m];
      byModel[m] = y === undefined ? x : {
        costUsd: y.costUsd + x.costUsd, inputTokens: y.inputTokens + x.inputTokens, outputTokens: y.outputTokens + x.outputTokens,
        cacheReadTokens: y.cacheReadTokens + x.cacheReadTokens, cacheWriteTokens: y.cacheWriteTokens + x.cacheWriteTokens,
      };
    }
  }
  return { totalUsd: us.reduce((a, u) => a + u.totalUsd, 0), byModel, check: us.every((u) => u.check === 'ok') ? 'ok' : 'mismatch' };
}

/** The session read from its events (`parseEvents`); several calls' events read together are one combined session. */
export function readTranscript(events: readonly Event[]): Transcript {
  let tools: readonly string[] = [];
  let model: string | null = null;
  const calls = new Map<string, { id: string; name: string; input: Record<string, unknown>; parent: string | null; result: string | null }>();
  const subagents = new Map<string, { id: string; type: string | null; model: string | null; outputTokens: number; inputTokens: number }>();
  const toolTurns: string[][] = [];
  const seen = new Set<string>();
  let turns = 0;
  let load = 0;
  let result: Event | null = null;
  // Each message's latest usage and model: the stream repeats a message once per content block, its usage growing.
  const priced = new Map<string, { model: string; usage: Readonly<Record<string, unknown>> }>();
  for (const e of events) {
    const parent = typeof e['parent_tool_use_id'] === 'string' ? e['parent_tool_use_id'] : null;
    if (e['type'] === 'system' && e['subtype'] === 'init') {
      tools = Array.isArray(e['tools']) ? (e['tools'] as unknown[]).filter((t): t is string => typeof t === 'string') : [];
      model = typeof e['model'] === 'string' ? e['model'] : null;
      continue;
    }
    if (e['type'] === 'result') {
      result = e;
      continue;
    }
    const message = e['message'] as Readonly<{ content?: unknown; model?: unknown; usage?: Readonly<Record<string, unknown>> }> | undefined;
    const content = Array.isArray(message?.content) ? (message.content as Item[]) : [];
    if (e['type'] === 'assistant') {
      const id = typeof (message as { id?: unknown } | undefined)?.id === 'string' ? (message as { id: string }).id : null;
      const first = id === null || !seen.has(id);
      if (id !== null) seen.add(id);
      if (message?.usage !== undefined && typeof message.model === 'string') priced.set(id ?? `#${priced.size}`, { model: message.model, usage: message.usage });
      if (first) {
        const u = message?.usage;
        const input = num(u?.['input_tokens']) + num(u?.['cache_read_input_tokens']) + num(u?.['cache_creation_input_tokens']);
        load += input + num(u?.['output_tokens']);
        if (parent === null) turns += 1;
        else {
          const s = subagents.get(parent);
          if (s !== undefined) {
            if (s.model === null && typeof message?.model === 'string') s.model = message.model;
            s.outputTokens += num(u?.['output_tokens']);
            s.inputTokens += input;
          }
        }
      }
      const made: string[] = [];
      for (const item of content) {
        if (item.type !== 'tool_use' || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
        const input = (item.input ?? {}) as Record<string, unknown>;
        calls.set(item.id, { id: item.id, name: item.name, input, parent, result: null });
        made.push(item.id);
        if (item.name === 'Agent' || item.name === 'Task') {
          subagents.set(item.id, {
            id: item.id, type: typeof input['subagent_type'] === 'string' ? input['subagent_type'] : null,
            model: typeof input['model'] === 'string' ? input['model'] : null, outputTokens: 0, inputTokens: 0,
          });
        }
      }
      if (parent === null && made.length > 0) {
        const last = toolTurns.at(-1);
        if (!first && last !== undefined) last.push(...made);
        else toolTurns.push(made);
      }
      continue;
    }
    if (e['type'] === 'user') {
      for (const item of content) {
        if (item.type !== 'tool_result' || typeof item.tool_use_id !== 'string') continue;
        const c = calls.get(item.tool_use_id);
        if (c !== undefined) c.result = resultText(item.content);
      }
    }
  }
  const denials = result === null ? 0 : Array.isArray(result['permission_denials']) ? (result['permission_denials'] as unknown[]).length : 0;
  let liveUsd = 0;
  for (const { model: m, usage: u } of priced.values()) {
    if (m === '<synthetic>') continue; // the CLI's own messages (an API error it reports): no model call, no cost
    const p = priceOf(m);
    liveUsd += (num(u['input_tokens']) * p.input + num(u['output_tokens']) * p.output + num(u['cache_read_input_tokens']) * p.cacheRead
      + num(u['cache_creation_input_tokens']) * p.cacheWrite) / 1e6;
  }
  return {
    tools, model, calls: [...calls.values()], subagents: [...subagents.values()], turns, load, toolTurns,
    usage: result === null ? null : usageOf(result), liveUsd, denials, numTurns: result === null ? null : num(result['num_turns']),
  };
}

/** The paths a session Read (any session), as given. */
export const readPaths = (t: Transcript): readonly string[] =>
  t.calls.flatMap((c) => (c.name === 'Read' && typeof c.input['file_path'] === 'string' ? [c.input['file_path']] : []));

/** The result texts of the session's Grep calls (any session). */
export const grepResults = (t: Transcript): readonly string[] => t.calls.flatMap((c) => (c.name === 'Grep' && c.result !== null ? [c.result] : []));

/** Tool calls by tool name. */
export function toolCounts(t: Transcript): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const c of t.calls) out[c.name] = (out[c.name] ?? 0) + 1;
  return out;
}

/** The subagent tool's two names: the CLI lists `Task` in its init event on some versions and calls it `Agent`. */
const AGENT_NAMES = ['Agent', 'Task'];
const listed = (tools: readonly string[], name: string): boolean => tools.includes(name) || (AGENT_NAMES.includes(name) && AGENT_NAMES.some((n) => tools.includes(n)));

/** Calls of tools the init event did not list (attempts at unavailable tools). */
export const unavailableCalls = (t: Transcript): readonly string[] => t.calls.filter((c) => t.tools.length > 0 && !listed(t.tools, c.name)).map((c) => c.name);
