// The endgame's independent review (dev.82, WS-5; DESIGN-1.0.md §2.10): the one review the architect's hand-made endgame
// work gets, since no gate saw it. A verifier session in `endgame` mode (src/prompts/verifier/, `EndgameReviewBrief`) on the
// verifier's `high` seat (src/pipeline/dispatch.ts `jobSeat`), run by the endgame job `job` (src/endgame/jobs.ts), never in
// the architect's session:
//
//   1. A detached checkout `<worktreeRoot>/<arc>/<job>.review` of the integration head, made fresh (a restarted job's
//      leftover removed first) unless its call is already recorded.
//   2. The brief: the review's range (src/endgame/open.ts `reviewRange`: from the episode's base, or from the earliest
//      landing of an earlier, reversed episode no review reached, to the integration head) as a bounded diff, the
//      episode's recorded fixes, the publications in the range (a unit's or a batch's marked already gated), the active
//      findings, the vision.
//   3. One acting-judge call (the recorded one is consumed by a resumed job), answering ENDGAME_REVIEW_SCHEMA; a refused
//      answer takes the one judgment repair turn.
//   4. Answered: each finding opened (`openFinding`) as an `endgame-review` finding of its severity over no obligation, from
//      the job, then `endgame-reviewed{job, from, to, findings}` (the ids opened or merged into). A P1 is a required
//      worklist entry, so the closing step returns to `open`; P2 and P3 go to the close-out settlement. Not answered (a
//      malformed answer twice, a fault, an interruption): no-verdict, nothing recorded; the closing step asks again.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshJudgmentSession } from '../backends/argv.ts';
import type { FindingId, JobId, Sha } from '../core/ids.ts';
import { parseInvocationId } from '../core/ids.ts';
import type { EndgameEpisode } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { boundedDiff } from '../git/boundeddiff.ts';
import { jobEvidenceRoot } from '../git/snapshot.ts';
import { removeCheckout } from '../holistic/audit.ts';
import { integrationHeadNow } from '../holistic/cadence.ts';
import { publishedHeads } from '../holistic/coverage.ts';
import { isActive, openFinding } from '../holistic/findings.ts';
import { derivedOf } from '../input/plan.ts';
import { raiseNeedsUser, raisedFor } from '../needsuser.ts';
import { type BackendCallOutcome, type StageContext, callActingJudge, jobSeat, recordedArcCall, repairTurnOf, runOp, verdictOf } from '../pipeline/dispatch.ts';
import { GATE_DIFF_BUDGET } from '../pipeline/gate.ts';
import { removeJobCheckouts } from '../pipeline/lanes.ts';
import { inMs, visionInput } from '../pipeline/stages.ts';
import { judgmentRepairDirective } from '../prompts/directives.ts';
import { promptFor, renderPrompt } from '../prompts/index.ts';
import type { EndgameReviewBrief } from '../prompts/inputs.ts';
import { ENDGAME_REVIEW_SCHEMA, type EndgameReviewOutput, validateEndgameReviewOutput } from '../prompts/schemas.ts';
import { worktreeCreateOp } from '../recover/ops.ts';
import { reviewRange } from './open.ts';

/** How long the review session may run. */
export const ENDGAME_REVIEW_MIN = 60;

const checkoutOf = (ctx: Pick<StageContext, 'plan'>, job: JobId): AbsPath => absPath(join(ctx.plan().worktreeRoot, ctx.plan().arc, `${job}.review`));

type Read = Readonly<{ kind: 'answered'; output: EndgameReviewOutput }> | Readonly<{ kind: 'failed'; reasons: readonly string[]; refused: boolean }>;

/** Reads a review call. A usage-limit park's item is raised once. */
function readReview(ctx: StageContext, job: JobId, called: BackendCallOutcome): Read {
  const v = verdictOf(ctx, { type: 'job', job }, called);
  switch (v.kind) {
    case 'success':
      try {
        return { kind: 'answered', output: validateEndgameReviewOutput(v.value) };
      } catch (error) {
        if (error instanceof SchemaError) return { kind: 'failed', reasons: [`the answer is off its schema: ${error.message}`], refused: true };
        throw error;
      }
    case 'malformed':
      return { kind: 'failed', reasons: [`malformed answer: ${v.detail}`], refused: true };
    case 'interrupted': {
      if (v.needsUser !== null) {
        const parent = { type: 'op', op: parseInvocationId(called.inv).op } as const;
        if (raisedFor(ctx.journal.view, parent) === null) raiseNeedsUser(ctx.journal, ctx.runDir, v.needsUser, parent);
      }
      return { kind: 'failed', reasons: [`interrupted: ${v.reason}`], refused: false };
    }
    default:
      return { kind: 'failed', reasons: [`${v.kind}: ${v.detail}`], refused: false };
  }
}

/** The brief of the review of `episode`'s range `from..to`, its publications those after `since` (see the header). */
function briefOf(ctx: StageContext, episode: EndgameEpisode, from: Sha, since: number, to: Sha, checkout: AbsPath, evidenceDir: AbsPath): EndgameReviewBrief {
  const view = ctx.journal.view;
  return {
    vision: visionInput(ctx),
    range: { from, to },
    diff: boundedDiff(ctx.repo, from, to, {
      budget: GATE_DIFF_BUDGET, derived: [...new Set(derivedOf(ctx.plan()).flatMap((d) => d.outputs))].sort(), removes: null, dir: absPath(join(evidenceDir, 'diff')),
    }),
    fixes: episode.fixes.map((f) => ({ command: f.command, closes: f.closes, commit: f.commit, note: f.note })),
    publications: publishedHeads(view).filter((h) => h.seq > since).map((h) => ({
      head: h.head, what: h.subject === 'unit' ? `unit publication (${h.op})` : `${h.subject} ${h.pub}`, gated: h.subject === 'unit' || h.subject === 'batch',
    })),
    findings: view.holistic().findings.filter(isActive).map((f) => `${f.id} ${f.severity} ${f.lens} (${f.state}): ${f.claim}`),
    checkout, evidenceDir,
  };
}

/** The review of `episode` by `job` (see the header): reviewed (its findings recorded) or no verdict. */
export async function runEndgameReview(ctx: StageContext, job: JobId, episode: EndgameEpisode): Promise<Readonly<{ kind: 'reviewed'; findings: readonly FindingId[] }> | Readonly<{ kind: 'no-verdict'; detail: string }>> {
  if (episode.opened === null) throw new Error(`${job}: a review of endgame episode ${episode.episode}, which has not opened`);
  const { from, since } = reviewRange(ctx, episode);
  const to = integrationHeadNow(ctx);
  const parent = { type: 'job', job } as const;
  const checkout = checkoutOf(ctx, job);
  const evidenceDir = jobEvidenceRoot(ctx.runDir, job);
  mkdirSync(evidenceDir, { recursive: true });
  const prompt = promptFor('verifier', jobSeat(ctx, 'verifier').triple.model);
  let made = false;
  const ensureCheckout = async (): Promise<void> => {
    if (made || existsSync(checkout)) return;
    await removeJobCheckouts(ctx, job);
    await runOp(ctx.journal, worktreeCreateOp(ctx.repo), `worktree:${job}:review`, parent, { path: checkout, checkout: { type: 'detached', at: to } });
    made = true;
  };
  const ask = async (attempt: number, repair: Readonly<{ reasons: readonly string[]; inv: BackendCallOutcome['inv'] }> | null): Promise<Readonly<{ read: Read; called: BackendCallOutcome }>> => {
    let called = recordedArcCall(ctx, job, 'verifier', attempt);
    if (called === null || called.kind === 'lost') {
      await ensureCheckout();
      const turn = repair === null ? null : repairTurnOf(ctx.runDir, repair.inv);
      called = await callActingJudge(ctx, {
        job, role: 'verifier', attempt, system: prompt.system, cwd: checkout, evidenceDirs: [evidenceDir], mcpConfig: null, deadlineAt: inMs(ENDGAME_REVIEW_MIN * 60_000),
        ...(repair === null || turn === null
          ? { ...renderPrompt(prompt, { mode: 'endgame', brief: briefOf(ctx, episode, from, since, to, checkout, evidenceDir) }), schema: ENDGAME_REVIEW_SCHEMA, session: freshJudgmentSession() }
          : { prompt: null, rendered: judgmentRepairDirective(repair.reasons), schema: turn.schema, session: turn.session }),
      });
    }
    return { read: readReview(ctx, job, called), called };
  };
  try {
    const first = await ask(1, null);
    let read = first.read;
    if (read.kind === 'failed' && read.refused && (recordedArcCall(ctx, job, 'verifier', 2) !== null || repairTurnOf(ctx.runDir, first.called.inv) !== null)) {
      read = (await ask(2, { reasons: read.reasons, inv: first.called.inv })).read;
    }
    if (read.kind === 'failed') return { kind: 'no-verdict', detail: read.reasons.join('; ') };
    const findings: FindingId[] = [];
    for (const f of read.output.findings) {
      const opened = openFinding(ctx.journal, {
        lens: 'endgame-review', severity: f.severity, obligation: null, visionClauses: [], claim: f.text, cause: f.text,
        evidence: [...(f.path === null ? [] : [f.path]), ...f.evidence].map((path) => ({ path, blob: null })), mutant: null, source: { type: 'job', job }, gateHadPassed: false,
      });
      if (opened.kind !== 'suppressed') findings.push(opened.id);
    }
    ctx.journal.fact({ kind: 'endgame-reviewed', job, from, to, findings });
    return { kind: 'reviewed', findings };
  } finally {
    if (existsSync(checkout)) await removeCheckout(ctx, job, checkout);
  }
}
