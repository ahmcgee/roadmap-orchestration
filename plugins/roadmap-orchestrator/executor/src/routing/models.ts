// The pinned model catalogue (DESIGN-1.0.md §4, Routing profiles). One entry per ModelId, so a model
// added to the union fails compilation here until it is catalogued, and again in src/prompts/index.ts
// until every role has a prompt decision for it. Code, not state: records name roles, never these ids.
import type { ClaudeModelId, CodexEffort, CodexModelId, ModelId, Triple } from './types.ts';

export type ClaudeModel = Readonly<{ backend: 'claude'; displayName: string; efforts: readonly ['default'] }>;
/** Efforts are the ones a routing layer may select; `xhigh` is a CLI value no seat uses in M1. */
export type CodexModel = Readonly<{ backend: 'codex'; displayName: string; efforts: readonly CodexEffort[] }>;

const CODEX_SEAT_EFFORTS = ['low', 'medium', 'high'] as const;

export const MODELS: { readonly [M in ClaudeModelId]: ClaudeModel } & { readonly [M in CodexModelId]: CodexModel } = {
  'claude-opus-5-5': { backend: 'claude', displayName: 'Claude Opus 5.5', efforts: ['default'] },
  'claude-fable-5-1': { backend: 'claude', displayName: 'Claude Fable 5.1', efforts: ['default'] },
  'gpt-5.6-luna': { backend: 'codex', displayName: 'GPT-5.6 Luna', efforts: CODEX_SEAT_EFFORTS },
  'gpt-5.6-sol': { backend: 'codex', displayName: 'GPT-5.6 Sol', efforts: CODEX_SEAT_EFFORTS },
};

export function modelInfo(model: ModelId): ClaudeModel | CodexModel {
  return MODELS[model];
}

/** A triple whose effort the catalogue lists for its model. */
export function effortSupported(triple: Triple): boolean {
  return (modelInfo(triple.model).efforts as readonly string[]).includes(triple.effort);
}
