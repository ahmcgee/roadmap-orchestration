// M3 step A4: the docs publication (src/pipeline/publish.ts) and `roadmap rule` (src/commands/rule.ts), over real arcs
// (real git, real processes, fake backends). Named tests: rule.publish, rule.red-rejected, rule.queued-abandons-candidate,
// publish.green-not-preempted, docs.transient, publish.obligation-must-hold (G12), publish.finding-blocked (G10), and the
// crash cells of the matrix rows DOCS_PUBLICATION and PREEMPT (test/matrix.ts), recovered by the recovery engine.
// Checkpoint A fixes: publish.lane-evidence-immutable, publish.checkout-integrity, rule.dispositions-applied (with
// startup.pending-write-back).
// dev.16: publish.vision-edit (a vision edit publishes the vision files onto integration).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { applyCommand, evaluateApply } from '../src/commands/apply.ts';
import { readReceipt, submitCommand } from '../src/commands/queue.ts';
import type { Fact, IntentOf, IntentRecord, PlanAppliedFact } from '../src/core/events.ts';
import { INTEGRATION_SLOT, findingId, invocationDirName, jobId, laneId, obligationId, sha, sha256, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { bytesSha256 } from '../src/spec/spec.ts';
import { changedPaths } from '../src/git/docs.ts';
import { git as rawGit } from '../src/git/git.ts';
import { jobLaneDir, verifySnapshot } from '../src/git/snapshot.ts';
import { isExempt } from '../src/holistic/types.ts';
import { readInputFiles, requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { corpusPin } from '../src/commands/corpus.ts';
import { sha256Hex } from '../src/core/json.ts';
import { settlePlan } from '../src/preflight/checks.ts';
import { docsTransientViolations } from '../src/git/transient.ts';
import { laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { reached } from './helpers/barrier.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll, git, tmpDir } from './helpers/repo.ts';
import { PIN_FILE, VISION_DOC } from './helpers/corpusarc.ts';
import { VISION_PATH, setupCorpusArc } from './fixtures/corpus-unit.ts';
import { readCalls } from './helpers/scenario.ts';
import { witnessLaneArgv, writeWitnessControl } from './helpers/witness.ts';
import { DOCS_PUBLICATION, PREEMPT, crashCells } from './matrix.ts';
import { API_OP, barrierSuite, closedAs, publishArc, ruleRecord, submitRule, wire } from './fixtures/publish-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import {
  type ArcDescriptor, type ArcOptions, type ArcRun, U1, appendSteps, applyBody, codexStep, contextFor, gateStep, isGateCall, mulBuild, outcomes, stepUntil,
  visionApplyBody,
} from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

const facts = (r: ArcRun): readonly Fact[] => readJournal(r.ctx.runDir, r.journal.view.arc).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const applied = (r: ArcRun): readonly PlanAppliedFact[] => facts(r).flatMap((f) => (f.kind === 'plan-applied' ? [f] : []));
const head = (d: ArcDescriptor): string => git(d.repo, 'rev-parse', 'main');
const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const show = (d: ArcDescriptor, at: string, path: string): string => git(d.repo, 'show', `${at}:${path}`);
const slotState = (r: ArcRun): string => resourceTable(r.journal.view).get(INTEGRATION_SLOT)?.status.state ?? 'free';
const docsFfs = (r: ArcRun): readonly IntentOf<'integration.ff'>[] => r.journal.view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'docs');
const checkouts = (r: ArcRun): readonly string[] => {
  const dir = join(r.ctx.plan().worktreeRoot, r.ctx.plan().arc);
  return existsSync(dir) ? git(r.d.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ') && l.includes('.checkout')) : [];
};

/** Wakes the arbiter as the scheduler's loop does: a released slot is granted to its next waiter. */
function ticking(w: Readonly<{ arbiter: Readonly<{ wake: () => void }> }>): () => void {
  const timer = setInterval(() => w.arbiter.wake(), 50);
  return () => clearInterval(timer);
}

/** What every published rule leaves: its revision, its docs ff to exactly its commit, the snapshot, the slot free. */
function assertPublished(r: ArcRun, id: string, pub: string, tip: string, atHead = true): PlanAppliedFact {
  const fact = applied(r).find((f) => f.command === id)!;
  assert.deepEqual([fact.command, fact.source], [id, { type: 'command', command: id }]);
  assert.ok(fact.publication !== undefined, 'the revision names its publication');
  assert.equal(fact.publication.pub, pub);
  if (atHead) assert.equal(head(r.d), fact.publication.head, 'integration is at the published docs commit');
  else git(r.d.repo, 'merge-base', '--is-ancestor', fact.publication.head, 'main');
  assert.deepEqual(parentsOf(r.d.repo, fact.publication.head), [tip], 'the docs commit sits on the tip it was built on');
  const ff = docsFfs(r).find((i) => i.expect.subject?.type === 'docs' && i.expect.subject.pub === pub)!;
  assert.deepEqual([ff.expect.old, ff.expect.new], [tip, fact.publication.head], 'the exact expected integration update');
  assert.equal(r.journal.view.doneOf(ff.op)?.kind, 'integration.ff');
  const snap = r.journal.view.opsOf('snapshot.publish').find((i) => i.parent.type === 'job' && i.parent.job === pub);
  assert.ok(snap !== undefined && r.journal.view.doneOf(snap.op) !== null, 'the snapshot after the activation');
  assert.equal(verifySnapshot(absPath(r.d.repo), sha(git(r.d.repo, 'rev-parse', `refs/roadmap/${r.d.arc}`))).kind, 'verified');
  assert.equal(slotState(r), 'free', 'the slot is released');
  assert.deepEqual(checkouts(r), [], 'the docs checkout is removed');
  assert.equal(readReceipt(r.ctx.runDir, id as never, 'applied')?.state, 'applied');
  return fact;
}

// ---------------------------------------------------------------------------------------------------
// rule

test('rule.publish: a ruling with a contract op lands through its docs publication: constraints.md and the edited contract in one commit on the tip, lanes on it, ff, activation, snapshot; nothing written into the owner\'s files; a `C-?` record takes the next id', T, async () => {
  const d = publishArc({ steps: [] });
  const r = contextFor(d);
  const w = wire(r);
  try {
    const tip = head(d);
    const file = submitRule(r, ruleRecord(r, 'C-2', API_OP));
    const outcome = await applyCommand(w.commands, file);
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const fact = assertPublished(r, file.id, 'docs-1', tip);
    assert.equal(fact.rev, 2);
    const at = fact.publication!.head;
    assert.deepEqual(changedPaths(absPath(d.repo), sha(tip), sha(at)), ['.roadmap/constraints.md', 'contracts/api.md']);
    assert.match(show(d, at, '.roadmap/constraints.md'), /C-2/);
    const api = show(d, at, 'contracts/api.md');
    assert.match(api, /^<!-- revised by C-2 -->\n/);
    assert.match(api, /the sum of two finite numbers/);
    // Its lanes ran on the docs commit under job{docs-1}, spawned as journeys.
    const lanes = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey');
    assert.deepEqual(lanes.map((i) => [i.expect.subject.purpose === 'journey' && i.expect.subject.lane, i.expect.subject.purpose === 'journey' && i.expect.subject.at, i.parent]),
      [['suite', at, { type: 'job', job: 'docs-1' }]]);
    assert.equal(facts(r).filter((f) => f.kind === 'docs-covered').length, 0, 'a publication carrying contract ops is not docs-only (A17)');
    // The ledger in force holds the ruling; the owner's ledger is never written, nor a sidecar beside it.
    const inForce = revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view));
    assert.match(inForce.ledger.bytes.toString('utf8'), /^C-2 — Helpers take finite numbers only\.$/m);
    assert.doesNotMatch(readFileSync(join(d.planPath, '..', 'rulings.md'), 'utf8'), /C-2/);
    assert.ok(!existsSync(join(d.planPath, '..', 'rulings.md.d', 'C-2.json')));
    // A second ruling, unnumbered, takes the next id when it lands; the receipt names it.
    const second = submitRule(r, ruleRecord(r, 'C-?', { statement: 'Helpers never round.' }));
    const again = await applyCommand(w.commands, second);
    assert.equal(again.kind, 'applied', JSON.stringify(again));
    assert.equal(applied(r).at(-1)!.publication?.pub, 'docs-2');
    const receipt = readReceipt(r.ctx.runDir, second.id, 'applied');
    assert.ok(receipt?.state === 'applied' && receipt.verified.some((v) => / numbered C-3$/.test(v)), JSON.stringify(receipt));
    assert.match(revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view)).ledger.bytes.toString('utf8'), /^C-3 — Helpers never round\.$/m);
    assert.deepEqual(r.journal.view.openIntents(), []);
  } finally {
    r.journal.close();
  }
});

test('apply.ruling-for-added-unit (paid M4b run 3, OP-2): `apply --ruling` with a ruling applying to a unit the same apply adds lands through its docs publication, as its dry run said', T, async () => {
  const d = publishArc({ steps: [] });
  const r = contextFor(d);
  const w = wire(r);
  try {
    const dir = join(d.planPath, '..');
    writeFileSync(join(dir, 'u2.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(dir, 'u1.json'), 'utf8')) as Json), unit: 'u2', rev: 1 }));
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as Json & { units: Json[] };
    writeFileSync(d.planPath, JSON.stringify({ ...plan, units: [...plan.units, { ...plan.units[0]!, id: 'u2', spec: 'u2.json' }] }));
    const path = join(tmpDir('apply-ruling'), 'C-2.json');
    const bytes = Buffer.from(`${JSON.stringify(ruleRecord(r, 'C-2', { statement: 'u2 keeps the helpers pure.', appliesTo: { type: 'units', units: ['u2'] } }), null, 2)}\n`, 'utf8');
    writeFileSync(path, bytes);
    const rulings = [{ path: absPath(path), sha256: bytesSha256(bytes) }];
    const c = w.commands;
    const dry = await evaluateApply({
      runDir: c.runDir, view: r.journal.view, hostDir: c.hostDir, repo: c.repo, planFile: c.planFile, routingBase: c.routingBase, laneEnv: c.laneEnv, manifest: null, base: null, rulings, visionEdit: false,
    });
    assert.equal(dry.kind, 'accepted', JSON.stringify(dry));
    const tip = head(d);
    const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { ...applyBody(d), rulings } as never);
    const outcome = await applyCommand(c, file);
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const fact = assertPublished(r, file.id, 'docs-1', tip);
    assert.deepEqual(fact.changes.filter((x) => x.type === 'unit-added'), [{ type: 'unit-added', unit: 'u2' }]);
    assert.match(show(d, fact.publication!.head, '.roadmap/constraints.md'), /C-2/);
  } finally {
    r.journal.close();
  }
});

test('rule.red-rejected: a docs candidate whose suite is red is refused before any ff; a stale consistency or a ruling that is not the next id of the ledger is refused before any revision', T, async () => {
  const d = publishArc({ steps: [], base: 'red' });
  const r = contextFor(d);
  const w = wire(r);
  try {
    const tip = head(d);
    const ledger = readFileSync(join(d.planPath, '..', 'rulings.md'), 'utf8');
    const file = submitRule(r, ruleRecord(r, 'C-2'));
    const outcome = await applyCommand(w.commands, file);
    assert.equal(outcome.kind, 'rejected');
    assert.ok(outcome.kind === 'rejected');
    assert.match(outcome.reason, /docs publication docs-1: suite lane suite is fail on the docs candidate/);
    assert.equal(applied(r).length, 1, 'nothing is in force');
    assert.equal(head(d), tip, 'integration never moved');
    assert.deepEqual(docsFfs(r), [], 'no docs ff');
    const commit = r.journal.view.opsOf('revision.commit').at(-1)!;
    assert.equal(r.journal.view.doneOf(commit.op), null, 'the revision commit is aborted');
    assert.equal(slotState(r), 'free');
    assert.deepEqual(checkouts(r), []);
    assert.equal(readFileSync(join(d.planPath, '..', 'rulings.md'), 'utf8'), ledger, 'nothing is written back');

    const stale = ruleRecord(r, 'C-2');
    (stale['consistency'] as Json)['judgedRevs'] = { ...((stale['consistency'] as Json)['judgedRevs'] as Json), ledgerSha256: 'b'.repeat(64) };
    const refused = await applyCommand(w.commands, submitRule(r, stale));
    assert.ok(refused.kind === 'rejected' && /C-2's consistency is stale: judged ledgerSha256/.test(refused.reason), JSON.stringify(refused));
    const wrongId = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-5')));
    assert.ok(wrongId.kind === 'rejected' && /C-5 is not the ledger's next id \(C-2\)/.test(wrongId.reason), JSON.stringify(wrongId));
    assert.equal(r.journal.view.opsOf('revision.commit').length, 2, 'the refused records never began a revision');
  } finally {
    r.journal.close();
  }
});

test('rule.queued-abandons-candidate: a rule queued while a candidate holds the slot before green preempts it (preempted, uncharged); the docs publish first, then the unit merges without a new gate', T, async () => {
  const barrier = tmpDir('barrier');
  const d = publishArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], suite: [barrierSuite(barrier)] });
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    const tip = head(d);
    const unit = runUnit(w.stage, r.unit('u1'), admitAll);
    await reached(barrier, 'lane', 120_000);
    const file = submitRule(r, ruleRecord(r, 'C-2'));
    const outcome = await applyCommand(w.commands, file);
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    assert.deepEqual(await unit, { kind: 'merged' });
    const fact = assertPublished(r, file.id, 'docs-1', tip, false);
    const docsHead = fact.publication!.head;
    const seq = outcomes(d);
    const pre = seq.indexOf('candidate:preempted');
    assert.ok(pre !== -1, seq.join(' '));
    assert.deepEqual(seq.slice(pre), ['candidate:preempted', 'candidate:green', 'ff:published', 'snapshot:published', ...seq.slice(pre + 4)]);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'a preemption is uncharged');
    const kills = r.journal.view.opsOf('proc.kill').filter((k) => k.expect.reason === 'preempt');
    assert.equal(kills.length, 1, 'the candidate\'s suite lane was killed with reason preempt');
    assert.ok(r.journal.view.doneOf(kills[0]!.op) !== null);
    const unitFf = r.journal.view.opsOf('integration.ff').find((i) => i.expect.subject === undefined)!;
    assert.equal(unitFf.expect.old, docsHead, 'the unit published onto the docs commit');
    assert.deepEqual(facts(r).flatMap((f) => (f.kind === 'docs-covered' ? [[f.pub, f.from, f.to]] : [])), [['docs-1', tip, docsHead]], 'a docs-only publication covers its own edge (A17)');
    assert.equal(readCalls(d.scenarioPath).filter(isGateCall).length, 1, 'no new gate');
    assert.deepEqual(r.journal.view.openIntents(), []);
  } finally {
    stop();
    r.journal.close();
  }
});

test('publish.green-not-preempted: once a candidate is green its ff and snapshot complete first; the docs publication then runs on the new tip', T, async () => {
  const d = publishArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const tip = head(d);
    // Judged at the tip before the unit publishes: its publication waits behind the unit's chain, and, the unit
    // touching none of the revisions it judged (the head is provenance only), publishes on the new tip.
    const file = submitRule(r, ruleRecord(r, 'C-2'));
    const early = applyCommand(w.commands, file);
    await sleep(1_000);
    assert.equal(r.journal.view.opsOf('docs.commit').length, 0, 'the docs publication waits for the green publication');
    assert.ok(!outcomes(d).includes('candidate:preempted'));
    assert.equal(slotState(r), 'running', 'the unit\'s publication still holds the slot');
    assert.deepEqual(await runUnit(w.stage, r.unit('u1'), admitAll), { kind: 'merged' });
    const merged = r.journal.view.opsOf('integration.ff').find((i) => i.expect.subject === undefined)!.expect.new;
    const outcome = await early;
    assert.notEqual(merged, tip);
    assert.deepEqual(outcomes(d).slice(-3), ['candidate:green', 'ff:published', 'snapshot:published'], 'the chain was never preempted');
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    assertPublished(r, file.id, 'docs-1', merged);
  } finally {
    stop();
    r.journal.close();
  }
});

test('docs.transient: a docs publication\'s diff is exactly its rendered files and its contract ops\' paths; a unit dispatched under dev.6 may not touch the in-tree .roadmap/', T, async () => {
  // C-2 rewrites contracts/api.md, which u1 cites: its plan-check answers the stale link (dev.17 propagation).
  const answered = planCheckStep(
    { decision: 'approve', staleLinks: [{ link: 'contract:contracts/api.md', outcome: 'confirmed', reason: 'mul does not depend on how sums are stated' }] },
    { stdinContains: ['<stale_links>', 'contract:contracts/api.md'] },
  );
  const d = publishArc({ steps: [answered, mulBuild({ '.roadmap/constraints.md': 'hand-written\n' })] });
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    const tip = head(d);
    const outcome = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2', API_OP)));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    const at = head(d);
    const diff = changedPaths(absPath(d.repo), sha(tip), sha(at));
    assert.deepEqual(diff, ['.roadmap/constraints.md', 'contracts/api.md']);
    assert.deepEqual(docsTransientViolations(diff, diff), []);
    assert.deepEqual(docsTransientViolations(diff, [diff[0]!]).map((v) => [v.path, v.rule]), [['contracts/api.md', 'not-docs']]);
    // The unit (dispatched on the published tip) overwrites the rendered constraints.md: refused at its candidate, a
    // fix round restores the executor's rendering, then it merges.
    appendSteps(d, [
      gateStep({ decision: 'approve' }),
      codexStep([{ type: 'commit', message: 'restore the roadmap file', files: { '.roadmap/constraints.md': rawGit(absPath(d.repo), ['show', `${at}:.roadmap/constraints.md`]) } }], {
        argv: ['exec', 'resume'], stdinContains: ['.roadmap/constraints.md (roadmap-dir)'],
      }),
      gateStep({ decision: 'approve' }),
    ]);
    assert.deepEqual(await runUnit(w.stage, r.unit('u1'), admitAll), { kind: 'merged' }, outcomes(d).join(' '));
    assert.ok(outcomes(d).includes('candidate:transient-violation'), outcomes(d).join(' '));
    assert.equal(show(d, 'main', '.roadmap/constraints.md'), show(d, at, '.roadmap/constraints.md'), 'only the executor wrote the in-tree .roadmap/');
  } finally {
    stop();
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// G12, G10 in a holistic arc

const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Arithmetic helpers anyone can trust.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'world', text: 'A developer calls add or mul and gets the exact answer, every time.', rank: null, state: 'active' },
  ],
  questions: [],
};

/**
 * A holistic arc whose one obligation I-1 is witnessed by a fake jsonl lane scripted per test id (every tree alike);
 * `declare`: u1's spec declares I-1 (its approval then selects it).
 */
function holisticArc(steps: ArcOptions['steps'], scripted: Readonly<Record<string, 'pass' | 'fail'>>, declare = false, suite?: ArcOptions['suite']): ArcRun {
  const d = publishArc({ steps, ...(suite === undefined ? {} : { suite }) }, (x) => {
    const planDir = join(x.planPath, '..');
    const control = join(tmpDir('witness-control'), 'control.json');
    writeWitnessControl(control, { trees: { '*': { outcomes: scripted } } });
    const journey = { id: 'journey', argv: witnessLaneArgv('jsonl', tmpDir('witness-lane'), control), cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'jsonl' };
    const laneRev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [journey], obligations: [], mapping: { paths: [] } }).lanes[0]!);
    writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION));
    writeFileSync(join(planDir, 'obligations.json'), JSON.stringify({
      schema: 'roadmap/obligations-m3', cutLine: 'mul ships', lanes: [journey], mapping: { paths: [] },
      obligations: [{
        id: 'I-1', rev: 1, statement: 'add adds.', docRef: { path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module' }, serves: ['V-1'],
        witness: { lane: 'journey', testIds: ['t-I-1'] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness: { lane: 'journey', testIds: ['t-I-1'] } }, deliveredBy: [], activation: 'must-hold',
        contracts: [], state: { type: 'active' },
      }],
    }));
    const plan = JSON.parse(readFileSync(x.planPath, 'utf8')) as Json;
    writeFileSync(x.planPath, JSON.stringify({ ...plan, holistic: { vision: 'vision.json', advances: ['V-1', 'V-2'], obligations: 'obligations.json' } }));
    if (declare) {
      const spec = join(planDir, 'u1.json');
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(readFileSync(spec, 'utf8')) as Json), obligations: ['I-1'] }));
    }
  });
  return contextFor(d);
}

/** Adds must-hold obligation `id` to the arc's obligations file (the apply's edit). */
function addObligation(r: ArcRun, id: string): void {
  const path = join(r.d.planPath, '..', 'obligations.json');
  const o = JSON.parse(readFileSync(path, 'utf8')) as Json & { obligations: Json[] };
  const witness = { lane: 'journey', testIds: [`t-${id}`] };
  o.obligations.push({ ...o.obligations[0]!, id, statement: `${id} holds.`, witness, proofJudgment: { ...(o.obligations[0]!['proofJudgment'] as Json), witness } });
  writeFileSync(path, JSON.stringify(o));
}

describe('holistic docs publications', () => {
  test('publish.obligation-must-hold: an apply adding a must-hold obligation publishes invariants.md only when the obligation holds on the docs candidate (G12); its witness is a job witness', T, async () => {
    const r = holisticArc([], { 't-I-1': 'pass', 't-I-2': 'fail', 't-I-3': 'pass' });
    const w = wire(r);
    try {
      const tip = head(r.d);
      addObligation(r, 'I-2');
      const red = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(r.d)));
      assert.ok(red.kind === 'rejected' && /obligations I-2 do not hold on the docs candidate/.test(red.reason), JSON.stringify(red));
      assert.equal(head(r.d), tip);
      const witnessed = facts(r).flatMap((f) => (f.kind === 'witnessed' ? [[f.lane, f.for, f.purpose]] : []));
      assert.deepEqual(witnessed, [['journey', { type: 'job', job: 'docs-1' }, 'witness']]);
      const inv = facts(r).flatMap((f) => (f.kind === 'witnessed' ? [f.inv] : []))[0]!;
      assert.ok(existsSync(join(jobLaneDir(r.ctx.runDir, jobId('docs', 1), 'arc', laneId('journey'), invocationDirName(inv)), 'witness.json')));

      // I-3 (passing) instead of I-2.
      const path = join(r.d.planPath, '..', 'obligations.json');
      const o = JSON.parse(readFileSync(path, 'utf8')) as Json & { obligations: Json[] };
      o.obligations = o.obligations.filter((x) => x['id'] !== 'I-2');
      writeFileSync(path, JSON.stringify(o));
      addObligation(r, 'I-3');
      const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(r.d));
      const ok = await applyCommand(w.commands, file);
      assert.equal(ok.kind, 'applied', JSON.stringify(ok));
      const fact = assertPublished(r, file.id, 'docs-2', tip);
      assert.deepEqual(changedPaths(absPath(r.d.repo), sha(tip), sha(fact.publication!.head)), ['.roadmap/invariants.md']);
      assert.match(show(r.d, 'main', '.roadmap/invariants.md'), /I-3/);
      assert.deepEqual(facts(r).flatMap((f) => (f.kind === 'docs-covered' ? [f.pub] : [])), ['docs-2']);
    } finally {
      r.journal.close();
    }
  });

  test('publish.finding-blocked: an active P1 over an obligation the approval selects blocks the candidate before green (finding-blocked, uncharged) and the unit ff before its intent (G10); once ruled, the unit publishes', T, async () => {
    const r = holisticArc([planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], { 't-I-1': 'pass' }, true);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }], 'the approval selects I-1');
      const open = (n: number): void => void r.journal.fact({
        kind: 'finding-opened', id: findingId(`F-${n}`), key: sha256(String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a')), lens: 'witness', severity: 'P1',
        obligation: 'I-1' as never, visionClauses: [], claim: 'I-1 is not held on the audited head', evidence: [], mutant: null, source: { type: 'job', job: `audit-${n}` as never },
        gateHadPassed: true,
      });
      const rule = (n: number): void => void r.journal.fact({ kind: 'finding-transition', id: findingId(`F-${n}`), to: { state: 'ruled', disposition: 'dismissed', by: { type: 'code', reason: 'not-reproduced' } } as never });
      open(1);
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(r.d).at(-1), 'candidate:finding-blocked');
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'uncharged');
      assert.equal(slotState(r), 'free', 'the blocked candidate released the slot');
      rule(1);
      await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
      open(2);
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(r.d).at(-1), 'ff:cas-stale', 'blocked before the ff intent');
      assert.equal(r.journal.view.opsOf('integration.ff').length, 0);
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(r.d).at(-1), 'candidate:finding-blocked', 'its fresh candidate records the block');
      rule(2);
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// dev.16: a vision edit publishes the vision onto the integration branch

describe('vision edits publish', () => {
  test('publish.vision-edit: a corpus arc\'s `apply --vision-edit`, committed on the owner\'s branch, lands .roadmap/vision.json on integration through its docs publication; a same-repo re-pin of the vision document lands the document too; the owner\'s branch never moves', T, async () => {
    const a = await setupCorpusArc([]);
    const d = a.d;
    const r = contextFor(d);
    const w = wire(r);
    try {
      const repo = absPath(d.repo);
      const vision = (): Json => JSON.parse(readFileSync(join(d.repo, '.roadmap/vision.json'), 'utf8')) as Json;
      const at = (commit: string, path: string): string => rawGit(repo, ['show', `${commit}:${path}`]);
      git(d.repo, 'checkout', '--quiet', '-b', 'owner');

      // 1. A vision-only edit: the record alone (and a corpus arc's debt.md, rendered with any docs publication).
      const tip = head(d);
      const v1 = vision();
      const rev2 = `${JSON.stringify({ ...v1, rev: 2, clauses: [...(v1['clauses'] as Json[]), { id: 'V-3', kind: 'good', text: 'Quiet nights.', rank: null, state: 'active' }] }, null, 2)}\n`;
      writeFileSync(join(d.repo, '.roadmap/vision.json'), rev2);
      const owner2 = commitAll(d.repo, 'vision rev 2');
      const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, visionApplyBody(d));
      const outcome = await applyCommand(w.commands, file);
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
      const fact = assertPublished(r, file.id, 'docs-1', tip);
      assert.deepEqual(fact.changes, [{ type: 'vision', rev: 2 }]);
      assert.equal(fact.visionSha256, bytesSha256(Buffer.from(rev2, 'utf8')), 'the vision in force is the published one');
      const head1 = fact.publication!.head;
      assert.deepEqual(changedPaths(repo, sha(tip), sha(head1)).filter((p) => p !== '.roadmap/debt.md'), ['.roadmap/vision.json']);
      assert.equal(at('main', '.roadmap/vision.json'), rev2, 'integration carries the new vision');
      assert.equal(git(d.repo, 'rev-parse', 'owner'), owner2, 'the owner\'s branch is never moved');

      // 2. A same-repo re-pin changing the vision document, with the record confirming it: both land.
      const doc = `${readFileSync(join(d.repo, VISION_PATH), 'utf8')}Quiet nights in every berth.\n`;
      writeFileSync(join(d.repo, VISION_PATH), doc);
      const repinned = commitAll(d.repo, 'the vision document');
      const pinned = await corpusPin({ repo, commit: repinned, baseline: sha(a.baseline), out: absPath(join(a.planDir, PIN_FILE)) });
      assert.equal(pinned.kind, 'pinned', JSON.stringify(pinned));
      const rev3 = `${JSON.stringify({ ...vision(), rev: 3, confirmation: { ref: `corpus:${VISION_DOC}#sha256:${sha256Hex(doc)}`, at: '2026-10-21T00:00:00.000Z' } }, null, 2)}\n`;
      writeFileSync(join(d.repo, '.roadmap/vision.json'), rev3);
      const owner3 = commitAll(d.repo, 'vision rev 3, confirmed against the re-pinned document');
      const again = submitCommand(r.ctx.runDir, r.ctx.plan().arc, visionApplyBody(d));
      const second = await applyCommand(w.commands, again);
      assert.equal(second.kind, 'applied', JSON.stringify(second));
      const fact2 = assertPublished(r, again.id, 'docs-2', head1);
      assert.deepEqual(fact2.changes.map((c) => c.type).sort(), ['corpus', 'vision']);
      assert.deepEqual(changedPaths(repo, sha(head1), sha(fact2.publication!.head)).filter((p) => p !== '.roadmap/debt.md'), ['.roadmap/vision.json', VISION_PATH]);
      assert.equal(at('main', VISION_PATH), doc, 'integration carries the re-pinned vision document');
      assert.equal(at('main', '.roadmap/vision.json'), rev3);
      assert.equal(git(d.repo, 'rev-parse', 'owner'), owner3, 'the owner\'s branch is never moved');
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Checkpoint A fixes: the lanes' evidence and checkout, a rule's dispositions and write-back

/** The evidence dirs a docs job's lanes left, by name (`<kind>-<lane>-<inv>`, `_dirty`). */
const laneDirs = (r: ArcRun, pub: string): readonly string[] => readdirSync(join(r.ctx.runDir, 'evidence', 'jobs', pub)).sort();

test('publish.lane-evidence-immutable: a suite lane and an arc lane of one id each keep their own evidence; a crash after the docs ff recovers through the snapshot', T, async () => {
  const suite = [{ id: 'journey', argv: ['node', '-e', "console.log('the suite lane')"] }];
  const r = holisticArc([], { 't-I-1': 'pass', 't-I-3': 'pass' }, false, suite);
  const tip = head(r.d);
  addObligation(r, 'I-3');
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(r.d));
  r.journal.close();
  await crashChild('revision.commit.after-docs', r.d, file.id, null);
  const back = await recoverArc(r.d);
  try {
    assertPublished(back, file.id, 'docs-1', tip);
    const dirs = laneDirs(back, 'docs-1');
    const suiteDir = dirs.find((x) => x.startsWith('suite-journey-'));
    const arcDir = dirs.find((x) => x.startsWith('arc-journey-'));
    assert.ok(suiteDir !== undefined && arcDir !== undefined, dirs.join(', '));
    const out = (dir: string): string => readFileSync(join(back.ctx.runDir, 'evidence', 'jobs', 'docs-1', dir, 'output', 'manifest.json'), 'utf8');
    assert.notEqual(out(suiteDir), out(arcDir), 'each lane execution\'s own output');
    assert.ok(existsSync(join(back.ctx.runDir, 'evidence', 'jobs', 'docs-1', arcDir, 'witness.json')));
    assert.ok(!existsSync(join(back.ctx.runDir, 'evidence', 'jobs', 'docs-1', suiteDir, 'witness.json')), 'a suite lane witnesses nothing');
    assert.deepEqual(back.journal.view.openIntents(), []);
  } finally {
    back.journal.close();
  }
});

test('publish.checkout-integrity: a passing lane that changes the docs checkout, or moves its HEAD, refuses the certification; what it wrote is kept as evidence', T, async () => {
  const cases = [
    { lane: "require('node:fs').appendFileSync('contracts/api.md', 'tampered\\n')", reason: /its lanes changed the checkout they tested \(contracts\/api\.md; kept at .*\/evidence\/jobs\/docs-1\/_dirty-docs-1\.checkout\)/ },
    { lane: "require('node:child_process').execFileSync('git', ['-c', 'user.name=l', '-c', 'user.email=l@l', 'commit', '-q', '--allow-empty', '-m', 'moved'])", reason: /its lanes moved the checkout's HEAD to [0-9a-f]{40}/ },
  ];
  for (const c of cases) {
    const d = publishArc({ steps: [], suite: [{ id: 'suite', argv: ['node', '-e', c.lane] }] });
    const r = contextFor(d);
    const w = wire(r);
    try {
      const tip = head(d);
      const outcome = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
      assert.ok(outcome.kind === 'rejected' && c.reason.test(outcome.reason), JSON.stringify(outcome));
      assert.equal(head(d), tip, 'integration never moved');
      assert.equal(applied(r).length, 1, 'nothing is in force');
      assert.equal(slotState(r), 'free');
      assert.deepEqual(checkouts(r), []);
      if (c.reason.source.includes('changed')) {
        const manifest = readFileSync(join(r.ctx.runDir, 'evidence', 'jobs', 'docs-1', '_dirty-docs-1.checkout', 'manifest.json'), 'utf8');
        assert.match(manifest, /contracts\/api\.md/, 'the changed file is kept');
      }
    } finally {
      r.journal.close();
    }
  }
});

test('rule.dispositions-applied: a ruling waiving I-1 puts I-1 waived in its own revision and publishes invariants.md; the owner\'s files are never written; a crash after its snapshot leaves a manual start nothing to refuse, and after recovery a start with the owner\'s files changes nothing (startup.pending-write-back)', T, async () => {
  const r = holisticArc([], { 't-I-1': 'pass' });
  const tip = head(r.d);
  const file = submitRule(r, ruleRecord(r, 'C-2', { obligations: ['I-1'], obligationDispositions: [{ id: 'I-1', disposition: 'waived' }] }));
  const ledgerBefore = readFileSync(join(r.d.planPath, '..', 'rulings.md'), 'utf8');
  const obligationsBefore = readFileSync(join(r.d.planPath, '..', 'obligations.json'), 'utf8');
  r.journal.close();
  await crashChild('docs.after-snapshot', r.d, file.id, null);

  // A manual start before recovery: the revision is in force, the files do not hold it yet, and nothing is refused.
  const start = contextFor(r.d);
  try {
    assert.equal(readFileSync(join(r.d.planPath, '..', 'rulings.md'), 'utf8'), ledgerBefore, 'the owner\'s ledger is never written');
    const context = {
      repo: start.ctx.repo, planFile: absPath(r.d.planPath), plan: start.ctx.plan(), specOf: () => null, profile: 'default' as never, arcRoles: 'm4b' as const, runDir: start.ctx.runDir, hostDir: start.ctx.hostDir,
    };
    const revs = applied(start).length;
    assert.deepEqual(settlePlan(start.journal, context, readInputFiles(absPath(r.d.planPath), absPath(r.d.repo)), process.env), [], 'no false ledger-edit refusal');
    assert.equal(applied(start).length, revs, 'the files wait for the next start');
  } finally {
    start.journal.close();
  }

  const back = await recoverArc(r.d);
  try {
    const fact = assertPublished(back, file.id, 'docs-1', tip);
    assert.deepEqual(changedPaths(absPath(back.d.repo), sha(tip), sha(fact.publication!.head)), ['.roadmap/constraints.md', '.roadmap/invariants.md']);
    assert.match(show(back.d, 'main', '.roadmap/invariants.md'), /I-1/);
    assert.ok(fact.changes.some((c) => c.type === 'obligation' && c.id === 'I-1'), JSON.stringify(fact.changes));
    const inForce = revisionInForce(back.ctx.runDir, requirePlanInForce(back.ctx.runDir, back.journal.view));
    const i1 = inForce.obligations!.value.obligations.find((o) => o.id === obligationId('I-1'))!;
    assert.deepEqual(i1.state, { type: 'waived', ruling: 'C-2' });
    assert.ok(isExempt(i1), 'a waived obligation is exempt');
    assert.equal(readFileSync(join(back.d.planPath, '..', 'obligations.json'), 'utf8'), obligationsBefore, 'the owner\'s obligations file is never written');
    assert.equal(readFileSync(join(back.d.planPath, '..', 'rulings.md'), 'utf8'), ledgerBefore, 'nor the ledger');
    assert.ok(!existsSync(join(back.d.planPath, '..', 'rulings.md.d', 'C-2.json')));
    // The next start rebases the owner's unchanged files onto the revision in force: nothing changes, I-1 stays waived.
    const context = {
      repo: back.ctx.repo, planFile: absPath(back.d.planPath), plan: back.ctx.plan(), specOf: () => null, profile: 'default' as never, arcRoles: 'm4b' as const, runDir: back.ctx.runDir, hostDir: back.ctx.hostDir,
    };
    const revs = applied(back).length;
    assert.deepEqual(settlePlan(back.journal, context, readInputFiles(absPath(back.d.planPath), absPath(back.d.repo)), process.env), []);
    assert.equal(applied(back).length, revs, 'unchanged');
    const after = revisionInForce(back.ctx.runDir, requirePlanInForce(back.ctx.runDir, back.journal.view)).obligations!.value.obligations;
    assert.deepEqual(after.find((o) => o.id === obligationId('I-1'))!.state, { type: 'waived', ruling: 'C-2' });
  } finally {
    back.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// Crash: the docs publication (the matrix row DOCS_PUBLICATION) and a preemption (PREEMPT)

type Crashed = Readonly<{ d: ArcDescriptor; id: string; tip: string; open: readonly IntentRecord[] }>;

async function crashChild(label: string, d: ArcDescriptor, id: string, barrier: string | null): Promise<void> {
  const trigger = writeTrigger(tmpDir('publish-crash'), { label, occurrence: 1 });
  const exit = await runFixture('publish-child.ts', [JSON.stringify(d), id, ...(barrier === null ? [] : [barrier])], {
    env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000,
  });
  assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
  assertFired(trigger);
}

/** The intents the crashed child left open. */
function openAfterCrash(d: ArcDescriptor): readonly IntentRecord[] {
  const r = contextFor(d);
  try {
    return r.journal.view.openIntents();
  } finally {
    r.journal.close();
  }
}

/** Recovery, as a start runs it, with the real docs publisher behind its command reconciler. */
async function recoverArc(d: ArcDescriptor): Promise<ArcRun> {
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    await recover({ stage: w.stage, commands: w.commands });
  } finally {
    stop();
  }
  return r;
}

describe(`matrix row ${DOCS_PUBLICATION}`, () => {
  const cells = crashCells(DOCS_PUBLICATION);
  /**
   * The publication in force after recovery: crashed before its ff published, the revision is aborted and the rule
   * publishes again as docs-2 (docs-1 when the crashed commit never took the slot, so named no job).
   */
  const PUB: Readonly<Record<string, string>> = {
    'revision.commit.after-intent': 'docs-1', 'docs.act-start': 'docs-2', 'docs.after-commit-tree': 'docs-2', 'docs.act-end': 'docs-2', 'docs.after-lanes': 'docs-2',
    'ff.act-start': 'docs-1', 'ff.act-end': 'docs-1', 'revision.commit.after-docs': 'docs-1', 'revision.commit.after-fact': 'docs-1', 'docs.after-snapshot': 'docs-1',
  };

  /**
   * How recovery closes the ops each crash leaves open (closedAs): the apply always reconciled; the revision aborted
   * before its docs ff published, else reconciled; a docs.commit cut short redone, one acted reconciled; the docs ff
   * redone before its CAS, reconciled after it.
   */
  const APPLY = ['command.apply:reconciled'];
  const ABORTED = [...APPLY, 'revision.commit:aborted'];
  const ACTIVATED = [...APPLY, 'revision.commit:reconciled'];
  const CLOSED: Readonly<Record<string, readonly string[]>> = {
    'revision.commit.after-intent': ABORTED, 'docs.act-start': [...ABORTED, 'docs.commit:redone'], 'docs.after-commit-tree': [...ABORTED, 'docs.commit:redone'],
    'docs.act-end': [...ABORTED, 'docs.commit:reconciled'], 'docs.after-lanes': ABORTED,
    'ff.act-start': [...ACTIVATED, 'integration.ff:redone'], 'ff.act-end': [...ACTIVATED, 'integration.ff:reconciled'],
    'revision.commit.after-docs': ACTIVATED, 'revision.commit.after-fact': ACTIVATED, 'docs.after-snapshot': APPLY,
  };

  async function crashAt(label: string): Promise<Crashed> {
    const d = publishArc({ steps: [] });
    const r = contextFor(d);
    const tip = head(d);
    const file = submitRule(r, ruleRecord(r, 'C-2', API_OP));
    r.journal.close();
    await crashChild(label, d, file.id, null);
    return { d, id: file.id, tip, open: openAfterCrash(d) };
  }

  for (const cell of cells) {
    test(`docs publication crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const { d, id, tip, open } = await crashAt(cell.label);
      const r = await recoverArc(d);
      try {
        const pub = PUB[cell.label];
        if (pub === undefined) throw new Error(`no expectation for ${cell.label}`);
        assert.deepEqual(closedAs(r.journal.view, open), CLOSED[cell.label], 'the ops the crash left open, as recovery closed them');
        assert.equal(applied(r).filter((f) => f.command === id).length, 1, 'one plan-applied');
        assertPublished(r, id, pub, tip);
        assert.equal(docsFfs(r).filter((i) => r.journal.view.doneOf(i.op)?.kind === 'integration.ff').length, 1, 'one docs ff');
        assert.match(show(d, 'main', 'contracts/api.md'), /finite numbers/);
        assert.match(revisionInForce(r.ctx.runDir, requirePlanInForce(r.ctx.runDir, r.journal.view)).ledger.bytes.toString('utf8'), /^C-2 — /m, 'the ledger in force holds the ruling');
        assert.doesNotMatch(readFileSync(join(d.planPath, '..', 'rulings.md'), 'utf8'), /C-2/, 'the owner\'s ledger is never written');
        assert.equal(r.journal.view.opsOf('snapshot.publish').filter((i) => i.parent.type === 'job').length, 1, 'one docs snapshot');
        assert.deepEqual(r.journal.view.openIntents(), [], 'recovery leaves nothing open');
      } finally {
        r.journal.close();
      }
    });
  }
});

describe(`matrix row ${PREEMPT}`, () => {
  const cells = crashCells(PREEMPT);
  /** How the preempt kill stands after recovery (closedAs): its runner alive until the cancel lands, so redone; then reconciled; once done, live. */
  const KILL_CLOSED: Readonly<Record<string, readonly string[]>> = {
    'kill.after-intent': ['proc.kill:redone'], 'kill.after-cancel': ['proc.kill:redone', 'proc.kill:reconciled'],
    'kill.after-quiesced': ['proc.kill:reconciled'], 'kill.after-done': ['proc.kill:live'],
  };
  /**
   * How the lane's spawn stands after recovery: open at the crash, so redone, while its runner can still be alive. Once
   * the runner has exited (the kill quiesced), the lane's own invoke and the kill both await that exit, each on its own
   * poll: whichever sees it first moves on, so the crash finds the spawn either still open (redone) or already settled
   * by its invoke (live). Which one is decided inside the crashed child; both are correct.
   */
  const LANE_CLOSED: Readonly<Record<string, readonly string[]>> = {
    'kill.after-intent': ['proc.spawn:redone'], 'kill.after-cancel': ['proc.spawn:redone'],
    'kill.after-quiesced': ['proc.spawn:live', 'proc.spawn:redone'], 'kill.after-done': ['proc.spawn:live', 'proc.spawn:redone'],
  };

  for (const cell of cells) {
    test(`preemption crashed at ${cell.boundary} ${cell.label}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
      const barrier = tmpDir('barrier');
      const d = publishArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })], suite: [barrierSuite(barrier)] });
      const setup = contextFor(d);
      const tip = head(d);
      const file = submitRule(setup, ruleRecord(setup, 'C-2'));
      setup.journal.close();
      await crashChild(cell.label, d, file.id, barrier);
      const open = openAfterCrash(d);
      const r = await recoverArc(d);
      const w = wire(r);
      const stop = ticking(w);
      try {
        assertPublished(r, file.id, 'docs-1', tip);
        // The crashed op is the preempt kill of u1's candidate suite lane, closed per boundary.
        const [kill, ...moreKills] = r.journal.view.opsOf('proc.kill');
        assert.ok(kill !== undefined && moreKills.length === 0 && kill.expect.reason === 'preempt', 'one kill, the preemption');
        const lane = kill.parent.type === 'op' ? r.journal.view.latestIntent(kill.parent.op) : null;
        assert.ok(lane?.kind === 'proc.spawn' && lane.expect.subject.purpose === 'lane' && lane.expect.subject.set === 'suite', JSON.stringify(lane));
        assert.deepEqual(lane.parent.type === 'stage' ? [lane.parent.unit, lane.parent.stage] : [], ['u1', 'candidate'], 'the lane is u1\'s candidate\'s');
        assert.ok(KILL_CLOSED[cell.label]!.includes(closedAs(r.journal.view, [kill])[0]!), `${cell.label}: ${closedAs(r.journal.view, [kill])[0]}`);
        const laneClosed = closedAs(r.journal.view, [lane])[0]!;
        assert.ok(LANE_CLOSED[cell.label]!.includes(laneClosed), `${cell.label}: ${laneClosed}`);
        assert.equal(open.some((i) => i.op === lane.op), laneClosed === 'proc.spawn:redone', 'the lane is redone exactly when the crash left it open');
        assert.deepEqual(closedAs(r.journal.view, open.filter((i) => i.kind !== 'proc.kill' && i.op !== lane.op)), ['command.apply:reconciled', 'revision.commit:aborted'],
          'the apply reconciled, its revision (waiting for the slot) aborted and re-evaluated');
        const events = readJournal(r.ctx.runDir, r.journal.view.arc).events;
        const seqOf = (p: (f: Fact) => boolean): number => events.find((e) => e.type === 'fact' && p(e.fact))?.seq ?? Infinity;
        assert.ok(seqOf((f) => f.kind === 'plan-applied' && f.command === file.id) < seqOf((f) => f.kind === 'stage-outcome' && f.unit === 'u1' && f.stage === 'candidate' && f.outcome === 'green'),
          'the candidate never recorded green before the publication');
        assert.deepEqual(await runUnit(w.stage, r.unit('u1'), admitAll), { kind: 'merged' });
        const unitFf = r.journal.view.opsOf('integration.ff').find((i) => i.expect.subject === undefined)!;
        assert.equal(unitFf.expect.old, applied(r).find((f) => f.command === file.id)!.publication!.head, 'the unit merged after the docs publication');
        assert.equal(r.journal.view.unit(unitId('u1')).counters.chargeableFailures, 0);
        assert.equal(readCalls(d.scenarioPath).filter(isGateCall).length, 1, 'no new gate');
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally {
        stop();
        r.journal.close();
      }
    });
  }
});
