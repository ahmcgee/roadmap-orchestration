// dev.17 lane topology: the suite lanes a unit's candidate runs (src/pipeline/integrate.ts `candidateLanes`), through the
// unit driver over real processes and real git. Named tests: candidate.selects-by-systems, candidate.unmapped-runs-all,
// candidate.docs-only, candidate.never-batch.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runUnit } from '../src/pipeline/unit.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { MUL, SUITE_LANE, codexStep, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const MAP = {
  systems: { math: { paths: ['src/**'], tests: ['test/**'] }, other: { paths: ['other/**'] } },
  docs: ['contracts/*.md'],
};
/** Every suite lane passes; each is of cadence candidate, so only a candidate runs it (the lanes stage never does). */
const SUITE: readonly LaneJson[] = [
  { id: 'math', cadence: 'candidate', argv: ['true'], systems: ['math'] },
  { id: 'other', cadence: 'candidate', argv: ['true'], systems: ['other'] },
  { id: 'docs-lane', cadence: 'candidate', argv: ['true'], systems: ['docs'] },
  { id: 'whole', cadence: 'candidate', argv: ['true'] },
];
/** The unit's own lane: passes whatever it built. */
const OK_LANE: LaneJson = { id: 'ok', argv: ['true'] };

/** The suite lane ids spawned by the candidate stage, in spawn order. */
const candidateSuiteSpawns = (runDir: string): readonly string[] => intents(runDir, 'proc.spawn').flatMap((i) => {
  if (i.kind !== 'proc.spawn') return [];
  const s = i.expect.subject;
  return s.purpose === 'lane' && s.set === 'suite' && i.parent.type === 'stage' && i.parent.stage === 'candidate' ? [s.lane as string] : [];
});

/** Runs u1, whose build commits `files`, to its merge under MAP; returns the suite lanes its candidate spawned. */
async function mergeWith(files: Readonly<Record<string, string>>): Promise<readonly string[]> {
  const d = setupArc({
    steps: [planCheckStep({ decision: 'approve' }), codexStep([{ type: 'commit', message: 'build', files }], { argv: ['exec', '-C'] }), gateStep({ decision: 'approve' })],
    units: [{ id: 'u1', lanes: [OK_LANE] }], suite: SUITE, systemsMap: MAP,
  });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
    assert.equal(outcomes(d).filter((o) => o === 'candidate:green').length, 1, outcomes(d).join(' '));
    assert.deepEqual(r.journal.view.planApplied()?.systemsMap?.docs, ['contracts/*.md'], 'revision 1 recorded the repo config\'s map');
    return candidateSuiteSpawns(d.runDir);
  } finally {
    r.journal.close();
  }
}

describe('candidate lane selection (dev.17)', () => {
  test('candidate.reuses-fast-suite: a candidate with the same input reuses the lanes-stage pass through the reuse key', T, async () => {
    const d = setupArc({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
      units: [{ id: 'u1', lanes: [OK_LANE] }],
      suite: [{ id: 'shared', cadence: 'unit', argv: ['sh', '-c', ': shared'], systems: ['math'] }], systemsMap: MAP,
    });
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.deepEqual(candidateSuiteSpawns(d.runDir), []);
      const reused = r.journal.view.holistic().laneReuses.filter((l) => l.parent.type === 'stage' && l.parent.stage === 'candidate');
      assert.deepEqual(reused.map((l) => [l.lane, l.set, l.from.parent.type === 'stage' ? l.from.parent.stage : null]), [['shared', 'suite', 'lanes']]);
    } finally {
      r.journal.close();
    }
  });

  test('candidate.selects-by-systems: a diff in one system runs the lanes listing it and the lane listing none, nothing else', T, async () => {
    assert.deepEqual(await mergeWith(MUL), ['math', 'whole']);
  });

  test('candidate.unmapped-runs-all: a diff touching an unmapped path runs every suite lane', T, async () => {
    assert.deepEqual(await mergeWith({ ...MUL, 'contracts/notes.txt': 'unmapped\n' }), ['math', 'other', 'docs-lane', 'whole']);
  });

  test('candidate.docs-only: a docs-only diff runs the lane listing docs and the lane listing no systems, no other', T, async () => {
    assert.deepEqual(await mergeWith({ 'contracts/notes.md': '# Notes\n' }), ['docs-lane', 'whole']);
  });

  test('candidate.never-batch: a batch lane of a holistic plan never runs in the merge path; the other suite lanes do', T, async () => {
    const { d } = holisticArc({
      steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
      suite: [{ ...SUITE_LANE, cadence: 'candidate' }, { id: 'batch', cadence: 'batch', argv: ['true'] }],
      obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [], trees: { '*': { outcomes: { t1: 'pass' } } },
    });
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.deepEqual(candidateSuiteSpawns(d.runDir), ['suite']);
      const batchSpawns = intents(d.runDir, 'proc.spawn').filter((i) => i.kind === 'proc.spawn' && 'lane' in i.expect.subject && i.expect.subject.lane === 'batch');
      assert.deepEqual(batchSpawns, [], 'no stage of the unit ran the batch lane');
    } finally {
      r.journal.close();
    }
  });
});
