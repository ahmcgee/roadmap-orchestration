// Anchor-exact document references. Pure: callers supply document text at the tip.
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
