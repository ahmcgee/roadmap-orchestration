// M4a rev 3 step N6: `roadmap status`'s and the brief's run-10 keys (src/status.ts, src/brief.ts) and the needs-user
// texts (src/needsuser.ts, src/pipeline/failures.ts), over real arcs (real git, real processes, fake backends): lane
// failures with host-suspected signatures (F3), the running lane (8c), drains after a rejected apply (8b), known-defect
// holds (F4), a checkpoint waiting at a stage boundary (C5), checkpoint admits, opportunities and the drift indicator
// (OR-A1) in status and in the brief, and the re-entry text (8a). Named tests: status.failures-host-suspected,
// status.running-lane, status.drainfor-after-rejected-apply, status.known-defect-holds, status.checkpoint-busy-wait,
// status.drift-indicator, brief.admits-and-opportunities, needsuser.reentry-text-prepare-creates-branch.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { brief } from '../src/commands/brief.ts';
import { arcId, laneId, sha, unitId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { sha256Hex } from '../src/core/json.ts';
import type { LaneDef } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { git, gitRun, lsTree } from '../src/git/git.ts';
import { snapshotRef, snapshotRequestOf, verifySnapshot } from '../src/git/snapshot.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import type { HostSample } from '../src/host/sample.ts';
import { reentryRecommendation } from '../src/needsuser.ts';
import { type StageContext, type StageParent, pinDispatch } from '../src/pipeline/dispatch.ts';
import { type LaneFailure, failuresText, laneFailures } from '../src/pipeline/failures.ts';
import { type LaneRuntime, laneOrder, reserveNow, runLaneSeries, seriesOrder, specSeriesRoot } from '../src/pipeline/lanes.ts';
import { executorIdentity, loadUnitSpec } from '../src/pipeline/stages.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { specFacts } from '../src/pipeline/reproduce.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { admitter } from '../src/schedule/ready.ts';
import { type Status, status } from '../src/status.ts';
import { reached, release } from './helpers/barrier.ts';
import { withForge } from './helpers/corpusarc.ts';
import { sampleCorpus } from './helpers/corpus.ts';
import { checkpointAnswer, checkpointStep, lensStep } from './helpers/holistic.ts';
import { tmpDir } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { admitOp, checkpointContext, completedAudit } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc } from './fixtures/corpus-holistic.ts';
import { VISION_PATH } from './fixtures/corpus-unit.ts';
import { EXEC_TIMEOUT_MS, SMOKE_DEFAULT, cli, setupExec, startExec, statusOf, until } from './fixtures/exec-common.ts';
import { runOp } from './fixtures/git-common.ts';
import { editPlan, followContext, stepTo, unitOf } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS, type LaneJson, type StageRun, U1, admitAll, keptSpec, planCheckStep, setupUnit } from './fixtures/stage-common.ts';
import { idle, pausedFromTheStart, startCli, startLine } from './fixtures/sup-common.ts';
import { type ArcRun, appendSteps, contextFor, gateStep, mulBuild, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const TE = { timeout: EXEC_TIMEOUT_MS };
type Json = Record<string, unknown>;

const statusOfRun = (r: ArcRun): Status => status(r.ctx.runDir, arcId(r.d.arc), r.ctx.hostDir);

// ---------------------------------------------------------------------------------------------------
// F3: lane failures

const sample = (load1: number): HostSample => ({ load1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb: 900_000 });

describe('lane failures (F3)', () => {
  test('status.failures-host-suspected: a flaky lane and a host-signature red are listed per lanes attempt with their class; the host-suspected one names its signatures and the busy host; failuresText is the lanes park summary sentence', T, async () => {
    const once = join(tmpDir('flaky'), 'once');
    const oomed = join(tmpDir('oomed'), 'once');
    const lanes: readonly LaneJson[] = [
      { id: 'flaky', argv: ['sh', '-c', `if [ -f ${once} ]; then exit 0; fi; touch ${once}; echo "connection reset by peer" >&2; exit 1`] },
      // OOMKilled on its first run; its rerun fails on its own (a real defect the host signal hid).
      { id: 'oom', argv: ['sh', '-c', `if [ -f ${oomed} ]; then echo "assertion failed: berth 3 is double-booked" >&2; exit 1; fi; touch ${oomed}; echo "Last State: Terminated  Reason: OOMKilled" >&2; exit 1`] },
    ];
    const run: StageRun = setupUnit({ steps: [], lanes });
    pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
    const defs = laneOrder(loadUnitSpec(run.ctx, run.unit).spec);
    const byId = (id: string): LaneDef => defs.find((l) => l.id === id)!;
    const series = (attempt: number, lane: LaneDef, sampleHost: () => HostSample) => {
      const parent: StageParent = { type: 'stage', unit: U1, stage: 'lanes', attempt };
      const rt: LaneRuntime = { acquire: reserveNow(run.ctx), rank: () => { throw new Error('not ranked'); }, signal: new AbortController().signal, sampleHost };
      const checkout = { path: absPath(join(tmpDir('status-rev3-tree'), 'tree')), checkout: { type: 'detached', at: run.base } } as const;
      return runLaneSeries(run.ctx, parent, seriesOrder([lane]), 'spec', checkout, specSeriesRoot(run.ctx.runDir, parent), rt, false);
    };
    const redOutcome = (attempt: number) => run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'lanes', attempt, outcome: 'red', class: 'advance', chargeable: true });
    // Attempt 1: red on a clear host, then green on the diagnostic rerun: flaky, no signature (the first run counts: red).
    const flaky = await series(1, byId('flaky'), () => sample(1));
    assert.deepEqual([flaky.end.kind, flaky.ledger[0]?.flaky], ['red', true]);
    assert.deepEqual(laneFailures(run.ctx, run.unit), [], 'an attempt still open (no outcome yet) is not read');
    redOutcome(1);
    // Attempt 2: OOMKilled on a busy host (both samples), rerun once the host is clear, red again.
    let samples = 0;
    const busyFirst = (): HostSample => sample(samples++ < 2 ? 40 : 1);
    assert.equal((await series(2, byId('oom'), busyFirst)).end.kind, 'red');
    redOutcome(2);

    const expected: readonly LaneFailure[] = [
      { stage: 'lanes', attempt: 1, lane: laneId('flaky'), class: 'flaky', hostSuspected: null },
      { stage: 'lanes', attempt: 2, lane: laneId('oom'), class: 'red', hostSuspected: { signatures: ['oom-kill'], busy: true } },
    ];
    assert.deepEqual(laneFailures(run.ctx, run.unit), expected);
    const s = status(run.runDir, run.journal.view.arc, run.ctx.hostDir);
    assert.deepEqual(s.units[0]?.failures, expected, 'status lists the same, read back from the evidence');
    assert.equal(failuresText(expected), 'Lane failures: lanes#1 flaky flaky; lanes#2 oom red host-suspected (oom-kill; host busy).');

    // DESIGN §2.9: the failures derive from what the snapshot carries (the log and each red run's red.json), never raw
    // evidence: the run dir deleted and restored from the ref alone lists the same.
    const arc = run.journal.view.arc;
    await runOp(run.journal, snapshotPublishOp(run.repo), `snapshot:${arc}`, snapshotRequestOf({
      view: run.journal.view, runDir: run.runDir, identity: executorIdentity(), message: `roadmap ${arc}: snapshot\n`,
    }));
    run.journal.close();
    const at = sha(git(run.repo, ['rev-parse', snapshotRef(arc)]).trim());
    const check = verifySnapshot(run.repo, at);
    assert.equal(check.kind, 'verified', check.kind === 'mismatch' ? check.detail : '');
    const reds = lsTree(run.repo, at).map((e) => e.path).filter((p) => p.endsWith('/red.json'));
    assert.deepEqual(reds, ['evidence/u1/1-lanes/flaky/red.json', 'evidence/u1/2-lanes/oom/red.json'], 'each red run\'s class is in the snapshot');
    rmSync(run.runDir, { recursive: true, force: true });
    for (const e of lsTree(run.repo, at)) {
      if (e.path === 'manifest.json') continue;
      mkdirSync(dirname(join(run.runDir, e.path)), { recursive: true });
      writeFileSync(join(run.runDir, e.path), gitRun(run.repo, ['cat-file', 'blob', e.object]).stdout);
    }
    assert.deepEqual(status(run.runDir, arc, run.ctx.hostDir).units[0]?.failures, expected, 'restored from the ref alone');
  });
});

// ---------------------------------------------------------------------------------------------------
// 8a: the re-entry text

test('needsuser.reentry-text-prepare-creates-branch: a park recommends a re-entering unit whose prepare creates its branch at the parked tip, never by hand', () => {
  const text = reentryRecommendation(unitId('u3'), 'lanes', 'roadmap/arc-1/u3');
  assert.match(text, /re-enters u3 \(`"reenters": \{"unit": "u3"\}`/);
  assert.match(text, /the new unit's prepare creates its branch roadmap\/<arc>\/<new id> at the tip of roadmap\/arc-1\/u3\. Never create that branch by hand\./);
  assert.doesNotMatch(text, /create that unit's branch/);
});

// ---------------------------------------------------------------------------------------------------
// 8b, 8c: drains after a rejected apply, the running lane (real executors)

describe('status of a live arc', () => {
  test('status.running-lane: while a spec lane runs, the unit\'s running attempt names it (spec, its invocation, its start)', TE, async (t) => {
    const flag = join(tmpDir('lane-flag'), 'go');
    const r = setupExec(t, {
      units: [{ id: 'u1', lanes: [{ id: 'slow', argv: ['sh', '-c', `while [ ! -f ${flag} ]; do sleep 0.1; done`] }] }],
      steps: [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
    });
    const run = startExec(r);
    let s = await statusOf(r);
    await until(async () => (s = await statusOf(r)).units[0]?.running?.lane?.id === 'slow', 120_000, 'the slow lane running in status');
    const l = s.units[0]!;
    assert.equal(l.running?.stage, 'lanes');
    assert.equal(l.running.lane?.set, 'spec');
    assert.match(l.running.lane?.inv ?? '', new RegExp(`^${r.arc}/[0-9]+#1$`));
    assert.ok(Date.parse(l.running.lane?.startedAt ?? '') <= Date.now());
    writeFileSync(flag, '');
    const exit = await run.exit;
    assert.equal(exit.code, 0, exit.stdout + exit.stderr);
    assert.equal((await statusOf(r)).units[0]?.running, null);
  });

  test('status.drainfor-after-rejected-apply: an apply the executor rejected is pending nowhere and no unit drains for it', TE, async (t) => {
    const r = setupExec(t, { steps: SMOKE_DEFAULT });
    await pausedFromTheStart(r);
    const line = startLine(await startCli(r, []));
    assert.equal(line.kind, 'ready', JSON.stringify(line));
    await idle(r, line.generation!);
    // The files moved on (a spec edit nobody applied), so the apply is evaluated, and it expects a revision not in force.
    const spec = join(r.planPath, '..', 'u1.json');
    writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), rev: 2 }));
    const submitted = JSON.parse((await cli(r, ['apply', '--expect-rev', '7'])).stdout) as { command: string };
    let s = await statusOf(r);
    await until(async () => (s = await statusOf(r)).commands.receipts.some((x) => x.command === submitted.command), 60_000, 'the apply\'s receipt');
    assert.equal(s.commands.receipts.find((x) => x.command === submitted.command)?.state, 'rejected');
    assert.deepEqual(s.commands.pending, []);
    for (const u of s.units) {
      assert.deepEqual(u.waitingFor?.drainFor ?? [], [], `${u.unit} drains for nothing`);
      assert.ok(!(u.waitingFor?.admission ?? []).some((c) => c.type === 'drain'), JSON.stringify(u.waitingFor));
    }
    assert.equal(s.units[0]?.state, 'held', 'only the pause holds it');
  });
});

// ---------------------------------------------------------------------------------------------------
// F4: known-defect holds

test('status.known-defect-holds: a unit that hit K-1 waits at prepare under it (a dependency\'s wait); status lists the defect with its fixer and the unit it holds', T, async () => {
  const d = setupArc({ units: [{ id: 'u1' }, { id: 'u2' }], steps: [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/u1.js': 'export const u1 = true;\n' })] });
  editPlan(d, (p) => {
    p['knownDefects'] = [{ id: 'K-1', match: { type: 'lane', lane: 'mul' }, fixUnit: 'u2' }];
  });
  const r = contextFor(d);
  const admitted: Gate = (next) => Promise.resolve(next.kind === 'chain' || admitter((u) => r.ctx.routing(u).table, specFacts(r.ctx))({
    view: r.journal.view, plan: r.ctx.plan(), unit: r.unit('u1'), stage: next.stage, blocking: [], drains: [], tripped: [],
  }).kind === 'admit');
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitted), { kind: 'held', needsUser: null });
    const s = statusOfRun(r);
    assert.deepEqual(s.knownDefects, [{ id: 'K-1', match: { type: 'lane', lane: 'mul' }, fixUnit: 'u2', fixMerged: false, holds: ['u1'] }]);
    const u1 = s.units.find((u) => u.unit === 'u1')!;
    assert.equal(u1.state, 'awaiting-admission');
    assert.deepEqual(u1.waitingFor?.admission, [{ type: 'known-defect', id: 'K-1', fixUnit: 'u2' }]);
    assert.equal(u1.priority?.priority, 'normal');
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Corpus arcs: a busy checkpoint, admits, opportunities, drift, the brief

/** The corpus arc's vision with two more world clauses outside the slice (advances = [V-1]): V-3 and V-4. */
function visionWithHorizon(): string {
  const text = sampleCorpus().files[VISION_PATH]!;
  return `${JSON.stringify({
    schema: 'roadmap/vision-m3', rev: 1, confirmation: { ref: `corpus:0005_Vision.md#sha256:${sha256Hex(text)}`, at: '2026-10-01T00:00:00.000Z' },
    clauses: [
      { id: 'V-1', kind: 'world', text: 'Every vessel finds a berth.', rank: null, state: 'active' },
      { id: 'V-2', kind: 'purpose', text: 'A calm harbour.', rank: null, state: 'active' },
      { id: 'V-3', kind: 'world', text: 'A cancelled berth goes back to the pool.', rank: null, state: 'active' },
      { id: 'V-4', kind: 'world', text: 'The harbour master sees the day at a glance.', rank: null, state: 'active' },
    ],
    questions: [],
  }, null, 2)}\n`;
}
const admitStep = (a: CorpusHolisticArc, id: string, cites: readonly string[]): JsonValue => ({ ...(admitOp(a.d, id) as Json), cites: [...cites] } as JsonValue);

test('status.checkpoint-busy-wait: a checkpoint rejected busy shows "waiting for <unit> <stage> boundary" until the attempt closes', T, async () => {
  const pc = planCheckStep({ decision: 'approve' });
  const limitsU1: JsonValue = { op: 'limits', unit: 'u1', limits: [{ field: 'chargeable', value: 2 }], cites: ['V-1'], evidence: ['audit-1'] };
  const a = await corpusHolisticArc([
    lensStep('audit-1', 'vision'),
    { ...pc, acts: [{ type: 'barrier', name: 'pc', timeoutMs: 120_000 }, ...pc.acts] } as Step,
    checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [limitsU1] })),
  ], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
  const r = contextFor(a.d);
  const { ctx } = checkpointContext(r);
  try {
    await completedAudit(r, ctx);
    const unit = stepTo(ctx, 'u1', (f) => f.stage === 'plan-check');
    await reached(a.d.scenarioDir, 'pc', 120_000);
    const first = await withForge(a.forge, () => runCheckpoint(ctx));
    assert.ok(first.kind === 'decided' && first.decision.kind === 'rejected' && first.decision.reason === 'busy', JSON.stringify(first));
    const waiting = await withForge(a.forge, () => statusOfRun(r));
    assert.deepEqual(waiting.checkpointWaits, [{ job: 'ckpt-1', waitingFor: [{ unit: 'u1', stage: 'plan-check', attempt: 1 }], line: 'checkpoint ckpt-1 waiting for u1 plan-check boundary' }]);
    release(a.d.scenarioDir, 'pc');
    await unit;
    assert.deepEqual((await withForge(a.forge, () => statusOfRun(r))).checkpointWaits, [], 'the boundary passed');
  } finally {
    r.journal.close();
  }
});

test('status.drift-indicator / brief.admits-and-opportunities: an oversight, an opportunity and a converted admit; a finding outside the slice on the oversight\'s merge is drift, a mixed one is not; the brief carries the admits, the opportunity, the drift and the converted admit under its amendment', T, async () => {
  const a = await corpusHolisticArc([lensStep('audit-1', 'vision')], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
  appendSteps(a.d, [
    checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitStep(a, 'over', ['V-1']), admitStep(a, 'opp', ['V-1', 'V-3']), admitStep(a, 'aside', ['V-2'])] })),
    planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
    lensStep('audit-2', 'vision', [
      { severity: 'P2', visionClauses: ['V-4'], claim: 'mul shows no day view', cause: 'mul: no day view', evidence: [{ path: 'src/mul.js', line: 1 }] },
      { severity: 'P3', visionClauses: ['V-1', 'V-4'], claim: 'mul berths without a view', cause: 'mul: berths blind', evidence: [{ path: 'src/mul.js', line: 2 }] },
    ]),
  ]);
  const r = contextFor(a.d);
  const base = checkpointContext(r);
  const follow = followContext(r);
  const ctx = { ...base.ctx, plan: follow.plan, routing: follow.routing };
  try {
    await completedAudit(r, ctx);
    const decided = await withForge(a.forge, () => runCheckpoint(ctx));
    assert.ok(decided.kind === 'decided' && decided.decision.kind === 'applied', JSON.stringify(decided));
    assert.deepEqual(await runUnit(follow, unitOf(follow, 'over'), admitAll), { kind: 'merged' });
    await completedAudit(r, ctx);

    const s = await withForge(a.forge, () => statusOfRun(r));
    assert.deepEqual(s.admits.map(({ seq: _, ...x }) => x), [
      { job: 'ckpt-1', index: 0, unit: 'over', class: 'oversight', clauses: ['V-1'], followUp: null },
      { job: 'ckpt-1', index: 1, unit: 'opp', class: 'opportunity', clauses: ['V-3'], followUp: null },
    ]);
    assert.deepEqual(s.opportunities, [{ id: 'O-1', clauses: ['V-3'], units: ['opp'], followUps: 0, spentUsd: 0, overrun: [] }], 'opp never ran: nothing spent');
    const f1 = r.journal.view.holistic().findings.find((f) => f.claim === 'mul shows no day view')!;
    assert.deepEqual(s.drift, [
      { unit: 'over', job: 'ckpt-1', class: 'oversight', merged: ['over'], findings: [{ id: f1.id, severity: 'P2', clauses: ['V-4'], claim: 'mul shows no day view' }] },
    ]);
    assert.deepEqual(s.amendments.filter((m) => m.source.type === 'admit').map((m) => m.source), [{ type: 'admit', job: 'ckpt-1', index: 2, reason: 'unrelated' }]);

    // The brief reads the arc's snapshot ref: publish one at the head of the log.
    await runOp(r.journal, snapshotPublishOp(absPath(a.d.repo)), `snapshot:${a.d.arc}:status-rev3`, snapshotRequestOf({
      view: r.journal.view, runDir: r.ctx.runDir, identity: executorIdentity(), message: `roadmap ${a.d.arc}: snapshot\n`,
    }));
    const b = await withForge(a.forge, () => brief({ repo: absPath(a.d.repo), ack: null }));
    assert.equal(b.kind, 'brief');
    if (b.kind !== 'brief') throw new Error('unreachable');
    const arc = b.payload.arcs.find((x) => x.arc === a.d.arc)!;
    assert.deepEqual(arc.admits, [
      { job: 'ckpt-1', index: 0, unit: 'over', class: 'oversight', clauses: ['V-1'], followUp: null },
      { job: 'ckpt-1', index: 1, unit: 'opp', class: 'opportunity', clauses: ['V-3'], followUp: null },
    ]);
    assert.deepEqual(arc.opportunities, s.opportunities);
    assert.deepEqual(arc.drift, [{ unit: 'over', job: 'ckpt-1', findings: [{ id: f1.id, clauses: ['V-4'] }] }]);
    assert.deepEqual(arc.amendments.filter((m) => m.admit !== null).map((m) => m.admit), [{ job: 'ckpt-1', index: 2, reason: 'unrelated' }]);
    assert.match(b.markdown, /#### Opportunities\n\n- O-1 advances V-3: units opp; 0 follow-ups; \$0/);
    assert.match(b.markdown, new RegExp(`- over \\(ckpt-1\\): 1 — ${f1.id} V-4`));
    assert.match(b.markdown, /\[converted admit ckpt-1#2: unrelated\]/);
  } finally {
    r.journal.close();
  }
});
