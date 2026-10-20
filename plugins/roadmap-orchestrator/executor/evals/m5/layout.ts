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
 * The planted defect (answer-key.json `plant`): a data row, not a style. The first book on the shelf's page, the entry of
 * the reservation journey, is free and its condition (in the giver's words, data/shelf.json) ends in a long URL with no
 * break opportunity, and no seed rule wraps it, so at 320 CSS px the page scrolls sideways (WCAG 2.x 1.4.10 Reflow, V-10).
 * Only rendering shows it. The check renders `/` in Chromium at `viewport` px (reflow.ts) and wants the book still listed.
 */
export const PLANT = {
  data: 'data/shelf.json',
  book: 'b1',
  title: 'The Left Hand of Darkness',
  url: 'https://oakstreet.example/wiki/Bookplates_of_Autumn_2019:_Le_Guin_The_Left_Hand_of_Darkness_Gollancz_1969_First_UK_Edition_Signed_Copy',
  viewport: 320,
} as const;

/** The vendored design skill: committed as a project skill so unit worktrees load it (plan §5). */
export const DESIGN_SKILL = { dir: '.claude/skills/frontend-design', files: ['SKILL.md', 'LICENSE.txt', 'LICENSE'] } as const;
