import { createElement as h } from 'react';
function HistoryInline({ text }: any) {
  return String(text).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part: any, i: any) => {
    if (part.startsWith("`")) return h("code", { key: i }, part.slice(1, -1));
    if (part.startsWith("**")) return h("strong", { key: i }, part.slice(2, -2));
    const link2 = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link2 && /^https?:\/\//i.test(link2[2]!)) return h("a", { key: i, href: link2[2]!, target: "_blank", rel: "noreferrer" }, link2[1]!);
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
        items.push(h("li", { key: i++ }, h(HistoryInline, { text: m[1] })));
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
