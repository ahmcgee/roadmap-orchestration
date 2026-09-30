// Anchor-exact document references and contract ops (DESIGN-1.0.md §2.3 `rule`, §2.6; M3 step A1). Pure: the
// caller hands in the documents' text at the tip.
//
// An anchor names exactly one place in a document:
//   `#<slug>`   a Markdown ATX heading whose slug (lowercase, punctuation dropped, spaces to `-`) is `<slug>`; its
//               section runs to the next heading of the same or a higher level
//   any other   a literal text that occurs on exactly one line; its section runs from that line to the next heading
// Headings inside fenced code blocks are not headings. An anchor matching no place, or more than one, is refused.
//
// A contract op `{path, anchor, oldText, newText}` replaces the one occurrence of `oldText` in its anchor's section.
// The ops of one ruling on one document must not have overlapping sections (their order would matter), and every
// edited document's first line cites the ruling: `<!-- revised by C-3, C-7 -->` (added, or extended).
import type { RulingId } from '../core/ids.ts';
import type { RepoPath } from '../core/values.ts';
import type { ContractOp } from '../holistic/types.ts';

/** A region of a document as character offsets, `start` inclusive, `end` exclusive. */
export type Section = Readonly<{ start: number; end: number }>;

type Line = Readonly<{ start: number; text: string; heading: Readonly<{ level: number; slug: string }> | null }>;

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** GitHub-style heading slug: lowercase, letters, digits, spaces, `-` and `_` kept, spaces to `-`. */
export function headingSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

function linesOf(doc: string): readonly Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  let start = 0;
  for (const text of doc.split('\n')) {
    const f = FENCE.exec(text);
    let heading: Line['heading'] = null;
    if (fence !== null) {
      if (f !== null && f[1]!.startsWith(fence[0]!) && f[1]!.length >= fence.length) fence = null;
    } else if (f !== null) {
      fence = f[1]!;
    } else {
      const h = HEADING.exec(text);
      if (h !== null) heading = { level: h[1]!.length, slug: headingSlug(h[2] ?? '') };
    }
    out.push({ start, text, heading });
    start += text.length + 1;
  }
  return out;
}

/** The section `anchor` names in `doc`, or why it names none (no match, or more than one). */
export function anchorSection(doc: string, anchor: string): Section | string {
  const lines = linesOf(doc);
  const bySlug = anchor.startsWith('#');
  const hits = lines.flatMap((l, i) => ((bySlug ? l.heading?.slug === anchor.slice(1) : l.text.includes(anchor)) ? [i] : []));
  if (hits.length !== 1) return `anchor ${JSON.stringify(anchor)} matches ${hits.length} ${bySlug ? 'headings' : 'lines'} (exactly one needed)`;
  const at = hits[0]!;
  const level = bySlug ? lines[at]!.heading!.level : 6;
  const next = lines.findIndex((l, i) => i > at && l.heading !== null && l.heading.level <= level);
  return { start: lines[at]!.start, end: next === -1 ? doc.length : lines[next]!.start };
}

/** Why `quotedText` is not under `anchor` in `doc`, or null when it is. */
export function quotedTextReason(doc: string, anchor: string, quotedText: string): string | null {
  const section = anchorSection(doc, anchor);
  if (typeof section === 'string') return section;
  return doc.slice(section.start, section.end).includes(quotedText) ? null : `quoted text ${JSON.stringify(quotedText)} is not under anchor ${JSON.stringify(anchor)}`;
}

const REVISED_BY = /^<!-- revised by (C-[0-9]+(?:, C-[0-9]+)*) -->\n/;

/** The document with its first line citing `ruling` (the header added, or the ruling appended to it). */
export function citeRuling(doc: string, ruling: RulingId): string {
  const m = REVISED_BY.exec(doc);
  if (m === null) return `<!-- revised by ${ruling} -->\n${doc}`;
  const ids = m[1]!.split(', ');
  if (ids.includes(ruling)) return doc;
  return `<!-- revised by ${[...ids, ruling].join(', ')} -->\n${doc.slice(m[0].length)}`;
}

export type ContractEdit = Readonly<{ path: RepoPath; text: string }>;

/**
 * Applies one ruling's contract ops to the documents at the tip (`docAt`: a path's text, null when absent). Returns
 * the edited documents ascending by path, or every reason the ops are refused (all or none).
 */
export function applyContractOps(
  ops: readonly ContractOp[], ruling: RulingId, docAt: (path: RepoPath) => string | null,
): Readonly<{ edits: readonly ContractEdit[] }> | Readonly<{ reasons: readonly string[] }> {
  const reasons: string[] = [];
  const edits: ContractEdit[] = [];
  for (const path of [...new Set(ops.map((o) => o.path))].sort()) {
    const doc = docAt(path);
    if (doc === null) {
      reasons.push(`contract op on ${path}: no such document at the tip`);
      continue;
    }
    const placed: { op: ContractOp; section: Section; at: number }[] = [];
    for (const op of ops.filter((o) => o.path === path)) {
      const section = anchorSection(doc, op.anchor);
      if (typeof section === 'string') {
        reasons.push(`contract op on ${path}: ${section}`);
        continue;
      }
      const body = doc.slice(section.start, section.end);
      const first = body.indexOf(op.oldText);
      if (first === -1 || body.indexOf(op.oldText, first + 1) !== -1) {
        reasons.push(`contract op on ${path}: old text ${JSON.stringify(op.oldText)} occurs ${first === -1 ? 'nowhere' : 'more than once'} under anchor ${JSON.stringify(op.anchor)} (exactly once needed)`);
        continue;
      }
      placed.push({ op, section, at: section.start + first });
    }
    placed.forEach((a, i) => placed.slice(i + 1).forEach((b) => {
      if (a.section.start < b.section.end && b.section.start < a.section.end) reasons.push(`contract ops on ${path} overlap: anchors ${JSON.stringify(a.op.anchor)} and ${JSON.stringify(b.op.anchor)}`);
    }));
    if (reasons.length > 0) continue;
    const text = [...placed].sort((a, b) => b.at - a.at).reduce((t, p) => t.slice(0, p.at) + p.op.newText + t.slice(p.at + p.op.oldText.length), doc);
    edits.push({ path, text: citeRuling(text, ruling) });
  }
  return reasons.length > 0 ? { reasons } : { edits };
}
