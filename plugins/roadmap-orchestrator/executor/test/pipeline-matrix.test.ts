// The whole-pipeline crash matrix (plan "Tests", R23-R25): fake-backed arcs through the real supervised
// `roadmap start` (test/fixtures/pm-common.ts), crashed at every executor crash point they pass through and
// checked by the semantic oracle (test/oracle.ts) against the same scenario uncrashed.
//
// Each scenario runs once uncrashed with the recording mode (pm-record.ts): that run lists the labels its
// executor reached and how often (the method of enumeration), must reach exactly the labels its matrix row
// lists, and is the oracle's reference. Then every label is crashed at occurrence 1, and 2 where it repeats:
// the executor SIGKILLs itself, the supervisor restarts it, and the arc must end as the uncrashed run did,
// with the recovery trace the label allows. Also: the runner, the supervisor, and supervisor and executor
// together killed from outside mid-build; and the adversarial rows (a malformed result, a cancellation, a
// failed publication), each crashed at its own occurrence of its labels.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, after, test } from 'node:test';
import type { Event, IntentOf } from '../src/core/events.ts';
import { arcId, invocationId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import type { ExitReason } from '../src/executor.ts';
import { EXIT_REASON_FILE } from '../src/executor.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { type Owner, assertNoSurvivors } from './helpers/reap.ts';
import {
  ADVERSARIAL_CANCEL, ADVERSARIAL_MALFORMED, ADVERSARIAL_STALE, type Boundary, PIPELINE_BUMPY, PIPELINE_HOST_DEATH, PIPELINE_RUNNER_DEATH,
  PIPELINE_STRAIGHT, PIPELINE_SUPERVISOR_DEATH, SUPERVISOR_HOST, crashCells, killCells,
} from './matrix.ts';
import { type Expected, type OracleRun, type Trace, UNCRASHED, type UnitEnd, assertOracle, oracleRun, outcomesOf } from './oracle.ts';
import { LABEL_TRACE, NONE, R, appendTrace } from './fixtures/pm-trace.ts';
import { type ExecRun, SMOKE_DEFAULT, hostFile } from './fixtures/exec-common.ts';
import {
  BUMPY, BUMPY_OUTCOMES, CANCEL, CANCEL_OUTCOMES, type Hook, MALFORMED, MALFORMED_OUTCOMES, type Recorded, STALE, STALE_LANE, STALE_OUTCOMES, STRAIGHT,
  STRAIGHT_OUTCOMES, type Scenario, blockedAt, buildRunner, callsMatchSteps, finalReason, layout, moveIntegration, readRecord, release, supervisedRun,
} from './fixtures/pm-common.ts';
import { gone, kill, ownerOf, startCli, startLine, startedGenerations, stateOf, supervisorOf } from './fixtures/sup-common.ts';
import { planCheckStep } from './fixtures/stage-common.ts';
import { MUL, codexStep, gateStep } from './fixtures/unit-common.ts';

// Every supervised run a test here started is stopped by its teardown; nothing of them outlives the file.
after(assertNoSurvivors);

/**
 * Supervised runs at once: each is a handful of short-lived processes, often waiting on polls and the
 * supervisor's backoff. At 10 the host sat at about two-thirds busy with the matrix alone; at 16 it is
 * CPU-bound, alone and in the full suite, and the matrix is the suite's longest file.
 */
const CONCURRENCY = 16;
const CELL = { timeout: 360_000 };
const WAIT_MS = 120_000;

// ---------------------------------------------------------------------------------------------------
// References: each scenario uncrashed, recorded

type Reference = Readonly<{
  name: string;
  recorded: Recorded;
  events: readonly Event[];
  reason: ExitReason;
  tree: string;
  units: Readonly<Record<string, UnitEnd>>;
  outcomes: Readonly<Record<string, readonly string[]>>;
  needsUser: readonly string[];
}>;

const unitIds = (r: ExecRun): readonly string[] => (JSON.parse(readFileSync(r.planPath, 'utf8')) as { units: { id: string }[] }).units.map((u) => u.id);
const baselineOf = (r: ExecRun): string => (JSON.parse(readFileSync(r.planPath, 'utf8')) as { baseline: string }).baseline;
const runOf = (r: ExecRun): OracleRun => oracleRun(absPath(r.repo), absPath(r.runDir), arcId(r.arc));

/** What `r`'s run must end as, for a cell of the same scenario: the reference's end, with `trace`. */
function expected(ref: Reference, r: ExecRun, trace: Trace): Expected {
  return { integration: 'main', baseline: baselineOf(r), tree: ref.tree, units: ref.units, outcomes: ref.outcomes, needsUser: ref.needsUser, trace };
}

async function reference(t: Owner, name: string, s: Scenario, outcomes: Readonly<Record<string, readonly string[]>>): Promise<Reference> {
  const laid = layout(t, s);
  const record = join(tmpDir('pm-record'), 'record');
  await supervisedRun(laid, { record });
  const { r } = laid;
  const run = runOf(r);
  const ids = unitIds(r);
  const ref: Reference = {
    name,
    recorded: readRecord(record),
    events: run.events,
    reason: finalReason(r),
    tree: git(r.repo, 'rev-parse', 'main^{tree}'),
    // Every unit of every reference scenario merges (the oracle below checks it).
    units: Object.fromEntries(ids.map((u) => [u, 'merged'])),
    outcomes: Object.fromEntries(ids.map((u) => [u, outcomesOf(run, u)])),
    needsUser: [],
  };
  assert.deepEqual(ref.outcomes, outcomes, `${name}: the uncrashed run takes the scenario's path`);
  assert.deepEqual(callsMatchSteps(r), { ...callsMatchSteps(r), calls: callsMatchSteps(r).steps, unmatched: 0 }, `${name}: every step called once`);
  assertOracle(run, expected(ref, r, UNCRASHED));
  return ref;
}

// ---------------------------------------------------------------------------------------------------
// The recovery trace each crash point allows

function traceFor(ref: Reference, label: string, occurrence: number): Trace {
  if (label.startsWith('log.append.')) {
    const e = ref.events.find((x) => x.seq === occurrence);
    if (e === undefined) throw new Error(`${ref.name}: no event at seq ${occurrence}`);
    return appendTrace(label, e);
  }
  const t = LABEL_TRACE[label];
  if (t === undefined) throw new Error(`no recovery trace is declared for ${label}`);
  return t;
}

// ---------------------------------------------------------------------------------------------------
// A crash cell

/** `s` crashed at (label, occurrence): one crash, one restart, and the arc ends as `ref` did, with `trace`. */
async function crashCell(t: Owner, ref: Reference, s: Scenario, label: string, occurrence: number, trace: Trace, whileDown?: (r: ExecRun) => void): Promise<void> {
  const laid = layout(t, s);
  const { r } = laid;
  const trigger = writeTrigger(tmpDir('pm-trigger'), { label, occurrence });
  await supervisedRun(laid, { trigger, ...(whileDown === undefined ? {} : { whileDown }) });
  assertFired(trigger);
  assert.equal(stateOf(r).crashes.length, 1, 'one executor crash, counted by the supervisor, which restarted it');
  assert.deepEqual(finalReason(r), ref.reason);
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 }, 'every backend call matched its step once: no completed call made twice');
  assertOracle(runOf(r), expected(ref, r, trace));
}

/** Labels of a row's crash cells, as a sorted set. */
const rowLabels = (row: string): readonly string[] => [...new Set(crashCells(row).map((c) => c.label))].sort();
const boundaryOf = (row: string, label: string): Boundary => {
  const c = crashCells(row).find((x) => x.label === label);
  if (c === undefined) throw new Error(`${row} has no cell for ${label}`);
  return c.boundary;
};

/** The executor's invoke spawns in log order (smokes go through their own launch, not `invoke`). */
const invokeSpawns = (events: readonly Event[]): readonly IntentOf<'proc.spawn'>[] =>
  events.flatMap((e) => (e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose !== 'smoke' ? [e] : []));

type CellSpec = Readonly<{ name: string; run: (t: TestContext) => Promise<void> }>;

/** Every label of a whole-pipeline scenario at occurrence 1, and 2 where it repeats. */
function pipelineCells(row: string, ref: Reference, s: Scenario): readonly CellSpec[] {
  return rowLabels(row).flatMap((label) => {
    const count = ref.recorded.executor.get(label) ?? 0;
    return (count >= 2 ? [1, 2] : [1]).map((occurrence) => ({
      name: `${ref.name} ${boundaryOf(row, label)} ${label}#${occurrence}`,
      run: (t) => crashCell(t, ref, s, label, occurrence, traceFor(ref, label, occurrence)),
    }));
  });
}

// ---------------------------------------------------------------------------------------------------
// Kill cells

const reachedBuild = (r: ExecRun): boolean => existsSync(join(r.scenarioDir, 'build1.reached'));

/**
 * The build's runner SIGKILLed mid-call, after the implementer changed the tree: the live executor finds
 * the invocation lost with tree effects and salvages and verifies what it left (lead ruling, 14c).
 */
const RUNNER_DEATH: Scenario = {
  arc: () => ({}),
  steps: () => [
    planCheckStep({ decision: 'approve' }),
    codexStep([{ type: 'dirty', files: MUL }, { type: 'barrier', name: 'build1', timeoutMs: 120_000 }], { argv: ['exec', '-C'] }),
    gateStep({ decision: 'approve' }),
  ],
  hooks: (r): readonly Hook[] => [
    { name: 'kill-runner', when: () => reachedBuild(r), act: async () => void process.kill(buildRunner(r).pid, 'SIGKILL') },
  ],
};

async function runnerDeath(t: Owner, ref: Reference): Promise<void> {
  const laid = layout(t, RUNNER_DEATH);
  const { r } = laid;
  await supervisedRun(laid);
  const run = runOf(r);
  assert.deepEqual(finalReason(r), ref.reason);
  const builds = run.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  assert.equal(builds.length, 1, 'the lost build is not called again');
  const inv = invocationId(builds[0]!.op, builds[0]!.ordinal);
  assert.equal(builds[0]!.ordinal, 1, 'a build lost with tree effects is not retried');
  const done = run.view.doneOf(builds[0]!.op);
  assert.ok(done?.kind === 'proc.spawn' && done.outcome.kind === 'lost' && done.outcome.treeEffects && done.recoveredBy === null, `closed lost with tree effects by the live executor: ${JSON.stringify(done)}`);
  const usage = run.events.flatMap((e) => (e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable') && e.fact.inv === inv ? [e.fact] : []));
  assert.deepEqual(usage.map((f) => (f.kind === 'usage-unavailable' ? f.reason : f.kind)), ['no-result'], 'its usage is unavailable{no-result}');
  assert.deepEqual(run.view.opsOf('proc.kill').map((k) => k.expect.reason), ['recovery'], 'its orphaned workload killed');
  assert.equal(run.view.unit('u1' as never).counters.chargeableFailures, 0, 'a lost build never charges');
  assert.equal(stateOf(r).crashes.length, 0);
  assert.equal(readCalls(r.scenarioPath).filter((c) => c.as === 'codex' && c.step !== null).length, 2, 'the codex smoke and the one build');
  assertOracle(run, {
    integration: 'main', baseline: baselineOf(r), tree: ref.tree, units: { u1: 'merged' },
    outcomes: { u1: ['plan-check:approve', 'build:lost-tree-effects', ...STRAIGHT_OUTCOMES.u1.slice(2)] }, needsUser: [], trace: UNCRASHED,
  });
}

/** The supervisor SIGKILLed mid-build: its executor runs on, alone, to the end; the next start takes over. */
async function supervisorDeath(t: Owner, ref: Reference): Promise<void> {
  const s: Scenario = {
    arc: () => ({}),
    steps: () => [planCheckStep({ decision: 'approve' }), blockedAt([{ type: 'dirty', files: MUL }]), gateStep({ decision: 'approve' }), ...SMOKE_DEFAULT],
    hooks: (r) => [{ name: 'kill-supervisor', when: () => reachedBuild(r), act: () => kill(supervisorOf(r)) }],
  };
  const laid = layout(t, s);
  const { r } = laid;
  const fired = new Set<string>();
  const first = await supervisedRun(laid, {}, fired);
  const orphan = ownerOf(r)?.executor ?? null;
  assert.ok(orphan !== null);
  const busy = await startCli(r, []);
  assert.equal(busy.code, 75, 'while the orphaned executor lives, a start is refused: never two executors');
  assert.equal(startLine(busy).kind, 'refused');
  const refused = JSON.parse(busy.stdout) as { rejections: readonly { kind: string; holder: string }[] };
  assert.deepEqual(refused.rejections.map((x) => [x.kind, x.holder]), [['host-busy', 'owner']]);
  release(r.scenarioDir, 'build1');
  await gone(orphan, WAIT_MS);
  const ended = JSON.parse(readFileSync(hostFile(r, EXIT_REASON_FILE), 'utf8')) as { reason: string; generation: number };
  assert.deepEqual([ended.reason, ended.generation], ['complete', first.firstGeneration], 'the unsupervised executor finished the arc');
  await supervisedRun(laid, {}, fired);
  assert.deepEqual(finalReason(r), ref.reason);
  assert.equal(startedGenerations(r).length, 2, 'the takeover\'s executor started after the first ended');
  assert.deepEqual(stateOf(r).crashes, [], 'nothing crashed');
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 });
  assertOracle(runOf(r), expected(ref, r, UNCRASHED));
}

/** Supervisor and executor SIGKILLed mid-build, the runner alive: the next start takes over and adopts it. */
async function hostDeath(t: Owner, ref: Reference): Promise<void> {
  const s: Scenario = {
    arc: () => ({}),
    steps: () => [planCheckStep({ decision: 'approve' }), blockedAt([{ type: 'dirty', files: MUL }]), ...SMOKE_DEFAULT, gateStep({ decision: 'approve' })],
    hooks: (r) => [
      {
        name: 'kill-host', when: () => reachedBuild(r), act: async () => {
          const executor = ownerOf(r)?.executor ?? null;
          assert.ok(executor !== null);
          await kill(supervisorOf(r));
          await kill(executor);
        },
      },
      // Released once the takeover's executor has started: its recovery finds the runner alive or just exited.
      { name: 'release', when: () => startedGenerations(r).length === 2, act: async () => release(r.scenarioDir, 'build1') },
    ],
  };
  const laid = layout(t, s);
  const { r } = laid;
  const fired = new Set<string>();
  await supervisedRun(laid, {}, fired);
  assert.ok(fired.has('kill-host'));
  await supervisedRun(laid, {}, fired);
  assert.deepEqual(finalReason(r), ref.reason);
  const run = runOf(r);
  const builds = run.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build');
  assert.equal(builds.length, 1, 'the stranded build is consumed, never dispatched again');
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 });
  assertOracle(run, expected(ref, r, R('adopted', 'redone')));
}

// ---------------------------------------------------------------------------------------------------

test('whole-pipeline crash matrix', { concurrency: CONCURRENCY, timeout: 45 * 60_000 }, async (t) => {
  const started = Date.now();
  const [straight, bumpy, malformed, cancel, staleLane] = await Promise.all([
    reference(t, 'straight', STRAIGHT, STRAIGHT_OUTCOMES),
    reference(t, 'bumpy', BUMPY, BUMPY_OUTCOMES),
    reference(t, 'malformed', MALFORMED, MALFORMED_OUTCOMES),
    reference(t, 'cancel', CANCEL, CANCEL_OUTCOMES),
    reference(t, 'stale', STALE_LANE, STALE_OUTCOMES),
  ]);

  // Enumeration: each scenario's executor reached exactly its row's labels; the only other process that
  // reached any is the supervisor, whose labels the supervisor/host row crashes.
  for (const [row, ref] of [[PIPELINE_STRAIGHT, straight], [PIPELINE_BUMPY, bumpy]] as const) {
    assert.deepEqual([...ref.recorded.executor.keys()].sort(), rowLabels(row), `${ref.name}: the labels the executor reached are the row's`);
    assert.deepEqual([...ref.recorded.others.keys()], ['supervisor.ts'], `${ref.name}: only the executor and the supervisor reach crash points`);
    assert.deepEqual([...ref.recorded.others.get('supervisor.ts')!].sort(), rowLabels(SUPERVISOR_HOST), `${ref.name}: the supervisor's labels are the supervisor/host row's`);
  }
  // One tree for every one-unit mul scenario: the kill cells' expectations read it from the straight run.
  assert.equal(malformed.tree, straight.tree);
  assert.equal(cancel.tree, straight.tree);

  // The adversarial cells' occurrences: the malformed gate's own.
  const spawnsM = invokeSpawns(malformed.events);
  assert.equal(spawnsM.length, malformed.recorded.executor.get('spawn.after-intent'), 'every invoke spawn reaches spawn.after-intent once');
  assert.equal(spawnsM.length, malformed.recorded.executor.get('spawn.after-result'), 'and settles live through spawn.after-result once');
  const gateAt = spawnsM.findIndex((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'gate') + 1;
  const stageAt = (ref: Reference, outcome: string): number => {
    const all = ref.outcomes['u1']!;
    assert.equal(ref.recorded.executor.get('unit.after-stage'), all.length - 1, 'unit.after-stage follows every stage but the last');
    return all.indexOf(outcome) + 1;
  };
  const adversarial: readonly CellSpec[] = [
    ...crashCells(ADVERSARIAL_MALFORMED).map((c): CellSpec => {
      const occurrence = c.label === 'unit.after-stage' ? stageAt(malformed, 'gate:malformed') : gateAt;
      const trace = c.label === 'unit.after-stage' ? NONE : R('reconciled');
      return { name: `malformed ${c.boundary} ${c.label}#${occurrence}`, run: (t) => crashCell(t, malformed, MALFORMED, c.label, occurrence, trace) };
    }),
    ...crashCells(ADVERSARIAL_CANCEL).map((c): CellSpec => {
      const traces: Readonly<Record<string, Trace>> = {
        'kill.after-intent': R('redone'),
        'kill.after-cancel': R('reconciled', 'redone'),
        'kill.after-quiesced': R('reconciled', 'redone'),
        'kill.after-done': { recoveredBy: ['redone'], required: false, tailDiscarded: false },
      };
      return { name: `cancel ${c.boundary} ${c.label}#1`, run: (t) => crashCell(t, cancel, CANCEL, c.label, 1, traces[c.label]!) };
    }),
    ...crashCells(ADVERSARIAL_STALE).map((c): CellSpec => (c.label === 'ff.act-start'
      ? { name: `stale ${c.boundary} ff.act-start#1, integration moved while down`, run: (t) => crashCell(t, staleLane, STALE, 'ff.act-start', 1, R('reconciled'), moveIntegration) }
      : { name: `stale ${c.boundary} ${c.label}#${stageAt(staleLane, 'ff:cas-stale')}`, run: (t) => crashCell(t, staleLane, STALE_LANE, c.label, stageAt(staleLane, 'ff:cas-stale'), NONE) })),
  ];
  assert.deepEqual(killCells(PIPELINE_RUNNER_DEATH).map((c) => c.boundary), ['B3']);
  assert.deepEqual(killCells(PIPELINE_SUPERVISOR_DEATH).map((c) => c.boundary), ['B3']);
  assert.deepEqual(killCells(PIPELINE_HOST_DEATH).map((c) => c.boundary), ['B3']);
  const kills: readonly CellSpec[] = [
    { name: `${PIPELINE_RUNNER_DEATH}: B3 kill`, run: (t) => runnerDeath(t, straight) },
    { name: `${PIPELINE_SUPERVISOR_DEATH}: B3 kill`, run: (t) => supervisorDeath(t, straight) },
    { name: `${PIPELINE_HOST_DEATH}: B3 kill`, run: (t) => hostDeath(t, straight) },
  ];

  const cells = [...pipelineCells(PIPELINE_STRAIGHT, straight, STRAIGHT), ...pipelineCells(PIPELINE_BUMPY, bumpy, BUMPY), ...adversarial, ...kills];
  await Promise.all(cells.map((c) => t.test(c.name, CELL, c.run)));
  t.diagnostic(`${cells.length} cells in ${Math.round((Date.now() - started) / 1000)} s`);
});
