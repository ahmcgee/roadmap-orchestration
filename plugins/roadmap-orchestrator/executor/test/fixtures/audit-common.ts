// Shared by the audit tests (test/audit.test.ts) and their crash child (audit-child.ts): a holistic arc (brake-common's
// vision and fake witness lanes) whose plan sets `holistic.audit` (the cadence N, the required lens set L), the audit
// context over the run's one arbiter, the scenario steps that take a unit to its merge, and log readers.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '../../src/core/events.ts';
import { readJournal } from '../../src/core/log.ts';
import type { Clock } from '../../src/holistic/cadence.ts';
import type { AuditContext } from '../../src/holistic/audit.ts';
import { tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { type TreePlan, witnessLaneArgv, writeWitnessControl } from '../helpers/witness.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { type HolisticArc, type HolisticOptions, ADVANCES, VISION, obligationsJson } from './brake-common.ts';
import { publishArc, wire } from './publish-common.ts';
import { planCheckStep } from './stage-common.ts';
import { type ArcRun, codexStep, gateStep } from './unit-common.ts';

type Json = Record<string, unknown>;

export type AuditArcOptions = HolisticOptions & Readonly<{
  audit: Readonly<{ every?: number; lenses?: readonly string[]; wallClockMin?: number }>;
  /** Arc lanes scripted by a control file of their own (lane id → its trees): they report only these tests. */
  ownControl?: Readonly<Record<string, Readonly<Record<string, TreePlan>>>>;
}>;

/** The obligations file with each `ownControl` lane on its own control file (its proofs re-bound to the lane's new rev). */
function withOwnControls(file: Json, own: AuditArcOptions['ownControl']): Json {
  if (own === undefined) return file;
  const lanes = (file['lanes'] as Json[]).map((l) => {
    const trees = own[String(l['id'])];
    if (trees === undefined) return l;
    const control = join(tmpDir(`witness-control-${String(l['id'])}`), 'control.json');
    writeWitnessControl(control, { trees });
    return { ...l, argv: witnessLaneArgv('jsonl', tmpDir(`witness-lane-${String(l['id'])}`), control) };
  });
  const revs = new Map(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes, obligations: [], mapping: { paths: [] } }).lanes.map((l) => [l.id as string, laneRevOf(l)]));
  const obligations = (file['obligations'] as (Json & { proofJudgment: Json; witness: Json })[]).map((o) => ({
    ...o, proofJudgment: { ...o.proofJudgment, laneRev: revs.get(String(o.witness['lane'])) },
  }));
  return { ...file, lanes, obligations };
}

/** Lays out a holistic arc whose plan carries `holistic.audit`, and records revision 1 as an M3 start does. */
export function auditArc(opts: AuditArcOptions): HolisticArc {
  const control = join(tmpDir('witness-control'), 'control.json');
  writeWitnessControl(control, { trees: opts.trees });
  const d = publishArc({ steps: opts.steps, ...(opts.units === undefined ? {} : { units: opts.units }), ...(opts.suite === undefined ? {} : { suite: opts.suite }) }, (x) => {
    const planDir = join(x.planPath, '..');
    writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION));
    writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(withOwnControls(obligationsJson(opts, control), opts.ownControl)));
    const plan = JSON.parse(readFileSync(x.planPath, 'utf8')) as Json;
    writeFileSync(x.planPath, JSON.stringify({ ...plan, holistic: { vision: 'vision.json', advances: ADVANCES, obligations: 'obligations.json', audit: opts.audit } }));
    for (const u of opts.units ?? []) {
      if (u.obligations === undefined) continue;
      const spec = join(planDir, `${u.id}.json`);
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), obligations: u.obligations }));
    }
  });
  return { d, control };
}

/** The audit context over the run's arbiter (units acquire through the same one), with `clock`. */
export function auditContext(r: ArcRun, clock: Clock = () => 0): Readonly<{ ctx: AuditContext; w: ReturnType<typeof wire> }> {
  const w = wire(r);
  return { ctx: { ...w.stage, acquireFirst: w.arbiter.acquireFirst, clock }, w };
}

/** A unit's own module and its test (a unit other than u1 adds its own file). */
export const moduleFiles = (name: string, op: string): Readonly<Record<string, string>> => ({
  [`src/${name}.js`]: `export function ${name}(a, b) {\n  return a ${op} b;\n}\n`,
  [`test/${name}.test.js`]: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { ${name} } from '../src/${name}.js';\n\ntest('${name}', () => {\n  assert.equal(typeof ${name}(6, 3), 'number');\n});\n`,
});

/** The steps that take `unit` through plan-check, a build committing `files` and an approving gate. */
export function unitSteps(unit: string, files: Readonly<Record<string, string>>): readonly Step[] {
  return [
    { ...planCheckStep({ decision: 'approve' }), unit },
    { ...codexStep([{ type: 'commit', message: `build ${unit}`, files }], { argv: ['exec', '-C'] }), unit },
    { ...gateStep({ decision: 'approve' }), unit },
  ];
}

/** Every path a unit may touch maps to `obligations` (a unit then declares them). */
export const mapped = (obligations: readonly string[]) => ['src/**', 'test/**', 'contracts/**'].map((pattern) => ({ pattern, obligations }));

/** The log's facts, read as `status` reads them. */
export const factsOf = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
