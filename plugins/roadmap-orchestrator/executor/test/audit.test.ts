// M3 step B5: the cadence audit (src/holistic/{audit,cadence,coverage}.ts) and the arc roles' call (src/pipeline/dispatch.ts
// `callArcRole`), over real arcs: real git, real processes, the fake claude answering lens calls keyed by job and lens, fake
// witness lanes scripted per tree. Named tests: cadence.triggers, cadence.final-outstanding-lenses (H9),
// audit.immutable-inputs, audit.coverage, audit.one-call-per-lens (R-16), audit.race-ends-before-merge and audit.race-merge-during-audit (both race
// orders), audit.owed, audit.skipped-on-park, audit.starts-in-ff-window (H2), coverage.docs-edge-contiguous (H8), coverage.docs-edge-subsumed,
// coverage.vision-reset (H3), the crash cells of the matrix row AUDIT_JOB (test/matrix.ts), and M4a rev 3 (N5):
// cadence.spec-only-bundle-vision-lens-only, cadence.obligation-bundle-full-drift, the 2026-10-24 field fixes
// cadence.exempt-not-unwitnessed and cadence.drift-throttled, audit.cross-lens-merge-corroborated,
// audit.cross-lens-different-cause-separate (with a refused mutant refused again); M4b: audit.refused-mutant-retried; the
// lens-range fix (2026-10-16): audit.range-chunked, audit.oversized-publication-bounded, audit.upgrade-dev10-oversized-range,
// audit.chunk-crash-resume.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { applyCommand, evaluateRevision, keepRevision, payloadOf } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type CommandId, type Sha, commandId, findingId, jobId, opKey, sha256, sha, visionClauseId } from '../src/core/ids.ts';
import { absPath, branchName, isoTimeOf } from '../src/core/values.ts';
import { MUTANT_PATCH_INPUT } from '../src/git/mutant.ts';
import { corroborateFinding } from '../src/holistic/findings.ts';
import { readInputFiles } from '../src/input/inforce.ts';
import { commitRevision } from '../src/recover/revision.ts';
import { fakeDocs } from './fixtures/docs-fake.ts';
import { readJournal } from '../src/core/log.ts';
import { type AuditContext, runAudit } from '../src/holistic/audit.ts';
import { type Cadence, DRIFT_THROTTLE_MIN, cadence } from '../src/holistic/cadence.ts';
import { coverageBase, coverageOf, lensCoverage } from '../src/holistic/coverage.ts';
import { findingKey } from '../src/holistic/types.ts';
import { openBlocking, readNeedsUser } from '../src/needsuser.ts';
import { LENS_DIFF_BUDGET } from '../src/holistic/lensdiff.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { jobRepairStep, lensAnswer, lensStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { AUDIT_JOB, crashCells } from './matrix.ts';
import { auditArc, auditContext, factsOf, mapped, moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { VISION, obligationsJson } from './fixtures/brake-common.ts';
import { API_OP, barrierSuite, closedAs, ruleRecord, submitRule } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor, stepUntil, visionApplyBody } from './fixtures/unit-common.ts';

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
/** Every call of audit `job`: its lenses' first calls and their repair turns (whose prompt names no lens). */
const auditCalls = (r: ArcRun, job = 'audit-1') => readCalls(r.d.scenarioPath).filter((c) => c.unit === job);
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

  test('cadence.exempt-not-unwitnessed (R8, field fix 2026-10-24): a publication selecting deferred, waived or retired obligations left unwitnessed owes no trigger for them; an active future one still does', T, async () => {
    const ids = ['I-1', 'I-2', 'I-3', 'I-4', 'I-5'];
    const { d } = auditArc({
      steps: unitSteps('u1', moduleFiles('mul', '*')),
      units: [{ id: 'u1', obligations: ids }, { id: 'u2', obligations: ['I-1'] }],
      obligations: [
        { id: 'I-1', testIds: ['t1'] },
        { id: 'I-2', activation: 'future', deliveredBy: ['u1', 'u2'], testIds: ['t2'] },
        { id: 'I-3', activation: 'future', deliveredBy: ['u1', 'u2'], testIds: ['t3'], state: { type: 'deferred', ruling: 'C-1' } },
        { id: 'I-4', testIds: ['t4'], state: { type: 'waived', ruling: 'C-1' } },
        { id: 'I-5', testIds: ['t5'], state: { type: 'retired', ruling: 'C-1' } },
      ],
      mapping: mapped(ids), trees: { '*': { outcomes: { t1: 'pass' } } }, audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(owed(cadence(ctx, ctx.clock)), ['unwitnessed:I-2']);
    } finally {
      r.journal.close();
    }
  });

  test('cadence.drift-throttled (field fix 2026-10-24): while work remains, drift within DRIFT_THROTTLE_MIN of the latest audit start is owed but runs no audit; once the period passes, or with another fresh trigger, one audit records every drift', T, async () => {
    const { d } = auditArc({
      steps: [lensStep('audit-1', 'vision')], units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      await rule(w, r, 'C-2');
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan?.triggers, [{ type: 'drift', planRev: 2 }], 'no audit yet: the first drift runs one at once');
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      await rule(w, r, 'C-3', { statement: 'Helpers never round.' });
      await rule(w, r, 'C-4', { statement: 'Helpers never truncate.' });
      const drifts = [{ type: 'drift', planRev: 3 }, { type: 'drift', planRev: 4 }];
      assert.deepEqual([owed(cadence(ctx, ctx.clock)), cadence(ctx, ctx.clock)!.plan], [['drift:3', 'drift:4'], null], 'owed, inside the period');
      assert.equal(cadence(ctx, () => DRIFT_THROTTLE_MIN - 1)!.plan, null);
      assert.deepEqual(cadence(ctx, () => DRIFT_THROTTLE_MIN)!.plan, { triggers: drifts, lenses: ['vision'], generation: 2 }, 'the period passed: one audit records both');
      const asked = requestAudit(r, ['invariants']);
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan?.triggers, [...drifts, { type: 'requested', command: asked }], 'another fresh trigger runs it at once, the held drifts with it');
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('cadence.empty-coverage-and-wall-clock: ordinary triggers need an outstanding selected range; requests and semantic drift inspect an unchanged head; the timer needs a publication since the latest audit started', T, async () => {
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/')), lensStep('audit-1', 'vision'), lensStep('audit-2', 'vision')],
      units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }], ...I1, mapping: [], audit: { every: 1, lenses: ['vision'], wallClockMin: 1 },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      assert.equal(cadence(ctx, () => 10)!.plan, null, 'no publication: no wall-clock audit at the initial head');
      await runUnit(ctx, r.unit('u1'), admitAll);
      assert.equal(cadence(ctx, () => 10)!.owed.some((t) => t.type === 'wall-clock'), true);
      assert.equal((await runAudit(ctx)).kind, 'ended');
      assert.equal(cadence(ctx, () => 10)!.plan, null, 'the timer cannot audit the same head twice');
      await runUnit(ctx, r.unit('u2'), admitAll);
      // The docs-covered edge uses the same watermark calculation as real docs publications. The cadence trigger is
      // still owed, but none of its selected lenses has an outstanding range, so pending and capture both suppress it.
      const previous = started(r)[0]!;
      r.journal.fact({ kind: 'docs-covered', pub: jobId('docs', 99), from: previous.integrationSha, to: head(d.repo) });
      assert.equal(cadence(ctx, () => 10)!.due, false);
      assert.equal(cadence(ctx, () => 10)!.plan, null);
      assert.deepEqual(await runAudit({ ...ctx, clock: () => 10 }), { kind: 'none' });
      assert.equal(started(r).length, 1, 'no audit-started for an empty ordinary audit');
      requestAudit(r);
      assert.equal((await runAudit(ctx)).kind, 'ended', 'an explicit request still runs at empty coverage');
      assert.equal(started(r).length, 2);
      assert.deepEqual(ended(r)[1]!.covered, []);
    } finally {
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
      steps: [...unitSteps('u2', moduleFiles('div', '/')), ...unitSteps('u1', moduleFiles('mul', '*')), barrierLens('audit-1', 'vision'), lensStep('audit-1', 'invariants')],
      units: [{ id: 'u1' }, { id: 'u2', lanes: [] }], ...I1, mapping: [], audit: { lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      const base = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
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
      assert.deepEqual(ended(r)[0]!.covered, L2.map((lens) => ({ lens, from: base, to: S })), 'the audit covers the published range captured before the ruling');
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

  for (const earlierOperations of [1, 2, 3]) {
    test(`audit.lost-call-cap: ${earlierOperations} earlier operations of one logical lens call survive a restart; only two reissues are allowed`, T, async () => {
      const { d } = auditArc({ steps: [lensStep('audit-1', 'vision')], units: [{ id: 'u1' }], ...I1, mapping: [], audit: { lenses: ['vision'] } });
      const setup = contextFor(d);
      requestAudit(setup);
      setup.journal.close();
      const trigger = writeTrigger(tmpDir('audit-lost-cap'), { label: 'audit.after-started', occurrence: 1 });
      const exit = await runFixture('audit-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', exit.stderr);
      assertFired(trigger);
      let r = contextFor(d);
      for (let i = 0; i < earlierOperations; i++) {
        const { op } = r.journal.begin({
          kind: 'proc.spawn', key: opKey('backend:audit-1'), parent: { type: 'job', job: jobId('audit', 1) }, deadlineAt: isoTimeOf(new Date(Date.now() + 60_000)),
          body: () => ({ expect: { subject: { purpose: 'arc-backend', job: jobId('audit', 1), role: 'lens', tier: 'arc', routingRev: r.ctx.routing(null).rev, attempt: 1 }, launchSha256: sha256('0'.repeat(64)) }, post: null }),
        });
        r.journal.done(op, 'proc.spawn', { kind: 'lost', treeEffects: false }, 'reconciled');
        // Reopen between losses: the budget comes from the journal, never a process-local counter.
        r.journal.close();
        r = contextFor(d);
      }
      try {
        const out = await runAudit(auditContext(r).ctx);
        assert.ok(out.kind === 'ended' && out.outcome === (earlierOperations < 3 ? 'completed' : 'abandoned'), JSON.stringify(out));
        assert.equal(lensCalls(r).length, earlierOperations < 3 ? 1 : 0);
        const calls = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'arc-backend');
        assert.equal(calls.length, earlierOperations < 3 ? earlierOperations + 1 : 3);
      } finally {
        r.journal.close();
      }
    });
  }

  test('audit.one-call-per-lens (paid M4a run 10, R-16): an audit asks each lens of its plan exactly once, the vision first; the spawn\'s attempt is the lens\'s ordinal in that order, never a retry', T, async () => {
    const ALL: readonly Lens[] = ['drift', 'invariants', 'vacuity', 'vision'];
    const { d } = auditArc({
      steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...['vision', 'drift', 'invariants', 'vacuity'].map((l) => lensStep('audit-1', l as Lens))],
      units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']),
      audit: { every: 5, lenses: [...ALL] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(lensCalls(r).map((c) => c.lens), ['vision', 'drift', 'invariants', 'vacuity']);
      const spawns = r.journal.view.opsOf('proc.spawn').filter((i) => i.parent.type === 'job' && i.parent.job === 'audit-1');
      assert.deepEqual(spawns.map((i) => (i.expect.subject.purpose === 'arc-backend' ? i.expect.subject.attempt : null)), [1, 2, 3, 4]);
      assert.deepEqual(ended(r)[0]!.covered.map((c) => c.lens), [...ALL], 'one range per lens');
      assert.deepEqual(await runAudit(ctx), { kind: 'none' }, 'nothing asks a lens again on the unchanged head');
      assert.equal(lensCalls(r).length, 4);
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
      assert.deepEqual(cadence(ctx, () => 400)!.plan?.triggers, [{ type: 'requested', command: asked }], 'the request stays owed; no publication since the audit start, so no wall-clock trigger');
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
      const applied = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, visionApplyBody(d)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      const base = coverageBase(ctx, S2)!;
      assert.deepEqual([base.head, base.visionSha256], [S, r.journal.view.planApplied()!.visionSha256], 'the arc\'s base, and the vision now in force');
      assert.deepEqual(lensCoverage(r.journal.view.holistic(), base, 'invariants').followed, [], 'audit-1\'s range was recorded under the old vision');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S, true], ['vision', S, true]], 'every lens\'s coverage is cleared back to the arc\'s base');
      const rev = r.journal.view.planApplied()!.rev;
      assert.equal(cadence(ctx, ctx.clock)!.plan, null, 'u3 remains and audit-1 just started: the drift is throttled');
      const settled = { ...ctx, clock: () => DRIFT_THROTTLE_MIN };
      assert.deepEqual(cadence(settled, settled.clock)!.plan, { triggers: [{ type: 'drift', planRev: rev }], lenses: ['vision'], generation: 2 });
      const out = await runAudit(settled);
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

// ---------------------------------------------------------------------------------------------------
// M4a rev 3 (step N5): change-sensitive drift (H2, R61) and cross-lens dedupe within one audit (H7, R62), with a
// vacuity draft whose mutant cannot be made refused at admission (H6), its lens asked once more (M4b).

const CKPT = jobId('ckpt', 1);

/** The checkpoint whose bundle the next revision comes from (its generation numbers the audit the revision triggers). */
function checkpointInputs(r: ArcRun): void {
  const visionSha256 = r.journal.view.planApplied()!.visionSha256!;
  r.journal.fact({
    kind: 'checkpoint-inputs', job: CKPT, trigger: { type: 'audit', job: jobId('audit', 9) }, generation: 1,
    vector: { plan: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, visionSha256, contracts: [] },
    headSha: head(r.d.repo), visionSha256, findings: [], observations: [],
  });
}

/** Commits the plan files as they stand now as a revision of checkpoint `ckpt-1`'s bundle. */
async function bundleRevision(r: ArcRun): Promise<void> {
  checkpointInputs(r);
  const rctx = { runDir: r.ctx.runDir, view: r.journal.view, hostDir: r.ctx.hostDir, planFile: absPath(r.d.planPath), routingBase: { profile: 'default', config: null, arcRoles: 'm4b' }, laneEnv: process.env } as const;
  const v = evaluateRevision(rctx, readInputFiles(absPath(r.d.planPath), absPath(r.d.repo)), { type: 'bundle', job: CKPT, cites: [visionClauseId('V-1')], evidence: ['the scripted bundle'], admits: [], fixesUnrecorded: [] });
  assert.equal(v.kind, 'accepted', JSON.stringify(v));
  if (v.kind !== 'accepted') return;
  keepRevision(r.ctx.runDir, v);
  const committed = await commitRevision({ journal: r.journal, runDir: r.ctx.runDir, docs: fakeDocs(r.journal, absPath(r.d.repo), branchName('main')) },
    payloadOf(v.draft, { type: 'bundle', job: CKPT }), { type: 'job', job: CKPT });
  assert.equal(committed.kind, 'applied', JSON.stringify(committed));
}

const editJsonFile = (path: string, edit: (v: Record<string, unknown>) => Record<string, unknown>): void =>
  writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)));
const L3: readonly Lens[] = ['drift', 'invariants', 'vision'];

describe('change-sensitive drift (M4a rev 3, H2)', () => {
  test('cadence.spec-only-bundle-vision-lens-only: a bundle revision changing only a unit\'s spec records drift{specsOnly} and runs the vision lens alone over that spec; the code lenses keep their watermarks', T, async () => {
    const { d } = auditArc({ steps: [lensStep('audit-1', 'vision')], units: [{ id: 'u1', obligations: ['I-1'] }, { id: 'u2', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L3] } });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const before = watermarks(ctx, L3);
      editJsonFile(join(d.planPath, '..', 'u2.json'), (s) => ({ ...s, acceptance: [...(s['acceptance'] as unknown[]), { id: 'A9', clause: 'div rounds toward zero.', failLoudIfUndelivered: false, state: 'active' }] }));
      await bundleRevision(r);
      assert.deepEqual(r.journal.view.planApplied()!.changes.map((c) => c.type), ['spec']);
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan, { triggers: [{ type: 'drift', planRev: 2, specsOnly: ['u2'] }], lenses: ['vision'], generation: 2 });
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(lensCalls(r).map((c) => `${c.unit}:${c.lens}`), ['audit-1:vision'], 'no code lens ran');
      const stdin = lensCalls(r)[0]!.stdin;
      assert.match(stdin, /<specs_only>[\s\S]*spec of unit u2, revision 1[\s\S]*div rounds toward zero\.[\s\S]*<\/specs_only>/, 'the lens reads the changed spec, embedded');
      assert.doesNotMatch(stdin, /spec of unit u1/, 'and only it');
      assert.deepEqual(watermarks(ctx, ['drift', 'invariants']), before.filter(([l]) => l !== 'vision'), 'the code lenses keep their watermarks');
    } finally {
      r.journal.close();
    }
  });

  test('cadence.obligation-bundle-full-drift: a bundle revision changing the obligations drifts fully (L ∩ {drift, vision}), its lenses reading the whole tree', T, async () => {
    const { d, control } = auditArc({ steps: [lensStep('audit-1', 'vision'), lensStep('audit-1', 'drift')], units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L3] } });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const obligations = [...I1.obligations, { id: 'I-2', testIds: ['t2'] }];
      writeFileSync(join(d.planPath, '..', 'obligations.json'), JSON.stringify(obligationsJson({ obligations, mapping: mapped(['I-1', 'I-2']) }, control)));
      editJsonFile(join(d.planPath, '..', 'u1.json'), (s) => ({ ...s, obligations: ['I-1', 'I-2'] }));
      await bundleRevision(r);
      assert.ok(r.journal.view.planApplied()!.changes.some((c) => c.type === 'obligation'), JSON.stringify(r.journal.view.planApplied()!.changes));
      assert.deepEqual(cadence(ctx, ctx.clock)!.plan, { triggers: [{ type: 'drift', planRev: 2 }], lenses: ['drift', 'vision'], generation: 2 });
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.doesNotMatch(lensCalls(r)[0]!.stdin, /<specs_only>/, 'a full drift');
    } finally {
      r.journal.close();
    }
  });
});

describe('cross-lens dedupe within one audit (M4a rev 3, H7)', () => {
  const SAME = { obligation: 'I-1', cause: 'mul: returns a float for integer inputs', evidence: [{ path: 'src/mul.js', line: 2 }] } as const;

  test('audit.cross-lens-merge-corroborated: a second lens\'s draft with the same repo evidence paths, obligation and cause corroborates the first lens\'s finding (its claim kept), opening none; a resumed audit writes it once', T, async () => {
    const { d } = auditArc({
      steps: [lensStep('audit-1', 'vision', [{ ...SAME, claim: 'mul breaks V-2\'s exact answer' }]), lensStep('audit-1', 'invariants', [{ ...SAME, claim: 'mul violates I-1', severity: 'P1' }])],
      units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: [...L2] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      const h = r.journal.view.holistic();
      assert.deepEqual(h.findings.map((f) => [f.id, f.lens, f.claim]), [['F-1', 'vision', 'mul breaks V-2\'s exact answer']], 'one finding');
      assert.deepEqual(h.corroborations.map((c) => [c.id, c.lens, c.claim]), [['F-1', 'invariants', 'mul violates I-1']], 'the second lens\'s rationale kept');
      assert.deepEqual(ended(r)[0]!.findings, ['F-1']);
      corroborateFinding(r.journal, findingId('F-1'), 'invariants', 'mul violates I-1');
      assert.equal(r.journal.view.holistic().corroborations.length, 1, 'idempotent: a resumed audit asking the lens again writes nothing new');
    } finally {
      r.journal.close();
    }
  });

  test('audit.cross-lens-different-cause-separate: drafts differing in cause or in repo evidence paths stay separate findings; a vacuity draft whose mutant cannot be made is refused at admission, recorded, asked once more, and takes the repair turn in its own session; refused again it leaves its lens uncovered (findings.mutant-refused)', T, async () => {
    // The backend's schema admits edits only (a pre-M4b recorded patch is findings.mutant-refused's).
    const nofile = { ...SAME, claim: 'corrupt mutant', mutant: { lane: 'journey', edits: [{ path: 'src/none.js', old: 'a', new: 'b' }] } };
    const absent = { ...SAME, claim: 'corrupt mutant', mutant: { lane: 'journey', edits: [{ path: 'src/add.js', old: 'a * b', new: 'a / b' }] } };
    const { d } = auditArc({
      steps: [
        lensStep('audit-1', 'vision', [{ ...SAME, claim: 'vision' }]),
        lensStep('audit-1', 'invariants', [{ ...SAME, cause: 'mul: overflows past 2^53', claim: 'other cause' }, { ...SAME, evidence: [{ path: 'src/add.js', line: 1 }], claim: 'other path' }]),
        lensStep('audit-1', 'vacuity', [nofile]),
        jobRepairStep('audit-1', lensAnswer([absent]), ['finding "corrupt mutant"', 'edit 1 (src/none.js): no regular file', 'report only the refused ones again']),
      ],
      units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: ['invariants', 'vacuity', 'vision'] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'abandoned', JSON.stringify(out));
      assert.deepEqual(out.covered, ['invariants', 'vision'], 'a lens whose draft was refused again is not covered');
      const h = r.journal.view.holistic();
      assert.deepEqual(h.findings.map((f) => [f.id, f.lens, f.claim]), [['F-1', 'vision', 'vision'], ['F-2', 'invariants', 'other cause'], ['F-3', 'invariants', 'other path']]);
      assert.deepEqual(h.corroborations, [], 'nothing merged across lenses');
      assert.deepEqual(lensCalls(r).map((c) => c.lens), ['vision', 'invariants', 'vacuity']);
      assert.equal(auditCalls(r).length, 4, 'the vacuity lens\'s repair turn, no further call');
      const [e] = ended(r);
      assert.equal(e!.outcome, 'abandoned', 'the audit is owed again');
      assert.deepEqual(e!.refused?.map((x) => [x.lens, x.attempt, x.claim, x.cause]), [['vacuity', 3, 'corrupt mutant', SAME.cause], ['vacuity', 4, 'corrupt mutant', SAME.cause]], 'each refusal recorded in the log');
      assert.match(e!.refused![0]!.reason, /^its mutant cannot be made: edit 1 \(src\/none\.js\): no regular file/);
      assert.match(e!.refused![1]!.reason, /edit 1 \(src\/add\.js\): old occurs 0 times/);
      assert.deepEqual(out.refused, e!.refused);
      assert.deepEqual(readdirSync(join(r.ctx.runDir, 'inputs')).filter((f) => f.endsWith(`.${MUTANT_PATCH_INPUT}`)), [], 'a refused mutant is never kept');
    } finally {
      r.journal.close();
    }
  });

  test('audit.refused-mutant-repaired: a vacuity draft whose mutant\'s old text is not in the file is refused, and the lens\'s session resumed with why (the repair turn); its corrected report is admitted, the mutant kept as a patch git wrote, and the lens covered', T, async () => {
    const mutant = (old: string) => ({ lane: 'journey', edits: [{ path: 'src/add.js', old, new: 'a - b' }] });
    const other = { ...SAME, cause: 'add: sign of zero', claim: 'admitted first time' };
    const { d } = auditArc({
      steps: [
        lensStep('audit-1', 'vacuity', [{ ...SAME, claim: 'add is vacuous', mutant: mutant('a +  b') }, other]),
        jobRepairStep('audit-1', lensAnswer([{ ...SAME, claim: 'add is vacuous', mutant: mutant('a + b') }]),
          ['finding "add is vacuous"', 'old occurs 0 times', 'the report\'s other findings are recorded']),
      ],
      units: [{ id: 'u1', obligations: ['I-1'] }], ...I1, mapping: mapped(['I-1']), audit: { every: 5, lenses: ['vacuity'] },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(out.covered, ['vacuity']);
      const [first, repair] = auditCalls(r);
      assert.equal(auditCalls(r).length, 2);
      assert.equal(repair!.argv[repair!.argv.indexOf('--resume') + 1], first!.argv[first!.argv.indexOf('--session-id') + 1], 'the repair turn resumes the lens\'s session');
      const h = r.journal.view.holistic();
      assert.deepEqual(h.findings.map((f) => [f.id, f.claim]), [['F-1', 'admitted first time'], ['F-2', 'add is vacuous']]);
      const m = h.findings[1]!.mutant;
      assert.ok(m !== null && m.lane === 'journey');
      const patch = readFileSync(join(r.ctx.runDir, 'inputs', `${m.patchSha256}.${MUTANT_PATCH_INPUT}`), 'utf8');
      assert.match(patch, /^diff --git a\/src\/add\.js b\/src\/add\.js\n[\s\S]*-  return a \+ b;\n\+  return a - b;\n }\n$/);
      assert.deepEqual(ended(r)[0]!.refused?.map((x) => [x.attempt, x.claim]), [[1, 'add is vacuous']]);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The lens-range fix (2026-10-16): a lens's outstanding range over the budget is reviewed in chunks by publication within
// one audit, each chunk's diff attached within the budget (src/holistic/lensdiff.ts); coverage records exactly what the
// reports reached. The fixtures' diffs are genuinely over LENS_DIFF_BUDGET (no test hook sets a smaller one).

/** About `n` bytes of source, in 50-byte lines tagged `tag`. */
const bigSource = (tag: string, n: number): string =>
  Array.from({ length: Math.ceil(n / 50) }, (_, i) => `${`export const ${tag}${i.toString().padStart(6, '0')} = 1;`.padEnd(49)}\n`).join('');
/** Two units, each publishing about 100 KB: their range together is over the budget, each alone within it. */
const TWO_BIG = [
  ...unitSteps('u1', { ...moduleFiles('mul', '*'), 'src/big1.js': bigSource('bigone', 100_000) }),
  ...unitSteps('u2', { ...moduleFiles('div', '/'), 'src/big2.js': bigSource('bigtwo', 100_000) }),
];
const TWO_UNITS = { units: [{ id: 'u1' }, { id: 'u2' }], ...I1, mapping: [] };
/** The `<audited_range>` opening tag a lens call's stdin carries. */
const rangeTag = (from: Sha, to: Sha, audited: Sha): string => `<audited_range from="${from}" to="${to}" audited="${audited}">`;
/**
 * The `spawn.after-runner-exit` occurrences of the chunk calls in a two-chunk audit of TWO_BIG (the recording mode lists
 * them for its one process): the arc lane's observation is reused from u2's publication, so the first spawn is chunk 1's.
 */
const CHUNK_SPAWN = [1, 2] as const;

describe('the lens-range fix: chunks by publication, bounded attachments', () => {
  test('audit.range-chunked: a range over the budget is reviewed chunk by chunk in one audit; a lens failing a later chunk keeps what it reported, and the next audit drains the rest', T, async () => {
    const { d } = auditArc({
      steps: [
        ...TWO_BIG,
        lensStep('audit-1', 'vision', [], [], ['bigone000100']), lensStep('audit-1', 'vision', [], [], ['bigtwo000100']),
        lensStep('audit-1', 'invariants', [], [], ['bigone000100']), { as: 'claude', unit: 'audit-1', lens: 'invariants', expect: {}, acts: [{ type: 'malformed' }] },
        lensStep('audit-2', 'invariants', [], [], ['bigtwo000100']),
      ],
      ...TWO_UNITS, audit: { every: 5, lenses: [...L2], wallClockMin: 1 },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    try {
      const S0 = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
      const S2 = head(d.repo);
      const first = await runAudit(ctx);
      assert.ok(first.kind === 'ended' && first.outcome === 'abandoned', JSON.stringify(first));
      assert.equal(started(r)[0]!.diffBudget, LENS_DIFF_BUDGET, 'the budget is a recorded input');
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'invariants', from: S0, to: S1 }, { lens: 'vision', from: S0, to: S2 }], 'the failed lens keeps the chunk it reported');
      const calls = lensCalls(r);
      assert.deepEqual(calls.map((c) => `${c.unit}:${c.lens}`), ['audit-1:vision', 'audit-1:vision', 'audit-1:invariants', 'audit-1:invariants']);
      assert.ok(calls[0]!.stdin.includes(rangeTag(S0, S1, S2)) && !calls[0]!.stdin.includes('bigtwo000100'), 'chunk 1: u1\'s publication alone');
      assert.ok(calls[1]!.stdin.includes(rangeTag(S1, S2, S2)) && !calls[1]!.stdin.includes('bigone000100'), 'chunk 2: from where chunk 1 ended');
      for (const c of calls) assert.doesNotMatch(c.stdin, /<not_inlined>/, 'each chunk attaches whole');
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S1, true], ['vision', S2, false]]);
      assert.deepEqual(cadence(ctx, () => 2)!.plan, { triggers: [{ type: 'final' }], lenses: ['invariants'], generation: 2 }, 'the final audit runs the partly covered lens alone');
      const again = await runAudit({ ...ctx, clock: () => 2 });
      assert.ok(again.kind === 'ended' && again.outcome === 'completed', JSON.stringify(again));
      assert.deepEqual(ended(r)[1]!.covered, [{ lens: 'invariants', from: S1, to: S2 }]);
      assert.ok(lensCalls(r)[4]!.stdin.includes(rangeTag(S1, S2, S2)));
      assert.deepEqual(watermarks(ctx, L2), [['invariants', S2, false], ['vision', S2, false]]);
      assert.deepEqual(owed(cadence(ctx, () => 2)), [], 'nothing outstanding: the arc converges');
    } finally {
      r.journal.close();
    }
  });

  test('audit.oversized-publication-bounded: one publication over the budget is attached bounded (stat, small files inlined, the large one and a derived output listed with their readable diff files), as is an owner\'s branch, and the lens reports', T, async () => {
    const { d } = auditArc({
      steps: [
        // Each unit's diff overflows the gate's budget too: its gate answers with a cluster map covering every changed path.
        ...unitSteps('u1', { ...moduleFiles('mul', '*'), 'src/huge.js': bigSource('hugeone', 300_000), 'dist/bundle.js': 'export const bundled = true;\n' }, { clusters: [{ id: 'all', paths: ['**'], review: 'close' }] }),
        ...unitSteps('u2', { 'src/ownerbig.js': bigSource('ownerbig', 300_000), 'src/owner.js': 'export const owner = 1;\n' }, { clusters: [{ id: 'all', paths: ['**'], review: 'close' }] }),
        lensStep('audit-1', 'vision'),
      ],
      units: [{ id: 'u1' }, { id: 'u2' }], ...I1, mapping: [], audit: { lenses: ['vision'] },
      planExtra: { derived: [{ sources: ['src/**'], outputs: ['dist/**'] }] },
    });
    const r = contextFor(d);
    const { ctx, w } = auditContext(r);
    const stop = ticking(w);
    try {
      const S0 = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      const S1 = head(d.repo);
      // u2 approved, not merged, owning a finding: its branch is an owner the lens reads.
      await stepUntil(r, 'u2', (f) => f.stage === 'gate' && f.outcome === 'approve');
      r.journal.fact({
        kind: 'finding-opened', id: r.journal.view.nextFindingId(), key: findingKey('plan-check', null, 'owner gap'), lens: 'plan-check', severity: 'P3',
        obligation: null, visionClauses: [VISION.clauses[0].id as never], claim: 'owner gap', evidence: [], mutant: null,
        source: { type: 'stage', unit: r.unit('u2').id, stage: 'plan-check', attempt: 1 }, gateHadPassed: false,
      });
      r.journal.fact({ kind: 'finding-transition', id: r.journal.view.holistic().findings[0]!.id, to: { state: 'owned', unit: r.unit('u2').id } });
      requestAudit(r);
      const out = await runAudit(ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'vision', from: S0, to: S1 }], 'the whole publication is covered by the one call');
      const [call] = lensCalls(r);
      const stdin = call!.stdin;
      assert.ok(stdin.includes(rangeTag(S0, S1, S1)));
      assert.ok(stdin.length < 2 * LENS_DIFF_BUDGET + 64_000, `the prompt is bounded: ${stdin.length} bytes`);
      assert.ok(!stdin.includes('hugeone000100') && !stdin.includes('ownerbig000100'), 'neither large file is attached');
      assert.match(stdin, /src\/huge\.js +\| +\d+ \+/, 'the stat names every file of the range');
      assert.match(stdin, /^\+export function mul\(a, b\) \{/m, 'the small files are inlined');
      // 1.0.0-dev.12: each file not shown is a readable diff file under the call's diff dir, which the call may read.
      const diffDir = join(d.runDir, 'evidence', 'jobs', 'audit-1', 'diffs', 'lens-1');
      const addDirs = call!.argv.flatMap((a, i) => (call!.argv[i - 1] === '--add-dir' ? [a] : []));
      assert.ok(addDirs.some((x) => diffDir === x || diffDir.startsWith(`${x}/`)), addDirs.join(', '));
      const huge = join(diffDir, 'range', 'files', 'src/huge.js.diff');
      assert.match(stdin, new RegExp(`- src/huge\\.js \\(new source, over the budget, \\d+ bytes\\): ${huge.replace(/[.]/g, '\\.')}\\n`));
      assert.equal(readFileSync(huge, 'utf8').trim(), git(d.repo, 'diff', '--no-color', '-M', S0, S1, '--', 'src/huge.js'), 'the readable file is what git diff prints (both trimmed)');
      assert.ok(stdin.includes(`- dist/bundle.js (derived output, regenerated from sources this diff changes, `) && stdin.includes(join(diffDir, 'range', 'files', 'dist/bundle.js.diff')));
      assert.doesNotMatch(stdin, /^\+export const bundled/m, 'a derived output is never inlined');
      assert.ok(stdin.includes(`- src/ownerbig.js (new source, over the budget, `) && stdin.includes(join(diffDir, 'owner-u2', 'files', 'src/ownerbig.js.diff')), 'the owner\'s branch is bounded too');
      assert.doesNotMatch(stdin, /git diff [0-9a-f]{40}/, 'no git command: a lens has no shell');
      assert.match(stdin, /^\+export const owner = 1;/m);
      assert.deepEqual(watermarks(ctx, ['vision']), [['vision', S1, false]]);
    } finally {
      stop();
      r.journal.close();
    }
  });

  test('audit.upgrade-dev10-oversized-range: an audit a dev.10 executor started (no diffBudget) resumes unchunked and is abandoned with an owed item; the next audit chunks and the arc converges', T, async () => {
    const { d } = auditArc({
      steps: [
        ...TWO_BIG,
        { as: 'claude', unit: 'audit-1', lens: 'vision', expect: {}, acts: [{ type: 'malformed' }] },
        lensStep('audit-2', 'vision', [], [], ['bigone000100']), lensStep('audit-2', 'vision', [], [], ['bigtwo000100']),
      ],
      ...TWO_UNITS, audit: { every: 5, lenses: ['vision'], wallClockMin: 1 },
    });
    const r = contextFor(d);
    const { ctx } = auditContext(r);
    const late = { ...ctx, clock: () => 2 };
    try {
      const S0 = head(d.repo);
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(await runUnit(ctx, r.unit('u2'), admitAll), { kind: 'merged' });
      const S2 = head(d.repo);
      // audit-started as a dev.10 executor wrote it: no diffBudget.
      const applied = r.journal.view.planApplied()!;
      r.journal.fact({
        kind: 'audit-started', job: jobId('audit', 1), triggers: [{ type: 'final' }], generation: 1, lenses: ['vision'], integrationSha: S2, planRev: applied.rev,
        ledgerSha256: applied.rulingsSha256 ?? null, obligationsSha256: applied.obligationsSha256 ?? null, visionSha256: applied.visionSha256!, owners: [], priorFindings: [],
        highWater: r.journal.view.highWater(),
      });
      const first = await runAudit(late);
      assert.ok(first.kind === 'ended' && first.job === 'audit-1' && first.outcome === 'abandoned', JSON.stringify(first));
      assert.ok(lensCalls(r)[0]!.stdin.includes(rangeTag(S0, S2, S2)), 'the dev.10 audit reads its whole range in one call');
      assert.match(lensCalls(r)[0]!.stdin, /<not_inlined>/, 'attached within today\'s budget');
      const item = r.journal.view.needsUser().find((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === 'audit-owed');
      assert.ok(item !== undefined && !item.blocking, 'the overdue audit raised its non-blocking item');
      const again = await runAudit(late);
      assert.ok(again.kind === 'ended' && again.job === 'audit-2' && again.outcome === 'completed', JSON.stringify(again));
      assert.equal(started(r)[1]!.diffBudget, LENS_DIFF_BUDGET);
      assert.deepEqual(ended(r)[1]!.covered, [{ lens: 'vision', from: S0, to: S2 }]);
      assert.equal(lensCalls(r).length, 3, 'two chunks');
      assert.deepEqual(owed(cadence(ctx, () => 2)), [], 'nothing owed: the audit no longer holds completion');
      assert.deepEqual(watermarks(ctx, ['vision']), [['vision', S2, false]]);
      assert.deepEqual(openBlocking(r.journal.view), [], 'the owed item never blocks; the owner acknowledges it as before');
    } finally {
      r.journal.close();
    }
  });

  /**
   * Crashed mid-chunking: at the runner exit of chunk 1's call (its result not yet read) or of chunk 2's, the resumed
   * job consumes the calls it made (redone from exit.json) and asks only the rest, at the same attempts.
   */
  for (const [occurrence, before] of [[CHUNK_SPAWN[0], 1], [CHUNK_SPAWN[1], 2]] as const) {
    test(`audit.chunk-crash-resume: crashed at the runner exit of chunk ${before}'s call, the job resumes and asks no chunk twice`, T, async () => {
      const { d } = auditArc({
        steps: [...TWO_BIG, lensStep('audit-1', 'vision', [], [], ['bigone000100']), lensStep('audit-1', 'vision', [], [], ['bigtwo000100'])],
        ...TWO_UNITS, audit: { every: 5, lenses: ['vision'] },
      });
      const setup = contextFor(d);
      const S0 = head(d.repo);
      try {
        const sctx = auditContext(setup).ctx;
        assert.deepEqual(await runUnit(sctx, setup.unit('u1'), admitAll), { kind: 'merged' });
        assert.deepEqual(await runUnit(sctx, setup.unit('u2'), admitAll), { kind: 'merged' });
      } finally {
        setup.journal.close();
      }
      const S2 = head(d.repo);
      const trigger = writeTrigger(tmpDir('audit-chunk-crash'), { label: 'spawn.after-runner-exit', occurrence });
      const exit = await runFixture('audit-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
      assertFired(trigger);
      const r = contextFor(d);
      const open = r.journal.view.openIntents();
      const { ctx, w } = auditContext(r);
      try {
        assert.deepEqual(open.map((i) => (i.kind === 'proc.spawn' ? i.expect.subject.purpose : i.kind)), ['arc-backend'], 'a lens call was cut short');
        assert.equal(lensCalls(r).length, before, 'the chunk calls made before the crash');
        await recover({ stage: ctx, commands: w.commands });
        const out = await runAudit(ctx);
        assert.ok(out.kind === 'ended' && out.job === 'audit-1' && out.outcome === 'completed', JSON.stringify(out));
        assert.deepEqual(ended(r)[0]!.covered, [{ lens: 'vision', from: S0, to: S2 }]);
        assert.equal(lensCalls(r).length, 2, 'no chunk asked twice');
        assert.deepEqual(r.journal.view.openIntents(), []);
        assert.deepEqual(await runAudit(ctx), { kind: 'none' });
      } finally {
        r.journal.close();
      }
    });
  }
});
