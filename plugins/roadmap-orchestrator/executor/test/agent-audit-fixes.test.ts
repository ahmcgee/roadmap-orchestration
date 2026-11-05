import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unitId } from '../src/core/ids.ts';
import { buildTriple,pinDispatch,raiseRisk } from '../src/pipeline/dispatch.ts';
import { build,loadUnitSpec,preBuild } from '../src/pipeline/stages.ts';
import { markers,reviewItems } from '../src/pipeline/surface.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { runWalk } from '../src/walk/walk.ts';
import { validateGateOutput,validateCampaignAuditOutput } from '../src/prompts/schemas.ts';
import { promptFor } from '../src/prompts/index.ts';
import type { BuildInputs } from '../src/prompts/inputs.ts';
import { absPath,repoPath } from '../src/core/values.ts';
import { specRev } from '../src/core/ids.ts';
import { contextFor,setupArc } from './fixtures/unit-common.ts';
import { BUILD_REPORT,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { walkArc,milestoneJson,walkContext,walkStep,walkAnswer } from './fixtures/walk-common.ts';
import { unitSteps,moduleFiles } from './fixtures/audit-common.ts';
import { lensStep } from './helpers/holistic.ts';
import { readCalls } from './helpers/scenario.ts';

const T = {timeout: 120_000};
const clean = {decision: 'approve', ordering: null, findings: [], directives: [], reasons: ['Checked'], premises: [], standing: [], clusters: null, rulings: []};

test('surface.design-exclusion: the design unit uses Claude; a non-design milestone member stays Codex-eligible', () => {
  const d = walkArc({steps: [], milestone: milestoneJson({design: {unit: 'u3'}})});
  const r = contextFor(d);
  try {
    assert.deepEqual(buildTriple(r.ctx, unitId('u3'), 'med'), {backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium'});
    assert.equal(buildTriple(r.ctx, unitId('u1'), 'med').backend, 'codex');
  } finally {r.journal.close();}
});

test('surface.M1-eligibility: persistent and redacting traits trigger independent review and retain Codex builds', () => {
  const d = setupArc({steps: [], systemsMap: {systems: {app: {paths: ['src/**'], traits: ['persistent', 'redacts']}}}});
  const r = contextFor(d);
  try {
    assert.ok(markers(r.ctx, r.unit('u1'), loadUnitSpec(r.ctx, r.unit('u1')).spec).some((m) => m.marker === 'M1'));
    assert.equal(buildTriple(r.ctx, unitId('u1'), 'med').backend, 'codex');
  } finally {r.journal.close();}
});

test('surface.high-risk-floor: a raised dispatch floor runs the actual build on Opus', T, async () => {
  const d = setupArc({steps: [{as: 'claude', expect: {argv: ['--model', 'claude-opus-5-5']}, acts: [{type: 'emit', value: BUILD_REPORT}]}]});
  const r = contextFor(d);
  try {
    const unit = r.unit('u1'), loaded = loadUnitSpec(r.ctx, unit), state = {rev: loaded.spec.rev, sha256: loaded.sha256};
    const pinned = pinDispatch(r.ctx, unit, state);
    assert.equal(pinned.kind, 'pinned');
    if (pinned.kind !== 'pinned') throw new Error('no dispatch');
    raiseRisk(r.ctx, pinned.dispatch, 'high', state);
    const result = await build(r.ctx, unit, {kind: 'fresh'});
    assert.ok(!('kind' in result) && result.outcome.kind === 'success', JSON.stringify(result));
    assert.equal(readCalls(d.scenarioPath)[0]!.argv.includes('claude-opus-5-5'), true);
  } finally {r.journal.close();}
});

test('surface.always-without-marker: the root override runs a separate pre-build annotation', T, async () => {
  const d = setupArc({steps: [planCheckStep({decision: 'approve'})]});
  const r = contextFor(d);
  try {
    assert.deepEqual(markers(r.ctx, r.unit('u1'), loadUnitSpec(r.ctx, r.unit('u1')).spec).map((m) => m.marker), ['always']);
    await preBuild(r.ctx, r.unit('u1'));
    assert.equal(readCalls(d.scenarioPath).length, 1);
    assert.equal(r.journal.view.unit(unitId('u1')).decided?.stage, 'pre-build');
    assert.equal(reviewItems(r.journal.view, unitId('u1')).length, 0);
    assert.equal(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-completed').length, 1);
  } finally {r.journal.close();}
});

test('surface.root-only-obligations: neither verifier nor audit output can waive or defer an obligation', () => {
  for (const disposition of ['waived', 'deferred']) {
    assert.throws(() => validateGateOutput({...clean, obligations: [{id: 'I-1', state: {type: disposition}}]}));
    assert.throws(() => validateCampaignAuditOutput({findings: [], reasons: ['Checked'], premises: [], requests: [{op: 'obligation', id: 'I-1', disposition}]}));
    assert.throws(() => validateCampaignAuditOutput({findings: [], reasons: ['Checked'], premises: [], requests: [], obligationDispositions: [{id: 'I-1', disposition}]}));
  }
});

test('surface.nonzero-verdicts: experience and campaign outcomes record actual admitted finding counts', T, async () => {
  const d = walkArc({steps: [
    ...unitSteps('u1', moduleFiles('mul', '*')),
    walkStep('walk-1', walkAnswer({findings: [{class: 'deviates', journey: 'J-1', claim: 'The error copy departs from the design', cause: 'greet: unclear failure', against: {type: 'design', path: 'design/README.md', anchor: '#errors'}}]})),
    lensStep('audit-1', 'invariants', [{severity: 'P3', claim: 'The unit seam needs a follow-up', obligation: null}]),
  ]});
  const r = contextFor(d), {ctx, w} = walkContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    assert.equal((await runUnit(w.stage, r.unit('u1'), admitAll)).kind, 'merged');
    assert.equal((await runWalk(ctx)).kind, 'ended');
    assert.equal((await runAudit({...ctx, clock: () => 0})).kind, 'ended');
    assert.deepEqual(r.journal.view.stageJobOutcomes().map((v) => [v.stage, v.findings.total]), [['experience-verdict', 1], ['campaign-audit', 1]]);
  } finally {clearInterval(tick); r.journal.close();}
});

test('surface.fix-evidence: both builders receive findings, lane evidence, a base slot, notes and cap state', () => {
  const inputs: BuildInputs = {
    target: {kind: 'full', doc: {path: repoPath('ARCH.md'), text: 'Target'}}, spec: {unit: unitId('u1'), rev: specRev(1), markdown: 'Spec'},
    intent: 'Repair the failure', nonGoals: ['No unrelated change'], contracts: [], index: {contracts: [], rulings: [], withdrawn: [], ledger: absPath('/run/rulings')},
    systemNotes: [], notes: ['Retain the restart experiment'], fastLanes: [], suiteLanes: [], lastLaneSeries: null, evidenceDir: absPath('/run/build'), worktree: absPath('/work'), systems: [],
    fixRound: {failingEvidenceDirs: [absPath('/run/lanes/failed')], directives: ['Lost write: src/store.ts:42; experiment node restart.mjs: exit 1'], baseComparison: null, capState: {builds: 4, judgedStages: 12, chargeableFailures: 1, chargeableBound: 3, certificationAllowance: 2}},
    method: {traits: [], markers: [], unitKind: 'module', expensiveLanes: false, ui: false}, witnessChecks: [], milestones: null, browser: null, handover: null,
  };
  for (const model of ['claude-opus-5-5', 'gpt-5.6-luna'] as const) {
    const p = promptFor('build', model), rendered = p.render(inputs);
    for (const evidence of ['src/store.ts:42', 'node restart.mjs: exit 1', '/run/lanes/failed', '<base_comparison>null</base_comparison>', 'Retain the restart experiment', '"certificationAllowance":2', '"chargeableBound":3']) assert.ok(rendered.includes(evidence), evidence);
    assert.doesNotMatch(p.system + rendered, /nothing adjacent/i);
  }
});
