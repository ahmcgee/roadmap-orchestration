// Job-owned residues through the reservation cycle, recovery and the prober (M3, G4; src/resources/reserve.ts,
// src/recover/{residue,resource}.ts, src/park/probe.ts), with real processes, real journals and the estate fake:
//
//   job-residue.failed-cleanup-restart   a job's failed cleanup leaves a job-owned residue durable in the host
//                                        index; across a restart recovery leaves it cleanup-failed; the probe of
//                                        the residue reclaims it under the job's own holder: released, `cleaned`
//   job-residue.retry-crash              the job's reclaim crashed at retry.before-/after-disposition: recovery
//                                        resumes the reclaim order (a job holder cleaning with a residue on it)
//   job-residue.dead-holder              a job that died with its lane running: recovery settles the lane spawn,
//                                        cleans, reruns the teardown under the job's owner label, and releases,
//                                        or fails with a job-owned residue that the probe then reclaims
//   job-residue.occupancy-probe          a job holder's occupancy probe runs under the job's owner label
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Event, IntentOf } from '../src/core/events.ts';
import { arcId, jobId, poolInstance } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { ResidueKey } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { readResidues, undispositioned } from '../src/host/residues.ts';
import { createProber } from '../src/park/probe.ts';
import { dueJobs } from '../src/park/schedule.ts';
import { recoverReservations } from '../src/recover/resource.ts';
import { probe } from '../src/resources/probe.ts';
import { type JobHolder, cleanup, jobOwnerLabel, reserve, run } from '../src/resources/reserve.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { assertNoSurvivors } from './helpers/reap.ts';
import { tmpDir } from './helpers/repo.ts';
import { events } from './fixtures/invoke-specs.ts';
import { ESTATE } from './fixtures/pool-plan.ts';
import { newProbeRun, openProbeRun } from './fixtures/probe-common.ts';
import { type ResRun, newRun, tableOf } from './fixtures/res-plan.ts';

after(assertNoSurvivors);

const T = { timeout: 120_000 };
const CHILD_TIMEOUT_MS = 30_000;
const JOB = jobId('audit', 1);
const HOLDER: JobHolder = { type: 'job', job: JOB };
const PARENT = { type: 'job', job: JOB } as const;
const INSTANCE = poolInstance(ESTATE, 1);
const signal = (): AbortSignal => new AbortController().signal;

const child = (mode: string, r: ResRun, trigger: string | null) =>
  runFixture('job-child.ts', [mode, JSON.stringify(r)], {
    env: trigger === null ? { ...process.env } : { ...process.env, ROADMAP_TEST_CRASH: trigger },
    timeoutMs: CHILD_TIMEOUT_MS,
  });

async function ok(mode: string, r: ResRun): Promise<string> {
  const exit = await child(mode, r, null);
  assert.equal(exit.code, 0, `${mode}: ${exit.stderr}`);
  return exit.stdout.trim();
}

const residueLines = (r: ResRun) => readResidues(absPath(r.hostDir));
const residueKeys = (r: ResRun): readonly ResidueKey[] => residueLines(r).flatMap((l) => (l.type === 'residue' ? [l.key] : []));

/** Every resource.transition of estate#1 as `<holder type> <edge>`, log order. */
function moves(r: ResRun): readonly string[] {
  return events(r.runDir)
    .filter((e): e is Event & IntentOf<'resource.transition'> => e.type === 'intent' && e.kind === 'resource.transition')
    .filter((e) => e.expect.resources.includes(INSTANCE))
    .map((e) => `${e.expect.holder.type} ${e.expect.edge.type}`);
}

/** The estate fake's calls on estate#1: `<cmd> <label>`. */
function estateCalls(r: ResRun): readonly string[] {
  const log = join(r.stateDir, 'calls.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith(`teardown ${INSTANCE} `) || l.startsWith(`probe ${INSTANCE} `)).map((l) => l.replace(` ${INSTANCE}`, ''));
}

/** Free, its one job-owned residue disposed `cleaned`, the last move the job's release, nothing open. */
function assertReclaimed(r: ResRun): void {
  assert.deepEqual(Object.fromEntries(tableOf(r)), { [INSTANCE]: { state: 'free' } });
  assert.deepEqual(undispositioned(absPath(r.hostDir)), []);
  const [key, ...more] = residueKeys(r);
  assert.deepEqual(more, [], 'one failed teardown, one residue');
  assert.equal(key?.job, JOB, 'the residue is job-owned');
  assert.equal(key?.unit, undefined);
  const dispositions = residueLines(r).filter((l) => l.type === 'disposition');
  assert.equal(dispositions.length, 1);
  assert.ok(dispositions.every((d) => d.type === 'disposition' && d.disposition === 'cleaned'));
  assert.equal(moves(r).at(-1), 'job release');
}

describe('job-residue.failed-cleanup-restart', () => {
  it('a job\'s failed cleanup: job-owned residue durable, cleanup-failed across a restart, reclaimed by the probe under the job\'s holder', T, async () => {
    const r = newProbeRun([]);
    writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
    let { ctx, journal } = openProbeRun(r);
    const got = reserve(ctx, HOLDER, { named: [], pools: [ESTATE], cpu: 0, publication: false }, PARENT);
    assert.equal(got.state, 'reserved');
    if (got.state !== 'reserved') return;
    const label = jobOwnerLabel(journal.view.arc, JOB);
    assert.equal(label, `${journal.view.arc}/job/${JOB}`);
    assert.deepEqual([...got.recipes.values()].map((x) => [x.label, x.teardown.env['RESOURCE_OWNER'], x.teardown.env['RESOURCE_INSTANCE_ESTATE']]), [[label, label, '1']]);
    const cleaned = await cleanup(ctx, run(ctx, got, PARENT), PARENT);
    assert.deepEqual(cleaned, { kind: 'cleanup-failed', failed: [INSTANCE], released: [] });
    const [key] = undispositioned(absPath(r.hostDir));
    assert.deepEqual(key && { job: key.job, unit: key.unit, resource: key.resource, arc: key.arc }, { job: JOB, unit: undefined, resource: INSTANCE, arc: journal.view.arc });
    assert.equal(residueLines(r).find((l) => l.type === 'residue')?.label, label);
    journal.close();

    // A restart: the journal reopened, recovery never releases a cleanup-failed instance.
    ({ ctx, journal } = openProbeRun(r));
    await recoverReservations(ctx);
    assert.deepEqual(journal.view.resources().get(INSTANCE)?.status, { state: 'cleanup-failed', holder: HOLDER });
    assert.equal(undispositioned(absPath(r.hostDir)).length, 1);
    const [residue] = journal.view.residues();
    assert.deepEqual(residue?.holder, HOLDER);

    // The residue's probe: the reclaim order under the job's own holder, then the pass.
    const prober = createProber(ctx);
    const [job, ...others] = prober.due(journal.view, new Date());
    assert.deepEqual(others, []);
    assert.deepEqual(job, { target: { type: 'resource', instance: INSTANCE }, covers: [residue!.failSeq] });
    assert.equal(await prober.run(job!, signal()), 'pass');
    assert.deepEqual(dueJobs(journal.view, new Date()), []);
    journal.close();

    assertReclaimed(r);
    assert.deepEqual(moves(r), ['job reserve', 'job run', 'job clean', 'job fail', 'job reclaim', 'job release']);
    // Both teardowns carried the job's owner label: the failed one and the reclaim's replay of its recipe.
    assert.deepEqual(estateCalls(r), [`teardown ${label}`, `teardown ${label}`]);
  });
});

describe('job-residue.retry-crash', { concurrency: 2 }, () => {
  for (const label of ['retry.before-disposition', 'retry.after-disposition']) {
    it(`${label}: recovery resumes the job's reclaim order (teardown, disposition unless recorded, release)`, T, async () => {
      const r = newRun();
      await ok('recover', r); // creates the state dir and an empty log
      writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
      const trigger = writeTrigger(tmpDir('trigger'), { label, occurrence: 1 });
      const exit = await child('retry', r, trigger);
      assert.equal(exit.signal, 'SIGKILL', `the reclaim did not crash at ${label}: ${exit.stderr}`);
      assertFired(trigger);
      const { view } = readJournal(absPath(r.runDir), arcId(r.arc));
      assert.deepEqual(view.resources().get(INSTANCE)?.status, { state: 'cleaning', holder: HOLDER }, 'the job holds it cleaning, reclaiming');
      assert.equal(undispositioned(absPath(r.hostDir)).length, label === 'retry.before-disposition' ? 1 : 0);

      await ok('recover', r);
      assertReclaimed(r);
      assert.deepEqual(moves(r), ['job reserve', 'job run', 'job clean', 'job fail', 'job reclaim', 'job release']);
      // Recovery and the probe are idempotent.
      const before = events(r.runDir).length;
      await ok('recover', r);
      assert.equal(await ok('reclaim', r), 'pass');
      assert.equal(events(r.runDir).length, before, 'nothing left to do');
    });
  }
});

describe('job-residue.dead-holder', { concurrency: 2 }, () => {
  for (const teardownFails of [false, true]) {
    it(`a job that died with its lane running is cleaned and ${teardownFails ? 'fails with a job-owned residue, then the probe reclaims it' : 'released'}`, T, async () => {
      const r = newRun();
      await ok('recover', r); // creates the state dir and an empty log
      if (teardownFails) writeFileSync(join(r.stateDir, `${ESTATE}.teardown-fails-once`), '');
      // What the job's lane left on estate#1, under the job's owner label (the estate fake's occupant).
      const label = jobOwnerLabel(arcId(r.arc), JOB);
      const occupant = join(r.stateDir, INSTANCE, 'occupant');
      mkdirSync(join(r.stateDir, INSTANCE), { recursive: true });
      writeFileSync(occupant, label);
      // The first spawn is the lane: the job dies with it launched and its spawn open.
      const trigger = writeTrigger(tmpDir('trigger'), { label: 'launch.after-spawn', occurrence: 1 });
      const exit = await child('lane', r, trigger);
      assert.equal(exit.signal, 'SIGKILL', exit.stderr);
      assertFired(trigger);
      const { view } = readJournal(absPath(r.runDir), arcId(r.arc));
      assert.deepEqual(view.resources().get(INSTANCE)?.status, { state: 'running', holder: HOLDER });
      assert.ok(view.openIntents().some((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'journey'), 'the lane spawn is open');

      await ok('recover', r);
      if (teardownFails) {
        // tableOf also asserts nothing is left open, the lane spawn included.
        assert.deepEqual(Object.fromEntries(tableOf(r)), { [INSTANCE]: { state: 'cleanup-failed', holder: HOLDER } });
        const [key, ...more] = undispositioned(absPath(r.hostDir));
        assert.deepEqual(more, []);
        assert.equal(key?.job, JOB);
        assert.equal(readFileSync(occupant, 'utf8'), label, 'the failed teardown left the lane\'s object');
        assert.deepEqual(moves(r), ['job reserve', 'job run', 'job clean', 'job fail']);
        // The residue's probe after the restart.
        assert.equal(await ok('reclaim', r), 'pass');
        assertReclaimed(r);
      } else {
        assert.deepEqual(Object.fromEntries(tableOf(r)), { [INSTANCE]: { state: 'free' } });
        assert.deepEqual(residueLines(r), []);
        assert.deepEqual(moves(r), ['job reserve', 'job run', 'job clean', 'job release']);
      }
      // The teardown ran under the job's owner label and removed the lane's object.
      assert.equal(existsSync(occupant), false);
      assert.ok(estateCalls(r).length > 0 && estateCalls(r).every((c) => c === `teardown ${label}`), JSON.stringify(estateCalls(r)));
      const before = events(r.runDir).length;
      await ok('recover', r);
      assert.equal(events(r.runDir).length, before, 'recovery is idempotent');
    });
  }
});

describe('job-residue.occupancy-probe', () => {
  it('a job holder\'s occupancy probe uses the job\'s owner label: its own leftovers are torn down, a foreign occupant parks the arc naming the job', T, async () => {
    const r = newProbeRun([]);
    const { ctx, journal } = openProbeRun(r);
    const label = jobOwnerLabel(journal.view.arc, JOB);
    const occupant = join(r.stateDir, INSTANCE, 'occupant');
    mkdirSync(join(r.stateDir, INSTANCE), { recursive: true });
    const request = { named: [], pools: [ESTATE], cpu: 0, publication: false } as const;

    writeFileSync(occupant, label);
    const own = reserve(ctx, HOLDER, request, PARENT);
    if (own.state !== 'reserved') throw new Error(`refused: ${own.busy.join(', ')}`);
    assert.deepEqual(await probe(ctx, own, PARENT), { kind: 'clear' });
    assert.equal(existsSync(occupant), false, 'the job\'s own leftovers were torn down');
    assert.deepEqual(estateCalls(r), [`probe ${label}`, `teardown ${label}`, `probe ${label}`]);
    assert.equal((await cleanup(ctx, own, PARENT)).kind, 'released');

    writeFileSync(occupant, `${journal.view.arc}/u1`);
    const foreign = reserve(ctx, HOLDER, request, PARENT);
    if (foreign.state !== 'reserved') throw new Error(`refused: ${foreign.busy.join(', ')}`);
    const verdict = await probe(ctx, foreign, PARENT);
    if (verdict.kind !== 'parked') throw new Error(`not parked: ${JSON.stringify(verdict)}`);
    assert.deepEqual(verdict.needsUser.subject, { type: 'arc' });
    assert.match(verdict.needsUser.summary, new RegExp(`estate#1 is occupied by something without this job's label at the first probe .*job ${JOB}'s lane did not run`));
    assert.equal((await cleanup(ctx, foreign, PARENT)).kind, 'released');
    journal.close();
  });
});
