// The residue half of `resource.transition` (reservation cycle and recovery table, R4/R11).
//
// A failed cleanup is a `resource.transition` intent with edge `fail`, listing one residue per failed
// resource. Its ordering is fixed: every residue durable in the host index first, then the local
// `cleanup-failed` done, and the resources are never released. A crash anywhere in between leaves the
// intent open; recovery calls the same function (appends are idempotent by key) and then writes the done.
// The rest of the op kind's reconciler (reserved, running, cleaning) is the reservation cycle's (step 10).
import { crashPoint } from '../core/crash.ts';
import type { IntentOf } from '../core/events.ts';
import { type ResourceInstance, parseOpId } from '../core/ids.ts';
import type { Disposition } from '../core/interfaces.ts';
import type { TeardownRecipe } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { recordResidue } from '../host/residues.ts';

/**
 * What a residue must carry so a later sweep or retry can clean it: the resolved teardown (with the holder's
 * instance binding, F7) and the resource label.
 */
export type ResidueRecipe = Readonly<{ teardown: TeardownRecipe; label: string }>;

/**
 * Makes every residue of a `fail` transition durable in the host index, in the intent's lock order. The
 * caller writes the local done only after this returns (normally with `recoveredBy: null`, in recovery
 * through `reconcileFailedCleanup`).
 */
export function appendFailedCleanupResidues(
  hostDir: AbsPath,
  intent: IntentOf<'resource.transition'>,
  recipes: ReadonlyMap<ResourceInstance, ResidueRecipe>,
): void {
  const { holder, edge } = intent.expect;
  if (edge.type !== 'fail') throw new Error(`${intent.op}: a ${edge.type} transition records no residue`);
  // A sweep's failed teardown leaves the residue it swept undisposed; it has no unit to key a new one by.
  if (holder.type !== 'stage') throw new Error(`${intent.op}: a fail transition held by a sweep has no unit to key its residues`);
  const arc = parseOpId(intent.op).arc;
  for (const { resource, teardown } of edge.residues) {
    const recipe = recipes.get(resource);
    if (recipe === undefined) throw new Error(`${intent.op}: no teardown recipe for failed resource ${resource}`);
    crashPoint('residue.before-host-append');
    recordResidue(hostDir, { type: 'residue', key: { arc, unit: holder.unit, inv: teardown, resource }, teardown: recipe.teardown, label: recipe.label });
  }
  crashPoint('residue.after-host-append');
}

/** Recovery of an open `fail` transition: residues (idempotently), then the done the caller records. */
export function reconcileFailedCleanup(
  hostDir: AbsPath,
  intent: IntentOf<'resource.transition'>,
  recipes: ReadonlyMap<ResourceInstance, ResidueRecipe>,
): Extract<Disposition<'resource.transition'>, { kind: 'done' }> {
  appendFailedCleanupResidues(hostDir, intent, recipes);
  return { kind: 'done', outcome: { kind: 'transitioned' } };
}
