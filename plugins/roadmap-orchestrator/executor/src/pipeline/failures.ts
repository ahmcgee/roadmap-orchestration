// A unit's lane failures (M4a rev 3, F3, dx2 5): what `status.units[].failures` and a lanes park's needs-user summary
// list, so a re-entry that resets its counters can cite the executor's own classification of host-caused failures.
//
// Derived from authoritative records only (DESIGN §2.9: the snapshot ref alone restores the same `status`): each closed
// `lanes` attempt's spec lane spawns and their done verdicts in the log, and each red first run's persisted class
// (`red.json`, redlane.ts; the snapshot closure carries it). Raw evidence (launch.json, output, host samples) is never
// read but by the dev.6 scaffolding below: gc deletes it. One line per lane that is red or flaky, ascending by attempt,
// then by the lane's first spawn. `class`: `flaky` (a diagnostic rerun went green), `repeat` (it repeated the unit's earlier red, F2: no rerun), else
// `red`. `hostSuspected`: the persisted host signatures, and whether the host was busy (a `host-signature` class) or not
// (`signature-without-evidence`). The counting verdict is the rerun's after a host-signature rerun, else the first
// run's (lanes.ts `laneRecord`).
//
// Not listed: a lanes attempt still open (its records are not final); a lane whose spawns are not all done (a crash cut
// it short: unknown); a reused lane (a pass); suite lanes (the candidate's).
//
// 1.0.0-dev.6 adoption (temporary scaffolding): a red run its spawn did not stamp with `redRev` never persisted its
// class; it is re-derived from its raw evidence with the frozen table (lanes.ts `dev6RedClass`), and not listed once
// that evidence is gone.
import { join } from 'node:path';
import type { IntentOf } from '../core/events.ts';
import { type LaneId, type UnitId, invocationId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { CommandVerdict } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import type { StageParent } from './dispatch.ts';
import { type HostSuspected, dev6RedClass, specSeriesRoot } from './lanes.ts';
import { type RedClass, readRedClass } from './redlane.ts';

export const FAILURE_CLASSES = ['red', 'flaky', 'repeat'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];
export type LaneFailure = Readonly<{ stage: 'lanes'; attempt: number; lane: LaneId; class: FailureClass; hostSuspected: HostSuspected | null }>;

const isRed = (verdict: CommandVerdict): boolean => verdict === 'fail' || verdict === 'stall';

/** A done lane spawn's verdict as its done record states it (a lost runner: `process-fault`); null while not done. */
function verdictOf(view: JournalView, spawn: IntentOf<'proc.spawn'>): CommandVerdict | null {
  const done = view.doneOf(spawn.op);
  if (done === null) return null;
  if (done.kind !== 'proc.spawn') throw new Error(`${spawn.op}: a ${done.kind} done closes a lane spawn`);
  if (done.outcome.kind === 'lost') return 'process-fault';
  if (done.outcome.summary.type !== 'command') throw new Error(`${spawn.op}: a lane spawn ended with a ${done.outcome.summary.type} result`);
  return done.outcome.summary.verdict;
}

/** One lane of a closed lanes attempt, from its first run and its rerun, if any; null when it is not listed. */
function laneFailure(view: JournalView, runDir: AbsPath, parent: StageParent, lane: LaneId, spawns: readonly IntentOf<'proc.spawn'>[]): LaneFailure | null {
  const [first, rerun, ...more] = spawns;
  if (first === undefined) throw new Error(`lane ${lane}: no spawn`);
  if (more.length > 0) throw new Error(`lane ${lane} ran ${spawns.length} times in series ${parent.unit} lanes#${parent.attempt}; a lane runs at most twice`);
  const verdicts = spawns.map((s) => verdictOf(view, s));
  if (verdicts.some((v) => v === null)) return null;
  const [firstVerdict, rerunVerdict] = verdicts as CommandVerdict[];
  if (!isRed(firstVerdict!)) {
    if (rerun !== undefined) throw new Error(`lane ${lane} was rerun after a ${firstVerdict} run (${first.op})`);
    return null;
  }
  const subject = first.expect.subject;
  if (subject.purpose !== 'lane') throw new Error(`${first.op} spawned a ${subject.purpose}, not a lane`);
  const dir = absPath(join(specSeriesRoot(runDir, parent), lane));
  if (subject.redRev === undefined) {
    const dev6 = dev6RedClass(runDir, invocationId(first.op, first.ordinal), dir);
    return dev6 === null ? null : classified(parent, lane, dev6, rerunVerdict);
  }
  const cls = readRedClass(dir)?.class ?? null;
  if (rerun !== undefined && cls === null) throw new Error(`lane ${lane} was rerun after ${first.op}, whose red class (red.json) was never written`);
  return classified(parent, lane, cls, rerunVerdict);
}

/** A red lane's failure line by its class (null: none was written, so no rerun ran) and its rerun's verdict; null when not listed. */
function classified(parent: StageParent, lane: LaneId, cls: RedClass | null, rerunVerdict: CommandVerdict | undefined): LaneFailure | null {
  const out = (c: FailureClass, hostSuspected: HostSuspected | null): LaneFailure => ({ stage: 'lanes', attempt: parent.attempt, lane, class: c, hostSuspected });
  switch (cls?.kind) {
    case undefined:
      // Red, and a crash before its class was written: no rerun ran.
      return out('red', null);
    case 'repeat':
      return out('repeat', null);
    case 'diagnostic':
      return out(rerunVerdict === 'pass' ? 'flaky' : 'red', null);
    case 'host-signature':
      // The rerun on a clear host counts; without one (the host never cleared) the first run does.
      return rerunVerdict === undefined || isRed(rerunVerdict) ? out('red', { signatures: cls.signatures, busy: true }) : null;
    case 'signature-without-evidence':
      return out('red', { signatures: cls.signatures, busy: false });
  }
}

export function laneFailures(ctx: Readonly<{ journal: Readonly<{ view: JournalView }>; runDir: AbsPath }>, unit: Readonly<{ id: UnitId }>): readonly LaneFailure[] {
  const view = ctx.journal.view;
  const open = view.unit(unit.id).open;
  // attempt → lane → its spawns, in log order.
  const attempts = new Map<number, Readonly<{ parent: StageParent; lanes: Map<LaneId, IntentOf<'proc.spawn'>[]> }>>();
  for (const i of view.opsOf('proc.spawn')) {
    const s = i.expect.subject;
    if (s.purpose !== 'lane' || s.set !== 'spec' || s.unit !== unit.id || i.parent.type !== 'stage' || i.parent.stage !== 'lanes') continue;
    if (open?.stage === 'lanes' && open.attempt === i.parent.attempt) continue;
    const entry = attempts.get(i.parent.attempt) ?? { parent: i.parent, lanes: new Map() };
    entry.lanes.set(s.lane, [...(entry.lanes.get(s.lane) ?? []), i]);
    attempts.set(i.parent.attempt, entry);
  }
  return [...attempts.values()].sort((a, b) => a.parent.attempt - b.parent.attempt).flatMap(({ parent, lanes }) =>
    [...lanes].flatMap(([lane, spawns]) => {
      const f = laneFailure(view, ctx.runDir, parent, lane, spawns);
      return f === null ? [] : [f];
    }));
}

/** The failures as one sentence for a park's summary; empty when none. */
export function failuresText(failures: readonly LaneFailure[]): string {
  if (failures.length === 0) return '';
  const one = (f: LaneFailure): string => `lanes#${f.attempt} ${f.lane} ${f.class}${f.hostSuspected === null ? ''
    : ` host-suspected (${f.hostSuspected.signatures.join(', ')}${f.hostSuspected.busy ? '; host busy' : ''})`}`;
  return `Lane failures: ${failures.map(one).join('; ')}.`;
}
