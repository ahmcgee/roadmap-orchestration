// Where each milestone stands (dev.13, plan §2–§4; SCHEMAS.md "dev.13"): derived from the log's walk facts, the plan in
// force and the findings, never stored. Pure but for the repairing units the caller reads (src/pipeline/reproduce.ts
// `repairUnits`: which units' specs repair which findings).
//
// - **Reached**: every unit of the milestone is merged (each followed to its lineage head). The walk of round 1 is due.
// - **A walk** (`walk-<n>`): `walk-started` opens it, `walk-ended` closes it. An `abandoned` walk (its session failed, was
//   interrupted or its backend parked) is not a round: the same round is due again, but a round whose walk failed (not
//   interrupted) WALK_ATTEMPTS times ends `abandoned`: no further walk, not settled (the demo never promotes on it), and
//   its escalation is raised (lead ruling 2026-10-18: a brake, not a retry for ever).
// - **The rounds brake** (plan §4, in code): after round k's walk ended (`reported` or `bring-up-failed`), the units
//   admitted from it are the polish units carrying its applied proposals and the units whose specs repair one of its
//   findings. While an author has yet to act (a finding of the walk is still open, no unit owning it, and no checkpoint
//   that settled a decision under the vision in force weighed it: the walk's checkpoint trigger; or an applied proposal is
//   in no unit of the plan yet and was not refused: agent D's code-applied polish revision, src/walk/polish.ts) or one of
//   those units is in flight, round k is open. Then round k+1's walk is due when at least one of them
//   landed (merged) and k < `walkRounds`; otherwise the milestone settles. A milestone settles at most once: no fact
//   records it; `settledMilestones` is the demo's hook (agent G promotes on it).
// - **The node** (src/walk/node.ts) passes when a walk ends `reported` and the milestone has no active walkthrough P1
//   (`milestone-passed`, written by the walk job, src/walk/walk.ts).
// - **Escalation** (`finding-p1-escalated`, blocking, raised once per walk job): a walkthrough P1 of the walk still open
//   (no unit owns it) PARK_ESCALATE_MS after the walk ended, or the milestone settled with its node unpassed.
import { type FindingId, type JobId, type MilestoneId, type PolishId, type ServeName, type Sha, type UnitId, canonicalIds } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { WalkOutcome } from '../core/events.ts';
import type { NeedsUserContent } from '../core/records.ts';
import type { IsoTime } from '../core/values.ts';
import { type RepairUnit, isActive } from '../holistic/findings.ts';
import { lineageMembers } from '../input/envelope.ts';
import { type Milestone, type PlanM1, milestonesOf, walkRoundsOf } from '../input/plan.ts';
import { PARK_ESCALATE_MS } from '../schedule/types.ts';

/** What the rounds read of the repairing units (`repairUnits`, or the brief's over a ref): each unit and what its spec repairs. */
export type Repairs = readonly Pick<RepairUnit, 'unit' | 'repairs'>[];
import { milestonePassed } from './node.ts';

/** One walk as the log has it: its start, and its end once written. */
export type WalkRecord = Readonly<{
  job: JobId; milestone: MilestoneId; round: number; sha: Sha; ports: Readonly<Record<ServeName, number>>; seq: number; at: IsoTime;
  ended: Readonly<{ outcome: WalkOutcome; findings: readonly FindingId[]; proposals: readonly PolishId[]; dropped: readonly PolishId[]; interrupted: boolean; seq: number; at: IsoTime }> | null;
}>;

/** Every walk in log order (of `milestone` only, when given). */
export function walksOf(view: JournalView, milestone?: MilestoneId): readonly WalkRecord[] {
  const out: WalkRecord[] = [];
  for (const { seq, at, fact: f } of view.walkFacts()) {
    if (f.kind === 'walk-started') {
      if (milestone === undefined || f.milestone === milestone) out.push({ job: f.job, milestone: f.milestone, round: f.round, sha: f.sha, ports: f.ports, seq, at, ended: null });
    } else if (f.kind === 'walk-ended') {
      const i = out.findIndex((w) => w.job === f.job);
      if (i >= 0) out[i] = { ...out[i]!, ended: { outcome: f.outcome, findings: f.findings, proposals: f.proposals, dropped: f.dropped, interrupted: f.interrupted === true, seq, at } };
    }
  }
  return out;
}

/** The walk started and not ended (one at a time, arc-wide), or null. */
export const runningWalk = (view: JournalView): WalkRecord | null => walksOf(view).find((w) => w.ended === null) ?? null;

/** The lineage head of `unit`: the unit itself, or the last unit re-entering it. */
const headOf = (view: JournalView, unit: UnitId): UnitId => lineageMembers(view, unit).at(-1)!;

/** Every unit of `m` is merged (each followed to its lineage head). */
export const milestoneReached = (view: JournalView, m: Milestone): boolean => m.units.every((u) => view.unit(headOf(view, u)).status === 'retired');

/** A round's walk and what it admitted: the units, and what an author has yet to do. */
export type RoundView = Readonly<{
  job: JobId;
  round: number;
  /** The walk's applied proposals: its proposals less those dropped (the last round's are all dropped). */
  applied: readonly PolishId[];
  /** The units admitted from the round (polish and repairs), in plan order. */
  units: readonly UnitId[];
  /**
   * `checkpoint`: a finding of the walk no checkpoint has weighed (`unweighedWalkFindings`); `polish`: an applied proposal
   * is in no unit of the plan yet and was not refused (agent D's polish revision, src/walk/polish.ts, has yet to act).
   */
  pending: 'checkpoint' | 'polish' | null;
  /** The admitted units (lineage heads) neither merged nor cut. */
  inFlight: readonly UnitId[];
  /** The admitted units (lineage heads) merged. */
  landed: readonly UnitId[];
}>;

export type MilestoneProgress =
  /** Not every unit merged yet. */
  | Readonly<{ kind: 'building' }>
  /** The walk of `round` is due: round 1 once reached, a later one by the brake, or a round whose walk was abandoned. */
  | Readonly<{ kind: 'walk-due'; round: number }>
  | Readonly<{ kind: 'walking'; walk: WalkRecord }>
  /** Round `round.round` is open: its authors have yet to act, or its units are in flight. */
  | Readonly<{ kind: 'round-open'; round: RoundView }>
  /** Done: no further walk. `last`: the last round's walk. */
  | Readonly<{ kind: 'settled'; last: WalkRecord }>
  /**
   * No further walk: round `round`'s walk was abandoned WALK_ATTEMPTS times (`last` the latest). The milestone is done but
   * not settled (the demo never promotes on it); `walkItemsDue` raises its escalation.
   */
  | Readonly<{ kind: 'abandoned'; round: number; last: WalkRecord }>;

/**
 * The findings of walk `w` no checkpoint has weighed (agent D): each active and open (no unit owns it) and captured by no
 * checkpoint that settled a decision (applied, no-op or requested) under the vision in force, in id order. The walk's
 * checkpoint trigger is due while any is (src/holistic/checkpoint.ts); none, the trigger is skipped as an audit that found
 * nothing new is.
 */
export function unweighedWalkFindings(view: JournalView, w: WalkRecord): readonly FindingId[] {
  if (w.ended === null) return [];
  const vision = view.planApplied()?.visionSha256;
  const weighed = new Set<string>(view.holistic().checkpoints
    .filter((c) => c.decided !== null && c.decided.kind !== 'rejected' && c.inputs.visionSha256 === vision).flatMap((c) => c.inputs.findings));
  const mine = new Set<string>(w.ended.findings);
  return canonicalIds(view.holistic().findings.filter((f) => mine.has(f.id) && isActive(f) && f.state === 'open' && !weighed.has(f.id)).map((f) => f.id));
}

/** The polish proposals the code-applied polish revision refused (`polish-refused`): settled, never applied. */
export const refusedProposals = (view: JournalView): ReadonlySet<PolishId> =>
  new Set(view.walkFacts().flatMap((x) => (x.fact.kind === 'polish-refused' ? [x.fact.proposal] : [])));

/** Round `walk.round`'s view (its walk ended as a round: reported or bring-up-failed). */
export function roundOf(view: JournalView, plan: PlanM1, walk: WalkRecord, repairs: Repairs): RoundView {
  const ended = walk.ended;
  if (ended === null || ended.outcome === 'abandoned') throw new Error(`${walk.job} did not end as a round`);
  const dropped = new Set(ended.dropped);
  const applied = ended.proposals.filter((p) => !dropped.has(p));
  const findings = new Set<string>(ended.findings);
  const polishUnits = plan.units.filter((u) => u.polish !== undefined && applied.includes(u.polish.proposal)).map((u) => u.id);
  const repairUnits = repairs.filter((r) => r.repairs.some((ref) => findings.has(ref))).map((r) => r.unit);
  const units = plan.units.map((u) => u.id).filter((u) => polishUnits.includes(u) || repairUnits.includes(u));
  const heads = units.map((u) => headOf(view, u));
  const status = (u: UnitId): string => view.unit(u).status;
  const settledProposals = new Set([...plan.units.flatMap((u) => (u.polish === undefined ? [] : [u.polish.proposal])), ...refusedProposals(view)]);
  const pending = unweighedWalkFindings(view, walk).length > 0 ? 'checkpoint' : applied.some((p) => !settledProposals.has(p)) ? 'polish' : null;
  return {
    job: walk.job, round: walk.round, applied, units, pending,
    inFlight: [...new Set(heads.filter((h) => status(h) !== 'retired' && status(h) !== 'cut'))],
    landed: [...new Set(heads.filter((h) => status(h) === 'retired'))],
  };
}

/** Where milestone `m` stands now (see the header). */
export function milestoneProgress(view: JournalView, plan: PlanM1, m: Milestone, repairs: Repairs): MilestoneProgress {
  const walks = walksOf(view, m.id);
  const open = walks.find((w) => w.ended === null);
  if (open !== undefined) return { kind: 'walking', walk: open };
  const rounds = walks.filter((w) => w.ended !== null && w.ended.outcome !== 'abandoned');
  const last = rounds.at(-1);
  if (last === undefined) return milestoneReached(view, m) ? braked(walks, 1, null) : { kind: 'building' };
  const r = roundOf(view, plan, last, repairs);
  if (r.pending !== null || r.inFlight.length > 0) return { kind: 'round-open', round: r };
  return r.landed.length > 0 && last.round < walkRoundsOf(plan) ? braked(walks, last.round + 1, last) : { kind: 'settled', last };
}

/**
 * Walks a round gets: the first and one retry; a round whose walk failed this often ends `abandoned` (the brake, in code).
 * A walk a pause, a stop or a backend park cut short (`walk-ended.interrupted`) is no try.
 */
export const WALK_ATTEMPTS = 2;

/**
 * Round `round` due, unless its walks since `after` (the previous round's walk; null for round 1) were abandoned
 * WALK_ATTEMPTS times: then no further walk, `abandoned` (lead ruling 2026-10-18: a brake, not a retry for ever).
 */
function braked(walks: readonly WalkRecord[], round: number, after: WalkRecord | null): MilestoneProgress {
  const tries = walks.filter((w) => w.round === round && w.ended?.outcome === 'abandoned' && !w.ended.interrupted && (after === null || w.seq > after.seq));
  return tries.length >= WALK_ATTEMPTS ? { kind: 'abandoned', round, last: tries.at(-1)! } : { kind: 'walk-due', round };
}

/** The milestone a walk is due for now (the first in plan order) and its round, or null. */
export function walkDue(view: JournalView, plan: PlanM1, repairs: readonly RepairUnit[]): Readonly<{ milestone: Milestone; round: number }> | null {
  for (const m of milestonesOf(plan)) {
    const p = milestoneProgress(view, plan, m, repairs);
    if (p.kind === 'walk-due') return { milestone: m, round: p.round };
  }
  return null;
}

/** Whether any milestone has a walk due or running or a round open: the arc is not complete (`walk-pending`). */
export const walksPending = (view: JournalView, plan: PlanM1, repairs: readonly RepairUnit[]): boolean =>
  milestonesOf(plan).some((m) => ['walk-due', 'walking', 'round-open'].includes(milestoneProgress(view, plan, m, repairs).kind));

/**
 * The demo's hook (agent G): every settled milestone, with whether its node passed and its last round's walk (job and
 * walked SHA), in plan order.
 */
export function settledMilestones(view: JournalView, plan: PlanM1, repairs: Repairs): readonly Readonly<{ milestone: MilestoneId; passed: boolean; last: WalkRecord }>[] {
  return milestonesOf(plan).flatMap((m) => {
    const p = milestoneProgress(view, plan, m, repairs);
    return p.kind === 'settled' ? [{ milestone: m.id, passed: milestonePassed(view, m.id), last: p.last }] : [];
  });
}

/** The status line's state (SCHEMAS.md "dev.13"): `building` until reached, then `walking | blocked | passed | polishing | settled`. */
export type MilestoneState = 'building' | 'walking' | 'blocked' | 'passed' | 'polishing' | 'settled';

/**
 * Before the node passed: `walking` while a walk is due or running, `blocked` while a round is open or the milestone
 * settled unpassed. After: `passed` while a confirming walk is due or running, `polishing` while a round is open,
 * `settled` once settled.
 */
export function milestoneState(view: JournalView, m: MilestoneId, p: MilestoneProgress): MilestoneState {
  if (p.kind === 'building') return 'building';
  const passed = milestonePassed(view, m);
  switch (p.kind) {
    case 'walk-due':
    case 'walking':
      return passed ? 'passed' : 'walking';
    case 'round-open':
      return passed ? 'polishing' : 'blocked';
    case 'abandoned':
      return passed ? 'settled' : 'blocked';
    case 'settled':
      return passed ? 'settled' : 'blocked';
  }
}

/** The active walkthrough P1s of milestone `m`, in id order. */
export const activeWalkP1s = (view: JournalView, m: MilestoneId): readonly FindingId[] =>
  canonicalIds(view.holistic().findings.filter((f) => f.lens === 'walkthrough' && f.milestone === m && f.severity === 'P1' && isActive(f)).map((f) => f.id));

/** A due `finding-p1-escalated` of a milestone, parented by the walk job it is about. */
export type WalkItem = Readonly<{ job: JobId; content: NeedsUserContent }>;

/**
 * The milestone escalations due at `now` (see the header): per walk, its walkthrough P1s still open PARK_ESCALATE_MS after
 * it ended; per settled milestone with its node unpassed, its last walk. One item per walk job (the first due).
 */
export function walkItemsDue(view: JournalView, plan: PlanM1, repairs: readonly RepairUnit[], now: Date): readonly WalkItem[] {
  const out = new Map<JobId, WalkItem>();
  const findings = view.holistic().findings;
  for (const m of milestonesOf(plan)) {
    for (const w of walksOf(view, m.id)) {
      if (w.ended === null || Date.parse(w.ended.at) + PARK_ESCALATE_MS > now.getTime()) continue;
      const unowned = canonicalIds(findings.filter((f) => w.ended!.findings.includes(f.id) && f.severity === 'P1' && f.state === 'open').map((f) => f.id));
      if (unowned.length === 0 || out.has(w.job)) continue;
      out.set(w.job, {
        job: w.job,
        content: {
          blocking: true, subject: { type: 'arc' }, reason: 'finding-p1-escalated',
          summary: `Milestone ${m.id}'s walk ${w.job} found ${unowned.join(', ')} (P1, it breaks a journey or a floor), and no unit has owned ${unowned.length > 1 ? 'them' : 'it'} for more than 6 h. `
            + `Milestone ${m.id}'s node stays unpassed, so every unit that descends from it waits.`,
          recommendation: `Admit a repair with \`roadmap apply\` (or let the checkpoint admit one), or rule the finding; read the walk's evidence under evidence/jobs/${w.job}/.`,
          options: [], evidence: [],
        },
      });
    }
    const p = milestoneProgress(view, plan, m, repairs);
    if (p.kind === 'abandoned' && !out.has(p.last.job)) {
      const passed = milestonePassed(view, m.id);
      out.set(p.last.job, {
        job: p.last.job,
        content: {
          blocking: !passed, subject: { type: 'arc' }, reason: 'finding-p1-escalated',
          summary: `Milestone ${m.id}'s round ${p.round} walk failed ${WALK_ATTEMPTS} times (its last ${p.last.job}), so no further walk runs`
            + (passed ? '; its node had passed, so nothing waits on it.' : ` and its node never passed: every unit that descends from ${m.id} waits.`),
          recommendation: `Read why under evidence/jobs/${p.last.job}/ and the walk's backend calls (the bring-up, the walkthrough's session); fix the cause (a bring-up or walkthrough MCP problem is the environment's); the round's walks are over, so plan another milestone for the experience with \`roadmap apply\` if it still needs walking, and acknowledge this item.`,
          options: [], evidence: [],
        },
      });
      continue;
    }
    if (p.kind !== 'settled' || milestonePassed(view, m.id) || out.has(p.last.job)) continue;
    const p1s = activeWalkP1s(view, m.id);
    out.set(p.last.job, {
      job: p.last.job,
      content: {
        blocking: true, subject: { type: 'arc' }, reason: 'finding-p1-escalated',
        summary: `Milestone ${m.id}'s walks are over (round ${p.last.round} of ${walkRoundsOf(plan)}, its last ${p.last.job}) and its node never passed`
          + `${p1s.length > 0 ? `: ${p1s.join(', ')} still break${p1s.length > 1 ? '' : 's'} it` : ''}. Every unit that descends from ${m.id} waits.`,
        recommendation: `Decide how ${m.id} passes: repair what breaks it and raise limits.walkRounds, or change the milestone with \`roadmap apply\`; then acknowledge this item.`,
        options: [], evidence: [],
      },
    });
  }
  return [...out.values()];
}
