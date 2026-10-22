// The class catalogue (DESIGN-1.0.md §4, Routing profiles): the one place in code that binds a model to a
// seat. Seats name classes (profiles.ts, every routing layer); `resolveRouting` (layers.ts) binds each class
// through the arc's profile here, unless the repo's `.roadmap/config.json` rebinds it (`routing.classes`).
// A profile is a set of bindings: `default` puts the efficient class's builds on Codex, `claude-only` on Claude, so
// with the built-in bindings `claude-only` has no Codex dependency. A binding carries its effort, so a
// different effort would be a different class.
//
// A build class binds twice: the triple its build seats run on and the triple its judgment seats (every role but `build`)
// run on. A judgment binding is a Claude triple by type: no read-only Codex judgment profile exists (R21). Owner
// ruling 2026-10-15: the efficient class judges on Sonnet 5.5 at `high` in both profiles (it holds the low-risk
// plan-check seats, the med gate, the lenses and the flow seat, profiles.ts); its builds stay Luna `medium` under `default`
// and Sonnet 5.5 `medium` under `claude-only`, Anthropic's starting point for agentic coding on Sonnet's recalibrated
// levels (at `low` it may report a change done without running a check). frontier and summit bind one triple for both.
//
// Owner ruling OR-Q17 (M4a): frontier = Opus 5.5 at `medium`, summit = Opus 5.5 at `xhigh`, in both profiles.
// Anthropic's Opus 5.5 effort guidance: `medium` is the model's own default, and
// `xhigh` is the level for the hardest coding and agentic work, which is where a judgment escalates to summit.
//
// economy (owner direction 2026-10-17, 1.0.0-dev.12): a judgment-only class, Haiku 5.5. It held the low-risk gate until the
// paid gate role eval (2026-10-17) failed it there (clean-cell false alarms); no built-in seat names it now, and it is kept,
// reachable by a repo, plan or route rebind or seat assignment, for a retry (BACKLOG "Haiku at the low-risk gate: retry"). It binds
// no build triple (`JudgmentClassBinding`), and a build seat names a `BuildClass` by type. Effort `high`: Anthropic's
// "Prompting Claude Haiku 5.5" names `high` for "knowledge work, longer agent tasks, and strict instruction following"
// and warns that at `low`, in long agent prompts, the model is more likely to skip a search, stop early or skip a check.
// A gate is a long read-heavy session ending in a strict schema-bound verdict, so it takes `high` over the `medium` default.
// Our 2026-10-17 experiment ran Haiku 5.5 at `medium` on a narrower task, a closed checklist of 290 files: 6/6 plants caught,
// 0 false alarms, ~$0.45 a chunk, but one run claimed 290/290 files read when its trace showed 284. The open gate session
// is longer and less guided than that chunk, which is where the guide places `high`. The eval ran Haiku on the low seat at
// `high` (4/12 clean-cell false alarms) and `medium` (1/9); a retry rebinds a seat's class to it (`--rebind`).
//
// Owner ruling OR-L3: there are no routing generations; this catalogue applies retroactively to every plan revision.
// Fable 5.1 keeps its model entry and prompt modules and is reached only by a repo rebind. GPT-5.6 Sol has no class of
// its own: it stays in the model catalogue (models.ts) and is reached by rebinding a class.
import type { ClaudeTriple } from '../backends/argv.ts';
import type { BuildClass, ClaudeModelId, ModelClass, ProfileName, Role, Triple } from './types.ts';

/** What a build class binds: the triple at its build seats and the Claude triple at its judgment seats. */
export type BuildClassBinding = Readonly<{ build: Triple; judgment: ClaudeTriple }>;
/** What a judgment-only class binds: the Claude triple at its judgment seats; no build seat can name it. */
export type JudgmentClassBinding = Readonly<{ judgment: ClaudeTriple }>;
export type ClassBinding<C extends ModelClass> = C extends BuildClass ? BuildClassBinding : JudgmentClassBinding;

/** A complete catalogue: every profile binds every class. */
export type ClassCatalogue = { readonly [P in ProfileName]: { readonly [C in ModelClass]: ClassBinding<C> } };

const FRONTIER: ClaudeTriple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const SUMMIT: ClaudeTriple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' };
const EFFICIENT_JUDGMENT: ClaudeTriple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' };
const ECONOMY: JudgmentClassBinding = { judgment: { backend: 'claude', model: 'claude-haiku-5-5', effort: 'high' } };
const both = (t: ClaudeTriple): BuildClassBinding => ({ build: t, judgment: t });

export const CLASS_CATALOGUE: ClassCatalogue = {
  default: {
    efficient: { build: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }, judgment: EFFICIENT_JUDGMENT },
    frontier: both(FRONTIER),
    summit: both(SUMMIT),
    economy: ECONOMY,
  },
  'claude-only': {
    efficient: { build: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, judgment: EFFICIENT_JUDGMENT },
    frontier: both(FRONTIER),
    summit: both(SUMMIT),
    economy: ECONOMY,
  },
};

/**
 * dev.17 (owner 2026-10-22): the advisor every Claude build consults (`claude --advisor <model>`, backends/argv.ts), Opus 5.5.
 * The builder (Sonnet 5.5 under `claude-only`) decides when to call it: before committing to an approach, on a recurring
 * error, before declaring done (https://code.claude.com/docs/en/advisor). The pinned id, not the `opus` alias, so a CLI
 * release cannot move it. Not a class binding: it rides on whatever Claude triple a build seat binds (a Fable or weaker-ranked
 * main model runs without it, the CLI's own pairing rule). Its spend appears in the call's `modelUsage` under its own id, so
 * the meter counts it as delegated to the model's family class (`DELEGATE_CLASSES`: frontier), never to the seat's class
 * (verified on Claude Code 2.1.301, 2026-10-22, test/fixtures/backend-output/claude-build-advisor). The advisor is off when
 * feature-flag fetching is (DISABLE_TELEMETRY); evals/probe.ts `claude.build.advisor` checks it is consulted.
 */
export const BUILD_ADVISOR: ClaudeModelId = 'claude-opus-5-5';

/**
 * The triple `profile` binds `c` to at a seat of `role`: its build triple at a build seat, its judgment triple at any other.
 * A build seat naming a judgment-only class is unrepresentable in every layer (`ClassOf`), so reaching one is a bug.
 */
export function boundAt(profile: ProfileName, c: ModelClass, role: Role): Triple {
  const binding: BuildClassBinding | JudgmentClassBinding = CLASS_CATALOGUE[profile][c];
  if (role !== 'build') return binding.judgment;
  if (!('build' in binding)) throw new Error(`a build seat names the ${c} class, which binds no build triple`);
  return binding.build;
}

/**
 * The class a subagent's (or the CLI's own) spend on a model is metered to, by the model's family: Claude model ids are
 * `claude-<family>-<version>`, and a family's tier holds across versions. A session's own model is metered to its seat's
 * class instead (meter.ts), which is why Opus, bound by frontier and summit alike, sits here under one: frontier, the
 * class it binds at its own default effort; Haiku, the economy class it binds. Fable binds no class (a repo rebind reaches it) and is the costliest model a
 * subagent can pick: summit, the strongest class. Static, unlike the bindings: a repo rebind moves seats, not where a
 * subagent's spend is counted. By family, not by id, because the CLI also spends on models of its own choosing with no
 * subagent started (an Opus 5.5 judgment's `modelUsage` named `claude-opus-4-8` beside its own model, Claude Code
 * 2.1.301, the dev.12 probe): dollars are metered exactly either way, and only the class bucket is inferred.
 */
export const DELEGATE_CLASSES = {
  haiku: 'economy',
  sonnet: 'efficient',
  opus: 'frontier',
  fable: 'summit',
} as const satisfies Readonly<Record<string, ModelClass>>;

/** A model `modelUsage` names outside every catalogued family: a CLI or account change the meter must not guess at. */
export class UnknownModelError extends Error {
  constructor(model: string) {
    super(`modelUsage names ${JSON.stringify(model)}, of no family src/routing/classes.ts DELEGATE_CLASSES catalogues; add the family with its class`);
    this.name = 'UnknownModelError';
  }
}

/** The class spend on `model` is metered to, by its family; a model of no catalogued family fails loud. */
export function delegateClass(model: string): ModelClass {
  const family = /^claude-([a-z]+)-\d/.exec(model)?.[1];
  if (family === undefined || !Object.hasOwn(DELEGATE_CLASSES, family)) throw new UnknownModelError(model);
  return DELEGATE_CLASSES[family as keyof typeof DELEGATE_CLASSES];
}
