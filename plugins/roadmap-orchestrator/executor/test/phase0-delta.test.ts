// Command-center plan §9: runtime coverage of refusing rows and the two missing proof advisories.
// Retained coverage: phase0.test.ts (schema/plan-invalid, tree, chain), foreign-baseline.test.ts
// (corpus drift), revision.test.ts startup.obligation-dropped, system-scope.test.ts overlap,
// milestones-plan.test.ts milestone-unit-before-design. vision-leak and scope-references-outside
// were already retired with their implementations by P1/P2; §9 requires they stay absent.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, corpusArc, editJsonFile, editPlan, WITNESS_FILE } from './helpers/corpusarc.ts';

test('phase0 §9: schema and plan-invalid refuse malformed authored inputs', async () => {
  const a = await corpusArc();
  editPlan(a, (p) => ({...p, baseline: 'not-a-sha'}));
  assert.match(JSON.stringify((await check(a)).rows), /plan-invalid.*schema/);
});

for (const field of ['intent', 'nonGoals']) test(`phase0 §9: missing ${field} refuses the spec`, async () => {
  const a = await corpusArc();
  editJsonFile(join(a.planDir, 'u1.json'), (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== field)));
  const report = await check(a);
  assert.match(JSON.stringify(report.rows), new RegExp(`plan-invalid.*${field}`));
});

test('phase0 §9: missing lane cwd refuses the lane schema', async () => {
  const a = await corpusArc();
  editJsonFile(join(a.planDir, 'u1.json'), (s) => ({...s, lanes: (s['lanes'] as Record<string, unknown>[]).map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'cwd')))}));
  assert.match(JSON.stringify((await check(a)).rows), /plan-invalid.*cwd/);
});

test('phase0 §9: existing future witness files advise possible vacuity without refusing', async () => {
  const a = await corpusArc({activation: 'future'});
  const report = await check(a);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.advisories, [{kind: 'vacuous-future-witness', obligation: 'I-1', files: [WITNESS_FILE]}]);
  editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({...o, obligations: (o['obligations'] as Record<string, unknown>[]).map((x) => ({...x, activation: 'must-hold'}))}));
  assert.deepEqual((await check(a)).advisories, [], 'an existing must-hold witness is expected');
});

test('phase0 §9: multi-unit delivery needs a spanning proof advisory until its candidate lane spans the systems', async () => {
  const a = await corpusArc({activation: 'future'});
  const spec = JSON.parse(readFileSync(join(a.planDir, 'u1.json'), 'utf8'));
  writeFileSync(join(a.planDir, 'u2.json'), JSON.stringify({...spec, unit: 'u2'}));
  editPlan(a, (p) => ({...p, units: [...p['units'] as object[], {...(p['units'] as object[])[0], id: 'u2', spec: 'u2.json'}]}));
  editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({...o, obligations: (o['obligations'] as Record<string, unknown>[]).map((x) => ({...x, deliveredBy: ['u1', 'u2']}))}));
  const report = await check(a);
  assert.deepEqual(report.rows, []);
  assert.ok(report.advisories.some((r) => r.kind === 'spanning-proof' && r.obligation === 'I-1' && r.lane === 'journey' && r.units.join(',') === 'u1,u2'));
  editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({...o, lanes: (o['lanes'] as object[]).map((l) => ({...l, cadence: 'candidate', systems: ['tests']}))}));
  assert.ok((await check(a)).advisories.some((r) => r.kind === 'spanning-proof'), 'a candidate lane limited to another system still cannot span delivery');
  editJsonFile(join(a.planDir, 'obligations.json'), (o) => ({...o, lanes: (o['lanes'] as object[]).map((l) => ({...l, systems: ['app']}))}));
  const covered = await check(a);
  assert.deepEqual(covered.rows, []);
  assert.ok(!covered.advisories.some((r) => r.kind === 'spanning-proof'));
});
