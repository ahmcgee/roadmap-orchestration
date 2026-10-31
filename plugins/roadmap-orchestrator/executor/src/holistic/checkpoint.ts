import type { CheckpointIds } from '../prompts/schemas.ts';
import type { ArcLaneDef, ObligationDef } from './types.ts';
// Checkpoint plan amendment authority is retired. The root amends through CAS apply --reason.
import type { UnitId, JobId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { BackendCallOutcome } from '../pipeline/dispatch.ts';
import { lineageDiagnosis } from '../pipeline/handover.ts';
import type { CheckpointTrigger } from './types.ts';
import type { CheckpointContext } from './bundle.ts';
export type { CheckpointContext } from './bundle.ts';
export type DesignParkRoute = Readonly<{kind: 'park-item' | 'checkpoint' | 'respec-second'}> | Readonly<{kind: 'respecified'; planRev: number}>;
export type CheckpointOutcome = Readonly<{kind: 'none'}> | Readonly<{kind: 'decided'; job: JobId; trigger: CheckpointTrigger; decision: Readonly<{kind: 'applied'; planRev: number}> | Readonly<{kind: 'no-op'}> | Readonly<{kind: 'requested'; needsUser: import('../core/ids.ts').NeedsUserId; reason: string}> | Readonly<{kind: 'rejected'; reason: string; detail: string}>}>;
export const interruptedCall = (called: BackendCallOutcome): boolean => called.kind === 'result' && called.result.outcome.kind === 'cancelled';
export const designParkRoute = (_ctx: CheckpointContext, _unit: UnitId): DesignParkRoute | null => null;
export const busyHolds = (_ctx: CheckpointContext): ReadonlySet<UnitId> => new Set();
export const busyWaits = (_view: JournalView): readonly Readonly<{job: JobId; waitingFor: readonly import('./types.ts').BusyAttempt[]}>[] => [];
export const checkpointMilestonesRemaining = (_view: JournalView, _plan: PlanM1): number | null => null;
export const checkpointPending = (_ctx: CheckpointContext): boolean => false;
export const settleLatest = (_ctx: CheckpointContext): void => {};
export const runCheckpoint = async (_ctx: CheckpointContext): Promise<CheckpointOutcome> => ({kind: 'none'});
export const parkDiagnosis = (ctx: CheckpointContext, t: CheckpointTrigger) => t.type === 'park' ? lineageDiagnosis(ctx, t.unit) : null;

export function checkpointIdsOf(obligations: Readonly<{ lanes: readonly Pick<ArcLaneDef, 'id'>[]; obligations: readonly ObligationDef[] }> | null): CheckpointIds | null {
  if (obligations === null) return null;
  return {
    arcLanes: obligations.lanes.map((l) => l.id),
    splittable: obligations.obligations.filter((o) => o.state.type === 'active').map((o) => o.id),
    obligations: obligations.obligations.map((o) => o.id),
  };
}
