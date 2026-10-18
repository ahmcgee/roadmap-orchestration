// The M5 fixture's layout and its fixed names. The directory layout is M4a's (evals/m4a/layout.ts, reused as is: one
// fixture dir outside this repository holding stage/{plugin, product, origin.git, forge, config, roadmap-inputs,
// worktrees}, transcript.jsonl, diagnostics/, costs.jsonl and report.json); `fake/` and `canary.json` stay unused here.
// M5 has no fake root agent and reads no real forge, so it has no canary.
import { fileURLToPath } from 'node:url';

export { type Layout, MAIN, SESSION_END, STOP_REASONS, type StopReason, layout } from '../m4a/layout.ts';

/** The fixture forge's repo identity (no real forge exists for the scratch repo). */
export const FORGE_REPO = { host: 'forge.test', owner: 'oak-street', name: 'swapshelf' } as const;

export const FILES = fileURLToPath(new URL('./files/', import.meta.url));
export const CORPUS_ROOT = 'docs/corpus';
export const VISION_DOC = 'vision.md';

/**
 * The planted defect (answer-key.json `plant`): each book's condition-and-arrival line on the shelf's page, the entry of
 * the reservation journey, is faint (`--ink-faint` on `--paper`, about 2.1:1) in the stylesheet the browser milestone's
 * units build on. The check computes the selector's contrast over every stylesheet the final head tracks.
 */
export const PLANT = { stylesheet: 'public/style.css', selector: '.book-meta', floor: 4.5 } as const;

/** The vendored design skill: committed as a project skill so unit worktrees load it (plan §5). */
export const DESIGN_SKILL = { dir: '.claude/skills/frontend-design', files: ['SKILL.md', 'LICENSE.txt', 'LICENSE'] } as const;
