// dev.17 (experience-won E, propagation): over real arcs (real git, real processes, the fake backends and witness lanes),
// a requirement change after a test scenario was written leaves the scenario stale. Named tests:
// propagation.u1f (u1 merges I-1's scenario test; an apply moves I-1 to rev 2: the stale set names u1's merged witness file
// and in-flight u2's link; code mints one propagation unit whose scope is that file; u2 re-opens at plan-check, which is
// given the stale link and redirects (its patch pins every link at the revisions it read), then waits at its gate with u3,
// whose design record breaks the file, while unrelated u4 lands; both approve only after the propagation unit merged),
// propagation.stale-set (the computation over contracts, vision clauses, design records and pins), propagation.answers
// (the plan-check's stale-link check), and the crash cells of the matrix rows STALE_SET and PROPAGATION_REVISION.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type ObligationId, type UnitId, obligationId, sha, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { UNPINNED } from '../src/core/pins.ts';
import { type SpecM1, specM1 } from '../src/core/records.ts';
import type { StaleLinkAt } from '../src/holistic/staleset.ts';
import { propagationHolds, specLinksOf, staleAnswerReasons, staleSetOf } from '../src/holistic/staleset.ts';
import { applyPropagation } from '../src/holistic/propagation.ts';
import { type Obligations, type Vision, parseObligations, parseVision } from '../src/holistic/types.ts';
import { absPath, branchName, repoPath } from '../src/core/values.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { specFacts } from '../src/pipeline/reproduce.ts';
import { RESPEC_DIRECTIVE } from '../src/prompts/directives.ts';
import { recover } from '../src/recover/recover.ts';
import { admitter } from '../src/schedule/ready.ts';
import { holisticContexts } from '../src/schedule/scheduler.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls, type Step } from './helpers/scenario.ts';
import { moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { holisticArc, obligationsJson } from './fixtures/brake-common.ts';
import { fakeDocs } from './fixtures/docs-fake.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, applyBody, codexStep, commandContextFor, contextFor, gateStep, outcomes, stepUntil } from './fixtures/unit-common.ts';
import { unitInForce, walkContext } from './fixtures/walk-common.ts';
import { PROPAGATION_REVISION, STALE_SET, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS * 3 };
type Json = Record<string, unknown>;

const I1 = obligationId('I-1');
/** I-1's scenario test: the witness file u1 writes, and the file the propagation re-witnesses. */
const SCENARIO = 'test/i1.test.js';
const scenarioTest = (marker: string): string =>
  `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { one } from '../src/i1.js';\n\ntest('one', () => {\n  assert.equal(one(), 1, '${marker}');\n});\n`;
const U1_FILES = { 'src/i1.js': 'export function one() {\n  return 1;\n}\n', [SCENARIO]: scenarioTest('I-1 rev 1') };
const PROP = 'propagate-r2-i-1';
const U2_THREAD = '00000000-0000-4000-8000-00000000e2e2';

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const factsOf = <K extends Fact['kind']>(r: ArcRun, kind: K) => facts(r).filter((f): f is Extract<Fact, { kind: K }> => f.kind === kind);
const seqOf = (r: ArcRun, match: (f: Fact) => boolean): number =>
  readJournal(r.ctx.runDir, r.journal.view.arc).events.find((e) => e.type === 'fact' && match(e.fact))?.seq ?? -1;
const keyed = (unit: string, s: Step): Step => ({ ...s, unit });

/** u3's design record: it breaks I-1's scenario test (pinned at a blob from before the file existed). */
const U3_DESIGN = {
  kind: 'module', changes: [{ system: null, paths: ['src/**'], lines: 10 }], interfaces: [], failureModes: [],
  breaks: { tests: [{ type: 'file', path: SCENARIO, blob: '0'.repeat(40) }], docs: [] }, experiments: [],
};

/**
 * The arc: I-1 future (delivered by u1, witnessed by t1 on the fake journey lane, its scenario test declared), mapped only
 * under lib/ so no unit must declare it; u1 and u2 declare it, u3's design record breaks its scenario test, u4 is unrelated.
 * Every spec has no lane of its own (the plan's suite runs every test). `files`: committed onto the base before revision 1.
 */
function propagationArc(steps: readonly Step[], files: Readonly<Record<string, string>> = {}, more: readonly Json[] = []): ArcDescriptor {
  const { d } = holisticArc({
    steps,
    units: [{ id: 'u1', obligations: ['I-1'], lanes: [] }, { id: 'u2', obligations: ['I-1'], lanes: [] }, { id: 'u3', lanes: [] }, { id: 'u4', lanes: [] }],
    obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['t1'], files: [SCENARIO] }, ...more as never[]],
    mapping: [{ pattern: 'lib/**', obligations: ['I-1'] }],
    laneExtra: { journey: { testPaths: ['test/**'] } },
    trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
    beforeStart: (x) => {
      const spec = join(x.planPath, '..', 'u3.json');
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), design: U3_DESIGN }));
      if (Object.keys(files).length === 0) return;
      for (const [path, text] of Object.entries(files)) writeFileSync(join(x.repo, path), text);
      git(x.repo, 'add', '-A');
      git(x.repo, 'commit', '--quiet', '-m', 'the scenario test');
      const plan = JSON.parse(readFileSync(x.planPath, 'utf8')) as Json;
      writeFileSync(x.planPath, JSON.stringify({ ...plan, baseline: git(x.repo, 'rev-parse', 'main') }));
    },
  });
  return d;
}

/** The architect's requirement change: each of `ids` becomes must-hold at rev 2 (a normative change, no ruling needed). */
function moveToRev2(d: ArcDescriptor, ids: readonly string[]): void {
  const path = join(d.planPath, '..', 'obligations.json');
  const file = JSON.parse(readFileSync(path, 'utf8')) as Json & { obligations: (Json & { proofJudgment: Json })[] };
  writeFileSync(path, JSON.stringify({
    ...file,
    obligations: file.obligations.map((o) => (ids.includes(String(o['id']))
      ? { ...o, activation: 'must-hold', deliveredBy: o['id'] === 'I-1' ? [] : o['deliveredBy'], rev: 2, proofJudgment: { ...o.proofJudgment, obligationRev: 2 } }
      : o)),
  }));
}

/** Admission as the scheduler gives it, over the plan in force: the real admitter. */
const admitted = (r: ArcRun, w: ReturnType<typeof walkContext>['w'], id: string, stage: 'gate' | 'plan-check' = 'gate') =>
  admitter((u) => w.stage.routing(u).table, specFacts(w.stage))({
    view: r.journal.view, plan: requirePlanInForce(r.ctx.runDir, r.journal.view).plan, unit: unitInForce(r, id), stage,
    blocking: [], drains: [], tripped: [], pressure: { ticks: [], nowMs: 0 },
  });

/** A gate admitting what the admitter admits: a held gate admission ends the run there. */
const scheduled = (r: ArcRun, w: ReturnType<typeof walkContext>['w'], id: string): Gate => (next) =>
  Promise.resolve(next.kind === 'chain' || admitted(r, w, id, next.stage as 'gate').kind === 'admit');

async function run(r: ArcRun, w: ReturnType<typeof walkContext>['w'], id: string) {
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await runUnit(w.stage, unitInForce(r, id), scheduled(r, w, id));
  } finally {
    clearInterval(tick);
  }
}

async function ticking<X>(w: ReturnType<typeof walkContext>['w'], f: () => Promise<X>): Promise<X> {
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    return await f();
  } finally {
    clearInterval(tick);
  }
}

describe('propagation (dev.17, experience-won E)', () => {
  test('propagation.u1f: a requirement change after its scenario test merged leaves the scenario stale: the stale set names it, one propagation unit re-witnesses it, linked units answer at plan-check and approve only after it merged', T, async () => {
    const redirected = { op: 'add', section: 'facts', item: { id: 'F9', text: 'I-1 holds from rev 2 as a must-hold requirement.' } };
    const d = propagationArc([
      ...unitSteps('u1', U1_FILES),
      keyed('u2', planCheckStep({ decision: 'approve' })),
      { ...keyed('u2', codexStep([{ type: 'threadStarted' }, { type: 'commit', message: 'build u2', files: moduleFiles('two', '+') }], { argv: ['exec', '-C'] })), threadId: U2_THREAD } as Step,
      // The re-open after the change: the check is given u2's stale link, updates the spec and says so.
      keyed('u2', planCheckStep(
        { decision: 'redirect', patch: [redirected as never], staleLinks: [{ link: 'requirement:I-1', outcome: 'updated', reason: 'F9 states I-1 at rev 2' }] },
        { stdinContains: ['<stale_links>', 'requirement:I-1: the spec links requirement:I-1 (pinned nowhere', 'requirement I-1 moved from rev 1 to rev 2 at plan rev 2'] },
      )),
      keyed('u2', planCheckStep({ decision: 'approve' })),
      keyed('u2', codexStep([], { argv: ['exec', 'resume', U2_THREAD], stdinContains: [RESPEC_DIRECTIVE] })),
      ...unitSteps('u3', moduleFiles('three', '-')).slice(0, 2),
      ...unitSteps('u4', moduleFiles('four', '%')),
      ...unitSteps(PROP, { [SCENARIO]: scenarioTest('I-1 rev 2') }),
      keyed('u2', gateStep({ decision: 'approve' })),
      keyed('u3', gateStep({ decision: 'approve' })),
    ]);
    const r = contextFor(d);
    const { w } = walkContext(r);
    try {
      assert.deepEqual(await run(r, w, 'u1'), { kind: 'merged' }, outcomes(d, 'u1').join(' '));
      assert.equal(git(d.repo, 'show', `main:${SCENARIO}`), scenarioTest('I-1 rev 1').trimEnd(), 'u1 merged I-1\'s scenario test');
      await stepUntil(r, 'u2', (f) => f.stage === 'build' && f.outcome === 'success');

      // The architect moves I-1 to rev 2: the stale set, journaled with the revision.
      moveToRev2(d, ['I-1']);
      const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d)));
      assert.equal(out.kind, 'applied', JSON.stringify(out));
      const [set] = factsOf(r, 'stale-set');
      assert.ok(set !== undefined, 'the apply recorded a stale set');
      assert.deepEqual([set.rev, set.targets], [2, [{ type: 'requirement', id: 'I-1', from: 1, to: 2 }]]);
      assert.deepEqual(set.links, [
        { type: 'spec', unit: 'u2', target: { type: 'requirement', id: 'I-1' }, pinned: UNPINNED, cause: { type: 'requirement', id: 'I-1' } },
        { type: 'witness', obligation: 'I-1', files: [SCENARIO], cause: { type: 'requirement', id: 'I-1' } },
      ], 'u2 (in flight) links I-1; merged u1 is no unit link, its scenario test is the merged artifact');
      assert.ok(seqOf(r, (f) => f.kind === 'plan-applied' && f.rev === 2) < seqOf(r, (f) => f.kind === 'stale-set'));
      assert.equal(r.journal.view.unit(unitId('u2')).staleRev, 2);

      // Code mints the propagation unit: milestone-exempt origin, its scope the stale file, its spec pinned at rev 2.
      const h = holisticContexts(w).checkpoint;
      assert.deepEqual(await ticking(w, () => applyPropagation(h)), { kind: 'applied', minted: [PROP], refused: [] });
      assert.deepEqual(await ticking(w, () => applyPropagation(h)), { kind: 'none' }, 'the stale set is settled');
      const prop = unitInForce(r, PROP);
      assert.deepEqual([prop.origin, prop.propagation, [...prop.scope], prop.after, prop.risk], [
        'propagation', { rev: 2, target: { type: 'requirement', id: 'I-1', rev: 2 } }, [SCENARIO], [], 'med',
      ]);
      assert.deepEqual(factsOf(r, 'plan-applied').at(-1)!.source, { type: 'propagation', rev: 2 });
      const propSpec = loadUnitSpec(r.ctx, prop).spec;
      assert.deepEqual([propSpec.obligations, propSpec.pins, propSpec.lanes], [[I1], [{ type: 'requirement', id: 'I-1', rev: 2 }], []]);
      assert.match(propSpec.facts.map((f) => f.text).join('\n'), /Requirement I-1 changed at plan rev 2: from rev 1 \("I-1 holds\."\) to rev 2/);

      // The code edges: u2 links I-1, u3's design breaks the stale file; u4 is neither.
      const target = { type: 'requirement', id: 'I-1', rev: 2 };
      assert.deepEqual(admitted(r, w, 'u2'), { kind: 'wait', constraints: [{ type: 'propagation', unit: PROP, target, stale: [] }] });
      assert.deepEqual(admitted(r, w, 'u3'), { kind: 'wait', constraints: [{ type: 'propagation', unit: PROP, target, stale: [SCENARIO] }] });
      assert.deepEqual(admitted(r, w, 'u4'), { kind: 'admit' });
      assert.deepEqual(admitted(r, w, PROP), { kind: 'admit' }, 'a propagation unit never waits on one');
      assert.deepEqual(admitted(r, w, 'u2', 'plan-check'), { kind: 'admit' }, 'the edge holds the gate only');

      // u2, in flight past its plan-check, re-opens there; the check redirects (pinning every link), then approves; it
      // builds on its session and waits at its gate.
      assert.deepEqual(await run(r, w, 'u2'), { kind: 'held', needsUser: null });
      assert.deepEqual(factsOf(r, 'stale-reopened').map((f) => [f.unit, f.rev]), [['u2', 2]]);
      // Answered at the plan rev the check read: rev 3, the propagation revision's, which landed after the stale set's.
      assert.deepEqual(factsOf(r, 'stale-answered').map((f) => [f.unit, f.rev, f.answers]), [['u2', 3, [{ link: 'requirement:I-1', outcome: 'updated', reason: 'F9 states I-1 at rev 2' }]]]);
      assert.equal(r.journal.view.unit(unitId('u2')).staleRev, null, 'answered');
      const u2Spec = loadUnitSpec(r.ctx, unitInForce(r, 'u2')).spec;
      const apiBlob = sha(git(d.repo, 'rev-parse', `${factsOf(r, 'judgment-inputs').filter((f) => f.unit === 'u2' && f.stage === 'plan-check').at(-2)!.tip}:contracts/api.md`));
      assert.deepEqual(u2Spec.pins, [{ type: 'requirement', id: 'I-1', rev: 2 }, { type: 'contract', path: 'contracts/api.md', blob: apiBlob }], 'the redirect pinned every link at what it read');
      assert.deepEqual(outcomes(d, 'u2').filter((o) => o.startsWith('plan-check')), ['plan-check:approve', 'plan-check:redirect', 'plan-check:approve']);
      assert.equal(r.journal.view.unit(unitId('u2')).decided?.stage, 'lanes');

      // u3 waits at its gate too; u4 lands meanwhile.
      assert.deepEqual(await run(r, w, 'u3'), { kind: 'held', needsUser: null });
      assert.equal(r.journal.view.unit(unitId('u3')).decided?.stage, 'lanes');
      assert.deepEqual(await run(r, w, 'u4'), { kind: 'merged' }, outcomes(d, 'u4').join(' '));

      // The propagation unit re-witnesses I-1 at rev 2 and merges; then u2 and u3 approve and land.
      assert.deepEqual(await run(r, w, PROP), { kind: 'merged' }, outcomes(d, PROP).join(' '));
      assert.equal(git(d.repo, 'show', `main:${SCENARIO}`), scenarioTest('I-1 rev 2').trimEnd());
      assert.deepEqual(r.journal.view.unit(unitId(PROP)).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 2 }], 'its candidate grades I-1 at rev 2');
      assert.deepEqual(admitted(r, w, 'u2'), { kind: 'admit' });
      assert.deepEqual(await run(r, w, 'u2'), { kind: 'merged' }, outcomes(d, 'u2').join(' '));
      assert.deepEqual(await run(r, w, 'u3'), { kind: 'merged' }, outcomes(d, 'u3').join(' '));
      const propLanded = seqOf(r, (f) => f.kind === 'stage-outcome' && f.unit === PROP && f.stage === 'ff');
      for (const u of ['u2', 'u3']) assert.ok(seqOf(r, (f) => f.kind === 'approval' && f.unit === u) > propLanded, `${u} approved after ${PROP} merged`);
      assert.ok(seqOf(r, (f) => f.kind === 'approval' && f.unit === 'u4') < propLanded, 'u4 was never held');
      assert.deepEqual(r.journal.view.openIntents(), []);
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.step === null), [], 'every backend call matched its step');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The computation (pure)

const ob = (id: string, rev: number, extra: Json = {}): Json => ({
  id, rev, statement: `${id} holds.`, docRef: { path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module' }, serves: ['V-1'],
  witness: { lane: 'journey', testIds: ['t1'], files: [`test/${id.toLowerCase()}.test.js`] },
  proofJudgment: { verdict: 'proves', obligationRev: rev, laneRev: '0123456789abcdef', witness: { lane: 'journey', testIds: ['t1'], files: [`test/${id.toLowerCase()}.test.js`] } },
  deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' }, ...extra,
});
const obligationsOf = (list: readonly Json[]): Obligations => parseObligations({
  schema: 'roadmap/obligations-m3', cutLine: 'x', mapping: { paths: [] }, obligations: list,
  lanes: [{ id: 'journey', argv: ['node'], cwd: '.', env: { set: {}, pass: [] }, expectedExit: 0, cadence: 'candidate', resources: [], evidenceGlobs: [], reporter: 'jsonl' }],
});
const visionOf = (rev: number, v1: string): Vision => parseVision({
  schema: 'roadmap/vision-m3', rev, confirmation: null, questions: [],
  clauses: [{ id: 'V-1', kind: 'world', text: v1, rank: null, state: 'active' }, { id: 'V-2', kind: 'purpose', text: 'Exact arithmetic.', rank: null, state: 'active' }],
});
const specOf = (unit: string, extra: Json = {}): SpecM1 => specM1({
  schema: 'roadmap/spec-m1', unit, rev: 1, lanes: [], acceptance: [{ id: 'A1', clause: 'x', failLoudIfUndelivered: true, state: 'active' }], scope: ['src/**'],
  resources: [], decisions: [], facts: [], cites: { contracts: ['docs/api.md'], rulings: [] }, ...extra,
}, 'spec');
const BLOB = 'a'.repeat(40);

describe('the stale set (src/holistic/staleset.ts)', () => {
  test('propagation.stale-set: requirements whose rev rose, rewritten contracts and edited vision clauses, followed through obligations, specs, design records and witnesses; a link pinned at the new rev is fresh', () => {
    const before = obligationsOf([ob('I-1', 1), ob('I-2', 1, { serves: ['V-2'] }), ob('I-3', 1, { contracts: ['docs/api.md'] })]);
    const after = obligationsOf([ob('I-1', 2), ob('I-2', 1, { serves: ['V-2'] }), ob('I-3', 1, { contracts: ['docs/api.md'] })]);
    const design = {
      kind: 'module', changes: [{ system: null, paths: ['src/**'], lines: 1 }], experiments: [], breaks: { tests: [], docs: [] },
      interfaces: [{ type: 'contract', path: 'docs/api.md', blob: BLOB }],
      failureModes: [{ id: 'FM-1', mode: 'off by one', proof: { type: 'untested', reason: 'r' }, requirements: [{ type: 'requirement', id: 'I-1', rev: 1 }] }],
    };
    const set = staleSetOf({
      obligations: { before, after },
      vision: { before: visionOf(1, 'Helpers anyone can trust.'), after: visionOf(2, 'Helpers anyone can trust.') },
      contracts: [repoPath('docs/api.md')],
      units: () => [
        { id: unitId('ua'), spec: specOf('ua', { obligations: ['I-1', 'I-2'], design }) },
        { id: unitId('ub'), spec: specOf('ub', { obligations: ['I-1'], pins: [{ type: 'requirement', id: 'I-1', rev: 2 }, { type: 'contract', path: 'docs/api.md', blob: BLOB }] }) },
      ],
    });
    assert.ok(set !== null);
    assert.deepEqual(set.targets, [{ type: 'requirement', id: 'I-1', from: 1, to: 2 }, { type: 'contract', path: 'docs/api.md' }], 'the vision is unchanged but for its rev: no clause target');
    assert.deepEqual(set.links.map((l) => [l.type, 'unit' in l ? l.unit : l.obligation, l.cause]), [
      ['spec', 'ua', { type: 'requirement', id: 'I-1' }],
      ['spec', 'ua', { type: 'contract', path: 'docs/api.md' }],
      ['failure-mode', 'ua', { type: 'requirement', id: 'I-1' }],
      ['interface', 'ua', { type: 'contract', path: 'docs/api.md' }],
      // ub pins I-1 at rev 2: fresh; its contract pin is stale (the contract changed after it).
      ['spec', 'ub', { type: 'contract', path: 'docs/api.md' }],
      ['witness', 'I-1', { type: 'requirement', id: 'I-1' }],
      ['witness', 'I-3', { type: 'contract', path: 'docs/api.md' }],
    ]);

    // A vision edit of V-2 reaches I-2 (serving it, not revised): its own link, and ua's link to it.
    const viaVision = staleSetOf({
      obligations: { before: after, after }, vision: { before: visionOf(1, 'x'), after: parseVision({ ...JSON.parse(JSON.stringify(visionOf(2, 'x'))), clauses: [{ id: 'V-1', kind: 'world', text: 'x', rank: null, state: 'active' }, { id: 'V-2', kind: 'purpose', text: 'Exact, rounded half to even.', rank: null, state: 'active' }] }) },
      contracts: [], units: () => [{ id: unitId('ua'), spec: specOf('ua', { obligations: ['I-1', 'I-2'] }) }],
    });
    assert.deepEqual(viaVision, {
      targets: [{ type: 'vision-clause', id: 'V-2', visionRev: 2 }],
      links: [
        { type: 'obligation', obligation: 'I-2', cause: { type: 'vision-clause', id: 'V-2' } },
        { type: 'spec', unit: 'ua', target: { type: 'requirement', id: 'I-2' }, pinned: UNPINNED, cause: { type: 'vision-clause', id: 'V-2' } },
      ],
    });
    assert.equal(staleSetOf({ obligations: { before: after, after }, vision: { before: null, after: null }, contracts: [], units: () => { throw new Error('read with no target'); } }), null);
  });

  test('propagation.answers: an approve or redirect answers each stale link once by its key; only a redirect updates; links read for a held edge only when a propagation is pending', () => {
    const link = (unit: string, id: string): StaleLinkAt => ({
      rev: 2 as never, target: { type: 'requirement', id: id as ObligationId, from: 1, to: 2 },
      link: { type: 'spec', unit: unit as UnitId, target: { type: 'requirement', id: id as ObligationId }, pinned: UNPINNED, cause: { type: 'requirement', id: id as ObligationId } },
    });
    const links = [link('ua', 'I-1'), link('ua', 'I-2')];
    const a = (l: string, outcome: 'updated' | 'confirmed' = 'confirmed') => ({ link: l, outcome, reason: 'checked' });
    assert.deepEqual(staleAnswerReasons(links, [a('requirement:I-1'), a('requirement:I-2')], 'approve'), []);
    assert.deepEqual(staleAnswerReasons(links, [a('requirement:I-1', 'updated'), a('requirement:I-2')], 'redirect'), []);
    assert.deepEqual(staleAnswerReasons(links, [], 'escalate'), [], 'an escalation settles nothing, so it answers nothing');
    const refused = staleAnswerReasons(links, [a('requirement:I-1', 'updated'), a('requirement:I-1'), a('requirement:I-9')], 'approve');
    assert.equal(refused.length, 4, refused.join(' | '));
    assert.match(refused.join(' | '), /answers requirement:I-1 updated, but the decision is approve/);
    assert.match(refused.join(' | '), /answers requirement:I-1 twice/);
    assert.match(refused.join(' | '), /requirement:I-9, which is no stale link/);
    assert.match(refused.join(' | '), /leaves requirement:I-2 unanswered/);
    const view = { propagationFacts: () => [], unit: () => { throw new Error('no propagation unit to look up'); } } as never;
    const plan = { units: [] } as never;
    assert.deepEqual(propagationHolds(view, plan, { id: unitId('ua') } as never, () => { throw new Error('links read with no propagation pending'); }), []);
    assert.deepEqual(specLinksOf(specOf('ua', { obligations: ['I-1'] })).breaks, []);
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash cells

describe(`matrix row ${STALE_SET}`, () => {
  for (const { label } of crashCells(STALE_SET)) {
    test(`propagation.crash.${label}: the recovered revision appends its stale set once`, T, async () => {
      const d = propagationArc([]);
      const setup = contextFor(d);
      let id: string;
      try {
        moveToRev2(d, ['I-1']);
        id = submitCommand(setup.ctx.runDir, setup.journal.view.arc, applyBody(d)).id;
      } finally {
        setup.journal.close();
      }
      const trigger = writeTrigger(tmpDir('stale-crash'), { label, occurrence: 1 });
      const exit = await runFixture('revision-child.ts', [JSON.stringify(d), id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        assert.deepEqual(factsOf(r, 'stale-set').length, label === 'propagation.after-stale-set' ? 1 : 0, 'what the crash left');
        await recover({ stage: r.ctx, commands: { ...commandContextFor(r), docs: fakeDocs(r.journal, absPath(d.repo), branchName('main')) } });
        assert.deepEqual(r.journal.view.openIntents(), []);
        assert.equal(terminalReceipt(r.ctx.runDir, id as never)?.state, 'applied');
        assert.deepEqual(factsOf(r, 'plan-applied').map((f) => f.rev), [1, 2]);
        const sets = factsOf(r, 'stale-set');
        assert.deepEqual(sets.map((s) => [s.rev, s.targets, s.links.map((l) => l.type)]), [[2, [{ type: 'requirement', id: 'I-1', from: 1, to: 2 }], ['spec', 'spec', 'witness']]]);
        assert.ok(seqOf(r, (f) => f.kind === 'plan-applied' && f.rev === 2) < seqOf(r, (f) => f.kind === 'stale-set'));
      } finally {
        r.journal.close();
      }
    });
  }
});

describe(`matrix row ${PROPAGATION_REVISION}`, () => {
  for (const { label } of crashCells(PROPAGATION_REVISION)) {
    test(`propagation.crash.${label}: the resumed propagation revision settles each propagation once`, T, async () => {
      // I-1's scenario test is on the base (merged); I-2's is not (nothing merged to re-witness): I-2 is refused, I-1 minted.
      const d = propagationArc([], { [SCENARIO]: scenarioTest('I-1 rev 1'), 'src/i1.js': U1_FILES['src/i1.js'] }, [
        { id: 'I-2', activation: 'future', deliveredBy: ['u1'], testIds: ['t2'], files: ['test/i2.test.js'] },
      ]);
      const setup = contextFor(d);
      try {
        const { w } = walkContext(setup);
        moveToRev2(d, ['I-1', 'I-2']);
        const out = await applyCommand(w.commands, submitCommand(setup.ctx.runDir, setup.journal.view.arc, applyBody(d)));
        assert.equal(out.kind, 'applied', JSON.stringify(out));
      } finally {
        setup.journal.close();
      }
      const trigger = writeTrigger(tmpDir('propagation-crash'), { label, occurrence: 1 });
      const exit = await runFixture('propagation-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        const { w } = walkContext(r);
        await recover({ stage: w.stage, commands: w.commands });
        const again = await ticking(w, () => applyPropagation(holisticContexts(w).checkpoint));
        if (label === 'propagation.after-revision') assert.deepEqual(again, { kind: 'none' });
        else assert.deepEqual(again, { kind: 'applied', minted: [PROP], refused: [] });
        assert.deepEqual(factsOf(r, 'propagation-refused').map((f) => [f.rev, f.target]), [[2, { type: 'requirement', id: 'I-2', rev: 2 }]]);
        assert.match(factsOf(r, 'propagation-refused')[0]!.reasons.join(' '), /none of its witness files \(test\/i2\.test\.js\) is at the integration tip/);
        assert.deepEqual(factsOf(r, 'plan-applied').filter((f) => f.source.type === 'propagation').map((f) => f.source), [{ type: 'propagation', rev: 2 }]);
        assert.equal(unitInForce(r, PROP).origin, 'propagation');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});

