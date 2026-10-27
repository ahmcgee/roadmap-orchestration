// The design pass (dev.17; DESIGN-1.0.md "Design pass"): the plan-check's design record and its code-checked binding,
// integrated and fake-backed over a unit-common arc (real git, real lanes, the fake claude and codex behind PATH shims).
//
// design.record-lands: an approve's design record lands on the spec's next revision, its interfaces and broken files pinned
//   at their blobs at the tip the check read, written by the plan-check's own spec patch; the build reads it in the spec.
// design.unmapped-repair: a failure mode proven by a lane the unit does not have is refused through the repair turn, which
//   names it; the corrected answer approves.
// design.reachability-defect: a test item in a lane whose systems the design never selects is a plan defect: the repair turn,
//   then an uncharged plan-defect park naming it.
// design.clause-unexercised (item 10): an acceptance clause whose only lane lists systems the design never selects (it
//   cannot run before the unit merges) is a plan defect naming the three fixes: the repair turn, then an uncharged park.
//   (A batch lane's and an unavailable environment's halves: environments.test.ts env.unavailable-to-arc and the shared
//   `cannotRun`.)
// design.clause-unnamed (item 10): a clause no witness item and no clauses entry names is refused through the repair turn;
//   the answer naming a runnable lane for it approves, the lanes landing in the record.
// design.oversize-split: an oversize design (two systems each substantial) is refused; the repair turn's split of mixed
//   concerns lands as one revision: the unit cut, its skeleton and module children added after it with their specs built
//   from its own (items partitioned, designs pinned), its dependent moved onto both children.
// design.split-defect: a split whose children do not partition the parent's items is refused twice: a plan-defect park.
// design.unscoped-growth: a design change outside the scope envelope is a verified scope-growth proposal: the hold.
// design.scaffold-not-in-force: a scaffold decision in an arc of an earlier role set is refused.
// design.poc: a PoC builds on the unit's builder seat in a throwaway checkout of the tip; its diff is kept as evidence, the
//   checkout removed and nothing merged; the next plan-check reads its report; past the unit's two a PoC is refused through
//   the repair turn; the build is told the lessons, never the code.
// design.departure-and-contract: the build changes an existing test the design does not list (a departure recorded among
//   the spec's decisions, never refused) and a contract it does not declare (the salvage's risk trigger, and the gate told
//   which contract); the gate's inputs record the design's size estimate.
// split.crash.*, poc.crash.*: the matrix rows DESIGN_SPLIT and POC_STAGE (test/matrix.ts).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact, StageOutcomeFact } from '../src/core/events.ts';
import type { JsonValue } from '../src/core/json.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { type Gate, consume, runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { designUnscoped } from '../src/pipeline/design.ts';
import { splitCutReason } from '../src/input/classify.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { SCENARIO_TIMEOUT_MS, planCheckRepairStep, planCheckStep } from './fixtures/stage-common.ts';
import { followingContext, unitInForce } from './fixtures/steer-common.ts';
import { editSpec } from './fixtures/route-common.ts';
import { type ArcDescriptor, MUL, U1, codexStep, contextFor, gateStep, isGateCall, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { recoveryContext } from './fixtures/rec-common.ts';
import { DESIGN_SPLIT, POC_STAGE, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
/** Admits every stage but `stop`: the unit's task ends there, held. */
const until = (stop: string): Gate => async (next) => next.stage !== stop;

const facts = (d: ArcDescriptor): readonly Fact[] => readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const outcomeOf = (d: ArcDescriptor, stage: string): StageOutcomeFact => {
  const f = facts(d).filter((x): x is StageOutcomeFact => x.kind === 'stage-outcome' && x.stage === stage).at(-1);
  if (f === undefined) throw new Error(`no ${stage} outcome`);
  return f;
};

/** A design record as the plan-check writes it, `over` its defaults (one small module change of src/**). */
const design = (over: Readonly<Record<string, JsonValue>> = {}): JsonValue => ({
  kind: 'module', changes: [{ system: null, paths: ['src/**'], lines: 40 }], interfaces: [], failureModes: [], clauses: [{ clause: 'A1', lanes: ['mul'] }], breaks: { tests: [], docs: [] }, experiments: [],
  newSystem: null, verification: null, ...over,
});

/** The systems map these arcs run under: two systems, their tests, and the docs class. */
const SYSTEMS = {
  systems: { core: { paths: ['src/**'], tests: ['test/**'] }, api: { paths: ['contracts/**'], tests: [] } },
  docs: ['*.md'],
};

test('design.record-lands: an approve lands its pinned design record on the spec\'s next revision, by the plan-check\'s own patch', T, async () => {
  const record = design({
    interfaces: [{ type: 'contract', path: 'contracts/api.md' }, { type: 'file', path: 'src/add.js' }],
    failureModes: [{ id: 'FM-1', mode: 'mul of a negative', proof: { type: 'test', test: { type: 'test', lane: 'mul', testId: 'mul' } }, requirements: [] }],
    breaks: { tests: ['test/add.test.js'], docs: [] },
    experiments: [{ command: 'node --test', output: 'ok 1' }],
  });
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve', design: record }), mulBuild()] });
  const r = contextFor(d);
  try {
    const held = await runUnit(r.ctx, r.unit('u1'), until('lanes'));
    assert.equal(held.kind, 'held', JSON.stringify(held));
    assert.deepEqual(outcomes(d), ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released']);
    const { spec } = loadUnitSpec(r.ctx, r.unit('u1'));
    assert.equal(spec.rev, 2);
    const tip = git(d.repo, 'rev-parse', 'main');
    assert.deepEqual(spec.design?.interfaces, [
      { type: 'contract', path: 'contracts/api.md', blob: git(d.repo, 'rev-parse', `${tip}:contracts/api.md`) },
      { type: 'file', path: 'src/add.js', blob: git(d.repo, 'rev-parse', `${tip}:src/add.js`) },
    ]);
    assert.deepEqual(spec.design?.breaks.tests, [{ type: 'file', path: 'test/add.test.js', blob: git(d.repo, 'rev-parse', `${tip}:test/add.test.js`) }]);
    assert.deepEqual(spec.design?.failureModes.map((m) => m.proof), [{ type: 'test', test: { type: 'test', lane: 'mul', testId: 'mul' } }]);
    const patches = intents(d.runDir, 'spec.patch');
    assert.equal(patches.length, 1);
    assert.ok(patches[0]!.kind === 'spec.patch' && patches[0]!.parent.type === 'stage' && patches[0]!.parent.stage === 'plan-check');
    assert.deepEqual(patches[0]!.kind === 'spec.patch' && patches[0]!.expect.patch.by.role, 'planCheck');
    // The plan-check acted (shell and web tools), and the build reads the record in its spec.
    const [check, built] = readCalls(d.scenarioPath);
    assert.ok(check !== undefined && built !== undefined);
    assert.equal(check.argv[check.argv.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash,Write,Edit,Agent,WebSearch,WebFetch');
    assert.ok(check.argv.includes('--disallowedTools'), 'its file-writing tools are denied the repository and the run dir');
    assert.match(built.stdin, /## Design[\s\S]*FM-1[\s\S]*mul of a negative/);
  } finally {
    r.journal.close();
  }
});

test('design.unmapped-repair: a failure mode proven by no lane the unit has is refused through the repair turn; the corrected answer approves', T, async () => {
  const bad = design({ failureModes: [{ id: 'FM-1', mode: 'overflow', proof: { type: 'test', test: { type: 'test', lane: 'nope', testId: 't' } }, requirements: [] }] });
  const good = design({ failureModes: [{ id: 'FM-1', mode: 'overflow', proof: { type: 'untested', reason: 'numbers are doubles here' }, requirements: [] }] });
  const d = setupArc({
    steps: [planCheckStep({ decision: 'approve', design: bad }), planCheckRepairStep({ decision: 'approve', design: good }, ['failure mode FM-1 is unmapped: test "t" of lane nope'])],
  });
  const r = contextFor(d);
  try {
    assert.equal((await runUnit(r.ctx, r.unit('u1'), until('build'))).kind, 'held');
    assert.deepEqual(outcomes(d), ['plan-check:approve']);
    assert.deepEqual(loadUnitSpec(r.ctx, r.unit('u1')).spec.design?.failureModes.map((m) => m.proof.type), ['untested']);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('design.reachability-defect: a test item in a lane the design\'s systems never select is a plan defect: the repair turn, then an uncharged park', T, async () => {
  const unreachable = design({
    changes: [{ system: 'core', paths: ['src/**'], lines: 40 }],
    failureModes: [{ id: 'FM-1', mode: 'the contract drifts', proof: { type: 'test', test: { type: 'test', lane: 'api-suite', testId: 'contract' } }, requirements: [] }],
  });
  const d = setupArc({
    steps: [planCheckStep({ decision: 'approve', design: unreachable }), planCheckRepairStep({ decision: 'approve', design: unreachable }, ['never select'])],
    suite: [{ id: 'suite', argv: ['node', '--test'] }, { id: 'api-suite', argv: ['node', '--test'], cadence: 'candidate', systems: ['api'] }],
    systemsMap: SYSTEMS,
  });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), until('build'));
    assert.ok(parked.kind === 'parked', JSON.stringify(parked));
    assert.equal(parked.needsUser.reason, 'plan-defect');
    assert.match(parked.needsUser.summary, /test "contract" of lane api-suite sits in lane api-suite, which lists systems \(api\) the design's changes never select/);
    assert.deepEqual(outcomes(d), ['plan-check:plan-defect']);
    const f = outcomeOf(d, 'plan-check');
    assert.deepEqual([f.class, f.chargeable, f.park], ['park', false, { class: 'operator', kind: 'env' }]);
    assert.ok(f.detail?.kind === 'design-defect' && f.detail.reasons.length === 1);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
    assert.equal(loadUnitSpec(r.ctx, r.unit('u1')).spec.rev, 1, 'nothing of the answer landed');
  } finally {
    r.journal.close();
  }
});

/** u1 with a second acceptance clause A2, under the systems map, and a candidate suite lane `api-suite` of system api. */
function twoClauseArc(steps: Parameters<typeof setupArc>[0]['steps']): ArcDescriptor {
  const d = setupArc({
    steps, suite: [{ id: 'suite', argv: ['node', '--test'] }, { id: 'api-suite', argv: ['node', '--test'], cadence: 'candidate', systems: ['api'] }], systemsMap: SYSTEMS,
  });
  editSpec(d, 'u1', (s) => {
    s['acceptance'] = [...(s['acceptance'] as unknown[]), { id: 'A2', clause: 'the scripts render the TLS copy with its ca.crt', failLoudIfUndelivered: true, state: 'active' }];
  });
  return d;
}

test('design.clause-unexercised: a clause exercised only by a lane that cannot run before the unit merges is a plan defect: the repair turn, then an uncharged park naming the fixes', T, async () => {
  const batchOnly = design({ changes: [{ system: 'core', paths: ['src/**'], lines: 40 }], clauses: [{ clause: 'A1', lanes: ['mul'] }, { clause: 'A2', lanes: ['api-suite'] }] });
  const d = twoClauseArc([planCheckStep({ decision: 'approve', design: batchOnly }), planCheckRepairStep({ decision: 'approve', design: batchOnly }, ['acceptance clause A2'])]);
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), until('build'));
    assert.ok(parked.kind === 'parked', JSON.stringify(parked));
    assert.equal(parked.needsUser.reason, 'plan-defect');
    assert.match(parked.needsUser.summary, /acceptance clause A2's behaviour is exercised by no lane that can run in this arc before the unit merges \(api-suite lists systems \(api\) the design's changes never select\)/);
    assert.match(parked.needsUser.summary, /static harness witness[\s\S]*split A2 into its own unit[\s\S]*defer/);
    assert.deepEqual(outcomes(d), ['plan-check:plan-defect']);
    const f = outcomeOf(d, 'plan-check');
    assert.ok(f.detail?.kind === 'design-defect' && f.detail.reasons.length === 1, JSON.stringify(f.detail));
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
  } finally {
    r.journal.close();
  }
});

test('design.clause-unnamed: a clause no lane is named for is refused through the repair turn; the answer naming a runnable lane approves', T, async () => {
  const unnamed = design();
  const named = design({ clauses: [{ clause: 'A1', lanes: ['mul'] }, { clause: 'A2', lanes: ['api-suite', 'suite'] }] });
  const d = twoClauseArc([planCheckStep({ decision: 'approve', design: unnamed }), planCheckRepairStep({ decision: 'approve', design: named }, ['acceptance clause A2\'s behaviour is exercised by no lane: name its lanes'])]);
  const r = contextFor(d);
  try {
    assert.equal((await runUnit(r.ctx, r.unit('u1'), until('build'))).kind, 'held');
    assert.deepEqual(outcomes(d), ['plan-check:approve']);
    assert.deepEqual(loadUnitSpec(r.ctx, r.unit('u1')).spec.design?.clauses, [{ clause: 'A1', lanes: ['mul'] }, { clause: 'A2', lanes: ['api-suite', 'suite'] }]);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

/** u1 with a second acceptance clause (so a split can partition its items) and u2 after it. */
function splitArc(steps: Parameters<typeof setupArc>[0]['steps']): ArcDescriptor {
  const d = setupArc({
    steps, units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    suite: [{ id: 'suite', argv: ['node', '--test'] }, { id: 'e2e', argv: ['node', '--test'], cadence: 'candidate' }],
    systemsMap: SYSTEMS,
  });
  editSpec(d, 'u1', (s) => {
    s['acceptance'] = [...(s['acceptance'] as unknown[]), { id: 'A2', clause: 'the contract names mul', failLoudIfUndelivered: true, state: 'active' }];
  });
  return d;
}

const MIXED = design({
  changes: [{ system: 'core', paths: ['src/**'], lines: 300 }, { system: 'api', paths: ['contracts/**'], lines: 300 }],
  clauses: [{ clause: 'A1', lanes: ['mul'] }, { clause: 'A2', lanes: ['mul'] }],
});
/** A child of u1's split taking `items`, changing `system` by `lines`. */
const child = (unit: string, items: readonly string[], system: 'core' | 'api', lines: number, proven = false): JsonValue => ({
  unit, scope: [system === 'core' ? 'src/**' : 'contracts/**'], items, obligations: [],
  design: design({
    changes: [{ system, paths: [system === 'core' ? 'src/**' : 'contracts/**'], lines }], clauses: items.map((clause) => ({ clause, lanes: ['mul'] })),
    failureModes: proven ? [{ id: 'FM-1', mode: 'the seam breaks', proof: { type: 'test', test: { type: 'test', lane: 'e2e', testId: 'seam' } }, requirements: [] }] : [],
  }),
});

test('design.oversize-split: an oversize design is refused; the split of mixed concerns lands as one revision, skeleton first, the dependent on both children', T, async () => {
  const split = { children: [child('u1-skel', ['A1'], 'core', 300, true), child('u1-api', ['A2'], 'api', 300)], edges: [{ from: 'u1-skel', to: 'u1-api' }], skeleton: { unit: 'u1-skel', lane: 'e2e' } };
  const d = splitArc([planCheckStep({ decision: 'approve', design: MIXED }), planCheckRepairStep({ decision: 'split', split }, ['oversize: the design changes api and core substantially'])]);
  const r = contextFor(d);
  try {
    const held = await runUnit(r.ctx, r.unit('u1'), until('build'));
    assert.deepEqual(held, { kind: 'held', needsUser: null });
    assert.deepEqual(outcomes(d), ['plan-check:split']);
    assert.deepEqual(outcomeOf(d, 'plan-check').detail, { kind: 'split', children: ['u1-skel', 'u1-api'] });
    const f = followingContext(r);
    const plan = f.plan();
    assert.deepEqual(plan.units.map((u) => u.id), ['u1', 'u1-skel', 'u1-api', 'u2'], 'the children after their parent, skeleton first');
    assert.deepEqual(unitInForce(f, 'u1').cut, { reason: splitCutReason([unitId('u1-skel'), unitId('u1-api')]) });
    assert.equal(r.journal.view.unit(U1).status, 'cut');
    assert.deepEqual(unitInForce(f, 'u1-api').after, ['u1-skel']);
    assert.deepEqual([...unitInForce(f, 'u2').after].sort(), ['u1-api', 'u1-skel'], 'the dependent waits on every child');
    const applied = r.journal.view.planApplied();
    assert.ok(applied?.source.type === 'split' && applied.source.unit === 'u1');
    const skel = loadUnitSpec(f, unitInForce(f, 'u1-skel')).spec;
    const api = loadUnitSpec(f, unitInForce(f, 'u1-api')).spec;
    assert.deepEqual([skel.rev, skel.acceptance.map((a) => a.id), api.acceptance.map((a) => a.id)], [1, ['A1'], ['A2']], 'the parent\'s items partitioned');
    assert.equal(api.acceptance[0]!.clause, 'the contract names mul', 'an item\'s text unchanged');
    assert.deepEqual([skel.scope, api.scope], [['src/**'], ['contracts/**']]);
    assert.deepEqual(skel.design?.failureModes.map((m) => m.id), ['FM-1'], 'each child carries its own pinned design');
    assert.equal(skel.forces, undefined, 'a candidate spanning lane needs no force');
  } finally {
    r.journal.close();
  }
});

test('design.split-defect: a split whose children do not partition the parent\'s items is refused twice: an uncharged plan-defect park', T, async () => {
  const split = { children: [child('u1a', ['A1'], 'core', 20), child('u1b', ['A1'], 'core', 20)], edges: [], skeleton: null };
  const d = splitArc([planCheckStep({ decision: 'split', split }), planCheckRepairStep({ decision: 'split', split }, ['the children take A1 more than once'])]);
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), until('build'));
    assert.ok(parked.kind === 'parked', JSON.stringify(parked));
    assert.equal(parked.needsUser.reason, 'plan-defect');
    assert.match(parked.needsUser.summary, /no child takes the parent's A2/);
    assert.deepEqual(outcomes(d), ['plan-check:plan-defect']);
    assert.deepEqual(followingContext(r).plan().units.map((u) => u.id), ['u1', 'u2'], 'no revision');
  } finally {
    r.journal.close();
  }
});

test('design.unscoped-growth: a design change outside the scope envelope is a verified scope-growth proposal, holding the unit', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve', design: design({ changes: [{ system: null, paths: ['ARCHITECTURE.md'], lines: 5 }] }) })] });
  const r = contextFor(d);
  try {
    const held = await runUnit(r.ctx, r.unit('u1'), until('build'));
    assert.ok(held.kind === 'held' && held.needsUser?.reason === 'scope-growth', JSON.stringify(held));
    assert.deepEqual(r.journal.view.unit(U1).interrupted?.detail, { kind: 'scope-growth', proposals: [{ patterns: ['ARCHITECTURE.md'], reason: 'the design record changes it' }] });
    assert.equal(loadUnitSpec(r.ctx, r.unit('u1')).spec.rev, 1, 'nothing of a growth answer lands');
  } finally {
    r.journal.close();
  }
});

test('design.scaffold-not-in-force: a scaffold decision in an arc of an earlier role set is refused through the repair turn', T, async () => {
  const scaffold: JsonValue = {
    newSystem: { name: 'billing', paths: ['src/billing/**'], tests: [] }, entryPoints: ['src/billing/index.js'], exports: [], loadTest: { lane: 'journey', testId: 't1' }, manifest: [],
  };
  const record = design({ changes: [{ system: null, paths: ['src/billing/**'], lines: 20 }], newSystem: { name: 'billing', paths: ['src/billing/**'], tests: [] } });
  const d = setupArc({
    steps: [planCheckStep({ decision: 'scaffold', design: record, scaffold }), planCheckRepairStep({ decision: 'approve' }, ['the scaffold role is not in force in this arc'])],
  });
  const r = contextFor(d);
  try {
    assert.equal((await runUnit(r.ctx, r.unit('u1'), until('build'))).kind, 'held');
    assert.deepEqual(outcomes(d), ['plan-check:approve']);
  } finally {
    r.journal.close();
  }
});

test('design.departure-and-contract: an unlisted test change is a departure recorded among the decisions; an undeclared contract change triggers and is named to the gate', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'test/add.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from '../src/add.js';\n\ntest('add', () => {\n  assert.equal(add(2, 3), 5);\n});\n", 'contracts/api.md': '# API contract\n\n`add(a, b)` returns the sum; `mul(a, b)` the product.\n' }),
      gateStep({ decision: 'approve' }, { stdinContains: ['<undeclared_contracts>', '- contracts/api.md'] }),
    ],
    systemsMap: SYSTEMS,
  });
  const r = contextFor(d);
  try {
    const held = await runUnit(r.ctx, r.unit('u1'), until('candidate'));
    assert.equal(held.kind, 'held', JSON.stringify(held));
    assert.deepEqual(outcomes(d), ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed-contract-touched', 'teardown:released', 'lanes:green', 'gate:approve']);
    const decisions = loadUnitSpec(r.ctx, r.unit('u1')).spec.decisions;
    assert.equal(decisions.length, 1);
    assert.match(decisions[0]!.id, /^departure\.[0-9a-f]{12}$/);
    assert.equal(decisions[0]!.text, 'Departure from the design record: the build changed the existing test test/add.test.js, which its breaks do not list.');
    const gate = readCalls(d.scenarioPath).find(isGateCall);
    assert.ok(gate !== undefined && gate.argv.includes('claude-opus-5-5') && gate.argv.includes('high'), 'the contract touched put the gate on its escalation seat');
    const inputs = facts(d).find((f) => f.kind === 'judgment-inputs' && f.stage === 'gate');
    assert.ok(inputs?.kind === 'judgment-inputs' && inputs.designEstimate === 10, 'the gate records the design\'s size estimate');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('design.poc: a PoC builds in a throwaway checkout, its report goes to a fresh plan-check, a third is refused, and the build gets the lessons', T, async () => {
  const poc = { questions: [{ id: 'PQ-1', question: 'Does mul overflow?', whyItMatters: 'decides the number type' }], brief: 'Multiply two large numbers.' };
  const answer = (n: number) => ({
    answers: [{ questionId: 'PQ-1', answer: `ANSWER-${n}`, evidence: `ran probe ${n}`, confidence: 'high' }], lessons: [`LESSON-${n}`], surprises: [],
  });
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'poc', poc }),
      {
        as: 'codex', expect: { argv: ['exec', '-C'], stdinContains: ['Multiply two large numbers.', 'PQ-1: Does mul overflow?'] },
        acts: [{ type: 'dirty', files: { 'src/probe.js': 'export const big = 2 ** 60 * 3;\n' } }, { type: 'emit', value: answer(1) }],
      },
      planCheckStep({ decision: 'poc', poc }, { stdinContains: ['<proofs_of_concept>', 'ANSWER-1', 'LESSON-1'] }),
      { as: 'codex', expect: { argv: ['exec', '-C'], stdinContains: ['<earlier_lessons>', 'LESSON-1'] }, acts: [{ type: 'emit', value: answer(2) }] },
      planCheckStep({ decision: 'poc', poc }, { stdinContains: ['proofs of concept left for this unit: 0', 'ANSWER-2'] }),
      planCheckRepairStep({ decision: 'approve' }, ['the unit has run its 2 proofs of concept']),
      codexStep([{ type: 'commit', message: 'add mul', files: MUL }], { argv: ['exec', '-C'], stdinContains: ["Lessons from this unit's proofs of concept", '- LESSON-1', '- LESSON-2'] }),
    ],
  });
  const r = contextFor(d);
  try {
    const held = await runUnit(r.ctx, r.unit('u1'), until('lanes'));
    assert.equal(held.kind, 'held', JSON.stringify(held));
    assert.deepEqual(outcomes(d), ['plan-check:poc', 'poc:answered', 'plan-check:poc', 'poc:answered', 'plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released']);
    assert.equal(r.journal.view.unit(U1).pocs, 2);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'a PoC is uncharged');
    assert.ok(!git(d.repo, 'worktree', 'list', '--porcelain').includes('.poc-'), 'every PoC checkout removed');
    const pocs = intents(d.runDir, 'worktree.create').filter((i) => i.parent.type === 'stage' && i.parent.stage === 'poc');
    assert.equal(pocs.length, 2);
    for (const i of pocs) assert.ok(i.kind === 'worktree.create' && i.expect.checkout.type === 'detached', 'a PoC checkout makes no branch');
    const first = pocs[0]!;
    assert.ok(first.parent.type === 'stage');
    const root = join(d.runDir, 'evidence', 'u1', `${first.parent.attempt}-poc`);
    assert.match(readFileSync(join(root, 'poc.diff'), 'utf8'), /src\/probe\.js/, 'the PoC diff kept as evidence');
    assert.ok(existsSync(join(root, 'poc-report.json')));
    assert.ok(!git(d.repo, 'ls-tree', '-r', '--name-only', 'main').includes('src/probe.js'), 'nothing of a PoC merges');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'every call matched its step');
  } finally {
    r.journal.close();
  }
});

describe(`matrix row ${DESIGN_SPLIT}`, () => {
  for (const { label } of crashCells(DESIGN_SPLIT)) {
    test(`split.crash.${label}: the restart lands the split once from the recorded answer, never asking again`, T, async () => {
      const split = { children: [child('u1-skel', ['A1'], 'core', 300, true), child('u1-api', ['A2'], 'api', 300)], edges: [{ from: 'u1-skel', to: 'u1-api' }], skeleton: { unit: 'u1-skel', lane: 'e2e' } };
      const d = splitArc([planCheckStep({ decision: 'approve', design: MIXED }), planCheckRepairStep({ decision: 'split', split })]);
      const trigger = writeTrigger(tmpDir('design-crash'), { label, occurrence: 1, unit: 'u1' });
      const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS });
      assert.equal(first.signal, 'SIGKILL', `killed at the label: ${first.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        await recover(recoveryContext(r));
        const s = await consume(r.ctx, r.unit('u1'));
        assert.deepEqual(s, label === 'split.after-hold' ? { kind: 'held', needsUser: null } : null, 'what the startup finishes');
        assert.equal(r.journal.view.unit(U1).status, 'cut');
        assert.deepEqual(followingContext(r).plan().units.map((u) => u.id), ['u1', 'u1-skel', 'u1-api', 'u2']);
        assert.equal(facts(d).filter((f) => f.kind === 'plan-applied' && f.source.type === 'split').length, 1, 'one split revision');
        assert.equal(readCalls(d.scenarioPath).length, 2, 'the plan-check was asked once, with its repair turn');
        assert.deepEqual(await consume(r.ctx, r.unit('u1')), null, 'nothing left to finish');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});

describe(`matrix row ${POC_STAGE}`, () => {
  for (const { label } of crashCells(POC_STAGE)) {
    test(`poc.crash.${label}: the next attempt records the PoC from its report; the builder is asked once, its checkout gone`, T, async () => {
      const poc = { questions: [{ id: 'PQ-1', question: 'Does mul overflow?', whyItMatters: 'decides the number type' }], brief: 'Multiply two large numbers.' };
      const report = { answers: [{ questionId: 'PQ-1', answer: 'ANSWER-1', evidence: 'ran it', confidence: 'medium' }], lessons: ['LESSON-1'], surprises: [] };
      const d = setupArc({
        steps: [
          planCheckStep({ decision: 'poc', poc }),
          { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'dirty', files: { 'src/probe.js': 'export const p = 1;\n' } }, { type: 'emit', value: report }] },
          planCheckStep({ decision: 'approve' }, { stdinContains: ['ANSWER-1'] }),
        ],
      });
      const trigger = writeTrigger(tmpDir('poc-crash'), { label, occurrence: 1, unit: 'u1' });
      const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS });
      assert.equal(first.signal, 'SIGKILL', `killed at the label: ${first.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        await recover(recoveryContext(r));
        assert.equal((await runUnit(r.ctx, r.unit('u1'), until('build'))).kind, 'held');
        assert.deepEqual(outcomes(d), ['plan-check:poc', 'poc:answered', 'plan-check:approve']);
        assert.equal(readCalls(d.scenarioPath).filter((c) => c.as === 'codex').length, 1, 'the builder was asked once');
        assert.ok(!git(d.repo, 'worktree', 'list', '--porcelain').includes('.poc-'), 'no PoC checkout left');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});


// Derived exclusion (2026-10-27; 1.0.0-dev.26): a broad design keeps the envelope's holes; a named output needs growth.
test('design.derived-exclusion: broad change patterns inherit exclusions, explicit generated paths stay outside', () => {
  const scope = { include: [repoPattern('apps/web/**')], exclude: [repoPattern('apps/web/test/fixtures/core-routes.json')] };
  const paths = [repoPattern('apps/web/**'), repoPattern('apps/web/test/fixtures/core-routes.json'), repoPattern('apps/core/src/routes.ts')];
  assert.deepEqual(designUnscoped([{ system: null, paths, lines: 10 }], scope), ['apps/core/src/routes.ts', 'apps/web/test/fixtures/core-routes.json']);
  assert.deepEqual(designUnscoped([{ system: null, paths, lines: 10 }], { ...scope, exclude: [repoPattern('apps/web/test/fixtures')] }), ['apps/core/src/routes.ts', 'apps/web/test/fixtures/core-routes.json'], 'a proposed pattern under a directory exclusion stays outside');
  const subtree = [{ system: null, paths: [repoPattern('apps/web/test/fixtures/**')], lines: 10 }];
  assert.deepEqual(designUnscoped(subtree, scope), [], 'a broader proposed pattern retains the individual output hole');
  assert.deepEqual(designUnscoped(subtree, { ...scope, exclude: [repoPattern('apps/web/test/fixtures/')] }), ['apps/web/test/fixtures/**'], 'a pattern beneath a directory output stays excluded');
  assert.deepEqual(designUnscoped([{ system: null, paths, lines: 10 }], { ...scope, exclude: [repoPattern('apps/web/test/fixtures/**')] }), ['apps/core/src/routes.ts', 'apps/web/test/fixtures/core-routes.json'], 'an output glob excludes a proposed file pattern');
});
