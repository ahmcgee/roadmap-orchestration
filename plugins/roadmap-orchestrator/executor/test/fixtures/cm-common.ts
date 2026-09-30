// The concurrent crash matrix's scenarios (test/concurrent-matrix.test.ts; plan F20, G8): M2 arcs run by the
// real supervised `roadmap start` through the whole-pipeline harness (pm-common.ts), keyed per unit.
//
// Every scenario has the same prefix: the peer unit B (u2) starts and reaches its pin, then the stepping unit A
// (u1) starts. A is held back by a contingent edge (`a-go`) the watcher resolves once B is pinned, so A's whole
// walk runs beside a peer in a fixed state. A is the straight scenario (pm-common.ts STRAIGHT: a declared
// resource, decisions.json by spec.patch, salvage, lanes, gate, candidate, ff, snapshot, retire). B's pin is
// one of:
//   build        a live build runner (the fake implementer parks at barrier b-pin);
//   judgment     a live gate runner (the fake gate parks at b-pin), its judgment-inputs durable;
//   lane         a spec lane holding estate#1 (cm-pin.ts; A's own estate lane takes #2);
//   teardown     the teardown of B's build resource `slow` (cm-pin.ts as its teardown);
//   publication  waiting in memory for the publication slot, which a third unit C (u3) holds while its
//                candidate's suite lane parks at c-pin (cm-pin.ts); B starts once C holds it (`b-go`), A once B
//                waits for it;
//   residue      a retryable park on estate#1: B's build teardown failed, and so did the first probe's
//                reclaim (the estate fake fails two teardowns), so the next probe is a minute away.
// Pins are released when A has merged, or when a crashed executor's successor has started (its recovery
// adopts a pinned runner by waiting for it); the publication pin when A's gate approves. The residue park is
// resumed (`resume u2`: probe now) once A has merged. Every pin is one-shot, so a stage a crash cut short runs
// again without parking.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitCommand } from '../../src/commands/queue.ts';
import { arcId, edgeId, unitId } from '../../src/core/ids.ts';
import type { CommandBody } from '../../src/core/records.ts';
import { absPath } from '../../src/core/values.ts';
import { fixture } from '../helpers/proc.ts';
import type { Owner } from '../helpers/reap.ts';
import { tmpDir } from '../helpers/repo.ts';
import type { CodexAct, Step } from '../helpers/scenario.ts';
import { release } from '../helpers/barrier.ts';
import { type ExecRun, SMOKE_DEFAULT, journalOf, setupExec } from './exec-common.ts';
import { type Hook, type Laid, STRAIGHT } from './pm-common.ts';
import type { LaneJson } from './stage-common.ts';
import { planCheckStep } from './stage-common.ts';
import { startedGenerations } from './sup-common.ts';
import { type UnitSpecJson, MUL_LANE, appendSteps, codexStep, gateStep } from './unit-common.ts';

export const A = 'u1';
export const B = 'u2';
export const C = 'u3';

export const PEERS = ['build', 'judgment', 'lane', 'teardown', 'publication', 'residue'] as const;
export type Peer = (typeof PEERS)[number];

const ESTATE_FAKE = fixture('../fakes/estate.ts');
const CM_PIN = fixture('cm-pin.ts');
const PIN = 'b-pin';
const C_PIN = 'c-pin';
/** Long enough for A's whole walk on a loaded host; a pin never waits this long in a passing cell. */
const PIN_TIMEOUT_MS = 300_000;

const file = (name: string, text: string) => ({ [`src/${name}.js`]: text });
const TWO = {
  ...file('two', 'export const two = 2;\n'),
  'test/two.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { two } from '../src/two.js';\n\ntest('two', () => {\n  assert.equal(two, 2);\n});\n",
} as const;
const THREE = {
  ...file('three', 'export const three = 3;\n'),
  'test/three.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { three } from '../src/three.js';\n\ntest('three', () => {\n  assert.equal(three, 3);\n});\n",
} as const;
const TWO_LANE: LaneJson = { id: 'two', argv: ['node', '--test', 'test/two.test.js'] };
const THREE_LANE: LaneJson = { id: 'three', argv: ['node', '--test', 'test/three.test.js'] };

/** Each step keyed to `unit`: its calls take only these, in order. */
const of = (unit: string, steps: readonly Step[]): readonly Step[] => steps.map((s) => ({ ...s, unit }));
const build = (files: Readonly<Record<string, string>>, before: readonly CodexAct[] = []): Step =>
  codexStep([...before, { type: 'commit', message: 'add work', files }], { argv: ['exec', '-C'] });
const pinAct = { type: 'barrier', name: PIN, timeoutMs: PIN_TIMEOUT_MS } as const;

type Json = Record<string, unknown>;
type PlanJson = Json & { units: (Json & { id: string })[]; resources: Json[]; suite: { lanes: Json[] } };

function editPlan(r: ExecRun, edit: (plan: PlanJson) => void): void {
  const plan = JSON.parse(readFileSync(r.planPath, 'utf8')) as PlanJson;
  edit(plan);
  writeFileSync(r.planPath, JSON.stringify(plan));
}

const command = (argv: readonly string[]) => ({ argv, cwd: '.', env: { set: {}, pass: ['PATH'] } });
const lane = (l: LaneJson): Json => ({
  id: l.id, argv: l.argv, cwd: l.cwd ?? '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: l.tier ?? 'fast', resources: l.resources ?? [], evidenceGlobs: [],
});

// ---------------------------------------------------------------------------------------------------
// Reading the run

const unitStatus = (r: ExecRun, unit: string): string => journalOf(r).view.unit(unit as never).status;
export const merged = (r: ExecRun, unit: string): boolean => existsSync(join(r.runDir, 'events.jsonl')) && unitStatus(r, unit) === 'retired';
/** A crashed executor's successor has started: its recovery waits on a pinned runner, so the pin must go. */
export const restarted = (r: ExecRun): boolean => existsSync(join(r.runDir, 'events.jsonl')) && startedGenerations(r).length >= 2;
/** Whether `unit`'s gate has approved: its next stage is the candidate (or later). */
export const approved = (r: ExecRun, unit: string): boolean =>
  existsSync(join(r.runDir, 'events.jsonl')) && journalOf(r).events.some((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit && e.fact.stage === 'gate' && e.fact.outcome === 'approve');
/** B is parked on estate#1 and the first probe of it failed: the next is a minute away. */
export const residueParked = (r: ExecRun): boolean =>
  existsSync(join(r.runDir, 'events.jsonl')) && journalOf(r).events.some((e) => e.type === 'fact' && e.fact.kind === 'probe' && e.fact.target.type === 'resource' && e.fact.result === 'fail');

const once = (name: string, when: () => boolean, act: () => Promise<unknown> | void): Hook => ({ name, when, act: async () => void (await act()) });

/**
 * Queues a command as its `roadmap` CLI command does (src/cli/main.ts `submit`), in the watcher's own process: the
 * CLI's process start is no part of what the matrix crashes, and on a loaded host (the full suite beside the matrix)
 * it can outlive the hook's patience.
 */
export const submit = (r: ExecRun, body: CommandBody): void => void submitCommand(absPath(r.runDir), arcId(r.arc), body);
const resolveEdge = (r: ExecRun, edge: string): void => submit(r, { type: 'resolve-edge', edge: edgeId(edge), evidence: `${edge}: the peer is pinned` });

// ---------------------------------------------------------------------------------------------------
// The scenarios

export type Concurrent = Readonly<{ peer: Peer; laid: Laid; stateDir: string }>;

/**
 * Lays out the `peer` scenario for test `t`: the arc, its keyed steps (after the startup smoke, which is
 * unkeyed) and the watcher's hooks.
 */
export function layoutConcurrent(t: Owner, peer: Peer): Concurrent {
  const barriers = tmpDir('cm-barriers');
  const units: UnitSpecJson[] = [
    { id: A, lanes: peer === 'lane' ? [MUL_LANE, { id: 'estate-a', tier: 'estate', resources: ['estate'], argv: ['ESTATE_A'] }] : [MUL_LANE] },
    { id: B, lanes: peer === 'lane' ? [TWO_LANE, { id: 'estate-b', tier: 'estate', resources: ['estate'], argv: ['ESTATE_B'] }] : [TWO_LANE] },
    ...(peer === 'publication' ? [{ id: C, lanes: [THREE_LANE] }] : []),
  ];
  const r = setupExec(t, { steps: [], units });
  const stateDir = r.stateDir;
  const estatePool = { name: 'estate', pool: { size: 2 }, probe: command([process.execPath, ESTATE_FAKE, 'probe', stateDir, 'estate']), teardown: command([process.execPath, ESTATE_FAKE, 'teardown', stateDir, 'estate']) };
  editPlan(r, (plan) => {
    plan['capacity'] = { cpu: 16 };
    plan.resources = [
      { name: 'db', probe: command([process.execPath, fixture('res-tool.ts'), 'probe', stateDir, 'db']), teardown: command([process.execPath, fixture('res-tool.ts'), 'teardown', stateDir, 'db']) },
      ...(peer === 'lane' || peer === 'residue' ? [estatePool] : []),
      ...(peer === 'teardown' ? [{ name: 'slow', probe: command([process.execPath, fixture('res-tool.ts'), 'probe', stateDir, 'slow']), teardown: command([process.execPath, CM_PIN, barriers, PIN]) }] : []),
    ];
    if (peer === 'publication') plan.suite.lanes.push(lane({ id: 'c-pin', argv: [process.execPath, CM_PIN, barriers, C_PIN] }));
    for (const u of plan.units) {
      if (u.id === A) {
        u['resources'] = ['db'];
        u['contingent'] = [{ id: 'a-go', condition: 'the peer is pinned' }];
      }
      if (u.id === B) {
        u['resources'] = peer === 'teardown' ? ['slow'] : peer === 'residue' ? ['estate'] : [];
        if (peer === 'publication') u['contingent'] = [{ id: 'b-go', condition: 'C holds the publication slot' }];
      }
    }
  });
  if (peer === 'lane') {
    // The estate lanes' argv names this run's state dir and barriers, known only now: A's holds its instance
    // briefly (the estate fake), B's holds estate#1 at the pin.
    for (const [unit, marker, argv] of [
      [A, 'ESTATE_A', [process.execPath, ESTATE_FAKE, 'hold', stateDir, 'estate']],
      [B, 'ESTATE_B', [process.execPath, CM_PIN, barriers, PIN, stateDir, 'estate']],
    ] as const) {
      const specPath = join(r.planPath, '..', `${unit}.json`);
      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { lanes: { argv: string[] }[] };
      for (const l of spec.lanes) if (l.argv[0] === marker) l.argv = [...argv];
      writeFileSync(specPath, JSON.stringify(spec));
    }
  }
  if (peer === 'residue') writeFileSync(join(stateDir, 'estate.teardown-fails-once'), '2');

  const approve = planCheckStep({ decision: 'approve' });
  const peerSteps: Readonly<Record<Peer, readonly Step[]>> = {
    build: [approve, build(TWO, [pinAct]), gateStep({ decision: 'approve' })],
    judgment: [approve, build(TWO), gateStep({ decision: 'approve' }, {}, [pinAct])],
    lane: [approve, build(TWO), gateStep({ decision: 'approve' })],
    teardown: [approve, build(TWO), gateStep({ decision: 'approve' })],
    publication: [approve, build(TWO), gateStep({ decision: 'approve' })],
    residue: [approve, build(TWO), gateStep({ decision: 'approve' })],
  };
  appendSteps(r, [
    ...SMOKE_DEFAULT,
    ...of(A, STRAIGHT.steps(r)),
    ...of(B, peerSteps[peer]),
    ...(peer === 'publication' ? of(C, [approve, build(THREE), gateStep({ decision: 'approve' })]) : []),
  ]);

  const pinned = (dir: string, name: string) => () => existsSync(join(dir, `${name}.reached`));
  const releasePin = (dir: string): Hook => once('release', () => merged(r, A) || restarted(r), () => release(dir, PIN));
  const hooks: Readonly<Record<Peer, readonly Hook[]>> = {
    build: [once('a-go', pinned(r.scenarioDir, PIN), () => resolveEdge(r, 'a-go')), releasePin(r.scenarioDir)],
    judgment: [once('a-go', pinned(r.scenarioDir, PIN), () => resolveEdge(r, 'a-go')), releasePin(r.scenarioDir)],
    lane: [once('a-go', pinned(barriers, PIN), () => resolveEdge(r, 'a-go')), releasePin(barriers)],
    teardown: [once('a-go', pinned(barriers, PIN), () => resolveEdge(r, 'a-go')), releasePin(barriers)],
    publication: [
      once('b-go', pinned(barriers, C_PIN), () => resolveEdge(r, 'b-go')),
      once('a-go', () => approved(r, B), () => resolveEdge(r, 'a-go')),
      once('release', () => approved(r, A) || restarted(r), () => release(barriers, C_PIN)),
    ],
    residue: [
      once('a-go', () => residueParked(r), () => resolveEdge(r, 'a-go')),
      once('resume', () => merged(r, A), () => submit(r, { type: 'resume', target: { type: 'unit', unit: unitId(B) } })),
    ],
  };
  return { peer, laid: { r, barriers, hooks: hooks[peer] }, stateDir };
}
