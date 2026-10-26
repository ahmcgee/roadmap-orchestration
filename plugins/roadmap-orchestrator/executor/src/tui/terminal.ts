import { safe } from './text.ts';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function cellWidth(s: string): number {
  if (/^[\p{Mark}\p{Format}]+$/u.test(s)) return 0;
  const cp = s.codePointAt(0) ?? 0;
  // Text-presentation symbols (✔, ℹ, ⚠) occupy one cell unless VS16 requests emoji.
  // Extended_Pictographic alone incorrectly treats these common test-output glyphs as wide.
  const emoji = /\p{Emoji_Presentation}/u.test(s) || (/\ufe0f/u.test(s) && /\p{Emoji}/u.test(s)) || /^[#*0-9]\ufe0f?\u20e3$/u.test(s);
  return emoji || (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
}
export function width(s: string): number { return [...segmenter.segment(safe(s))].reduce((n, x) => n + cellWidth(x.segment), 0); }
export function clip(s: string, columns: number): string {
  let text = ''; let used = 0;
  for (const { segment } of segmenter.segment(safe(s).replace(/\n/g, ' '))) {
    const w = cellWidth(segment); if (used + w > columns) break; text += segment; used += w;
  }
  return text;
}
export function wrap(s: string, columns: number): string[] {
  const out: string[] = [];
  for (const line of safe(s).split('\n')) {
    let text = ''; let used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const w = cellWidth(segment);
      if (used + w > Math.max(1, columns)) { out.push(text); text = ''; used = 0; }
      text += segment; used += w;
    }
    out.push(text);
  }
  return out;
}
/** Word boundaries and hanging indents keep prose legible; raw sources retain literal wrapping. */
export function wrapProse(s: string, columns: number): string[] {
  if (columns < 4) return wrap(s, columns);
  return safe(s).split('\n').flatMap((original) => {
    const indent = original.match(/^ */)![0];
    const continuation = ' '.repeat(Math.min(Math.floor(columns / 3), indent.length + (original.trimStart().startsWith('- ') ? 2 : 0)));
    const lines: string[] = []; let rest = original;
    while (width(rest) > columns) {
      const head = clip(rest, columns);
      const space = head.lastIndexOf(' ');
      const split = space > continuation.length ? space : head.length;
      lines.push(rest.slice(0, split).trimEnd());
      rest = continuation + rest.slice(split).trimStart();
    }
    lines.push(rest); return lines;
  });
}
export const pad = (s: string, n: number): string => { const t = clip(s, n); return t + ' '.repeat(Math.max(0, n - width(t))); };
export function symbol(state: string, ascii = false): string {
  if (state === 'stopped') return ascii ? '#' : '■';
  return /fail|fault|blocked|lost|malformed|refusal|stall/.test(state) ? '!' : /running|preparing|ready|alive|active|building|walking|polishing/.test(state) ? (ascii ? '>' : '●')
    : /merged|success|pass|complete/.test(state) ? (ascii ? '+' : '✓') : /held|wait|park|probe unknown/.test(state) ? (ascii ? '?' : '◇') : (ascii ? 'o' : '○');
}
/** Only these trusted styles become terminal escapes; captured text always goes through safe(). */
export type Tone = 'text' | 'muted' | 'strong' | 'accent' | 'wait' | 'fault' | 'good' | 'border' | 'violet';
export type Span = { text: string; tone: Tone; bold?: boolean; selected?: boolean };
export type Line = Span[];
export const ink = (text: string, tone: Tone = 'text', bold = false): Span => ({ text: safe(text).replace(/\n/g, ' '), tone, bold });
export const line = (...parts: (string | Span)[]): Line => parts.map((part) => typeof part === 'string' ? ink(part) : part);
export const plain = (row: Line): string => row.map((part) => part.text).join('');
export function fit(row: Line, columns: number): Line {
  let remaining = Math.max(0, columns); const out: Line = [];
  for (const part of row) {
    if (remaining <= 0) break;
    const text = clip(part.text, remaining); out.push({ ...part, text }); remaining -= width(text);
  }
  if (remaining) out.push(ink(' '.repeat(remaining)));
  return out;
}
export function stateTone(state: string): Tone {
  if (state === 'stopped') return 'wait';
  return /fail|fault|blocked|lost|malformed|refusal|stall|stale/.test(state) ? 'fault'
    : /running|preparing|ready|alive|active|building|walking|polishing/.test(state) ? 'accent'
    : /merged|success|pass|complete/.test(state) ? 'good'
    : /held|wait|park|probe unknown/.test(state) ? 'wait' : 'muted';
}
const colors: Record<Tone, number> = { text: 252, muted: 245, strong: 255, accent: 81, wait: 220, fault: 203, good: 114, border: 60, violet: 141 };
export function paint(row: Line, columns: number, color: boolean): string {
  return fit(row, columns).map((part) => color
    ? `\x1b[0;38;5;${colors[part.tone]};48;5;${part.selected ? 237 : 234}${part.bold ? ';1' : ''}m${part.text}`
    : part.text).join('');
}
export class Terminal {
  #previous: string[] = [];
  draw(lines: Line[], columns: number, rows: number, color: boolean): void {
    const frame = Array.from({ length: rows }, (_, i) => paint(lines[i] ?? [], Math.max(1, columns - 1), color));
    let changes = '';
    for (let i = 0; i < rows; i++) {
      const row = frame[i]!;
      if (row === this.#previous[i]) continue;
      changes += `\x1b[${i + 1};1H\x1b[2K${row}\x1b[0m`;
    }
    process.stdout.write(changes);
    this.#previous = frame;
  }
  invalidate(): void { this.#previous = []; }
}
