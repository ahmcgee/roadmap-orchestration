// dev.77: the Activity index is extended with each capture, not built again (T13), and an anchor outlives the captures after
// it (T14): `activity/changes` counts on a moving arc, and paging stays as frozen at the anchor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Observations } from './helpers/observations.ts';
import { ConsoleActivity, ACTIVITY_RETENTION } from '../src/console/activity-query.ts';
/** dev.75 kept at most eight indexes, and an anchor went with its index. */
const OLD_INDEX_BOUND = 8;
import { buildActivityIndex, type ActivityIndex } from '../src/console/activity-index.ts';
import { displayOrder } from '../src/observation/invocations.ts';
import { invocationId, commandId, findingId, jobId, needsUserId, obligationId, sha256, visionClauseId, unitId } from '../src/core/ids.ts';
import { repoPath } from '../src/core/values.ts';
import type { Fact } from '../src/core/events.ts';
import { captureKey, type Envelope } from '../src/observation/protocol.ts';
import type { ActivityRow, ActivityView } from '../src/console/activity-protocol.ts';
import type { Invocation } from '../src/tui/types.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { needsUserPath, raiseNeedsUser } from '../src/needsuser.ts';
import { renameSync } from 'node:fs';
import { serveConsole } from '../src/console/http.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { absPath } from '../src/core/values.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import type { Metadata } from '../src/console/view-protocol.ts';
import { until } from './fixtures/exec-common.ts';
import { frames, type Frame } from './helpers/console-lag.ts';
import { consoleGet } from './helpers/console-http.ts';

/** The two indexes are the same value: entries (rows, actors, invocations, requests, search, order), holds, units, milestones, facets. */
function sameIndex(extended: ActivityIndex, fresh: ActivityIndex, label: string): void {
  const a = extended.entries.map((x) => JSON.stringify(x)), b = fresh.entries.map((x) => JSON.stringify(x));
  const at = a.findIndex((x, n) => x !== b[n]);
  assert.ok(at === -1 && a.length === b.length, `${label}: entries differ at ${at} of ${a.length}/${b.length}:\n  extended ${a[at] ?? a.at(-1)}\n  built    ${b[at] ?? b.at(-1)}`);
  assert.deepEqual(extended.holds, fresh.holds, `${label}: holds`);
  assert.deepEqual([extended.units, extended.milestones, extended.facets], [fresh.units, fresh.milestones, fresh.facets], `${label}: units, milestones, facets`);
  assert.deepEqual([extended.version, extended.bytes], [fresh.version, fresh.bytes], `${label}: identity and retained size`);
}
function exhaust(a: ConsoleActivity, e: Envelope, query: Record<string, string>): {first: ActivityView; rows: ActivityRow[]} {
  const first = a.page(e, query), rows = [...first.rows];
  for (let page = first; page.page.next;) { page = a.page(e, {...query, cursor: page.page.next}); rows.push(...page.rows); assert.ok(rows.length <= 10_000); }
  return {first, rows};
}

test('T13: an index extended capture by capture equals one built from nothing at every capture, through runs, holds, findings, requests and decisions', {timeout: 120_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const cache = new Observations(f.hostDir, 'activity-extend', 'repo'), a = new ConsoleActivity(), j = f.journal;
  const seen = new Set<string>(), keys = new Set<string>();
  let captures = 0;
  const check = (label: string): Envelope => {
    const e = cache.read({runDir: f.runDir, arc: f.arc}), extended = a.index(e);
    sameIndex(extended, buildActivityIndex(e), label);
    const query = {housekeeping: '1', limit: '100', kind: 'stage-outcome,invocation-started,invocation-ended,backend-park,backend-closure,decision,finding-opened,finding-transition,request-raised,request-acknowledged'};
    assert.deepEqual(a.page(e, query).rows, new ConsoleActivity().page(e, query).rows, `${label}: the newest page`);
    for (const h of extended.holds) seen.add(h.closure?.kind ?? (h.terminalAt ? 'terminal' : 'open'));
    captures++; keys.add(captureKey(e));
    return e;
  };
  const e0 = check('the first capture');
  const meter = e0.data.events.find((ev) => ev.type === 'fact' && ev.fact.kind === 'meter')!;
  if (meter.type !== 'fact' || meter.fact.kind !== 'meter') throw new Error('the fixture records a meter');
  const outcome = (unit: string, stage: 'build', attempt: number, value: 'success' = 'success') =>
    j.fact({kind: 'stage-outcome', unit: unitId(unit), stage, attempt, outcome: value, class: 'advance', chargeable: false} as Fact);

  const build = f.begin('u9', 'build'), run = f.invocation(build, true); check('an agent run starts');
  j.fact({...meter.fact, inv: run.inv, subject: {type: 'seat', unit: unitId('u9'), attempt: build.attempt, role: 'build', tier: 'med'}} as Fact); check('the open run is charged');
  run.append('Working on the change.'); check('the open run writes output');
  run.finish({summary: 'Built the change.'}); check('the run ends');
  outcome('u9', 'build', build.attempt); check('its stage succeeds');
  j.fact({kind: 'backend-park', backend: 'claude', class: 'capacity', inv: f.review.inv} as Fact); const parked = j.view.highWater(); check('a backend is parked');
  const lanes = f.begin('u9', 'lanes'), fail = f.invocation(lanes, false, null, 0, true); check('a check starts');
  fail.finish(); check('the check fails');
  f.outcome(lanes, 'red'); check('the stage is red');
  j.fact({kind: 'probe', target: {type: 'backend', backend: 'claude'}, covers: [parked], result: 'pass', nextProbeAt: null} as Fact); check('a passed probe closes the hold');
  j.fact({kind: 'backend-park', backend: 'codex', class: 'usage-limit', inv: f.review.inv} as Fact); check('another backend is parked');
  j.fact({kind: 'finding-opened', id: findingId('F-2'), key: sha256('2'.repeat(64)), lens: 'invariants', severity: 'P2', obligation: obligationId('I-1'), visionClauses: [visionClauseId('V-1')],
    claim: 'Name the empty input case', evidence: [{path: repoPath('src/mul.js'), blob: null}], mutant: null, source: {type: 'job', job: jobId('audit', 1)}, gateHadPassed: false} as Fact);
  check('a finding is opened');
  j.fact({kind: 'finding-transition', id: findingId('F-2'), to: {state: 'ruled', disposition: 'dismissed', by: {type: 'code', reason: 'not-reproduced'}}} as Fact); check('the finding is ruled');
  j.fact({kind: 'steered', unit: unitId('u9'), command: commandId('cmd-00000000000000a1'), brief: sha256('3'.repeat(64)), budgetMin: 5, resume: true} as Fact); check('a steer is a root decision');
  j.fact({kind: 'resumed', command: commandId('cmd-00000000000000a2'), target: {type: 'backend', backend: 'codex'}} as Fact); check('a resume closes the second hold');
  for (let n = 0; n < 12; n++) { const p = f.begin('u7', 'build'); f.invocation(p, true, {summary: `Round ${n}.`}, 0.25); outcome('u7', 'build', p.attempt); }
  check('twelve more builds in one capture');
  const asked = raiseNeedsUser(j, f.runDir, {reason: 'owner-request', blocking: true, subject: {type: 'unit', unit: unitId('u9')}, summary: 'Confirm the empty input case',
    recommendation: 'Confirm it.', options: [], evidence: []}, {type: 'arc'});
  check('a decision is requested');
  j.fact({kind: 'needs-user-acked', id: asked, command: commandId('cmd-00000000000000a3'), choice: null} as Fact); check('the request is answered');
  f.finishLive(); check('the live run ends');
  j.fact({kind: 'backend-park', backend: 'claude', class: 'outage', inv: null} as Fact); check('a third hold, open at the end');
  f.complete(); const last = check('the arc completes');
  assert.ok(captures >= 10);
  assert.deepEqual([...seen].sort(), ['open', 'probe', 'resumed', 'terminal'], 'holds opened, closed both ways, and clipped by the terminal fact');
  assert.ok(last.data.display.status.decisionsSince.length > e0.data.display.status.decisionsSince.length, 'a root decision was added');
  const sizes = a.sizes();
  assert.equal(sizes.built, 1, 'built from nothing once');
  assert.equal(sizes.extended, keys.size - 1, 'extended at every later capture (a rows refresh keeps its capture\'s index)');
});

test('T13: extended in seeded random chunks over a long journal, the index equals one built from nothing at every position, rows moving with it', {timeout: 120_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  let codex = 0;
  for (let n = 0; n < 150; n++) {
    const p = f.begin(`u${7 + n % 3}`, 'build'); f.invocation(p, n % 4 !== 0, n % 4 === 0 ? {} : {summary: `Change ${n}.`}, n % 5 === 0 ? 0 : 0.1, n % 7 === 0);
    f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false} as Fact);
    if (n % 15 === 3) f.journal.fact({kind: 'backend-park', backend: 'claude', class: 'capacity', inv: f.review.inv} as Fact);
    if (n % 15 === 9) f.journal.fact({kind: 'resumed', command: commandId(`cmd-${n.toString(16).padStart(16, '0')}`), target: {type: 'backend', backend: 'claude'}} as Fact);
    if (n % 30 === 20) { f.journal.fact({kind: 'backend-park', backend: 'codex', class: 'outage', inv: null} as Fact); codex = f.journal.view.highWater(); }
    if (n % 30 === 25) f.journal.fact({kind: 'probe', target: {type: 'backend', backend: 'codex'}, covers: [codex], result: 'pass', nextProbeAt: null} as Fact);
  }
  f.finishLive(); f.complete();
  const end = new Observations(f.hostDir, 'activity-chunks', 'repo').read({runDir: f.runDir, arc: f.arc}), events = end.data.events;
  // Rows as a capture at each position shows them: those spawned by then (`lag` events after their spawn: a row read after
  // the capture that folded its spawn), open while their spawn is not yet done.
  const spawnAt = new Map<string, number>(), doneAt = new Map<string, number>();
  events.forEach((ev, n) => {
    if (ev.type === 'intent' && ev.kind === 'proc.spawn') spawnAt.set(invocationId(ev.op, ev.ordinal), n);
    if (ev.type === 'done' && ev.kind === 'proc.spawn') doneAt.set(String(ev.op), n);
  });
  const at = (k: number, lag: number): Envelope => {
    const seq = events[k - 1]!.seq, rows: Invocation[] = [];
    for (const row of end.data.display.invocations) {
      const spawned = spawnAt.get(row.id); if (spawned === undefined || spawned >= k - lag) continue;
      const done = doneAt.get(row.id.slice(0, row.id.lastIndexOf('#')));
      const {work: _work, ...open} = row;
      rows.push(done !== undefined && done < k ? row : {...open, endedAt: null, state: 'running'});
    }
    rows.sort((x, y) => displayOrder(x, y) || spawnAt.get(x.id)! - spawnAt.get(y.id)!);
    const status = {...end.data.display.status, decisionsSince: end.data.display.status.decisionsSince.filter((d) => d.seq <= seq)};
    // Each position is its own capture: the index is kept per capture (ConsoleActivity's default version).
    return {...end, highWater: seq, data: {...end.data, events: events.slice(0, k), display: {...end.data.display, invocations: rows, status},
      capture: {...end.data.capture, materializations: k}}};
  };
  assert.ok(events.length > 400, `a long journal (${events.length} events)`);
  let positions = 0;
  for (let run = 0; run < 12; run++) {
    let seed = 0x9e3779b9 ^ run;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const a = new ConsoleActivity();
    for (let k = 1 + Math.floor(random() * 20); k <= events.length; k += 1 + Math.floor(random() * (run % 3 === 0 ? 4 : 60))) {
      const e = at(k, run % 2 ? 6 : 0);
      sameIndex(a.index(e), buildActivityIndex(e), `chunking ${run}, ${k} of ${events.length} events`);
      positions++;
    }
    assert.equal(a.sizes().built, 1, `chunking ${run}: built from nothing once`);
  }
  assert.ok(positions > 200, `${positions} positions compared`);
});

test('T13: a decision request seen before its record is published reads the record once its raise is done, as a build from nothing does', {timeout: 60_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const id = raiseNeedsUser(f.journal, f.runDir, {reason: 'owner-request', blocking: true, subject: {type: 'unit', unit: unitId('u9')}, summary: 'Confirm the late record',
    recommendation: 'Confirm it.', options: [], evidence: []}, {type: 'arc'});
  const end = new Observations(f.hostDir, 'activity-late-record', 'repo').read({runDir: f.runDir, arc: f.arc}), events = end.data.events;
  const intent = events.findIndex((ev) => ev.type === 'intent' && ev.kind === 'needsuser.raise' && String(ev.expect.id) === id);
  const done = events.findIndex((ev, n) => n > intent && ev.type === 'done' && ev.kind === 'needsuser.raise');
  assert.ok(intent > 0 && done > intent);
  const at = (k: number): Envelope => ({...end, highWater: events[k - 1]!.seq, data: {...end.data, events: events.slice(0, k), capture: {...end.data.capture, materializations: k}}});
  const a = new ConsoleActivity(), path = needsUserPath(f.runDir, needsUserId(id)), kept = `${path}.away`;
  renameSync(path, kept);
  const before = a.index(at(intent + 1)).entries.find((x) => x.request?.id === id)!;
  assert.match(before.row.summary.text, /evidence pruned/, 'not yet published');
  renameSync(kept, path);
  const after = at(done + 1), extended = a.index(after);
  sameIndex(extended, buildActivityIndex(after), 'after the raise is done');
  assert.equal(extended.entries.find((x) => x.request?.id === id)!.row.summary.text, 'Decision requested: Confirm the late record');
});

test('T14: an anchor issued at capture 1 counts new matching events and pages its frozen rows at every capture after it, past the old index bound', {timeout: 120_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const cache = new Observations(f.hostDir, 'activity-anchor', 'repo'), read = () => cache.read({runDir: f.runDir, arc: f.arc}), a = new ConsoleActivity();
  const e1 = read(), query = {limit: '25', housekeeping: '1'}, runs = {kind: 'invocation-started', limit: '25'};
  const frozen = exhaust(a, e1, query), started = exhaust(a, e1, runs);
  const live = started.rows.find((r) => r.coverage.unmeasured === 1 && r.subject.id === 'u3')!, asked: number[] = [];
  assert.ok(live, 'the live run is open at the anchor');
  for (let capture = 2; capture <= OLD_INDEX_BOUND + 4; capture++) {
    if (capture === 2) f.finishLive();
    const p = f.begin('u9', 'build');
    f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false} as Fact);
    // Asked at captures 2 and 3, then not until more captures than the old bound kept indexes for (8) have passed; the
    // newest page is indexed at each capture meanwhile, as the serve worker warms a tab's list.
    const e = read();
    if (capture > 3 && capture < OLD_INDEX_BOUND + 4) { a.page(e, query); continue; }
    const changes = a.changes(e, {...query, anchor: frozen.first.page.anchor});
    assert.equal(changes.newMatching, new ConsoleActivity().page(e, query).page.matching - frozen.first.page.matching, `capture ${capture}: new matching events`);
    assert.equal(changes.latestHighWater, e.highWater);
    // Paging the anchor's generation on at this capture gives what it gave at capture 1: no duplicates, no gaps, no newer forms.
    const rows: ActivityRow[] = [...frozen.first.rows];
    for (let page = frozen.first; page.page.next;) { page = a.page(e, {...query, cursor: page.page.next}); rows.push(...page.rows); }
    assert.deepEqual(rows, frozen.rows, `capture ${capture}: frozen pages`);
    const runRows: ActivityRow[] = [...started.first.rows];
    for (let page = started.first; page.page.next;) { page = a.page(e, {...runs, cursor: page.page.next}); runRows.push(...page.rows); }
    assert.deepEqual(runRows, started.rows, `capture ${capture}: a run that ended since reads as it was at the anchor`);
    if (capture === 2) {
      const now = exhaust(new ConsoleActivity(), e, runs).rows.find((r) => r.id === live.id)!;
      assert.deepEqual(now.coverage, {measured: 1, unmeasured: 0}, 'the newest index shows the run ended');
    }
    asked.push(capture);
  }
  assert.deepEqual(asked, [2, 3, OLD_INDEX_BOUND + 4]);
});

test('T14: through the console, activity/changes on a moving arc answers 200 with the count at every notice after the anchor', {timeout: 120_000}, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const s = await serveConsole({repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0});
  t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const stream = new AbortController(); t.after(() => stream.abort());
  const seen: Frame[] = []; frames((await fetch(`${base}/events`, {signal: stream.signal})).body!, seen);
  const notices = () => seen.filter((x) => x.event === 'revision').map((x) => x.data as Metadata);
  await until(() => notices().length > 0, 30_000, 'first notice');
  const first = await consoleGet(`${base}/activity`); assert.equal(first.status, 200);
  const page = (await first.json() as {data: ActivityView}).data, statuses: number[] = [];
  for (let capture = 2; capture <= OLD_INDEX_BOUND + 4; capture++) {
    const before = notices().at(-1)!;
    const p = f.begin('u9', 'build');
    f.journal.fact({kind: 'stage-outcome', unit: p.unit, stage: 'build', attempt: p.attempt, outcome: 'success', class: 'advance', chargeable: false} as Fact);
    await until(() => notices().some((n) => n.highWater > before.highWater && n.viewVersions.activity !== before.viewVersions.activity), 10_000, `capture ${capture} published`);
    // The capture stands long enough for the serve worker to index it for the Activity tab (its warm-up after 500 ms).
    await new Promise((r) => setTimeout(r, 800));
    // Asked at captures 2 and 3, then not until more captures than the old bound kept indexes for (8) have passed.
    if (capture > 3 && capture < OLD_INDEX_BOUND + 4) continue;
    const latest = notices().at(-1)!;
    const r = await consoleGet(`${base}/activity/changes?anchor=${encodeURIComponent(page.page.anchor)}&epoch=${latest.epoch}&minHighWater=${latest.highWater}`);
    statuses.push(r.status);
    assert.equal(r.status, 200, `capture ${capture}: ${await r.clone().text()}`);
    const counted = (await r.json() as {data: {newMatching: number; latestHighWater: number}}).data;
    assert.equal(counted.newMatching, capture - 1, `capture ${capture}: one new build outcome a capture`);
    assert.ok(counted.latestHighWater >= latest.highWater);
  }
  assert.deepEqual(statuses, [200, 200, 200]);
});
