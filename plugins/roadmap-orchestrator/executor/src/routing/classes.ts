// The class catalogue (DESIGN-1.0.md §4, Routing profiles): the one place in code that binds a model to a
// seat. Seats name classes (profiles.ts, every routing layer); `resolveRouting` (layers.ts) binds each class
// through the arc's profile here, unless the repo's `.roadmap/config.json` rebinds it (`routing.classes`).
// A profile is a set of bindings: `default` puts the efficient class on Codex, `claude-only` on Claude, so
// with the built-in bindings `claude-only` has no Codex dependency. A binding carries its effort, so a
// different effort would be a different class. Opus and Fable bind effort `high`, the level arc 1 ran at
// (Opus 5.5's own default is `medium`); Sonnet 5.5 binds `medium`, Anthropic's starting point for agentic
// coding on its recalibrated levels (at `low` it may report a change done without running a check). GPT-5.6
// Sol has no class of its own: it stays in the model catalogue (models.ts) and is reached by rebinding a class.
import type { ModelClass, ProfileName, Triple } from './types.ts';

const FRONTIER: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const SUMMIT: Triple = { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' };

export const CLASS_CATALOGUE: { readonly [P in ProfileName]: { readonly [C in ModelClass]: Triple } } = {
  default: { efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }, frontier: FRONTIER, summit: SUMMIT },
  'claude-only': { efficient: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, frontier: FRONTIER, summit: SUMMIT },
};
