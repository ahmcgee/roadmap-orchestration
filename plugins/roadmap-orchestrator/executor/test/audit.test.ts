// M3 step B5: the cadence audit (src/holistic/{audit,cadence,coverage}.ts) and the arc roles' call (src/pipeline/dispatch.ts
// `callArcRole`), over real arcs: real git, real processes, the fake claude answering lens calls keyed by job and lens, fake
// witness lanes scripted per tree. Named tests: cadence.triggers, cadence.final-outstanding-lenses (H9),
// audit.immutable-inputs, audit.coverage, audit.race-ends-before-merge and audit.race-merge-during-audit (both race
// orders), audit.owed, audit.skipped-on-park, audit.starts-in-ff-window (H2), coverage.docs-edge-contiguous (H8), coverage.docs-edge-subsumed,
// coverage.vision-reset (H3), and the crash cells of the matrix row AUDIT_JOB (test/matrix.ts).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type CommandId, type Sha, commandId, sha } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { type AuditContext, runAudit } from '../src/holistic/audit.ts';
import { type Cadence, cadence } from '../src/holistic/cadence.ts';
import { coverageBase, coverageOf, lensCoverage } from '../src/holistic/coverage.ts';
import { findingKey } from '../src/holistic/types.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { lensStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { AUDIT_JOB, crashCells } from './matrix.ts';
import { auditArc, auditContext, factsOf, mapped, moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { VISION } from './fixtures/brake-common.ts';
import { API_OP, barrierSuite, closedAs, ruleRecord, submitRule } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Lens = 'invariants' | 'drift' | 'vacuity' | 'vision';
type Wired = ReturnType<typeof auditContext>['w'];

const head = (repo: string): Sha => sha(git(repo, 'rev-parse', 'main'));
const treeOf = (repo: string, commit: string): string => git(repo, 'rev-parse', `${commit}^{tree}`);
let commands = 0;
/** An `audit-requested` fact, as the `audit` command (B7) writes it. */
function requestAudit(r: ArcRun, lenses: readonly Lens[] | null = null): CommandId {
  const command = commandId(`cmd-${(++commands).toString(16).padStart(16, 'b')}`);
  r.journal.fact({ kind: 'audit-requested', command, lenses });
  return command;
}
const started = (r: ArcRun) => factsOf(r).flatMap((f) => (f.kind === 'audit-started' ? [f] : []));
const ended = (r: ArcRun) => factsOf(r).flatMap((f) => (f.kind === 'audit-ended' ? [f] : []));
/** The owed triggers, compactly: `drift:<rev>`, `unwitnessed:<I-n>`, or the type. */
const owed = (c: Cadence | null): readonly string[] => (c?.owed ?? []).map((t) => (t.type === 'drift' ? `drift:${t.planRev}` : t.type === 'unwitnessed' ? `unwitnessed:${t.obligation}` : t.type));
const lensCalls = (r: ArcRun) => readCalls(r.d.scenarioPath).filter((c) => c.lens !== null);
/** Each lens's watermark at the head now, and whether a range is outstanding. */
function watermarks(ctx: AuditContext, lenses: readonly Lens[]): readonly (readonly [Lens, Sha, boolean])[] {
  const now = head(ctx.repo);
  return coverageOf(ctx.journal.view.holistic(), coverageBase(ctx, now)!, lenses, now).map((c) => [c.lens, c.watermark, c.outstanding] as const);
}
async function rule(w: Wired, r: ArcRun, id: string, over: Record<string, unknown> = {}): Promise<void> {
  const outcome = await applyCommand(w.commands, submitRule(r, ruleRecord(r, id, over)));
  assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
}
/** The arbiter's wake loop, as the scheduler runs it. */
function ticking(w: Wired): () => void {
  const timer = setInterval(() => w.arbiter.wake(), 50);
  return () => clearInterval(timer);
}
const L2: readonly Lens[] = ['invariants', 'vision'];
const I1 = { obligations: [{ id: 'I-1', testIds: ['t1'] }], trees: { '*': { outcomes: { t1: 'pass' as const } } } };
const barrierLens = (job: string, lens: Lens) => lensStep(job, lens, [], [{ type: 'barrier', name: 'lens', timeoutMs: 120_000 }]);

describe('cadence', () => {
  test('cadence.triggers: every trigger the log holds is owed and coalesces into one audit-started; N counts unit and contract-op publications, never a docs-only one', T, async () => {
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), lensStep('audit-1', 'vision'), lensStep('audit-1', 'invariants')],
      units: [{ id: 'u1', obligations: ['I-1', 'I-2'] }, { id: 'u2', obligations: ['I-1', 'I-2'] }, { id: 'u3', obligations: ['I-1', 'I-2'] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', activation: 'future', deliveredBy: ['u1', 'u3'], testIds: ['t2'] }],
      mapping: mapped(['I-1', 'I-2']), trees: { '*': { outcomes: { t1: 'pass' } } }, audit: { every: 2, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      assert.deepEqual([owed(cadence(ctx, ctx.clock)), cadence(ctx, ctx.clock)!.plan], [[], null], 'nothing owed on a fresh arc');
      const asked = requestAudit(r, ['vision']);
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan, { triggers: [{ type: 'requested', command: asked }], lenses: ['vision'], generation: 1 });
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      // R8: u1 selected future I-2 (not completing it: u3 delivers it too), whose test its tree does not report.
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['unwitnessed:I-2', 'requested'], 'one publication of N = 2: no cadence yet');
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan?.lenses, ['invariants', 'vision']);
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['cadence', 'unwitnessed:I-2', 'requested']);
      assert.deepEqual(owed(cadence(ctx, () => 400)), ['cadence', 'unwitnessed:I-2', 'wall-clock', 'requested'], 'the wall clock, while work (u3) remains');
      await rule(w, r, 'C-2');
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['cadence', 'unwitnessed:I-2', 'drift:2', 'requested'], 'a docs-only rule drifts and is no publication');
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      const [s] = started(r);
      assert.deepEqual(s!.triggers, [{ type: 'cadence' }, { type: 'unwitnessed', obligation: 'I-2' }, { type: 'drift', planRev: 2 }, { type: 'requested', command: asked }], 'coalesced into one audit');
      assert.deepEqual([s!.lenses, s!.generation], [['invariants', 'vision'], 1]);
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), [], 'a completed audit consumes every trigger it recorded');
      // Rulings carrying contract ops are publications: two reach N = 2 again.
      await rule(w, r, 'C-3', API_OP);
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['drift:3']);
      await rule(w, r, 'C-4', {
        contractRefs: ['contracts/api.md'],
        contractOps: [{ path: 'contracts/api.md', anchor: '#api-contract', oldText: 'the sum of two finite numbers', newText: 'the exact sum of two finite numbers' }],
      });
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['cadence', 'drift:3', 'drift:4']);
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('cadence.final-outstanding-lenses (H9): with no work left, the final audit runs exactly the lenses in L with an outstanding range', T, async () => {
    const { d } = auditArc({
      steps: [
        ...unitSteps('u1', moduleFiles('mul', '*')), lensStep('audit-1', 'vision'),
        { as: 'claude', unit: 'audit-1', lens: 'invariants', expect: {}, acts: [{ type: 'malformed' }] }, lensStep('audit-2', 'invariants'),
      ],
      units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L2], wallClockMin: 1 },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const S = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan, { triggers: [{ type: 'final' }], lenses: ['invariants', 'vision'], generation: 1 });
      const first = await runAudit(ctx);
      assert.ok(first.kind === 'ended' && first.outcome === 'abandoned', JSON.stringify(first));
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'vision', from: S, to: S1 }], 'the lens that reported is covered, the malformed one is not');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S, true], ['vision', S1, false]]);
      assert.equal(cadence(ctx, ctx.clock)!.plan, null, 'an abandoned final audit is not retried at once');
      assert.deepEqual(cadence(ctx, () => 2)!.plan, { triggers: [{ type: 'final' }], lenses: ['invariants'], generation: 2 }, 'after the period: the outstanding lens alone');
      const again = await runAudit({ ...ctx, clock: () => 2 });
      assert.ok(again.kind === 'ended' && again.outcome === 'completed', JSON.stringify(again));
      assert.deepEqual(ended(r)[1]!.covered, [{ lens: 'invariants', from: S, to: S1 }]);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S1, false], ['vision', S1, false]]);
      assert.deepEqual(owed(cadence(ctx, () => 2)), [], 'nothing outstanding: no final audit');
      assert.deepEqual(lensCalls(r).map((c) => `${c.unit}:${c.lens}`), ['audit-1:vision', 'audit-1:invariants', 'audit-2:invariants']);
    } finally {
      r.journal.close();
    }
  });
});

describe('the audit job', () => {
  test('audit.immutable-inputs: the capture records the revisions, owners, prior findings and high water; the lenses read those, not what lands meanwhile; each call is metered to the job by role and routingRev', T, async () => {
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), barrierLens('audit-1', 'vision'), lensStep('audit-1', 'invariants')],
      units: [{ id: 'u1' }], ...I1, mapping: [], audit: { lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      // A plan-check vision conflict of u1, owned by u1: its branch is an owner the lenses read.
      r.journal.fact({
        kind: 'finding-opened', id: r.journal.view.nextFindingId(), key: findingKey('plan-check', null, 'mul may round'), lens: 'plan-check', severity: 'P3',
        obligation: null, visionClauses: [VISION.clauses[0].id as never], claim: 'mul may round', evidence: [], mutant: null,
        source: { type: 'stage', unit: r.unit('u1').id, stage: 'plan-check', attempt: 1 }, gateHadPassed: false,
      });
      r.journal.fact({ kind: 'finding-transition', id: r.journal.view.holistic().findings[0]!.id, to: { state: 'owned', unit: r.unit('u1').id } });
      requestAudit(r);
      const S = head(d.repo);
      const before = r.journal.view.planApplied()!;
      const audit = runAudit(ctx);
      await reached(d.scenarioDir, 'lens', 120_000);
      await rule(w, r, 'C-2', API_OP);
      assert.notEqual(head(d.repo), S, 'the ruling published while the audit ran');
      release(d.scenarioDir, 'lens');
      const out = await audit;
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      const s = started(r)[0]!;
      assert.deepEqual(
        [s.job, s.integrationSha, s.planRev, s.ledgerSha256, s.obligationsSha256, s.visionSha256, s.owners, s.priorFindings],
        ['audit-1', S, 1, before.rulingsSha256, before.obligationsSha256, before.visionSha256, [{ unit: 'u1', head: git(d.repo, 'rev-parse', `roadmap/${d.arc}/u1`) }], ['F-1']],
      );
      const seq = readJournal(r.ctx.runDir, r.journal.view.arc).events.find((e) => e.type === 'fact' && e.fact.kind === 'audit-started')!.seq;
      assert.equal(s.highWater, seq - 1, 'the high water is the log just before the capture');
      const invariants = lensCalls(r).find((c) => c.lens === 'invariants')!;
      assert.ok(invariants.stdin.startsWith('<vision>'), 'the vision first');
      assert.match(invariants.stdin, /the sum of two numbers/, 'the contract as at the audited SHA');
      assert.doesNotMatch(invariants.stdin, /finite numbers/, 'neither the ruling nor its contract op that landed during the audit');
      assert.match(invariants.stdin, /export function mul/, 'the owner\'s branch diff');
      assert.match(invariants.stdin, /F-1/, 'the prior findings');
      assert.equal(invariants.cwd, join(ctx.plan().worktreeRoot, ctx.plan().arc, 'audit-1.lenses'));
      assert.deepEqual(ended(r)[0]!.covered, [], 'nothing was published before S: the range is empty');
      const usage = factsOf(r).flatMap((f) => ((f.kind === 'meter' || f.kind === 'usage-unavailable') && f.subject.type === 'job' ? [[f.subject, f.routingRev]] : []));
      assert.deepEqual(usage, [
        [{ type: 'job', role: 'lens', tier: 'arc', job: 'audit-1', attempt: 1 }, ctx.routing(null).rev],
        [{ type: 'job', role: 'lens', tier: 'arc', job: 'audit-1', attempt: 2 }, ctx.routing(null).rev],
      ]);
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('audit.coverage: an audit covers each lens it ran from its watermark to the audited SHA, its lanes observed there; a lens it did not run keeps its watermark', T, async () => {
    const { d } = auditArc({
      steps: [
        ...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')),
        lensStep('audit-1', 'vision'), lensStep('audit-1', 'invariants'), lensStep('audit-2', 'vision'),
      ],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }, { id: 'u3', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']),
      audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const S = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S, true], ['vision', S, true]]);
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'invariants', from: S, to: S1 }, { lens: 'vision', from: S, to: S1 }]);
      // Its lanes' results are observations keyed by the audited tree: u1's candidate observed the lane on that very tree,
      // so the audit reads that observation and runs nothing.
      assert.deepEqual(factsOf(r).flatMap((f) => (f.kind === 'witnessed' && f.treeSha === treeOf(d.repo, S1) ? [f.for.type] : [])), ['candidate']);
      assert.equal(r.journal.view.opsOf('proc.spawn').filter((i) => i.parent.type === 'job').length, 2, 'the two lens calls, no lane');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S1, false], ['vision', S1, false]]);
      assert.equal(cadence(ctx, ctx.clock)!.plan, null);
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
      const S2 = head(d.repo);
      requestAudit(r, ['vision']);
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan?.lenses, ['vision']);
      const second = await runAudit(ctx);
      assert.ok(second.kind === 'ended' && second.outcome === 'completed', JSON.stringify(second));
      assert.deepEqual(ended(r)[1]!.covered, [{ lens: 'vision', from: S1, to: S2 }], 'it discharges only its lens');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S1, true], ['vision', S2, false]]);
    } finally {
      r.journal.close();
    }
  });

  test('audit.race-ends-before-merge: an audit that ended before a merge leaves the merge outstanding, and it counts toward the next cadence', T, async () => {
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), lensStep('audit-1', 'vision'), lensStep('audit-2', 'vision')],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }, { id: 'u3', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']),
      audit: { every: 1, lenses: ['vision'] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const S = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      assert.equal((await runAudit(ctx)).kind, 'ended');
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'vision', from: S, to: S1 }]);
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
      const S2 = head(d.repo);
      assert.deepEqual(watermarks(ctx, ['vision']), [['vision', S1, true]], 'the merge after the audit is outstanding');
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['cadence'], 'and counts toward the next cadence');
      assert.equal((await runAudit(ctx)).kind, 'ended');
      assert.deepEqual(ended(r)[1]!.covered, [{ lens: 'vision', from: S1, to: S2 }]);
    } finally {
      r.journal.close();
    }
  });

  test('audit.race-merge-during-audit: a merge landing while the audit runs stays outstanding (coverage stops at the audited SHA); the P1 it opened is re-witnessed on the new head', T, async () => {
    // I-2 (on its own lane) is broken everywhere; u1 and u2 select I-1 alone, so their candidates never run its lane.
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), barrierLens('audit-1', 'vision')],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }, { id: 'u3', obligations: ['I-1'] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'], lane: 'other' }], lanes: ['journey', 'other'],
      mapping: mapped(['I-1']), trees: { '*': { outcomes: { t1: 'pass' } } }, ownControl: { other: { '*': { outcomes: { t2: 'fail' } } } },
      audit: { every: 1, lenses: ['vision'] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      const S = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      const audit = runAudit(ctx);
      await reached(d.scenarioDir, 'lens', 120_000);
      assert.deepEqual(r.journal.view.holistic().findings.map((f) => [f.id, f.lens, f.severity, f.obligation]), [['F-1', 'witness', 'P1', 'I-2']], 'code opened the P1 before the lenses');
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' }, 'a P1 over an obligation u2 does not select holds nothing');
      const S2 = head(d.repo);
      release(d.scenarioDir, 'lens');
      const out = await audit;
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'vision', from: S, to: S1 }], 'coverage stops at the audited SHA');
      assert.deepEqual(ended(r)[0]!.findings, ['F-1']);
      assert.deepEqual(out.rewitnessed, [{ finding: 'F-1', obligation: 'I-2', head: S2, verdict: 'not-held' }]);
      assert.deepEqual(factsOf(r).flatMap((f) => (f.kind === 'witnessed' && f.for.type === 'job' ? [[f.lane, f.treeSha]] : [])),
        [['other', treeOf(d.repo, S1)], ['other', treeOf(d.repo, S2)]], 'I-1\'s lane reused from u1\'s candidate; then the P1\'s lane alone, on the new head');
      assert.deepEqual(watermarks(ctx, ['vision']), [['vision', S1, true]]);
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['cadence']);
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('audit.owed: an audit owed for 2 × the wall-clock period, or for 2N publications, raises one non-blocking audit-owed per episode', T, async () => {
    const pause = (r: ArcRun) => r.journal.fact({ kind: 'paused', command: commandId(`cmd-${(++commands).toString(16).padStart(16, 'c')}`), target: { type: 'all' } });
    const { d } = auditArc({ steps: [], units: [{ id: 'u1' }], ...I1, mapping: [], audit: { every: 5, lenses: ['vision'], wallClockMin: 1 } });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      requestAudit(r);
      pause(r);
      assert.deepEqual(await runAudit(ctx), { kind: 'skipped', reason: 'paused', owed: null }, 'owed, not yet long');
      const late = { ...ctx, clock: () => 2 };
      const first = await runAudit(late);
      assert.ok(first.kind === 'skipped' && first.owed !== null, JSON.stringify(first));
      const item = readNeedsUser(r.ctx.runDir, first.owed)!;
      assert.deepEqual([item.reason, item.blocking, item.subject], ['audit-owed', false, { type: 'arc' }]);
      assert.deepEqual(await runAudit(late), first, 'once per episode');
      assert.deepEqual(started(r), [], 'a skipped audit writes nothing');
    } finally {
      r.journal.close();
    }
    const b = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/'))],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }, { id: 'u3', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']),
      audit: { every: 1, lenses: ['vision'] },
    });
    const rb = contextFor(b.d);
    const cb = auditContext(rb).ctx;
    try {
      assert.deepEqual(await runUnit(cb, rb.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(await runUnit(cb, rb.unit('u2'), admitAll), { kind: 'merged' });
      pause(rb);
      const out = await runAudit(cb);
      assert.ok(out.kind === 'skipped' && out.owed !== null, `owed for 2N = 2 publications: ${JSON.stringify(out)}`);
      assert.equal(readNeedsUser(rb.ctx.runDir, out.owed)!.blocking, false);
    } finally {
      rb.journal.close();
    }
  });

  test('audit.skipped-on-park: a lens that hits a usage limit parks its backend and abandons the audit; while it is parked a due audit is skipped and its triggers stay owed', T, async () => {
    const { d } = auditArc({
      steps: [{ as: 'claude', unit: 'audit-1', lens: 'vision', expect: {}, acts: [{ type: 'usageLimit' }] }],
      units: [{ id: 'u1' }], ...I1, mapping: [], audit: { lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const asked = requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'abandoned', JSON.stringify(out));
      assert.deepEqual(r.journal.view.parkedBackends(), ['claude']);
      assert.equal(lensCalls(r).length, 1, 'the invariants lens was not asked');
      const usage = r.journal.view.needsUser().map((n) => readNeedsUser(r.ctx.runDir, n.id)!);
      assert.deepEqual(usage.map((n) => [n.reason, n.blocking]), [['usage-limit', true]]);
      assert.match(usage[0]!.summary, /in audit-1/);
      assert.deepEqual(await runAudit(ctx), { kind: 'none' }, 'an abandoned audit is not retried at once');
      const later = await runAudit({ ...ctx, clock: () => 400 });
      assert.deepEqual(later, { kind: 'skipped', reason: 'backend-parked', owed: null });
      assert.equal(started(r).length, 1, 'no second audit started');
      assert.deepEqual(cadence(ctx, () => 400)!.plan?.triggers, [{ type: 'wall-clock' }, { type: 'requested', command: asked }], 'its triggers stay owed');
    } finally {
      r.journal.close();
    }
  });

  test('audit.starts-in-ff-window (H2): an audit due while a revision holds the fence (its docs publication before the ff) captures the state after the activation', T, async () => {
    const barrier = tmpDir('barrier');
    const { d } = auditArc({ steps: [lensStep('audit-1', 'vision')], suite: [barrierSuite(barrier)], units: [{ id: 'u1' }], ...I1, mapping: [], audit: { lenses: ['vision'] } });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      const asked = requestAudit(r);
      const ruling = applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2', API_OP)));
      await reached(barrier, 'lane', 120_000);
      const audit = runAudit(ctx);
      await sleep(500);
      assert.deepEqual(started(r), [], 'the capture waits for the fence');
      release(barrier, 'lane');
      assert.equal((await ruling).kind, 'applied');
      const out = await audit;
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      const applied = r.journal.view.planApplied()!;
      const s = started(r)[0]!;
      assert.deepEqual([s.planRev, s.ledgerSha256, s.integrationSha], [2, applied.rulingsSha256, applied.publication!.head], 'the post-activation state');
      assert.deepEqual(s.triggers, [{ type: 'drift', planRev: 2 }, { type: 'requested', command: asked }]);
      assert.match(lensCalls(r)[0]!.stdin, /finite numbers/, 'the lens reads the activated ruling and contract');
    } finally {
      stop();
      r.journal.close();
    }
  });
});

describe('coverage', () => {
  test('coverage.docs-edge-contiguous (H8): a docs-only publication covers its own edge U→D, extending a watermark only once it reaches U; its drift trigger is kept', T, async () => {
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), barrierLens('audit-1', 'vision'), lensStep('audit-1', 'invariants')],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      await rule(w, r, 'C-2');
      const D1 = head(d.repo);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', D1, false], ['vision', D1, false]], 'the edge S→D1 is contiguous: both lenses reach D1');
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan, { triggers: [{ type: 'drift', planRev: 2 }], lenses: ['vision'], generation: 1 }, 'the drift trigger is kept: L ∩ {drift, vision}');
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      requestAudit(r);
      const audit = runAudit(ctx);
      await reached(d.scenarioDir, 'lens', 120_000);
      await rule(w, r, 'C-3', { statement: 'Helpers never round.' });
      const D2 = head(d.repo);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', D1, true], ['vision', D1, true]], 'the edge S1→D2 does not reach from D1: kept, not applied');
      const base = coverageBase(ctx, D2)!;
      assert.deepEqual(lensCoverage(r.journal.view.holistic(), base, 'vision').pendingDocs.map((e) => [e.from, e.to]), [[S1, D2]]);
      release(d.scenarioDir, 'lens');
      const out = await audit;
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'invariants', from: D1, to: S1 }, { lens: 'vision', from: D1, to: S1 }]);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', D2, false], ['vision', D2, false]], 'the gap closed: the kept edge applies');
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('coverage.docs-edge-subsumed (paid m3 run 8): a docs edge the watermark passes inside an audit\'s range, without following it, is not pending', T, async () => {
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), lensStep('audit-1', 'vision'), lensStep('audit-1', 'invariants')],
      units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      const S = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      // The docs edge S1→D1 does not reach from the watermark S: kept, pending.
      await rule(w, r, 'C-2');
      const D1 = head(d.repo);
      const pending = () => lensCoverage(r.journal.view.holistic(), coverageBase(ctx, D1)!, 'vision').pendingDocs.map((e) => [e.from, e.to]);
      assert.deepEqual(pending(), [[S1, D1]]);
      // The audit at D1 covers S→D1 across the edge: the watermark passes it without following it.
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'invariants', from: S, to: D1 }, { lens: 'vision', from: S, to: D1 }]);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', D1, false], ['vision', D1, false]]);
      assert.deepEqual(pending(), [], 'subsumed by audit-1\'s range, not pending');
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('coverage.vision-reset (H3): a vision revision clears every lens\'s coverage recorded under the old vision; the next audit of a lens covers from the arc\'s base, so the range uncovered at the change is covered; it triggers a drift-only audit', T, async () => {
    const { d } = auditArc({
      steps: [
        ...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')),
        lensStep('audit-1', 'vision'), lensStep('audit-1', 'invariants'), lensStep('audit-2', 'vision'),
      ],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }, { id: 'u3', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']),
      audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      const S = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      requestAudit(r);
      assert.equal((await runAudit(ctx)).kind, 'ended');
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
      const S2 = head(d.repo);
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S1, true], ['vision', S1, true]], 'S1→S2 is uncovered when the vision changes');
      const visionFile = join(d.planPath, '..', 'vision.json');
      const vision = JSON.parse(readFileSync(visionFile, 'utf8')) as typeof VISION;
      writeFileSync(visionFile, JSON.stringify({ ...vision, rev: 2, clauses: [...vision.clauses, { id: 'V-3', kind: 'good', text: 'Errors are explicit.', rank: null, state: 'active' }] }));
      const applied = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      const base = coverageBase(ctx, S2)!;
      assert.deepEqual([base.head, base.visionSha256], [S, r.journal.view.planApplied()!.visionSha256], 'the arc\'s base, and the vision now in force');
      assert.deepEqual(lensCoverage(r.journal.view.holistic(), base, 'invariants').followed, [], 'audit-1\'s range was recorded under the old vision');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S, true], ['vision', S, true]], 'every lens\'s coverage is cleared back to the arc\'s base');
      const rev = r.journal.view.planApplied()!.rev;
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan, { triggers: [{ type: 'drift', planRev: rev }], lenses: ['vision'], generation: 2 });
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.equal(started(r)[1]!.visionSha256, base.visionSha256);
      assert.deepEqual(ended(r)[1]!.covered, [{ lens: 'vision', from: S, to: S2 }], 'the vision lens covers everything up to S2, S1→S2 included');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S, true], ['vision', S2, false]], 'invariants stays owed until its own next audit');
    } finally {
      stop();
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash: the audit job (the matrix row AUDIT_JOB)

describe(`matrix row ${AUDIT_JOB}`, () => {
  /**
   * The occurrences crashed per label (the recording mode lists them for this audit's one process): spawn.after-runner-exit
   * #1 is the arc lane's, #2 the first lens call's (vision); #3, the second lens call's, is a pure repeat of #2 (a lens
   * call whose result is unread, the earlier lens's read already durable as audit.after-lens#1 leaves it). audit.after-lens
   * #1 follows the first lens's read, #2 the second's (every lens read, the checkout not yet removed).
   */
  const OCCURRENCES: Readonly<Record<string, readonly number[]>> = { 'spawn.after-runner-exit': [1, 2], 'audit.after-lens': [1, 2] };
  /**
   * How recovery closes the ops each crash leaves open (closedAs), per `label#occurrence`: a spawn whose runner exited
   * before its result was certified is redone (the result re-derived from exit.json, never asked again); the job's own
   * records leave nothing open.
   */
  const CLOSED: Readonly<Record<string, readonly string[]>> = {
    'audit.after-started#1': [], 'spawn.after-runner-exit#1': ['proc.spawn:redone'], 'spawn.after-runner-exit#2': ['proc.spawn:redone'],
    'audit.after-lens#1': [], 'audit.after-lens#2': [], 'audit.before-ended#1': [], 'audit.after-ended#1': [],
  };
  /** The lens calls asked before each crash; the resumed job asks only the rest. */
  const LENSES_ASKED: Readonly<Record<string, readonly string[]>> = {
    'audit.after-started#1': [], 'spawn.after-runner-exit#1': [], 'spawn.after-runner-exit#2': ['vision'], 'audit.after-lens#1': ['vision'],
    'audit.after-lens#2': ['vision', 'invariants'], 'audit.before-ended#1': ['vision', 'invariants'], 'audit.after-ended#1': ['vision', 'invariants'],
  };
  /** The job's arc lane spawns: the lane cut short at its runner's exit runs again on resume (no witnessed fact before). */
  const laneSpawns = (r: ArcRun): number => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length;
  for (const cell of crashCells(AUDIT_JOB)) for (const occurrence of OCCURRENCES[cell.label] ?? [1]) {
    test(`audit crashed at ${cell.boundary} ${cell.label}#${occurrence}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d } = auditArc({ steps: [lensStep('audit-1', 'vision'), lensStep('audit-1', 'invariants')], units: [{ id: 'u1' }], ...I1, mapping: [], audit: { lenses: [...L2] } });
      const setup = contextFor(d);
      requestAudit(setup);
      setup.journal.close();
      const trigger = writeTrigger(tmpDir('audit-crash'), { label: cell.label, occurrence });
      const exit = await runFixture('audit-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}#${occurrence}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      const open = r.journal.view.openIntents();
      const callsBefore = lensCalls(r).map((c) => c.lens);
      const { ctx, w } = auditContext(r);
      try {
        await recover({ stage: ctx, commands: w.commands });
        const closed = closedAs(r.journal.view, open);
        const expected = CLOSED[`${cell.label}#${occurrence}`];
        if (expected === undefined) throw new Error(`no expectation for ${cell.label}#${occurrence}`);
        assert.deepEqual(closed, expected, 'the ops the crash left open, as recovery closed them');
        // The occurrence crashed is the one named: the arc lane's spawn, then the vision lens call's.
        if (cell.label === 'spawn.after-runner-exit') assert.deepEqual(open.map((i) => (i.kind === 'proc.spawn' ? i.expect.subject.purpose : i.kind)), [occurrence === 1 ? 'journey' : 'arc-backend']);
        assert.deepEqual(callsBefore, LENSES_ASKED[`${cell.label}#${occurrence}`], 'the lens calls made before the crash');
        const out = await runAudit(ctx);
        if (cell.label === 'audit.after-ended') assert.deepEqual(out, { kind: 'none' });
        else assert.ok(out.kind === 'ended' && out.outcome === 'completed' && out.job === 'audit-1', JSON.stringify(out));
        assert.deepEqual([started(r).length, ended(r).map((e) => e.outcome)], [1, ['completed']]);
        assert.deepEqual(lensCalls(r).map((c) => c.lens), ['vision', 'invariants'], 'no lens asked twice');
        assert.equal(laneSpawns(r), cell.label === 'spawn.after-runner-exit' && occurrence === 1 ? 2 : 1, 'the arc lane runs again only when cut short');
        assert.deepEqual(r.journal.view.openIntents(), []);
        assert.equal(git(d.repo, 'worktree', 'list', '--porcelain').includes('audit-1.'), false, 'no audit checkout left');
        assert.deepEqual(await runAudit(ctx), { kind: 'none' });
      } finally {
        r.journal.close();
      }
    });
  }
});
