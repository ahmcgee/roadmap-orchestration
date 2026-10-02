// Shared by the held-claims tests (test/brake.test.ts, test/baseline.test.ts, test/batch.test.ts) and their crash
// children: a unit-common arc made holistic (a vision, an obligations file whose arc lanes are the fake witness lanes of
// test/helpers/witness.ts, scripted per tree through one control file), recorded as revision 1 as an M3 start does.
// The candidate tree a unit's candidate will test is known once its gate approved (`candidateTree`), so a test scripts
// the outcomes the lanes report on it before the candidate runs (`scriptTree`).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unitId } from '../../src/core/ids.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { unitBranch } from '../../src/pipeline/dispatch.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { type TreePlan, witnessLaneArgv, writeWitnessControl } from '../helpers/witness.ts';
import { publishArc } from './publish-common.ts';
import type { LaneJson } from './stage-common.ts';
import { type ArcDescriptor, type UnitSpecJson } from './unit-common.ts';

type Json = Record<string, unknown>;

export const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Arithmetic helpers anyone can trust.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'world', text: 'A developer calls add or mul and gets the exact answer, every time.', rank: null, state: 'active' },
  ],
  questions: [],
} as const;
/** The plan's `holistic.advances` for VISION: the whole vision. */
export const ADVANCES = ['V-1', 'V-2'] as const;

/** One obligation of the arc: witnessed on `lane` (default `journey`) by `testIds`. */
export type ObligationJson = Readonly<{
  id: string;
  activation?: 'must-hold' | 'future';
  testIds: readonly string[];
  lane?: string;
  deliveredBy?: readonly string[];
  /** A split parent (`{type: 'split', children}`) has no witness: its `testIds` are ignored. */
  state?: Json;
  /** A split child's parent. */
  parent?: string;
}>;

export type HolisticOptions = Readonly<{
  steps: readonly Step[];
  units?: readonly (UnitSpecJson & Readonly<{ obligations?: readonly string[]; repairs?: readonly string[]; origin?: 'repair' }>)[];
  suite?: readonly LaneJson[];
  obligations: readonly ObligationJson[];
  mapping: readonly Readonly<{ pattern: string; obligations: readonly string[] }>[];
  /** Arc lane ids (all jsonl fake witness lanes over the one control file); default `['journey']`. */
  lanes?: readonly string[];
  /** Arc lanes' extra fields by id (resources, tier). */
  laneExtra?: Readonly<Record<string, Json>>;
  /** The control file's scripts: tree id (or `*`) → outcomes. */
  trees: Readonly<Record<string, TreePlan>>;
  /** Plan fields added verbatim (resources). */
  planExtra?: Json;
  /** Runs on the laid-out arc before revision 1 is recorded (M3 B3: a finding a repair unit's spec names must exist first). */
  beforeStart?: (d: ArcDescriptor) => void;
}>;

export type HolisticArc = Readonly<{ d: ArcDescriptor; control: string }>;

/** An arc lane over the control file, as the obligations file holds it. */
function arcLane(id: string, control: string, extra: Json = {}): Json {
  return {
    id, argv: witnessLaneArgv('jsonl', tmpDir(`witness-lane-${id}`), control), cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast',
    resources: [], evidenceGlobs: [], reporter: 'jsonl', ...extra,
  };
}

/** The obligations file of `opts` over `control` (JSON). */
export function obligationsJson(opts: Pick<HolisticOptions, 'obligations' | 'mapping' | 'lanes' | 'laneExtra'>, control: string): Json {
  const lanes = (opts.lanes ?? ['journey']).map((id) => arcLane(id, control, opts.laneExtra?.[id]));
  const revs = new Map(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes, obligations: [], mapping: { paths: [] } }).lanes.map((l) => [l.id, laneRevOf(l)]));
  return {
    schema: 'roadmap/obligations-m3', cutLine: 'the helpers ship', lanes,
    mapping: { paths: opts.mapping.map((m) => ({ pattern: m.pattern, obligations: [...m.obligations].sort() })) },
    obligations: opts.obligations.map((o) => {
      const lane = o.lane ?? 'journey';
      const activation = o.activation ?? 'must-hold';
      const split = o.state?.['type'] === 'split';
      return {
        id: o.id, rev: 1, statement: `${o.id} holds.`, docRef: { path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module' }, serves: ['V-1'],
        witness: split ? null : { lane, testIds: [...o.testIds] },
        proofJudgment: split ? null : { verdict: 'proves', obligationRev: 1, laneRev: revs.get(lane as never), witness: { lane, testIds: [...o.testIds] } },
        deliveredBy: activation === 'future' ? [...(o.deliveredBy ?? [])] : [], activation, contracts: [], state: o.state ?? { type: 'active' },
        ...(o.parent === undefined ? {} : { parent: o.parent }),
      };
    }),
  };
}

/** Lays out the arc, holistic, and records revision 1 (publishArc). */
export function holisticArc(opts: HolisticOptions): HolisticArc {
  const control = join(tmpDir('witness-control'), 'control.json');
  writeWitnessControl(control, { trees: opts.trees });
  const d = publishArc({ steps: opts.steps, ...(opts.units === undefined ? {} : { units: opts.units }), ...(opts.suite === undefined ? {} : { suite: opts.suite }) }, (x) => {
    const planDir = join(x.planPath, '..');
    writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION));
    writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(obligationsJson(opts, control)));
    const plan = JSON.parse(readFileSync(x.planPath, 'utf8')) as Json & { units: Json[] };
    const units = plan.units.map((u) => {
      const o = opts.units?.find((s) => s.id === u['id']);
      return o?.origin === undefined ? u : { ...u, origin: o.origin };
    });
    writeFileSync(x.planPath, JSON.stringify({ ...plan, ...opts.planExtra, units, holistic: { vision: 'vision.json', advances: ADVANCES, obligations: 'obligations.json' } }));
    for (const u of opts.units ?? [{ id: 'u1' }]) {
      const extra = u as Readonly<{ obligations?: readonly string[]; repairs?: readonly string[] }>;
      if (extra.obligations === undefined && extra.repairs === undefined) continue;
      const spec = join(planDir, `${u.id}.json`);
      writeFileSync(spec, JSON.stringify({
        ...(JSON.parse(readFileSync(spec, 'utf8')) as Json),
        ...(extra.obligations === undefined ? {} : { obligations: extra.obligations }), ...(extra.repairs === undefined ? {} : { repairs: extra.repairs }),
      }));
    }
    opts.beforeStart?.(x);
  });
  return { d, control };
}

/** The tree a unit's candidate will test: the merge of its branch onto the integration tip (as `candidate.merge` makes it). */
export function candidateTree(d: ArcDescriptor, unit: string): string {
  const branch = unitBranch(d.arc as never, unitId(unit));
  return git(d.repo, 'merge-tree', '--write-tree', 'main', branch).split('\n')[0]!;
}

/** The integration tip's tree. */
export const tipTree = (d: ArcDescriptor): string => git(d.repo, 'rev-parse', 'main^{tree}');
