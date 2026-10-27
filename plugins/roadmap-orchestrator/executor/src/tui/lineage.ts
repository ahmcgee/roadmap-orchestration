import type { Display } from './types.ts';

const indexes = new WeakMap<Display, ReturnType<typeof buildIndex>>();
function buildIndex(display: Display) {
  return { units: new Map(display.status.units.map((u) => [String(u.unit), u])),
    estate: new Map(display.estate.map((e) => [e.id, e])),
    specifications: new Map(display.estate.filter((e) => e.kind === 'specification').map((e) => [e.id, e])),
    families: new Map<string, string[]>() };
}
/** Replies replace Display objects; indexes live exactly as long as their snapshot. */
export function displayIndex(display: Display) {
  let index = indexes.get(display);
  if (!index) { index = buildIndex(display); indexes.set(display, index); }
  return index;
}

/** Only the executor's explicit replacement lineage defines a family, never ids or shared paths. */
export function unitFamily(display: Display, id: string): string[] {
  const { units, families } = displayIndex(display);
  const cached = families.get(id); if (cached) return cached;
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
  for (const member of chain) families.set(member, chain);
  return chain;
}
export function specificationRevision(display: Display, id: string): number | undefined {
  const entry = displayIndex(display).specifications.get(id);
  if (!entry) return undefined;
  let body; try { body = JSON.parse(entry.body); } catch { return undefined; } // Pruned inputs have an explicit prose explanation.
  return Number.isInteger(body?.rev) && body.rev > 0 ? body.rev : undefined;
}
