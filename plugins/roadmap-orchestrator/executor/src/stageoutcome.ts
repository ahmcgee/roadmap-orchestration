import type { JobStageOutcomeFact } from './core/events.ts';
import type { FindingId, JobId, MilestoneId } from './core/ids.ts';
import type { Journal } from './core/interfaces.ts';

export function jobStageOutcome(journal: Journal, job: JobId, stage: JobStageOutcomeFact['stage'], milestone: MilestoneId | null,
  verdict: JobStageOutcomeFact['verdict'], ids: readonly FindingId[]): void {
  if (journal.view.stageJobOutcomes().some((f) => f.job === job && f.stage === stage)) return;
  const unique = new Set(ids);
  const counts = { P1: 0, P2: 0, P3: 0, total: 0 };
  for (const f of journal.view.holistic().findings) if (unique.has(f.id)) { counts[f.severity]++; counts.total++; }
  journal.fact({ kind: 'stage-outcome', stage, job, milestone, verdict, findings: counts });
}
