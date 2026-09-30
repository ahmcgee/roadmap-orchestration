// M3 step B7: the scheduler joins the holistic layer into the running arc (src/schedule/scheduler.ts), over real arcs
// (real git, real processes, the fake claude and codex answering by unit, job and lens, fake witness lanes). Named tests:
// sched.close-out-then-complete, sched.arc-completed-fact, complete.terminal-snapshot, complete.reopen-invalidates,
// quiescence.vision-change-reopens (H3), sched.arc-state-predicates (the clauses of `complete`),
// sched.baseline-before-admission (A6), sched.audit-job-one-at-a-time, sched.design-park-checkpoint and
// sched.design-park-no-op (OR-Q1), sched.batch-repair and sched.batch-red-fix-round (R7), draining, and the M3 command
// and item rules (commands.audit, needsuser.m3-blocking).
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type NeedsUserId, type Sha, sha, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { renderConstraints } from '../src/docs/constraints.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import { quiescentGenerations } from '../src/holistic/convergence.ts';
import { requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { m3Blocking, raiseNeedsUser, raisedFor, readNeedsUser } from '../src/needsuser.ts';
import { runBaseline } from '../src/pipeline/baseline.ts';
import { publishCloseOut } from '../src/pipeline/publish.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { completionBlockers, settleBatch } from '../src/schedule/scheduler.ts';
import { parseRulings } from '../src/spec/rulings.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { checkpointAnswer, checkpointStep, lensStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { TERMINAL_SNAPSHOT, crashCells } from './matrix.ts';
import { F1, approveBoth, batchArc, publish } from './fixtures/batch-common.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { applyVision, checkpointArc } from './fixtures/checkpoint-common.ts';
import { until } from './fixtures/exec-common.ts';
import { openBefore, witnessDraft } from './fixtures/repair-common.ts';
import { NOOP, addUnit, completingArc, contextsOf, startHolistic, wired } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, appendSteps, applyBody, codexStep, commandContextFor, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const WAIT_MS = 120_000;

const head = (d: ArcDescriptor): Sha => sha(git(d.repo, 'rev-parse', 'main'));
/** The log's facts with their seqs, as `status` reads them. */
const facts = (r: ArcRun): readonly (Fact & { seq: number })[] =>
  readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [{ ...e.fact, seq: e.seq }] : []));
const factsOf = <K extends Fact['kind']>(r: ArcRun, kind: K) => facts(r).filter((f): f is Extract<Fact, { kind: K }> & { seq: number } => f.kind === kind);
const terminalSnapshots = (r: ArcRun) => r.journal.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'arc' && r.journal.view.doneOf(i.op) !== null);
const submit = (r: ArcRun, body: CommandBody) => submitCommand(r.ctx.runDir, r.journal.view.arc, body).id;
const itemOf = (r: ArcRun, reason: string): NeedsUserId | null => r.journal.view.needsUser().find((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === reason)?.id ?? null;
const opSeq = (op: string): number => Number(op.slice(op.lastIndexOf('/') + 1));

/** Runs `r`'s arc under the scheduler to its end, which must be `complete` with `merged` merged. */
async function runToComplete(r: ArcRun, merged: readonly string[] = ['u1']): Promise<void> {
  const end = await startHolistic(r).end;
  assert.deepEqual(end, { kind: 'complete', units: merged.map((u) => ({ unit: u, result: 'merged' })) });
}

/** Stops a scheduler left running, and closes the arc. */
async function stopAndClose(r: ArcRun, s: ReturnType<typeof startHolistic>): Promise<void> {
  submit(r, { type: 'stop' });
  await s.end;
  r.journal.close();
}

/** u1's plan-check and a build that commits nothing: its gate parks it `empty-diff` (a design park). */
const emptyBuild = (): readonly Step[] => [{ ...planCheckStep({ decision: 'approve' }), unit: 'u1' }, { ...codexStep([], { argv: ['exec', '-C'] }), unit: 'u1' }];

describe('completion (§2.10, A8, A20, G8)', () => {
  test('sched.close-out-then-complete / sched.arc-completed-fact: baseline, the unit, the final audit, a no-op checkpoint, then the close-out publication, then arc-completed and its terminal snapshot', T, async () => {
    const d = completingArc();
    const r = contextFor(d);
    try {
      await runToComplete(r);
      const fs = facts(r);
      const firstOutcome = fs.find((f) => f.kind === 'stage-outcome')!.seq;
      const baseline = fs.filter((f) => f.kind === 'witnessed' && f.for.type === 'job' && f.for.job === 'baseline-1');
      assert.ok(baseline.length > 0 && baseline.every((f) => f.seq < firstOutcome), 'the baseline witnessed before any unit stage (A6)');
      const [started] = factsOf(r, 'audit-started');
      assert.deepEqual(started!.triggers, [{ type: 'final' }], 'the final audit, no work left');
      assert.deepEqual(factsOf(r, 'bundle-decided').map((f) => [f.job, f.outcome.kind]), [['ckpt-1', 'no-op']]);
      const [published] = factsOf(r, 'docs-published');
      assert.deepEqual([published!.pub, published!.source, published!.commit], ['docs-1', 'close-out', head(d)], 'the close-out published the head');
      const [covered] = factsOf(r, 'docs-covered');
      assert.deepEqual([covered!.pub, covered!.from, covered!.to], ['docs-1', started!.integrationSha, head(d)], 'docs-only: it covers its own edge (A17)');
      // A8: the close-out renderings are in the tree (arc-lifetime and withdrawn rulings retired), with the obligations' block.
      const revision = revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view), absPath(d.planPath));
      const expected = renderConstraints(parseRulings(revision.ledger.bytes.toString('utf8'), 'ledger'), [...revision.sidecars.values()].map((s) => s.sidecar), 'close-out');
      assert.equal(`${git(d.repo, 'show', 'main:.roadmap/constraints.md')}\n`, expected);
      assert.match(git(d.repo, 'show', 'main:.roadmap/invariants.md'), /json roadmap-obligations/);
      // The fact after the close-out, then the terminal snapshot.
      const [completed] = factsOf(r, 'arc-completed');
      assert.deepEqual([completed!.planRev, completed!.head, completed!.units], [r.journal.view.planApplied()!.rev, head(d), ['u1']]);
      assert.ok(completed!.highWater < completed!.seq && completed!.seq > published!.seq);
      const [terminal] = terminalSnapshots(r);
      assert.ok(terminal !== undefined && terminal.expect.highWater >= completed!.seq, 'the terminal snapshot follows the fact');
      assert.equal(r.journal.view.holistic().completion?.active, true);
      assert.deepEqual(completionBlockers(contextsOf(r), { blocking: 0, pending: 0 }), []);
      assert.deepEqual(r.journal.view.openIntents(), []);
      // A restart of a completed arc: complete again at once, nothing written twice.
      await runToComplete(r);
      assert.equal(factsOf(r, 'arc-completed').length, 1);
      assert.equal(terminalSnapshots(r).length, 1);
    } finally {
      r.journal.close();
    }
  });

  test('complete.reopen-invalidates (A20): an admitting apply after completion invalidates it; the arc runs the new unit and completes again with a new fact', T, async () => {
    const d = completingArc();
    const r = contextFor(d);
    try {
      await runToComplete(r);
      const first = factsOf(r, 'arc-completed')[0]!;
      addUnit(d, 'u2');
      appendSteps(d, [...unitSteps('u2', moduleFiles('div', '/')), lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', NOOP)]);
      const out = await applyCommand(wired(r).commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d)));
      assert.equal(out.kind, 'applied', JSON.stringify(out));
      assert.equal(r.journal.view.holistic().completion?.active, false, 'the plan rev moved: no longer complete');
      assert.ok(completionBlockers(contextsOf(r), { blocking: 0, pending: 0 }).includes('units-open'));
      await runToComplete(r, ['u1', 'u2']);
      const all = factsOf(r, 'arc-completed');
      assert.equal(all.length, 2);
      const second = all[1]!;
      assert.deepEqual([second.planRev, second.head, second.units], [r.journal.view.planApplied()!.rev, head(d), ['u1', 'u2']]);
      assert.ok(second.planRev > first.planRev);
      assert.equal(factsOf(r, 'docs-published').length, 1, 'the head already held the close-out renderings: nothing to change');
      assert.equal(r.journal.view.holistic().completion?.active, true);
      assert.equal(terminalSnapshots(r).length, 2);
    } finally {
      r.journal.close();
    }
  });

  test('quiescence.vision-change-reopens (H3): a vision revision after completion reopens the quiescent generation and owes a drift audit; its no-op checkpoint makes the arc complete again', T, async () => {
    const d = completingArc([lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', NOOP)]);
    const r = contextFor(d);
    try {
      await runToComplete(r);
      const g1 = factsOf(r, 'checkpoint-inputs')[0]!;
      await applyVision(r, wired(r), [{ id: 'V-2', kind: 'good', text: 'Errors are explicit.', rank: null, state: 'active' }]);
      const visionNow = r.journal.view.planApplied()!.visionSha256!;
      assert.notEqual(visionNow, g1.visionSha256);
      assert.deepEqual([...quiescentGenerations(r.journal.view.holistic(), visionNow)], [], 'generation 1 is quiescent only under the old vision');
      const blockers = completionBlockers(contextsOf(r), { blocking: 0, pending: 0 });
      for (const b of ['audit-pending', 'audit-owed', 'generation-not-quiescent'] as const) assert.ok(blockers.includes(b), `${b} in ${blockers.join(', ')}`);
      assert.equal(r.journal.view.holistic().completion?.active, false);
      await runToComplete(r);
      const [, a2] = factsOf(r, 'audit-started');
      assert.deepEqual([a2!.lenses, a2!.triggers.map((t) => t.type)], [['vision'], ['drift']]);
      const g2 = factsOf(r, 'checkpoint-inputs')[1]!;
      assert.deepEqual([g2.generation, g2.visionSha256], [2, visionNow]);
      assert.deepEqual([...quiescentGenerations(r.journal.view.holistic(), visionNow)], [2]);
      const completions = factsOf(r, 'arc-completed');
      assert.equal(completions.length, 2);
      assert.equal(completions[1]!.planRev, r.journal.view.planApplied()!.rev);
    } finally {
      r.journal.close();
    }
  });

  test('sched.arc-state-predicates: each clause of `complete` fails and clears in turn as the arc advances (baseline, unit, audit, checkpoint, close-out)', T, async () => {
    const d = completingArc();
    const r = contextFor(d);
    const w = wired(r);
    const h = contextsOf(r);
    const tick = setInterval(() => w.arbiter.wake(), 50);
    const blockers = (x = { blocking: 0, pending: 0 }) => completionBlockers(h, x);
    try {
      assert.deepEqual(blockers(), ['units-open', 'baseline-owed', 'close-out', 'obligations-not-discharged'], 'a fresh arc: nothing witnessed on the head yet');
      assert.deepEqual(blockers({ blocking: 1, pending: 2 }).slice(0, 3), ['units-open', 'blocking-items', 'pending-commands']);
      assert.deepEqual(await runBaseline(h.audit), { kind: 'held' });
      assert.deepEqual(blockers(), ['units-open', 'close-out'], 'the baseline witnessed every obligation on the head');
      assert.deepEqual(await runUnit(w.stage, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(blockers(), ['audit-pending', 'coverage-outstanding', 'audit-owed', 'close-out'], 'merged: the final audit is owed');
      const audited = await runAudit(h.audit);
      assert.ok(audited.kind === 'ended' && audited.outcome === 'completed', JSON.stringify(audited));
      assert.deepEqual(blockers(), ['checkpoint-pending', 'generation-not-quiescent', 'close-out']);
      assert.equal((await runCheckpoint(h.checkpoint)).kind, 'decided');
      assert.deepEqual(blockers(), ['close-out'], 'quiescent: only the close-out is left');
      assert.equal((await publishCloseOut(h.docs)).kind, 'published');
      assert.deepEqual(blockers(), []);
      // A non-blocking item never blocks `complete`.
      raiseNeedsUser(r.journal, r.ctx.runDir, {
        blocking: false, subject: { type: 'arc' }, reason: 'audit-owed', summary: 'owed', recommendation: 'run it', options: [], evidence: [],
      }, { type: 'arc' });
      assert.deepEqual(blockers(), []);
    } finally {
      clearInterval(tick);
      r.journal.close();
    }
  });
});

describe('holistic jobs in the scheduler', () => {
  test('sched.baseline-before-admission (A6): a must-hold obligation not held at the baseline raises a blocking obligation-baseline, and no unit is admitted until it is acknowledged', T, async () => {
    const d = checkpointArc(unitSteps('u1', moduleFiles('mul', '*')), { trees: { '*': { outcomes: { t1: 'fail' } } } });
    const r = contextFor(d);
    const s = startHolistic(r);
    try {
      let item: NeedsUserId | null = null;
      await until(() => (item = itemOf(r, 'obligation-baseline')) !== null, WAIT_MS, 'the baseline item');
      assert.equal(readNeedsUser(r.ctx.runDir, item!)!.blocking, true);
      await sleep(3_000);
      assert.deepEqual(factsOf(r, 'stage-outcome'), [], 'no unit stage while the baseline item is open');
      assert.equal(r.journal.view.opsOf('proc.spawn').some((i) => i.expect.subject.purpose === 'backend'), false);
      submit(r, { type: 'ack', needsUser: item!, choice: null });
      await until(() => factsOf(r, 'stage-outcome').some((f) => f.unit === 'u1'), WAIT_MS, 'u1 admitted after the ack');
      assert.ok(factsOf(r, 'needs-user-acked')[0]!.seq < factsOf(r, 'stage-outcome')[0]!.seq);
    } finally {
      await stopAndClose(r, s);
    }
  });

  test('sched.audit-job-one-at-a-time: an audit requested while one runs waits for it; each runs its own triggers, never two at once', T, async () => {
    const barrier = { type: 'barrier', name: 'lens', timeoutMs: 120_000 } as const;
    const d = checkpointArc([lensStep('audit-1', 'vision', [], [barrier]), checkpointStep('ckpt-1', NOOP), lensStep('audit-2', 'vision'), checkpointStep('ckpt-2', NOOP)]);
    const r = contextFor(d);
    // u1 stays paused: only the requested audits run.
    submit(r, { type: 'pause', target: { type: 'unit', unit: unitId('u1') } });
    const a = submit(r, { type: 'audit', lenses: null });
    const s = startHolistic(r);
    try {
      await reached(d.scenarioDir, 'lens', WAIT_MS);
      const b = submit(r, { type: 'audit', lenses: ['vision'] });
      await until(() => terminalReceipt(r.ctx.runDir, b) !== null, WAIT_MS, 'the second audit request applied');
      assert.equal(terminalReceipt(r.ctx.runDir, b)!.state, 'applied');
      assert.deepEqual(factsOf(r, 'audit-started').map((f) => f.job), ['audit-1'], 'one audit at a time');
      release(d.scenarioDir, 'lens');
      await until(() => factsOf(r, 'bundle-decided').length === 2, WAIT_MS, 'both audits and their checkpoints');
      const [s1, s2] = factsOf(r, 'audit-started');
      const [e1] = factsOf(r, 'audit-ended');
      assert.ok(e1!.seq < s2!.seq, 'audit-2 starts after audit-1 ended');
      assert.deepEqual(s1!.triggers, [{ type: 'requested', command: a }]);
      assert.deepEqual(s2!.triggers, [{ type: 'requested', command: b }]);
      const baseline = factsOf(r, 'witnessed').filter((f) => f.for.type === 'job' && f.for.job === 'baseline-1');
      assert.ok(baseline.length > 0 && baseline.every((f) => f.seq < s1!.seq), 'the baseline first');
    } finally {
      await stopAndClose(r, s);
    }
  });

  test('sched.design-park-checkpoint (OR-Q1): a design park goes to the checkpoint with its item held back; a respec re-opens the unit; its second design park raises respec-second', T, async () => {
    const cite = { op: 'patch-spec', unit: 'u1', patch: [{ op: 'cite', contracts: ['contracts/api.md'], rulings: ['C-1'] }], cites: ['V-1'], evidence: ['u1 parked on an empty diff'] };
    const respec = checkpointAnswer({ decision: 'bundle', ops: [cite] });
    const d = checkpointArc([...emptyBuild(), checkpointStep('ckpt-1', respec), ...emptyBuild()], { units: [{ id: 'u1', lanes: [] }] });
    const r = contextFor(d);
    const s = startHolistic(r);
    try {
      let second: NeedsUserId | null = null;
      await until(() => (second = itemOf(r, 'respec-second')) !== null, WAIT_MS, 'respec-second');
      const parks = factsOf(r, 'stage-outcome').filter((f) => f.unit === 'u1' && f.outcome === 'empty-diff');
      assert.equal(parks.length, 2);
      const parentOf = (f: (typeof parks)[number]) => ({ type: 'stage' as const, unit: f.unit, stage: f.stage, attempt: f.attempt });
      assert.equal(raisedFor(r.journal.view, parentOf(parks[0]!)), null, 'the first park\'s own item was held back for the checkpoint');
      assert.equal(raisedFor(r.journal.view, parentOf(parks[1]!)), second, 'the second park raised respec-second, not its own item');
      assert.equal(readNeedsUser(r.ctx.runDir, second!)!.blocking, true);
      const [reopened] = factsOf(r, 'reopened');
      const [applied] = factsOf(r, 'plan-applied').filter((f) => f.source?.type === 'bundle');
      assert.ok(reopened !== undefined && applied !== undefined && reopened.command === null && reopened.seq > applied.seq, 'the respec re-opened the unit');
      assert.ok(reopened!.seq < parks[1]!.seq);
      assert.deepEqual(readCalls(d.scenarioPath).filter((c) => c.unit?.startsWith('ckpt-') === true).map((c) => c.unit), ['ckpt-1']);
    } finally {
      await stopAndClose(r, s);
    }
  });

  test('sched.design-park-no-op (OR-Q1): a checkpoint that decides nothing for a design park raises the park\'s own item after its decision', T, async () => {
    const d = checkpointArc([...emptyBuild(), checkpointStep('ckpt-1', NOOP)], { units: [{ id: 'u1', lanes: [] }] });
    const r = contextFor(d);
    const s = startHolistic(r);
    try {
      let id: NeedsUserId | null = null;
      await until(() => {
        const park = factsOf(r, 'stage-outcome').find((f) => f.outcome === 'empty-diff');
        return park !== undefined && (id = raisedFor(r.journal.view, { type: 'stage', unit: park.unit, stage: park.stage, attempt: park.attempt })) !== null;
      }, WAIT_MS, 'the park item');
      const [decided] = factsOf(r, 'bundle-decided');
      assert.equal(decided!.outcome.kind, 'no-op');
      const raise = r.journal.view.opsOf('needsuser.raise').find((i) => i.expect.id === id)!;
      assert.ok(opSeq(raise.op) > decided!.seq, 'raised after the checkpoint decided');
      assert.equal(readNeedsUser(r.ctx.runDir, id!)!.reason, 'empty-diff');
    } finally {
      await stopAndClose(r, s);
    }
  });
});

describe('repair batches in the scheduler (R7)', () => {
  test('sched.batch-repair: two units repairing one finding wait at their candidates for each other and publish as one batch; both retire', T, async () => {
    const { d } = holisticArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/'))],
      units: [
        { id: 'u1', origin: 'repair', obligations: ['I-1'], repairs: ['F-1'] },
        { id: 'u2', origin: 'repair', obligations: ['I-1'], repairs: ['F-1'], lanes: [{ id: 'div', argv: ['node', '--test', 'test/div.test.js'] }] },
      ],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'] }],
      mapping: [{ pattern: 'src/**', obligations: ['I-1'] }, { pattern: 'test/**', obligations: ['I-1'] }, { pattern: 'contracts/**', obligations: ['I-1'] }, { pattern: 'lib/**', obligations: ['I-2'] }],
      trees: { '*': { outcomes: { t1: 'pass', t2: 'pass' } } },
      beforeStart: openBefore(witnessDraft('I-2')),
    });
    const r = contextFor(d);
    const s = startHolistic(r);
    try {
      const view = () => r.journal.view;
      const retired = (u: string): boolean =>
        view().opsOf('worktree.remove').some((i) => i.parent.type === 'stage' && i.parent.unit === u && i.parent.stage === 'retire' && view().doneOf(i.op) !== null);
      await until(() => retired('u1') && retired('u2'), WAIT_MS, 'both members retired');
      const cands = view().opsOf('candidate.merge');
      assert.equal(cands.length, 1, 'no member merged a candidate of its own');
      assert.deepEqual([cands[0]!.expect.batch?.job, cands[0]!.expect.batch?.members.map((m) => m.unit)], ['batch-1', ['u1', 'u2']]);
      assert.deepEqual(factsOf(r, 'stage-outcome').filter((f) => f.stage === 'candidate'), []);
      for (const u of ['u1', 'u2']) assert.equal(view().unit(unitId(u)).status, 'retired');
      assert.equal(view().holistic().findings.find((f) => f.id === 'F-1')!.state, 'resolved');
    } finally {
      await stopAndClose(r, s);
    }
  });

  test('sched.batch-red-fix-round: a red batch records red for each member its own selection attributes, and each member\'s fix round names its red obligation from the batch evidence', T, async () => {
    const { d } = batchArc({ t2: 'fail' });
    const r = contextFor(d);
    try {
      await approveBoth(r);
      const out = await publish(r);
      assert.deepEqual(out.kind === 'red' ? out.attributable : out, ['u1', 'u2']);
      assert.deepEqual(settleBatch(r.ctx, F1, [r.unit('u1'), r.unit('u2')], out), { progress: true, retire: [], unbatch: [] });
      for (const u of ['u1', 'u2']) {
        const f = r.journal.view.unit(unitId(u)).decided!;
        assert.deepEqual([f.stage, f.outcome, f.chargeable], ['candidate', 'red', true]);
      }
      appendSteps(d, [{ ...codexStep([{ type: 'commit', message: 'fix u1', files: { 'src/mul.js': 'export function mul(a, b) {\n  return a * b;\n}\n' } }]), unit: 'u1' }]);
      await step(r.ctx, r.unit('u1'));
      const fix = readCalls(d.scenarioPath).filter((c) => c.unit === 'u1').at(-1)!;
      assert.match(fix.stdin, /Obligation I-2 must hold on the candidate/);
      assert.match(fix.stdin, /batch-1/);
    } finally {
      r.journal.close();
    }
  });
});

describe('the M3 commands and items', () => {
  test('draining: close-admissions latches draining once (a second is refused, a re-delivery applies nothing twice); an architect apply that adds a unit reopens admissions', T, async () => {
    const d = completingArc();
    const r = contextFor(d);
    try {
      const w = wired(r);
      const close = submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'close-admissions' });
      assert.equal((await applyCommand(w.commands, close)).kind, 'applied');
      assert.equal(r.journal.view.holistic().draining?.command, close.id);
      assert.equal((await applyCommand(w.commands, close)).kind, 'applied', 're-delivered: the recorded outcome');
      assert.equal(factsOf(r, 'admissions-closed').length, 1);
      const again = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'close-admissions' }));
      assert.ok(again.kind === 'rejected' && /already draining/.test(again.reason), JSON.stringify(again));
      addUnit(d, 'u2');
      assert.equal((await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d)))).kind, 'applied');
      assert.equal(r.journal.view.holistic().draining, null, 'an architect admit reopens admissions');
    } finally {
      r.journal.close();
    }
  });

  test('commands.audit: `audit` records its request; a lens outside L is refused; an arc without the holistic layer refuses it', T, async () => {
    const r = contextFor(completingArc());
    try {
      const w = wired(r);
      const bad = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'audit', lenses: ['drift'] }));
      assert.ok(bad.kind === 'rejected' && /outside the arc's required lens set \(vision\)/.test(bad.reason), JSON.stringify(bad));
      const ok = submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'audit', lenses: ['vision'] });
      assert.equal((await applyCommand(w.commands, ok)).kind, 'applied');
      assert.deepEqual(factsOf(r, 'audit-requested').map((f) => [f.command, f.lenses]), [[ok.id, ['vision']]]);
    } finally {
      r.journal.close();
    }
    const m2 = contextFor(setupArc({ steps: [] }));
    try {
      const out = await applyCommand(commandContextFor(m2), submitCommand(m2.ctx.runDir, m2.journal.view.arc, { type: 'audit', lenses: null }));
      assert.ok(out.kind === 'rejected' && /no holistic layer/.test(out.reason), JSON.stringify(out));
    } finally {
      m2.journal.close();
    }
  });

  test('needsuser.m3-blocking: an M3 reason is raised blocking or not by its OR ruling, and a raise that disagrees fails loud', T, () => {
    assert.equal(m3Blocking('owner-request'), true);
    assert.equal(m3Blocking('obligation-baseline'), true);
    assert.equal(m3Blocking('respec-second'), true);
    for (const reason of ['bundle-request', 'convergence-bound', 'convergence-identity', 'audit-owed', 'divergence-digest'] as const) assert.equal(m3Blocking(reason), false);
    assert.equal(m3Blocking('base-red'), null, 'an earlier reason: its raiser decides');
    const r = contextFor(completingArc());
    try {
      assert.throws(() => raiseNeedsUser(r.journal, r.ctx.runDir, {
        blocking: true, subject: { type: 'arc' }, reason: 'convergence-bound', summary: 'x', recommendation: 'y', options: [], evidence: [],
      }, { type: 'arc' }), /convergence-bound needs-user is raised non-blocking, not blocking/);
      assert.deepEqual(r.journal.view.needsUser(), []);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: the close-out and the completion (the matrix row TERMINAL_SNAPSHOT); complete.terminal-snapshot (G8) is its B5 cell

describe(`matrix row ${TERMINAL_SNAPSHOT}`, () => {
  for (const cell of crashCells(TERMINAL_SNAPSHOT)) {
    test(`complete.terminal-snapshot: crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const d = completingArc();
      const trigger = writeTrigger(tmpDir('complete-crash'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('sched-m3-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      try {
        if (cell.label === 'complete.after-fact') assert.deepEqual(terminalSnapshots(r), [], 'the crash left the fact without its snapshot');
        const w = wired(r);
        await recover({ stage: w.stage, commands: w.commands });
        await runToComplete(r);
        const published = factsOf(r, 'docs-published');
        assert.deepEqual(published.map((f) => [f.pub, f.commit]), [['docs-1', head(d)]], 'one close-out, the head');
        assert.equal(factsOf(r, 'docs-covered').length, 1);
        const completed = factsOf(r, 'arc-completed');
        assert.equal(completed.length, 1, 'the completion written once');
        const snaps = terminalSnapshots(r);
        assert.equal(snaps.length, 1);
        assert.ok(snaps[0]!.expect.highWater >= completed[0]!.seq);
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        r.journal.close();
      }
    });
  }
});
