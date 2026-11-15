// dev.81 (D3): the status `roadmap status` prints (the console's status route and its local fallback), from the full
// `Status` the observer captures. The full status stays whole in memory: the TUI and every console view read it
// in-process from the envelope (CPU evidence, invocation and unit details, the Graph), so nothing they show changes.
// What is serialized folds the history that grows with an arc's length and that no reader of the printed status uses:
//   units[].work, host.work      -> `workTotals`: the runs' count by kind and their measured times (`work` rows stay in
//                                   the envelope; a run's figures are on its invocation in the console)
//   units[].certification.lanes  -> on a merged, cut or superseded unit, `laneStates`: the lanes' count by state; a
//                                   live unit keeps its lanes
//   commands.receipts[].verified -> an applied receipt's first VERIFIED_SHOWN postconditions and `verifiedTotal`; the
//                                   whole receipt is `commands/receipts/<id>.applied.json`
// A field atlas2 m6 status was 11.63 MB, 6.09 MB of it work rows (13,998 over 158 units), 1.16 MB certification lanes and
// 2.42 MB two receipts' `verified`; with the fold a retired unit's bytes no longer grow with its invocations.
import type { Receipt } from './core/records.ts';
import type { Status, UnitStatusLine } from './status.ts';
import type { Certification, WorkRun } from './status-work.ts';

export const VERIFIED_SHOWN = 20;
export type WorkTotals = Readonly<{ builds: number; lanes: number; measured: number; runMs: number; wallMs: number }>;
type LaneState = Certification['lanes'][number]['state'];
export type FoldedCertification = Omit<Certification, 'lanes'> & Readonly<{ laneStates: Readonly<Partial<Record<LaneState, number>>> }>;
export type WireReceipt = Exclude<Receipt, { state: 'applied' }> | (Extract<Receipt, { state: 'applied' }> & Readonly<{ verifiedTotal: number }>);
export type WireUnitLine = Omit<UnitStatusLine, 'work' | 'certification'> & Readonly<{ workTotals: WorkTotals; certification: Certification | FoldedCertification | null }>;
export type WireStatus = Omit<Status, 'units' | 'host' | 'commands'> & Readonly<{
  units: readonly WireUnitLine[];
  host: Omit<Status['host'], 'work'> & Readonly<{ workTotals: WorkTotals }>;
  commands: Omit<Status['commands'], 'receipts'> & Readonly<{ receipts: readonly WireReceipt[] }>;
}>;

export function workTotals(runs: readonly WorkRun[]): WorkTotals {
  let builds = 0, lanes = 0, measured = 0, runMs = 0, wallMs = 0;
  for (const r of runs) {
    if (r.kind === 'build') builds++; else lanes++;
    if (r.measured !== null) { measured++; runMs += r.measured.runMs; wallMs += r.measured.wallMs; }
  }
  return { builds, lanes, measured, runMs, wallMs };
}
const settled = (state: UnitStatusLine['state']): boolean => state === 'merged' || state === 'cut' || state === 'superseded';
function foldCertification(c: Certification): FoldedCertification {
  const { lanes, ...rest } = c, laneStates: Partial<Record<LaneState, number>> = {};
  for (const l of lanes) laneStates[l.state] = (laneStates[l.state] ?? 0) + 1;
  return { ...rest, laneStates };
}
function wireReceipt(r: Receipt): WireReceipt {
  return r.state === 'applied' ? { ...r, verified: r.verified.slice(0, VERIFIED_SHOWN), verifiedTotal: r.verified.length } : r;
}

export function wireStatus(s: Status): WireStatus {
  const { work: hostWork, ...host } = s.host;
  return {
    ...s,
    units: s.units.map(({ work, certification, ...u }) => ({
      ...u, workTotals: workTotals(work), certification: certification !== null && settled(u.state) ? foldCertification(certification) : certification,
    })),
    host: { ...host, workTotals: workTotals(hostWork) },
    commands: { ...s.commands, receipts: s.commands.receipts.map(wireReceipt) },
  };
}
