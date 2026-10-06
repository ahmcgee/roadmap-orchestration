// M4a step C1: `roadmap phase0 check` and the shared Phase-0 rows (src/phase0/rows.ts) over real repos, real pins
// (`roadmap corpus pin`), real issue captures against the fake forge and real snapshot refs for the chain (src/chain.ts).
// The classifier's and the apply's and start's sides are test/phase0-apply.test.ts. M4a rev 3 (N5):
// phase0.spec-census-mismatch-row. Run 10 (C): phase0.spec-census-witness-items.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acksDir, amendmentsOf, arcsWithRefs, chainBack, completedHeadOf, readArcRef } from '../src/chain.ts';
import { phase0Check } from '../src/commands/phase0.ts';
import { amendmentIdOf, arcId, divergenceIdOf, obligationId, ruleId } from '../src/core/ids.ts';
import { specM1 } from '../src/core/records.ts';
import { specCensusMismatches } from '../src/holistic/rederive.ts';
import { canonicalJson, sha256Hex } from '../src/core/json.ts';
import { repoPath } from '../src/core/values.ts';
import { debtKey } from '../src/debt/ledger.ts';
import { renderDebt } from '../src/docs/debt.ts';
import { normalizeText } from '../src/corpus/rules.ts';
import { parseCorpusPin } from '../src/corpus/types.ts';
import { ruleAnchorResolves } from '../src/holistic/obligations.ts';
import { parseObligations } from '../src/holistic/types.ts';
import { planInForce, revisionInForce } from '../src/input/inforce.ts';
import { rulingCorpusOf } from '../src/phase0/rows.ts';
import { UNTRUSTED_POLICY } from './helpers/forge.ts';
import {
  CAPTURE_FILE, type CorpusArc, PIN_FILE, betweenArc, check, corpusArc, editJsonFile, editPhase0, editPlan, inForce, kinds, nextArc, phase0Of, rowOf,
  runDirOfArc, seal, visionRecord, withForge,
} from './helpers/corpusarc.ts';
import { runUntilExit } from './helpers/proc.ts';
import { commitAll, git, writeFiles } from './helpers/repo.ts';

const T = { timeout: 120_000 };
type Json = Record<string, unknown>;

/** The problems of the arc's one `phase0-invalid` row (none: the row is absent). */
async function phase0Problems(a: CorpusArc): Promise<readonly unknown[]> {
  const rows = (await check(a)).rows;
  assert.deepEqual(kinds(rows).filter((k) => k !== 'phase0-invalid'), [], JSON.stringify(rows));
  return rows.length === 0 ? [] : rowOf(rows, 'phase0-invalid').problems;
}
async function corpusProblems(a: CorpusArc): Promise<readonly unknown[]> {
  const rows = (await check(a)).rows;
  assert.deepEqual(kinds(rows).filter((k) => k !== 'corpus-invalid'), [], JSON.stringify(rows));
  return rows.length === 0 ? [] : rowOf(rows, 'corpus-invalid').problems;
}
async function chainProblem(a: CorpusArc): Promise<unknown> {
  const rows = (await check(a)).rows;
  assert.deepEqual(kinds(rows).filter((k) => k !== 'chain-invalid'), [], JSON.stringify(rows));
  return rows.length === 0 ? null : rowOf(rows, 'chain-invalid').problem;
}
const green = async (a: CorpusArc): Promise<void> => assert.deepEqual((await check(a)).rows, []);

const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));

describe('phase0 check', () => {
  it('phase0.check-green-and-every-row: green with slice candidates; each row in turn; the CLI exits 0, then 78', T, async () => {
    const a = await corpusArc();
    const report = await check(a);
    assert.deepEqual(report, { rows: [], sliceCandidates: [] }, 'V-1 is served by a must-hold obligation: held on the baseline');
    const cli = async (): Promise<Readonly<{ code: number | null; out: Json }>> => {
      const r = await runUntilExit(process.execPath, [BIN, 'phase0', 'check', '--repo', a.repo, '--plan', a.planPath], {
        env: { PATH: a.forge.path, HOME: process.env['HOME'] ?? '/' }, timeoutMs: 60_000,
      });
      return { code: r.code, out: JSON.parse(r.stdout) as Json };
    };
    assert.deepEqual(await cli(), { code: 0, out: { rows: [], sliceCandidates: [] } });

    // corpus-invalid: the pin file no longer equals its re-derivation.
    const pinPath = join(a.planDir, PIN_FILE);
    const pin = readFileSync(pinPath);
    editJsonFile(pinPath, (p) => ({ ...p, highWater: 9 }));
    assert.deepEqual(await corpusProblems(a), [{ type: 'pin-drift' }]);
    const red = await cli();
    assert.equal(red.code, 78);
    assert.deepEqual(red.out, { rows: [{ kind: 'corpus-invalid', problems: [{ type: 'pin-drift' }] }], sliceCandidates: [] });
    writeFileSync(pinPath, pin);
    // phase0-invalid: the census misses T-3.
    const obligations = join(a.planDir, 'obligations.json');
    const before = readFileSync(obligations);
    editJsonFile(obligations, (o) => ({ ...o, census: (o['census'] as Json[]).filter((e) => e['rule'] !== 'T-3') }));
    assert.deepEqual(await phase0Problems(a), [{ type: 'census-incomplete', rules: ['T-3'] }]);
    writeFileSync(obligations, before);
    // vision-unconfirmed: a committed vision record with no confirmation.
    writeFiles(a.repo, { '.roadmap/vision.json': JSON.stringify(visionRecord(null)) });
    commitAll(a.repo, 'unconfirm');
    assert.deepEqual((await check(a)).rows, [{ kind: 'vision-unconfirmed', ref: null, expected: null, actual: null }]);
    writeFiles(a.repo, { '.roadmap/vision.json': JSON.stringify(visionRecord('# Vision\n\nanother text\n')) });
    commitAll(a.repo, 'confirm another text');
    const pinned = (JSON.parse(pin.toString('utf8')) as { vision: { sha256: string } }).vision.sha256;
    assert.deepEqual((await check(a)).rows, [{ kind: 'vision-unconfirmed', ref: `corpus:0005_Vision.md#sha256:${sha256Hex('# Vision\n\nanother text\n')}`, expected: sha256Hex('# Vision\n\nanother text\n'), actual: pinned }]);
    writeFiles(a.repo, { '.roadmap/vision.json': JSON.stringify(visionRecord('# Vision\n\nA calm harbour where every vessel has a berth.\n')) });
    commitAll(a.repo, 'confirm again');
    await green(a);
    // tree-uncommitted: the working tree's config is not HEAD's.
    writeFiles(a.repo, { '.roadmap/config.json': '{"chain":{"k":2}}\n' });
    assert.deepEqual((await check(a)).rows, [{ kind: 'tree-uncommitted', paths: ['.roadmap/config.json'] }]);
    git(a.repo, 'checkout', '--', '.roadmap/config.json');
    // issue-policy-untrusted: the forge lets anyone open issues.
    a.forge.setPolicy(UNTRUSTED_POLICY);
    assert.deepEqual((await check(a)).rows, [{ kind: 'issue-policy-untrusted', visibility: 'PUBLIC', policy: 'ALL' }]);
    a.forge.setPolicy({ ...UNTRUSTED_POLICY, issueCreationPolicy: 'COLLABORATORS_ONLY' });
    await green(a);
    // plan-invalid: a corpus arc names its obligations file (LR-0a-2).
    editPlan(a, (p) => ({ ...p, holistic: { advances: ['V-1'] } }));
    assert.deepEqual((await check(a)).rows.map((r) => (r.kind === 'plan-invalid' && r.problem.type === 'schema' ? r.problem.field : r.kind)), ['plan.holistic.obligations']);
  });

  it('phase0.slice-candidates: an active world clause only future obligations serve is a candidate (R15)', T, async () => {
    const a = await corpusArc({ activation: 'future' });
    assert.deepEqual(await check(a), { rows: [], sliceCandidates: ['V-1'] });
  });

  it('phase0.scope-overlaps-corpus: a unit scope that may write the same-repo corpus file set', T, async () => {
    for (const scope of [['docs/**'], ['docs/corpus/0010_Overview.md'], ['src/**', 'docs/corpus/new/**']]) {
      const a = await corpusArc({ scope });
      assert.deepEqual(await corpusProblems(a), [{ type: 'scope-overlaps-corpus', unit: 'u1' }], scope.join(','));
    }
    await green(await corpusArc({ scope: ['src/**', 'docs/api/**'] }));
  });

  it('phase0.contract-overlaps-corpus-direct: a plan contract that is a pinned corpus file', T, async () => {
    const a = await corpusArc({ plan: { contracts: ['docs/corpus/0010_Overview.md'] } });
    assert.deepEqual(await corpusProblems(a), [{ type: 'contract-overlaps-corpus', path: 'docs/corpus/0010_Overview.md' }]);
  });

  it('phase0.contract-overlaps-corpus-glob: a plan contract an include pattern matches, pinned or not', T, async () => {
    const a = await corpusArc({ plan: { contracts: ['docs/api.md', 'docs/corpus/sub/0099_New.md'] } });
    assert.deepEqual(await corpusProblems(a), [{ type: 'contract-overlaps-corpus', path: 'docs/corpus/sub/0099_New.md' }]);
  });

  it('ruling.corpus-in-force: the ruling context of a corpus arc in force: its active rules and its same-repo corpus file set', T, async () => {
    const a = await corpusArc();
    const j = inForce(a);
    try {
      const runDir = runDirOfArc(a);
      const corpus = revisionInForce(runDir, planInForce(runDir, j.view)!).corpus;
      assert.ok(corpus !== null);
      const r = rulingCorpusOf(corpus);
      assert.deepEqual([...r.rules.keys()], ['T-1', 'T-2', 'T-3']);
      assert.equal(r.rules.get(ruleId('T-1')), corpus.pin.value.rules[0]!.textSha256);
      assert.deepEqual(['docs/corpus/0010_Overview.md', 'docs/corpus/sub/new.md', 'src/berths.ts', 'docs/api.md'].map((p) => r.inFileSet(repoPath(p))), [true, true, false, false]);
    } finally {
      j.close();
    }
  });
});

describe('the pack\'s specs against the census (M4a rev 3, H3)', () => {
  it('phase0.spec-census-mismatch-row: a spec declaring an obligation whose rule the census does not give it, and an acceptance clause naming an out-of-slice rule, are rows', T, async () => {
    const a = await corpusArc();
    await green(a);
    const pin = parseCorpusPin(JSON.parse(readFileSync(join(a.planDir, PIN_FILE), 'utf8')));
    const t2 = pin.rules.find((r) => r.id === 'T-2')!;
    editJsonFile(join(a.planDir, 'obligations.json'), (o) => {
      const i1 = (o['obligations'] as Json[])[0]!;
      return { ...o, obligations: [i1, { ...i1, id: 'I-2', statement: 'A booking names one berth.', rule: { id: 'T-2', textSha256: t2.textSha256 }, state: { type: 'deferred', ruling: 'C-1' } }] };
    });
    await green(a);
    editJsonFile(join(a.planDir, 'u1.json'), (s) => ({
      ...s, obligations: ['I-1', 'I-2'],
      acceptance: [...(s['acceptance'] as Json[]), { id: 'A2', clause: 'A booking names its berth (T-2), as T-1 needs.', failLoudIfUndelivered: false, state: 'active' }, { id: 'A3', clause: 'T-2 again.', failLoudIfUndelivered: false, state: 'struck' }],
    }));
    assert.deepEqual(await phase0Problems(a), [
      { type: 'spec-census-mismatch', unit: 'u1', item: 'I-2', rule: 'T-2', state: 'out-of-slice' },
      { type: 'spec-census-mismatch', unit: 'u1', item: 'A2', rule: 'T-2', state: 'out-of-slice' },
    ], 'the binding I-1 on its own rule and a struck clause are fine');
  });
});

describe('the one spec-census predicate (run 10, C)', () => {
  it('phase0.spec-census-witness-items: an active witness item naming an out-of-slice rule in its test id or skeleton is a mismatch; a struck one, an in-slice rule and an acceptance clause on another rule are not', () => {
    const spec = specM1({
      schema: 'roadmap/spec-m1', unit: 'u1', rev: 2, lanes: [], scope: ['src/**'], resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] },
      acceptance: [{ id: 'A1', clause: 'A booking names one berth (T-1).', failLoudIfUndelivered: false, state: 'active' }],
      witnesses: [
        { id: 'W-1', lane: 'journey', testId: 'refusal names T-2', clause: 'A1', skeleton: 'book twice', state: 'active' },
        { id: 'W-2', lane: 'journey', testId: 'next steps', clause: 'A1', skeleton: 'assert the T-2 next step', state: 'active' },
        { id: 'W-3', lane: 'journey', testId: 'old', clause: 'A1', skeleton: 'T-2', state: 'struck' },
        { id: 'W-4', lane: 'journey', testId: 'in slice', clause: 'A1', skeleton: 'T-1 holds', state: 'active' },
      ],
    }, 'spec');
    const obligations = { obligations: [] } as unknown as Parameters<typeof specCensusMismatches>[1];
    const census = [{ rule: ruleId('T-1'), state: { type: 'obligation' as const, id: obligationId('I-1') } }, { rule: ruleId('T-2'), state: { type: 'out-of-slice' as const } }];
    assert.deepEqual(specCensusMismatches([spec], obligations, census), [
      { type: 'spec-census-mismatch', unit: 'u1', item: 'W-1', rule: 'T-2', state: 'out-of-slice' },
      { type: 'spec-census-mismatch', unit: 'u1', item: 'W-2', rule: 'T-2', state: 'out-of-slice' },
    ]);
  });
});

describe('exempt obligations and retired rules (LR-C1-2)', () => {
  /** The baseline publishes T-9 active (the corpus no longer holds it, so the pin retires it with this hash). */
  const RETIRED_TEXT = 'A berth may be held overnight.';
  const RETIRED = { id: 'T-9', textSha256: sha256Hex(normalizeText(RETIRED_TEXT)) };
  const SAMPLE = ['A berth is never double-booked.', 'A booking names one berth and one tide window.', 'A cancelled booking frees its berth at once.'];
  const active = [...SAMPLE.map((text, i) => ({ id: `T-${i + 1}`, textSha256: sha256Hex(normalizeText(text)) })), RETIRED];
  const invariants = `# Invariants\n\n\`\`\`json roadmap-rules\n${canonicalJson({ highWater: 9, active, retired: [] })}\n\`\`\`\n`;
  /** I-1, then I-2 (`state`, anchored at `rule`, absent from the census). */
  const withI2 = (a: CorpusArc, rule: Json, state: Json): void => editJsonFile(join(a.planDir, 'obligations.json'), (o) => {
    const i1 = (o['obligations'] as Json[])[0]!;
    return { ...o, obligations: [i1, { ...i1, id: 'I-2', statement: 'A berth is held overnight.', rule, state }] };
  });

  it('phase0.exempt-rule-anchor: an exempt obligation may keep a rule the pin retired (same hash) and stay out of the census; another hash, or no such rule, is unresolved', T, async () => {
    const a = await corpusArc({ files: { '.roadmap/invariants.md': invariants } });
    const pin = JSON.parse(readFileSync(join(a.planDir, PIN_FILE), 'utf8')) as { retired: Json[]; highWater: number };
    assert.deepEqual(pin.retired, [RETIRED], 'the pin retires T-9');
    await green(a);
    withI2(a, RETIRED, { type: 'deferred', ruling: 'C-1' });
    await green(a);
    withI2(a, { ...RETIRED, textSha256: sha256Hex('another text') }, { type: 'deferred', ruling: 'C-1' });
    assert.deepEqual(await phase0Problems(a), [{ type: 'obligation-rule-unresolved', obligation: 'I-2' }]);
    withI2(a, { id: 'T-8', textSha256: RETIRED.textSha256 }, { type: 'waived', ruling: 'C-1' });
    assert.deepEqual(await phase0Problems(a), [{ type: 'obligation-rule-unresolved', obligation: 'I-2' }]);
  });

  it('a binding obligation resolves only to an active rule: a retired one, whatever its hash, does not (ruleAnchorResolves)', T, async () => {
    const a = await corpusArc({ files: { '.roadmap/invariants.md': invariants } });
    const pin = parseCorpusPin(JSON.parse(readFileSync(join(a.planDir, PIN_FILE), 'utf8')));
    const o = parseObligations(JSON.parse(readFileSync(join(a.planDir, 'obligations.json'), 'utf8'))).obligations[0]!;
    assert.equal(ruleAnchorResolves(o, pin), true);
    const at = (rule: Json, state: Json) => ({ ...o, rule, state }) as unknown as typeof o;
    assert.equal(ruleAnchorResolves(at(RETIRED, { type: 'active' }), pin), false);
    assert.equal(ruleAnchorResolves(at(RETIRED, { type: 'retired', ruling: 'C-1' }), pin), true);
    assert.equal(ruleAnchorResolves(at({ id: 'T-1', textSha256: sha256Hex('reworded') }, { type: 'waived', ruling: 'C-1' }), pin), false);
  });
});

describe('phase0 debt and questions', () => {
  /** A baseline debt ledger: B-1 open and kept in each of the two previous arcs, B-2 open and new. */
  const debtFiles = (): Readonly<Record<string, string>> => {
    const item = (n: number, history: readonly Json[]): Json => ({
      id: `B-${n}`, originArc: 'arc-a', bankReason: 'gate-note', what: `debt ${n}`, unit: null,
      key: debtKey({ unit: null, bankReason: 'gate-note', what: `debt ${n}` }), history, state: 'open',
    });
    const keep = (arc: string): Json => ({ arc, disposition: { type: 'keep', reason: 'later' } });
    return { '.roadmap/debt.md': renderDebt({ schema: 'roadmap/debt-m4', items: [item(1, [keep('arc-a'), keep('arc-b')]), item(2, [])] } as never) };
  };
  const question = (id: string, text: string, rank = 1): Json => ({
    id, rank, text, files: ['0010_Overview.md'], bears: ['T-1'], assumption: 'keep going', state: { type: 'open' },
  });

  it('phase0.debt-undispositioned: every open item of the baseline ledger needs a disposition', T, async () => {
    const a = await corpusArc({ files: debtFiles() });
    assert.deepEqual(await phase0Problems(a), [{ type: 'debt-undispositioned', id: 'B-1' }, { type: 'debt-undispositioned', id: 'B-2' }]);
  });

  it('phase0.debt-kept-twice-unasked: a third keep needs a question naming the item; promote and resolve name a plan unit and an active ruling', T, async () => {
    const a = await corpusArc({ files: debtFiles() });
    const debt = (b1: Json, b2: Json): void => editPhase0(a, (r) => ({ ...r, debt: [{ id: 'B-1', disposition: b1 }, { id: 'B-2', disposition: b2 }] }));
    debt({ type: 'keep', reason: 'still later' }, { type: 'keep', reason: 'later' });
    assert.deepEqual(await phase0Problems(a), [{ type: 'debt-kept-twice-unasked', id: 'B-1' }]);
    editPhase0(a, (r) => ({ ...r, questions: [question('P-1', 'Should B-1 be paid down now, or dropped?')] }));
    await green(a);
    debt({ type: 'promote', unit: 'u1' }, { type: 'resolve', ruling: 'C-1' });
    await green(a);
    debt({ type: 'promote', unit: 'u9' }, { type: 'resolve', ruling: 'C-9' });
    assert.deepEqual((await check(a)).rows.map((r) => (r.kind === 'plan-invalid' && r.problem.type === 'schema' ? r.problem.field : r.kind)), ['plan.phase0.debt.B-1', 'plan.phase0.debt.B-2']);
  });

  it('phase0.question-reused: a carried question keeps its id and text; a new one takes an id above the chain closure\'s highest (H23)', T, async () => {
    const a1 = await corpusArc();
    editPhase0(a1, (r) => ({ ...r, questions: [question('P-1', 'q one', 1), question('P-3', 'q three', 2)] }));
    const h1 = await seal(a1);
    betweenArc(a1.repo, h1);
    const a2 = await nextArc(a1, h1, 'arc-2');
    const questions = (...qs: Json[]): void => editPhase0(a2, (r) => ({ ...r, questions: qs }));
    questions(question('P-1', 'q one', 1), question('P-4', 'q four', 2));
    await green(a2);
    questions(question('P-1', 'q one, reworded', 1));
    assert.deepEqual(await phase0Problems(a2), [{ type: 'question-reused', id: 'P-1' }]);
    questions(question('P-2', 'a new question at a used number', 1));
    assert.deepEqual(await phase0Problems(a2), [{ type: 'question-reused', id: 'P-2' }]);
  });
});

describe('phase0 intake', () => {
  const outcome = (issue: string): Json => ({ issue, outcome: { type: 'none', reason: 'nothing to do' } });

  it('phase0.intake-missing-against-capture: an issue of the kept capture with no outcome', T, async () => {
    const a = await corpusArc();
    editPhase0(a, (r) => ({ ...r, intake: [] }));
    assert.deepEqual(await phase0Problems(a), [{ type: 'intake-missing', issue: 'issue-1' }]);
  });

  it('phase0.intake-unknown-against-capture: an outcome for an issue the capture does not hold (an issue opened after it is the first checkpoint\'s)', T, async () => {
    const a = await corpusArc();
    a.forge.addIssue({ title: 'opened after the capture', labels: ['roadmap:feedback'] });
    editPhase0(a, (r) => ({ ...r, intake: [outcome('issue-1'), outcome('issue-2')] }));
    assert.deepEqual(await phase0Problems(a), [{ type: 'intake-unknown', issue: 'issue-2' }]);
  });

  it('phase0.intake-duplicate-against-capture: two outcomes for one issue', T, async () => {
    const a = await corpusArc();
    editPhase0(a, (r) => ({ ...r, intake: [outcome('issue-1'), outcome('issue-1')] }));
    assert.deepEqual(await phase0Problems(a), [{ type: 'intake-duplicate', issue: 'issue-1' }]);
  });

  it('phase0.capture-missing: the capture the record names is absent or not the bytes it hashed', T, async () => {
    const a = await corpusArc();
    editJsonFile(join(a.planDir, CAPTURE_FILE), (c) => ({ ...c, filtered: { comments: 5, pullRequests: 0 } }));
    assert.deepEqual(await phase0Problems(a), [{ type: 'capture-missing' }]);
  });

  it('phase0.capture-foreign: the capture\'s repo is not the one gh resolves now (live only)', T, async () => {
    const a = await corpusArc();
    const was = a.forge.read().repo;
    a.forge.update((s) => ({ ...s, repo: { ...s.repo, owner: 'someone-else' } }));
    assert.deepEqual(await phase0Problems(a), [{ type: 'capture-foreign', expected: { ...was, owner: 'someone-else' }, actual: was }]);
  });

  it('phase0.issue-policy-untrusted: PUBLIC + ALL refuses; issues disabled or collaborators-only do not (OR-L6)', T, async () => {
    const a = await corpusArc();
    a.forge.setPolicy(UNTRUSTED_POLICY);
    assert.deepEqual((await check(a)).rows, [{ kind: 'issue-policy-untrusted', visibility: 'PUBLIC', policy: 'ALL' }]);
    a.forge.setPolicy({ ...UNTRUSTED_POLICY, hasIssuesEnabled: false });
    await green(a);
  });
});

describe('the chain (src/chain.ts)', () => {
  /** Arc 1 sealed with one amendment, the between-arc commit on its head, arc 2 chained over it. */
  async function twoArcs(): Promise<Readonly<{ a1: CorpusArc; h1: string; a2: CorpusArc }>> {
    const a1 = await corpusArc();
    const h1 = await seal(a1, {
      before: (j) => j.fact({
        kind: 'corpus-amendment', id: amendmentIdOf(1), source: { type: 'divergence', divergence: divergenceIdOf(1) }, rules: [ruleId('T-2')],
        proposal: 'Name the tide window in every booking.', why: 'D-1', evidence: [],
      }),
    });
    betweenArc(a1.repo, h1);
    const a2 = await nextArc(a1, h1, 'arc-2');
    editPhase0(a2, (r) => ({ ...r, amendments: [{ id: 'arc-1/M-1', disposition: { type: 'applied', rules: ['T-2'] } }] }));
    return { a1, h1, a2 };
  }

  it('chain.derived-from-refs: arcs, completed heads, amendments and previous arcs from the verified refs alone', T, async () => {
    const { a1, h1, a2 } = await twoArcs();
    await green(a2);
    const h2 = await seal(a2);
    assert.deepEqual(arcsWithRefs(a1.repo), ['arc-1', 'arc-2']);
    const chain = chainBack(a1.repo, arcId('arc-2'));
    assert.deepEqual([chain.arcs.map((r) => r.arc), chain.missing], [['arc-1', 'arc-2'], null]);
    assert.deepEqual(chain.arcs.map((r) => completedHeadOf(r)), [{ head: h1, done: true }, { head: h2, done: true }]);
    assert.deepEqual(amendmentsOf(chain.arcs[0]!).map((x) => x.id), ['arc-1/M-1']);
    assert.equal(chain.arcs[1]!.plan.chain?.previousArc, 'arc-1');
    assert.equal(readArcRef(a1.repo, arcId('arc-9')), null);
    assert.deepEqual(chainBack(a1.repo, arcId('arc-9')), { arcs: [], missing: 'arc-9' });
  });

  it('phase0.amendment-undispositioned: every amendment of the previous arc\'s verified ref needs a disposition', T, async () => {
    const { a2 } = await twoArcs();
    editPhase0(a2, (r) => ({ ...r, amendments: [] }));
    assert.deepEqual(await phase0Problems(a2), [{ type: 'amendment-undispositioned', id: 'arc-1/M-1' }]);
    editPhase0(a2, (r) => ({ ...r, amendments: [{ id: 'arc-1/M-1', disposition: { type: 'deferred', reason: 'next arc' } }, { id: 'arc-1/M-2', disposition: { type: 'rejected', reason: 'no' } }] }));
    assert.deepEqual((await check(a2)).rows.map((r) => (r.kind === 'plan-invalid' && r.problem.type === 'schema' ? r.problem.field : r.kind)), ['plan.phase0.amendments.arc-1/M-2']);
  });

  it('phase0.chain-baseline-previous-head: plan.chain.previousHead is not the previous arc\'s completed head', T, async () => {
    const { a1, a2 } = await twoArcs();
    editPlan(a2, (p) => ({ ...p, chain: { previousArc: 'arc-1', previousHead: git(a1.repo, 'rev-parse', 'main~1') } }));
    assert.deepEqual(await chainProblem(a2), { type: 'baseline', baseline: { type: 'previous-head-mismatch' } });
  });

  it('phase0.chain-baseline-merge: the baseline is a merge commit', T, async () => {
    const a1 = await corpusArc();
    const h1 = await seal(a1);
    git(a1.repo, 'checkout', '--quiet', '-b', 'side', h1);
    writeFiles(a1.repo, { '.roadmap/config.json': '{"chain":{"k":2}}\n' });
    commitAll(a1.repo, 'side');
    git(a1.repo, 'checkout', '--quiet', '--detach', h1);
    git(a1.repo, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
    const a2 = await nextArc(a1, h1, 'arc-2');
    assert.deepEqual(await chainProblem(a2), { type: 'baseline', baseline: { type: 'merge-commit' } });
  });

  it('phase0.chain-baseline-parent: more than one commit between the previous head and the baseline', T, async () => {
    const a1 = await corpusArc();
    const h1 = await seal(a1);
    const first = betweenArc(a1.repo, h1);
    betweenArc(a1.repo, first, { '.roadmap/config.json': '{"chain":{"k":1}}\n' });
    const a2 = await nextArc(a1, h1, 'arc-2');
    assert.deepEqual(await chainProblem(a2), { type: 'baseline', baseline: { type: 'parent-mismatch' } });
  });

  it('phase0.chain-baseline-paths: the between-arc commit touches only .roadmap/{vision.json, corpus.md, config.json} and same-repo corpus paths', T, async () => {
    const a1 = await corpusArc();
    const h1 = await seal(a1);
    betweenArc(a1.repo, h1, { 'src/extra.ts': 'export {};\n', 'README.md': 'changed\n', '.roadmap/config.json': '{"chain":{"k":1}}\n' });
    const bad = await nextArc(a1, h1, 'arc-2');
    assert.deepEqual(await chainProblem(bad), { type: 'baseline', baseline: { type: 'paths', paths: ['README.md', 'src/extra.ts'] } });
    const overview = join(a1.repo, 'docs/corpus/0010_Overview.md');
    betweenArc(a1.repo, h1, { 'docs/corpus/0010_Overview.md': `${readFileSync(overview, 'utf8')}\nMore rationale.\n`, '.roadmap/config.json': '{"chain":{"k":1}}\n' });
    await green(await nextArc(a1, h1, 'arc-3'));
  });

  it('phase0.chain-previous-incomplete: the previous arc has no ref, or no completion in it', T, async () => {
    const a1 = await corpusArc();
    const h1 = await seal(a1, { complete: false });
    betweenArc(a1.repo, h1);
    const a2 = await nextArc(a1, h1, 'arc-2');
    assert.deepEqual(await chainProblem(a2), { type: 'previous-incomplete', arc: 'arc-1' });
    editPlan(a2, (p) => ({ ...p, chain: { previousArc: 'arc-0', previousHead: h1 } }));
    assert.deepEqual(await chainProblem(a2), { type: 'previous-incomplete', arc: 'arc-0' });
  });

  it('chain.k-limit: unacked starts since the last ack may not exceed K (bootstrap acked); an ack of the chain head releases; no K refuses a chained start', T, async () => {
    const { a1, a2 } = await twoArcs();
    const h2 = await seal(a2);
    betweenArc(a1.repo, h2);
    const a3 = await nextArc(a2, h2, 'arc-3');
    assert.deepEqual(await chainProblem(a3), { type: 'limit', k: 1, unacked: 2 });
    const marker = { briefId: '0123456789abcdef', at: '2026-10-02T00:00:00.000Z', chainHead: 'arc-2', coverage: [], items: [] };
    mkdirSync(acksDir(a1.repo), { recursive: true });
    writeFileSync(join(acksDir(a1.repo), '0123456789abcdef.pending.json'), canonicalJson(marker));
    assert.deepEqual(await chainProblem(a3), { type: 'limit', k: 1, unacked: 2 }, 'a pending marker is not an ack');
    writeFileSync(join(acksDir(a1.repo), '0123456789abcdef.json'), canonicalJson(marker));
    assert.equal(await chainProblem(a3), null);
    // Without K, a chained start is refused (K is asked at bootstrap and never written by the agent).
    betweenArc(a1.repo, h2, { '.roadmap/config.json': '{}\n' });
    const noK = await nextArc(a2, h2, 'arc-4');
    assert.deepEqual(await chainProblem(noK), { type: 'k-unset' });
  });
});

describe('phase0 check --from-ref (K20)', () => {
  it('phase0.from-ref: the arc\'s inputs by the digests its verified ref recorded, after the live files changed', T, async () => {
    const a = await corpusArc();
    await seal(a);
    // The live files move on: the pin, the capture, the record and the vision in the working tree.
    editJsonFile(join(a.planDir, PIN_FILE), (p) => ({ ...p, highWater: 9 }));
    editJsonFile(join(a.planDir, CAPTURE_FILE), (c) => ({ ...c, filtered: { comments: 3, pullRequests: 0 } }));
    editPhase0(a, (r) => ({ ...r, intake: [] }));
    writeFiles(a.repo, { '.roadmap/vision.json': JSON.stringify(visionRecord(null)) });
    commitAll(a.repo, 'the live vision moves on');
    assert.deepEqual([...kinds((await check(a)).rows)].sort(), ['corpus-invalid', 'phase0-invalid', 'vision-unconfirmed']);
    const fromRef = await withForge(a.forge, () => phase0Check({ repo: a.repo, source: { type: 'ref', arc: a.arc } }));
    assert.deepEqual(fromRef, { rows: [], sliceCandidates: [] });
    assert.deepEqual(phase0Of(a)['intake'], [], 'the live record is not what the ref check read');
  });

  it('phase0.from-ref-unknown-arc: an arc with no ref is a CLI error', T, async () => {
    const a = await corpusArc();
    await assert.rejects(phase0Check({ repo: a.repo, source: { type: 'ref', arc: arcId('arc-9') } }), /no refs\/roadmap\/arc-9/);
  });
});
