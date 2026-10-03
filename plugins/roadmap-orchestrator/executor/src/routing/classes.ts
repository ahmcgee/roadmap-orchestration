// The class catalogue (DESIGN-1.0.md §4, Routing profiles): the one place in code that binds a model to a
// seat. Seats name classes (profiles.ts, every routing layer); `resolveRouting` (layers.ts) binds each class
// through the arc's profile here, unless the repo's `.roadmap/config.json` rebinds it (`routing.classes`).
// A profile is a set of bindings: `default` puts the efficient class on Codex, `claude-only` on Claude, so
// with the built-in bindings `claude-only` has no Codex dependency. A binding carries its effort, so a
// different effort would be a different class.
//
// Owner ruling OR-Q17 (M4a): frontier = Opus 5.5 at `medium`, summit = Opus 5.5 at `xhigh`, in both profiles.
// Anthropic's Opus 5.5 effort guidance: `medium` is the model's own default (one level below Opus 5's `high`), and
// `xhigh` is the level for the hardest coding and agentic work, which is where a judgment escalates to summit.
// Owner ruling OR-L3: there are no routing generations; this catalogue applies retroactively to every plan revision,
// adopted 1.0.0-dev.6 arcs included (their frontier was Opus `high` and summit Fable 5.1 `high`; src/core/upgrade.ts
// `DEV6_CLASS_CATALOGUE` keeps that only to alias their recorded revs in `status`). Fable 5.1 keeps its model entry
// and prompt modules and is reached only by a repo rebind. Sonnet 5.5 binds `medium`, Anthropic's starting point
// for agentic coding on its recalibrated levels (at `low` it may report a change done without running a check).
// GPT-5.6 Sol has no class of its own: it stays in the model catalogue (models.ts) and is reached by rebinding a class.
import type { ModelClass, ProfileName, Triple } from './types.ts';

/** A complete catalogue: every profile binds every class. */
export type ClassCatalogue = { readonly [P in ProfileName]: { readonly [C in ModelClass]: Triple } };

const FRONTIER: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' };
const SUMMIT: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' };

export const CLASS_CATALOGUE: ClassCatalogue = {
  default: { efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }, frontier: FRONTIER, summit: SUMMIT },
  'claude-only': { efficient: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, frontier: FRONTIER, summit: SUMMIT },
};
