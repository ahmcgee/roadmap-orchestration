// Job-owned residues (M3, G4) in the park schedule and the prober (src/park/{schedule,probe}.ts) and in the A9
// ownership proof (src/host/residues.ts): a job's failed lane cleanup leaves a residue keyed by the job, which is a
// probe target, reclaimed under the job's own holder, escalated after 6 h like a unit's, and owned by its arc.
//
//   residue.job-owned-probe-target   the residue is a resource target covering its fail seq, before and during a
//                                    reclaim by the job holder; the prober reclaims under that holder
//   residue.job-owned-escalation     6 h after the failed cleanup: one non-blocking park-escalated item naming the job
//   residue.job-owned-own-arc        its arc's log proves the job-owned key its own; a unit or another job never does
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Holder, type LogRecord, type ResourceEdge, prevHash, serializeEvent } from '../src/core/events.ts';
import { type ResidueKey } from '../src/core/records.ts';
import { invocationId, jobId, opId, opKey, poolInstance, resourceName, unitId } from '../src/core/ids.ts';
import { Fold } from '../src/core/state.ts';
import { ownArcResidue } from '../src/host/residues.ts';
import { retryHolderOf } from '../src/park/probe.ts';
import { probeTargets, residueEscalationsDue, residueTargets } from '../src/park/schedule.ts';
import { PARK_ESCALATE_MS } from '../src/schedule/types.ts';
import { ARC, AT, chain } from './fixtures/log-records.ts';

const JOB = jobId('audit', 1);
const HOLDER: Holder = { type: 'job', job: JOB };
const INSTANCE = poolInstance(resourceName('estate'), 1);
const TEARDOWN = invocationId(opId(ARC, 90), 1);
const KEY: ResidueKey = { arc: ARC, job: JOB, inv: TEARDOWN, resource: INSTANCE };

/** One done `resource.transition` of estate#1 under `holder` at op seq `seq`. */
function transition(seq: number, holder: Holder, edge: ResourceEdge): readonly LogRecord[] {
  const op = opId(ARC, seq);
  return [
    {
      type: 'intent', op, ordinal: 1, kind: 'resource.transition', key: opKey(`resources:job/${JOB}`), parent: { type: 'job', job: JOB }, deadlineAt: null,
      expect: { holder, resources: [INSTANCE], edge }, post: null,
    } as LogRecord,
    { type: 'done', op, kind: 'resource.transition', outcome: { kind: 'transitioned' }, recoveredBy: null } as LogRecord,
  ];
}

/** The job's lane: reserve, run, clean, then a failed cleanup recording estate#1's residue (fail at seq 7). */
const FAILED: readonly LogRecord[] = [
  ...transition(1, HOLDER, { type: 'reserve' }),
  ...transition(3, HOLDER, { type: 'run' }),
  ...transition(5, HOLDER, { type: 'clean', from: 'running' }),
  ...transition(7, HOLDER, { type: 'fail', residues: [{ resource: INSTANCE, teardown: TEARDOWN }] }),
];
const FAIL_SEQ = 7;

function folded(records: readonly LogRecord[]): Fold {
  const f = new Fold(ARC);
  for (const e of chain(records)) f.apply(e, prevHash(Buffer.from(serializeEvent(e))));
  return f;
}

test('residue.job-owned-probe-target: a job\'s residue is a resource probe target covering its fail, reclaimed under the job\'s own holder', () => {
  const failed = folded(FAILED);
  const [residue] = failed.residues();
  assert.deepEqual(residue?.key, KEY, 'the residue is keyed by its job');
  assert.deepEqual(residue?.holder, HOLDER);
  assert.deepEqual(residueTargets(failed).map((r) => r.key), [KEY]);
  assert.deepEqual(probeTargets(failed), [{ target: { type: 'resource', instance: INSTANCE }, covers: [FAIL_SEQ] }]);
  assert.deepEqual(retryHolderOf(failed, INSTANCE), HOLDER, 'cleanup-failed: the job reclaims its own residue');

  // A reclaim by the job whose teardown failed again (or crashed): still a target, still the job's holder.
  const reclaiming = folded([...FAILED, ...transition(9, HOLDER, { type: 'reclaim' })]);
  assert.deepEqual(reclaiming.resources().get(INSTANCE)?.status, { state: 'cleaning', holder: HOLDER });
  assert.deepEqual(residueTargets(reclaiming).map((r) => r.key), [KEY]);
  assert.deepEqual(retryHolderOf(reclaiming, INSTANCE), HOLDER);

  // Released: no target, nothing to reclaim.
  const released = folded([...FAILED, ...transition(9, HOLDER, { type: 'reclaim' }), ...transition(11, HOLDER, { type: 'release' })]);
  assert.deepEqual(residueTargets(released), []);
  assert.deepEqual(probeTargets(released), []);
  assert.equal(retryHolderOf(released, INSTANCE), null);
});

test('residue.job-owned-escalation: 6 h after the job\'s failed cleanup one non-blocking park-escalated item about the arc names the job', () => {
  const view = folded(FAILED);
  const at6h = new Date(Date.parse(AT) + PARK_ESCALATE_MS);
  assert.deepEqual(residueEscalationsDue(view, new Date(at6h.getTime() - 1)), []);
  const due = residueEscalationsDue(view, at6h);
  assert.equal(due.length, 1);
  const [item] = due;
  assert.deepEqual(item?.parent, { type: 'op', op: opId(ARC, FAIL_SEQ) });
  assert.equal(item?.content.blocking, false);
  assert.equal(item?.content.reason, 'park-escalated');
  assert.deepEqual(item?.content.subject, { type: 'arc' });
  assert.match(item?.content.summary ?? '', new RegExp(`estate#1 .*the cleanup of job ${JOB}'s lane failed \\(teardown ${TEARDOWN}\\)`));
});

test('residue.job-owned-own-arc: the arc\'s fail intent held by the job proves the job-owned key its own; a unit or another job never does', () => {
  const view = folded(FAILED);
  assert.equal(ownArcResidue(view, KEY), true);
  assert.equal(ownArcResidue(view, { ...KEY, job: jobId('audit', 2) }), false, 'another job');
  const { job: _job, ...base } = KEY;
  assert.equal(ownArcResidue(view, { ...base, unit: unitId('u1') }), false, 'a unit key on the same teardown');
  assert.equal(ownArcResidue(folded([]), KEY), false, 'an empty log proves nothing');
});
