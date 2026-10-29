import { certificationEntries } from './execution.ts';
import { estateOutline, asEstateRow } from './estate-tree.ts';
import { ViewerDiagnostics } from './diagnostics.ts';
import { activityState } from './outcome.ts';
import { documentLines } from './markdown.ts';
import { promptLines } from './prompt.ts';
import { PAGE_BYTES } from './transcript.ts';
import { graph, type GraphRow } from './graph.ts';
import { activityContext, type ActivityContext } from './activity.ts';
import { type Display, type Entry, type Invocation, type LogPage, type LogRequest, pretty } from './types.ts';
import { ink, line, plain, wrap, wrapProse, type Line } from './terminal.ts';
import type { ClaudeUsage } from './usage.ts';
import { related, originalInput, SOURCES, sourceInfo, viewName, detailTitle } from './navigation.ts';
import { renderView } from './view.ts';

export const HELP = `Read-only executor observatory
1 Dependency map  2 Activity  3 Estate  4 Exceptions
Left/Right or Tab / Shift-Tab: visible panes, detail tabs, or log sources
Up/Down or j/k: select a row or scroll text  Enter: open the selected item
Esc: cancel search, clear a search term, or return to your previous location
Arrows or h/j/k/l: navigate  Enter: inspect  Esc: back
/: find without hiding content; Enter jumps to a match; n next, N previous.
Activity accepts unit:value role:value status:value and plain text
Page Up/Down: page  Home/End: beginning/end  f: follow transcript
s: next log source (Messages / Output / Stderr / Runner / Result / Input)
m: readable Messages from a raw log  b: original input from a resumed session
r / R: next / previous running item on map or Activity (wraps)
r: toggle readable / raw detail or transcript
 e: expand result previews  a: all retained invocations / latest 20 completions
 c: toggle open work / full map  w: include withdrawn/superseded/exempt estate
q or Ctrl-C: exit viewer  ?: close help
Colours repeat symbols: activity ●, wait ◇, fault !, completion ✓, history ○.
Quiet output is information, not a stall diagnosis. Mouse capture is off.
Paused logs count new bytes; Page Up loads older pages on demand.
Dependency map: follow paths downward from prerequisites to their dependents.
m on the map: next milestone. Unit labels show milestone membership.
Open milestone checkpoints stay visible; settled nodes are hidden until c shows the full map.
Walkthrough pending means due, not running. Waiting for names outstanding constraints.
The amber STOPPED badge and bold banner mean execution must resume for work to advance.
4 Exceptions also contains informational viewer notes; they do not count as faults.
Open a note for a plain-language explanation and its technical details.
Replaces / Replaced by: explicit version history, separate from prerequisite paths.
Visible versions retain lineage notes; c reveals settled versions. Select a version to highlight its lineage's activity.
Enter then Related documents opens the previous or replacement version.
Spec rN in the preview is an input revision of the same unit, not another graph node.
Paths branch and join; ╳ is a crossing, not a join. The preview names prerequisites.
Activity shows running invocations first (linked first), then linked history, other history and queued commands.
* marks invocations linked to the highlighted map node.
Other activity stays visible with muted labels. Tab opens Activity; Enter opens logs.
x: expand/restore Activity, keeping selection and search. Esc also restores the split.
g: toggle map-related / all activity. a: toggle recent / all retained history.
Agent: model invocation. Command: executed lane or shell task. Queued: pending command.
Run: execution type unavailable in retained artifacts.
Milestone labels identify recorded walkthrough and bring-up ownership.
Arc-wide: work whose recorded scope is the arc, without a specific milestone.
Graph connectors are neutral. Green checks mark completion, cyan marks selection/activity;
grey circles mark other settled history on the full map. Hidden settled prerequisites are satisfied.
Pre-delivery: an earlier baseline/audit/job checked future requirements before delivery.
This is historical context, not an executor fault or the current requirement state.
Probe passed: recorded mutation verdict confirms tests detected deliberately broken code.
Result retains the original command outcome and the explanation.
Agent models come from recorded launches/streams; explicit adapters are labelled.
Execution attempts are local counters, not row IDs or retry counts. Unit counters
advance across stage starts; repair turns can share a stage attempt.
Related documents names each destination and explains what it contains.
Estate groups vision clauses, constraints/rulings, obligations, rules and debt.
Groups are collapsed by default; context leads, then documents sort alphabetically.
Context order: project Vision, Arc scope (selected vision clauses), execution plan, intent.
Numbered entries use natural order (V-2 before V-10).
Space expands/collapses the selected group; Enter opens the document or clause.
Search includes collapsed entries and reveals their parents when a match is selected.
Arc plan: applied execution plan. Specification: unit requirements and checks.
Implementation plan: settled design. Input: exact retained agent prompt.
Recorded intent/vision provides context; the original planning conversation is not retained.`;
export function groupInvocations(rows: readonly Invocation[]): Invocation[] {
  const units = new Map<string, Map<string, Invocation[]>>();
  for (const row of rows) {
    let sessions = units.get(row.unit);
    if (!sessions) { sessions = new Map(); units.set(row.unit, sessions); }
    const group = sessions.get(row.session) ?? []; group.push(row); sessions.set(row.session, group);
  }
  return [...units.values()].flatMap((sessions) => [...sessions.values()].flat());
}
const inactive = /^(withdrawn|superseded|exempt|waived|deferred|struck|cut|retired)$/;
export function matches(entry: Entry, query: string): boolean {
  const inv = 'startedAt' in entry ? entry as Invocation : null;
  const state = inv ? activityState(inv) : entry.state;
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => {
    const m = /^(unit|role|status):(.*)$/.exec(term);
    if (m) return String(m[1] === 'status' ? state : (entry as Partial<Invocation>)[m[1] as 'unit' | 'role'] ?? '').toLowerCase().includes(m[2]!);
    return `${entry.label} ${state} ${entry.body} ${inv?.latest ?? ''} ${inv?.model ?? ''} ${inv?.context ?? ''}`.toLowerCase().includes(term);
  });
}
type Location = { detail: Entry | null; logRequest: LogRequest | null; log: LogPage | null; pane: number;
  offset: number; linkIndex: number; query: string; rawDetail: boolean; follow: boolean; seenSize: number };
export class ViewState {
  display: Display | null = null;
  usage: ClaudeUsage = { snapshot: null, pending: false, error: null };
  error: string | null = null;
  notice = '';
  readonly diagnostics = new ViewerDiagnostics();
  view = 1;
  pane = 0;
  activityExpanded = false;
  activityAll = false;
  #listQueries = new Map<string, string>();
  selected = new Map<string, string>();
  readonly expandedEstate = new Set<string>();
  detail: Entry | null = null;
  #history: Location[] = [];
  #helpLocation: Location | null = null;
  #previousQuery = '';
  #searchOffset = 0;
  offset = 0;
  linkIndex = 0;
  help = false;
  searching = false;
  query = '';
  searchFeedback = '';
  /** Shown until the next key. */
  jumpFeedback = '';
  #matchCursor: { key: string; position: number } | null = null;
  allHistory = false;
  withdrawn = false;
  expandedGraph = false;
  expandedLog = false;
  rawDetail = false;
  logRequest: LogRequest | null = null;
  log: LogPage | null = null;
  follow = true;
  seenSize = 0;
  columns = 120;
  ascii = false;
  #logLayout: { body: string[]; columns: number; ascii: boolean; mode: string; rows: Line[]; plain: string[] } | null = null;
  #detailLayout: { body: string; width: number; ascii: boolean; raw: boolean; rows: Line[] } | null = null;
  #pageMove: 'older' | 'newer' | 'home' | null = null;
  #activityContext = '';
  #rowCache = new Map<number, { display: Display; key: string; rows: Entry[] }>();

  /** What the log worker must read; local scrolling and search inside a loaded page leave it unchanged. */
  logKey(): string { return JSON.stringify(this.help ? null : { log: this.logRequest, follow: this.follow }); }
  canFollowHost(): boolean { return this.view === 1 && this.detail === null && this.logRequest === null && !this.help && !this.activityExpanded; }
  accept(display: Display): void {
    if (this.display && this.display.run.runDir !== display.run.runDir) {
      this.notice = `Following host: ${this.display.run.arc} -> ${display.run.arc}`;
      this.expandedEstate.clear();
      this.selected.clear(); this.#listQueries.clear(); this.query = '';
    }
    this.display = display; this.error = null;
  }
  logFrame(ascii = this.ascii): Line[] {
    const body = this.log?.lines ?? [`Loading ${this.logRequest ? sourceInfo(this.logRequest.source).label.toLowerCase() : 'transcript'}…`];
    const columns = Math.max(1, this.columns - 5);
    const mode = `${this.logRequest?.source}:${Boolean(this.logRequest?.raw)}`;
    let cache = this.#logLayout;
    if (!cache || cache.body !== body || cache.columns !== columns || cache.ascii !== ascii || cache.mode !== mode) {
      const rows = this.logRequest?.source === 'prompt' && !this.logRequest.raw ? promptLines(body.join('\n'), columns, ascii)
        : body.flatMap((text) => (this.logRequest && ['transcript', 'stdout', 'result'].includes(this.logRequest.source) && !this.logRequest.raw ? wrapProse : wrap)(text, columns).map((text) => line(ink(text))));
      const texts = rows.map(plain);
      cache = { body, columns, ascii, mode, rows, plain: texts };
      this.#logLayout = cache;
    }
    return cache.rows;
  }
  logLines(): string[] { this.logFrame(); return this.#logLayout!.plain; }
  detailFrame(): Line[] {
    if (!this.detail) return [];
    const width = Math.max(1, this.columns - 5);
    const body = this.detail.body; let cache = this.#detailLayout;
    if (!cache || cache.body !== body || cache.width !== width || cache.ascii !== this.ascii || cache.raw !== this.rawDetail) {
      cache = { body, width, ascii: this.ascii, raw: this.rawDetail,
        rows: this.rawDetail ? wrap(body, width).map((text) => line(ink(text))) : documentLines(body, width, this.ascii) };
      this.#detailLayout = cache;
    }
    return cache.rows;
  }
  jumpMatch(direction: 1 | -1, height: number, includeCurrent = false): void {
    if (!this.query) return;
    if (!this.detail && !this.logRequest && this.view === 1 && this.pane === 1) this.allHistory = true;
    const related = this.detail && this.pane === 1 ? this.related() : null;
    const entries = !this.logRequest && !this.detail ? (this.view === 2 ? this.estateRows(true) : this.rows()) : null;
    const texts = this.logRequest ? this.logLines() : related ? related.map((r) => `${r.label} ${r.description}`) : this.detailFrame().map(plain);
    const needle = this.query.toLowerCase();
    const positions = entries ? entries.flatMap((entry, i) => matches(entry, this.query) ? [i] : [])
      : texts.flatMap((text, i) => text.toLowerCase().includes(needle) ? [i] : []);
    if (!positions.length) { this.searchFeedback = this.logRequest ? 'No matches in this page · PgUp/PgDn loads more' : 'No matches'; return; }
    const key = `${this.view}:${this.pane}:${this.detail?.id}:${this.rawDetail}:${this.logRequest?.inv}:${this.logRequest?.source}:${this.logRequest?.raw}:${this.log?.start}:${this.log?.end}:${this.columns}:${this.query}`;
    const current = !includeCurrent && this.#matchCursor?.key === key ? this.#matchCursor.position : entries ? entries.findIndex((e) => e.id === this.selection()?.id) : related ? this.linkIndex : this.offset;
    const position = direction === 1 ? positions.find((i) => includeCurrent ? i >= current : i > current) ?? positions[0]!
      : positions.findLast((i) => includeCurrent ? i <= current : i < current) ?? positions.at(-1)!;
    if (entries) {
      const matched = entries[position]!;
      if (this.view === 2) {
        const parents = new Map(this.display?.estate.map((e) => [e.id, e.parentId]));
        const seen = new Set<string>(); let parent = matched.parentId;
        while (parent && !seen.has(parent)) { seen.add(parent); this.expandedEstate.add(parent); parent = parents.get(parent); }
      }
      this.selected.set(`${this.view}:${this.pane}`, matched.id);
    }
    else if (related) this.linkIndex = position;
    else { if (this.logRequest) this.move(0, height); this.offset = position; }
    this.#matchCursor = { key, position };
    this.searchFeedback = `Match ${positions.indexOf(position) + 1}/${positions.length}${this.logRequest ? ' in page' : ''} · n next · N previous`;
  }
  acceptLog(page: LogPage, height: number): void {
    // Worker messages are cloned. Reuse unchanged text so one-second polls do not invalidate layout.
    const previous = this.log?.lines;
    this.log = previous && previous.length === page.lines.length && previous.every((text, i) => text === page.lines[i]) ? { ...page, lines: previous } : page;
    if (this.follow || this.#pageMove === 'older') this.offset = Math.max(0, this.logLines().length - height);
    else if (this.#pageMove === 'newer' || this.#pageMove === 'home') this.offset = 0;
    this.#pageMove = null;
    if (this.follow) this.seenSize = page.size;
  }
  // The two internal layouts share a single four-section navigation row.
  section(): number {
    const pane = this.detail || this.logRequest ? this.#history[0]?.pane ?? this.pane : this.help ? this.#helpLocation?.pane ?? this.pane : this.pane;
    return this.view === 2 ? 2 : pane === 2 ? 3 : pane;
  }
  sectionName(): string { return ['Dependency map', 'Activity', 'Estate', 'Exceptions'][this.section()]!; }
  private selectSection(section: number): void {
    const location = this.#history[0];
    this.#listQueries.set(`${this.view}:${location?.pane ?? this.pane}`, location?.query ?? this.query);
    this.view = section === 2 ? 2 : 1; this.pane = section === 3 ? 2 : section === 2 ? 0 : section;
    if (section !== 1) this.activityExpanded = false;
    this.detail = null; this.#history = []; this.logRequest = null; this.log = null; this.offset = 0;
    this.query = this.#listQueries.get(`${this.view}:${this.pane}`) ?? '';
  }
  listQuery(pane: number): string { return pane === this.pane ? this.query : this.#listQueries.get(`${this.view}:${pane}`) ?? ''; }
  private setPane(pane: number): void {
    if (this.detail) this.query = '';
    else {
      this.#listQueries.set(`${this.view}:${this.pane}`, this.query);
      this.query = this.#listQueries.get(`${this.view}:${pane}`) ?? '';
    }
    this.pane = pane;
  }
  estateRows(all = false) {
    const entries = this.display?.estate ?? [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const visible = entries.filter((entry) => {
      if (this.withdrawn) return true;
      let current: Entry | undefined = entry; const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (inactive.test(current.state) || (current.kind === 'debt-item' && current.state !== 'open')) return false;
        seen.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return true;
    });
    return estateOutline(visible, all ? undefined : this.expandedEstate);
  }
  rows(pane = this.pane): Entry[] {
    const d = this.display;
    const observationErrors: Entry[] = this.error ? [{ id: 'observation-error', label: 'Observation error (display is stale)', state: 'failed', body: this.error, links: [], provenance: `last valid ${d?.at ?? 'unavailable'}` }] : [];
    if (this.view === 1 && pane === 2) return [...(d?.exceptions ?? []), ...observationErrors, ...this.diagnostics.entries()];
    if (!d) return [];
    const context = this.view === 1 && pane === 1 ? this.activityContext() : null;
    const key = `${this.view}:${this.expandedGraph}:${this.allHistory}:${this.withdrawn}:${this.activityAll}:${context?.id}:${this.view === 2 ? [...this.expandedEstate].join(',') : ''}`;
    const cached = this.#rowCache.get(pane);
    if (cached?.display === d && cached.key === key) return cached.rows;
    let rows: Entry[];
    if (this.view === 2) rows = this.estateRows();
    else if (pane === 1) {
      const running = d.invocations.filter((i) => i.endedAt === null);
      const history = d.invocations.filter((i) => i.endedAt !== null);
      const recent = new Set(history.slice(0, 20).map((i) => i.id));
      const prioritize = (items: Invocation[]) => context
        ? [...groupInvocations(items.filter((i) => context.invocations.has(i.id))), ...groupInvocations(items.filter((i) => !context.invocations.has(i.id)))]
        : groupInvocations(items);
      rows = [...certificationEntries(d, context?.id), ...prioritize(running), ...prioritize(this.allHistory ? history : history.filter((i) => recent.has(i.id) || context?.invocations.has(i.id)))];
      if (this.view === 1) rows.push(...d.status.commands.pending.map((c) => ({ id: `command:${c.id}`, label: `Command ${c.id}`, state: 'waiting', body: pretty(c), links: [], provenance: 'command queue' })));
    } else if (pane === 2) rows = d.exceptions;
    else rows = graph(d, this.expandedGraph);
    this.#rowCache.set(pane, { display: d, key, rows });
    return rows;
  }
  selection(pane = this.pane): Entry | null {
    if (this.view === 1 && pane === 1) {
      const context = `${this.display?.run.runDir}:${this.activityContext()?.id ?? ''}`;
      if (context !== this.#activityContext) { if (!this.activityAll) this.selected.delete('1:1'); this.#activityContext = context; }
    }
    const rows = this.rows(pane); const key = `${this.view}:${pane}`;
    const row = rows.find((r) => r.id === this.selected.get(key)) ?? rows[0] ?? null;
    if (row) this.selected.set(key, row.id);
    return row;
  }
  activityContext(): ActivityContext | null {
    if (this.view !== 1 || this.activityAll || !this.display) return null;
    const node = this.selection(0) as GraphRow | null;
    return node ? activityContext(this.display, node) : null;
  }
  move(delta: number, height: number): void {
    this.#matchCursor = null;
    if (this.logRequest) {
      // No page loaded yet (or only a placeholder): leaving follow now would request the whole file.
      if (!this.log || this.log.error) return;
      if (this.follow) { this.follow = false; this.seenSize = this.log?.size ?? 0; this.logRequest.before = this.log?.end ?? null; this.logRequest.after = this.log?.start ?? 0; }
      const end = Math.max(0, this.logLines().length - height);
      if (delta < 0 && this.offset === 0 && this.log && this.log.start > 0) {
        delete this.logRequest.after; this.logRequest.before = this.log.start; this.#pageMove = 'older';

      } else if (delta > 0 && this.offset >= end && this.log && this.log.end < this.log.size) {
        this.logRequest.after = this.log.end; this.logRequest.before = Math.min(this.log.size, this.log.end + 64 * 1024); this.#pageMove = 'newer';
      } else this.offset = Math.max(0, Math.min(end, this.offset + delta));
    } else if (this.detail || this.help) {
      if (this.pane === 1 && this.detail) this.linkIndex = Math.max(0, Math.min(this.related().length - 1, this.linkIndex + delta));
      else this.offset = Math.max(0, this.offset + delta);
    } else {
      const rows = this.rows(); const row = this.selection();
      const index = Math.max(0, rows.findIndex((r) => r.id === row?.id));
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
      if (next) this.selected.set(`${this.view}:${this.pane}`, next.id);
    }
  }
  jumpRunning(direction: 1 | -1): void {
    const selected = this.selection(); const rows = this.rows();
    const running = rows.flatMap((row, i) => {
      const active = this.pane === 1 ? 'endedAt' in row && (row as Invocation).endedAt === null
        : row.kind === 'unit-status' ? ['running', 'preparing'].includes(row.state)
        : row.kind === 'milestone-status' && this.display!.status.milestones.find((m) => m.id === row.id)!.walks.some((walk) => walk.outcome === null);
      return active ? [i] : [];
    });
    if (!running.length) { this.jumpFeedback = `No running items in ${this.pane === 0 ? 'the dependency map' : 'Activity'}`; return; }
    const current = rows.findIndex((row) => row.id === selected?.id);
    const index = direction === 1 ? running.find((i) => i > current) ?? running[0]!
      : running.findLast((i) => i < current) ?? running.at(-1)!;
    this.selected.set(`1:${this.pane}`, rows[index]!.id);
  }
  related() { return (this.detail ? related(this.detail, this.display) : []); }
  location(): Location {
    return { detail: this.detail, logRequest: this.logRequest ? { ...this.logRequest } : null, log: this.log, pane: this.pane,
      offset: this.offset, linkIndex: this.linkIndex, query: this.query, rawDetail: this.rawDetail, follow: this.follow, seenSize: this.seenSize };
  }
  restore(location: Location): void { Object.assign(this, location); this.#pageMove = null; }
  backLabel(): string {
    const location = this.#history.at(-1);
    return location?.detail ? detailTitle(location.detail) : location?.logRequest ? `${sourceInfo(location.logRequest.source).label}${this.display?.invocations.find((i) => i.id === location.logRequest!.inv)?.inputKind === 'repair' ? ' (repair)' : ''}` : this.view === 1 ? ['Dependency map', 'Activity', 'Exceptions'][location?.pane ?? 0]! : viewName(this.view);
  }
  private enter(entry: Entry): void {
    this.#history.push(this.location()); this.detail = entry; this.logRequest = null; this.log = null;
    this.rawDetail = false; this.offset = 0; this.pane = 0; this.linkIndex = 0; this.query = '';
  }
  private enterLog(inv: string, source: LogRequest['source']): void {
    this.#history.push(this.location()); this.detail = null;
    this.logRequest = { inv, source, before: source === 'prompt' ? PAGE_BYTES : null, ...(source === 'prompt' ? { after: 0 } : {}), expanded: this.expandedLog };
    this.#pageMove = null; this.log = null; this.follow = sourceInfo(source).follow; this.offset = 0; this.pane = 0; this.query = ''; this.seenSize = 0;
  }
  cycleSource(delta: number): void {
    if (!this.logRequest) return;
    const index = SOURCES.findIndex((s) => s.id === this.logRequest!.source);
    this.logRequest.source = SOURCES[(index + delta + SOURCES.length) % SOURCES.length]!.id;
    this.logRequest.before = this.logRequest.source === 'prompt' ? PAGE_BYTES : null; delete this.logRequest.after;
    if (this.logRequest.source === 'prompt') this.logRequest.after = 0;
    this.logRequest.raw = false;
    this.#pageMove = null; this.follow = sourceInfo(this.logRequest.source).follow; this.log = null; this.offset = 0; this.query = ''; this.seenSize = 0;
  }
  open(): void {
    if (this.help) return;
    if (this.detail && this.pane === 1) {
      const row = this.related()[this.linkIndex];
      if (row?.target.type === 'entry') this.enter(row.target.entry);
      else if (row?.target.type === 'log') this.enterLog(row.target.inv, row.target.source);
      return;
    }
    if (this.detail || this.logRequest) return;
    const row = this.selection(); if (!row) return;
    if (this.display?.invocations.some((i) => i.id === row.id)) this.enterLog(row.id, 'transcript');
    else this.enter(row);
  }
  key(name: string, text: string, height: number): boolean {
    this.jumpFeedback = '';
    if (this.searching) {
      if (name === 'return' || name === 'escape') {
        this.searching = false;
        if (name === 'escape') { this.query = this.#previousQuery; this.offset = this.#searchOffset; }
        else this.jumpMatch(1, height, true);
      }
      else if (name === 'backspace') this.query = this.query.slice(0, -1);
      else if (text && !/[\x00-\x1f\x7f]/.test(text)) this.query += text;
      return false;
    }
    if (text === 'q') return true;
    if (text === '?' || (this.help && name === 'escape')) {
      if (this.help) { this.help = false; if (this.#helpLocation) this.restore(this.#helpLocation); this.#helpLocation = null; }
      else { this.#helpLocation = this.location(); this.help = true; this.offset = 0; this.query = ''; }
      return false;
    }
    if (this.help) {
      if (name === 'up' || text === 'k') this.offset = Math.max(0, this.offset - 1);
      if (name === 'down' || text === 'j') this.offset++;
      if (name === 'pageup') this.offset = Math.max(0, this.offset - height);
      if (name === 'pagedown') this.offset += height;
      if (name === 'home') this.offset = 0;
      if (name === 'end') this.offset = Number.MAX_SAFE_INTEGER;
      return false;
    }
    if (name === 'escape') {
      if (this.query) { this.query = ''; this.searchFeedback = ''; this.#matchCursor = null; return false; }
      if (!this.detail && !this.logRequest && this.activityExpanded) { this.activityExpanded = false; return false; }
      const previous = this.#history.pop();
      if (previous) this.restore(previous);
      else { this.detail = null; this.logRequest = null; this.log = null; this.offset = 0; this.pane = 0; this.rawDetail = false; }
      return false;
    }
    if (['1', '2', '3', '4'].includes(text)) { this.selectSection(Number(text) - 1); return false; }
    if (!this.detail && !this.logRequest && this.view === 1) {
      if (text === 'x' && this.pane !== 2) { this.setPane(1); this.activityExpanded = !this.activityExpanded; return false; }
      if (text === 'g' && this.pane === 1) {
        this.activityAll = !this.activityAll;
        this.#activityContext = `${this.display?.run.runDir}:${this.activityContext()?.id ?? ''}`; return false;
      }
    }
    if ((name === 'space' || text === ' ') && this.view === 2 && !this.detail && !this.logRequest) {
      const selected = asEstateRow(this.selection());
      if (selected?.childCount) {
        if (this.expandedEstate.has(selected.id)) this.expandedEstate.delete(selected.id); else this.expandedEstate.add(selected.id);
        this.#matchCursor = null;
      }
      return false;
    }
    if (text === 'n' || text === 'N') { this.jumpMatch(text === 'n' ? 1 : -1, height); return false; }
    if (text === '/') { this.searchFeedback = ''; this.#matchCursor = null; this.searching = true; this.#previousQuery = this.query; this.#searchOffset = this.offset; this.query = ''; return false; }
    if ((name === 'tab' || name === 'backtab') && this.logRequest) { this.cycleSource(name === 'backtab' ? -1 : 1); return false; }
    if (name === 'tab' || name === 'backtab') {
      if (this.detail) this.setPane((this.pane + 1) % 2);
      else this.selectSection((this.section() + (name === 'backtab' ? 3 : 1)) % 4);
      return false;
    }
    if ((text === 'r' || text === 'R') && !this.detail && !this.logRequest && this.view === 1 && this.pane < 2) {
      this.jumpRunning(text === 'r' ? 1 : -1); return false;
    }
    if (text === 'r' && !this.help) {
      if (this.detail && this.pane === 0) { this.rawDetail = !this.rawDetail; this.offset = 0; }
      else if (this.logRequest && ['transcript', 'stdout', 'result', 'prompt'].includes(this.logRequest.source)) {
        this.logRequest.raw = !this.logRequest.raw; this.log = null; this.offset = 0;
      }
    }
    if (text === 'a' && !this.detail && !this.logRequest && (this.view === 1 && this.pane === 1)) this.allHistory = !this.allHistory;
    if (text === 'w' && this.view === 2 && !this.detail && !this.logRequest) this.withdrawn = !this.withdrawn;
    if (text === 'c' && this.view === 1 && !this.detail && !this.logRequest) this.expandedGraph = !this.expandedGraph;
    if (text === 'e' && this.logRequest && ['transcript', 'stdout'].includes(this.logRequest.source)) { this.expandedLog = !this.expandedLog; this.logRequest.expanded = this.expandedLog; }
    if (text === 's' && this.logRequest) this.cycleSource(1);
    if (text === 'm' && !this.logRequest && !this.detail && this.view === 1 && this.pane === 0) {
      const milestones = this.rows().filter((e) => e.kind === 'milestone-status');
      const index = milestones.findIndex((e) => e.id === this.selection()?.id);
      const next = milestones[(index + 1) % milestones.length];
      if (next) this.selected.set('1:0', next.id);
    }
    if (text === 'm' && this.logRequest) this.cycleSource(-SOURCES.findIndex((s) => s.id === this.logRequest!.source));
    if (text === 'b' && this.logRequest?.source === 'prompt') {
      const initial = originalInput(this.display?.invocations.find((inv) => inv.id === this.logRequest!.inv), this.display);
      if (initial) this.enterLog(initial.id, 'prompt');
    }
    if ((text === 'f' && this.logRequest) || name === 'end') {
      if (this.logRequest) { this.follow = true; this.logRequest.before = null; delete this.logRequest.after; }
      else if (this.detail && this.pane === 1) this.linkIndex = Math.max(0, this.related().length - 1);
      else if (this.detail || this.help) this.offset = Number.MAX_SAFE_INTEGER;
      else this.move(Number.MAX_SAFE_INTEGER, height);
    } else if (name === 'home') {
      if (this.logRequest) { this.follow = false; this.seenSize = this.log?.size ?? 0; this.logRequest.after = 0; this.logRequest.before = Math.min(64 * 1024, this.log?.size ?? 64 * 1024); this.#pageMove = 'home'; }
      this.offset = 0; if (this.detail && this.pane === 1) this.linkIndex = 0; if (!this.detail && !this.logRequest) this.move(-Number.MAX_SAFE_INTEGER, height);
    } else if (name === 'up' || text === 'k') this.move(-1, height);
    else if (name === 'down' || text === 'j') this.move(1, height);
    else if (name === 'pageup') this.move(-height, height);
    else if (name === 'pagedown') this.move(height, height);
    else if (name === 'left' || text === 'h') { if (this.logRequest) this.cycleSource(-1); else { if (this.detail) this.setPane(Math.max(0, this.pane - 1)); else this.selectSection(Math.max(0, this.section() - 1)); } }
    else if (name === 'right' || text === 'l') { if (this.logRequest) this.cycleSource(1); else { if (this.detail) this.setPane(Math.min(1, this.pane + 1)); else this.selectSection(Math.min(3, this.section() + 1)); } }
    else if (name === 'return') this.open();
    return false;
  }

  renderFrame(columns: number, rows: number, ascii: boolean): Line[] {
    this.columns = columns; this.ascii = ascii;
    return renderView(this, columns, rows, ascii);
  }
  render(columns: number, rows: number, ascii: boolean): string[] {
    return this.renderFrame(columns, rows, ascii).map(plain);
  }
}
