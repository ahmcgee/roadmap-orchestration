// Rules blocks (M4a, OR-Q12; SCHEMAS.md "M4a"): in a corpus Markdown file other than the vision document, a fenced
// block with info string `rules` holds one rule per line, `T-<n>: <one-line normative claim>`. Prose outside blocks is
// rationale. A rule's section is the nearest preceding ATX heading outside any fence (null when none precedes it).
// Blank lines inside a block are allowed; a malformed line, an empty block, an unclosed block and a duplicate id are
// refused (`CorpusFormatError`). A rules block in the vision document is the row `rules-in-vision` (K17), told by
// `hasRulesBlock`, so no vision text reaches the rules index.
//
// `normalizeText` (trim, collapse whitespace) is the one text normalisation: a rule's `textSha256` hashes it, and
// `debtKey` (src/debt/ledger.ts) normalises a debt item's `what` with it.
import { type RuleId, type Sha256Hex, compareIds, ruleId, sha256 } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import type { RepoPath } from '../core/values.ts';
import { type PinnedRule, RULES_FENCE } from './types.ts';

/** A corpus file or guide that does not parse: loud, never a row (the agent fixes the text and re-runs). */
export class CorpusFormatError extends Error {
  constructor(where: string, what: string) {
    super(`corpus: ${where}: ${what}`);
    this.name = 'CorpusFormatError';
  }
}

/** Trimmed, every whitespace run collapsed to one space. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export const ruleTextSha256 = (text: string): Sha256Hex => sha256(sha256Hex(normalizeText(text)));

/** A fenced block: its info string (trimmed), body lines, 1-based line of the opening fence, nearest preceding heading. */
export type FencedBlock = Readonly<{ info: string; body: readonly string[]; line: number; section: string | null }>;

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/**
 * Every fenced code block of a Markdown text (CommonMark fences: three or more backticks or tildes, closed by a fence
 * of the same character at least as long). An unclosed block runs to the end of the text; an unclosed rules block is
 * refused.
 */
export function fencedBlocks(text: string, where: string): readonly FencedBlock[] {
  const lines = text.split('\n');
  const out: FencedBlock[] = [];
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = OPEN.exec(line);
    if (open === null) {
      const h = HEADING.exec(line);
      if (h !== null) section = normalizeText(h[2] ?? '');
      continue;
    }
    const fence = open[1]!;
    const info = open[2]!.trim();
    if (fence[0] === '`' && info.includes('`')) continue; // not a fence (CommonMark: a backtick fence's info has none)
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j]!)) body.push(lines[j++]!);
    if (j === lines.length && info === RULES_FENCE) throw new CorpusFormatError(`${where}:${i + 1}`, 'unclosed rules block');
    out.push({ info, body, line: i + 1, section });
    i = j;
  }
  return out;
}

export const hasRulesBlock = (text: string, where: string): boolean => fencedBlocks(text, where).some((b) => b.info === RULES_FENCE);

const RULE_LINE = /^(T-[1-9][0-9]*):[ \t]+(.*\S.*)$/;

/** The rules of one corpus file, in file order; duplicate ids within the file are refused. */
export function parseRules(text: string, file: RepoPath): readonly PinnedRule[] {
  const out: PinnedRule[] = [];
  const seen = new Set<RuleId>();
  for (const block of fencedBlocks(text, file)) {
    if (block.info !== RULES_FENCE) continue;
    let count = 0;
    block.body.forEach((raw, k) => {
      if (raw.trim() === '') return;
      const where = `${file}:${block.line + 1 + k}`;
      const m = RULE_LINE.exec(raw.trim());
      if (m === null) throw new CorpusFormatError(where, `malformed rule line ${JSON.stringify(raw)} (expected "T-<n>: <claim>")`);
      const id = ruleId(m[1], where);
      if (seen.has(id)) throw new CorpusFormatError(where, `duplicate rule id ${id}`);
      seen.add(id);
      const text = normalizeText(m[2]!);
      out.push({ id, textSha256: ruleTextSha256(text), text, file, section: block.section });
      count++;
    });
    if (count === 0) throw new CorpusFormatError(`${file}:${block.line}`, 'empty rules block');
  }
  return out;
}

/** Rules of several files, ascending by number; an id in two files is refused. */
export function collectRules(perFile: readonly (readonly PinnedRule[])[]): readonly PinnedRule[] {
  const byId = new Map<RuleId, PinnedRule>();
  for (const rules of perFile) {
    for (const r of rules) {
      const other = byId.get(r.id);
      if (other !== undefined) throw new CorpusFormatError(r.file, `duplicate rule id ${r.id} (also in ${other.file})`);
      byId.set(r.id, r);
    }
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}
