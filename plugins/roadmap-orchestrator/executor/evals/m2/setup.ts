// The M2 paid fixture, step 1: `node evals/m2/setup.ts <dir>` lays out a fresh fixture in `<dir>` (absent or
// empty; anything else is refused, so a previous run is never half-reused). Hand-authored against SCHEMAS.md
// ("Input contract", "spec.json M1 subset", "M2"):
//
//   repo/     a small Node library (pure ES modules, `node --test`), branch `main` and an `integration` branch
//             cut from it; in-tree `.roadmap/` holds contracts/one.md, the C-nn ledger, invariants, config.json
//   input/    plan.json and one spec per unit, rulings.md
//   estate/   the pool's state dir (the driver arms instance #2's failing teardown during the run)
//   barriers/ empty: the lanes write `.reached` here, the driver `.release`
//
// Units (DAG, merged-only edges): `base`; `left` and `right` after it; `top` after both, plus the contingent edge
// `e-top` the driver resolves once `left` merges; `urgent` (origin checkpoint, no deps), which the driver keeps
// out with `run-only` until `right` is paused. `right` and `urgent` both edit the one line of src/registry.js,
// so once `urgent` merges, `right` conflicts with integration; `right2` (`reentrySpec`, written by the driver)
// re-enters it at verify and resolves the conflict.
//
// Resources: the pool `estate` of size 2 (estate.ts, directory-backed, owner markers per instance) and the
// `@cpu` pool of CPU_CAPACITY. Every unit has an estate lane; only `left`'s and `right`'s wait at the
// `estate-hold` barrier (two rounds: the kill, then the failing teardown), which holds both instances at once.
// `right` also has the `right-hold` barrier lane, after its edit commit.
// Each unit's product is a one-function module and a test: every lane runs in seconds.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CPU_CAPACITY, EDGE, ESTATE_HOLD, ESTATE_ROUNDS, INTEGRATION, type Layout, MAIN, POOL, POOL_SIZE, REENTRY, RIGHT_HOLD, SHARED_FILE, UNITS, layout,
} from './layout.ts';

export const ESTATE_SCRIPT = fileURLToPath(new URL('./estate.ts', import.meta.url));
/** A barrier lane waits at most this long for the driver (the driver's own run timeout is shorter). */
const BARRIER_TIMEOUT_MS = 3 * 60 * 60_000;

const CONTRACT = `# Contract one: the parts library

Every module under \`src/\` exports one pure function; later modules import earlier ones instead of repeating
them.

## Parts

- \`base()\` in \`src/base.js\` returns \`'base'\`.
- \`left()\` in \`src/left.js\` returns \`base() + '-left'\`, importing \`base\`.
- \`right()\` in \`src/right.js\` returns \`base() + '-right'\`, importing \`base\`.
- \`top()\` in \`src/top.js\` returns \`left() + '+' + right()\`, importing both.

## The registry

\`src/registry.js\` is exactly one line, \`export const NAMES = [...];\`, an array literal of the registered
names in registration order. It starts as \`['core']\`. A unit that registers a name appends it to that one line,
in place, never on a new line and never by code that mutates the array.
`;

const RULINGS = `# Constraints (C-nn ledger)

C-1 — Every module under src/ is a pure ES module with no runtime dependencies and no I/O.
C-2 — Every exported function is covered by node --test tests under test/, one test file per module.
C-3 — src/registry.js stays one line: registrations edit that line in place.
`;

const INVARIANTS = `# Invariants

- \`npm test\` passes on the integration branch.
- \`package.json\` declares no dependencies.
`;

const ARCHITECTURE = `# Architecture

A tiny library of pure functions.

- \`src/<module>.js\`: one ES module per concern, exporting pure functions. No dependencies, no I/O.
- \`test/<module>.test.js\`: that module's \`node --test\` tests.
- \`npm test\` runs \`node --test\`, which finds every \`*.test.js\`.
- \`src/registry.js\` lists the registered names on one line (\`.roadmap/contracts/one.md\`, the registry).
`;

const test = (module: string, body: string): string =>
  `import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n${module}\n\n${body}`;

const PRODUCT: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: 'm2-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'ARCHITECTURE.md': ARCHITECTURE,
  [SHARED_FILE]: "export const NAMES = ['core'];\n",
  'test/registry.test.js': test("import { NAMES } from '../src/registry.js';", "test('the registry starts with core', () => {\n  assert.equal(NAMES[0], 'core');\n});\n"),
  '.roadmap/contracts/one.md': CONTRACT,
  '.roadmap/constraints.md': RULINGS,
  '.roadmap/invariants.md': INVARIANTS,
  '.roadmap/config.json': `${JSON.stringify({ routing: {} }, null, 2)}\n`,
};

const CONTRACT_PATH = '.roadmap/contracts/one.md';
const SCOPE = ['src/**', 'test/**'];
const PASS_PATH = { set: {}, pass: ['PATH'] };

const lane = (id: string, tier: 'fast' | 'estate', argv: readonly string[], resources: readonly string[], cpu?: number) => ({
  id, argv, cwd: '.', env: PASS_PATH, expectedExit: 0, tier, resources, evidenceGlobs: [], state: 'active', ...(cpu === undefined ? {} : { cpu }),
});
const fastLane = (id: string, ...files: readonly string[]) => lane(id, 'fast', ['node', '--test', ...files], []);
/** The unit's estate lane: holds one instance of the pool; at the `estate-hold` barrier for `left` and `right`. */
const estateLane = (l: Layout, id: string, hold: boolean) =>
  lane(id, 'estate', [process.execPath, ESTATE_SCRIPT, 'hold', l.estate, ...(hold ? [l.barriers, ESTATE_HOLD, String(ESTATE_ROUNDS), String(BARRIER_TIMEOUT_MS)] : [])], [POOL]);
/** `right`'s barrier lane after its edit commit: no instance, one `@cpu` token. */
const holdLane = (l: Layout) => lane(RIGHT_HOLD, 'estate', [process.execPath, ESTATE_SCRIPT, 'barrier', l.barriers, RIGHT_HOLD, '1', String(BARRIER_TIMEOUT_MS)], [], 1);

const clause = (id: string, text: string) => ({ id, clause: text, failLoudIfUndelivered: true, state: 'active' });

type SpecUnit = (typeof UNITS)[number] | typeof REENTRY;

const part = (unit: string, expr: string, imports: string): readonly unknown[] => [
  clause('A1', `${unit}() in src/${unit}.js returns ${expr}, importing ${imports} rather than re-implementing it (${CONTRACT_PATH}, parts).`),
  clause('A2', `test/${unit}.test.js covers A1 and passes under the ${unit} lane (C-2).`),
];

const REGISTER_RIGHT = `Edit the one line of ${SHARED_FILE} in place so it reads exactly \`export const NAMES = ['core', 'right'];\` (${CONTRACT_PATH}, the registry; C-3).`;

function specOf(l: Layout, unit: SpecUnit): unknown {
  const common = { schema: 'roadmap/spec-m1', unit, rev: 1, scope: SCOPE, resources: [], decisions: [], cites: { contracts: [CONTRACT_PATH], rulings: ['C-1', 'C-2', 'C-3'] } };
  const facts = (text: string) => [{ id: 'F1', text, state: 'active' }];
  switch (unit) {
    case 'base':
      return { ...common, lanes: [fastLane('base', 'test/base.test.js'), estateLane(l, 'estate', false)], acceptance: part('base', "'base'", 'nothing'), facts: facts('package.json declares "type": "module".') };
    case 'left':
      return { ...common, lanes: [fastLane('left', 'test/left.test.js'), estateLane(l, ESTATE_HOLD, true)], acceptance: part('left', "base() + '-left'", 'base from src/base.js'), facts: facts('src/base.js exports base once unit base has merged.') };
    case 'right':
      return {
        ...common,
        lanes: [fastLane('right', 'test/right.test.js'), estateLane(l, ESTATE_HOLD, true), holdLane(l)],
        acceptance: [
          ...part('right', "base() + '-right'", 'base from src/base.js'),
          clause('A3', `${REGISTER_RIGHT} test/right.test.js asserts that NAMES includes 'right'.`),
        ],
        facts: facts('src/base.js exports base once unit base has merged.'),
      };
    case 'top':
      return { ...common, lanes: [fastLane('top', 'test/top.test.js'), estateLane(l, 'estate', false)], acceptance: part('top', "left() + '+' + right()", 'left from src/left.js and right from src/right.js'), facts: facts('src/left.js and src/right.js export left and right once units left and right have merged.') };
    case 'urgent':
      return {
        ...common,
        lanes: [fastLane('registry', 'test/registry.test.js'), estateLane(l, 'estate', false)],
        acceptance: [
          clause('A1', `Edit the one line of ${SHARED_FILE} in place so it reads exactly \`export const NAMES = ['core', 'urgent'];\` (${CONTRACT_PATH}, the registry; C-3).`),
          clause('A2', "test/registry.test.js also asserts that NAMES includes 'urgent', and passes under the registry lane (C-2)."),
        ],
        facts: facts(`${SHARED_FILE} is one line, \`export const NAMES = ['core'];\`, at the baseline.`),
      };
    case REENTRY:
      return {
        ...common,
        lanes: [fastLane('right', 'test/right.test.js', 'test/registry.test.js'), estateLane(l, 'estate', false)],
        acceptance: [
          ...part('right', "base() + '-right'", 'base from src/base.js'),
          clause('A3', `The one line of ${SHARED_FILE} reads exactly \`export const NAMES = ['core', 'urgent', 'right'];\`: the integration branch's 'urgent' kept, 'right' appended in place (${CONTRACT_PATH}, the registry; C-3). test/right.test.js asserts that NAMES includes 'right'.`),
        ],
        facts: [
          { id: 'F1', text: 'This unit re-enters unit right: its branch already holds right() and its test.', state: 'active' },
          { id: 'F2', text: `Unit urgent merged first and registered 'urgent' on the same line of ${SHARED_FILE}.`, state: 'active' },
        ],
      };
  }
}

/** The spec the driver writes at the re-entry, and the plan unit it appends (after `right`'s envelope and risk). */
export function reentrySpec(l: Layout): unknown {
  return specOf(l, REENTRY);
}
export const reentryUnit = { id: REENTRY, spec: `${REENTRY}.json`, risk: 'med', scope: SCOPE, resources: [], after: ['base'], reenters: { unit: 'right', enterAt: 'verify' } } as const;

function poolDecl(l: Layout) {
  const tool = (cmd: string) => ({ argv: [process.execPath, ESTATE_SCRIPT, cmd, l.estate], cwd: '.', env: PASS_PATH });
  return { name: POOL, pool: { size: POOL_SIZE }, probe: tool('probe'), teardown: tool('teardown') };
}

const PLAN_UNITS: Readonly<Record<(typeof UNITS)[number], object>> = {
  base: {},
  left: { after: ['base'] },
  right: { after: ['base'] },
  top: { after: ['left', 'right'], contingent: [{ id: EDGE, condition: 'left has merged and its left() is what top builds on' }] },
  urgent: { origin: 'checkpoint' },
};

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

export function setup(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`fixture dir ${dir} is not empty: a fixture dir is set up and run once`);
  const l = layout(dir);
  for (const d of [l.worktrees, l.estate, l.barriers, l.repo]) mkdirSync(d, { recursive: true });

  git(l.repo, '-c', `init.defaultBranch=${MAIN}`, 'init', '--quiet');
  git(l.repo, 'config', 'user.name', 'M2 Fixture');
  git(l.repo, 'config', 'user.email', 'm2-fixture@example.invalid');
  git(l.repo, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries(PRODUCT)) write(join(l.repo, path), text);
  git(l.repo, 'add', '--all');
  git(l.repo, 'commit', '--quiet', '--message', 'm2 fixture: initial product');
  git(l.repo, 'branch', INTEGRATION, MAIN);
  const baseline = git(l.repo, 'rev-parse', MAIN);

  write(join(l.input, 'rulings.md'), RULINGS);
  for (const unit of UNITS) write(join(l.input, `${unit}.json`), json(specOf(l, unit)));
  write(l.plan, json({
    schema: 'roadmap/plan-m1',
    arc: l.arc,
    integrationBranch: INTEGRATION,
    baseline,
    worktreeRoot: l.worktrees,
    contracts: [CONTRACT_PATH],
    rulings: 'rulings.md',
    architectureDoc: 'ARCHITECTURE.md',
    direction: 'Grow a small library of pure parts, each built on the ones before it, and keep the one-line registry of names current. Every module stays dependency-free and fully tested.',
    capacity: { cpu: CPU_CAPACITY },
    suite: {
      lanes: [{
        id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: { npm_config_update_notifier: 'false' }, pass: ['PATH', 'HOME'] },
        expectedExit: 0, tier: 'estate', resources: [], evidenceGlobs: [],
      }],
    },
    resources: [poolDecl(l)],
    units: UNITS.map((id) => ({ id, spec: `${id}.json`, risk: 'med', scope: SCOPE, resources: [], ...PLAN_UNITS[id] })),
  }));
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m2/setup.ts <dir>');
  const abs = resolve(dir);
  setup(abs);
  process.stdout.write(`${JSON.stringify({ fixture: abs, plan: layout(abs).plan, repo: layout(abs).repo })}\n`);
}
