// The arc under test's log as M5 reads it (`logOf`, shared by the driver and check.ts), and the driver's stop rule over
// it (`evidenceComplete`).
//
// The stop rule. M5 proves dev.13 (milestones, design-first, the node, walks, the walk → repair → re-walk loop, polish,
// the demo), not arc convergence (m1's job): once that evidence is complete the rest of the arc is audit tail, so the
// driver stops the arc there (`endedBy: evidence-complete`). Complete, over the log and the plan in force:
//   - every milestone of the plan has a `milestone-passed`, and a `demo-promoted` follows the last of them; the demo was
//     promoted on the SHA the latest round's walk (of any milestone) confirmed (the demo promotes the settled milestone
//     whose closing walk is the latest, src/demo/promote.ts: run 5's MS-2 settled 48 ms before its promotion);
//   - no walk and no compare is in flight (`walk-started` without its `walk-ended`; `compare-started` closed by neither
//     `compare-abandoned` nor its unit's `tweak-judged`);
//   - no walk is due: per milestone, its last round's walk (ended `reported` or `bring-up-failed`) admitted units (the
//     polish units of its applied proposals, the units whose specs repair one of its findings); when one of them landed
//     and the round is below `walkRounds`, the next round's walk is due, unless that round was abandoned WALK_ATTEMPTS
//     times (the brake). And no author has yet to act on that round: none of its findings is still untouched (no
//     transition: the checkpoint has not weighed it) and each applied proposal is in a polish unit or refused;
//   - no walk-originated unit is pending: every polish unit, and every unit whose spec repairs a walkthrough finding, is
//     published or cut (followed to its lineage head: a unit re-entered is carried on by the unit re-entering it);
//   - every polish unit has its `tweak-judged`, or was cut.
// This mirrors src/walk/milestones.ts's rounds from the log alone (the rewalk reset of an apply aside), so the stop does
// not lean on the code under test; check.ts's `milestones-settled` grades the same rule at the end.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Event, Fact, IntentOf, TweakDecision, TweakReason, WalkOutcome } from '../../src/core/events.ts';
import type { ArcId, Sha256Hex } from '../../src/core/ids.ts';
import type { JournalView } from '../../src/core/interfaces.ts';
import { readJournal } from '../../src/core/log.ts';
import { specRepairs } from '../../src/core/records.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import type { FindingTo } from '../../src/holistic/types.ts';
import { PLAN_INPUT, SPEC_INPUT, keptInput, specShaInForce } from '../../src/input/inforce.ts';
import { type PlanM1, milestonesOf, parsePlan, walkRoundsOf } from '../../src/input/plan.ts';
import { parseSpec } from '../../src/spec/spec.ts';
import { WALK_ATTEMPTS } from '../../src/walk/milestones.ts';

/**
 * `interrupted`: an abandoned walk a pause, a stop or a backend park cut short (no try of its round's brake; absent: false).
 * `findings`, `proposals`, `dropped`: its `walk-ended`'s ([] until it ends).
 */
export type Walk = Readonly<{
  job: string; milestone: string; round: number; sha: string; seq: number; outcome: WalkOutcome | null; interrupted?: boolean;
  findings: readonly string[]; proposals: readonly string[]; dropped: readonly string[];
}>;
/** A polish unit's compare job (agent D): `abandoned` without a judgment, `interrupted` when a pause, stop or park cut it short. */
export type CompareLog = Readonly<{ job: string; unit: string; seq: number; abandoned: boolean; interrupted: boolean }>;
export type FindingLog = Readonly<{ id: string; seq: number; lens: string; milestone: string | null; claim: string; cause: string | null; transitions: readonly Readonly<{ seq: number; to: FindingTo }>[] }>;
export type M5Log = Readonly<{
  /** Each unit's first `dispatch` fact. */
  firstDispatch: ReadonlyMap<string, number>;
  /** Unit publications (a published `integration.ff` with a stage parent): the seq of the done, the commit published. */
  publications: readonly Readonly<{ seq: number; unit: string; commit: string }>[];
  walks: readonly Walk[];
  passed: readonly Readonly<{ seq: number; milestone: string; job: string }>[];
  findings: readonly FindingLog[];
  tweaks: readonly Readonly<{ seq: number; unit: string; decision: TweakDecision; reason: TweakReason }>[];
  /** Agent D: the compare jobs (`compare-started`, closed by `compare-abandoned` or the unit's `tweak-judged`). */
  compares: readonly CompareLog[];
  /** The proposals the code-applied polish revision refused (`polish-refused`). */
  refused: readonly string[];
  demos: readonly Readonly<{ seq: number; milestone: string; sha: string }>[];
}>;

export function logOf(events: readonly Event[]): M5Log {
  const firstDispatch = new Map<string, number>();
  const ffs = new Map<string, IntentOf<'integration.ff'>>();
  const publications: { seq: number; unit: string; commit: string }[] = [];
  type W = { -readonly [K in keyof Walk]: Walk[K] };
  const walks = new Map<string, W>();
  const compares = new Map<string, { job: string; unit: string; seq: number; abandoned: boolean; interrupted: boolean }>();
  const passed: M5Log['passed'][number][] = [];
  const findings = new Map<string, { id: string; seq: number; lens: string; milestone: string | null; claim: string; cause: string | null; transitions: { seq: number; to: FindingTo }[] }>();
  const tweaks: M5Log['tweaks'][number][] = [];
  const refused: string[] = [];
  const demos: M5Log['demos'][number][] = [];
  for (const e of events) {
    if (e.type === 'intent' && e.kind === 'integration.ff') ffs.set(e.op, e);
    if (e.type === 'done' && e.kind === 'integration.ff' && e.outcome.kind === 'published') {
      const i = ffs.get(e.op);
      if (i === undefined) throw new Error(`integration.ff ${e.op} done without an intent`);
      if (i.expect.subject === undefined && i.parent.type === 'stage') publications.push({ seq: e.seq, unit: i.parent.unit, commit: i.expect.new });
    }
    if (e.type !== 'fact') continue;
    const f: Fact = e.fact;
    switch (f.kind) {
      case 'dispatch':
        if (!firstDispatch.has(f.record.unit)) firstDispatch.set(f.record.unit, e.seq);
        break;
      case 'walk-started':
        walks.set(f.job, { job: f.job, milestone: f.milestone, round: f.round, sha: f.sha, seq: e.seq, outcome: null, findings: [], proposals: [], dropped: [] });
        break;
      case 'walk-ended': {
        const w = walks.get(f.job);
        if (w === undefined) throw new Error(`walk-ended ${f.job} without its walk-started`);
        w.outcome = f.outcome;
        w.findings = f.findings;
        w.proposals = f.proposals;
        w.dropped = f.dropped;
        if (f.interrupted === true) w.interrupted = true;
        break;
      }
      case 'compare-started':
        compares.set(f.job, { job: f.job, unit: f.unit, seq: e.seq, abandoned: false, interrupted: false });
        break;
      case 'compare-abandoned': {
        const c = compares.get(f.job);
        if (c === undefined) throw new Error(`compare-abandoned ${f.job} without its compare-started`);
        c.abandoned = true;
        c.interrupted = f.interrupted === true;
        break;
      }
      case 'milestone-passed':
        passed.push({ seq: e.seq, milestone: f.milestone, job: f.job });
        break;
      case 'finding-opened':
        findings.set(f.id, { id: f.id, seq: e.seq, lens: f.lens, milestone: f.milestone ?? null, claim: f.claim, cause: f.cause ?? null, transitions: [] });
        break;
      case 'finding-transition': {
        const x = findings.get(f.id);
        if (x === undefined) throw new Error(`finding-transition ${f.id} without its finding-opened`);
        x.transitions.push({ seq: e.seq, to: f.to });
        break;
      }
      case 'tweak-judged':
        tweaks.push({ seq: e.seq, unit: f.unit, decision: f.decision, reason: f.reason });
        break;
      case 'polish-refused':
        refused.push(f.proposal);
        break;
      case 'demo-promoted':
        demos.push({ seq: e.seq, milestone: f.milestone, sha: f.sha });
        break;
      default:
        break;
    }
  }
  return { firstDispatch, publications, walks: [...walks.values()], passed, findings: [...findings.values()], tweaks, compares: [...compares.values()], refused, demos };
}

// ---------------------------------------------------------------------------------------------------
// The stop rule (see the header)

/** What each unit's spec in force repairs (finding and obligation ids); units repairing nothing may be absent. */
export type Repairs = ReadonlyMap<string, readonly string[]>;
export type Evidence = Readonly<{ complete: boolean; detail: string }>;

/** The plan fields the rule reads. */
export type EvidencePlan = Pick<PlanM1, 'units' | 'milestones' | 'limits'>;

export function evidenceComplete(log: M5Log, plan: EvidencePlan, repairs: Repairs): Evidence {
  const missing: string[] = [];
  const published = new Set(log.publications.map((p) => p.unit));
  const cut = new Set(plan.units.filter((u) => u.cut !== undefined).map((u) => u.id as string));
  const reenteredBy = new Map(plan.units.flatMap((u) => (u.reenters === undefined ? [] : [[u.reenters.unit as string, u.id as string] as const])));
  const headOf = (u: string): string => {
    for (let h = u; ; ) {
      const next = reenteredBy.get(h);
      if (next === undefined) return h;
      h = next;
    }
  };
  const landed = (u: string): boolean => published.has(headOf(u));
  const settled = (u: string): boolean => landed(u) || cut.has(headOf(u));
  const repairsOf = (u: string): readonly string[] => repairs.get(u) ?? [];
  const polishUnits = plan.units.filter((u) => u.polish !== undefined);

  const milestones = milestonesOf(plan);
  const passes = milestones.map((m) => log.passed.findLast((p) => p.milestone === m.id) ?? null);
  milestones.forEach((m, i) => {
    if (passes[i] === null) missing.push(`${m.id} has no milestone-passed`);
  });
  const passSeq = Math.max(0, ...passes.map((p) => p?.seq ?? 0));
  if (milestones.length === 0) missing.push('the plan has no milestones');
  else if (!passes.includes(null) && !log.demos.some((d) => d.seq > passSeq)) missing.push(`no demo-promoted after the last milestone-passed (seq ${passSeq})`);
  const closing = log.walks.filter((w) => w.outcome !== null && w.outcome !== 'abandoned').at(-1);
  if (closing !== undefined && !log.demos.some((d) => d.sha === closing.sha)) missing.push(`the demo was never promoted on ${closing.job}'s SHA ${closing.sha}`);

  for (const w of log.walks) if (w.outcome === null) missing.push(`${w.job} (${w.milestone} round ${w.round}) is in flight`);
  for (const c of log.compares) {
    if (!c.abandoned && !log.tweaks.some((t) => t.unit === c.unit && t.seq > c.seq)) missing.push(`${c.job} (${c.unit}) is in flight`);
  }

  const walkRounds = walkRoundsOf(plan);
  const findingState = new Map(log.findings.map((f) => [f.id, f]));
  for (const m of milestones) {
    const walks = log.walks.filter((w) => w.milestone === m.id);
    const last = walks.filter((w) => w.outcome !== null && w.outcome !== 'abandoned').at(-1);
    if (last === undefined) continue;
    const dropped = new Set(last.dropped);
    const applied = last.proposals.filter((p) => !dropped.has(p));
    const untouched = last.findings.filter((f) => (findingState.get(f)?.transitions.length ?? 0) === 0);
    if (untouched.length > 0) missing.push(`${last.job}'s ${untouched.join(', ')} not yet weighed`);
    const unplaced = applied.filter((p) => !polishUnits.some((u) => u.polish!.proposal === p) && !log.refused.includes(p));
    if (unplaced.length > 0) missing.push(`${last.job}'s proposal ${unplaced.join(', ')} in no polish unit yet`);
    const admitted = plan.units.filter((u) => (u.polish !== undefined && applied.includes(u.polish.proposal)) || repairsOf(u.id).some((r) => last.findings.includes(r))).map((u) => u.id as string);
    if (last.round < walkRounds && admitted.some(landed)) {
      const tries = walks.filter((w) => w.seq > last.seq && w.round === last.round + 1 && w.outcome === 'abandoned' && w.interrupted !== true).length;
      if (tries < WALK_ATTEMPTS) missing.push(`${m.id} round ${last.round + 1}'s walk is due (${admitted.filter(landed).join(', ')} landed after ${last.job})`);
    }
  }

  const walkFindings = new Set(log.findings.filter((f) => f.lens === 'walkthrough').map((f) => f.id));
  const walkOriginated = plan.units.filter((u) => u.polish !== undefined || repairsOf(u.id).some((r) => walkFindings.has(r))).map((u) => u.id as string);
  const pending = walkOriginated.filter((u) => !settled(u));
  if (pending.length > 0) missing.push(`walk-originated ${pending.join(', ')} neither published nor cut`);
  const unjudged = polishUnits.filter((u) => u.cut === undefined && !log.tweaks.some((t) => t.unit === u.id)).map((u) => u.id);
  if (unjudged.length > 0) missing.push(`polish ${unjudged.join(', ')} not judged`);

  if (missing.length > 0) return { complete: false, detail: missing.join('; ') };
  return {
    complete: true,
    detail: `${milestones.map((m, i) => `${m.id} passed at seq ${passes[i]!.seq}`).join(', ')}; demo promoted at seq ${log.demos.at(-1)!.seq}; `
      + `${walkOriginated.length} walk-originated unit(s) settled (${walkOriginated.join(', ') || 'none'}); ${log.walks.length} walk(s), ${log.tweaks.length} tweak(s) judged`,
  };
}

// ---------------------------------------------------------------------------------------------------
// The run dir

export type ArcLog = Readonly<{ dir: AbsPath; view: JournalView; log: M5Log; plan: PlanM1 }>;

function kept(dir: AbsPath, sha: Sha256Hex, ext: string): Buffer {
  const bytes = keptInput(dir, sha, ext);
  if (bytes === null) throw new Error(`${dir} keeps no inputs/${sha}.${ext}`);
  return bytes;
}

/** The arc's run-dir log with its plan in force; null before its first plan. */
export function readArcLog(dir: AbsPath, arc: ArcId): ArcLog | null {
  if (!existsSync(join(dir, 'events.jsonl'))) return null;
  const { view, events } = readJournal(dir, arc);
  const applied = view.planApplied();
  if (applied === null) return null;
  return { dir, view, log: logOf(events), plan: parsePlan(JSON.parse(kept(dir, applied.planSha256, PLAN_INPUT).toString('utf8'))) };
}

/** What each unit's spec in force repairs (read from the run dir's kept specs). */
export const repairsOf = (a: ArcLog): Repairs => new Map(a.plan.units.map((u) => {
  const sha = specShaInForce(a.view, u.id);
  return [u.id as string, specRepairs(parseSpec(kept(a.dir, sha, SPEC_INPUT), absPath(join(a.dir, 'inputs', `${sha}.${SPEC_INPUT}`))))] as const;
}));
