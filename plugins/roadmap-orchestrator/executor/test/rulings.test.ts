// M3 step A1: ruling sidecar validation against the ledger in force (identity, anchors, quoted text, supersede-only,
// overlapping anchors, deviations, G21 consistency freshness, withdrawn cites), anchor-exact contract ops, landing a
// ruling in the ledger, and the byte-stable constraints.md with its close-out retirement.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Sha, ruleId, rulingId, sha, sha256, unitId } from '../src/core/ids.ts';
import { type RepoPath, repoPath } from '../src/core/values.ts';
import { anchorSection, applyContractOps, citeRuling, headingSlug } from '../src/docs/contracts.ts';
import { renderConstraints } from '../src/docs/constraints.ts';
import { type Obligations, type RulingSidecar, type Vision, parseObligations, parseRulingSidecar, parseVision } from '../src/holistic/types.ts';
import { type RulingContext, consistencyRevs, effectiveRulingRevs, ledgerAfter, nextRulingId, parseRulings, sidecarsAfter, validateRuling } from '../src/spec/rulings.ts';

const HEAD = sha('a'.repeat(40));
const BLOB = sha('b'.repeat(40));
const BLOB2 = sha('c'.repeat(40));
const LEDGER_SHA = sha256('1'.repeat(64));
const OBL_SHA = sha256('2'.repeat(64));
const VIS_SHA = sha256('3'.repeat(64));
const REV = '0123456789abcdef';

const MONEY = [
  '# Money',
  '',
  '## Rounding',
  '',
  'Totals round half-up at the cent.',
  'Rates keep four places.',
  '',
  '### Display',
  '',
  'Amounts show two places.',
  '',
  '## Currency',
  '',
  'One currency per ledger.',
  '',
  '```md',
  '## Rounding',
  '```',
  '',
].join('\n');
const TARGET = '# Target\n\n## Reconcile\n\nA month reconciles in one command.\n';

const LEDGER_TEXT = '# Rulings\n\nC-1 — totals are integers of cents\nC-2 — errors exit 2\n';

const VISION: Vision = parseVision({
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'bookkeepers reconcile a month in one command', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'money is never silently mis-rounded', rank: null, state: 'active' },
    { id: 'V-3', kind: 'good', text: 'terse output', rank: null, state: 'withdrawn' },
    { id: 'V-4', kind: 'world', text: 'a bookkeeper closes the month by running one command and trusting every total', rank: null, state: 'active' },
  ],
  questions: [],
});

const OBLIGATIONS: Obligations = parseObligations({
  schema: 'roadmap/obligations-m3', cutLine: 'the ledger CLI', lanes: [{
    id: 'journey', argv: ['node', '--test', 'test/journey.test.js'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [],
    evidenceGlobs: [], evidenceExcludes: [], reporter: 'node-test',
  }],
  obligations: [{
    id: 'I-2', rev: 1, statement: 'money is never silently mis-rounded', docRef: { path: 'docs/money.md', anchor: '#rounding', quotedText: 'half-up' },
    serves: ['V-2'], witness: { lane: 'journey', testIds: ['rounding'] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: '0123456789abcdef', witness: { lane: 'journey', testIds: ['rounding'] } },
    deliveredBy: [], activation: 'must-hold', contracts: ['docs/money.md'], state: { type: 'active' },
  }],
  mapping: { paths: [] },
});

const DOCS: Readonly<Record<string, string>> = { 'docs/money.md': MONEY, 'docs/target.md': TARGET };
const BLOBS: Readonly<Record<string, Sha>> = { 'docs/money.md': BLOB, 'docs/api.md': BLOB2 };

function context(over: Partial<RulingContext> = {}): RulingContext {
  return {
    ledger: parseRulings(LEDGER_TEXT, 'ledger'),
    inForce: { head: HEAD, ledgerSha256: LEDGER_SHA, obligationsSha256: OBL_SHA, visionSha256: VIS_SHA },
    docAt: (p) => DOCS[p] ?? null,
    blobAt: (p) => BLOBS[p] ?? null,
    documents: [repoPath('docs/money.md'), repoPath('docs/api.md')],
    obligations: OBLIGATIONS,
    vision: VISION,
    units: [unitId('tidy'), unitId('report')],
    corpus: null,
    ...over,
  };
}

/** A valid architect ruling C-3 amending the rounding rule; `over` replaces fields (raw JSON, parsed). */
function sidecar(over: Record<string, unknown> = {}): RulingSidecar {
  return parseRulingSidecar({
    schema: 'roadmap/ruling-m3', id: 'C-3', statement: 'totals round half-even at the cent', kind: 'deviation', ruledBy: { type: 'architect' }, trigger: 'F-1',
    supersedes: [{ id: 'C-1', part: null }], condition: null,
    docRefs: [
      { path: 'docs/money.md', anchor: '#rounding', quotedText: 'Totals round half-up', relation: 'deviates' },
      { path: 'docs/target.md', anchor: 'reconciles in one command', quotedText: 'one command', relation: 'consistent' },
    ],
    contractRefs: ['docs/money.md'], contractOps: [{ path: 'docs/money.md', anchor: '#rounding', oldText: 'half-up', newText: 'half-even' }],
    obligations: ['I-2'], obligationDispositions: [{ id: 'I-2', disposition: 'amended' }], cites: ['V-2'], evidence: ['F-1: 0.125 rounds to 0.13'],
    appliesTo: { type: 'arc' }, lifetime: 'standing', status: 'active',
    consistency: {
      verdict: 'consistent', judgedRevs: { head: HEAD, ledgerSha256: LEDGER_SHA, obligationsSha256: OBL_SHA, visionSha256: VIS_SHA, contracts: [{ path: 'docs/money.md', blob: BLOB }] },
      by: { type: 'architect' },
    },
    ...over,
  });
}

const refused = (s: RulingSidecar, pattern: RegExp, ctx: RulingContext = context()): void => {
  const reasons = validateRuling(s, ctx);
  assert.ok(reasons.some((r) => pattern.test(r)), `expected a reason matching ${pattern}, got ${JSON.stringify(reasons)}`);
};

describe('ruling sidecars', () => {
  it('rulings.sidecar-valid: a well-formed ruling on the revisions in force passes', () => {
    assert.deepEqual(validateRuling(sidecar(), context()), []);
  });

  it('rulings.sidecar-identity: the next C-n only; an existing id is never edited; lands active with a one-line statement', () => {
    assert.equal(nextRulingId(context().ledger), 'C-3');
    assert.equal(nextRulingId([]), 'C-1');
    refused(sidecar({ id: 'C-2' }), /C-2 is already in the ledger .*supersede/);
    refused(sidecar({ id: 'C-5' }), /not the ledger's next id \(C-3\)/);
    refused(sidecar({ status: 'superseded' }), /status active/);
    refused(sidecar({ statement: 'two\nlines' }), /one line/);
    refused(sidecar({ statement: 'withdrawn by C-1' }), /withdrawn fold/);
  });

  it('rulings.sidecar-anchors: a docRef anchor must name exactly one heading or line', () => {
    refused(sidecar({ docRefs: [{ path: 'docs/target.md', anchor: '#nowhere', quotedText: 'x', relation: 'consistent' }], contractOps: [], contractRefs: [] }), /#nowhere.*matches 0 headings/);
    const twice: Readonly<Record<string, string>> = { ...DOCS, 'docs/target.md': `${TARGET}\n## Reconcile\n\nagain\n` };
    refused(sidecar({ docRefs: [{ path: 'docs/target.md', anchor: '#reconcile', quotedText: 'one command', relation: 'consistent' }], contractOps: [], contractRefs: [] }),
      /matches 2 headings/, context({ docAt: (p) => twice[p] ?? null }));
    refused(sidecar({ docRefs: [{ path: 'docs/nope.md', anchor: '#a', quotedText: 'x', relation: 'consistent' }], contractOps: [], contractRefs: [] }), /docs\/nope\.md: no such document/);
  });

  it('rulings.sidecar-quoted-text: the quoted text must be under its anchor, not elsewhere in the document', () => {
    refused(sidecar({ docRefs: [{ path: 'docs/money.md', anchor: '#currency', quotedText: 'Totals round half-up', relation: 'deviates' }] }), /quoted text .* is not under anchor "#currency"/);
    assert.deepEqual(validateRuling(sidecar({ docRefs: [{ path: 'docs/money.md', anchor: '#rounding', quotedText: 'Amounts show two places', relation: 'deviates' }] }), context()), [], 'a subsection is under its heading');
  });

  it('rulings.sidecar-supersede: supersede is the only change: an active ledger ruling, once, never itself', () => {
    const withdrawn = parseRulings(`${LEDGER_TEXT}C-3 — later\n`.replace('C-2 — errors exit 2', 'C-2 — withdrawn by C-3'), 'ledger');
    refused(sidecar({ id: 'C-4', supersedes: [{ id: 'C-2', part: null }] }), /C-2, which is already withdrawn by C-3/, context({ ledger: withdrawn }));
    refused(sidecar({ supersedes: [{ id: 'C-9', part: null }] }), /C-9, which is not in the ledger/);
    refused(sidecar({ supersedes: [{ id: 'C-1', part: null }, { id: 'C-1', part: 'x' }] }), /C-1 twice/);
    refused(sidecar({ supersedes: [{ id: 'C-3', part: null }] }), /supersedes itself/);
  });

  it('rulings.sidecar-overlap: two contract ops of one document with overlapping anchors are refused', () => {
    const ops = [
      { path: 'docs/money.md', anchor: '#rounding', oldText: 'half-up', newText: 'half-even' },
      { path: 'docs/money.md', anchor: '#display', oldText: 'two places', newText: 'three places' },
    ];
    refused(sidecar({ contractOps: ops }), /contract ops on docs\/money\.md overlap: anchors "#rounding" and "#display"/);
    const disjoint = [ops[1], { path: 'docs/money.md', anchor: '#currency', oldText: 'One currency', newText: 'Many currencies' }];
    assert.deepEqual(validateRuling(sidecar({ contractOps: disjoint }), context()), []);
  });

  it('rulings.deviates-needs-ops: a deviating docRef without contract ops is refused; ops stay on listed plan documents', () => {
    assert.throws(() => sidecar({ contractOps: [] }), /contractOps/);
    refused(sidecar({ contractOps: [{ path: 'docs/target.md', anchor: '#reconcile', oldText: 'one command', newText: 'two' }] }), /docs\/target\.md, which is not a plan contract/);
    refused(sidecar({ contractRefs: ['docs/api.md'] }), /contract op on docs\/money\.md, which its contractRefs do not list/);
  });

  it('rulings.obligations-and-scope: named obligations exist, dispositions are named, appliesTo names planned units', () => {
    refused(sidecar({ obligations: ['I-2', 'I-7'] }), /obligation I-7, which is not in force/);
    refused(sidecar({ obligations: [], obligationDispositions: [{ id: 'I-2', disposition: 'amended' }] }), /dispositions I-2 without naming it/);
    refused(sidecar({ appliesTo: { type: 'units', units: ['ghost'] } }), /applies to ghost/);
  });

  it('rulings.consistency-stale: judged revisions other than those in force, or an inconsistent verdict, are refused (G21)', () => {
    const judged = sidecar().consistency.judgedRevs;
    const withRevs = (revs: object, by: object = { type: 'architect' }): RulingSidecar => sidecar({ consistency: { verdict: 'consistent', judgedRevs: { ...judged, ...revs }, by } });
    // The judged head is provenance only: a merge that leaves the judged revisions untouched keeps it fresh.
    assert.deepEqual(validateRuling(withRevs({ head: sha('d'.repeat(40)) }), context()), []);
    refused(withRevs({ ledgerSha256: sha256('9'.repeat(64)) }), /stale: judged ledgerSha256/);
    refused(withRevs({ obligationsSha256: null }), /stale: judged obligationsSha256/);
    refused(withRevs({ visionSha256: sha256('8'.repeat(64)) }), /stale: judged visionSha256/);
    refused(withRevs({ contracts: [{ path: 'docs/money.md', blob: BLOB2 }] }), /stale: judged contracts/);
    refused(withRevs({ contracts: [] }), /stale: judged contracts/);
    refused(sidecar({ consistency: { verdict: 'inconsistent', judgedRevs: judged, by: { type: 'architect' } } }), /found it inconsistent/);
    // The head moved after the judgment, the judged revisions did not: still fresh; a judged contract moving is stale.
    assert.deepEqual(validateRuling(sidecar(), context({ inForce: { ...context().inForce, head: sha('e'.repeat(40)) } })), []);
    const fresh = consistencyRevs(sidecar(), context());
    assert.ok('revs' in fresh);
    assert.deepEqual(fresh.revs, judged);
    // A checkpoint's ruling carries its own judgment, never the architect's.
    const ckpt = sidecar({ ruledBy: { type: 'checkpoint', job: 'ckpt-1' } });
    refused(ckpt, /the checkpoint's: its consistency is a judgment's/);
    assert.deepEqual(validateRuling(sidecar({ ruledBy: { type: 'checkpoint', job: 'ckpt-1' }, consistency: { verdict: 'consistent', judgedRevs: judged, by: { type: 'judgment', role: 'checkpoint', routingRev: REV } } }), context()), []);
  });

  it('rulings.withdrawn-cite-refused: a new ruling may not cite a withdrawn or unknown clause', () => {
    refused(sidecar({ cites: ['V-2', 'V-3'] }), /cites V-3, which is withdrawn/);
    refused(sidecar({ cites: ['V-9'] }), /cites V-9, which is not a clause/);
    refused(sidecar({ cites: ['V-1'] }), /cites V-1/, context({ vision: null }));
  });
});

describe('a corpus arc\'s rulings (M4a step C1)', () => {
  const T1 = sha256('3'.repeat(64));
  /** A corpus in force with T-1 active, whose same-repo file set holds `docs/money.md` (a state the plan rows prevent; the guard is here too). */
  const corpus = (inFileSet: (p: RepoPath) => boolean = (p) => p === 'docs/money.md') => ({ rules: new Map([[ruleId('T-1'), T1]]), inFileSet });
  const noDocRefs = { docRefs: [], contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [] };

  it('ruling.contract-op-on-corpus-refused: a contract op on a corpus file is refused, whatever the plan documents list (R32)', () => {
    refused(sidecar(), /contract op on docs\/money\.md, which is a corpus file/, context({ corpus: corpus() }));
    const other = validateRuling(sidecar(), context({ corpus: corpus(() => false) }));
    assert.ok(!other.some((r) => /corpus file/.test(r)), JSON.stringify(other));
  });

  it('ruling.rule-ref: a rule ref resolves to {T-n, textSha256} active in the pin in force; outside a corpus arc it is refused', () => {
    const ruleRef = (textSha256: string) => sidecar({ ...noDocRefs, docRefs: [{ rule: 'T-1', textSha256, relation: 'consistent' }] });
    const ok = validateRuling(ruleRef(T1), context({ corpus: corpus() }));
    assert.ok(!ok.some((r) => /rule ref/.test(r)), JSON.stringify(ok));
    refused(ruleRef('4'.repeat(64)), /rule ref T-1: not an active rule of the corpus pin in force/, context({ corpus: corpus() }));
    refused(sidecar({ ...noDocRefs, docRefs: [{ rule: 'T-7', textSha256: T1, relation: 'refines' }] }), /rule ref T-7: not an active rule/, context({ corpus: corpus() }));
    refused(ruleRef(T1), /rule ref T-1: the arc has no corpus pin/, context());
  });

  it('ruling.consistency-corpus: a judgment of another pin than the one in force is stale (judgedRevs.corpusSha256)', () => {
    const inForce = { head: HEAD, ledgerSha256: LEDGER_SHA, obligationsSha256: OBL_SHA, visionSha256: VIS_SHA, corpusSha256: sha256('5'.repeat(64)) };
    refused(sidecar(), /consistency is stale: judged corpusSha256/, context({ inForce, corpus: corpus(() => false) }));
  });
});

describe('contract ops', () => {
  it('contracts.anchor-exact: anchors name one heading (by slug, not in fences) or one line; old text exactly once; the header cites the ruling', () => {
    assert.equal(headingSlug(' Rounding & Display! '), 'rounding--display');
    const s = anchorSection(MONEY, '#rounding');
    assert.ok(typeof s !== 'string');
    assert.equal(MONEY.slice(s.start, s.end), '## Rounding\n\nTotals round half-up at the cent.\nRates keep four places.\n\n### Display\n\nAmounts show two places.\n\n');
    assert.match(anchorSection(MONEY, 'places') as string, /matches 2 lines/);
    const line = anchorSection(MONEY, 'Rates keep');
    assert.ok(typeof line !== 'string');
    assert.equal(MONEY.slice(line.start, line.end), 'Rates keep four places.\n\n', 'a line anchor runs to the next heading');

    const C3 = rulingId('C-3');
    const at = (p: RepoPath): string | null => DOCS[p] ?? null;
    const ok = applyContractOps([{ path: repoPath('docs/money.md'), anchor: '#rounding', oldText: 'half-up', newText: 'half-even' }], C3, at);
    assert.ok('edits' in ok);
    assert.deepEqual(ok.edits, [{ path: 'docs/money.md', text: `<!-- revised by C-3 -->\n${MONEY.replace('half-up', 'half-even')}` }]);
    const twice = applyContractOps([{ path: repoPath('docs/money.md'), anchor: '#rounding', oldText: 'places', newText: 'digits' }], C3, at);
    assert.ok('reasons' in twice);
    assert.match(twice.reasons[0]!, /occurs more than once under anchor "#rounding"/);
    const outside = applyContractOps([{ path: repoPath('docs/money.md'), anchor: '#currency', oldText: 'half-up', newText: 'x' }], C3, at);
    assert.ok('reasons' in outside && /occurs nowhere/.test(outside.reasons[0]!), 'text elsewhere in the document does not count');
    const missing = applyContractOps([{ path: repoPath('docs/none.md'), anchor: '#a', oldText: 'a', newText: 'b' }], C3, at);
    assert.ok('reasons' in missing && /no such document/.test(missing.reasons[0]!));

    assert.equal(citeRuling('<!-- revised by C-1 -->\n# X\n', rulingId('C-4')), '<!-- revised by C-1, C-4 -->\n# X\n');
    assert.equal(citeRuling('<!-- revised by C-1, C-4 -->\n# X\n', rulingId('C-4')), '<!-- revised by C-1, C-4 -->\n# X\n');
  });
});

describe('landing a ruling', () => {
  it('rulings.ledger-after: the line appended, full supersedes folded, other bytes kept; partial supersedes stay active', () => {
    const s = sidecar();
    const text = ledgerAfter(LEDGER_TEXT, s);
    assert.equal(text, '# Rulings\n\nC-1 — withdrawn by C-3\nC-2 — errors exit 2\nC-3 — totals round half-even at the cent\n');
    assert.deepEqual(parseRulings(text, 'l').map((r) => r.status), ['withdrawn', 'active', 'active']);
    assert.equal(ledgerAfter('C-1 — a', sidecar({ supersedes: [{ id: 'C-1', part: 'the cent' }] })), 'C-1 — a\nC-3 — totals round half-even at the cent\n');
    const c1 = sidecar({ id: 'C-1', supersedes: [], docRefs: [{ path: 'docs/target.md', anchor: '#reconcile', quotedText: 'one command', relation: 'consistent' }], contractOps: [] });
    assert.deepEqual(sidecarsAfter([c1], s).map((x) => [x.id, x.status]), [['C-1', 'superseded'], ['C-3', 'active']]);
  });

  it('rulings.effective-revs: a cited ruling\'s effective revision rises with each partial supersession of it, and again when that one leaves force', () => {
    const plain = (id: string, supersedes: readonly Record<string, unknown>[] = []): RulingSidecar => sidecar({ id, supersedes });
    const partial = (id: string, of: string): RulingSidecar => plain(id, [{ id: of, part: 'the cent' }]);
    // No partial supersession (no sidecars at all): every ruling is at its first revision.
    assert.deepEqual([...effectiveRulingRevs([])], []);
    assert.deepEqual([...effectiveRulingRevs([plain('C-3', [{ id: 'C-1', part: null }])])], [], 'a full supersession withdraws, it does not revise');
    // C-3 partially supersedes C-1 (a ledger ruling without a sidecar): C-1 moves to 2.
    const one = effectiveRulingRevs([partial('C-3', 'C-1')]);
    assert.equal(one.get(rulingId('C-1')), 2);
    // C-4 partially supersedes C-3 too: C-3 moves to 2, and so C-1 to 3.
    const two = effectiveRulingRevs([partial('C-3', 'C-1'), partial('C-4', 'C-3')]);
    assert.deepEqual([two.get(rulingId('C-1')), two.get(rulingId('C-3'))], [3, 2]);
    // C-5 fully supersedes C-3: its part of C-1's meaning leaves force, and C-1 moves again.
    const gone = effectiveRulingRevs([{ ...partial('C-3', 'C-1'), status: 'superseded' }, partial('C-4', 'C-3'), plain('C-5', [{ id: 'C-3', part: null }])]);
    assert.equal(gone.get(rulingId('C-1')), 4);
  });
});

describe('constraints.md', () => {
  const s3 = sidecar();
  const s4 = sidecar({
    id: 'C-4', statement: 'the rounding helper is private to src/format.js', kind: 'decision', supersedes: [{ id: 'C-2', part: 'for parse errors' }],
    docRefs: [{ path: 'docs/target.md', anchor: '#reconcile', quotedText: 'one command', relation: 'refines' }], contractRefs: [], contractOps: [],
    obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'units', units: ['tidy'] }, lifetime: 'arc',
  });
  const ledger = parseRulings(ledgerAfter(ledgerAfter(LEDGER_TEXT, s3), s4), 'l');
  const sidecars = sidecarsAfter([s3], s4);

  it('render.byte-stable: constraints.md is a pure function of the records, whatever the sidecar order', () => {
    const living = renderConstraints(ledger, sidecars, 'living');
    assert.equal(renderConstraints(ledger, [...sidecars].reverse(), 'living'), living);
    assert.equal(living, [
      '# Constraints',
      '',
      '<!-- Rendered by the roadmap executor from the C-nn ledger and its sidecars; edits are overwritten. -->',
      '',
      '## C-1 — withdrawn by C-3',
      '',
      '- state: superseded by C-3',
      '- provenance: none recorded (a ruling from before sidecars)',
      '',
      '## C-2 — errors exit 2',
      '',
      '- state: active, partly superseded by C-4 (for parse errors)',
      '- provenance: none recorded (a ruling from before sidecars)',
      '',
      '## C-3 — totals round half-even at the cent',
      '',
      '- state: active',
      '- kind: deviation',
      '- ruled by: the architect',
      '- trigger: F-1',
      '- applies to: the arc',
      '- lifetime: standing',
      '- supersedes: C-1',
      '- doc refs:',
      '  - `docs/money.md` `#rounding` (deviates): "Totals round half-up"',
      '  - `docs/target.md` `reconciles in one command` (consistent): "one command"',
      '- contracts: `docs/money.md` (edits `docs/money.md`)',
      '- obligations: I-2 (amended)',
      '- cites: V-2',
      '- evidence:',
      '  - F-1: 0.125 rounds to 0.13',
      '',
      '## C-4 — the rounding helper is private to src/format.js',
      '',
      '- state: active',
      '- kind: decision',
      '- ruled by: the architect',
      '- trigger: F-1',
      '- applies to: units tidy',
      '- lifetime: arc',
      '- supersedes: C-2 (part: for parse errors)',
      '- doc refs:',
      '  - `docs/target.md` `#reconcile` (refines): "one command"',
      '- contracts: (none)',
      '- obligations: (none)',
      '- cites: (none)',
      '',
    ].join('\n'));
  });

  it('render.close-out-retires: the close-out rendering leaves out arc-lifetime and withdrawn rulings', () => {
    const closed = renderConstraints(ledger, sidecars, 'close-out');
    assert.deepEqual([...closed.matchAll(/^## (C-[0-9]+)/gm)].map((m) => m[1]), ['C-2', 'C-3']);
    assert.equal(renderConstraints([], [], 'close-out'), '# Constraints\n\n<!-- Rendered by the roadmap executor from the C-nn ledger and its sidecars; edits are overwritten. -->\n\n(no rulings)\n');
    assert.throws(() => renderConstraints(parseRulings(LEDGER_TEXT, 'l'), [s3], 'living'), /C-3 names no ruling/);
  });
});
