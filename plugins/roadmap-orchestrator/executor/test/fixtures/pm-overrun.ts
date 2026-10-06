// The admit-conversions crash row's story (M4a rev 3 ADMIT_CONVERSIONS, LR-k; test/pipeline-matrix.test.ts): a corpus arc
// whose vision has two world clauses outside the slice (advances = [V-1]); `ckpt-1` admits `opp`, honest work on V-3, as
// opportunity O-1; `opp` runs to its merge; audit-2's vision lens finds F-1 on its code; `ckpt-2` admits `fix1` repairing
// F-1, O-1's one follow-up; audit-3 completes; `ckpt-3` admits `fix2` repairing F-1 again, which code converts
// (`follow-up-overrun`): a no-op whose settlement writes the conversion's corpus amendment, then the debt item naming
// O-1. Everything up to audit-3 runs in process; `ckpt-3` runs in the crash child (pm-overrun-child.ts).
import { sha256Hex } from '../../src/core/json.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { CheckpointContext } from '../../src/holistic/checkpoint.ts';
import { runCheckpoint } from '../../src/holistic/checkpoint.ts';
import { runUnit } from '../../src/pipeline/unit.ts';
import { withForge } from '../helpers/corpusarc.ts';
import { sampleCorpus } from '../helpers/corpus.ts';
import { checkpointAnswer, checkpointStep, lensStep } from '../helpers/holistic.ts';
import { readCalls } from '../helpers/scenario.ts';
import { admitOp, checkpointContext, completedAudit } from './checkpoint-common.ts';
import { type CorpusHolisticArc, corpusHolisticArc } from './corpus-holistic.ts';
import { VISION_PATH } from './corpus-unit.ts';
import { followContext, unitOf } from './route-common.ts';
import { admitAll, planCheckStep } from './stage-common.ts';
import { type ArcRun, appendSteps, contextFor, gateStep, mulBuild } from './unit-common.ts';

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

/** An admit of `id` (u1's spec renamed), citing `cites`. */
const admitCiting = (a: CorpusHolisticArc, id: string, cites: readonly string[]): Json => ({ ...(admitOp(a.d, id) as Json), cites: [...cites] });

/** A repair admit of `id` repairing F-1, citing V-3. */
function repairOf(a: CorpusHolisticArc, id: string): JsonValue {
  const op = admitCiting(a, id, ['V-3']) as Json & { spec: string; unit: Json };
  return { ...op, unit: { ...op.unit, origin: 'repair' }, spec: JSON.stringify({ ...(JSON.parse(op.spec) as Json), repairs: ['F-1'] }) } as JsonValue;
}

/** The checkpoint context the story's jobs run under: the plan in force (with its admitted units) and their routing. */
export function overrunContext(r: ArcRun): Readonly<{ ctx: CheckpointContext; w: ReturnType<typeof checkpointContext>['w'] }> {
  const base = checkpointContext(r);
  const follow = followContext(r);
  return { ctx: { ...base.ctx, plan: follow.plan, routing: follow.routing }, w: base.w };
}

/** Lays the story out and runs it in process up to audit-3 completed; `ckpt-3` is next. */
export async function overrunArc(): Promise<CorpusHolisticArc> {
  const a = await corpusHolisticArc([lensStep('audit-1', 'vision')], { baseline: { '.roadmap/vision.json': visionWithHorizon() } });
  appendSteps(a.d, [
    checkpointStep('ckpt-1', checkpointAnswer({ decision: 'bundle', ops: [admitCiting(a, 'opp', ['V-1', 'V-3']) as JsonValue] })),
    planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }),
    lensStep('audit-2', 'vision', [{ severity: 'P2', visionClauses: ['V-3'], claim: 'mul frees no berth', cause: 'mul: no pool', evidence: [{ path: 'src/mul.js', line: 1 }] }]),
    checkpointStep('ckpt-2', checkpointAnswer({ decision: 'bundle', ops: [repairOf(a, 'fix1')] })),
    lensStep('audit-3', 'vision'),
    checkpointStep('ckpt-3', checkpointAnswer({ decision: 'bundle', ops: [repairOf(a, 'fix2')] })),
  ]);
  const r = contextFor(a.d);
  try {
    const { ctx } = overrunContext(r);
    const run = async (): Promise<string> => {
      const out = await withForge(a.forge, () => runCheckpoint(ctx));
      return out.kind === 'decided' ? out.decision.kind : out.kind;
    };
    await completedAudit(r, ctx);
    if (await run() !== 'applied') throw new Error('ckpt-1 did not apply O-1');
    const follow = followContext(r);
    const merged = await runUnit(follow, unitOf(follow, 'opp'), admitAll);
    if (merged.kind !== 'merged') throw new Error(`opp did not merge: ${JSON.stringify(merged)}`);
    await completedAudit(r, ctx);
    if (await run() !== 'applied') throw new Error('ckpt-2 did not apply the follow-up');
    await completedAudit(r, ctx);
  } finally {
    r.journal.close();
  }
  return a;
}

/** The checkpoint calls made so far, by job. */
export const checkpointCalls = (a: CorpusHolisticArc): readonly string[] => readCalls(a.d.scenarioPath).flatMap((c) => (c.unit?.startsWith('ckpt-') ? [c.unit] : []));
