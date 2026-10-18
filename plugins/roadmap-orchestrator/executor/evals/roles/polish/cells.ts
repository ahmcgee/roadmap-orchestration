// The polish-judge eval's dev cells: the four families (families.ts), each with its better, worse and neutral after-state
// on the same step, 12 cells. Each cell is a polish proposal as a walk would make it (its text) and the after-state its
// unit builds (product and reference edits on the family's before). Every cell's product is the clean `ledgerly` of one
// seed (all 13 walkthrough slots their twins) with the family's before.
//
// The holdout set (evals/roles/holdout/polish.ts, untracked) exports HOLDOUT_POLISH_CELLS of the same type: six more cells
// on the dev families (their own proposals and after edits, other seeds), run only at acceptance with --compare.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CellSet } from '../gate/cells.ts';
import { AFTER, type Edit, POLISH_FAMILY_IDS, type PolishFamilyId, VARIANTS, type Variant } from './families.ts';

export type PolishCell = Readonly<{
  id: string;
  family: PolishFamilyId;
  variant: Variant;
  /** The product's seed (walkthrough/product.ts): its data. */
  seed: string;
  proposal: string;
  /** The after-state: edits on the family's before, at least one under design/ (the reference diff). */
  after: readonly Edit[];
}>;

export const POLISH_SEED = 'ledgerly-1';
const PREFIX: Readonly<Record<PolishFamilyId, string>> = { spacing: 'SP', hierarchy: 'HI', 'cli-help': 'CH', 'error-copy': 'EC' };
const SUFFIX: Readonly<Record<Variant, string>> = { better: 'B', worse: 'W', neutral: 'N' };

export const DEV_POLISH_CELLS: readonly PolishCell[] = POLISH_FAMILY_IDS.flatMap((family) => VARIANTS.map((variant): PolishCell => ({
  id: `${PREFIX[family]}-${SUFFIX[variant]}`, family, variant, seed: POLISH_SEED, ...AFTER[family][variant],
})));

/** The untracked holdout set: `export const HOLDOUT_POLISH_CELLS: readonly PolishCell[]`. */
export const HOLDOUT_POLISH_FILE = fileURLToPath(new URL('../holdout/polish.ts', import.meta.url));

export async function polishCellsFor(set: CellSet): Promise<readonly PolishCell[]> {
  if (set === 'dev') return DEV_POLISH_CELLS;
  if (!existsSync(HOLDOUT_POLISH_FILE)) throw new Error(`the holdout set is untracked and missing: ${HOLDOUT_POLISH_FILE} must export HOLDOUT_POLISH_CELLS`);
  const m = (await import(pathToFileURL(HOLDOUT_POLISH_FILE).href)) as { HOLDOUT_POLISH_CELLS?: readonly PolishCell[] };
  if (m.HOLDOUT_POLISH_CELLS === undefined || m.HOLDOUT_POLISH_CELLS.length === 0) throw new Error(`${HOLDOUT_POLISH_FILE} exports no HOLDOUT_POLISH_CELLS`);
  return m.HOLDOUT_POLISH_CELLS;
}
