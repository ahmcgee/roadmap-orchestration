// The class catalogue (DESIGN-1.0.md §4, Routing profiles): the one place in code that binds a model to a
// seat. Profiles and every routing layer name classes; `resolveRouting` (layers.ts) binds each class here,
// unless the repo's `.roadmap/config.json` rebinds it (`routing.classes`). A Codex binding carries its
// effort, so a different effort would be a different class. The Claude classes bind effort `high`, the level
// arc 1 ran at (inherited then from the operator's settings; Opus 5.5's own default is `medium`). GPT-5.6 Sol has no class of its own: it stays
// in the model catalogue (models.ts) and is reached by rebinding a class.
import type { ModelClass, Triple } from './types.ts';

export const CLASS_CATALOGUE: { readonly [C in ModelClass]: Triple } = {
  efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
  frontier: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  summit: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' },
};
