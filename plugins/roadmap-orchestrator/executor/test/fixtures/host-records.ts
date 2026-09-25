// Record builders shared by the host and residue tests and their child fixtures.
import { randomBytes, randomUUID } from 'node:crypto';
import { type ArcId, type ResourceName, arcId, invocationId, opId, opKey, resourceName, unitId } from '../../src/core/ids.ts';
import type { NewIntent } from '../../src/core/interfaces.ts';
import type { HostLockClaim, ProcIdentity, ResidueKey } from '../../src/core/records.ts';
import { type BootId, absPath, bootId, nonce } from '../../src/core/values.ts';
import { SCHEMA_VERSION } from '../../src/core/version.ts';
import type { ResidueEntry } from '../../src/host/residues.ts';
import type { ResidueRecipe } from '../../src/recover/residue.ts';

export const ARC_NAME = 'arc-1';
export const ARC = arcId(ARC_NAME);
export const UNIT = unitId('u1');
/** The two resources whose cleanup fails, in lock order. */
export const FAILED: readonly ResourceName[] = [resourceName('db'), resourceName('queue')];
/** Teardown invocations of the failed cleanups (op seqs 90, 91 of the arc). */
export const TEARDOWN = new Map(FAILED.map((r, i) => [r, invocationId(opId(ARC, 90 + i), 1)]));

export const recipeOf = (resource: ResourceName): ResidueRecipe => ({
  teardown: { argv: ['./teardown.sh', resource], cwd: absPath('/repo'), env: { RESOURCE: resource } },
  label: `roadmap-${ARC_NAME}-${resource}`,
});
export const RECIPES: ReadonlyMap<ResourceName, ResidueRecipe> = new Map(FAILED.map((r) => [r, recipeOf(r)]));

export function failIntent(): NewIntent<'resource.transition'> {
  return {
    kind: 'resource.transition',
    key: opKey(`resources:${FAILED.join('+')}`),
    parent: { type: 'stage', unit: UNIT, stage: 'teardown', attempt: 1 },
    deadlineAt: null,
    body: () => ({
      expect: {
        holder: { type: 'stage', unit: UNIT, stage: 'build', attempt: 1 },
        resources: FAILED,
        edge: { type: 'fail', residues: FAILED.map((resource) => ({ resource, teardown: TEARDOWN.get(resource)! })) },
      },
      post: null,
    }),
  };
}

export function keyOf(resource: ResourceName, arc: ArcId = ARC): ResidueKey {
  return { arc, unit: UNIT, inv: TEARDOWN.get(resource)!, resource };
}

export function residueEntry(resource: ResourceName, arc: ArcId = ARC): ResidueEntry {
  return { type: 'residue', key: keyOf(resource, arc), ...recipeOf(resource) };
}

export const otherBoot = (): BootId => bootId(randomUUID());

export function claimRecord(opts: Readonly<{ supervisor: ProcIdentity; bootId: BootId; arc?: ArcId; generation?: number }>): HostLockClaim {
  return {
    v: SCHEMA_VERSION,
    nonce: nonce(randomBytes(16).toString('hex')),
    generation: opts.generation ?? 1,
    bootId: opts.bootId,
    supervisor: opts.supervisor,
    arc: opts.arc ?? ARC,
    runDir: absPath(`/repo/.git/roadmap-runtime/${opts.arc ?? ARC}`),
    repo: absPath('/repo'),
  };
}
