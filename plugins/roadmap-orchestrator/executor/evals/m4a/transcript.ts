// Session transcripts (`claude -p --output-format stream-json`, one event per line) and the isolation scan (LR-f, H1,
// K22, H14): every tool call's input and every tool result is searched for the needles; any hit is a finding. Shared
// by the driver (the root session), check.ts (re-scanned) and adjudicate.ts (whose hit voids the verdict). Also the
// cost export (F30): per-invocation and per-turn rows with the unknowns explicit.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Event } from '../../src/core/events.ts';
import { invocationId } from '../../src/core/ids.ts';
import type { Layout } from './layout.ts';

/** The answer key: never staged, never read by a session. */
export const ANSWER_KEY = fileURLToPath(new URL('./answer-key.json', import.meta.url));

/** This repository's root and its main checkout (a worktree's common dir names the latter). */
export function repositoryPaths(): readonly string[] {
  const here = dirname(ANSWER_KEY);
  const top = execFileSync('git', ['-C', here, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const common = resolve(here, execFileSync('git', ['-C', here, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim());
  return [...new Set([top, dirname(common)])];
}

/** What a session must never touch: the key (path and name), the fixture sources, the real repository. */
export function needles(): readonly string[] {
  return [ANSWER_KEY, 'answer-key', 'evals/m4a', ...repositoryPaths()];
}

/** A tool call's input or a tool result, as the transcript carries it. */
export type ToolTraffic = Readonly<{ turn: number; line: number; kind: 'tool_use' | 'tool_result'; text: string }>;

type ContentItem = Readonly<{ type?: unknown; input?: unknown; content?: unknown }>;

/** Every tool call input and tool result in a stream-json transcript (lines `{turn, event}` as the driver writes them). */
export function toolTraffic(file: string): readonly ToolTraffic[] {
  if (!existsSync(file)) return [];
  const out: ToolTraffic[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((raw, i) => {
    if (raw === '') return;
    const { turn, event } = JSON.parse(raw) as { turn: number; event: { type?: unknown; message?: { content?: unknown } } };
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content as ContentItem[]) {
      if (item.type === 'tool_use') out.push({ turn, line: i + 1, kind: 'tool_use', text: JSON.stringify(item.input ?? null) });
      if (item.type === 'tool_result') out.push({ turn, line: i + 1, kind: 'tool_result', text: JSON.stringify(item.content ?? null) });
    }
  });
  return out;
}

/** Each needle found in the transcript's tool traffic, with where. */
export function scanTranscript(file: string, search: readonly string[]): readonly string[] {
  const hits: string[] = [];
  for (const t of toolTraffic(file)) for (const n of search) if (t.text.includes(n)) hits.push(`${JSON.stringify(n)} in a ${t.kind} (turn ${t.turn}, line ${t.line})`);
  return hits;
}

/** The session's final text of each turn (`result` events). */
export function resultsOf(file: string): readonly Readonly<{ turn: number; text: string }>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').flatMap((raw) => {
    const { turn, event } = JSON.parse(raw) as { turn: number; event: { type?: unknown; result?: unknown } };
    return event.type === 'result' && typeof event.result === 'string' ? [{ turn, text: event.result }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------
// Cost export (F30): one row per executor invocation and per session turn, unknowns explicit

/** An executor invocation's cost: `costUsd: null` is an unknown, and `unknown` says why (never a silent zero). */
export type InvocationCost = Readonly<{
  kind: 'invocation'; arc: string; inv: string; role: string; seq: number; costUsd: number | null; unknown: string | null; postRun: boolean;
}>;
/** A root-agent turn's cost: the delta of the session's cumulative `total_cost_usd` since the last known total. */
export type RootCost = Readonly<{ kind: 'root'; turn: number; costUsd: number | null; cumulativeUsd: number | null; unknown: string | null; coversTurns: readonly number[] }>;
export type CostTotals = Readonly<{
  kind: 'totals'; rootUsd: number; executorUsd: number; postRunUsd: number; unknownInvocations: number; unknownRootTurns: number; postRunUnknown: number;
}>;
export type CostRow = InvocationCost | RootCost | CostTotals;

/**
 * One arc's invocation costs: every backend spawn intent (`backend`, `arc-backend`) and every usage fact. A spawn with a
 * `meter` fact charges that fact's `costUsd` (null when the CLI reported none: Codex); one with `usage-unavailable` or no
 * usage fact at all is an unknown with its reason. Activity after `terminalSeq` (the arc's terminal state) is `postRun`.
 */
export function invocationCosts(arc: string, events: readonly Event[], terminalSeq: number | null): readonly InvocationCost[] {
  const rows = new Map<string, InvocationCost>();
  const post = (seq: number): boolean => terminalSeq !== null && seq > terminalSeq;
  for (const e of events) {
    if (e.type !== 'intent' || e.kind !== 'proc.spawn') continue;
    const subject = e.expect.subject;
    if (subject.purpose !== 'backend' && subject.purpose !== 'arc-backend') continue;
    const inv = invocationId(e.op, e.ordinal);
    rows.set(inv, { kind: 'invocation', arc, inv, role: subject.role, seq: e.seq, costUsd: null, unknown: 'no usage fact', postRun: post(e.seq) });
  }
  for (const e of events) {
    if (e.type !== 'fact' || (e.fact.kind !== 'meter' && e.fact.kind !== 'usage-unavailable')) continue;
    const f = e.fact;
    const seq = rows.get(f.inv)?.seq ?? e.seq;
    const base = { kind: 'invocation', arc, inv: f.inv as string, role: f.subject.type === 'smoke' ? 'smoke' : f.subject.role, seq, postRun: post(seq) } as const;
    if (f.kind === 'meter') rows.set(f.inv, { ...base, costUsd: f.usage.costUsd, unknown: f.usage.costUsd === null ? 'the CLI reported no cost' : null });
    else rows.set(f.inv, { ...base, costUsd: null, unknown: `usage unavailable: ${f.reason}` });
  }
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * The root session's per-turn costs from the transcript's `result` events: `total_cost_usd` is the session's cumulative
 * total, so a turn's cost is the delta since the last known total. A turn with no total is an unknown, and the next known
 * delta names the turns it spans (`coversTurns`); a total below the last one is not cumulative and is an unknown too.
 */
export function rootCosts(file: string): readonly RootCost[] {
  if (!existsSync(file)) return [];
  const totals = new Map<number, number | null>();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (raw === '') continue;
    const { turn, event } = JSON.parse(raw) as { turn: number; event: { type?: unknown; total_cost_usd?: unknown } };
    if (!totals.has(turn)) totals.set(turn, null);
    if (event.type === 'result' && typeof event.total_cost_usd === 'number') totals.set(turn, event.total_cost_usd);
  }
  const rows: RootCost[] = [];
  let last = 0;
  let pending: number[] = [];
  for (const [turn, total] of [...totals].sort((a, b) => a[0] - b[0])) {
    if (total === null) {
      rows.push({ kind: 'root', turn, costUsd: null, cumulativeUsd: null, unknown: 'the turn reported no total_cost_usd', coversTurns: [turn] });
      pending.push(turn);
    } else if (total < last) {
      rows.push({ kind: 'root', turn, costUsd: null, cumulativeUsd: total, unknown: `the total fell from ${last} to ${total}: not cumulative`, coversTurns: [turn] });
      last = total;
      pending = [];
    } else {
      rows.push({ kind: 'root', turn, costUsd: total - last, cumulativeUsd: total, unknown: null, coversTurns: [...pending, turn] });
      last = total;
      pending = [];
    }
  }
  return rows;
}

/** Totals over known costs only; the unknowns are counted beside them, and post-run activity is totalled apart. */
export function costTotals(invocations: readonly InvocationCost[], root: readonly RootCost[]): CostTotals {
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  const known = (r: InvocationCost): number => r.costUsd ?? 0;
  return {
    kind: 'totals',
    rootUsd: sum(root.map((r) => r.costUsd ?? 0)),
    executorUsd: sum(invocations.filter((r) => !r.postRun).map(known)),
    postRunUsd: sum(invocations.filter((r) => r.postRun).map(known)),
    unknownInvocations: invocations.filter((r) => r.costUsd === null && !r.postRun).length,
    unknownRootTurns: root.filter((r) => r.costUsd === null).length,
    postRunUnknown: invocations.filter((r) => r.costUsd === null && r.postRun).length,
  };
}

/** Writes `<dir>/costs.jsonl`: invocation rows, root rows, then the totals row. */
export function exportCosts(l: Layout, arcs: readonly Readonly<{ arc: string; events: readonly Event[]; terminalSeq: number | null }>[]): readonly CostRow[] {
  const invocations = arcs.flatMap((a) => invocationCosts(a.arc, a.events, a.terminalSeq));
  const root = rootCosts(l.transcript);
  const rows: CostRow[] = [...invocations, ...root, costTotals(invocations, root)];
  writeFileSync(l.costs, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return rows;
}
