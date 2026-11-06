// The integration slot (src/pipeline/integrate.ts) through the unit driver, fake-backed: real processes,
// real git. Named tests: merge.base-red, merge.stale-tip-fresh-candidate; also the transient refusal as a
// scope-growth fix round and a foreign move of integration stopping publication.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { invocationId, resourceName } from '../src/core/ids.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { salvageSummaries } from '../src/pipeline/memory.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import type { Gate } from '../src/pipeline/unit.ts';
import { MUL, U1, appendSteps, codexStep, contextFor, gateStep, isGateCall as isGate, mulBuild, outcomes, setupArc, stepUntil, workDirPattern } from './fixtures/unit-common.ts';

import { writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
/** Every stage admitted at once: the unit runs on its own. */
const live = (): Gate => admitAll;
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
    assert.match(result.needsUser.summary, new RegExp(`alone, without unit u1: lane suite red\\. The base is broken`), 'the item names the suite lane red on T alone');
    assert.equal(outcomes(d).at(-1), 'candidate:base-red');
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'base-red is uncharged');
    assert.equal(git(d.repo, 'rev-parse', 'main'), tip, 'integration never moved');
    const suiteSpawns = intents(d.runDir, 'proc.spawn').flatMap((i) => (i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'suite' ? [i] : []));
    const atOf = (i: (typeof suiteSpawns)[number]): string => (i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' ? i.expect.subject.at : '');
    // The lanes stage's fast suite (stages.ts `fastSuite`) ran first: red at the unit commit, and red again on its diff
    // base T alone, so the lanes stage recorded an uncharged base-red and went on to the gate.
    const unitCommit = r.journal.view.unit(U1).approval!.fingerprint.unitCommit;
    const lanesSpawns = suiteSpawns.filter((i) => i.parent.type === 'stage' && i.parent.stage === 'lanes');
    assert.deepEqual(lanesSpawns.map(atOf), [unitCommit, unitCommit, tip, tip], 'the fast suite red at the unit commit and on T alone, each red lane rerun');
    assert.ok(outcomes(d).includes('lanes:base-red'), outcomes(d).join(' '));
    const suites = suiteSpawns.filter((i) => i.parent.type === 'stage' && i.parent.stage === 'candidate').map(atOf);
    assert.equal(suiteSpawns.length, lanesSpawns.length + suites.length, 'every suite spawn is the lanes stage\'s or the candidate\'s');
    // Each red suite lane is rerun once at its SHA (the red-lane protocol's diagnostic rerun, M2 A10).
    assert.equal(suites.length, 4);
    assert.notEqual(suites[0], tip);
    assert.equal(suites[1], suites[0], 'the candidate\'s red lane was rerun on the candidate');
    assert.deepEqual(suites.slice(2), [tip, tip], 'the second suite series tested T alone, its red lane rerun');
    const candidateTrees = r.journal.view.opsOf('worktree.create').filter((i) => i.parent.type === 'stage' && i.parent.stage === 'candidate');
    assert.ok(candidateTrees.some((i) => i.expect.path.endsWith('/.candidate.verify') && existsSync(i.expect.path)), 'the arc candidate cache survives a base-red park');
    const bases = candidateTrees.filter((i) => i.expect.path.includes('.base-'));
    assert.ok(bases.length > 0 && bases.every((i) => !existsSync(i.expect.path)), 'diagnostic base checkouts are still removed');
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
    const candidates = r.journal.view.opsOf('candidate.merge');
    assert.equal(candidates.length, 2);
    assert.equal(r.journal.view.opsOf('salvage.commit').length, 0, 'the builder committed everything itself');
    for (const i of candidates) assert.equal(i.expect.commit.message, `roadmap ${d.arc}: candidate of unit u1\n\nDid the work.\n`, 'both candidates retain the build summary even without a salvage commit');
  } finally {
    r.journal.close();
  }
});

test('merge.transient-refusal: salvage refuses a transient path and sends the unit to a scope-growth fix round, and the next gate sits on the escalation seat', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'evidence/notes.txt': 'scratch\n' }),
      codexStep([{ type: 'commit', message: 'drop the scratch file', files: { 'evidence/notes.txt': null } }], {
        argv: ['exec', 'resume'], stdinContains: ["The executor refused your last round's commit:", 'evidence/notes.txt (evidence)', 'Remove them from the branch;'],
      }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d), [
      'pre-build:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:transient-violation',
      'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve',
      'candidate:green', 'ff:published', 'snapshot:published',
    ]);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 1, `a transient violation charges: ${outcomes(d).join(' ')}`);
    const gates = readCalls(d.scenarioPath).filter(isGate);
    assert.equal(gates.length, 1, 'the refused salvage never reached a gate');
    assert.ok(gates[0]!.argv.includes('claude-opus-5-5') && gates[0]!.argv.includes('medium'), 'scope growth promoted the next judgment');
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


test('memory: salvage keeps the build report and decisions; candidate concatenates every round in order', T, async () => {
  const d = setupArc({ steps: [] });
  const first = 'Added multiplication. Use the native operator to keep numeric semantics.';
  const second = 'Clarified operand names after review.';
  const decision = 'Use * because it preserves JavaScript number semantics.';
  appendSteps(d, [
    planCheckStep({ decision: 'approve' }),
    { as: 'codex', expect: {}, acts: [
      { type: 'dirty', files: MUL },
      { type: 'writeToPrompt', pattern: workDirPattern(d), file: 'decisions.json', text: JSON.stringify({ decisions: [{ id: 'D1', text: decision }] }) },
      { type: 'emit', value: { ...BUILD_REPORT, summary: first } },
    ] },
    gateStep({ decision: 'revise', findings: [{evidence: ["src/mul.js:1"],  severity: 'blocking', path: 'src/mul.js', text: 'Clarify operand names.', contractRef: null, experiments: [], debt: null }], directives: ['Clarify operand names.'] }),
    { as: 'codex', expect: {}, acts: [
      { type: 'dirty', files: { 'src/mul.js': 'export function mul(left, right) { return left * right; }\n' } },
      { type: 'emit', value: { ...BUILD_REPORT, summary: second } },
    ] },
    gateStep({ decision: 'approve' }),
  ]);
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'evidence' && f.outcome === 'captured');
    // The live evidence can change; both messages must still read the completed snapshot.
    const build = r.journal.view.opsOf('proc.spawn').find((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build')!;
    const liveResult = join(invocationDir(r.ctx.runDir, invocationId(build.op, build.ordinal)), 'result.json');
    const resultBytes = readFileSync(liveResult);
    const result = JSON.parse(resultBytes.toString('utf8'));
    result.outcome.value.summary = 'LIVE SUMMARY MUST NOT LEAK';
    writeFileSync(liveResult, JSON.stringify(result));
    const work = r.journal.view.opsOf('evidence.snapshot').find((i) => i.parent.type === 'stage' && i.parent.stage === 'evidence')!.expect.globs.find((g) => g.endsWith('/**'))!.slice(0, -3);
    writeFileSync(join(d.runDir, work, 'decisions.json'), JSON.stringify({ decisions: [{ id: 'D1', text: 'LIVE DECISION MUST NOT LEAK' }] }));
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    writeFileSync(liveResult, resultBytes); // Restore the runner record before publication verifies its independent hash.
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    const bodies = [first + '\n\nDecisions:\nD1: ' + decision, second];
    assert.deepEqual(salvageSummaries(r.ctx, U1), bodies);
    const salvages = r.journal.view.opsOf('salvage.commit');
    assert.equal(salvages.length, 2);
    for (const [n, i] of salvages.entries()) {
      assert.equal(i.expect.commit.message.split('\n').slice(2).join('\n'), bodies[n] + '\n');
      assert.equal(git(d.repo, 'show', '-s', '--format=%B', i.post.new), i.expect.commit.message.trimEnd());
    }
    const candidate = r.journal.view.opsOf('candidate.merge').at(-1)!;
    assert.equal(candidate.expect.commit.message, `roadmap ${d.arc}: candidate of unit u1\n\n${bodies.join('\n\n')}\n`);
    assert.equal(git(d.repo, 'show', '-s', '--format=%B', 'main'), candidate.expect.commit.message.trimEnd());
  } finally { r.journal.close(); }
});

for (const label of ['salvage.after-commit-tree', 'candidate.after-commit-tree']) {
  test(`memory: ${label} recovery preserves the recorded message and exact commit object`, T, async () => {
    const d = setupArc({ steps: [] });
    appendSteps(d, [planCheckStep({ decision: 'approve' }), codexStep([
      { type: 'dirty', files: MUL },
      { type: 'writeToPrompt', pattern: workDirPattern(d), file: 'decisions.json', text: JSON.stringify({ decisions: [{ id: 'D1', text: 'Use * because it preserves numeric semantics.' }] }) },
    ]), gateStep({ decision: 'approve' })]);
    const trigger = writeTrigger(tmpDir('memory-crash'), { label, occurrence: 1 });
    const env = { ...process.env, ROADMAP_TEST_CRASH: trigger };
    const crashed = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const kind = label.startsWith('salvage') ? 'salvage.commit' : 'candidate.merge';
    const pending = intents(d.runDir, kind).at(-1)!;
    assert.ok(pending.kind === 'salvage.commit' || pending.kind === 'candidate.merge');
    const recorded = pending.expect.commit;
    assert.match(recorded.message, /Did the work\./);
    assert.match(recorded.message, /D1: Use \* because it preserves numeric semantics\./);
    // The act already made the expected object, but has not moved its ref. Force redo to recreate it.
    const objectPath = git(d.repo, 'rev-parse', '--git-common-dir');
    unlinkSync(join(d.repo, objectPath, 'objects', pending.post.new.slice(0, 2), pending.post.new.slice(2)));
    const resumed = await runFixture('stage-child.ts', [JSON.stringify(d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual(JSON.parse(resumed.stdout), { kind: 'merged' });
    const after = intents(d.runDir, kind).find((i) => i.op === pending.op)!;
    assert.deepEqual(after.expect, pending.expect, 'recovery uses the original recorded commit inputs');
    assert.equal(git(d.repo, 'show', '-s', '--format=%B', pending.post.new), recorded.message.trimEnd());
    assert.equal(readCalls(d.scenarioPath).length, 3, 'recovery never reruns the builder or gate');
  });
}

test('entry-is-one-atomic-grant and spec-before-suite-entry', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
  const path = join(d.planPath, '..', plan.units[0].spec);
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  spec.lanes.push({ ...spec.lanes[0], id: 'candidate-spec', cadence: 'candidate', cpu: 1, argv: ['true'] });
  writeFileSync(path, JSON.stringify(spec));
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const grants = r.journal.view.opsOf('resource.transition').filter((i) => i.expect.edge.type === 'reserve' && i.parent.type === 'stage' && i.parent.stage === 'candidate');
    const entry = grants.find((i) => i.expect.resources.includes(resourceName('integration-slot')))!;
    assert.equal(entry.expect.holder.type, 'stage');
    assert.deepEqual(entry.expect.slotHolder, { type: 'publication', unit: U1, attempt: entry.parent.type === 'stage' ? entry.parent.attempt : 0 });
    assert.equal(entry.expect.resources.filter((u) => u.startsWith('@cpu#')).length, 1, 'the first spec lane, rather than the larger suite lane');
    assert.equal(grants.filter((i) => i.expect.holder.type === 'stage').length, 1, 'entry is consumed once; the suite reuses its earlier certified pass');
    const slot = resourceTable(r.journal.view).get(resourceName('integration-slot'))!.status;
    assert.equal(slot.state !== 'free' && slot.holder.type, 'publication');
    assert.ok([...resourceTable(r.journal.view)].filter(([u]) => u.startsWith('@cpu#')).every(([, e]) => e.status.state === 'free'), 'entry CPU never reaches ff/snapshot');
  } finally { r.journal.close(); }
});

for (const moveAt of ['before-grant', 'after-grant'] as const) test(`tip-move-reselects (${moveAt}) and releases replaced entry`, T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
  const lane = plan.suite.lanes[0];
  plan.suite.lanes = [{ ...lane, id: 'selected', argv: ['true'], cadence: 'candidate', systems: ['mul'], cpu: 3 }, { ...lane, id: 'always', argv: ['true'], cadence: 'candidate', cpu: 1 }];
  writeFileSync(d.planPath, JSON.stringify(plan));
  const r = contextFor(d);
  try {
    const acquire = r.ctx.acquire; let moved = false;
    const move = () => {
      const commit = r.journal.view.unit(U1).approval!.fingerprint.unitCommit;
      git(d.repo, 'cherry-pick', commit);
      git(d.repo, 'commit', '--allow-empty', '-m', 'external tip moved');
    };
    const ctx = { ...r.ctx, acquire: (async (request, holder, rank, signal, entry) => {
      const moving = request.publication && !moved;
      if (moving) { moved = true; if (moveAt === 'before-grant') move(); }
      const grant = await acquire(request, holder, rank, signal, entry);
      if (moving && moveAt === 'after-grant') move();
      return grant;
    }) satisfies typeof acquire };
    await stepUntil({ ...r, ctx }, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const facts = (await import('../src/core/log.ts')).readJournal(r.ctx.runDir, r.ctx.plan().arc).events.flatMap((e) => e.type === 'fact' && e.fact.kind === 'candidate-entry-planned' ? [e.fact] : []);
    assert.deepEqual(facts.map((f) => f.request.cpu), [3, 1]);
    const grants = r.journal.view.opsOf('resource.transition').filter((i) => i.expect.edge.type === 'reserve' && i.expect.resources.includes(resourceName('integration-slot')));
    assert.equal(grants.length, moveAt === 'before-grant' ? 1 : 2);
    assert.equal(grants.at(-1)!.expect.resources.filter((u) => u.startsWith('@cpu#')).length, 1);
    assert.equal(r.journal.view.opsOf('candidate.merge').length, 1, 'only the revalidated plan publishes candidate refs');
    assert.ok([...resourceTable(r.journal.view)].filter(([u]) => u.startsWith('@cpu#')).every(([, e]) => e.status.state === 'free'));
  } finally { r.journal.close(); }
});
