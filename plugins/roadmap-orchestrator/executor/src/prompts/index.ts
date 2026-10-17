// The prompt table: one decision per (role, model). PromptTable is a mapped type over the closed ModelId
// union, so adding a model fails compilation here until every role names a prompt module, a reviewed
// `inherits`, or `unsupported` (DESIGN-1.0.md §4, Prompt–model coupling; test parse.new-model-fails).
import type { ModelId, PromptSupport, PromptTable, Role } from '../routing/types.ts';
import { PROMPT as BUILD_LUNA } from './build/gpt-5.6-luna.ts';
import { PROMPT as BUILD_OPUS } from './build/claude-opus-5-5.ts';
import { PROMPT as CHECKPOINT_OPUS } from './checkpoint/claude-opus-5-5.ts';
import { PROMPT as FLOW_OPUS } from './flow/claude-opus-5-5.ts';
import { PROMPT as GATE_OPUS } from './gate/claude-opus-5-5.ts';
import type { PromptModule, PromptModules } from './inputs.ts';
import { PROMPT as LENS_OPUS } from './lens/claude-opus-5-5.ts';
import { PROMPT as PACK_REVIEW_OPUS } from './packReview/claude-opus-5-5.ts';
import { PROMPT as PLAN_CHECK_OPUS } from './planCheck/claude-opus-5-5.ts';

/** Every Codex judgment triple is unsupported in M1 (R21); layers.ts reports it as `codex-judgment`. */
const CODEX_JUDGMENT = 'no read-only Codex judgment profile exists yet (R21)';
/** What a Sonnet judgment seat adds to the Opus module it reads: the line ends its system prompt (`sonnet`). */
export const SONNET_THINK_FIRST = 'Think the problem through before you answer.';

/**
 * The Sonnet 5.5 module of a judgment role: the role's Opus module with SONNET_THINK_FIRST at the end of its system prompt.
 * Sonnet 5.5 judges on the efficient class (owner ruling 2026-10-15) at effort `high` (classes.ts), and every judgment
 * answers a schema-bound structured output after a few steps of working out. Anthropic's "Prompting Claude Sonnet 5.5"
 * (Reasoning tasks with JSON output, 2026-10-16): on such tasks the model often answers without thinking first; with
 * structured outputs it can work the problem out only in its thinking, and this line at the end of the system prompt makes
 * it think first more often, bringing `high` close to `xhigh` accuracy for a modest increase in output tokens. The rest of
 * the Opus module carries over unchanged (the guide: prompts written for the Claude 5 line perform well). Sonnet's build
 * seat is agentic coding, not a JSON reasoning task, and inherits the Opus brief instead.
 */
function sonnet<M extends Readonly<{ system: string }>>(opus: M): { readonly type: 'prompt'; readonly prompt: M } {
  return { type: 'prompt', prompt: { ...opus, system: `${opus.system}\n\n${SONNET_THINK_FIRST}` } };
}

/** What a Haiku judgment seat adds to the Opus module it reads: these lines end its system prompt (`haiku`). */
export const HAIKU_FINISH = [
  'Keep working until every part of what you were asked to judge has been read and judged; do not answer before then.',
  'Once it has, give your one answer and stop. Judge what you were asked to judge, nothing beyond it.',
  'Report as read only what you actually read.',
].join(' ');

/**
 * The Haiku 5.5 module of a judgment role: the role's Opus module with HAIKU_FINISH at the end of its system prompt, so
 * every edit to the shared Opus text reaches the Haiku seat unchanged. Haiku 5.5 judges on the economy class (owner
 * direction 2026-10-17: the low-risk gate) at effort `high` (classes.ts). Anthropic's "Prompting Claude Haiku 5.5"
 * (2026-10-17): with a long agent system prompt the model sometimes stops before the work is done; its suggested text
 * ("keep working until everything the user asked for is done ... when the work is done and checked, stop and report;
 * don't add what wasn't asked for") is adapted here to a read-only reviewer, whose work is reading and judging every
 * part of the change and whose report is the one structured answer. The last line answers what the 2026-10-17 gate eval
 * saw: a Haiku reviewer claimed every file of a chunk read when its trace showed six unread. The guide's JSON-output line
 * applies with thinking off only; Claude Code runs the seat with thinking on, so it is left out. Sonnet's think-first line
 * is Sonnet's guide's, not Haiku's.
 */
function haiku<M extends Readonly<{ system: string }>>(opus: M): { readonly type: 'prompt'; readonly prompt: M } {
  return { type: 'prompt', prompt: { ...opus, system: `${opus.system}\n\n${HAIKU_FINISH}` } };
}

/** Fable 5.1 holds no built-in seat (a repo rebind reaches it) and reads each judgment role's Opus module unchanged. */
const fableJudgment = (module: string) => ({
  type: 'inherits',
  from: 'claude-opus-5-5',
  reviewed: `2026-10-16: Prompting Claude Fable 5.1 (Anthropic) checked against the ${module}; no Fable-specific change needed, and no built-in seat routes Fable`,
}) as const;

export const PROMPTS: PromptTable<PromptModules> = {
  planCheck: {
    'claude-opus-5-5': { type: 'prompt', prompt: PLAN_CHECK_OPUS },
    'claude-fable-5-1': fableJudgment('Opus 5.5 plan-check prompt (both shapes, scope growth, the escalation preface)'),
    'claude-sonnet-5-5': sonnet(PLAN_CHECK_OPUS),
    'claude-haiku-5-5': haiku(PLAN_CHECK_OPUS),
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  build: {
    'claude-opus-5-5': { type: 'prompt', prompt: BUILD_OPUS },
    // No built-in seat routes Fable to build; write a Fable-native module before a layer may.
    // economy, Haiku's class, is judgment-only (classes.ts): no build seat can name it.
    'claude-haiku-5-5': { type: 'unsupported', reason: 'Haiku 5.5 holds no build seat: its class, economy, is judgment-only' },
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
    'claude-fable-5-1': fableJudgment('Opus 5.5 gate prompt (the bounded diff, the escalation preface)'),
    'claude-sonnet-5-5': sonnet(GATE_OPUS),
    'claude-haiku-5-5': haiku(GATE_OPUS),
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  // The arc roles (M3). The built-in seats put the lenses on efficient (Sonnet) and the checkpoint on summit (Opus)
  // under both profiles; a plan's `route` or a class rebind can seat either role on another Claude model. Every judgment
  // role has a Sonnet and a Haiku row, so `route` may seat the efficient class at any seat and economy at any judgment seat.
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
    'claude-sonnet-5-5': sonnet(LENS_OPUS),
    'claude-haiku-5-5': haiku(LENS_OPUS),
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  checkpoint: {
    'claude-opus-5-5': { type: 'prompt', prompt: CHECKPOINT_OPUS },
    // Written for Fable first (2026-09-30), so its Fable-specific lines (finish the whole weighing, plain prose, ops held
    // to what the clauses demand) are already in it.
    'claude-fable-5-1': fableJudgment('Opus 5.5 checkpoint prompt (first written for Fable 5.1)'),
    'claude-sonnet-5-5': sonnet(CHECKPOINT_OPUS),
    'claude-haiku-5-5': haiku(CHECKPOINT_OPUS),
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
    'claude-sonnet-5-5': sonnet(PACK_REVIEW_OPUS),
    'claude-haiku-5-5': haiku(PACK_REVIEW_OPUS),
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  // M4b: the flow role (on efficient, Sonnet, since 2026-10-15), its rows mirroring packReview's. Fable reads the Opus flow prompt unchanged, as
  // it reads the pack review's: its rules (the whole method in order, plain literal sentences, the ruler and the lever
  // shapes as the only scope, change nothing, one report) are what the Fable guide asks of a judgment.
  flow: {
    'claude-opus-5-5': { type: 'prompt', prompt: FLOW_OPUS },
    'claude-fable-5-1': {
      type: 'inherits',
      from: 'claude-opus-5-5',
      reviewed: '2026-10-08: Prompting Claude Fable 5.1 (Anthropic) checked against the Opus 5.5 flow prompt (the five focusing steps, no tampering, the ruler out of reach, the lever catalogue with code\'s checks); no Fable-specific change needed',
    },
    'claude-sonnet-5-5': sonnet(FLOW_OPUS),
    'claude-haiku-5-5': haiku(FLOW_OPUS),
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
