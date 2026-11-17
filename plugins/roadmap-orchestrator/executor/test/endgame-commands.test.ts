// dev.82 (WS-5): the endgame commands over a real arc (real git, real lanes, the fake Claude for the review): a fix records
// and resolves its finding once landed; a unit a fix closes is cut; a landing of a non-descendant is refused; a red landing
// moves nothing; `resume <unit>` releases a unit the endgame holds; and a P1 the closing step's review opens returns the
// step to `open`. WS-7, the exit rules: an entered episode not yet opened holds completion while its required worklist is
// non-empty; a landed episode owes its review even after its branch was reset to its base; a landing of an episode a
// planned unit reversed is reviewed in the next one, from that landing, which opens for it even with nothing required. The arc is
// test/fixtures/endgame-arc.ts `endgameArc`: episode 1 open with r1 held and F-1 a P1.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { INTEGRATION_SLOT, jobId } from '../src/core/ids.ts';
import { endgameJobDue, runEndgameJob } from '../src/endgame/jobs.ts';
import { closingSettled, endgameNow, endgameOpen, openEndgame, repairsReader, reviewDue } from '../src/endgame/open.ts';
import { endgameHeld, openEpisode } from '../src/endgame/phase.ts';
import { publishedHeads } from '../src/holistic/coverage.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { completionBlockers } from '../src/schedule/scheduler.ts';
import { F1, R1, endgame, endgameArc, fixAndLand, head, runDue } from './fixtures/endgame-arc.ts';
import { addUnit } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, applyBody } from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const finding = (r: ArcRun, id: string) => r.journal.view.holistic().findings.find((f) => f.id === id)!;
const episodeOf = (r: ArcRun) => openEpisode(r.journal.view)!;
const endgameFfs = (r: ArcRun) => r.journal.view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'endgame');

describe('the endgame commands (dev.82, WS-5)', () => {
  test('endgame.fix-resolves-on-landing: a recorded fix fixes its finding on the endgame branch; the landing publishes the head by an endgame ff and resolves it', T, async () => {
    const e = await endgameArc();
    try {
      const base = head(e.d);
      const fix = e.commit({ 'src/carry.js': 'export const carry = (a, b) => a + b;\n' }, 'keep the carry');
      const receipt = await e.command(endgame({ type: 'fix', closes: [F1, R1], commit: fix, note: 'add() keeps the carry' }));
      assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
      const [recorded] = episodeOf(e.r).fixes;
      assert.deepEqual([recorded!.closes, recorded!.commit, recorded!.note], [[F1, R1], fix, 'add() keeps the carry']);
      assert.equal(finding(e.r, F1).state, 'fixed-on-branch');
      assert.deepEqual(finding(e.r, F1).last, { state: 'fixed-on-branch', endgame: recorded!.command }, 'owned by the fix, no unit');
      assert.equal(finding(e.r, F1).owner, null);

      assert.equal((await e.command(endgame({ type: 'land' }))).state, 'applied');
      await runDue(e);
      assert.equal(head(e.d), fix, 'the integration head is the endgame head');
      const [ff] = endgameFfs(e.r);
      assert.deepEqual([ff!.expect.old, ff!.expect.new, ff!.expect.subject], [base, fix, { type: 'endgame', job: 'endgame-1' }]);
      const episode = episodeOf(e.r);
      assert.deepEqual(episode.landings.map((l) => [l.job, l.old, l.head]), [['endgame-1', base, fix]]);
      assert.deepEqual(episode.jobs.map((j) => [j.started.job, j.started.request.type, j.ended?.outcome]), [['endgame-1', 'land', 'landed']]);
      assert.equal(finding(e.r, F1).state, 'resolved', 'the landing holds the fix');
      assert.deepEqual(publishedHeads(e.r.journal.view).at(-1), { ...publishedHeads(e.r.journal.view).at(-1)!, subject: 'endgame', pub: 'endgame-1', old: base, head: fix });
      assert.equal(resourceTable(e.r.journal.view).get(INTEGRATION_SLOT)?.status.state ?? 'free', 'free');
      assert.deepEqual(e.r.journal.view.openIntents(), []);
      // A fix whose commit is not on the endgame branch after its base is refused.
      const refused = await e.command(endgame({ type: 'fix', closes: [F1], commit: base, note: 'n' }));
      assert.equal(refused.state, 'rejected');
      assert.match(refused.reason!, /not a commit on .* after its base/);
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.fix-cuts-unit: a unit a fix closes is cut by a code-applied revision whose source is the fix; it leaves the worklist', T, async () => {
    const e = await endgameArc();
    try {
      const required = () => endgameNow(e.h.audit, e.h.laneEnv).worklist.required.map((x) => (x.type === 'unit' ? x.unit : x.type === 'finding' ? x.finding : x.type));
      assert.deepEqual(required(), [F1, R1]);
      const fix = e.commit({ 'src/carry.js': 'export const carry = (a, b) => a + b;\n' }, 'keep the carry');
      const receipt = await e.command(endgame({ type: 'fix', closes: [R1], commit: fix, note: 'r1 is done by hand' }));
      assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
      assert.equal(e.r.journal.view.unit(R1).status, 'cut');
      const applied = e.r.journal.view.planApplied()!;
      assert.deepEqual(applied.source, { type: 'endgame', command: episodeOf(e.r).fixes[0]!.command });
      assert.deepEqual(applied.changes, [{ type: 'unit-cut', unit: R1 }]);
      assert.deepEqual(required(), [F1], 'r1 left the worklist; F-1, no longer owned by r1, stays');
      assert.equal(finding(e.r, F1).state, 'open', 'r1 cut releases F-1; this fix does not name it');
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.land-non-descendant: a landing of an endgame head that does not descend from the integration head is refused, and nothing is requested', T, async () => {
    const e = await endgameArc();
    try {
      const tip = head(e.d);
      // The endgame branch rewritten onto a root commit of the same tree: no descendant of the integration head.
      const orphan = git(e.worktree, 'commit-tree', `${tip}^{tree}`, '-m', 'an unrelated history');
      git(e.worktree, 'reset', '-q', '--hard', orphan);
      const receipt = await e.command(endgame({ type: 'land' }));
      assert.equal(receipt.state, 'rejected');
      assert.match(receipt.reason!, /does not descend from the integration head/);
      assert.deepEqual(episodeOf(e.r).requests, []);
      assert.equal(endgameJobDue(e.h.audit, e.h.laneEnv), null);
      git(e.worktree, 'reset', '-q', '--hard', tip);
      const nothing = await e.command(endgame({ type: 'land' }));
      assert.equal(nothing.state, 'rejected');
      assert.match(nothing.reason!, /nothing to land/);
      assert.equal(head(e.d), tip);
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.land-red: a landing whose suite is red on the endgame head (and green on the tip alone) moves nothing; the job ends red naming the lane', T, async () => {
    const e = await endgameArc();
    try {
      const tip = head(e.d);
      e.commit({ 'test/red.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('red', () => assert.fail('the endgame broke it'));\n" }, 'a red test');
      assert.equal((await e.command(endgame({ type: 'land' }))).state, 'applied');
      await runDue(e);
      assert.equal(head(e.d), tip, 'integration did not move');
      assert.deepEqual(endgameFfs(e.r), [], 'no endgame ff was begun');
      const [job] = episodeOf(e.r).jobs;
      assert.equal(job!.ended?.outcome, 'red');
      assert.match(job!.ended!.detail, /lane suite/);
      assert.doesNotMatch(job!.ended!.detail, /tip alone too/, 'the tip alone is green: the red is the endgame\'s');
      assert.deepEqual(episodeOf(e.r).landings, []);
      assert.equal(resourceTable(e.r.journal.view).get(INTEGRATION_SLOT)?.status.state ?? 'free', 'free');
      assert.deepEqual(e.r.journal.view.openIntents(), []);
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.resume-releases: resume of a unit the endgame holds writes endgame-released and the hold drops; a second resume changes nothing', T, async () => {
    const e = await endgameArc();
    try {
      const held = () => endgameHeld(e.r.journal.view, requirePlanInForce(e.r.ctx.runDir, e.r.journal.view).plan, repairsReader(e.h.audit));
      assert.deepEqual([...held()], [R1]);
      const receipt = await e.command({ type: 'resume', target: { type: 'unit', unit: R1 } });
      assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
      assert.deepEqual(episodeOf(e.r).released.map((x) => x.unit), [R1]);
      assert.deepEqual([...held()], []);
      const again = await e.command({ type: 'resume', target: { type: 'unit', unit: R1 } });
      assert.equal(again.state, 'applied');
      assert.equal(episodeOf(e.r).released.length, 1, 'released once');
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.closing-review-p1: once landed with an empty required worklist the step is closing and owes the review; a P1 it opens returns the step to open', T, async () => {
    const e = await endgameArc();
    try {
      const base = episodeOf(e.r).opened!.base;
      await fixAndLand(e);
      const now = () => endgameNow(e.h.audit, e.h.laneEnv);
      const step = (): string => { const p = now().phase; return p.kind === 'endgame' ? p.step : 'body'; };
      assert.deepEqual(now().worklist.required, []);
      assert.equal(step(), 'closing');
      assert.equal(reviewDue(e.h.audit, episodeOf(e.r)), true, 'the endgame branch holds commits no review covered');
      assert.equal(closingSettled(e.h.audit, episodeOf(e.r)), false);
      assert.equal(endgameOpen(e.h.audit, e.h.laneEnv), true, 'endgame-open holds completion');
      appendSteps(e.d, [{
        as: 'claude', expect: { stdinContains: ['<mode>endgame</mode>', base] },
        acts: [{ type: 'emit', value: { findings: [{ severity: 'P1', text: 'carry() drops the sign', path: 'src/carry.js', evidence: ['src/carry.js:1'] }], reasons: ['Read the range.'] } }],
      }]);
      const due = endgameJobDue(e.h.audit, e.h.laneEnv);
      assert.deepEqual([due?.command, due?.request], [null, { type: 'review' }], 'the closing step\'s own review');
      await runEndgameJob(e.h.audit, due!);
      const [review] = episodeOf(e.r).reviews;
      assert.deepEqual([review!.job, review!.from, review!.to], ['endgame-2', base, head(e.d)]);
      const opened = finding(e.r, review!.findings[0]!);
      assert.deepEqual([opened.lens, opened.severity, opened.source], ['endgame-review', 'P1', { type: 'job', job: 'endgame-2' }]);
      assert.equal(reviewDue(e.h.audit, episodeOf(e.r)), false, 'the review covers the endgame head');
      assert.equal(step(), 'open', 'the P1 is a required entry: the step is open again');
      assert.deepEqual(now().worklist.required.map((x) => (x.type === 'finding' ? x.finding : x.type)), [opened.id]);
      assert.equal(endgameOpen(e.h.audit, e.h.laneEnv), true);
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.settling-holds: an entered episode not yet opened holds completion (`endgame-open`) while its required worklist is non-empty', T, async () => {
    const e = await endgameArc(false);
    try {
      assert.equal(episodeOf(e.r).opened, null, 'entered, not opened');
      assert.deepEqual(endgameNow(e.h.audit, e.h.laneEnv).worklist.required.map((x) => x.type), ['finding', 'unit']);
      assert.equal(endgameOpen(e.h.audit, e.h.laneEnv), true, 'the required worklist holds completion before the open step');
      assert.ok(completionBlockers(e.h, { blocking: 0, pending: 0 }).includes('endgame-open'));
      await openEndgame(e.h.audit, e.h.laneEnv);
      assert.equal(endgameOpen(e.h.audit, e.h.laneEnv), true, 'and after it');
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.review-after-reset: a landed episode owes its independent review even when the endgame branch is reset to its base afterwards', T, async () => {
    const e = await endgameArc();
    try {
      const base = episodeOf(e.r).opened!.base;
      await fixAndLand(e);
      git(e.worktree, 'reset', '-q', '--hard', base);
      const p = endgameNow(e.h.audit, e.h.laneEnv).phase;
      assert.equal(p.kind === 'endgame' ? p.step : 'body', 'closing', 'nothing required, nothing unlanded');
      assert.equal(reviewDue(e.h.audit, episodeOf(e.r)), true, 'the landed commits have had no review');
      assert.equal(closingSettled(e.h.audit, episodeOf(e.r)), false);
      assert.equal(endgameOpen(e.h.audit, e.h.laneEnv), true);
      assert.deepEqual(endgameJobDue(e.h.audit, e.h.laneEnv)?.request, { type: 'review' }, 'the closing step\'s review is due');
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.review-carries-reversed-landing: a landing of an episode a planned unit reversed is reviewed in the next episode, from that landing', T, async () => {
    const e = await endgameArc();
    try {
      const base1 = episodeOf(e.r).opened!.base;
      const fix = await fixAndLand(e);
      openFinding(e.r.journal, {
        lens: 'drift', severity: 'P1', obligation: null, visionClauses: [], claim: 'sub() drops the borrow', cause: 'borrow', evidence: [{ path: 'src/add.js', blob: null }],
        mutant: null, source: { type: 'job', job: jobId('audit', 2) }, gateHadPassed: true,
      });
      await reverseAndReenter(e);
      assert.deepEqual(endgameNow(e.h.audit, e.h.laneEnv).worklist.required.map((x) => x.type), ['finding'], 'the new P1 opens episode 2');
      await openEndgame(e.h.audit, e.h.laneEnv);
      assert.equal(episodeOf(e.r).opened!.base, fix, 'episode 2 starts from the kept branch, past episode 1\'s landing');
      assert.equal(reviewDue(e.h.audit, episodeOf(e.r)), true, 'episode 1\'s landing had no review');
      assert.equal((await e.command(endgame({ type: 'review' }))).state, 'applied');
      appendSteps(e.d, [{
        as: 'claude', expect: { stdinContains: ['<mode>endgame</mode>', base1] },
        acts: [{ type: 'emit', value: { findings: [], reasons: ['Read the range.'] } }],
      }]);
      await runDue(e);
      const [review] = episodeOf(e.r).reviews;
      assert.deepEqual([review!.from, review!.to], [base1, head(e.d)], 'the range starts at the unreviewed landing');
      assert.equal(reviewDue(e.h.audit, episodeOf(e.r)), false);
    } finally {
      e.r.journal.close();
    }
  });

  test('endgame.reversed-landing-opens: an entered episode with an empty required worklist still opens while an earlier episode\'s landing is unreviewed, and owes that review', T, async () => {
    const e = await endgameArc();
    try {
      const base1 = episodeOf(e.r).opened!.base;
      await fixAndLand(e);
      await reverseAndReenter(e);
      assert.deepEqual(endgameNow(e.h.audit, e.h.laneEnv).worklist.required, []);
      assert.equal(episodeOf(e.r).opened, null);
      assert.equal(endgameOpen(e.h.audit, e.h.laneEnv), true, 'the unreviewed landing holds completion');
      await openEndgame(e.h.audit, e.h.laneEnv);
      const p = endgameNow(e.h.audit, e.h.laneEnv).phase;
      assert.equal(p.kind === 'endgame' ? p.step : 'body', 'closing', 'nothing required, nothing unlanded');
      assert.equal(e.r.journal.view.opsOf('needsuser.raise').filter((i) => readNeedsUser(e.r.ctx.runDir, i.expect.id)?.reason === 'endgame').length, 1, 'no item for an episode with nothing to do by hand');
      assert.deepEqual(endgameJobDue(e.h.audit, e.h.laneEnv)?.request, { type: 'review' }, 'the closing step\'s review is due');
      appendSteps(e.d, [{
        as: 'claude', expect: { stdinContains: ['<mode>endgame</mode>', base1] },
        acts: [{ type: 'emit', value: { findings: [], reasons: ['Read the range.'] } }],
      }]);
      await runDue(e);
      const [review] = episodeOf(e.r).reviews;
      assert.deepEqual([review!.from, review!.to], [base1, head(e.d)]);
      assert.equal(reviewDue(e.h.audit, episodeOf(e.r)), false);
    } finally {
      e.r.journal.close();
    }
  });
});

/** A planned unit added and cut again (r1, which the fix cut, cut on disk too): episode 1 is left (`planned-unit`) and episode 2 entered, not opened. */
async function reverseAndReenter(e: Awaited<ReturnType<typeof endgameArc>>): Promise<void> {
  const setCut = async (cut: Readonly<{ reason: string }> | undefined): Promise<void> => {
    const plan = JSON.parse(readFileSync(e.d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
    writeFileSync(e.d.planPath, JSON.stringify({ ...plan, units: plan.units.map((u) => (u['id'] === 'p2' ? { ...u, cut } : u['id'] === 'r1' ? { ...u, cut: { reason: 'closed by the endgame fix' } } : u)) }));
    const receipt = await e.command(applyBody(e.d));
    assert.equal(receipt.state, 'applied', JSON.stringify(receipt));
  };
  addUnit(e.d, 'p2');
  await setCut(undefined);
  e.r.journal.fact({ kind: 'endgame-left', episode: 1, cause: 'planned-unit' });
  await setCut({ reason: 'not needed after all' });
  e.r.journal.fact({ kind: 'endgame-entered', episode: 2, planRev: e.r.journal.view.planApplied()!.rev });
}
