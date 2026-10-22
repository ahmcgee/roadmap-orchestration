// Plan defects (2026-10-16): a plan defect code can check is refused at Phase 0 (`plan-defect`, src/phase0/rows.ts row
// 11), over a corpus arc's real files and git (test/helpers/corpusarc.ts). Named tests: plan-defect.witness-in-lane,
// plan-defect.argv-forms, plan-defect.witness-reachable, plan-defect.undeclared, plan-defect.undeclared-per-witness,
// plan-defect.derived, plan-defect.regenerate.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { obligationId, unitId } from '../src/core/ids.ts';
import { repoPath, repoPattern } from '../src/core/values.ts';
import { type ArcLaneDef, type PlanDefect, laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { laneMisses } from '../src/holistic/witnessfiles.ts';
import { derivedWidening } from '../src/input/derived.ts';
import { parsePlan, regenerateLaneId } from '../src/input/plan.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../src/phase0/rows.ts';
import { type CorpusArc, PIN_FILE, WITNESS_FILE, check, corpusArc, editJsonFile, editPlan, filesOf, kinds, rowOf } from './helpers/corpusarc.ts';

const T = { timeout: 120_000 };
type Json = Record<string, unknown>;

const obligationsPath = (a: CorpusArc): string => join(a.planDir, 'obligations.json');

/** Edits the journey lane and I-1's witness, keeping I-1's proof judgment bound to what it now judges. */
function editWitness(a: CorpusArc, edit: Readonly<{ lane?: (l: Json) => Json; witness?: (w: Json) => Json; i1?: (o: Json) => Json }>): void {
  editJsonFile(obligationsPath(a), (o) => {
    const lane = (edit.lane ?? ((l) => l))((o['lanes'] as Json[])[0]!);
    const laneRev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [lane], obligations: [], mapping: { paths: [] } }).lanes[0]!);
    const i1 = (o['obligations'] as Json[])[0]!;
    const witness = (edit.witness ?? ((w) => w))(i1['witness'] as Json);
    return { ...o, lanes: [lane], obligations: [{ ...(edit.i1 ?? ((x) => x))(i1), witness, proofJudgment: { ...(i1['proofJudgment'] as Json), laneRev, witness } }] };
  });
}

/** The defects of the arc's one `plan-defect` row (none: no row); any other row fails the test. */
async function defects(a: CorpusArc): Promise<readonly PlanDefect[]> {
  const rows = (await check(a)).rows;
  assert.deepEqual(kinds(rows).filter((k) => k !== 'plan-defect'), [], JSON.stringify(rows));
  return rows.length === 0 ? [] : rowOf(rows, 'plan-defect').defects;
}

describe('witness files against their lane', () => {
  it('plan-defect.witness-in-lane: a witness file outside the lane\'s testPaths, or not named by an argv that names test files, is refused', T, async () => {
    const a = await corpusArc();
    assert.deepEqual(await defects(a), []);
    editWitness(a, { lane: (l) => ({ ...l, testPaths: ['spec'] }) });
    assert.deepEqual(await defects(a), [{ type: 'witness-not-in-lane', obligation: 'I-1', lane: 'journey', file: WITNESS_FILE, missing: 'test-paths' }]);
    editWitness(a, { lane: (l) => ({ ...l, testPaths: ['test'], argv: ['node', '--test', 'test/other'] }) });
    assert.deepEqual(await defects(a), [{ type: 'witness-not-in-lane', obligation: 'I-1', lane: 'journey', file: WITNESS_FILE, missing: 'argv' }]);
    editWitness(a, { lane: (l) => ({ ...l, argv: ['node', '--test', 'test/other', 'test/berths.test.ts'] }) });
    assert.deepEqual(await defects(a), []);
  });

  it('plan-defect.argv-forms: the forms an argv names its test files by', () => {
    const lane = (argv: readonly string[], cwd = '.', testPaths: readonly string[] | null = ['test']): ArcLaneDef => parseObligations({
      schema: 'roadmap/obligations-m3', cutLine: 'x', obligations: [], mapping: { paths: [] },
      lanes: [{ id: 'journey', argv, cwd, env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'jsonl', ...(testPaths === null ? {} : { testPaths }) }],
    }).lanes[0]!;
    const file = repoPath('test/unit/a.test.ts');
    // The runner selects (no test path named): testPaths alone decides.
    assert.equal(laneMisses(lane(['npm', 'test']), file), null);
    assert.equal(laneMisses(lane(['node', '--test', '--test-reporter', 'spec']), file), null);
    // A directory above it, the file itself, a glob matching it, the repo root, a path against the lane's cwd.
    assert.equal(laneMisses(lane(['node', '--test', 'test/unit']), file), null);
    assert.equal(laneMisses(lane(['node', '--test', './test/unit/a.test.ts']), file), null);
    assert.equal(laneMisses(lane(['node', '--test', 'test/**/*.test.ts']), file), null);
    assert.equal(laneMisses(lane(['node', '--test', '.']), file), null);
    assert.equal(laneMisses(lane(['node', '--test', 'unit'], 'test'), file), null);
    assert.equal(laneMisses(lane(['node', '--test', 'other'], 'test'), file), 'argv');
    // A go package pattern names its directory and everything under it.
    const goFile = repoPath('pkg/berth/berth_test.go');
    assert.equal(laneMisses(lane(['go', 'test', '-json', './pkg/...'], '.', ['pkg']), goFile), null);
    assert.equal(laneMisses(lane(['go', 'test', '-json', './pkg/berth/...'], '.', ['pkg']), goFile), null);
    assert.equal(laneMisses(lane(['go', 'test', '-json', './pkg/tide/...'], '.', ['pkg']), goFile), 'argv');
    // A flag's value or a path outside the repo names no test path; a lane without testPaths decides nothing.
    assert.equal(laneMisses(lane(['node', '--test', '--import=./test/setup.ts', '/abs/test']), file), null);
    assert.equal(laneMisses(lane(['node', '--test', 'test/other'], '.', null), file), null);
    assert.equal(laneMisses(lane(['npm', 'test'], '.', ['src']), file), 'test-paths');
  });
});

describe('witness files their deliverers can create', () => {
  it('plan-defect.witness-reachable: a witness file absent at the tip is refused unless a deliverer, or a unit it runs after, covers it', T, async () => {
    const a = await corpusArc({ activation: 'future' });
    const NEW = 'test/new.test.ts';
    editWitness(a, { witness: (w) => ({ ...w, files: [NEW] }) });
    assert.deepEqual(await defects(a), [{ type: 'witness-file-unreachable', obligation: 'I-1', file: NEW, units: ['u1'] }]);
    // u1's own scope covers it.
    editPlan(a, (p) => ({ ...p, units: (p['units'] as Json[]).map((u) => ({ ...u, scope: ['src/**', 'test/**'] })) }));
    assert.deepEqual(await defects(a), []);
    // u0, which u1 runs after, covers it.
    const spec = JSON.parse(readFileSync(join(a.planDir, 'u1.json'), 'utf8')) as Json;
    writeFileSync(join(a.planDir, 'u0.json'), JSON.stringify({ ...spec, unit: 'u0', scope: ['test/**'], obligations: undefined }));
    editPlan(a, (p) => ({
      ...p, units: [{ id: 'u0', spec: 'u0.json', risk: 'low', scope: ['test/**'], resources: [] }, ...(p['units'] as Json[]).map((u) => ({ ...u, scope: ['src/**'], after: ['u0'] }))],
    }));
    assert.deepEqual(await defects(a), []);
    // A must-hold obligation binds now: its witness file exists at the tip, or nobody creates it.
    editPlan(a, (p) => ({ ...p, units: (p['units'] as Json[]).filter((u) => u['id'] !== 'u0').map((u) => ({ ...u, after: [] })) }));
    editWitness(a, { i1: (o) => ({ ...o, activation: 'must-hold', deliveredBy: [] }) });
    assert.deepEqual(await defects(a), [{ type: 'witness-file-unreachable', obligation: 'I-1', file: NEW, units: [] }]);
  });
});

describe('declared test paths and witness files', () => {
  it('plan-defect.undeclared: a fresh start requires both; an arc whose recorded inputs declare neither is read as undeclared, not refused', T, async () => {
    const a = await corpusArc();
    editWitness(a, { lane: ({ testPaths: _t, ...l }) => l, witness: ({ files: _f, ...w }) => w });
    assert.deepEqual(await defects(a), [{ type: 'lane-test-paths-undeclared', lane: 'journey' }, { type: 'witness-files-undeclared', obligation: 'I-1' }]);
    // An apply (or a restart) of an arc started before: nothing declared anywhere, so nothing to check.
    assert.deepEqual(phase0Rows(phase0InputOf(filesOf(a), null), APPLY).rows, []);
  });

  it('plan-defect.undeclared-per-witness: on an arc started before, one witness declaring files is checked alone; the others stay undeclared, not refused', T, async () => {
    // The field arc (2026-10-21): a checkpoint split gave two children files on an arc whose witnesses declared none.
    const a = await corpusArc();
    editWitness(a, { lane: ({ testPaths: _t, ...l }) => l, witness: ({ files: _f, ...w }) => w });
    const t2 = (JSON.parse(readFileSync(join(a.planDir, PIN_FILE), 'utf8')) as { rules: Json[] }).rules.find((r) => r['id'] === 'T-2')!;
    const withI2 = (files: readonly string[]): void => editJsonFile(obligationsPath(a), (o) => {
      const i1 = (o['obligations'] as Json[])[0]!;
      const witness = { ...(i1['witness'] as Json), files };
      const i2 = { ...i1, id: 'I-2', rule: { id: 'T-2', textSha256: t2['textSha256'] }, witness, proofJudgment: { ...(i1['proofJudgment'] as Json), witness } };
      const census = (o['census'] as Json[]).map((e) => (e['rule'] === 'T-2' ? { rule: 'T-2', state: { type: 'obligation', id: 'I-2' } } : e));
      return { ...o, obligations: [i1, i2], census };
    });
    withI2([WITNESS_FILE]);
    assert.deepEqual(phase0Rows(phase0InputOf(filesOf(a), null), APPLY).rows, []);
    // I-2's declared file is still checked.
    withI2(['test/new.test.ts']);
    assert.deepEqual(phase0Rows(phase0InputOf(filesOf(a), null), APPLY).rows, [{ kind: 'plan-defect', defects: [{ type: 'witness-file-unreachable', obligation: obligationId('I-2'), file: repoPath('test/new.test.ts'), units: [] }] }]);
  });
});

describe('derived files', () => {
  it('plan-defect.derived: an output inside a unit that covers none of its sources, or on the corpus, is refused; a source\'s unit takes the outputs in', T, async () => {
    const plan = (derived: readonly Json[], units: readonly Json[] = []) => (p: Json): Json => ({ ...p, derived, units: [...(p['units'] as Json[]), ...units] });
    const a = await corpusArc();
    editPlan(a, plan([{ sources: ['src/**'], outputs: ['dist/bundle.js'] }]));
    assert.deepEqual(await defects(a), []);
    const widened = parsePlan(JSON.parse(readFileSync(a.planPath, 'utf8')));
    assert.deepEqual(derivedWidening(widened, [repoPattern('src/**')]), ['dist/bundle.js']);
    assert.deepEqual(derivedWidening(widened, [repoPattern('src/lib')]), ['dist/bundle.js'], 'a scope under a source pattern covers it');
    assert.deepEqual(derivedWidening(widened, [repoPattern('test/**')]), []);

    const spec = JSON.parse(readFileSync(join(a.planDir, 'u1.json'), 'utf8')) as Json;
    const b = await corpusArc();
    writeFileSync(join(b.planDir, 'u2.json'), JSON.stringify({ ...spec, unit: 'u2', scope: ['dist/**'], obligations: undefined }));
    editPlan(b, plan([{ sources: ['src/**'], outputs: ['dist/bundle.js'] }], [{ id: 'u2', spec: 'u2.json', risk: 'low', scope: ['dist/**'], resources: [] }]));
    assert.deepEqual(await defects(b), [{ type: 'derived-output-owned', output: repoPattern('dist/bundle.js'), unit: unitId('u2') }]);

    const c = await corpusArc();
    editPlan(c, plan([{ sources: ['src/**'], outputs: ['docs/corpus/generated.md'] }]));
    assert.deepEqual(await defects(c), [{ type: 'derived-overlaps-corpus', output: repoPattern('docs/corpus/generated.md') }]);
  });

  it('plan-defect.regenerate: a regenerate argv is well-formed and runnable; an entry a unit takes in without one is advised, never refused', T, async () => {
    const GEN = { argv: ['node', 'tools/gen.mjs'], cwd: '.', env: { set: {}, pass: ['PATH'] } };
    const entry = (regenerate?: Json): Json => ({ sources: ['src/**'], outputs: ['dist/bundle.js'], ...(regenerate === undefined ? {} : { regenerate }) });
    const a = await corpusArc();
    // No regenerate: an advisory naming the outputs and the unit that takes them in; no row.
    editPlan(a, (p) => ({ ...p, derived: [entry()] }));
    const advised = await check(a);
    assert.deepEqual(advised.rows, []);
    assert.deepEqual(advised.advisories, [{ kind: 'derived-unregenerated', outputs: [repoPattern('dist/bundle.js')], units: [unitId('u1')] }]);
    // A runnable generator: neither.
    editPlan(a, (p) => ({ ...p, derived: [entry(GEN)] }));
    const clean = await check(a);
    assert.deepEqual([clean.rows, clean.advisories], [[], []]);
    // A generator whose argv[0] resolves nowhere is refused as the suite lane its check runs under.
    editPlan(a, (p) => ({ ...p, derived: [entry({ ...GEN, argv: ['no-such-generator-r3'] })] }));
    const lane = regenerateLaneId(parsePlan(JSON.parse(readFileSync(a.planPath, 'utf8'))).derived![0]!);
    assert.match(lane, /^regenerate\.[0-9a-f]{12}$/);
    assert.deepEqual((await check(a)).rows, [{ kind: 'spec-lane-unrunnable', unit: null, lane, problem: { type: 'argv0-unresolvable', argv0: 'no-such-generator-r3' } }]);

    // The schema: a non-empty argv, a cwd and an env; the lane id is the entry's (reordering keeps it); no suite lane takes one.
    const base = JSON.parse(readFileSync(a.planPath, 'utf8')) as Json;
    assert.throws(() => parsePlan({ ...base, derived: [entry({ ...GEN, argv: [] })] }), /plan\.derived\[0\]\.regenerate\.argv/);
    assert.throws(() => parsePlan({ ...base, derived: [entry({ argv: ['node'] })] }), /plan\.derived\[0\]\.regenerate\.cwd/);
    const other = { sources: ['lib/**'], outputs: ['dist/lib.js'], regenerate: GEN };
    const ids = (derived: readonly Json[]) => parsePlan({ ...base, derived }).derived!.map(regenerateLaneId);
    assert.deepEqual(ids([entry(GEN), other]), [...ids([other, entry(GEN)])].reverse());
    const suite = base['suite'] as { lanes: Json[] };
    const taken = { ...(suite.lanes[0] ?? { argv: ['true'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] }), id: ids([entry(GEN)])[0] };
    assert.throws(() => parsePlan({ ...base, suite: { lanes: [...suite.lanes, taken] }, derived: [entry(GEN)] }), /plan\.suite\.lanes/);
  });
});
