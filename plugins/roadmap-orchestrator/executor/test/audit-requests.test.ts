import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandId,jobId,sha } from '../src/core/ids.ts';
import { runAudit } from '../src/holistic/audit.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { LENS_DIFF_BUDGET } from '../src/holistic/lensdiff.ts';
import { keptPayload } from '../src/input/inforce.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { validateCampaignAuditOutput } from '../src/prompts/schemas.ts';
import { recover } from '../src/recover/recover.ts';
import { auditArc,auditContext } from './fixtures/audit-common.ts';
import { SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { type ArcRun,contextFor } from './fixtures/unit-common.ts';
import { assertFired,writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { git,tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const JOB = jobId('audit', 1);
const request = (dismisses: string | null, summary: string) => ({
  op: 'request' as const, summary, evidence: ['src/add.js:1'], dismisses,
  counterEvidence: dismisses === null ? null : 'The restart test retains the committed write',
});

function setup(reports: readonly (readonly ReturnType<typeof request>[])[]) {
  const { d } = auditArc({
    steps: reports.map((requests) => ({
      as: 'claude', unit: JOB, expect: {}, acts: [{ type: 'emit', value: {
        findings: [], reasons: ['Checked the campaign'], premises: [], requests,
      } }],
    })),
    units: [{ id: 'u1' }], obligations: [], lanes: [], mapping: [], trees: {},
  });
  for (const requests of reports) validateCampaignAuditOutput({ findings: [], reasons: ['Checked the campaign'], premises: [], requests });
  const r = contextFor(d);
  for (const claim of ['first false regression', 'second false regression']) openFinding(r.journal, {
    lens: 'invariants', severity: 'P1', obligation: null, visionClauses: [], claim, cause: claim,
    evidence: [], mutant: null, source: { type: 'job', job: jobId('baseline', 1) }, gateHadPassed: false,
  });
  const command = commandId('cmd-1111111111111111');
  r.journal.fact({ kind: 'audit-requested', command });
  const applied = r.journal.view.planApplied()!;
  const payload = keptPayload(r.ctx.runDir, applied.payloadSha256!);
  // Adopt a recorded multi-lens job, as an audit started before the single campaign seat does.
  r.journal.fact({
    kind: 'audit-started', job: JOB, triggers: [{ type: 'requested', command }], generation: 1,
    lenses: ['invariants', 'vision'], integrationSha: sha(git(d.repo, 'rev-parse', 'main')), planRev: applied.rev,
    ledgerSha256: payload.manifest.rulings.ledgerSha256, obligationsSha256: applied.obligationsSha256!,
    visionSha256: applied.visionSha256!, owners: [], priorFindings: r.journal.view.holistic().findings.map((f) => f.id),
    highWater: r.journal.view.highWater(), diffBudget: LENS_DIFF_BUDGET,
  });
  return r;
}

function requestsOf(r: ArcRun) {
  return r.journal.view.opsOf('needsuser.raise').filter((i) => i.parent.type === 'job' && i.parent.job === JOB)
    .map((i) => readNeedsUser(r.ctx.runDir, i.expect.id)!).filter((n) => n.reason === 'owner-request');
}

for (const scenario of [
  {
    name: 'same finding with different summaries raises one item',
    reports: [[request('F-1', 'Dismiss the false regression')], [request('F-1', 'The persistence finding is a false positive')]],
    subjects: [{ type: 'findings', findings: ['F-1'] }],
  },
  {
    name: 'different findings with the same summary raise two items',
    reports: [[request('F-1', 'Dismiss the false regression')], [request('F-2', 'Dismiss the false regression')]],
    subjects: [{ type: 'findings', findings: ['F-1'] }, { type: 'findings', findings: ['F-2'] }],
  },
  {
    name: 'arc requests dedupe equal summaries and retain different summaries',
    reports: [[request(null, 'Review the plan'), request(null, 'Review the plan')], [request(null, 'Review the scope')]],
    subjects: [{ type: 'arc' }, { type: 'arc' }],
  },
] as const) test(`audit.requests: ${scenario.name}`, T, async () => {
  const r = setup(scenario.reports);
  try {
    const out = await runAudit(auditContext(r).ctx);
    assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
    const items = requestsOf(r);
    assert.deepEqual(items.map((n) => n.subject), scenario.subjects);
    assert.equal(items[0]!.summary, scenario.reports[0][0]!.summary, 'the first request is retained');
    assert.ok(items.every((n) => n.blocking));
    assert.deepEqual(r.journal.view.holistic().findings.map((f) => f.state), ['open', 'open'], 'requests leave findings unchanged');
    assert.equal(readCalls(r.d.scenarioPath).length, 2, 'both lens reports were admitted without retries');
  } finally { r.journal.close(); }
});

test('audit.requests: a resumed audit re-admits finding and arc requests without new items', T, async () => {
  const setupRun = setup([[request('F-1', 'Dismiss the false regression')], [request(null, 'Review the plan')]]);
  const d = setupRun.d;
  setupRun.journal.close();
  const trigger = writeTrigger(tmpDir('audit-requests-crash'), { label: 'audit.before-ended', occurrence: 1 });
  const exit = await runFixture('audit-child.ts', [JSON.stringify(d)], {
    env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: SCENARIO_TIMEOUT_MS,
  });
  assert.equal(exit.signal, 'SIGKILL', exit.stderr);
  assertFired(trigger);
  const r = contextFor(d);
  try {
    const before = requestsOf(r);
    assert.equal(before.length, 2, 'both reports were admitted before the crash');
    const { ctx, w } = auditContext(r);
    await recover({ stage: ctx, commands: w.commands });
    const out = await runAudit(ctx);
    assert.ok(out.kind === 'ended' && out.outcome === 'completed', JSON.stringify(out));
    assert.deepEqual(requestsOf(r), before, 'replay raises nothing and preserves the original items');
    assert.equal(readCalls(d.scenarioPath).length, 2, 'recorded reports are consumed without another backend call');
    assert.deepEqual(await runAudit(ctx), { kind: 'none' });
    assert.deepEqual(r.journal.view.openIntents(), []);
  } finally { r.journal.close(); }
});
