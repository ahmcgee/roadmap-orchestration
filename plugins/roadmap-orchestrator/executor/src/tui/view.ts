import { estateRowLabel, asEstateRow } from './estate-tree.ts';
import { scopeLabel } from './activity.ts';
import type { ViewState } from './state.ts';
import { usageLines } from './usage-view.ts';
import { detailTitle, hints, originalInput, sourceInfo, SOURCES } from './navigation.ts';
import { HELP } from './state.ts';
import { summary } from './projection.ts';
import type { Entry, Invocation } from './types.ts';
import { activityState, assessmentExplanation } from './outcome.ts';
import { executionSummary, unitWaitReason } from './execution.ts';
import { modelLabel } from './models.ts';
import { milestoneProgress, milestonePhase } from './milestones.ts';
import { dependencyDrawing } from './graph-view.ts';
import { settledNodeIds, type GraphRow } from './graph.ts';
import { clip, fit, ink, line, pad, plain, stateTone, symbol, width, wrap, type Line, type Tone } from './terminal.ts';

// Ten rows of persistent context, including the visible pane/source tabs, four of selection detail, one of keyboard hints.
export const contentHeight = (rows: number): number => Math.max(1, rows - 17);
const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
};
const invocation = (entry: Entry | null): Invocation | null => entry && 'startedAt' in entry ? entry as Invocation : null;

/** Framing and style are trusted; every string from the observed run remains inert text. */
export function renderView(ui: ViewState, columns: number, rows: number, ascii: boolean): Line[] {
  const w = Math.max(1, columns - 1); const d = ui.display; const s = d?.status;
  const dot = ascii ? ' | ' : ' · ';
  const chars = ascii ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', arrow: '>', link: '|-' }
    : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', arrow: '▸', link: '├─' };
  const edge = (title: string, right: string, size: number, tone: Tone, bottom = false, emphasis = false): Line => {
    const available = Math.max(0, size - 2);
    const suffix = clip(right ? ` ${right} ` : '', Math.floor(available * 0.45));
    const label = clip(title ? ` ${title} ` : '', Math.max(0, available - width(suffix)));
    return line(ink(bottom ? chars.bl : chars.tl, tone), ink(label, tone, !bottom || emphasis),
      ink(chars.h.repeat(Math.max(0, available - width(label) - width(suffix))), tone), ink(suffix, tone), ink(bottom ? chars.br : chars.tr, tone));
  };
  const panel = (title: string, right: string, contents: Line[], size: number, height: number, focused = false, tone: Tone = 'border', foot = ''): Line[] => {
    const border = focused ? 'accent' : tone;
    return [edge(`${focused ? chars.arrow + ' ' : ''}${title}`, right, size, border),
      ...Array.from({ length: Math.max(0, height - 2) }, (_, i) => [ink(chars.v, border), ink(' '), ...fit(contents[i] ?? [], Math.max(0, size - 4)), ink(' '), ink(chars.v, border)]),
      edge(foot, '', size, border, true)].slice(0, height);
  };
  const join = (left: Line[], right: Line[], leftWidth: number, count: number): Line[] => Array.from({ length: count }, (_, i) => [...fit(left[i] ?? [], leftWidth), ink(' '), ...(right[i] ?? [])]);
  const badge = (state: string, meaning = state): Line => line(ink(`${symbol(meaning, ascii)} ${state}`, stateTone(meaning), true));
  const selectedRow = (row: Line, selected: boolean, size: number): Line => fit(row, size).map((part) => ({ ...part, selected }));
  const now = Date.now();
  const clock = new Date(now).toISOString().slice(11, 19);
  const brand = line(ink(' ROADMAP', 'strong', true), ink(`${dot}executor observatory`, 'muted'));
  const clockLabel = `READ ONLY${dot}${clock} `;
  const title = [...fit(brand, Math.max(0, w - width(clockLabel))), ink(clockLabel, 'muted')];
  const noteCount = ui.diagnostics.entries().length;
  const tabs = ['Dependency map', 'Activity', 'Estate', noteCount ? 'Exceptions & notes' : 'Exceptions'].flatMap((label, section) => {
    const active = ui.section() === section;
    return [{ ...ink(` ${active ? '[' : ' '}${section + 1} ${label}${active ? ']' : ' '} `, active ? 'accent' : 'muted', active), selected: active }];
  });
  const heartbeat = s?.run.heartbeatAt ? elapsed(now - Date.parse(s.run.heartbeatAt)) : 'unavailable';
  const execution = d ? executionSummary(d) : null;
  const status = s ? line(ink('NOW ', 'muted'), ...badge(execution!.state === 'stopped' ? 'STOPPED' : execution!.state, execution!.state), ink('    EXECUTOR ', 'muted'), ...badge(s.run.owner.state), ink('    HEARTBEAT ', 'muted'), ink(heartbeat))
    : line(ink('Waiting for an executor snapshot', 'wait'));
  const merged = s?.units.filter((unit) => unit.state === 'merged').length ?? 0;
  const total = s?.units.length ?? 0;
  const meterSize = columns >= 100 ? 16 : 8;
  const filled = total ? Math.floor(meterSize * merged / total) : 0;
  const progress = line(ink((ascii ? '#' : '━').repeat(filled), 'good'), ink((ascii ? '-' : '┄').repeat(meterSize - filled), 'border'),
    ink(` ${merged}/${total} merged`, 'strong'), ink(dot, 'muted'), ink(execution?.counts ?? '0 agents · 0 commands', execution?.state === 'running' ? 'accent' : 'muted'), ...(s?.milestones.length ? [ink(`${dot}${columns >= 100 ? '' : 'MS '}${s.milestones.filter((m) => m.state === 'settled').length}/${s.milestones.length}${columns >= 100 ? ' milestones settled' : ''}`, 'muted')] : []), ink(`${dot}next `, 'muted'),
    ink(s?.milestones.find((m) => m.state !== 'settled')?.id ?? s?.target?.nextMilestone?.obligation ?? 'none'));
  const stoppedBanner = execution?.state === 'stopped' && !ui.error && !ui.notice;
  const banner = ui.error ? `! STALE since ${d?.at ?? 'startup'}: ${ui.error}` : ui.notice || execution?.detail || 'Waiting for snapshot';
  const runPanel = panel(d?.run.arc ?? 'Executor', '', [status, progress, ...usageLines(ui.usage, w - 4, ascii, now)], w, 6);
  runPanel[5] = edge(stoppedBanner ? `${symbol('stopped', ascii)} ${banner}` : banner, '', w, ui.error ? 'fault' : stoppedBanner || ui.notice || execution?.state === 'waiting' ? 'wait' : execution?.state === 'running' ? 'accent' : 'muted', true, stoppedBanner);
  const faultCount = d?.exceptions.filter((e) => /fail|fault|lost|malformed|refusal/.test(e.state)).length ?? 0;
  const exceptionCount = (d?.exceptions.length ?? 0) + Number(ui.error !== null);
  const exceptions = [
    ['owner', s?.needsUser.filter((n) => n.blocking).length ?? 0, 'wait'], ['backends', s?.parkedBackends.length ?? 0, 'wait'],
    ['holds', s?.holds.length ?? 0, 'wait'], ['faults', faultCount, 'fault'], ['observer', Number(ui.error !== null), 'fault'],
  ] as const;
  const strip = line(ink(` ${ui.view === 1 && ui.pane === 2 ? chars.arrow : ' '} Exceptions ${exceptionCount} `, (d?.exceptions.length || ui.error) ? 'wait' : 'muted', true),
    ...exceptions.flatMap(([label, count, tone]) => [ink(`${dot}${label} `, 'muted'), ink(String(count), count ? tone : 'muted', count > 0)]));
  const inner = contentHeight(rows); const bodyHeight = inner + 2;
  const window = (lines: Line[]): Line[] => { ui.offset = Math.min(ui.offset, Math.max(0, lines.length - inner)); return lines.slice(ui.offset, ui.offset + inner); };

  let graphVisible = new Set<string>();
  const dependencyLabel = (id: string): string => d && !ui.expandedGraph && settledNodeIds(d).has(id) ? `${id} ${ascii ? '+' : '✓'}` : graphVisible.has(id) ? id : `${id} [offscreen]`;
  const list = (pane: number, size: number, height: number, name: string): Line[] => {
    const entries = ui.rows(pane); const selection = ui.selection(pane);
    const index = entries.findIndex((e) => e.id === selection?.id); const room = Math.max(1, size - 4);
    if (ui.view === 1 && pane === 0 && d) {
      const drawing = dependencyDrawing(entries as GraphRow[], d, selection?.id, ascii, room);
      const roomHeight = Math.max(1, height - 2);
      const selectedY = drawing.positions.get(selection?.id ?? '') ?? 0;
      const node = selection as GraphRow | undefined;
      const annotated = Boolean(node?.replaces || node?.replacedBy || node?.redirected || node?.waitReason);
      // At small heights, keep the selected node's relationship note visible beneath it.
      const aboveSelection = Math.floor((roomHeight - Number(annotated)) / 2);
      const top = Math.max(0, Math.min(Math.max(0, drawing.length - roomHeight), selectedY - aboveSelection));
      graphVisible = new Set([...drawing.positions].filter(([, y]) => y >= top && y < top + roomHeight).map(([id]) => id));
      const below = Math.max(0, drawing.length - top - roomHeight);
      const direction = !ascii && d.status.edges.some((edge) => edge.type !== 'after') ? '↓ flow down · ⇣ condition · ⇓ milestone' : `${ascii ? 'v' : '↓'} prerequisite to dependent`;
      const hidden = ui.expandedGraph ? 0 : settledNodeIds(d).size;
      const foot = `${hidden ? `${hidden} settled hidden${dot}c full${dot}` : ''}${direction}${drawing.hiddenTracks ? `${dot}${drawing.hiddenTracks} tracks offscreen` : ''}${drawing.crossings ? (ascii ? ' | x crossing' : ' · ╳ crossing') : ''}${top || below ? `${dot}${top} above / ${below} below` : ''}`;
      return panel(`${name}${hidden ? `${dot}${hidden} settled hidden` : ''}`, `${entries.length} nodes`, drawing.length ? drawing.window(top, roomHeight) : [line(ink(hidden ? 'All work settled · c shows full map' : 'No work recorded', 'muted'))], size, height, ui.pane === 0, 'border', foot);
    }
    const activity = ui.view === 1 && pane === 1;
    const context = ui.view === 1 && pane === 1 ? ui.activityContext() : null;
    const linkedCount = context ? entries.filter((e) => context.invocations.has(e.id)).length : 0;
    const table = activity && ui.activityExpanded && room >= 65;
    const estateTable = ui.view === 2 && room >= 65;
    const rowHeight = (_entry: Entry) => activity ? 2 : 1;
    const roomHeight = Math.max(1, height - 2 - Number(table || estateTable) - Number(activity));
    let start = Math.max(0, index); let used = entries[start] ? rowHeight(entries[start]!) : 0;
    while (start > 0 && used + rowHeight(entries[start - 1]!) <= roomHeight) { start--; used += rowHeight(entries[start]!); }
    const visible: Entry[] = []; used = 0;
    for (const entry of entries.slice(start)) { const count = rowHeight(entry); if (visible.length && used + count > roomHeight) break; visible.push(entry); used += count; }
    const content: Line[] = [];
    if (context) content.push(line(ink(linkedCount ? `* ${linkedCount} linked to map` : 'No recorded activity for map selection', linkedCount ? 'accent' : 'muted'),
      ink(linkedCount ? `${dot}others follow` : '', 'muted')));
    else if (activity) content.push(line(ink(ui.activityAll ? 'All activity' : 'No map selection', 'accent'), ink(`${dot}${ui.allHistory ? 'all retained history' : 'running + 20 recent'}`, 'muted')));
    const unitWidth = table ? Math.min(24, Math.floor(room * 0.20)) : Math.min(20, Math.floor(room * 0.42));
    const roleWidth = table ? Math.min(16, Math.floor(room * 0.16)) : Math.max(8, room - unitWidth - 12);
    const modelWidth = Math.min(24, Math.floor(room * 0.20));
    if (table) content.push(line(ink(`   ${pad('TYPE', 7)} ${pad('UNIT / JOB', unitWidth)} ${pad('ROLE', roleWidth)} ${pad('MODEL', modelWidth)} ${pad('STATUS', 14)} TIME`, 'muted')));
    // Supporting text sits under the unit/job column, with a child connector to its own row.
    const detailPrefix = `${' '.repeat(3 + 7 + 1)}${ascii ? '\\-' : '└─'} `;
    const documentWidth = Math.floor(room * 0.45);
    if (estateTable) content.push(line(ink(`  ${pad('DOCUMENT / ENTRY', documentWidth)} ${pad('STATE', 14)} PROVENANCE`, 'muted')));
    visible.forEach((e, i) => {
      const active = ui.pane === pane && e.id === selection?.id;
      const linked = context?.invocations.has(e.id) ?? false;
      const labelTone = linked ? 'accent' : context ? 'muted' : 'strong';
      const marker = ink(`${active ? chars.arrow : ' '}${activity ? linked ? '* ' : '  ' : ' '}`, active || linked ? 'accent' : 'muted', active || linked);
      const inv = invocation(e);
      let row: Line;
      if (inv) {
        const state = activityState(inv);
        const previous = invocation(visible[i - 1] ?? null);
        const nested = previous?.unit === inv.unit && previous.session === inv.session && (previous.endedAt === null) === (inv.endedAt === null);
        const unit = nested ? `${chars.link} ${inv.unit}` : inv.unit;
        const duration = elapsed(Date.parse(inv.endedAt ?? d!.at) - Date.parse(inv.startedAt));
        const kind = inv.execution === 'agent' ? 'Agent' : inv.execution === 'command' ? 'Command' : 'Run';
        const type = ink(pad(kind, 7), context ? labelTone : 'muted', linked);
        row = table ? line(marker, type, ' ', ink(pad(unit, unitWidth), labelTone, active || linked), ' ', ink(pad(inv.role, roleWidth), context ? labelTone : 'text', linked), ' ', ink(pad(inv.execution === 'agent' ? modelLabel(inv) : '-', modelWidth), 'muted'), ' ',
          ink(pad(`${symbol(state, ascii)} ${state}`, 14), stateTone(state)), ' ', ink(duration, 'muted'))
          : line(marker, type, ' ', ink(pad(unit, unitWidth), labelTone, active || linked), ' ', ink(pad(inv.role, roleWidth), context ? labelTone : 'text', linked));
        content.push(selectedRow(row, active, room));
        const session = inv.session ? `${inv.session.slice(0, 8)}${dot}` : '';
        const latest = `${inv.context ? inv.context + dot : ''}${inv.inputKind === 'repair' ? 'Repair turn · ' : inv.inputKind === 'resume' ? 'Resumed session · ' : ''}${inv.latest || (inv.endedAt ? 'No recorded output' : 'Awaiting output')}`;
        const scope = scopeLabel(inv) && (inv.milestone || !inv.context) ? [ink(`${scopeLabel(inv)}${dot}`, 'violet')] : [];
        const detail = table ? line(ink(detailPrefix, 'muted'), ...scope, ink(`${session}${latest}`, 'muted'))
          : line(ink(detailPrefix, 'muted'), ...scope, ink(`${symbol(state, ascii)} ${state}`, stateTone(state)), ink(`${dot}${inv.execution === 'agent' ? modelLabel(inv) + dot : ''}${duration}${dot}${latest}`, 'muted'));
        content.push(selectedRow(detail, active, room));
        return;
      }
      const label = ui.view === 2 ? estateRowLabel(e, ascii) : e.label;
      if (estateTable) {
        row = line(marker, ink(pad(label, documentWidth), 'strong', active), ' ', ink(pad(e.state, 14), stateTone(e.state)), ' ', ink(e.provenance, 'muted'));
      } else {
        const stateWidth = Math.min(15, Math.floor(room / 4));
        row = line(marker, ...(activity ? [ink('Queued  ', 'wait')] : []), ink(pad(label, Math.max(0, room - stateWidth - 3 - (activity ? 9 : 0))), labelTone, active), ' ', ink(pad(e.state, stateWidth), stateTone(e.state)));
      }
      content.push(selectedRow(row, active, room));
      if (activity) content.push(line(ink(`${detailPrefix}${clip(summary(e.body), Math.max(0, room - width(detailPrefix)))}`, 'muted')));
    });
    if (!entries.length) content.push(line(ink(pane === 2 ? 'All clear. No exceptions recorded.' : 'No entries yet', 'muted')));
    const range = entries.length ? `${start + 1}-${start + visible.length}/${entries.length}` : '0 items';
    const overflow = start > 0 || start + visible.length < entries.length ? `${start} above${dot}${entries.length - start - visible.length} below` : '';
    const foot = activity && ui.activityExpanded ? `${ui.allHistory ? 'All history' : 'Recent history'}${dot}a toggle${overflow ? dot + overflow : ''}` : overflow;
    return panel(context ? `${name}${dot}${context.label}` : name, range, content, size, height, ui.pane === pane, ui.view === 2 ? 'violet' : 'border', foot);
  };

  const navTab = (label: string, active: boolean): Line => line(ink(' '), { ...ink(active ? `[${label}]` : ` ${label} `, active ? 'accent' : 'muted', active), selected: active });
  let navigation: Line;
  if (ui.help) navigation = line(ink(' Help', 'strong', true), ink(' · ↑↓ scroll · Esc or ? returns to your previous location', 'muted'));
  else if (ui.logRequest) navigation = [...SOURCES.flatMap((source) => navTab(source.label, source.id === ui.logRequest!.source)), ink('  ←→ source', 'muted')];
  else if (ui.detail) navigation = [...navTab(ui.detail.kind === 'unit-status' ? 'Status' : 'Document', ui.pane === 0), ...navTab(`Related documents (${ui.related().length})`, ui.pane === 1), ink('  ←→ / Tab', 'muted')];
  else if (ui.view === 1 && ui.activityExpanded) navigation = line(ink(' Activity expanded', 'accent', true), ink(`${dot}x restore${dot}g ${ui.activityAll ? 'map focus' : 'all activity'}${dot}a ${ui.allHistory ? 'recent only' : 'all history'}`, 'muted'));
  else if (ui.view === 1) navigation = line(ink(ui.pane === 0 ? s?.milestones.length ? ` Milestones: ${s.milestones.map((m) => `${m.id} ${milestonePhase(m)}`).join(' · ')} · m next milestone` : ' Milestones: not defined for this run' : ui.pane === 1 ? ' Activity · x expand · g ' + (ui.activityAll ? 'map focus' : 'all activity') : ` Exceptions: ${exceptionCount}${noteCount ? ` · ${noteCount} viewer note` : ''}`, 'muted'), ink(' · ←→ / Tab section', 'muted'));
  else navigation = line(ink(` Estate: ${ui.withdrawn ? 'all recorded entries' : 'active entries'}`, 'muted'), ink(` · w ${ui.withdrawn ? 'hide inactive' : 'include inactive'}`, 'accent'));
  if (ui.searching || ui.query) navigation = line(ink(` / ${ui.query}${ui.searching ? '_  Enter find · Esc cancel' : '  ' + (ui.searchFeedback || 'n next · N previous') + ' · Esc clear'}`, 'wait'));
  if (ascii) navigation = navigation.map((part) => ({ ...part, text: part.text.replace(/←→/g, 'h/l').replace(/↑↓/g, 'j/k').replace(/·/g, '|') }));

  let body: Line[];
  if (ui.help) body = panel('Help', '? close', window(wrap(HELP, w - 4).map((text) => line(ink(text)))), w, bodyHeight, true);
  else if (ui.logRequest) {
    const lines = ui.logFrame(ascii);
    if (ui.follow) ui.offset = Math.max(0, lines.length - inner);
    ui.offset = Math.min(ui.offset, Math.max(0, lines.length - inner));
    const current = d?.invocations.find((inv) => inv.id === ui.logRequest!.inv);
    const staticSource = !sourceInfo(ui.logRequest.source).follow;
    body = panel(`${current?.label ?? ui.logRequest.inv}${current && scopeLabel(current) ? ` · ${scopeLabel(current)}` : ''} / ${sourceInfo(ui.logRequest.source).label}${ui.logRequest.raw ? ' / Raw' : ''}`, staticSource ? ui.logRequest.source === 'prompt' ? current?.inputKind === 'repair' ? 'Repair prompt' : current?.inputKind === 'resume' ? 'Resume prompt' : 'Original input' : 'Recorded result' : ui.follow ? 'FOLLOW' : 'PAUSED', lines.slice(ui.offset, ui.offset + inner), w, bodyHeight, true, 'border',
      `lines ${lines.length ? ui.offset + 1 : 0}-${Math.min(lines.length, ui.offset + inner)}/${lines.length}${staticSource && ui.logRequest.source === 'result' ? '' : ' in page'} · ${ui.log && ui.log.start > 0 ? 'PgUp older · ' : ''}${ui.log && ui.log.end < ui.log.size ? 'PgDn newer · ' : ''}Home/End`);
  } else if (ui.detail) {
    const destinations = ui.related();
    ui.linkIndex = Math.max(0, Math.min(ui.linkIndex, destinations.length - 1));
    const lines = ui.pane === 1 ? destinations.map((row, i) => selectedRow(line(ink(`${i === ui.linkIndex ? chars.arrow : ' '} ${row.label}`, i === ui.linkIndex ? 'accent' : 'text')), i === ui.linkIndex, w - 4))
      : ui.detailFrame();
    if (ui.pane === 1 && !lines.length) lines.push(line(ink('No related documents recorded for this item.', 'muted')));
    const start = Math.max(0, ui.linkIndex - inner + 1);
    const content = ui.pane === 1 ? lines.slice(start, start + inner) : window(lines);
    const position = ui.pane === 1 ? `${destinations.length ? ui.linkIndex + 1 : 0}/${destinations.length} documents` : `lines ${lines.length ? ui.offset + 1 : 0}-${Math.min(lines.length, ui.offset + inner)}/${lines.length}`;
    body = panel(`${ui.sectionName()} > ${detailTitle(ui.detail)}`, ui.pane === 1 ? 'Related documents' : ui.rawDetail ? 'Raw · r readable' : 'Readable · r raw', content, w, bodyHeight, true, 'border', `${position} · PgUp/PgDn scroll`);
  } else if (d) {
    if (ui.view === 1 && ui.activityExpanded) body = list(1, w, bodyHeight, 'Activity');
    else if (ui.view === 1 && ui.pane !== 2) {
      if (columns >= 100) {
        const leftWidth = Math.floor((w - 1) * 0.55);
        body = join(list(0, leftWidth, bodyHeight, 'Dependency map'), list(1, w - leftWidth - 1, bodyHeight, 'Activity'), leftWidth, bodyHeight);
      } else {
        const half = Math.floor(bodyHeight / 2);
        body = [...list(0, w, half, 'Dependency map'), ...list(1, w, bodyHeight - half, 'Activity')];
      }
    } else body = list(ui.pane, w, bodyHeight, ui.view === 2 ? `Estate (${ui.withdrawn ? 'all' : 'active'})` : noteCount ? 'Exceptions & viewer notes' : 'Exceptions');
  } else body = panel('Connecting', '', wrap('Waiting for host ownership. Use --repo <path> --arc <id> to inspect a retained run.', w - 4).map((text) => line(ink(text, 'muted'))), w, bodyHeight);

  const selection = ui.detail || ui.logRequest || ui.help ? null : ui.selection(); const inv = invocation(selection);
  let preview: Line[]; let previewTitle = 'Selection';
  if (ui.help) preview = [line(ink('Read-only observation. Keyboard navigation; terminal text selection stays available.', 'muted')), line(ink('? close help', 'accent'))];
  else if (ui.logRequest) {
    const mode = !sourceInfo(ui.logRequest.source).follow ? sourceInfo(ui.logRequest.source).label : ui.follow ? 'FOLLOW' : `PAUSED +${Math.max(0, (ui.log?.size ?? 0) - ui.seenSize)} new bytes`;
    previewTitle = sourceInfo(ui.logRequest.source).follow ? `${sourceInfo(ui.logRequest.source).label} · ${mode}` : sourceInfo(ui.logRequest.source).label;
    const current = d?.invocations.find((inv) => inv.id === ui.logRequest!.inv);
    const initial = originalInput(current, d);
    const repair = ui.logRequest.source === 'prompt' && current?.inputKind === 'repair';
    const resume = ui.logRequest.source === 'prompt' && current?.inputKind === 'resume';
    if (repair) previewTitle = 'Repair prompt';
    else if (resume) previewTitle = 'Resume prompt';
    const description = ui.logRequest.raw ? 'Raw recorded data. Press r to return to the readable projection.' : repair ? 'Executor correction request for a refused answer; see Result for the response.'
      : resume ? 'Continuation prompt for this session; the initial task is a separate input.' : sourceInfo(ui.logRequest.source).description;
    preview = [line(ink(current?.execution === 'agent' ? `Model: ${modelLabel(current)}${current.adapter ? ` (${current.adapter})` : ''}${dot}${description}` : description, 'muted')),
      line(ink(`${ui.logRequest.source === 'prompt' && initial ? 'b original input' + dot : ''}${['transcript', 'stdout', 'result', 'prompt'].includes(ui.logRequest.source) ? (ui.logRequest.raw ? 'r readable' : 'r raw') + dot : ''}PgUp/PgDn${dot}Home/End${dot}/ find${['transcript', 'stdout'].includes(ui.logRequest.source) ? dot + (ui.expandedLog ? 'e collapse' : 'e expand') : ''}${sourceInfo(ui.logRequest.source).follow ? dot + 'f follow' : ''}`, 'muted'))];
  } else if (ui.detail) {
    const destination = ui.pane === 1 ? ui.related()[ui.linkIndex] : null;
    previewTitle = destination ? `Open: ${destination.label}` : 'About this view';
    preview = destination ? wrap(destination.description, w - 4).slice(0, 2).map((text) => line(ink(text)))
      : [line(ink(ui.detail.description ?? `${detailTitle(ui.detail)} · Related documents shows connected records.`, 'muted')), line(ink(ui.detail.provenance, 'violet'))];
  } else if (inv) {
    previewTitle = `Selected invocation${scopeLabel(inv) ? ` · ${scopeLabel(inv)}` : ''}`;
    preview = [line(ink(`${inv.execution === 'agent' ? 'Agent' : inv.execution === 'command' ? 'Command' : 'Run'}: ${inv.label}`, 'strong', true), ink(`${dot}`, 'muted'), ...badge(activityState(inv)), ink(`${dot}execution attempt ${inv.attempt}${dot}quiet ${inv.quietMs === null ? 'unknown' : elapsed(inv.quietMs)}`, 'muted')),
      line(ink(inv.execution === 'agent' ? `Model: ${modelLabel(inv)}${inv.adapter ? ` (${inv.adapter}; requested ${inv.requestedModel ?? 'unavailable'})` : ''}${dot}${assessmentExplanation(inv) || inv.latest || 'No recorded output'}` : assessmentExplanation(inv) || inv.latest || 'No recorded output', 'muted'))];
  } else if (selection?.kind === 'milestone-status' && d) {
    const milestone = d.status.milestones.find((m) => m.id === selection.id)!;
    previewTitle = `Milestone ${milestone.id}`;
    preview = [line(...badge(milestonePhase(milestone), (selection as GraphRow).markerState), ink(`${dot}${milestoneProgress(d, milestone.id)}${dot}gate ${milestone.passed ? 'passed' : 'waiting'}${dot}round ${milestone.round}`, 'muted')),
      line(ink(selection.description ?? '', 'strong'))];
  } else if (selection?.kind === 'unit-status') {
    const node = selection as GraphRow;
    const unit = d?.status.units.find((u) => u.unit === node.id);
    const waitReason = unit ? unitWaitReason(unit, graphVisible) : node.waitReason;
    const dependencies = node.from.map(dependencyLabel).join(', ') || 'none (independent unit)';
    preview = [line(ink(node.label, 'strong', true), ink(`${dot}${node.specRevision === undefined ? 'Spec revision unavailable' : `Spec r${node.specRevision}`}`, 'violet')),
      line(ink(`${[node.replaces ? `Replaces ${node.replaces}` : '', node.replacedBy ? `Replaced by ${node.replacedBy}` : '', waitReason ?? `Needs: ${dependencies}`, node.replaces || node.replacedBy ? 'Enter status / related versions' : 'Enter status / documents'].filter(Boolean).join(dot)}`, 'muted'))];
  } else if (ui.view === 2 && asEstateRow(selection)?.childCount) {
    const group = asEstateRow(selection)!;
    preview = [line(ink(`${group.label}${dot}${group.childSummary}`, 'strong', true)),
      line(ink(`Space ${group.expanded ? 'collapse' : 'expand'} contents${dot}Enter open document${dot}/ find including hidden entries`, 'muted'))];
  } else if (selection) {
    preview = [line(ink(selection.label, 'strong', true), ink(`${dot}${selection.provenance}`, 'muted')),
      line(ink('from' in selection ? `Needs: ${(selection as GraphRow).from.map(dependencyLabel).join(', ') || 'none (independent unit)'}${dot}Enter opens execution status` : selection.description ?? summary(selection.body), 'muted'))];
  } else preview = [line(ink('Select an entry to see its details', 'muted')), line(ink('Enter inspect', 'accent'))];
  const footer = line(...hints(ui).flatMap(([key, action]) => [ink(ascii ? key.replace('↑↓', 'j/k').replace('←→', 'h/l') : key, 'accent'), ink(` ${action}  `, 'muted')]));
  const returnHint = ui.detail || ui.logRequest ? `Esc: ${ui.query ? 'clear search' : ui.backLabel()}` : ui.view === 1 && ui.pane === 0 ? `c ${ui.expandedGraph ? 'open work' : 'full map'}` : ui.view === 1 && ui.pane === 1 ? 'a toggle history' : ui.view === 2 ? 'w toggle inactive' : '';
  const frame = [title, tabs, ...runPanel, strip, navigation, ...body, ...panel(previewTitle, returnHint, preview, w, 4), footer];
  // Below the supported 80x24 size, keep input usable and never write beyond the viewport.
  if (rows < 18) return [...frame.slice(0, Math.max(0, rows - 1)), footer].map((row) => fit(row, w));
  return Array.from({ length: rows }, (_, i) => fit(frame[i] ?? [], w));
}
