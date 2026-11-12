import { createElement as h } from 'react';
// Inline Markdown as React elements, never as HTML: code, bold, italic and links (http(s) links open; any other target shows its text only).
// Italic needs a space, an opening bracket or the line start before its marker, so globs such as `src/*.ts` stay literal.
export function HistoryInline({ text }: { text: string }): React.ReactNode {
  return String(text).split(/(`[^`\n]+`|\*\*(?=\S)[^\n]*?\S\*\*|(?<=^|[\s(])\*(?=[^\s*])[^*\n]*?[^\s*]\*(?![\w*])|(?<=^|[\s(])_(?=[^\s_])[^_\n]*?[^\s_]_(?!\w)|\[[^\]\n]+\]\([^\s)]+\))/g).map((part: string, i: number) => {
    // Odd parts are the matched inline tokens; even parts are plain text.
    if (i % 2) {
      if (part.startsWith("`")) return h("code", { key: i }, part.slice(1, -1));
      if (part.startsWith("**")) return h("strong", { key: i }, h(HistoryInline, { text: part.slice(2, -2) }));
      if (part.startsWith("*") || part.startsWith("_")) return h("em", { key: i }, h(HistoryInline, { text: part.slice(1, -1) }));
    }
    const link2 = i % 2 ? /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part) : null;
    if (link2) return /^https?:\/\//i.test(link2[2]!) ? h("a", { key: i, href: link2[2]!, target: "_blank", rel: "noreferrer" }, link2[1]!) : h("span", { key: i }, link2[1]!);
    return String(part).split(/((?:[\w@.*{}-]+\/)+[^\s,;]+|\b[\w*-]+\.(?:[cm]?[jt]sx?|json|md|css|html|ya?ml)\b|\b(?:contract|spec):[\w:#./-]+)/g).map((piece,j)=>j%2?h("code",{key:j},piece):piece);
  });
}
export function HistoryMarkdown({ text }: any): React.ReactElement {
  const lines = String(text || "").replace(/\r/g, "").split("\n"), blocks = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!, fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const code: any[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(lines[i]!)) code.push(lines[i++]!);
      i++;
      blocks.push(h("pre", { key: blocks.length }, h("code", null, code.join("\n"))));
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(h(`h${Math.min(6, heading[1]!.length + 2)}`, { key: blocks.length }, h(HistoryInline, { text: heading[2]! })));
      i++;
      continue;
    }
    const item = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
    if (item) {
      const ordered = /^\s*\d/.test(line), items = [];
      while (i < lines.length) {
        const m = /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(lines[i]!);
        if (!m) break;
        items.push(h("li", { key: i++ }, h(HistoryInline, { text: m[1]! })));
      }
      blocks.push(h(ordered ? "ol" : "ul", { key: blocks.length }, items));
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: any[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      blocks.push(h("blockquote", { key: blocks.length }, h(HistoryMarkdown, { text: quote.join("\n") })));
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() && !/^\s*(?:#{1,6}\s|[-*+] |\d+[.)] |`{3,}|~{3,}|>)/.test(lines[i]!)) paragraph.push(lines[i++]!);
    blocks.push(h("p", { key: blocks.length }, h(HistoryInline, { text: paragraph.join("\n") })));
  }
  return h("div", { className: "history-markdown" }, blocks);
}
