import type { Entry } from './types.ts';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const contextOrder = ['vision', 'arc-slice', 'plan', 'intent:arc'];
const compare = (a: Entry, b: Entry): number => collator.compare(a.label, b.label) || collator.compare(a.id, b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export type EstateRow = Entry & { treePrefix: string; childCount: number; childSummary: string; expanded: boolean };

/** Containment is explicit metadata, separate from cross-links. Omit expanded to search the full outline. */
export function estateOutline(entries: readonly Entry[], expanded?: ReadonlySet<string>): EstateRow[] {
  const ids = new Set(entries.map((e) => e.id));
  const children = new Map<string, Entry[]>();
  for (const e of entries) if (e.parentId && ids.has(e.parentId)) {
    const group = children.get(e.parentId) ?? []; group.push(e); children.set(e.parentId, group);
  }
  for (const group of children.values()) group.sort((a, b) => {
    const rank = (e: Entry) => e.kind === 'vision-clause' ? 0 : e.kind === 'vision-question' ? 1 : 2;
    return rank(a) - rank(b) || compare(a, b);
  });
  const roots = entries.filter((e) => !e.parentId || !ids.has(e.parentId)).sort((a, b) => {
    const rank = (e: Entry) => contextOrder.includes(e.id) ? contextOrder.indexOf(e.id) : contextOrder.length;
    return rank(a) - rank(b) || compare(a, b);
  });
  const rows: EstateRow[] = []; const seen = new Set<string>();
  const visit = (entry: Entry, prefix: string, ancestors: string, visible: boolean): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    const group = children.get(entry.id) ?? [];
    const clauses = group.filter((e) => e.kind === 'vision-clause').length;
    const questions = group.filter((e) => e.kind === 'vision-question').length;
    const childSummary = clauses + questions === group.length
      ? [clauses ? `${clauses} clause${clauses === 1 ? '' : 's'}` : '', questions ? `${questions} question${questions === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')
      : `${group.length} item${group.length === 1 ? '' : 's'}`;
    const open = expanded === undefined || expanded.has(entry.id);
    if (visible) rows.push({ ...entry, treePrefix: prefix, childCount: group.length, childSummary, expanded: open });
    group.forEach((child, index) => {
      const last = index === group.length - 1;
      visit(child, ancestors + (last ? '└─ ' : '├─ '), ancestors + (last ? '   ' : '│  '), visible && open);
    });
  };
  for (const entry of roots) visit(entry, '', '', true);
  // A filtered/missing parent or malformed cycle must not make records permanently inaccessible.
  for (const entry of entries) if (!seen.has(entry.id)) visit(entry, '', '', true);
  return rows;
}
export function asEstateRow(entry: Entry | null): EstateRow | null {
  return entry && 'treePrefix' in entry ? entry as EstateRow : null;
}
export function estateRowLabel(entry: Entry, ascii: boolean): string {
  const row = asEstateRow(entry);
  const prefix = row?.treePrefix ?? '';
  const tree = ascii ? prefix.replaceAll('├', '+').replaceAll('└', '\\').replaceAll('─', '-').replaceAll('│', '|') : prefix;
  return tree + (row?.childCount ? `[${row.expanded ? '-' : '+'}] ` : '') + entry.label + (row?.childCount ? ` · ${row.childSummary}` : '');
}
