import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { unitId } from '../src/core/ids.ts';
import { parsePlan } from '../src/input/plan.ts';
import { standingRules } from '../src/pipeline/gate.ts';
import { planCheck, build } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { methodModules } from '../src/prompts/method/index.ts';
import { validateBuildOutput, validateGateOutput } from '../src/prompts/schemas.ts';
import { arcStack, resolveRouting, seatsInForce } from '../src/routing/layers.ts';
import { repin, seatTripleOf } from '../src/pipeline/dispatch.ts';
import { buildTriple } from '../src/pipeline/dispatch.ts';
import { reviewItems } from '../src/pipeline/surface.ts';
import { contextFor, setupArc, gateStep, mulBuild, appendSteps } from './fixtures/unit-common.ts';
import { BUILD_REPORT, admitAll } from './fixtures/stage-common.ts';
import { readCalls } from './helpers/scenario.ts';

const answer = {decision: 'approve' as const, ordering: null, findings: [], directives: [], reasons: ['Checked'], premises: [], standing: [], clusters: null, rulings: []};

test('surface.grounded-report: required grounding, split estimate, notes; retired report claims are refused', () => {
  assert.deepEqual(validateBuildOutput(BUILD_REPORT).grounding, {specWrong: null, touches: []});
  for (const field of ['changedPaths', 'docsOnlySince', 'lanesRun']) assert.throws(() => validateBuildOutput({...BUILD_REPORT, [field]: []}));
  const {grounding: _g, ...missing} = BUILD_REPORT;
  assert.throws(() => validateBuildOutput(missing));
  assert.throws(() => validateBuildOutput({...BUILD_REPORT, tooBig: {estimate: 'two days', suggestedChildren: []}}));
});

test('surface.modules: exact mechanical selections, testing always once, each module below 3 KB', () => {
  const base = {traits: [] as const, markers: [], unitKind: 'module', expensiveLanes: false, ui: false};
  const names = (s: string) => [...s.matchAll(/<method name="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(names(methodModules('build', base)), ['testing']);
  assert.deepEqual(names(methodModules('verifier', {...base, traits: ['persistent', 'redacts'], markers: ['M2'], ui: true, expensiveLanes: true})), ['testing', 'persistence', 'redaction', 'cluster-proof', 'ui', 'perf']);
  assert.deepEqual(names(methodModules('experience', base)), ['testing', 'ui']);
  for (const name of ['testing', 'persistence', 'redaction', 'cluster-proof', 'ui', 'perf']) assert.ok(Buffer.byteLength(readFileSync(new URL(`../src/prompts/method/${name}.ts`, import.meta.url))) <= 3072);
});

test('surface.standing: approval needs an evidence-backed response to every pre-build finding', () => {
  const items = [{id: 'pre:1', text: 'Crash loses the write', evidence: ['src/a.ts:3']}];
  assert.throws(() => standingRules(items)(validateGateOutput(answer)), /every pre-build finding/);
  for (const disposition of ['addressed', 'rebutted']) {
    const out = validateGateOutput({...answer, standing: [{id: 'pre:1', disposition, evidence: ['src/a.ts:8; restart test passed']}]});
    assert.equal(standingRules(items)(out).decision, 'approve');
  }
  assert.throws(() => validateGateOutput({...answer, standing: [{id: 'pre:1', disposition: 'rebutted', evidence: []}]}));
});

test('surface.no-marker: an ordinary unit builds and gates without a planning seat', {timeout: 120_000}, async () => {
  const d = setupArc({steps: [mulBuild(), gateStep({decision: 'approve'})]});
  const r = contextFor(d);
  try {
    await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired');
    const roles = r.journal.view.spawnsOfUnit(unitId('u1')).flatMap((i) => i.expect.subject.purpose === 'backend' ? [i.expect.subject.role] : []);
    assert.deepEqual(roles, ['build', 'verifier']);
    assert.deepEqual(r.journal.view.surfaceFacts(), []);
    assert.equal(readCalls(d.scenarioPath).length, 2);
  } finally {r.journal.close();}
});

test('surface.M1: review annotates even on revise, reaches the build and becomes a gate standing item', {timeout: 120_000}, async () => {
  const d = setupArc({systemsMap: {systems: {app: {paths: ['src/**', 'test/**', 'contracts/**', 'ARCHITECTURE.md'], traits: ['persistent']}}}, steps: [gateStep({decision: 'revise', directives: ['Check restart'], findings: [{severity: 'blocking', path: 'src/mul.js:1', text: 'Show restart evidence', contractRef: null, experiments: [], debt: null, defect: null, reraises: null, hunk: null}]})]});
  const r = contextFor(d);
  try {
    const checked = await planCheck(r.ctx, r.unit('u1'));
    assert.equal('kind' in checked ? checked.kind : checked.outcome.kind, 'approve');
    const items = reviewItems(r.journal.view, unitId('u1'));
    assert.equal(items.length, 1);
    assert.equal(buildTriple(r.ctx, unitId('u1'), 'med').backend, 'codex');
    appendSteps(d, [mulBuild(), gateStep({...answer, standing: [{id: items[0]!.id, disposition: 'addressed', evidence: ['test/mul.test.js:1']}]})]);
    await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired');
    assert.ok(readCalls(d.scenarioPath).some((c) => c.as === 'codex' && c.stdin.includes('Show restart evidence')));
    assert.deepEqual(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-triggered').map((f) => f.marker), ['M1']);
  } finally {r.journal.close();}
});

test('surface.profile-switch: claude-only to default is a routing revision after a build has started', {timeout: 120_000}, async () => {
  const d = setupArc({steps: [mulBuild()]});
  const r = contextFor(d);
  try {
    await planCheck(r.ctx, r.unit('u1'));
    const old = r.journal.view.dispatchOf(unitId('u1'))!;
    const claude = resolveRouting(arcStack('claude-only', null, null));
    const before = repin(r.journal, claude, old)!;
    const mixed = resolveRouting(arcStack('claude-only', null, {profile: 'default'}));
    const next = repin(r.journal, mixed, before)!;
    assert.notEqual(next.routingRev, before.routingRev);
    assert.equal(seatTripleOf(before.implementerSeatRev).backend, 'claude');
    assert.equal(seatTripleOf(next.implementerSeatRev).backend, 'codex');
    assert.ok(seatsInForce(mixed).every((s) => s.role === 'build' || s.role === 'verifier'));
    const raw = JSON.parse(readFileSync(d.planPath, 'utf8'));
    raw.routing = {profile: 'default'};
    assert.equal(parsePlan(raw).routing?.profile, 'default');
  } finally {r.journal.close();}
});
