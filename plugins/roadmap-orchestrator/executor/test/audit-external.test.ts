// External audit witnesses use root CI attestations on lane inputs, never journey records.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { witness } from '../src/commands/witness.ts';
import { commandId, obligationId, sha } from '../src/core/ids.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { inputShaOf } from '../src/git/reusekey.ts';
import { systemsMapInForce } from '../src/input/systems.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { auditArc, auditContext, moduleFiles, unitSteps } from './fixtures/audit-common.ts';
import { SCENARIO_TIMEOUT_MS, admitAll } from './fixtures/stage-common.ts';
import { contextFor } from './fixtures/unit-common.ts';
import { milestoneJson } from './fixtures/walk-common.ts';
import { reached, release } from './helpers/barrier.ts';
import { lensStep } from './helpers/holistic.ts';
import { commitAll, git } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const EVIDENCE = 'https://ci.example/arcs/external-audit';
const head = (repo: string) => sha(git(repo, 'rev-parse', 'main'));
const tree = (repo: string) => sha(git(repo, 'rev-parse', 'main^{tree}'));

function setup(milestone: boolean, barrier = false) {
  const { d } = auditArc({
    steps: [...unitSteps('u1', moduleFiles('mul', '*')), lensStep('audit-1', 'invariants', [],
      barrier ? [{ type: 'barrier', name: 'lens', timeoutMs: 120_000 }] : [])],
    units: [{ id: 'u1', obligations: ['I-1'] }],
    obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['ci'] }],
    laneExtra: { journey: { witnessClass: 'external', inputs: ['src/add.js'] } },
    trees: {}, mapping: [],
    ...(milestone ? { planExtra: { milestones: [milestoneJson({ references: ['contracts'] })] } } : {}),
  });
  const r = contextFor(d);
  const { ctx, w } = auditContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 20);
  const attest = (result: 'pass' | 'fail', n = 1) => {
    assert.equal(witness(w.commands, commandId(`cmd-${n.toString(16).padStart(16, '0')}`), {
      type: 'witness', obligation: obligationId('I-1'), expectedHead: head(d.repo), result,
      evidence: EVIDENCE, evidenceFile: null,
    }).kind, 'applied');
  };
  return { d, r, ctx, attest, close: () => { clearInterval(tick); r.journal.close(); } };
}

/** A real merge changes the tree while preserving every declared external lane input. */
function mergeUnrelated(repo: string): void {
  git(repo, 'checkout', '-q', '-b', 'unrelated');
  writeFileSync(join(repo, 'ci-audit-notes.md'), 'Unrelated publication.\n');
  commitAll(repo, 'unrelated documentation');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '--no-ff', '-q', '-m', 'merge unrelated publication', 'unrelated');
}

for (const milestone of [false, true]) {
  for (const scenario of ['none', 'pass', 'fail', 'pass-before-merge', 'fail-before-merge', 'stale-fail'] as const) {
    test(`audit.external-${milestone ? 'milestone' : 'batch'}-${scenario}: a latched CI-only witness needs no journey record`, T, async () => {
      const { d, r, ctx, attest, close } = setup(milestone);
      try {
        assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
        // A durable latch remains must-hold even when CI has no attestation at today's inputs.
        r.journal.fact({ kind: 'obligation-latched', obligation: obligationId('I-1'), unit: r.unit('u1').id, treeSha: tree(d.repo) });
        if (scenario !== 'none') attest(scenario.startsWith('pass') ? 'pass' : 'fail');
        if (scenario.endsWith('before-merge')) {
          const before = head(d.repo);
          const beforeTree = tree(d.repo);
          const lane = holisticInForce(ctx).obligations!.lanes[0]!;
          const input = inputShaOf(ctx.repo, beforeTree, lane, systemsMapInForce(r.journal.view.planApplied()));
          mergeUnrelated(d.repo);
          assert.notEqual(head(d.repo), before);
          assert.notEqual(tree(d.repo), beforeTree);
          assert.equal(inputShaOf(ctx.repo, tree(d.repo), lane, systemsMapInForce(r.journal.view.planApplied())), input);
        }
        if (scenario === 'stale-fail') {
          const path = join(d.repo, 'src/add.js');
          writeFileSync(path, `${readFileSync(path, 'utf8')}\n// changed external input\n`);
          commitAll(d.repo, 'change external witness inputs');
        }
        r.journal.fact({ kind: 'audit-requested', command: commandId('cmd-ffffffffffffffff') });
        const out = await runAudit(ctx);
        assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
        const findings = r.journal.view.holistic().findings;
        const failed = scenario === 'fail' || scenario === 'fail-before-merge';
        assert.equal(findings.length, failed ? 1 : 0);
        assert.deepEqual(out.findings, findings.map((f) => f.id));
        if (failed) {
          const f = findings[0]!;
          assert.deepEqual([f.lens, f.severity, f.obligation], ['witness', 'P1', 'I-1']);
          assert.match(f.claim, /attested failure/);
          assert.ok(f.claim.includes(head(d.repo)));
          assert.ok(f.claim.includes(EVIDENCE));
          assert.ok(f.evidence.some((e) => e.path === EVIDENCE));
        }
        assert.equal(r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length, 0, 'external lanes are never executed locally');
        assert.deepEqual(r.journal.view.holistic().witnessed, []);
        assert.deepEqual(r.journal.view.openIntents(), []);
      } finally { close(); }
    });
  }
}

for (const verdict of ['pass', 'fail', 'missing'] as const) {
  test(`audit.external-rewitness-${verdict}: a P1 follows external attestations when the head moves during the audit`, T, async () => {
    const { d, r, ctx, attest, close } = setup(false, true);
    try {
      assert.deepEqual(await runUnit(ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      r.journal.fact({ kind: 'obligation-latched', obligation: obligationId('I-1'), unit: r.unit('u1').id, treeSha: tree(d.repo) });
      attest('fail');
      r.journal.fact({ kind: 'audit-requested', command: commandId('cmd-ffffffffffffffff') });
      const audit = runAudit(ctx);
      await reached(d.scenarioDir, 'lens', 120_000);
      assert.equal(r.journal.view.holistic().findings.length, 1, 'the attested failure opens the P1 before the lens');
      if (verdict === 'missing') {
        const path = join(d.repo, 'src/add.js');
        writeFileSync(path, `${readFileSync(path, 'utf8')}\n// new external input\n`);
        commitAll(d.repo, 'invalidate prior attestation');
      } else {
        mergeUnrelated(d.repo);
        attest(verdict, 2);
      }
      release(d.scenarioDir, 'lens');
      const out = await audit;
      assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
      assert.deepEqual(out.rewitnessed, [{ finding: 'F-1', obligation: 'I-1', head: head(d.repo), verdict: verdict === 'missing' ? null : verdict === 'pass' ? 'held' : 'not-held' }]);
      assert.equal(r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'journey').length, 0);
      assert.deepEqual(r.journal.view.openIntents(), []);
    } finally { close(); }
  });
}
