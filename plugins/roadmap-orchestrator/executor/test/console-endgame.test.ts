// dev.82: the endgame in the console, read from a real arc in the endgame (test/fixtures/endgame-arc.ts: real git, real
// lanes, the fake Claude for the review), through the observer as the console reads it: the shell's phase, the Endgame
// view (exit checklist, worklist, fix log, landings, reviews, handover, episode history) and the Graph's Endgame group.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { endgameView } from '../src/console/endgame.ts';
import { milestoneMembership, outsideGroups } from '../src/console/milestones.ts';
import { endgameShape, graphShape, shellShape } from '../src/console/view-shapes.ts';
import { graphView, shellView } from '../src/console/views.ts';
import { arcId } from '../src/core/ids.ts';
import { openEndgame } from '../src/endgame/open.ts';
import { absPath } from '../src/core/values.ts';
import { F1, R1, endgame, endgameArc, fixAndLand, runDue } from './fixtures/endgame-arc.ts';
import { addUnit, completingArc } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcDescriptor, appendSteps, applyBody } from './fixtures/unit-common.ts';
import { Observations } from './helpers/observations.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const read = (d: ArcDescriptor) => new Observations(absPath(d.hostDir), 'endgame', 'repo').read({ runDir: absPath(d.runDir), arc: arcId(d.arc) });

describe('the endgame in the console (dev.82)', () => {
  test('console.endgame-held: an opened episode hands r1 over; the Graph draws it in the Endgame group, pending, not on hold', T, async () => {
    const e = await endgameArc();
    try {
      const x = read(e.d);
      const shell = shellView(x);
      assert.ok(shellShape(shell));
      assert.deepEqual(shell.phase, { kind: 'endgame', step: 'open', episode: 1, required: 2, optional: 0, episodes: 1 });
      const graph = graphView(x);
      assert.ok(graphShape(graph));
      assert.deepEqual(graph.groups.at(-1), { kind: 'endgame', id: 'endgame', label: 'Endgame', ids: [R1] });
      const r1 = graph.units.find((u) => u.id === R1)!;
      assert.deepEqual([r1.signal, r1.endgame], ['pending', { relation: 'handed-over', command: null, commit: null }]);
      const v = endgameView(x);
      assert.ok(endgameShape(v));
      assert.deepEqual(v.worklist.map((w) => [w.kind, w.id, w.required, w.closed]), [['finding', F1, true, false], ['unit', R1, true, false]]);
      assert.deepEqual(v.worklist.map((w) => w.detail?.type), ['event', 'unit'], 'each entry links to its page');
      assert.deepEqual(v.exit?.map((c) => [c.key, c.met]), [['worklist', false], ['review', true], ['audit', true], ['obligations', false]], 'nothing on the endgame branch yet: the review and audit cover its empty range');
      assert.equal(v.current?.state, 'open');
      assert.match(v.current!.opened!.handover.text!, /^# Endgame handover/);
      assert.equal(v.current!.opened!.sizeGuard, false);
      assert.equal(v.current!.opened!.advisory, null);
    } finally {
      e.r.journal.close();
    }
  });

  test('console.endgame-open: fixes, a landing and a review: the fix log, the landing\'s lanes, the review\'s P1 back on the worklist, closed entries with their fix', T, async () => {
    const e = await endgameArc();
    try {
      const fix = await fixAndLand(e);
      appendSteps(e.d, [{ as: 'claude', expect: { stdinContains: ['<mode>endgame</mode>'] }, acts: [{ type: 'emit', value: { findings: [{ severity: 'P1', text: 'carry() drops the sign', path: 'src/carry.js', evidence: ['src/carry.js:1'] }], reasons: ['Read the range.'] } }] }]);
      await runDue(e);
      const x = read(e.d);
      const v = endgameView(x);
      assert.ok(endgameShape(v));
      const ep = v.current!;
      assert.equal(ep.state, 'open');
      assert.deepEqual(ep.fixes.map((f) => [f.commit, f.closes.map((c) => c.id), f.note, f.landed]), [[fix, [F1, R1], 'add() keeps the carry', true]]);
      assert.deepEqual(ep.landings.map((l) => [l.job, l.head]), [['endgame-1', fix]]);
      assert.ok(ep.landings[0]!.lanes.length > 0, 'the landing names the lanes it ran');
      assert.deepEqual(ep.reviews.map((r) => [r.job, r.to, r.findings.map((f) => [f.severity, f.claim])]), [['endgame-2', fix, [['P1', 'carry() drops the sign']]]]);
      assert.deepEqual(ep.jobs.map((j) => [j.job, j.request, j.outcome]), [['endgame-1', 'land', 'landed'], ['endgame-2', 'review', 'reviewed']]);
      const review = ep.reviews[0]!.findings[0]!.id;
      assert.deepEqual(v.worklist.map((w) => [w.id, w.required, w.closed, w.fixes.map((f) => f.landed)]), [[review, true, false, []], [F1, true, true, [true]], [R1, true, true, [true]]]);
      assert.deepEqual(v.exit?.map((c) => [c.key, c.met]).slice(0, 2), [['worklist', false], ['review', true]]);
      assert.equal(v.landed, true);
      assert.deepEqual(shellView(x).phase, { kind: 'endgame', step: 'open', episode: 1, required: 1, optional: 0, episodes: 1 });
      // A unit a fix closed is cut: withdrawn, in the Endgame group with its fix.
      const graph = graphView(x);
      const r1 = graph.units.find((u) => u.id === R1)!;
      assert.deepEqual([r1.signal, r1.endgame?.relation, r1.endgame?.commit], ['withdrawn', 'closed', fix]);
      assert.deepEqual(outsideGroups(x, milestoneMembership(x)).at(-1)?.ids, [R1]);
    } finally {
      e.r.journal.close();
    }
  });

  test('console.endgame-reversed: a planned unit added leaves episode 1 reversed; episode 2 lists it as history', T, async () => {
    const e = await endgameArc();
    try {
      addUnit(e.d, 'p2');
      const plan = JSON.parse(readFileSync(e.d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
      writeFileSync(e.d.planPath, JSON.stringify({ ...plan, units: plan.units.map((u) => (u['id'] === 'p2' ? { ...u, cut: undefined } : u)) }));
      assert.equal((await e.command(applyBody(e.d))).state, 'applied');
      e.r.journal.fact({ kind: 'endgame-left', episode: 1, cause: 'planned-unit' });
      const body = read(e.d);
      assert.deepEqual(shellView(body).phase, { kind: 'body', planned: 1, milestones: 0, episodes: 1 });
      const reversed = endgameView(body);
      assert.ok(endgameShape(reversed));
      assert.deepEqual([reversed.current?.episode, reversed.current?.state, reversed.history.length, reversed.exit], [1, 'reversed', 0, null]);
      assert.deepEqual(reversed.worklist, []);

      const again = JSON.parse(readFileSync(e.d.planPath, 'utf8')) as { units: Record<string, unknown>[] };
      writeFileSync(e.d.planPath, JSON.stringify({ ...again, units: again.units.map((u) => (u['id'] === 'p2' ? { ...u, cut: { reason: 'not needed after all' } } : u)) }));
      assert.equal((await e.command(applyBody(e.d))).state, 'applied');
      e.r.journal.fact({ kind: 'endgame-entered', episode: 2, planRev: e.r.journal.view.planApplied()!.rev });
      await openEndgame(e.h.audit, e.h.laneEnv);
      const v = endgameView(read(e.d));
      assert.ok(endgameShape(v));
      assert.deepEqual([v.current?.episode, v.current?.state], [2, 'open']);
      assert.deepEqual(v.history.map((h) => [h.episode, h.state]), [[1, 'reversed']]);
      assert.ok(v.history[0]!.leftAt !== null);
      assert.equal((await e.command(endgame({ type: 'review' }))).state, 'applied', 'the open episode takes commands');
    } finally {
      e.r.journal.close();
    }
  });

  test('console.endgame-none: an arc with no episode: the body\'s phase, an empty Endgame view, no Endgame group', T, () => {
    const d = completingArc();
    const x = read(d);
    const v = endgameView(x);
    assert.ok(endgameShape(v));
    assert.deepEqual([v.current, v.history, v.exit, v.worklist, v.branch], [null, [], null, [], null]);
    assert.equal(v.phase.kind, 'body');
    assert.equal(shellView(x).phase.episodes, 0);
    assert.ok(graphView(x).groups.every((g) => g.kind !== 'endgame'));
  });
});
