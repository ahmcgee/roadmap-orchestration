// The class catalogue (DESIGN-1.0.md §4, Routing profiles): the one place in code that binds a model to a
// seat. Seats name classes (profiles.ts, every routing layer); `resolveRouting` (layers.ts) binds each class
// through the arc's profile here, unless the repo's `.roadmap/config.json` rebinds it (`routing.classes`).
// A profile is a set of bindings: `default` puts the efficient class's builds on Codex, `claude-only` on Claude, so
// with the built-in bindings `claude-only` has no Codex dependency. A binding carries its effort, so a
// different effort would be a different class.
//
// A class binds twice: the triple its build seats run on and the triple its judgment seats (every role but `build`)
// run on. A judgment binding is a Claude triple by type: no read-only Codex judgment profile exists (R21). Owner
// ruling 2026-10-15: the efficient class judges on Sonnet 5.5 at `high` in both profiles (it holds the low-risk
// plan-check and gate seats, the lenses and the flow seat, profiles.ts); its builds stay Luna `medium` under `default`
// and Sonnet 5.5 `medium` under `claude-only`, Anthropic's starting point for agentic coding on Sonnet's recalibrated
// levels (at `low` it may report a change done without running a check). frontier and summit bind one triple for both.
//
// Owner ruling OR-Q17 (M4a): frontier = Opus 5.5 at `medium`, summit = Opus 5.5 at `xhigh`, in both profiles.
// Anthropic's Opus 5.5 effort guidance: `medium` is the model's own default (one level below Opus 5's `high`), and
// `xhigh` is the level for the hardest coding and agentic work, which is where a judgment escalates to summit.
// Owner ruling OR-L3: there are no routing generations; this catalogue applies retroactively to every plan revision.
// Fable 5.1 keeps its model entry and prompt modules and is reached only by a repo rebind. GPT-5.6 Sol has no class of
// its own: it stays in the model catalogue (models.ts) and is reached by rebinding a class.
import type { ClaudeTriple } from '../backends/argv.ts';
import type { ModelClass, ProfileName, Role, Triple } from './types.ts';

/** What a class binds: the triple at its build seats and the Claude triple at its judgment seats. */
export type ClassBinding = Readonly<{ build: Triple; judgment: ClaudeTriple }>;

/** A complete catalogue: every profile binds every class. */
export type ClassCatalogue = { readonly [P in ProfileName]: { readonly [C in ModelClass]: ClassBinding } };

const FRONTIER: ClaudeTriple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const SUMMIT: ClaudeTriple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' };
const EFFICIENT_JUDGMENT: ClaudeTriple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' };
const both = (t: ClaudeTriple): ClassBinding => ({ build: t, judgment: t });

export const CLASS_CATALOGUE: ClassCatalogue = {
  default: {
    efficient: { build: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }, judgment: EFFICIENT_JUDGMENT },
    frontier: both(FRONTIER),
    summit: both(SUMMIT),
  },
  'claude-only': {
    efficient: { build: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, judgment: EFFICIENT_JUDGMENT },
    frontier: both(FRONTIER),
    summit: both(SUMMIT),
  },
};

/** The triple `binding` puts at a seat of `role`: its build triple at a build seat, its judgment triple at any other. */
export function boundAt(binding: ClassBinding, role: Role): Triple {
  return role === 'build' ? binding.build : binding.judgment;
}
