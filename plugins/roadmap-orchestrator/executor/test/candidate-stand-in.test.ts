// M4a rev 3 F6 (src/pipeline/integrate.ts, src/pipeline/lanes.ts): on a unit's candidate, a suite lane identical to an
// arc lane the held claims witness (argv, cwd, declared env, expected exit) runs once, in the suite, with the arc lane's
// reporter env: its exit is the suite lane's verdict and its record the arc lane's observation, which the brake's journey
// series reuses. Named tests: candidate.identical-suite-witness-one-run, candidate.different-env-two-runs.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { witnessRecordPath } from '../src/pipeline/lanes.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { tmpDir } from './helpers/repo.ts';
import { approveBoth, batchArc, publish } from './fixtures/batch-common.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, contextFor, gateStep, mulBuild, outcomes } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

/** Every in-scope path maps to I-1, so the candidate selects it and its arc lane `journey` runs. */
const MAPPED = [{ pattern: 'src/**', obligations: ['I-1'] }, { pattern: 'test/**', obligations: ['I-1'] }, { pattern: 'contracts/**', obligations: ['I-1'] }] as const;

/** Makes the plan's suite the arc lane `journey` itself (as a suite lane), with `envSet` set on the copy. */
const suiteCopy = (envSet: Readonly<Record<string, string>>) => (x: ArcDescriptor): void => {
  const planDir = join(x.planPath, '..');
  const arcLane = (JSON.parse(readFileSync(join(planDir, 'obligations.json'), 'utf8')) as { lanes: Json[] }).lanes[0]!;
  const { reporter: _r, ...def } = arcLane;
  const suiteLane = { ...def, id: 'suite-journey', env: { set: envSet, pass: ['PATH'] } };
  const plan = JSON.parse(readFileSync(x.planPath, 'utf8')) as Json;
  writeFileSync(x.planPath, JSON.stringify({ ...plan, suite: { lanes: [suiteLane] } }));
};

/** An arc whose suite is the arc lane `journey` itself, with `env` set on the suite copy. */
function arcWithSuiteCopy(envSet: Readonly<Record<string, string>>): ArcDescriptor {
  const { d } = holisticArc({
    steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
    units: [{ id: 'u1', obligations: ['I-1'] }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: MAPPED,
    trees: { '*': { outcomes: { t1: 'pass' } } },
    beforeStart: suiteCopy(envSet),
  });
  return d;
}

const facts = (d: ArcDescriptor): readonly Fact[] => readJournal(absPath(d.runDir), d.arc as never).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));

describe('one execution for identical suite and witness lanes (F6)', () => {
  test('candidate.identical-suite-witness-one-run: the suite lane runs once with the reporter env; the claims reuse its observation; the candidate is green', T, async () => {
    const d = arcWithSuiteCopy({});
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      assert.ok(outcomes(d).includes('candidate:green'));
      const spawns = r.journal.view.opsOf('proc.spawn');
      const suite = spawns.filter((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'suite');
      assert.equal(suite.length, 1, 'the suite lane ran once');
      assert.equal(spawns.filter((i) => i.expect.subject.purpose === 'journey').length, 0, 'the arc lane did not run again');
      const witnessed = facts(d).flatMap((f) => (f.kind === 'witnessed' ? [f] : []));
      assert.equal(witnessed.length, 1);
      const [w] = witnessed;
      assert.deepEqual([w!.lane, w!.inv, w!.for.type, w!.purpose], ['journey', `${suite[0]!.op}#${suite[0]!.ordinal}`, 'candidate', 'witness']);
      assert.ok(existsSync(witnessRecordPath(r.ctx.runDir, w!)), 'its record kept where the fact names it');
      assert.ok(facts(d).some((f) => f.kind === 'series-certified' && f.parent.type === 'stage' && f.parent.stage === 'candidate'), 'the suite series certified');
    } finally {
      r.journal.close();
    }
  });

  test('candidate.batch-stand-in-one-run: a repair batch runs the suite lane identical to a claimed arc lane once, in the suite\'s place, and publishes', T, async () => {
    const { d } = batchArc({ beforeStart: suiteCopy({}) });
    const r = contextFor(d);
    try {
      await approveBoth(r);
      const outcome = await publish(r);
      assert.equal(outcome.kind, 'published', JSON.stringify(outcome));
      const journeys = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey');
      assert.deepEqual(journeys.map((i) => (i.expect.subject.purpose === 'journey' ? i.expect.subject.lane : '')), ['journey'], 'one execution, as the arc lane');
      assert.deepEqual(facts(d).flatMap((f) => (f.kind === 'witnessed' ? [f.lane] : [])), ['journey']);
    } finally {
      r.journal.close();
    }
  });

  test('candidate.different-env-two-runs: a suite lane whose declared env differs runs on its own, and the arc lane runs as a journey lane', T, async () => {
    const d = arcWithSuiteCopy({ ROADMAP_WITNESS_FILE: join(tmpDir('suite-witness'), 'out.jsonl') });
    const r = contextFor(d);
    try {
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
      const spawns = r.journal.view.opsOf('proc.spawn');
      assert.equal(spawns.filter((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.set === 'suite').length, 1);
      assert.equal(spawns.filter((i) => i.expect.subject.purpose === 'journey').length, 1, 'two executions');
      const witnessed = facts(d).flatMap((f) => (f.kind === 'witnessed' ? [f] : []));
      const journey = spawns.find((i) => i.expect.subject.purpose === 'journey')!;
      assert.deepEqual(witnessed.map((f) => f.inv), [`${journey.op}#${journey.ordinal}`]);
    } finally {
      r.journal.close();
    }
  });
});
