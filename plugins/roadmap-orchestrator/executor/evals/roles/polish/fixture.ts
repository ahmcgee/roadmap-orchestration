// One polish-judge trial's fixture: the cell's before product (the clean `ledgerly` of its seed, every walkthrough slot
// its twin, plus its family's before), the walkthrough eval's milestone over it (walkthrough/fixture.ts: the bring-up,
// the nine journeys, `design/` the one reference), the after-state the polish unit's build commits, and the answer key,
// which only the eval run dir holds.
import { buildWalkFixture, type WalkFixture } from '../walkthrough/fixture.ts';
import type { FileMap } from '../walkthrough/product.ts';
import type { PolishCell } from './cells.ts';
import { FAMILIES, applyEdits, expectedDecision, type PolishFamily, type Variant } from './families.ts';

/** The polish unit the walk proposes (its id no unit of the plan: u1 is the milestone's). */
export const POLISH_UNIT = 'u2';
/** Its scope: the reference and every product surface a tweak may touch. */
export const POLISH_SCOPE = ['design/**', 'web/**', 'bin/**', 'src/**'] as const;
/** The walk's evidence note the proposal cites. */
export const WALK_NOTE = 'walk-notes.md';
/** The walk and the compare as the trial's arc numbers them. */
export const WALK_JOB = 'walk-1';
export const COMPARE_JOB = 'compare-1';

export type PolishFixture = Readonly<{
  cell: PolishCell;
  family: PolishFamily;
  /** The walkthrough fixture over the before product (its files are the before's). */
  walk: WalkFixture;
  before: FileMap;
  after: FileMap;
  /** The files the after-state changes, at their after text: what the polish unit's build commits. */
  changed: Readonly<Record<string, string>>;
}>;

export type PolishKey = Readonly<{ cell: string; family: string; variant: Variant; expected: 'keep' | 'drop'; seed: string; trial: number; sha: string }>;

export function buildPolishFixture(cell: PolishCell): PolishFixture {
  const family = FAMILIES[cell.family];
  if (!cell.after.some((e) => e.file.startsWith('design/'))) throw new Error(`${cell.id}: its after-state leaves the reference design/ untouched`);
  const clean = buildWalkFixture({ id: cell.id, seed: cell.seed, planted: [] });
  const before = applyEdits(clean.files, family.before);
  const after = applyEdits(before, cell.after);
  const changed = Object.fromEntries([...after].filter(([p, t]) => before.get(p) !== t));
  return { cell, family, walk: { ...clean, files: before }, before, after, changed };
}

export const keyOf = (f: PolishFixture, trial: number, sha: string): PolishKey => ({
  cell: f.cell.id, family: f.cell.family, variant: f.cell.variant, expected: expectedDecision(f.cell.variant), seed: f.cell.seed, trial, sha,
});
