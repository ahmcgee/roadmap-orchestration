// dev.82 (WS-5): the endgame commands over a real arc (real git, real lanes, the fake Claude for the review): a fix records
// and resolves its finding once landed; a unit a fix closes is cut; a landing of a non-descendant is refused; a red landing
// moves nothing; `resume <unit>` releases a unit the endgame holds; and a P1 the closing step's review opens returns the
// step to `open`. The arc (`endgameArc`): u1 planned, F-1 a P1 the audit found, r1 admitted to repair it, then u1 cut, so
// the arc is in the endgame with r1 held; the scheduler's entry and the open step (src/endgame/open.ts) made it episode 1,
// with the endgame branch and worktree at the integration head.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import { INTEGRATION_SLOT, type Sha, findingId, jobId, sha, unitId } from '../src/core/ids.ts';
import type { CommandBody, EndgameAct } from '../src/core/records.ts';
import { endgameJobDue, runEndgameJob } from '../src/endgame/jobs.ts';
import { closingSettled, endgameNow, endgameOpen, endgameWorktree, openEndgame, repairsReader, reviewDue } from '../src/endgame/open.ts';
import { endgameHeld, openEpisode } from '../src/endgame/phase.ts';
import { publishedHeads } from '../src/holistic/coverage.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { type HolisticContexts, holisticContexts } from '../src/schedule/scheduler.ts';
import { addUnit, completingArc, wired } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, appendSteps, applyBody, contextFor } from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const F1 = findingId('F-1');
const R1 = unitId('r1');

type Json = Record<string, unknown>;
type EndgameRun = Readonly<{
  d: ArcDescriptor; r: ArcRun; h: HolisticContexts; worktree: string;
  /** Commits `files` on the endgame branch (in its worktree). */
  commit: (files: Readonly<Record<string, string>>, message: string) => Sha;
  /** Applies one command now, as the scheduler would: its receipt. */
  command: (body: CommandBody) => Promise<Readonly<{ state: string; reason?: string; verified?: readonly string[] }>>;
}>;

const head = (d: ArcDescriptor): Sha => sha(git(d.repo, 'rev-parse', 'main'));
const endgame = (act: EndgameAct): CommandBody => ({ type: 'endgame', act });

async function endgameArc(): Promise<EndgameRun> {
  const d = completingArc();
  const r = contextFor(d);
  const w = wired(r);
  const h = holisticContexts(w);
  const command = async (body: CommandBody): Promise<Readonly<{ state: string; reason?: string; verified?: readonly string[] }>> => {
    const file = submitCommand(r.ctx.runDir, r.journal.view.arc, body);
    await applyCommand(w.commands, file);
    const receipt = terminalReceipt(r.ctx.runDir, file.id);
    if (receipt === null) throw new Error(`${file.id} has no terminal receipt`);
    return receipt;
  };
  openFinding(r.journal, {
    lens: 'drift', severity: 'P1', obligation: null, visionClauses: [], claim: 'add() drops the carry', cause: 'carry', evidence: [{ path: 'src/add.js', blob: null }],
    mutant: null, source: { type: 'job', job: jobId('audit', 1) }, gateHadPassed: true,
  });
  addUnit(d, 'r1');
  const planDir = join(d.planPath, '..');
  const spec = JSON.parse(readFileSync(join(planDir, 'r1.json'), 'utf8')) as Json;
  writeFileSync(join(planDir, 'r1.json'), JSON.stringify({ ...spec, repairs: ['F-1'] }));
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
  writeFileSync(d.planPath, JSON.stringify({ ...plan, units: plan.units.map((u) => (u['id'] === 'u1' ? { ...u, cut: { reason: 'the endgame test needs no planned work' } } : u)) }));
  const applied = await command(applyBody(d));
  assert.equal(applied.state, 'applied', JSON.stringify(applied));
  const inForce = () => requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
  assert.deepEqual([...endgameHeld(r.journal.view, inForce(), repairsReader(h.audit))], [R1], 'r1 is held before the entry');
  r.journal.fact({ kind: 'endgame-entered', episode: 1, planRev: r.journal.view.planApplied()!.rev });
  await openEndgame(h.audit, h.laneEnv);
  const worktree = endgameWorktree(inForce().worktreeRoot, inForce().arc);
  const commit = (files: Readonly<Record<string, string>>, message: string): Sha => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(worktree, path)), { recursive: true });
      writeFileSync(join(worktree, path), text);
    }
    git(worktree, 'add', '-A');
    git(worktree, 'commit', '-q', '-m', message);
    return sha(git(worktree, 'rev-parse', 'HEAD'));
  };
  return { d, r, h, worktree, commit, command };
}

const finding = (r: ArcRun, id: string) => r.journal.view.holistic().findings.find((f) => f.id === id)!;
const episodeOf = (r: ArcRun) => openEpisode(r.journal.view)!;
const endgameFfs = (r: ArcRun) => r.journal.view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'endgame');

/** Runs the endgame job due now to its end; it must be one. */
async function runDue(e: EndgameRun): Promise<void> {
  const due = endgameJobDue(e.h.audit, e.h.laneEnv);
  assert.ok(due !== null, 'an endgame job is due');
  await runEndgameJob(e.h.audit, due);
}

/** Records a fix of F-1 that closes r1 too (so nothing but F-1's landing is left), and lands it. */
async function fixAndLand(e: EndgameRun): Promise<Sha> {
  const fix = e.commit({ 'src/carry.js': 'export const carry = (a, b) => a + b;\n' }, 'keep the carry');
  assert.equal((await e.command(endgame({ type: 'fix', closes: [F1, R1], commit: fix, note: 'add() keeps the carry' }))).state, 'applied');
  assert.equal((await e.command(endgame({ type: 'land' }))).state, 'applied');
  await runDue(e);
  return fix;
}

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
});
