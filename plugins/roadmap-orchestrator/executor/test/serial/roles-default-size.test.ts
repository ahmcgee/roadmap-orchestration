// The gate role eval's inlined cells at the size a run uses (fixtures only, no gate). Serial: building a size-3000 repository
// and its bounded diffs takes about 100 s of host time, too heavy for the parallel tier.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEV_CELLS } from '../../evals/roles/gate/cells.ts';
import { buildFixture } from '../../evals/roles/gate/fixture.ts';
import { tmpDir } from '../helpers/repo.ts';

test('roles.default-size-feasible: the inlined cells build at the default size and seed, each plant on the inlined side', () => {
  // A plant that cannot land inlined at size 3000 voids every trial of its cell. The bounded diff inlines what the
  // sweep's substitutions do not explain first, a plant among it, at a budget of 128 KiB since 1.0.0-dev.12.
  for (const id of ['G2a', 'G3a']) {
    const f = buildFixture(DEV_CELLS.find((c) => c.id === id)!, { seed: 'roles-1', trial: 0, size: 3000, scratch: tmpDir('roles-scratch') });
    assert.equal(f.key.plant!.predicted, 'inlined', `${id}: ${f.key.plant!.path}`);
  }
});
