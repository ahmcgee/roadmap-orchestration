// The debt ledger's pure rules (M4a, DESIGN §2.9, A4): the one `debtKey`, the id high-water, the open items and the
// "kept twice" test Phase 0 asks. Callers (ledger, facts, recovery, CLI) all compute keys here and nowhere else.
import { type DebtId, type Sha256Hex, type UnitId, debtIdOf, debtSeq, sha256 } from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { type BankReason, type DebtItem, type DebtLedger, DEBT_SCHEMA } from './types.ts';
import { normalizeText } from '../corpus/rules.ts';

/** Trimmed, every whitespace run collapsed to one space. (Corpus rules hash the same normal form, `textSha256`.) */

/** `sha256(canonicalJson({unit, bankReason, normalizedWhat}))`: equal wording up to whitespace on the same unit and reason is one item. */
export function debtKey(input: Readonly<{ unit: UnitId | null; bankReason: BankReason; what: string }>): Sha256Hex {
  return sha256(sha256Hex(canonicalJson({ unit: input.unit, bankReason: input.bankReason, normalizedWhat: normalizeText(input.what) })));
}

export const EMPTY_LEDGER: DebtLedger = { schema: DEBT_SCHEMA, items: [] };

/** The id the next item takes: one past the highest `B-n` among the given ids (ids are never reused), `B-1` for none. */
export function nextDebtId(existing: readonly DebtId[]): DebtId {
  return debtIdOf(existing.reduce((m, id) => Math.max(m, debtSeq(id)), 0) + 1);
}

/** Items that still need a Phase-0 disposition. */
export function openItems(ledger: DebtLedger): readonly DebtItem[] {
  return ledger.items.filter((i) => i.state === 'open');
}

/** True when the item's two most recent arcs both kept it: this arc must then ask a `P-n` question about it (`debt-kept-twice-unasked`). */
export function keptInEachOfLastTwoArcs(item: DebtItem): boolean {
  const last = item.history.slice(-2);
  return last.length === 2 && last.every((h) => h.disposition.type === 'keep') && last[0]!.arc !== last[1]!.arc;
}
