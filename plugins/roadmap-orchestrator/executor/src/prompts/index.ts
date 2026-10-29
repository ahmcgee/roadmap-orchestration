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
import { PROMPT as POLISH_JUDGE_OPUS } from './polishJudge/claude-opus-5-5.ts';
import { PROMPT as WALKTHROUGH_OPUS } from './walkthrough/claude-opus-5-5.ts';
import { PROMPT as VERIFIER_HAIKU } from './verifier/claude-haiku-5-5.ts';
import { PROMPT as SCAFFOLD_HAIKU } from './scaffold/claude-haiku-5-5.ts';
import { POC_PROMPT } from './poc/claude-opus-5-5.ts';
import type { PocInputs } from './inputs.ts';
import { promptBytes } from '../backends/argv.ts';
import { canonicalJson } from '../core/json.ts';
import type { JsonValue } from '../core/json.ts';

/** Every Codex judgment triple is unsupported in M1 (R21); layers.ts reports it as `codex-judgment`. */
const CODEX_JUDGMENT = 'no read-only Codex judgment profile exists yet (R21)';
/**
 * What a Sonnet judgment seat adds to the Opus module it reads: the line ends its system prompt (`sonnet`). Verbatim from
 * "Prompting Claude Sonnet 5.5", Reasoning tasks with JSON output (re-checked 2026-10-17): with structured outputs and
 * adaptive thinking the model often answers without thinking at low and medium effort; the line makes it think first
 * (at high, the judgment effort, it brings accuracy close to xhigh's).
 */
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
const HAIKU_FINISH = [
  'Keep working until every part of what you were asked to judge has been read and judged; do not answer before then.',
  'Once it has, give your one answer and stop. Judge what you were asked to judge, nothing beyond it.',
  'Report as read only what you actually read.',
].join(' ');

/**
 * The Haiku 5.5 module of a judgment role: the role's Opus module with HAIKU_FINISH at the end of its system prompt, so
 * every edit to the shared Opus text reaches the Haiku seat unchanged. Haiku 5.5 judges on the economy class at effort
 * `high` (classes.ts), which no built-in seat names since the 2026-10-17 gate eval (kept for a retry at the low-risk gate). Anthropic's "Prompting Claude Haiku 5.5"
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

/** dev.17: why the verifier's other Claude rows read the Haiku module. */
const VERIFIER_INHERITS = '2026-10-23: the Haiku 5.5 verifier module (a closed per-hunk classification, no model-specific method) read unchanged; no built-in seat routes this model to the verifier, so its role eval has not run on it';

/** dev.13: why a walk role has no prompt on a model. */
const WALK_OPUS_ONLY = 'the walk roles have Opus 5.5 modules only: the Sonnet and Haiku guides carry no design guidance (dev.13 plan §6)';
const WALK_CODEX = 'Codex has no walkthrough prompt and no acting-judge profile';

/** dev.17: why the scaffold role has no prompt on a model other than Haiku 5.5. */
const SCAFFOLD_HAIKU_ONLY = 'the scaffold role has a Haiku 5.5 module only (economy, its built-in class)';

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
  // dev.13: the walk roles, on frontier (Opus 5.5). Only Opus modules are written (plan §6): the Sonnet and Haiku guides
  // carry no design guidance. A role's Fable row becomes a dated `inherits` once its Opus module is written and
  // reviewed against the Fable guide. Codex has no walkthrough prompt, so `unsupportedSeats` refuses a Codex rebind.
  walkthrough: {
    'claude-opus-5-5': { type: 'prompt', prompt: WALKTHROUGH_OPUS },
    // Fable reads the Opus walkthrough module unchanged: what its guide asks of a long autonomous task (finish the whole
    // task, check the last paragraph, no stop to ask) is the module's <working_unattended> and <how_your_session_ends>, and
    // its vision advice (crop and zoom tools) is the module's <seeing>.
    'claude-fable-5-1': {
      type: 'inherits',
      from: 'claude-opus-5-5',
      reviewed: '2026-10-18: Prompting Claude Fable 5.1 (Anthropic) checked against the Opus 5.5 walkthrough prompt (unattended to the final report, crops and zoom for dense screens, the rubric lenses, the classes and polish units); no Fable-specific change needed, and no built-in seat routes Fable',
    },
    'claude-sonnet-5-5': { type: 'unsupported', reason: WALK_OPUS_ONLY },
    'claude-haiku-5-5': { type: 'unsupported', reason: WALK_OPUS_ONLY },
    'gpt-5.6-luna': { type: 'unsupported', reason: WALK_CODEX },
    'gpt-5.6-sol': { type: 'unsupported', reason: WALK_CODEX },
  },
  polishJudge: {
    'claude-opus-5-5': { type: 'prompt', prompt: POLISH_JUDGE_OPUS },
    // Fable reads the Opus polish judge module unchanged, as it does the walkthrough's: unattended to the final answer, the
    // last-paragraph check, crops and zoom for the side-by-side captures.
    'claude-fable-5-1': {
      type: 'inherits',
      from: 'claude-opus-5-5',
      reviewed: '2026-10-18: Prompting Claude Fable 5.1 (Anthropic) checked against the Opus 5.5 polish judge prompt (unattended to the final decision, side-by-side captures with crops and zoom, keep only on an improvement on the proposal\'s terms and the reference); no Fable-specific change needed, and no built-in seat routes Fable',
    },
    'claude-sonnet-5-5': { type: 'unsupported', reason: WALK_OPUS_ONLY },
    'claude-haiku-5-5': { type: 'unsupported', reason: WALK_OPUS_ONLY },
    'gpt-5.6-luna': { type: 'unsupported', reason: WALK_CODEX },
    'gpt-5.6-sol': { type: 'unsupported', reason: WALK_CODEX },
  },
  // dev.17 (proportional review): the docs-only verifier on economy (Haiku 5.5). Its one written module is Haiku's; like every
  // judgment role it has a row on each Claude model, so `route` may seat any class at its seats. The others read the Haiku
  // module unchanged: the task is a closed per-hunk classification whose text holds nothing Haiku-specific but the completion
  // lines, which the other models need no less.
  verifier: {
    'claude-haiku-5-5': { type: 'prompt', prompt: VERIFIER_HAIKU },
    'claude-opus-5-5': { type: 'inherits', from: 'claude-haiku-5-5', reviewed: VERIFIER_INHERITS },
    'claude-fable-5-1': { type: 'inherits', from: 'claude-haiku-5-5', reviewed: VERIFIER_INHERITS },
    'claude-sonnet-5-5': { type: 'inherits', from: 'claude-haiku-5-5', reviewed: VERIFIER_INHERITS },
    'gpt-5.6-luna': { type: 'unsupported', reason: CODEX_JUDGMENT },
    'gpt-5.6-sol': { type: 'unsupported', reason: CODEX_JUDGMENT },
  },
  // dev.17 (design pass): the scaffold writer, on economy (Haiku 5.5 high) in the built-in seats. Only a Haiku module is
  // written; a rebind of its seat to another model is refused at startup until that model's module is written and reviewed.
  scaffold: {
    'claude-haiku-5-5': { type: 'prompt', prompt: SCAFFOLD_HAIKU },
    'claude-opus-5-5': { type: 'unsupported', reason: SCAFFOLD_HAIKU_ONLY },
    'claude-sonnet-5-5': { type: 'unsupported', reason: SCAFFOLD_HAIKU_ONLY },
    'claude-fable-5-1': { type: 'unsupported', reason: SCAFFOLD_HAIKU_ONLY },
    'gpt-5.6-luna': { type: 'unsupported', reason: 'the scaffold writer is Claude only (a fresh Claude session in the unit worktree)' },
    'gpt-5.6-sol': { type: 'unsupported', reason: 'the scaffold writer is Claude only (a fresh Claude session in the unit worktree)' },
  },
};

/**
 * dev.17 (design pass): the proof-of-concept brief the builder seat runs (src/pipeline/poc.ts). Not a role: the seat is
 * build's, so its table follows build's models. One module, task-only text (the job, the unattended-run rule, the answer),
 * written to the Opus 5.5 guide; Codex takes it with its system text leading stdin, as it takes every brief.
 */
export type PocModule = Readonly<{ fields: readonly (keyof PocInputs)[]; system: string; render: (inputs: PocInputs) => string; schema: JsonValue }>;
export const POC_PROMPTS: { readonly [M in ModelId]: PromptSupport<PocModule> } = {
  'claude-opus-5-5': { type: 'prompt', prompt: POC_PROMPT },
  'claude-sonnet-5-5': {
    type: 'inherits', from: 'claude-opus-5-5',
    reviewed: '2026-10-23: carried over as the Sonnet build seat carries the Opus build brief (task-only text, the unattended-run rule, one closed answer; no Sonnet-specific text); unmeasured until a PoC eval (BACKLOG)',
  },
  'gpt-5.6-luna': {
    type: 'inherits', from: 'claude-opus-5-5',
    reviewed: '2026-10-23: the PoC brief is task-only text with no model-specific steering; the Codex builder reads it as its build brief is read (system text leading stdin)',
  },
  'gpt-5.6-sol': { type: 'inherits', from: 'gpt-5.6-luna', reviewed: '2026-10-23: GPT-5.6 tiers share one prompt skeleton, as for the build brief' },
  'claude-haiku-5-5': { type: 'unsupported', reason: 'Haiku 5.5 holds no build seat: its class, economy, is judgment-only' },
  'claude-fable-5-1': { type: 'unsupported', reason: 'no build prompt written for Fable; no built-in seat uses it' },
};

/** The PoC module a builder seat runs, following `inherits`; a seat the build table refuses is refused here too. */
export function pocPromptFor(model: ModelId): PocModule {
  const s = POC_PROMPTS[model];
  switch (s.type) {
    case 'prompt':
      return s.prompt;
    case 'inherits':
      return pocPromptFor(s.from);
    case 'unsupported':
      throw new UnsupportedPromptError('build', model, s.reason);
  }
}

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

/** Exact UTF-8 stdin size and, per module input, canonical JSON bytes (an approximation of its rendered section). */
export type PromptSize = Readonly<{ bytes: number; inputs: Readonly<Record<string, number>> }>;
export function promptSize<I>(module: Readonly<{ fields: readonly (keyof I & string)[] }>, inputs: I, stdin: string): PromptSize {
  return { bytes: Buffer.byteLength(stdin, 'utf8'), inputs: Object.fromEntries(module.fields.map((field) => [field, Buffer.byteLength(canonicalJson(inputs[field]), 'utf8')])) };
}

/** Render and measure together. Codex build stdin includes the system text (`backends/argv.ts`, promptBytes). */
export function renderPrompt<I>(module: Readonly<{ system: string; fields: readonly (keyof I & string)[]; render: (inputs: I) => string }>, inputs: I, backend: 'claude' | 'codex' = 'claude'): Readonly<{ rendered: string; prompt: PromptSize }> {
  const rendered = module.render(inputs);
  return { rendered, prompt: promptSize(module, inputs, promptBytes({ kind: backend === 'codex' ? 'codex-build' : 'claude-build', system: module.system }, rendered)) };
}
