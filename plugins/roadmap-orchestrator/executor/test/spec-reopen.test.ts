import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { CommandBody } from '../src/core/records.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { editSpec } from './fixtures/route-common.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, MUL, U1, applyBody, commandContextFor, contextFor, gateStep, setupArc, stepUntil } from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';
import { readCalls, type Step } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
async function command(r: ArcRun, body: CommandBody) {
  return applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.ctx.plan().arc, body));
}
const flag = (argv: readonly string[], name: string): string | undefined => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };

test('build spec-wrong: strike a stale fact, apply rev+1, resume at pre-build with branch, checkout, counters and Claude implementer session kept', T, async () => {
  const wrong = { ...BUILD_REPORT, grounding: { specWrong: 'F1 is stale', touches: [] } };
  const d = setupArc({ steps: [
    planCheckStep({ decision: 'approve' }),
    { as: 'claude', expect: { argv: ['--session-id'] }, acts: [{ type: 'emit', value: wrong }] },
    planCheckStep({ decision: 'approve' }),
    { as: 'claude', expect: { argv: ['--resume'] }, acts: [{ type: 'commit', message: 'implement corrected spec', files: MUL }, { type: 'emit', value: BUILD_REPORT }] },
    gateStep({ decision: 'approve' }),
  ] });
  editSpec(d, 'u1', (s) => { s['facts'] = [{ id: 'F1', text: 'stale fact', state: 'active' }]; });
  const r = contextFor({ ...d, config: parseRepoConfig({ routing: { seats: { build: { med: 'frontier' } } } }) });
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.equal(parked.kind, 'parked');
    if (parked.kind !== 'parked') throw new Error(JSON.stringify(parked));
    assert.equal(parked.needsUser.reason, 'spec-wrong');
    assert.ok(parked.needsUser.recommendation.includes('resume u1'));
    const before = r.journal.view.unit(U1);
    assert.equal(before.decided?.stage, 'build');
    raiseNeedsUser(r.journal, r.ctx.runDir, parked.needsUser, { type: 'stage', unit: U1, stage: 'build', attempt: before.decided!.attempt });
    const rejected = await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } });
    assert.equal(rejected.kind, 'rejected', 'resume requires an applied correction');
    const branch = `roadmap/${d.arc}/u1`;
    const head = git(d.repo, 'rev-parse', branch);
    const trees = git(d.repo, 'worktree', 'list', '--porcelain');
    editSpec(d, 'u1', (s) => { s['rev'] = 2; s['facts'] = [{ id: 'F1', text: 'stale fact', state: 'struck' }]; });
    assert.equal((await command(r, applyBody(d))).kind, 'applied');
    assert.equal((await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } })).kind, 'applied');
    const reopened = r.journal.view.unit(U1);
    assert.deepEqual([reopened.status, reopened.stage, reopened.spec?.rev, reopened.pendingRevision], ['active', 'pre-build', 2, null]);
    assert.deepEqual(reopened.counters, before.counters);
    assert.equal(git(d.repo, 'rev-parse', branch), head);
    assert.equal(git(d.repo, 'worktree', 'list', '--porcelain'), trees);
    await stepUntil(r, 'u1', (f) => f.stage === 'pre-build');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    const builds = readCalls(d.scenarioPath).filter((c) => c.argv.includes('--permission-mode') && !c.argv.includes('--tools'));
    assert.equal(builds.length, 2);
    assert.equal(flag(builds[1]!.argv, '--resume'), flag(builds[0]!.argv, '--session-id'));
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally { r.journal.close(); }
});

for (const reason of ['refusal', 'malformed'] as const) {
  test(`a build ${reason} park still requires re-entry after a spec correction`, T, async () => {
    const bad: Step = { as: 'claude', expect: {}, acts: reason === 'refusal' ? [{ type: 'refusal' }] : [{ type: 'emit', value: { ...BUILD_REPORT, summary: 42 } }] };
    const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), bad, ...(reason === 'malformed' ? [bad] : [])] });
    const r = contextFor({ ...d, config: parseRepoConfig({ routing: { seats: { build: { med: 'frontier' } } } }) });
    try {
      assert.equal((await runUnit(r.ctx, r.unit('u1'), admitAll)).kind, 'parked');
      assert.equal(r.journal.view.unit(U1).decided?.stage, 'build');
      assert.equal(r.journal.view.unit(U1).decided?.outcome, reason);
      editSpec(d, 'u1', (s) => { s['rev'] = 2; s['intent'] = 'Corrected intent'; });
      assert.equal((await command(r, applyBody(d))).kind, 'rejected', 'other build parks also reject a revision');
      const out = await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } });
      assert.equal(out.kind, 'rejected');
      if (out.kind === 'rejected') assert.match(out.reason, /this park needs re-entry/);
      assert.equal(r.journal.view.unit(U1).status, 'park-pending');
    } finally { r.journal.close(); }
  });
}
