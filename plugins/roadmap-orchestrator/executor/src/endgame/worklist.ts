// The endgame's worklist (dev.82): what the architect finishes by hand, derived from the log and the plan in force, never
// stored.
//
// - **Required**: active P1 findings; active findings over an obligation; non-exempt obligations not held on the
//   integration head (observed red there: `notHeld`, src/schedule/scheduler.ts `obligationVerdicts`); finding-raised units
//   neither retired, cut nor superseded. While any remains, an opened episode stays `open` and the arc is not complete
//   (`endgame-open`).
// - **Optional**: every other active finding (P2/P3 over no obligation: the close-out settlement still banks or releases
//   them) and the polish proposals refused since the episode was entered (the endgame admits no polish unit).
import type { FindingId, ObligationId, PolishId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { EndgameEpisode } from '../core/state.ts';
import { isActive } from '../holistic/findings.ts';
import type { FindingSeverity } from '../holistic/types.ts';
import type { PlanM1 } from '../input/plan.ts';
import { type RepairsOf, findingRaised } from './phase.ts';

export type WorklistEntry =
  | Readonly<{ type: 'finding'; finding: FindingId; severity: FindingSeverity; obligation: ObligationId | null; evidence: readonly string[] }>
  | Readonly<{ type: 'obligation'; obligation: ObligationId }>
  | Readonly<{ type: 'unit'; unit: UnitId }>
  | Readonly<{ type: 'polish-refused'; proposal: PolishId; reasons: readonly string[] }>;

export type Worklist = Readonly<{ required: readonly WorklistEntry[]; optional: readonly WorklistEntry[] }>;

export const EMPTY_WORKLIST: Worklist = { required: [], optional: [] };

const TERMINAL: readonly string[] = ['retired', 'cut', 'superseded'];

/** The worklist now (see the header): findings in id order, then obligations as given, units in plan order, refusals in log order. */
export function worklist(view: JournalView, plan: PlanM1, repairsOf: RepairsOf, notHeld: readonly ObligationId[], episode: EndgameEpisode | null): Worklist {
  const required: WorklistEntry[] = [];
  const optional: WorklistEntry[] = [];
  for (const f of view.holistic().findings) {
    if (!isActive(f)) continue;
    const entry: WorklistEntry = { type: 'finding', finding: f.id, severity: f.severity, obligation: f.obligation, evidence: f.evidence.map((e) => e.path) };
    (f.severity === 'P1' || f.obligation !== null ? required : optional).push(entry);
  }
  for (const obligation of notHeld) required.push({ type: 'obligation', obligation });
  for (const u of plan.units) {
    if (!TERMINAL.includes(view.unit(u.id).status) && findingRaised(view, u, repairsOf(u))) required.push({ type: 'unit', unit: u.id });
  }
  if (episode !== null) {
    for (const { seq, fact } of view.walkFacts()) {
      if (fact.kind === 'polish-refused' && seq > episode.seq) optional.push({ type: 'polish-refused', proposal: fact.proposal, reasons: fact.reasons });
    }
  }
  return { required, optional };
}
