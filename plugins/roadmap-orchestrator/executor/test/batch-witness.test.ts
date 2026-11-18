// dev.83 (E3): arc witness lanes at `batch` cadence (src/pipeline/batchlanes.ts, the batch witness; holistic/types.ts
// `deferredLane`), over real arcs (real git, real processes, fake witness lanes scripted per tree): a unit delivering an
// obligation on a batch arc lane merges without running it; the merge count makes the witness due; green latches; a red
// bisects over the published heads and reopens the culprit deliverer or opens a P1 naming the culprit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Sha, jobId, opKey, sha, unitId } from '../src/core/ids.ts';
import { KIND_CADENCES } from '../src/core/records.ts';
import { keptInput } from '../src/input/inforce.ts';
import { DEFAULT_BATCH_EVERY, batchEveryOf } from '../src/input/plan.ts';
import { deferredLane, parseObligations } from '../src/holistic/types.ts';
import { batchWitnessDue, runBatchWitness } from '../src/pipeline/batchlanes.ts';
import { laneEnvId } from '../src/pipeline/lanes.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { obligationVerdicts, obligationsOn, unattestedOn } from '../src/schedule/scheduler.ts';
import { holisticArc, obligationsJson } from './fixtures/brake-common.ts';
import { wire } from './fixtures/publish-common.ts';
import { BUILD_REPORT, admitAll, planCheckStep, SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, MUL, contextFor, gateStep } from './fixtures/unit-common.ts';
import { commitAll, git, writeFiles } from './helpers/repo.ts';
import { scriptTree } from './helpers/witness.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const BATCH = { journey: { cadence: 'batch' } } as const;

/** A unit's publication as its ff stage records it: a commit of its own file on main, the published `integration.ff`. */
function publish(r: ArcRun, unit: string): Sha {
  const old = sha(git(r.d.repo, 'rev-parse', 'main'));
  writeFiles(r.d.repo, { [`pub/${unit}.txt`]: unit });
  const head = sha(commitAll(r.d.repo, `publish ${unit}`));
  const { op } = r.journal.begin({
    kind: 'integration.ff', key: opKey(`ff:${unit}`), parent: { type: 'stage', unit: unitId(unit), stage: 'ff', attempt: 1 }, deadlineAt: null,
    body: () => ({ expect: { ref: 'refs/heads/main' as never, old, new: head, fingerprint: { unitCommit: head, specRev: 1 as never, contractRevs: [], rulingRevs: [] } }, post: null }),
  });
  r.journal.done(op, 'integration.ff', { kind: 'published' }, null);
  return head;
}

const treeOf = (r: ArcRun, commit: string): string => git(r.d.repo, 'rev-parse', `${commit}^{tree}`);
/** The commits the job's journey spawns ran at, in order. */
const ranAt = (r: ArcRun, job: string): readonly string[] => [...new Set(r.journal.view.opsOf('proc.spawn').flatMap((i) => {
  const s = i.expect.subject;
  return s.purpose === 'journey' && s.owner.type === 'job' && s.owner.job === job ? [s.at] : [];
}))];

function arc(units: number, trees: Parameters<typeof holisticArc>[0]['trees']) {
  const ids = Array.from({ length: units }, (_, i) => ({ id: `u${i + 1}` }));
  const { d, control } = holisticArc({ steps: [], units: ids, mapping: [], obligations: [{ id: 'I-1', testIds: ['t1'] }], laneExtra: BATCH, trees });
  const r = contextFor(d);
  const w = wire(r);
  return { r, ctx: { ...w.stage, acquireFirst: w.arbiter.acquireFirst }, control };
}

test('batch witness: the reader accepts batch on an arc lane, which is deferred; batchEvery defaults to 5', () => {
  assert.ok(KIND_CADENCES.arc.includes('batch'));
  const obligations = parseObligations(obligationsJson({ obligations: [], mapping: [], lanes: ['journey', 'other'], laneExtra: { journey: { cadence: 'batch' } } }, '/x/control.json'));
  assert.deepEqual(obligations.lanes.map((l) => [l.id, l.cadence, deferredLane(l)]), [['journey', 'batch', true], ['other', 'build', false]]);
  const external = parseObligations(obligationsJson({ obligations: [], mapping: [], laneExtra: { journey: { witnessClass: 'external' } } }, '/x/control.json'));
  assert.equal(deferredLane(external.lanes[0]!), true);
  const plan = { holistic: { advances: [], vision: 'v.json' } } as never;
  assert.equal(batchEveryOf(plan), DEFAULT_BATCH_EVERY);
  assert.equal(DEFAULT_BATCH_EVERY, 5);
  assert.equal(batchEveryOf({ holistic: { advances: [], batchEvery: 2 } } as never), 2);
});

test('batch witness: due once batchEvery publications landed since its last run; green writes the observation and ends; an open job resumes as itself', T, async () => {
  const { r, ctx } = arc(10, { '*': { outcomes: { t1: 'pass' } } });
  try {
    for (const u of ['u1', 'u2', 'u3', 'u4']) publish(r, u);
    assert.equal(batchWitnessDue(ctx, 'merges'), null, 'four publications: not due');
    const h5 = publish(r, 'u5');
    const due = batchWitnessDue(ctx, 'merges');
    assert.deepEqual(due, { job: jobId('witness', 1), head: h5, lanes: ['journey'] });
    assert.deepEqual(await runBatchWitness(ctx, due!), { kind: 'ended' });
    assert.deepEqual(ranAt(r, 'witness-1'), [h5]);
    assert.ok(r.journal.view.holistic().witnessed.some((w) => w.lane === 'journey' && w.for.type === 'job' && w.for.job === 'witness-1' && w.treeSha === treeOf(r, h5)));
    assert.deepEqual(r.journal.view.holistic().findings, []);
    assert.equal(batchWitnessDue(ctx, 'merges'), null, 'counted again from the head it ran at');
    for (const u of ['u6', 'u7', 'u8', 'u9']) publish(r, u);
    assert.equal(batchWitnessDue(ctx, 'merges'), null);
    const h10 = publish(r, 'u10');
    const next = batchWitnessDue(ctx, 'merges')!;
    assert.deepEqual(next, { job: jobId('witness', 2), head: h10, lanes: ['journey'] });
    // A job cut short (started, not ended) is due again as the same job, whatever the trigger.
    r.journal.fact({ kind: 'batch-witness-started', ...next });
    assert.deepEqual(batchWitnessDue(ctx, 'closing'), next);
    assert.throws(() => r.journal.fact({ kind: 'batch-witness-started', job: jobId('witness', 3), head: h10, lanes: next.lanes }), /another is open/);
    assert.deepEqual(await runBatchWitness(ctx, next), { kind: 'ended' });
    assert.equal(batchWitnessDue(ctx, 'closing'), null, 'every batch lane observed on the head');
  } finally {
    r.journal.close();
  }
});

test('batch witness: a red must-hold obligation bisects over the published heads in log2 probes and opens a P1 naming the culprit', T, async () => {
  const { r, ctx, control } = arc(8, { '*': { outcomes: { t1: 'pass' } } });
  try {
    const heads = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'].map((u) => publish(r, u));
    for (const h of heads.slice(5)) scriptTree(control, treeOf(r, h), { outcomes: { t1: 'fail' } });
    const due = batchWitnessDue(ctx, 'merges')!;
    assert.equal(due.head, heads[7]);
    assert.deepEqual(await runBatchWitness(ctx, due), { kind: 'ended' });
    // [base, H1..H8]: H8 red; H4 good, H6 red, H5 good: three probes for eight publications.
    assert.deepEqual(ranAt(r, 'witness-1'), [heads[7], heads[3], heads[5], heads[4]]);
    const [finding] = r.journal.view.holistic().findings;
    assert.ok(finding !== undefined);
    assert.deepEqual([finding.lens, finding.severity, finding.obligation, finding.source], ['witness', 'P1', 'I-1', { type: 'job', job: 'witness-1' }]);
    assert.ok(finding.claim.includes(`first red at ${heads[5]}, published by u6`), finding.claim);
    assert.ok(r.journal.view.ciFacts().some((f) => f.kind === 'batch-witness-ended' && f.job === 'witness-1'));
    assert.ok(!r.journal.view.ciFacts().some((f) => f.kind === 'batch-reopened'));
  } finally {
    r.journal.close();
  }
});

test('batch witness: a batch arc lane is local to the one head reader: unobserved (never unattested) until a batch witness observes it on the head, then discharged', T, async () => {
  const { r, ctx } = arc(1, { '*': { outcomes: { t1: 'pass' } } });
  try {
    const head = publish(r, 'u1');
    const env = (lane: Parameters<typeof laneEnvId>[1]) => laneEnvId(ctx, lane);
    assert.deepEqual([...obligationVerdicts(ctx, head, env)], [{ obligation: 'I-1', lane: 'journey', verdict: 'unobserved' }]);
    assert.equal(obligationsOn(ctx, head, env), 'unobserved', 'a close-out (every arc lane) or the closing batch witness can observe it: no external-witness wait');
    assert.deepEqual(unattestedOn(ctx, head, env), [], 'no attestation is owed for a batch lane');
    const due = batchWitnessDue(ctx, 'closing')!;
    assert.deepEqual([due.head, due.lanes], [head, ['journey']]);
    assert.deepEqual(await runBatchWitness(ctx, due), { kind: 'ended' });
    assert.equal(batchWitnessDue(ctx, 'closing'), null);
    assert.deepEqual([...obligationVerdicts(ctx, head, env)], [{ obligation: 'I-1', lane: 'journey', verdict: 'held' }]);
    assert.equal(obligationsOn(ctx, head, env), 'discharged', 'its batch witness observation discharges it on the head');
  } finally {
    r.journal.close();
  }
});

/**
 * One unit u1 delivering future I-1 on the batch lane, merged for real. Its proof is not local (surface.ts M2), so the
 * pre-build review runs and the build is Claude's.
 */
async function delivered(trees: Parameters<typeof holisticArc>[0]['trees']) {
  const steps = [
    { ...planCheckStep({ decision: 'approve' }), unit: 'u1' },
    { as: 'claude' as const, unit: 'u1', expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'] }, acts: [{ type: 'dirty' as const, files: MUL }, { type: 'emit' as const, value: BUILD_REPORT }] },
    { ...gateStep({ decision: 'approve' }), unit: 'u1' },
  ];
  const { d } = holisticArc({ steps, obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['t1'] }], mapping: [], laneExtra: BATCH, trees });
  const r = contextFor(d);
  const w = wire(r);
  const tick = setInterval(() => w.arbiter.wake(), 20);
  try { assert.deepEqual(await runUnit(w.stage, w.stage.plan().units[0]!, admitAll), { kind: 'merged' }); } finally { clearInterval(tick); }
  assert.equal(r.journal.view.unit(unitId('u1')).status, 'retired');
  assert.deepEqual(r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey'), [], 'the unit merged without running the batch lane');
  return { r, ctx: { ...w.stage, acquireFirst: w.arbiter.acquireFirst } };
}

test('batch witness: green on the head latches a future obligation once its deliverer is merged', T, async () => {
  const { r, ctx } = await delivered({ '*': { outcomes: { t1: 'pass' } } });
  try {
    assert.deepEqual(r.journal.view.holistic().latched, [], 'nothing latches at the candidate');
    const due = batchWitnessDue(ctx, 'closing')!;
    assert.deepEqual(await runBatchWitness(ctx, due), { kind: 'ended' });
    assert.deepEqual(r.journal.view.holistic().latched.map((l) => [l.obligation, l.unit, l.treeSha]), [['I-1', 'u1', treeOf(r, due.head)]]);
  } finally {
    r.journal.close();
  }
});

test('batch witness: a red delivered obligation whose first red head the deliverer published reopens it with the range as its brief, uncharged', T, async () => {
  const { r, ctx } = await delivered({ '*': { outcomes: { t1: 'fail' } } });
  try {
    const before = r.journal.view.unit(unitId('u1'));
    const due = batchWitnessDue(ctx, 'closing')!;
    assert.deepEqual(await runBatchWitness(ctx, due), { kind: 'ended' });
    const reopened = r.journal.view.ciFacts().find((f) => f.kind === 'batch-reopened');
    assert.ok(reopened?.kind === 'batch-reopened');
    assert.deepEqual([reopened.job, reopened.unit, reopened.obligation, reopened.culprit], ['witness-1', 'u1', 'I-1', due.head]);
    const after = r.journal.view.unit(unitId('u1'));
    assert.deepEqual([after.status, after.stage, after.approval], ['active', 'pre-build', null]);
    assert.deepEqual(after.counters, before.counters, 'no chargeable counter moves');
    const note = r.journal.view.notes(unitId('u1')).find((n) => n.command === 'witness-1')!;
    const brief = keptInput(r.ctx.runDir, note.brief, 'brief.md')!.toString('utf8');
    assert.ok(brief.includes(`- ${due.head} (first red)`), brief);
    assert.deepEqual(r.journal.view.holistic().findings, []);
    assert.deepEqual(r.journal.view.holistic().latched, []);
  } finally {
    r.journal.close();
  }
});
