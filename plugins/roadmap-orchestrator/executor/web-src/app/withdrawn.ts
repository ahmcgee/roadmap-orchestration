// dev.81 (D2): whether withdrawn units (superseded or cut) are shown. Hidden by default; a viewer's choice is kept in
// localStorage under one key. Storage can be absent, disabled or throwing (a private window, a preview): it then reads as
// hidden, and a choice it would not keep lasts for the page. One value for every view that renders withdrawn rows (the
// Graph, the milestone drawer), read through `useShowWithdrawn` (shared.tsx).
export const SHOW_WITHDRAWN_KEY = 'roadmap.show-withdrawn';
export type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): ChoiceStorage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** A choice the storage refused to keep. */
let unkept: boolean | null = null;
const listeners = new Set<() => void>();
export function readShowWithdrawn(from: ChoiceStorage | null = storage()): boolean {
  if (unkept !== null) return unkept;
  try { return from?.getItem(SHOW_WITHDRAWN_KEY) === '1'; } catch { return false; }
}
export function writeShowWithdrawn(next: boolean, to: ChoiceStorage | null = storage()): void {
  try { if (!to) throw new Error('no storage'); to.setItem(SHOW_WITHDRAWN_KEY, next ? '1' : '0'); unkept = null; } catch { unkept = next; }
  for (const listener of listeners) listener();
}
export function subscribeShowWithdrawn(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
