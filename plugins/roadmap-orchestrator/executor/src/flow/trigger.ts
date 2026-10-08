// Flow-run triggers (plan "Triggers and the job", RC-5, OI-1), pure. Each is evidence that arrived after the last run's
// start (the arc's start before any run), coalesced in `FLOW_TRIGGERS` order:
//   - `buffer-red`: rule 1 on the frozen chart (src/flow/spc.ts), the latest point red and merged since, or an in-flight
//     unit red now that was not at the last run's start (its age then: its age now less the time since; no limits, no
//     trigger: a self-seeded chart has none before its fifth merge);
//   - `yellow-worsening`: rule 2, the latest point merged since;
//   - `constraint-shift`: once ≥ 3 points exist (OI-1), code's label (station and slot component) differs from the one the
//     last ended run recorded, or no run has recorded one (the first label);
//   - `verdict-closed`: a `flow-verdict` since; `floor`: 10 merges since; `requested`: a `flow-requested` since.
// The cooldown runs 120 minutes from the last run's start. Inside it nothing fires but `requested`, and that only when the
// last run did not itself start inside its predecessor's cooldown: one bypass per cooldown window (RC-5); a bypassing run
// takes every trigger due with it. While the one open window arc-wide is open only `verdict-closed`, `buffer-red` and
// `requested` fire, which also suppresses every trigger about a station under it (`constraint-shift` is the one such).
import type { UnitId } from '../core/ids.ts';
import type { IsoTime } from '../core/values.ts';
import { codeConstraintOf } from './constraint.ts';
import type { FlowLog } from './log.ts';
import { type XmrLimits, specialCause, zoneOf } from './spc.ts';
import { type CodeConstraint, FLOW_TRIGGERS, type FlowPoint, type FlowTrigger, type FlowWindow } from './types.ts';

export const COOLDOWN_MIN = 120;
export const FLOOR_MERGES = 10;
/** OI-1: the points a first constraint label needs; measured in paid run 1. */
export const FIRST_LABEL_POINTS = 3;
/** What fires while a window is open. */
const UNDER_WINDOW: readonly FlowTrigger[] = ['verdict-closed', 'buffer-red', 'requested'];

const ms = (t: IsoTime): number => Date.parse(t);
const COOLDOWN_MS = COOLDOWN_MIN * 60_000;

export type TriggerInput = Readonly<{
  log: FlowLog;
  points: readonly FlowPoint[];
  limits: XmrLimits | null;
  inFlight: readonly Readonly<{ unit: UnitId; ageMin: number }>[];
  window: FlowWindow | null;
  now: IsoTime;
}>;

/** A label as one comparable string: the station and, for the slot, its component. */
const labelOf = (c: CodeConstraint | null): string | null => (c === null ? null : `${c.station}|${c.component ?? ''}`);

/** Whether run `i` of the log started inside its predecessor's cooldown (a `requested` bypass). */
function bypassed(log: FlowLog, i: number): boolean {
  if (i <= 0) return false;
  return ms(log.runs[i]!.started.at) - ms(log.runs[i - 1]!.started.at) < COOLDOWN_MS;
}

export type Cooldown = Readonly<{ until: IsoTime | null; bypass: boolean }>;

/** The cooldown at `now`: until when it runs (null: none), and whether a `requested` may still bypass it. */
export function cooldownOf(log: FlowLog, now: IsoTime): Cooldown {
  const last = log.runs.at(-1);
  if (last === undefined) return { until: null, bypass: false };
  const until = ms(last.started.at) + COOLDOWN_MS;
  if (until <= ms(now)) return { until: null, bypass: false };
  return { until: new Date(until).toISOString() as IsoTime, bypass: !bypassed(log, log.runs.length - 1) };
}

/** Every trigger whose evidence arrived after the last run's start, before the cooldown and the window rule. */
function evidence(input: TriggerInput): ReadonlySet<FlowTrigger> {
  const { log, points, limits, inFlight, now } = input;
  const last = log.runs.at(-1);
  const since = last === undefined ? null : ms(last.started.at);
  const after = (t: IsoTime): boolean => since === null || ms(t) > since;
  const out = new Set<FlowTrigger>();
  const latest = points.at(-1);
  if (limits !== null) {
    const cause = specialCause(limits, latest === undefined || !after(latest.mergedAt) ? [] : points, []);
    if (cause !== null) out.add(cause);
    const elapsedMin = since === null ? Infinity : (ms(now) - since) / 60_000;
    const newlyRed = inFlight.some((u) => u.ageMin > 0 && zoneOf(limits, u.ageMin) === 'red' && (u.ageMin - elapsedMin <= 0 || zoneOf(limits, u.ageMin - elapsedMin) !== 'red'));
    if (newlyRed) out.add('buffer-red');
  }
  if (points.length >= FIRST_LABEL_POINTS) {
    const recorded = log.runs.findLast((r) => r.ended !== null)?.ended?.constraint.code ?? null;
    const label = labelOf(codeConstraintOf(points));
    if (label !== null && label !== labelOf(recorded)) out.add('constraint-shift');
  }
  if ([...log.verdicts.values()].some((v) => after(v.at))) out.add('verdict-closed');
  if (points.filter((p) => after(p.mergedAt)).length >= FLOOR_MERGES) out.add('floor');
  if (log.requests.some((r) => after(r.at))) out.add('requested');
  return out;
}

/** The triggers due at `now`, coalesced in `FLOW_TRIGGERS` order; empty when no run is due (see the header). */
export function dueTriggers(input: TriggerInput): readonly FlowTrigger[] {
  let due = evidence(input);
  const cooldown = cooldownOf(input.log, input.now);
  if (cooldown.until !== null && !(cooldown.bypass && due.has('requested'))) return [];
  if (input.window !== null) due = new Set([...due].filter((t) => UNDER_WINDOW.includes(t)));
  return FLOW_TRIGGERS.filter((t) => due.has(t));
}
