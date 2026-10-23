// One verifier trial's fixture: the cell's hunks as `git diff -U0` cuts them (checked against the cell's key, which must
// name one expectation per hunk) and the answer key, which only the eval run dir holds.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../../../test/helpers/repo.ts';
import type { VerifierCell } from './cells.ts';
import type { HunkExpect, VerifierFamily } from './families.ts';

/** One hunk of the cell's diff: its changed lines without their +/- marks. */
export type CellHunk = Readonly<{ lines: readonly string[] }>;

export type VerifierFixture = Readonly<{
  cell: VerifierCell;
  hunks: readonly CellHunk[];
  /** The trial's right outcome: accept only when every hunk is clear. */
  expected: 'accept' | 'refuse';
}>;

export type VerifierKey = Readonly<{
  cell: string; family: VerifierFamily; path: string; hunks: readonly HunkExpect[]; expected: 'accept' | 'refuse'; trial: number;
}>;

/** The `git diff -U0` of `before`..`after` (as src/pipeline/docsonly.ts reads a file's diff). */
export function diffOf(before: string, after: string): string {
  const dir = tmpDir('verifier-hunks');
  writeFileSync(join(dir, 'a'), before);
  writeFileSync(join(dir, 'b'), after);
  const r = spawnSync('git', ['diff', '--no-index', '--no-renames', '-U0', 'a', 'b'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 1) throw new Error(`git diff --no-index exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** The hunks of `before`..`after` under `git diff -U0`. */
export function hunksOf(before: string, after: string): readonly CellHunk[] {
  const out: string[][] = [];
  for (const line of diffOf(before, after).split('\n')) {
    if (line.startsWith('@@')) out.push([]);
    else if (out.length > 0 && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) out.at(-1)!.push(line.slice(1));
  }
  return out.map((lines) => ({ lines }));
}

export function buildVerifierFixture(cell: VerifierCell): VerifierFixture {
  if (!cell.path.startsWith('src/')) throw new Error(`${cell.id}: ${cell.path} is outside the unit's scope src/**`);
  const hunks = hunksOf(cell.before, cell.after);
  if (hunks.length !== cell.hunks.length) throw new Error(`${cell.id}: the diff has ${hunks.length} hunks, the key names ${cell.hunks.length}`);
  return { cell, hunks, expected: cell.hunks.every((h) => h === 'clear') ? 'accept' : 'refuse' };
}

export const keyOf = (f: VerifierFixture, trial: number): VerifierKey => ({
  cell: f.cell.id, family: f.cell.family, path: f.cell.path, hunks: f.cell.hunks, expected: f.expected, trial,
});
