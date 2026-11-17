// Campaign audits run at reached milestones, on root request, and over the final outstanding range. dev.82: the final audit
// is the endgame's (src/endgame/phase.ts): owed once the arc is in the endgame and no unit runs, active P1s or not (they are
// worklist entries), and again whenever the integration head moved past its watermark, except while an opened episode's
// step is `open` (`deferred`): the architect's landings and repair merges there arm nothing, and the audit runs at
// `closing` (its coverage of the head is an exit condition) or when the root asks (`roadmap audit`). So an endgame audits
// once while settling, to complete the worklist, and once per closing.
// One fresh campaign seat judges invariants, vacuity and cross-unit interactions together. An abandoned
// audit retries after AUDIT_RETRY_MIN, immediately for a new root request, or, abandoned because its lens backend parked
// (`audit-ended.parked`), as soon as that backend is no longer parked. No rolling lens, drift,
// publication-count or wall-clock cadence remains. Clocks delay retries after restart, never fire early.
import { auditedMilestones, openEpisode, phaseKind, runningUnits } from '../endgame/phase.ts';
import { endgameNow, repairsReader } from '../endgame/open.ts';
import { lensCoverage, coverageBase, type CoverageBase } from './coverage.ts';
import { milestoneReached } from '../walk/milestones.ts';
import type { ArcLaneDef, AuditTrigger, LensKind } from './types.ts';
import type { EnvId, Sha } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AuditState } from '../core/state.ts';
import { branchRef } from '../core/values.ts';
import { revParse } from '../git/git.ts';
import type { StageContext } from '../pipeline/dispatch.ts';

/** Backoff after an abandoned campaign audit, in minutes. */
export const AUDIT_RETRY_MIN = 360;

/** Minutes since the fact at `seq` was written. */
export type Clock = (seq: number) => number;

/** The executor's clock: a fact is timed from when this process first asked about it, one older than the process from its start. */
export function processClock(view: JournalView, now: () => number = Date.now): Clock {
  const start = now();
  const known = view.highWater();
  const seen = new Map<number, number>();
  return (seq) => {
    let at = seq <= known ? start : seen.get(seq);
    if (at === undefined) {
      at = now();
      seen.set(seq, at);
    }
    return (now() - at) / 60_000;
  };
}

/**
 * What an audit started now records: its coalesced triggers, the lenses they call for (ascending), its generation, and
 * `whole`: a request pending since the last completed audit asked for the whole range (`audit --whole`).
 */
export type AuditPlan = Readonly<{ triggers: readonly AuditTrigger[]; lenses: readonly LensKind[]; generation: number; whole: boolean }>;

/** The cadence now: the base, the owed triggers (as an audit would record them), whether one is due, and whether one is due. */
export type Cadence = Readonly<{
  base: CoverageBase;
  /** The integration head now. */
  head: Sha;
  owed: readonly AuditTrigger[];
  due: boolean;
  plan: AuditPlan | null;
  /** dev.82: the final audit would be owed, but the opened episode's step is `open`: it runs at `closing`. */
  deferred: boolean;
}>;

/** The integration head now. */
export const integrationHeadNow = (ctx: Pick<StageContext, 'repo' | 'plan'>): Sha => revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));

/** The latest audit whose outcome is `completed`, or null. */
const lastCompleted = (audits: readonly AuditState[]): AuditState | null => audits.filter((a) => a.ended?.outcome === 'completed').at(-1) ?? null;

/**
 * The cadence now; null outside a holistic arc. `laneEnv`: the executor's environment of an arc lane (the scheduler's
 * `HolisticContexts.laneEnv`), which the endgame's step reads through the obligations held on the head.
 */
export function cadence(ctx: StageContext, clock: Clock, laneEnv: (lane: ArcLaneDef) => EnvId | null): Cadence | null {
  const view = ctx.journal.view;
  if (!view.holistic().on || ctx.plan().holistic === undefined) return null;
  const base = coverageBase(ctx, integrationHeadNow(ctx));
  if (base === null) return null;
  const head = integrationHeadNow(ctx);
  const fold = view.holistic();
  const audited = auditedMilestones(fold);
  const milestone = (ctx.plan().milestones ?? []).find((m) => milestoneReached(view, ctx.plan(), m) && !audited.has(m.id));
  const latest = fold.audits.at(-1);
  const pending = fold.auditRequests.filter((q) => q.seq > (lastCompleted(fold.audits)?.started.seq ?? 0));
  const requested = pending[0];
  const endgame = phaseKind(view, ctx.plan(), repairsReader(ctx)).kind === 'endgame' && runningUnits(view, ctx.plan()).length === 0;
  const uncovered = endgame && (!fold.audits.some((a) => a.ended?.outcome === 'completed' && a.started.visionSha256 === base.visionSha256) || lensCoverage(fold, base, 'invariants').watermark !== head);
  // Read only when the final audit would be owed: the step reads the worklist (the obligations on the head) and git.
  const episode = openEpisode(view);
  const step = uncovered && episode !== null && episode.opened !== null ? endgameNow(ctx, laneEnv).phase : null;
  const deferred = step?.kind === 'endgame' && step.step === 'open';
  const final = uncovered && !deferred;
  const owed: AuditTrigger[] = milestone !== undefined ? [{type: 'milestone', milestone: milestone.id}] : requested !== undefined ? [{type: 'requested', command: requested.command}] : final ? [{type: 'final'}] : [];
  const parked = latest?.ended?.parked;
  const retryReady = latest?.ended?.outcome !== 'abandoned' || (requested?.seq ?? 0) > latest.started.seq || clock(latest.started.seq) >= AUDIT_RETRY_MIN
    || (parked !== undefined && !view.parkedBackends().includes(parked));
  const due = owed.length > 0 && retryReady && !fold.audits.some((a) => a.ended === null);
  return {base, head, owed, due, plan: due ? {triggers: owed, lenses: ['invariants'], generation: Math.max(0, ...fold.audits.map((a) => a.started.generation)) + 1, whole: pending.some((q) => q.whole === true)} : null, deferred};
}
