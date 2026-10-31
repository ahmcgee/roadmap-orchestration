import { lensCoverage } from '../src/holistic/coverage.ts';
import { sha, sha256 } from '../src/core/ids.ts';
import { claudeBuilderRouting } from '../src/routing/eligibility.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { cadence } from '../src/holistic/cadence.ts';
import { runWalk } from '../src/walk/walk.ts';
import { walkArc, walkContext, walkStep, walkAnswer } from './fixtures/walk-common.ts';
import { unitSteps, moduleFiles } from './fixtures/audit-common.ts';
import { lensStep } from './helpers/holistic.ts';
import { wire } from './fixtures/publish-common.ts';
import { join } from 'node:path';
import { holisticArc } from './fixtures/brake-common.ts';
import { editPlan } from './fixtures/route-common.ts';
import { MUL } from './fixtures/unit-common.ts';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { unitId } from '../src/core/ids.ts';
import { standingRules } from '../src/pipeline/gate.ts';
import { preBuild, build, loadUnitSpec } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { methodModules } from '../src/prompts/method/index.ts';
import { validateBuildOutput, validateGateOutput, validateCampaignAuditOutput } from '../src/prompts/schemas.ts';
import { seatTripleOf } from '../src/pipeline/dispatch.ts';
import { buildTriple } from '../src/pipeline/dispatch.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { diagnosisDue, reviewItems, markers, proofNotLocal, methodContext } from '../src/pipeline/surface.ts';
import { contextFor, setupArc, gateStep, mulBuild, codexStep, appendSteps, stepUntil, syncInputs, commandContextFor, applyBody } from './fixtures/unit-common.ts';
import { BUILD_REPORT, admitAll, planCheckStep, planCheckRepairStep } from './fixtures/stage-common.ts';
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
    const checked = await preBuild(r.ctx, r.unit('u1'));
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
      await preBuild(r.ctx, r.unit('u1'));
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

test('surface.M2: a delivered candidate witness triggers review and Claude; review never suppresses the seat only', {timeout: 120_000}, async () => {
  const a = holisticArc({steps: [gateStep({decision: 'approve'})], units: [{id: 'u1', obligations: ['I-1']}], obligations: [{id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['t1']}], mapping: [], laneExtra: {journey: {cadence: 'candidate'}}, trees: {'*': {outcomes: {t1: 'pass'}}}});
  const r = contextFor(a.d);
  try {
    assert.equal(proofNotLocal(r.ctx, r.unit('u1')), true);
    assert.equal(buildTriple(r.ctx, unitId('u1'), 'med').backend, 'claude');
    await preBuild(r.ctx, r.unit('u1'));
    assert.ok(r.journal.view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.marker === 'M2'));
    assert.equal(r.journal.view.dispatchOf(unitId('u1'))!.routingRev, claudeBuilderRouting(r.ctx.routing(unitId('u1'))).rev);
    assert.notEqual(r.journal.view.dispatchOf(unitId('u1'))!.routingRev, r.ctx.routing(unitId('u1')).rev, 'the fallback records its actual routing table');
    const never = {...r.unit('u1'), review: 'never' as const};
    assert.deepEqual(markers(r.ctx, never, loadUnitSpec(r.ctx, never).spec), []);
    assert.equal(proofNotLocal(r.ctx, never), true, 'the builder exclusion remains mechanical');
    assert.ok(methodContext(r.ctx, never, loadUnitSpec(r.ctx, never).spec).markers.includes('M2'), 'disabling the review seat retains the proof method module');
  } finally {r.journal.close();}
});

test('surface.review-repair: one refused annotation resumes its recorded session without holding the unit', {timeout: 120_000}, async () => {
  const first = planCheckStep({decision: 'approve'});
  const d = setupArc({steps: [{...first, acts: [{type: 'malformed'}]}, planCheckRepairStep({decision: 'approve'}, ['the answer does not match its schema'])]});
  const r = contextFor(d);
  try {
    const out = await preBuild(r.ctx, r.unit('u1'));
    assert.equal('kind' in out ? out.kind : out.outcome.kind, 'approve');
    const calls = readCalls(d.scenarioPath);
    assert.equal(calls.length, 2);
    const flag = (n: number, name: string) => calls[n]!.argv[calls[n]!.argv.indexOf(name) + 1];
    assert.equal(flag(1, '--resume'), flag(0, '--session-id'));
    assert.equal(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-completed').length, 1);
    await preBuild(r.ctx, r.unit('u1'));
    assert.equal(readCalls(d.scenarioPath).length, 2, 'no repeated review of unchanged inputs');
  } finally {r.journal.close();}
});

test('surface.M3: an apply meaning change reviews a cited obligation even when specRev stays fixed', {timeout: 120_000}, async () => {
  const a = holisticArc({steps: [], units: [{id: 'u1', obligations: ['I-1']}], obligations: [{id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['t1']}], mapping: [], trees: {'*': {outcomes: {t1: 'pass'}}}});
  const r = contextFor(a.d);
  const w = wire(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    await preBuild(r.ctx, r.unit('u1'));
    assert.equal(readCalls(a.d.scenarioPath).length, 0);
    syncInputs(r);
    const path = join(a.d.planPath, '..', 'obligations.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.obligations[0].statement = 'I-1 also refuses invalid operands.';
    raw.obligations[0].rev = 2;
    raw.obligations[0].proofJudgment.obligationRev = 2;
    writeFileSync(path, JSON.stringify(raw));
    const applied = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(a.d)));
    assert.equal(applied.kind, 'applied', JSON.stringify(applied));
    assert.ok(markers(r.ctx, r.unit('u1'), loadUnitSpec(r.ctx, r.unit('u1')).spec).some((m) => m.marker === 'M3'));
    appendSteps(a.d, [gateStep({decision: 'approve'})]);
    await preBuild(r.ctx, r.unit('u1'));
    assert.equal(readCalls(a.d.scenarioPath).length, 1);
    assert.equal(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-triggered' && f.marker === 'M3').length, 1);
    await preBuild(r.ctx, r.unit('u1'));
    assert.equal(readCalls(a.d.scenarioPath).length, 1, 'the meaning change is consumed once');
  } finally {clearInterval(tick); r.journal.close();}
});

test('surface.diagnosis: the M4 signal adds build memory and moves remaining default builds to Claude', {timeout: 120_000}, async () => {
  const d = setupArc({steps: [gateStep({decision: 'approve', reasons: ['The repeated red needs a narrow restart experiment.']}), {as: 'claude', expect: {argv: ['--model', 'claude-sonnet-5-5'], stdinContains: ['narrow restart experiment']}, acts: [{type: 'commit', message: 'diagnosed build', files: MUL}, {type: 'emit', value: BUILD_REPORT}]}, gateStep({decision: 'approve'})]});
  const r = contextFor(d);
  try {
    const countAttempts = r.journal.view.judgedAttempts.bind(r.journal.view);
    Object.assign(r.journal.view, {judgedAttempts: () => ({builds: 8, stages: 20})});
    await runUnit(r.ctx, r.unit('u1'), admitAll);
    Object.assign(r.journal.view, {judgedAttempts: countAttempts});
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired');
    assert.ok(r.journal.view.surfaceFacts().some((f) => f.kind === 'review-triggered' && f.marker === 'M4'));
    assert.ok(r.journal.view.surfaceFacts().some((f) => f.kind === 'review-completed' && f.mode === 'diagnosis' && f.note !== null));
    assert.equal(buildTriple(r.ctx, unitId('u1'), 'med').backend, 'claude');
    assert.equal(readCalls(d.scenarioPath).filter((c) => c.as === 'codex').length, 0);
  } finally {r.journal.close();}
});

test('surface.campaign-schema: only request ops, and dismissals require counter-evidence', () => {
  const base = {reasons: ['Audited'], premises: [], findings: [], requests: []};
  assert.deepEqual(validateCampaignAuditOutput(base).requests, []);
  assert.throws(() => validateCampaignAuditOutput({...base, requests: [{op: 'cut', unit: 'u1'}]}));
  const request = {op: 'request', summary: 'Reconsider F-1', evidence: ['test/mul.js:1'], dismisses: 'F-1', counterEvidence: null};
  assert.throws(() => validateCampaignAuditOutput({...base, requests: [request]}), /counter-evidence/);
  assert.equal(validateCampaignAuditOutput({...base, requests: [{...request, counterEvidence: 'Restart experiment retained the committed write.'}]}).requests.length, 1);
});

test('surface.milestone: one combined experience verdict and one campaign audit, both recorded with finding counts', {timeout: 120_000}, async () => {
  const d = walkArc({steps: [...unitSteps('u1', moduleFiles('mul', '*')), walkStep('walk-1', walkAnswer()), lensStep('audit-1', 'invariants')]});
  const r = contextFor(d);
  const {ctx, w} = walkContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    assert.equal(cadence(ctx, () => 0)?.due, false);
    await runUnit(w.stage, r.unit('u1'), admitAll);
    assert.ok(cadence(ctx, () => 0)?.owed.some((t) => t.type === 'milestone'));
    assert.equal((await runWalk(ctx)).kind, 'ended');
    const before = r.journal.view.planApplied()!.rev;
    const audit = await runAudit({...ctx, clock: () => 0});
    assert.ok(audit.kind === 'ended' && audit.outcome === 'completed', JSON.stringify(audit));
    assert.equal(r.journal.view.planApplied()!.rev, before, 'the audit cannot amend the plan');
    assert.deepEqual(r.journal.view.arcVerdicts().map((v) => [v.stage, v.verdict, v.findings]), [['experience-verdict', 'reported', 0], ['campaign-audit', 'completed', 0]]);
    assert.deepEqual(await runAudit({...ctx, clock: () => 0}), {kind: 'none'});
    assert.equal(r.journal.view.arcVerdicts().length, 2);
  } finally {clearInterval(tick); r.journal.close();}
});

test('surface.review-usage-limit: annotation never parks the unit and still parks the failed backend arc-wide', {timeout: 120_000}, async () => {
  const first = planCheckStep({decision: 'approve'});
  const d = setupArc({steps: [{...first, acts: [{type: 'usageLimit'}]}]});
  const r = contextFor(d);
  try {
    const out = await preBuild(r.ctx, r.unit('u1'));
    assert.equal('kind' in out ? out.kind : out.outcome.kind, 'approve');
    assert.equal(r.journal.view.unit(unitId('u1')).status, 'active');
    assert.deepEqual(r.journal.view.parkedBackends(), ['claude']);
    assert.equal(r.journal.view.needsUser().map((n) => readNeedsUser(r.ctx.runDir, n.id)).filter((n) => n?.reason === 'usage-limit').length, 1);
    assert.ok(r.journal.view.surfaceFacts().some((f) => f.kind === 'review-completed' && f.note !== null));
  } finally {r.journal.close();}
});

test('surface.whole-range: later campaign coverage advances from the same baseline without repeating final audits', () => {
  const base={seq:1,head:sha('a'.repeat(40)),visionSha256:sha256('d'.repeat(64))};
  const audit=(n:number,to:string)=>({started:{job:`audit-${n}`,seq:n*10,visionSha256:base.visionSha256},ended:{seq:n*10+5,covered:[{lens:'invariants',from:base.head,to:sha(to.repeat(40))}]}});
  const fold={audits:[audit(1,'b'),audit(2,'c')],docsCovered:[]} as unknown as import('../src/core/state.ts').HolisticFold;
  assert.equal(lensCoverage(fold,base,'invariants').watermark,sha('c'.repeat(40)));
  assert.equal(lensCoverage(fold,base,'invariants',20).watermark,sha('b'.repeat(40)));
});

test('surface.review-always: no marker still runs the pre-build verifier before building', {timeout: 120_000}, async () => {
  const d = setupArc({steps: [planCheckStep({decision: 'approve'}), mulBuild(), gateStep({decision: 'approve'})]});
  editPlan(d, (p) => { (p['units'] as Record<string, unknown>[])[0]!['review'] = 'always'; });
  const r = contextFor(d);
  try {
    assert.deepEqual(markers(r.ctx, r.unit('u1'), loadUnitSpec(r.ctx, r.unit('u1')).spec).filter((m) => m.marker !== 'always'), []);
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), {kind: 'merged'});
    const calls = readCalls(d.scenarioPath);
    assert.equal(calls.length, 3);
    assert.ok(calls[0]!.stdin.includes('pre-build'));
    const roles = r.journal.view.spawnsOfUnit(unitId('u1')).flatMap((i) => i.expect.subject.purpose === 'backend' ? [i.expect.subject.role] : []);
    assert.deepEqual(roles, ['verifier', 'build', 'verifier']);
    assert.equal(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-completed' && f.mode === 'pre-build').length, 1);
    assert.deepEqual(r.journal.view.surfaceFacts().filter((f) => f.kind === 'review-triggered').map((f) => f.marker), ['always']);
  } finally {r.journal.close();}
});

test('surface.fix-round: a gate revision delivers findings, experiments and live cap state to the builder', {timeout: 120_000}, async () => {
  const finding = {severity: 'blocking', path: 'src/mul.js:2', text: 'The retry drops the durable write', contractRef: null, experiments: [{command: 'node test/restart.js', output: 'restarted without the write'}], evidence: ['src/mul.js:2: the acknowledgement precedes persistence'], debt: null, defect: null, reraises: null, hunk: null};
  const d = setupArc({steps: [mulBuild(), gateStep({decision: 'revise', findings: [finding], directives: ['Persist before acknowledgement']}), codexStep([{type: 'commit', message: 'persist the retry', files: {'src/repaired.js': 'export const repaired = true;\n'}}], {argv: ['exec', 'resume']}), gateStep({decision: 'approve'})]});
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), {kind: 'merged'});
    const calls = readCalls(d.scenarioPath).filter((c) => c.as === 'codex');
    assert.equal(calls.length, 2);
    const prompt = calls[1]!.stdin;
    assert.match(prompt, /<fix_round>/);
    assert.match(prompt, /The retry drops the durable write/);
    assert.match(prompt, /src\/mul\.js:2: the acknowledgement precedes persistence/);
    assert.match(prompt, /node test\/restart\.js: restarted without the write/);
    const cap = JSON.parse(/<cap_and_allowance>([^<]+)<\/cap_and_allowance>/.exec(prompt)![1]!);
    assert.equal(cap.builds, 2);
    assert.ok(cap.judgedStages >= 5);
    assert.equal(cap.chargeableFailures, 1);
    assert.equal(cap.chargeableBound, 3);
    assert.equal(cap.certificationAllowance, 3);
    assert.equal(r.journal.view.unit(unitId('u1')).counters.reviseRounds, 1);
  } finally {r.journal.close();}
});
