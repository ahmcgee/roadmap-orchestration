import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Event } from '../src/core/events.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { statusBytes } from '../src/observation/protocol.ts';
import { identityIndex } from '../src/console/indexes.ts';
import { unitView } from '../src/console/details.ts';
import { ConsoleViews, graphView, shellView, preview } from '../src/console/views.ts';
import { projectionIndex, timelineIntervals, effortRows, attentionSummaries, cpuSummaries, bookingSummaries, waitingMeasurements, stageSummaries, holisticSummaries, resourceNow } from '../src/console/tab-projections.ts';
import { retainedReport } from '../src/console/reports.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { invocationDirName, invocationIdOf } from '../src/core/ids.ts';
import { waited } from '../src/core/waiting.ts';
import { waitingBreakdown } from '../src/console/waiting.ts';

const capture = (f: Awaited<ReturnType<typeof investigationFixture>>) => new ObservationCache(f.hostDir, 'view-projections', 'reader').read({runDir: f.runDir, arc: f.arc});
function noWorkingSet(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['body', 'events', 'display', 'plan', 'transcript', 'report', 'raw', 'capture', 'estate', 'contributions', 'recommendation', 'options', 'evidence'].includes(key), `working set leaked: ${key}`);
    noWorkingSet(child);
  }
}

test('D1–D11 independent projections exclude evidence working sets and canonical bytes remain unchanged', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = capture(f), beforeFull = statusBytes(e, false), beforeSummary = statusBytes(e, true);
  const index = projectionIndex(e);
  const shell = shellView(e), graph = graphView(e), intervals = timelineIntervals(e, index), effort = effortRows(e, index);
  const all = [shell, graph, intervals, effort, attentionSummaries(e), cpuSummaries(e), bookingSummaries(e.data.events), waitingMeasurements(e, index), stageSummaries(e), holisticSummaries(e), resourceNow(e)];
  all.forEach(noWorkingSet);
  assert.equal(shell.identity.arc, f.arc); assert.ok(shell.identity.direction); assert.equal(shell.identity.direction.text, e.data.plan!.direction.trim(), 'the Arc goal is the recorded plan direction, never derived'); assert.equal(shell.progress.total, 14);
  assert.equal(shell.spend.costUsd, e.data.summary.spend.costUsd);
  assert.equal(shell.attention.total, e.data.requests.length);
  assert.equal(shell.attention.blocking + shell.attention.informational, shell.attention.total);
  assert.equal(shell.lifecycle.startedAt, e.data.events[0]!.at);
  assert.deepEqual(graph.units.map(u => u.title), [...identityIndex(e).values()].map(u => u.title));
  assert.deepEqual(graph.edges.filter(edge => edge.kind !== 'contingent').map(edge => [edge.source, edge.target]), [...e.data.display.status.edges.flatMap(edge=>edge.type==='after'?[[edge.effective,edge.unit]]:edge.type==='milestone'?[[`milestone:${edge.milestone}`,edge.unit]]:[]),...(e.data.plan?.milestones??[]).flatMap(g=>g.units.map(id=>[id,`milestone:${g.id}`]))]);
  assert.equal(graph.units.find(u => u.id === 'u14')!.lineageRef, 'u14');
  assert.equal(graph.units.find(u => u.id === 'u13')!.signal, 'withdrawn');
  assert.equal(graph.focus.firstUncleared, 'MS-1');
  assert.deepEqual(intervals.filter(i => i.subject.id === 'u7' && i.stage === 'build').map(i => [i.attempt, i.round]).sort((a,b) => a[0]! - b[0]!), [[1,1], [2,2], [3,3]]);
  const unit = effort.find(u => u.subject.id === 'u7')!;
  assert.equal(unit.lifetime.rounds, 3); assert.equal(unit.lifetime.redChecks, 1);
  assert.equal(unit.spend.costUsd, 2.25); assert.equal(unit.spend.recorded, 4);
  assert.ok(unit.currentBlockers.preview.text.includes('Baseline hold'));
  assert.equal(effort.find(u => u.subject.id === 'u8')!.currentBlockers.preview.text.includes('Integration queue position 1'), true);
  assert.equal(effort.find(u => u.subject.id === 'u5')!.agentMs, null, 'absence of completed measurements is unknown');
  assert.equal(effort.reduce((n,u) => n + (u.spend.costUsd ?? 0), 0), shell.spend.costUsd, 'unit plus Arc/job attribution counts each charge once');
  const cpu = cpuSummaries(e).find(g => g.parent.id === 'u1')!;
  assert.equal(cpu.reservationPercent, 5); assert.equal(cpu.averageCores, .2); assert.equal(cpu.weightedReservedCores, 4);
  assert.equal(cpu.measuredCalls, 1); assert.equal(cpu.excludedCalls, 0);
  const waits = waitingMeasurements(e, index);
  assert.equal(waits.unmeasuredReservations, 1);
  assert.deepEqual(waits.rows.flatMap(m => m.reasons).map(r => r.ms).sort((a,b) => a-b), [1200,2300,3400,4500,5600]);
  assert.deepEqual(holisticSummaries(e).filter(r => r.type === 'finding').map(r => [r.id, r.claim.text, r.state]), [['F-1','Document empty input behavior','open']]);
  assert.deepEqual(resourceNow(e).queues.filter(q => q.publication).map(q => q.unitId), ['u8', 'u9']);
  assert.equal(resourceNow(e).cpuReservation!.used, 4);
  assert.equal(resourceNow({...e,data:{...e.data,display:{...e.data.display,status:{...e.data.display.status,host:{...e.data.display.status.host,queue:[],jobQueue:[]}}}}}).queueAvailable,null,'an alive owner alone does not prove an empty scheduler capture');
  assert.equal(statusBytes(e, false), beforeFull); assert.equal(statusBytes(e, true), beforeSummary);
});

test('new projections never sweep reports; selected enrichment keeps digest checks on cache hits, pruning and containment', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = capture(f), path = join(f.runDir, 'inv', f.review.routeId, 'result.json'), original = readFileSync(path);
  const id = e.data.display.invocations.find(i => invocationDirName(invocationIdOf(i.id)) === f.review.routeId)!.id;
  assert.ok(retainedReport(e, id)); // Populate validated-content cache.
  writeFileSync(path, JSON.stringify({...JSON.parse(original.toString()), extra: 'tampered'}));
  const index = projectionIndex(e);
  for (const build of [() => shellView(e), () => graphView(e), () => timelineIntervals(e,index), () => effortRows(e,index), () => attentionSummaries(e), () => cpuSummaries(e), () => waitingMeasurements(e,index), () => stageSummaries(e), () => holisticSummaries(e)]) assert.doesNotThrow(build);
  assert.throws(() => retainedReport(e, id), /recorded digest/);
  assert.throws(() => unitView(e,'u7'), /recorded digest/, 'selected journey retains evidence integrity');
  writeFileSync(path, original); assert.ok(retainedReport(e, id));
  unlinkSync(path); assert.equal(retainedReport(e, id), null, 'pruned evidence is not returned from a cached report');
  symlinkSync('/etc/passwd', path); assert.throws(() => retainedReport(e, id), /symlink|escapes/);
  unlinkSync(path); writeFileSync(path, original);
});

test('D3/D4/D5 missing and recorded-zero measurements differ; wait reasons overlap and mixed categories stay unallocated', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = capture(f), measured = e.data.display.invocations.find(i => i.endedAt && i.work?.measured)!;
  const only = {...e, data: {...e.data, display: {...e.data.display, invocations: [{...measured, work: {...measured.work!, measured: {wallMs: 0, runMs: 0, waitMs: 0}}}]}}};
  const row = effortRows(only).find(r => r.subject.id === measured.unit)!;
  assert.equal(measured.execution === 'agent' ? row.agentMs : row.commandMs, 0);
  const interval = timelineIntervals(only)[0]!;
  assert.equal(interval.wallMs, 0); assert.equal(interval.startedAt, measured.startedAt); assert.equal(interval.endedAt, measured.endedAt);
  const mixed = waited({totalMs: 100, byReasonMs: {'cpu-pressure': 80, 'admission-hold:base-red': 90}}, 'waited');
  assert.deepEqual(waitingBreakdown(mixed, 'admission'), {held: 0, queued: 0, unallocated: 100});
  assert.deepEqual(waitingBreakdown(mixed, 'reservation'), {held: 0, queued: 100, unallocated: 0});
  assert.equal(Object.values(mixed.byReasonMs).reduce<number>((n,ms) => n + ms!, 0), 170, 'reason totals are non-additive');
  const missing = timelineIntervals({...only, data: {...only.data, events: only.data.events.filter(ev => ev.type !== 'fact' || !['meter', 'usage-unavailable'].includes(ev.fact.kind))}})[0]!;
  assert.equal(missing.spend.costUsd, null);
});

test('D9 request previews are bounded and retain identity, age, canonical count and duplicate summaries', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = capture(f), requests = e.data.requests;
  assert.ok(requests.length >= 2);
  const first = requests[0]!, second = requests[1]!;
  const summaries = attentionSummaries({...e, data: {...e.data, requests: [{...first, summary: 'Long request '.repeat(1000), recommendation: 'Long advice '.repeat(1000)}, {...second, summary: 'Long request '.repeat(1000)}]}});
  assert.equal(summaries.length, 2); assert.notEqual(summaries[0]!.id, summaries[1]!.id);
  for (const row of summaries) {
    assert.equal(row.summary.truncated, true); assert.equal(row.summary.text.length, 240); assert.ok(row.recommendationPreview.text.length <= 240); assert.equal(row.recommendationPreview.detail.id, row.id);
    if (row.id === String(first.id)) assert.equal(row.recommendationPreview.truncated, true);
    assert.equal(row.summary.detail.id, row.id); assert.ok(row.raisedAt); assert.equal(row.evidenceCount, requests.find(r => r.id === row.id)!.evidence.length);
  }
  assert.deepEqual(preview('', {type:'unit', id:'u1'}), {text:'', truncated:false, detail:{type:'unit',id:'u1'}});
});

test('D8/D11 heartbeat reuse keeps versions and terminal bounds fixed; source changes invalidate independently', async t => {
  const f = await investigationFixture(); t.after(() => f.close()); f.finishLive(); f.complete();
  const e = capture(f), views = new ConsoleViews(), shell = views.shell(e), graph = views.graph(e);
  const later = {...e, checkedAt: new Date(Date.parse(e.checkedAt) + 7 * 3600_000).toISOString(), revision: e.revision + 1};
  assert.equal(views.shell(later), shell); assert.equal(views.graph(later), graph);
  assert.equal(shell.lifecycle.state, 'complete'); assert.ok(shell.lifecycle.endedAt);
  assert.equal(shellView(later).viewVersion, shell.viewVersion);
  const changed = {...e, data: {...e.data, capture: {...e.data.capture, source:'request-change'}, requests: []}};
  assert.notEqual(views.shell(changed).viewVersion, shell.viewVersion);
  assert.equal(views.graph(changed).viewVersion, graph.viewVersion);
  assert.equal(resourceNow({...e,data:{...e.data,display:{...e.data.display,status:{...e.data.display.status,host:{...e.data.display.status.host,pools:{}}}}}}).cpuReservation, null);
});

test('D4 enclosing charges include delegated shares once and preserve estimated, unavailable and explicit-zero costs', async t => {
  const {fact: validateFact} = await import('../src/core/events.ts');
  const {meterOf} = await import('../src/meter.ts');
  const f = await investigationFixture(); t.after(() => f.close());
  const e = capture(f), selected = e.data.events.find(ev => ev.type === 'fact' && ev.fact.kind === 'meter')!;
  assert.ok(selected.type === 'fact' && selected.fact.kind === 'meter');
  const original = selected.fact;
  const withCharge = (costUsd: number | null, estimated = false) => {
    const {costUsd:_cost,costEstimated:_estimated,...usage} = original.usage;
    return validateFact({...original,session:'11111111-1111-4111-8111-111111111111',usage:{...usage,costUsd,...(estimated ? {costEstimated:true} : {})},delegated:[{class:'economy',inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,costUsd:(costUsd??0)/2}]},'meter');
  };
  for (const [cost,estimated] of [[2.5,true],[0,false],[null,false]] as const) {
    const events: readonly Event[] = e.data.events.map(ev => ev === selected ? {...selected,fact:withCharge(cost,estimated)} : ev);
    const rows = effortRows({...e,data:{...e.data,events}}), usage = meterOf(events);
    const canonical = [...usage.byRole,...usage.bySmoke].reduce((n,u) => n+u.costUsd,0);
    assert.equal(rows.reduce((n,r) => n+(r.spend.costUsd??0),0),canonical);
    const interval = timelineIntervals({...e,data:{...e.data,events}}).find(i => i.id === invocationDirName(invocationIdOf(original.inv)))!;
    assert.equal(interval.spend.costUsd,cost); assert.equal(interval.spend.estimated,estimated ? 1 : 0);
    assert.equal(interval.spend.unavailable,cost === null ? 1 : 0);
  }
});
