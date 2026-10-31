import { editPlan } from './fixtures/route-common.ts';
import { MUL } from './fixtures/unit-common.ts';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { unitId } from '../src/core/ids.ts';
import { standingRules } from '../src/pipeline/gate.ts';
import { planCheck, build } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { methodModules } from '../src/prompts/method/index.ts';
import { validateBuildOutput, validateGateOutput } from '../src/prompts/schemas.ts';
import { seatTripleOf } from '../src/pipeline/dispatch.ts';
import { buildTriple } from '../src/pipeline/dispatch.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { diagnosisDue, reviewItems } from '../src/pipeline/surface.ts';
import { contextFor, setupArc, gateStep, mulBuild, appendSteps, stepUntil, syncInputs, commandContextFor, applyBody } from './fixtures/unit-common.ts';
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
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired', JSON.stringify(r.journal.view.unit(unitId('u1')).decided));
    const roles = r.journal.view.spawnsOfUnit(unitId('u1')).flatMap((i) => i.expect.subject.purpose === 'backend' ? [i.expect.subject.role] : []);
    assert.deepEqual(roles, ['build', 'verifier']);
    assert.deepEqual(r.journal.view.surfaceFacts(), []);
    assert.equal(readCalls(d.scenarioPath).length, 2);
  } finally {r.journal.close();}
});

test('surface.M1: review annotates even on revise, reaches the build and becomes a gate standing item', {timeout: 120_000}, async () => {
  const d = setupArc({systemsMap: {systems: {app: {paths: ['src/**', 'test/**', 'contracts/**', 'ARCHITECTURE.md'], traits: ['persistent']}}}, steps: [gateStep({decision: 'revise', directives: ['Check restart'], findings: [{evidence: ["src/mul.js:1:1"], severity: 'blocking', path: 'src/mul.js:1', text: 'Show restart evidence', contractRef: null, experiments: [], debt: null, defect: null, reraises: null, hunk: null}]})]});
  const r = contextFor(d);
  try {
    const checked = await planCheck(r.ctx, r.unit('u1'));
    assert.equal('kind' in checked ? checked.kind : checked.outcome.kind, 'approve');
    const items = reviewItems(r.journal.view, unitId('u1'));
    assert.equal(items.length, 1);
    assert.equal(buildTriple(r.ctx, unitId('u1'), 'med').backend, 'codex');
    appendSteps(d, [mulBuild(), gateStep({...answer, standing: [{id: items[0]!.id, disposition: 'addressed', evidence: ['test/mul.test.js:1']}]})]);
    await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired', JSON.stringify(r.journal.view.unit(unitId('u1')).decided));
    assert.ok(readCalls(d.scenarioPath).some((c) => c.as === 'codex' && c.stdin.includes('Show restart evidence')));
    assert.deepEqual(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-triggered').map((f) => f.marker), ['M1']);
  } finally {r.journal.close();}
});

test('surface.profile-switch: claude-only to default mid-arc starts the fix on a fresh Codex session', {timeout: 120_000}, async () => {
  const first = mulBuild();
  const d = setupArc({steps: [{as: 'claude', expect: {argv: ['--model', 'claude-sonnet-5-5']}, acts: [{type: 'commit', message: 'build', files: MUL}, {type: 'emit', value: BUILD_REPORT}]}, {as: 'codex', expect: {stdinContains: ['Reply with the JSON object']}, acts: [{type: 'emit', value: {ok: true}}]}, gateStep({decision: 'revise', directives: ['Check the repair']}), mulBuild({'src/mul.js': MUL['src/mul.js'] + '\n// Repair checked.\n'}), gateStep({decision: 'approve'})]});
  const raw = JSON.parse(readFileSync(d.planPath, 'utf8'));
  raw.routing = {profile: 'claude-only'};
  writeFileSync(d.planPath, JSON.stringify(raw));
  let r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'build');
    const before = r.journal.view.dispatchOf(unitId('u1'))!;
    assert.equal(seatTripleOf(before.implementerSeatRev).backend, 'claude');
    syncInputs(r);
    editPlan(d, (p) => {p['routing'] = {profile: 'default'};});
    const receipt = await applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d)));
    assert.equal(receipt.kind, 'applied', JSON.stringify(receipt));
    r.journal.close();
    r = contextFor(d);
    await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired', JSON.stringify(r.journal.view.unit(unitId('u1')).decided));
    const builds = r.journal.view.spawnsOfUnit(unitId('u1'), 'build');
    assert.equal(builds.length, 2);
    const subjects = builds.map((i) => i.expect.subject).filter((s) => s.purpose === 'backend');
    assert.notEqual(subjects[0]!.routingRev, subjects[1]!.routingRev);
    const calls = readCalls(d.scenarioPath);
    assert.equal(calls.filter((c) => c.as === 'claude' && c.argv.includes('claude-sonnet-5-5')).length, 1);
    const codex = calls.find((c) => c.as === 'codex' && c.stdin.includes('<unit_policy>'))!;
    assert.ok(codex);
    assert.ok(!codex.argv.includes('resume'));
  } finally {r.journal.close();}
});

test('surface.M4: all attempts count at 8 builds or 20 judged stages, never bookkeeping', () => {
  const id = unitId('u1');
  for (const [builds, stages, due] of [[7, 19, false], [8, 8, true], [1, 20, true]] as const) {
    const view = {judgedAttempts: (unit: typeof id) => {assert.equal(unit, id); return {builds, stages};}} as import('../src/core/interfaces.ts').JournalView;
    assert.equal(diagnosisDue(view, id), due);
  }
});

test('surface.specWrong: builder grounding becomes a blocking root item; tooBig is a nonblocking split proposal', {timeout: 120_000}, async () => {
  for (const wrong of [true, false]) {
    const report = {...BUILD_REPORT, grounding: {specWrong: wrong ? 'src/add.js:1 contradicts A1' : null, touches: ['app']}, tooBig: wrong ? null : {estimate: 'two independent changes', suggestedChildren: ['parser', 'presentation']}};
    const d = setupArc({steps: [{as: 'codex', expect: {}, acts: [{type: 'commit', message: 'grounded build', files: MUL}, {type: 'emit', value: report}]}]});
    const r = contextFor(d);
    try {
      await planCheck(r.ctx, r.unit('u1'));
      const out = await build(r.ctx, r.unit('u1'), {kind: 'fresh'});
      if ('kind' in out) throw new Error('unexpected cancellation');
      assert.equal(out.outcome.kind, wrong ? 'spec-wrong' : 'success');
      if (wrong) assert.equal(out.needsUser?.blocking, true);
      else {
        const items = r.journal.view.needsUser().map((n) => readNeedsUser(r.ctx.runDir, n.id));
        assert.equal(items.filter((n) => n?.reason === 'split-proposal').length, 1);
        assert.equal(items.find((n) => n?.reason === 'split-proposal')?.blocking, false);
        assert.match(items.find((n) => n?.reason === 'split-proposal')?.summary ?? '', /parser; presentation/);
      }
    } finally {r.journal.close();}
  }
});
