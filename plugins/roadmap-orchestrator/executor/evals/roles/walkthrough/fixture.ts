// One walkthrough trial's fixture: the cell's product (product.ts), the milestone the walk is of (its bring-up, its nine
// journeys, its design reference `design/`, owner-supplied), the vision with experience clauses, the one unit whose merge
// reaches the milestone (u1, its spec stating what the milestone's surfaces deliver), this repository's walkthrough MCP
// config, and the answer key, which only the eval run dir holds.
import { journeyId, milestoneId, serveName, unitId } from '../../../src/core/ids.ts';
import { repoPath } from '../../../src/core/values.ts';
import type { Journey, Milestone } from '../../../src/input/plan.ts';
import { type RepoConfig, parseRepoConfig } from '../../../src/routing/layers.ts';
import { FAMILIES, type Expected, type Family, type FamilyId, type FamilyTable, type Position, type SlotState } from './families.ts';
import { type FileMap, type SeedData, productFiles, seedData } from './product.ts';
import { assignSlots } from './slots.ts';

export type WalkCell = Readonly<{
  id: string;
  /** The product's seed: its data and its slot assignment. */
  seed: string;
  /** The families carrying their plant; every other family carries its twin. */
  planted: readonly FamilyId[];
  /**
   * Families in another form than their dev one (families.ts): each its own plant, twin, positions, contributions and
   * locus, of the same id and expected class. The holdout set's cells carry theirs; a family absent here takes its dev form.
   */
  forms?: Readonly<Partial<Record<FamilyId, Family>>>;
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
  slots: readonly SlotKey[];
}>;

/** The design reference directory: the milestone's one reference. */
export const REFERENCE = 'design';
/** The serve entry's name and the data directory the bring-up uses (beside the README's own `.ledgerly`). */
export const SERVE = 'web';
/** The unit whose merge reaches the milestone. */
export const MILESTONE_UNIT = 'u1';
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
    units: [unitId(MILESTONE_UNIT)],
    design: { supplied: true },
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

/** The vision (roadmap/vision-m3), with experience clauses; the plan advances V-1 and V-4 to V-7. */
export const VISION_JSON = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null,
  clauses: [
    { id: 'V-1', kind: 'world', text: 'Platform teams record what they pay their vendors in ledgerly and see it against a monthly limit per team.' },
    { id: 'V-2', kind: 'purpose', text: 'A team lead knows where the team stands against its limit without asking finance.' },
    { id: 'V-3', kind: 'serves', text: 'Engineering leads and platform engineers, who are not accountants and visit a few times a month.' },
    { id: 'V-4', kind: 'experience', text: 'Recording a payment takes under a minute and never loses what was typed.' },
    { id: 'V-5', kind: 'experience', text: 'Every error says what went wrong and how to fix it, in the product\'s own voice.' },
    { id: 'V-6', kind: 'experience', text: 'Everything works by keyboard alone and meets WCAG 2.2 AA.' },
    { id: 'V-7', kind: 'experience', text: 'Scripts and other tools can rely on ledgerly: stable JSON, honest exit codes, results on stdout, one error format.' },
    { id: 'V-8', kind: 'non-negotiable', text: 'Nothing fails silently: nothing typed, imported or configured is dropped or ignored without saying so.' },
  ].map((c) => ({ ...c, rank: null, state: 'active' })),
  questions: [],
} as const;
// V-1 too: a revision requires the advances to name an active world clause (src/holistic/vision.ts `advancesReasons`; the polish revision is one).
export const ADVANCES = ['V-1', 'V-4', 'V-5', 'V-6', 'V-7'] as const;

/** u1's acceptance: what the milestone's surfaces deliver, each to its design reference (rendered into the walk's inputs). */
export const UNIT_ACCEPTANCE: readonly string[] = [
  'The dashboard (web/, server/main.js) follows design/DESIGN.md and design/tokens.css; the three flows of DESIGN.md "Flows and their budgets" complete within their budgets, by mouse and by keyboard, at 1280 and 390 px.',
  'The CLI (bin/, src/) follows design/cli.md: its golden transcripts, streams and exit codes.',
  'The HTTP API (server/api.js) follows design/api.md: its example sessions run as shown; every error is a problem document of a listed type.',
  'ledgerly.conf (src/config.js) reports every mistake as design/config.md "Mistakes" describes.',
  'node ci/run.js runs the steps CI runs and reports a failure as design/ci.md "Output" says; the README quickstart runs as written from a fresh checkout.',
];

/** The release note u1's build commits: the change whose merge reaches the milestone. */
export const RELEASE_NOTE = { 'CHANGELOG.md': '# Changelog\n\n## 0.4.0\n\nThe dashboard, CLI, HTTP API, configuration file and local CI runner, to the design reference in design/.\n' } as const;

/**
 * This repository's walkthrough MCP config (SCHEMAS.md "dev.13", "Repo config"; the devcontainer installs the server and
 * Playwright's Chromium, edd2f51): Playwright MCP, headless, isolated, on Chromium (only Playwright's Chromium is
 * installed; the server defaults to the Chrome channel), screenshots into the evidence dir. Pages are served over HTTP:
 * the server refuses file: URLs.
 */
export const WALK_MCP = {
  playwright: { command: 'playwright-mcp', args: ['--headless', '--isolated', '--browser', 'chromium', '--output-dir', '{evidence}', '--viewport-size', '{viewport}'] },
} as const;

/** The trial arc's repo config: the walkthrough MCP servers, with `--rebind`'s class bindings. */
export function walkRepoConfig(rebind: RepoConfig | null): RepoConfig {
  return parseRepoConfig({ walkthrough: { mcp: WALK_MCP }, ...(rebind?.routing?.classes === undefined ? {} : { routing: { classes: rebind.routing.classes } }) } as never);
}

/** The families of `cell`: its forms over the dev ones; a form of another id or expected class fails loud. */
export function familiesOf(cell: WalkCell): FamilyTable {
  const out: Record<FamilyId, Family> = { ...FAMILIES };
  for (const [id, f] of Object.entries(cell.forms ?? {}) as [FamilyId, Family][]) {
    if (f.id !== id) throw new Error(`${cell.id}: the form given for ${id} is ${f.id}'s`);
    if (f.expected !== FAMILIES[id].expected) throw new Error(`${cell.id}: ${id}'s form expects ${f.expected}, the family ${FAMILIES[id].expected}`);
    out[id] = f;
  }
  return out;
}

/** The fixture of `cell`: the same for every trial of the cell. */
export function buildWalkFixture(cell: WalkCell): WalkFixture {
  const data = seedData(cell.seed);
  const families = familiesOf(cell);
  const slots = assignSlots(cell.seed, cell.planted, families);
  const files = productFiles(data, slots, families);
  const keys = slots.map((s): SlotKey => {
    const f = families[s.family];
    return { family: s.family, state: s.state, expected: f.expected, at: s.at, what: s.state === 'plant' ? f.plant : f.twin, ...f.locus(s.state, s.at) };
  });
  return { cell, data, files, milestone: milestoneOf(data), slots: keys };
}
