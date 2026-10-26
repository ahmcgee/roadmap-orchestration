import { project } from './projection.ts';
import { safe } from './text.ts';
import { cellWidth, fit, ink, line, plain, width, wrap, wrapProse, type Line } from './terminal.ts';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A deliberately small, inert Markdown renderer. Links and images are text, never terminal hyperlinks. */
export function inline(text: string): Line {
  const out: Line = []; let literal = '';
  const flush = (): void => { if (literal) { out.push(ink(literal)); literal = ''; } };
  text = safe(text);
  for (let i = 0; i < text.length;) {
    const rest = text.slice(i);
    const escape = /^\\([\\`*_[\]()>!|])/.exec(rest);
    if (escape) { literal += escape[1]; i += escape[0].length; continue; }
    const code = /^(`+)([^`]*?)\1/.exec(rest);
    if (code) { flush(); out.push(ink(code[2]!, 'accent')); i += code[0].length; continue; }
    const link = /^(!?)\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      flush(); out.push(ink(link[1] ? `Image: ${link[2]}` : link[2]!, 'accent'));
      if (link[2] !== link[3]) out.push(ink(` (${link[3]})`, 'muted'));
      i += link[0].length; continue;
    }
    const strong = /^(\*\*|__)(.+?)\1/.exec(rest);
    if (strong) { flush(); out.push(...inline(strong[2]!).map((part) => ({ ...part, bold: true, tone: part.tone === 'text' ? 'strong' as const : part.tone }))); i += strong[0].length; continue; }
    const emphasis = /^(\*|_)([^\n]+?)\1/.exec(rest);
    if (emphasis && (i === 0 || !/\w/.test(text[i - 1]!))) { flush(); out.push(ink(emphasis[2]!, 'violet')); i += emphasis[0].length; continue; }
    literal += text[i]!; i++;
  }
  flush(); return out;
}

/** Wrap after styling, preserving both Unicode cell widths and emphasis across line breaks. */
function flow(parts: Line, columns: number, prefix: Line = [], continuation: Line = prefix): Line[] {
  const cells = parts.flatMap((part) => [...graphemes.segment(part.text)].map(({ segment }) => ({ ...part, text: segment })));
  const out: Line[] = []; let start = 0;
  while (start < cells.length) {
    const lead = out.length ? continuation : prefix; const room = Math.max(1, columns - width(plain(lead)));
    let end = start; let used = 0; let space = -1;
    while (end < cells.length && used + cellWidth(cells[end]!.text) <= room) {
      if (cells[end]!.text === ' ') space = end;
      used += cellWidth(cells[end]!.text); end++;
    }
    if (end === start) end++;
    if (end < cells.length && space > start) end = space;
    const row: Line = [];
    for (const part of [...lead, ...cells.slice(start, end)]) {
      const previous = row.at(-1);
      if (previous && previous.tone === part.tone && previous.bold === part.bold && previous.selected === part.selected) previous.text += part.text;
      else row.push({ ...part });
    }
    out.push(row);
    start = end; while (cells[start]?.text === ' ') start++;
  }
  return out.length ? out : [prefix];
}
function tableCells(text: string): string[] {
  const cells: string[] = []; let cell = ''; let code = false;
  text = text.trim();
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && text[i + 1] === '|') { cell += '|'; i++; }
    else if (char === '`') { code = !code; cell += char; }
    else if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  if (text.startsWith('|')) cells.shift();
  if (text.endsWith('|')) cells.pop();
  return cells;
}
export function markdown(body: string, columns: number, ascii: boolean): Line[] {
  const input = safe(body).replace(/\r/g, '').split('\n'); const out: Line[] = [];
  const quote = ascii ? '|' : '│';
  for (let i = 0; i < input.length; i++) {
    const text = input[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      out.push(line(ink(`Code${fence[2]!.trim() ? (ascii ? ' | ' : ' · ') + fence[2]!.trim() : ''}`, 'muted')));
      for (i++; i < input.length; i++) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(input[i]!);
        if (close && close[1]![0] === fence[1]![0] && close[1]!.length >= fence[1]!.length) break;
        out.push(...wrap(input[i]!, Math.max(1, columns - 2)).map((row) => line(ink(`${quote} `, 'border'), ink(row))));
      }
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
    const setext = text.trim() && /^\s{0,3}(?:={3,}|-{3,})\s*$/.test(input[i + 1] ?? '');
    if (heading || setext) {
      out.push(...flow(inline(heading?.[1] ?? text).map((part) => ({ ...part, tone: 'accent', bold: true })), columns));
      if (setext) i++; continue;
    }
    if (/^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(text)) {
      out.push(line(ink((ascii ? '-' : '─').repeat(Math.max(1, columns)), 'border'))); continue;
    }
    const head = tableCells(text); const delimiter = tableCells(input[i + 1] ?? '');
    if (text.includes('|') && head.length >= 2 && delimiter.length === head.length && delimiter.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const rows = [head]; i++;
      while (i + 1 < input.length && input[i + 1]!.includes('|') && input[i + 1]!.trim()) {
        const row = tableCells(input[i + 1]!); if (row.length !== head.length) break;
        rows.push(row); i++;
      }
      const room = columns - (head.length - 1) * 3;
      if (room < head.length * 8) {
        // Wide tables become labelled records rather than silently losing rightmost columns.
        if (rows.length === 1) out.push(...flow(inline(head.join(' / ')), columns));
        for (const row of rows.slice(1)) {
          row.forEach((cell, index) => out.push(...flow([...inline(head[index]!).map((part) => ({ ...part, bold: true })), ink(': '), ...inline(cell)], columns)));
          out.push(line());
        }
      } else {
        const sizes = head.map((_, col) => Math.max(8, ...rows.map((row) => width(plain(inline(row[col]!))))));
        while (sizes.reduce((a, b) => a + b, 0) > room) { const index = sizes.indexOf(Math.max(...sizes)); sizes[index]!--; }
        rows.forEach((row, index) => {
          const rendered = row.map((cell, col) => flow(inline(cell).map((part) => ({ ...part, bold: index === 0 || Boolean(part.bold) })), sizes[col]!));
          for (let y = 0; y < Math.max(...rendered.map((cell) => cell.length)); y++) {
            out.push(rendered.flatMap((cell, col) => [...(col ? [ink(` ${quote} `, 'border')] : []), ...fit(cell[y] ?? [], sizes[col]!)]));
          }
          if (!index) out.push(line(ink(sizes.map((size) => (ascii ? '-' : '─').repeat(size)).join(ascii ? '-+-' : '─┼─'), 'border')));
        });
      }
      continue;
    }
    const bullet = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(text);
    if (bullet) {
      const indent = ' '.repeat(Math.min(bullet[1]!.length, Math.floor(columns / 4)));
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[3]!);
      const marker = task ? task[1] === ' ' ? '[ ]' : '[x]' : /^\d/.test(bullet[2]!) ? bullet[2]! : ascii ? '-' : '•';
      const prefix = line(ink(`${indent}${marker} `, task?.[1] !== undefined && task[1] !== ' ' ? 'good' : 'accent'));
      out.push(...flow(inline(task?.[2] ?? bullet[3]!), columns, prefix, line(ink(' '.repeat(width(plain(prefix))))))); continue;
    }
    if (text.startsWith('    ')) {
      out.push(...wrap(text.slice(4), Math.max(1, columns - 2)).map((row) => line(ink(`${quote} `, 'border'), ink(row)))); continue;
    }
    const blockquote = /^(\s*)(?:>\s?)(.*)$/.exec(text);
    if (blockquote) { out.push(...flow(inline(blockquote[2]!), columns, line(ink(`${quote} `, 'violet')))); continue; }
    out.push(...flow(inline(text), columns));
  }
  return out;
}
export function documentLines(body: string, columns: number, ascii: boolean): Line[] {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return markdown(body, columns, ascii); }
  return project(value).flatMap((row) => wrapProse(row.text, columns).map((text) => line(ink(text, row.kind === 'heading' ? 'accent' : 'text', row.kind === 'heading'))));
}
