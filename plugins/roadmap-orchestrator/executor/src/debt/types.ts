// The debt records (M4a, frozen in step 0a; SCHEMAS.md "M4a", DESIGN §2.9): the debt ledger `debt.md` renders, its
// item, the Phase-0 disposition and the `debt-banked` fact's source. Types and readers only; A4 owns the behaviour
// (src/debt/{ledger,mint,render}.ts): `debtKey`, minting, dedupe, rendering.
import {
  type ArcId, type DebtId, type FindingId, type RulingId, type Sha256Hex, type UnitId, arcId, debtId, debtSeq, findingId, rulingId, sha256, unitId, compareIds,
} from '../core/ids.ts';
import { type Read, SchemaError, arrayOf, literal, nat, nullable, object, oneOf, positive, str, tagged } from '../core/validate.ts';

/** Why an item was banked (R7): a gate `note` finding on an approved attempt, or a P2/P3 finding with no obligation a checkpoint deferred. */
export const BANK_REASONS = ['gate-note', 'finding-deferred'] as const;
export type BankReason = (typeof BANK_REASONS)[number];
export const DEBT_STATES = ['open', 'promoted', 'resolved'] as const;
export type DebtState = (typeof DEBT_STATES)[number];

/** Every `open` item's Phase-0 disposition: promoted into a unit of the plan, kept with a reason, or resolved by a ruling. */
export type DebtDisposition =
  | Readonly<{ type: 'promote'; unit: UnitId }>
  | Readonly<{ type: 'keep'; reason: string }>
  | Readonly<{ type: 'resolve'; ruling: RulingId }>;

export const debtDisposition: Read<DebtDisposition> = tagged('type', {
  promote: object((f): DebtDisposition => ({ type: f.get('type', literal('promote')), unit: f.get('unit', (v, p) => unitId(v, p)) })),
  keep: object((f): DebtDisposition => ({ type: f.get('type', literal('keep')), reason: f.get('reason', str) })),
  resolve: object((f): DebtDisposition => ({ type: f.get('type', literal('resolve')), ruling: f.get('ruling', (v, p) => rulingId(v, p)) })),
});

/**
 * One debt item. `key` = `debtKey({unit, bankReason, what})` (A4's src/debt/ledger.ts, the only place it is computed:
 * sha256 of canonical `{unit, bankReason, normalizedWhat}`); `history`: each arc's disposition, oldest first.
 */
export type DebtItem = Readonly<{
  id: DebtId;
  originArc: ArcId;
  bankReason: BankReason;
  what: string;
  unit: UnitId | null;
  key: Sha256Hex;
  history: readonly Readonly<{ arc: ArcId; disposition: DebtDisposition }>[];
  state: DebtState;
}>;

export const DEBT_SCHEMA = 'roadmap/debt-m4';
/** The info string of the block in `debt.md` that holds the ledger. */
export const DEBT_FENCE = 'json roadmap-debt';

/** The ledger: items ascending by number, ids never reused; the next id continues from the highest. */
export type DebtLedger = Readonly<{ schema: typeof DEBT_SCHEMA; items: readonly DebtItem[] }>;

const debtItem: Read<DebtItem> = object((f) => ({
  id: f.get('id', (v, p) => debtId(v, p)),
  originArc: f.get('originArc', (v, p) => arcId(v, p)),
  bankReason: f.get('bankReason', oneOf(BANK_REASONS)),
  what: f.get('what', str),
  unit: f.get('unit', nullable((v, p) => unitId(v, p))),
  key: f.get('key', (v, p) => sha256(v, p)),
  history: f.get('history', arrayOf(object((g) => ({ arc: g.get('arc', (v, p) => arcId(v, p)), disposition: g.get('disposition', debtDisposition) })))),
  state: f.get('state', oneOf(DEBT_STATES)),
}));

export const debtLedger: Read<DebtLedger> = object((f) => {
  const out: DebtLedger = { schema: f.get('schema', literal(DEBT_SCHEMA)), items: f.get('items', arrayOf(debtItem)) };
  out.items.forEach((item, i) => {
    if (i > 0 && !(compareIds(out.items[i - 1]!.id, item.id) < 0)) throw new SchemaError(`${f.path}.items[${i}]`, 'items strictly ascending by number', item.id);
  });
  return out;
});

export function parseDebtLedger(value: unknown): DebtLedger {
  return debtLedger(value, 'debt');
}

/** Where a `debt-banked` fact came from; banking is idempotent per source. */
export type DebtSource =
  | Readonly<{ type: 'gate'; unit: UnitId; attempt: number; index: number }>
  | Readonly<{ type: 'finding'; finding: FindingId }>;

export const debtSource: Read<DebtSource> = tagged('type', {
  gate: object((f): DebtSource => ({
    type: f.get('type', literal('gate')), unit: f.get('unit', (v, p) => unitId(v, p)), attempt: f.get('attempt', positive),
    index: f.get('index', nat),
  })),
  finding: object((f): DebtSource => ({ type: f.get('type', literal('finding')), finding: f.get('finding', (v, p) => findingId(v, p)) })),
});
