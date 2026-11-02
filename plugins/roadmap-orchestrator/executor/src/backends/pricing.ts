// List prices per million tokens, verified 2026-10-31. These are estimates, never billing or admission limits.
// https://developers.openai.com/api/docs/models/gpt-5.6-luna
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
import type { TokenUsage, Usage } from '../core/records.ts';
import type { CodexModelId } from '../routing/types.ts';

export const CODEX_PRICES: Readonly<Record<CodexModelId, Readonly<{ input: number; cached: number; write: number; output: number }>>> = {
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, write: 0.25, output: 1.2 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, write: 5, output: 20 },
};

/** Codex input includes cached tokens. Aggregate CLI usage cannot identify long-context requests; standard rates apply. */
export function pricedCodexUsage(usage: Usage, model: string): Usage {
  const rate = CODEX_PRICES[model as CodexModelId];
  if (rate === undefined) throw new Error(`Codex model has no price: ${model}`);
  const price = (u: TokenUsage): TokenUsage => {
    if (u.costUsd !== null) return u;
    const cached = u.cacheReadTokens ?? 0;
    const written = u.cacheWriteTokens ?? 0;
    return { ...u, costEstimated: true, costUsd: (Math.max(0, u.inputTokens - cached - written) * rate.input + cached * rate.cached + written * rate.write + u.outputTokens * rate.output) / 1e6 };
  };
  return usage.kind === 'known' ? { ...usage, tokens: price(usage.tokens) }
    : usage.streamed === undefined ? usage : { ...usage, streamed: price(usage.streamed) };
}
