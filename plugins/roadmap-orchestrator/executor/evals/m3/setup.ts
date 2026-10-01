// The M3 paid fixture, step 1: `node evals/m3/setup.ts <dir>` lays out a fresh fixture in `<dir>` (absent or
// empty; anything else is refused, so a previous run is never half-reused). Hand-authored against SCHEMAS.md
// ("Input contract", "spec.json M1 subset", "M3: the holistic layer"):
//
//   repo/     the Node CLI `ledger` (pure ES modules, `node --test`), copied from evals/m3/files/base/: `src/cli.js`
//             (commands `format` through `formatAmount`, `total` through `formatDisplay`; unknown commands, wrong
//             arguments and non-amounts exit 2 with a message), `src/format.js` (`isAmount`, the exact `sumAmounts`,
//             `formatAmount` building the cents from the decimal digits, half to even, with no comment saying so),
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { AUDIT_EVERY, CONVERGENCE_K, INTEGRATION, LENSES, type Layout, MAIN, MONEY_LANE, UNITS, layout } from './layout.ts';

export const BARRIER_SCRIPT = fileURLToPath(new URL('./barrier.ts', import.meta.url));
/** The money lane waits at most this long for the driver (the driver's own run timeout is shorter). */
const BARRIER_TIMEOUT_MS = 5 * 60 * 60_000;

export const CONTRACT_PATH = '.roadmap/contracts/ledger.md';

/**
 * The product's files, as real files (`evals/m3/files/`): `base/` is the baseline tree, `units/<unit>/` the files each
 * fake build commits (`units/report-on-tidy/` is report's src/cli.js on a tree tidy changed, branch R). The seed is
 * meant to satisfy the vision everywhere but the story's own issue (`formatDisplay`'s `toFixed`, against I-2's
 * half-even): strict amounts and dates, exact sums, refused input exits 2 with a message (paid run 4's lenses found
 * real V-3 gaps in an earlier seed and the checkpoint kept steering).
 */
export const FILES = fileURLToPath(new URL('./files/', import.meta.url));

/** Every file under `dir`, by its path relative to `dir`, ascending. */
export function filesOf(dir: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    out[relative(dir, abs)] = readFileSync(abs, 'utf8');
  }
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : 1)));
}

/** The witness test ids (node test ids: the test's name path), per obligation, as the journeys name them. */
export const WITNESS_TESTS = {
  'I-1': 'reconcile a month in one command',
  'I-2': 'amounts render to the cent',
  'I-3': 'unknown commands exit 2',
} as const;

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
  const common = { schema: 'roadmap/spec-m1', unit, rev: 1, scope: SCOPES[unit], resources: [], decisions: [], cites: { contracts: [CONTRACT_PATH], rulings: ['C-1', 'C-2', 'C-3', 'C-4'] } };
  switch (unit) {
    case 'parse':
      return {
        ...common, obligations: ['I-1'],
        lanes: [unitLane('parse', 'test/unit/parse.test.js')],
        acceptance: [
          clause('A1', '`parseLedger(text)` in src/parse.js returns the entries `{date, amount, memo}` of the lines `YYYY-MM-DD,<amount>,<memo>` in file order, `amount` the amount text as written; blank lines are skipped and `\\r\\n` line ends accepted (.roadmap/contracts/ledger.md, ledger file).'),
          clause('A2', 'A malformed line (not exactly three comma-separated fields, a date that is not a real calendar date, an amount `isAmount` from src/format.js refuses, an empty memo) throws a `LedgerError` (exported by src/parse.js) whose message names its 1-based line number and why (C-4).'),
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
          clause('A1', '`reconcile(entries, month)` in src/report.js returns `<month> balance <amount>`: the exact sum (`sumAmounts` from src/format.js) of the amounts of the entries whose date is in `month` (YYYY-MM), rendered by formatAmount (C-3); a month with no entries balances at 0.00.'),
          clause('A2', 'src/cli.js gains the command `reconcile <YYYY-MM> <file>`: it reads the file, parses it with parseLedger from src/parse.js and prints the line of A1 (.roadmap/contracts/ledger.md, commands). A wrong number of arguments, a month that is not YYYY-MM, a file it cannot read or a `LedgerError` is refused with a one-line message naming it on stderr and exit 2 (C-4). The other commands are unchanged.'),
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
  for (const [path, text] of Object.entries(filesOf(join(FILES, 'base')))) write(join(l.repo, path), text);
  git(l.repo, 'add', '--all');
  git(l.repo, 'commit', '--quiet', '--message', 'm3 fixture: the ledger CLI');
  git(l.repo, 'branch', INTEGRATION, MAIN);
  const baseline = git(l.repo, 'rev-parse', MAIN);

  write(join(l.input, 'rulings.md'), readFileSync(join(FILES, 'base', '.roadmap', 'constraints.md'), 'utf8'));
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
