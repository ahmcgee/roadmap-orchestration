// M3 step A1: obligation edits and split semantics (H14), impact selection (split closure, unmapped paths),
// re-derivation against the previous arc's published block (R2), the byte-stable invariants.md, and the vision
// record's rules (coverage both directions, withdrawn cites, edits).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ObligationId, obligationId, unitId, visionClauseId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { repoPath } from '../src/core/values.ts';
import { parseInvariantsBlock, renderInvariants } from '../src/docs/invariants.ts';
import { selectObligations } from '../src/holistic/impact.ts';
import { type ClassifyContext, classifyObligations } from '../src/holistic/obligations.ts';
import { rederive } from '../src/holistic/rederive.ts';
import { type Obligations, type RulingSidecar, type Vision, laneRevOf, parseObligations, parseRulingSidecar, parseVision } from '../src/holistic/types.ts';
import { citeReasons, visionCoverage, visionEditReasons } from '../src/holistic/vision.ts';

const LANE = {
  id: 'journey', argv: ['node', '--test', 'journey.test.js'], cwd: 'test', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [],
  evidenceGlobs: [], evidenceExcludes: [], reporter: 'node-test',
};
const LANE_REV = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [LANE], obligations: [], mapping: { paths: [] } }).lanes[0]!);
const proof = (id: string, rev = 1, testIds: readonly string[] = [id]): object => ({ verdict: 'proves', obligationRev: rev, laneRev: LANE_REV, witness: { lane: 'journey', testIds } });

type Raw = Record<string, unknown>;
const ob = (id: string, over: Raw = {}): Raw => ({
  id, rev: 1, statement: `${id} holds.`, docRef: { path: 'docs/target.md', anchor: `#${id.toLowerCase()}`, quotedText: id },
  serves: ['V-1'], witness: { lane: 'journey', testIds: [id] }, proofJudgment: proof(id), deliveredBy: [], activation: 'must-hold', contracts: [],
  state: { type: 'active' }, ...over,
});

// I-1 future delivered by report; I-2 must-hold on docs/money.md; I-3 must-hold, mapped to src/format.js.
const BASE: Raw[] = [
  ob('I-1', { activation: 'future', deliveredBy: ['report'], statement: 'A month reconciles in one command.' }),
  ob('I-2', { statement: 'Money is never mis-rounded. Totals round half-even.', contracts: ['docs/money.md'] }),
  ob('I-3', { statement: 'Unknown commands exit 2.', serves: ['V-2'] }),
];
const file = (obligations: Raw[], mapping: Raw[] = [{ pattern: 'src/format.js', obligations: ['I-3'] }, { pattern: 'src/report/**', obligations: ['I-1'] }]): Obligations =>
  parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'the ledger CLI', lanes: [LANE], obligations, mapping: { paths: mapping } });
const PREV = file(BASE);
/** The obligations without I-3 (and its mapping entry). */
const WITHOUT_I3 = (): Obligations => file(BASE.filter((o) => o['id'] !== 'I-3'), [{ pattern: 'src/report/**', obligations: ['I-1'] }]);

const VISION: Vision = parseVision({
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'reconcile a month in one command', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'money is never silently mis-rounded', rank: null, state: 'active' },
    { id: 'V-3', kind: 'tradeoff', text: 'clear errors over permissive input', rank: 1, state: 'active' },
    { id: 'V-4', kind: 'good', text: 'terse output', rank: null, state: 'withdrawn' },
  ],
});

const ruling = (id: string, dispositions: readonly Readonly<{ id: string; disposition: string }>[]): RulingSidecar => parseRulingSidecar({
  schema: 'roadmap/ruling-m3', id, statement: `ruling ${id}`, kind: 'disposition', ruledBy: { type: 'architect' }, trigger: 'phase 0', supersedes: [], condition: null,
  docRefs: [{ path: 'docs/target.md', anchor: '#i-2', quotedText: 'I-2', relation: 'consistent' }], contractRefs: [], contractOps: [],
  obligations: [...new Set(dispositions.map((d) => d.id))].sort(), obligationDispositions: dispositions, cites: [], evidence: [], appliesTo: { type: 'arc' },
  lifetime: 'standing', status: 'active',
  consistency: {
    verdict: 'consistent', judgedRevs: { head: 'a'.repeat(40), ledgerSha256: '1'.repeat(64), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' },
  },
});

const ARCHITECT: ClassifyContext = { vision: VISION, rulings: [], author: { type: 'architect' } };
const withRulings = (rulings: readonly RulingSidecar[]): ClassifyContext => ({ ...ARCHITECT, rulings });
const replace = (id: string, over: Raw): Raw[] => BASE.map((o) => (o['id'] === id ? { ...o, ...over } : o));

describe('obligation edits', () => {
  it('obligations.unchanged-and-added: a new id starts at rev 1, active, proven, serving active clauses', () => {
    assert.deepEqual(classifyObligations(PREV, PREV, ARCHITECT), { changes: [], mapping: false, lanes: [], cutLine: false, reasons: [] });
    const added = classifyObligations(PREV, file([...BASE, ob('I-4', { serves: ['V-3'] })]), ARCHITECT);
    assert.deepEqual(added.changes, [{ type: 'added', id: 'I-4', activation: 'must-hold' }]);
    assert.deepEqual(added.reasons, []);
    const bad = classifyObligations(PREV, file([...BASE, ob('I-4', { rev: 2, proofJudgment: { ...proof('I-4', 2), verdict: 'insufficient' }, serves: ['V-4'] })]), ARCHITECT);
    assert.deepEqual(bad.reasons, ['I-4 is new and starts at rev 1, not 2', "I-4's witness is judged insufficient (a new witness must prove it)", 'I-4 cites V-4, which is withdrawn (a withdrawn clause may not be newly cited)']);
    const none = classifyObligations(PREV, file([...BASE, ob('I-4', { serves: [] })]), ARCHITECT);
    assert.deepEqual(none.reasons, ['I-4 serves no vision clause (the arc has a vision)']);
    assert.deepEqual(classifyObligations(null, PREV, ARCHITECT).changes.map((c) => c.type), ['added', 'added', 'added']);
  });

  it('obligations.weakening-needs-ruling: removal, amendment, must-hold → future, disposal and a shrunk witness each need a ruling naming the id', () => {
    const cases: readonly [Obligations, string, string][] = [
      [WITHOUT_I3(), 'removed', 'retired'],
      [file(replace('I-3', { statement: 'Unknown commands exit 64.', rev: 2, proofJudgment: proof('I-3', 2) })), 'statement changed', 'amended'],
      [file(replace('I-3', { docRef: { path: 'docs/target.md', anchor: '#cli', quotedText: 'exit' }, rev: 2, proofJudgment: proof('I-3', 2) })), 'docRef changed', 'amended'],
      [file(replace('I-3', { activation: 'future', deliveredBy: ['tidy'], rev: 2, proofJudgment: proof('I-3', 2) })), 'must-hold → future', 'amended'],
      [file(replace('I-3', { state: { type: 'waived', ruling: 'C-5' } })), 'waived by C-5', 'waived'],
      [file(replace('I-3', { witness: { lane: 'journey', testIds: ['other'] }, proofJudgment: proof('I-3', 1, ['other']) })), 'witness no longer names "I-3"', 'amended'],
    ];
    for (const [obligations, what, disposition] of cases) {
      const v = classifyObligations(PREV, obligations, ARCHITECT);
      assert.ok(v.reasons.some((r) => r.startsWith(`I-3 is weakened (${what}) without a ruling in force naming it ${disposition}`)), `${what}: ${JSON.stringify(v.reasons)}`);
      const ok = classifyObligations(PREV, obligations, withRulings([ruling('C-5', [{ id: 'I-3', disposition }])]));
      assert.deepEqual(ok.reasons, [], what);
      assert.ok(ok.changes.some((c) => c.type === 'disposed' && c.id === 'I-3' && c.disposition === disposition && c.ruling === 'C-5'), what);
    }
    // A ruling naming another disposition does not do; a state's own ruling must be the one.
    assert.ok(classifyObligations(PREV, file(replace('I-3', { state: { type: 'waived', ruling: 'C-5' } })), withRulings([ruling('C-5', [{ id: 'I-3', disposition: 'deferred' }])])).reasons.length > 0);
    assert.ok(classifyObligations(PREV, file(replace('I-3', { state: { type: 'waived', ruling: 'C-5' } })), withRulings([ruling('C-6', [{ id: 'I-3', disposition: 'waived' }])])).reasons.length > 0);
    // Restoring, and strengthening, need none.
    const waived = file(replace('I-3', { state: { type: 'waived', ruling: 'C-5' } }));
    assert.deepEqual(classifyObligations(waived, PREV, ARCHITECT).changes, [{ type: 'restored', id: 'I-3' }]);
    const latched = classifyObligations(PREV, file(replace('I-1', { activation: 'must-hold', rev: 2, proofJudgment: proof('I-1', 2) })), ARCHITECT);
    assert.deepEqual(latched, { changes: [{ type: 'edited', id: 'I-1', fields: ['activation'] }], mapping: false, lanes: [], cutLine: false, reasons: [] });
  });

  it('obligations.revs-and-proofs: the rev rises exactly with a normative change; a stale proof judgment is refused; a new witness must prove; a proof binds the complete witness definition', () => {
    assert.deepEqual(classifyObligations(PREV, file(replace('I-2', { rev: 2, proofJudgment: proof('I-2', 2) })), ARCHITECT).reasons, ['I-2 takes rev 1, not 2 (the rev rises exactly when its statement, docRef or activation changes)']);
    assert.deepEqual(classifyObligations(PREV, file(replace('I-2', { proofJudgment: { ...proof('I-2'), laneRev: '0000000000000000' } })), ARCHITECT).reasons,
      [`I-2's proof judgment is stale (judged obligation rev 1, lane 0000000000000000; now rev 1, lane ${LANE_REV})`]);
    // Checkpoint A: a witness whose test set grows (lane and obligation revs unchanged) needs a fresh proof of that witness.
    const grownWitness = { lane: 'journey', testIds: ['I-2', 'half-even'] };
    const unreviewed = classifyObligations(PREV, file(replace('I-2', { witness: grownWitness })), ARCHITECT);
    assert.deepEqual(unreviewed.reasons, [`I-2's proof judgment is stale (judged witness {"lane":"journey","testIds":["I-2"]}; now {"lane":"journey","testIds":["I-2","half-even"]})`]);
    const grown = classifyObligations(PREV, file(replace('I-2', { witness: grownWitness, proofJudgment: proof('I-2', 1, grownWitness.testIds) })), ARCHITECT);
    assert.deepEqual(grown, { changes: [{ type: 'witness', id: 'I-2' }], mapping: false, lanes: [], cutLine: false, reasons: [] });
    // A proof of the same tests on another lane id is stale too.
    const otherLane = { lane: 'suite', testIds: ['I-2'] };
    assert.deepEqual(classifyObligations(PREV, file(replace('I-2', { proofJudgment: { ...proof('I-2'), witness: otherLane } })), ARCHITECT).reasons,
      [`I-2's proof judgment is stale (judged witness {"lane":"suite","testIds":["I-2"]}; now {"lane":"journey","testIds":["I-2"]})`]);
    const unproven = classifyObligations(PREV, file(replace('I-2', { witness: { lane: 'journey', testIds: ['I-2', 'x'] }, proofJudgment: { ...proof('I-2', 1, ['I-2', 'x']), verdict: 'insufficient' } })), ARCHITECT);
    assert.deepEqual(unproven.reasons, ["I-2's witness is judged insufficient (a new witness must prove it)"]);
    const moved = classifyObligations(PREV, file(BASE, [{ pattern: 'src/**', obligations: ['I-3'] }]), ARCHITECT);
    assert.equal(moved.mapping, true);
  });

  it('obligations.split-text: the architect\'s children keep every parent sentence; a checkpoint may drop text citing an active clause (H14)', () => {
    const splitInto = (children: Raw[]): Obligations => file([
      ...replace('I-2', { witness: null, proofJudgment: null, state: { type: 'split', children: children.map((c) => c['id']) } }),
      ...children.map((c) => ({ ...c, parent: 'I-2' })),
    ]);
    const keeps = splitInto([ob('I-4', { statement: 'Money is never mis-rounded.', serves: ['V-2'] }), ob('I-5', { statement: 'Totals round half-even. Refunds too.', serves: ['V-2'] })]);
    assert.deepEqual(classifyObligations(PREV, keeps, ARCHITECT), {
      changes: [{ type: 'split', id: 'I-2', children: ['I-4', 'I-5'], dropped: [] }], mapping: false, lanes: [], cutLine: false, reasons: [],
    });
    const drops = splitInto([ob('I-4', { statement: 'Money is never mis-rounded.', serves: ['V-2'] })]);
    assert.deepEqual(classifyObligations(PREV, drops, ARCHITECT).reasons, ['I-2\'s children drop parent text: "Totals round half-even."']);
    const ckpt = classifyObligations(PREV, drops, { ...ARCHITECT, author: { type: 'checkpoint', cites: [visionClauseId('V-2')] } });
    assert.deepEqual(ckpt.reasons, []);
    assert.deepEqual(ckpt.changes, [{ type: 'split', id: 'I-2', children: ['I-4'], dropped: ['Totals round half-even.'] }]);
    assert.deepEqual(classifyObligations(PREV, drops, { ...ARCHITECT, author: { type: 'checkpoint', cites: [visionClauseId('V-4')] } }).reasons,
      ["I-2's split cites V-4, which is withdrawn (a withdrawn clause may not be newly cited)"]);
    // A split parent stays split into the same children; an existing obligation is not a new child.
    assert.deepEqual(classifyObligations(keeps, keeps, ARCHITECT).reasons, []);
    const regrow = file([
      ...replace('I-2', { witness: null, proofJudgment: null, state: { type: 'split', children: ['I-4', 'I-5', 'I-6'] } }),
      ob('I-4', { parent: 'I-2', statement: 'Money is never mis-rounded.', serves: ['V-2'] }), ob('I-5', { parent: 'I-2', statement: 'Totals round half-even. Refunds too.', serves: ['V-2'] }),
      ob('I-6', { parent: 'I-2' }),
    ]);
    assert.ok(classifyObligations(keeps, regrow, ARCHITECT).reasons.includes('I-2 is split and stays split into I-4, I-5'));
    const adopt = file([...replace('I-2', { witness: null, proofJudgment: null, state: { type: 'split', children: ['I-3'] } }).map((o) => (o['id'] === 'I-3' ? { ...o, parent: 'I-2', statement: 'Money is never mis-rounded. Totals round half-even.' } : o))]);
    const adopted = classifyObligations(PREV, adopt, ARCHITECT).reasons;
    assert.ok(adopted.includes('I-2 splits into I-3, which is not a new obligation'), JSON.stringify(adopted));
    assert.ok(adopted.includes("I-3's parent changed (a split family is fixed)"), JSON.stringify(adopted));
  });
});

describe('impact selection', () => {
  const O = file([
    ...BASE,
    ob('I-4', { statement: 'Parse errors name the line.', docRef: { path: 'docs/parse.md', anchor: '#errors', quotedText: 'line' }, witness: { lane: 'journey', testIds: ['parse'] } }),
  ], [{ pattern: 'src/format.js', obligations: ['I-3'] }, { pattern: 'src/report', obligations: ['I-1'] }, { pattern: 'src/**', obligations: ['I-4'] }]);
  const select = (over: Partial<Parameters<typeof selectObligations>[0]> = {}): readonly ObligationId[] => selectObligations({
    obligations: O, units: [{ unit: unitId('tidy'), declared: [], repairs: [] }], closure: [], changedPaths: [], revised: [], ...over,
  });
  const ids = (...xs: string[]): ObligationId[] => xs.map((x) => obligationId(x));

  it('impact.declared: declared obligations, repairs, the dependency closure and a revision\'s revised ones', () => {
    assert.deepEqual(select(), []);
    assert.deepEqual(select({ units: [{ unit: unitId('tidy'), declared: ids('I-3'), repairs: ids('I-2') }] }), ids('I-2', 'I-3'));
    assert.deepEqual(select({ closure: ids('I-4'), revised: ids('I-2') }), ids('I-2', 'I-4'));
    assert.throws(() => select({ closure: ids('I-9') }), /I-9 is not an obligation in force/);
  });

  it('impact.touched: a changed contract, docRef document, witness file or mapped path selects', () => {
    assert.deepEqual(select({ changedPaths: [repoPath('src/format.js')] }), ids('I-3', 'I-4'));
    assert.deepEqual(select({ changedPaths: [repoPath('src/report/month.js')] }), ids('I-1', 'I-4'));
    assert.deepEqual(select({ changedPaths: [repoPath('docs/money.md')] }).includes(obligationId('I-2')), true);
    assert.deepEqual(select({ changedPaths: [repoPath('src/format.js'), repoPath('docs/parse.md')] }).includes(obligationId('I-4')), true);
    // The lane runs `journey.test.js` from `test`: that file is every journey-witnessed obligation's witness file.
    assert.deepEqual(select({ changedPaths: [repoPath('src/x.js'), repoPath('test/journey.test.js')] }), ids('I-1', 'I-2', 'I-3', 'I-4'));
  });

  it('impact.future: the future obligations a candidate delivers are selected', () => {
    assert.deepEqual(select({ units: [{ unit: unitId('report'), declared: [], repairs: [] }] }), ids('I-1'));
  });

  it('impact.unmapped-selects-must-hold: a changed path no mapping pattern matches selects every must-hold obligation', () => {
    assert.deepEqual(select({ changedPaths: [repoPath('README.md')] }), ids('I-2', 'I-3', 'I-4'));
  });

  it('impact.split-closure: a selected child selects its parent, and a selected parent its children, transitively (H14)', () => {
    const S = file([
      ob('I-1', { witness: null, proofJudgment: null, state: { type: 'split', children: ['I-2', 'I-3'] } }),
      ob('I-2', { parent: 'I-1' }),
      ob('I-3', { parent: 'I-1', witness: null, proofJudgment: null, state: { type: 'split', children: ['I-4'] } }),
      ob('I-4', { parent: 'I-3' }),
      ob('I-5'),
    ], [{ pattern: 'src/a.js', obligations: ['I-4'] }, { pattern: 'src/b.js', obligations: ['I-5'] }]);
    const pick = (over: Partial<Parameters<typeof selectObligations>[0]>): readonly ObligationId[] => selectObligations({
      obligations: S, units: [], closure: [], changedPaths: [], revised: [], ...over,
    });
    assert.deepEqual(pick({ changedPaths: [repoPath('src/a.js')] }), ids('I-1', 'I-2', 'I-3', 'I-4'));
    assert.deepEqual(pick({ revised: ids('I-1') }), ids('I-1', 'I-2', 'I-3', 'I-4'));
    assert.deepEqual(pick({ changedPaths: [repoPath('src/b.js')] }), ids('I-5'));
  });
});

describe('invariants.md and re-derivation', () => {
  it('invariants.block-roundtrip: the machine block reads back as the published obligations (latched → must-hold), byte-stable', () => {
    const text = renderInvariants(PREV, [obligationId('I-1')]);
    assert.equal(renderInvariants(PREV, [obligationId('I-1')]), text);
    const back = parseInvariantsBlock(text);
    assert.ok(back !== null);
    assert.equal(back.obligations.find((o) => o.id === 'I-1')?.activation, 'must-hold');
    assert.equal(canonicalJson(back), canonicalJson(file(replace('I-1', { activation: 'must-hold' }))));
    assert.equal(canonicalJson(parseInvariantsBlock(renderInvariants(PREV, []))), canonicalJson(PREV));
    assert.match(text, /^## I-2 — Money is never mis-rounded\. Totals round half-even\.\n\n- state: active\n- activation: must-hold\n- rev: 1\n/m);
    assert.equal(parseInvariantsBlock('# Invariants\n\nnothing published\n'), null);
    assert.throws(() => parseInvariantsBlock(`${text}\n${text}`), /2 json roadmap-obligations blocks/);
    assert.throws(() => renderInvariants(PREV, [obligationId('I-9')]), /I-9 is not an obligation/);
  });

  it('rederive.drop-refused: a published id missing or weakened needs a Phase-0 ruling; a split parent is present; new ids are free', () => {
    const published = renderInvariants(PREV, []);
    assert.deepEqual(rederive(null, PREV, []), []);
    assert.deepEqual(rederive('# Invariants\n', PREV, []), []);
    assert.deepEqual(rederive(published, file([...BASE, ob('I-9')]), []), []);
    const dropped = WITHOUT_I3();
    assert.deepEqual(rederive(published, dropped, []), ['obligation-dropped: I-3 (removed) has no Phase-0 ruling naming it retired']);
    assert.deepEqual(rederive(published, dropped, [ruling('C-1', [{ id: 'I-3', disposition: 'retired' }])]), []);
    assert.deepEqual(rederive(published, null, []).length, 3);
    const weakened = file(replace('I-2', { activation: 'future', deliveredBy: ['tidy'], rev: 2, proofJudgment: proof('I-2', 2) }));
    assert.deepEqual(rederive(published, weakened, []), ['obligation-dropped: I-2 (must-hold → future) has no Phase-0 ruling naming it amended']);
    const split = file([
      ...replace('I-2', { witness: null, proofJudgment: null, state: { type: 'split', children: ['I-4'] } }),
      ob('I-4', { parent: 'I-2', statement: 'Money is never mis-rounded. Totals round half-even.' }),
    ]);
    assert.deepEqual(rederive(published, split, []), []);
    const retired = renderInvariants(file(replace('I-3', { state: { type: 'retired', ruling: 'C-2' } })), []);
    assert.deepEqual(rederive(retired, WITHOUT_I3(), []), [], 'a retired obligation may leave');
  });
});

describe('the vision record', () => {
  it('vision.coverage: unserved active clauses, obligations serving no active clause, withdrawn clauses still cited', () => {
    const o = file([...BASE, ob('I-4', { serves: ['V-4'] }), ob('I-5', { serves: ['V-3'], state: { type: 'waived', ruling: 'C-1' } })]);
    assert.deepEqual(visionCoverage(VISION, o, [{ id: 'C-2', cites: [visionClauseId('V-4')] }, { id: 'D-1', cites: [visionClauseId('V-2')] }]), {
      unservedClauses: ['V-3'],
      obligationsServingNone: ['I-4'],
      withdrawnCited: [{ clause: 'V-4', citedBy: ['C-2', 'I-4'] }],
    });
    assert.deepEqual(visionCoverage(VISION, null, []), { unservedClauses: ['V-1', 'V-2', 'V-3'], obligationsServingNone: [], withdrawnCited: [] });
  });

  it('vision.withdrawn-cite-refused: a new ruling, obligation or bundle op may not cite a withdrawn clause; existing citations stay', () => {
    assert.deepEqual(citeReasons(VISION, [visionClauseId('V-1'), visionClauseId('V-4')], 'op 2'), ['op 2 cites V-4, which is withdrawn (a withdrawn clause may not be newly cited)']);
    assert.deepEqual(citeReasons(VISION, [visionClauseId('V-7')], 'op 1'), ['op 1 cites V-7, which is not a clause of the vision in force']);
    const citing = file([...BASE, ob('I-4', { serves: ['V-1', 'V-4'] })]);
    assert.deepEqual(classifyObligations(PREV, citing, ARCHITECT).reasons, ['I-4 cites V-4, which is withdrawn (a withdrawn clause may not be newly cited)']);
    assert.deepEqual(classifyObligations(citing, citing, ARCHITECT).reasons, [], 'an existing citation of a clause withdrawn since stays');
    const newCite = file(replace('I-3', { serves: ['V-2', 'V-4'] }));
    assert.deepEqual(classifyObligations(PREV, newCite, ARCHITECT).reasons, ['I-3 cites V-4, which is withdrawn (a withdrawn clause may not be newly cited)']);
  });

  it('vision.edit: clauses stay, a withdrawn clause stays withdrawn as it was, a change takes the next rev', () => {
    const raw = JSON.parse(canonicalJson(VISION)) as { clauses: Raw[] } & Raw;
    const next = (clauses: Raw[], rev = 2): Vision => parseVision({ ...raw, rev, clauses });
    assert.deepEqual(visionEditReasons(VISION, VISION), []);
    assert.deepEqual(visionEditReasons(null, VISION), []);
    const withdrawV3 = raw.clauses.map((c) => (c['id'] === 'V-3' ? { ...c, state: 'withdrawn' } : c));
    assert.deepEqual(visionEditReasons(VISION, next(withdrawV3)), []);
    assert.deepEqual(visionEditReasons(VISION, next(withdrawV3, 1)), ['a changed vision takes rev 2, not 1']);
    assert.deepEqual(visionEditReasons(VISION, next(raw.clauses.filter((c) => c['id'] !== 'V-2'))), ['vision clause V-2 was removed (a clause stays in the file; withdraw it instead)']);
    const reused = raw.clauses.map((c) => (c['id'] === 'V-4' ? { ...c, text: 'something new', state: 'active' } : c));
    assert.deepEqual(visionEditReasons(VISION, next(reused)), ['vision clause V-4 is withdrawn and stays as it was (ids are never reused; add a new clause)']);
  });
});
