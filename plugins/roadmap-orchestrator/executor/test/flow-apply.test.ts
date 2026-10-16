// M4b step B2: flow decisions, suite-lane proofs and the apply of an accepted proposal (src/commands/flow.ts,
// src/flow/proof.ts, src/flow/apply.ts), integrated over unit-common arcs: real git, real node test runs of a tiny
// product (timer-driven test files under test/unit/), the command path, and a SIGKILLed child for the apply's crash.
// Named tests: flow.proof-preserved-applied, flow.proof-changed, flow.proof-unprovable, flow.proof-red, flow.apply-crash,
// flow.decide, flow.request, flow.given.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { type CommandOutcome, applyCommand } from '../src/commands/apply.ts';
import { flowCommand } from '../src/commands/flow.ts';
import { readReceipt, submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type CommandId, type NeedsUserId, type ProposalId, arcId, jobId, laneId, proposalId, stationId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { acceptedProposals, applyPendingFlow, flowApplyHolds, proofDue, rejectionMemory } from '../src/flow/apply.ts';
import { readHostGivens } from '../src/flow/givens.ts';
import { runProof } from '../src/flow/proof.ts';
import type { FlowAction, FlowProposal } from '../src/flow/types.ts';
import { FLOW_INPUTS_INPUT, FLOW_PROOF_INPUT, keepInput, keptInput } from '../src/input/inforce.ts';
import { runDir } from '../src/input/cli.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { gitCommonDir } from '../src/preflight/checks.ts';
import { recover } from '../src/recover/recover.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll, git, tmpDir, writeFiles } from './helpers/repo.ts';
import { wire } from './fixtures/publish-common.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { followingContext } from './fixtures/steer-common.ts';
import { type ArcDescriptor, type ArcRun, commandContextFor, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const LANE = laneId('suite');
const SERIAL = ['node', '--test', '--test-concurrency=1', 'test/unit/*.test.js'];
const PARALLEL = ['node', '--test', '--test-concurrency=3', 'test/unit/*.test.js'];

const timer = (name: string, ms: number): string =>
  `import { test } from 'node:test';\n\ntest('${name}', async () => {\n  await new Promise((resolve) => setTimeout(resolve, ${ms}));\n});\n`;
/** Three passing, isolated timer files: serial is three times one file, parallel about one. */
const TIMERS = { 'test/unit/a.test.js': timer('a', 1000), 'test/unit/b.test.js': timer('b', 1000), 'test/unit/c.test.js': timer('c', 1000) };
/** A shared ledger dir: b passes only after a wrote its entry, so serial passes and parallel fails b (plant S's story, unfixed). */
const LEDGER = {
  'test/unit/a.test.js': "import { mkdirSync, writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\n\ntest('a', async () => {\n  await new Promise((resolve) => setTimeout(resolve, 500));\n  mkdirSync('out/ledger', { recursive: true });\n  writeFileSync('out/ledger/a', 'a');\n});\n",
  'test/unit/b.test.js': "import assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\nimport { test } from 'node:test';\n\ntest('b', () => {\n  assert.ok(existsSync('out/ledger/a'), 'LEDGER-MARKER');\n});\n",
  'test/unit/c.test.js': timer('c', 100),
};
const RED = { ...TIMERS, 'test/unit/c.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\ntest('c', () => {\n  assert.fail('RED-MARKER');\n});\n" };

type FlowArc = Readonly<{ d: ArcDescriptor; r: ArcRun }>;

/** A unit-common arc whose suite is `SERIAL` over `files` (committed on main), its run dir where the CLI locates it. */
function flowArc(files: Readonly<Record<string, string>>, env?: LaneJson['env']): FlowArc {
  const base = setupArc({ steps: [], suite: [{ id: 'suite', argv: SERIAL, ...(env === undefined ? {} : { env }) }] });
  writeFiles(base.repo, files);
  const head = commitAll(base.repo, 'product tests');
  const plan = JSON.parse(readFileSync(base.planPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(base.planPath, JSON.stringify({ ...plan, baseline: head }));
  const d: ArcDescriptor = { ...base, runDir: runDir(gitCommonDir(absPath(base.repo)), arcId(base.arc)) };
  mkdirSync(d.runDir, { recursive: true });
  return { d, r: contextFor(d) };
}

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const ofKind = <K extends Fact['kind']>(r: ArcRun, kind: K) => facts(r).filter((f): f is Extract<Fact, { kind: K }> => f.kind === kind);
const phaseOf = (r: ArcRun, id: ProposalId) => acceptedProposals(r.journal.view).find((a) => a.proposal.id === id)?.phase;
const proofCtx = (r: ArcRun) => ({ ...followingContext(r), acquireFirst: wire(r).arbiter.acquireFirst });
const applyCtx = (r: ArcRun) => ({ ...commandContextFor(r, followingContext(r)), repo: r.ctx.repo });
const livePlanLane = (d: ArcDescriptor) => (JSON.parse(readFileSync(d.planPath, 'utf8')) as { suite: { lanes: { id: string; argv: string[]; cpu?: number }[] } }).suite.lanes[0];

/** Flow run `flow-<n>` ends proposing `action` (or dropping it), and raises its `flow-proposal` item as the job does. */
function propose(r: ArcRun, n: number, action: FlowAction, dropped = false): Readonly<{ proposal: FlowProposal; item: NeedsUserId | null }> {
  const job = jobId('flow', n);
  const proposal: FlowProposal = { id: proposalId(`flow-${n}.0`), target: stationId('suite:suite'), action, rationale: 'the suite is the slot', risks: 'none' };
  r.journal.fact({ kind: 'flow-started', job, triggers: ['requested'], inputsSha256: keepInput(r.ctx.runDir, Buffer.from(`{"n":${n}}`), FLOW_INPUTS_INPUT) });
  r.journal.fact({
    kind: 'flow-ended', job, outcome: 'done', proposal: dropped ? null : proposal, dropped: dropped ? { proposal, reason: 'target', detail: 'scripted drop' } : null,
    constraint: { code: null, judged: { station: stationId('suite:suite'), agree: true, reason: 'scripted' } },
  });
  if (dropped) return { proposal, item: null };
  const item = raiseNeedsUser(r.journal, r.ctx.runDir, {
    blocking: false, subject: { type: 'arc' }, reason: 'flow-proposal', summary: `Flow proposal ${proposal.id}`, recommendation: 'Accept or reject it.',
    options: [], evidence: [],
  }, { type: 'job', job });
  return { proposal, item };
}

async function command(r: ArcRun, body: CommandBody): Promise<Readonly<{ id: CommandId; outcome: CommandOutcome }>> {
  const file = submitCommand(r.ctx.runDir, r.journal.view.arc, body);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r, followingContext(r)), file) };
}
const decide = (r: ArcRun, proposal: ProposalId, decision: 'accept' | 'reject', reason = 'scripted reason') => command(r, { type: 'flow-decide', proposal, decision, reason });

const SUITE_ARGV: FlowAction = { lever: 'suite-lane', lane: LANE, argv: PARALLEL, reporter: 'node-test', cpu: 3 };

describe('suite-lane proofs (RC-4) and the apply', () => {
  test('flow.proof-preserved-applied: =1 → =3 over three timer files is preserved (equal records, faster), then applied under the fence; the owner\'s plan file is never written', T, async () => {
    const { d, r } = flowArc(TIMERS);
    try {
      const { proposal, item } = propose(r, 1, SUITE_ARGV);
      const accepted = await decide(r, proposal.id, 'accept');
      assert.equal(accepted.outcome.kind, 'applied');
      assert.deepEqual(ofKind(r, 'flow-decided').map((f) => [f.proposal, f.decision, f.command]), [[proposal.id, 'accepted', accepted.id]]);
      assert.equal(r.journal.view.ackOf(item!)?.command, accepted.id, 'the proposal item is acknowledged by the decision');
      assert.deepEqual(phaseOf(r, proposal.id), { phase: 'pending-proof', reds: 0 });
      assert.equal(flowApplyHolds(r.journal.view), false, 'a pending proof holds no candidate');

      const due = proofDue(r.journal.view);
      assert.deepEqual(due, { proposal, job: 'proof-1' });
      await runProof(proofCtx(r), due!.proposal, due!.job);
      const [proof, ...more] = ofKind(r, 'flow-proof');
      assert.equal(more.length, 0);
      assert.ok(proof !== undefined && proof.outcome === 'preserved', JSON.stringify(proof));
      assert.equal(proof.job, 'proof-1');
      assert.equal(proof.treeSha, git(d.repo, 'rev-parse', 'main^{tree}'), 'proved at the integration head');
      assert.equal(proof.oldSha256, proof.newSha256, 'the same (testId, selected, outcome) records');
      assert.deepEqual(JSON.parse(keptInput(r.ctx.runDir, proof.oldSha256!, FLOW_PROOF_INPUT)!.toString('utf8')), [
        { outcome: 'pass', selected: 1, testId: 'a' }, { outcome: 'pass', selected: 1, testId: 'b' }, { outcome: 'pass', selected: 1, testId: 'c' },
      ]);
      assert.ok(proof.minutes !== null && proof.minutes.new < proof.minutes.old, JSON.stringify(proof.minutes));
      assert.equal(proof.breaksStandIn, false);
      assert.deepEqual(ofKind(r, 'witnessed'), [], 'a proof journals no witnessed fact');
      const spawns = r.journal.view.opsOf('proc.spawn').map((i) => i.expect.subject);
      assert.deepEqual(spawns.map((s) => (s.purpose === 'proof' ? [s.job, s.side, s.lane] : s.purpose)), [['proof-1', 'old', 'suite'], ['proof-1', 'new', 'suite']]);
      assert.deepEqual(r.journal.view.openIntents(), []);
      assert.ok(!existsSync(`${r.ctx.plan().worktreeRoot}/${r.ctx.plan().arc}/proof-1.old`) && !existsSync(`${r.ctx.plan().worktreeRoot}/${r.ctx.plan().arc}/proof-1.new`));

      assert.deepEqual(phaseOf(r, proposal.id), { phase: 'pending-apply' });
      assert.equal(flowApplyHolds(r.journal.view), true, 'pending-apply holds new candidate starts');
      assert.equal(proofDue(r.journal.view), null);
      await applyPendingFlow(applyCtx(r));
      const flowRevs = ofKind(r, 'plan-applied').filter((f) => f.source.type === 'flow');
      assert.deepEqual(flowRevs.map((f) => [f.rev, f.source]), [[2, { type: 'flow', proposal: proposal.id }]]);
      assert.deepEqual(ofKind(r, 'flow-applied'), [{
        kind: 'flow-applied', proposal: proposal.id, revision: 2, preimage: { lever: 'suite-lane', lane: LANE, argv: SERIAL, cpu: null },
      }]);
      assert.deepEqual(phaseOf(r, proposal.id), { phase: 'applied', revision: 2 });
      assert.equal(flowApplyHolds(r.journal.view), false);
      assert.deepEqual([livePlanLane(d)?.argv, livePlanLane(d)?.cpu], [SERIAL, undefined], 'the owner\'s plan file is never written');
      assert.deepEqual(followingContext(r).plan().suite.lanes[0]?.argv, PARALLEL);

      await applyPendingFlow(applyCtx(r));
      assert.equal(ofKind(r, 'plan-applied').length, 2, 'nothing more to apply');
    } finally {
      r.journal.close();
    }
  });

  test('flow.proof-changed: on a shared ledger dir the parallel argv fails a test: changed, refused and remembered', T, async () => {
    const { r } = flowArc(LEDGER);
    try {
      const { proposal } = propose(r, 1, SUITE_ARGV);
      await decide(r, proposal.id, 'accept');
      await runProof(proofCtx(r), proposal, jobId('proof', 1));
      const [proof] = ofKind(r, 'flow-proof');
      assert.ok(proof?.outcome === 'changed', JSON.stringify(proof));
      assert.notEqual(proof.oldSha256, proof.newSha256);
      const now = JSON.parse(keptInput(r.ctx.runDir, proof.newSha256!, FLOW_PROOF_INPUT)!.toString('utf8')) as { testId: string; outcome: string }[];
      assert.deepEqual(now.map((t) => [t.testId, t.outcome]), [['a', 'pass'], ['b', 'fail'], ['c', 'pass']]);
      assert.ok(proof.minutes !== null);
      assert.deepEqual(phaseOf(r, proposal.id), { phase: 'refused', reason: 'its proof proof-1 was changed' });
      assert.equal(flowApplyHolds(r.journal.view), false);
      assert.equal(proofDue(r.journal.view), null);
      assert.deepEqual(rejectionMemory(r.journal.view), [{ key: { station: 'suite:suite', lever: 'suite-lane', target: { type: 'lane', lane: 'suite' } }, proposal: proposal.id, cause: 'changed' }]);
      await applyPendingFlow(applyCtx(r));
      assert.equal(ofKind(r, 'plan-applied').length, 1, 'a refused proposal is never applied');
    } finally {
      r.journal.close();
    }
  });

  test('flow.proof-unprovable: a lane env setting NODE_OPTIONS clashes with the node-test reporter: unprovable, nothing run, remembered', T, async () => {
    const { r } = flowArc(TIMERS, { set: { NODE_OPTIONS: '--no-warnings' }, pass: ['PATH'] });
    try {
      const { proposal } = propose(r, 1, SUITE_ARGV);
      await decide(r, proposal.id, 'accept');
      await runProof(proofCtx(r), proposal, jobId('proof', 1));
      assert.deepEqual(ofKind(r, 'flow-proof').map((f) => [f.outcome, f.oldSha256, f.newSha256, f.minutes]), [['unprovable', null, null, null]]);
      assert.deepEqual(r.journal.view.opsOf('proc.spawn'), [], 'nothing ran');
      assert.equal(phaseOf(r, proposal.id)?.phase, 'refused');
      assert.deepEqual(rejectionMemory(r.journal.view).map((x) => x.cause), ['unprovable']);
    } finally {
      r.journal.close();
    }
  });

  test('flow.proof-red: a red baseline is proved again once by a fresh proof job, then refused unremembered', T, async () => {
    const { r } = flowArc(RED);
    try {
      const { proposal } = propose(r, 1, SUITE_ARGV);
      await decide(r, proposal.id, 'accept');
      await runProof(proofCtx(r), proposal, proofDue(r.journal.view)!.job);
      assert.deepEqual(phaseOf(r, proposal.id), { phase: 'pending-proof', reds: 1 });
      assert.equal(proofDue(r.journal.view)?.job, 'proof-2', 'the rerun is a fresh proof job');
      await runProof(proofCtx(r), proposal, jobId('proof', 2));
      assert.deepEqual(ofKind(r, 'flow-proof').map((f) => [f.job, f.outcome, f.newSha256, f.minutes]), [['proof-1', 'red', null, null], ['proof-2', 'red', null, null]]);
      const sides = r.journal.view.opsOf('proc.spawn').map((i) => (i.expect.subject.purpose === 'proof' ? i.expect.subject.side : null));
      assert.deepEqual(sides, ['old', 'old'], 'a red baseline runs no new argv');
      assert.deepEqual(phaseOf(r, proposal.id), { phase: 'refused', reason: 'its proofs were red 2 times (proof-1, proof-2)' });
      assert.equal(proofDue(r.journal.view), null);
      assert.deepEqual(rejectionMemory(r.journal.view), [], 'a red proof is not remembered');
    } finally {
      r.journal.close();
    }
  });

  test('flow.apply-crash: SIGKILLed after the flow revision is committed, the next tick journals flow-applied from it and commits nothing twice', T, async () => {
    const { d, r: setup } = flowArc(TIMERS);
    const cpuOnly: FlowAction = { lever: 'suite-lane', lane: LANE, cpu: 2 };
    const { proposal } = propose(setup, 1, cpuOnly);
    await decide(setup, proposal.id, 'accept');
    assert.deepEqual(phaseOf(setup, proposal.id), { phase: 'pending-apply' }, 'a cpu-only change needs no proof');
    setup.journal.close();

    const trigger = writeTrigger(tmpDir('flow-crash'), { label: 'revision.commit.after-fact', occurrence: 1 });
    const exit = await runFixture('flow-apply-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
    assert.equal(exit.signal, 'SIGKILL', `the child must crash after the commit: code ${exit.code}, stderr ${exit.stderr}`);
    assertFired(trigger);

    const r = contextFor(d);
    try {
      assert.deepEqual(ofKind(r, 'flow-applied'), []);
      assert.equal(flowApplyHolds(r.journal.view), true, 'still pending-apply: candidates stay held');
      const f = followingContext(r);
      await recover({ stage: f, commands: commandContextFor(r, f) });
      await applyPendingFlow(applyCtx(r));
      assert.deepEqual(ofKind(r, 'plan-applied').map((x) => [x.rev, x.source.type]), [[1, 'start'], [2, 'flow']]);
      assert.deepEqual(ofKind(r, 'flow-applied'), [{ kind: 'flow-applied', proposal: proposal.id, revision: 2, preimage: { lever: 'suite-lane', lane: LANE, argv: SERIAL, cpu: null } }]);
      assert.equal(f.plan().suite.lanes[0]?.cpu, 2, 'the flow revision is the plan in force');
      assert.equal(livePlanLane(d)?.cpu, undefined, 'the owner\'s plan file is never written');
      assert.equal(flowApplyHolds(r.journal.view), false);
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });
});

describe('roadmap flow commands', () => {
  test('flow.decide: a rejection is remembered by its RC-9 key and acks the item; decisions are idempotent by proposal id; unknown, dropped and contrary decisions are refused', T, async () => {
    const { d, r } = flowArc(TIMERS);
    try {
      const { proposal, item } = propose(r, 1, { lever: 'suite-lane', lane: LANE, cpu: 2 });
      propose(r, 2, { lever: 'suite-lane', lane: LANE, cpu: 3 }, true);
      const run = { type: 'explicit', repo: d.repo, arc: r.journal.view.arc } as const;

      const rejected = await decide(r, proposal.id, 'reject', 'the suite is not the constraint');
      assert.equal(rejected.outcome.kind, 'applied');
      assert.equal(r.journal.view.ackOf(item!)?.command, rejected.id);
      assert.deepEqual(rejectionMemory(r.journal.view), [{ key: { station: 'suite:suite', lever: 'suite-lane', target: { type: 'lane', lane: 'suite' } }, proposal: proposal.id, cause: 'rejected' }]);
      assert.deepEqual(acceptedProposals(r.journal.view), []);

      const again = await decide(r, proposal.id, 'reject');
      assert.equal(again.outcome.kind, 'applied', 'the same decision again is a no-op');
      const receipt = readReceipt(r.ctx.runDir, again.id, 'applied');
      assert.ok(receipt?.state === 'applied' && receipt.verified.includes(`${proposal.id} was rejected by ${rejected.id} already`), JSON.stringify(receipt));
      assert.equal(ofKind(r, 'flow-decided').length, 1);

      const contrary = await decide(r, proposal.id, 'accept');
      assert.deepEqual(contrary.outcome.kind === 'rejected' ? contrary.outcome.reason : contrary.outcome, `flow accept ${proposal.id}: it is already rejected (by ${rejected.id}: the suite is not the constraint)`);
      const unknown = await decide(r, proposalId('flow-9.0'), 'accept');
      assert.ok(unknown.outcome.kind === 'rejected' && /no flow run of arc .* proposed it/.test(unknown.outcome.reason), JSON.stringify(unknown.outcome));

      // The CLI refuses the same before it queues anything.
      assert.deepEqual(await flowCommand({ type: 'decide', proposal: proposal.id, decision: 'accept', reason: 'x', run }, absPath(d.hostDir)), {
        kind: 'refused', reason: `flow accept ${proposal.id}: it is already rejected (by ${rejected.id}: the suite is not the constraint)`,
      });
      const dropped = await flowCommand({ type: 'decide', proposal: proposalId('flow-2.0'), decision: 'accept', reason: 'x', run }, absPath(d.hostDir));
      assert.ok(dropped.kind === 'refused' && dropped.reason.includes("code's checks dropped it (target: scripted drop)"), JSON.stringify(dropped));
      const queued = await flowCommand({ type: 'decide', proposal: proposal.id, decision: 'reject', reason: 'x', run }, absPath(d.hostDir));
      assert.ok(queued.kind === 'submitted' && queued.arc === r.journal.view.arc, JSON.stringify(queued));
    } finally {
      r.journal.close();
    }
  });

  test('flow.request: flow-requested once per command, with its reason', T, async () => {
    const { r } = flowArc(TIMERS);
    try {
      const file = submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'flow-request', reason: 'the slot queue doubled since 10:00' });
      const ctx = commandContextFor(r, followingContext(r));
      assert.equal((await applyCommand(ctx, file)).kind, 'applied');
      assert.equal((await applyCommand(ctx, file)).kind, 'applied');
      assert.deepEqual(ofKind(r, 'flow-requested'), [{ kind: 'flow-requested', command: file.id, reason: 'the slot queue doubled since 10:00' }]);
    } finally {
      r.journal.close();
    }
  });

  test('flow.given: a host given is written once under this host\'s fingerprint; the same given again is the one there', T, async () => {
    const { d, r } = flowArc(TIMERS);
    r.journal.close();
    const repo = absPath(d.repo);
    const first = await flowCommand({ type: 'given', repo, lever: 'concurrency', note: 'this host has 4 real cores' }, absPath(d.hostDir));
    assert.ok(first.kind === 'given' && first.given.id === 'G-1' && first.given.lever === 'concurrency', JSON.stringify(first));
    assert.deepEqual(await flowCommand({ type: 'given', repo, lever: 'concurrency', note: 'this host has 4 real cores' }, absPath(d.hostDir)), first);
    const second = await flowCommand({ type: 'given', repo, lever: 'resource-pool', note: 'one database only' }, absPath(d.hostDir));
    assert.ok(second.kind === 'given' && second.given.id === 'G-2');
    assert.deepEqual(readHostGivens(gitCommonDir(repo)).givens.map((g) => [g.id, g.lever, g.note]), [['G-1', 'concurrency', 'this host has 4 real cores'], ['G-2', 'resource-pool', 'one database only']]);
  });
});
