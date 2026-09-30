// The occupancy probe (plan "Reservation cycle", R4): after reserve, before run, every reserved resource
// instance that declares a probe (named resources and pool instances; not `@cpu` tokens or the slot) is probed
// through `invoke` (purpose `probe`), with the unit's owner label and the holder's instance binding (F7).
//
//   exit 0 (PROBE_EXIT.free)      → clear;
//   exit 10 (PROBE_EXIT.ownLabel) → this unit's own leftovers: run the teardown, then probe once more,
//                                   which must say 0;
//   exit 11, or anything else     → unlabelled, foreign or a faulted probe: park the unit and ask the user.
//
// The verdict comes before `run`, so before the holder's workload starts and before any charge: a parked
// probe never counts a chargeable failure. The needs-user write itself belongs to the caller (step 13);
// this returns the record's content. The reservation stays reserved, and the caller cleans it up.
import type { Parent } from '../core/events.ts';
import type { ResourceInstance } from '../core/ids.ts';
import type { NeedsUserContent } from '../core/records.ts';
import { PROBE_EXIT } from '../input/plan.ts';
import { instanceEnv } from './pool.ts';
import { type AcquiringHolder, type Reservation, type ResourceContext, holderStage } from './reserve.ts';
import { type CommandRun, ownerLabel, resolveCommand, resourceDecl, runResourceCommand, teardown } from './teardown.ts';

export type Occupancy =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'parked'; resource: ResourceInstance; needsUser: NeedsUserContent }>;

export async function probe(
  ctx: ResourceContext,
  r: Reservation<'reserved', AcquiringHolder>,
  parent: Parent,
): Promise<Occupancy> {
  const { unit } = r.holder;
  const instances = instanceEnv(r.resources);
  // The recipes are exactly the instances that declare a probe and a teardown, in lock order.
  for (const [resource, recipe] of r.recipes) {
    const command = resolveCommand(ctx.repo, resourceDecl(ctx.plan(), resource).probe, ownerLabel(ctx.plan().arc, unit), instances);
    const first = await runResourceCommand(ctx, 'probe', unit, resource, command, parent);
    if (first.exitCode === PROBE_EXIT.free) continue;
    if (first.exitCode !== PROBE_EXIT.ownLabel) return parked(r, resource, first, 'at the first probe');
    const cleared = await teardown(ctx, unit, resource, recipe, parent);
    const second = await runResourceCommand(ctx, 'probe', unit, resource, command, parent);
    if (second.exitCode !== PROBE_EXIT.free) {
      return parked(r, resource, second, `after tearing down this unit's own leftovers (teardown ${cleared.inv} ${cleared.clean ? 'passed' : 'failed'})`);
    }
  }
  return { kind: 'clear' };
}

function parked(r: Reservation<'reserved', AcquiringHolder>, resource: ResourceInstance, run: CommandRun, when: string): Occupancy {
  const what = run.exitCode === PROBE_EXIT.foreign
    ? 'is occupied by something without this unit\'s label'
    : run.exitCode === PROBE_EXIT.ownLabel
      ? 'is still occupied under this unit\'s own label'
      : `could not be probed (probe ${run.verdict === 'lost' ? 'lost' : `exited ${run.exitCode ?? 'without a code'}`})`;
  return {
    kind: 'parked',
    resource,
    needsUser: {
      blocking: true,
      subject: { type: 'unit', unit: r.holder.unit },
      reason: 'occupancy-unlabelled',
      summary: `Resource ${resource} ${what} ${when} (probe ${run.inv}); unit ${r.holder.unit} is parked before its ${holderStage(r.holder)} ran.`,
      recommendation: `Free ${resource}, or confirm what occupies it may be removed, then resume unit ${r.holder.unit}.`,
      options: [],
      evidence: run.evidence,
    },
  };
}
