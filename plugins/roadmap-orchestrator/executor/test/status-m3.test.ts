// `roadmap status`'s M3 keys (src/status.ts; DESIGN-1.0.md §2.4, plan "`status` (additive)"), in process over holistic
// arcs whose log is written directly (real repos, real run dirs, the real fold): the facts are the frozen M3 ones, so
// what a later step writes renders the same. Named tests: status.target, status.findings-audit, status.coverage-per-lens,
// status.decisions-since, status.divergences-since-ack, status.completion-sealed, status.log-size, status.non-holistic-arc,
// status.dev6-alias.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { submitCommand } from '../src/commands/queue.ts';
import type { Fact, IntentOf, RevisionPayload } from '../src/core/events.ts';
import {
  type RoutingRev, type Sha, type UnitId, arcId, commandId, envId, invocationId, jobId, opKey, planRev, routingRev, sha, sha256, unitId,
} from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { snapshotRequestOf, witnessDir } from '../src/git/snapshot.ts';
import { type ArcLaneDef, laneRevOf, parseObligations, parseRulingSidecar } from '../src/holistic/types.ts';
import { witnessRecordOf, writeWitnessRecord } from '../src/holistic/witness.ts';
import {
  RULINGS_INPUT, RULING_INPUT, commitRevisionNow, keepInput, keepInputFiles, keptPayload, readInputFiles, routingProvenanceOf,
} from '../src/input/inforce.ts';
import { parsePlan } from '../src/input/plan.ts';
import { canonicalJson } from '../src/core/json.ts';
import { ledgerAfter } from '../src/spec/rulings.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { executorIdentity } from '../src/pipeline/stages.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { provenanceStack, resolveRouting } from '../src/routing/layers.ts';
import { MODEL_IDS, type Triple, unitSeatRef } from '../src/routing/types.ts';
import { type Status, status } from '../src/status.ts';
import type { NeedsUserReason } from '../src/core/records.ts';
import { runOp } from './fixtures/git-common.ts';
import { auditArc } from './fixtures/audit-common.ts';
import { VISION, holisticArc, tipTree } from './fixtures/brake-common.ts';
import { ruleRecord } from './fixtures/publish-common.ts';
import { type ArcRun, contextFor, setupArc } from './fixtures/unit-common.ts';
import { commitAll, git, writeFiles } from './helpers/repo.ts';

const T = { timeout: 60_000 };
const U = (id: string): UnitId => unitId(id);
const CMD = commandId('cmd-00000000000000b9');
const OPUS_HIGH: Triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const FABLE_HIGH: Triple = { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' };

const statusOf = (r: ArcRun): Status => status(r.ctx.runDir, arcId(r.d.arc), r.ctx.hostDir);
/** No model id anywhere in a status but `spend` (the one render-time derivation): state.no-model-ids over the M3 keys. */
function noModelIds(s: Status): void {
  const text = JSON.stringify({ ...s, spend: null });
  for (const model of MODEL_IDS) assert.ok(!text.includes(model), `${model} in status outside spend.byModel`);
}

/** The arc lanes of the obligations file in force (the plan dir's). */
const lanesOf = (r: ArcRun): ReadonlyMap<string, ArcLaneDef> =>
  new Map(parseObligations(JSON.parse(readFileSync(join(r.ctx.planDir, 'obligations.json'), 'utf8'))).lanes.map((l) => [l.id as string, l]));

let spawns = 0;
/** A journey spawn of `lane` under `job` at `at` (its intent only): what a job's lane run opens. */
function journeySpawn(r: ArcRun, job: string, lane: ArcLaneDef, at: string): IntentOf<'proc.spawn'> {
  spawns += 1;
  const j = jobId(job.split('-')[0] as never, Number(job.split('-')[1]));
  const { op } = r.journal.begin({
    kind: 'proc.spawn', key: opKey(`lane:${job}:${lane.id}:${spawns}`), parent: { type: 'job', job: j }, deadlineAt: null,
    body: () => ({ expect: { subject: { purpose: 'journey', lane: lane.id, laneRev: laneRevOf(lane), at: sha(at), owner: { type: 'job', job: j } }, launchSha256: sha256('c'.repeat(64)) }, post: null }),
  });
  return r.journal.view.latestIntent(op) as IntentOf<'proc.spawn'>;
}

/** A witness run of `lane` on `tree` under `baseline-1` reporting `outcomes`: its record kept where the snapshot finds it, then `witnessed`. */
function witness(r: ArcRun, lane: ArcLaneDef, tree: string, outcomes: Readonly<Record<string, 'pass' | 'fail'>>, env = 'fedcba9876543210'): string {
  const spawn = journeySpawn(r, 'baseline-1', lane, git(r.d.repo, 'rev-parse', 'main'));
  const inv = invocationId(spawn.op, 1);
  const base = { lane: lane.id, laneRev: laneRevOf(lane), envId: envId(env), treeSha: sha(tree), inv, purpose: 'witness', for: { type: 'job', job: jobId('baseline', 1) } } as const;
  const dir = witnessDir(r.ctx.runDir, base);
  mkdirSync(dir, { recursive: true });
  const tests = Object.entries(outcomes).sort(([a], [b]) => (a < b ? -1 : 1)).map(([testId, outcome]) => ({ testId, selected: 1, outcome }));
  const recordsSha256 = writeWitnessRecord(dir, witnessRecordOf({ lane, envId: base.envId, treeSha: base.treeSha, inv, purpose: 'witness' }, tests));
  r.journal.fact({ kind: 'witnessed', ...base, recordsSha256 });
  return dir;
}

/** A unit's publication as its ff stage records it: `files` committed on main, the published `integration.ff`. Returns [old, new]. */
function publish(r: ArcRun, unit: string, files: Readonly<Record<string, string>>): readonly [Sha, Sha] {
  const old = sha(git(r.d.repo, 'rev-parse', 'main'));
  writeFiles(r.d.repo, files);
  const head = sha(commitAll(r.d.repo, `publish ${unit}`));
  const { op } = r.journal.begin({
    kind: 'integration.ff', key: opKey(`ff:${unit}`), parent: { type: 'stage', unit: U(unit), stage: 'ff', attempt: 1 }, deadlineAt: null,
    body: () => ({
      expect: { ref: 'refs/heads/main' as never, old, new: head, fingerprint: { unitCommit: head, specRev: 1 as never, contractRevs: [], rulingRevs: [] } }, post: null,
    }),
  });
  r.journal.done(op, 'integration.ff', { kind: 'published' }, null);
  return [old, head];
}

/** The vision sha in force (what a checkpoint's inputs record). */
const visionSha = (r: ArcRun) => r.journal.view.planApplied()!.visionSha256!;

function checkpointInputs(r: ArcRun, n: number, generation: number): void {
  const v = visionSha(r);
  r.journal.fact({
    kind: 'checkpoint-inputs', job: jobId('ckpt', n), trigger: { type: 'audit', job: jobId('audit', 1) }, generation,
    vector: { plan: planRev(r.journal.view.planApplied()!.rev), specs: {}, obligationsSha256: null, ledgerSha256: null, visionSha256: v, contracts: [] },
    headSha: sha(git(r.d.repo, 'rev-parse', 'main')), visionSha256: v, findings: [], observations: [],
  } as unknown as Fact);
}

const item = (r: ArcRun, reason: NeedsUserReason, blocking: boolean) => raiseNeedsUser(r.journal, r.ctx.runDir, {
  blocking, subject: { type: 'arc' }, reason, summary: reason, recommendation: 'look', options: [], evidence: [],
}, { type: 'arc' });
const ack = (r: ArcRun, id: ReturnType<typeof item>) => r.journal.fact({ kind: 'needs-user-acked', id, command: CMD, choice: null });

describe('status M3', () => {
  it('status.target: the cut line, the next milestone (R13), the critical path and counts; each non-exempt obligation now true or not yet, with its verdict on the head, the units it waits on, why and its evidence; waived with its ruling; the vision and its coverage', T, async () => {
    const { d } = holisticArc({
      steps: [], units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3', after: ['u2'] }], lanes: ['journey', 'other'], mapping: [], trees: {},
      obligations: [
        { id: 'I-1', testIds: ['t1'] },
        { id: 'I-2', activation: 'future', deliveredBy: ['u1'], testIds: ['t2'] },
        { id: 'I-3', activation: 'future', deliveredBy: ['u2', 'u3'], testIds: ['t3'] },
        { id: 'I-4', testIds: ['t4'], lane: 'other' },
        { id: 'I-5', testIds: ['t5'], state: { type: 'waived', ruling: 'C-1' } },
      ],
    });
    const r = contextFor(d);
    try {
      const tree = tipTree(d);
      const dir = witness(r, lanesOf(r).get('journey')!, tree, { t1: 'pass', t2: 'fail' });
      let s = statusOf(r);
      assert.equal(s.holistic, true);
      assert.deepEqual(s.nowTrue, [{ obligation: 'I-1', statement: 'I-1 holds.', activation: 'must-hold', verdict: 'held', evidence: [dir] }]);
      assert.deepEqual(s.notYetTrue, [
        { obligation: 'I-2', statement: 'I-2 holds.', activation: 'future', verdict: 'not-held', evidence: [dir], blockingUnits: ['u1'], reason: 'code' },
        { obligation: 'I-3', statement: 'I-3 holds.', activation: 'future', verdict: 'unwitnessed', evidence: [dir], blockingUnits: ['u2', 'u3'], reason: 'waiting-dep' },
        { obligation: 'I-4', statement: 'I-4 holds.', activation: 'must-hold', verdict: 'not-covered', evidence: [], blockingUnits: [], reason: 'spec' },
      ]);
      assert.deepEqual(s.target, {
        cutLine: 'the helpers ship', nextMilestone: { obligation: 'I-2', statement: 'I-2 holds.', unmerged: ['u1'] }, criticalPath: ['u2', 'u3'],
        obligations: { total: 5, nowTrue: 1, notYetTrue: 3, latched: 0, split: 0, waived: 1, deferred: 0, retired: 0 },
      });
      assert.deepEqual([s.waived, s.deferred], [[{ obligation: 'I-5', ruling: 'C-1' }], []]);
      assert.deepEqual(s.vision, {
        rev: 1, confirmation: null, clauses: VISION.clauses, questions: [], advances: ['V-1', 'V-2'],
        coverage: { unservedAdvanced: ['V-2'], horizon: [], obligationsServingNone: [], withdrawnCited: [] },
      });
      noModelIds(s);

      // I-2 latches (it is must-hold now, and no repair owns it); u2 is paused: I-3 waits on supervision first.
      r.journal.fact({ kind: 'obligation-latched', obligation: 'I-2', unit: U('u1'), treeSha: sha(tree) } as unknown as Fact);
      r.journal.fact({ kind: 'paused', command: CMD, target: { type: 'unit', unit: U('u2') } });
      s = statusOf(r);
      assert.deepEqual(s.notYetTrue.map((o) => [o.obligation, o.activation, o.blockingUnits, o.reason]), [
        ['I-2', 'must-hold', [], 'spec'], ['I-3', 'future', ['u2', 'u3'], 'supervision'], ['I-4', 'must-hold', [], 'spec'],
      ]);
      assert.deepEqual(s.target?.nextMilestone, { obligation: 'I-3', statement: 'I-3 holds.', unmerged: ['u2', 'u3'] });
      assert.equal(s.target?.obligations.latched, 1);
      // A new tree on the head: nothing is observed there, so nothing is true yet.
      writeFiles(d.repo, { 'src/extra.js': 'export const x = 1;\n' });
      commitAll(d.repo, 'move the head');
      s = statusOf(r);
      assert.deepEqual(s.nowTrue, []);
      assert.ok(s.notYetTrue.every((o) => o.verdict === 'not-covered' && o.evidence.length === 0));
    } finally {
      r.journal.close();
    }
  });

  it('status.strict-env: an observation from another environment than the one the executor recorded for the lane is not shown true (completion\'s rule)', T, async () => {
    const { d } = holisticArc({ steps: [], units: [{ id: 'u1' }], lanes: ['journey'], mapping: [], trees: {}, obligations: [{ id: 'I-1', testIds: ['t1'] }] });
    const r = contextFor(d);
    try {
      const journey = lanesOf(r).get('journey')!;
      const tree = tipTree(d);
      witness(r, journey, tree, { t1: 'pass' }, '0123456789abcdef');
      assert.deepEqual(statusOf(r).nowTrue.map((o) => o.obligation), ['I-1'], 'held in the environment the executor recorded');
      // The executor now witnesses the lane in another environment (on another tree): the head's observation is foreign.
      witness(r, journey, 'e'.repeat(40), { t1: 'pass' });
      const s = statusOf(r);
      assert.deepEqual(s.nowTrue, []);
      assert.deepEqual(s.notYetTrue.map((o) => [o.obligation, o.verdict]), [['I-1', 'not-covered']]);
      assert.ok(s.completion.unmet.includes('obligations-not-discharged'), JSON.stringify(s.completion.unmet));
    } finally {
      r.journal.close();
    }
  });

  it('status.findings-audit / status.coverage-per-lens: per lens in L its watermark follows audits and docs edges (pending until the gap closes), the uncovered range, the generation and running audit, checkpoint lane minutes; active findings and their metrics; the owed audit and the completion predicate', T, async () => {
    const { d } = auditArc({
      steps: [], units: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [], trees: {},
      audit: { lenses: ['invariants', 'vision'] },
    });
    const r = contextFor(d);
    try {
      const t0 = sha(git(d.repo, 'rev-parse', 'main'));
      const [, t1] = publish(r, 'u1', { 'src/one.js': 'export const one = 1;\n' });
      const v = visionSha(r);
      r.journal.fact({
        kind: 'audit-started', job: jobId('audit', 1), triggers: [{ type: 'cadence' }], generation: 1, lenses: ['invariants', 'vision'], integrationSha: t1,
        planRev: planRev(1), ledgerSha256: null, obligationsSha256: null, visionSha256: v, owners: [], priorFindings: [], highWater: r.journal.view.highWater(),
      } as unknown as Fact);
      let s = statusOf(r);
      assert.equal(s.audit?.running, 'audit-1');
      r.journal.fact({
        kind: 'finding-opened', id: 'F-1', key: sha256('1'.repeat(64)), lens: 'invariants', severity: 'P1', obligation: 'I-1', visionClauses: ['V-1'], claim: 'I-1 is broken',
        evidence: [{ path: 'src/one.js', blob: null }], mutant: null, source: { type: 'job', job: 'audit-1' }, gateHadPassed: true,
      } as unknown as Fact);
      r.journal.fact({ kind: 'audit-ended', job: jobId('audit', 1), covered: [{ lens: 'invariants', from: t0, to: t1 }], findings: ['F-1'], suppressed: 0, outcome: 'completed' } as unknown as Fact);
      const [, t2] = publish(r, 'u2', { 'src/two.js': 'export const two = 2;\n' });
      r.journal.fact({ kind: 'docs-covered', pub: jobId('docs', 1), from: t1, to: t2 } as unknown as Fact);

      s = statusOf(r);
      assert.deepEqual(s.audit?.lenses, ['invariants', 'vision']);
      assert.deepEqual(s.audit?.coverage, [
        { lens: 'invariants', coveredTo: t2, outstanding: false, pendingDocs: [] },
        { lens: 'vision', coveredTo: t0, outstanding: true, pendingDocs: [{ pub: 'docs-1', from: t1, to: t2 }] },
      ]);
      assert.deepEqual(s.audit?.uncovered, [{ lens: 'vision', from: t0, to: t2 }]);
      assert.deepEqual([s.audit?.generation, s.audit?.running, s.audit?.checkpointLaneMinutes], [1, null, 0]);
      assert.deepEqual(s.findings.active, [{ id: 'F-1', lens: 'invariants', severity: 'P1', state: 'open', owner: null, obligation: 'I-1', claim: 'I-1 is broken' }]);
      assert.deepEqual(s.findings.metrics, [{ id: 'F-1', lens: 'invariants', severity: 'P1', gateHadPassed: true, disposition: null, merged: false, timeToResolveMs: null }]);

      // A checkpoint of generation 1 runs a lane; an audit-owed item is raised: the completion predicate (the scheduler's
      // `completionBlockers`) names every gap, the running checkpoint among them.
      checkpointInputs(r, 1, 1);
      journeySpawn(r, 'ckpt-1', lanesOf(r).get('journey')!, t2);
      const owed = item(r, 'audit-owed', false);
      await sleep(30);
      s = statusOf(r);
      assert.ok((s.audit?.checkpointLaneMinutes ?? 0) > 0, 'a running checkpoint lane counts to now');
      assert.deepEqual(s.owed, { audits: [owed] });
      assert.deepEqual(s.completion.unmet, [
        'units-open', 'baseline-owed', 'coverage-outstanding', 'checkpoint-pending', 'generation-not-quiescent', 'close-out', 'obligations-not-discharged',
      ]);
      r.journal.fact({ kind: 'bundle-decided', job: jobId('ckpt', 1), outcome: { kind: 'no-op' } } as unknown as Fact);
      ack(r, owed);
      s = statusOf(r);
      assert.deepEqual(s.owed, { audits: [] });
      assert.deepEqual(s.completion.unmet, ['units-open', 'baseline-owed', 'coverage-outstanding', 'close-out', 'obligations-not-discharged'], 'a no-op checkpoint makes generation 1 quiescent');
      assert.equal(s.run.state, 'no-owner', 'a holistic arc is complete only through arc-completed');
      noModelIds(s);
    } finally {
      r.journal.close();
    }
  });

  it('status.decisions-since / status.divergences-since-ack: a bundle\'s ruling, revision and cut and its divergences are listed with who ruled; the digest binding them shows on each; acknowledging it clears both lists; a later divergence starts the next; the convergence counter counts the bundle against K', T, async () => {
    const { d } = holisticArc({ steps: [], units: [{ id: 'u1' }, { id: 'u2' }], obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [], trees: {} });
    const r = contextFor(d);
    try {
      let s = statusOf(r);
      assert.deepEqual([s.decisionsSince, s.divergences], [[], []], 'the arc\'s first revision decides nothing');
      assert.deepEqual(s.convergence, { k: 3, counter: 0, since: 0, open: [] });

      checkpointInputs(r, 1, 1);
      const record = ruleRecord(r, 'C-2', { ruledBy: { type: 'checkpoint', job: 'ckpt-1' }, cites: ['V-1'], evidence: ['scripted evidence'], statement: 'Keep helpers pure.' });
      const rulingSha = keepInput(r.ctx.runDir, Buffer.from(`${JSON.stringify(record)}\n`), RULING_INPUT);
      const prev = keptPayload(r.ctx.runDir, r.journal.view.planApplied()!.payloadSha256!);
      // The revision lands C-2 in the ledger with its sidecar, as `rule` and a bundle's activation do.
      const ledgerText = readFileSync(join(r.ctx.runDir, 'inputs', `${prev.manifest.rulings.ledgerSha256}.${RULINGS_INPUT}`), 'utf8');
      const ledgerSha256 = keepInput(r.ctx.runDir, Buffer.from(ledgerAfter(ledgerText, parseRulingSidecar(record))), RULINGS_INPUT);
      const draft = (what: string) => ({
        job: jobId('ckpt', 1), type: 'interpretation', from: 'V-1', what, cites: ['V-1'], evidence: ['scripted evidence'],
        preimage: { planRev: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] }, compensation: { hint: 'nothing to undo', kind: 'none' },
      }) as const;
      commitRevisionNow(r.journal, r.ctx.runDir, {
        ...prev, source: { type: 'bundle', job: jobId('ckpt', 1) }, base: planRev(1), rev: planRev(2),
        manifest: { ...prev.manifest, rulings: { ledgerSha256, sidecars: { ...prev.manifest.rulings.sidecars, 'C-2': rulingSha } } },
        changes: [{ type: 'unit-cut', unit: U('u2') }, { type: 'limits', unit: null }], dispositions: [],
        divergences: [draft('trust means tested'), draft('helpers stay small')],
      } as unknown as RevisionPayload, { type: 'job', job: jobId('ckpt', 1) });

      s = statusOf(r);
      const checkpoint = { type: 'checkpoint', job: 'ckpt-1' };
      assert.deepEqual(s.decisionsSince.map((x) => [x.kind, x.id, x.oneLine, x.ruledBy]), [
        ['ruling', 'C-2', 'Keep helpers pure.', checkpoint],
        ['bundle', 'ckpt-1', 'plan rev 2: unit-cut u2, limits', checkpoint],
        ['cut', 'u2', 'u2 cut (plan rev 2)', checkpoint],
        ['divergence', 'D-1', 'interpretation: trust means tested', checkpoint],
        ['divergence', 'D-2', 'interpretation: helpers stay small', checkpoint],
      ]);
      assert.deepEqual(s.divergences.map((x) => [x.id, x.bundle, x.cites, x.evidence, x.compensation, x.digest]), [
        ['D-1', 'ckpt-1', ['V-1'], ['scripted evidence'], { hint: 'nothing to undo', kind: 'none' }, null],
        ['D-2', 'ckpt-1', ['V-1'], ['scripted evidence'], { hint: 'nothing to undo', kind: 'none' }, null],
      ]);
      assert.deepEqual(s.convergence, { k: 3, counter: 1, since: 0, open: [] });
      assert.deepEqual(s.vision?.coverage.withdrawnCited, []);

      const digest = item(r, 'divergence-digest', false);
      r.journal.fact({ kind: 'divergence-digest', needsUser: digest, ids: ['D-1', 'D-2'] } as unknown as Fact);
      assert.deepEqual(statusOf(r).divergences.map((x) => [x.id, x.digest]), [['D-1', digest], ['D-2', digest]], 'an open digest binds them');
      const bound = item(r, 'convergence-bound', false);
      assert.deepEqual(statusOf(r).convergence, { k: 3, counter: 1, since: 0, open: [bound] });
      ack(r, digest);
      ack(r, bound);
      s = statusOf(r);
      assert.deepEqual([s.divergences, s.decisionsSince], [[], []], 'the acknowledged digest covers them, and nothing was decided since');
      assert.deepEqual([s.convergence?.counter, s.convergence?.open], [0, []], 'acknowledging the bound resets the counter');
      assert.ok((s.convergence?.since ?? 0) > 0);

      checkpointInputs(r, 2, 2);
      r.journal.fact({ kind: 'bundle-decided', job: jobId('ckpt', 2), outcome: { kind: 'no-op' } } as unknown as Fact);
      r.journal.fact({ kind: 'divergence', id: 'D-3', index: 0, ...draft('a later reading'), job: jobId('ckpt', 2) } as unknown as Fact);
      s = statusOf(r);
      assert.deepEqual(s.decisionsSince.map((x) => [x.kind, x.id, x.ruledBy]), [['divergence', 'D-3', { type: 'checkpoint', job: 'ckpt-2' }]]);
      assert.deepEqual(s.divergences.map((x) => [x.id, x.digest]), [['D-3', null]]);
      noModelIds(s);
    } finally {
      r.journal.close();
    }
  });

  it('status.completion-sealed: arc-completed makes a holistic arc complete (active); its terminal snapshot seals it; a pending command unseals it and is an unmet condition', T, async () => {
    const { d } = holisticArc({ steps: [], obligations: [], mapping: [], trees: {} });
    const r = contextFor(d);
    try {
      let s = statusOf(r);
      assert.deepEqual([s.run.state, s.completion.active, s.completion.sealed, s.completion.notSealed], ['no-owner', false, false, 'not completed']);
      const head = sha(git(d.repo, 'rev-parse', 'main'));
      r.journal.fact({ kind: 'arc-completed', planRev: planRev(1), head, highWater: r.journal.view.highWater(), units: [] } as unknown as Fact);
      s = statusOf(r);
      assert.equal(s.run.state, 'complete');
      assert.deepEqual([s.completion.planRev, s.completion.head, s.completion.active, s.completion.sealed], [1, head, true, false]);
      assert.match(s.completion.notSealed ?? '', /terminal snapshot is not published/);
      await runOp(r.journal, snapshotPublishOp(absPath(d.repo)), `snapshot:${d.arc}`, snapshotRequestOf({
        view: r.journal.view, runDir: r.ctx.runDir, identity: executorIdentity(), message: `roadmap ${d.arc}: terminal snapshot\n`,
      }));
      s = statusOf(r);
      assert.deepEqual([s.completion.sealed, s.completion.notSealed], [true, null]);
      submitCommand(r.ctx.runDir, arcId(d.arc), { type: 'pause', target: { type: 'all' } });
      s = statusOf(r);
      assert.equal(s.completion.sealed, false);
      assert.match(s.completion.notSealed ?? '', /pending commands cmd-/);
      assert.ok(s.completion.unmet.includes('pending-commands'));
      assert.equal(s.commands.pending.length, 1, 'pendingCommandIds lists it');
      noModelIds(s);
    } finally {
      r.journal.close();
    }
  });

  it('status.log-size: host.log states the event log\'s bytes and events and the fold\'s time, and grows with the log', T, () => {
    const { d } = holisticArc({ steps: [], obligations: [], mapping: [], trees: {} });
    const r = contextFor(d);
    try {
      const size = () => statSync(join(r.ctx.runDir, 'events.jsonl')).size;
      let s = statusOf(r);
      assert.deepEqual([s.host.log.bytes, s.host.log.events, s.host.log.compactionDue], [size(), readJournal(r.ctx.runDir, arcId(d.arc)).events.length, false]);
      assert.ok(Number.isInteger(s.host.log.foldMs) && s.host.log.foldMs >= 0);
      const before = s.host.log;
      r.journal.fact({ kind: 'executor-started', generation: 2 });
      s = statusOf(r);
      assert.deepEqual([s.host.log.events, s.host.log.bytes], [before.events + 1, size()]);
      assert.ok(s.host.log.bytes > before.bytes);
    } finally {
      r.journal.close();
    }
  });

  it('status.non-holistic-arc: an arc without the holistic layer renders its holistic keys vacuous and its spend by model from its revision\'s recorded provenance', T, () => {
    const d = setupArc({ steps: [], units: [{ id: 'u1' }] });
    const r = contextFor(d);
    try {
      const rev = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: null, unit: null }).rev;
      const inv = invocationId(r.journal.begin({
        kind: 'proc.spawn', key: opKey('build:u1'), parent: { type: 'stage', unit: U('u1'), stage: 'build', attempt: 1 }, deadlineAt: null,
        body: () => ({ expect: { subject: { purpose: 'backend', routingRev: rev, unit: U('u1'), attempt: 1, role: 'build', tier: 'med' }, launchSha256: sha256('c'.repeat(64)) }, post: null }),
      }).op, 1);
      r.journal.fact({
        kind: 'meter', inv, routingRev: rev, subject: { type: 'seat', role: 'build', tier: 'med', unit: U('u1'), attempt: 1 },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, turns: null, costUsd: null },
      });
      const s = statusOf(r);
      assert.deepEqual([s.holistic, s.target, s.vision, s.audit, s.convergence], [false, null, null, null, null]);
      assert.deepEqual([s.nowTrue, s.notYetTrue, s.waived, s.deferred, s.divergences, s.decisionsSince, s.findings, s.owed], [[], [], [], [], [], [], { active: [], metrics: [] }, { audits: [] }]);
      assert.deepEqual(s.completion, { planRev: null, head: null, active: false, sealed: false, notSealed: 'not completed', unmet: ['units-open'] });
      assert.deepEqual(s.spend.byModel, { models: [{ model: 'gpt-5.6-luna', calls: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0, unavailable: 0 }], unresolvedRevs: [] });
      assert.equal(s.routing?.rev, rev);
      noModelIds(s);
    } finally {
      r.journal.close();
    }
  });
});

describe('status: dev.6 routing revs (K12, OR-L3)', () => {
  it('status.dev6-alias: a dev.6 revision\'s recorded routingRev joins its meter rows to the revision\'s current table: totals equal the meter\'s, nothing unresolved, byModel on today\'s bindings', T, () => {
    const d = setupArc({ steps: [], units: [{ id: 'u1', risk: 'high' }] });
    const r = contextFor(d);
    try {
      // Revision 2 as dev.6 recorded it: revision 1's payload and ledger, and its routing provenance.
      const plan = parsePlan(JSON.parse(readFileSync(d.planPath, 'utf8')));
      const provenance = routingProvenanceOf({ profile: 'default', config: null }, plan);
      const first = r.journal.view.planApplied()!;
      r.journal.fact({
        kind: 'plan-applied', rev: planRev(2), command: null, ...keepInputFiles(r.ctx.runDir, readInputFiles(absPath(d.planPath))), changes: [],
        source: { type: 'start' }, payloadSha256: first.payloadSha256, rulingsSha256: first.rulingsSha256, routingProvenance: provenance,
      });
      // The rev dev.6 recorded: the M2 table under its catalogue (frontier Opus high, summit Fable high), by hand.
      const now = resolveRouting(provenanceStack(provenance, 'none', null));
      const dev6Triple = (t: Triple): Triple => (t.model === 'claude-opus-5-5' ? (t.effort === 'xhigh' ? FABLE_HIGH : OPUS_HIGH) : t);
      const dev6Table = Object.fromEntries((['planCheck', 'build', 'gate'] as const).map((role) => [role, Object.fromEntries(Object.entries(now.table[role]).map(([tier, t]) => [tier, dev6Triple(t)]))]));
      const dev6Rev = routingRev(createHash('sha256').update(canonicalJson(dev6Table)).digest('hex').slice(0, 16));
      assert.notEqual(dev6Rev, now.rev, 'the catalogue moved the rev');
      const meter = (n: number, rev: RoutingRev, role: 'build' | 'gate', tier: 'med' | 'high' | 'escalation', input: number): void => {
        const inv = invocationId(r.journal.begin({
          kind: 'proc.spawn', key: opKey(`dev6:${n}`), parent: { type: 'stage', unit: U('u1'), stage: role === 'build' ? 'build' : 'gate', attempt: n }, deadlineAt: null,
          body: () => ({ expect: { subject: { purpose: 'backend', routingRev: rev, unit: U('u1'), attempt: n, ...unitSeatRef(role, tier) }, launchSha256: sha256('c'.repeat(64)) }, post: null }),
        }).op, 1);
        r.journal.fact({
          kind: 'meter', inv, routingRev: rev, subject: { type: 'seat', ...unitSeatRef(role, tier), unit: U('u1'), attempt: n },
          usage: { inputTokens: input, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, turns: null, costUsd: null },
        });
      };
      meter(1, dev6Rev, 'build', 'high', 100);
      meter(2, dev6Rev, 'gate', 'escalation', 20);
      meter(3, now.rev, 'build', 'med', 5);
      const s = statusOf(r);
      // Totals: every metered call renders by model.
      const byRole = s.spend.byRole.reduce((n, t) => n + t.input, 0);
      assert.equal(byRole, 125);
      assert.equal(s.spend.byModel.models.reduce((n, m) => n + m.input, 0), byRole, 'byModel totals equal the meter\'s');
      // Unresolved: none; the dev.6 rev resolves through its alias.
      assert.deepEqual(s.spend.byModel.unresolvedRevs, []);
      // byModel: the dev.6 spend on today's bindings (Opus 5.5 for frontier and summit), never Fable.
      assert.deepEqual(s.spend.byModel.models.map((m) => [m.model, m.calls, m.input]), [['claude-opus-5-5', 2, 120], ['gpt-5.6-luna', 1, 5]]);
      noModelIds(s);
    } finally {
      r.journal.close();
    }
  });
});
