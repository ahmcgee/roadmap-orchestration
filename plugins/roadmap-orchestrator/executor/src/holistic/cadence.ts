// Campaign audits run at reached milestones, on root request, and over the final outstanding range.
// One fresh campaign seat judges invariants, vacuity and cross-unit interactions together. An abandoned
// audit retries after AUDIT_RETRY_MIN, or immediately for a new root request. No rolling lens, drift,
// publication-count or wall-clock cadence remains. Clocks delay retries after restart, never fire early.
import { isActive } from './findings.ts';
import { lensCoverage, coverageBase, type CoverageBase } from './coverage.ts';
import { milestoneReached } from '../walk/milestones.ts';
import type { AuditTrigger, LensKind } from './types.ts';
import type { Sha } from '../core/ids.ts';
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

/** What an audit started now records: its coalesced triggers, the lenses they call for (ascending), its generation. */
export type AuditPlan = Readonly<{ triggers: readonly AuditTrigger[]; lenses: readonly LensKind[]; generation: number }>;

/** The cadence now: the base, the owed triggers (as an audit would record them), whether one is due, and whether one is due. */
export type Cadence = Readonly<{
  base: CoverageBase;
  /** The integration head now. */
  head: Sha;
  owed: readonly AuditTrigger[];
  due: boolean;
  plan: AuditPlan | null;
}>;

/** The integration head now. */
export const integrationHeadNow = (ctx: Pick<StageContext, 'repo' | 'plan'>): Sha => revParse(ctx.repo, branchRef(ctx.plan().integrationBranch));

const TERMINAL = ['retired', 'cut', 'superseded'];

/** Whether a unit of the plan in force can still publish. */
export const workRemains = (ctx: Pick<StageContext, 'journal' | 'plan'>): boolean => ctx.plan().units.some((u) => !TERMINAL.includes(ctx.journal.view.unit(u.id).status));

/** The latest audit whose outcome is `completed`, or null. */
const lastCompleted = (audits: readonly AuditState[]): AuditState | null => audits.filter((a) => a.ended?.outcome === 'completed').at(-1) ?? null;

/** The cadence now; null outside a holistic arc. */
export function cadence(ctx: StageContext, clock: Clock): Cadence | null {
  const view = ctx.journal.view;
  if (!view.holistic().on || ctx.plan().holistic === undefined) return null;
  const base = coverageBase(ctx, integrationHeadNow(ctx));
  if (base === null) return null;
  const head = integrationHeadNow(ctx);
  const fold = view.holistic();
  const audited = new Set(fold.audits.filter((a) => a.ended?.outcome === 'completed').flatMap((a) => a.started.triggers.filter((t) => t.type === 'milestone').map((t) => t.type === 'milestone' ? t.milestone : '')));
  const milestone = (ctx.plan().milestones ?? []).find((m) => milestoneReached(view, m) && !audited.has(m.id));
  const latest = fold.audits.at(-1);
  const requested = fold.auditRequests.find((q) => q.seq > (lastCompleted(fold.audits)?.started.seq ?? 0));
  const final = !workRemains(ctx) && !fold.findings.some(f => f.severity === 'P1' && isActive(f)) && (!fold.audits.some((a) => a.ended?.outcome === 'completed' && a.started.visionSha256 === base.visionSha256) || lensCoverage(fold, base, 'invariants').watermark !== head);
  const owed: AuditTrigger[] = milestone !== undefined ? [{type: 'milestone', milestone: milestone.id}] : requested !== undefined ? [{type: 'requested', command: requested.command}] : final ? [{type: 'final'}] : [];
  const retryReady = latest?.ended?.outcome !== 'abandoned' || (requested?.seq ?? 0) > latest.started.seq || clock(latest.started.seq) >= AUDIT_RETRY_MIN;
  const due = owed.length > 0 && retryReady && !fold.audits.some((a) => a.ended === null);
  return {base, head, owed, due, plan: due ? {triggers: owed, lenses: ['invariants'], generation: Math.max(0, ...fold.audits.map((a) => a.started.generation)) + 1} : null};
}
