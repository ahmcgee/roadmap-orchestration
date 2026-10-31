// Per-test evidence comparison, root revision concurrency, and audit integration-history coverage.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';

import { runUnit } from '../src/pipeline/unit.ts';
import { status } from '../src/status.ts';
import { checkpointContext, completedAudit, factsOfKind } from './fixtures/checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc } from './fixtures/corpus-holistic.ts';
import { VISION_PATH } from './fixtures/corpus-unit.ts';
import { stepTo, unitOf } from './fixtures/route-common.ts';
import { SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { type ArcRun, applyBody, contextFor, gateStep, mulBuild } from './fixtures/unit-common.ts';
import { reached,release } from './helpers/barrier.ts';
import { sampleCorpus } from './helpers/corpus.ts';
import { lensStep } from './helpers/holistic.ts';
import { git } from './helpers/repo.ts';
import { type Step } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
type Json = Record<string, unknown>;

/** The corpus arc's vision with two more world clauses outside the slice (advances = [V-1]): V-3 and V-4. */
function visionWithHorizon(): string {
  const text = sampleCorpus().files[VISION_PATH]!;
  return `${JSON.stringify({
    schema: 'roadmap/vision-m3', rev: 1, confirmation: { ref: `corpus:0005_Vision.md#sha256:${sha256Hex(text)}`, at: '2026-10-01T00:00:00.000Z' },
    clauses: [
      { id: 'V-1', kind: 'world', text: 'Every vessel finds a berth.', rank: null, state: 'active' },
      { id: 'V-2', kind: 'purpose', text: 'A calm harbour.', rank: null, state: 'active' },
      { id: 'V-3', kind: 'world', text: 'A cancelled berth goes back to the pool.', rank: null, state: 'active' },
      { id: 'V-4', kind: 'world', text: 'The harbour master sees the day at a glance.', rank: null, state: 'active' },
    ],
    questions: [],
  }, null, 2)}\n`;
}

type Arc = Readonly<{ a: CorpusHolisticArc; r: ArcRun; ctx: ReturnType<typeof checkpointContext>['ctx']; w: ReturnType<typeof checkpointContext>['w'] }>;

/** A corpus arc with the horizon vision, `steps` after audit-1's vision lens, audit-1 completed; `before` edits the plan dir before revision 1. */
async function arc(steps: readonly Step[], opts: Readonly<{ before?: (a: CorpusHolisticArc) => void; audit?: boolean }> = {}): Promise<Arc> {
  const a = await corpusHolisticArc([lensStep('audit-1', 'vision'), ...steps], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
  opts.before?.(a);
  const r = contextFor(a.d);
  const { ctx, w } = checkpointContext(r);
  if (opts.audit !== false) await completedAudit(r, ctx);
  return { a, r, ctx, w };
}
// ---------------------------------------------------------------------------------------------------
const pcBarrier = {type: 'barrier', name: 'pc', timeoutMs: 120_000} as const;
describe('root apply while an attempt is live or abandoned', () => {

  test('classify.open-attempt-running-vs-abandoned: an attempt an executor restart found open does not refuse an edit (arc feedback 2026-10-15: the startup records it); the revision is pending', T, async () => {
    const pc = planCheckStep({ decision: 'approve' });
    const x = await arc([{ ...pc, acts: [pcBarrier, ...pc.acts] } as Step], { audit: false });
    try {
      const unit = stepTo(x.ctx, 'u1', (f) => f.stage === 'pre-build');
      await reached(x.a.d.scenarioDir, 'pc', 120_000);
      x.r.journal.fact({ kind: 'executor-started', generation: 99 });
      const spec = join(x.a.planDir, 'u1.json');
      const was = readFileSync(spec, 'utf8');
      writeFileSync(spec, JSON.stringify({ ...(JSON.parse(was) as Json), rev: 2 }));
      const applied = await applyCommand(x.w.commands, submitCommand(x.r.ctx.runDir, x.r.journal.view.arc, applyBody(x.a.d)));
      assert.equal(applied.kind, 'applied', JSON.stringify(applied));
      assert.equal(x.r.journal.view.unit(unitId('u1')).pendingRevision?.rev, 2);
      writeFileSync(spec, was);
      release(x.a.d.scenarioDir, 'pc');
      await unit;
    } finally {
      x.r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('an owner commit on the integration branch (dev.13 arc, audit-24)', () => {
  test('history.unpublished-head-resolves: an audit ending on a commit the owner put on the branch places it at its nearest published ancestor', T, async () => {
    const x = await arc([planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }), lensStep('audit-2', 'invariants')]);
    try {
      assert.deepEqual(await runUnit(x.ctx, unitOf(x.ctx, 'u1'), admitAll), { kind: 'merged' });
      const ref = `refs/heads/${x.ctx.plan().integrationBranch}`;
      const published = git(x.ctx.repo, 'rev-parse', ref);
      const owner = git(x.ctx.repo, 'commit-tree', `${published}^{tree}`, '-p', published, '-m', 'vision rev 2');
      git(x.ctx.repo, 'update-ref', ref, owner, published);
      await completedAudit(x.r, x.ctx);
      const ended = factsOfKind(x.r, 'audit-ended').find((f) => f.job === 'audit-2');
      assert.ok(ended?.covered.some((c) => c.to === owner), 'audit-2 ends on the owner commit');
      assert.deepEqual(ended!.covered.map((r) => r.from), [x.ctx.plan().baseline], 'the unified campaign keeps its baseline range even on an owner commit');
      status(x.r.ctx.runDir, arcId(x.r.d.arc), x.r.ctx.hostDir);
    } finally {
      x.r.journal.close();
    }
  });
});
