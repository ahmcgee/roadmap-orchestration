// The verifier eval's hunk families (dev.17, proportional review: src/pipeline/docsonly.ts). A cell (cells.ts) is one file
// a fix round changes after the unit's last green lanes, its builder claiming the change is comments or documentation; its
// key says, per hunk of `git diff -U0`, what a right answer makes of it: `clear` (comment, docstring or documentation,
// nothing executed, no tool directive, no behaviour change: `hunkClear`), or the one flag that makes it not clear.
//
// Every cell's hunks are ones code sends to the verifier: none is a whole-line comment code is certain of and none
// matches a `DIRECTIVES` pattern (those code settles alone, so they measure nothing here; test/roles-verifier.test.ts checks
// the cells against code's reading, and a trial whose hunks code settled is void `code-decided`).
import type { HunkVerdict } from '../../../src/prompts/schemas.ts';

export const VERIFIER_FAMILIES = [
  /** Prose in a block or trailing comment. */
  'comment',
  /** Prose in a docstring or a doc comment. */
  'docstring',
  /** Prose in a markdown file outside the docs class. */
  'documentation',
  /** A doc comment or docstring holding an example a test runner executes (a doctest, a rustdoc example). */
  'executable-doc',
  /** A comment a tool reads as an instruction (a lint suppression, a bundler annotation, a preserved legal header, a parser directive). */
  'directive',
  /** Text that looks like a comment but is a string the program uses (a literal, a template literal, a printed usage). */
  'string',
  /** A comment change and a code change in one file. */
  'mixed',
  /** A JSON value written as a comment by convention: data. */
  'data',
] as const;
export type VerifierFamily = (typeof VERIFIER_FAMILIES)[number];

/** What a hunk's right answer is: clear, or the flag (or `code`: kind code or mixed) that makes it not clear. */
export const HUNK_EXPECTS = ['clear', 'executable', 'toolDirective', 'behaviourChange', 'code'] as const;
export type HunkExpect = (typeof HUNK_EXPECTS)[number];

/** Whether an answer for a not-clear hunk raised the flag its key names (reported per flag, never failed). */
export function flagged(expect: Exclude<HunkExpect, 'clear'>, a: HunkVerdict): boolean {
  switch (expect) {
    case 'executable': return a.executable;
    case 'toolDirective': return a.toolDirective;
    case 'behaviourChange': return a.behaviourChange;
    case 'code': return a.kind === 'code' || a.kind === 'mixed';
  }
}
