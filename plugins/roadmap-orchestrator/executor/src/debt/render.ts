// The ledger as `debt.md` shows it (M4a, DESIGN §2.9, A4): the baseline ledger, this arc's Phase-0 dispositions recorded
// in each item's history, and the items banked this arc. Pure; docs/debt.ts prints the result.
import type { ArcId, DebtId, UnitId } from '../core/ids.ts';
import { debtSeq } from '../core/ids.ts';
import type { DebtBanked } from './mint.ts';
import type { DebtDisposition, DebtItem, DebtLedger, DebtSource, DebtState } from './types.ts';

const stateOf = (d: DebtDisposition): DebtState => (d.type === 'promote' ? 'promoted' : d.type === 'resolve' ? 'resolved' : 'open');

/** The unit a banked fact belongs to: a gate note's own, a finding's as the caller knows it (the fact does not carry it). */
export type UnitOfSource = (source: DebtSource) => UnitId | null;

/**
 * The ledger after an arc: each disposition (one per open baseline item, named by id) is appended to that item's history
 * and sets its state; each banked fact becomes an open item with empty history. A disposition for an id that is not an
 * open baseline item, or two for one id, throws (Phase 0 refuses these before any arc runs).
 */
export function ledgerAfterArc(
  baseline: DebtLedger, arc: ArcId, dispositions: readonly Readonly<{ id: DebtId; disposition: DebtDisposition }>[],
  banked: readonly DebtBanked[], unitOf: UnitOfSource,
): DebtLedger {
  const byId = new Map(dispositions.map((d) => [d.id, d.disposition]));
  if (byId.size !== dispositions.length) throw new Error('debt: two dispositions for one item');
  for (const id of byId.keys()) {
    const item = baseline.items.find((i) => i.id === id);
    if (item === undefined || item.state !== 'open') throw new Error(`debt: disposition for ${id}, which is not an open item`);
  }
  const carried: DebtItem[] = baseline.items.map((i) => {
    const d = byId.get(i.id);
    return d === undefined ? i : { ...i, history: [...i.history, { arc, disposition: d }], state: stateOf(d) };
  });
  const minted: DebtItem[] = banked.map((b) => ({
    id: b.id, originArc: arc, bankReason: b.bankReason, what: b.what, unit: unitOf(b.source), key: b.key, history: [], state: 'open',
  }));
  const items = [...carried, ...minted].sort((a, b) => debtSeq(a.id) - debtSeq(b.id));
  return { schema: baseline.schema, items };
}
