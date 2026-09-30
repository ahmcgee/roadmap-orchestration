// The occupancy probe (plan "Reservation cycle", R4): after reserve, before run, every reserved resource
// instance that declares a probe (named resources and pool instances; not `@cpu` tokens or the slot) is probed
// through `invoke` (purpose `probe`), with the holder's owner label (a unit's, or since M3 a job's, G4:
// `jobOwnerLabel`) and its instance binding (F7). A docs holder holds integration-slot alone: nothing to probe.
//
//   exit 0 (PROBE_EXIT.free)      → clear;
//   exit 10 (PROBE_EXIT.ownLabel) → the owner's own leftovers: run the teardown, then probe once more,
//                                   which must say 0;
//   exit 11, or anything else     → unlabelled, foreign or a faulted probe: park the unit (a job: its lane does
//                                   not run; the needs-user is the arc's) and ask the user.
//
// The verdict comes before `run`, so before the holder's workload starts and before any charge: a parked
// probe never counts a chargeable failure. The needs-user write itself belongs to the caller (step 13);
// this returns the record's content. The reservation stays reserved, and the caller cleans it up.
import type { Parent } from '../core/events.ts';
import type { ResourceInstance, UnitId } from '../core/ids.ts';
import type { NeedsUserContent, NeedsUserSubject } from '../core/records.ts';
import { PROBE_EXIT } from '../input/plan.ts';
import { instanceEnv } from './pool.ts';
import { type AcquiringHolder, type Reservation, type ResourceContext, holderStage, jobOwnerLabel } from './reserve.ts';
import { type CommandRun, ownerLabel, resolveCommand, resourceDecl, runResourceCommand, teardown } from './teardown.ts';

export type Occupancy =
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'parked'; resource: ResourceInstance; needsUser: NeedsUserContent }>;

export async function probe(
  ctx: ResourceContext,
  r: Reservation<'reserved', AcquiringHolder>,
  parent: Parent,
): Promise<Occupancy> {
  // The recipes are exactly the instances that declare a probe and a teardown, in lock order.
  if (r.recipes.size === 0) return { kind: 'clear' };
  const owner = ownerOf(ctx, r.holder);
  const { unit } = owner;
  const instances = instanceEnv(r.resources);
  for (const [resource, recipe] of r.recipes) {
    const command = resolveCommand(ctx.repo, resourceDecl(ctx.plan(), resource).probe, owner.label, instances);
    const first = await runResourceCommand(ctx, 'probe', unit, resource, command, parent);
    if (first.exitCode === PROBE_EXIT.free) continue;
    if (first.exitCode !== PROBE_EXIT.ownLabel) return parked(owner, resource, first, 'at the first probe');
    const cleared = await teardown(ctx, unit, resource, recipe, parent);
    const second = await runResourceCommand(ctx, 'probe', unit, resource, command, parent);
    if (second.exitCode !== PROBE_EXIT.free) {
      return parked(owner, resource, second, `after tearing down this ${owner.kind}'s own leftovers (teardown ${cleared.inv} ${cleared.clean ? 'passed' : 'failed'})`);
    }
  }
  return { kind: 'clear' };
}

/** Who a probe speaks for: the owner label its objects carry, and how a parked probe names it. */
type Owner = Readonly<{
  kind: 'unit' | 'job';
  unit: UnitId | null;
  label: string;
  subject: NeedsUserSubject;
  /** What the park stopped, and how the user lets it go on. */
  stopped: string;
  resume: string;
}>;

function ownerOf(ctx: ResourceContext, holder: AcquiringHolder): Owner {
  const arc = ctx.plan().arc;
  switch (holder.type) {
    case 'stage':
    case 'publication':
      return {
        kind: 'unit', unit: holder.unit, label: ownerLabel(arc, holder.unit), subject: { type: 'unit', unit: holder.unit },
        stopped: `unit ${holder.unit} is parked before its ${holderStage(holder)} ran`, resume: `resume unit ${holder.unit}`,
      };
    case 'job':
      return {
        kind: 'job', unit: null, label: jobOwnerLabel(arc, holder.job), subject: { type: 'arc' },
        stopped: `job ${holder.job}'s lane did not run`, resume: `let job ${holder.job} run its lane again`,
      };
    case 'docs':
    case 'batch':
      throw new Error(`${JSON.stringify(holder)} holds integration-slot alone: it has nothing to probe`);
  }
}

function parked(owner: Owner, resource: ResourceInstance, run: CommandRun, when: string): Occupancy {
  const what = run.exitCode === PROBE_EXIT.foreign
    ? `is occupied by something without this ${owner.kind}'s label`
    : run.exitCode === PROBE_EXIT.ownLabel
      ? `is still occupied under this ${owner.kind}'s own label`
      : `could not be probed (probe ${run.verdict === 'lost' ? 'lost' : `exited ${run.exitCode ?? 'without a code'}`})`;
  return {
    kind: 'parked',
    resource,
    needsUser: {
      blocking: true,
      subject: owner.subject,
      reason: 'occupancy-unlabelled',
      summary: `Resource ${resource} ${what} ${when} (probe ${run.inv}); ${owner.stopped}.`,
      recommendation: `Free ${resource}, or confirm what occupies it may be removed, then ${owner.resume}.`,
      options: [],
      evidence: run.evidence,
    },
  };
}
