// adopted-arc coverage (LR-D0b): migrate to corpus arcs when holistic architecture-doc scaffolding is deleted (BACKLOG)
// Shared by the repair-batch tests (test/batch.test.ts) and their crash child (batch-child.ts): a holistic arc with two
// units that both repair I-2 (a P1 finding F-1 is open over it), each adding its own module, approved one after the
// other; then `publishBatch` publishes them as one candidate. `estate`: the journey lane reserves an estate pool
// instance (test/fakes/estate.ts), whose teardown a test can make fail.
import { fileURLToPath } from 'node:url';
import { findingId, sha256 } from '../../src/core/ids.ts';
import { type BatchContext, type BatchOutcome, publishBatch } from '../../src/pipeline/integrate.ts';
import { tmpDir } from '../helpers/repo.ts';
import type { Step } from '../helpers/scenario.ts';
import { holisticArc } from './brake-common.ts';
import { wire } from './publish-common.ts';
import { planCheckStep } from './stage-common.ts';
import { type ArcDescriptor, type ArcRun, codexStep, contextFor, gateStep, stepUntil } from './unit-common.ts';

export const F1 = findingId('F-1');
const estateFake = fileURLToPath(new URL('../fakes/estate.ts', import.meta.url));

const moduleFiles = (name: string, op: string): Readonly<Record<string, string>> => ({
  [`src/${name}.js`]: `export function ${name}(a, b) {\n  return a ${op} b;\n}\n`,
  [`test/${name}.test.js`]: `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { ${name} } from '../src/${name}.js';\n\ntest('${name}', () => {\n  assert.equal(typeof ${name}(6, 3), 'number');\n});\n`,
});
const keyed = (unit: string, s: Step): Step => ({ ...s, unit });
const unitSteps = (unit: string, files: Readonly<Record<string, string>>): readonly Step[] => [
  keyed(unit, planCheckStep({ decision: 'approve' })),
  keyed(unit, codexStep([{ type: 'commit', message: `build ${unit}`, files }], { argv: ['exec', '-C'] })),
  keyed(unit, gateStep({ decision: 'approve' })),
];

/** The arc: u1 (mul) and u2 (div), each declaring I-1 and repairing I-2; `state`: the estate fake's state dir. */
export function batchArc(opts: Readonly<{ estate?: true; t2?: 'pass' | 'fail' }> = {}): Readonly<{ d: ArcDescriptor; state: string }> {
  const state = tmpDir('batch-estate');
  const estate = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, estateFake, cmd, state, 'estate'], cwd: '.', env: { set: {}, pass: ['PATH'] } });
  const { d } = holisticArc({
    steps: [...unitSteps('u1', moduleFiles('mul', '*')), ...unitSteps('u2', moduleFiles('div', '/'))],
    units: [{ id: 'u1', obligations: ['I-1'], repairs: ['I-2'] }, { id: 'u2', obligations: ['I-1'], repairs: ['I-2'], lanes: [{ id: 'div', argv: ['node', '--test', 'test/div.test.js'] }] }],
    obligations: [{ id: 'I-1', testIds: ['t1'] }, { id: 'I-2', testIds: ['t2'] }],
    mapping: [{ pattern: 'src/**', obligations: ['I-1'] }, { pattern: 'test/**', obligations: ['I-1'] }, { pattern: 'contracts/**', obligations: ['I-1'] }, { pattern: 'lib/**', obligations: ['I-2'] }],
    trees: { '*': { outcomes: { t1: 'pass', t2: opts.t2 ?? 'pass' } } },
    ...(opts.estate === undefined ? {} : {
      laneExtra: { journey: { resources: ['estate'] } },
      planExtra: { resources: [{ name: 'estate', pool: { size: 1 }, probe: estate('probe'), teardown: estate('teardown') }] },
    }),
  });
  return { d, state };
}

/** Opens F-1, a P1 over I-2, then steps both units to their approvals. */
export async function approveBoth(r: ArcRun): Promise<void> {
  r.journal.fact({
    kind: 'finding-opened', id: F1, key: sha256('1'.repeat(64)), lens: 'witness', severity: 'P1', obligation: 'I-2' as never, visionClauses: [],
    claim: 'I-2 is not held on the audited head', evidence: [], mutant: null, source: { type: 'job', job: 'audit-1' as never }, gateHadPassed: true,
  });
  await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
  await stepUntil(r, 'u2', (f) => f.stage === 'gate' && f.outcome === 'approve');
}

/** The batch context over `r`: its stage context with an arbiter's `acquireFirst`. */
export function batchContext(r: ArcRun): BatchContext {
  const w = wire(r);
  return { ...r.ctx, acquireFirst: w.arbiter.acquireFirst };
}

export const publish = (r: ArcRun): Promise<BatchOutcome> => publishBatch(batchContext(r), F1, [r.unit('u1'), r.unit('u2')]);

export { contextFor };
