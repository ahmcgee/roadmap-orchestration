export const fileLines = (text: any) => text === "" ? [] : String(text).replace(/\n$/, "").split("\n");
export function fileDiff(oldText: any, newText: any, oldStart: any = null, newStart: any = oldStart, eof: any = true) {
  const tokens = (text: any) => fileLines(text).map((line: any, i: any, all: any) => line + (i < all.length - 1 || !eof || text.endsWith("\n") ? "\n" : ""));
  const a = tokens(oldText), b = tokens(newText), ops = [];
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  for (let i = 0; i < prefix; i++) ops.push([" ", a[i]]);
  const aa = a.slice(prefix, a.length - suffix), bb = b.slice(prefix, b.length - suffix);
  if (aa.length * bb.length <= 25e4) {
    const table = Array.from({ length: aa.length + 1 }, () => new Uint32Array(bb.length + 1));
    for (let i2 = aa.length - 1; i2 >= 0; i2--) for (let j2 = bb.length - 1; j2 >= 0; j2--) table[i2]![j2] = aa[i2] === bb[j2] ? table[i2 + 1]![j2 + 1]! + 1 : Math.max(table[i2 + 1]![j2]!, table[i2]![j2 + 1]!);
    let i = 0, j = 0;
    while (i < aa.length || j < bb.length) {
      if (i < aa.length && j < bb.length && aa[i] === bb[j]) {
        ops.push([" ", aa[i++]]);
        j++;
      } else if (i < aa.length && (j === bb.length || table[i + 1]![j]! >= table[i]![j + 1]!)) ops.push(["-", aa[i++]]);
      else ops.push(["+", bb[j++]]);
    }
  } else {
    aa.forEach((line: any) => ops.push(["-", line]));
    bb.forEach((line: any) => ops.push(["+", line]));
  }
  for (let i = a.length - suffix; i < a.length; i++) ops.push([" ", a[i]]);
  let old = oldStart, next = newStart;
  const numbered = ops.map(([kind, text]: any) => {
    const row = { kind, text: text.replace(/\n$/, ""), noNewline: eof && !text.endsWith("\n"), oldCursor: old, nextCursor: next, old: kind === "+" ? null : old, next: kind === "-" ? null : next };
    if (kind !== "+" && old !== null) old++;
    if (kind !== "-" && next !== null) next++;
    return row;
  });
  const ranges: any[] = [];
  for (let i = 0; i < numbered.length; i++) if (numbered[i]!.kind !== " ") {
    const start = Math.max(0, i - 3), end = Math.min(numbered.length, i + 4), last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  }
  const rows: any[] = [];
  for (const [start, end] of ranges) {
    const chunk = numbered.slice(start, end), oldCount = chunk.filter((r: any) => r.kind !== "+").length, newCount = chunk.filter((r: any) => r.kind !== "-").length;
    const o = oldStart === null ? null : chunk[0]!.oldCursor - (oldCount === 0 ? 1 : 0), n = newStart === null ? null : chunk[0]!.nextCursor - (newCount === 0 ? 1 : 0);
    rows.push({ kind: "@", text: o != null && n != null ? `@@ -${o},${oldCount} +${n},${newCount} @@` : "@@ changed lines @@" }, ...chunk.flatMap((row: any) => row.noNewline ? [row, { kind: "@", text: "\\ No newline at end of file" }] : [row]));
  }
  highlightFileRows(rows);
  return { rows, added: ops.filter((r: any) => r[0] === "+").length, removed: ops.filter((r: any) => r[0] === "-").length };
}
export function highlightFileRows(rows: any) {
  for (let i = 0; i < rows.length; i++) if (rows[i].kind === "-") {
    let end = i;
    while (rows[end]?.kind === "-") end++;
    let plus = end;
    while (rows[plus]?.kind === "+") plus++;
    for (let k = 0; k < Math.min(end - i, plus - end); k++) {
      const left = rows[i + k], right = rows[end + k];
      if (left.text.length + right.text.length > 4e3) continue;
      let p = 0, s = 0;
      while (p < left.text.length && p < right.text.length && left.text[p] === right.text[p]) p++;
      while (p > 0 && /\w/.test(left.text[p - 1]) && /\w/.test(left.text[p] || right.text[p] || "")) p--;
      while (s < left.text.length - p && s < right.text.length - p && left.text.at(-1 - s) === right.text.at(-1 - s)) s++;
      while (s > 0 && /\w/.test(left.text[left.text.length - s]) && /\w/.test(left.text[left.text.length - s - 1] || right.text[right.text.length - s - 1] || "")) s--;
      left.mark = [p, left.text.length - s];
      right.mark = [p, right.text.length - s];
    }
    i = end - 1;
  }
}
export function resultFileDiff(text: any) {
  let patches;
  try {
    patches = JSON.parse(text).filePatch;
  } catch {
    return null;
  }
  if (!Array.isArray(patches) || !patches.length) return null;
  const rows: any[] = [];
  let added = 0, removed = 0;
  for (const patch of patches) {
    if (!Number.isSafeInteger(patch.oldStart) || !Number.isSafeInteger(patch.newStart) || !Array.isArray(patch.lines)) return null;
    let old = patch.oldStart, next = patch.newStart;
    rows.push({ kind: "@", text: `@@ -${old},${patch.oldLines} +${next},${patch.newLines} @@` });
    for (const line of patch.lines) {
      if (typeof line !== "string") return null;
      if (line.startsWith("\\ No newline")) {
        rows.push({ kind: "@", text: line });
        continue;
      }
      if (![" ", "-", "+"].includes(line[0]!)) return null;
      const kind = line[0];
      rows.push({ kind, text: line.slice(1), old: kind === "+" ? null : old, next: kind === "-" ? null : next });
      if (kind !== "-") next++;
      if (kind !== "+") old++;
      if (kind === "+") added++;
      if (kind === "-") removed++;
    }
  }
  highlightFileRows(rows);
  return { rows, added, removed };
}
export function readFilePreview(output: any, data: any) {
  const numbered = String(output || "").split("\n").map((line: any) => /^\s*(\d+)(?:→|\t)(.*)$/.exec(line)).filter((m): m is RegExpExecArray => m !== null);
  if (numbered.length) return { text: numbered.map((m: any) => m[2]).join("\n"), start: Number(numbered[0]![1]), end: Number(numbered.at(-1)![1]) };
  const text = String(output || ""), start = Number(data.offset) || 1;
  return { text, start, end: start + fileLines(text).length - 1 };
}
export function shellWritePath(command: any) {
  const match = /^\s*cat\s*>\s*(?:'([^'\n]+)'|"([^"$`\n]+)"|([^\s<>;&|$`]+))\s*<<-?\s*['"]?([\w-]+)['"]?\s*\n([\s\S]*?)\n\4\s*$/.exec(command);
  return match && !match[5]!.split("\n").some((line: any) => line.trim() === match[4]) ? match[1] || match[2] || match[3] : null;
}
export function fileHistory(events: any) {
  const files = /* @__PURE__ */ new Map(), views = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.type !== "tool") continue;
    let data;
    try {
      data = JSON.parse(e.input);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    const path = data.file_path || data.path, key = `${e.parent || ""}:${path}`, before = files.get(key);
    const complete = !e.truncated?.includes("input"), outputReady = !e.truncated?.includes("output");
    if (e.tool === "Read") {
      const read = readFilePreview(e.output, data);
      views.set(e.id, { read });
      if (e.status === "passed" && outputReady && read.start !== null) files.set(key, { ...read, eofKnown: false, whole: read.start === 1 && fileLines(read.text).length < (Number(data.limit) || 2e3) });
    } else if (e.tool === "Write" && complete && typeof data.content === "string") {
      const result = e.status === "passed" ? e.fileResult?.kind || (/^File created successfully at:/.test(e.output || "") ? "create" : /has been (?:updated|overwritten) successfully|overwrote existing file/i.test(e.output || "") ? "update" : null) : null;
      const kind = result || (before ? "update" : null);
      views.set(e.id, { kind, diff: kind === "update" ? before?.whole ? fileDiff(before.text, data.content, 1, 1, before.eofKnown) : resultFileDiff(e.text) : null });
      if (e.status === "passed") files.set(key, { text: data.content, start: 1, whole: true, eofKnown: true });
      else if (!e.status) files.delete(key);
    } else if (["Edit", "MultiEdit"].includes(e.tool) && complete) {
      const edits = e.tool === "MultiEdit" ? data.edits || [] : [data];
      let current = before ? { ...before } : null;
      const rows: any[] = [];
      let added = 0, removed = 0;
      for (const edit of edits) {
        const old = String(edit.old_string ?? ""), next = String(edit.new_string ?? "");
        let positions: any[] = [];
        if (current && old) {
          for (let at = current.text.indexOf(old); at >= 0; at = current.text.indexOf(old, at + old.length)) {
            positions.push(current.start + current.text.slice(0, at).split("\n").length - 1);
            if (!edit.replace_all) break;
          }
        }
        if (!positions.length && e.tool === "Edit") positions = e.fileResult?.starts || [];
        if (!positions.length) positions = [null];
        let delta = 0;
        for (const start of positions) {
          const diff = fileDiff(old, next, start, start === null ? null : start + delta, false);
          rows.push(...diff.rows);
          added += diff.added;
          removed += diff.removed;
          delta += fileLines(next).length - fileLines(old).length;
        }
        if (current && old && current.text.includes(old)) current.text = edit.replace_all ? current.text.split(old).join(next) : current.text.replace(old, () => next);
        else current = null;
      }
      views.set(e.id, { diff: before && current ? fileDiff(before.text, current.text, before.start, before.start, before.eofKnown) : resultFileDiff(e.text) || { rows, added, removed }, replaceAll: edits.some((edit: any) => edit.replace_all) });
      if (e.status === "passed" && current) files.set(key, current);
      else if (e.status !== "failed") files.delete(key);
    } else if (["Bash", "Command"].includes(e.tool)) {
      const command = data.command || "";
      if (shellWritePath(command) || /\btee\b|\bsed\s+-[a-z]*i|writeFile(?:Sync)?\s*\(|appendFile(?:Sync)?\s*\(|write_text\s*\(|write_bytes\s*\(|open\([^\n]+['"](?:w|a|x)[+b]?['"]/.test(command)) files.clear();
    }
  }
  return views;
}
