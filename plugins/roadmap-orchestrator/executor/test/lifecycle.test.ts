// Unit lifecycle across parks (src/commands/apply.ts `resume`, src/pipeline/{unit,arc}.ts), integrated and
// fake-backed: a unit parked at a judgment stage re-opens after an applied spec revision (`roadmap apply`), the needs-user of a
// park names what `resume` does and its evidence, a unit parked `routing-changed` re-enters without a spec
// edit once its implementer seat's routing is restored, a build whose seat a risk raise moved starts a
// fresh session, and `after` holds a unit until the unit it names is
// settled. Named tests: reopen.plan-check-park, reopen.paused-and-parked, reopen.gate-park-keeps-session,
// reopen.risk-raise-moves-seat, reroute.routing-changed-park, arc.after-waits-for-ack.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CommandContext, type CommandOutcome, applyCommand } from '../src/commands/apply.ts';
import { readReceipt, submitCommand } from '../src/commands/queue.ts';
import { type NeedsUserId, commandId, invocationId, unitId } from '../src/core/ids.ts';
import type { CommandBody, NeedsUserContent } from '../src/core/records.ts';
import { openBlocking, raiseNeedsUser } from '../src/needsuser.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { NO_SESSION_NOTE, RESPEC_DIRECTIVE } from '../src/pipeline/rounds.ts';
import type { StageContext } from '../src/pipeline/dispatch.ts';
import { keptSpecPath } from '../src/pipeline/stages.ts';
import { type Gate, runUnit, step } from '../src/pipeline/unit.ts';
import { absPath } from '../src/core/values.ts';
import { legacyNext } from '../src/core/upgrade.ts';
import { DOCS_NOT_YET } from '../src/recover/revision.ts';
import { arcStack, resolveRouting } from '../src/routing/layers.ts';
import { type RoutingLayer, routingLayer } from '../src/routing/types.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep, testProbes } from './fixtures/stage-common.ts';
import { type ArcRun, MUL, U1, applyBody, codexStep, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';
import { haltItem, receiptOf, startScheduler, submit } from './fixtures/sched-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const U2 = unitId('u2');
/** Every stage admitted at once: the unit runs on its own. */
const live = (): Gate => admitAll;
const STRAIGHT = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

/** The executor's writer for a parked unit's item: parented by the attempt that parked it. */
function raiseParked(r: ArcRun, unit: typeof U1, content: NeedsUserContent): NeedsUserId {
  const f = r.journal.view.unit(unit).decided;
  assert.ok(f !== null);
  return raiseNeedsUser(r.journal, r.ctx.runDir, content, { type: 'stage', unit, stage: f.stage, attempt: f.attempt });
}

/** Submits one command and applies it under `stage`'s routing, as the executor's loop does at a safe point. */
async function command(r: ArcRun, body: CommandBody, stage: StageContext = r.ctx): Promise<Readonly<{ id: string; outcome: CommandOutcome }>> {
  const ctx: CommandContext = {
    ...stage, hostEnv: {}, laneEnv: stage.hostEnv, planFile: absPath(r.d.planPath), routing: () => ({ profile: 'default', resolved: stage.routing(null) }),
    routingBase: { profile: 'default', config: null }, docs: DOCS_NOT_YET,
    probes: testProbes(stage),
  };
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(ctx, file) };
}

const resume = (r: ArcRun, unit = U1, stage: StageContext = r.ctx) => command(r, { type: 'resume', target: { type: 'unit', unit } }, stage);

/** `roadmap apply` of the plan and specs as the files hold them now. */
const apply = (r: ArcRun) => command(r, applyBody(r.d));

/** The run's context under the default profile with `plan` as the plan's routing layer. */
const rerouted = (r: ArcRun, plan: unknown): StageContext => {
  const routing = resolveRouting(arcStack('default', null, routingLayer(plan, 'plan') as RoutingLayer));
  return { ...r.ctx, routing: () => routing };
};

/** Rewrites the unit's spec.json as the architect would: `edit` changes the parsed file. */
function editSpec(r: ArcRun, edit: (spec: Record<string, unknown>) => void, unit = 'u1'): string {
  const path = join(r.ctx.planDir, `${unit}.json`);
  const spec = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(spec);
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

const NEW_CLAUSE = { id: 'A2', clause: 'mul(0, 5) is 0', failLoudIfUndelivered: true, state: 'active' };
const addClause = (spec: Record<string, unknown>): void => {
  spec['acceptance'] = [...(spec['acceptance'] as unknown[]), NEW_CLAUSE];
};

test('reopen.plan-check-park: resume is rejected until a revision of the spec (the next rev) is applied, then re-opens the unit at plan-check (its item acknowledged), which runs to merge on the new spec', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' }),
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), live());
    assert.ok(parked.kind === 'parked');
    // The item says what `resume` does for this park, and names the evidence it refers to (arc-1 feedback items 1, 23).
    const specPath = join(r.ctx.planDir, 'u1.json');
    assert.match(parked.needsUser.recommendation, /set "rev" to 2, run `roadmap apply`, then `roadmap resume u1`/);
    assert.match(parked.needsUser.summary, /at rev 1/);
    const checks = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'planCheck');
    const deciding = checks.at(-1)!;
    assert.deepEqual(parked.needsUser.evidence, [
      join(invocationDir(r.ctx.runDir, invocationId(deciding.op, deciding.ordinal)), 'result.json'),
      join(invocationDir(r.ctx.runDir, invocationId(deciding.op, deciding.ordinal)), 'stdout'),
      keptSpecPath(r.ctx, r.unit('u1')),
    ], 'the spec in force as kept, not the live file');
    assert.equal(readFileSync(keptSpecPath(r.ctx, r.unit('u1')), 'utf8'), readFileSync(specPath, 'utf8'), 'unedited so far: the same bytes');
    const item = raiseParked(r, U1, parked.needsUser);

    const noRevision = { kind: 'rejected', reason: `unit u1 is parked (escalation); edit its spec ${specPath} (rev 1), set rev 2, run \`roadmap apply\`, then resume` };
    assert.deepEqual((await resume(r)).outcome, noRevision);
    // Evidence plumbing may change at the same rev (applied at once); it is still not a revision resume can re-open on.
    editSpec(r, (s) => void (s['lanes'] = (s['lanes'] as Record<string, unknown>[]).map((l) => ({ ...l, evidenceGlobs: ['out/**'], evidenceExcludes: ['out/secret/**'] }))));
    assert.equal((await apply(r)).outcome.kind, 'applied');
    assert.deepEqual((await resume(r)).outcome, noRevision);
    editSpec(r, addClause);
    assert.deepEqual((await apply(r)).outcome, {
      kind: 'rejected',
      reason: `apply rejected (1 reason): (1) unit u1: its spec ${specPath} changed but is still at rev 1; a revision sets rev 2 (lane evidenceGlobs and evidenceExcludes may change at the current rev)`,
    });
    editSpec(r, (s) => void (s['rev'] = 3));
    assert.deepEqual((await apply(r)).outcome, {
      kind: 'rejected', reason: `apply rejected (1 reason): (1) unit u1: its spec ${specPath} is at rev 3, but the unit's recorded rev is 1; a revision sets rev 2`,
    });
    assert.deepEqual((await resume(r)).outcome, noRevision);
    assert.equal(r.journal.view.unit(U1).status, 'park-pending', 'a rejected apply or resume changes nothing');

    editSpec(r, (s) => void (s['rev'] = 2));
    assert.deepEqual((await resume(r)).outcome, {
      kind: 'rejected', reason: `unit u1 is parked (escalation); its spec ${specPath} is at rev 2 but not applied: run \`roadmap apply\`, then resume`,
    }, 'a revision edited but not applied: the rejection says to apply it');
    assert.equal((await apply(r)).outcome.kind, 'applied');
    assert.equal(r.journal.view.unit(U1).status, 'park-pending', 'an applied revision of a parked unit waits for the resume');
    const reopened = await resume(r);
    assert.equal(reopened.outcome.kind, 'applied');
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.stage, u.decided, u.reopened?.specRev], ['active', 'plan-check', null, 2]);
    assert.equal(r.journal.view.ackOf(item)?.command, reopened.id, 'the park\'s item is acknowledged by the resume');
    assert.deepEqual(openBlocking(r.journal.view), []);
    assert.deepEqual(await resume(r).then((x) => x.outcome.kind), 'applied', 'a second resume of the running unit is a no-op');

    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), ['plan-check:escalate', 'plan-check:escalate', ...STRAIGHT]);
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls[2]!.stdin.includes('mul(0, 5) is 0'), 'the re-opened plan-check reads the edited spec');
    assert.equal(r.journal.view.unit(U1).approval?.fingerprint.specRev, 2);
    assert.equal(r.journal.view.unit(U1).counters.attempts, STRAIGHT.length + 3, 'the counters of the parked run are kept');
    assert.ok(calls.every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('reopen.paused-and-parked: one resume of a unit both paused and parked clears the pause and re-opens it; while the park cannot re-open, it clears the pause alone', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' })] });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), live());
    assert.ok(parked.kind === 'parked');
    const item = raiseParked(r, U1, parked.needsUser);
    const pause = () => command(r, { type: 'pause', target: { type: 'unit', unit: U1 } });
    const specPath = join(r.ctx.planDir, 'u1.json');

    assert.equal((await pause()).outcome.kind, 'applied');
    const unpaused = await resume(r);
    assert.equal(unpaused.outcome.kind, 'applied');
    const receipt = readReceipt(r.ctx.runDir, commandId(unpaused.id), 'applied');
    assert.deepEqual(receipt?.state === 'applied' ? receipt.verified : receipt, [
      'unit u1 unpaused', `unit u1 still parked: unit u1 is parked (escalation); edit its spec ${specPath} (rev 1), set rev 2, run \`roadmap apply\`, then resume`,
    ]);
    assert.deepEqual(r.journal.view.control().pausedUnits, []);
    assert.equal(r.journal.view.unit(U1).status, 'park-pending');

    assert.equal((await pause()).outcome.kind, 'applied');
    editSpec(r, (s) => {
      addClause(s);
      s['rev'] = 2;
    });
    assert.equal((await apply(r)).outcome.kind, 'applied');
    const both = await resume(r);
    assert.equal(both.outcome.kind, 'applied');
    assert.deepEqual(r.journal.view.control().pausedUnits, [], 'the pause is cleared');
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.stage, u.decided, u.reopened?.specRev, u.reopened?.command], ['active', 'plan-check', null, 2, both.id], 'and the unit re-opened');
    assert.equal(r.journal.view.ackOf(item)?.command, both.id);
  } finally {
    r.journal.close();
  }
});

test('reopen.gate-park-keeps-session: a unit parked at the gate re-opens after an applied spec revision; its next build resumes the implementer session, told the spec was amended, in the kept worktree', T, async () => {
  const thread = '00000000-0000-4000-8000-00000000abcd';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { ...codexStep([{ type: 'commit', message: 'add mul', files: MUL }], { argv: ['exec', '-C'] }), threadId: thread } as Step,
      gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
      planCheckStep({ decision: 'approve' }),
      codexStep([], { argv: ['exec', 'resume', thread], stdinContains: [RESPEC_DIRECTIVE, 'mul(0, 5) is 0'] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), live());
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'escalation');
    assert.match(parked.needsUser.recommendation, /roadmap resume u1/);
    raiseParked(r, U1, parked.needsUser);
    editSpec(r, (s) => {
      addClause(s);
      s['rev'] = 2;
    });
    assert.equal((await apply(r)).outcome.kind, 'applied');
    assert.equal((await resume(r)).outcome.kind, 'applied');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), [...STRAIGHT.slice(0, 7), 'gate:escalate', 'gate:escalate', ...STRAIGHT]);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'the build after the reopen resumed the session');
  } finally {
    r.journal.close();
  }
});

test('reopen.risk-raise-moves-seat: a re-opened unit whose plan-check raises the risk onto another implementer binding builds in a fresh session on the kept branch, told the spec was amended and that the worktree holds the earlier work', T, async () => {
  const thread = '00000000-0000-4000-8000-00000000cafe';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { ...codexStep([{ type: 'commit', message: 'add mul', files: MUL }], { argv: ['exec', '-C'] }), threadId: thread } as Step,
      gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
      planCheckStep({ decision: 'approve', risk: 'high' }),
      {
        as: 'claude',
        expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'], argvLacks: ['--resume'], stdinContains: [RESPEC_DIRECTIVE, NO_SESSION_NOTE, 'mul(0, 5) is 0'] },
        acts: [{ type: 'emit', value: BUILD_REPORT }],
      },
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), live());
    assert.ok(parked.kind === 'parked');
    raiseParked(r, U1, parked.needsUser);
    editSpec(r, (s) => {
      addClause(s);
      s['rev'] = 2;
    });
    assert.equal((await apply(r)).outcome.kind, 'applied');
    assert.equal((await resume(r)).outcome.kind, 'applied');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), [...STRAIGHT.slice(0, 7), 'gate:escalate', 'gate:escalate', ...STRAIGHT]);
    const [first, raised] = r.journal.view.dispatchesOf(U1);
    assert.deepEqual([first?.riskFloor, raised?.riskFloor], ['med', 'high']);
    assert.notEqual(raised?.implementerSeatRev, first?.implementerSeatRev, 'the raise moved the implementer seat');
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls.every((c) => c.step !== null), 'the build after the raise was a fresh Claude session, not a resume of the Codex thread');
    assert.ok(!calls.some((c) => c.as === 'codex' && c.argv.includes('resume')));
  } finally {
    r.journal.close();
  }
});

test('reroute.routing-changed-park: resume is rejected while the implementer seat stays moved; once its routing is restored, resume re-pins the unit and re-enters it at the stage it parked at, no spec edit', T, async () => {
  const thread = '00000000-0000-4000-8000-00000000beef';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { ...codexStep([{ type: 'commit', message: 'add mul', files: MUL }], { argv: ['exec', '-C'] }), threadId: thread } as Step,
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
    const moved = rerouted(r, { build: { med: 'frontier' } });
    const s = await step(moved, r.unit('u1'));
    assert.ok(s.kind === 'parked' && s.needsUser.reason === 'routing-changed');
    assert.match(s.needsUser.recommendation, /^Restore the routing of build\.med or re-enter the unit under a new id\./);
    const item = raiseParked(r, U1, s.needsUser);
    const pinned = r.journal.view.dispatchOf(U1)!;

    const rejected = await resume(r, U1, moved);
    assert.deepEqual(rejected.outcome, { kind: 'rejected', reason: 'unit u1 is parked (routing-changed) at gate: restore the routing of build.med or re-enter the unit under a new id' });
    assert.equal(r.journal.view.unit(U1).status, 'park-pending', 'a rejected resume changes nothing');

    // The architect restores build.med; another seat keeps its new class, so the rev still differs.
    const restored = rerouted(r, { gate: { med: 'summit' } });
    assert.notEqual(restored.routing(null).rev, pinned.routingRev);
    const resumed = await resume(r, U1, restored);
    assert.equal(resumed.outcome.kind, 'applied');
    const repinned = r.journal.view.dispatchOf(U1)!;
    assert.deepEqual([repinned.routingRev, repinned.implementerSeatRev, repinned.riskFloor], [restored.routing(null).rev, pinned.implementerSeatRev, 'med']);
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.stage, u.decided?.stage, u.decided?.outcome, u.reopened], ['active', 'gate', 'lanes', 'green', null]);
    assert.equal(r.journal.view.ackOf(item)?.command, resumed.id, 'the park\'s item is acknowledged by the resume');

    assert.deepEqual(await runUnit(restored, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d), [...STRAIGHT.slice(0, 7), 'gate:routing-changed', ...STRAIGHT.slice(7)]);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('arc.after-waits-for-ack: on a legacy arc a unit with `after` is not dispatched while the unit it names is parked with its item open; the ack releases it', T, async () => {
  const d = setupArc({
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    steps: [planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
  });
  const r = contextFor(d);
  try {
    // A legacy arc (dev.4's serial frontier, G4): the scheduler raises u1's item and then waits at u2.
    const s = startScheduler(r);
    const item = await haltItem(r, U1);
    // Several scheduler polls later u2 is still undispatched: the frontier holds it after u1.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(r.journal.view.dispatchOf(U2), null, 'no dispatch fact for the held unit');
    assert.equal(r.journal.view.unit(U2).counters.attempts, 0);
    assert.deepEqual(legacyNext(r.journal.view, r.ctx.plan().units), { unit: U2, block: 'unit u2 is held after u1' });
    assert.equal(readCalls(d.scenarioPath).length, 2);

    assert.equal((await receiptOf(r, submit(r, { type: 'ack', needsUser: item, choice: null }))).state, 'applied');
    // The ack releases u2, which runs to merge; the arc is then complete.
    const done = await s.end;
    assert.ok(done.kind === 'complete', JSON.stringify(done));
    assert.deepEqual(done.units.map((u) => [u.unit, u.result]), [['u1', 'parked'], ['u2', 'merged']]);
    assert.deepEqual(outcomes(d, 'u2'), STRAIGHT);
  } finally {
    r.journal.close();
  }
});
