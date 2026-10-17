// Usage arithmetic for the meter (2026-10-16). A Claude result reports its session's cumulative usage (records.ts `Usage`),
// so a resumed session's reading includes its earlier invocations'. The usage fact charges each invocation the difference
// from what the session's earlier facts already charged (`chargedUsage`, written by pipeline/invoke.ts `usageFact`), so
// every reader of `meter` facts sums them as before; the fold keeps each session's running sum (`addCharged`).
import type { ClassUsage, TokenUsage } from './records.ts';
import { MODEL_CLASSES } from '../routing/types.ts';

/** What a Claude session's facts have charged so far: tokens over every model, and the delegated share per class. */
export type SessionCharge = Readonly<{ tokens: TokenUsage; delegated: readonly ClassUsage[] }>;

const nullable = (a: number | null, b: number | null, op: (x: number, y: number) => number): number | null => (a === null || b === null ? null : op(a, b));

/** `a + b`, field by field; turns add too (each fact's are its own process's). */
function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  const add = (x: number, y: number): number => x + y;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: nullable(a.cacheReadTokens, b.cacheReadTokens, add),
    cacheWriteTokens: nullable(a.cacheWriteTokens, b.cacheWriteTokens, add),
    turns: nullable(a.turns, b.turns, add),
    costUsd: nullable(a.costUsd, b.costUsd, add),
  };
}

/** Per-class sums, ascending in `MODEL_CLASSES` order; `sign` -1 subtracts `b`. */
function combineClasses(a: readonly ClassUsage[], b: readonly ClassUsage[], sign: 1 | -1): readonly ClassUsage[] {
  return MODEL_CLASSES.flatMap((c): ClassUsage[] => {
    const x = a.find((u) => u.class === c);
    const y = b.find((u) => u.class === c);
    if (x === undefined && y === undefined) return [];
    const zero: ClassUsage = { class: c, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const l = x ?? zero;
    const r = y ?? zero;
    return [{
      class: c,
      inputTokens: l.inputTokens + sign * r.inputTokens,
      outputTokens: l.outputTokens + sign * r.outputTokens,
      cacheReadTokens: l.cacheReadTokens + sign * r.cacheReadTokens,
      cacheWriteTokens: l.cacheWriteTokens + sign * r.cacheWriteTokens,
      costUsd: l.costUsd + sign * r.costUsd,
    }];
  });
}

/** The session's running sum once a fact charging `charged` is folded. */
export function addCharged(sum: SessionCharge | null, charged: SessionCharge): SessionCharge {
  return sum === null ? charged : { tokens: addTokens(sum.tokens, charged.tokens), delegated: combineClasses(sum.delegated, charged.delegated, 1) };
}

/** Float slack for a cost difference that should be zero or more (list prices summed per model). */
const COST_EPSILON = 1e-9;

/** A difference that cannot be negative: a count exactly, a cost within float slack (clamped to zero). */
function nonNegative(n: number, isCost: boolean, inv: string, what: string): number {
  if (n >= 0) return n;
  if (isCost && n >= -COST_EPSILON) return 0;
  throw new Error(`${inv}: its session's cumulative ${what} is below what the session's earlier invocations were charged (${n})`);
}

/**
 * What an invocation is charged: its session's cumulative `reading` less what the session's earlier facts charged (`sum`,
 * null for its first). `turns` is the reading's own (a process's turns are not cumulative). A reading below its session's
 * charged sum cannot happen (the CLI's totals only grow) and fails loud, naming `inv`.
 */
export function chargedUsage(reading: SessionCharge, sum: SessionCharge | null, inv: string): SessionCharge {
  if (sum === null) return reading;
  const t = reading.tokens;
  const s = sum.tokens;
  const diff = (x: number | null, y: number | null, what: string, isCost = false): number | null =>
    (x === null || y === null ? x : nonNegative(x - y, isCost, inv, what));
  const tokens: TokenUsage = {
    inputTokens: nonNegative(t.inputTokens - s.inputTokens, false, inv, 'input tokens'),
    outputTokens: nonNegative(t.outputTokens - s.outputTokens, false, inv, 'output tokens'),
    cacheReadTokens: diff(t.cacheReadTokens, s.cacheReadTokens, 'cache reads'),
    cacheWriteTokens: diff(t.cacheWriteTokens, s.cacheWriteTokens, 'cache writes'),
    turns: t.turns,
    costUsd: diff(t.costUsd, s.costUsd, 'cost', true),
  };
  const delegated = combineClasses(reading.delegated, sum.delegated, -1).map((c) => ({
    class: c.class,
    inputTokens: nonNegative(c.inputTokens, false, inv, `${c.class} input tokens`),
    outputTokens: nonNegative(c.outputTokens, false, inv, `${c.class} output tokens`),
    cacheReadTokens: nonNegative(c.cacheReadTokens, false, inv, `${c.class} cache reads`),
    cacheWriteTokens: nonNegative(c.cacheWriteTokens, false, inv, `${c.class} cache writes`),
    costUsd: nonNegative(c.costUsd, true, inv, `${c.class} cost`),
  }));
  return { tokens, delegated };
}
