// The prompt table: one decision per (role, model). PromptTable is a mapped type over the closed ModelId
// union, so adding a model fails compilation here until every role names a prompt module, a reviewed
// `inherits`, or `unsupported` (DESIGN-1.0.md §4, Prompt–model coupling; test parse.new-model-fails).
import type { ModelId, PromptSupport, PromptTable, Role } from '../routing/types.ts';
import { PROMPT as BUILD_LUNA } from './build/gpt-5.6-luna.ts';
import { PROMPT as BUILD_OPUS } from './build/claude-opus-5-5.ts';
import { PROMPT as GATE_FABLE } from './gate/claude-fable-5-1.ts';
import { PROMPT as GATE_OPUS } from './gate/claude-opus-5-5.ts';
import type { PromptModule, PromptModules } from './inputs.ts';
import { PROMPT as PLAN_CHECK_FABLE } from './planCheck/claude-fable-5-1.ts';
import { PROMPT as PLAN_CHECK_OPUS } from './planCheck/claude-opus-5-5.ts';

/** Every Codex judgment triple is unsupported in M1 (R21); layers.ts reports it as `codex-judgment`. */
const CODEX_JUDGMENT = 'no read-only Codex judgment profile exists yet (R21)';

export const PROMPTS: PromptTable<PromptModules> = {
  planCheck: {
    'claude-opus-5-5': { type: 'prompt', prompt: PLAN_CHECK_OPUS },
    'claude-fable-5-1': { type: 'prompt', prompt: PLAN_CHECK_FABLE },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  build: {
    'claude-opus-5-5': { type: 'prompt', prompt: BUILD_OPUS },
    // No built-in seat routes Fable to build; write a Fable-native module before a layer may.
    'claude-fable-5-1': { type: 'unsupported', reason: 'no build prompt written for Fable; no built-in seat uses it' },
    'gpt-5.6-luna': { type: 'prompt', prompt: BUILD_LUNA },
    // OpenAI's GPT-5.6 guidance gives Sol, Terra and Luna one prompt skeleton: the tiers differ in cost,
    // latency and reasoning depth, not in how a prompt is structured. Sol's build prompt is Luna's.
    'gpt-5.6-sol': {
      type: 'inherits',
      from: 'gpt-5.6-luna',
      reviewed: '2026-09-25: GPT-5.6 tiers share one prompt skeleton (OpenAI model guidance); no Sol-specific build behaviour known',
    },
  },
  gate: {
    'claude-opus-5-5': { type: 'prompt', prompt: GATE_OPUS },
    'claude-fable-5-1': { type: 'prompt', prompt: GATE_FABLE },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
};

export class UnsupportedPromptError extends Error {
  readonly role: Role;
  readonly model: ModelId;
  constructor(role: Role, model: ModelId, reason: string) {
    super(`no prompt for ${role} on ${model}: ${reason}`);
    this.name = 'UnsupportedPromptError';
    this.role = role;
    this.model = model;
  }
}

export function support<R extends Role>(role: R, model: ModelId): PromptSupport<PromptModules[R]> {
  return PROMPTS[role][model];
}

/** The module a seat runs, following `inherits`. Throws on `unsupported`: routing validation refuses such seats first. */
export function promptFor<R extends Role>(role: R, model: ModelId): PromptModule<R> {
  const s = support(role, model);
  switch (s.type) {
    case 'prompt':
      return s.prompt;
    case 'inherits':
      return promptFor(role, s.from);
    case 'unsupported':
      throw new UnsupportedPromptError(role, model, s.reason);
  }
}
