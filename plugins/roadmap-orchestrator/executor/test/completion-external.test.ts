// Completion over external witness lanes (1.0.0-dev.82 field hotfix): an obligation whose arc lane is `witnessClass:
// external` is discharged on the head by the root's `roadmap witness` attestation at the head's lane inputs, the same
// reader `status`, the audit and the gate use (src/holistic/external.ts). Named tests: complete.external-attestation (a
// pass at the head completes; none or a fail stays `obligations-not-discharged`), complete.external-owed-waits (a done
// close-out never restarts with nothing changed; one `external-witness-owed` item asks for the attestation), and
// complete.external-field-upgrade (the stuck dev.81 arc, exactly as the field left it, completes on its first idle pass).
// dev.83: endgame.worklist-external (the endgame's worklist reads the same verdicts: an unattested external obligation
// is an optional attestation entry, never a required one, an attested fail a required one, a pass none) and
// complete.external-owed-settles (the completion supersedes the item; the endgame raises no item of its own for it).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { describe,test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { POLL_MS,submitCommand } from '../src/commands/queue.ts';
import { witness } from '../src/commands/witness.ts';
import { type Sha,commandId,envId,findingId,invocationId,obligationId,sha } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { witnessRecordOf,writeWitnessRecord } from '../src/holistic/witness.ts';
import { witnessDir } from '../src/git/snapshot.ts';
import { laneRevOf } from '../src/holistic/types.ts';
import { endgameNow,endgameOpen } from '../src/endgame/open.ts';
import { openNeedsUser,readNeedsUser } from '../src/needsuser.ts';
import { publishCloseOut } from '../src/pipeline/publish.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { type SchedulerEnd,completionBlockers } from '../src/schedule/scheduler.ts';
import { status } from '../src/status.ts';
import { moduleFiles,unitSteps } from './fixtures/audit-common.ts';
import { checkpointArc } from './fixtures/checkpoint-common.ts';
import { until } from './fixtures/exec-common.ts';
import { NOOP,contextsOf,startHolistic,wired } from './fixtures/sched-m3-common.ts';
import { SCENARIO_TIMEOUT_MS,admitAll } from './fixtures/stage-common.ts';
import { type ArcDescriptor,type ArcRun,SUITE_LANE,contextFor } from './fixtures/unit-common.ts';
import { checkpointStep,lensStep } from './helpers/holistic.ts';
import { git } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const WAIT_MS = 120_000;
const EVIDENCE = 'https://ci.example/arcs/external-completion';
const OBLIGATIONS = ['I-1', 'I-2'] as const;
const OWED = 'external-witness-owed';

const head = (d: ArcDescriptor): Sha => sha(git(d.repo, 'rev-parse', 'main'));
const tree = (d: ArcDescriptor, at: Sha): Sha => sha(git(d.repo, 'rev-parse', `${at}^{tree}`));

/**
 * u1 (mul, merged through its pipeline), its final audit and no-op checkpoint; I-1 and I-2 must-hold, witnessed only by
 * the external lane `journey` (its inputs u1's module: an attestation before u1 merged binds other inputs). The suite
 * has a batch lane, which the close-out's nothing-to-change path runs fresh every time (the field loop's cost).
 */
function externalArc(): ArcDescriptor {
  return checkpointArc([...unitSteps('u1', moduleFiles('mul', '*')), lensStep('audit-1', 'vision'), checkpointStep('ckpt-1', NOOP)], {
    obligations: OBLIGATIONS.map((id) => ({ id, testIds: ['ci'] })),
    laneExtra: { journey: { witnessClass: 'external', inputs: ['src/mul.js'] } },
    suite: [SUITE_LANE, { id: 'batch', cadence: 'batch', argv: ['true'] }],
  });
}

let commands = 0;
/** The root's `roadmap witness --at <at>` for every obligation, applied directly (no scheduler running). */
function attestAll(r: ArcRun, at: Sha, result: 'pass' | 'fail'): void {
  const w = wired(r);
  for (const o of OBLIGATIONS) {
    const out = witness(w.commands, commandId(`cmd-${(++commands).toString(16).padStart(16, 'e')}`), {
      type: 'witness', obligation: obligationId(o), expectedHead: at, result, evidence: EVIDENCE, evidenceFile: null,
    });
    assert.equal(out.kind, 'applied', JSON.stringify(out));
  }
}

/** The same attestations through the command queue, for a running scheduler to apply. */
function submitAll(r: ArcRun, at: Sha, result: 'pass' | 'fail'): void {
  for (const o of OBLIGATIONS) {
    submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'witness', obligation: obligationId(o), expectedHead: at, result, evidence: EVIDENCE, evidenceFile: null });
  }
}

/** u1 (no baseline is owed: the only arc lane is external), the final audit (and its no-op checkpoint), then the close-out publication at the head: what the scheduler does first. */
async function upToCloseOut(r: ArcRun): Promise<Sha> {
  const w = wired(r);
  const h = contextsOf(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  try {
    assert.deepEqual(await runUnit(w.stage, r.unit('u1'), admitAll), { kind: 'merged' });
    const audited = await runAudit(h.audit);
    assert.ok(audited.kind === 'ended' && audited.outcome === 'completed', JSON.stringify(audited));
    assert.equal((await publishCloseOut(h.docs)).kind, 'published');
  } finally {
    clearInterval(tick);
  }
  return head(r.d);
}

const blockers = (r: ArcRun) => completionBlockers(contextsOf(r), { blocking: 0, pending: 0 });
const statusUnmet = (r: ArcRun) => status(r.ctx.runDir, r.journal.view.arc, absPath(r.d.hostDir)).completion.unmet;
const closeOuts = (r: ArcRun) => r.journal.view.holistic().docsPublished.filter((p) => p.source === 'close-out');
const owedItems = (r: ArcRun) => r.journal.view.needsUser().filter((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === OWED);

/** The scheduler's end, or a failure naming the loop once `ms` pass (the defect this file guards never ends). */
async function endWithin(end: Promise<SchedulerEnd>, ms: number): Promise<SchedulerEnd> {
  let timer: NodeJS.Timeout | undefined;
  const loop = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the scheduler did not end within ${ms} ms`)), ms); });
  try { return await Promise.race([end, loop]); } finally { clearTimeout(timer); }
}

describe('completion over external witness lanes', () => {
  test('complete.external-attestation: only a pass attested at the head\'s lane inputs discharges; none, or a fail, stays obligations-not-discharged as status shows it; the scheduler then completes with the one close-out', T, async () => {
    const d = externalArc();
    const r = contextFor(d);
    try {
      const H = await upToCloseOut(r);
      assert.deepEqual([blockers(r), statusUnmet(r)], [['obligations-not-discharged'], ['obligations-not-discharged']], 'no attestation at the head');
      attestAll(r, H, 'fail');
      assert.deepEqual([blockers(r), statusUnmet(r)], [['obligations-not-discharged'], ['obligations-not-discharged']], 'an attested failure at the head');
      attestAll(r, H, 'pass');
      assert.deepEqual([blockers(r), statusUnmet(r)], [[], []], 'the newest attestation at the head\'s inputs is a pass');
      const docs = r.journal.view.nextJobId('docs');
      const end = await endWithin(startHolistic(r).end, WAIT_MS);
      assert.deepEqual(end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
      assert.equal(closeOuts(r).length, 1, 'exactly one close-out publication');
      assert.equal(r.journal.view.nextJobId('docs'), docs, 'no close-out job after it');
      assert.equal(r.journal.view.holistic().completion?.head, H);
    } finally {
      r.journal.close();
    }
  });

  test('complete.external-owed-waits: a close-out done at the head is not restarted while only external attestations are missing; one external-witness-owed item names them; the attestation completes the arc', T, async () => {
    const d = externalArc();
    const r = contextFor(d);
    const s = startHolistic(r);
    try {
      await until(() => owedItems(r).length > 0, WAIT_MS, 'the external-witness-owed item');
      const H = head(d);
      assert.deepEqual(closeOuts(r).map((p) => p.commit), [H], 'the close-out published the head once');
      const docs = r.journal.view.nextJobId('docs');
      await sleep(4 * POLL_MS);
      assert.equal(r.journal.view.nextJobId('docs'), docs, 'no close-out job started across the idle ticks');
      assert.equal(owedItems(r).length, 1, 'the item is raised once');
      assert.deepEqual(blockers(r), ['obligations-not-discharged']);
      const item = readNeedsUser(r.ctx.runDir, owedItems(r)[0]!.id)!;
      assert.deepEqual([item.blocking, item.subject], [false, { type: 'arc' }]);
      for (const text of [...OBLIGATIONS, 'journey', `roadmap witness`, `--at ${H}`]) assert.ok(item.summary.includes(text) || item.recommendation.includes(text), `the item names ${text}: ${JSON.stringify(item)}`);
      submitAll(r, H, 'pass');
      const end = await endWithin(s.end, WAIT_MS);
      assert.deepEqual(end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
      assert.equal(r.journal.view.nextJobId('docs'), docs, 'the attestation completes the arc without another close-out');
      assert.equal(owedItems(r).length, 1);
    } finally {
      if (r.journal.view.holistic().completion === null) {
        submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'stop' });
        await s.end.catch(() => undefined);
      }
      r.journal.close();
    }
  });

  test('complete.external-field-upgrade: a stopped dev.81 arc (close-out done at H, later nothing-to-change docs jobs, external passes at H superseding earlier ones, a mutant run on the external lane) completes on its first idle pass with no audit, no docs job and no publication', T, async () => {
    const d = externalArc();
    let r = contextFor(d);
    try {
      const base = head(d);
      // Earlier passes, at the arc's base (other lane inputs: u1's module is not there yet).
      attestAll(r, base, 'pass');
      const H = await upToCloseOut(r);
      // A mutant run on the external lane at the older tree, in its own environment: never a discharging observation.
      const lane = holisticInForce(r.ctx).obligations!.lanes.find((l) => l.id === 'journey')!;
      const spawn = r.journal.view.opsOf('proc.spawn')[0]!;
      const mutant = {
        lane: lane.id, laneRev: laneRevOf(lane), envId: envId('0'.repeat(16)), treeSha: tree(d, base), inv: invocationId(spawn.op, 1),
        purpose: 'mutant', for: { type: 'mutant', finding: findingId('F-1'), of: base },
      } as const;
      const dir = witnessDir(r.ctx.runDir, mutant);
      mkdirSync(dir, { recursive: true });
      const recordsSha256 = writeWitnessRecord(dir, witnessRecordOf({ lane, envId: mutant.envId, treeSha: mutant.treeSha, inv: mutant.inv, purpose: 'mutant' }, [{ testId: 'ci', selected: 1, outcome: 'fail' }]));
      r.journal.fact({ kind: 'witnessed', ...mutant, recordsSha256 });
      // The passes at H, each naming the earlier pass as its `since`; then a stop and a restart.
      attestAll(r, H, 'pass');
      assert.deepEqual(r.journal.view.ciFacts().filter((f) => f.kind === 'external-witness' && f.head === H).map((f) => f.kind === 'external-witness' && f.since), [base, base]);
      r.journal.close();
      r = contextFor(d);
      // dev.81's loop: every idle tick a nothing-to-change close-out, its batch lanes fresh, as a new docs job.
      const w = wired(r);
      const tick = setInterval(() => w.arbiter.wake(), 50);
      try {
        for (let i = 0; i < 3; i++) assert.deepEqual(await publishCloseOut(contextsOf(r).docs), { kind: 'nothing-to-change', head: H });
      } finally { clearInterval(tick); }
      r.journal.close();
      r = contextFor(d);
      const fold = r.journal.view.holistic();
      assert.equal(fold.completion, null, 'the arc never completed on dev.81');
      const before = {
        audits: fold.audits.length, docs: r.journal.view.nextJobId('docs'), published: fold.docsPublished.length,
        ffs: r.journal.view.opsOf('integration.ff').length, spawns: r.journal.view.opsOf('proc.spawn').length,
      };
      const end = await endWithin(startHolistic(r).end, WAIT_MS);
      assert.deepEqual(end, { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
      const after = r.journal.view.holistic();
      assert.deepEqual({
        audits: after.audits.length, docs: r.journal.view.nextJobId('docs'), published: after.docsPublished.length,
        ffs: r.journal.view.opsOf('integration.ff').length, spawns: r.journal.view.opsOf('proc.spawn').length,
      }, before, 'no audit, no docs or close-out job, no publication, no lane run');
      assert.equal(after.completion?.head, H);
      assert.deepEqual(owedItems(r), []);
      assert.deepEqual(statusUnmet(r), []);
    } finally {
      r.journal.close();
    }
  });

  test('endgame.worklist-external: unattested at the head, an external obligation is an optional attestation entry that holds no episode; an attested fail is a required obligation entry; a pass lists nothing', T, async () => {
    const d = externalArc();
    const r = contextFor(d);
    try {
      const H = await upToCloseOut(r);
      const h = contextsOf(r);
      const now = () => endgameNow(h.audit, h.laneEnv);
      assert.equal(now().phase.kind, 'endgame');
      assert.deepEqual(now().worklist, { required: [], optional: OBLIGATIONS.map((o) => ({ type: 'attestation', obligation: o, lane: 'journey' })) });
      assert.equal(endgameOpen(h.audit, h.laneEnv), false, 'an attestation owed never holds the endgame open');
      attestAll(r, H, 'fail');
      assert.deepEqual(now().worklist, { required: OBLIGATIONS.map((o) => ({ type: 'obligation', obligation: o })), optional: [] }, 'an attested fail at the head is not held');
      attestAll(r, H, 'pass');
      assert.deepEqual(now().worklist, { required: [], optional: [] }, 'attested at the head: not on the worklist');
    } finally {
      r.journal.close();
    }
  });

  test('complete.external-owed-settles: the arc-completed the attestations allow supersedes the external-witness-owed item; no endgame item asks for them too', T, async () => {
    const d = externalArc();
    const r = contextFor(d);
    const s = startHolistic(r);
    try {
      await until(() => owedItems(r).length > 0, WAIT_MS, 'the external-witness-owed item');
      const [item] = owedItems(r);
      assert.deepEqual(openNeedsUser(r.journal.view).map((n) => n.id), [item!.id], 'the owed item is the only open item: the endgame raised none');
      const episodes = r.journal.view.holistic().endgame;
      assert.deepEqual(episodes.map((e) => [e.episode, e.opened, e.left]), [[1, null, null]], 'the endgame entered (episode 1) and, with nothing required, never opened');
      const docs = r.journal.view.nextJobId('docs');
      submitAll(r, head(d), 'pass');
      assert.deepEqual(await endWithin(s.end, WAIT_MS), { kind: 'complete', units: [{ unit: 'u1', result: 'merged' }] });
      assert.deepEqual(r.journal.view.holistic().completion?.settles, [item!.id]);
      assert.deepEqual(openNeedsUser(r.journal.view), [], 'the completion settles it');
      assert.equal(r.journal.view.nextJobId('docs'), docs, 'the finished close-out did not restart through the endgame episode\'s end');
      assert.deepEqual(r.journal.view.holistic().endgame.map((e) => e.left?.cause), ['complete']);
    } finally {
      if (r.journal.view.holistic().completion === null) {
        submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'stop' });
        await s.end.catch(() => undefined);
      }
      r.journal.close();
    }
  });
});
