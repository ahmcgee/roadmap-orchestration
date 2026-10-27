import { asEstateRow } from './estate-tree.ts';
import { graph } from './graph.ts';
import type { ViewState } from './state.ts';
import type { Display, Entry, Invocation, LogSource } from './types.ts';

export const SOURCES: readonly { id: LogSource; label: string; description: string; follow: boolean }[] = [
  { id: 'transcript', label: 'Messages', description: 'Readable agent messages and tool activity.', follow: true },
  { id: 'stdout', label: 'Output', description: 'Readable standard output with decoded events and tool results; r shows raw.', follow: true },
  { id: 'stderr', label: 'Stderr', description: 'Standard error output; text here does not necessarily mean failure.', follow: true },
  { id: 'runner.log', label: 'Runner', description: 'Executor runner diagnostics.', follow: true },
  { id: 'result', label: 'Result', description: 'Recorded outcome and report; may be unavailable while running.', follow: false },
  { id: 'prompt', label: 'Input', description: 'Readable retained agent prompt; r shows its exact source.', follow: false },
];
export const sourceInfo = (source: LogSource) => SOURCES.find((s) => s.id === source)!;
export const viewName = (view: number): string => ['Overview', 'Estate'][view - 1]!;
export function detailTitle(entry: Entry): string {
  return entry.kind === 'unit-status' ? `Unit status: ${entry.id}` : entry.label;
}
/** Only a recorded session identity establishes the original input relationship. */
export function originalInput(inv: Invocation | undefined, display: Display | null): Invocation | null {
  if (!inv?.session || inv.inputKind === 'initial' || !display) return null;
  return display.invocations.filter((candidate) => candidate.id !== inv.id && candidate.unit === inv.unit && candidate.role === inv.role
    && candidate.session === inv.session && candidate.inputKind === 'initial' && candidate.startedAt <= inv.startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0] ?? null;
}
export type Related = { id: string; label: string; description: string; target: { type: 'entry'; entry: Entry } | { type: 'log'; inv: string; source: LogSource } };
export function related(entry: Entry, display: Display | null): Related[] {
  if (!display) return [];
  const unit = ['unit-status', 'specification'].includes(entry.kind ?? '') ? entry.id : entry.kind === 'implementation-plan' ? entry.id.slice('design:'.length) : null;
  const ids = [...new Set([...(unit ? [unit, `design:${unit}`, 'plan', 'intent:arc'] : []), ...entry.links])].filter((id) => id !== entry.id || entry.kind === 'unit-status' || entry.kind === 'milestone-status');
  const rows: Related[] = ids.map((id) => {
    const target = display.estate.find((e) => e.id === id) ?? { id, label: `Unavailable document: ${id}`, state: 'unavailable', body: 'This referenced document is not retained in the displayed snapshot.', links: [], provenance: entry.provenance };
    return { id, label: target.state === 'unavailable' ? `${target.label} (unavailable)` : target.label, description: target.description ?? `Recorded relationship to ${target.label}.`, target: { type: 'entry', entry: target } };
  });
  if (unit) {
    const status = display.status.units.find((u) => u.unit === unit);
    for (const [id, relationship] of [[status?.lineage?.reenters, 'Previous version'], [status?.supersededBy, 'Replacement']] as const) {
      if (!id) continue;
      const target = graph(display, true).find((r) => r.id === id);
      if (target) rows.unshift({ id: `lineage:${id}`, label: `${relationship}: ${id} (${target.state})`,
        description: 'Recorded replacement lineage. Open this version’s status, specification and activity; it is not a prerequisite edge.', target: { type: 'entry', entry: target } });
    }
    const latest = (role: string) => display.invocations.filter((inv) => inv.unit === unit && inv.role === role).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const planner = latest('planCheck'); const builder = latest('build');
    if (planner) {
      const initial = originalInput(planner, display);
      const input = initial ?? planner;
      rows.push({ id: `input:${input.id}`, label: `Plan-check ${input.inputKind === 'repair' ? 'repair prompt' : 'input'} · attempt ${input.attempt}`, description: input.inputKind === 'repair' ? 'Correction prompt for a refused answer; the original input is unavailable.' : 'The original retained prompt asking the planner to assess and design this unit.', target: { type: 'log', inv: input.id, source: 'prompt' } });
      if (initial) rows.push({ id: `input:${planner.id}`, label: `Plan-check repair prompt · attempt ${planner.attempt}`, description: 'The executor asked this resumed turn to correct a refused answer. See Result for its response.', target: { type: 'log', inv: planner.id, source: 'prompt' } });
      rows.push({ id: `result:${planner.id}`, label: `Plan-check result · attempt ${planner.attempt}`, description: 'Open the recorded planning decision, reasons and proposed design.', target: { type: 'log', inv: planner.id, source: 'result' } });
    }
    if (builder) rows.push({ id: `messages:${builder.id}`, label: `Build transcript · attempt ${builder.attempt}`, description: 'Open the latest recorded build invocation and its messages.', target: { type: 'log', inv: builder.id, source: 'transcript' } });
  }
  return rows;
}
export type Hint = readonly [key: string, action: string];
/** Every advertised action is valid in the current mode; more specialised controls live in the preview. */
export function hints(ui: ViewState): Hint[] {
  if (ui.searching) return [['Enter', 'find match'], ['Esc', 'cancel'], ['Backspace', 'edit']];
  if (ui.help) return [['↑↓', 'scroll help'], ['Esc / ?', 'close'], ['q', 'quit']];
  const tail: Hint[] = [['?', 'help'], ['q', 'quit']];
  if (ui.logRequest) return [['←→/Tab', 'source'], ['↑↓', 'scroll'], ['Esc', ui.query ? 'clear search' : 'back'], ...tail];
  if (ui.detail) return [['←→/Tab', 'tab'], ['↑↓', ui.pane ? 'select' : 'scroll'], ...(ui.pane ? (ui.related().length ? [['Enter', 'open'] as const] : []) : [['r', ui.rawDetail ? 'readable' : 'raw'] as const]), ['/', 'find'], ['Esc', ui.query ? 'clear search' : 'back'], ...tail];
  const selected = ui.selection();
  if (ui.view === 2 && asEstateRow(selected)?.childCount) return [['Space', asEstateRow(selected)!.expanded ? 'collapse' : 'expand'], ['Enter', 'document'], ['↑↓', 'select'], ['/', 'find all'], ...tail];
  const open = ui.display?.invocations.some((inv) => inv.id === selected?.id) ? 'transcript' : ui.view === 1 && ui.pane === 0 ? 'status' : 'open';
  if (ui.view === 1 && ui.pane === 1) return [['x', ui.activityExpanded ? 'restore' : 'expand'], ['g', ui.activityAll ? 'map focus' : 'all activity'], ['↑↓', 'select'], ['r/R', 'running'], ['Enter', 'open'], ['/', 'find'], ...tail];
  return [['←→/Tab', 'section'] as const, ...(ui.view === 1 && ui.pane === 0 ? [['r/R', 'running'] as const, ['c', ui.expandedGraph ? 'open work' : 'full map'] as const] : []), ...(ui.view === 1 && ui.pane === 0 && ui.display?.status.milestones.length ? [['m', 'milestone'] as const] : []), ['↑↓', 'select'], ...(selected ? [['Enter', open] as const] : []), ['/', 'find'], ...tail];
}
