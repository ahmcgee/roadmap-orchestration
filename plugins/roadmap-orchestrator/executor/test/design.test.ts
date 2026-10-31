
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
import { test } from 'node:test';
import type { Fact,StageOutcomeFact } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { editSpec } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, contextFor, gateStep, isGateCall, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';
import { readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
/** Admits every stage but `stop`: the unit's task ends there, held. */
const until = (stop: string): Gate => async (next) => next.stage !== stop;

const facts = (d: ArcDescriptor): readonly Fact[] => readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const outcomeOf = (d: ArcDescriptor, stage: string): StageOutcomeFact => {
  const f = facts(d).filter((x): x is StageOutcomeFact => (x.kind === 'stage-outcome' && 'unit' in x) && x.stage === stage).at(-1);
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

/** u1 with a second acceptance clause (so a split can partition its items) and u2 after it. */
function splitArc(steps: Parameters<typeof setupArc>[0]['steps']): ArcDescriptor {
  const d = setupArc({
    steps, units: [{ id: 'u1', systems: ['core', 'api'] }, { id: 'u2', after: ['u1'] }],
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
  unit, systems: [system], items, obligations: [],
  design: design({
    changes: [{ system, paths: [system === 'core' ? 'src/**' : 'contracts/**'], lines }], clauses: items.map((clause) => ({ clause, lanes: ['mul'] })),
    failureModes: proven ? [{ id: 'FM-1', mode: 'the seam breaks', proof: { type: 'test', test: { type: 'test', lane: 'e2e', testId: 'seam' } }, requirements: [] }] : [],
  }),
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
  editSpec(d, 'u1', (s) => { s['design'] = {kind: 'module', changes: [{system: null, paths: ['src/**'], lines: 10}], interfaces: [], failureModes: [], clauses: [{clause: 'A1', lanes: ['mul']}], breaks: {tests: [], docs: []}, experiments: []}; });
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
    assert.ok(gate !== undefined && gate.argv.includes('claude-opus-5-5') && gate.argv.includes('medium'), 'the contract touched put the gate on its escalation seat');
    const inputs = facts(d).find((f) => f.kind === 'judgment-inputs' && f.stage === 'gate');
    assert.ok(inputs?.kind === 'judgment-inputs' && inputs.designEstimate === 10, 'the gate records the design\'s size estimate');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});
