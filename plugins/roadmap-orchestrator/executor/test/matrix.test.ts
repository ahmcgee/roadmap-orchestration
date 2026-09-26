// The crash matrix table itself (test/matrix.ts), as the single index of the crash and fixture evidence:
// nothing is left pending; every crash cell names a real crash point; every crash point in src/ is crashed
// by some cell; every row names test files that exist; every fixture cell names a test of its row's file
// and a row that crashes it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BOUNDARIES, type Boundary, MATRIX, RECOVERY_EFFECT_LABELS, crashCells } from './matrix.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const boundaries = Object.keys(BOUNDARIES) as Boundary[];
const cellsOf = (row: (typeof MATRIX)[number]) => boundaries.map((b) => ({ boundary: b, cell: row.cells[b] }));

/** Every label a `crashPoint('...')` call in src/ names. */
function sourceLabels(): ReadonlySet<string> {
  const dir = join(ROOT, 'src');
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.ts'));
  const labels = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(join(f.parentPath, f.name), 'utf8').matchAll(/crashPoint\('([^']+)'\)/g)) labels.add(m[1]!);
  }
  return labels;
}

/** The test files a row names (`test/<name>.test.ts`, possibly several, each with a note). */
const testFiles = (row: (typeof MATRIX)[number]): readonly string[] => [...row.test.matchAll(/test\/[\w.-]+\.test\.ts/g)].map((m) => m[0]);

test('matrix.no-pending: every cell is crashed, killed, a fixture, or excluded with a reason', () => {
  const pending = MATRIX.flatMap((r) => cellsOf(r).flatMap(({ boundary, cell }) => (cell.status === 'pending' ? [`${r.row} ${boundary}`] : [])));
  assert.deepEqual(pending, []);
  const empty = MATRIX.flatMap((r) => cellsOf(r).flatMap(({ boundary, cell }) => (cell.status === 'excluded' && cell.why.trim() === '' ? [`${r.row} ${boundary}`] : [])));
  assert.deepEqual(empty, [], 'an exclusion says why');
  assert.equal(new Set(MATRIX.map((r) => r.row)).size, MATRIX.length, 'row names are unique');
});

test('matrix.labels-exist: every label a cell crashes is a crashPoint call in src/', () => {
  const known = sourceLabels();
  const cited = [...MATRIX.flatMap((r) => crashCells(r.row).map((c) => c.label)), ...Object.values(RECOVERY_EFFECT_LABELS)];
  assert.deepEqual([...new Set(cited.filter((l) => !known.has(l)))], []);
});

test('matrix.labels-covered: every crashPoint label in src/ is crashed by at least one cell', () => {
  const cited = new Set(MATRIX.flatMap((r) => crashCells(r.row).map((c) => c.label)));
  assert.deepEqual([...sourceLabels()].filter((l) => !cited.has(l)).sort(), []);
});

test('matrix.test-files-exist: every row names at least one test file, and each exists', () => {
  for (const r of MATRIX) {
    const files = testFiles(r);
    assert.ok(files.length > 0, `${r.row}: names no test file (${r.test})`);
    for (const f of files) assert.ok(existsSync(join(ROOT, f)), `${r.row}: ${f} does not exist`);
  }
});

test('matrix.fixtures-indexed: a fixture cell names a test of its row\'s file, and a row that crashes it', () => {
  const rows = new Set(MATRIX.map((r) => r.row));
  let fixtures = 0;
  for (const r of MATRIX) {
    const sources = testFiles(r).map((f) => readFileSync(join(ROOT, f), 'utf8'));
    for (const { boundary, cell } of cellsOf(r)) {
      if (cell.status !== 'fixture') continue;
      fixtures += 1;
      assert.ok(sources.some((s) => s.includes(`test('${cell.test}:`)), `${r.row} ${boundary}: no test '${cell.test}: …' in ${r.test}`);
      assert.ok(rows.has(cell.crashedIn), `${r.row} ${boundary}: crashedIn names no row: ${cell.crashedIn}`);
      assert.ok(crashCells(cell.crashedIn).length > 0, `${r.row} ${boundary}: ${cell.crashedIn} crashes nothing`);
    }
  }
  assert.ok(fixtures > 0);
});
