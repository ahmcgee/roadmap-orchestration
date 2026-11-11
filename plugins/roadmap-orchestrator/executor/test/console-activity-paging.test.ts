import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Observations } from './helpers/observations.ts';
import { statusBytes, type Envelope } from '../src/observation/protocol.ts';
import { ConsoleActivity, ACTIVITY_RETENTION } from '../src/console/activity-query.ts';
import { activityDetail } from '../src/console/activity-detail.ts';
import { buildActivityIndex } from '../src/console/activity-index.ts';
import { backendHolds } from '../src/console/backend-holds.ts';
import { activityShape, activityChangesShape, activityDetailShape, contentShape } from '../src/console/view-shapes.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { fact, type Event } from '../src/core/events.ts';
import { commandId, sha256 } from '../src/core/ids.ts';
import { canonicalJson, sha256Hex } from '../src/core/json.ts';
import { needsUserRecord } from '../src/core/records.ts';
import { needsUserPath } from '../src/needsuser.ts';
import type { ActivityView, ActivityRow } from '../src/console/activity-protocol.ts';

const capture = (f: Awaited<ReturnType<typeof investigationFixture>>, cache = new Observations(f.hostDir, 'activity', 'repo')) => cache.read({runDir: f.runDir, arc: f.arc});
function exhaust(a: ConsoleActivity, e: Envelope, query: Record<string, string> = {}) {
  const pages: ActivityView[] = [], rows: ActivityRow[] = [];
  let page = a.page(e, query);
  for (;;) {
    assert.ok(activityShape(page)); pages.push(page); rows.push(...page.rows);
    if (!page.page.next) break;
    assert.ok(pages.length < 200);
    page = a.page(e, {...query, cursor: page.page.next});
  }
  assert.equal(rows.length, pages[0]!.page.matching); assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  return {pages, rows};
}
function noWorkingSet(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['body', 'events', 'display', 'plan', 'transcript', 'report', 'raw', 'capture', 'estate'].includes(key), `working set leaked: ${key}`);
    noWorkingSet(child);
  }
}

test('Activity keysets exhaust equal/skewed timestamps, both orders, filtered counts and previous pages at one frozen anchor', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  for (let n = 0; n < 65; n++) {const p = f.begin('u7', 'build'); f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false});}
  const e = capture(f), before = statusBytes(e, false);
  // Keep validated fixture facts, alter only their clock values to exercise equal/skewed date indexing.
  const events = e.data.events.map((ev, n) => ({...ev, at: (n % 3 === 0 ? '2026-11-02T12:00:00.000Z' : n % 3 === 1 ? '2026-11-01T12:00:00.000Z' : '2026-11-02T12:00:00.000Z') as typeof ev.at}));
  const skewed = {...e, data: {...e.data, events}}, a = new ConsoleActivity();
  const query = {unit: 'u7', kind: 'stage-outcome', stage: 'build', limit: '25'}, desc = exhaust(a, skewed, query), asc = exhaust(a, skewed, {...query, order: 'asc'});
  assert.equal(desc.rows.length, 68); assert.deepEqual(asc.rows.map(r => r.id), desc.rows.map(r => r.id).reverse());
  assert.ok(desc.rows.every((r, n) => n === 0 || desc.rows[n - 1]!.seq > r.seq));
  assert.equal(desc.pages[0]!.days.reduce((n, d) => n + d.count, 0), 68); assert.equal(desc.pages[0]!.days.length, 2);
  for (let n = desc.pages.length - 1; n > 0; n--) {
    const previous = a.page(skewed, {...query, cursor: desc.pages[n]!.page.previous!});
    assert.deepEqual(previous.rows, desc.pages[n - 1]!.rows); assert.deepEqual(previous.page.asOf, desc.pages[0]!.page.asOf);
  }
  const day = exhaust(a, skewed, {...query, from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z'});
  assert.deepEqual(day.rows, desc.rows.filter(r => r.at.startsWith('2026-11-01')));
  const literal = a.page(skewed, {...query, q: 'BUILD — SUCCEEDED'}); assert.equal(literal.page.matching, 68);
  assert.equal(a.page(skewed, {...query, q: '.*'}).page.matching, 0, 'summary search is literal, not regex');
  const since = a.page(skewed, {...query, afterSeq: String(desc.rows[20]!.seq), epoch: e.epoch}); assert.equal(since.page.matching, 20);
  for (const page of desc.pages) {noWorkingSet(page); assert.ok(Buffer.byteLength(JSON.stringify({...e, data: page}) + '\n') <= 64 * 1024);}
  assert.equal(statusBytes(e, false), before, 'canonical status bytes are unchanged');
});

test('Activity appends do not move anchored rows; changes count only matching new facts and heartbeats do not change versions', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  for (let n = 0; n < 45; n++) {const p = f.begin('u7', 'build'); f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false});}
  const cache = new Observations(f.hostDir, 'activity-append', 'repo'), e = capture(f, cache), a = new ConsoleActivity(), query = {unit: 'u7', kind: 'stage-outcome', limit: '25'};
  const first = a.page(e, query), before = exhaust(a, e, query);
  const p = f.begin('u7', 'build'); f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false});
  const unrelated = f.begin('u6', 'build'); f.journal.fact({kind: 'stage-outcome', unit: unrelated.unit, stage: 'build', attempt: unrelated.attempt, outcome: 'success', class: 'advance', chargeable: false});
  const appended = capture(f, cache), second = a.page(appended, {...query, cursor: first.page.next!});
  assert.deepEqual(second.rows, before.pages[1]!.rows); assert.deepEqual(second.page.asOf, first.page.asOf); assert.equal(second.page.matching, first.page.matching);
  const changes = a.changes(appended, {...query, anchor: first.page.anchor}); assert.ok(activityChangesShape(changes)); assert.equal(changes.newMatching, 1);
  assert.equal(a.page(appended, query).page.matching, first.page.matching + 1);
  const heartbeat = {...appended, checkedAt: new Date(Date.parse(appended.checkedAt) + 1000).toISOString(), revision: appended.revision + 1};
  assert.equal(a.page(heartbeat, query).viewVersion, a.page(appended, query).viewVersion);
  // File-only open-list changes are current Attention facts, never fabricated journal Activity.
  const fileOnly = {...appended, data: {...appended.data, capture: {...appended.data.capture, materializations: appended.data.capture.materializations + 1}, requests: []}};
  assert.equal(a.changes(fileOnly, {...query, anchor: first.page.anchor}).newMatching, 1);
  assert.equal(buildActivityIndex(fileOnly).entries.length, buildActivityIndex(appended).entries.length);
});

test('Activity rejects foreign/tampered cursors, changed filters, invalid queries, eviction, expiry and epoch reset', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  for (let n = 0; n < 40; n++) {const p = f.begin('u7', 'build'); f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false});}
  const e = capture(f), a = new ConsoleActivity(), query = {limit: '25', housekeeping: '1'}, first = a.page(e, query);
  assert.ok(first.page.next);
  for (const params of [{...query, cursor: first.page.next! + 'x'}, {...query, q: 'changed', cursor: first.page.next!}, {...query, limit: '50', cursor: first.page.next!}, {...query, cursor: first.page.anchor}]) assert.throws(() => a.page(e, params), /invalid|foreign/);
  for (const patch of [{arc: 'foreign'}, {repoId: 'foreign'}, {instance: 'prior'}, {epoch: 'replacement'}]) assert.throws(() => a.page({...e, ...patch} as Envelope, {...query, cursor: first.page.next!}), /foreign/);
  assert.throws(() => new ConsoleActivity().page(e, {...query, cursor: first.page.next!}), /invalid/);
  const invalidQueries = [{offset: '30'}, {limit: '30'}, {limit: '025'}, {kind: 'unknown'}, {housekeeping: 'true'}, {order: 'time'}, {q: 'x'.repeat(201)}, {unit: 'missing'}, {unit: 'u1,u1'}, {unit: 'u1,'}, {milestone: 'missing'}, {stage: 'nonsense'}, {role: 'person'}, {backend: 'person'}, {model: 'missing'}, {outcome: 'unknown'}, {zone: 'Not/AZone'}, {from: '2026-02-30T00:00:00Z'}, {from: '2026-11-02'}, {from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z'}, {window: 'arc', from: '2026-11-02T00:00:00Z'}, {window: 'forever'}, {afterSeq: '1'}, {afterSeq: '2', beforeSeq: '1', epoch: e.epoch}, {beforeSeq: '-1'}, {typo: '1'}];
  for (const q of invalidQueries) assert.throws(() => a.page(e, q), {code: 'invalid'}, JSON.stringify(q));
  assert.throws(() => a.changes(e, {}), /anchor/); assert.throws(() => a.changes(e, {...query, anchor: first.page.next!}), /invalid/);
  for (let n = 0; n < ACTIVITY_RETENTION.queries + 1; n++) a.page(e, {...query, q: `unique ${n}`});
  assert.throws(() => a.page(e, {...query, cursor: first.page.next!}), /expired/);
  const recent = a.page(e, query), now = Date.now(); t.mock.method(Date, 'now', () => now + ACTIVITY_RETENTION.idleMs + 1);
  assert.throws(() => a.page(e, {...query, cursor: recent.page.next!}), /expired/);
});

test('D3/D4 attempt rows join every exact parent, preserve recorded zero and distinguish non-agent/unknown costs', async t => {
  const f = await investigationFixture(); t.after(() => f.close()); const e = capture(f), index = buildActivityIndex(e);
  const build = index.entries.find(r => r.row.kind === 'stage-outcome' && r.row.subject.id === 'u7' && r.row.stage === 'build')!;
  assert.equal(build.row.attempt, 1); assert.equal(build.row.round, 1); assert.equal(build.invocations.length, 1); assert.equal(build.row.spend!.costUsd, .5);
  assert.equal(build.row.workMs, 2000); assert.deepEqual(build.row.coverage, {measured: 1, unmeasured: 0});
  const check = index.entries.find(r => r.row.subject.id === 'u7' && r.row.kind === 'stage-outcome' && r.row.stage === 'lanes')!;
  assert.equal(check.row.spend, null, 'commands are not a zero-dollar agent cost');
  const control = index.entries.find(r => r.row.kind === 'plan-applied')!; assert.equal(control.row.actor, null); assert.equal(control.row.workMs, null); assert.equal(control.row.spend, null);
  const a = new ConsoleActivity(), invocationRows = a.page(e, {kind: 'invocation-started', unit: 'u7'});
  assert.equal(invocationRows.page.matching, 5); assert.ok(invocationRows.rows.every(r => r.workMs === null && r.spend === null));
  assert.ok(a.page(e, {}).rows.every(r => r.kind !== 'invocation-started' && r.kind !== 'invocation-ended'));
  const measured = e.data.display.invocations.find(i => i.id === f.finished.inv)!;
  const zero = {...e, data: {...e.data, display: {...e.data.display, invocations: e.data.display.invocations.map(i => i === measured ? {...i, work: {...i.work!, measured: {wallMs: 0, runMs: 0, waitMs: 0}}} : i)}}};
  assert.equal(buildActivityIndex(zero).entries.find(r => r.row.subject.id === 'u1' && r.row.kind === 'stage-outcome' && r.row.stage === 'build')!.row.workMs, 0);
});

test('D8 backend epochs preserve usage-limit dominance, exact covered probes, continuous changes and terminal clipping', async t => {
  const f = await investigationFixture(); t.after(() => f.close());
  const e = capture(f), events: Event[] = [], base = e.data.events[0]!;
  const append = (value: unknown) => {const seq = e.highWater + events.length + 1; events.push({...base, seq, at: new Date(Date.UTC(2026, 10, 1, events.length)).toISOString() as typeof base.at, type: 'fact', fact: fact(value, 'park fixture')}); return seq;};
  const old = append({kind: 'backend-park', backend: 'claude', class: 'capacity', inv: f.review.inv});
  const codex = append({kind: 'backend-park', backend: 'codex', class: 'outage', inv: null});
  append({kind: 'probe', target: {type: 'backend', backend: 'codex'}, covers: [codex], result: 'pass', nextProbeAt: null});
  const latest = append({kind: 'backend-park', backend: 'claude', class: 'outage', inv: null});
  append({kind: 'probe', target: {type: 'backend', backend: 'claude'}, covers: [old], result: 'pass', nextProbeAt: null});
  append({kind: 'probe', target: {type: 'backend', backend: 'claude'}, covers: [latest], result: 'fail', nextProbeAt: '2099-01-01T00:00:00.000Z'});
  const cleared = append({kind: 'probe', target: {type: 'backend', backend: 'claude'}, covers: [latest], result: 'pass', nextProbeAt: null});
  append({kind: 'backend-park', backend: 'claude', class: 'usage-limit', inv: f.review.inv});
  const dominated = append({kind: 'backend-park', backend: 'claude', class: 'capacity', inv: f.review.inv});
  append({kind: 'probe', target: {type: 'backend', backend: 'claude'}, covers: [dominated], result: 'pass', nextProbeAt: null});
  const resumed = append({kind: 'resumed', command: commandId('cmd-0000000000000901'), target: {type: 'backend', backend: 'claude'}});
  append({kind: 'backend-park', backend: 'codex', class: 'outage', inv: null});
  // Use an actual schema-valid terminal fact from the completed fixture.
  f.finishLive(); f.complete(); const terminal = capture(f).data.events.findLast(ev => ev.type === 'fact' && ev.fact.kind === 'arc-completed')!;
  events.push({...terminal, seq: events.at(-1)!.seq + 1});
  const holds = backendHolds(events, e.epoch); assert.equal(holds.length, 6);
  assert.equal(holds[0]!.closure!.kind, 'park-updated'); assert.equal(holds[0]!.endedAt, holds[2]!.startedAt);
  assert.equal(holds[2]!.closure!.seq, cleared); assert.equal(holds[2]!.closure!.kind, 'probe');
  assert.equal(holds[4]!.recordedClass, 'capacity'); assert.equal(holds[4]!.effectiveClass, 'usage-limit'); assert.equal(holds[4]!.closure!.seq, resumed);
  assert.equal(holds[5]!.endedAt, null); assert.equal(holds[5]!.closure, null); assert.equal(holds[5]!.terminalAt, terminal.at);
  const typed = buildActivityIndex({...e, highWater: events.at(-1)!.seq, data: {...e.data, events}});
  assert.equal(typed.entries.filter(r => r.row.kind === 'backend-park').length, 6);
  assert.equal(typed.entries.filter(r => r.row.kind === 'backend-closure').length, 3);
  const parked = {...e, highWater: events.at(-1)!.seq, data: {...e.data, capture: {...e.data.capture, materializations: e.data.capture.materializations + 1}, events}}, a = new ConsoleActivity();
  const detail = activityDetail(parked, a, holds[4]!.id, {}) as any;
  assert.equal(detail.backendHold.startSeq, dominated, 'a new park detail opens its own epoch, not the prior continued hold');
  assert.equal(detail.backendHold.effectiveClass, 'usage-limit');
  const laterPark = {...events.findLast(ev => ev.type === 'fact' && ev.fact.kind === 'backend-park')!, seq: events.at(-1)!.seq + 1};
  assert.equal(backendHolds([...events, laterPark], e.epoch).at(-1)!.terminalAt, null, 'a preceding completion cannot clip a subsequent park');
});

test('selected event evidence keeps exact review findings, request digest/containment and bounded long-field reconstruction', async t => {
  const f = await investigationFixture(); t.after(() => f.close()); const e = capture(f), a = new ConsoleActivity();
  const entry = a.index(e).entries.find(r => r.row.kind === 'stage-outcome' && r.row.subject.id === 'u7' && r.row.stage === 'gate')!;
  const detail = activityDetail(e, a, entry.row.id, {}) as any; assert.ok(activityDetailShape(detail)); noWorkingSet(detail);
  assert.ok(detail.context.some((r: any) => r.value === 'Handle empty input before multiplying')); assert.equal(detail.invocations[0].id, f.review.routeId);
  const result = join(f.runDir, 'inv', f.review.routeId, 'result.json'), original = readFileSync(result);
  writeFileSync(result, '{}'); assert.doesNotThrow(() => a.page(e, {}), 'projection itself does not sweep unrelated reports'); assert.throws(() => activityDetail(e, a, entry.row.id, {}), /digest|identity|result|field|kind|v/);
  writeFileSync(result, original); assert.ok(activityDetailShape(activityDetail(e, a, entry.row.id, {})));
  unlinkSync(result); assert.equal((activityDetail(e, a, entry.row.id, {}) as any).evidenceAvailability, 'pruned');
  symlinkSync('/etc/passwd', result); assert.throws(() => activityDetail(e, a, entry.row.id, {}), /symlink|escapes/); unlinkSync(result); writeFileSync(result, original);
  const request = a.index(e).entries.find(r => r.row.kind === 'request-raised' && r.request?.id === f.request)!;
  const path = needsUserPath(f.runDir, f.request), bytes = readFileSync(path);
  assert.ok((activityDetail(e, a, request.row.id, {}) as any).context.some((r: any) => r.label === 'Recommendation'));
  writeFileSync(path, '{}'); assert.throws(() => a.page(e, {q: 'Compiler process failed'}), /recorded digest/); assert.throws(() => activityDetail(e, a, request.row.id, {}), /recorded digest/);
  writeFileSync(path, bytes); unlinkSync(path); assert.equal((activityDetail(e, a, request.row.id, {}) as any).evidenceAvailability, 'pruned');
  assert.ok(a.page(e, {q: 'Compiler process failed'}).rows.some(r => r.id === request.row.id), 'pruning does not erase an anchored source event');
  symlinkSync('/etc/passwd', path); assert.throws(() => activityDetail(e, a, request.row.id, {}), /symlink|escapes/); unlinkSync(path); writeFileSync(path, bytes);
  assert.throws(() => activityDetail(e, a, 'foreign-event', {}), /not recorded/);
  assert.throws(() => activityDetail(e, a, entry.row.id, {path: '/etc/passwd'}), /query/);
  const long = 'Recorded recommendation \"\\\n𝄞界'.repeat(2000), r = needsUserRecord({...JSON.parse(bytes.toString()), summary: long, recommendation: long}, 'long request');
  const longBytes = canonicalJson(r); writeFileSync(path, longBytes);
  const changed = {...e, data: {...e.data, capture: {...e.data.capture, materializations: e.data.capture.materializations + 1}, events: e.data.events.map(ev =>
    ev.type === 'intent' && ev.kind === 'needsuser.raise' && ev.expect.id === f.request ? {...ev, post: {sha256: sha256(sha256Hex(longBytes))}} : ev)}};
  const b = new ConsoleActivity(), key = b.index(changed).entries.find(r => r.request?.id === f.request)!.row.id;
  const preview = b.page(changed, {q: 'Recorded recommendation'}); assert.equal(preview.rows[0]!.summary.truncated, true); assert.ok(preview.rows[0]!.summary.text.length <= 240);
  const expanded = activityDetail(changed, b, key, {}) as any;
  assert.ok(activityDetailShape(expanded)); assert.ok(Buffer.byteLength(JSON.stringify({...e, data: expanded}) + '\n') <= 32 * 1024);
  let reads = 0, maximum = 0;
  while (expanded.continuations?.length) {
    const used = expanded.continuations.shift(), reply = activityDetail(changed, b, key, {section: 'content', cursor: used.next}) as any;
    assert.ok(contentShape(reply)); const size = Buffer.byteLength(JSON.stringify({...e, data: reply}) + '\n'); maximum = Math.max(maximum, size); assert.ok(size <= 64 * 1024);
    let parent = expanded; for (const part of used.path.slice(0, -1)) parent = parent[part]; const last = used.path.at(-1);
    if (reply.content.kind === 'text') parent[last] = parent[last].slice(0, used.offset) + reply.content.value;
    else parent[last].splice(used.offset, parent[last].length - used.offset, ...reply.content.value);
    expanded.continuations.push(...reply.continuations); assert.ok(++reads < 1000);
  }
  assert.equal(expanded.context.find((r: any) => r.label === 'Summary').value, long);
  assert.equal(expanded.context.find((r: any) => r.label === 'Recommendation').value, long);
  writeFileSync(path, bytes); t.diagnostic(JSON.stringify({longFieldReads: reads, largestFieldBytes: maximum}));
});
