// `roadmap status` (src/status.ts) through the real CLI, and the global state.no-model-ids test over full
// fake-backed runs under both profiles. Named tests: status.subset, state.no-model-ids,
// status.sup-items-and-arc-wide-state.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { arcId, hostNeedsUserId, supervisorNeedsUserId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { writeFileNeedsUser } from '../src/executor.ts';
import { snapshotRef } from '../src/git/snapshot.ts';
import { openBlocking } from '../src/needsuser.ts';
import { MODEL_IDS } from '../src/routing/types.ts';
import { SESSION_GUARANTEE, type Status } from '../src/status.ts';
import { reached, release } from './helpers/barrier.ts';
import { git } from './helpers/repo.ts';
import type { Step } from './helpers/scenario.ts';
import { type Owner, assertNoSurvivors } from './helpers/reap.ts';
import { BUILD_REPORT, planCheckStep } from './fixtures/stage-common.ts';
import { MUL, gateStep, mulBuild } from './fixtures/unit-common.ts';
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
    assert.deepEqual(before_, {
      arc: r.arc,
      run: { state: 'no-owner', owner: { state: 'none', generation: null, pid: null }, heartbeatAt: null },
      units: [],
      needsUser: [],
      commands: { pending: [], receipts: [] },
      spend: { byRole: [], byModel: { models: [], unresolvedRevs: [] } },
      host: { containment: { mode: null, guarantee: SESSION_GUARANTEE } },
      parkedBackends: [],
      routing: null,
      rejection: null,
    });
  });

  test('after a completed run: state, owner, units, spend by role and by model, containment and its narrowed guarantee', () => {
    const s = after_;
    assert.deepEqual(Object.keys(s).sort(), ['arc', 'commands', 'host', 'needsUser', 'parkedBackends', 'rejection', 'routing', 'run', 'spend', 'units']);
    assert.equal(s.run.state, 'complete');
    assert.equal(s.run.owner.state, 'none', 'the lock was released');
    assert.ok(s.run.heartbeatAt !== null, 'the executor wrote its heartbeat');
    assert.deepEqual(s.units, [{ unit: 'u1', stage: 'retire', status: 'retired', attempts: 12, chargeableFailures: 0, risk: 'med', seat: null }]);
    assert.deepEqual(s.needsUser, []);
    assert.deepEqual(s.commands, { pending: [], receipts: [] });
    assert.deepEqual(s.spend.byRole.map((t) => [t.role, t.calls]), [['build', 2], ['gate', 1], ['planCheck', 2]], 'the smokes count by role too');
    assert.deepEqual(s.spend.byModel.unresolvedRevs, []);
    // The one permitted derivation: models named by looking seats up in the routing table at render time.
    assert.deepEqual(s.spend.byModel.models.map((m) => [m.model, m.calls]), [['claude-opus-5-5', 3], ['gpt-5.6-luna', 2]]);
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
    const status = JSON.stringify({ ...(await statusOf(r)), spend: null });
    for (const model of MODEL_IDS) assert.ok(!status.includes(model), `${model} in status outside spend.byModel`);
    // The launch inputs are where the models are: the exclusion is not vacuous.
    const launches = files(r.runDir).filter((p) => p.startsWith('inv/') && p.endsWith('launch.json')).map((p) => readFileSync(join(r.runDir, p), 'utf8')).join('\n');
    assert.ok(MODEL_IDS.some((m) => launches.includes(m)), 'launch.json argv names the models it launched');
  }
  const claudeOnly = await statusOf(runs[1]!);
  assert.deepEqual(claudeOnly.spend.byModel.models.map((m) => m.model), ['claude-opus-5-5'], 'claude-only: Opus in every seat this run used');
});

test('status.sup-items-and-arc-wide-state: file-only sup-/host- items are listed until acknowledged; run.state applies the arc-wide rule', { timeout: EXEC_TIMEOUT_MS }, async (t) => {
  const check = planCheckStep({ decision: 'approve' });
  const r = setupExec(t, {
    units: [{ id: 'u1' }, { id: 'u2' }],
    steps: [
      ...SMOKE_DEFAULT, planCheckStep({ decision: 'escalate' }), planCheckStep({ decision: 'escalate' }),
      { ...check, acts: [{ type: 'barrier', name: 'u2check', timeoutMs: 120_000 }, ...check.acts] } as Step,
      mulBuild(), gateStep({ decision: 'approve' }),
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
