// Mint gate-note and close-out finding debt, deduplicated by source and normalized key.
import type { Fact } from '../core/events.ts';
import type { DebtId, FindingId, ObligationId, UnitId } from '../core/ids.ts';
import { normalizeText } from '../corpus/rules.ts';
import { debtKey, nextDebtId } from './ledger.ts';
import type { BankReason, DebtLedger, DebtSource } from './types.ts';

export type DebtBanked = Extract<Exclude<Fact, {kind: 'stage-outcome'; job: unknown}>, { kind: 'debt-banked' }>;

/** What a bank request names. */
export type DebtCandidate =
  | Readonly<{ type: 'gate-note'; unit: UnitId; attempt: number; index: number; what: string }>
  /** `witness`: a vacuity finding, about the strength of an obligation's witness, not about the obligation's truth. */
  | Readonly<{ type: 'finding-deferred'; finding: FindingId; severity: 'P1' | 'P2' | 'P3'; obligation: ObligationId | null; witness: boolean; unit: UnitId | null; what: string }>;


export class DebtRefusedError extends Error {}

function sameSource(a: DebtSource, b: DebtSource): boolean {
  switch (a.type) {
    case 'gate':
      return b.type === 'gate' && a.unit === b.unit && a.attempt === b.attempt && a.index === b.index;
    case 'finding':
      return b.type === 'finding' && a.finding === b.finding;
  }
}

/**
 * The fact to append for a candidate, or null when nothing is to be banked: its source already banked (idempotent), or an
 * unresolved item with the same `debtKey` exists (in the baseline ledger or already banked this arc). Throws on a
 * finding that is P1 or P3 or has an obligation, or whose text is empty. Ids continue from the highest in the baseline and the
 * arc's own facts.
 */
export function mintDebt(baseline: DebtLedger, banked: readonly DebtBanked[], c: DebtCandidate): DebtBanked | null {
  const bankReason: BankReason = c.type;
  const source: DebtSource = c.type === 'gate-note'
    ? { type: 'gate', unit: c.unit, attempt: c.attempt, index: c.index }
    : { type: 'finding', finding: c.finding };
  if (c.type === 'finding-deferred') {
    if (c.obligation !== null && !c.witness) throw new DebtRefusedError(`${c.finding} affects ${c.obligation}: a finding with an obligation is never debt (a vacuous witness of one may be)`);
    if (c.severity !== 'P2') throw new DebtRefusedError(`${c.finding} is ${c.severity}: only P2 findings are banked (a P3 is never debt)`);
  }
  const what = normalizeText(c.what);
  if (what === '') throw new DebtRefusedError('debt text is empty');
  if (banked.some((b) => sameSource(b.source, source))) return null;
  const key = debtKey({ unit: c.unit, bankReason, what });
  if (baseline.items.some((i) => i.key === key && i.state !== 'resolved') || banked.some((b) => b.key === key)) return null;
  const ids: readonly DebtId[] = [...baseline.items.map((i) => i.id), ...banked.map((b) => b.id)];
  return { kind: 'debt-banked', id: nextDebtId(ids), bankReason, what, key, source };
}
