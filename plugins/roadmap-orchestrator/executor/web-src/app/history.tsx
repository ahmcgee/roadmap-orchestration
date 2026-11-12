import { InvocationFacts } from './invocation-facts.tsx';
import { mergeHistoryPages } from './history-pages.ts';
import { HistoryInline, HistoryMarkdown } from './markdown.tsx';
// Recorded agent-history rendering, ported intact from the original console.
import * as R from 'react';
import { useState, useEffect, useRef } from 'react';
import { Clock, api, elapsed, get, link, money, pluralise, relativeTime, route } from './shared.tsx';
import { Drawer as Dialog, BackToUnit } from './drawer.tsx';
import { fileHistory, shellWritePath, fileLines, readFilePreview } from './file-history.ts';
import { changedFiles, historyToolRuns } from './history-presentation.ts';
const h: any = R.createElement;
function HistoryField({ event, field, base, identity }: any) {
  const [pages, setPages] = useState<any>([]), [cursor, setCursor] = useState<any>(0), [size, setSize] = useState<any>(null), [error, setError] = useState<any>("");
  const load = () => get(`${base}/history-field?identity=${encodeURIComponent(identity)}&ref=${encodeURIComponent(event.refs?.[field] || event.id)}&field=${field}&after=${cursor}`).then((r: any) => {
    setPages([r.data.text]);
    setCursor(r.data.next);
    setSize(r.data.size);
    setError("");
  }).catch((err: any) => setError(err.message));
  return h(
    "details",
    { className: "history-expansion", onToggle: (ev: any) => {
      if (ev.currentTarget.open && size === null) load();
    } },
    h("summary", null, `Expand full ${field} (preview truncated)`),
    error && h("p", { role: "alert" }, error),
    pages.map((text: any, i: any) => h("pre", { key: i }, text)),
    size !== null && h("p", { className: "muted" }, `Characters ${Math.max(0, cursor - pages.join("").length)}\u2013${cursor} of ${size}`),
    size !== null && cursor < size && h("button", { onClick: load }, `Next ${field} page`)
  );
}
const historyLabel = (value: any) => String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/^./, (c: any) => c.toUpperCase());
const historyJson = (text: any) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const historyEmpty = (value: any) => value == null || value === "" || (Array.isArray(value) ? !value.length : typeof value === "object" && Object.values(value).every(historyEmpty));
function HistoryValue({ value, name = "" }: any) {
  if (historyEmpty(value)) return null;
  if (Array.isArray(value)) return name === "argv" ? h("pre", null, h("code", null, value.join(" "))) : h("ul", null, value.filter((v: any) => !historyEmpty(v)).map((v: any, i: any) => h("li", { key: i }, h(HistoryValue, { value: v, name: name === "evidence" ? "evidence" : "" }))));
  if (typeof value === "object") {
    if (typeof value.path === "string" && typeof value.line === "number") return h("code", { className: "history-evidence" }, `${value.path}:${value.line}`);
    // A command the agent ran reads as one entry: its name and exit on one line, the command beneath, any other fields after.
    const command = Array.isArray(value.argv) ? value.argv.join(" ") : typeof value.command === "string" ? value.command : null;
    if (command !== null) {
      const label = ["name", "description", "title"].find(key => typeof value[key] === "string" && value[key]), exitKey = ["exit", "exitCode"].find(key => typeof value[key] === "number");
      const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !["argv", "command", label, exitKey].includes(key)));
      return h("div", { className: "history-run" },
        (label || exitKey) && h("div", { className: "history-run-head" }, label && h("span", null, h(HistoryInline, { text: value[label] })), exitKey && h("span", { className: "history-run-exit", "data-ok": value[exitKey] === 0 }, `Exit ${value[exitKey]}`)),
        h("pre", { className: "history-command" }, h("code", null, command)),
        h(HistoryValue, { value: rest }));
    }
    const order = ["title", "claim", "text", "what", "summary", "description", "name", "severity", "path", "evidence", "command", "argv", "exit", "output"];
    const fields = Object.entries(value).filter(([, v]: any) => !historyEmpty(v)).sort(([a]: any, [b]: any) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));
    // A short single-line value sits beside its label; longer prose, lists and code stack beneath it.
    const short = (key: string, v: unknown) => typeof v === "number" || typeof v === "boolean" || typeof v === "string" && v.length <= 60 && !v.includes("\n") && !["command", "output", "old_string", "new_string", "content", "code", "function"].includes(key);
    return h("dl", { className: "history-fields" }, fields.map(([key, v]: any) => h("div", { key, className: short(key, v) ? "history-field-inline" : void 0 }, h("dt", null, historyLabel(key)), h("dd", null, h(HistoryValue, { value: v, name: key })))));
  }
  if (["decision", "outcome", "severity"].includes(name)) return h("span", { className: "history-status", "data-status": String(value) }, historyLabel(value));
  if (["path", "file", "contractRef", "evidence"].includes(name)) return h("code", { className: "history-evidence" }, String(value));
  if (["command", "output", "old_string", "new_string", "content", "code", "function"].includes(name)) return h("pre", null, h("code", null, String(value)));
  return typeof value === "string" ? h(HistoryMarkdown, { text: value }) : h("span", null, typeof value === "boolean" ? value ? "Yes" : "No" : String(value));
}
const recordedDecision=(value:any)=>({approve:'Approved',revise:'Changes requested',pass:'Passed',fail:'Failed',success:'Succeeded',keep:'Kept',reject:'Rejected',hold:'Held',cut:'Withdrawn',continue:'Continued',escalate:'Escalated'}[String(value)]||historyLabel(value));
function VerdictStatus({value}:any){
  if(value?.mode&&value?.verdict)value=value.verdict;
  const decision=value?.decision||(typeof value?.outcome==='string'?value.outcome:null)||(value?.ok===true?'pass':value?.ok===false?'fail':null);
  if(!decision)return null;
  return h("div",{className:"invocation-verdict"},h("span",{className:"history-status","data-status":decision},h("span",{className:"verdict-glyph","aria-hidden":true},/approve|pass|success/i.test(decision)?'✓':/fail|revise/i.test(decision)?'×':'○'),`Verdict: ${recordedDecision(decision)}`));
}
function VerdictCard({ value }: any) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return h("section", { className: "history-verdict", "aria-label": "Agent report" }, h("h3", null, "Agent report"), h(HistoryValue, { value }));
  if (value.mode && value.verdict && typeof value.verdict === "object") value = { mode: value.mode, ...value.verdict };
  const decision = value.decision || (typeof value.outcome === "string" ? value.outcome : null) || (value.final === true ? "Report complete" : value.final === false ? "Interim report" : value.ok === true ? "Passed" : value.ok === false ? "Failed" : "Report recorded");
  const order = ["summary", "reasons", "findings", "premises", "grounding", "experiments"];
  const fields = Object.entries(value).filter(([key]: any) => !["decision", "final"].includes(key)).sort(([a]: any, [b]: any) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));
  const empty = fields.filter(([, v]: any) => historyEmpty(v)).map(([key]: any) => historyLabel(key));
  return h(
    "section",
    { className: "history-verdict", "aria-label": "Agent verdict" },
    h("div", { className: "history-verdict-head" }, h("h3", null, "Agent report"), h("span", { className: "history-status", "data-status": String(decision) }, recordedDecision(decision))),
    fields.filter(([key, v]: any) => !historyEmpty(v) && !(key === "outcome" && typeof v === "string")).map(([key, v]: any) => h("section", { key, className: "history-verdict-section" }, h("h4", null, historyLabel(key)), h(HistoryValue, { value: v, name: key }))),
    empty.length > 0 && h("p", { className: "muted history-empty" }, `No ${empty.map((name:any)=>name.toLowerCase()).join(" or ")}.`)
  );
}
const briefSections = new Set("affected audited_range base_comparison browser build_lanes builder_touches cap_and_allowance changed checkout contracts_index decisions delta diff direction_text disputes driving_the_product escalation evidence_dir evidence_dirs executable_checks failing_lane_evidence finding_bar findings_and_evidence findings_ledger fix_round grounding_first handover history how_your_session_ends implementation intent journeys judging kept_tweaks lane_ledger large_diff last_lane_series lenses merged_units method milestone milestones non_goals not_inlined notes obligations open_findings orientation owner_branches plan previous_findings prior_findings prior_round product reach reach_traits references report required_checks rules_index safety seeing specs standing standing_items standing_obligations subagents suite_lanes system_notes system_traits systems tweak_diff undeclared_contracts unit_policy unit_systems vision vision_first walkthrough_findings witness_checks witnesses_and_lanes working_unattended workspace worktree your_checkout".split(" "));
function BriefInstructions({ text }: any) {
  let fence = null, chunk: string[] = [];
  const blocks: any[] = [];
  const flush = () => {
    const body = chunk.join("\n").trim();
    chunk = [];
    if (!body) return;
    const value = historyJson(body);
    blocks.push(value !== null ? h(HistoryValue, { key: blocks.length, value }) : h(HistoryMarkdown, { key: blocks.length, text: body }));
  };
  for (const line of String(text || "").split("\n")) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (mark) {
      if (!fence) fence = mark[1]!;
      else if (mark[1]![0] === fence[0]! && mark[1]!.length >= fence.length) fence = null;
      chunk.push(line);
      continue;
    }
    if (fence) {
      chunk.push(line);
      continue;
    }
    for (const part of line.split(/(<\/?[a-z_]+>|<\/?pasted_content id="[a-f0-9]+">)/g)) {
      const tag = /^<(\/?)([a-z_]+)(?: id="[a-f0-9]+")?>$/.exec(part);
      if (tag && (briefSections.has(tag[2]!) || tag[2]! === "pasted_content")) {
        flush();
        if (!tag[1]!) blocks.push(h("h4", { key: blocks.length }, tag[2]! === "pasted_content" ? "Recorded diff" : historyLabel(tag[2]!)));
      } else if (part) chunk.push(part);
    }
  }
  flush();
  return h("div", { className: "history-instructions" }, blocks);
}
function SeatBrief({ brief }: any) {
  return h(
    "div",
    { className: "history-seat-brief" },
    brief.mode && h("p", null, h("strong", null, "Mode: "), historyLabel(brief.mode)),
    brief.documents.map((doc: any, i: any) => h("details", { key: i, className: "history-document", open: doc.content.length < 1600 }, h("summary", null, doc.source), h(HistoryMarkdown, { text: doc.content }))),
    h("section", null, h("h3", null, "Instructions"), h(BriefInstructions, { text: brief.instructions }))
  );
}
function useHistoryText(event: any, field: any, base: any, identity: any) {
  const [full, setFull] = useState<any>(null), [error, setError] = useState<any>("");
  const original = event?.[field], ref = event?.refs?.[field] || event?.id, truncated = event?.truncated?.includes(field);
  useEffect(() => {
    setFull(null);
    setError("");
    if (!truncated) return;
    const c = new AbortController();
    (async () => {
      let after = 0, text = "";
      for (; ; ) {
        const r = (await get(`${base}/history-field?identity=${encodeURIComponent(identity)}&ref=${encodeURIComponent(ref)}&field=${field}&after=${after}`, c.signal)).data;
        text += r.text;
        after = r.next;
        if (after >= r.size) {
          setFull(text);
          return;
        }
        if (text.length >= 8 * 1024 * 1024) throw new Error("Record exceeds the history decoder bound");
      }
    })().catch((err: any) => {
      if (!c.signal.aborted) setError(err.message);
    });
    return () => c.abort();
  }, [original, ref, truncated, field, base, identity]);
  return { text: full ?? original, ready: !truncated || full !== null, error };
}
const FileHistory = R.createContext<any>({ views: /* @__PURE__ */ new Map(), hydrate: () => {
} });
function FileHistoryProvider({ events, identity, children }: any) {
  const [cache, setCache] = useState<any>({ identity, fields: {} });
  const hydrated = cache.identity === identity ? cache.fields : {};
  const hydrate = R.useCallback((id: any, fields: any) => setCache((old: any) => {
    const retained = old.identity === identity ? old.fields : {}, before = retained[id];
    if (before?.input === fields.input && before?.output === fields.output && before?.text === fields.text) return old;
    return { identity, fields: { ...retained, [id]: fields } };
  }), [identity]);
  useEffect(() => {
    const ids = new Set(events.map((e: any) => e.id));
    setCache((old: any) => old.identity === identity && Object.keys(old.fields).some((id: any) => !ids.has(id)) ? { identity, fields: Object.fromEntries(Object.entries(old.fields).filter(([id]: any) => ids.has(id))) } : old);
  }, [events, identity]);
  const resolved = R.useMemo(() => events.map((e: any) => hydrated[e.id] ? { ...e, ...hydrated[e.id], truncated: (e.truncated || []).filter((f: any) => !(f in hydrated[e.id])) } : e), [events, hydrated]);
  const views = R.useMemo(() => fileHistory(resolved), [resolved]), value = R.useMemo(() => ({ views, hydrate, events: resolved }), [views, hydrate, resolved]);
  return h(FileHistory.Provider, { value }, children);
}
function FileLines({ rows, diff = false, path = "", start = 1 }: any) {
  const [all, setAll] = useState<any>(false), shown = all ? rows : rows.slice(0, 40);
  const tint = (text: any) => {
    if (!/\.(?:[cm]?[jt]sx?|json|md|sh|css|html?)$/i.test(path)) return text;
    return text.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:const|let|var|function|return|export|import|from|true|false|null|if|else|class|async|await)\b|^\s*#.*$|\/\/.*$)/g).map((part: any, i: any) => /^(?:["']|\s*#|\/\/)/.test(part) || /^(?:const|let|var|function|return|export|import|from|true|false|null|if|else|class|async|await)$/.test(part) ? h("span", { key: i, className: "history-syntax" }, part) : part);
  };
  return h(R.Fragment, null, h("pre", { className: diff ? "history-diff" : "history-code" }, shown.map((row: any, i: any) => {
    const text = diff ? row.text : row, mark = diff && row.mark;
    return h(
      "div",
      { key: i, className: diff ? `history-diff-line history-diff-${({ "-": "remove", "+": "add", "@": "hunk", " ": "context" } as Record<string, string>)[row.kind]}` : "history-code-line" },
      diff ? row.kind !== "@" && h(R.Fragment, null, row.old != null && h("small", { className: "history-line-number" }, row.old), row.next != null && h("small", { className: "history-line-number" }, row.next)) : h("small", { className: "history-line-number" }, start + i),
      h("code", null, diff && row.kind !== "@" ? h("span", { className: "history-diff-marker", "aria-hidden": true }, `${row.kind} `) : "", mark ? h(R.Fragment, null, text.slice(0, mark[0]!), h("mark", null, text.slice(...mark)), text.slice(mark[1]!)) : diff ? text : tint(text), "\n")
    );
  })), rows.length > 40 && h("button", { className: "history-show-all", onClick: () => setAll(!all) }, all ? "Show less" : `Show all (${rows.length} lines)`));
}
function NativeTool({ event, base, identity, onLayout }: any) {
  const input = useHistoryText(event, "input", base, identity), output = useHistoryText(event, "output", base, identity), patch = useHistoryText(event, "text", base, identity);
  const { views, hydrate, events } = R.useContext(FileHistory), view = views.get(event.id) || {};
  const data = event.inputFormat === "json" ? historyJson(input.text) : null;
  useEffect(() => {
    if (input.ready && output.ready && patch.ready) hydrate(event.id, { input: input.text, output: output.text, text: patch.text });
  }, [event.id, input.text, output.text, patch.text, input.ready, output.ready, patch.ready, hydrate]);
  R.useLayoutEffect(() => {
    onLayout?.();
  }, [input.ready, output.ready, patch.ready]);
  const tool = event.tool || "Tool result", path = data?.file_path || data?.path;
  const shell = ["bash", "command", "bash_placeholder"].includes(tool.toLowerCase()), fileTool = ["Edit", "MultiEdit", "Write", "Read"].includes(tool);
  const title = path ? `${tool === "Read" ? "Read  " : fileTool ? "" : tool + "  "}${path}` : tool === "Grep" ? `Grep  ${data?.pattern || "search"}` : tool === "Glob" ? `Glob  ${data?.pattern || "files"}` : data?.description ? `${tool}  ${data.description}` : historyLabel(tool.replace(/^mcp__playwright__browser_/, "Browser "));
  const expansion = (field: any) => event.truncated?.includes(field) ? h(HistoryField, { event, field, base, identity }) : null;
  const status = event.status && h("span", { className: event.status === "failed" ? "history-tool-error" : "history-tool-ok", title: event.status === "passed" ? "Succeeded" : void 0 }, event.status === "failed" ? "Error" : fileTool ? "\u2713" : "Done");
  const errors = event.status === "failed" && h("details", { className: "tool-output history-tool-error", open: true }, h("summary", null, "Output  error"), h("pre", null, output.text), expansion("output"));
  if (tool === "Read" && data) {
    const read = view.read || readFilePreview(output.text, data), range = event.status === "failed" ? "read failed" : event.output == null ? "reading\u2026" : read.end < read.start ? "empty file" : read.start !== null ? `lines ${read.start}\u2013${read.end}` : data.offset ? `from line ${data.offset}${data.limit ? `  ${data.limit} requested` : ""}` : data.limit ? `first ${data.limit} lines requested` : "line range unrecorded";
    return h(R.Fragment, null, h("details", { className: "history-read" }, h("summary", null, h("strong", { title: path }, title), h("small", { className: "muted" }, range), event.status === "passed" && h("small", { className: "muted" }, "Show output"), status), event.status !== "failed" && h("pre", null, h("code", null, read.text))), event.truncated?.includes("input") && h("div", { className: "tool-input" }, expansion("input")), errors);
  }
  const writes = shell && shellWritePath(data?.command || input.text || "");
  if(shell&&event.status==='passed')return h(R.Fragment,null,
    h("details",{className:"successful-command",onToggle:onLayout},
      h("summary",null,h("strong",null,data?.description||data?.command?.split('\n')[0]||title),h("span",{className:"history-tool-ok"},"✓ Passed"),writes&&h("a",{href:`#diff-${event.id}`,onClick:(ev:any)=>{
        ev.preventDefault();ev.stopPropagation();
        const file=changedFiles(events,views).find(file=>file.path===writes),target=[...document.querySelectorAll<HTMLElement>('.history-scroll [data-event-id]')].find(node=>node.dataset['eventId']===(file?.id??event.id));
        if(target){if(!views.get(file?.id)?.diff){const details=target.querySelector<HTMLDetailsElement>('.successful-command');if(details)details.open=true;}target.scrollIntoView({block:'nearest'});}
      }},`writes ${writes}`)),
      h("pre",{className:"history-command"},h("code",null,data?.command||input.text)),expansion("input"),
      h("pre",{className:"tool-output"},output.text),expansion("output")),
    input.error&&h("p",{role:"alert"},input.error),output.error&&h("p",{role:"alert"},output.error),
    view.diff&&h("div",{id:`diff-${event.id}`},h(FileLines,{rows:view.diff.rows,diff:true})));
  return h(
    R.Fragment,
    null,
    h("header", { className: "history-event-head" }, h("strong", null, title), h("span", { className: "history-file-meta" }, view.kind && h("small", { className: `history-file-badge history-file-${view.kind}` }, view.kind === "create" ? "new file" : "overwrote existing file"), view.replaceAll && h("small", { className: "history-file-badge" }, "replace_all"), view.diff && h("small", { className: "history-diff-count" }, h("span", { className: "history-count-add" }, `+${view.diff.added}`), h("span", { className: "history-count-remove" }, ` \u2212${view.diff.removed}`)), status)),
    event.title && h("small", { className: "muted" }, event.title),
    input.error && h("p", { role: "alert" }, input.error),
    output.error && h("p", { role: "alert" }, output.error),
    patch.error && h("p", { role: "alert" }, patch.error),
    event.input != null && h("div", { className: "tool-input" }, !input.ready ? h("p", { className: "muted" }, "Reading recorded tool input\u2026") : shell ? h(R.Fragment, null, writes && h("small", { className: "muted" }, `writes ${writes}`), h("pre", { className: "history-command" }, h("code", null, data?.command || event.input))) : ["Edit", "MultiEdit"].includes(tool) && data ? view.diff ? h(FileLines, { rows: view.diff.rows, diff: true }) : h("p", { className: "muted" }, "Preparing diff\u2026") : tool === "Write" && data ? view.diff ? h(FileLines, { rows: view.diff.rows, diff: true }) : h(FileLines, { rows: fileLines(data.content || ""), path }) : data ? h(HistoryValue, { value: Object.fromEntries(Object.entries(data).filter(([key]: any) => !["file_path", "path", "description"].includes(key))) }) : event.input && h("pre", null, event.input), !fileTool && expansion("input")),
    errors,
    !fileTool && event.status !== "failed" && event.output != null && h("details", { className: "tool-output" }, h("summary", null, "Show output"), h("pre", null, event.output), expansion("output"))
  );
}
const ThinkingState = R.createContext(new Map<string, boolean>());
function Thinking({ event, base, identity }: any) {
  const retained = R.useContext(ThinkingState), key = `${identity}:${event.id}`;
  const [open, setOpen] = useState(() => retained.get(key) ?? false);
  const value = useHistoryText(open ? event : { ...event, truncated: [] }, "text", base, identity);
  return h("div", { className: "thinking-disclosure" },
    h("div", { id: `thinking-${event.id}`, className: open ? "" : "thinking-preview" }, h(HistoryMarkdown, { text: value.text }),
      open && !value.ready && h("p", { className:"muted", role:"status" }, "Reading full thinking…"),
      value.error && h("p", {role:"alert"}, value.error),
      value.error && event.truncated?.includes("text") && h(HistoryField, { event, field: "text", base, identity })),
    h("button", { "aria-expanded": open, "aria-controls": `thinking-${event.id}`, onClick: () => { retained.set(key, !open); setOpen(!open); } }, `${open ? "Hide thinking" : "Show thinking"} (1 event)`));
}
function AgentEvent({ event, base, identity, onLayout }: any) {
  const now = R.useContext(Clock), unknown = event.unknown;
  const expansion = (field: any) => event.truncated?.includes(field) ? h(HistoryField, { event, field, base, identity }) : null;
  const structured = event.tool === "StructuredOutput";
  const title = unknown ? `${(event.title || "Transcript record").replace(/^Unknown\s*/, "")}  recorded event` : structured ? event.status === "failed" ? "Report rejected" : "Report submitted" : event.type === "result" ? "Agent finished" : event.title || historyLabel(event.type === "message" ? "Agent" : event.type);
  return h(
    "article",
    { className: `history-event history-${event.type}${unknown ? " history-unforeseen" : ""}`, "data-event-id": event.id, "data-tool": event.tool, "data-tool-id": event.toolId, title: event.at ? new Date(event.at).toLocaleString() : void 0 },
    event.parent && h("small", { className: "muted" }, `Subagent of ${event.parent}`),
    event.type === "tool" && !structured ? h(NativeTool, { event, base, identity, onLayout }) : h(
      R.Fragment,
      null,
      h("header", { className: "history-event-head" }, h("strong", null, title), event.at && h("time", null, relativeTime(event.at, now))),
      unknown ? h("details", null, h("summary", null, "Raw event payload"), h("pre", null, historyJson(event.text) ? JSON.stringify(historyJson(event.text), null, 2) : event.text), expansion("text")) : structured && event.status === "failed" ? h("details", { open: true, className: "tool-output" }, h("summary", null, "Output  error"), h("pre", null, event.output), expansion("output")) : !structured && event.type !== "result" && (event.type === "thinking" ? h(Thinking, { event, base, identity }) : h(R.Fragment, null, h(HistoryMarkdown, { text: event.text }), expansion("text")))
    ),
    // A model call's usage counts its whole context, everything earlier in the conversation included: say so, never a bare count.
    (event.tokens != null || event.elapsedMs != null) && h("small", { className: "muted history-event-meta", title: event.tokens != null ? "Tokens this model call read and wrote, including the conversation before it" : void 0 }, [event.tokens != null ? `Context ${event.tokens.toLocaleString("en-US")} ${event.tokens === 1 ? "token" : "tokens"}` : "", event.elapsedMs != null ? elapsed(event.elapsedMs) : ""].filter(Boolean).join("  "))
  );
}
function TranscriptVerdict({ event, base, identity, onLayout, summary=false }: any) {
  const field = event?.tool === "StructuredOutput" ? "input" : "text", value = useHistoryText(event, field, base, identity);
  R.useLayoutEffect(() => {
    onLayout?.();
  }, [value.ready]);
  if (value.error) return h("p", { role: "alert" }, value.error);
  if (!event) return null;
  if (!value.ready) return h("p", { className: "muted" }, "Reading agent report\u2026");
  return h(summary?VerdictStatus:VerdictCard, { value: historyJson(value.text) || value.text });
}
function ChangedFiles({onJump}:any){
  const {views,events=[]}=R.useContext(FileHistory),files=changedFiles(events,views);
  return h("details",{className:"changed-files"},h("summary",null,`Changed files (${files.length})`),h("div",null,files.map(file=>h("button",{key:file.path,onClick:()=>onJump(file.id)},h("code",null,file.path),file.counts?h("span",null,`+${file.added} −${file.removed}`):h("small",null,"Change counts unrecorded")))),!files.length&&h("p",{className:"muted"},"No file changes in the loaded events."));
}
function HistoryEvents({events,live,...props}:any){
  const groups=historyToolRuns(events,live);
  return groups.map(group=>group.events.length===1?h(AgentEvent,{key:group.key,event:group.events[0],...props}):h("details",{key:group.events.at(-1).id,className:"history-group",onToggle:props.onLayout},h("summary",null,`${group.events.length} tool calls: ${group.label}`,h("small",{className:"muted"},[group.events[0].at,group.events.at(-1).at].filter(Boolean).map(at=>new Date(at).toLocaleTimeString()).join(' – '))),group.events.map(event=>h(AgentEvent,{key:event.id,event,...props}))));
}
function AgentDetail({ arc, id, activity, close, stale, detail, full = false }: any) {
  const now=R.useContext(Clock);
  const base = `/arcs/${arc}/invocations/${id}`;
  const [history, setHistory] = useState<any>(null), [error, setError] = useState<any>(""), [brief, setBrief] = useState<any>(null), [result, setResult] = useState<any>(null);
  const [following, setFollowing] = useState<any>(true), [earlier, setEarlier] = useState<any>(false), [above,setAbove]=useState(false), [loadingEarlier,setLoadingEarlier]=useState(false);
  const scroll = useRef<any>(null), follow = useRef<any>(true), placedScroll = useRef<any>(null), entered=useRef(false), anchor=useRef<{id:string;offset:number;height:number}|null>(null);
  // Where the reader was in the drawer when they pressed Expand: the full view opens there and Back returns there.
  const reading=useRef<{following:boolean;anchor:{id:string;offset:number;height:number}|null}|null>(null), wasFull=useRef(full);
  // The first event still visible at the top of the transcript, how far below the top edge it sits, and its height.
  const readingAnchor=()=>{const top=scroll.current.getBoundingClientRect().top,first=[...scroll.current.querySelectorAll('[data-event-id]')].find((node:any)=>!node.closest('details:not([open])')&&node.getBoundingClientRect().height>0&&node.getBoundingClientRect().bottom>top) as HTMLElement|undefined;return first?{id:first.dataset['eventId']!,offset:first.getBoundingClientRect().top-top,height:first.getBoundingClientRect().height}:null;};
  useEffect(() => {
    const c = new AbortController();
    setHistory(null);
    setBrief(null);
    setError("");
    setResult(null);
    setEarlier(false);setLoadingEarlier(false);
    follow.current = true;
    setFollowing(true);
    placedScroll.current = null;entered.current=false;anchor.current=null;setAbove(false);
    get(`${base}/prompt?after=0`, c.signal).then((r: any) => setBrief(r.data)).catch((err: any) => {
      if (!c.signal.aborted) setError(err.message);
    });
    let fetching = false, again = false;
    const load = async (notice?: any) => {
      if (fetching) {
        again = true;
        return;
      }
      fetching = true;
      try {
        const next = (await get(`${base}/history`, c.signal)).data;
        setHistory((old: any) => {
          if (!old || notice?.reset || old.identity !== next.identity){if(next.endedAt||next.state!=="running"){follow.current=false;setFollowing(false);}return next;}
          if (!follow.current) return { ...old, state: next.state, endedAt: next.endedAt, unseen: (old.unseen || 0) + (notice?.changed || 0) };
          return mergeHistoryPages(old,next);
        });
        setError("");
      } catch (err: any) {
        if (!c.signal.aborted) setError(err.message);
      } finally {
        fetching = false;
        if (again && !c.signal.aborted) {
          again = false;
          load();
        }
      }
    };
    load();
    const stream = new EventSource(`${api}/arcs/${arc}/events?invocation=${id}`);
    stream.addEventListener("history", (ev: any) => load(JSON.parse(ev.data)));
    stream.addEventListener("history-error", (ev: any) => {
      if (ev.data) setError(JSON.parse(ev.data).message);
    });
    return () => {
      c.abort();
      stream.close();
    };
  }, [base]);
  const followLayout = () => {
    if(!scroll.current)return;
    if(anchor.current){const saved=anchor.current;anchor.current=null;const target=[...scroll.current.querySelectorAll('[data-event-id]')].find((node:any)=>node.dataset['eventId']===saved.id) as HTMLElement|undefined;if(target){const box=target.getBoundingClientRect();
      // An event cut by the top edge keeps the same share of itself above the edge when a width change reflows it.
      const offset=saved.offset<0&&saved.height>0?saved.offset*box.height/saved.height:saved.offset;
      scroll.current.scrollTop+=box.top-scroll.current.getBoundingClientRect().top-offset;}placedScroll.current=scroll.current.scrollTop;return;}
    if(!entered.current&&history?.events.length){entered.current=true;if(completed){scroll.current.scrollTop=0;placedScroll.current=0;return;}}
    if (!follow.current) return;
    const verdict = completed ? scroll.current.querySelector(".history-verdict") : null;
    scroll.current.scrollTop = verdict ? scroll.current.scrollTop + verdict.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top : scroll.current.scrollHeight;
    placedScroll.current = scroll.current.scrollTop;
  };
  R.useLayoutEffect(followLayout, [history, result]);
  // Expand and Back change only the width: keep the same reading position, or keep following the live tail.
  R.useLayoutEffect(() => {
    if (wasFull.current === full) return;
    wasFull.current = full;
    if (!scroll.current) return;
    const saved = reading.current;
    if (!full) reading.current = null;
    // A reader who was following when they expanded and stopped in the full view gets the updates they skipped.
    const catchUp = saved?.following && !follow.current && history?.unseen;
    if (saved) { follow.current = saved.following; setFollowing(saved.following); anchor.current = saved.following ? null : saved.anchor; }
    if (catchUp) void latest();
    followLayout();
    setAbove(scroll.current.scrollTop > 8);
  }, [full]);
  const more = () => {
    if(loadingEarlier)return;setLoadingEarlier(true);
    follow.current = false;
    setFollowing(false);
    anchor.current=readingAnchor();
    get(`${base}/history?before=${history.before}&identity=${encodeURIComponent(history.identity)}`).then((r: any) => {
      setEarlier(true);
      setHistory((old: any) => ({ ...old, before: r.data.before, hasMore:r.data.hasMore, events: [...new Map([...r.data.events, ...old.events].map((event: any) => [event.id, event])).values()].slice(0, 200) }));
    }).catch((err: any) => {anchor.current=null;setError(err.message);}).finally(()=>setLoadingEarlier(false));
  };
  const latest = () => get(`${base}/history`).then((r: any) => {
    setEarlier(false);
    follow.current = true;
    setFollowing(true);
    setHistory(r.data);
  }).catch((err: any) => setError(err.message));
  const completed = history?.endedAt != null || ["success", "pass", "fail", "fault", "lost"].includes(history?.state);
  const live = history?.state === "running" && !completed && !stale;
  const model = history?.session?.model || [...history?.events || []].reverse().find((event: any) => event.model)?.model || activity.model;
  const usage = [...history?.events || []].reverse().find((event: any) => event.tokens != null)?.tokens;
  useEffect(() => {
    if (!completed) return;
    const c = new AbortController();
    get(`${base}/result`, c.signal).then((r: any) => setResult(r.data)).catch((err: any) => {
      if (!c.signal.aborted) setResult({ unavailable: err.message });
    });
    return () => c.abort();
  }, [base, completed]);
  const verdictEvent = [...history?.events || []].reverse().find((event: any) => event.report || event.tool === "StructuredOutput" && event.status !== "failed");
  const thinking = useRef(new Map<string, boolean>());
  // The full view gives the log the page: status sits on one line above it and the rest is one click away.
  const [overview, setOverview] = useState(false);
  const facts = h("dl",{className:"invocation-status"},h("div",null,h("dt",null,"Status"),h("dd",null,live?"Running":completed?"Finished":history?.state||"Connecting")),h("div",null,h("dt",null,"Elapsed"),h("dd",null,elapsed(activity.elapsedMs??(activity.status==='active'?now-Date.parse(activity.startedAt):null)))),h("div",null,h("dt",null,"Recorded spend"),h("dd",null,activity.spend.costUsd===null?'Unrecorded':money(activity.spend.costUsd))));
  const verdictLine = () => result?.report != null ? h(VerdictStatus,{value:result.report}) : h(TranscriptVerdict,{event:verdictEvent,base,identity:history?.identity,summary:true});
  const controls = h("div", { className: "history-controls" }, history?.before != null && h("button", { onClick: more,disabled:loadingEarlier }, loadingEarlier?"Loading earlier history":history.hasMore!==true?"Check earlier history":history.pageSize?`Load ${history.pageSize} earlier events`:"Load earlier events"), live && h("button", { onClick: latest, className: following ? "history-following" : undefined }, following ? "Following live" : `Follow live tail${history?.unseen ? ` (${pluralise(history.unseen, "update")})` : ""}`), completed && h("button", { onClick: latest }, "Latest"), history && h("span", {className:"history-boundary"}, `${earlier?"Earlier history  ":""}${pluralise(history.events.length,"event")} loaded`, h("small",null,loadingEarlier?"Loading earlier history":history.hasMore===false?"Start of session":history.hasMore===true?"Earlier events available":"Earlier history not checked")));
  return h(ThinkingState.Provider,{value:thinking.current},h(FileHistoryProvider,{identity:history?.identity,events:history?.events||[]},h(
    Dialog,
    { title: `${activity.label}, attempt ${activity.attempt}`, close, className: `agent-detail${overview?"":" overview-closed"}`, expand: { arc, id, full, onExpand: () => { reading.current = { following: follow.current, anchor: follow.current ? null : readingAnchor() }; } }, headingLink: activity.subject.type==='unit'?h(BackToUnit, {arc, unit:activity.unit,title:activity.subject.title,systems:activity.systems}):h('p',null,`${activity.subject.type==='job'?'Job':'Arc'} ${activity.subject.id}`) },
    full && h("div",{className:"log-bar"},facts,verdictLine(),h("button",{className:"log-overview-toggle","aria-expanded":overview,onClick:()=>setOverview(!overview)},overview?"Hide summary and details":"Summary and details"),controls),
    h(InvocationFacts,{arc,id,detail}),
    h("div",{className:"invocation-summary"},h("div",{className:"invocation-summary-text"},h(HistoryMarkdown,{text:live?(()=>{const event=[...history?.events||[]].reverse().find((event:any)=>event.type==='tool'&&event.tool!=='StructuredOutput'),data=historyJson(event?.input);return data?.description||event?.title||event?.tool||'Agent is working';})():result?.report?.summary||result?.report?.verdict?.summary||result?.report?.reasons?.[0]||recordedDecision(result?.report?.decision||historyJson(verdictEvent?.input||verdictEvent?.text)?.decision||activity.outcome||history?.state||'Connecting')})),facts),
    verdictLine(),
    error && h("p", { role: "alert" }, error),
    h("div",{className:"history-navigation"},h("div", {className:"history-heading"},"History"),h(ChangedFiles,{onJump:(id:string)=>{follow.current=false;setFollowing(false);const target=[...scroll.current.querySelectorAll('[data-event-id]')].find((node:any)=>node.dataset['eventId']===id) as HTMLElement|undefined;if(target){let parent=target.parentElement;while(parent&&parent!==scroll.current){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}scroll.current.scrollTop+=target.getBoundingClientRect().top-scroll.current.getBoundingClientRect().top;placedScroll.current=scroll.current.scrollTop;setAbove(scroll.current.scrollTop>8);}}}),
    ),
    !full && controls,
    h(
      "details",
      { className: "session-details" },
      h("summary", null, "Session details"),
      h("div", {className:"history-meta"}, h("span",null,model||"Model unrecorded"), usage != null && h("span",null,pluralise(usage,"recorded token"))),
      history?.session && h("div", null, h("p", null, `Tools: ${history.session.tools.join(", ") || "unrecorded"}`), history.session.notices.map((n:any)=>h("p",{key:n},n))),
      h("details",{className:"history-brief"},h("summary",null,"Recorded instructions"),brief?.brief?h(SeatBrief,{brief:brief.brief}):brief?h(R.Fragment,null,h(HistoryMarkdown,{text:brief.lines.join("\n")}),brief.end<brief.size&&h("button",{onClick:()=>get(`${base}/prompt?after=${brief.end}`).then((r:any)=>setBrief(r.data)).catch((err:any)=>setError(err.message))},`Next brief page (${brief.end} of ${pluralise(brief.size,"byte")})`)):h("p",null,"Reading retained brief…")),
      h(
        "details",
        { onToggle: (ev: any) => {
          if (ev.currentTarget.open && !result) get(`${base}/result`).then((r: any) => setResult(r.data)).catch((err: any) => setResult({ unavailable: err.message }));
        } },
        h("summary", null, "Raw result.json"),
        result?.raw ? h("pre", { className: "record" }, result.raw) : h("p", { className: "muted" }, result?.unavailable || "Reading retained result\u2026")
      ),
      h(TranscriptText, { base })
    ),
    h(
      "div",
      { className: `history-scroll ${above?"history-above":""}`, ref: scroll, tabIndex: 0, "aria-label": "Agent transcript", onScroll: (ev: any) => {
        if (placedScroll.current != null && Math.abs(ev.currentTarget.scrollTop - placedScroll.current) < 1) {
          placedScroll.current = null;
          return;
        }
        placedScroll.current = null;
        setAbove(ev.currentTarget.scrollTop>8);
        follow.current = ev.currentTarget.scrollHeight - ev.currentTarget.scrollTop - ev.currentTarget.clientHeight < 48;
        setFollowing(follow.current);
      } },
      h(HistoryEvents,{events:history?.events||[],live,base,identity:history?.identity,onLayout:followLayout}),
      result?.report != null ? h(VerdictCard, { value: result.report }) : h(TranscriptVerdict, { event: verdictEvent, base, identity: history?.identity, onLayout: followLayout }),
      history && !history.events.length && h("p", null, "Waiting for complete transcript records\u2026"),
      live && h("p", { className: "history-live", role: "status" }, "Agent is working", h("span", { className: "history-caret", "aria-hidden": true }))
    ),

  )));
}
function TranscriptText({ base }: any) {
  const [page, setPage] = useState<any>(null), [error, setError] = useState<any>("");
  const load = (after: any) => get(`${base}/log?source=stdout&after=${after}`).then((r: any) => setPage(r.data)).catch((e: any) => setError(e.message));
  return h("details", { onToggle: (ev: any) => {
    if (ev.currentTarget.open && !page) load(0);
  } }, h("summary", null, "Transcript text"), error && h("p", { role: "alert" }, error), page && h(R.Fragment, null, h("pre", { className: "record" }, page.text), h("p", null, `Bytes ${page.after}\u2013${page.next} of ${page.size}`), page.after > 0 && h("button", { onClick: () => load(Math.max(0, page.after - 65536)) }, "Show earlier text"), page.next < page.size && h("button", { onClick: () => load(page.next) }, "Next text page")));
}

export { AgentDetail };
