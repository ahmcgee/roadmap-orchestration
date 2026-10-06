// M4a step C3: the pack review (src/holistic/packreview.ts) and its hold in the scheduler, over real corpus arcs: real
// git, real processes, the fake claude answering the review calls by job. Named tests: packreview.key-excludes-job,
// packreview.holds-admission, packreview.ack-releases, packreview.key-pending-holds, packreview.superseded-by-rereview (with
// R-17: status, watch and --actionable drop the superseded item),
// packreview.none-after-first-admission, packreview.abandoned, packreview.consumed-on-restart,
// packreview.inputs-only-on-recovery, packreview.delta-rereview-dispositions (M4a rev 3, N5),
// packreview.no-review-between-rule-and-apply (M4a rev 3, I2), and the
// crash cells of the matrix row PACK_REVIEW_JOB.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type NeedsUserId, jobId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { PACK_REVIEW_INPUT } from '../src/input/inforce.ts';
import { PACK_REVIEW_INPUTS_SCHEMA, parsePackReviewInputs } from '../src/holistic/types.ts';
import { packReviewKey, packReviewPending, packReviewStatus, requiredInputs, runPackReview } from '../src/holistic/packreview.ts';
import { blockingItems, openBlocking, openNeedsUser, readNeedsUser, supersededPackItems } from '../src/needsuser.ts';
import { status } from '../src/status.ts';
import { ActionableFilter, watch } from '../src/watch.ts';
import { recover } from '../src/recover/recover.ts';
import { arcHolds, holisticContexts } from '../src/schedule/scheduler.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { packReviewStep, packTargetOf } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type Step, readCalls } from './helpers/scenario.ts';
import { PACK_REVIEW_JOB, crashCells } from './matrix.ts';
import { applyPlanEdit, checkpointContext, factsOfKind } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc, forgeEnv } from './fixtures/corpus-holistic.ts';
import { until } from './fixtures/exec-common.ts';
import { followContext, stepTo } from './fixtures/route-common.ts';
import { startHolistic } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor } from './fixtures/unit-common.ts';
import { sha256Hex } from '../src/core/json.ts';
import { sha, sha256 } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { parseRulingSidecar } from '../src/holistic/types.ts';
import { keptPayload } from '../src/input/inforce.ts';
import { rulingContextAt } from '../src/pipeline/publish.ts';
import { consistencyRevs } from '../src/spec/rulings.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const WAIT_MS = 120_000;

const BLOCKING = [{ severity: 'blocking', target: packTargetOf.unit('u1'), claim: 'u1 cannot be built: its scope misses the berth module.' }, { severity: 'note', claim: 'The cut line is vague.' }] as const;
/** review-2's dispositions of review-1's two BLOCKING findings: both resolved by the fixed pack. */
const RESOLVES_BLOCKING = [{ job: 'review-1', index: 0, disposition: 'resolved' }, { job: 'review-1', index: 1, disposition: 'resolved' }] as const;
const reviewCalls = (a: CorpusHolisticArc): readonly string[] => readCalls(a.d.scenarioPath).flatMap((c) => (c.unit?.startsWith('review-') ? [c.unit] : []));
const stdinOf = (a: CorpusHolisticArc, job: string): string => readCalls(a.d.scenarioPath).find((c) => c.unit === job)!.stdin;
const itemsOf = (r: ArcRun, reason: string): readonly NeedsUserId[] =>
  r.journal.view.needsUser().filter((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === reason).map((n) => n.id);

/** The corpus arc with `steps`, opened as a first start records it (`reopen`). */
const arcWith = async (steps: readonly Step[]) => reopen(await corpusHolisticArc(steps));

test('packreview.key-excludes-job: the required-review key hashes the inputs without the job, so a later review can match it', () => {
  const inputs = parsePackReviewInputs({
    schema: PACK_REVIEW_INPUTS_SCHEMA, job: 'review-1', planRev: 1, planSha256: 'a'.repeat(64), specs: [{ unit: 'u1', sha256: 'b'.repeat(64) }],
    obligationsSha256: 'c'.repeat(64), corpusPinSha256: 'd'.repeat(64), phase0Sha256: 'e'.repeat(64), visionSha256: 'f'.repeat(64),
    head: '1'.repeat(40), routingRev: '0123456789abcdef',
  });
  assert.equal(packReviewKey({ ...inputs, job: jobId('review', 2) }), packReviewKey(inputs));
  for (const changed of [{ head: '2'.repeat(40) }, { planRev: 2 }, { phase0Sha256: '9'.repeat(64) }, { routingRev: 'fedcba9876543210' }]) {
    assert.notEqual(packReviewKey(parsePackReviewInputs({ ...inputs, ...changed })), packReviewKey(inputs), JSON.stringify(changed));
  }
});

test('packreview.holds-admission: the review runs first, before the baseline; its blocking finding holds every admission until acknowledged', T, async () => {
  const a = await corpusHolisticArc([packReviewStep('review-1', BLOCKING), { ...planCheckStep({ decision: 'approve' }), unit: 'u1' }]);
  const r = contextFor(a.d);
  const s = startHolistic(r);
  try {
    let item: NeedsUserId | null = null;
    await until(() => (item = itemsOf(r, 'pack-review')[0] ?? null) !== null, WAIT_MS, 'the pack-review item');
    const record = readNeedsUser(r.ctx.runDir, item!)!;
    assert.deepEqual([record.blocking, record.subject], [true, { type: 'arc' }]);
    assert.match(record.summary, /#0 \(unit u1\): u1 cannot be built/);
    assert.doesNotMatch(record.summary, /cut line/, 'a note goes to the brief, not the item');
    const facts = (): readonly (Fact & { seq: number })[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [{ ...e.fact, seq: e.seq }] : []));
    await until(() => facts().some((f) => f.kind === 'witnessed' && f.for.type === 'job' && f.for.job === 'baseline-1'), WAIT_MS, 'the baseline after the review');
    const seqOf = (p: (f: Fact) => boolean): number => facts().find(p)!.seq;
    assert.ok(seqOf((f) => f.kind === 'pack-review-ended') < seqOf((f) => f.kind === 'witnessed' && f.for.type === 'job' && f.for.job === 'baseline-1'), 'the review before the baseline');
    await sleep(3_000);
    assert.deepEqual(facts().filter((f) => f.kind === 'stage-outcome'), [], 'no unit stage while the item is open');
    // The call read the pack read-only in a checkout of the head the inputs bind.
    const call = readCalls(a.d.scenarioPath).find((c) => c.unit === 'review-1')!;
    assert.equal(basename(call.cwd), 'review-1.review');
    const [started] = factsOfKind(r, 'pack-review-started');
    const inputs = parsePackReviewInputs(JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${started!.inputsSha256}.${PACK_REVIEW_INPUT}`), 'utf8')));
    assert.equal(inputs.head, git(a.d.repo, 'rev-parse', 'main'));
    for (const tag of ['<vision>', '<plan>', '<specs>', '<obligations>', '<rules_index>', '<phase0>']) assert.ok(call.stdin.includes(tag), `the prompt holds ${tag}`);
    submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: item!, choice: null });
    await until(() => facts().some((f) => f.kind === 'stage-outcome' && f.unit === 'u1'), WAIT_MS, 'u1 admitted after the ack');
  } finally {
    submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'stop' });
    await s.end;
    r.journal.close();
  }
});

describe('the hold before the first admission (K14, H9)', () => {
  test('packreview.ack-releases: a completed review with a blocking finding holds admission; its acknowledgement releases it and no review runs again', T, async () => {
    const x = await arcWith([packReviewStep('review-1', BLOCKING)]);
    try {
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'due' });
      assert.ok(x.holds().includes('pack-review'), 'a review due holds admission');
      const out = await runPackReview(x.ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'completed' && out.needsUser !== null, JSON.stringify(out));
      const [ended] = factsOfKind(x.r, 'pack-review-ended');
      assert.deepEqual(ended!.findings.map((f) => [f.index, f.severity, f.target]), [[0, 'blocking', { type: 'unit', id: 'u1' }], [1, 'note', { type: 'plan' }]]);
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'held', job: 'review-1', needsUser: out.needsUser });
      assert.ok(x.holds().includes('pack-review'));
      await x.ack(out.needsUser);
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'clear', job: 'review-1' });
      assert.ok(!x.holds().includes('pack-review'), 'the ack releases');
      assert.equal(packReviewPending(x.ctx), false);
      assert.deepEqual(await runPackReview(x.ctx), { kind: 'none' });
      assert.deepEqual(reviewCalls(x.a), ['review-1']);
    } finally {
      x.r.journal.close();
    }
  });

  test('packreview.key-pending-holds: a clean earlier review does not release a changed key; the re-review does', T, async () => {
    const x = await arcWith([packReviewStep('review-1'), packReviewStep('review-2')]);
    try {
      const first = await runPackReview(x.ctx);
      assert.deepEqual(first, { kind: 'ended', job: 'review-1', outcome: 'completed', needsUser: null });
      assert.ok(!x.holds().includes('pack-review'), 'a clean review with the current key holds nothing');
      const key = factsOfKind(x.r, 'pack-review-started')[0]!.key;
      await x.editPack('Berth booking, the tide windows first.');
      assert.notEqual(packReviewKey(requiredInputs(x.ctx, jobId('review', 2))!), key, 'the apply changed the key');
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'due' });
      assert.ok(x.holds().includes('pack-review'), 'the clean review-1 does not release the new key');
      const second = await runPackReview(x.ctx);
      assert.ok(second.kind === 'ended' && second.job === 'review-2', JSON.stringify(second));
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'clear', job: 'review-2' });
      assert.ok(!x.holds().includes('pack-review'));
      assert.match(stdinOf(x.a, 'review-2'), /tide windows first/);
    } finally {
      x.r.journal.close();
    }
  });

  test('packreview.superseded-by-rereview: an apply that fixes the pack makes a new key; the re-review\'s end supersedes the earlier item, which holds and blocks nothing', T, async () => {
    const x = await arcWith([packReviewStep('review-1', BLOCKING), packReviewStep('review-2', [], [], RESOLVES_BLOCKING)]);
    try {
      const first = await runPackReview(x.ctx);
      assert.ok(first.kind === 'ended' && first.needsUser !== null);
      assert.deepEqual(openBlocking(x.r.journal.view), [first.needsUser]);
      await x.editPack('Berth booking with u1 scoped to the berth module.');
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'due' });
      const second = await runPackReview(x.ctx);
      assert.deepEqual(second, { kind: 'ended', job: 'review-2', outcome: 'completed', needsUser: null });
      assert.deepEqual([...supersededPackItems(x.r.journal.view)], [first.needsUser], 'review-1\'s item is superseded');
      assert.deepEqual(openBlocking(x.r.journal.view), [], 'and no longer open');
      assert.equal(x.r.journal.view.ackOf(first.needsUser), null, 'without an ack');
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'clear', job: 'review-2' });
      assert.ok(!x.holds().includes('pack-review'));
      // R-17 (paid M4a run 10): one predicate drops it wherever open items are listed: status, the brief, watch --actionable.
      const { runDir, hostDir } = x.r.ctx;
      const arc = x.r.journal.view.arc;
      assert.deepEqual(openNeedsUser(x.r.journal.view).map((n) => n.id), []);
      const s = status(runDir, arc, hostDir);
      assert.deepEqual(s.needsUser, [], 'status lists no superseded item');
      assert.deepEqual(s.packReview!.reviews.map((v) => [v.job, v.needsUser, v.superseded]), [['review-1', first.needsUser, true], ['review-2', null, false]], 'packReview still shows it, superseded');
      const lines: string[] = [];
      const stop = new AbortController();
      const watching = watch(runDir, arc, hostDir, (l) => lines.push(l), stop.signal);
      await until(() => lines.some((l) => l.includes('"event":"units"')), WAIT_MS, 'the first watch poll');
      stop.abort();
      await watching;
      const events = lines.map((l) => JSON.parse(l) as { event: string; id?: string });
      const at = (event: string): number => events.findIndex((e) => e.event === event && e.id === first.needsUser);
      assert.ok(at('superseded') >= 0 && at('superseded') < at('needs-user'), `the superseded line precedes the item's: ${lines.join(' | ')}`);
      const filter = new ActionableFilter(0);
      const woke = lines.flatMap((l) => {
        const out = filter.feed(arc, l, 0);
        return out === null ? [] : [JSON.parse(out) as { event: string }];
      });
      assert.deepEqual(woke.filter((e) => e.event === 'needs-user'), [], '--actionable does not wake on the superseded item');
    } finally {
      x.r.journal.close();
    }
  });

  test('packreview.none-after-first-admission: from the first admission on no review runs and no key is required', T, async () => {
    const x = await arcWith([packReviewStep('review-1'), { ...planCheckStep({ decision: 'approve' }), unit: 'u1' }]);
    try {
      assert.equal((await runPackReview(x.ctx)).kind, 'ended');
      await stepTo(followContext(x.r), 'u1', (f) => f.stage === 'plan-check');
      await x.editPack('A new direction after the first admission.');
      assert.deepEqual(packReviewStatus(x.ctx), { kind: 'none' });
      assert.equal(packReviewPending(x.ctx), false);
      assert.ok(!x.holds().includes('pack-review'));
      assert.deepEqual(await runPackReview(x.ctx), { kind: 'none' });
      assert.deepEqual(reviewCalls(x.a), ['review-1']);
    } finally {
      x.r.journal.close();
    }
  });

  test('packreview.abandoned: a review that gives no valid report ends abandoned with a blocking item saying why; its ack releases', T, async () => {
    const x = await arcWith([{ as: 'claude', unit: 'review-1', expect: {}, acts: [{ type: 'emit', value: { findings: 'not a list' } }] }]);
    try {
      const out = await runPackReview(x.ctx);
      assert.ok(out.kind === 'ended' && out.outcome === 'abandoned' && out.needsUser !== null, JSON.stringify(out));
      assert.match(readNeedsUser(x.r.ctx.runDir, out.needsUser)!.summary, /gave no valid report \(malformed/);
      assert.ok(x.holds().includes('pack-review'));
      await x.ack(out.needsUser);
      assert.ok(!x.holds().includes('pack-review'));
      assert.deepEqual(await runPackReview(x.ctx), { kind: 'none' }, 'not asked again for the same key');
    } finally {
      x.r.journal.close();
    }
  });
});

test('packreview.no-review-between-rule-and-apply (I2): `apply --ruling` lands the ruling and its dependent edit as one revision, so the only key a review can bind is the whole pack\'s', T, async () => {
  const x = await arcWith([packReviewStep('review-1')]);
  try {
    const r = x.r;
    const tip = sha(git(r.d.repo, 'rev-parse', 'main'));
    const draft = {
      schema: 'roadmap/ruling-m3', id: 'C-2', statement: 'Berth booking comes before tide windows.', kind: 'decision', ruledBy: { type: 'architect' }, trigger: 'pack',
      supersedes: [], condition: null, docRefs: [{ path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module', relation: 'consistent' }],
      contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: [], evidence: [], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
      consistency: { verdict: 'consistent', judgedRevs: { head: tip, ledgerSha256: 'a'.repeat(64), obligationsSha256: null, visionSha256: null, contracts: [] }, by: { type: 'architect' } },
    };
    const fresh = consistencyRevs(parseRulingSidecar(draft), rulingContextAt({ journal: r.journal, runDir: r.ctx.runDir, planFile: absPath(r.d.planPath), repo: absPath(r.d.repo) }, tip));
    if ('reasons' in fresh) throw new Error(fresh.reasons.join('; '));
    const path = absPath(join(tmpDir('packreview-ruling'), 'C-2.json'));
    writeFileSync(path, `${JSON.stringify({ ...draft, consistency: { ...draft.consistency, judgedRevs: fresh.revs } }, null, 2)}\n`);
    // The dependent edit: the plan's direction now states what the ruling decides.
    const plan = JSON.parse(readFileSync(r.d.planPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(r.d.planPath, JSON.stringify({ ...plan, direction: 'Berth booking first, per C-2.' }));
    const out = await applyCommand(x.w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, {
      ...applyBody(r.d), rulings: [{ path, sha256: sha256(sha256Hex(readFileSync(path))) }],
    } as Parameters<typeof submitCommand>[2]));
    assert.equal(out.kind, 'applied', JSON.stringify(out));
    const revisions = factsOfKind(r, 'plan-applied');
    assert.deepEqual(revisions.map((f) => f.rev), [1, 2], 'one revision for the ruling and its edit: none holds the ruling alone');
    const manifest = keptPayload(r.ctx.runDir, revisions[1]!.payloadSha256).manifest;
    assert.deepEqual(Object.keys(manifest.rulings.sidecars), ['C-2']);
    assert.deepEqual(revisions[1]!.changes, [{ type: 'plan-field', field: 'direction' }]);
    const review = await runPackReview(x.ctx);
    assert.deepEqual(review, { kind: 'ended', job: 'review-1', outcome: 'completed', needsUser: null });
    const started = factsOfKind(r, 'pack-review-started');
    assert.deepEqual(started.map((f) => f.planRev), [2], 'the one review reads the revision holding both');
    assert.match(stdinOf(x.a, 'review-1'), /Berth booking first, per C-2\./);
    assert.deepEqual(packReviewStatus(x.ctx), { kind: 'clear', job: 'review-1' });
  } finally {
    x.r.journal.close();
  }
});

test('packreview.delta-rereview-dispositions (H3): a re-review reads what changed and the unresolved earlier findings, dispositions each once; a blocking one kept still-open holds; a missing disposition is malformed; an abandoned review is skipped over', T, async () => {
  const x = await arcWith([
    packReviewStep('review-1', BLOCKING),
    packReviewStep('review-2', [{ severity: 'note', claim: 'NEW-IN-2' }], [], [{ job: 'review-1', index: 0, disposition: 'still-open' }, { job: 'review-1', index: 1, disposition: 'resolved' }]),
    packReviewStep('review-3', [], [], [{ job: 'review-1', index: 0, disposition: 'resolved' }]),
    packReviewStep('review-4', [], [], [{ job: 'review-1', index: 0, disposition: 'resolved' }, { job: 'review-2', index: 0, disposition: 'withdrawn' }]),
  ]);
  try {
    const first = await runPackReview(x.ctx);
    assert.ok(first.kind === 'ended' && first.needsUser !== null);
    assert.doesNotMatch(stdinOf(x.a, 'review-1'), /<delta/, 'the first review is full');
    await x.editPack('Berth booking, still with u1 unscoped.');
    const second = await runPackReview(x.ctx);
    assert.ok(second.kind === 'ended' && second.outcome === 'completed' && second.needsUser !== null, JSON.stringify(second));
    const stdin = stdinOf(x.a, 'review-2');
    assert.match(stdin, /<delta since="review-1">\n<changed>\nplan\n<\/changed>/, 'the plan changed, no spec');
    assert.match(stdin, /- review-1#0 \[blocking\] unit u1: u1 cannot be built/);
    assert.match(stdin, /- review-1#1 \[note\] plan: The cut line is vague\./);
    assert.doesNotMatch(stdin, /<specs>\s*<documents>\s*<document/, 'no unchanged spec embedded');
    assert.deepEqual(factsOfKind(x.r, 'pack-review-ended')[1]!.dispositions, [{ job: 'review-1', index: 0, disposition: 'still-open' }, { job: 'review-1', index: 1, disposition: 'resolved' }]);
    assert.match(readNeedsUser(x.r.ctx.runDir, second.needsUser)!.summary, /review-1#0, still open \(unit u1\): u1 cannot be built/, 'the still-open blocking finding holds through the new item');
    assert.deepEqual(packReviewStatus(x.ctx), { kind: 'held', job: 'review-2', needsUser: second.needsUser });

    await x.editPack('Berth booking, a third draft.');
    const third = await runPackReview(x.ctx);
    assert.ok(third.kind === 'ended' && third.outcome === 'abandoned', JSON.stringify(third));
    assert.match(readNeedsUser(x.r.ctx.runDir, third.needsUser!)!.summary, /dispositions: none for review-2#0/);

    await x.editPack('Berth booking with u1 scoped to the berth module.');
    const fourth = await runPackReview(x.ctx);
    assert.deepEqual(fourth, { kind: 'ended', job: 'review-4', outcome: 'completed', needsUser: null });
    assert.match(stdinOf(x.a, 'review-4'), /<delta since="review-2">/, 'the abandoned review-3 is skipped over');
    assert.deepEqual(packReviewStatus(x.ctx), { kind: 'clear', job: 'review-4' });
  } finally {
    x.r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Restarts: the job's kept inputs (K8) and its recorded call

/** Runs the pack review in a child that crashes at `label` (occurrence 1), then reopens the arc and recovers. */
async function crashed(steps: readonly Step[], label: string, between: (x: Awaited<ReturnType<typeof arcWith>>) => Promise<void> = async () => {}) {
  const first = await arcWith(steps);
  first.r.journal.close();
  const trigger = writeTrigger(tmpDir('packreview-crash'), { label, occurrence: 1 });
  const exit = await runFixture('corpus-job-child.ts', [JSON.stringify(first.a.d), 'packreview'], { env: forgeEnv(first.a, { ROADMAP_TEST_CRASH: trigger }), timeoutMs: 150_000 });
  assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
  assertFired(trigger);
  const x = reopen(first.a);
  await recover({ stage: x.ctx, commands: x.w.commands });
  await between(x);
  return x;
}

/**
 * The arc opened as an executor sees it: its run context, the checkpoint context its jobs run under, its arc-wide holds
 * now, an ack, and an architect's apply that changes the pack (the plan's direction: a new key).
 */
function reopen(a: CorpusHolisticArc) {
  const r = contextFor(a.d);
  const { ctx, w } = checkpointContext(r);
  const h = holisticContexts({ stage: w.stage, commands: w.commands, arbiter: w.arbiter });
  return {
    a, r, ctx, w,
    holds: () => arcHolds(h, blockingItems(r.ctx.runDir, r.journal.view), false),
    ack: async (id: NeedsUserId) => {
      const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: id, choice: null }));
      assert.equal(out.kind, 'applied', JSON.stringify(out));
    },
    editPack: (direction: string) => applyPlanEdit(r, w, (p) => {
      p['direction'] = direction;
    }),
  };
}

test('packreview.consumed-on-restart: a call recorded before the review ended is consumed by the restart, never asked again', T, async () => {
  const x = await crashed([packReviewStep('review-1', BLOCKING)], 'packreview.after-call');
  try {
    assert.deepEqual(factsOfKind(x.r, 'pack-review-ended'), []);
    const out = await runPackReview(x.ctx);
    assert.ok(out.kind === 'ended' && out.job === 'review-1' && out.needsUser !== null, JSON.stringify(out));
    assert.deepEqual(reviewCalls(x.a), ['review-1'], 'asked once');
    assert.equal(factsOfKind(x.r, 'pack-review-ended')[0]!.findings.length, 2, 'the recorded answer\'s findings');
  } finally {
    x.r.journal.close();
  }
});

test('packreview.inputs-only-on-recovery: a review resumed after the live pack changed renders its kept inputs alone; the changed key then calls for a re-review', T, async () => {
  const x = await crashed([packReviewStep('review-1'), packReviewStep('review-2')], 'packreview.after-started', (y) => y.editPack('LIVE DIRECTION AFTER THE CRASH'));
  try {
    assert.deepEqual(packReviewStatus(x.ctx), { kind: 'running', job: 'review-1' });
    const out = await runPackReview(x.ctx);
    assert.deepEqual(out, { kind: 'ended', job: 'review-1', outcome: 'completed', needsUser: null });
    const first = stdinOf(x.a, 'review-1');
    assert.match(first, /Plan rev 1 /);
    assert.doesNotMatch(first, /LIVE DIRECTION AFTER THE CRASH/, 'the kept inputs, never the live files');
    assert.deepEqual(packReviewStatus(x.ctx), { kind: 'due' }, 'the live change is a new key');
    const second = await runPackReview(x.ctx);
    assert.ok(second.kind === 'ended' && second.job === 'review-2', JSON.stringify(second));
    assert.match(stdinOf(x.a, 'review-2'), /Plan rev 2 [\s\S]*LIVE DIRECTION AFTER THE CRASH/);
  } finally {
    x.r.journal.close();
  }
});

describe(`matrix row ${PACK_REVIEW_JOB}`, () => {
  for (const cell of crashCells(PACK_REVIEW_JOB)) {
    test(`pack review crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const x = await crashed([packReviewStep('review-1', BLOCKING)], cell.label);
      try {
        const started = factsOfKind(x.r, 'pack-review-started');
        if (cell.label === 'packreview.after-inputs') {
          assert.deepEqual(started, [], 'killed after the inputs were kept, before the fact');
        }
        const out = await runPackReview(x.ctx);
        if (cell.label === 'packreview.after-ended') assert.deepEqual(out, { kind: 'none' }, 'the restart only raises the item');
        else assert.ok(out.kind === 'ended' && out.job === 'review-1', JSON.stringify(out));
        const after = factsOfKind(x.r, 'pack-review-started');
        assert.deepEqual(after.map((f) => f.job), ['review-1'], 'one review');
        assert.ok(existsSync(join(x.r.ctx.runDir, 'inputs', `${after[0]!.inputsSha256}.${PACK_REVIEW_INPUT}`)), 'its inputs kept');
        assert.deepEqual(factsOfKind(x.r, 'pack-review-ended').map((f) => [f.job, f.outcome]), [['review-1', 'completed']], 'ended once');
        assert.deepEqual(reviewCalls(x.a), ['review-1'], 'asked once');
        assert.equal(itemsOf(x.r, 'pack-review').length, 1, 'one item');
        assert.deepEqual(packReviewStatus(x.ctx).kind, 'held');
        assert.deepEqual(x.r.journal.view.openIntents(), []);
        assert.equal(git(x.a.d.repo, 'worktree', 'list', '--porcelain').includes('review-'), false, 'no review checkout left');
      } finally {
        x.r.journal.close();
      }
    });
  }
});
