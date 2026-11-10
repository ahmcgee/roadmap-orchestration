// dev.59 console QA from a real long arc (atlas2's m6, stopped): the read model over the shapes it records and the
// design week lacks. The field fixture records them with production writers (scale-arc.ts --field).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationCache } from '../src/observation/cache.ts';
import { absPath } from '../src/core/values.ts';
import { graphView } from '../src/console/views.ts';
import { milestoneView, unitView } from '../src/console/details.ts';
import { identityIndex } from '../src/console/indexes.ts';
import { ConsoleTemporal } from '../src/console/temporal-query.ts';
import { effortRows } from '../src/console/tab-projections.ts';
import { generateScaleArc } from './helpers/scale-arc.ts';
import { tmpDir } from './helpers/repo.ts';

test('a stopped field arc reads its milestones, re-entries and audits as recorded', { timeout: 120_000 }, async t => {
  const m = await generateScaleArc(tmpDir('console-field'), { preset: 'design', field: true });
  const e = new ObservationCache(absPath(m.hostDir), 'field', 'reader').read({ runDir: absPath(m.runDir), arc: m.arc as never });
  const graph = graphView(e), states = new Map(e.data.display.status.units.map(u => [String(u.unit), u.state]));

  await t.test('C1: No milestone counts the units in no milestone, once', () => {
    const members = new Set(graph.milestones.flatMap(g => g.memberIds));
    const none = graph.units.map(u => u.id).filter(id => !members.has(id));
    assert.deepEqual(none, ['u32-flush-retry-r2', 'u32-flush-retry-r3', 'u33-rollup-export-r2'], 'the re-entries the plan added outside every milestone');
    assert.deepEqual(graph.noMilestone, { ids: none, merged: 2, withdrawn: 1 });
    assert.equal(graph.milestones.reduce((n, g) => n + g.memberIds.length, 0) + graph.noMilestone.ids.length, graph.units.length, 'every unit is counted exactly once');
  });

  await t.test('C2: fractions keep withdrawn members apart, and an unpassed milestone says why', () => {
    const ms4 = graph.milestones.find(g => g.id === 'MS-4')!;
    assert.deepEqual([ms4.memberIds.length, ms4.merged, ms4.withdrawn], [10, 0, 2]);
    assert.equal(ms4.reason, '8 units have not merged: u31, u34, u35, u36 and 4 more');
    const ms3 = milestoneView(e, 'MS-3', { limit: '100', section: 'members' });
    assert.deepEqual([ms3.total, ms3.merged, ms3.withdrawn], [10, 9, 1]);
    assert.equal(ms3.reason, 'its walkthrough has not run, and the arc is stopped', 'a stopped arc names the step that has not run');
    const replaced = ms3.members.rows.find(r => r.id === 'u29')!;
    assert.deepEqual([replaced.signal, replaced.replacedBy], ['withdrawn', { id: 'u30', state: 'Merged', signal: 'passed' }]);
    assert.equal(ms3.members.rows.filter(r => r.signal !== 'passed' && r.signal !== 'withdrawn').length, 0, 'nothing outstanding: only the replaced member is not merged');
    const u31 = unitView(e, 'u31');
    assert.ok('journey' in u31);
    assert.ok(u31.unit.reasons.includes('Milestone MS-3 has not passed: its walkthrough has not run, and the arc is stopped'), u31.unit.reasons.join('; '));
    const effort = effortRows(e).find(r => r.subject.id === 'u31')!;
    assert.match(effort.currentBlockers.preview.text, /Milestone MS-3 has not passed: its walkthrough has not run/);
  });

  await t.test('C3: titles keep the arc\'s own unit ids and a leading ruling', () => {
    const titles = identityIndex(e);
    assert.equal(titles.get('u32-flush-retry-r2')!.title, "C-356: Continue u32's flush retry work from its last green tip");
    assert.equal(titles.get('u32-flush-retry-r3')!.title, "Continues u32-flush-retry-r2's work on bounded flush retries");
    assert.equal(titles.get('u33-rollup-export-r2')!.title, 'Moved from u32-flush-retry-r2 by C-351');
  });

  await t.test('C5: no milestone of a stopped arc reads as running', () => {
    assert.equal(states.get('u30'), 'merged');
    const ms3 = graph.milestones.find(g => g.id === 'MS-3')!;
    assert.deepEqual([ms3.state, ms3.signal, ms3.passed], ['walking', 'pending', false], 'its walk is due, and nothing runs on a stopped arc');
  });

  await t.test('C8: audits show their judged verdict, and both finding counts are named', () => {
    const audits = new ConsoleTemporal().holistic(e, { section: 'audits' });
    assert.ok(audits.rows.length > 0 && audits.rows.every(r => r.type === 'audit' && r.verdict === 'revise' && r.outcome === 'completed'));
    assert.equal(audits.latestOutcome?.verdict, 'revise');
    assert.equal(audits.counts.raised, e.data.summary.caught.uniqueFindings);
    assert.ok(audits.counts.raised > audits.counts.findings, `${audits.counts.raised} raised, ${audits.counts.findings} active`);
  });

  await t.test('C10: each milestone carries its recorded spend', () => {
    for (const g of graph.milestones) assert.equal(g.costUsd, e.data.summary.milestones.find(s => s.id === g.id)!.costUsd);
    assert.ok(graph.milestones.find(g => g.id === 'MS-1')!.costUsd > 0);
    assert.equal(milestoneView(e, 'MS-1').costUsd, graph.milestones.find(g => g.id === 'MS-1')!.costUsd);
  });
});
