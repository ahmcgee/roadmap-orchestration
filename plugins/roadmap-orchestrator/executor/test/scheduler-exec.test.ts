// The scheduler inside the executor process, through the real CLI and supervisor, fake-backed: a crash while
// one unit's gate is in flight and another unit publishes. Named test: gate.recovered-recorded-tip (at the
// scheduler level, two units; the stage-level case is in test/stage-m2.test.ts).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { unitId } from '../src/core/ids.ts';
import { reached, release } from './helpers/barrier.ts';
import { git } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { U1, gateStep, mulBuild, outcomes } from './fixtures/unit-common.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_DEFAULT, executorPid, journalOf, reasonOf, setupExec, startExec, until,
} from './fixtures/exec-common.ts';

after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };
const WAIT_MS = 60_000;
const U2 = unitId('u2');
const CONTRACT = 'contracts/api.md';

/** Each step keyed to `unit`: its calls take only these, in order (independent units run at once). */
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const facts = (r: ExecRun): readonly Fact[] => journalOf(r).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const started = (r: ExecRun): number => facts(r).filter((f) => f.kind === 'executor-started').length;

test('gate.recovered-recorded-tip (scheduler, two units): u1\'s gate is in flight when u2 publishes a contract change and the executor crashes; the restart consumes u1\'s approval at the tip it reviewed, and ff finds it fingerprint-invalid and re-gates', T, async (t) => {
  const changed = { [CONTRACT]: '# API contract\n\n`add(a, b)` returns the sum of two numbers; `mul(a, b)` their product.\n' };
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      ...SMOKE_DEFAULT,
      ...of('u1', [
        planCheckStep({ decision: 'approve' }), mulBuild(),
        gateStep({ decision: 'approve' }, {}, [{ type: 'barrier', name: 'agate', timeoutMs: 120_000 }]),
        gateStep({ decision: 'approve' }),
      ]),
      ...of('u2', [planCheckStep({ decision: 'approve' }), mulBuild(changed), gateStep({ decision: 'approve' })]),
      // The respawn's smoke.
      ...SMOKE_DEFAULT,
    ],
  });
  const run = startExec(r);
  await reached(r.scenarioDir, 'agate', WAIT_MS);
  await until(() => outcomes(r, 'u2').includes('ff:published'), WAIT_MS, 'u2 to publish its contract change while u1\'s gate is in flight');
  const before = journalOf(r).view;
  const open = before.unit(U1).open;
  assert.ok(open !== null && open.stage === 'gate', 'u1\'s gate attempt is open');
  const inputs = before.judgmentInputs(U1, 'gate', open.attempt);
  assert.ok(inputs !== null, 'the gate recorded its inputs before its spawn');
  const main = git(r.repo, 'rev-parse', 'main');
  assert.notEqual(inputs.tip, main, 'integration moved on under the gate');

  process.kill(executorPid(r), 'SIGKILL');
  await until(() => started(r) === 2, WAIT_MS, 'the supervisor\'s restart');
  release(r.scenarioDir, 'agate');
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual(reasonOf(exit), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }, { unit: 'u2', result: 'merged' }] });

  const all = facts(r);
  const approvals = all.flatMap((f) => (f.kind === 'approval' && f.unit === U1 ? [f] : []));
  assert.equal(approvals.length, 2, 'approved, invalidated, approved again');
  const blob = (tip: string): string => git(r.repo, 'rev-parse', `${tip}:${CONTRACT}`);
  const bound = (i: number): string | undefined => approvals[i]!.fingerprint.contractRevs.find((c) => c.path === CONTRACT)?.blob;
  assert.equal(approvals[0]!.attempt, open.attempt, 'the recovered call was consumed as its own attempt');
  assert.equal(bound(0), blob(inputs.tip), 'the recovered approval binds the contract at the tip the gate reviewed');
  assert.equal(bound(1), blob(main), 'the re-gate binds the contract u2 published');
  const u1 = outcomes(r, 'u1');
  const invalid = u1.indexOf('ff:fingerprint-invalid');
  assert.ok(invalid > 0 && u1.slice(invalid + 1).includes('gate:approve') && u1.at(-2) === 'ff:published', u1.join(' '));
  const gates = journalOf(r).view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.unit === U1 && i.expect.subject.role === 'gate');
  assert.equal(gates.length, 2, 'the crashed gate call was consumed, never re-dispatched');
  assert.deepEqual(outcomes(r, 'u2').at(-1), 'snapshot:published');
  assert.ok(facts(r).some((f) => f.kind === 'stage-outcome' && f.unit === U2 && f.stage === 'ff' && f.outcome === 'published'));
});
