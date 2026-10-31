import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCodex } from '../src/backends/codex.ts';
import { CODEX_PRICES, pricedCodexUsage } from '../src/backends/pricing.ts';
import { tokenUsage } from '../src/core/records.ts';
import { usageFact } from '../src/pipeline/invoke.ts';
import { invocationIdOf, routingRev } from '../src/core/ids.ts';
import { CODEX_MODELS } from '../src/routing/types.ts';

const stream = (u: object) => JSON.stringify({ type: 'turn.completed', usage: u }) + '\n';
test('Codex prices cover the routed models and subtract cached input exactly once', () => {
  assert.deepEqual(Object.keys(CODEX_PRICES), [...CODEX_MODELS]);
  for (const model of CODEX_MODELS) {
    const usage = pricedCodexUsage(readCodex(stream({ input_tokens: 1000000, output_tokens: 100000, cached_input_tokens: 800000, cache_write_input_tokens: 50000 }), '{}').usage, model);
    assert.equal(usage.kind, 'known'); if (usage.kind !== 'known') return;
    const p = CODEX_PRICES[model];
    assert.equal(usage.tokens.costUsd, 0.15 * p.input + 0.8 * p.cached + 0.05 * p.write + 0.1 * p.output);
    assert.equal(usage.tokens.costEstimated, true);
    assert.deepEqual(tokenUsage(usage.tokens, 'tokens'), usage.tokens);
  }
});
test('Codex native cost is preserved and never flagged as estimated', () => {
  const u = pricedCodexUsage(readCodex(stream({ input_tokens: 100, output_tokens: 5, cost_usd: 0.04 }) + stream({ input_tokens: 20, output_tokens: 2, cost_usd: 0.01 }), '{}').usage, 'gpt-5.6-luna');
  assert.equal(u.kind, 'known'); if (u.kind !== 'known') return;
  assert.equal(u.tokens.costUsd, 0.05); assert.equal(u.tokens.costEstimated, undefined); assert.equal(u.tokens.inputTokens, 120);
});
test('Codex partial token usage still produces a meter fact when another completed turn omits usage', () => {
  const reading = readCodex(stream({ input_tokens: 100, output_tokens: 5 }) + JSON.stringify({ type: 'turn.completed' }) + '\n', '{}');
  const usage = pricedCodexUsage(reading.usage, 'gpt-5.6-luna');
  const f = usageFact({ sessionCharge: () => null }, { routingRev: routingRev('0123456789abcdef'), subject: { type: 'smoke', backend: 'codex' } }, invocationIdOf('arc/1#1'), usage, null);
  assert.equal(f.kind, 'meter'); if (f.kind !== 'meter') return;
  assert.equal(f.usage.inputTokens, 100); assert.equal(f.usage.outputTokens, 5); assert.equal(f.usage.costEstimated, true); assert.equal(f.incomplete, 'absent');
});
test('a Codex call without any reported tokens remains explicitly unavailable', () => {
  assert.deepEqual(pricedCodexUsage(readCodex('', null).usage, 'gpt-5.6-luna'), { kind: 'unavailable', reason: 'no-result' });
  assert.throws(() => pricedCodexUsage({ kind: 'unavailable', reason: 'absent' }, 'unpriced-model'), /no price/);
});

test('partial Codex native cost retains tokens in the meter without an estimation flag', () => {
  const usage = pricedCodexUsage(readCodex(stream({ input_tokens: 100, output_tokens: 5, cost_usd: 0.01 }) + JSON.stringify({ type: 'turn.completed' }) + '\n', '{}').usage, 'gpt-5.6-luna');
  const f = usageFact({ sessionCharge: () => null }, { routingRev: routingRev('0123456789abcdef'), subject: { type: 'smoke', backend: 'codex' } }, invocationIdOf('arc/1#1'), usage, null);
  assert.equal(f.kind, 'meter'); if (f.kind !== 'meter') return;
  assert.equal(f.usage.inputTokens, 100); assert.equal(f.usage.costUsd, 0.01); assert.equal(f.usage.costEstimated, undefined); assert.equal(f.incomplete, 'absent');
});
