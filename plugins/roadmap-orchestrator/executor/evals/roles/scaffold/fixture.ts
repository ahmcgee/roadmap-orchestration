// One scaffold trial's arc: the corpus arc of the scaffold tests (test/fixtures/corpus-unit.ts `setupCorpusArc`, role set
// `dev17`, so the scaffold role is in force) shaped to the cell. Its u1 spec carries the cell's acceptance and scope; the
// obligations gain the arc lane `load`, `node --test <the cell's glob>` under the node-test reporter (the shipped witness
// reporter, as a real arc's lane), which the scaffold's dry run runs for real; the plan-check (fake) decides `scaffold` with
// the cell's decision and a design record naming the same new system. The answer key only the eval run dir holds.
import { join } from 'node:path';
import type { JsonValue } from '../../../src/core/json.ts';
import type { RepoConfig } from '../../../src/routing/layers.ts';
import type { RiskTier } from '../../../src/routing/types.ts';
import { setupCorpusArc } from '../../../test/fixtures/corpus-unit.ts';
import { editJson, editPlan, specPathOf } from '../../../test/fixtures/route-common.ts';
import { planCheckStep } from '../../../test/fixtures/stage-common.ts';
import { type ArcDescriptor, laneJson } from '../../../test/fixtures/unit-common.ts';
import type { Step } from '../../../test/helpers/scenario.ts';
import type { ScaffoldCell } from './cells.ts';

/** The arc lane the load test runs in. */
export const LOAD_LANE = 'load';
/** The scaffold seat a trial runs on: the plan-check's risk (the fake answers `med`), the unit's risk floor. */
export const SCAFFOLD_TIER: RiskTier = 'med';

export const decisionOf = (c: ScaffoldCell): JsonValue => ({
  newSystem: { ...c.newSystem, paths: [...c.newSystem.paths], tests: [...c.newSystem.tests] }, entryPoints: [...c.entryPoints], exports: [...c.exports],
  loadTest: { lane: LOAD_LANE, testId: c.testId }, manifest: c.manifest.map((m) => ({ ...m })),
});

const designOf = (c: ScaffoldCell): JsonValue => ({
  kind: 'module', changes: [{ system: null, paths: [...c.newSystem.paths], lines: 30 }], interfaces: [], failureModes: [], breaks: { tests: [], docs: [] }, experiments: [],
  newSystem: { ...c.newSystem, paths: [...c.newSystem.paths], tests: [...c.newSystem.tests] }, verification: null,
});

const laneOf = (c: ScaffoldCell, id: string): Record<string, unknown> => laneJson({ id, argv: ['node', '--test', c.loadGlob] });

/** The trial's arc: the plan-check's scaffold decision, then `writer` (the scaffold calls); nothing recorded yet. */
export async function setupScaffoldArc(c: ScaffoldCell, writer: readonly Step[], config: RepoConfig | null): Promise<ArcDescriptor> {
  const a = await setupCorpusArc([planCheckStep({ decision: 'scaffold', design: designOf(c), scaffold: decisionOf(c) }), ...writer]);
  const d: ArcDescriptor = { ...a.d, arcRoles: 'dev17', ...(config === null ? {} : { config }) };
  editJson(specPathOf(d, 'u1'), (s) => {
    s['acceptance'] = c.acceptance.map((clause, i) => ({ id: `A${i + 1}`, clause, failLoudIfUndelivered: true, state: 'active' }));
    s['scope'] = [...c.scope];
    s['lanes'] = [{ ...laneOf(c, 'unit'), state: 'active' }];
  });
  editPlan(d, (p) => {
    p.units[0]!['scope'] = [...c.scope];
  });
  editJson(join(a.planDir, 'obligations.json'), (o) => {
    (o['lanes'] as unknown[]).push({ ...laneOf(c, LOAD_LANE), reporter: 'node-test', testPaths: [...c.newSystem.tests] });
  });
  return d;
}

export type ScaffoldKey = Readonly<{ cell: string; family: string; expected: 'scaffolded'; trial: number; sha: string }>;

export const keyOf = (c: ScaffoldCell, trial: number, sha: string): ScaffoldKey => ({ cell: c.id, family: c.family, expected: 'scaffolded', trial, sha });
