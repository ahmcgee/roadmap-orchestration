// The debt ledger (M4a step A4): the one key, minting and dedupe, the obligation refusal, the rendered block, the
// kept-twice history.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { arcId, debtId, findingId, obligationId, rulingId, unitId } from '../src/core/ids.ts';
import { DEBT_DOC, parseDebtBlock, renderDebt } from '../src/docs/debt.ts';
import { EMPTY_LEDGER, debtKey, keptInEachOfLastTwoArcs, nextDebtId, openItems } from '../src/debt/ledger.ts';
import { type DebtBanked, DebtRefusedError, mintDebt } from '../src/debt/mint.ts';
import { ledgerAfterArc } from '../src/debt/render.ts';
import type { DebtItem, DebtLedger } from '../src/debt/types.ts';

const u1 = unitId('u1');
const F1 = findingId('F-1');

describe('debt.key-vectors', () => {
  const vectors: readonly [string | null, 'gate-note' | 'finding-deferred', string, string][] = [
    [null, 'gate-note', 'x', '757b5d174d5272fb78c483a802e4e8a9ef2d011cd9b68812e796a53ec3760b59'],
    ['u1', 'gate-note', 'Add a retry to the loop', '6c583ca19bed0131ea0591340647f30199d1455a7d83f3f237ce6242c45a9f23'],
    ['u1', 'finding-deferred', 'Add a retry to the loop', '1c1b6e098f9f5ad80bc6627aaa4407bdafdf93ebab6b591ab9b0614acfa3e3e6'],
    ['auth-cookie', 'finding-deferred', 'Naming is inconsistent.', '33e8fb81bb49dd233aa9e6ed6c994f5bd338e4d19da5eee031783c2db34f77f0'],
  ];
  for (const [unit, bankReason, what, key] of vectors) {
    it(`${unit}/${bankReason}/${what}`, () => assert.equal(debtKey({ unit: unit === null ? null : unitId(unit), bankReason, what }), key));
  }
  it('is sha256 of the canonical object, keys sorted', () => {
    const raw = createHash('sha256').update('{"bankReason":"gate-note","normalizedWhat":"x","unit":null}').digest('hex');
    assert.equal(debtKey({ unit: null, bankReason: 'gate-note', what: 'x' }), raw);
  });
  it('ignores whitespace, not unit, reason or case', () => {
    const base = debtKey({ unit: u1, bankReason: 'gate-note', what: 'Add a retry to the loop' });
    assert.equal(debtKey({ unit: u1, bankReason: 'gate-note', what: '  Add a  retry\n to the\tloop ' }), base);
    assert.notEqual(debtKey({ unit: unitId('u2'), bankReason: 'gate-note', what: 'Add a retry to the loop' }), base);
    assert.notEqual(debtKey({ unit: u1, bankReason: 'finding-deferred', what: 'Add a retry to the loop' }), base);
    assert.notEqual(debtKey({ unit: u1, bankReason: 'gate-note', what: 'add a retry to the loop' }), base);
  });
});

const item = (n: number, what: string, over: Partial<DebtItem> = {}): DebtItem => ({
  id: debtId(`B-${n}`), originArc: arcId('arc-1'), bankReason: 'gate-note', what, unit: u1,
  key: debtKey({ unit: u1, bankReason: 'gate-note', what }), history: [], state: 'open', ...over,
});
const ledger = (...items: DebtItem[]): DebtLedger => ({ ...EMPTY_LEDGER, items });
const gate = (index: number, what: string, attempt = 1) => ({ type: 'gate-note' as const, unit: u1, attempt, index, what });

describe('debt.mint-dedupe', () => {
  it('starts at B-1 and continues from the baseline and the arc high-water', () => {
    const a = mintDebt(EMPTY_LEDGER, [], gate(0, 'one'))!;
    assert.equal(a.id, 'B-1');
    const b = mintDebt(ledger(item(7, 'old')), [a], gate(1, 'two'))!;
    assert.equal(b.id, 'B-8');
    assert.equal(nextDebtId([]), 'B-1');
  });
  it('is idempotent per source', () => {
    const a = mintDebt(EMPTY_LEDGER, [], gate(0, 'one'))!;
    assert.equal(mintDebt(EMPTY_LEDGER, [a], gate(0, 'one reworded entirely')), null);
    const f = mintDebt(EMPTY_LEDGER, [], { type: 'finding-deferred', finding: F1, severity: 'P2', obligation: null, unit: null, what: 'f' })!;
    assert.deepEqual(f.source, { type: 'finding', finding: F1 });
    assert.equal(mintDebt(EMPTY_LEDGER, [f], { type: 'finding-deferred', finding: F1, severity: 'P2', obligation: null, unit: null, what: 'g' }), null);
  });
  it('dedupes by key against the arc and the unresolved baseline, normalising whitespace', () => {
    const a = mintDebt(EMPTY_LEDGER, [], gate(0, 'same  thing'))!;
    assert.equal(mintDebt(EMPTY_LEDGER, [a], gate(1, 'same thing', 2)), null);
    assert.equal(mintDebt(ledger(item(1, 'same thing')), [], gate(0, ' same thing ')), null);
    assert.equal(mintDebt(ledger(item(1, 'same thing', { state: 'promoted' })), [], gate(0, 'same thing')), null);
    assert.equal(mintDebt(ledger(item(1, 'same thing', { state: 'resolved' })), [], gate(0, 'same thing'))!.id, 'B-2');
  });
  it('banks the normalised text and the key the ledger computes', () => {
    const a = mintDebt(EMPTY_LEDGER, [], gate(0, '  spaced \n out '))!;
    assert.equal(a.what, 'spaced out');
    assert.equal(a.key, debtKey({ unit: u1, bankReason: 'gate-note', what: 'spaced out' }));
  });
  it('refuses empty text', () => assert.throws(() => mintDebt(EMPTY_LEDGER, [], gate(0, ' \n ')), DebtRefusedError));
});

describe('debt.obligation-refused', () => {
  const f = (over: object) => ({ type: 'finding-deferred' as const, finding: F1, severity: 'P2' as const, obligation: null, unit: null, what: 'w', ...over });
  it('refuses a finding with an obligation', () => assert.throws(() => mintDebt(EMPTY_LEDGER, [], f({ obligation: obligationId('I-1') })), DebtRefusedError));
  it('refuses a P1', () => assert.throws(() => mintDebt(EMPTY_LEDGER, [], f({ severity: 'P1' })), DebtRefusedError));
  it('banks a P3 without an obligation', () => assert.equal(mintDebt(EMPTY_LEDGER, [], f({ severity: 'P3' }))!.bankReason, 'finding-deferred'));
});

describe('debt.render-block', () => {
  const arc2 = arcId('arc-2');
  const baseline = ledger(item(1, 'keep me'), item(2, 'promote me'), item(3, 'resolve me'), item(4, 'untouched', { state: 'resolved' }));
  const banked: DebtBanked[] = [mintDebt(baseline, [], gate(0, 'fresh'))!];
  const after = ledgerAfterArc(baseline, arc2, [
    { id: debtId('B-1'), disposition: { type: 'keep', reason: 'later' } },
    { id: debtId('B-2'), disposition: { type: 'promote', unit: unitId('u9') } },
    { id: debtId('B-3'), disposition: { type: 'resolve', ruling: rulingId('C-4') } },
  ], banked, (s) => (s.type === 'gate' ? s.unit : null));

  it('applies dispositions to history and state, and appends banked items', () => {
    assert.deepEqual(after.items.map((i) => [i.id, i.state, i.history.length]), [['B-1', 'open', 1], ['B-2', 'promoted', 1], ['B-3', 'resolved', 1], ['B-4', 'resolved', 0], ['B-5', 'open', 0]]);
    assert.equal(after.items[4]!.originArc, arc2);
    assert.deepEqual(openItems(after).map((i) => i.id), ['B-1', 'B-5']);
  });
  it('rejects a disposition for a non-open or unknown item, and duplicates', () => {
    const d = (id: string) => ({ id: debtId(id), disposition: { type: 'keep' as const, reason: 'r' } });
    assert.throws(() => ledgerAfterArc(baseline, arc2, [d('B-4')], [], () => null));
    assert.throws(() => ledgerAfterArc(baseline, arc2, [d('B-9')], [], () => null));
    assert.throws(() => ledgerAfterArc(baseline, arc2, [d('B-1'), d('B-1')], [], () => null));
  });
  it('renders byte-stably and the block round-trips', () => {
    const text = renderDebt(after);
    assert.equal(renderDebt(after), text);
    assert.deepEqual(parseDebtBlock(text), after);
    assert.equal(text.match(/^```json roadmap-debt$/gm)!.length, 1);
    assert.match(text, /## B-2 — promote me/);
    assert.match(text, /arc-2: promote to u9/);
    assert.equal(DEBT_DOC, '.roadmap/debt.md');
  });
  it('renders an empty ledger and finds no block in foreign text', () => {
    assert.match(renderDebt(EMPTY_LEDGER), /\(no debt\)/);
    assert.deepEqual(parseDebtBlock(renderDebt(EMPTY_LEDGER)), EMPTY_LEDGER);
    assert.equal(parseDebtBlock('# Debt\n\nnothing'), null);
  });
  it('refuses two blocks', () => assert.throws(() => parseDebtBlock(renderDebt(after) + renderDebt(after)), /2 json roadmap-debt blocks/));
});

describe('debt.kept-history', () => {
  const keep = (a: string) => ({ arc: arcId(a), disposition: { type: 'keep' as const, reason: 'r' } });
  it('is true only when the last two arcs both kept it', () => {
    assert.equal(keptInEachOfLastTwoArcs(item(1, 'a', { history: [keep('arc-1'), keep('arc-2')] })), true);
    assert.equal(keptInEachOfLastTwoArcs(item(1, 'a', { history: [keep('arc-1')] })), false);
    assert.equal(keptInEachOfLastTwoArcs(item(1, 'a')), false);
    assert.equal(keptInEachOfLastTwoArcs(item(1, 'a', { history: [{ arc: arcId('arc-1'), disposition: { type: 'promote', unit: u1 } }, keep('arc-2')] })), false);
  });
  it('counts only the two most recent', () => {
    assert.equal(keptInEachOfLastTwoArcs(item(1, 'a', { history: [keep('arc-1'), keep('arc-2'), keep('arc-3')] })), true);
    assert.equal(keptInEachOfLastTwoArcs(item(1, 'a', { history: [keep('arc-1'), keep('arc-2'), { arc: arcId('arc-3'), disposition: { type: 'promote', unit: u1 } }] })), false);
  });
});
