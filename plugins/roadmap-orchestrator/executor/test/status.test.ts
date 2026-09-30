// `roadmap status` (src/status.ts) through the real CLI, and the global state.no-model-ids test over full
// fake-backed runs under both profiles. Named tests: status.subset, state.no-model-ids,
// status.sup-items-and-arc-wide-state; M2: status.parallel, status.resources (real runs), status.parks and
// status.legacy-arc (in process, over a log written directly).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { identityOf, readBootId } from '../src/contain/proc.ts';
import type { Fact, ProbeTarget } from '../src/core/events.ts';
import { atomicJson } from '../src/core/fsx.ts';
import { type UnitId, arcId, commandId, hostNeedsUserId, supervisorNeedsUserId, unitId } from '../src/core/ids.ts';
import { type AbsPath, absPath, isoTimeOf } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { HOST_LOCK, hostPath } from '../src/host/hostdir.ts';
import { publishOwner } from '../src/host/owner.ts';
import { nextProbeAt } from '../src/park/schedule.ts';
import { PARK_ESCALATE_MS } from '../src/schedule/types.ts';
import { watch } from '../src/watch.ts';
import { fileSha256 } from '../src/spec/spec.ts';
import { START_FILE, writeFileNeedsUser } from '../src/executor.ts';
import { snapshotRef } from '../src/git/snapshot.ts';
import { openBlocking } from '../src/needsuser.ts';
import { MODEL_IDS } from '../src/routing/types.ts';
import { SESSION_GUARANTEE, type Status, type UnitStatusLine, status } from '../src/status.ts';
import { reached, release } from './helpers/barrier.ts';
import { git } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { type Owner, assertNoSurvivors } from './helpers/reap.ts';
import { BUILD_REPORT, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, MUL, codexStep, contextFor, gateStep, mulBuild, setupArc } from './fixtures/unit-common.ts';
import { claimRecord } from './fixtures/host-records.ts';
import { LANES_BLOCKED, parkBackend, parkUnit } from './fixtures/probe-common.ts';
import {
  EXEC_TIMEOUT_MS, type ExecRun, SMOKE_CLAUDE_ONLY, SMOKE_DEFAULT, cli, journalOf, reasonOf, setupExec, startExec, statusOf, until,
} from './fixtures/exec-common.ts';

// Every supervised run a test here started is stopped by its teardown; nothing of them outlives the file.
after(assertNoSurvivors);

const T = { timeout: EXEC_TIMEOUT_MS };

const DEFAULT_STEPS: readonly Step[] = [...SMOKE_DEFAULT, planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];
const CLAUDE_ONLY_STEPS: readonly Step[] = [
  ...SMOKE_CLAUDE_ONLY, planCheckStep({ decision: 'approve' }),
  { as: 'claude', expect: { argv: ['-p', '--permission-mode'] }, acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: BUILD_REPORT }] },
  gateStep({ decision: 'approve' }),
];

async function completeRun(t: Owner, steps: readonly Step[], extra: readonly string[] = []): Promise<ExecRun> {
  const r = setupExec(t, { steps });
  const exit = await startExec(r, extra).exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(reasonOf(exit).kind, 'complete', exit.stdout);
  return r;
}

describe('status.subset', () => {
  let before_: Status;
  let r: ExecRun;
  let after_: Status;
  // A suite's before hook has no context to own the run: the suite's after hook tears it down.
  const teardowns: (() => Promise<void>)[] = [];
  after(async () => {
    for (const teardown of teardowns) await teardown();
  });
  before(async () => {
    r = setupExec({ after: (fn) => void teardowns.push(fn) }, { steps: DEFAULT_STEPS });
    before_ = await statusOf(r);
    const exit = await startExec(r).exit;
    assert.equal(exit.code, 0, exit.stderr);
    after_ = await statusOf(r);
  }, T);

  test('no-owner when nothing has run: every field present, nothing to report', () => {
    assert.ok(before_.host.log.foldMs >= 0);
    assert.deepEqual({ ...before_, host: { ...before_.host, log: { ...before_.host.log, foldMs: 0 } } }, {
      arc: r.arc,
      run: { state: 'no-owner', owner: { state: 'none', generation: null, pid: null }, heartbeatAt: null },
      units: [],
      edges: [],
      runOnly: null,
      legacy: false,
      needsUser: [],
      commands: { pending: [], receipts: [] },
      spend: { byRole: [], byModel: { models: [], unresolvedRevs: [] }, byJob: [], bySmoke: [] },
      host: {
        containment: { mode: null, guarantee: SESSION_GUARANTEE }, resources: [], pools: {}, queue: [], probes: [], backends: [],
        log: { bytes: 0, events: 0, foldMs: 0, compactionDue: false },
      },
      parkedBackends: [],
      plan: null,
      routing: null,
      rejection: null,
      holistic: false,
      target: null,
      nowTrue: [],
      notYetTrue: [],
      waived: [],
      deferred: [],
      vision: null,
      divergences: [],
      decisionsSince: [],
      convergence: null,
      findings: { active: [], metrics: [] },
      audit: null,
      owed: { audits: [] },
      completion: { planRev: null, head: null, active: false, sealed: false, notSealed: 'not completed', unmet: ['units-open'] },
    });
  });

  test('after a completed run: state, owner, units, spend by role and by model, containment and its narrowed guarantee', () => {
    const s = after_;
    assert.deepEqual(Object.keys(s).sort(), [
      'arc', 'audit', 'commands', 'completion', 'convergence', 'decisionsSince', 'deferred', 'divergences', 'edges', 'findings', 'holistic', 'host', 'legacy',
      'needsUser', 'notYetTrue', 'nowTrue', 'owed', 'parkedBackends', 'plan', 'rejection', 'routing', 'run', 'runOnly', 'spend', 'target', 'units', 'vision',
      'waived',
    ]);
    assert.equal(s.plan?.rev, 1, 'the first start put plan.json in force as revision 1');
    assert.equal(s.plan?.planSha256, fileSha256(absPath(r.planPath)));
    assert.equal(s.run.state, 'complete');
    assert.equal(s.run.owner.state, 'none', 'the lock was released');
    assert.ok(s.run.heartbeatAt !== null, 'the executor wrote its heartbeat');
    assert.deepEqual(s.units, [{
      unit: 'u1', stage: 'retire', status: 'retired', attempts: 12, chargeableFailures: 0, risk: 'med', seat: null,
      state: 'merged', waitingFor: null, holds: [], priority: null, park: null, lineage: null, supersededBy: null, buildTier: 'med', running: null,
    }]);
    assert.equal(s.legacy, false, 'a new arc schedules a DAG');
    assert.deepEqual([s.edges, s.runOnly, s.host.resources, s.host.queue, s.host.probes, s.host.backends], [[], null, [], [], [], []]);
    assert.deepEqual(s.host.pools['@cpu']?.used, 0, 'every token released');
    assert.deepEqual(s.needsUser, []);
    assert.deepEqual(s.commands, { pending: [], receipts: [] });
    assert.deepEqual(s.spend.byRole.map((t) => [t.role, t.calls]), [['build', 1], ['gate', 1], ['planCheck', 1]], 'the unit\'s own calls only');
    assert.deepEqual(s.spend.bySmoke.map((t) => [t.backend, t.calls]), [['claude', 1], ['codex', 1]], 'each start-up smoke apart, by backend');
    assert.deepEqual(s.spend.byModel.unresolvedRevs, []);
    // The one permitted derivation: models named by looking seats up in the routing table at render time.
    assert.deepEqual(s.spend.byModel.models.map((m) => [m.model, m.calls]), [['claude-opus-5-5', 2], ['gpt-5.6-luna', 1]]);
    assert.deepEqual(s.host.containment, { mode: 'session', guarantee: SESSION_GUARANTEE });
    assert.match(s.host.containment.guarantee, /setsid\(\) and execs with a cleared environment/);
    assert.deepEqual(s.parkedBackends, []);
    assert.equal(s.rejection, null);
    // The routing view: classes per seat, the layer that chose each and where each class is bound; no model.
    assert.equal(s.routing?.profile, 'default');
    assert.deepEqual(s.routing?.seats.gate, { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' });
    assert.deepEqual(s.routing?.seats.build, { low: 'efficient', med: 'efficient', high: 'frontier' });
    assert.equal(s.routing?.sources.planCheck.escalation, 'builtin');
    assert.deepEqual(s.routing?.bindings, { efficient: 'builtin', frontier: 'builtin', summit: 'builtin' });
    for (const m of MODEL_IDS) assert.doesNotMatch(JSON.stringify(s.routing), new RegExp(m.replace('.', '\\.')));
    // M3: an arc without the holistic layer has vacuous holistic keys and completes as in M2.
    assert.equal(s.holistic, false);
    assert.deepEqual([s.target, s.vision, s.audit, s.convergence, s.nowTrue, s.notYetTrue, s.divergences, s.decisionsSince], [null, null, null, null, [], [], [], []]);
    assert.deepEqual(s.completion, { planRev: null, head: null, active: false, sealed: false, notSealed: 'not completed', unmet: [] });
    assert.ok(s.host.log.bytes > 0 && s.host.log.events > 0 && !s.host.log.compactionDue, JSON.stringify(s.host.log));
  });
});

/** Every file under `dir`, relative to it. */
function files(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

/**
 * The state.no-model-ids scope: every file the run dir holds except the launch inputs and captured backend
 * output (SCHEMAS.md "Owner rulings on model ids"): `inv/*\/launch.json`, and `stdout`, `stderr` and the Codex
 * `-o` file wherever they were captured (invocation dirs and the evidence snapshots of them).
 */
function inScope(path: string): boolean {
  const name = basename(path);
  if (name === 'stdout' || name === 'stderr' || name === 'last.json') return false;
  return !(path.startsWith('inv/') && name === 'launch.json');
}

function assertNoModelIds(r: ExecRun): number {
  let checked = 0;
  for (const path of files(r.runDir).filter(inScope)) {
    const text = readFileSync(join(r.runDir, path), 'utf8');
    for (const model of MODEL_IDS) assert.ok(!text.includes(model), `${model} in ${path}`);
    checked += 1;
  }
  const ref = snapshotRef(r.arc as never);
  for (const path of git(r.repo, 'ls-tree', '-r', '--name-only', ref).split('\n')) {
    const text = git(r.repo, 'show', `${ref}:${path}`);
    for (const model of MODEL_IDS) assert.ok(!text.includes(model), `${model} in ${ref}:${path}`);
    checked += 1;
  }
  return checked;
}

test('state.no-model-ids: after full runs under the default and claude-only profiles, no executor-written file and no snapshot names a model', { timeout: 2 * EXEC_TIMEOUT_MS }, async (t) => {
  const runs = [await completeRun(t, DEFAULT_STEPS), await completeRun(t, CLAUDE_ONLY_STEPS, ['--profile', 'claude-only'])];
  for (const r of runs) {
    assert.ok(assertNoModelIds(r) > 20, 'the scope covers the log, state, receipts, evidence and the snapshot');
    assert.ok(files(r.runDir).includes('sched.json'), 'and the scheduler\'s derived view');
    // Every status field, the M2 ones included (units' state, holds, priority, park, lineage, buildTier, running;
    // host resources, pools, queue, probes, backends; edges): no model outside spend.byModel.
    assertNoModelIdsInStatus(await statusOf(r));
    // The launch inputs are where the models are: the exclusion is not vacuous.
    const launches = files(r.runDir).filter((p) => p.startsWith('inv/') && p.endsWith('launch.json')).map((p) => readFileSync(join(r.runDir, p), 'utf8')).join('\n');
    assert.ok(MODEL_IDS.some((m) => launches.includes(m)), 'launch.json argv names the models it launched');
  }
  const claudeOnly = await statusOf(runs[1]!);
  assert.deepEqual(claudeOnly.spend.byModel.models.map((m) => m.model), ['claude-opus-5-5', 'claude-sonnet-5-5'], 'claude-only: Opus judges, Sonnet builds');
});

test('status.sup-items-and-arc-wide-state: file-only sup-/host- items are listed until acknowledged; run.state applies the arc-wide rule', { timeout: EXEC_TIMEOUT_MS }, async (t) => {
  const check = planCheckStep({ decision: 'approve' });
  // u1 and u2 are independent, so they run at once (an M2 arc schedules a DAG): each unit's calls take its own steps.
  const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      ...SMOKE_DEFAULT, ...of('u1', [planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' })]),
      ...of('u2', [{ ...check, acts: [{ type: 'barrier', name: 'u2check', timeoutMs: 120_000 }, ...check.acts] } as Step, mulBuild(), gateStep({ decision: 'approve' })]),
    ],
  });
  // What a supervisor's crash limit and a refused claim leave: host-level, blocking, outside the journal.
  mkdirSync(r.runDir, { recursive: true });
  const content = { blocking: true, subject: { type: 'host' }, summary: 'seeded', recommendation: 'ack it', options: [], evidence: [] } as const;
  const sup = supervisorNeedsUserId(3, 3);
  const host = hostNeedsUserId('owner-mismatch-1');
  writeFileNeedsUser(absPath(r.runDir), arcId(r.arc), sup, { ...content, reason: 'supervisor-crash-limit' });
  writeFileNeedsUser(absPath(r.runDir), arcId(r.arc), host, { ...content, reason: 'owner-mismatch' });
  const both = [{ id: host, reason: 'owner-mismatch', blocking: true }, { id: sup, reason: 'supervisor-crash-limit', blocking: true }];
  const idle = await statusOf(r);
  assert.equal(idle.run.state, 'no-owner');
  assert.deepEqual(idle.needsUser, both, 'listed with no executor running');

  const run = startExec(r);
  await until(async () => (await statusOf(r)).run.state === 'parked', 60_000, 'the executor to wait on the host items');
  assert.deepEqual((await statusOf(r)).needsUser, both);
  await cli(r, ['ack', sup]);
  await cli(r, ['ack', host]);

  // u1 parks on a unit-scoped item while u2 runs: running, and the acknowledged host items are gone.
  await reached(r.scenarioDir, 'u2check', 60_000);
  await until(() => openBlocking(journalOf(r).view).length === 1, 60_000, 'u1 to park, u2 still at its plan-check');
  const [item] = openBlocking(journalOf(r).view);
  assert.ok(item !== undefined);
  const mid = await statusOf(r);
  assert.equal(mid.run.state, 'running');
  assert.deepEqual(mid.needsUser, [{ id: item, reason: 'escalation', blocking: true }]);

  // No unit left to run: the open unit item now holds the arc.
  release(r.scenarioDir, 'u2check');
  await until(async () => (await statusOf(r)).run.state === 'parked', 60_000, 'the arc to wait on u1\'s item');
  await cli(r, ['ack', item]);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(reasonOf(exit).kind, 'complete');
  const done = await statusOf(r);
  assert.equal(done.run.state, 'complete');
  assert.deepEqual(done.needsUser, []);
});

// ---------------------------------------------------------------------------------------------------
// The parallel view (M2 step 9)

/** No model id anywhere in a status but `spend` (the one render-time derivation). */
function assertNoModelIdsInStatus(s: Status): void {
  const text = JSON.stringify({ ...s, spend: null });
  for (const model of MODEL_IDS) assert.ok(!text.includes(model), `${model} in status outside spend.byModel`);
}

const perUnit = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
/** A build that commits mul and waits at its unit's barrier `<unit>.build`. */
const heldBuild = codexStep([{ type: 'commit', message: 'add mul', files: MUL }, { type: 'barrier', name: 'build', timeoutMs: 120_000, perUnit: true }], { argv: ['exec', '-C'] });
const heldUnit = (unit: string): readonly Step[] => perUnit(unit, [planCheckStep({ decision: 'approve' }), heldBuild, gateStep({ decision: 'approve' })]);
const line = (s: Status, unit: string): UnitStatusLine => {
  const l = s.units.find((u) => u.unit === unit);
  assert.ok(l !== undefined, `unit ${unit} in status`);
  return l;
};

test('status.parallel: two independent units build at once and status shows both running (stage, attempt, elapsed, their @cpu tokens), a dependent waiting on its dependency, the pool in use and the edge; watch streams the same view compactly; once the dependency merges the paused dependent is held', T, async (t) => {
  const r = setupExec(t, { units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', after: ['u1'] }], steps: [...SMOKE_DEFAULT, ...heldUnit('u1'), ...heldUnit('u2')] });
  mkdirSync(r.runDir, { recursive: true });
  await cli(r, ['pause', 'u3']);
  const lines: Record<string, unknown>[] = [];
  const stop = new AbortController();
  const watching = watch(absPath(r.runDir), arcId(r.arc), absPath(r.hostDir), (l) => lines.push(JSON.parse(l) as Record<string, unknown>), stop.signal);
  try {
    const run = startExec(r);
    for (const u of ['u1', 'u2']) await reached(r.scenarioDir, `${u}.build`, 60_000);
    let s = await statusOf(r);
    await until(async () => (s = await statusOf(r)).units.filter((l) => l.state === 'running').length === 2, 30_000, 'both builds running in status');
    assert.equal(s.run.state, 'running');
    assert.equal(s.legacy, false);
    for (const u of ['u1', 'u2']) {
      const l = line(s, u);
      assert.equal(l.running?.stage, 'build', u);
      assert.equal(l.running.attempt, l.attempts, u);
      assert.ok(l.running.elapsed !== null && l.running.elapsed >= 0, `${u} elapsed`);
      assert.deepEqual(l.running.resources, l.holds, `${u}: a build holds its entry reservation`);
      assert.equal(l.holds.filter((h) => h.startsWith('@cpu#')).length, 4, `${u}: four @cpu tokens`);
      assert.equal(l.waitingFor, null);
      assert.equal(l.priority?.origin, 'planned');
      assert.equal(l.buildTier, 'med');
    }
    assert.equal(line(s, 'u3').state, 'waiting', 'a dependency not merged: waiting, before its pause matters');
    assert.deepEqual(line(s, 'u3').waitingFor, { deps: ['u1'], edges: [], resources: null, envBlocked: false, admission: [], drainFor: [] });
    assert.deepEqual(s.edges, [{ type: 'after', unit: 'u3', on: 'u1', effective: 'u1', met: false }]);
    assert.equal(s.host.pools['@cpu']?.used, 8);
    assert.deepEqual(s.host.queue, []);
    const holders = s.host.resources.map((e) => (e.holder?.type === 'stage' ? `${e.holder.unit}:${e.holder.stage}` : null)).sort();
    assert.deepEqual(holders, [...Array<string>(4).fill('u1:build'), ...Array<string>(4).fill('u2:build')]);
    assertNoModelIdsInStatus(s);
    await until(() => lines.some((l) => {
      const units = l['units'] as Record<string, string> | undefined;
      return l['event'] === 'units' && l['run'] === 'running' && /^running:build#\d+$/.test(units?.['u1'] ?? '') && /^running:build#\d+$/.test(units?.['u2'] ?? '')
        && units?.['u3'] === 'waiting:deps=u1';
    }), 10_000, 'watch to stream both builds running and u3 waiting on u1');

    for (const u of ['u1', 'u2']) release(r.scenarioDir, `${u}.build`);
    await until(async () => (s = await statusOf(r)).run.state === 'held', 60_000, 'u1 and u2 to merge, leaving paused u3');
    assert.deepEqual(s.units.map((l) => l.state), ['merged', 'merged', 'held']);
    assert.deepEqual(line(s, 'u3').waitingFor?.admission, [{ type: 'paused', scope: 'unit' }]);
    assert.deepEqual(s.edges, [{ type: 'after', unit: 'u3', on: 'u1', effective: 'u1', met: true }]);
    await until(() => lines.some((l) => l['event'] === 'units' && l['run'] === 'held' && (l['units'] as Record<string, string>)['u3'] === 'held:paused'), 10_000, 'watch to show u3 held');
    await cli(r, ['stop']);
    const exit = await run.exit;
    assert.equal(exit.code, 0, exit.stderr);
    assert.equal(reasonOf(exit).kind, 'stop');
  } finally {
    stop.abort();
    await watching;
  }
});

test('status.resources: two units want the one instance of a pool; the builder holds it (host.resources, holds), the other waits in the arbiter\'s queue for exactly its entry reservation, the pool shows 1/1 in use; both merge in turn', T, async (t) => {
  const r = setupExec(t, { units: [{ id: 'u1' }, { id: 'u2' }], steps: [...SMOKE_DEFAULT, ...heldUnit('u1'), ...heldUnit('u2')] });
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as { resources: unknown[]; units: { resources: string[] }[] };
  const tool = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, join(import.meta.dirname, 'fixtures', 'res-tool.ts'), cmd, r.stateDir, 'est'], cwd: '.', env: { set: {}, pass: [] } });
  plan.resources = [{ name: 'est', pool: { size: 1 }, probe: tool('probe'), teardown: tool('teardown') }];
  for (const u of plan.units) u.resources = ['est'];
  writeFileSync(r.planPath, JSON.stringify(plan));
  const run = startExec(r);

  let s = await statusOf(r);
  await until(async () => {
    s = await statusOf(r);
    return s.units.some((l) => l.running?.stage === 'build') && s.units.some((l) => l.state === 'waiting');
  }, 60_000, 'one unit building, the other waiting for the pool');
  const builder = s.units.find((l) => l.running?.stage === 'build')!;
  const waiter = s.units.find((l) => l.state === 'waiting')!;
  const want = { named: [], pools: ['est'], cpu: 4, publication: false };
  assert.equal(s.run.state, 'running');
  assert.deepEqual(waiter.waitingFor, { deps: [], edges: [], resources: want, envBlocked: false, admission: [], drainFor: [] });
  assert.deepEqual(s.host.queue, [{ unit: waiter.unit, stage: 'build', attempt: waiter.attempts + 1, publication: false, request: want, envBlocked: false }]);
  assert.deepEqual(s.host.pools['est'], { size: 1, used: 1, dirty: 0 });
  assert.ok(builder.holds.some((h) => h === 'est#1'), JSON.stringify(builder.holds));
  assert.deepEqual(waiter.holds, [], 'a waiter holds nothing (all-or-none)');
  const est = s.host.resources.find((e) => e.resource === 'est#1');
  assert.deepEqual(est?.holder, { type: 'stage', unit: builder.unit, stage: 'build', attempt: builder.running?.attempt });
  assertNoModelIdsInStatus(s);

  release(r.scenarioDir, `${builder.unit}.build`);
  await reached(r.scenarioDir, `${waiter.unit}.build`, 60_000);
  release(r.scenarioDir, `${waiter.unit}.build`);
  const exit = await run.exit;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(reasonOf(exit).kind, 'complete');
  s = await statusOf(r);
  assert.deepEqual(s.units.map((l) => l.state), ['merged', 'merged']);
  assert.deepEqual(s.host.pools['est'], { size: 1, used: 0, dirty: 0 });
});

// In process, over a log written directly: a live owner is a sleeping process named in this run's claim.

function writeStart(d: ArcDescriptor): void {
  atomicJson(join(d.runDir, START_FILE), { v: SCHEMA_VERSION, generation: 1, at: isoTimeOf(new Date()), repo: d.repo, planFile: d.planPath, profile: 'default' });
}

/** Makes this run's claim name a live executor (a sleeping process) until the returned function kills it. */
function liveOwner(d: ArcDescriptor, hostDir: AbsPath): () => Promise<void> {
  const executor = spawn('sleep', ['300'], { stdio: 'ignore' });
  assert.ok(executor.pid !== undefined);
  const exited = new Promise((resolve) => executor.once('exit', resolve));
  const claim = { ...claimRecord({ supervisor: { pid: process.pid, start: identityOf(process.pid).start }, bootId: readBootId(), arc: arcId(d.arc) }), runDir: absPath(d.runDir) };
  atomicJson(hostPath(hostDir, HOST_LOCK), claim);
  const { pid, start } = identityOf(executor.pid);
  publishOwner(hostDir, claim, { pid, start });
  return async () => {
    executor.kill('SIGKILL');
    await exited;
  };
}

const statusNow = (r: ArcRun): Status => status(r.ctx.runDir, arcId(r.d.arc), r.ctx.hostDir);
const HOST: ProbeTarget = { type: 'host' };
const U = (id: string): UnitId => unitId(id);
const designPark = (r: ArcRun, unit: string): number => r.journal.fact({
  kind: 'stage-outcome', unit: U(unit), stage: 'plan-check', attempt: 1, outcome: 'escalate', class: 'park', chargeable: false, park: { class: 'operator', kind: 'design' },
} as Fact);

test('status.parks: a retryable park shows its targets, what is outstanding, its backoff and escalation; the host probe covers both parks and has tripped; an operator park shows its kind and blocks its dependent; a parked backend is listed; with nothing able to move the run is blocked, and a passing probe makes it run', T, async () => {
  const d = setupArc({ steps: [], dag: true, units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', after: ['u2'] }, { id: 'u4' }] });
  const r = contextFor(d);
  let kill: (() => Promise<void>) | null = null;
  try {
    writeStart(d);
    const p1 = parkUnit(r.journal, U('u1'), LANES_BLOCKED, 1, [HOST]);
    const backoff = nextProbeAt(r.journal.view, HOST, [p1], new Date());
    r.journal.fact({ kind: 'probe', target: HOST, covers: [p1], result: 'fail', nextProbeAt: backoff });
    const p4 = parkUnit(r.journal, U('u4'), LANES_BLOCKED, 1, [HOST]);
    designPark(r, 'u2');
    const b = parkBackend(r.journal, 'codex', 'outage', null);

    let s = statusNow(r);
    assert.equal(s.run.state, 'no-owner');
    const parkedAt = r.journal.view.unit(U('u1')).park!.at;
    assert.equal(line(s, 'u1').state, 'parked');
    assert.deepEqual(line(s, 'u1').park, {
      class: 'retryable', targets: [HOST], outstanding: [HOST], nextProbeAt: backoff, escalateAt: isoTimeOf(new Date(Date.parse(parkedAt) + PARK_ESCALATE_MS)),
    });
    assert.equal(line(s, 'u4').park?.nextProbeAt, null, 'no failed probe covers u4\'s park yet: due at once');
    assert.deepEqual(line(s, 'u2').park, { class: 'operator', kind: 'design', targets: [], outstanding: [], nextProbeAt: null, escalateAt: null });
    assert.equal(line(s, 'u3').state, 'blocked', 'D1: a parked dependency is released only by the architect');
    assert.deepEqual(line(s, 'u3').waitingFor, { deps: ['u2'], edges: [], resources: null, envBlocked: false, admission: [], drainFor: [] });
    assert.deepEqual(s.host.probes, [
      { target: { type: 'backend', backend: 'codex' }, parks: [b], nextProbeAt: null, lastResult: null, tripped: false },
      { target: HOST, parks: [p1, p4], nextProbeAt: null, lastResult: 'fail', tripped: true },
    ]);
    assert.deepEqual(s.host.backends, [{ backend: 'codex', parkSeq: b, class: 'outage' }]);
    assert.deepEqual(s.parkedBackends, ['codex']);
    assert.deepEqual(s.edges, [{ type: 'after', unit: 'u3', on: 'u2', effective: 'u2', met: false }]);
    assert.deepEqual(s.units.map((l) => l.priority === null), [true, true, false, true], 'a rank only for an active unit');
    assert.equal(s.runOnly, null);
    assertNoModelIdsInStatus(s);

    kill = liveOwner(d, r.ctx.hostDir);
    assert.equal(statusNow(r).run.state, 'blocked', 'nothing can move: parks being probed and a dead dependency');

    // The host passes for both parks: u1 and u4 are active again; run-only admits u4 alone.
    r.journal.fact({ kind: 'probe', target: HOST, covers: [p1, p4], result: 'pass', nextProbeAt: null });
    r.journal.fact({ kind: 'run-only', command: commandId('cmd-0000000000000001'), units: [U('u4')] });
    s = statusNow(r);
    assert.deepEqual(s.units.map((l) => l.state), ['awaiting-admission', 'parked', 'blocked', 'ready']);
    assert.deepEqual(line(s, 'u1').waitingFor?.admission, [{ type: 'run-only' }]);
    assert.deepEqual(s.runOnly, ['u4']);
    assert.deepEqual(s.host.probes.map((p) => p.target), [{ type: 'backend', backend: 'codex' }], 'the host has no park left');
    assert.equal(s.run.state, 'running');
  } finally {
    await kill?.();
    r.journal.close();
  }
});

test('status.legacy-arc: a dev.4 arc keeps its serial frontier: a parked unit releases the next, later units wait on the frontier; a paused frontier holds the run (not parked)', T, async () => {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] });
  const r = contextFor(d);
  let kill: (() => Promise<void>) | null = null;
  try {
    writeStart(d);
    let s = statusNow(r);
    assert.equal(s.legacy, true);
    assert.deepEqual(s.units.map((l) => l.state), ['ready', 'waiting', 'waiting']);
    assert.deepEqual(s.units.map((l) => l.waitingFor?.deps ?? null), [null, ['u1'], ['u1']], 'one unit at a time, in plan order');

    designPark(r, 'u1');
    kill = liveOwner(d, r.ctx.hostDir);
    s = statusNow(r);
    assert.deepEqual(s.units.map((l) => l.state), ['parked', 'ready', 'waiting'], 'a park releases the next unit, as dev.4 did');
    assert.deepEqual(line(s, 'u3').waitingFor?.deps, ['u2']);
    assert.equal(s.run.state, 'running');

    r.journal.fact({ kind: 'paused', command: commandId('cmd-0000000000000001'), target: { type: 'unit', unit: U('u2') } });
    s = statusNow(r);
    assert.deepEqual(s.units.map((l) => l.state), ['parked', 'held', 'waiting']);
    assert.deepEqual(line(s, 'u2').waitingFor?.admission, [{ type: 'paused', scope: 'unit' }]);
    assert.equal(s.run.state, 'held', 'the frontier is paused: held, whatever is parked before it');
    assertNoModelIdsInStatus(s);
  } finally {
    await kill?.();
    r.journal.close();
  }
});
