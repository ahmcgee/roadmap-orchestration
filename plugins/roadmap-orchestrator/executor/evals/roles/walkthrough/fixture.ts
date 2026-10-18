// One walkthrough trial's fixture: the cell's product (product.ts) committed to a scratch repository, the milestone the
// walk is of (its bring-up, its nine journeys, its design reference `design/`), the vision with experience clauses, the
// milestone's merged unit specs, and the answer key, which only the eval run dir holds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { journeyId, milestoneId, serveName, specRev, unitId, visionClauseId } from '../../../src/core/ids.ts';
import { repoPath } from '../../../src/core/values.ts';
import type { VisionClause } from '../../../src/holistic/types.ts';
import type { Journey, Milestone } from '../../../src/input/plan.ts';
import type { RenderedSpec, VisionInput } from '../../../src/prompts/inputs.ts';
import { spawnSync } from 'node:child_process';
import { FAMILIES, type Expected, type FamilyId, type Position, type SlotState } from './families.ts';
import { type FileMap, type SeedData, productFiles, seedData } from './product.ts';
import { assignSlots } from './slots.ts';

export type WalkCell = Readonly<{
  id: string;
  /** The product's seed: its data and its slot assignment. */
  seed: string;
  /** The families carrying their plant; every other family carries its twin. */
  planted: readonly FamilyId[];
}>;

export type SlotKey = Readonly<{
  family: FamilyId;
  state: SlotState;
  expected: Expected;
  at: Position;
  what: string;
  journeys: readonly string[];
  files: readonly string[];
  markers: readonly string[];
  exercise: readonly string[];
}>;

export type WalkKey = Readonly<{ cell: string; seed: string; trial: number; sha: string; slots: readonly SlotKey[] }>;

export type WalkFixture = Readonly<{
  cell: WalkCell;
  data: SeedData;
  files: FileMap;
  milestone: Milestone;
  vision: VisionInput;
  units: readonly RenderedSpec[];
  slots: readonly SlotKey[];
}>;

/** The design reference directory: every milestone reference the walk reads. */
export const REFERENCE = 'design';
/** The serve entry's name and the data directory the bring-up uses (beside the README's own `.ledgerly`). */
export const SERVE = 'web';
const DATA = 'var/ledger';
const ADDRESS = `http://127.0.0.1:{port:${SERVE}}`;

const journey = (n: number, text: string, via: Journey['via'], entry: string, steps: number, seconds: number): Journey =>
  ({ id: journeyId(`J-${n}`), text, via, entry, budget: { steps, seconds } });

export function milestoneOf(data: SeedData): Milestone {
  return {
    id: milestoneId('MS-1'),
    text: 'A platform team can record its spend, watch its monthly limits and print its statements from the dashboard, import and script it '
      + 'from the CLI, record it from other tools through the HTTP API, configure its teams in one file, and run the project\'s CI locally '
      + 'before pushing; a newcomer gets there from the README.',
    units: ['u-web', 'u-cli', 'u-api', 'u-config', 'u-ci'].map((u) => unitId(u)),
    design: { unit: unitId('u-design') },
    references: [repoPath(REFERENCE)],
    bringUp: {
      setup: [['node', 'bin/ledgerly.js', 'init', '--data', DATA]],
      serve: [{ name: serveName(SERVE), argv: ['node', 'server/main.js'], ready: { http: `${ADDRESS}/healthz` } }],
      env: { LEDGERLY_PORT: `{port:${SERVE}}`, LEDGERLY_DATA: DATA, LEDGERLY_API_TOKEN: 'walk-token' },
      seed: [data.prev, data.month].map((m) => ['node', 'bin/ledgerly.js', 'import', `samples/${m}.csv`, '--data', DATA]),
    },
    journeys: [
      journey(1, 'Record a payment for your team in the dashboard and find it in the ledger', 'browser', `${ADDRESS}/entries`, 6, 90),
      journey(2, "Check a team's budget in the dashboard and change its monthly limit", 'browser', `${ADDRESS}/budgets`, 5, 60),
      journey(3, "Open last month's statement in the dashboard and get a printable copy", 'browser', `${ADDRESS}/statements`, 3, 45),
      journey(4, 'Import a month of spend from a CSV file with the CLI, including a file with a mistake in it', 'shell', `node bin/ledgerly.js import --data ${DATA}`, 4, 120),
      journey(5, "Get a team's monthly total from the CLI as JSON a script can use", 'shell', `node bin/ledgerly.js report --data ${DATA}`, 3, 60),
      journey(6, 'Record an entry through the HTTP API and list it back, as another tool would', 'shell', `${ADDRESS}/api/v1`, 4, 120),
      journey(7, 'Add a team to ledgerly.conf by hand and check the file', 'shell', 'ledgerly.conf', 3, 120),
      journey(8, 'Run the CI pipeline locally, break a test on purpose and find what to fix from its output', 'shell', 'node ci/run.js', 4, 180),
      journey(9, 'Follow the README quickstart from a fresh copy of the repository', 'shell', 'README.md', 4, 120),
    ],
    resources: [],
  };
}

const clause = (n: number, kind: VisionClause['kind'], text: string): VisionClause => ({ id: visionClauseId(`V-${n}`), kind, text, rank: null, state: 'active' });

export const VISION: VisionInput = {
  rev: 1,
  clauses: [
    clause(1, 'world', 'Platform teams record what they pay their vendors in ledgerly and see it against a monthly limit per team.'),
    clause(2, 'purpose', 'A team lead knows where the team stands against its limit without asking finance.'),
    clause(3, 'serves', 'Engineering leads and platform engineers, who are not accountants and visit a few times a month.'),
    clause(4, 'experience', 'Recording a payment takes under a minute and never loses what was typed.'),
    clause(5, 'experience', 'Every error says what went wrong and how to fix it, in the product\'s own voice.'),
    clause(6, 'experience', 'Everything works by keyboard alone and meets WCAG 2.2 AA.'),
    clause(7, 'experience', 'Scripts and other tools can rely on ledgerly: stable JSON, honest exit codes, results on stdout, one error format.'),
    clause(8, 'non-negotiable', 'Nothing fails silently: nothing typed, imported or configured is dropped or ignored without saying so.'),
  ],
  questions: [],
  advances: [visionClauseId('V-4'), visionClauseId('V-5'), visionClauseId('V-6'), visionClauseId('V-7')],
};

const spec = (unit: string, markdown: string): RenderedSpec => ({ unit: unitId(unit), rev: specRev(1), markdown });

/** The milestone's merged units, as their specs render. */
export const UNITS: readonly RenderedSpec[] = [
  spec('u-web', '# u-web: the dashboard\n\nScope: `web/**`, `server/main.js`.\n\nThe server-rendered dashboard to `design/DESIGN.md` and `design/tokens.css`: overview, entries, recording an entry, budgets and changing a limit, statements and their print views.\n\nAcceptance: the three flows of DESIGN.md "Flows and their budgets" complete within their budgets, by mouse and by keyboard, at 1280 and 390 px.'),
  spec('u-cli', '# u-cli: the CLI\n\nScope: `bin/**`, `src/**`.\n\n`init`, `import`, `report` and `config check` to `design/cli.md`.\n\nAcceptance: the golden transcripts in design/cli.md; streams and exit codes as its table says.'),
  spec('u-api', '# u-api: the HTTP API\n\nScope: `server/api.js`.\n\n`/api/v1` to `design/api.md`.\n\nAcceptance: the example sessions in design/api.md run as shown; every error is a problem document of a listed type.'),
  spec('u-config', '# u-config: ledgerly.conf\n\nScope: `src/config.js`, `ledgerly.conf`.\n\nThe configuration file to `design/config.md`.\n\nAcceptance: every mistake in design/config.md "Mistakes" is reported as described.'),
  spec('u-ci', '# u-ci: CI and the README\n\nScope: `ci/**`, `README.md`.\n\nThe pipeline and its local runner to `design/ci.md`; the README quickstart.\n\nAcceptance: `node ci/run.js` matches CI; a failure reports as design/ci.md "Output" says; the quickstart runs as written from a fresh checkout.'),
];

/** The fixture of `cell`: the same for every trial of the cell (the trial only numbers the key). */
export function buildWalkFixture(cell: WalkCell): WalkFixture {
  const data = seedData(cell.seed);
  const slots = assignSlots(cell.seed, cell.planted);
  const files = productFiles(data, slots);
  const keys = slots.map((s): SlotKey => {
    const f = FAMILIES[s.family];
    return { family: s.family, state: s.state, expected: f.expected, at: s.at, what: s.state === 'plant' ? f.plant : f.twin, ...f.locus(s.state, s.at) };
  });
  return { cell, data, files, milestone: milestoneOf(data), vision: VISION, units: UNITS, slots: keys };
}

/** A fixed identity and date, and no user or system git config: the same cell commits the same sha on every host. */
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ledgerly Team', GIT_AUTHOR_EMAIL: 'team@ledgerly.dev', GIT_AUTHOR_DATE: '2026-10-01T09:00:00Z',
  GIT_COMMITTER_NAME: 'Ledgerly Team', GIT_COMMITTER_EMAIL: 'team@ledgerly.dev', GIT_COMMITTER_DATE: '2026-10-01T09:00:00Z',
};

export function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${repo} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Writes the product into a fresh repository at `repo` and commits it; returns the commit (the same for the same cell). */
export function materialise(f: WalkFixture, repo: string): string {
  git(repo, 'init', '--quiet', '--initial-branch', 'main');
  for (const [path, text] of f.files) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--no-gpg-sign', '-m', 'ledgerly 0.4.0');
  return git(repo, 'rev-parse', 'HEAD');
}
