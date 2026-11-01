
// Retained design validation over root-authored revisions, and design evidence consumed by the gate.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {unitId} from '../src/core/ids.ts';
import {splitCutReason} from '../src/input/classify.ts';
import { test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
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

/** A design record as the pre-build writes it, `over` its defaults (one small module change of src/**). */
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
    assert.deepEqual(outcomes(d), ['pre-build:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed-contract-touched', 'teardown:released', 'lanes:green', 'gate:approve']);
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

// The root supplies design records now. The same pin, reachability and clause checks remain independently covered.
import {pinDesign, designFaults, designSelects, clauseFaults, oversize, substantialSystems, mixedConcerns} from '../src/pipeline/design.ts';
import {integrationTip} from '../src/pipeline/stages.ts';
import type {DesignAnswer} from '../src/prompts/schemas.ts';
import {laneId, clauseId, systemName} from '../src/core/ids.ts';
import {repoPattern} from '../src/core/values.ts';
import {command, followContext} from './fixtures/route-common.ts';
import {applyBody} from './fixtures/unit-common.ts';

function pinnedDesign(r: ReturnType<typeof contextFor>, over: Readonly<Record<string, JsonValue>> = {}) {
  const result = pinDesign(r.ctx, design(over) as unknown as DesignAnswer, integrationTip(r.ctx));
  assert.equal(result.kind, 'pinned', JSON.stringify(result));
  if (result.kind !== 'pinned') throw new Error('design refused');
  return result.record;
}

test('design.record-lands: a root apply lands a pinned record and the spec preserves interface and broken-file blobs', T, async () => {
  const d = setupArc({steps: [], systemsMap: SYSTEMS}), r = contextFor(d);
  try {
    const record = pinnedDesign(r, {interfaces: [{type: 'contract', path: 'contracts/api.md'}, {type: 'file', path: 'src/add.js'}], breaks: {tests: ['test/add.test.js'], docs: ['ARCHITECTURE.md']}});
    assert.equal(record.interfaces.length, 2);
    assert.ok(record.interfaces.every((p) => /^[0-9a-f]{40}$/.test(p.blob)));
    assert.ok(record.breaks.tests[0]!.blob.length === 40 && record.breaks.docs[0]!.blob.length === 40);
    editSpec(d, 'u1', (spec) => {spec['rev'] = 2; spec['design'] = record;});
    const result = await command(r, r.ctx, applyBody(d));
    assert.equal(result.kind, 'applied', JSON.stringify(result));
    assert.deepEqual(loadUnitSpec(followContext(r), r.unit('u1')).spec.design, record);
  } finally {r.journal.close();}
});

test('design.pin-refusals: missing files, undeclared contracts, systems and requirements are refused together', () => {
  const d = setupArc({steps: [], systemsMap: SYSTEMS}), r = contextFor(d);
  try {
    const result = pinDesign(r.ctx, design({interfaces: [{type: 'contract', path: 'missing.md'}, {type: 'file', path: 'absent.ts'}], changes: [{system: 'unknown', paths: ['src/**'], lines: 1}], failureModes: [{id: 'FM-1', mode: 'unknown requirement', proof: {type: 'untested', reason: 'no rig'}, requirements: ['I-99']}]}) as unknown as DesignAnswer, integrationTip(r.ctx));
    assert.equal(result.kind, 'refused');
    if (result.kind !== 'refused') throw new Error('unexpected pin');
    for (const match of [/no plan contract/, /no file/, /no obligation/, /does not declare/]) assert.ok(result.reasons.some((s) => match.test(s)), result.reasons.join('; '));
  } finally {r.journal.close();}
});

test('design.reachability-defect: a proof lane excluded by systems is still a plan defect', () => {
  const d = twoClauseArc([]), r = contextFor(d);
  try {
    const spec = loadUnitSpec(r.ctx, r.unit('u1')).spec;
    const record = pinnedDesign(r, {changes: [{system: 'core', paths: ['src/**'], lines: 20}], failureModes: [{id: 'FM-1', mode: 'seam', requirements: [], proof: {type: 'test', test: {type: 'test', lane: 'api-suite', testId: 'seam'}}}], clauses: [{clause: 'A1', lanes: ['mul']}, {clause: 'A2', lanes: ['mul']}]});
    assert.match(designFaults(r.ctx, spec, record).defects.join('; '), /lists systems \(api\).*never select/);
    assert.equal(designSelects(d.config?.systemsMap ?? null, {systems: [systemName('api')]}, record.changes), false);
    assert.equal(designSelects(null, {systems: [systemName('api')]}, record.changes), true);
  } finally {r.journal.close();}
});

for (const mode of ['unnamed', 'unknown-clause', 'unknown-lane', 'unreachable', 'runnable'] as const) {
  test(`design.clause-${mode}: acceptance remains tied to runnable named lanes`, () => {
    const d = twoClauseArc([]), r = contextFor(d);
    try {
      const spec = loadUnitSpec(r.ctx, r.unit('u1')).spec, lane = spec.lanes[0]!;
      const lanes = new Map([[lane.id, lane]]);
      const record = {clauses: mode === 'unnamed' ? [] : [{clause: clauseId(mode === 'unknown-clause' ? 'A99' : 'A1'), lanes: [laneId(mode === 'unknown-lane' ? 'missing' : 'mul')]}, {clause: clauseId('A2'), lanes: [lane.id]}]};
      const faults = clauseFaults(spec, record, lanes, () => mode === 'unreachable' ? 'environment unavailable' : null);
      if (mode === 'runnable') assert.deepEqual(faults, {reasons: [], defects: []});
      if (mode === 'unnamed') {assert.equal(faults.defects.length, 2); assert.match(faults.defects.join('; '), /static harness witness.*split.*defer/);}
      if (mode === 'unknown-clause') assert.match(faults.reasons.join('; '), /no active acceptance clause/);
      if (mode === 'unknown-lane') assert.match(faults.reasons.join('; '), /no spec, suite or arc lane/);
      if (mode === 'unreachable') assert.match(faults.defects.join('; '), /environment unavailable/);
    } finally {r.journal.close();}
  });
}

test('design.split-sizing: substantial mixed concerns and oversized records remain root split signals', () => {
  const changes = [{system: systemName('core'), paths: [repoPattern('src/**')], lines: 300}, {system: systemName('api'), paths: [repoPattern('contracts/**')], lines: 300}];
  assert.deepEqual(substantialSystems(changes), ['api', 'core']);
  assert.equal(mixedConcerns(changes), true);
  assert.match(oversize({changes})!, /mixed concerns: split it/);
  assert.match(oversize({changes: [{...changes[0]!, lines: 100_000}]})!, /over the .*gate reads inline/);
  assert.equal(oversize({changes: [{...changes[0]!, lines: 10}]}), null);
});

test('design.unmapped-repair: an unknown proof lane remains a design validation reason', () => {
  const d = setupArc({steps: [], systemsMap: SYSTEMS}), r = contextFor(d);
  try {
    const record = pinnedDesign(r, {failureModes: [{id: 'FM-1', mode: 'the seam breaks', requirements: [], proof: {type: 'test', test: {type: 'test', lane: 'missing', testId: 'seam'}}}]});
    assert.match(designFaults(r.ctx, loadUnitSpec(r.ctx, r.unit('u1')).spec, record).reasons.join('; '), /failure mode FM-1 is unmapped.*no spec, suite or arc lane/);
  } finally {r.journal.close();}
});

test('design.oversize-split: a root apply cuts the mixed parent, partitions its items, pins children and rewires dependents', T, async () => {
  const d = splitArc([]), r = contextFor(d);
  try {
    const children = [unitId('u1-core'), unitId('u1-api')];
    const source = JSON.parse(readFileSync(join(d.planPath, '..', 'u1.json'), 'utf8')) as Record<string, unknown>;
    source['acceptance'] = [...source['acceptance'] as {id: string}[]];
    for (const [index, id] of children.entries()) {
      const clause = index === 0 ? 'A1' : 'A2';
      const record = pinnedDesign(r, {changes: [{system: index === 0 ? 'core' : 'api', paths: [index === 0 ? 'src/**' : 'contracts/**'], lines: 40}], clauses: [{clause, lanes: ['mul']}], interfaces: index === 0 ? [] : [{type: 'contract', path: 'contracts/api.md'}]});
      writeFileSync(join(d.planPath, '..', `${id}.json`), JSON.stringify({...source, unit: id, rev: 1, acceptance: (source['acceptance'] as {id: string}[]).filter((a) => a.id === clause), design: record}));
    }
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as {units: Record<string, unknown>[]};
    plan.units = [
      {...plan.units[0], cut: {reason: splitCutReason(children)}},
      {id: children[0], spec: `${children[0]}.json`, risk: 'med', systems: ['core'], resources: [], after: []},
      {id: children[1], spec: `${children[1]}.json`, risk: 'med', systems: ['api'], resources: [], after: [children[0]]},
      {...plan.units[1], after: children},
    ];
    writeFileSync(d.planPath, JSON.stringify(plan));
    const result = await command(r, r.ctx, applyBody(d));
    assert.equal(result.kind, 'applied', JSON.stringify(result));
    const ctx = followContext(r), units = ctx.plan().units;
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'cut');
    assert.deepEqual(units.find((u) => u.id === unitId('u2'))!.after, children);
    assert.deepEqual(units.find((u) => u.id === children[1])!.after, [children[0]]);
    const specs = children.map((id) => loadUnitSpec(ctx, units.find((u) => u.id === id)!).spec);
    assert.deepEqual(specs.map((s) => s.acceptance.map((a) => a.id)), [['A1'], ['A2']]);
    assert.equal(specs[1]!.design?.interfaces[0]?.type, 'contract');
    assert.ok(specs[1]!.design?.interfaces[0]?.blob.length === 40);
    assert.deepEqual(readCalls(d.scenarioPath), [], 'root decisions need no retired seat call');
  } finally {r.journal.close();}
});

test('design.clause-unexercised: root apply refuses an acceptance clause whose only lane cannot run before merge', T, async () => {
  const d = twoClauseArc([]), r = contextFor(d);
  try {
    const record = pinnedDesign(r, {changes: [{system: 'core', paths: ['src/**'], lines: 40}], clauses: [{clause: 'A1', lanes: ['mul']}, {clause: 'A2', lanes: ['api-suite']}]});
    editSpec(d, 'u1', (s) => {s['design'] = record;});
    const before = r.journal.view.planApplied()!.rev;
    const result = await command(r, r.ctx, applyBody(d));
    assert.equal(result.kind, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /acceptance clause A2.*no lane.*before the unit merges/);
    assert.match(JSON.stringify(result), /api-suite lists systems.*never select/);
    assert.match(JSON.stringify(result), /static harness witness.*split.*defer/);
    assert.equal(r.journal.view.planApplied()!.rev, before);
    assert.equal(r.journal.view.unit(unitId('u1')).counters.chargeableFailures, 0);
    assert.deepEqual(readCalls(d.scenarioPath), []);
  } finally {r.journal.close();}
});

test('split.revision-race: a root split exported before a concurrent plan revision refuses CAS and keeps the concurrent change', T, async () => {
  const d = splitArc([]), r = contextFor(d);
  try {
    const original = readFileSync(d.planPath, 'utf8');
    const initialStatus = r.journal.view.unit(unitId('u1')).status;
    const source = JSON.parse(readFileSync(join(d.planPath, '..', 'u1.json'), 'utf8'));
    const children = [unitId('u1-core'), unitId('u1-api')];
    for (const [index, id] of children.entries()) writeFileSync(join(d.planPath, '..', `${id}.json`), JSON.stringify({...source, unit: id, rev: 1, acceptance: source.acceptance.filter((a: {id: string}) => a.id === (index === 0 ? 'A1' : 'A2'))}));
    const split = JSON.parse(original);
    split.units = [{...split.units[0], cut: {reason: splitCutReason(children)}}, ...children.map((id) => ({id, spec: `${id}.json`, risk: 'med', systems: ['core'], resources: [], after: []})), {...split.units[1], after: children}];
    const splitBytes = JSON.stringify(split);
    writeFileSync(d.planPath, splitBytes);
    const stale = applyBody(d);
    const concurrent = JSON.parse(original);
    concurrent.units[0].priority = 'high';
    writeFileSync(d.planPath, JSON.stringify(concurrent));
    assert.equal((await command(r, r.ctx, applyBody(d))).kind, 'applied');
    const rev = r.journal.view.planApplied()!.rev;
    writeFileSync(d.planPath, splitBytes);
    const result = await command(r, followContext(r), stale);
    assert.equal(result.kind, 'rejected', JSON.stringify(result));
    assert.match(JSON.stringify(result), /stale.*plan|plan.*stale/);
    assert.equal(r.journal.view.planApplied()!.rev, rev);
    assert.equal(followContext(r).plan().units.find((u) => u.id === unitId('u1'))!.priority, 'high');
    assert.equal(r.journal.view.unit(unitId('u1')).status, initialStatus);
    assert.ok(!followContext(r).plan().units.some((u) => children.includes(u.id)));
    assert.deepEqual(readCalls(d.scenarioPath), []);
  } finally {r.journal.close();}
});
