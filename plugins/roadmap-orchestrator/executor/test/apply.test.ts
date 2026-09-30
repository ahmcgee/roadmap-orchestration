// `roadmap apply` in process (src/commands/apply.ts `applyPlan`, src/input/{classify,inforce}.ts, the fold's
// `plan-applied`): the classifier's per-edit rules, one row per edit class; the plan in force as a fold of
// the log, with and without a fact; an apply's rejections (a stale expectRev, files changed since they were
// hashed, a startup row) and its smoke of a backend the new routing needs; and the crash cells of the apply
// matrix row. Named tests: apply.classifier-table, apply.fold, apply.rejections, apply.smoke-new-backend,
// apply.upgrade-queued-resume, apply.crash-cells, apply.recovered-after-start; M2: apply.cut-*, apply.reenter-*, apply.pool-*,
// apply.capacity-*, apply.after-non-prefix-* (G3), apply.revalidate-after-smoke, cmd.scope,
// apply.stale-after-evidence-revision.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type CommandOutcome, applyCommand } from '../src/commands/apply.ts';
import { pollCommands, readReceipt, submitCommand } from '../src/commands/queue.ts';
import type { Fact, IntentOf, PlanChange } from '../src/core/events.ts';
import { type UnitId, arcId, clauseId, commandId, edgeId, invocationIdOf, opKey, planRev, poolInstance, resourceName, routingRev, seatRev, sha, specRev, unitId } from '../src/core/ids.ts';
import { openJournal, readJournal } from '../src/core/log.ts';
import type { CommandBody, ResidueKey } from '../src/core/records.ts';
import { FoldInvariantError } from '../src/core/state.ts';
import { earlierReleaseBaseline } from '../src/core/upgrade.ts';
import { absPath, isoTimeOf, repoPattern } from '../src/core/values.ts';
import { type Classified, classify, commandScope } from '../src/input/classify.ts';
import {
  PLAN_INPUT, SPEC_INPUT, keepInputFiles, keptInput, planInForce, readInputFiles, recordPlan, requirePlanInForce, revisionInForce, specShaInForce,
} from '../src/input/inforce.ts';
import { pinDispatch, repin, runOp } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { reentryAllowed } from '../src/pipeline/unit.ts';
import { type StageHolder, reserve } from '../src/resources/reserve.ts';
import { requestOf } from '../src/resources/pool.ts';
import { commandReconciler } from '../src/recover/command.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import { specPatchOp } from '../src/spec/patch.ts';
import { fileSha256 } from '../src/spec/spec.ts';
import { reached, release } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { PLAN_APPLY, crashCells } from './matrix.ts';
import { type ArcDescriptor, type ArcRun, type UnitSpecJson, applyBody, commandContextFor, contextFor, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: 60_000 };
type Json = Record<string, unknown>;
type UnitJson = Json & { id: string; after?: string[] };
type PlanJson = Json & { units: UnitJson[]; resources: Json[]; suite: { lanes: Json[] } };

// ---------------------------------------------------------------------------------------------------
// Files and unit states

const U1 = unitId('u1');
const readPlan = (d: ArcDescriptor): PlanJson => JSON.parse(readFileSync(d.planPath, 'utf8')) as PlanJson;
const specPath = (d: ArcDescriptor, unit: string): string => join(d.planPath, '..', `${unit}.json`);

function editPlan(d: ArcDescriptor, edit: (plan: PlanJson) => void): void {
  const plan = readPlan(d);
  edit(plan);
  writeFileSync(d.planPath, JSON.stringify(plan));
}

function editSpec(d: ArcDescriptor, unit: string, edit: (spec: Json) => void): void {
  const spec = JSON.parse(readFileSync(specPath(d, unit), 'utf8')) as Json;
  edit(spec);
  writeFileSync(specPath(d, unit), JSON.stringify(spec));
}

/** Adds unit `id` to the plan, its spec a copy of u1's under its id. */
function addUnit(d: ArcDescriptor, id: string): void {
  editSpec(d, 'u1', () => {});
  const spec = JSON.parse(readFileSync(specPath(d, 'u1'), 'utf8')) as Json;
  writeFileSync(specPath(d, id), JSON.stringify({ ...spec, unit: id, rev: 1 }));
  editPlan(d, (p) => void p.units.push({ ...p.units[0]!, id, spec: `${id}.json`, after: [] }));
}

const addClause = (s: Json): void => {
  s['acceptance'] = [...(s['acceptance'] as Json[]), { id: 'A2', clause: 'mul(0, 5) is 0', failLoudIfUndelivered: true, state: 'active' }];
};
const evidenceGlobs = (s: Json): void => {
  s['lanes'] = (s['lanes'] as Json[]).map((l) => ({ ...l, evidenceGlobs: ['out/**'] }));
};
const tool = { argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] } };
const DB = { name: 'db', probe: tool, teardown: tool };

/** Pins `unit`'s dispatch on its spec in force, as its first plan-check does. */
function pin(r: ArcRun, unit: string): void {
  const u = r.unit(unit);
  const { spec, sha256 } = loadUnitSpec(r.ctx, u);
  assert.equal(pinDispatch(r.ctx, u, { rev: spec.rev, sha256 }).kind, 'pinned');
}

/** Records one stage outcome of `unit` with the class given (the next attempt). */
function decide(r: ArcRun, unit: string, stage: string, outcome: string, cls: string): void {
  const id = unitId(unit);
  const attempt = r.journal.view.unit(id).counters.attempts + 1;
  r.journal.fact({ kind: 'stage-outcome', unit: id, stage, attempt, outcome, class: cls, chargeable: false } as Fact);
}

const routingBase = { profile: 'default', config: null } as const;

function classifyNow(r: ArcRun, residues: readonly ResidueKey[] = []): Classified {
  const { runDir } = r.ctx;
  const inForce = requirePlanInForce(runDir, r.journal.view);
  return classify({
    runDir, view: r.journal.view, inForce, revision: revisionInForce(runDir, inForce, absPath(r.d.planPath)), next: readInputFiles(absPath(r.d.planPath)), residues,
    routing: routingBase, proposer: { type: 'apply' },
  });
}

/** Classifies the files and puts them in force, as an accepted apply does. */
function accept(r: ArcRun): void {
  const v = classifyNow(r);
  if (v.kind !== 'accepted') assert.fail(`expected an accepted change, got ${JSON.stringify(v)}`);
  recordPlan(r.journal, r.ctx.runDir, readInputFiles(absPath(r.d.planPath)), v.changes, routingBase);
}

// ---------------------------------------------------------------------------------------------------
// The classifier table

type Row = Readonly<{
  name: string;
  units?: readonly UnitSpecJson[];
  /** Before the arc's first context (the baseline records the files as they are then). */
  before?: (d: ArcDescriptor) => void;
  setup?: (r: ArcRun) => void;
  edit: (d: ArcDescriptor, r: ArcRun) => void;
  residues?: readonly ResidueKey[];
  /** Revision 1 records `scheduling: 'dag'` (an arc started on M2); otherwise the arc is legacy. */
  dag?: boolean;
  expect: 'unchanged' | ((r: ArcRun) => readonly PlanChange[]) | readonly RegExp[];
}>;

const THREE: readonly UnitSpecJson[] = [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }];
const specChange = (d: ArcDescriptor, unit: string, edit: Extract<PlanChange, { type: 'spec' }>['edit'], rev: number): PlanChange =>
  ({ type: 'spec', unit: unitId(unit), edit, specRev: specRev(rev), specSha256: fileSha256(absPath(specPath(d, unit))) });
const inFlight = (r: ArcRun): void => {
  pin(r, 'u1');
  decide(r, 'u1', 'plan-check', 'approve', 'advance');
};
const revise = (d: ArcDescriptor): void => editSpec(d, 'u1', (s) => {
  addClause(s);
  s['rev'] = 2;
});

const ROWS: readonly Row[] = [
  { name: 'add a unit: now', edit: (d) => addUnit(d, 'u4'), expect: () => [{ type: 'unit-added', unit: unitId('u4') }] },
  {
    name: 'a removed unit id is never planned again',
    setup: (r) => {
      editPlan(r.d, (p) => void p.units.splice(2, 1));
      accept(r);
    },
    edit: (d) => editPlan(d, (p) => void p.units.push({ ...p.units[1]!, id: 'u3', spec: 'u3.json' })),
    expect: [/unit id u3 was planned before; ids are never reused/],
  },
  {
    name: 'add a unit with a reserved id (batch-<n>, jobs, mutants): refused, each named',
    edit: (d) => ['batch-3', 'jobs', 'mutants'].forEach((id) => addUnit(d, id)),
    expect: [/unit id batch-3 is reserved/, /unit id jobs is reserved/, /unit id mutants is reserved/],
  },
  {
    name: 'a reserved id already in an adopted arc\'s plan in force stays: its edits and other additions apply',
    units: [{ id: 'u1' }, { id: 'batch-2' }, { id: 'jobs' }],
    edit: (d) => {
      addUnit(d, 'u4');
      editSpec(d, 'jobs', addClause);
    },
    expect: (r) => [{ type: 'unit-added', unit: unitId('u4') }, specChange(r.d, 'jobs', 'undispatched', 1)],
  },
  { name: 'remove a unit that never started: now', edit: (d) => editPlan(d, (p) => void p.units.splice(2, 1)), expect: () => [{ type: 'unit-removed', unit: unitId('u3') }] },
  {
    name: 'remove a unit that started: refused, with every reason',
    setup: (r) => pin(r, 'u1'),
    edit: (d) => editPlan(d, (p) => void p.units.splice(0, 1)),
    expect: [/unit u1 has started; it cannot be removed/, /units that have started \(u1\) must stay first in plan order/],
  },
  { name: 'reorder units that never started: now', setup: (r) => pin(r, 'u1'), edit: (d) => editPlan(d, (p) => void p.units.reverse().unshift(p.units.pop()!)), expect: () => [{ type: 'order' }] },
  {
    name: 'a started unit behind one that never started: refused',
    setup: (r) => pin(r, 'u1'),
    edit: (d) => editPlan(d, (p) => void p.units.push(p.units.shift()!)),
    expect: [/units that have started \(u1\) must stay first/],
  },
  { name: 'an undispatched unit\'s plan entry: now', edit: (d) => editPlan(d, (p) => void (p.units[1]!['risk'] = 'high')), expect: () => [{ type: 'unit-changed', unit: unitId('u2') }] },
  { name: 'an undispatched unit\'s spec: now', edit: (d) => editSpec(d, 'u2', addClause), expect: (r) => [specChange(r.d, 'u2', 'undispatched', 1)] },
  {
    name: 'a dispatched unit\'s lower risk and its scope: refused (M3: its risk may rise)',
    setup: (r) => pin(r, 'u1'),
    edit: (d) => editPlan(d, (p) => {
      p.units[0]!['risk'] = 'low';
      p.units[0]!['scope'] = ['src/**'];
    }),
    expect: [/unit u1 is dispatched: its risk may not change/, /unit u1 is dispatched: its scope may not change/],
  },
  {
    name: 'a new `after` on a dispatched unit: refused',
    setup: (r) => {
      pin(r, 'u1');
      pin(r, 'u2');
    },
    edit: (d) => editPlan(d, (p) => void (p.units[1]!.after = ['u1'])),
    expect: [/unit u2 is dispatched: it may not run after u1 as well/],
  },
  {
    name: 'a dispatched unit dropping an `after`: now',
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    setup: (r) => {
      pin(r, 'u1');
      pin(r, 'u2');
    },
    edit: (d) => editPlan(d, (p) => void (p.units[1]!.after = [])),
    expect: () => [{ type: 'unit-changed', unit: unitId('u2') }],
  },
  { name: 'an evidence-only edit of an in-flight unit: in force at once', setup: inFlight, edit: (d) => editSpec(d, 'u1', evidenceGlobs), expect: (r) => [specChange(r.d, 'u1', 'evidence', 1)] },
  { name: 'any other edit at the same rev: refused', setup: inFlight, edit: (d) => editSpec(d, 'u1', addClause), expect: [/changed but is still at rev 1; a revision sets rev 2/] },
  { name: 'rev + 1 of an in-flight unit: pending', setup: inFlight, edit: revise, expect: (r) => [specChange(r.d, 'u1', 'revision', 2)] },
  { name: 'rev + 2: refused', setup: inFlight, edit: (d) => editSpec(d, 'u1', (s) => void (s['rev'] = 3)), expect: [/is at rev 3, but the unit's recorded rev is 1; a revision sets rev 2/] },
  {
    name: 'rev + 1 changing the spec\'s scope: refused',
    setup: inFlight,
    edit: (d) => editSpec(d, 'u1', (s) => {
      s['rev'] = 2;
      s['scope'] = ['src/**'];
    }),
    expect: [/its spec's scope and resources may not change/],
  },
  {
    name: 'rev + 1 of an approved unit: refused',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'gate', 'approve', 'advance');
    },
    edit: revise,
    expect: [/unit u1 is approved and publishing; its spec is fixed/],
  },
  {
    name: 'an evidence-only edit of a merged unit: refused',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'snapshot', 'published', 'retire');
    },
    edit: (d) => editSpec(d, 'u1', evidenceGlobs),
    expect: [/unit u1 is merged; its spec is fixed/],
  },
  {
    name: 'rev + 1 of a unit parked at the gate: pending for its resume',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'gate', 'escalate', 'park');
    },
    edit: revise,
    expect: (r) => [specChange(r.d, 'u1', 'revision', 2)],
  },
  {
    name: 'rev + 1 of a unit parked at a candidate: refused (re-enter under a new id)',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'candidate', 'red', 'park');
    },
    edit: revise,
    expect: [/unit u1 is parked at candidate, which is final in M1/],
  },
  {
    name: 'an evidence-only edit of a unit parked at a candidate: refused',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'candidate', 'red', 'park');
    },
    edit: (d) => editSpec(d, 'u1', evidenceGlobs),
    expect: [/unit u1 is parked at candidate, which is final in M1/],
  },
  {
    name: 'rev + 1 of a unit with an attempt a crash cut short: refused until the executor records it',
    setup: (r) => {
      inFlight(r);
      const parent = { type: 'stage', unit: U1, stage: 'build', attempt: 2 } as const;
      r.journal.begin({ kind: 'worktree.create', key: opKey('worktree:u1:unit'), parent, deadlineAt: null, body: () => ({
        expect: { path: absPath(tmpDir('apply-wt')), checkout: { type: 'detached', at: sha('0'.repeat(40)) } }, post: null,
      }) });
    },
    edit: revise,
    expect: [/unit u1 has build attempt 2 cut short by a crash/],
  },
  {
    name: 'a pending revision taken back: withdrawn',
    setup: (r) => {
      inFlight(r);
      const original = readFileSync(specPath(r.d, 'u1'));
      revise(r.d);
      accept(r);
      writeFileSync(specPath(r.d, 'u1'), original);
    },
    edit: () => {},
    expect: (r) => [specChange(r.d, 'u1', 'withdrawn', 1)],
  },
  {
    name: 'routing: re-resolved to a new routingRev',
    edit: (d) => editPlan(d, (p) => void (p['routing'] = { build: { med: 'frontier' } })),
    expect: (r) => [{ type: 'routing', routingRev: resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: { build: { med: 'frontier' } } as never, unit: null }).rev }],
  },
  { name: 'add a resource declaration: now', edit: (d) => editPlan(d, (p) => void p.resources.push(DB)), expect: () => [{ type: 'resource', resource: resourceName('db'), edit: 'added' }] },
  {
    name: 'change a free resource declaration: now',
    before: (d) => editPlan(d, (p) => void p.resources.push(DB)),
    edit: (d) => editPlan(d, (p) => void (p.resources[0]!['teardown'] = { ...tool, argv: ['node', '-e', '1'] })),
    expect: () => [{ type: 'resource', resource: resourceName('db'), edit: 'changed' }],
  },
  {
    name: 'change a held resource declaration: refused',
    before: (d) => editPlan(d, (p) => void p.resources.push(DB)),
    setup: reserveDb,
    edit: (d) => editPlan(d, (p) => void (p.resources[0]!['teardown'] = { ...tool, argv: ['node', '-e', '1'] })),
    expect: [/resource db is held \(reserved\)/],
  },
  {
    name: 'remove a resource an undisposed residue names: refused',
    before: (d) => editPlan(d, (p) => void p.resources.push(DB)),
    edit: (d) => editPlan(d, (p) => void p.resources.pop()),
    residues: [{ arc: arcId('other-arc'), unit: U1, inv: invocationIdOf('other-arc/4#1'), resource: resourceName('db') }],
    expect: [/resource db is named by an undisposed residue/],
  },
  {
    name: 'suite lanes: now',
    edit: (d) => editPlan(d, (p) => void p.suite.lanes.push({ ...p.suite.lanes[0]!, id: 'suite2' })),
    expect: () => [{ type: 'suite' }],
  },
  {
    name: 'suite lanes while a unit is past a candidate attempt: refused',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'candidate', 'red', 'candidate-red');
    },
    edit: (d) => editPlan(d, (p) => void p.suite.lanes.push({ ...p.suite.lanes[0]!, id: 'suite2' })),
    expect: [/suite lanes may not change while a candidate is under way \(unit u1 is past a candidate attempt\)/],
  },
  {
    name: 'arc, integrationBranch, baseline, worktreeRoot: always refused',
    edit: (d) => editPlan(d, (p) => {
      p['integrationBranch'] = 'other';
      p['worktreeRoot'] = tmpDir('apply-wt');
    }),
    expect: [/integrationBranch may never change/, /worktreeRoot may never change/],
  },
  { name: 'the other plan fields: now', edit: (d) => editPlan(d, (p) => void (p['direction'] = 'Keep it smaller.')), expect: () => [{ type: 'plan-field', field: 'direction' }] },
  { name: 'nothing edited: unchanged', edit: () => {}, expect: 'unchanged' },
  { name: 'the same plan in other bytes: in force, no change listed', edit: (d) => writeFileSync(d.planPath, JSON.stringify(readPlan(d), null, 2)), expect: () => [] },
];

/** Reserves `db` for u1's build, as its reservation does. */
function reserveDb(r: ArcRun): void {
  const holder: StageHolder = { type: 'stage', unit: U1, stage: 'build', attempt: 1 };
  assert.equal(reserve(r.ctx, holder, requestOf(r.ctx.plan(), [resourceName('db')], 0), { ...holder }).state, 'reserved');
}

/**
 * Records the files as revision 1 of an arc started on M2 (`scheduling: 'dag'`), before `contextFor` would
 * record them as a legacy arc's. Its `@cpu` pool is sized 8, so no row depends on the host's parallelism.
 */
function dagArc(d: ArcDescriptor): void {
  editPlan(d, (p) => void (p['capacity'] = { cpu: 8 }));
  const journal = openJournal(absPath(d.runDir), arcId(d.arc));
  try {
    const manifest = keepInputFiles(absPath(d.runDir), readInputFiles(absPath(d.planPath)));
    journal.fact({ kind: 'plan-applied', rev: planRev(1), command: null, ...manifest, changes: [], scheduling: 'dag' });
  } finally {
    journal.close();
  }
}

// ---------------------------------------------------------------------------------------------------
// M2 rows: cut, re-entry, the effective graph, pools, capacity, started order (G3)

const unitJson = (p: PlanJson, id: string): UnitJson => p.units.find((u) => u.id === id) ?? assert.fail(`no unit ${id}`);
const cutUnits = (...ids: string[]) => (d: ArcDescriptor): void => editPlan(d, (p) => {
  for (const id of ids) unitJson(p, id)['cut'] = { reason: 'out of scope' };
});
/** Adds unit `id` re-entering `old` (a copy of u1's entry and spec), with `extra` over its entry. */
const reenter = (id: string, old: string, extra: Json = {}, reentry: Json = {}) => (d: ArcDescriptor): void => {
  addUnit(d, id);
  editPlan(d, (p) => Object.assign(unitJson(p, id), { reenters: { unit: old, ...reentry }, ...extra }));
};
const parkAtGate = (r: ArcRun, unit = 'u1'): void => {
  pin(r, unit);
  decide(r, unit, 'gate', 'escalate', 'park');
};
const cutChange = (unit: string): PlanChange => ({ type: 'unit-cut', unit: unitId(unit) });
const reentered = (unit: string, old: string, reset = false): readonly PlanChange[] =>
  [{ type: 'unit-added', unit: unitId(unit) }, { type: 'unit-reentered', unit: unitId(unit), reenters: unitId(old), reset }];
const CHAIN: readonly UnitSpecJson[] = [{ id: 'u1' }, { id: 'u2', after: ['u1'] }, { id: 'u3', after: ['u2'] }];
const EST = { name: 'est', probe: tool, teardown: tool, pool: { size: 2 } };
const withEst = (d: ArcDescriptor): void => editPlan(d, (p) => void p.resources.push(EST));
const resizeEst = (size: number) => (d: ArcDescriptor): void => editPlan(d, (p) => void (p.resources.find((x) => x['name'] === 'est')!['pool'] = { size }));

const M2_ROWS: readonly Row[] = [
  // cut
  { name: 'apply.cut-unstarted: a unit that never started: now', edit: cutUnits('u3'), expect: () => [cutChange('u3')] },
  { name: 'apply.cut-parked: a parked unit: now', setup: parkAtGate, edit: cutUnits('u1'), expect: () => [cutChange('u1')] },
  { name: 'apply.cut-in-task: a unit active past its dispatch: refused', setup: inFlight, edit: cutUnits('u1'), expect: [/^unit u1 is in a task \(past plan-check\); pause it, or let it park, before cutting it$/] },
  {
    name: 'apply.cut-paused: a paused unit is in no task: now',
    setup: (r) => {
      inFlight(r);
      r.journal.fact({ kind: 'paused', command: commandId('cmd-0000000000000001'), target: { type: 'unit', unit: U1 } });
    },
    edit: cutUnits('u1'),
    expect: () => [cutChange('u1')],
  },
  {
    name: 'apply.cut-merged: refused',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'snapshot', 'published', 'retire');
    },
    edit: cutUnits('u1'),
    expect: [/^unit u1 is merged; it cannot be cut$/],
  },
  {
    name: 'apply.cut-dependents: a direct dependent neither cut nor dropping its `after`: refused',
    units: CHAIN,
    edit: cutUnits('u1'),
    expect: [/^unit u2 runs after u1, which is cut: cut u2 too, or drop its `after`$/],
  },
  {
    name: 'apply.cut-dependents-resolved: the dependents cut in the same apply, or dropping the edge: now',
    units: CHAIN,
    edit: (d) => {
      cutUnits('u1', 'u2')(d);
      editPlan(d, (p) => void (unitJson(p, 'u3').after = []));
    },
    expect: () => [cutChange('u1'), cutChange('u2'), { type: 'unit-changed', unit: unitId('u3') }],
  },
  {
    name: 'apply.cut-final: a cut is never taken back',
    setup: (r) => {
      cutUnits('u3')(r.d);
      accept(r);
    },
    edit: (d) => editPlan(d, (p) => void delete unitJson(p, 'u3')['cut']),
    expect: [/^unit u3 is cut; a cut is final$/],
  },
  { name: 'apply.cut-added: a unit added cut: refused', edit: (d) => { addUnit(d, 'u4'); cutUnits('u4')(d); }, expect: [/^unit u4 is added cut/] },
  {
    name: 'apply.cut-ruling: a cut citing a ruling the ledger does not hold: refused',
    edit: (d) => editPlan(d, (p) => void (unitJson(p, 'u3')['cut'] = { reason: 'superseded by the v2 API', ruling: 'C-99' })),
    expect: [/^unit u3's cut cites ruling C-99, which the ledger .*rulings\.md does not hold$/],
  },
  // re-entry
  { name: 'apply.reenter-parked: a parked unit re-entered under a new id: now', setup: parkAtGate, edit: reenter('u4', 'u1'), expect: () => reentered('u4', 'u1') },
  {
    name: 'apply.reenter-held: a held unit: now',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'build', 'interrupted', 'hold');
    },
    edit: reenter('u4', 'u1', { scope: ['src/**'] }),
    expect: () => reentered('u4', 'u1'),
  },
  { name: 'apply.reenter-active: a unit neither parked nor held: refused', setup: inFlight, edit: reenter('u4', 'u1'), expect: [/^unit u4 re-enters u1, which is active; only a parked or held unit is re-entered$/] },
  {
    name: 'apply.reenter-merged: refused',
    setup: (r) => {
      pin(r, 'u1');
      decide(r, 'u1', 'snapshot', 'published', 'retire');
    },
    edit: reenter('u4', 'u1'),
    expect: [/^unit u4 re-enters u1, which is merged$/],
  },
  {
    name: 'apply.reenter-superseded: a second successor of one unit: refused (a lineage is a chain)',
    setup: (r) => {
      parkAtGate(r);
      reenter('u4', 'u1')(r.d);
      accept(r);
    },
    edit: reenter('u5', 'u1'),
    expect: [/^units u4, u5 each re-enter u1; a lineage is a chain: re-enter its head$/],
  },
  {
    name: 'apply.reenter-cut: a unit this apply cuts: refused',
    setup: parkAtGate,
    edit: (d) => {
      reenter('u4', 'u1')(d);
      cutUnits('u1')(d);
    },
    expect: [/^unit u4 re-enters u1, which this apply cuts$/],
  },
  {
    name: 'apply.reenter-envelope: a scope beyond the lineage\'s first pin: refused',
    setup: parkAtGate,
    edit: reenter('u4', 'u1', { scope: ['src/lib/**', 'docs/**'] }),
    expect: [/^unit u4: scope docs\/\*\* lies outside its lineage's envelope contracts\/\*\*, src\/\*\*, test\/\*\* \(u1's first pin\)$/],
  },
  { name: 'apply.reenter-risk-floor: a risk below the lineage\'s floor: refused', setup: parkAtGate, edit: reenter('u4', 'u1', { risk: 'low' }), expect: [/^unit u4: risk low is below its lineage's floor med$/] },
  {
    name: 'apply.reenter-reset: a reset needs an active ruling of the ledger',
    setup: parkAtGate,
    edit: reenter('u4', 'u1', {}, { reset: { ruling: 'C-7' } }),
    expect: [/^unit u4's reset cites ruling C-7, which the ledger .* does not hold$/],
  },
  { name: 'apply.reenter-reset-ruled: a reset backed by C-1: now', setup: parkAtGate, edit: reenter('u4', 'u1', {}, { reset: { ruling: 'C-1' } }), expect: () => reentered('u4', 'u1', true) },
  {
    name: 'apply.reenter-later: `reenters` set on a unit already planned: refused',
    setup: parkAtGate,
    edit: (d) => editPlan(d, (p) => void (unitJson(p, 'u2')['reenters'] = { unit: 'u1' })),
    expect: [/^unit u2: `reenters` is set when a unit is added, never after$/],
  },
  {
    name: 'apply.reenter-effective-cycle: `top after old` and `new after top, reenters old`: refused as a cycle',
    units: [{ id: 'u1' }, { id: 'u2', after: ['u1'] }],
    setup: parkAtGate,
    edit: reenter('u4', 'u1', { after: ['u2'] }),
    expect: [/^the unit graph has a cycle once each re-entered unit stands for its lineage's head: u2 → u4 → u2$/],
  },
  // pools and capacity
  { name: 'apply.pool-added: a pool declared: now', edit: withEst, expect: () => [{ type: 'resource', resource: resourceName('est'), edit: 'added' }] },
  { name: 'apply.pool-resize-free: every instance free: now', before: withEst, edit: resizeEst(3), expect: () => [{ type: 'resource', resource: resourceName('est'), edit: 'changed' }] },
  {
    name: 'apply.pool-resize-held: an instance held: refused',
    before: withEst,
    setup: (r) => {
      const holder: StageHolder = { type: 'stage', unit: U1, stage: 'build', attempt: 1 };
      assert.equal(reserve(r.ctx, holder, requestOf(r.ctx.plan(), [resourceName('est')], 0), { ...holder }).state, 'reserved');
    },
    edit: resizeEst(1),
    expect: [/^resource est is held \(est#1 reserved\); its declaration may not change until it is free and swept$/],
  },
  {
    name: 'apply.pool-remove-residue: an instance a residue names: refused',
    before: withEst,
    edit: (d) => editPlan(d, (p) => void p.resources.pop()),
    residues: [{ arc: arcId('other-arc'), unit: U1, inv: invocationIdOf('other-arc/4#1'), resource: poolInstance(resourceName('est'), 2) }],
    expect: [/^resource est is named by an undisposed residue/],
  },
  {
    name: 'apply.capacity-over: builds above the @cpu pool\'s size: refused (a DAG arc)',
    dag: true,
    edit: (d) => editPlan(d, (p) => void (p['capacity'] = { cpu: 3 })),
    expect: ['u1', 'u2', 'u3'].map((u) => new RegExp(`^\\{"kind":"plan-invalid","problem":\\{"lane":null,"requested":4,"resource":"@cpu","total":3,"type":"over-capacity","unit":"${u}"\\}\\}$`)),
  },
  { name: 'apply.capacity-within: now', dag: true, edit: (d) => editPlan(d, (p) => void (p['capacity'] = { cpu: 4 })), expect: () => [{ type: 'plan-field', field: 'capacity' }] },
  { name: 'apply.capacity-legacy: a legacy arc requests no @cpu: now', edit: (d) => editPlan(d, (p) => void (p['capacity'] = { cpu: 1 })), expect: () => [{ type: 'plan-field', field: 'capacity' }] },
  // G3: started units keep their relative order
  {
    name: 'apply.after-non-prefix-dispatch: a DAG arc started u2 and u3 before u1: an unrelated edit applies',
    dag: true,
    setup: (r) => {
      pin(r, 'u2');
      pin(r, 'u3');
    },
    edit: (d) => addUnit(d, 'u4'),
    expect: () => [{ type: 'unit-added', unit: unitId('u4') }],
  },
  {
    name: 'apply.after-non-prefix-order: an unstarted unit moves past started ones: now; started ones swapped: refused',
    dag: true,
    setup: (r) => {
      pin(r, 'u2');
      pin(r, 'u3');
    },
    edit: (d) => editPlan(d, (p) => void p.units.push(p.units.shift()!)),
    expect: () => [{ type: 'order' }],
  },
  {
    name: 'apply.after-non-prefix-swap: started units swapped: refused',
    dag: true,
    setup: (r) => {
      pin(r, 'u2');
      pin(r, 'u3');
    },
    edit: (d) => editPlan(d, (p) => void p.units.reverse()),
    expect: [/^the units that have started must keep their relative order \(u2, u3\)$/],
  },
];

function runRow(row: Row): void {
  test(row.name, T, () => {
    const d = setupArc({ steps: [], units: row.units ?? THREE });
    row.before?.(d);
    if (row.dag === true) dagArc(d);
    const r = contextFor(d);
    try {
      row.setup?.(r);
      row.edit(d, r);
      const v = classifyNow(r, row.residues);
      if (row.expect === 'unchanged') assert.deepEqual(v, { kind: 'unchanged' });
      else if (typeof row.expect === 'function') {
        assert.equal(v.kind, 'accepted', JSON.stringify(v));
        if (v.kind === 'accepted') assert.deepEqual(v.changes, row.expect(r));
      } else {
        assert.equal(v.kind, 'rejected', JSON.stringify(v));
        if (v.kind === 'rejected') {
          assert.equal(v.reasons.length, row.expect.length, `every reason, once: ${JSON.stringify(v.reasons)}`);
          row.expect.forEach((re, i) => assert.match(v.reasons[i]!, re));
        }
      }
    } finally {
      r.journal.close();
    }
  });
}

describe('apply.classifier-table: one row per edit class of an apply against the plan in force', () => {
  for (const row of ROWS) runRow(row);
});

describe('apply.classifier-table M2: cut, re-entry, the effective graph, pools, capacity, started order', () => {
  for (const row of M2_ROWS) runRow(row);
});

// ---------------------------------------------------------------------------------------------------
// The fold

const factsOf = (d: ArcDescriptor): readonly Fact[] => readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const applied = (d: ArcDescriptor) => factsOf(d).filter((f): f is Extract<Fact, { kind: 'plan-applied' }> => f.kind === 'plan-applied');

test('apply.fold: the plan in force is the latest plan-applied fact (none before one); its spec edits move the unit\'s spec in force, and the fold refuses what the rules refuse', T, () => {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2' }] });
  const bare = openJournal(absPath(d.runDir), arcId(d.arc));
  try {
    assert.equal(bare.view.planApplied(), null);
    assert.equal(planInForce(absPath(d.runDir), bare.view), null, 'no fact: no plan in force (a start records one; status and a dry run read the file)');
    assert.throws(() => specShaInForce(bare.view, U1), /records no plan in force/);
  } finally {
    bare.close();
  }

  const r = contextFor(d);
  try {
    const { runDir } = r.ctx;
    const view = r.journal.view;
    const baseline = requirePlanInForce(runDir, view);
    assert.equal(baseline.rev, 1);
    assert.equal(baseline.fact.command, null);
    const u1Sha = baseline.manifest.specs[U1]!;
    const u2Sha = baseline.manifest.specs[unitId('u2')]!;
    assert.deepEqual(baseline.manifest, { planSha256: fileSha256(absPath(d.planPath)), specs: { u1: fileSha256(absPath(specPath(d, 'u1'))), u2: fileSha256(absPath(specPath(d, 'u2'))) } });
    assert.ok(keptInput(runDir, baseline.manifest.planSha256, PLAN_INPUT) !== null && keptInput(runDir, u1Sha, SPEC_INPUT) !== null, 'the bytes are kept');
    assert.deepEqual(view.plannedUnits(), ['u1', 'u2']);

    // An unapplied edit changes nothing in force: the stages load the kept spec.
    editSpec(d, 'u1', addClause);
    assert.equal(specShaInForce(view, U1), u1Sha);
    assert.equal(loadUnitSpec(r.ctx, r.unit('u1')).spec.acceptance.length, 1, 'the spec in force, not the live file');
    editSpec(d, 'u1', (s) => void (s['acceptance'] = (s['acceptance'] as Json[]).slice(0, 1)));

    // The fold refuses a revision out of order, and a spec edit the unit's state does not allow.
    const next = { kind: 'plan-applied', command: null, ...baseline.manifest, changes: [] } as const;
    assert.throws(() => r.journal.fact({ ...next, rev: planRev(3) }), (e: unknown) => e instanceof FoldInvariantError && /the next plan revision is 2/.test(e.message));
    const evidence = (sha: string): PlanChange => ({ type: 'spec', unit: U1, edit: 'evidence', specRev: specRev(1), specSha256: sha as never });
    assert.throws(() => r.journal.fact({ ...next, rev: planRev(2), changes: [evidence(u1Sha)] }), /never dispatched/);

    // Dispatched: an evidence-only edit is the spec in force at once, and a re-pin (a routing change) keeps it.
    pin(r, 'u1');
    // A fact refused for one edit applies none of the others: the fold is as it was.
    const other = 'f'.repeat(64);
    const u2Evidence: PlanChange = { type: 'spec', unit: unitId('u2'), edit: 'evidence', specRev: specRev(1), specSha256: u2Sha };
    assert.throws(() => r.journal.fact({ ...next, rev: planRev(2), specs: { u1: other, u2: u2Sha } as never, changes: [evidence(other), u2Evidence] }), /u2, which was never dispatched/);
    assert.deepEqual(view.unit(U1).spec, { rev: 1, sha256: u1Sha });
    assert.equal(view.planApplied()?.rev, 1);
    editSpec(d, 'u1', evidenceGlobs);
    accept(r);
    const evidenceSha = fileSha256(absPath(specPath(d, 'u1')));
    assert.deepEqual(view.unit(U1).spec, { rev: 1, sha256: evidenceSha });
    assert.equal(loadUnitSpec(r.ctx, r.unit('u1')).spec.lanes[0]!.evidenceGlobs[0], 'out/**');
    const moved = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: { gate: { med: 'summit' } } as never, unit: null });
    assert.ok(repin(r.journal, moved, view.dispatchOf(U1)!) !== null);
    assert.deepEqual(view.unit(U1).spec, { rev: 1, sha256: evidenceSha }, 'a re-pin keeps the spec in force');

    // A revision is pending until the unit re-opens on it; the driver re-opens only at a boundary that allows it.
    decide(r, 'u1', 'plan-check', 'approve', 'advance');
    decide(r, 'u1', 'build', 'success', 'advance');
    revise(d);
    accept(r);
    const revision = fileSha256(absPath(specPath(d, 'u1')));
    assert.deepEqual(view.unit(U1).pendingRevision, { rev: 2, sha256: revision, command: null });
    assert.deepEqual(view.unit(U1).spec, { rev: 1, sha256: evidenceSha }, 'pending, not in force');
    assert.equal(reentryAllowed(view.unit(U1)), false, 'after a build, inside the build → teardown chain');
    for (const [stage, outcome] of [['quiesce', 'empty'], ['evidence', 'captured'], ['salvage', 'committed'], ['teardown', 'released']] as const) {
      decide(r, 'u1', stage, outcome, 'advance');
    }
    assert.equal(reentryAllowed(view.unit(U1)), true, 'before lanes the worktree is clean');
    r.journal.fact({ kind: 'reopened', unit: U1, command: null, specRev: specRev(2), specSha256: revision as never });
    const u = view.unit(U1);
    assert.deepEqual([u.status, u.stage, u.decided, u.spec, u.pendingRevision, u.reopened], ['active', 'plan-check', null, { rev: 2, sha256: revision }, null, { command: null, specRev: 2 }]);
    assert.equal(applied(d).length, 3);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// The command: rejections, then an accepted apply

async function command(r: ArcRun, body: CommandBody): Promise<Readonly<{ id: string; outcome: CommandOutcome }>> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r), file) };
}

test('apply.stale-after-evidence-revision: an architect\'s revision written while the build ran, applied after its evidence stage appended the implementer\'s decisions (the executor\'s rev 2), is refused naming that revision; re-applied on top of it, it is pending', T, async () => {
  const d = setupArc({ steps: [], units: [{ id: 'u1' }] });
  const r = contextFor(d);
  try {
    inFlight(r);
    const onRev1 = readFileSync(specPath(d, 'u1'), 'utf8');
    // The build's evidence stage appends the implementer's decisions: the executor's revision, rev 2.
    const { path, spec, sha256 } = loadUnitSpec(r.ctx, r.unit('u1'));
    const attempt = r.journal.view.unit(U1).counters.attempts + 1;
    await runOp(r.journal, specPatchOp(r.ctx.runDir), 'spec:u1', { type: 'stage', unit: U1, stage: 'evidence', attempt }, {
      path, oldSha256: sha256,
      patch: { expectRev: spec.rev, by: { role: 'executor', inv: invocationIdOf(`${d.arc}/9#1`) }, ops: [{ op: 'add', section: 'decisions', item: { id: clauseId('D1'), text: 'mul is exported from src/mul.js' } }] },
    });
    r.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'evidence', attempt, outcome: 'captured', class: 'advance', chargeable: false } as Fact);
    const recorded = r.journal.view.unit(U1).spec;
    assert.equal(recorded?.rev, 2, 'the machine revision is the unit\'s spec in force');

    // The architect wrote rev 2 on rev 1 while the build ran; applied now, it is stale.
    writeFileSync(specPath(d, 'u1'), onRev1);
    revise(d);
    const kept = join(r.ctx.runDir, 'inputs', `${recorded!.sha256}.${SPEC_INPUT}`);
    assert.deepEqual(classifyNow(r), {
      kind: 'rejected',
      reasons: [
        `unit u1: its spec ${specPath(d, 'u1')} is at rev 2, but the unit's spec is now rev 2, a revision the executor wrote from the build's evidence `
        + `(the implementer's recorded decisions, appended at evidence attempt ${attempt}) before your edit was applied; `
        + `re-apply your edit on top of rev 2 (kept at ${kept}) and set rev 3`,
      ],
    });

    // Re-applied on top of rev 2, as the refusal says: a pending revision.
    writeFileSync(specPath(d, 'u1'), readFileSync(kept));
    editSpec(d, 'u1', (s) => {
      addClause(s);
      s['rev'] = 3;
    });
    const v = classifyNow(r);
    assert.equal(v.kind, 'accepted', JSON.stringify(v));
    if (v.kind === 'accepted') assert.deepEqual(v.changes, [specChange(d, 'u1', 'revision', 3)]);
  } finally {
    r.journal.close();
  }
});

test('apply.rejections: a stale expectRev, files changed since they were hashed, and a startup row over the changed units each reject the whole apply; then it applies, and a re-run is a no-op', T, async () => {
  const d = setupArc({ steps: [] });
  const r = contextFor(d);
  try {
    addUnit(d, 'u2');
    const stale = await command(r, applyBody(d, planRev(2)));
    assert.deepEqual(stale.outcome, { kind: 'rejected', reason: 'apply rejected (1 reason): (1) stale: --expect-rev 2, but the plan in force is rev 1' });

    const hashed = applyBody(d, planRev(1));
    editSpec(d, 'u2', addClause);
    const changed = await command(r, hashed);
    assert.deepEqual(changed.outcome, {
      kind: 'rejected', reason: `apply rejected (1 reason): (1) the files changed since \`roadmap apply\` hashed them: ${specPath(d, 'u2')}; run it again`,
    });

    editSpec(d, 'u2', (s) => void (s['lanes'] = (s['lanes'] as Json[]).map((l) => ({ ...l, argv: ['no-such-lane-tool'] }))));
    const row = await command(r, applyBody(d));
    assert.equal(row.outcome.kind, 'rejected');
    assert.match(row.outcome.kind === 'rejected' ? row.outcome.reason : '', /"kind":"spec-lane-unrunnable".*"argv0":"no-such-lane-tool".*"unit":"u2"/);
    assert.equal(applied(d).length, 1, 'nothing rejected is in force');
    assert.equal(readReceipt(r.ctx.runDir, row.id as never, 'rejected')?.state, 'rejected');

    editSpec(d, 'u2', (s) => void (s['lanes'] = JSON.parse(readFileSync(specPath(d, 'u1'), 'utf8')).lanes));
    const ok = await command(r, applyBody(d, planRev(1)));
    assert.equal(ok.outcome.kind, 'applied');
    const receipt = readReceipt(r.ctx.runDir, ok.id as never, 'applied');
    assert.ok(receipt?.state === 'applied');
    assert.deepEqual(receipt.verified, ['plan rev 2 in force', '{"type":"unit-added","unit":"u2"}']);
    const facts = applied(d);
    assert.deepEqual(facts.map((f) => [f.rev, f.command]), [[1, null], [2, ok.id]]);
    assert.equal(requirePlanInForce(r.ctx.runDir, r.journal.view).plan.units.length, 2);
    assert.deepEqual((await command(r, applyBody(d))).outcome.kind, 'applied', 'the files are the plan in force: nothing to apply');
    assert.equal(applied(d).length, 2, 'an unchanged apply writes no fact');
  } finally {
    r.journal.close();
  }
});

test('apply.smoke-new-backend: a routing apply that seats a backend the plan in force did not smokes it first; a failed smoke rejects it', T, async () => {
  const OK = { ok: true } as const;
  const d = setupArc({
    steps: [
      { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'exit', code: 1 }] },
      { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'emit', value: OK }] },
    ],
  });
  // In force: every build seat on the frontier class (Claude), so no seat runs on Codex.
  const allClaude = { build: { low: 'frontier', med: 'frontier' } };
  editPlan(d, (p) => void (p['routing'] = allClaude));
  const r = contextFor(d);
  try {
    editPlan(d, (p) => void delete p['routing']);
    const failed = await command(r, applyBody(d));
    assert.equal(failed.outcome.kind, 'rejected');
    assert.match(failed.outcome.kind === 'rejected' ? failed.outcome.reason : '', /"backend":"codex".*"kind":"backend-smoke"/);
    const ok = await command(r, applyBody(d));
    assert.equal(ok.outcome.kind, 'applied');
    const smokes = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'smoke');
    assert.deepEqual(smokes.map((i) => i.expect.subject.purpose === 'smoke' ? i.expect.subject.check : null), ['backend-codex', 'backend-codex'], 'Codex alone, once per apply');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
    const last = applied(d).at(-1);
    assert.deepEqual(last?.changes.map((c) => c.type), ['routing']);
  } finally {
    r.journal.close();
  }
});

test('apply.revalidate-after-smoke: the log moving while the smoke runs is caught by the classification run again just before the commit; nothing is applied', T, async () => {
  const d = setupArc({
    steps: [{ as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'barrier', name: 'smoke', timeoutMs: 30_000 }, { type: 'emit', value: { ok: true } }] }],
    units: [{ id: 'u1' }, { id: 'u2' }],
  });
  editPlan(d, (p) => void (p['routing'] = { build: { low: 'frontier', med: 'frontier' } }));
  const r = contextFor(d);
  try {
    // Seats Codex again (smoked first) and edits u2's spec while u2 is undispatched.
    pin(r, 'u1');
    editPlan(d, (p) => void delete p['routing']);
    editSpec(d, 'u2', addClause);
    const pending = command(r, applyBody(d));
    await reached(d.scenarioDir, 'smoke', 30_000);
    // Meanwhile u2 is dispatched on its spec in force: the same edit is now a same-rev edit of a dispatched spec.
    pin(r, 'u2');
    release(d.scenarioDir, 'smoke');
    const { outcome } = await pending;
    assert.equal(outcome.kind, 'rejected');
    assert.match(outcome.kind === 'rejected' ? outcome.reason : '', /^apply rejected \(1 reason\): \(1\) unit u2: its spec .*u2\.json changed but is still at rev 1; a revision sets rev 2/);
    assert.equal(applied(d).length, 1, 'nothing applied');
    assert.equal(r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'smoke').length, 1, 'the smoke ran, and passed');
  } finally {
    r.journal.close();
  }
});

test('cmd.scope: each mutation\'s scope (A12); an apply\'s follows from its classification of the files as they are', T, async () => {
  const d = setupArc({ steps: [], units: THREE });
  const r = contextFor(d);
  try {
    const scope = commandScope({ runDir: r.ctx.runDir, hostDir: r.ctx.hostDir, planFile: absPath(d.planPath), routingBase });
    const of = (body: CommandBody) => scope(body as Parameters<typeof scope>[0], r.journal.view, r.ctx.plan());
    assert.deepEqual(of({ type: 'resume', target: { type: 'all' } }), { type: 'arc' });
    assert.deepEqual(of({ type: 'resume', target: { type: 'unit', unit: unitId('u2') } }), { type: 'units', units: ['u2'] });
    assert.deepEqual(of({ type: 'resume', target: { type: 'backend', backend: 'codex' } }), { type: 'none' });
    assert.deepEqual(of({ type: 'sweep', resource: null }), { type: 'none' });
    assert.deepEqual(of({ type: 'resolve-edge', edge: edgeId('e1'), evidence: 'met' }), { type: 'none' });
    assert.deepEqual(of({ type: 'run-only', units: [U1] }), { type: 'none' });

    assert.deepEqual(of(applyBody(d)), { type: 'none' }, 'nothing to apply');
    editSpec(d, 'u2', addClause);
    addUnit(d, 'u4');
    assert.deepEqual(of(applyBody(d)), { type: 'units', units: ['u2', 'u4'] }, 'spec and unit edits: those units');
    const hashed = applyBody(d);
    editPlan(d, (p) => void p.units.splice(1, 2, p.units[2]!, p.units[1]!));
    assert.deepEqual(of(hashed), { type: 'arc' }, 'the files moved past the manifest: the whole arc');
    assert.deepEqual(of(applyBody(d)), { type: 'units', units: ['u2', 'u3', 'u4'] }, 'an order change: the units it moved');
    editPlan(d, (p) => void (p['direction'] = 'Smaller still.'));
    assert.deepEqual(of(applyBody(d)), { type: 'arc' }, 'a plan-wide field: the arc');
    editPlan(d, (p) => {
      p['direction'] = 'Keep it small.';
      p.resources.push(DB);
    });
    assert.deepEqual(of(applyBody(d)), { type: 'arc' }, 'a resource edit: the arc');
    editPlan(d, (p) => void (p['integrationBranch'] = 'other'));
    assert.deepEqual(of(applyBody(d)), { type: 'none' }, 'rejected: it touches nothing');
  } finally {
    r.journal.close();
  }
});

test('apply.upgrade-queued-resume: a `resume <unit>` queued under 1.0.0-dev.3 after a rev + 1 edit of a parked unit re-opens it once the first start records the edit as a pending revision', T, async () => {
  const d = setupArc({ steps: [] });
  const runDir = absPath(d.runDir);
  // The log 1.0.0-dev.3 leaves: u1 dispatched on its spec file and parked at its gate; no plan revision.
  const old = openJournal(runDir, arcId(d.arc));
  old.fact({
    kind: 'dispatch',
    record: {
      unit: U1, specRev: specRev(1), specSha256: fileSha256(absPath(specPath(d, 'u1'))), scope: [repoPattern('src/**')], riskFloor: 'med',
      routingRev: routingRev('0123456789abcdef'), implementerSeatRev: seatRev('fedcba9876543210'), at: isoTimeOf(new Date()),
    },
  });
  old.fact({ kind: 'stage-outcome', unit: U1, stage: 'gate', attempt: 1, outcome: 'escalate', class: 'park', chargeable: false });
  old.close();
  revise(d);
  const revision = fileSha256(absPath(specPath(d, 'u1')));
  const file = submitCommand(runDir, arcId(d.arc), { type: 'resume', target: { type: 'unit', unit: U1 } });

  // HEAD's first start (settlePlan): revision 1 as that release ran the files.
  const first = openJournal(runDir, arcId(d.arc));
  const files = readInputFiles(absPath(d.planPath));
  const baseline = earlierReleaseBaseline(first.view, files, d.planPath);
  assert.ok('changes' in baseline, JSON.stringify(baseline));
  recordPlan(first, runDir, files, baseline.changes, routingBase);
  first.close();

  const r = contextFor(d);
  try {
    assert.deepEqual(r.journal.view.unit(U1).pendingRevision, { rev: 2, sha256: revision, command: null });
    assert.equal((await applyCommand(commandContextFor(r), file)).kind, 'applied');
    const receipt = readReceipt(r.ctx.runDir, file.id, 'applied');
    assert.deepEqual(receipt?.state === 'applied' ? receipt.verified : receipt, ['unit u1 re-opened at plan-check on spec rev 2']);
    const u = r.journal.view.unit(U1);
    assert.deepEqual([u.status, u.stage, u.spec, u.reopened], ['active', 'plan-check', { rev: 2, sha256: revision }, { command: file.id, specRev: 2 }]);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Crash cells

describe(`matrix row ${PLAN_APPLY}`, () => {
  const cells = crashCells(PLAN_APPLY);

  test('lists the apply\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), [
      'B2 command.apply.before-effect', 'B3 plan.apply.after-inputs', 'B4 command.apply.after-effect', 'B4 command.apply.after-receipt',
    ]);
  });

  for (const cell of cells) {
    test(`apply.crash-cells ${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const d = setupArc({ steps: [] });
      const setup = contextFor(d);
      addUnit(d, 'u2');
      const file = submitCommand(setup.ctx.runDir, setup.ctx.plan().arc, applyBody(d, planRev(1)));
      assert.equal(pollCommands(setup.ctx.runDir, setup.ctx.plan().arc).length, 1);
      setup.journal.close();

      const trigger = writeTrigger(tmpDir('apply-crash'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('apply-child.ts', [JSON.stringify(d), file.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 30_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stderr ${exit.stderr}`);
      assertFired(trigger);

      const r = contextFor(d);
      try {
        const open = r.journal.view.openIntents().filter((i) => i.kind === 'command.apply');
        assert.equal(open.length, 1, 'the op is open');
        const intent = open[0] as IntentOf<'command.apply'>;
        const ctx = commandContextFor(r);
        const disposition = await commandReconciler(ctx)(intent, r.journal.view);
        assert.ok(disposition.kind === 'done' && disposition.outcome.kind === 'applied', JSON.stringify(disposition));
        r.journal.done(intent.op, 'command.apply', disposition.outcome, 'reconciled');
        assert.equal(readReceipt(ctx.runDir, file.id, 'applied')?.state, 'applied');
        assert.deepEqual(pollCommands(ctx.runDir, r.journal.view.arc), []);
        const facts = applied(d);
        assert.deepEqual(facts.map((f) => [f.rev, f.command]), [[1, null], [2, file.id]], 'exactly one fact for the apply');
        assert.deepEqual(requirePlanInForce(ctx.runDir, r.journal.view).plan.units.map((u) => u.id), ['u1', 'u2']);
      } finally {
        r.journal.close();
      }
    });
  }

  test('apply.recovered-after-start: an apply cut short before its fact, whose files a start then put in force, is receipted applied (already in force), not stale', T, async () => {
    const d = setupArc({ steps: [] });
    const setup = contextFor(d);
    addUnit(d, 'u2');
    const file = submitCommand(setup.ctx.runDir, setup.ctx.plan().arc, applyBody(d, planRev(1)));
    setup.journal.close();
    const trigger = writeTrigger(tmpDir('apply-crash'), { label: 'plan.apply.after-inputs', occurrence: 1 });
    const exit = await runFixture('apply-child.ts', [JSON.stringify(d), file.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 30_000 });
    assert.equal(exit.signal, 'SIGKILL', exit.stderr);
    assertFired(trigger);

    const r = contextFor(d);
    try {
      // A manual start reads the same files: its classification puts them in force as rev 2 (no command).
      accept(r);
      const intent = r.journal.view.openIntents().find((i) => i.kind === 'command.apply') as IntentOf<'command.apply'>;
      const ctx = commandContextFor(r);
      const disposition = await commandReconciler(ctx)(intent, r.journal.view);
      assert.ok(disposition.kind === 'done' && disposition.outcome.kind === 'applied', JSON.stringify(disposition));
      r.journal.done(intent.op, 'command.apply', disposition.outcome, 'reconciled');
      const receipt = readReceipt(ctx.runDir, file.id, 'applied');
      assert.deepEqual(receipt?.state === 'applied' ? receipt.verified : receipt, ['the files are the plan in force already (rev 2): nothing to apply']);
      assert.deepEqual(applied(d).map((f) => [f.rev, f.command]), [[1, null], [2, null]], 'no second fact');
    } finally {
      r.journal.close();
    }
  });
});
