// M3 step B6: the checkpoint job and its bundles (src/holistic/{checkpoint,bundle,convergence,divergence}.ts), over real
// arcs: real git, real processes, the fake claude answering lens and checkpoint calls keyed by job, fake witness lanes.
// Named tests: bundle.stale, bundle.partial (with the retry's prior_attempt), bundle.vision-always-read (H3), bundle.partial (A18's literal partial bundle), bundle.no-op,
// noop.interpretation-divergence (H12), bundle.evidence-drift-witnessed, bundle.evidence-drop, bundle.draining-request, bundle.nested-owner-only (H10), bundle.owner-request-not-repeated,
// bundle.withdrawn-cite-invalid (H16), bundle.rule-race-stale, bundle.ruling-id-collision-invalid, bundle.admit-widens-obligations, bundle.weakening-applies-with-divergence (OR-V), convergence.bound-k,
// convergence.bound-identity, bundle.compensating, digest.binds-ids (H11), divergence.preimage-no-inverse (H13), divergence.patch-of-introduced-unit, bundle.fault-decided,
// ckpt.design-park-respec-first (OR-Q1), ckpt.park-cause, bundle.p1-left-to-repair, and the crash cells of the matrix rows CHECKPOINT_JOB and BUNDLE_ACTIVATE.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type NeedsUserId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { runCheckpoint } from '../src/holistic/checkpoint.ts';
import { findingKey } from '../src/holistic/types.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { recover } from '../src/recover/recover.ts';
import { status } from '../src/status.ts';
import { type Wired, applyPlanEdit, checkpointArc, checkpointContext, completedAudit, factsOfKind, limitsOp, visionLenses } from './fixtures/checkpoint-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun, appendSteps, contextFor, syncInputs } from './fixtures/unit-common.ts';
import { assertFired,writeTrigger } from './helpers/crash.ts';
import { VALID_OP, checkpointAnswer, checkpointStep } from './helpers/holistic.ts';
import { runFixture } from './helpers/proc.ts';
import { git,tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { BUNDLE_ACTIVATE,CHECKPOINT_JOB,crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const decisions = (r: ArcRun) => factsOfKind(r, 'bundle-decided').map((f) => [f.job, f.outcome.kind === 'rejected' ? `rejected:${f.outcome.reason}` : f.outcome.kind]);
const bundleRevs = (r: ArcRun) => factsOfKind(r, 'plan-applied').flatMap((f) => (f.source?.type === 'bundle' ? [[f.rev, f.source.job]] : []));
const checkpointCalls = (r: ArcRun) => readCalls(r.d.scenarioPath).filter((c) => c.unit !== null && c.unit.startsWith('ckpt-')).map((c) => c.unit);
const planLimits = (r: ArcRun) => {
  const applied = r.journal.view.planApplied()!;
  return (JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${applied.planSha256}.plan.json`), 'utf8')) as { limits?: unknown }).limits ?? null;
};
const item = (r: ArcRun, id: string) => readNeedsUser(r.ctx.runDir, id as NeedsUserId)!;
const itemsOf = (r: ArcRun, reason: string) => r.journal.view.needsUser().filter((n) => readNeedsUser(r.ctx.runDir, n.id)?.reason === reason);
async function ack(w: Wired, r: ArcRun, id: string, choice: string | null = null): Promise<void> {
  const out = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, { type: 'ack', needsUser: id as NeedsUserId, choice }));
  assert.equal(out.kind, 'applied', JSON.stringify(out));
}
/** Optionless requests close through an action on their arc, never a bare acknowledgement. */
async function completeOwnerRequest(w: Wired, r: ArcRun, id: string): Promise<void> {
  const rejected = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.journal.view.arc, {type: 'ack', needsUser: id as NeedsUserId, choice: null}));
  assert.ok(rejected.kind === 'rejected' && rejected.reason.includes('has no options'), JSON.stringify(rejected));
  assert.equal(r.journal.view.ackOf(id as NeedsUserId), null);
  syncInputs(r);
  await applyPlanEdit(r, w, (p) => {p['direction'] = `Owner request ${id} resolved; continue within the slice.`;});
  assert.notEqual(r.journal.view.ackOf(id as NeedsUserId), null, 'the arc action closes its request');
}
const barrier = { type: 'barrier', name: 'ckpt', timeoutMs: 120_000 } as const;

describe('the checkpoint and its bundle', () => {
});

/** A P2 vision finding over no obligation, opened by audit `job` (as its lens would). */
function openVisionFinding(r: ArcRun, job: string, cause: string): string {
  const id = r.journal.view.nextFindingId();
  r.journal.fact({
    kind: 'finding-opened', id, key: findingKey('vision', null, cause), lens: 'vision', severity: 'P2', obligation: null, visionClauses: ['V-1' as never],
    claim: cause, evidence: [], mutant: null, source: { type: 'job', job: job as never }, gateHadPassed: false,
  });
  return id;
}
/** `id` resolved by u1's publication, as the executor moves it (`syncFindings`: owned, fixed on branch, resolved). */
function resolveMidCall(r: ArcRun, id: string): void {
  for (const to of [{ state: 'owned', unit: 'u1' }, { state: 'fixed-on-branch', unit: 'u1' }, { state: 'resolved' }]) {
    r.journal.fact({ kind: 'finding-transition', id: id as never, to: to as never });
  }
}
/** A bundle answer of `ops` (a no-op when empty), optionally citing observations, dismissing findings, with one interpretation. */
function bundle(ops: readonly JsonValue[], extra: Readonly<{ observations?: readonly JsonValue[]; dispose?: readonly string[]; interpretations?: boolean }> = {}): JsonValue {
  const a = checkpointAnswer({
    decision: ops.length === 0 ? 'no-op' : 'bundle', ops,
    findingDispositions: (extra.dispose ?? []).map((finding) => ({ finding, disposition: 'dismissed' as const, reason: 'not a defect' })),
    ...(extra.interpretations === true ? { interpretations: [{ clauses: ['V-1'], situation: 'The vision is silent on rounding.', reading: 'Round half to even.' }] } : {}),
  }) as Record<string, JsonValue>;
  return { ...a, cites: { vision: ['V-1'], observations: [...(extra.observations ?? [])], findings: [...(extra.dispose ?? [])] } };
}
/** A checkpoint ruling's JSON text `id` (the executor stamps `ruledBy` and `consistency`), and its `rule` op. */
const checkpointRuling = (id: string): string => JSON.stringify({
  schema: 'roadmap/ruling-m3', id, statement: `Helpers reject non-finite input (${id}).`, kind: 'decision', trigger: 'checkpoint',
  supersedes: [], condition: null, docRefs: [{ path: 'contracts/api.md', anchor: '#api-contract', quotedText: 'returns the sum', relation: 'consistent' }],
  contractRefs: [], contractOps: [], obligations: [], obligationDispositions: [], cites: ['V-1'],
  evidence: ['the vision asks for helpers anyone can trust'], appliesTo: { type: 'arc' }, lifetime: 'arc', status: 'active',
});
const ruleOp = (id: string): JsonValue => ({ op: 'rule', ruling: id, cites: ['V-1'], evidence: ['the vision asks for helpers anyone can trust'] });
const requirePlan = (r: ArcRun) => JSON.parse(readFileSync(join(r.ctx.runDir, 'inputs', `${r.journal.view.planApplied()!.planSha256}.plan.json`), 'utf8')) as { units: { id: string; origin?: string; reenters?: { fixes?: string } }[] };

describe('the activation checks', () => {

  
});

describe('convergence', () => {
});

describe('divergences', () => {
});

describe('executor faults', () => {
});

describe('design parks (OR-Q1)', () => {
});

describe('P1s and their repair (paid m3 run 9)', () => {
});

describe('the convergence tail (dev.13, src/holistic/tail.ts)', () => {
});

describe('park causes (paid m3 run 7)', () => {
});

// ---------------------------------------------------------------------------------------------------
// Crash: the checkpoint job and the bundle's activation (the matrix rows CHECKPOINT_JOB and BUNDLE_ACTIVATE)

// Each label once per checkpoint (counted with test/fixtures/pm-record.ts), so each cell is crashed at the arc's first
// checkpoint and at its second (`#2`): ckpt-1 applied in setup with its divergence D-1 and its digest open, then audit-2
// and the crashed ckpt-2. The second resumes as ckpt-2 from its own inputs, numbers its divergences on from D-1 keyed
// (ckpt-2, i), and raises no second digest while D-1's is open.
for (const row of [CHECKPOINT_JOB, BUNDLE_ACTIVATE]) {
  describe(`matrix row ${row}`, () => {
    for (const cell of crashCells(row)) for (const second of [false, true]) {
      test(`checkpoint crashed at ${cell.boundary} ${cell.label}${second ? '#2 (the arc\'s second checkpoint)' : ''}: ${cell.recovery.slice(0, 80)}…`, T, async () => {
        const noop = cell.label === 'bundle.after-decided';
        const job = second ? 'ckpt-2' : 'ckpt-1';
        const audit = second ? 'audit-2' : 'audit-1';
        const d = second ? checkpointArc([...visionLenses('audit-1', 'audit-2'), checkpointStep('ckpt-1', bundle([limitsOp('retries', 2)]))]) : checkpointArc(visionLenses('audit-1'));
        const setup = contextFor(d);
        const { ctx: sctx } = checkpointContext(setup);
        await completedAudit(setup, sctx);
        if (second) {
          const first = await runCheckpoint(sctx);
          assert.ok(first.kind === 'decided' && first.job === 'ckpt-1' && first.decision.kind === 'applied', JSON.stringify(first));
          assert.deepEqual(factsOfKind(setup, 'divergence-digest').map((x) => x.ids), [['D-1']]);
          await completedAudit(setup, sctx);
        }
        const finding = openVisionFinding(setup, audit, 'helpers round');
        appendSteps(d, [checkpointStep(job, bundle(noop ? [] : [VALID_OP], { dispose: [finding], interpretations: true }))]);
        setup.journal.close();
        const trigger = writeTrigger(tmpDir('checkpoint-crash'), { label: cell.label, occurrence: 1 });
        const exit = await runFixture('checkpoint-child.ts', [JSON.stringify(d)], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 150_000 });
        assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stdout ${exit.stdout}, stderr ${exit.stderr}`);
        assertFired(trigger);
        const r = contextFor(d);
        const { ctx, w } = checkpointContext(r);
        try {
          await recover({ stage: ctx, commands: w.commands });
          const out = await runCheckpoint(ctx);
          if (cell.label.startsWith('bundle.')) assert.deepEqual(out, { kind: 'none' });
          else assert.ok(out.kind === 'decided' && out.job === job && out.decision.kind === 'applied', JSON.stringify(out));
          const jobs = second ? ['ckpt-1', 'ckpt-2'] : ['ckpt-1'];
          assert.deepEqual(factsOfKind(r, 'checkpoint-inputs').map((x) => x.job), jobs, 'one capture per checkpoint');
          assert.deepEqual(checkpointCalls(r), jobs, 'asked once');
          const decided = [...decisions(r), ...bundleRevs(r).map(([, j]) => [j, 'applied'])].sort();
          assert.deepEqual(decided, [...(second ? [['ckpt-1', 'applied']] : []), [job, noop ? 'no-op' : 'applied']], 'decided once');
          const dv = factsOfKind(r, 'divergence').map((x) => [x.id, x.job, x.index, x.type]);
          const own = noop ? [[job, 0, 'interpretation']] : [[job, 0, 'plan-departed'], [job, 1, 'interpretation']];
          const expected = [...(second ? [['ckpt-1', 0, 'plan-departed']] : []), ...own].map((x, i) => [`D-${i + 1}`, ...x]);
          assert.deepEqual(dv, expected, 'each divergence once, keyed (job, index), numbered on');
          assert.deepEqual(factsOfKind(r, 'finding-transition').map((x) => [x.id, x.to.state]), [[finding, 'ruled']], 'the disposition written once');
          const digests = () => factsOfKind(r, 'divergence-digest').map((x) => x.ids);
          assert.deepEqual(digests(), second ? [['D-1']] : [expected.map(([id]) => id)], 'one digest: the second checkpoint\'s divergences wait while D-1\'s is open');
          assert.deepEqual(r.journal.view.openIntents(), []);
          assert.equal(git(d.repo, 'worktree', 'list', '--porcelain').includes('ckpt-'), false, 'no checkpoint checkout left');
          assert.deepEqual(await runCheckpoint(ctx), { kind: 'none' });
          assert.equal(digests().length, 1, 'settling again writes nothing');
        } finally {
          r.journal.close();
        }
      });
    }
  });
}
