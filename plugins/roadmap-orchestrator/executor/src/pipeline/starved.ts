// Charging under host pressure (M4b rev 3, RC-11, step H2; SCHEMAS.md "Rev 3: host pressure"): the impure edge of
// `pressureRuling` (src/host/pressure.ts). A stage reads each run that ended its attempt without a pass (a backend call
// that ended `process-fault`, a lane series' red or blocked lane) as a `PressureRun`: its exit cause from exit.json, its
// pressure from its spawn's done record, and its unit's pressure holds from the fold. A `starved` or
// `red-rerun` ruling is recorded as the stage's `interrupted` hold with cause `host-pressure{inv}`: uncharged, no fix
// round, no park; admission holds the re-run (src/schedule/ready.ts). Nothing here is journaled: the hold fact is the
// stage's one outcome, so a crash before it re-runs the attempt as any crash does, and the fold derives the rest.
import type { HoldCause } from '../core/events.ts';
import { type InvocationId, parseInvocationId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { UnitState } from '../core/state.ts';
import { spawnPressureOf } from '../core/upgrade.ts';
import { type PressureHolds, type PressureRun, type PressureRuling, pressureRuling } from '../host/pressure.ts';
import { isRed } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { runnerFiles } from '../runner/files.ts';
import { invocationDir } from './invoke.ts';
import type { LaneRun, SeriesEnd } from './lanes.ts';

/** The fold's pressure holds of `u`: its count, and whether its latest hold was host-pressure with no decision since. */
export const pressureHoldsOf = (u: UnitState): PressureHolds => ({ count: u.pressureHolds, rerun: u.pressureHold !== null });

/** The hold cause a `starved` or `red-rerun` ruling records; null for `counts`. */
export const pressureCause = (r: PressureRuling): HoldCause | null => (r.kind === 'counts' ? null : { type: 'host-pressure', inv: r.inv });

/** A closed run as the rules read it: its exit cause (deadline, stall), else red or not, with its pressure. */
function runOf(runDir: AbsPath, inv: InvocationId, pressure: number | null, red: boolean): PressureRun {
  // Without pressure no rule applies: exit.json is not read (a lost runner has none).
  if (pressure === null) return { inv, end: 'other', pressure };
  const exit = runnerFiles(invocationDir(runDir, inv), inv).read('exit.json');
  if (exit === null) throw new Error(`${inv}: a run with pressure ${pressure} and no exit.json`);
  return { inv, end: exit.cause === 'timeout' ? 'deadline' : exit.cause === 'deadline' || exit.cause === 'stall' ? exit.cause : red ? 'red' : 'other', pressure };
}

/** The ruling over a backend call `inv` of `unit` that ended `process-fault` (its spawn's done record carries the pressure). */
export function callRuling(view: JournalView, runDir: AbsPath, unit: UnitState, inv: InvocationId): PressureRuling {
  const done = view.doneOf(parseInvocationId(inv).op);
  if (done === null || done.kind !== 'proc.spawn') throw new Error(`${inv}: a backend call read without its spawn's done record`);
  const pressure = done.outcome.kind === 'result' ? spawnPressureOf(done.outcome) : null;
  return pressureRuling([runOf(runDir, inv, pressure, false)], pressureHoldsOf(unit));
}

/**
 * The ruling over a lane series' end: its red or blocked lane's counted run, then its diagnostic rerun (a host-signature
 * rerun's voided first run is not read: the rerun on a clear host is the verdict). `counts` for any other end.
 */
export function seriesRuling(runDir: AbsPath, unit: UnitState, end: SeriesEnd): PressureRuling {
  if ((end.kind !== 'red' && end.kind !== 'blocked') || end.lane === null) return { kind: 'counts' };
  const runs = [end.lane, end.lane.diagnostic].filter((r): r is LaneRun => r !== null);
  return pressureRuling(runs.map((r) => runOf(runDir, r.inv, r.pressure, isRed(r.verdict))), pressureHoldsOf(unit));
}
