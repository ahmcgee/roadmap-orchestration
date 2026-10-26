import type { Display } from './types.ts';

/** Only the executor's explicit replacement lineage defines a family, never ids or shared paths. */
export function unitFamily(display: Display, id: string): string[] {
  const units = new Map(display.status.units.map((u) => [String(u.unit), u]));
  let root = id; const seen = new Set<string>();
  while (!seen.has(root)) {
    seen.add(root); const previous = units.get(root)?.lineage?.reenters;
    if (!previous) break;
    root = previous;
  }
  const chain: string[] = []; let current: string | undefined = root;
  while (current && !chain.includes(current)) {
    chain.push(current); current = units.get(current)?.supersededBy ?? undefined;
  }
  return chain;
}
export function specificationRevision(display: Display, id: string): number | undefined {
  const entry = display.estate.find((e) => e.kind === 'specification' && e.id === id);
  if (!entry) return undefined;
  let body; try { body = JSON.parse(entry.body); } catch { return undefined; } // Pruned inputs have an explicit prose explanation.
  return Number.isInteger(body?.rev) && body.rev > 0 ? body.rev : undefined;
}
