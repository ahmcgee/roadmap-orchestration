// The M4a fixture's harness (evals/m4a/{driver,check,layout,transcript}.ts), rev 3.1 section A: what the driver and the
// checker do around the session, tested without paying. The pure parts are tested on constructed inputs; the driver's
// stop of a held arc on a real host claim; the turn timeout and the report's forensic fields on a real fake-backed run.
// Named tests: evals-m4a.turn-cap-equals-session, evals-m4a.turn-timeout-distinct, evals-m4a.driver-stops-held-arc,
// evals-m4a.check-restores-on-throw, evals-m4a.operator-log-metric, evals-m4a.profile-criterion,
// evals-m4a.watch-absorbs-routine, evals-m4a.terminal-seq-and-post-run, evals-m4a.cost-deltas-and-unknowns.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import type { Event } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { claimHost, readClaim, releaseHost } from '../src/host/lock.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { type ArcForensics, LIMITS, arcForensics, drive, initialPrompt, postRunOf, stopHeldArc } from '../evals/m4a/driver.ts';
import { ActionableFilter, HEARTBEAT_MIN } from '../src/watch.ts';
import { CRITERIA, LEVERS, check, hostReleasedVerdict, interventionsOf, parseOperatorLog, profileVerdict } from '../evals/m4a/check.ts';
import { layout } from '../evals/m4a/layout.ts';
import { costTotals, exportCosts, invocationCosts, rootCosts } from '../evals/m4a/transcript.ts';
import { fakeArc, fakeHostDir } from '../evals/m4a/fake-root.ts';
import { runUntilExit } from './helpers/proc.ts';
import { type RunScope, assertNoSurvivors, teardown, track } from './helpers/reap.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';

after(assertNoSurvivors);

const EVALS = fileURLToPath(new URL('../evals/m4a/', import.meta.url));
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
const T = { timeout: 10 * 60_000 };

test('evals-m4a.turn-cap-equals-session: a turn may use the whole session, real and fake; the prompt allows in-turn supervision and fixes the profile', () => {
  for (const mode of ['real', 'fake'] as const) assert.equal(LIMITS[mode].turnMs, LIMITS[mode].sessionMs, `${mode}: the turn cap is the session cap`);
  assert.equal(LIMITS.real.sessionMs, 360 * 60_000);
  const prompt = initialPrompt('claude-only');
  assert.match(prompt, /you may wait on `roadmap watch --actionable`\s+under Monitor or end your turn; both are supported/);
  assert.match(prompt, /Start every arc with `--profile claude-only`; never change it\./);
  assert.match(initialPrompt('default'), /--profile default/);
});

// ---------------------------------------------------------------------------------------------------

/** A set-up fixture dir: the product repo with a tracked file, the layout's inputs dir, nothing run. */
function bareFixture(): string {
  const dir = join(tmpDir('m4a-harness'), 'fx');
  makeRepo(layout(dir).product, { files: { 'a.txt': 'original\n', '.roadmap/config.json': '{}\n' } });
  mkdirSync(layout(dir).inputs, { recursive: true });
  return dir;
}

const reportOf = (over: Record<string, unknown> = {}): string => JSON.stringify({ scrambled: [], released: [], profile: 'default', hostDir: '/nonexistent', ...over });

test('evals-m4a.check-restores-on-throw: the scrambled live inputs are restored when the check itself throws', T, async () => {
  const dir = bareFixture();
  const l = layout(dir);
  writeFileSync(l.report, reportOf({ scrambled: ['.roadmap/config.json', '.roadmap/corpus.md', 'a.txt'] }));
  // As driver.ts `scramble` leaves it: the live bytes backed up first (an absent path as `<path>.absent`), then scrambled.
  const backup = join(dir, 'diagnostics', 'scramble-backup');
  mkdirSync(join(backup, '.roadmap'), { recursive: true });
  writeFileSync(join(backup, 'a.txt'), 'original\n');
  writeFileSync(join(backup, '.roadmap/config.json'), '{}\n');
  writeFileSync(join(backup, '.roadmap/corpus.md.absent'), '');
  for (const p of ['a.txt', '.roadmap/config.json', '.roadmap/corpus.md']) writeFileSync(join(l.product, p), 'Scrambled by the M4a driver.\n');
  // A ref that is no arc snapshot: reading the product's arcs throws before any criterion runs.
  git(l.product, 'update-ref', 'refs/roadmap/arc-x', 'HEAD');
  await assert.rejects(check(dir), /arc-x/);
  assert.equal(readFileSync(join(l.product, 'a.txt'), 'utf8'), 'original\n');
  assert.equal(readFileSync(join(l.product, '.roadmap/config.json'), 'utf8'), '{}\n');
  assert.ok(!existsSync(join(l.product, '.roadmap/corpus.md')), 'a path absent before the scramble is removed again');
});

// ---------------------------------------------------------------------------------------------------

test('evals-m4a.driver-stops-held-arc: an arc of the product holding the host is stopped and its claim awaited; another repo\'s claim is left alone', T, async () => {
  const host = absPath(join(tmpDir('m4a-host'), 'host'));
  mkdirSync(host, { recursive: true });
  const product = absPath(join(tmpDir('m4a-prod'), 'product'));
  const claim = async (repo: string, arc: string) => {
    const out = await claimHost(host, { arc: arcId(arc), runDir: absPath(join(tmpDir('m4a-run'), arc)), repo: absPath(repo), supervisor: selfIdentity() }, async () => ({ kind: 'reconciled' }));
    assert.equal(out.kind, 'claimed');
    return out.kind === 'claimed' ? out.claim : assert.fail('not claimed');
  };

  // Free host: nothing to release.
  assert.deepEqual(await stopHeldArc(host, product, () => assert.fail('no stop on a free host'), 1_000), []);

  // Another repo's claim: never touched.
  const other = await claim('/elsewhere/other', 'arc-other');
  assert.deepEqual(await stopHeldArc(host, product, () => assert.fail('no stop on another repo\'s claim'), 1_000), []);
  releaseHost(host, other);

  // The product's arc: `stop` ends it (here: the claim is released), the claim is awaited and reported.
  const mine = await claim(product, 'arc-1');
  const stopped: string[] = [];
  const released = await stopHeldArc(host, product, (arc) => {
    stopped.push(arc);
    releaseHost(host, mine);
    return 0;
  }, 5_000);
  assert.deepEqual(stopped, ['arc-1']);
  assert.equal(released.length, 1);
  assert.deepEqual({ arc: released[0]!.arc, stopped: released[0]!.stopped }, { arc: 'arc-1', stopped: true });
  assert.equal(readClaim(host), null);
  assert.equal(hostReleasedVerdict(released, readClaim(host), product).pass, true);

  // A stop that never clears the claim: reported not stopped, and the criterion fails on it.
  const stuck = await claim(product, 'arc-2');
  const failed = await stopHeldArc(host, product, () => 0, 600);
  assert.deepEqual(failed.map((r) => [r.arc, r.stopped]), [['arc-2', false]]);
  const verdict = hostReleasedVerdict(failed, readClaim(host), product);
  assert.equal(verdict.pass, false);
  assert.match(verdict.detail, /arc-2.*still held/);
  assert.match(verdict.detail, /holds the host now/);
  // A stop that exits non-zero but clears the claim is still not a clean stop.
  const dirty = await stopHeldArc(host, product, () => { releaseHost(host, stuck); return 1; }, 5_000);
  assert.deepEqual(dirty.map((r) => [r.arc, r.stopped]), [['arc-2', false]]);
});

// ---------------------------------------------------------------------------------------------------

test('evals-m4a.profile-criterion: every arc\'s first plan-applied is under the profile the session was told; the criterion is graded', () => {
  assert.equal(profileVerdict('claude-only', [{ arc: 'a1', profile: 'claude-only' }, { arc: 'a2', profile: 'claude-only' }]).pass, true);
  const wrong = profileVerdict('claude-only', [{ arc: 'a1', profile: 'claude-only' }, { arc: 'a2', profile: 'default' }, { arc: 'a3', profile: null }]);
  assert.equal(wrong.pass, false);
  assert.match(wrong.detail, /a2 started under default, not claude-only/);
  assert.match(wrong.detail, /a3 started under no plan-applied/);
  const names = CRITERIA.map(([name]) => name);
  assert.ok(names.includes('profile') && names.includes('host-released'));
  assert.ok(!names.includes('interventions'), 'interventions is a metric, never a criterion');
});

// ---------------------------------------------------------------------------------------------------

const entry = (n: number, lever: string, over: Partial<Record<string, string>> = {}): string => [
  `## OP-${n} 2026-10-06T10:0${n}:00Z arc=arc-${n} lever=${lever}`,
  `- symptom: ${over['symptom'] ?? 'a unit sat in awaiting-admission'}`,
  `- evidence: ${over['evidence'] ?? 'status u3, seq 412'}`,
  `- outcome: ${over['outcome'] ?? 'it moved'}`,
  `- executor change: ${over['executor change'] ?? 'release the hold by itself'}`,
  '',
].join('\n');

test('evals-m4a.operator-log-metric: the log counts well-formed entries by lever, lists malformed ones, and a missing log is zero', () => {
  const good = parseOperatorLog(['# Skill feedback', '', 'free text is ignored', '', entry(1, 'apply'), entry(2, 'pause'), entry(3, 'apply'), entry(4, 'inputs export')].join('\n'));
  assert.deepEqual({ n: good.n, byLever: good.byLever, malformed: good.malformed }, { n: 4, byLever: { apply: 2, pause: 1, 'inputs export': 1 }, malformed: [] });
  assert.ok(LEVERS.every((x) => parseOperatorLog(entry(1, x)).n === 1), 'every lever of the closed list parses');

  const bad = parseOperatorLog([
    entry(1, 'apply'),
    entry(2, 'patch-the-executor'),
    entry(3, 'rule', { evidence: '' }),
    '## OP-four sometime arc=a lever=rule\n- symptom: x',
    entry(1, 'stop'),
    entry(6, 'gc').replace('- outcome: it moved\n', ''),
  ].join('\n'));
  assert.equal(bad.n, 1, 'only the first entry is well-formed');
  assert.deepEqual(bad.byLever, { apply: 1 });
  assert.equal(bad.malformed.length, 5);
  assert.match(bad.malformed.join('\n'), /lever "patch-the-executor" is not in the closed list/);
  assert.match(bad.malformed.join('\n'), /"- evidence:"/);
  assert.match(bad.malformed.join('\n'), /heading is not/);
  assert.match(bad.malformed.join('\n'), /OP-1 repeats/);
  assert.match(bad.malformed.join('\n'), /"- outcome:"/);

  const dir = join(tmpDir('m4a-log'), 'fx');
  mkdirSync(layout(dir).inputs, { recursive: true });
  assert.deepEqual(interventionsOf(layout(dir)), { n: 0, byLever: {}, malformed: [] }, 'a missing log is 0');
  writeFileSync(join(layout(dir).inputs, 'skill-feedback.md'), entry(1, 'resume --backend'));
  assert.deepEqual(interventionsOf(layout(dir)), { n: 1, byLever: { 'resume --backend': 1 }, malformed: [] });
});

// ---------------------------------------------------------------------------------------------------

const needsUser = (id: string): string => JSON.stringify({ event: 'needs-user', id, blocking: true, reason: 'x', subject: null, summary: 's' });
const units = (run: string, u1: string): string => JSON.stringify({ event: 'units', run, units: { u1 } });
const MIN = 60_000;

test('evals-m4a.watch-absorbs-routine: the root wakes only on a new needs-user item, a unit merged or parked, a changed constraint or a terminal state', () => {
  const f = new ActionableFilter(0, HEARTBEAT_MIN);
  const wakes: string[] = [];
  const feed = (line: string, arc = 'a1'): void => {
    const w = f.feed(arc, line);
    if (w !== null) wakes.push(w);
  };

  // Routine: owner and ack lines, units moving between stages, gates, lanes and waits.
  feed(JSON.stringify({ event: 'owner', state: 'alive', generation: 1, pid: 7 }));
  feed(units('running', 'running:build#1'));
  feed(units('running', 'running:gate#1'));
  feed(units('running', 'running:lanes#1'));
  feed(JSON.stringify({ event: 'ack', id: 'nu-0', command: 'c', choice: null }));
  feed(units('running', 'waiting:deps=u0'));
  assert.deepEqual(wakes, [], 'routine transitions are absorbed');
  // An item already acknowledged when it is seen (a restarted watch lists the ack before the item) is not actionable.
  feed(needsUser('nu-0'));
  assert.deepEqual(wakes, [], 'an acknowledged item wakes nothing');

  // A needs-user item wakes once; a restarted watch re-emitting it does not wake again; the next arc's same id does.
  feed(needsUser('nu-1'));
  feed(needsUser('nu-1'));
  feed(needsUser('nu-1'), 'a2');
  assert.equal(wakes.length, 2);

  // A unit wakes on entering merged or parked, once; a park changing class is no new park; un-parked and parked again is.
  wakes.length = 0;
  feed(units('running', 'parked:retryable'));
  feed(units('running', 'parked:retryable'));
  feed(units('running', 'parked:terminal'));
  assert.equal(wakes.length, 1, 'a unit parking wakes once');
  feed(units('running', 'running:build#2'));
  feed(units('running', 'parked:retryable'));
  feed(units('running', 'merged'));
  feed(units('running', 'merged'));
  assert.equal(wakes.length, 3, 'parked again and merged each wake on entry');
  // The first view of an arc is its baseline: a fresh watch does not wake on units already merged or parked.
  feed(units('running', 'merged'), 'a4');
  assert.equal(wakes.length, 3, 'a first view wakes no unit');

  // A changed constraint wakes on entry only: held, held again (a restart), running, held again.
  wakes.length = 0;
  feed(units('held', 'held:paused'));
  feed(units('held', 'held:paused'));
  assert.equal(wakes.length, 1, 'a held run wakes once');
  feed(units('running', 'running:build#3'));
  feed(units('held', 'held:paused'));
  feed(units('blocked', 'blocked:deps'));
  feed(units('draining', 'running:build#3'));
  assert.equal(wakes.length, 4, 'held again, blocked and draining each wake on entry');

  // A terminal state wakes once per arc and state.
  wakes.length = 0;
  feed(units('complete', 'merged'));
  feed(units('complete', 'merged'));
  assert.equal(wakes.length, 1);
  assert.equal(f.ended('a1'), true);
  assert.equal(f.ended('a3'), false);
  feed(units('no-owner', 'ready'));
  feed(units('refused', 'ready'));
  assert.equal(wakes.length, 3, 'no-owner and refused are terminal too');
});

test('evals-m4a.watch-absorbs-routine: the heartbeat is a fixed cadence of HEARTBEAT_MIN minutes from the start, whatever happened', () => {
  assert.equal(HEARTBEAT_MIN, 30);
  const t0 = 5_000_000;
  const f = new ActionableFilter(t0, HEARTBEAT_MIN);
  const beat = JSON.stringify({ event: 'heartbeat', everyMin: 30 });
  assert.equal(f.heartbeat(t0 + 29 * MIN), null);
  assert.equal(f.heartbeat(t0 + 30 * MIN), beat);
  assert.equal(f.heartbeat(t0 + 31 * MIN), null, 'one line per period');
  // Activity and wakes do not move the clock.
  assert.notEqual(f.feed('a1', needsUser('nu-9')), null);
  f.feed('a1', units('running', 'running:build#1'));
  assert.equal(f.heartbeat(t0 + 60 * MIN), beat);
  // A late check emits one line, never a burst; the next is due a full period after it.
  assert.equal(f.heartbeat(t0 + 100 * MIN), beat);
  assert.equal(f.heartbeat(t0 + 100 * MIN + 1), null);
  assert.equal(f.heartbeat(t0 + 129 * MIN), null);
  assert.equal(f.heartbeat(t0 + 130 * MIN), beat);
  assert.equal(new ActionableFilter(t0, 7).heartbeat(t0 + 7 * MIN), JSON.stringify({ event: 'heartbeat', everyMin: 7 }));
  assert.throws(() => new ActionableFilter(t0, 0), /positive integer/);
});

// ---------------------------------------------------------------------------------------------------

const fact = (seq: number, kind: string, extra: Record<string, unknown> = {}) => ({ type: 'fact' as const, seq, fact: { kind, ...extra } });

test('evals-m4a.terminal-seq-and-post-run: the terminal seq is the latest arc-completed up to the session end, else the session end; later events are post-run', () => {
  const events = [fact(1, 'plan-applied'), fact(4, 'arc-completed'), fact(5, 'meter'), fact(6, 'arc-completed'), fact(7, 'meter'), fact(8, 'paused'), fact(9, 'arc-completed')];
  const completed = arcForensics('a1', events, 8);
  assert.deepEqual(completed, { arc: 'a1', terminalSeq: 6, lastSeq: 9 } satisfies ArcForensics, 'the completion after the session end does not count');
  assert.deepEqual(postRunOf(completed), { arc: 'a1', fromSeq: 7, events: 3 });

  const open = arcForensics('a2', [fact(1, 'plan-applied'), fact(2, 'meter'), fact(3, 'paused'), fact(4, 'stop-requested'), fact(5, 'meter')], 3);
  assert.deepEqual(open, { arc: 'a2', terminalSeq: 3, lastSeq: 5 }, 'no completion: the seq the session ended at');
  assert.deepEqual(postRunOf(open), { arc: 'a2', fromSeq: 4, events: 2 });

  const quiet = arcForensics('a3', [fact(1, 'plan-applied'), fact(2, 'arc-completed')], 2);
  assert.equal(postRunOf(quiet), null, 'nothing after the terminal state');
});

// ---------------------------------------------------------------------------------------------------

const usage = (costUsd: number | null) => ({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, costUsd });
const spawn = (seq: number, op: string, role: string) => ({ type: 'intent' as const, seq, op, kind: 'proc.spawn', ordinal: 1, expect: { subject: { purpose: 'backend', role, tier: 'frontier', routingRev: 1, unit: 'u1', attempt: 1 }, launchSha256: 'x' } });
const meter = (seq: number, inv: string, role: string, costUsd: number | null, subject: Record<string, unknown> = { type: 'seat', role, tier: 'frontier', unit: 'u1', attempt: 1 }) => fact(seq, 'meter', { inv, routingRev: 1, subject, usage: usage(costUsd) });

test('evals-m4a.cost-deltas-and-unknowns: per-invocation rows keep unknowns explicit, root rows are deltas of the cumulative total, post-run activity is totalled apart', () => {
  const events = [
    spawn(10, 'a1/10', 'implementer'), meter(12, 'a1/10#1', 'implementer', 0.5),
    spawn(20, 'a1/20', 'gate'), meter(22, 'a1/20#1', 'gate', null),
    spawn(30, 'a1/30', 'implementer'), fact(32, 'usage-unavailable', { inv: 'a1/30#1', routingRev: 1, subject: { type: 'seat', role: 'implementer', tier: 'frontier', unit: 'u1', attempt: 1 }, reason: 'no-result' }),
    spawn(40, 'a1/40', 'gate'),
    spawn(50, 'a1/50', 'implementer'), meter(52, 'a1/50#1', 'implementer', 2),
    meter(36, 'a1/36#1', 'lens', 0.25, { type: 'job', role: 'lens', tier: 'frontier', job: 'J-1', attempt: 1 }),
    // Not a backend call: never an invocation row.
    { type: 'intent' as const, seq: 60, op: 'a1/60', kind: 'proc.spawn', ordinal: 1, expect: { subject: { purpose: 'lane', unit: 'u1', lane: 'l', set: 'spec', at: 'x' }, launchSha256: 'x' } },
  ] as unknown as readonly Event[];
  const rows = invocationCosts('a1', events, 35);
  const brief = rows.map((r) => [r.inv, r.role, r.costUsd, r.unknown, r.postRun]);
  assert.deepEqual(brief, [
    ['a1/10#1', 'implementer', 0.5, null, false],
    ['a1/20#1', 'gate', null, 'the CLI reported no cost', false],
    ['a1/30#1', 'implementer', null, 'usage unavailable: no-result', false],
    ['a1/36#1', 'lens', 0.25, null, true],
    ['a1/40#1', 'gate', null, 'no usage fact', true],
    ['a1/50#1', 'implementer', 2, null, true],
  ]);

  // The root: result events carry the cumulative total; turn 2 has none, turn 5 falls.
  const dir = join(tmpDir('m4a-costs'), 'fx');
  const l = layout(dir);
  mkdirSync(dir, { recursive: true });
  const line = (turn: number, event: Record<string, unknown>): string => JSON.stringify({ turn, event });
  writeFileSync(l.transcript, [
    line(1, { type: 'assistant' }), line(1, { type: 'result', result: 'q', total_cost_usd: 1 }),
    line(2, { type: 'assistant' }),
    line(3, { type: 'result', result: 'q', total_cost_usd: 3.5 }),
    line(4, { type: 'result', result: 'q', total_cost_usd: 4 }),
    line(5, { type: 'result', result: 'q', total_cost_usd: 1.5 }),
  ].join('\n') + '\n');
  const root = rootCosts(l.transcript);
  assert.deepEqual(root.map((r) => [r.turn, r.costUsd, r.cumulativeUsd, r.coversTurns]), [
    [1, 1, 1, [1]],
    [2, null, null, [2]],
    [3, 2.5, 3.5, [2, 3]],
    [4, 0.5, 4, [4]],
    [5, null, 1.5, [5]],
  ]);
  assert.match(root[1]!.unknown ?? '', /no total_cost_usd/);
  assert.match(root[4]!.unknown ?? '', /not cumulative/);

  const totals = costTotals(rows, root);
  assert.deepEqual(totals, { kind: 'totals', rootUsd: 4, executorUsd: 0.5, postRunUsd: 2.25, unknownInvocations: 2, unknownRootTurns: 2, postRunUnknown: 1 });

  const written = exportCosts(l, [{ arc: 'a1', events, terminalSeq: 35 }]);
  const onDisk = readFileSync(l.costs, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as { kind: string });
  assert.equal(onDisk.length, written.length);
  assert.deepEqual(onDisk.map((r) => r.kind), ['invocation', 'invocation', 'invocation', 'invocation', 'invocation', 'invocation', 'root', 'root', 'root', 'root', 'root', 'totals']);
});

// ---------------------------------------------------------------------------------------------------

test('evals-m4a.turn-timeout-distinct: a turn killed at its cap ends the run turn-timeout, not session-failed, and the report carries the forensic fields', T, async () => {
  const dir = join(tmpDir('m4a-timeout'), 'fx');
  const setup = await runUntilExit(process.execPath, [join(EVALS, 'setup.ts'), dir], { env: ENV, timeoutMs: 5 * 60_000 });
  assert.equal(setup.code, 0, setup.stderr);
  const scope: RunScope = {
    paths: [dir],
    stop: async () => {
      for (const n of [1, 2]) {
        if (!existsSync(join(layout(dir).product, '.git', 'roadmap-runtime', fakeArc(dir, n)))) continue;
        await runUntilExit(process.execPath, [join(EVALS, 'stage-cli.ts'), layout(dir).plugin, fakeHostDir(dir), 'stop', '--repo', layout(dir).product, '--arc', fakeArc(dir, n)], { env: ENV, timeoutMs: 30_000 });
      }
    },
  };
  track(scope);
  const report = await drive(dir, { kind: 'fake', script: 'story' }, { profile: 'default', limits: { sessionMs: 600_000, turnMs: 300 } }).finally(() => teardown(scope));
  assert.equal(report.endedBy, 'turn-timeout');
  assert.match(report.failure ?? '', /turn 1 was killed at its 300 ms cap/);
  assert.equal(report.turns.length, 1);
  assert.equal(report.profile, 'default');
  assert.deepEqual(report.released, []);
  assert.deepEqual(report.arcs, []);
  assert.deepEqual(report.postRun, []);
  assert.ok(existsSync(layout(dir).costs), 'costs.jsonl is written even for a run that never started an arc');
  assert.ok(existsSync(layout(dir).diagnostics));
});
