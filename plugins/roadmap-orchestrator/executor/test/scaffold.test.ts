// The scaffold stage (dev.17, design pass; src/pipeline/scaffold.ts), integrated and fake-backed over a corpus arc of the
// dev17 role set (its arc lane `journey` reports per test through the fake witness lane: test/helpers/witness.ts):
//
// scaffold.commits: a plan-check's scaffold decision sends the unit to the scaffold writer (the scaffold seat, Haiku 5.5, in
//   the unit worktree); its skeleton passes code's checks and the dry run of the load test's lane, and is the unit's first
//   executor-authored commit, on to the fresh build.
// scaffold.refused-then-fixed: a skeleton missing an entry point is refused; the retry is told why and passes.
// scaffold.plan-defect: a load test that fails its dry run twice parks the unit plan-defect, uncharged, nothing committed.
// scaffold.crash.*: the matrix row SCAFFOLD_STAGE (test/matrix.ts).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { JsonValue } from '../src/core/json.ts';
import { unitBranch } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { setupCorpusArc } from './fixtures/corpus-unit.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, U1, contextFor, mulBuild, outcomes } from './fixtures/unit-common.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { recoveryContext } from './fixtures/rec-common.ts';
import { SCAFFOLD_STAGE, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const until = (stop: string): Gate => async (next) => next.stage !== stop;

const NEW_SYSTEM = { name: 'billing', paths: ['src/billing/**'], tests: ['test/billing/**'] } as const;
const SCAFFOLD: JsonValue = {
  newSystem: NEW_SYSTEM, entryPoints: ['src/billing/index.js'], exports: ['charge'], loadTest: { lane: 'journey', testId: 't1' }, manifest: [],
};
const DESIGN: JsonValue = {
  kind: 'module', changes: [{ system: null, paths: ['src/billing/**'], lines: 30 }], interfaces: [], failureModes: [], breaks: { tests: [], docs: [] }, experiments: [],
  newSystem: NEW_SYSTEM, verification: null,
};
const INDEX = { 'src/billing/index.js': 'export function charge(cents) {\n  return cents;\n}\n' };

/** One scaffold writer call: the scaffold seat (Haiku 5.5, a fresh session, full tools), writing `files` and reporting. */
const scaffoldStep = (files: Readonly<Record<string, string>>, stdinContains: readonly string[] = []): Step => ({
  as: 'claude',
  expect: {
    argv: ['-p', '--setting-sources', 'project', '--model', 'claude-haiku-5-5', '--permission-mode', 'bypassPermissions', '--session-id'],
    argvLacks: ['--tools', '--resume', '--advisor'], stdinContains: ['<new_system name="billing">', ...stdinContains],
  },
  acts: [{ type: 'dirty', files }, { type: 'emit', value: { summary: 'Wrote the billing skeleton.', paths: Object.keys(files) } }],
});

/** The corpus arc of the dev17 role set with `steps`, the scaffold decision first. */
async function scaffoldArc(steps: readonly Step[]): Promise<Readonly<{ d: ArcDescriptor; planDir: string }>> {
  const a = await setupCorpusArc([planCheckStep({ decision: 'scaffold', design: DESIGN, scaffold: SCAFFOLD }), ...steps]);
  return { d: { ...a.d, arcRoles: 'dev17' }, planDir: a.planDir };
}

/** The unit branch's commits after the integration tip, oldest first, as `<author>|<subject>`. */
const branchLog = (r: ArcRun): readonly string[] =>
  git(r.d.repo, 'log', '--reverse', '--format=%an|%s', `main..${unitBranch(r.ctx.plan().arc, U1)}`).split('\n').filter((l) => l !== '');

test('scaffold.commits: the scaffold writer\'s skeleton passes code\'s checks and the dry run, and is the unit\'s first executor-authored commit', T, async () => {
  const { d } = await scaffoldArc([scaffoldStep(INDEX), mulBuild()]);
  const r = contextFor(d);
  try {
    const held = await runUnit(r.ctx, r.unit('u1'), until('lanes'));
    assert.equal(held.kind, 'held', JSON.stringify(held));
    assert.deepEqual(outcomes(d), ['plan-check:scaffold', 'scaffold:scaffolded', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released']);
    const log = branchLog(r);
    assert.equal(log[0], `Roadmap Executor|roadmap ${r.ctx.plan().arc}: scaffold of unit u1 (billing)`, 'the first commit is the scaffold, by the executor');
    assert.equal(git(d.repo, 'show', `${unitBranch(r.ctx.plan().arc, U1)}:src/billing/index.js`), INDEX['src/billing/index.js'].trimEnd());
    // The dry run ran the load test's arc lane under the scaffold attempt, once.
    const journeys = intents(d.runDir, 'proc.spawn').filter((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'journey' && i.parent.type === 'stage' && i.parent.stage === 'scaffold');
    assert.equal(journeys.length, 1);
    assert.equal(loadUnitSpec(r.ctx, r.unit('u1')).spec.design?.newSystem?.name, 'billing', 'the design record landed with the decision');
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls.every((c) => c.step !== null), 'every call matched its step');
    assert.ok(calls[1]!.cwd.endsWith('/u1'), `the scaffold writer works in the unit worktree, not ${calls[1]!.cwd}`);
    assert.ok(!git(d.repo, 'worktree', 'list', '--porcelain').includes('.scaffold-'), 'the dry run\'s checkout is removed');
  } finally {
    r.journal.close();
  }
});

test('scaffold.refused-then-fixed: a skeleton missing an entry point is refused; the retry, told why, passes', T, async () => {
  const { d } = await scaffoldArc([
    scaffoldStep({ 'src/billing/other.js': 'export const other = 1;\n' }),
    scaffoldStep(INDEX, ['<previous_attempt>', 'entry point src/billing/index.js does not exist']),
    mulBuild(),
  ]);
  const r = contextFor(d);
  try {
    assert.equal((await runUnit(r.ctx, r.unit('u1'), until('lanes'))).kind, 'held');
    assert.deepEqual(outcomes(d).slice(0, 4), ['plan-check:scaffold', 'scaffold:refused', 'scaffold:scaffolded', 'build:success']);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'a refused skeleton is uncharged');
    assert.equal(branchLog(r).filter((l) => l.includes('scaffold of unit u1')).length, 1, 'one scaffold commit');
  } finally {
    r.journal.close();
  }
});

test('scaffold.plan-defect: a load test that fails its dry run twice parks the unit plan-defect, uncharged, with nothing committed', T, async () => {
  const { d, planDir } = await scaffoldArc([scaffoldStep(INDEX), scaffoldStep(INDEX, ['<previous_attempt>', 'did not exit 0 as declared'])]);
  const r = contextFor(d);
  // Every tree fails t1 from here on: the dry run of each skeleton fails.
  writeFileSync(join(planDir, 'witness-control.json'), `${JSON.stringify({ trees: { '*': { outcomes: { t1: 'fail' } } } })}\n`);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), until('lanes'));
    assert.ok(parked.kind === 'parked', JSON.stringify(parked));
    assert.equal(parked.needsUser.reason, 'plan-defect');
    assert.match(parked.needsUser.summary, /its scaffold was refused twice: the load test's lane journey did not exit 0 as declared/);
    assert.deepEqual(outcomes(d), ['plan-check:scaffold', 'scaffold:refused', 'scaffold:plan-defect']);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
    assert.deepEqual(branchLog(r), [], 'nothing committed');
  } finally {
    r.journal.close();
  }
});

describe(`matrix row ${SCAFFOLD_STAGE}`, () => {
  for (const { label } of crashCells(SCAFFOLD_STAGE)) {
    test(`scaffold.crash.${label}: the next attempt finds the committed skeleton and records it, the writer asked once`, T, async () => {
      const { d } = await scaffoldArc([scaffoldStep(INDEX), mulBuild()]);
      const trigger = writeTrigger(tmpDir('scaffold-crash'), { label, occurrence: 1, unit: 'u1' });
      const first = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS });
      assert.equal(first.signal, 'SIGKILL', `killed at the label: ${first.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        await recover(recoveryContext(r));
        assert.equal((await runUnit(r.ctx, r.unit('u1'), until('lanes'))).kind, 'held');
        assert.deepEqual(outcomes(d).slice(0, 3), ['plan-check:scaffold', 'scaffold:scaffolded', 'build:success']);
        assert.equal(readCalls(d.scenarioPath).filter((c) => c.argv.includes('claude-haiku-5-5')).length, 1, 'the scaffold writer was asked once');
        assert.equal(branchLog(r).filter((l) => l.includes('scaffold of unit u1')).length, 1, 'one scaffold commit');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});
