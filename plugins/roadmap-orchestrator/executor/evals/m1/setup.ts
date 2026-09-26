// The M1 paid fixture, step 1: `node evals/m1/setup.ts <dir>` lays out a fresh fixture in `<dir>` (absent or
// empty). Everything is hand-authored against SCHEMAS.md ("Input contract", "spec.json M1 subset"):
//
//   repo/     a small Node project (pure ES modules, `node --test` tests, `npm test`), branch `main` and an
//             `integration` branch cut from it; in-tree `.roadmap/` holds only contracts/one.md,
//             constraints.md (the C-nn ledger), invariants.md and config.json (empty routing)
//   input/    plan.json (two serial units, one declared resource, suite lane `npm test`), each unit's
//             spec.json, and rulings.md
//
// Unit `slug` adds a pure `slugify`. Unit `page-id` adds `pageId`, which imports `slugify`, so it can only
// pass its lane on an integration tip that already holds `slug`: the arc must merge `slug` first and cut
// `page-id` from the advanced tip. Its clause B2 (the empty slug) is the one a careless implementation
// misses, which gives the gate something to grade.
//
// The plan's `rulings` must lie under the plan's directory (SCHEMAS.md choice 12), so input/rulings.md is
// written from the same text as the in-tree ledger; the two are identical by construction.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { INTEGRATION, MAIN, RESOURCE, UNITS, layout } from './layout.ts';

const CONTRACT = `# Contract one: page identifiers

## slugify(text)

\`slugify(text)\` in \`src/slug.js\` returns a string of lowercase ASCII letters, digits and single hyphens:

1. ASCII letters are lowercased.
2. Every maximal run of characters that are not ASCII letters or digits becomes one \`-\`.
3. The result never starts or ends with \`-\`.
4. It is pure: no I/O, no state.

## pageId(title, n)

\`pageId(title, n)\` in \`src/page-id.js\` returns \`<slugify(title)>-<n>\` for a positive integer \`n\`.

- When \`slugify(title)\` is empty, the slug part is \`page\`: \`pageId('!!!', 3)\` is \`page-3\`, never \`-3\`.
- A non-integer or non-positive \`n\` throws a \`RangeError\`.
`;

// The ledger format is fixed by the executor (src/pipeline/stages.ts, RULING_LINE): `C-<n> — <rule>`.
const RULINGS = `# Constraints (C-nn ledger)

C-1 — Every module under src/ is a pure ES module with no runtime dependencies and no I/O.
C-2 — Every exported function is covered by node --test tests under test/, one test file per module.
`;

const INVARIANTS = `# Invariants

- \`npm test\` passes on the integration branch.
- \`package.json\` declares no dependencies.
`;

const ARCHITECTURE = `# Architecture

A tiny library of pure string and number helpers.

- \`src/<module>.js\`: one ES module per concern, exporting pure functions. No dependencies, no I/O.
- \`test/<module>.test.js\`: that module's \`node --test\` tests.
- \`npm test\` runs \`node --test\`, which finds every \`*.test.js\`.
- Page identifiers (\`.roadmap/contracts/one.md\`) are built from \`slugify\`; later modules import it rather than
  re-implementing it.
`;

const PRODUCT: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: 'm1-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  '.gitignore': 'node_modules/\n',
  'ARCHITECTURE.md': ARCHITECTURE,
  'src/text.js': "/** The whitespace-separated words of `s`, in order. */\nexport function words(s) {\n  return s.split(/\\s+/).filter((w) => w !== '');\n}\n",
  'test/text.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { words } from '../src/text.js';\n\ntest('words splits on runs of whitespace', () => {\n  assert.deepEqual(words('  a b\\t\\nc '), ['a', 'b', 'c']);\n  assert.deepEqual(words(''), []);\n});\n",
  'src/numbers.js': '/** `n` limited to the closed range [lo, hi]. */\nexport function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\n',
  'test/numbers.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { clamp } from '../src/numbers.js';\n\ntest('clamp', () => {\n  assert.equal(clamp(5, 0, 3), 3);\n  assert.equal(clamp(-1, 0, 3), 0);\n  assert.equal(clamp(2, 0, 3), 2);\n});\n",
  '.roadmap/contracts/one.md': CONTRACT,
  '.roadmap/constraints.md': RULINGS,
  '.roadmap/invariants.md': INVARIANTS,
  '.roadmap/config.json': `${JSON.stringify({ routing: {} }, null, 2)}\n`,
};

const CONTRACT_PATH = '.roadmap/contracts/one.md';
const SCOPE = ['src/**', 'test/**'];
const PASS_PATH = { set: {}, pass: ['PATH'] };

const fastLane = (id: string, file: string) => ({
  id, argv: ['node', '--test', file], cwd: '.', env: PASS_PATH, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], state: 'active',
});

const clause = (id: string, text: string) => ({ id, clause: text, failLoudIfUndelivered: true, state: 'active' });

const SPECS: Readonly<Record<(typeof UNITS)[number], unknown>> = {
  slug: {
    schema: 'roadmap/spec-m1', unit: 'slug', rev: 1,
    lanes: [fastLane('slug', 'test/slug.test.js')],
    acceptance: [
      clause('A1', `slugify(text) in src/slug.js lowercases ASCII letters and turns every maximal run of characters other than ASCII letters and digits into one '-' (${CONTRACT_PATH}, slugify rules 1 and 2).`),
      clause('A2', `slugify never returns a leading or trailing '-': slugify('  Hello, World!  ') is 'hello-world' (${CONTRACT_PATH}, slugify rule 3).`),
      clause('A3', 'test/slug.test.js covers A1 and A2 and passes under the slug lane (C-2).'),
    ],
    scope: SCOPE, resources: [RESOURCE],
    decisions: [],
    facts: [{ id: 'F1', text: 'package.json declares "type": "module", so src/*.js are ES modules.', state: 'active' }],
    cites: { contracts: [CONTRACT_PATH], rulings: ['C-1', 'C-2'] },
  },
  'page-id': {
    schema: 'roadmap/spec-m1', unit: 'page-id', rev: 1,
    lanes: [fastLane('page-id', 'test/page-id.test.js')],
    acceptance: [
      clause('B1', `pageId(title, n) in src/page-id.js returns slugify(title) + '-' + n, importing slugify from src/slug.js rather than re-implementing it (${CONTRACT_PATH}, pageId).`),
      clause('B2', `When slugify(title) is empty the slug part is 'page': pageId('!!!', 3) is 'page-3', never '-3' (${CONTRACT_PATH}, pageId).`),
      clause('B3', `A non-integer or non-positive n throws a RangeError (${CONTRACT_PATH}, pageId).`),
      clause('B4', 'test/page-id.test.js covers B1, B2 and B3 and passes under the page-id lane (C-2).'),
    ],
    scope: SCOPE, resources: [RESOURCE],
    decisions: [],
    facts: [{ id: 'F1', text: 'slugify is exported by src/slug.js once unit slug has merged.', state: 'active' }],
    cites: { contracts: [CONTRACT_PATH], rulings: ['C-1', 'C-2'] },
  },
};

/**
 * The resource `scratch`: a state dir. The probe answers the PROBE_EXIT contract from an owner file
 * (absent: free; our label: 10; anyone else's: 11); the teardown removes the owner file and the scratch dir.
 */
function resourceDecl(stateDir: string) {
  const probe = 'f="$1/scratch.owner"; [ -e "$f" ] || exit 0; [ "$(cat "$f")" = "$RESOURCE_OWNER" ] && exit 10; exit 11';
  const teardown = 'rm -f "$1/scratch.owner" && rm -rf "$1/scratch"';
  return {
    name: RESOURCE,
    probe: { argv: ['/bin/sh', '-c', probe, 'probe', stateDir], cwd: '.', env: PASS_PATH },
    teardown: { argv: ['/bin/sh', '-c', teardown, 'teardown', stateDir], cwd: '.', env: PASS_PATH },
  };
}

// Isolated from the user's global and system git config (hooks, signing, templates), so the fixture repo
// is the same on every machine. The repo-local identity below is what implementers commit with.
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

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function setup(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`fixture dir ${dir} is not empty`);
  const l = layout(dir);
  mkdirSync(l.worktrees, { recursive: true });
  mkdirSync(l.resource, { recursive: true });

  mkdirSync(l.repo, { recursive: true });
  git(l.repo, '-c', `init.defaultBranch=${MAIN}`, 'init', '--quiet');
  git(l.repo, 'config', 'user.name', 'M1 Fixture');
  git(l.repo, 'config', 'user.email', 'm1-fixture@example.invalid');
  git(l.repo, 'config', 'commit.gpgsign', 'false');
  for (const [path, text] of Object.entries(PRODUCT)) write(join(l.repo, path), text);
  git(l.repo, 'add', '--all');
  git(l.repo, 'commit', '--quiet', '--message', 'm1 fixture: initial product');
  git(l.repo, 'branch', INTEGRATION, MAIN);
  const baseline = git(l.repo, 'rev-parse', MAIN);

  write(join(l.input, 'rulings.md'), RULINGS);
  for (const unit of UNITS) write(join(l.input, `${unit}.json`), json(SPECS[unit]));
  write(l.plan, json({
    schema: 'roadmap/plan-m1',
    arc: l.arc,
    integrationBranch: INTEGRATION,
    baseline,
    worktreeRoot: l.worktrees,
    contracts: [CONTRACT_PATH],
    rulings: 'rulings.md',
    architectureDoc: 'ARCHITECTURE.md',
    direction: 'Grow a small page-identifier library one pure function at a time. Every module stays dependency-free and fully tested, and later modules build on earlier ones instead of duplicating them.',
    suite: {
      lanes: [{
        id: 'suite', argv: ['npm', 'test'], cwd: '.', env: { set: { npm_config_update_notifier: 'false' }, pass: ['PATH', 'HOME'] },
        expectedExit: 0, tier: 'estate', resources: [], evidenceGlobs: [],
      }],
    },
    resources: [resourceDecl(l.resource)],
    units: UNITS.map((id) => ({ id, spec: `${id}.json`, risk: 'med', scope: SCOPE, resources: [RESOURCE] })),
  }));
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (dir === undefined) throw new Error('usage: node evals/m1/setup.ts <dir>');
  const abs = resolve(dir);
  setup(abs);
  process.stdout.write(`${JSON.stringify({ fixture: abs, plan: layout(abs).plan, repo: layout(abs).repo })}\n`);
}
