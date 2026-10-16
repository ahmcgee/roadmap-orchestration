// M4b B1: the flow job and its track over real arcs (real git, real processes, the fake claude answering flow calls by
// job). Named tests: flow.job-proposal-item (trigger → job → ended → item, once per proposal), flow.host-and-dropped,
// flow.invalid-retry, flow.verdict-at-completion, flow.track-non-holistic (the track on an arc without the holistic layer, the series right before
// arc-completed), flow.off-dev7, flow.ruler-changed (and its pure reading), and the crash cells of the matrix rows FLOW_JOB
// and FLOW_SERIES.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type CommandId, type NeedsUserId, arcId, commandId, sha256, unitId } from '../src/core/ids.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { beforeCompletion, rulerChangesOf, runFlowTrack } from '../src/flow/track.ts';
import { runFlowJob } from '../src/flow/job.ts';
import { parseFlowInputs, parseFlowSeries } from '../src/flow/types.ts';
import { FLOW_INPUTS_INPUT, FLOW_SERIES_INPUT, readInputFiles, recordPlan } from '../src/input/inforce.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { recover } from '../src/recover/recover.ts';
import { status } from '../src/status.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { FlowLog, PLAN_A, commandAt, inputs, planOf } from './helpers/flowlog.ts';
import { INVALID_FLOW_ANSWER, flowAction, flowAnswer, flowStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { FLOW_JOB, FLOW_SERIES, crashCells } from './matrix.ts';
import { checkpointContext } from './fixtures/checkpoint-common.ts';
import { factsOf } from './fixtures/audit-common.ts';
import { startScheduler } from './fixtures/sched-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep, writeStart } from './fixtures/stage-common.ts';
import {
  type ArcDescriptor, type ArcRun, applyBody, commandContextFor, contextFor, gateStep, mulBuild, setupArc, stepUntil,
} from './fixtures/unit-common.ts';
import { sha256Hex } from '../src/core/json.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

let commands = 0;
/** A `flow-requested` fact, as the `flow request` command writes it. */
const request = (r: ArcRun): CommandId => {
  const command = commandId(`cmd-${(++commands).toString(16).padStart(16, 'f')}`);
  r.journal.fact({ kind: 'flow-requested', command, reason: 'scripted request' });
  return command;
};
const flowFacts = <K extends 'flow-started' | 'flow-ended' | 'flow-series'>(r: ArcRun, kind: K) =>
  factsOf(r).filter((f): f is Extract<ReturnType<typeof factsOf>[number], { kind: K }> => f.kind === kind);
const itemsOf = (r: ArcRun, reason: string): readonly NeedsUserId[] =>
  r.journal.view.needsUser().filter((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === reason).map((n) => n.id);
const flowCalls = (d: ArcDescriptor) => readCalls(d.scenarioPath).filter((c) => c.unit?.startsWith('flow-') === true);
const SEQUENCE = flowAnswer({ proposal: { target: 'stage:build', action: flowAction.sequence('u1') } });

function arc(steps: readonly Step[]) {
  const d = setupArc({ steps });
  const r = contextFor(d);
  return { d, r, ctx: checkpointContext(r).ctx };
}

test('flow.job-proposal-item: a request starts a run from kept inputs; its surviving proposal raises one non-blocking flow-proposal item, once', T, async () => {
  const { d, r, ctx } = arc([flowStep('flow-1', SEQUENCE)]);
  try {
    request(r);
    assert.deepEqual(await runFlowJob(ctx, ['requested'], null), { kind: 'ended', job: 'flow-1', outcome: 'done' });
    const [started] = flowFacts(r, 'flow-started');
    assert.deepEqual([started!.job, started!.triggers], ['flow-1', ['requested']]);
    const inputs = parseFlowInputs(JSON.parse(readFileSync(join(d.runDir, 'inputs', `${started!.inputsSha256}.${FLOW_INPUTS_INPUT}`), 'utf8')));
    assert.deepEqual([inputs.chart, inputs.constraint, inputs.stations, inputs.window, inputs.advances], [null, null, [], null, []], 'no merge yet, no holistic layer');
    assert.ok(inputs.levers.some((l) => l.lever === 'sequence' && l.unit === 'u1' && l.priority === 'normal'));
    assert.ok(inputs.levers.some((l) => l.lever === 'suite-lane' && l.lane === 'suite'));
    const [ended] = flowFacts(r, 'flow-ended');
    assert.equal(ended!.proposal?.id, 'flow-1.0');
    assert.deepEqual([ended!.dropped, ended!.constraint], [null, { code: null, judged: { station: 'stage:build', agree: false, reason: 'scripted reading' } }]);
    const [item] = itemsOf(r, 'flow-proposal');
    const record = readNeedsUser(r.ctx.runDir, item!)!;
    assert.equal(record.blocking, false);
    assert.deepEqual(record.options.map((o) => o.id), ['accept', 'reject']);
    assert.match(record.options[0]!.label, /roadmap flow accept flow-1\.0 --reason/);
    assert.match(record.summary, /flow-1\.0: unit u1 to priority high at stage:build \(subordinate; verdict metric lead time\)/);
    const raise = r.journal.view.opsOf('needsuser.raise').find((i) => i.expect.id === item);
    assert.deepEqual(raise?.parent, { type: 'job', job: 'flow-1' });
    const [call] = flowCalls(d);
    assert.equal(basename(call!.cwd), 'flow-1.flow', 'a checkout of the integration head');
    assert.match(call!.stdin, /<levers>[^]*sequence u1: priority normal/);
    assert.deepEqual(await runFlowJob(ctx, [], null), { kind: 'none' }, 'nothing due, nothing running');
    assert.equal(itemsOf(r, 'flow-proposal').length, 1, 'raised once');
    assert.equal(flowCalls(d).length, 1);
    const s = status(r.ctx.runDir, r.journal.view.arc, absPath(d.hostDir)).flow;
    assert.ok(s !== null && s.state === 'on');
    assert.deepEqual(s.pending.map((p) => [p.proposal, p.phase]), [['flow-1.0', 'undecided']]);
    assert.equal(s.next.running, null);
    assert.ok(s.next.cooldownUntil !== null && s.next.bypass, 'the cooldown runs; one request may bypass it');
  } finally {
    r.journal.close();
  }
});

test('flow.host-and-dropped: host advice raises flow-host; a proposal targeting held time is dropped with its reason and raises nothing', T, async () => {
  const { r, ctx } = arc([
    flowStep('flow-1', flowAnswer({ proposal: { target: 'stage:build', action: flowAction.host('add cores') } })),
    flowStep('flow-2', flowAnswer({ proposal: { target: 'held', action: flowAction.sequence('u1') } })),
  ]);
  try {
    await runFlowJob(ctx, ['requested'], null);
    assert.equal(itemsOf(r, 'flow-host').length, 1);
    await runFlowJob(ctx, ['requested'], null);
    const ended = flowFacts(r, 'flow-ended')[1]!;
    assert.deepEqual([ended.job, ended.proposal, ended.dropped?.reason, ended.dropped?.proposal.id], ['flow-2', null, 'target', 'flow-2.0']);
    assert.deepEqual([itemsOf(r, 'flow-proposal').length, itemsOf(r, 'flow-host').length], [0, 1]);
  } finally {
    r.journal.close();
  }
});

test('flow.invalid-retry: an answer the reader refuses is asked once more, told why; a second refusal ends invalid with a flow-invalid item', T, async () => {
  const { d, r, ctx } = arc([
    flowStep('flow-1', INVALID_FLOW_ANSWER), flowStep('flow-1', flowAnswer()),
    flowStep('flow-2', INVALID_FLOW_ANSWER), flowStep('flow-2', INVALID_FLOW_ANSWER),
  ]);
  try {
    assert.deepEqual(await runFlowJob(ctx, ['requested'], null), { kind: 'ended', job: 'flow-1', outcome: 'done' });
    const [first, retry] = flowCalls(d);
    assert.doesNotMatch(first!.stdin, /previous_answer_refused/);
    assert.match(retry!.stdin, /<previous_answer_refused>[^]*refused by the report's reader/);
    assert.deepEqual(itemsOf(r, 'flow-invalid'), [], 'a noAction raises nothing');
    assert.deepEqual(await runFlowJob(ctx, ['requested'], null), { kind: 'ended', job: 'flow-2', outcome: 'invalid' });
    const ended = flowFacts(r, 'flow-ended')[1]!;
    assert.deepEqual([ended.proposal, ended.dropped, ended.constraint.judged], [null, null, null]);
    assert.equal(flowCalls(d).length, 4, 'one retry each, no third call');
    const [item] = itemsOf(r, 'flow-invalid');
    assert.match(readNeedsUser(r.ctx.runDir, item!)!.summary, /Flow run flow-2 gave no valid report twice/);
  } finally {
    r.journal.close();
  }
});

test('flow.track-non-holistic: the track runs on an arc without the holistic layer; the series is kept right before arc-completed', T, async () => {
  const d = setupArc({ steps: [flowStep('flow-1'), planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    assert.equal(r.journal.view.holistic().on, false);
    request(r);
    const s = startScheduler(r);
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
    assert.deepEqual(flowFacts(r, 'flow-ended').map((f) => [f.job, f.outcome]), [['flow-1', 'done']]);
    const events = readJournal(r.ctx.runDir, r.journal.view.arc).events;
    const completed = events.findIndex((e) => e.type === 'fact' && e.fact.kind === 'arc-completed');
    const before = events[completed - 1]!;
    assert.ok(before.type === 'fact' && before.fact.kind === 'flow-series', 'the series right before arc-completed');
    const series = parseFlowSeries(JSON.parse(readFileSync(join(d.runDir, 'inputs', `${before.fact.sha256}.${FLOW_SERIES_INPUT}`), 'utf8')));
    assert.deepEqual(series.points.map((p) => p.unit), ['u1']);
    assert.equal(before.fact.highWater, before.seq - 1);
    assert.equal(flowFacts(r, 'flow-series').length, 1);
  } finally {
    r.journal.close();
  }
});

test('flow.off-dev7: an arc whose revisions carry no role set (1.0.0-dev.7) runs with the loop off: no run, no series; status says off-dev7', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const journal = openJournal(absPath(d.runDir), arcId(d.arc));
  writeStart(absPath(d.runDir), absPath(d.repo), absPath(d.planPath), 'default');
  recordPlan(journal, absPath(d.runDir), readInputFiles(absPath(d.planPath), absPath(d.repo)), [], { profile: 'default', config: null, arcRoles: null });
  journal.close();
  const r = contextFor(d);
  try {
    request(r);
    const s = startScheduler(r);
    assert.deepEqual(await s.end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
    assert.deepEqual([flowFacts(r, 'flow-started'), flowFacts(r, 'flow-series')], [[], []]);
    assert.deepEqual(status(r.ctx.runDir, r.journal.view.arc, absPath(d.hostDir)).flow, { state: 'off-dev7' });
  } finally {
    r.journal.close();
  }
});

test('flow.verdict-at-completion: an applied proposal\'s window the completion closes gets its verdict once, before the series (too few samples: inconclusive)', T, async () => {
  const { r, ctx } = arc([flowStep('flow-1', SEQUENCE)]);
  try {
    await runFlowJob(ctx, ['requested'], null);
    const proposal = flowFacts(r, 'flow-ended')[0]!.proposal!.id;
    r.journal.fact({ kind: 'flow-decided', proposal, command: request(r), decision: 'accepted', reason: 'scripted accept' });
    r.journal.fact({ kind: 'flow-applied', proposal, revision: r.journal.view.planApplied()!.rev, preimage: { lever: 'sequence', unit: unitId('u1'), priority: null } });
    beforeCompletion(ctx);
    beforeCompletion(ctx);
    const facts = factsOf(r);
    const verdicts = facts.filter((f) => f.kind === 'flow-verdict');
    assert.equal(verdicts.length, 1, 'written once');
    const v = verdicts[0]!;
    assert.ok(v.kind === 'flow-verdict');
    assert.deepEqual([v.proposal, v.metric, v.before.samples, v.after.samples, v.guards, v.verdict, v.preimage],
      [proposal, { type: 'lead' }, [], [], [], 'inconclusive', { lever: 'sequence', unit: 'u1', priority: null }]);
    assert.ok(facts.findIndex((f) => f.kind === 'flow-verdict') < facts.findIndex((f) => f.kind === 'flow-series'), 'the verdict before the series');
    assert.deepEqual(itemsOf(r, 'flow-worse'), []);
  } finally {
    r.journal.close();
  }
});

describe('ruler-changed', () => {
  test('flow.ruler-changed-reading: command revisions after the first dispatch that move the ruler; not before it, not a lever, not a vision apply', () => {
    const lever = sha256('b'.repeat(64));
    const ruler = sha256('c'.repeat(64));
    const plans = new Map([
      [PLAN_A, planOf({})], [ruler, { ...planOf({}), routing: { gate: { med: 'summit' } } }], [lever, { ...planOf({}), routing: { gate: { med: 'summit' } }, capacity: { cpu: 4 } }],
    ]);
    const log = new FlowLog();
    log.applied(0, 1);
    log.applied(1, 2, { command: commandAt(1), plan: ruler }); // before the first admission
    log.dispatch(2, 'u1');
    log.applied(3, 3, { command: commandAt(3), plan: lever }); // a lever path only
    log.applied(4, 4, { command: commandAt(4), plan: PLAN_A }); // the judgment seat reseated back: the ruler moved
    log.applied(5, 5, { command: commandAt(5), plan: ruler, vision: true }); // the vision record changed too: the owner's apply
    const read = { ...inputs(planOf({})), planOf: (f: { planSha256: string }) => plans.get(f.planSha256 as never)! };
    assert.deepEqual(rulerChangesOf(log.events, read).map((c) => [c.rev, c.command, c.paths]), [[4, commandAt(4), ['routing.gate']]]);
  });

  test('flow.ruler-changed: an apply after the first admission reseating a judgment raises one non-blocking ruler-changed item, listed in status', T, async () => {
    const { d, r, ctx } = arc([planCheckStep({ decision: 'approve' })]);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'plan-check');
      const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Record<string, unknown>;
      writeFileSync(d.planPath, JSON.stringify({ ...plan, routing: { gate: { med: 'summit' } } }));
      const command = submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d));
      const out = await applyCommand(commandContextFor(r), command);
      assert.equal(out.kind, 'applied', JSON.stringify(out));
      const track = { holisticRunning: () => false, judging: () => {}, hostPressure: () => null };
      await runFlowTrack(ctx, track);
      await runFlowTrack(ctx, track);
      const items = itemsOf(r, 'ruler-changed');
      assert.equal(items.length, 1, 'raised once');
      const record = readNeedsUser(r.ctx.runDir, items[0]!)!;
      assert.equal(record.blocking, false);
      assert.match(record.summary, /changed the ruler: routing\.gate/);
      const raise = r.journal.view.opsOf('needsuser.raise').find((i) => i.expect.id === items[0]);
      assert.deepEqual(raise?.parent, { type: 'command', command: command.id });
      const s = status(r.ctx.runDir, r.journal.view.arc, absPath(d.hostDir)).flow;
      assert.ok(s !== null && s.state === 'on');
      assert.deepEqual(s.rulerChanged.map((c) => [c.command, c.paths, c.needsUser]), [[command.id, ['routing.gate'], items[0]]]);
    } finally {
      r.journal.close();
    }
  });
});

/** The arc after its child crashed at `label` running `mode`, reopened and recovered as a restart does. */
async function crashed(steps: readonly Step[], mode: 'job' | 'series', label: string) {
  const d = setupArc({ steps });
  const first = contextFor(d);
  if (mode === 'job') request(first);
  first.journal.close();
  const trigger = writeTrigger(tmpDir('flow-crash'), { label, occurrence: 1 });
  const exit = await runFixture('flow-job-child.ts', [JSON.stringify(d), mode], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
  assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
  assertFired(trigger);
  const r = contextFor(d);
  const { ctx, w } = checkpointContext(r);
  await recover({ stage: ctx, commands: w.commands });
  return { d, r, ctx };
}

describe(`matrix row ${FLOW_JOB}`, () => {
  for (const cell of crashCells(FLOW_JOB)) {
    test(`flow job crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d, r, ctx } = await crashed([flowStep('flow-1', SEQUENCE)], 'job', cell.label);
      try {
        const out = await runFlowJob(ctx, [], null);
        if (cell.label === 'flow.after-ended') assert.deepEqual(out, { kind: 'none' }, 'the restart only raises the item');
        else assert.deepEqual(out, { kind: 'ended', job: 'flow-1', outcome: 'done' });
        assert.deepEqual(flowFacts(r, 'flow-started').map((f) => f.job), ['flow-1'], 'one run');
        assert.deepEqual(flowFacts(r, 'flow-ended').map((f) => [f.job, f.proposal?.id]), [['flow-1', 'flow-1.0']], 'ended once');
        assert.equal(flowCalls(d).length, 1, 'asked once');
        assert.equal(itemsOf(r, 'flow-proposal').length, 1, 'one item');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});

describe(`matrix row ${FLOW_SERIES}`, () => {
  for (const cell of crashCells(FLOW_SERIES)) {
    test(`flow series crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d, r, ctx } = await crashed([], 'series', cell.label);
      try {
        const [kept] = flowFacts(r, 'flow-series');
        assert.ok(kept !== undefined, 'kept before the crash');
        const bytes = readFileSync(join(d.runDir, 'inputs', `${kept.sha256}.${FLOW_SERIES_INPUT}`));
        assert.equal(sha256Hex(bytes.toString('utf8')), kept.sha256);
        beforeCompletion(ctx);
        assert.equal(flowFacts(r, 'flow-series').length, 1, 'no second series');
      } finally {
        r.journal.close();
      }
    });
  }
});
