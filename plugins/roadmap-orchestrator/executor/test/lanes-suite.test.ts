// The fast suite at the lanes stage (the 2026-10-15 batch; src/pipeline/stages.ts `fastSuite`): after a green spec series
// the plan's fast suite lanes run at the salvage SHA, less any identical to a spec lane; a red one runs again on the unit's
// diff base alone. Base green: the unit's red, a chargeable fix round whose evidence and prompt carry the suite lane. Base
// red: `base-red`, uncharged, on to the gate; a base's verdict is run once per run. Real processes, real git, fake
// backends. Named tests: lanes.fast-suite-own-red, lanes.fast-suite-base-red, lanes.fast-suite-base-is-salvage.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { type Sha, sha } from '../src/core/ids.ts';
import { worktreeList } from '../src/git/git.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { type LanesDone, fastSuiteRoot, lanes, loadUnitSpec, planCheck } from '../src/pipeline/stages.ts';
import { stageSuiteLanes, suiteStandIns } from '../src/pipeline/lanes.ts';
import { step } from '../src/pipeline/unit.ts';
import { git } from './helpers/repo.ts';
import { type CodexAct, type Expect, type Step, readCalls } from './helpers/scenario.ts';
import {
  BUILD_REPORT, type LaneJson, SCENARIO_TIMEOUT_MS, type StageRun, U1, keptSpec, outcomeFacts, planCheckStep, setupUnit, spawnIntents, started,
} from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const codexBuild = (acts: readonly CodexAct[], expect: Expect = {}): Step => ({ as: 'codex', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] });

/** The spec's one lane, green anywhere. */
const UNIT: LaneJson = { id: 'unit', argv: ['true'] };
/** A suite lane identical to the spec's: its pass is the spec series', so it never runs at the lanes stage. */
const SAME: LaneJson = { id: 'same', argv: ['true'] };
/** An estate suite lane: the candidate's alone. */
const E2E: LaneJson = { id: 'e2e', argv: ['false'], tier: 'estate' };

type LaneSubject = Readonly<{ lane: string; set: string; at: Sha; attempt: number }>;
/** The lane spawns, in order: which lane, which set, at which commit, under which lanes attempt. */
function laneSpawns(run: StageRun): readonly LaneSubject[] {
  return spawnIntents(run).flatMap((i: IntentOf<'proc.spawn'>) => {
    const s = i.expect.subject;
    return s.purpose === 'lane' && i.parent.type === 'stage' ? [{ lane: s.lane, set: s.set, at: s.at, attempt: i.parent.attempt }] : [];
  });
}

/** A commit of the unit's own on a side branch, off the integration tip (which stays where it is). */
function unitCommit(run: StageRun, file: string, text: string): Sha {
  git(run.repo, 'checkout', '-q', '-b', `side-${file.replace(/\W/g, '-')}`);
  writeFileSync(join(run.repo, file), text);
  git(run.repo, 'add', file);
  git(run.repo, 'commit', '-q', '-m', `unit work: ${file}`);
  const at = sha(git(run.repo, 'rev-parse', 'HEAD'));
  git(run.repo, 'checkout', '-q', 'main');
  return at;
}

const fastCheckouts = (run: StageRun) => worktreeList(run.repo).filter((w) => w.path.includes('.fast-'));

test('lanes.fast-suite-own-red: a fast suite lane red on the unit\'s commit and green on its base is a chargeable fix round with the suite evidence; the builder is shown it, fixes it, and the lanes go green', T, async () => {
  // Lint fails on a TODO in src/add.js: the first build leaves one, the fix round removes it. The base has none.
  const lint: LaneJson = { id: 'lint', argv: ['sh', '-c', 'if grep -q TODO src/add.js; then echo "lint: TODO left in src/add.js" >&2; exit 1; fi'] };
  const run = setupUnit({
    lanes: [UNIT],
    suite: [SAME, lint, E2E],
    steps: [
      planCheckStep({ decision: 'approve' }),
      codexBuild([{ type: 'commit', message: 'add', files: { 'src/add.js': 'export function add(a, b) {\n  return a + b; // TODO tidy\n}\n' } }], { argv: ['exec', '-C'] }),
      codexBuild([{ type: 'commit', message: 'lint', files: { 'src/add.js': 'export function add(a, b) {\n  return a + b;\n}\n' } }], { argv: ['exec', 'resume'] }),
    ],
  });
  started(await planCheck(run.ctx, run.unit));
  // build → quiesce → evidence → salvage → teardown → lanes, through the driver.
  while (run.journal.view.unit(U1).decided?.stage !== 'lanes') assert.equal((await step(run.ctx, run.unit)).kind, 'continue');

  // The plan-check's call, then the build's.
  const fresh = readCalls(run.scenario.path)[1];
  assert.ok(fresh !== undefined);
  // The builder is shown the fast suite lane it must run, as its exact command; never the identical or the estate one.
  assert.match(fresh.stdin, /# Suite lanes[\s\S]*- lint \(expects exit 0[^)]*\):\n {2}cd \S+ && sh -c /);
  assert.doesNotMatch(fresh.stdin, /- same \(|- e2e \(/);

  const red = run.journal.view.unit(U1).decided;
  assert.ok(red !== null && red.stage === 'lanes');
  assert.equal(red.outcome, 'red');
  assert.equal(red.chargeable, true, 'the unit\'s own red charges');
  const salvaged = laneSpawns(run).find((s) => s.set === 'spec')!.at;
  const base = sha(git(run.repo, 'rev-parse', 'main'));
  // The spec lane, then lint at the salvage SHA (red, its diagnostic rerun red), then lint on the base alone (green).
  assert.deepEqual(laneSpawns(run).map((s) => [s.lane, s.set, s.at]), [
    ['unit', 'spec', salvaged], ['lint', 'suite', salvaged], ['lint', 'suite', salvaged], ['lint', 'suite', base],
  ]);
  assert.deepEqual(fastCheckouts(run), [], 'the fast suite\'s checkouts are removed');

  // The fix round is rebuilt from the record: it reads the suite lane's evidence and its stderr names the failure.
  assert.equal((await step(run.ctx, run.unit)).kind, 'continue');
  const calls = readCalls(run.scenario.path);
  assert.equal(calls.length, 3);
  const suiteDir = fastSuiteRoot(run.runDir, { type: 'stage', unit: U1, stage: 'lanes', attempt: red.attempt }, 'suite');
  assert.ok(calls[2]!.stdin.includes(join(suiteDir, 'lint', 'output', 'files')), 'the fix round lists the suite lane\'s output');
  assert.equal(run.journal.view.unit(U1).decided?.outcome, 'success');

  while (run.journal.view.unit(U1).decided?.stage !== 'lanes') assert.equal((await step(run.ctx, run.unit)).kind, 'continue');
  const green = run.journal.view.unit(U1).decided;
  assert.equal(green?.outcome, 'green');
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 1);
});

test('lanes.fast-suite-base-red: a fast suite lane red on the unit\'s base alone too is base-red, uncharged, on to the gate; the base runs once for later attempts', T, async () => {
  const lint: LaneJson = { id: 'lint', argv: ['sh', '-c', 'echo "lint: broken everywhere" >&2; exit 1'] };
  const run = setupUnit({ steps: [], lanes: [UNIT], suite: [SAME, lint, E2E] });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  const salvaged = unitCommit(run, 'src/extra.js', 'export const extra = 1;\n');

  const first: LanesDone = started(await lanes(run.ctx, run.unit, salvaged));
  assert.equal(first.outcome.kind, 'base-red');
  assert.ok(first.next.kind === 'stage' && first.next.stage === 'gate', 'on to the gate');
  assert.equal(first.fix, null);
  assert.ok(first.verification !== null, 'the gate\'s checkout is kept');
  assert.deepEqual(first.ledger.map((l) => [l.lane, l.verdict]), [['unit', 'pass']], 'the gate\'s ledger is the spec series');
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome' && fact.outcome === 'base-red');
  assert.equal(fact.chargeable, false);
  assert.deepEqual(fact.detail, { kind: 'base-red', base: run.base, lanes: ['lint'], changedCheckout: false });
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 0);

  // A later attempt on the same base reuses the base's verdict: lint runs again on the unit's commit (the spec lane's pass
  // is reused, F1a), never on the base.
  const second = started(await lanes(run.ctx, run.unit, salvaged));
  assert.equal(second.outcome.kind, 'base-red');
  const onBase = laneSpawns(run).filter((s) => s.at === run.base);
  assert.ok(onBase.length > 0 && onBase.every((s) => s.lane === 'lint' && s.set === 'suite' && s.attempt === first.attempt), 'the base ran under the first attempt only');
  assert.deepEqual(laneSpawns(run).filter((s) => s.attempt === second.attempt).map((s) => [s.lane, s.at]), [['lint', salvaged], ['lint', salvaged]]);
  assert.ok(!laneSpawns(run).some((s) => s.lane === 'same' || s.lane === 'e2e'));
  assert.deepEqual(fastCheckouts(run), []);
});

test('lanes.fast-suite-base-is-salvage: a unit whose commit is its base fails on the base by its own run: base-red, nothing run twice', T, async () => {
  const run = setupUnit({ steps: [], lanes: [UNIT], suite: [{ id: 'lint', argv: ['false'] }] });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  const done = started(await lanes(run.ctx, run.unit, run.base));
  assert.equal(done.outcome.kind, 'base-red');
  assert.deepEqual(laneSpawns(run).map((s) => [s.lane, s.set]), [['unit', 'spec'], ['lint', 'suite'], ['lint', 'suite']], 'lint and its diagnostic rerun, once');
});

for (const [specTimeout, suiteTimeout, identical] of [[2, 1, false], [undefined, 360, false], [1, 1, true], [undefined, undefined, true]] as const) {
  test(`lanes.timeout-equality: spec ${specTimeout}, suite ${suiteTimeout}, identical ${identical}`, T, async () => {
    const run = setupUnit({
      steps: [], lanes: [{ ...UNIT, ...(specTimeout === undefined ? {} : { timeoutMin: specTimeout }) }],
      suite: [{ ...SAME, ...(suiteTimeout === undefined ? {} : { timeoutMin: suiteTimeout }) }],
    });
    const spec = loadUnitSpec(run.ctx, run.unit).spec;
    const active = spec.lanes.filter((l) => l.state === 'active');
    const suite = run.ctx.plan().suite.lanes;
    assert.equal(stageSuiteLanes(suite, spec, new Set()).length, identical ? 0 : 1, 'stage dedup respects timeout semantics');
    assert.equal(suiteStandIns(suite, active.map((l) => ({ ...l, reporter: 'jsonl' }))).size, identical ? 1 : 0, 'arc stand-ins respect the same timeout semantics');
    pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
    assert.equal(started(await lanes(run.ctx, run.unit, run.base)).outcome.kind, 'green');
    assert.deepEqual(laneSpawns(run).map((s) => [s.lane, s.set]), identical ? [['unit', 'spec']] : [['unit', 'spec'], ['same', 'suite']]);
  });
}
