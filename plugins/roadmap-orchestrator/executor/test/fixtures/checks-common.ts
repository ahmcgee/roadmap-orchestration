// The executable checks before the gate (M4a rev 3, D1 witness presence, D2 mutation smoke, E plan-check shape) over
// corpus-unit's arc: u1 adds `mul` in a corpus arc whose one obligation I-1 (at T-1) is witnessed on the fake `journey`
// lane, scripted per tree through the arc's control file (`scriptTree`). Options shape I-1 (activation, deliverers, test
// ids), what u1's spec declares (I-1, witness items), the journey lane (testPaths, a wrapper argv), u1's risk and the
// plan (more units, known defects, the plan-check shape).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StageOutcomeFact } from '../../src/core/events.ts';
import { arcId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import type { RiskTier } from '../../src/routing/types.ts';
import { commitAll, writeFiles } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import type { TreePlan } from '../helpers/witness.ts';
import { type CorpusUnitArc, setupCorpusArc } from './corpus-unit.ts';
import { editJson, editPlan, specPathOf } from './route-common.ts';

type Json = Record<string, unknown>;

/** A spec witness item on the journey lane. */
export type WitnessItemJson = Readonly<{ id: string; testId: string; clause?: string; state?: 'active' | 'struck' }>;

export type ChecksOptions = Readonly<{
  steps: readonly Step[];
  /** u1's plan risk (default med). */
  risk?: RiskTier;
  /** I-1: its activation (default must-hold), deliverers (a future one's) and test ids (default `t1`). */
  activation?: 'must-hold' | 'future';
  deliveredBy?: readonly string[];
  testIds?: readonly string[];
  /** Whether u1's spec declares I-1 (default true). */
  declares?: boolean;
  /** u1's spec witness items (default none). */
  witnesses?: readonly WitnessItemJson[];
  /** The journey lane's `testPaths` (default none); its argv, given the jsonl wrapper (default the wrapper). */
  testPaths?: readonly string[] | undefined;
  argv?: (wrapper: string) => readonly string[];
  /** u1's spec lane `mul` runs this argv instead (a colocated test file). */
  specLane?: readonly string[];
  /** Files committed on the integration tip before anything runs (what the unit then leaves alone). */
  tipFiles?: Readonly<Record<string, string>>;
  /** The control file's scripts (default `*`: every test id passes). */
  trees?: Readonly<Record<string, TreePlan>>;
  /** More units, each a copy of u1's spec with its own id (the plan gains them after u1). */
  more?: readonly string[];
  /** Edits of the plan JSON (known defects, the plan-check shape), after everything else. */
  plan?: (p: Json & { units: Json[] }) => void;
}>;

export type ChecksArc = CorpusUnitArc & Readonly<{ control: string; wrapper: string }>;

/** Lays out the corpus arc with the checks' options; nothing recorded yet (`contextFor` records revision 1). */
export async function checksArc(opts: ChecksOptions): Promise<ChecksArc> {
  const a = await setupCorpusArc(opts.steps);
  const { d, planDir } = a;
  const control = join(planDir, 'witness-control.json');
  const testIds = opts.testIds ?? ['t1'];
  const all: Record<string, 'pass'> = Object.fromEntries([...testIds, ...(opts.witnesses ?? []).map((w) => w.testId)].map((t) => [t, 'pass'] as const));
  writeFileSync(control, `${JSON.stringify({ trees: opts.trees ?? { '*': { outcomes: all } } }, null, 2)}\n`);
  const wrapper = join(planDir, 'jsonl-lane.sh');
  editJson(join(planDir, 'obligations.json'), (o) => {
    const lanes = o['lanes'] as Json[];
    const lane: Json = { ...lanes[0]!, argv: opts.argv?.(wrapper) ?? lanes[0]!['argv'], ...(opts.testPaths === undefined ? {} : { testPaths: opts.testPaths }) };
    o['lanes'] = [lane];
    const laneRev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [lane], obligations: [], mapping: { paths: [] } }).lanes[0]!);
    const [i1] = o['obligations'] as Json[];
    const witness = { lane: 'journey', testIds: [...testIds].sort() };
    o['obligations'] = [{
      ...i1, activation: opts.activation ?? 'must-hold', deliveredBy: [...(opts.deliveredBy ?? [])], witness,
      proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness },
    }];
  });
  editJson(specPathOf(d, 'u1'), (s) => {
    if (opts.declares ?? true) s['obligations'] = ['I-1'];
    if (opts.specLane !== undefined) s['lanes'] = (s['lanes'] as Json[]).map((l) => (l['id'] === 'mul' ? { ...l, argv: opts.specLane } : l));
    if (opts.witnesses !== undefined) {
      s['witnesses'] = opts.witnesses.map((w) => ({ id: w.id, lane: 'journey', testId: w.testId, clause: w.clause ?? 'A1', skeleton: `test('${w.testId}')`, state: w.state ?? 'active' }));
    }
  });
  for (const id of opts.more ?? []) {
    const spec = JSON.parse(readFileSync(specPathOf(d, 'u1'), 'utf8')) as Json;
    writeFileSync(specPathOf(d, id), JSON.stringify({ ...spec, unit: id, obligations: [], witnesses: undefined }));
  }
  editPlan(d, (p) => {
    const u1 = p.units[0]!;
    if (opts.risk !== undefined) u1['risk'] = opts.risk;
    for (const id of opts.more ?? []) p.units.push({ ...u1, id, spec: `${id}.json`, risk: 'med' });
    opts.plan?.(p);
  });
  if (opts.tipFiles !== undefined) {
    writeFiles(d.repo, opts.tipFiles);
    commitAll(d.repo, 'the tip before the unit');
  }
  return { ...a, control, wrapper };
}

/** The stage-outcome facts of `unit`, in log order. */
export function outcomeFacts(d: CorpusUnitArc['d'], unit = 'u1'): readonly StageOutcomeFact[] {
  return readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit ? [e.fact] : []));
}
