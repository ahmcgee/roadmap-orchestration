// `roadmap inputs export --repo <repo> --arc <arc> --out <dir>` (M4a rev 3, I1, F17): a host act, read-only, no lock.
// Writes the arc's complete current input view from the run dir's kept inputs (the plan, every spec at its current rev
// including post-plan machine patches, the obligations, vision, ledger and sidecars, the Phase-0 record and issue
// capture) into `--out`, which must not exist, plus `export.json {planRev, specRevs}`.
// PLACEHOLDER (step N0, H3): step N6 replaces this module in place.
import type { ArcId, PlanRev, SpecRev, UnitId } from '../core/ids.ts';
import { notYet } from '../core/notyet.ts';
import type { AbsPath } from '../core/values.ts';

export const EXPORT_FILE = 'export.json';
export type InputsExportArgs = Readonly<{ repo: AbsPath; arc: ArcId; out: AbsPath }>;
/** What `export.json` records: the plan revision the export is of and each unit's spec revision. */
export type InputsExport = Readonly<{ planRev: PlanRev; specRevs: Readonly<Record<UnitId, SpecRev>> }>;

export async function exportInputs(_args: InputsExportArgs): Promise<InputsExport> {
  return notYet('roadmap inputs export', 'N6');
}
