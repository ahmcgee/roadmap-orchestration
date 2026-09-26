// The integration slot (src/pipeline/integrate.ts) through the unit driver, fake-backed: real processes,
// real git. Named tests: merge.base-red, merge.stale-tip-fresh-candidate; also the transient refusal as a
// scope-growth fix round and a foreign move of integration stopping publication.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resourceName } from '../src/core/ids.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { git } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { U1, codexStep, contextFor, gateStep, isGateCall as isGate, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = (): AbortSignal => new AbortController().signal;
const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);

test('merge.base-red: the suite is red on the candidate and on T alone; the unit parks with an uncharged base-red needs-user', T, async () => {
  const d = setupArc({ base: 'red', steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    const tip = git(d.repo, 'rev-parse', 'main');
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.equal(result.kind, 'parked');
    assert.ok(result.kind === 'parked');
    assert.equal(result.needsUser.reason, 'base-red');
    assert.deepEqual(result.needsUser.subject, { type: 'arc' }, 'a broken base halts merges, not just this unit');
    assert.equal(result.needsUser.blocking, true);
    assert.equal(outcomes(d).at(-1), 'candidate:base-red');
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'base-red is uncharged');
    assert.equal(git(d.repo, 'rev-parse', 'main'), tip, 'integration never moved');
    const suites = intents(d.runDir, 'proc.spawn').flatMap((i) => (i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'suite' ? [i.expect.subject.at] : []));
    assert.equal(suites.length, 2);
    assert.equal(suites[1], tip, 'the second suite run tested T alone');
    for (const suffix of ['candidate', 'base']) {
      assert.ok(!existsSync(join(r.ctx.plan.worktreeRoot, r.ctx.plan.arc, `u1.${suffix}-9`)), `the ${suffix} checkout is removed`);
    }
    assert.equal(resourceTable(r.journal.view).get(resourceName('integration-slot'))?.status.state, 'free', 'the slot is released');
  } finally {
    r.journal.close();
  }
});

test('merge.stale-tip-fresh-candidate: T advances between the green candidate and ff; the approval holds, so a fresh candidate publishes without a new gate', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    writeFileSync(join(d.repo, 'NOTES.md'), 'Unrelated.\n');
    git(d.repo, 'add', 'NOTES.md');
    git(d.repo, 'commit', '--quiet', '-m', 'unrelated work lands first');
    const tip = git(d.repo, 'rev-parse', 'main');
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(8), ['candidate:green', 'ff:cas-stale', 'candidate:green', 'ff:published', 'snapshot:published']);
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 1, 'no new gate');
    const head = git(d.repo, 'rev-parse', 'main');
    const unitCommit = r.journal.view.unit(U1).approval!.fingerprint.unitCommit;
    assert.deepEqual(parentsOf(d.repo, head), [tip, unitCommit], 'the fresh candidate merged the approved commit onto the new tip');
    assert.equal(intents(d.runDir, 'candidate.merge').length, 2);
  } finally {
    r.journal.close();
  }
});

test('merge.transient-refusal: a path the transient check refuses sends the unit to a scope-growth fix round, and the next gate sits on the high seat', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'evidence/notes.txt': 'scratch\n' }),
      gateStep({ decision: 'approve' }),
      codexStep([{ type: 'commit', message: 'drop the scratch file', files: { 'evidence/notes.txt': null } }], { argv: ['exec', 'resume'], stdinContains: ['evidence/notes.txt (evidence)'] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.ok(outcomes(d).includes('candidate:transient-violation'));
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 1, `a transient violation charges: ${outcomes(d).join(' ')}`);
    const gates = readCalls(d.scenarioPath).filter(isGate);
    assert.equal(gates.length, 2);
    assert.ok(gates[1]!.argv.includes('claude-fable-5-1'), 'scope growth promoted the next judgment');
    assert.ok(!git(d.repo, 'ls-tree', '-r', '--name-only', 'main').includes('evidence/'), 'nothing transient reached integration');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('ff.foreign-move: integration rewritten under a green candidate stops publication with a needs-user', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const tree = git(d.repo, 'rev-parse', 'main^{tree}');
    const orphan = git(d.repo, 'commit-tree', tree, '-m', 'someone rewrote integration');
    git(d.repo, 'update-ref', 'refs/heads/main', orphan);
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.equal(result.kind, 'stopped');
    assert.ok(result.kind === 'stopped');
    assert.equal(result.needsUser.reason, 'foreign-ref-move');
    assert.deepEqual(result.needsUser.subject, { type: 'arc' });
    assert.equal(outcomes(d).at(-1), 'ff:foreign-move');
    assert.equal(git(d.repo, 'rev-parse', 'main'), orphan, 'the executor never moves a ref someone else moved');
    assert.deepEqual(intents(d.runDir, 'integration.ff'), []);
  } finally {
    r.journal.close();
  }
});
