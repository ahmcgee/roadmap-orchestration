// M4a records frozen in step 0a (SCHEMAS.md "M4a: corpus, debt, forge, brief, chaining"): ids, the plan target union
// (`plan.target-union`), the corpus guide, pin and registry, obligations with rule anchors and the census, ruling rule
// refs (`sidecar.rule-arm-no-deviates`), the Phase-0 record, the issue capture, the debt ledger, pack-review inputs and
// key, every new fact and PlanChange arm, the startup rows, the brief payload and the ack marker, the dev.6 read-time
// defaults (`upgrade.defaults-dev6`), the CLI forms (`cli.m4a`) and the accessor guard (`target.no-direct-access`).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { runCli } from '../src/cli/main.ts';
import { type Envelope, type Event, type Fact, type LogRecord, parseEventLine, serializeEvent } from '../src/core/events.ts';
import {
  InvalidIdError, amendmentRef, amendmentRefOf, arcId, briefId, commandId, debtId, issueContentRef, issueId, issueOfContent, jobId, jobIdOf,
  parseAmendmentRef, phaseQuestionId, ruleId, sha, sha256,
} from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { NotYetError } from '../src/core/notyet.ts';
import { approvalFingerprint, needsUserRecord, NEEDS_USER_REASONS, revisionInputs } from '../src/core/records.ts';
import { censusOf, checkpointOutputM4Default } from '../src/core/upgrade.ts';
import { Fields, SchemaError } from '../src/core/validate.ts';
import { absPath, isoTime, repoPath } from '../src/core/values.ts';
import { parseCorpusGuide, parseCorpusPin, parseRulesRegistry } from '../src/corpus/types.ts';
import { parseDebtLedger } from '../src/debt/types.ts';
import { parseIssueCapture } from '../src/forge/types.ts';
import { packReviewKey } from '../src/holistic/packreview.ts';
import {
  obligationSource, parseConfirmationRef, parseObligations, parsePackReviewInputs, parseRulingSidecar, rulingRefSource,
} from '../src/holistic/types.ts';
import { CliError, parseCommand } from '../src/input/cli.ts';
import { contractOpDocuments, parsePlan, targetDocumentPaths, targetDocuments, visionFile } from '../src/input/plan.ts';
import { parseAckMarker, parseBriefPayload, parsePhase0Record } from '../src/phase0/types.ts';
import { exitCodeFor, rejectionFile } from '../src/preflight/startup.ts';
import { validateCheckpointOutput, validatePackReviewOutput } from '../src/prompts/schemas.ts';
import { m3Blocking } from '../src/needsuser.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { ARC_ROLES, ROLES } from '../src/routing/types.ts';
import { BUILTIN_SEATS } from '../src/routing/profiles.ts';
import { tmpDir } from './helpers/repo.ts';
import { appliedFields } from './fixtures/log-records.ts';

const ARC = arcId('arc-2');
const A = sha('a'.repeat(40));
const B = sha('b'.repeat(40));
const H = sha256('d'.repeat(64));
const H2 = sha256('e'.repeat(64));
const AT = isoTime('2026-10-03T12:00:00.000Z');
const CMD = commandId('cmd-0123456789abcdef');

const envelope = (seq: number): Envelope => ({ v: 1, seq, prev: seq === 1 ? null : H, at: AT, arc: ARC });
function roundTrip(record: LogRecord): Event {
  const e = { ...envelope(2), ...record } as Event;
  const line = serializeEvent(e);
  const back = parseEventLine(line.slice(0, -1));
  assert.deepEqual(back, e);
  assert.equal(serializeEvent(back), line, 'byte-identical');
  return back;
}
const fact = (f: object): LogRecord => ({ type: 'fact', fact: f as Fact });
const refusesFact = (f: object, field: RegExp): void => assert.throws(() => roundTrip(fact(f)), (err: unknown) => err instanceof SchemaError && field.test(err.field));
/** A reader's value is canonical-JSON equal to its input (the record round-trips). */
const same = (read: (v: unknown) => unknown, value: object): void => assert.equal(canonicalJson(read(JSON.parse(JSON.stringify(value)))), canonicalJson(value));

// ---------------------------------------------------------------------------------------------------
// Fixtures

const unit = { id: 'u1', spec: 'specs/u1.json', risk: 'med', scope: ['src/**'], resources: [] };
const base = {
  schema: 'roadmap/plan-m1', arc: 'arc-2', integrationBranch: 'main', baseline: A, worktreeRoot: '/var/tmp/wt', contracts: ['docs/api.md'],
  rulings: 'rulings.md', direction: 'd', suite: { lanes: [] }, resources: [], units: [unit],
};
const docPlan = { ...base, architectureDoc: 'docs/arch.md' };
const corpusPlan = {
  ...base, corpus: 'corpus.pin.json', phase0: 'phase0.json', holistic: { advances: ['V-1'], obligations: 'obligations.json' },
  chain: { previousArc: 'arc-1', previousHead: B },
};

const guide = { schema: 'roadmap/corpus-guide-m4', source: { kind: 'same-repo', root: 'docs/corpus' }, include: ['**/*.md'], vision: '0005_Vision.md' };
const pin = {
  schema: 'roadmap/corpus-pin-m4', guideSha256: H, source: { kind: 'same-repo', commit: A, root: 'docs/corpus' },
  files: [{ path: '0005_Vision.md', sha256: H2 }, { path: '0010_Overview.md', sha256: H }],
  rules: [
    { id: 'T-2', textSha256: H, text: 'Bookings never overlap.', file: '0010_Overview.md', section: 'Berths' },
    { id: 'T-10', textSha256: H2, text: 'Cancellations close 48 h before arrival.', file: '0010_Overview.md', section: null },
  ],
  retired: [{ id: 'T-1', textSha256: H2 }],
  highWater: 10,
  vision: { path: '0005_Vision.md', sha256: H2 },
};

const witness = { lane: 'journey', testIds: ['t1'] };
const proof = { verdict: 'proves', obligationRev: 1, laneRev: '0123456789abcdef', witness };
const ruleObligation = (id: string, rule: string) => ({
  id, rev: 1, statement: `statement ${id}`, rule: { id: rule, textSha256: H }, serves: ['V-1'], witness, proofJudgment: proof, deliveredBy: [],
  activation: 'must-hold', contracts: [], state: { type: 'active' },
});
const obligationsFile = (obligations: readonly object[], census?: readonly object[]) => ({
  schema: 'roadmap/obligations-m3', cutLine: 'cut',
  lanes: [{ id: 'journey', argv: ['node', 'j.js'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], evidenceExcludes: [], reporter: 'jsonl' }],
  obligations, mapping: { paths: [] }, ...(census === undefined ? {} : { census }),
});

const sidecar = (docRefs: readonly object[]) => ({
  schema: 'roadmap/ruling-m3', id: 'C-3', statement: 'A ruling.', kind: 'decision', ruledBy: { type: 'architect' }, trigger: 't', supersedes: [], condition: null,
  docRefs, contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc',
  status: 'active',
  consistency: {
    verdict: 'consistent', judgedRevs: { head: A, ledgerSha256: H, obligationsSha256: null, visionSha256: null, contracts: [], corpusSha256: H2 }, by: { type: 'architect' },
  },
});

const capture = {
  schema: 'roadmap/issues-capture-m4', repo: { host: 'github.com', owner: 'o', name: 'tidewater' },
  policy: { visibility: 'PUBLIC', hasIssuesEnabled: true, issueCreationPolicy: 'COLLABORATORS_ONLY' },
  issues: [
    {
      id: 'issue-3', title: 'Overlap allowed', labels: ['roadmap:bug'], body: '<pasted_content id="x">\nbody\n</pasted_content id="x">',
      comments: [{ id: 'issue-3/c-7', association: 'NONE', body: 'me too' }, { id: 'issue-3/c-12', association: 'OWNER', body: 'confirmed' }],
    },
    { id: 'issue-11', title: 'Feedback', labels: ['roadmap:feedback'], body: 'b', comments: [] },
  ],
  filtered: { comments: 1, pullRequests: 1 },
};

const phase0 = {
  schema: 'roadmap/phase0-m4',
  curation: [{ tier: 'structural', what: 'merged three restatements', files: ['0010_Overview.md'], rules: ['T-2'] }],
  corpusDivergences: [{ tier: 'semantic', what: 'no override', preimage: { pinSha256: H, files: [{ path: '0010_Overview.md', sha256: H2 }] }, cites: ['V-2'], rules: ['T-2'] }],
  questions: [{ id: 'P-4', rank: 1, text: '24 h or 48 h?', files: ['0010_Overview.md'], bears: ['T-10', 'V-1'], assumption: '48 h', state: { type: 'answered', answer: '48 h', at: AT } }],
  debt: [{ id: 'B-2', disposition: { type: 'keep', reason: 'later' } }, { id: 'B-10', disposition: { type: 'promote', unit: 'u1' } }],
  amendments: [{ id: 'arc-1/M-1', disposition: { type: 'applied', rules: ['T-10'] } }],
  issueCapture: { file: 'issues.json', sha256: H },
  intake: [
    { issue: 'issue-3', outcome: { type: 'acted', on: { type: 'rules', ids: ['T-2'] } } },
    { issue: 'issue-11', outcome: { type: 'none', reason: 'already planned' } },
  ],
  slice: { advances: ['V-1'], why: 'first slice' },
};

const packInputs = {
  schema: 'roadmap/pack-review-inputs-m4', job: 'review-1', planRev: 1, planSha256: H, specs: [{ unit: 'u1', sha256: H2 }], obligationsSha256: H,
  corpusPinSha256: H2, phase0Sha256: H, visionSha256: H2, head: A, routingRev: '0123456789abcdef',
};

const coverage = [{ arc: 'arc-1', snapshotCommit: A, highWater: 120 }, { arc: 'arc-2', snapshotCommit: B, highWater: 40 }];
const items = [{ arc: 'arc-2', id: 'nu-12' }, { arc: 'arc-2', id: 'nu-30' }];

// ---------------------------------------------------------------------------------------------------

describe('M4a ids', () => {
  it('rule, debt, amendment, Phase-0 question, issue, issue content and brief ids; review jobs', () => {
    assert.equal(ruleId('T-12'), 'T-12');
    assert.equal(debtId('B-1'), 'B-1');
    assert.equal(phaseQuestionId('P-3'), 'P-3');
    assert.equal(amendmentRefOf(ARC, 'M-4' as never), 'arc-2/M-4');
    assert.deepEqual(parseAmendmentRef(amendmentRef('arc-1/M-2')), { arc: 'arc-1', id: 'M-2' });
    assert.equal(issueId('issue-42'), 'issue-42');
    assert.equal(issueOfContent(issueContentRef('issue-42/c-9001')), 'issue-42');
    assert.equal(briefId('0123456789abcdef'), '0123456789abcdef');
    assert.equal(jobIdOf('review-1'), jobId('review', 1));
    for (const [read, bad] of [[ruleId, 'T-0'], [debtId, 'B-01'], [phaseQuestionId, 'P-'], [issueId, 'issue-0'], [issueContentRef, 'issue-3/c-'], [briefId, 'ABC'], [amendmentRef, 'M-1']] as const) {
      assert.throws(() => (read as (v: unknown) => unknown)(bad), InvalidIdError, String(bad));
    }
  });
});

describe('plan.target-union', () => {
  it('an architecture-doc plan and a corpus plan parse into the closed union, read through the accessors', () => {
    const doc = parsePlan({ ...docPlan, architectureDigest: 'docs/digest.md', holistic: { vision: 'vision.json', advances: ['V-1'] } });
    assert.equal(doc.target, 'architecture-doc');
    assert.deepEqual(targetDocuments(doc), { doc: 'docs/arch.md', digest: 'docs/digest.md' });
    assert.deepEqual(targetDocumentPaths(doc), ['docs/arch.md', 'docs/digest.md']);
    assert.deepEqual(contractOpDocuments(doc), ['docs/api.md', 'docs/arch.md']);
    assert.deepEqual(visionFile(doc), { base: 'plan', path: 'vision.json' });
    assert.equal(visionFile(parsePlan(docPlan)), null);

    const corpus = parsePlan(corpusPlan);
    assert.deepEqual(corpus, { ...corpusPlan, target: 'corpus', units: [{ ...unit, after: [], contingent: [] }] });
    assert.equal(targetDocuments(corpus), null);
    assert.deepEqual(targetDocumentPaths(corpus), []);
    assert.deepEqual(contractOpDocuments(corpus), ['docs/api.md']);
    assert.deepEqual(visionFile(corpus), { base: 'repo', path: '.roadmap/vision.json' });
    assert.deepEqual(corpus.chain, { previousArc: 'arc-1', previousHead: B });
  });

  it('refuses every illegal combination at parse', () => {
    const { corpus: _c, phase0: _p, holistic: _h, chain: _ch, ...bare } = corpusPlan;
    const cases: readonly (readonly [string, object, RegExp])[] = [
      ['both architectureDoc and corpus', { ...corpusPlan, architectureDoc: 'docs/arch.md' }, /^plan\.architectureDoc$/],
      ['neither', bare, /^plan\.architectureDoc$/],
      ['corpus without phase0', { ...corpusPlan, phase0: undefined }, /^plan\.phase0$/],
      ['phase0 without corpus', { ...docPlan, phase0: 'phase0.json' }, /^plan\.phase0$/],
      ['architectureDigest with corpus', { ...corpusPlan, architectureDigest: 'docs/digest.md' }, /^plan\.architectureDigest$/],
      ['corpus without holistic', { ...corpusPlan, holistic: undefined }, /^plan\.holistic$/],
      ['holistic.vision with corpus', { ...corpusPlan, holistic: { ...corpusPlan.holistic, vision: 'vision.json' } }, /^plan\.holistic\.vision$/],
      ['holistic without vision on an architecture-doc plan', { ...docPlan, holistic: { advances: ['V-1'] } }, /^plan\.holistic\.vision$/],
      ['a chain without its head', { ...corpusPlan, chain: { previousArc: 'arc-1' } }, /^plan\.chain\.previousHead$/],
    ];
    for (const [what, raw, field] of cases) {
      const value = JSON.parse(JSON.stringify(raw)) as object;
      assert.throws(() => parsePlan(value), (err: unknown) => err instanceof SchemaError && field.test(err.field), what);
    }
    // The parsed discriminant is not an on-disk field.
    assert.throws(() => parsePlan({ ...docPlan, target: 'architecture-doc' }), /plan\.target/);
  });
});

describe('corpus records', () => {
  it('the guide, the pin and the rules registry round-trip', () => {
    same(parseCorpusGuide, guide);
    same(parseCorpusGuide, { ...guide, source: { kind: 'other-repo', path: '/srv/corpus', root: '.' } });
    same(parseCorpusGuide, { ...guide, source: { kind: 'checkout', remote: 'https://example.invalid/corpus.git', root: 'docs' } });
    same(parseCorpusPin, pin);
    same(parseRulesRegistry, { highWater: 10, active: [{ id: 'T-2', textSha256: H }, { id: 'T-10', textSha256: H2 }], retired: [{ id: 'T-1', textSha256: H2 }] });
  });

  it('the pin refuses unsorted rules, a rule in the vision doc, a retired rule still active, a low high-water and an unpinned vision', () => {
    assert.throws(() => parseCorpusPin({ ...pin, rules: [...pin.rules].reverse() }), /rules\[1\]/);
    assert.throws(() => parseCorpusPin({ ...pin, rules: [{ ...pin.rules[0], file: '0005_Vision.md' }] }), /rules-in-vision/);
    assert.throws(() => parseCorpusPin({ ...pin, retired: [{ id: 'T-2', textSha256: H }] }), /retired\[0\]/);
    assert.throws(() => parseCorpusPin({ ...pin, highWater: 9 }), /highWater/);
    assert.throws(() => parseCorpusPin({ ...pin, vision: { path: '0005_Vision.md', sha256: H } }), /corpusPin\.vision/);
    assert.throws(() => parseCorpusGuide({ ...guide, include: [] }), /include/);
  });
});

describe('obligations, census and ruling refs', () => {
  it('a rule-anchored obligation with its census round-trips; obligationSource reads both arms', () => {
    const file = obligationsFile([ruleObligation('I-1', 'T-2')], [
      { rule: 'T-2', state: { type: 'obligation', id: 'I-1' } }, { rule: 'T-3', state: { type: 'untestable' } }, { rule: 'T-10', state: { type: 'prod-only' } },
    ]);
    same(parseObligations, file);
    const o = parseObligations(file).obligations[0]!;
    assert.deepEqual(obligationSource(o), { kind: 'rule', rule: { id: 'T-2', textSha256: H } });
    const { rule: _r, ...doc } = ruleObligation('I-1', 'T-2');
    const docO = parseObligations(obligationsFile([{ ...doc, docRef: { path: 'docs/arch.md', anchor: '#a', quotedText: 'q' } }])).obligations[0]!;
    assert.deepEqual(obligationSource(docO), { kind: 'doc', path: 'docs/arch.md', anchor: '#a', quotedText: 'q' });
  });

  it('refuses both or neither anchor, mixed anchors, a census beside docRefs or missing beside rules, and a census entry naming the wrong obligation', () => {
    const { rule: _r, ...noAnchor } = ruleObligation('I-1', 'T-2');
    const docRef = { path: 'docs/arch.md', anchor: '#a', quotedText: 'q' };
    const census = [{ rule: 'T-2', state: { type: 'obligation', id: 'I-1' } }];
    assert.throws(() => parseObligations(obligationsFile([{ ...ruleObligation('I-1', 'T-2'), docRef }], census)), /exactly one of docRef and rule/);
    assert.throws(() => parseObligations(obligationsFile([noAnchor])), /exactly one of docRef and rule/);
    assert.throws(() => parseObligations(obligationsFile([ruleObligation('I-1', 'T-2'), { ...noAnchor, id: 'I-2', docRef }], census)), /one anchor kind/);
    assert.throws(() => parseObligations(obligationsFile([ruleObligation('I-1', 'T-2')])), /census/);
    assert.throws(() => parseObligations(obligationsFile([{ ...noAnchor, docRef }], [])), /census/);
    assert.throws(() => parseObligations(obligationsFile([ruleObligation('I-1', 'T-2')], [{ rule: 'T-3', state: { type: 'obligation', id: 'I-1' } }])), /census\[0\]\.state\.id/);
    assert.throws(() => parseObligations(obligationsFile([ruleObligation('I-1', 'T-2')], [{ rule: 'T-3', state: { type: 'untestable' } }])), /every rule obligation is in the census/);
    assert.throws(() => parseObligations(obligationsFile([], [{ rule: 'T-3', state: { type: 'untestable' } }, { rule: 'T-2', state: { type: 'untestable' } }])), /census\[1\]/);
  });

  it('sidecar.rule-arm-no-deviates: a rule ref is consistent or refines, never deviates; both arms read through rulingRefSource', () => {
    const ruleRef = { rule: 'T-2', textSha256: H, relation: 'refines' };
    const docRef = { path: 'docs/arch.md', anchor: '#a', quotedText: 'q', relation: 'consistent' };
    same(parseRulingSidecar, sidecar([docRef, ruleRef]));
    const s = parseRulingSidecar(sidecar([docRef, ruleRef]));
    assert.deepEqual(s.docRefs.map(rulingRefSource), [
      { kind: 'doc', path: 'docs/arch.md', anchor: '#a', quotedText: 'q', relation: 'consistent' },
      { kind: 'rule', rule: 'T-2', textSha256: H, relation: 'refines' },
    ]);
    assert.throws(() => parseRulingSidecar(sidecar([{ ...ruleRef, relation: 'deviates' }])), (err: unknown) => err instanceof SchemaError && /docRefs\[0\]\.relation/.test(err.field));
    assert.throws(() => parseRulingSidecar(sidecar([{ ...ruleRef, path: 'docs/arch.md' }])), /docRefs\[0\]\.path/);
  });

  it('a vision confirmation ref: the corpus form and the M3 form', () => {
    assert.deepEqual(parseConfirmationRef(`corpus:0005_Vision.md#sha256:${H}`), { form: 'corpus', path: '0005_Vision.md', sha256: H });
    assert.deepEqual(parseConfirmationRef(`vision.md#sha256:${H}`), { form: 'm3', path: 'vision.md', sha256: H });
    assert.throws(() => parseConfirmationRef('vision.md'), SchemaError);
  });
});

describe('Phase 0, issues, debt and pack review', () => {
  it('the Phase-0 record round-trips; Phase 0 may act only on units or rules', () => {
    same(parsePhase0Record, phase0);
    const acted = (on: object) => ({ ...phase0, intake: [{ issue: 'issue-3', outcome: { type: 'acted', on } }] });
    same(parsePhase0Record, acted({ type: 'units', ids: ['u1'] }));
    assert.throws(() => parsePhase0Record(acted({ type: 'ops', indexes: [0] })), /intake\[0\]\.outcome\.on\.type/);
    assert.throws(() => parsePhase0Record(acted({ type: 'units', ids: [] })), /ids/);
    assert.throws(() => parsePhase0Record({ ...phase0, intake: [...phase0.intake].reverse() }), /intake\[1\]/);
    assert.throws(() => parsePhase0Record({ ...phase0, debt: [...phase0.debt].reverse() }), /debt\[1\]/);
    assert.throws(() => parsePhase0Record({ ...phase0, curation: [{ ...phase0.curation[0], files: [] }] }), /files/);
  });

  it('the issue capture round-trips canonically; its order, comment ownership and disabled issues are checked', () => {
    same(parseIssueCapture, capture);
    same(parseIssueCapture, { ...capture, policy: { ...capture.policy, hasIssuesEnabled: false }, issues: [] });
    assert.throws(() => parseIssueCapture({ ...capture, issues: [...capture.issues].reverse() }), /issues\[1\]/);
    assert.throws(() => parseIssueCapture({ ...capture, issues: [{ ...capture.issues[1], comments: [{ id: 'issue-3/c-1', association: 'OWNER', body: 'x' }] }] }), /comments\[0\]\.id/);
    assert.throws(() => parseIssueCapture({ ...capture, policy: { ...capture.policy, hasIssuesEnabled: false } }), /issues/);
    assert.throws(() => parseIssueCapture({ ...capture, policy: { ...capture.policy, issueCreationPolicy: 'SOMETIMES' } }), /issueCreationPolicy/);
  });

  it('the debt ledger round-trips, ascending by number', () => {
    const item = (id: string) => ({
      id, originArc: 'arc-1', bankReason: 'gate-note', what: 'tidy x', unit: null, key: H, history: [{ arc: 'arc-1', disposition: { type: 'resolve', ruling: 'C-4' } }], state: 'open',
    });
    same(parseDebtLedger, { schema: 'roadmap/debt-m4', items: [item('B-2'), item('B-10')] });
    assert.throws(() => parseDebtLedger({ schema: 'roadmap/debt-m4', items: [item('B-10'), item('B-2')] }), /items\[1\]/);
  });

  it('pack-review inputs round-trip; the required-review key excludes the job', () => {
    same(parsePackReviewInputs, packInputs);
    const inputs = parsePackReviewInputs(packInputs);
    const again = parsePackReviewInputs({ ...packInputs, job: 'review-2' });
    assert.equal(packReviewKey(inputs), packReviewKey(again));
    assert.notEqual(packReviewKey(inputs), packReviewKey(parsePackReviewInputs({ ...packInputs, phase0Sha256: H2 })));
    assert.throws(() => parsePackReviewInputs({ ...packInputs, job: 'ckpt-1' }), /job/);
    const out = { findings: [{ severity: 'note', target: { type: 'plan' }, claim: 'c', evidence: [] }], reasons: ['r'], premises: [] };
    same(validatePackReviewOutput, out);
  });
});

describe('facts, plan changes, manifests and fingerprints', () => {
  const M4A_FACTS: Readonly<Record<string, object>> = {
    'debt-banked': { kind: 'debt-banked', id: 'B-3', bankReason: 'gate-note', what: 'tidy x', key: H, source: { type: 'gate', unit: 'u1', attempt: 2, index: 0 } },
    'corpus-amendment': {
      kind: 'corpus-amendment', id: 'M-1', source: { type: 'issue', job: 'ckpt-2', issue: 'issue-3' }, rules: ['T-2'], proposal: 'p', why: 'w', evidence: ['issue-3'],
    },
    'issue-intake': { kind: 'issue-intake', job: 'ckpt-2', issue: 'issue-3', outcome: { type: 'acted', on: { type: 'ops', indexes: [0, 2] } } },
    'pack-review-started': { kind: 'pack-review-started', job: 'review-1', planRev: 1, inputsSha256: H, key: H2 },
    'pack-review-ended': {
      kind: 'pack-review-ended', job: 'review-1', outcome: 'completed',
      findings: [{ index: 0, severity: 'blocking', target: { type: 'census', rule: 'T-2' }, claim: 'c', evidence: [{ path: 'obligations.json', line: 3 }] }],
    },
    'issues-captured': { kind: 'issues-captured', job: 'ckpt-2', sha256: H, repo: { host: 'github.com', owner: 'o', name: 'n' }, filtered: { comments: 2, pullRequests: 1 } },
  };

  it('every M4a fact round-trips byte-identically', () => {
    for (const f of Object.values(M4A_FACTS)) roundTrip(fact(f));
    roundTrip(fact({ ...M4A_FACTS['debt-banked'], source: { type: 'finding', finding: 'F-4' } }));
    roundTrip(fact({ ...M4A_FACTS['corpus-amendment'], source: { type: 'checkpoint', job: 'ckpt-1', index: 2 } }));
    roundTrip(fact({ ...M4A_FACTS['corpus-amendment'], source: { type: 'divergence', divergence: 'D-3' } }));
    for (const outcome of [{ type: 'finding', finding: 'F-9' }, { type: 'amendment', amendment: 'M-2' }, { type: 'none', reason: 'dup' }]) {
      roundTrip(fact({ ...M4A_FACTS['issue-intake'], outcome }));
    }
  });

  it('the M4a facts refuse their illegal shapes', () => {
    refusesFact({ ...M4A_FACTS['issue-intake'], outcome: { type: 'acted', on: { type: 'units', ids: ['u1'] } } }, /outcome\.on\.type/);
    refusesFact({ ...M4A_FACTS['pack-review-started'], job: 'audit-1' }, /job/);
    refusesFact({ ...M4A_FACTS['pack-review-ended'], findings: [{ ...(M4A_FACTS['pack-review-ended'] as { findings: object[] }).findings[0], index: 1 }] }, /findings\[0\]\.index/);
    refusesFact({ ...M4A_FACTS['pack-review-ended'], outcome: 'abandoned' }, /findings/);
    refusesFact({ ...M4A_FACTS['issues-captured'], job: 'review-1' }, /job/);
    refusesFact({ ...M4A_FACTS['debt-banked'], bankReason: 'overflow' }, /bankReason/);
  });

  it('a finding opened by issue intake is P2 or P3', () => {
    const opened = {
      kind: 'finding-opened', id: 'F-1', key: H, lens: 'issue', severity: 'P2', obligation: null, visionClauses: [], claim: 'c', evidence: [], mutant: null,
      source: { type: 'job', job: 'ckpt-1' }, gateHadPassed: false,
    };
    roundTrip(fact(opened));
    refusesFact({ ...opened, severity: 'P1' }, /severity/);
  });

  it('PlanChange arms corpus and phase0 round-trip in plan-applied', () => {
    roundTrip(fact({
      kind: 'plan-applied', rev: 2, command: CMD, planSha256: H, specs: { u1: H },
      changes: [{ type: 'corpus', pinSha256: H, guideSha256: H2 }, { type: 'phase0', sha256: H2, issuesSha256: H }], ...appliedFields(2, CMD),
    }));
  });

  it('checkpoint-inputs: issues and corpusSha256 round-trip; a dev.6 fact without them reads as written', () => {
    const inputs = {
      kind: 'checkpoint-inputs', job: 'ckpt-1', trigger: { type: 'audit', job: 'audit-1' }, generation: 1,
      vector: { plan: 4, specs: { u1: 2 }, obligationsSha256: H2, ledgerSha256: H, visionSha256: H, contracts: [] }, headSha: A, visionSha256: H, findings: [], observations: [],
    };
    const dev6 = roundTrip(fact(inputs));
    assert.ok(dev6.type === 'fact' && dev6.fact.kind === 'checkpoint-inputs' && dev6.fact.issues === undefined && dev6.fact.corpusSha256 === undefined);
    roundTrip(fact({ ...inputs, issues: { type: 'captured', sha256: H }, corpusSha256: H2 }));
    roundTrip(fact({ ...inputs, issues: { type: 'unavailable', reason: 'gh: network unreachable' } }));
  });

  it('revision inputs: the four corpus digests together or not at all', () => {
    const read = (v: unknown) => { const f = new Fields(v, 'manifest'); const out = revisionInputs(f); f.end(); return out; };
    const m3 = { rulings: { ledgerSha256: H, sidecars: {} }, obligations: H2, vision: null };
    same(read, m3);
    same(read, { ...m3, corpus: H, corpusGuide: H2, phase0: H, phase0Issues: H2 });
    assert.throws(() => read({ ...m3, corpus: H }), /manifest\.corpus/);
  });

  it('the approval fingerprint: corpus round-trips; absent, the bytes are dev.6\'s', () => {
    const dev6 = { unitCommit: A, specRev: 2, contractRevs: [], rulingRevs: [] };
    assert.equal(canonicalJson(approvalFingerprint(dev6, 'fp')), canonicalJson(dev6));
    same((v) => approvalFingerprint(v, 'fp'), { ...dev6, corpus: H });
  });

  it('needs-user: pack-review and issue-policy-untrusted are blocking', () => {
    for (const reason of ['pack-review', 'issue-policy-untrusted'] as const) {
      assert.ok(NEEDS_USER_REASONS.includes(reason));
      assert.equal(m3Blocking(reason), true, reason);
      needsUserRecord({
        v: 1, id: 'nu-4', arc: 'arc-2', raisedAt: AT, blocking: true, subject: { type: 'arc' }, reason, summary: 's', recommendation: 'r', options: [], evidence: [],
      }, 'nu');
    }
  });

  it('routing: packReview is an arc role seated on frontier', () => {
    assert.ok(ROLES.includes('packReview') && (ARC_ROLES as readonly string[]).includes('packReview'));
    assert.deepEqual(BUILTIN_SEATS.packReview, { arc: 'frontier' });
  });

  it('.roadmap/config.json: chain.k is optional and positive', () => {
    assert.deepEqual(parseRepoConfig({ chain: { k: 1 } }), { chain: { k: 1 } });
    assert.deepEqual(parseRepoConfig({}), {});
    assert.throws(() => parseRepoConfig({ chain: { k: 0 } }), /chain\.k/);
    assert.throws(() => parseRepoConfig({ issues: { confirmed: true } }), /issues/);
  });
});

describe('startup rows, brief and ack', () => {
  it('every M4a row round-trips through the rejection file and refuses (78)', () => {
    const rows = [
      { kind: 'vision-unconfirmed', ref: null, expected: null, actual: null },
      { kind: 'vision-unconfirmed', ref: `corpus:0005_Vision.md#sha256:${H}`, expected: H, actual: H2 },
      {
        kind: 'corpus-invalid', problems: [
          { type: 'pin-drift' }, { type: 'rule-reused', id: 'T-3' }, { type: 'rule-retired-reappears', id: 'T-1' }, { type: 'rules-in-vision' }, { type: 'guide-missing' },
          { type: 'source-unreadable', detail: 'no such commit' }, { type: 'source-remote-mismatch' }, { type: 'scope-overlaps-corpus', unit: 'u1' },
          { type: 'contract-overlaps-corpus', path: 'docs/corpus/0010_Overview.md' },
        ],
      },
      {
        kind: 'phase0-invalid', problems: [
          { type: 'census-incomplete', rules: ['T-2', 'T-10'] }, { type: 'census-dangling', rules: ['T-1'] }, { type: 'obligation-rule-unresolved', obligation: 'I-2' },
          { type: 'debt-undispositioned', id: 'B-2' }, { type: 'debt-kept-twice-unasked', id: 'B-3' }, { type: 'amendment-undispositioned', id: 'arc-1/M-2' },
          { type: 'intake-missing', issue: 'issue-3' }, { type: 'intake-unknown', issue: 'issue-4' }, { type: 'intake-duplicate', issue: 'issue-5' }, { type: 'capture-missing' },
          { type: 'capture-foreign', expected: { host: 'github.com', owner: 'o', name: 'a' }, actual: { host: 'github.com', owner: 'o', name: 'b' } },
          { type: 'question-reused', id: 'P-2' },
        ],
      },
      { kind: 'chain-invalid', problem: { type: 'limit', k: 1, unacked: 1 } },
      { kind: 'chain-invalid', problem: { type: 'baseline', baseline: { type: 'paths', paths: ['src/a.ts'] } } },
      { kind: 'chain-invalid', problem: { type: 'baseline', baseline: { type: 'merge-commit' } } },
      { kind: 'chain-invalid', problem: { type: 'previous-incomplete', arc: 'arc-1' } },
      { kind: 'chain-invalid', problem: { type: 'k-unset' } },
      { kind: 'issue-policy-untrusted', visibility: 'PUBLIC', policy: 'ALL' },
      { kind: 'tree-uncommitted', paths: ['.roadmap/config.json', '.roadmap/vision.json'] },
      { kind: 'holistic-needs-corpus' },
    ];
    const file = { v: 1, at: AT, rejections: rows };
    same((v) => rejectionFile(v, 'rejection'), file);
    for (const row of rejectionFile(file, 'rejection').rejections) assert.equal(exitCodeFor(row), 78, row.kind);
    assert.throws(() => rejectionFile({ ...file, rejections: [{ kind: 'corpus-invalid', problems: [] }] }, 'rejection'), /problems/);
  });

  it('the ack marker round-trips with its coverage vector and items', () => {
    same(parseAckMarker, { briefId: '0123456789abcdef', at: AT, chainHead: 'arc-2', coverage, items });
    assert.throws(() => parseAckMarker({ briefId: '0123456789abcdef', at: AT, chainHead: 'arc-2', coverage: [...coverage].reverse(), items }), /coverage\[1\]/);
  });

  it('the brief payload round-trips, with no clock field', () => {
    const payload = {
      schema: 'roadmap/brief-m4', coverage, items, chain: { position: 2, k: 1, unackedStarts: ['arc-2'] },
      arcs: [{
        arc: 'arc-2', divergences: [{ id: 'D-1', type: 'target-departed', what: 'w' }], digests: [{ needsUser: 'nu-12', ids: ['D-1'] }], decisions: ['d'],
        curation: phase0.curation, corpusDivergences: phase0.corpusDivergences,
        debt: { banked: [{ id: 'B-3', what: 'tidy x' }], dispositioned: [{ id: 'B-2', disposition: { type: 'keep', reason: 'later' } }] },
        intake: [
          { issue: 'issue-3', job: null, outcome: { type: 'none', reason: 'planned' } },
          { issue: 'issue-4', job: 'ckpt-2', outcome: { type: 'finding', finding: 'F-2' } },
        ],
        questions: [{ id: 'P-4', rank: 1, text: 't', assumption: 'a', state: { type: 'open' } }],
        amendments: [{ id: 'arc-2/M-1', rules: ['T-2'], proposal: 'p' }],
        census: { held: 3, obligationRules: 4, outOfSlice: 2, untestable: 1, prodOnly: 1 },
        timings: [{ stage: 'build', count: 3, p50Ms: 60_000, maxMs: 90_000 }],
        pr: { type: 'pr', number: 7, url: 'https://example.invalid/pull/7', state: 'open', base: 'arc-1', needsRebase: false },
      }],
    };
    same(parseBriefPayload, payload);
    assert.doesNotMatch(JSON.stringify(payload), /"at"/, 'no clock field');
  });
});

describe('upgrade.defaults-dev6', () => {
  it('a dev.6 obligations file reads with no census (vacuous)', () => {
    const { rule: _r, ...noAnchor } = ruleObligation('I-1', 'T-2');
    const dev6 = parseObligations(obligationsFile([{ ...noAnchor, docRef: { path: 'docs/arch.md', anchor: '#a', quotedText: 'q' } }]));
    assert.equal(censusOf(dev6), null);
    assert.deepEqual(censusOf(parseObligations(obligationsFile([], []))), []);
  });

  it('a recorded dev.6 checkpoint answer reads with no amendments, no intake, and docRef split children', () => {
    const child = { id: 'I-5', statement: 's', docRef: { path: 'docs/arch.md', anchor: '#a', quotedText: 'q' }, witness, activation: 'must-hold', deliveredBy: [] };
    const answer = {
      decision: 'bundle', reasons: ['r'], ops: [{ op: 'obligation-split', obligation: 'I-1', children: [child], cites: ['V-1'], evidence: ['F-1'] }],
      rulings: [], findingDispositions: [], interpretations: [], cites: { vision: ['V-1'], observations: [], findings: [] }, premises: [],
    };
    const out = validateCheckpointOutput(answer);
    assert.deepEqual(out.corpusAmendments, []);
    assert.deepEqual(out.issueIntake, []);
    const op = out.ops[0]!;
    assert.ok(op.op === 'obligation-split' && op.children[0]!.rule === null);
    assert.deepEqual(checkpointOutputM4Default('issueIntake'), []);
    // M4a's own: a rule-anchored child, amendments and intake.
    const m4 = validateCheckpointOutput({
      ...answer, ops: [{ ...answer.ops[0], children: [{ ...child, docRef: null, rule: 'T-2' }] }],
      corpusAmendments: [{ rules: ['T-2'], proposal: 'p', why: 'w' }],
      issueIntake: [{ issue: 'issue-3', outcome: { type: 'acted', on: { type: 'ops', indexes: [0] } } }, { issue: 'issue-4', outcome: { type: 'finding', severity: 'P3', claim: 'c', cause: 'k' } }],
    });
    assert.equal(m4.issueIntake.length, 2);
    assert.throws(() => validateCheckpointOutput({ ...answer, ops: [{ ...answer.ops[0], children: [{ ...child, rule: 'T-2' }] }] }), /exactly one of docRef and rule/);
    assert.throws(() => validateCheckpointOutput({ ...answer, issueIntake: [{ issue: 'issue-4', outcome: { type: 'finding', severity: 'P1', claim: 'c', cause: 'k' } }] }), /severity/);
  });
});

describe('cli.m4a', () => {
  it('parses every M4a host act', () => {
    assert.deepEqual(parseCommand(['phase0', 'check', '--repo', '.', '--plan', 'plan.json']), { command: 'phase0-check', repo: '.', source: { type: 'plan', plan: 'plan.json' } });
    assert.deepEqual(parseCommand(['phase0', 'check', '--repo', '.', '--from-ref', 'arc-1']), { command: 'phase0-check', repo: '.', source: { type: 'ref', arc: 'arc-1' } });
    assert.deepEqual(
      parseCommand(['corpus', 'pin', '--repo', '.', '--commit', 'HEAD', '--baseline', '0123456789abcdef0123456789abcdef01234567', '--out', 'pin.json']),
      { command: 'corpus-pin', repo: '.', commit: 'HEAD', baseline: '0123456789abcdef0123456789abcdef01234567', out: 'pin.json' },
    );
    assert.deepEqual(parseCommand(['brief', '--repo', '.']), { command: 'brief', repo: '.', json: false, ack: null });
    assert.deepEqual(parseCommand(['brief', '--repo', '.', '--json', '--ack', '0123456789abcdef']), { command: 'brief', repo: '.', json: true, ack: '0123456789abcdef' });
    assert.deepEqual(parseCommand(['pr', '--repo', '.', '--arc', 'arc-1']), { command: 'pr', repo: '.', arc: 'arc-1' });
    assert.deepEqual(parseCommand(['issues', '--repo', '.']), { command: 'issues', repo: '.', out: null });
    assert.deepEqual(parseCommand(['issues', '--repo', '.', '--out', 'issues.json']), { command: 'issues', repo: '.', out: 'issues.json' });
    assert.deepEqual(parseCommand(['chain', 'status', '--repo', '.']), { command: 'chain-status', repo: '.' });
  });

  it('refuses malformed forms, naming them', () => {
    const refuses = (argv: readonly string[], message: RegExp): void => assert.throws(() => parseCommand(argv), (err: unknown) => err instanceof CliError && message.test(err.message), argv.join(' '));
    refuses(['phase0', 'check', '--repo', '.'], /exactly one of --plan <plan.json> or --from-ref <arc>/);
    refuses(['phase0', 'check', '--repo', '.', '--plan', 'p', '--from-ref', 'arc-1'], /exactly one of/);
    refuses(['phase0', 'check', '--plan', 'p'], /--repo <path> is required/);
    refuses(['phase0', 'run'], /phase0: expected the subcommand check/);
    refuses(['corpus', 'pin', '--repo', '.', '--commit', 'HEAD', '--baseline', '0123456789abcdef0123456789abcdef01234567'], /--out <file> is required/);
    refuses(['corpus', 'pin', '--repo', '.', '--commit', 'HEAD', '--out', 'pin.json'], /--baseline <sha> is required/);
    refuses(['corpus', 'pin', '--repo', '.', '--commit', 'HEAD', '--baseline', 'HEAD', '--out', 'pin.json'], /Sha/);
    refuses(['brief', '--repo', '.', '--ack', 'nope'], /BriefId/);
    refuses(['pr', '--repo', '.'], /--arc <arc> is required/);
    refuses(['issues', '--repo', '.', 'extra'], /unexpected argument/);
    refuses(['chain', '--repo', '.'], /chain: expected the subcommand status/);
    refuses(['debt', 'resolve', 'B-1'], /unknown command "debt"/);
  });

  it('the final dispatch reaches each placeholder module, which throws not-yet loudly', async () => {
    const host = absPath(tmpDir('m4a-cli-host'));
    const repo = tmpDir('m4a-cli-repo');
    for (const argv of [['brief', '--repo', repo], ['chain', 'status', '--repo', repo]]) {
      await assert.rejects(runCli(argv, host), NotYetError, argv.join(' '));
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// target.no-direct-access (H10): the plan target's variant fields, an obligation's anchor and a sidecar ref's arm are
// read only through `targetDocuments`, `visionFile`, `obligationSource` and `rulingRefSource`. The type system refuses an
// unnarrowed read; this guard refuses the spellings that would get around it outside the accessors' modules and the
// parsers: a property access of `.architectureDoc`, `.architectureDigest` or `.docRef`; `holistic.vision` or
// `holistic?.vision`; the sidecar doc arm's type `RulingDocRef`; and an `in` test on an anchor key. Comments and plain
// string literals are not code (a load label such as 'plan.holistic.vision' names a field, it does not read one).

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ALLOWED = new Set(['input/plan.ts', 'holistic/types.ts', 'prompts/schemas.ts']);
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['.architectureDoc', /\.architectureDoc\b/],
  ['.architectureDigest', /\.architectureDigest\b/],
  ['holistic.vision', /\bholistic\??\.vision\b/],
  ['.docRef', /\.docRef\b/],
  ['RulingDocRef', /\bRulingDocRef\b/],
  ['an anchor key `in` test', /['"](?:rule|path|anchor|quotedText|docRef)['"]\s+in\b/],
];

/**
 * The source with comments and single- or double-quoted string literals blanked (template literals stay: they hold
 * code), except a literal that is the key of an `in` test, which is code.
 */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
    .replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1(?!\s+in\b)/g, "''");
}

function sources(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') ? [path] : [];
  });
}

describe('target.no-direct-access', () => {
  it('no module outside the accessors and the parsers reads a variant field directly', () => {
    const hits: string[] = [];
    for (const path of sources(SRC)) {
      const rel = relative(SRC, path);
      if (ALLOWED.has(rel)) continue;
      codeOf(readFileSync(path, 'utf8')).split('\n').forEach((line, i) => {
        for (const [what, re] of FORBIDDEN) if (re.test(line)) hits.push(`src/${rel}:${i + 1}: ${what}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  it('the guard sees each forbidden spelling, and not a comment or a string label', () => {
    for (const line of [
      'const d = plan.architectureDoc;', 'x(plan.architectureDigest)', 'plan.holistic?.vision', 'p.holistic.vision', 'o.docRef!.path', 'o.docRef?.anchor',
      'const r = d as RulingDocRef;', "if ('rule' in d) {}", 'if ("path" in d) {}',
    ]) {
      assert.ok(FORBIDDEN.some(([, re]) => re.test(codeOf(line))), line);
    }
    for (const line of ["load('plan.holistic.vision', p)", '// plan.architectureDoc', '/* o.docRef.path */', 'const t = targetDocuments(plan);']) {
      assert.ok(!FORBIDDEN.some(([, re]) => re.test(codeOf(line))), line);
    }
  });
});

