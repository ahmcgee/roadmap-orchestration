// The park schedule (M2, A8, D2; SCHEMAS.md "Park schedule"): when each probe target is due, the backoff each
// failed probe records (`nextProbeAt`), escalation after 6 h, and the breaker. All of it is derived from the
// log: the parks (`UnitState.park`), backend parks and the latest probe per target. Nothing here runs a probe
// (src/park/probe.ts does); `raiseDue` raises the non-blocking items the schedule calls for, once each.
//
// - Due: a target is due when a current park it is outstanding for has no probe yet (the first probe runs at
//   once, and a park that arrived after the latest probe started is probed at once too, G7), or when its
//   latest probe failed and its `nextProbeAt` has passed. A backend under a usage-limit park is never probed
//   (D4: no auto-retry); `resume --backend` clears it.
// - Backoff: a probe that fails where the previous one (covering some of the same parks) failed too waits
//   one step longer: 1, 2, 4, 8, 16, 30, 30… minutes. The step is read back from the previous fact's
//   interval, so a restart keeps it.
// - Escalation: a retryable unit park unrecovered PARK_ESCALATE_MS after it parked raises one non-blocking
//   `park-escalated` item; probing goes on at the cap (D2).
// - Breaker: BREAKER_UNITS distinct units parked on one target within BREAKER_WINDOW_MS of each other trip
//   it while those parks are outstanding; admission reads `trippedTargets` (A17), and one non-blocking
//   `env-blocked` item is raised per trip.
import { type Parent, type ProbeTarget, RETRYABLE_BACKEND_PARKS, probeTargetKey } from '../core/events.ts';
import type { NeedsUserId, UnitId } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { NeedsUserContent, NeedsUserReason } from '../core/records.ts';
import type { ParkState, ProbeState, UnitState } from '../core/state.ts';
import { type AbsPath, type IsoTime, isoTimeOf } from '../core/values.ts';
import { raiseNeedsUser, readNeedsUser } from '../needsuser.ts';
import {
  BREAKER_UNITS, BREAKER_WINDOW_MS, PARK_ESCALATE_MS, PROBE_BACKOFF_MIN, type ProbeJob,
} from '../schedule/types.ts';

const MINUTE_MS = 60_000;
const LAST_STEP = PROBE_BACKOFF_MIN.length - 1;

// ---------------------------------------------------------------------------------------------------
// Parks

/** A unit's current retryable park, and the targets no covering probe has passed yet. */
export type RetryablePark = Readonly<{ unit: UnitState; park: ParkState; outstanding: readonly ProbeTarget[] }>;

/**
 * Every unit parked retryable, in unit id order. Only `park-pending` units count: a cut or superseded unit
 * keeps its park in the fold, but is never probed, escalated or counted by a breaker.
 */
export function retryableParks(view: JournalView): readonly RetryablePark[] {
  const out: RetryablePark[] = [];
  for (const id of view.plannedUnits()) {
    const unit = view.unit(id);
    const park = unit.park;
    if (unit.status !== 'park-pending' || park === null || park.park.class !== 'retryable') continue;
    const passed = new Set(park.passed.map(probeTargetKey));
    out.push({ unit, park, outstanding: park.park.targets.filter((t) => !passed.has(probeTargetKey(t))) });
  }
  return out;
}

/** The stage attempt whose outcome parked the unit: what its items answer for (`raisedFor`). */
export function parkParent(unit: UnitState): Extract<Parent, { type: 'stage' }> {
  const d = unit.decided;
  if (d === null || d.class !== 'park') throw new Error(`unit ${unit.unit} is not parked`);
  return { type: 'stage', unit: unit.unit, stage: d.stage, attempt: d.attempt };
}

// ---------------------------------------------------------------------------------------------------
// Due probes and backoff

/**
 * Every target a current park is outstanding for, with the park seqs a probe started now would cover: the
 * unit parks, and the backend's own park while its class is retryable. A usage-limited backend is left out
 * altogether (D4).
 */
export function probeTargets(view: JournalView): readonly ProbeJob[] {
  const jobs = new Map<string, { target: ProbeTarget; covers: Set<number> }>();
  const add = (target: ProbeTarget, seq: number): void => {
    const key = probeTargetKey(target);
    const job = jobs.get(key) ?? { target, covers: new Set<number>() };
    job.covers.add(seq);
    jobs.set(key, job);
  };
  for (const p of retryableParks(view)) for (const t of p.outstanding) add(t, p.park.seq);
  const limited = new Set<string>();
  for (const b of view.backendParks()) {
    const target: ProbeTarget = { type: 'backend', backend: b.backend };
    if ((RETRYABLE_BACKEND_PARKS as readonly string[]).includes(b.class)) add(target, b.seq);
    else limited.add(probeTargetKey(target));
  }
  return [...jobs].filter(([key]) => !limited.has(key)).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, j]) => ({ target: j.target, covers: [...j.covers].sort((a, b) => a - b) }));
}

const latestProbe = (view: JournalView, target: ProbeTarget): ProbeState | null =>
  view.probes().find((p) => probeTargetKey(p.target) === probeTargetKey(target)) ?? null;

/** Whether `job`'s target is due at `now`, given its latest probe. */
export function isDue(job: ProbeJob, prev: ProbeState | null, now: Date): boolean {
  if (prev === null || prev.result === 'pass') return true;
  if (job.covers.some((seq) => !prev.covers.includes(seq))) return true;
  return Date.parse(prev.nextProbeAt as IsoTime) <= now.getTime();
}

/** The probe jobs due at `now` (SCHEMAS.md `Prober.due`), except those of targets in `running`. */
export function dueJobs(view: JournalView, now: Date, running: ReadonlySet<string> = new Set()): readonly ProbeJob[] {
  return probeTargets(view).filter((job) => !running.has(probeTargetKey(job.target)) && isDue(job, latestProbe(view, job.target), now));
}

/** The backoff step a probe fact recorded (1 for 1 minute … LAST_STEP for the cap), read from its interval. */
function stepOf(p: ProbeState): number {
  const minutes = (Date.parse(p.nextProbeAt as IsoTime) - Date.parse(p.at)) / MINUTE_MS;
  let best = 1;
  for (let i = 1; i <= LAST_STEP; i++) if (Math.abs(PROBE_BACKOFF_MIN[i]! - minutes) < Math.abs(PROBE_BACKOFF_MIN[best]! - minutes)) best = i;
  return best;
}

/**
 * When a probe of `target` covering `covers` that fails at `now` is next due: one step after the previous
 * failed probe of the target when that one covered some of the same parks, else the first step (1 minute).
 */
export function nextProbeAt(view: JournalView, target: ProbeTarget, covers: readonly number[], now: Date): IsoTime {
  const prev = latestProbe(view, target);
  const continues = prev !== null && prev.result === 'fail' && covers.some((seq) => prev.covers.includes(seq));
  const step = continues ? Math.min(stepOf(prev) + 1, LAST_STEP) : 1;
  return isoTimeOf(new Date(now.getTime() + PROBE_BACKOFF_MIN[step]! * MINUTE_MS));
}

// ---------------------------------------------------------------------------------------------------
// Escalation (D2)

export const escalateAt = (park: ParkState): Date => new Date(Date.parse(park.at) + PARK_ESCALATE_MS);

export type DueItem = Readonly<{ parent: Extract<Parent, { type: 'stage' }>; content: NeedsUserContent }>;

const targetText = (targets: readonly ProbeTarget[]): string => targets.map(probeTargetKey).join(', ');

/** The `park-escalated` items due at `now`: one per retryable park at least PARK_ESCALATE_MS old. */
export function escalationsDue(view: JournalView, now: Date): readonly DueItem[] {
  return retryableParks(view).filter((p) => escalateAt(p.park).getTime() <= now.getTime()).map((p) => {
    const parent = parkParent(p.unit);
    return {
      parent,
      content: {
        blocking: false,
        subject: { type: 'unit', unit: p.unit.unit },
        reason: 'park-escalated',
        summary: `Unit ${p.unit.unit} has been parked at ${parent.stage} (attempt ${parent.attempt}) since ${p.park.at}, more than 6 h, `
          + `waiting on ${targetText(p.outstanding)}. It is probed every 30 minutes and re-runs ${parent.stage} once every target passes.`,
        recommendation: `Check what keeps ${targetText(p.outstanding)} failing (\`roadmap status\` shows each probe's last result). `
          + `Nothing needs doing for the unit itself: it recovers on its own once the environment does.`,
        options: [],
        evidence: [],
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------------
// The breaker

export type Trip = Readonly<{ target: ProbeTarget; units: readonly UnitId[]; parents: readonly Extract<Parent, { type: 'stage' }>[] }>;

/**
 * The tripped targets: BREAKER_UNITS or more distinct units whose current parks are outstanding on the target
 * and parked within BREAKER_WINDOW_MS of each other. `units` and `parents` are every such park's, oldest first.
 */
export function trips(view: JournalView): readonly Trip[] {
  const byTarget = new Map<string, { target: ProbeTarget; parks: RetryablePark[] }>();
  for (const p of retryableParks(view)) {
    for (const t of p.outstanding) {
      const entry = byTarget.get(probeTargetKey(t)) ?? { target: t, parks: [] };
      entry.parks.push(p);
      byTarget.set(probeTargetKey(t), entry);
    }
  }
  const out: Trip[] = [];
  for (const [, { target, parks }] of [...byTarget].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sorted = [...parks].sort((a, b) => a.park.seq - b.park.seq);
    const within = (i: number): boolean => {
      const window = sorted.slice(i, i + BREAKER_UNITS);
      return window.length === BREAKER_UNITS && Date.parse(window.at(-1)!.park.at) - Date.parse(window[0]!.park.at) <= BREAKER_WINDOW_MS;
    };
    if (!sorted.some((_, i) => within(i))) continue;
    out.push({ target, units: sorted.map((p) => p.unit.unit), parents: sorted.map((p) => parkParent(p.unit)) });
  }
  return out;
}

/** What admission reads (`AdmitInput.tripped`, A17). */
export const trippedTargets = (view: JournalView): readonly ProbeTarget[] => trips(view).map((t) => t.target);

function breakerItem(trip: Trip): DueItem {
  const parent = trip.parents.at(-1)!;
  return {
    parent,
    content: {
      blocking: false,
      subject: { type: 'arc' },
      reason: 'env-blocked',
      summary: `Probe target ${probeTargetKey(trip.target)} tripped its breaker: units ${trip.units.join(', ')} parked on it within an hour. `
        + `Stages that need it are not admitted until its probe passes; probing goes on.`,
      recommendation: `Fix ${probeTargetKey(trip.target)} on this host; the parks recover on the next passing probe.`,
      options: [],
      evidence: [],
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Raising what is due, once each

/** Whether a done raise parented by `parent` recorded an item with `reason`. */
function raisedWith(view: JournalView, runDir: AbsPath, parent: Parent, reason: NeedsUserReason): boolean {
  const key = canonicalJson(parent);
  return view.opsOf('needsuser.raise').some((i) => canonicalJson(i.parent) === key && view.doneOf(i.op) !== null
    && readNeedsUser(runDir, i.expect.id)?.reason === reason);
}

/**
 * Raises the schedule's items due at `now` that are not raised yet: each escalation (parented by its park's
 * attempt), and one `env-blocked` item per trip (parented by the trip's latest park; a trip whose parks
 * already carry one raises nothing). Synchronous, like every raise. Returns the ids raised.
 */
export function raiseDue(journal: Journal, runDir: AbsPath, now: Date): readonly NeedsUserId[] {
  const raised: NeedsUserId[] = [];
  for (const item of escalationsDue(journal.view, now)) {
    if (raisedWith(journal.view, runDir, item.parent, 'park-escalated')) continue;
    raised.push(raiseNeedsUser(journal, runDir, item.content, item.parent));
  }
  for (const trip of trips(journal.view)) {
    if (trip.parents.some((p) => raisedWith(journal.view, runDir, p, 'env-blocked'))) continue;
    const item = breakerItem(trip);
    raised.push(raiseNeedsUser(journal, runDir, item.content, item.parent));
  }
  return raised;
}
