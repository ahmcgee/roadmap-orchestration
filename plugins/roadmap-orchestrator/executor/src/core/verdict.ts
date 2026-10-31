import type { ArcStageVerdict } from './events.ts';
import type { Journal } from './interfaces.ts';

/** A job's report survives a crash between its verdict and terminal fact without double counting. */
export function recordArcVerdict(journal: Journal, verdict: Omit<ArcStageVerdict, 'kind'>): void {
  if (journal.view.arcVerdicts().some((v) => v.job === verdict.job && v.stage === verdict.stage)) return;
  journal.fact({kind: 'stage-outcome', ...verdict});
}
