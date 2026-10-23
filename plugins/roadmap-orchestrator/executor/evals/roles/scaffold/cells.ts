// The scaffold eval's cells (dev.17): small "new system" cases a plan-check's `scaffold` decision names, each over the corpus
// arc's Node repo (test/fixtures/unit-repo: `package.json` `{"type": "module"}`, `src/add.js`, `test/add.test.js`). A cell is
// the unit's spec (what it will build on the skeleton), the decision (the new system's paths and test paths, entry points,
// exports, manifest entries and the load test's id) and the load lane's test glob; the load lane is the arc lane `load`,
// `node --test <glob>` under the node-test reporter, run for real on what the writer wrote. Its `reference` is a skeleton
// that passes code's checks and the dry run: what the fake writers write (the free tier's check that every cell can pass),
// never shown to a real writer.
//
// Dev families: a plain module directory; a module the build reaches through a manifest entry (package.json `imports`); a
// load test that must import several named exports; a constrained skeleton (two entry points, a `bin` manifest entry and a
// load test nested in a suite, whose id is the name path "suite > test"), where a first attempt is likeliest to miss.
//
// The holdout set (evals/roles/holdout/scaffold.ts, untracked) exports HOLDOUT_SCAFFOLD_CELLS of the same type: other systems
// and families, run only at acceptance with --compare.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CellSet } from '../gate/cells.ts';

export type ScaffoldCell = Readonly<{
  id: string;
  /** What the cell exercises; the summary reports the landed rate per family. */
  family: string;
  /** The unit's acceptance clauses: the feature the build adds later, on the skeleton. */
  acceptance: readonly string[];
  /** The unit's scope (plan and spec): the new system's paths, its tests, and any manifest file. */
  scope: readonly string[];
  newSystem: Readonly<{ name: string; paths: readonly string[]; tests: readonly string[] }>;
  entryPoints: readonly string[];
  exports: readonly string[];
  manifest: readonly Readonly<{ path: string; entry: string }>[];
  /** The load test's id: its name path from its outermost suite, joined with " > " (the node witness reporter's). */
  testId: string;
  /** The load lane's test files, as `node --test` takes a glob. */
  loadGlob: string;
  /** A skeleton that passes: what the fake writers write. */
  reference: Readonly<Record<string, string>>;
}>;

const PACKAGE = (extra: string): string => `{\n  "name": "unit-fixture",\n  "private": true,\n  "type": "module",\n${extra}\n}\n`;

export const DEV_SCAFFOLD_CELLS: readonly ScaffoldCell[] = [
  {
    id: 'module', family: 'module',
    acceptance: ['charge(cents, card) returns a receipt carrying the charged amount and the card\'s last four digits', 'charge refuses a negative amount with a RangeError'],
    scope: ['src/**', 'test/**'],
    newSystem: { name: 'billing', paths: ['src/billing/**'], tests: ['test/billing/**'] },
    entryPoints: ['src/billing/index.js'], exports: ['charge'], manifest: [],
    testId: 'billing loads', loadGlob: 'test/billing/*.test.js',
    reference: {
      'src/billing/index.js': 'export function charge(cents, card) {\n  throw new Error(\'not implemented\');\n}\n',
      'test/billing/load.test.js': 'import assert from \'node:assert/strict\';\nimport { test } from \'node:test\';\nimport { charge } from \'../../src/billing/index.js\';\n\ntest(\'billing loads\', () => {\n  assert.equal(typeof charge, \'function\');\n});\n',
    },
  },
  {
    id: 'imports-map', family: 'manifest',
    acceptance: ['openLedger(dir) opens the ledger stored in dir and lists its entries', 'every module imports the ledger as #ledger, never by a relative path'],
    scope: ['packages/**', 'test/**', 'package.json'],
    newSystem: { name: 'ledger', paths: ['packages/ledger/**'], tests: ['test/ledger/**'] },
    entryPoints: ['packages/ledger/index.js'], exports: ['openLedger'],
    manifest: [{ path: 'package.json', entry: '"imports": { "#ledger": "./packages/ledger/index.js" }' }],
    testId: 'ledger loads through #ledger', loadGlob: 'test/ledger/*.test.js',
    reference: {
      'packages/ledger/index.js': 'export function openLedger(dir) {\n  throw new Error(\'not implemented\');\n}\n',
      'package.json': PACKAGE('  "imports": {\n    "#ledger": "./packages/ledger/index.js"\n  }'),
      'test/ledger/load.test.js': 'import assert from \'node:assert/strict\';\nimport { test } from \'node:test\';\nimport { openLedger } from \'#ledger\';\n\ntest(\'ledger loads through #ledger\', () => {\n  assert.equal(typeof openLedger, \'function\');\n});\n',
    },
  },
  {
    id: 'named-exports', family: 'named-exports',
    acceptance: ['convert(amount, from, to) converts between currencies at the rates RATE_TABLE holds', 'RATE_TABLE lists EUR, USD and GBP against EUR', 'convert throws RateError for a currency RATE_TABLE lacks'],
    scope: ['src/**', 'test/**'],
    newSystem: { name: 'rates', paths: ['src/rates/**'], tests: ['test/rates/**'] },
    entryPoints: ['src/rates/index.js'], exports: ['convert', 'RATE_TABLE', 'RateError'], manifest: [],
    testId: 'rates exports convert, RATE_TABLE and RateError', loadGlob: 'test/rates/*.test.js',
    reference: {
      'src/rates/index.js': 'export const RATE_TABLE = {};\n\nexport class RateError extends Error {}\n\nexport function convert(amount, from, to) {\n  throw new Error(\'not implemented\');\n}\n',
      'test/rates/load.test.js': 'import assert from \'node:assert/strict\';\nimport { test } from \'node:test\';\nimport { RATE_TABLE, RateError, convert } from \'../../src/rates/index.js\';\n\n'
        + 'test(\'rates exports convert, RATE_TABLE and RateError\', () => {\n  assert.equal(typeof convert, \'function\');\n  assert.equal(typeof RATE_TABLE, \'object\');\n  assert.equal(typeof RateError, \'function\');\n});\n',
    },
  },
  {
    id: 'bin-two-entries', family: 'constrained',
    acceptance: ['`report --month 2026-09` prints each team\'s spend for the month', 'buildReport(entries, month) is the library the command calls', 'the command exits 2 on a malformed month'],
    scope: ['src/**', 'test/**', 'package.json'],
    newSystem: { name: 'report', paths: ['src/report/**'], tests: ['test/report/**'] },
    entryPoints: ['src/report/index.js', 'src/report/cli.js'], exports: ['buildReport'],
    manifest: [{ path: 'package.json', entry: '"bin": { "report": "./src/report/cli.js" }' }],
    testId: 'report > loads', loadGlob: 'test/report/*.test.js',
    reference: {
      'src/report/index.js': 'export function buildReport(entries, month) {\n  throw new Error(\'not implemented\');\n}\n',
      'src/report/cli.js': '#!/usr/bin/env node\nimport { buildReport } from \'./index.js\';\n\nvoid buildReport;\n',
      'package.json': PACKAGE('  "bin": {\n    "report": "./src/report/cli.js"\n  }'),
      'test/report/load.test.js': 'import assert from \'node:assert/strict\';\nimport { describe, test } from \'node:test\';\nimport { buildReport } from \'../../src/report/index.js\';\n\n'
        + 'describe(\'report\', () => {\n  test(\'loads\', () => {\n    assert.equal(typeof buildReport, \'function\');\n  });\n});\n',
    },
  },
];

/** The untracked holdout set: `export const HOLDOUT_SCAFFOLD_CELLS: readonly ScaffoldCell[]`. */
export const HOLDOUT_SCAFFOLD_FILE = fileURLToPath(new URL('../holdout/scaffold.ts', import.meta.url));

export async function scaffoldCellsFor(set: CellSet): Promise<readonly ScaffoldCell[]> {
  if (set === 'dev') return DEV_SCAFFOLD_CELLS;
  if (!existsSync(HOLDOUT_SCAFFOLD_FILE)) throw new Error(`the holdout set is untracked and missing: ${HOLDOUT_SCAFFOLD_FILE} must export HOLDOUT_SCAFFOLD_CELLS`);
  const m = (await import(pathToFileURL(HOLDOUT_SCAFFOLD_FILE).href)) as { HOLDOUT_SCAFFOLD_CELLS?: readonly ScaffoldCell[] };
  if (m.HOLDOUT_SCAFFOLD_CELLS === undefined || m.HOLDOUT_SCAFFOLD_CELLS.length === 0) throw new Error(`${HOLDOUT_SCAFFOLD_FILE} exports no HOLDOUT_SCAFFOLD_CELLS`);
  return m.HOLDOUT_SCAFFOLD_CELLS;
}
