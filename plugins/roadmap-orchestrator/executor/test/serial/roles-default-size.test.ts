// The gate role eval's inlined cells at the size a run uses (fixtures only, no gate). Serial: building a size-3000 repository
// and its bounded diffs takes about 100 s of host time, too heavy for the parallel tier.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEV_CELLS } from '../../evals/roles/gate/cells.ts';
import { buildFixture } from '../../evals/roles/gate/fixture.ts';
import { tmpDir } from '../helpers/repo.ts';

test('roles.default-size-feasible: the inlined cells build at the default size and seed, each plant on the inlined side', () => {
  // A plant that cannot land inlined at size 3000 voids every trial of its cell. The sweep's inlined files are a
  // path-order prefix, which a trim before the placement filter once cut away whole.
  for (const id of ['G2a', 'G3a']) {
    const f = buildFixture(DEV_CELLS.find((c) => c.id === id)!, { seed: 'roles-1', trial: 0, size: 3000, scratch: tmpDir('roles-scratch') });
    assert.equal(f.key.plant!.predicted, 'inlined', `${id}: ${f.key.plant!.path}`);
  }
});
