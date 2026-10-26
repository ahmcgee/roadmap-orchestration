import type { Display } from './types.ts';
import type { GraphRow } from './graph.ts';
import { ink, line, stateTone, symbol, type Line } from './terminal.ts';

type Track = { to: string; kind: 'unit' | 'condition' | 'milestone' };
type Row = { cells: string[]; node?: GraphRow; nodeColumn?: number; note?: string };
export type GraphDrawing = { rows: Line[]; positions: Map<string, number>; crossings: boolean; hiddenTracks: number };

/** Forward rails: each open track leads to a named dependent. Duplicate destinations merge at that node. */
export function dependencyDrawing(nodes: readonly GraphRow[], display: Display, selected: string | undefined, ascii: boolean, width = 120): GraphDrawing {
  const tracks: (Track | null)[] = []; const rows: Row[] = []; let columns = 0; let crossings = false;
  const down = ascii ? 'v' : '↓';
  const vertical = (track: Track | null | undefined): string => !track ? ' ' : ascii ? '|' : track.kind === 'condition' ? '┆' : track.kind === 'milestone' ? '║' : '│';
  const rails = (): string[] => tracks.flatMap((track) => [vertical(track), ' ']);
  const slot = (): number => { const free = tracks.findIndex((track) => track === null); return free < 0 ? tracks.length : free; };
  const edgeKind = (from: string, to: string): Track['kind'] => display.status.edges.some((edge) => edge.type === 'contingent' && edge.edge === from && edge.unit === to)
    ? 'condition' : display.status.milestones.some((m) => m.id === from || m.id === to) ? 'milestone' : 'unit';
  const connector = (up: number[], below: number[], involved: Set<number>): void => {
    const cells = rails(); const ends = [...up, ...below]; const lo = Math.min(...ends); const hi = Math.max(...ends);
    const glyph: Record<number, string> = { 1: '│', 2: '│', 3: '│', 4: '─', 8: '─', 12: '─', 5: '┘', 9: '└', 6: '┐', 10: '┌', 7: '┤', 11: '├', 13: '┴', 14: '┬', 15: '┼' };
    for (let x = lo * 2; x <= hi * 2; x++) {
      const i = x / 2; const other = Number.isInteger(i) && tracks[i] && !involved.has(i);
      if (other && x > lo * 2 && x < hi * 2) { cells[x] = ascii ? 'x' : '╳'; crossings = true; continue; }
      const bits = (up.includes(i) ? 1 : 0) | (below.includes(i) ? 2 : 0) | (x > lo * 2 ? 4 : 0) | (x < hi * 2 ? 8 : 0);
      cells[x] = ascii ? bits & 3 ? bits & 12 ? '+' : '|' : '-' : glyph[bits] ?? ' ';
    }
    rows.push({ cells });
  };
  for (const node of nodes) {
    const incoming = tracks.flatMap((track, i) => track?.to === node.id ? [i] : []);
    const at = incoming[0] ?? slot();
    if (incoming.length > 1) {
      connector(incoming, [at], new Set(incoming));
      for (const i of incoming.slice(1)) tracks[i] = null;
    }
    if (!incoming.length) tracks[at] = { to: node.id, kind: 'unit' };
    const outside = node.from.filter((id) => !nodes.some((source) => source.id === id));
    if (outside.length) rows.push({ cells: rails(), note: `from ${outside.join(', ')} [offscreen]` });
    const cells = rails(); cells[at * 2] = symbol(node.markerState ?? node.state, ascii);
    rows.push({ cells, node, nodeColumn: at * 2 });
    if (node.replaces || node.replacedBy) rows.push({ cells: rails(), note: [node.replaces ? `Replaces: ${node.replaces}` : '', node.replacedBy ? `Replaced by: ${node.replacedBy}` : ''].filter(Boolean).join(' · ') });
    if (node.waitReason) rows.push({ cells: rails(), note: node.waitReason });
    for (const edge of node.redirected ?? []) rows.push({ cells: rails(), note: `Needs: ${edge.effective} (replaces ${edge.declared})` });
    tracks[at] = null;
    const children = nodes.filter((candidate) => candidate.from.includes(node.id));
    const targets: number[] = [];
    for (const [index, child] of children.entries()) {
      const next = index === 0 ? at : slot();
      tracks[next] = { to: child.id, kind: edgeKind(node.id, child.id) }; targets.push(next);
    }
    if (targets.length > 1) connector([at], targets, new Set([at, ...targets]));
    if (tracks.some(Boolean)) {
      const continuation = rails();
      for (const target of targets) continuation[target * 2] = ascii ? down : tracks[target]!.kind === 'condition' ? '⇣' : tracks[target]!.kind === 'milestone' ? '⇓' : down;
      rows.push({ cells: continuation });
    }
    columns = Math.max(columns, tracks.length, Math.ceil(cells.length / 2));
  }
  const positions = new Map<string, number>();
  const visibleTracks = Math.max(1, Math.floor((width - 32) / 2));
  const hiddenTracks = Math.max(0, columns - visibleTracks);
  return { positions, crossings, hiddenTracks, rows: rows.map((row, y) => {
    const active = row.node?.id === selected;
    if (row.node) positions.set(row.node.id, y);
    const allRails = row.cells.join('').padEnd(columns * 2);
    const prefix = hiddenTracks ? `${allRails.slice(0, visibleTracks * 2)}[+${hiddenTracks}] ` : allRails;
    const marker = row.node && row.nodeColumn !== undefined && (!hiddenTracks || row.nodeColumn < visibleTracks * 2) ? row.nodeColumn : null;
    const rails = marker === null ? [ink(prefix, 'border')] : [ink(prefix.slice(0, marker), 'border'),
      ink(prefix[marker]!, stateTone(row.node!.markerState ?? row.node!.state)), ink(prefix.slice(marker + 1), 'border')];
    return line(ink(active ? ascii ? '> ' : '▸ ' : '  ', active ? 'accent' : 'muted'), ...rails,
      ink(row.node?.label ?? row.note ?? '', row.node ? active ? 'accent' : row.node.state === 'superseded' ? 'muted' : 'strong' : 'muted', Boolean(row.node)));
  }) };
}
