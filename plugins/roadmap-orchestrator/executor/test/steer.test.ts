// `roadmap steer` (src/commands/steer.ts) and its steer pass (src/pipeline/{unit,rounds,transitions}.ts), integrated and
// fake-backed over a unit-common arc: a unit parked by two gate escalations is steered through the command path; its
// steer round is a fresh, uncharged implementer session on the brief with the budget as its window; the pass exits by
// the table's steer rows; a judgment after it is always a fresh session; the command's rejections and its `--class`
// revision, written back to the live plan file only while it holds the plan in force before it; and the crash cells of
// the matrix row STEER, recovered by the recovery engine (src/recover/recover.ts).
// Named tests: steer.round-uncharged, steer.resume-vs-park, steer.never-judge, steer.rejections, steer.class,
// steer.class-write-back, steer.class-architect-edit, steer.crash-cells.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type CommandOutcome, applyCommand } from '../src/commands/apply.ts';
import { readReceipt, submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type CommandId, type NeedsUserId, arcId, commandId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody, NeedsUserContent } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { BRIEF_INPUT, STEER_DIRECTIVE } from '../src/pipeline/rounds.ts';
import { keptInput } from '../src/input/inforce.ts';
import { openBlocking, raiseNeedsUser } from '../src/needsuser.ts';
import type { StageContext } from '../src/pipeline/dispatch.ts';
import { type Gate, runUnit, step } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { bytesSha256, fileSha256 } from '../src/spec/spec.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type CallRecord, type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { followingContext, unitInForce } from './fixtures/steer-common.ts';
import { type ArcDescriptor, type ArcRun, U1, applyBody, codexStep, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';
import { STEER, crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = (): Gate => admitAll;
const MIN_MS = 60_000;
const BRIEF = 'STEER-BRIEF-MARKER: keep mul as it is and document it in one comment.';

/** Plan-check, build, lanes green, then two gate escalations: the unit parks (escalation) after its build. */
const TO_PARK: readonly Step[] = [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' })];
const STRAIGHT_TO_GATE = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green'];
/** The steer pass's chain after its build, up to its lanes. */
const PASS_TO_LANES = ['build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'];

/** The steer round on the default seat (build.med efficient = Codex): a fresh `exec`, never `exec resume`, on the brief. */
const codexSteer = (acts: Parameters<typeof codexStep>[0] = [], threadId?: string): Step => ({
  ...codexStep(acts, { argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: [STEER_DIRECTIVE, BRIEF] }),
  ...(threadId === undefined ? {} : { threadId }),
}) as Step;

/** The steer round on `frontier` (Claude): a fresh implementer session, never `--resume`, on the brief. */
const claudeSteer: Step = {
  as: 'claude',
  expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'], argvLacks: ['--resume'], stdinContains: [STEER_DIRECTIVE, BRIEF] },
  acts: [{ type: 'emit', value: BUILD_REPORT }],
};

/** The executor's writer for a parked unit's item: parented by the attempt that parked it. */
function raiseParked(r: ArcRun, content: NeedsUserContent): NeedsUserId {
  const f = r.journal.view.unit(U1).decided;
  assert.ok(f !== null);
  return raiseNeedsUser(r.journal, r.ctx.runDir, content, { type: 'stage', unit: U1, stage: f.stage, attempt: f.attempt });
}

/** Drives u1 to its escalation park and raises the park's item, as the scheduler would. */
async function parkU1(r: ArcRun): Promise<NeedsUserId> {
  const parked = await runUnit(r.ctx, r.unit('u1'), live());
  assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'escalation', JSON.stringify(parked));
  return raiseParked(r, parked.needsUser);
}

/** A brief file, hashed as the CLI hashes it. */
function writeBrief(text = BRIEF): Readonly<{ path: ReturnType<typeof absPath>; sha256: ReturnType<typeof bytesSha256> }> {
  const path = absPath(join(tmpDir('steer-brief'), 'brief.md'));
  writeFileSync(path, text);
  return { path, sha256: bytesSha256(Buffer.from(text)) };
}

type SteerOpts = Readonly<{ budgetMin?: number; cls?: 'frontier' | null; resume?: boolean; brief?: ReturnType<typeof writeBrief> }>;

function steerBody(o: SteerOpts = {}): CommandBody {
  return { type: 'steer', unit: U1, brief: o.brief ?? writeBrief(), budgetMin: o.budgetMin ?? 7, class: o.cls ?? null, resume: o.resume ?? false };
}

/** Submits one command and applies it under `stage`, as the executor's loop does at a safe point. */
async function command(r: ArcRun, body: CommandBody, stage: StageContext = r.ctx): Promise<Readonly<{ id: CommandId; outcome: CommandOutcome }>> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r, stage), file) };
}

function facts(d: ArcDescriptor): readonly Fact[] {
  return readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
}
const steeredFacts = (d: ArcDescriptor) => facts(d).filter((f) => f.kind === 'steered');

const charged = (r: ArcRun) => {
  const c = r.journal.view.unit(U1).counters;
  return { chargeableFailures: c.chargeableFailures, reviseRounds: c.reviseRounds, candidateReds: c.candidateReds };
};

const buildSpawns = (r: ArcRun) => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');

const argAfter = (c: CallRecord, flag: string): string | undefined => (c.argv.includes(flag) ? c.argv[c.argv.indexOf(flag) + 1] : undefined);

/** u1's `build.med` seat in the live plan file, as the architect's next `apply` would read it. */
const fileSeat = (d: ArcDescriptor): unknown =>
  (JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: { id: string; routing?: { build?: { med?: string } } }[] }).units.find((u) => u.id === 'u1')?.routing?.build?.med;

/** The applied receipt's `verified` of a command. */
const verifiedOf = (r: ArcRun, id: CommandId): readonly string[] => {
  const receipt = readReceipt(r.ctx.runDir, id, 'applied');
  assert.ok(receipt?.state === 'applied', JSON.stringify(receipt));
  return receipt.verified;
};

test('steer.round-uncharged: a parked unit steered through the command path runs one fresh, uncharged implementer round on the brief with the budget as its window; its steer exit park charges nothing', T, async () => {
  const d = setupArc({ steps: [...TO_PARK, codexSteer(), gateStep({ decision: 'revise', directives: ['name the helper better'] })] });
  const r = contextFor(d);
  try {
    const item = await parkU1(r);
    const before = charged(r);
    const approvalBefore = r.journal.view.unit(U1).approval;
    const buildsBefore = buildSpawns(r).length;

    const t0 = Date.now();
    const steered = await command(r, steerBody({ budgetMin: 7 }));
    assert.equal(steered.outcome.kind, 'applied', JSON.stringify(steered.outcome));
    assert.equal(r.journal.view.ackOf(item)?.command, steered.id, 'the park\'s needs-user is acknowledged by the steer');
    assert.deepEqual(openBlocking(r.journal.view), []);
    const s = steeredFacts(d);
    assert.equal(s.length, 1);
    const s0 = s[0];
    assert.ok(s0?.kind === 'steered');
    assert.deepEqual([s0.unit, s0.command, s0.budgetMin, s0.resume, s0.brief], [U1, steered.id, 7, false, bytesSha256(Buffer.from(BRIEF))]);
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.entry?.kind, u.park, u.approval], ['active', 'steer', null, null], `the approval before the steer (${JSON.stringify(approvalBefore)}) is gone`);

    // The steer round: one build.
    const round = await step(r.ctx, r.unit('u1'));
    const t1 = Date.now();
    assert.equal(round.kind, 'continue', JSON.stringify(round));
    assert.equal(outcomes(d).at(-1), 'build:success');
    const calls = readCalls(d.scenarioPath);
    const call = calls.at(-1)!;
    assert.equal(call.as, 'codex');
    assert.notEqual(call.step, null, `the steer call matched its step (fresh, the brief and the directive in its prompt): ${JSON.stringify(call.argv)}`);
    assert.ok(!call.argv.includes('resume'), 'a fresh session, not `exec resume`');
    assert.ok(call.stdin.includes(STEER_DIRECTIVE) && call.stdin.includes(BRIEF));
    const spawns = buildSpawns(r);
    assert.equal(spawns.length, buildsBefore + 1);
    const deadline = Date.parse(spawns.at(-1)!.deadlineAt!);
    assert.ok(deadline >= t0 + 7 * MIN_MS - 1_000 && deadline <= t1 + 7 * MIN_MS + 1_000, `the window is the 7 min budget, not the fresh build's: ${spawns.at(-1)!.deadlineAt} (t0 ${new Date(t0).toISOString()})`);
    assert.deepEqual(charged(r), before, 'the steer round charges nothing');

    // The pass goes on to lanes and gate; the gate revises, which parks `steered` (no fix round), uncharged.
    const parked = await runUnit(r.ctx, r.unit('u1'), live());
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'steered', JSON.stringify(parked));
    assert.deepEqual(outcomes(d), [...STRAIGHT_TO_GATE, 'gate:escalate', 'gate:escalate', ...PASS_TO_LANES, 'lanes:green', 'gate:revise']);
    const decided = r.journal.view.unit(U1).decided;
    assert.deepEqual([decided?.class, decided?.chargeable], ['park', false]);
    assert.deepEqual(charged(r), before, 'the steer exit park charges nothing');
    assert.equal(readCalls(d.scenarioPath).length, calls.length + 1, 'no fix round after the revise');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

describe('steer.resume-vs-park', () => {
  test('steer.resume-vs-park: without --resume a green pass parks `steered` before any candidate; `resume u1` re-runs the gate (a fresh judgment), which approves, and the unit merges', T, async () => {
    const d = setupArc({ steps: [...TO_PARK, codexSteer(), gateStep({ decision: 'approve' }), gateStep({ decision: 'approve' })] });
    const r = contextFor(d);
    try {
      await parkU1(r);
      const before = charged(r);
      assert.equal((await command(r, steerBody({ budgetMin: 5 }))).outcome.kind, 'applied');
      const parked = await runUnit(r.ctx, r.unit('u1'), live());
      assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'steered', JSON.stringify(parked));
      assert.match(parked.needsUser.recommendation, /roadmap resume u1/);
      const decided = r.journal.view.unit(U1).decided;
      assert.deepEqual([decided?.stage, decided?.outcome, decided?.class, decided?.chargeable], ['gate', 'approve', 'park', false]);
      assert.deepEqual(decided?.park, { class: 'operator', kind: 'env' }, 'operator env');
      assert.ok(!outcomes(d).some((o) => o.startsWith('candidate:')), 'no candidate');
      assert.deepEqual(charged(r), before);
      const item = raiseParked(r, parked.needsUser);

      const resumed = await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } });
      assert.equal(resumed.outcome.kind, 'applied', JSON.stringify(resumed.outcome));
      assert.equal(r.journal.view.ackOf(item)?.command, resumed.id);
      const gatesBefore = readCalls(d.scenarioPath).length;
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
      assert.deepEqual(outcomes(d), [
        ...STRAIGHT_TO_GATE, 'gate:escalate', 'gate:escalate', ...PASS_TO_LANES, 'lanes:green', 'gate:approve',
        'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published',
      ]);
      const calls = readCalls(d.scenarioPath);
      assert.equal(calls.length, gatesBefore + 1, 'the resume re-ran the gate once');
      assert.ok(calls.every((c) => c.step !== null), 'the re-run gate was a fresh judgment (its step checks `--session-id`, no `--resume`)');
    } finally {
      r.journal.close();
    }
  });

  test('steer.resume-vs-park: with --resume a green pass goes on to the candidate and merges without a park', T, async () => {
    const d = setupArc({ steps: [...TO_PARK, codexSteer(), gateStep({ decision: 'approve' })] });
    const r = contextFor(d);
    try {
      await parkU1(r);
      const before = charged(r);
      assert.equal((await command(r, steerBody({ budgetMin: 5, resume: true }))).outcome.kind, 'applied');
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
      assert.deepEqual(outcomes(d), [
        ...STRAIGHT_TO_GATE, 'gate:escalate', 'gate:escalate', ...PASS_TO_LANES, 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published',
      ]);
      assert.deepEqual(charged(r), before);
      assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
    } finally {
      r.journal.close();
    }
  });

  test('steer.resume-vs-park: lanes red during the pass park `steered`: no fix round, uncharged', T, async () => {
    const broken = { 'src/mul.js': 'export function mul(a, b) {\n  return a + b;\n}\n' };
    const d = setupArc({ steps: [...TO_PARK, codexSteer([{ type: 'commit', message: 'steer: break mul', files: broken }])] });
    const r = contextFor(d);
    try {
      await parkU1(r);
      const before = charged(r);
      assert.equal((await command(r, steerBody({ budgetMin: 5, resume: true }))).outcome.kind, 'applied');
      const parked = await runUnit(r.ctx, r.unit('u1'), live());
      assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'steered', JSON.stringify(parked));
      assert.deepEqual(outcomes(d), [...STRAIGHT_TO_GATE, 'gate:escalate', 'gate:escalate', ...PASS_TO_LANES, 'lanes:red']);
      const decided = r.journal.view.unit(U1).decided;
      assert.deepEqual([decided?.class, decided?.chargeable], ['park', false]);
      assert.deepEqual(charged(r), before);
      const calls = readCalls(d.scenarioPath);
      assert.equal(calls.at(-1)?.as, 'codex', 'no call after the steer round: no fix round');
      assert.ok(calls.every((c) => c.step !== null));
    } finally {
      r.journal.close();
    }
  });
});

test('steer.never-judge: the gate after a steer round is a fresh judgment session whose id is new, not the steer round\'s implementer session', T, async () => {
  // The steer round on Claude (`--class frontier`), so both sessions are Claude session ids.
  const d = setupArc({ steps: [...TO_PARK, claudeSteer, gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await parkU1(r);
    const f = followingContext(r);
    assert.equal((await command(r, steerBody({ cls: 'frontier', resume: true }), f)).outcome.kind, 'applied');
    assert.deepEqual(await runUnit(f, unitInForce(f, 'u1'), live()), { kind: 'merged' });
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls.every((c) => c.step !== null));
    const steerCall = calls.findIndex((c) => c.stdin.includes(STEER_DIRECTIVE));
    assert.ok(steerCall >= 0);
    const implementerSession = argAfter(calls[steerCall]!, '--session-id');
    const gate = calls[steerCall + 1]!;
    assert.ok(!gate.argv.includes('--resume'), 'the gate resumes no session');
    const gateSession = argAfter(gate, '--session-id');
    assert.ok(implementerSession !== undefined && gateSession !== undefined);
    assert.notEqual(gateSession, implementerSession, 'the gate never judges in the steer round\'s session');
    const earlier = calls.slice(0, steerCall).flatMap((c) => argAfter(c, '--session-id') ?? []);
    assert.ok(!earlier.includes(gateSession), 'a new session id, no earlier call\'s');
  } finally {
    r.journal.close();
  }
});

test('steer.rejections: an active unit, and a brief whose bytes changed after hashing, are rejected with no steered fact', T, async () => {
  const d = setupArc({ steps: TO_PARK });
  const r = contextFor(d);
  try {
    // Active: the unit has built and is not parked.
    const built = await step(r.ctx, r.unit('u1'));
    assert.equal(built.kind, 'continue');
    await step(r.ctx, r.unit('u1'));
    assert.equal(outcomes(d).at(-1), 'build:success');
    const active = await command(r, steerBody());
    assert.deepEqual(active.outcome, { kind: 'rejected', reason: 'unit u1 is active: only a parked unit, or a re-entry prepared and not yet started, can be steered' });
    assert.deepEqual(steeredFacts(d), []);

    await parkU1(r);
    const brief = writeBrief();
    writeFileSync(brief.path, `${BRIEF} (edited after the CLI hashed it)`);
    const changed = await command(r, steerBody({ brief }));
    assert.deepEqual(changed.outcome, { kind: 'rejected', reason: `the brief ${brief.path} changed since the command hashed it` });
    assert.deepEqual(steeredFacts(d), []);
    assert.equal(r.journal.view.unit(U1).status, 'park-pending', 'a rejected steer changes nothing');
    assert.equal(readdirSync(join(d.runDir, 'inputs')).filter((n) => n.endsWith(`.${BRIEF_INPUT}`)).length, 0, 'no brief kept');
  } finally {
    r.journal.close();
  }
});

test('steer.class: `--class frontier` on a parked unit commits a plan revision routing u1, and the steer round runs fresh on the new seat (Claude)', T, async () => {
  const d = setupArc({ steps: [...TO_PARK, claudeSteer] });
  const r = contextFor(d);
  try {
    await parkU1(r);
    const f = followingContext(r);
    assert.equal(f.routing(U1).rev, r.ctx.routing(null).rev, 'before the revision u1 routes as the arc');
    const steered = await command(r, steerBody({ cls: 'frontier' }), f);
    assert.equal(steered.outcome.kind, 'applied', JSON.stringify(steered.outcome));
    const applied = facts(d).filter((x) => x.kind === 'plan-applied' && x.command === steered.id);
    assert.equal(applied.length, 1);
    assert.ok(applied[0]!.kind === 'plan-applied');
    assert.ok(applied[0].changes.some((c) => c.type === 'routing' && c.unit === U1), JSON.stringify(applied[0].changes));
    assert.equal(unitInForce(f, 'u1').routing?.build?.med, 'frontier');
    assert.notEqual(f.routing(U1).rev, r.ctx.routing(null).rev);
    assert.equal(steeredFacts(d).length, 1);

    const round = await step(f, unitInForce(f, 'u1'));
    assert.equal(round.kind, 'continue', JSON.stringify(round));
    assert.equal(outcomes(d).at(-1), 'build:success');
    const call = readCalls(d.scenarioPath).at(-1)!;
    assert.equal(call.as, 'claude', 'the steer round runs on the new seat');
    assert.notEqual(call.step, null, `a fresh Claude implementer session on the brief: ${JSON.stringify(call.argv)}`);
  } finally {
    r.journal.close();
  }
});

test('steer.class-write-back: the class revision is written back to the unchanged live plan file, and a later apply of that file keeps the layer', T, async () => {
  const d = setupArc({ steps: TO_PARK });
  const r = contextFor(d);
  try {
    await parkU1(r);
    const f = followingContext(r);
    const before = r.journal.view.planApplied();
    assert.ok(before !== null);
    assert.equal(fileSha256(absPath(d.planPath)), before.planSha256, 'the live file holds the plan in force');
    const steered = await command(r, steerBody({ cls: 'frontier' }), f);
    const applied = r.journal.view.planAppliedBy(steered.id);
    assert.ok(applied !== null);
    const verified = verifiedOf(r, steered.id);
    assert.ok(verified.includes(`plan file ${d.planPath} written back: it holds plan rev ${applied.rev}`), JSON.stringify(verified));
    assert.equal(fileSha256(absPath(d.planPath)), applied.planSha256, 'the live file holds the class revision');
    assert.equal(fileSeat(d), 'frontier');

    const again = await command(r, applyBody(d), f);
    assert.equal(again.outcome.kind, 'applied', JSON.stringify(again.outcome));
    assert.equal(r.journal.view.planApplied()?.rev, applied.rev, 'the unchanged file is the plan in force: no revision');
    assert.equal(unitInForce(f, 'u1').routing?.build?.med, 'frontier', 'the layer stays');
  } finally {
    r.journal.close();
  }
});

test('steer.class-architect-edit: a live plan file the architect changed since the plan in force is left alone, and the receipt says so', T, async () => {
  const d = setupArc({ steps: TO_PARK });
  const r = contextFor(d);
  try {
    await parkU1(r);
    const f = followingContext(r);
    const before = r.journal.view.planApplied();
    assert.ok(before !== null);
    // The architect's edit in progress: the same plan, reformatted.
    const edited = `${JSON.stringify(JSON.parse(readFileSync(d.planPath, 'utf8')))}\n`;
    writeFileSync(d.planPath, edited);
    assert.notEqual(fileSha256(absPath(d.planPath)), before.planSha256);
    const steered = await command(r, steerBody({ cls: 'frontier' }), f);
    const applied = r.journal.view.planAppliedBy(steered.id);
    assert.ok(applied !== null);
    assert.equal(unitInForce(f, 'u1').routing?.build?.med, 'frontier', 'the revision is in force');
    const text = `plan file ${d.planPath} left alone: it changed since plan rev ${before.rev}, so it does not hold plan rev ${applied.rev}'s routing, and an apply of it as it is drops that`;
    const verified = verifiedOf(r, steered.id);
    assert.ok(verified.includes(text), JSON.stringify(verified));
    assert.equal(readFileSync(d.planPath, 'utf8'), edited, 'the architect\'s file is untouched');
    assert.equal(fileSeat(d), undefined);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Crash cells

describe(`matrix row ${STEER}`, () => {
  const cells = crashCells(STEER);

  test('steer.crash-cells: lists the steer\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), [
      'B2 command.apply.before-effect', 'B3 revision.commit.after-intent', 'B3 revision.commit.after-fact', 'B4 command.apply.after-effect', 'B4 command.apply.after-receipt',
    ]);
  });

  for (const cell of cells) {
    test(`steer.crash-cells ${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const d = setupArc({ steps: TO_PARK });
      const setup = contextFor(d);
      const item = await parkU1(setup);
      const brief = writeBrief();
      const file = submitCommand(setup.ctx.runDir, setup.ctx.plan().arc, steerBody({ cls: 'frontier', budgetMin: 5, brief }));
      setup.journal.close();

      const trigger = writeTrigger(tmpDir('steer-crash'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('steer-child.ts', [JSON.stringify(d), file.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stderr ${exit.stderr}`);
      assertFired(trigger);

      const r = contextFor(d);
      try {
        assert.equal(r.journal.view.openIntents().filter((i) => i.kind === 'command.apply').length, 1, 'the command\'s op is open');
        assert.equal(terminalReceipt(r.ctx.runDir, file.id)?.state, cell.label === 'command.apply.after-receipt' ? 'applied' : undefined);
        const f = followingContext(r);
        await recover({ stage: f, commands: commandContextFor(r, f) });

        assert.deepEqual(r.journal.view.openIntents(), [], 'no open intents');
        const receipt = readReceipt(r.ctx.runDir, commandId(file.id), 'applied');
        assert.equal(receipt?.state, 'applied', 'the applied receipt');
        const steered = steeredFacts(d);
        assert.equal(steered.length, 1, 'exactly one steered fact');
        const s0 = steered[0];
        assert.ok(s0?.kind === 'steered' && s0.command === file.id);
        const applied = facts(d).filter((x) => x.kind === 'plan-applied' && x.command === file.id);
        assert.equal(applied.length, 1, 'exactly one plan-applied from the command');
        assert.ok(applied[0]!.kind === 'plan-applied' && applied[0].changes.some((c) => c.type === 'routing' && c.unit === U1));
        assert.equal(unitInForce(f, 'u1').routing?.build?.med, 'frontier');
        assert.equal(fileSha256(absPath(d.planPath)), applied[0].planSha256, 'the class revision written back to the live plan file, once');
        const briefs = readdirSync(join(d.runDir, 'inputs')).filter((n) => n.endsWith(`.${BRIEF_INPUT}`));
        assert.deepEqual(briefs, [`${brief.sha256}.${BRIEF_INPUT}`], 'one kept brief');
        assert.equal(keptInput(r.ctx.runDir, brief.sha256, BRIEF_INPUT)?.toString('utf8'), BRIEF);
        const dest = join(d.runDir, 'evidence', 'u1', `steer-${file.id}`);
        const snapshots = r.journal.view.opsOf('evidence.snapshot').filter((i) => i.expect.dest === dest);
        assert.equal(snapshots.length, 1, 'one pre-steer evidence snapshot');
        assert.notEqual(r.journal.view.doneOf(snapshots[0]!.op), null);
        assert.equal(r.journal.view.ackOf(item)?.command, file.id, 'the park\'s item acknowledged by the steer');
        // The unit then runs its one steer round.
        const u = r.journal.view.unit(U1);
        assert.deepEqual([u.status, u.entry?.kind], ['active', 'steer']);
      } finally {
        r.journal.close();
      }
    });
  }
});
