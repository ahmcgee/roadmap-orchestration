// The prompt table: one decision per (role, model). PromptTable is a mapped type over the closed ModelId
// union, so adding a model fails compilation here until every role names a prompt module, a reviewed
// `inherits`, or `unsupported` (DESIGN-1.0.md §4, Prompt–model coupling; test parse.new-model-fails).
import type { ModelId, PromptSupport, PromptTable, Role } from '../routing/types.ts';
import { PROMPT as BUILD_LUNA } from './build/gpt-5.6-luna.ts';
import { PROMPT as BUILD_OPUS } from './build/claude-opus-5-5.ts';
import { PROMPT as CHECKPOINT_FABLE } from './checkpoint/claude-fable-5-1.ts';
import { PROMPT as GATE_FABLE } from './gate/claude-fable-5-1.ts';
import { PROMPT as GATE_OPUS } from './gate/claude-opus-5-5.ts';
import type { PromptModule, PromptModules } from './inputs.ts';
import { PROMPT as LENS_OPUS } from './lens/claude-opus-5-5.ts';
import { PROMPT as PACK_REVIEW_OPUS } from './packReview/claude-opus-5-5.ts';
import { PROMPT as PLAN_CHECK_FABLE } from './planCheck/claude-fable-5-1.ts';
import { PROMPT as PLAN_CHECK_OPUS } from './planCheck/claude-opus-5-5.ts';

/** Every Codex judgment triple is unsupported in M1 (R21); layers.ts reports it as `codex-judgment`. */
const CODEX_JUDGMENT = 'no read-only Codex judgment profile exists yet (R21)';
/** Sonnet 5.5 is an implementer class only; write a Sonnet-native judgment module before a layer may seat it. */
const SONNET_JUDGMENT = 'no judgment prompt written for Sonnet 5.5; no built-in seat uses it';

export const PROMPTS: PromptTable<PromptModules> = {
  planCheck: {
    'claude-opus-5-5': { type: 'prompt', prompt: PLAN_CHECK_OPUS },
    'claude-fable-5-1': { type: 'prompt', prompt: PLAN_CHECK_FABLE },
    'claude-sonnet-5-5': { type: 'unsupported', reason: SONNET_JUDGMENT },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  build: {
    'claude-opus-5-5': { type: 'prompt', prompt: BUILD_OPUS },
    // No built-in seat routes Fable to build; write a Fable-native module before a layer may.
    'claude-fable-5-1': { type: 'unsupported', reason: 'no build prompt written for Fable; no built-in seat uses it' },
    // The Claude implementer brief carries over. Anthropic's Sonnet 5.5 guidance: prompts written for the
    // Claude 5 line perform well unchanged; the shifts it names are covered by the Opus brief as written
    // (it mandates running the fast lanes after the last change, the check a low-effort Sonnet may skip,
    // and has no tool-discouraging or anti-laziness text to remove). Seated at effort medium (classes.ts).
    'claude-sonnet-5-5': {
      type: 'inherits',
      from: 'claude-opus-5-5',
      reviewed: '2026-10-06: Sonnet 5.5 migration guidance (Anthropic) checked against the Opus 5.5 build brief with its unattended-run instruction (M4a) and its witness checklist, witness check commands and in-session assessment (M4a rev 3); no Sonnet-specific change needed',
    },
    'gpt-5.6-luna': { type: 'prompt', prompt: BUILD_LUNA },
    // OpenAI's GPT-5.6 guidance gives Sol, Terra and Luna one prompt skeleton: the tiers differ in cost,
    // latency and reasoning depth, not in how a prompt is structured. Sol's build prompt is Luna's.
    'gpt-5.6-sol': {
      type: 'inherits',
      from: 'gpt-5.6-luna',
      reviewed: '2026-10-06: GPT-5.6 tiers share one prompt skeleton (OpenAI model guidance), checked again against the Luna build prompt with its M4a rev 3 witness checks and in-session assessment; no Sol-specific build behaviour known',
    },
  },
  gate: {
    'claude-opus-5-5': { type: 'prompt', prompt: GATE_OPUS },
    'claude-fable-5-1': { type: 'prompt', prompt: GATE_FABLE },
    'claude-sonnet-5-5': { type: 'unsupported', reason: SONNET_JUDGMENT },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  // The arc roles (M3). The built-in seats put the lenses on frontier (Opus) and the checkpoint on summit (Fable)
  // under both profiles; a plan's `route` or a class rebind can seat either role on the other model.
  lens: {
    'claude-opus-5-5': { type: 'prompt', prompt: LENS_OPUS },
    // Fable reads the Opus lens brief unchanged: the rules a Fable-native judgment adds (finish the whole task,
    // open what you recognise, plain literal prose, no scope widening) are already in it as the audit's own rules
    // (every obligation checked, file:line evidence, one-sentence claims, the lens brief as the only scope).
    'claude-fable-5-1': {
      type: 'inherits',
      from: 'claude-opus-5-5',
      reviewed: '2026-10-06: Prompting Claude Fable 5.1 (Anthropic) checked against the Opus 5.5 lens prompt with its M4a rev 3 cause shape and specs-only drift; no Fable-specific change needed',
    },
    'claude-sonnet-5-5': { type: 'unsupported', reason: SONNET_JUDGMENT },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  checkpoint: {
    // Opus reads the Fable checkpoint prompt unchanged: its structure (role and authority up front, the inputs
    // before the ask, no reasoning field) is what the Opus 5.5 guide asks for, and its Fable-specific lines
    // (finish the whole weighing, plain prose, ops held to what the clauses demand) cost Opus nothing.
    'claude-opus-5-5': {
      type: 'inherits',
      from: 'claude-fable-5-1',
      reviewed: '2026-10-06: Prompting Claude Opus 5.5 (Anthropic) checked against the Fable 5.1 checkpoint prompt with its M4a corpus amendments and issue intake and its rev 3 admit classes, failure matrix, input manifest, embedded specs and closeout; no Opus-specific change needed',
    },
    'claude-fable-5-1': { type: 'prompt', prompt: CHECKPOINT_FABLE },
    'claude-sonnet-5-5': { type: 'unsupported', reason: SONNET_JUDGMENT },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  // M4a (OR-Q16): the pack review on frontier (Opus), ported from the former Phase-0 review brief. Fable reads it
  // unchanged, as it reads the Opus lens prompt: its rules (read everything before judging, file:line evidence, plain
  // one-sentence claims, the pack as the only scope, change nothing) are what the Fable guide asks of a judgment.
  packReview: {
    'claude-opus-5-5': { type: 'prompt', prompt: PACK_REVIEW_OPUS },
    'claude-fable-5-1': {
      type: 'inherits',
      from: 'claude-opus-5-5',
      reviewed: '2026-10-06: Prompting Claude Fable 5.1 (Anthropic) checked against the Opus 5.5 pack-review prompt with its M4a rev 3 census cross-check and time-fixture and entry-point checks; no Fable-specific change needed',
    },
    'claude-sonnet-5-5': { type: 'unsupported', reason: SONNET_JUDGMENT },
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
