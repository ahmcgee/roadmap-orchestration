// The M3 paid fixture, step 1: `node evals/m3/setup.ts <dir>` lays out a fresh fixture in `<dir>` (absent or
// empty; anything else is refused, so a previous run is never half-reused). Hand-authored against SCHEMAS.md
// ("Input contract", "spec.json M1 subset", "M3: the holistic layer"):
//
//   repo/     the Node CLI `ledger` (pure ES modules, `node --test`): `src/cli.js` (commands `format` through
//             `formatAmount`, `total` through `formatDisplay`; unknown commands exit 2), `src/format.js` (`formatAmount`,
//             building the cents from the amount's decimal digits, half to even, with no comment saying so),
//             `src/display.js` (`formatDisplay`, thousands separators over `toFixed(2)`), the unit tests under
//             test/unit/ (the suite, `npm test`), the journey tests under journeys/ (`*.journey.js`: the arc lanes;
//             outside `node --test`'s default discovery, so neither the suite nor a bare `node --test` an implementer
//             runs picks them up), docs/money.md (the rounding rule, I-2's docRef: no spec cites it, and it is
//             neither a plan contract nor the architecture doc, so no plan-check or gate is handed it); branch `main`
//             and an `integration` branch cut from it; in-tree `.roadmap/` holds contracts/ledger.md, the C-nn
//             ledger, a hand-written invariants.md (the close-out renders it, so the close-out publication has
//             something to change) and config.json (empty routing)
//   input/    plan.json (holistic: vision, obligations, audit every 2 with L = {invariants, vision};
//             limits.convergenceK 1), vision.json, obligations.json, rulings.md and one spec per unit
//   barriers/ empty: in branch R the money lane writes `money.reached` here, the driver `money.release`
//
// The vision (plan "Fixture evals/m3/"): V-1 purpose "bookkeepers reconcile a month in one command", V-2
// non-negotiable "money is never silently mis-rounded", V-3 tradeoff rank 1 "clear errors over permissive input".
// The obligations, each witnessed by one node-test arc lane over one journey test:
//   I-1 future, serves V-1, delivered by `parse` and `report`: `node src/cli.js reconcile 2026-09 <file>` prints
//       the month's balance (fails at the baseline: there is no reconcile command)
//   I-2 must-hold, serves V-2: `format` prints amounts rounded to the cent half to even, `format 0.125` prints
//       0.12 (held at the baseline; lane `money`, which waits at the driver's barrier in the first audit that sees the
//       regression, branch R only)
//   I-3 must-hold, serves V-3: unknown commands exit 2
//
// The regression (lead ruling after paid runs 1 and 2, whose plan-checks read a rounding change in tidy's spec and
// redirected it): tidy's diff holds no rounding code at all. Its spec is a one-line consistency change in
// src/cli.js: `format` prints through `formatDisplay`, the helper `total` already prints through, so both commands
// show amounts alike (`format 1234.5` prints `1,234.50`). formatDisplay rounds with `toFixed` (binary), which
// disagrees with half-even on ties (0.125 → '0.13', 0.625 → '0.63', 2.675 → '2.67'), so tidy regresses I-2.
// tidy's one path src/cli.js maps to I-3 only, so it never selects I-2.
//
// Units: `parse` (src/parse.js); `tidy` after it (src/cli.js); `report` after `parse` (src/report.js and the
// `reconcile` command in src/cli.js, rendered by formatAmount), which the driver keeps out with run-only until A1
// waits at the barrier. `repairSpec` is the spec the checkpoint is expected to admit (origin repair, repairing I-2's
// P1 by making formatDisplay round half to even): the fake story admits exactly it; a real checkpoint writes its own,
// and the check accepts any repair that makes I-2 hold.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { AUDIT_EVERY, CONVERGENCE_K, INTEGRATION, LENSES, type Layout, MAIN, MONEY_LANE, MONTH, RECONCILED, UNITS, layout } from './layout.ts';

export const BARRIER_SCRIPT = fileURLToPath(new URL('./barrier.ts', import.meta.url));
/** The money lane waits at most this long for the driver (the driver's own run timeout is shorter). */
const BARRIER_TIMEOUT_MS = 4 * 60 * 60_000;

export const CONTRACT_PATH = '.roadmap/contracts/ledger.md';

const CONTRACT = `# Contract: the ledger CLI

\`ledger\` is run as \`node src/cli.js <command> [args...]\`.

## Commands

- \`format <amount>\` prints the amount with two decimals.
- \`total <amount>...\` prints the sum of the amounts for display, with thousands separators.
- \`reconcile <YYYY-MM> <file>\` prints \`<YYYY-MM> balance <amount>\`: the sum of the ledger file's entries dated in
  that month, rendered by \`formatAmount\`.

Unknown commands exit 2 with a one-line error on stderr naming the command.

## Ledger file

One entry per line, \`YYYY-MM-DD,<amount>,<memo>\`; blank lines are skipped. A malformed line is refused with an
error naming its 1-based line number.

## Money

\`formatAmount(amount)\` in \`src/format.js\` renders an amount with exactly two decimals; \`formatDisplay(amount)\`
in \`src/display.js\` renders one for display, two decimals with thousands separators. Every amount the CLI prints
goes through one of them.
`;

const RULINGS = `# Constraints (C-nn ledger)

C-1 — Every module under src/ is a dependency-free ES module; only src/cli.js does I/O.
C-2 — Every exported function is covered by node --test tests under test/unit/, one test file per module.
C-3 — Amounts are rendered only through formatAmount (src/format.js) or formatDisplay (src/display.js).
`;

const INVARIANTS = `# Invariants

- \`npm test\` passes on the integration branch.
- \`package.json\` declares no dependencies.
`;

const ARCHITECTURE = `# Architecture

A small bookkeeping CLI.

- \`src/cli.js\`: the command dispatcher (\`.roadmap/contracts/ledger.md\`, commands); the only module doing I/O.
- \`src/<module>.js\`: one ES module per concern, pure functions, no dependencies.
- \`test/unit/<module>.test.js\`: that module's \`node --test\` tests; \`npm test\` runs them all.
- \`journeys/\`: end-to-end tests of the CLI (\`*.journey.js\`), one per obligation, run by the arc lanes (never by
  \`npm test\`).

## Money

Amounts are JavaScript numbers, rendered by formatAmount in \`src/format.js\` or, for display, by formatDisplay in
\`src/display.js\`.
`;

/** The rounding rule (I-2's docRef): only the obligation points here. */
const MONEY_DOC = `# Money

## Rounding

The \`format\` command rounds an amount to the cent on its decimal digits, half to even: \`format 0.125\` prints 0.12,
\`format 2.675\` prints 2.68.
`;

const unitTest = (imports: string, body: string): string =>
  `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n${imports}\n\n${body}`;

const CLI = `// ledger: node src/cli.js <command> [args...] (.roadmap/contracts/ledger.md, commands).
import { formatDisplay } from './display.js';
import { formatAmount } from './format.js';

const COMMANDS = {
  format: ([amount]) => {
    process.stdout.write(\`\${formatAmount(Number(amount))}\\n\`);
    return 0;
  },
  total: (amounts) => {
    process.stdout.write(\`\${formatDisplay(amounts.reduce((sum, a) => sum + Number(a), 0))}\\n\`);
    return 0;
  },
};

const [name, ...args] = process.argv.slice(2);
const command = Object.hasOwn(COMMANDS, name ?? '') ? COMMANDS[name] : undefined;
if (command === undefined) {
  process.stderr.write(\`ledger: unknown command \${JSON.stringify(name ?? '')}\\n\`);
  process.exitCode = 2;
} else {
  process.exitCode = command(args);
}
`;

const FORMAT = `/** Renders a money amount with exactly two decimals (.roadmap/contracts/ledger.md, money). */
export function formatAmount(amount) {
  const sign = amount < 0 ? '-' : '';
  const [whole, fraction = ''] = String(Math.abs(amount)).split('.');
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  const rest = fraction.slice(2);
  const above = rest.slice(1).replace(/0/g, '') !== '';
  if (rest[0] > '5' || (rest[0] === '5' && (above || cents % 2n === 1n))) cents += 1n;
  return \`\${sign}\${cents / 100n}.\${String(cents % 100n).padStart(2, '0')}\`;
}
`;

const DISPLAY = `/** Renders an amount for display: two decimals, thousands separated (.roadmap/contracts/ledger.md, money). */
export function formatDisplay(amount) {
  const [whole, cents] = amount.toFixed(2).split('.');
  return \`\${whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',')}.\${cents}\`;
}
`;

/** A journey test runs the CLI in the checkout it is in. */
const journey = (name: string, body: string): string => `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ledger = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('${name}', () => {
${body}
});
`;

/** The witness test ids (node test ids: the test's name path), per obligation. */
export const WITNESS_TESTS = {
  'I-1': 'reconcile a month in one command',
  'I-2': 'amounts render to the cent',
  'I-3': 'unknown commands exit 2',
} as const;

const PRODUCT: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: 'ledger', private: true, type: 'module', scripts: { test: "node --test 'test/unit/*.test.js'" } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'ARCHITECTURE.md': ARCHITECTURE,
  'src/cli.js': CLI,
  'src/format.js': FORMAT,
  'src/display.js': DISPLAY,
  'test/unit/display.test.js': unitTest("import { formatDisplay } from '../../src/display.js';", "test('formatDisplay separates thousands', () => {\n  assert.equal(formatDisplay(1234.5), '1,234.50');\n  assert.equal(formatDisplay(3), '3.00');\n});\n"),
  'test/unit/format.test.js': unitTest("import { formatAmount } from '../../src/format.js';", "test('formatAmount renders two decimals', () => {\n  assert.equal(formatAmount(12.5), '12.50');\n  assert.equal(formatAmount(3), '3.00');\n  assert.equal(formatAmount(0.1 + 0.2), '0.30');\n});\n"),
  'journeys/reconcile.journey.js': journey(WITNESS_TESTS['I-1'], `  const r = ledger('reconcile', '${MONTH}', fileURLToPath(new URL('./september.csv', import.meta.url)));\n  assert.equal(r.status, 0, r.stderr);\n  assert.equal(r.stdout, '${RECONCILED}\\n');`),
  'journeys/september.csv': '2026-08-31,40.00,last month\n2026-09-01,10.50,refund\n\n2026-09-15,2.25,interest\n2026-10-01,99.00,next month\n',
  'journeys/money.journey.js': journey(WITNESS_TESTS['I-2'], "  for (const [amount, printed] of [['0.125', '0.12'], ['0.625', '0.62'], ['2.675', '2.68'], ['10.5', '10.50']]) {\n    const r = ledger('format', amount);\n    assert.equal(r.status, 0, r.stderr);\n    assert.equal(r.stdout, `${printed}\\n`);\n  }"),
  'docs/money.md': MONEY_DOC,
  'journeys/cli.journey.js': journey(WITNESS_TESTS['I-3'], "  const r = ledger('frobnicate');\n  assert.equal(r.status, 2);\n  assert.match(r.stderr, /frobnicate/);"),
  [CONTRACT_PATH]: CONTRACT,
  '.roadmap/constraints.md': RULINGS,
  '.roadmap/invariants.md': INVARIANTS,
  '.roadmap/config.json': `${JSON.stringify({ routing: {} }, null, 2)}\n`,
};

const VISION = {
  schema: 'roadmap/vision-m3',
  rev: 1,
  confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'purpose', text: 'bookkeepers reconcile a month in one command', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'money is never silently mis-rounded', rank: null, state: 'active' },
    { id: 'V-3', kind: 'tradeoff', text: 'clear errors over permissive input', rank: 1, state: 'active' },
  ],
};

const PASS_PATH = { set: {}, pass: ['PATH'] };

/** An arc lane (node-test reporter) over one journey test; the money lane goes through the barrier (branch R). */
function arcLane(l: Layout, id: string, file: string) {
  const test = [process.execPath, '--test', file];
  const argv = id === MONEY_LANE ? [process.execPath, BARRIER_SCRIPT, l.barriers, String(BARRIER_TIMEOUT_MS), '--', ...test] : test;
  return { id, argv, cwd: '.', env: PASS_PATH, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'node-test' };
}

type ObligationSeed = Readonly<{ id: keyof typeof WITNESS_TESTS; lane: string; statement: string; anchor: string; quotedText: string; docPath: string; serves: string; activation: 'future' | 'must-hold'; deliveredBy: readonly string[]; contracts: readonly string[] }>;

const OBLIGATIONS: readonly ObligationSeed[] = [
  {
    id: 'I-1', lane: 'reconcile', activation: 'future', deliveredBy: ['parse', 'report'], serves: 'V-1', contracts: [CONTRACT_PATH],
    statement: 'A bookkeeper reconciles a month of a ledger file in one command: `reconcile <YYYY-MM> <file>` prints the month\'s balance.',
    docPath: CONTRACT_PATH, anchor: '#commands', quotedText: '`reconcile <YYYY-MM> <file>` prints `<YYYY-MM> balance <amount>`',
  },
  {
    id: 'I-2', lane: MONEY_LANE, activation: 'must-hold', deliveredBy: [], serves: 'V-2', contracts: [],
    statement: '`format <amount>` prints the amount rounded to the cent on its decimal digits, half to even: `format 0.125` prints 0.12 and `format 2.675` prints 2.68.',
    docPath: 'docs/money.md', anchor: '#rounding', quotedText: 'half to even',
  },
  {
    id: 'I-3', lane: 'cli', activation: 'must-hold', deliveredBy: [], serves: 'V-3', contracts: [CONTRACT_PATH],
    statement: 'Unknown commands exit 2.',
    docPath: CONTRACT_PATH, anchor: '#commands', quotedText: 'Unknown commands exit 2',
  },
];

/** Every path a unit may touch (and each journey and doc), mapped. tidy's one path, `src/cli.js`, maps to I-3 only. */
const MAPPING = [
  { pattern: 'docs/money.md', obligations: ['I-2'] },
  { pattern: 'journeys/cli.journey.js', obligations: ['I-3'] },
  { pattern: 'journeys/money.journey.js', obligations: ['I-2'] },
  { pattern: 'journeys/reconcile.journey.js', obligations: ['I-1'] },
  { pattern: 'src/cli.js', obligations: ['I-3'] },
  { pattern: 'src/display.js', obligations: ['I-2'] },
  { pattern: 'src/format.js', obligations: ['I-2'] },
  { pattern: 'src/parse.js', obligations: ['I-1'] },
  { pattern: 'src/report.js', obligations: ['I-1'] },
  { pattern: 'test/unit/display.test.js', obligations: ['I-2'] },
  { pattern: 'test/unit/format.test.js', obligations: ['I-2'] },
  { pattern: 'test/unit/parse.test.js', obligations: ['I-1'] },
  { pattern: 'test/unit/report.test.js', obligations: ['I-1'] },
];

export function obligationsFile(l: Layout): unknown {
  const lanes = [arcLane(l, 'cli', 'journeys/cli.journey.js'), arcLane(l, MONEY_LANE, 'journeys/money.journey.js'), arcLane(l, 'reconcile', 'journeys/reconcile.journey.js')];
  const revs = new Map(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes, obligations: [], mapping: { paths: [] } }).lanes.map((x) => [x.id as string, laneRevOf(x)]));
  return {
    schema: 'roadmap/obligations-m3',
    cutLine: 'a bookkeeper reconciles a month in one command, and every amount is rendered exactly',
    lanes,
    obligations: OBLIGATIONS.map((o) => {
      const witness = { lane: o.lane, testIds: [WITNESS_TESTS[o.id]] };
      return {
        id: o.id, rev: 1, statement: o.statement, docRef: { path: o.docPath, anchor: o.anchor, quotedText: o.quotedText }, serves: [o.serves],
        witness, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: revs.get(o.lane), witness },
        deliveredBy: [...o.deliveredBy], activation: o.activation, contracts: [...o.contracts], state: { type: 'active' },
      };
    }),
    mapping: { paths: MAPPING },
  };
}

const unitLane = (id: string, file: string) => commandLane(id, ['node', '--test', file]);
const commandLane = (id: string, argv: readonly string[]) => ({
  id, argv, cwd: '.', env: PASS_PATH, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active',
});
const clause = (id: string, text: string) => ({ id, clause: text, failLoudIfUndelivered: true, state: 'active' });
const fact = (id: string, text: string) => ({ id, text, state: 'active' });

type Unit = (typeof UNITS)[number] | 'fix-rounding';

const SCOPES: Readonly<Record<Unit, readonly string[]>> = {
  parse: ['src/parse.js', 'test/unit/parse.test.js'],
  tidy: ['src/cli.js'],
  report: ['src/cli.js', 'src/report.js', 'test/unit/report.test.js'],
  'fix-rounding': ['src/display.js', 'test/unit/display.test.js'],
};

function specOf(unit: Unit): unknown {
  const common = { schema: 'roadmap/spec-m1', unit, rev: 1, scope: SCOPES[unit], resources: [], decisions: [], cites: { contracts: [CONTRACT_PATH], rulings: ['C-1', 'C-2', 'C-3'] } };
  switch (unit) {
    case 'parse':
      return {
        ...common, obligations: ['I-1'],
        lanes: [unitLane('parse', 'test/unit/parse.test.js')],
        acceptance: [
          clause('A1', '`parseLedger(text)` in src/parse.js returns the entries `{date, amount, memo}` of the lines `YYYY-MM-DD,<amount>,<memo>` in file order, `amount` a number; blank lines are skipped (.roadmap/contracts/ledger.md, ledger file).'),
          clause('A2', 'A malformed line (not three comma-separated fields, a date not YYYY-MM-DD, an amount not a finite number) throws an Error whose message names its 1-based line number.'),
          clause('A3', 'test/unit/parse.test.js covers A1 and A2 and passes under the parse lane (C-2).'),
        ],
        facts: [fact('F1', 'package.json declares "type": "module"; src/cli.js is the only module doing I/O (C-1).')],
      };
    case 'tidy':
      return {
        ...common, obligations: ['I-3'],
        lanes: [commandLane('format-command', ['node', 'src/cli.js', 'format', '1234.5'])],
        acceptance: [
          clause('A1', 'In src/cli.js, the `format` command prints through formatDisplay from src/display.js, the helper the `total` command already prints through, so both commands show amounts the same way: `node src/cli.js format 1234.5` prints `1,234.50`.'),
          clause('A2', 'The other commands are unchanged; unknown commands still exit 2.'),
        ],
        facts: [fact('F1', '`total` prints through formatDisplay (src/display.js); `format` prints through formatAmount (src/format.js), so `format 1234.5` prints `1234.50` today while a total of 1234.5 prints `1,234.50`.')],
      };
    case 'report':
      return {
        ...common, obligations: ['I-1', 'I-3'],
        lanes: [unitLane('report', 'test/unit/report.test.js')],
        acceptance: [
          clause('A1', '`reconcile(entries, month)` in src/report.js returns `<month> balance <amount>`: the sum of the amounts of the entries whose date is in `month` (YYYY-MM), rendered by formatAmount (C-3).'),
          clause('A2', 'src/cli.js gains the command `reconcile <YYYY-MM> <file>`: it reads the file, parses it with parseLedger from src/parse.js and prints the line of A1 (.roadmap/contracts/ledger.md, commands). The other commands, and exit 2 for an unknown command, are unchanged.'),
          clause('A3', 'test/unit/report.test.js covers A1 and passes under the report lane (C-2).'),
        ],
        facts: [fact('F1', 'src/parse.js exports parseLedger once unit parse has merged.')],
      };
    case 'fix-rounding':
      return {
        ...common, obligations: ['I-2'], repairs: ['F-1'],
        lanes: [unitLane('display', 'test/unit/display.test.js')],
        acceptance: [
          clause('A1', '`formatDisplay(amount)` in src/display.js rounds to the cent on the amount\'s decimal digits, half to even (docs/money.md, rounding), keeping its thousands separators: `formatDisplay(0.125)` is `\'0.12\'`, `formatDisplay(2.675)` is `\'2.68\'`, `formatDisplay(1234.5)` is `\'1,234.50\'` (I-2).'),
          clause('A2', 'test/unit/display.test.js also asserts the values of A1 and passes under the display lane (C-2).'),
        ],
        facts: [fact('F1', 'Since unit tidy, `format` prints through formatDisplay, whose `toFixed(2)` rounds the binary value: `format 0.125` prints 0.13 (finding F-1, I-2 not held).')],
      };
  }
}

/** The repair the checkpoint is expected to admit: its plan unit and its spec's text (the fake story's admit op). */
export const REPAIR_UNIT = { id: 'fix-rounding', risk: 'med', scope: SCOPES['fix-rounding'], after: [], origin: 'repair' } as const;
export const repairSpecText = (): string => json(specOf('fix-rounding'));

// Isolated from the user's global and system git config, as in evals/m1/setup.ts.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { flag: 'wx' });
}

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const DIRECTION = 'Grow `ledger` until a bookkeeper reconciles a month in one command, every amount rendered exactly.';
/** The driver's stale-making edit (story step 4): the architect rewords the direction while the first checkpoint runs. */
export const DIRECTION_EDITED = `${DIRECTION} Clear errors come first.`;

export function setup(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`fixture dir ${dir} is not empty: a fixture dir is set up and run once`);
  const l = layout(dir);
  for (const d of [l.worktrees, l.barriers, l.repo]) mkdirSync(d, { recursive: true });

  git(l.repo, '-c', `init.defaultBranch=${MAIN}`, 'init', '--quiet');
  git(l.repo, 'config', 'user.name', 'M3 Fixture');
  git(l.repo, 'config', 'user.email', 'm3-fixture@example.invalid');
  git(l.repo, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries(PRODUCT)) write(join(l.repo, path), text);
  git(l.repo, 'add', '--all');
  git(l.repo, 'commit', '--quiet', '--message', 'm3 fixture: the ledger CLI');
  git(l.repo, 'branch', INTEGRATION, MAIN);
  const baseline = git(l.repo, 'rev-parse', MAIN);

  write(join(l.input, 'rulings.md'), RULINGS);
  write(l.vision, json(VISION));
  write(l.obligations, json(obligationsFile(l)));
  for (const unit of UNITS) write(join(l.input, `${unit}.json`), json(specOf(unit)));
  const after: Readonly<Record<(typeof UNITS)[number], readonly string[]>> = { parse: [], tidy: ['parse'], report: ['parse'] };
  write(l.plan, json({
    schema: 'roadmap/plan-m1',
    arc: l.arc,
    integrationBranch: INTEGRATION,
    baseline,
    worktreeRoot: l.worktrees,
    contracts: [CONTRACT_PATH],
    rulings: 'rulings.md',
    architectureDoc: 'ARCHITECTURE.md',
    direction: DIRECTION,
    suite: {
      lanes: [{
        id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: { npm_config_update_notifier: 'false' }, pass: ['PATH', 'HOME'] },
        expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [],
      }],
    },
    resources: [],
    holistic: { vision: 'vision.json', obligations: 'obligations.json', audit: { every: AUDIT_EVERY, lenses: [...LENSES] } },
    limits: { convergenceK: CONVERGENCE_K },
    units: UNITS.map((id) => ({ id, spec: `${id}.json`, risk: 'med', scope: SCOPES[id], resources: [], after: after[id] })),
  }));
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m3/setup.ts <dir>');
  const abs = resolve(dir);
  setup(abs);
  process.stdout.write(`${JSON.stringify({ fixture: abs, plan: layout(abs).plan, repo: layout(abs).repo })}\n`);
}
