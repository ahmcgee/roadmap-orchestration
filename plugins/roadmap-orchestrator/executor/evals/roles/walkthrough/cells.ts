// The walkthrough eval's dev cells: four product seeds, each with all 13 slots. Each family carries its plant in two of
// the four seeds and its twin in the other two (26 plants, 26 twins), so at n = 3 every family has six planted trials and
// the set has 156 slot observations, 78 of each. No two seeds plant the same set.
//
// The holdout set (evals/roles/holdout/walkthrough.ts, untracked) exports HOLDOUT_WALK_CELLS of the same type: two more
// seeds, run only at acceptance with --compare.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CellSet } from '../gate/cells.ts';
import type { WalkCell } from './fixture.ts';

export const DEV_WALK_CELLS: readonly WalkCell[] = [
  { id: 'S1', seed: 'ledgerly-1', planted: ['W1', 'W3', 'W5', 'W7', 'W9', 'W11', 'W13'] },
  { id: 'S2', seed: 'ledgerly-2', planted: ['W2', 'W3', 'W6', 'W7', 'W10', 'W12', 'W13'] },
  { id: 'S3', seed: 'ledgerly-3', planted: ['W1', 'W4', 'W6', 'W8', 'W9', 'W12'] },
  { id: 'S4', seed: 'ledgerly-4', planted: ['W2', 'W4', 'W5', 'W8', 'W10', 'W11'] },
];

/** The untracked holdout set: `export const HOLDOUT_WALK_CELLS: readonly WalkCell[]`. */
export const HOLDOUT_WALK_FILE = fileURLToPath(new URL('../holdout/walkthrough.ts', import.meta.url));

export async function walkCellsFor(set: CellSet): Promise<readonly WalkCell[]> {
  if (set === 'dev') return DEV_WALK_CELLS;
  if (!existsSync(HOLDOUT_WALK_FILE)) throw new Error(`the holdout set is untracked and missing: ${HOLDOUT_WALK_FILE} must export HOLDOUT_WALK_CELLS`);
  const m = (await import(pathToFileURL(HOLDOUT_WALK_FILE).href)) as { HOLDOUT_WALK_CELLS?: readonly WalkCell[] };
  if (m.HOLDOUT_WALK_CELLS === undefined || m.HOLDOUT_WALK_CELLS.length === 0) throw new Error(`${HOLDOUT_WALK_FILE} exports no HOLDOUT_WALK_CELLS`);
  return m.HOLDOUT_WALK_CELLS;
}
