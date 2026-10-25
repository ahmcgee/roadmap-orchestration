// The M5 paid fixture, step 1: `node evals/m5/setup.ts <dir>` lays out a fresh fixture in `<dir>` (absent or empty;
// anything else is refused) outside this repository (layout.ts, M4a's layout):
//
//   stage/product/    the scratch product `swapshelf` (files/product/): the page for a street's book swap shelf, a
//                     zero-dependency Node 24 HTTP server rendering its pages on the server (src/server.js, pages.js,
//                     store.js over data/shelf.json, whose first book carries the plant: layout.ts PLANT, a condition
//                     ending in an unbreakable URL), its stylesheet public/style.css, `node --test` tests, and its
//                     design record under docs/corpus/: the shelf's page (reserving, the browser milestone), the
//                     keeper's tools (a CLI and a settings file on top, the shell milestone), how it is built, and the
//                     vision document vision.md, curated (rules blocks with T-ids) and confirmed. In-tree
//                     `.roadmap/`: the corpus guide, the
//                     confirmed `vision.json` (V-1..V-13, five of them experience standards) and `config.json` naming
//                     the Playwright MCP server as `walkthrough.mcp` (no `chain`: K is asked at bootstrap).
//                     `.claude/skills/frontend-design/`: Anthropic's frontend-design skill vendored with its licences,
//                     so builds, gates and walks in unit worktrees load it. One commit on `main`, pushed to the origin.
//   stage/origin.git  the bare origin (`roadmap pr` pushes the arc branch here; `main` is never pushed again)
//   stage/forge/      the fake forge: no PRs
//   stage/config/     empty GH_CONFIG_DIR and XDG_CONFIG_HOME, and a gitconfig with the fixture identity only
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sha256Hex } from '../../src/core/json.ts';
import type { VisionClauseKind } from '../../src/holistic/types.ts';
import type { GhStore } from '../../test/fakes/gh-store.ts';
import { filesOf } from '../m4a/golden.ts';
import { git, json, writeForge } from '../m4a/setup.ts';
import { CORPUS_ROOT, FILES, FORGE_REPO, type Layout, MAIN, VISION_DOC, layout } from './layout.ts';

/** `<dir>/seed.json`: the seed commit origin's `main` must still be at after the run. */
export const SEED_FILE = 'seed.json';
export const FIXTURE_IDENTITY = { name: 'Swapshelf Fixture', email: 'swapshelf-fixture@example.invalid' } as const;

type Clause = Readonly<{ id: string; kind: VisionClauseKind; text: string; rank: number | null }>;

/** The compiled clauses of files/product/docs/corpus/vision.md, one per `{V-n}` anchor. */
export const CLAUSES: readonly Clause[] = [
  { id: 'V-1', kind: 'world', rank: null, text: 'A neighbour finds the book she wants on the shelf\'s page the night before, puts her first name on it, is told to collect it by Sunday at six, and finds it waiting on the shelf in the morning.' },
  { id: 'V-2', kind: 'world', rank: null, text: 'The keeper adds a box of donated books from his laptop in a few minutes, sets the week\'s collection hours, marks a collected book in one command, and the page shows it all.' },
  { id: 'V-3', kind: 'purpose', rank: null, text: 'Books go to the neighbours who want them instead of the recycling bin, and the shelf stays small enough for one person to keep in a few minutes a week.' },
  { id: 'V-4', kind: 'serves', rank: null, text: 'Neighbours on and around Oak Street who pass the shelf; not book dealers, and nobody outside walking distance.' },
  { id: 'V-5', kind: 'good', rank: null, text: 'A neighbour who has never used the page reserves a book on their phone in under a minute.' },
  { id: 'V-6', kind: 'good', rank: null, text: 'The keeper adds a box of ten books in under five minutes.' },
  { id: 'V-7', kind: 'non-negotiable', rank: null, text: 'A book is never promised to two neighbours at once.' },
  { id: 'V-8', kind: 'tradeoff', rank: 1, text: 'Plain and readable over clever.' },
  { id: 'V-9', kind: 'experience', rank: null, text: 'A neighbour reserves a book in at most three steps from the shelf\'s page, and the last one tells them where to collect it and by when.' },
  { id: 'V-10', kind: 'experience', rank: null, text: 'The page works on a phone outdoors in daylight, with a keyboard alone and with a screen reader, to the WCAG AA level.' },
  { id: 'V-11', kind: 'experience', rank: null, text: 'The page feels like the hand-lettered shelf itself, never like a generic template or an app store.' },
  { id: 'V-12', kind: 'experience', rank: null, text: 'Every error, on the page or in the keeper\'s tools, says what went wrong and what to do next.' },
  { id: 'V-13', kind: 'experience', rank: null, text: 'The keeper learns the keeper\'s tools from their own help text in five minutes, without reading code.' },
];

export function visionRecord(visionText: string): unknown {
  return {
    schema: 'roadmap/vision-m3',
    rev: 1,
    confirmation: { ref: `corpus:${VISION_DOC}#sha256:${sha256Hex(visionText)}`, at: '2026-10-18T09:00:00.000Z' },
    clauses: CLAUSES.map((c) => ({ ...c, state: 'active' })),
    questions: [],
  };
}

/** The fake forge's initial store: no PRs. */
export function forgeStore(l: Layout): GhStore {
  return { repo: { ...FORGE_REPO }, originPath: l.origin, nextNumber: 1, pulls: [], mutations: [] };
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { flag: 'wx' });
}

export function setup(dir: string): Layout {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`fixture dir ${dir} is not empty: a fixture dir is set up and run once`);
  const l = layout(dir);
  for (const d of [l.product, l.ghConfig, l.xdgConfig, l.inputs, l.worktrees]) mkdirSync(d, { recursive: true });
  write(l.gitConfig, `[user]\n\tname = ${FIXTURE_IDENTITY.name}\n\temail = ${FIXTURE_IDENTITY.email}\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = ${MAIN}\n`);
  for (const [path, text] of Object.entries(filesOf(join(FILES, 'product')))) write(join(l.product, path), text);
  const visionText = readFileSync(join(l.product, CORPUS_ROOT, VISION_DOC), 'utf8');
  write(join(l.product, '.roadmap', 'vision.json'), json(visionRecord(visionText)));
  git(l.product, '-c', `init.defaultBranch=${MAIN}`, 'init', '--quiet');
  git(l.product, 'config', 'user.name', FIXTURE_IDENTITY.name);
  git(l.product, 'config', 'user.email', FIXTURE_IDENTITY.email);
  git(l.product, 'config', 'commit.gpgsign', 'false');
  git(l.product, 'add', '--all');
  git(l.product, 'commit', '--quiet', '--message', 'swapshelf: the shelf\'s page, its design record and the frontend-design skill');
  git(dirname(l.origin), 'init', '--quiet', '--bare', l.origin);
  git(l.product, 'remote', 'add', 'origin', l.origin);
  git(l.product, 'push', '--quiet', 'origin', `${MAIN}:refs/heads/${MAIN}`);
  writeForge(l, forgeStore(l));
  writeFileSync(join(dir, SEED_FILE), json({ main: git(l.product, 'rev-parse', MAIN) }), { flag: 'wx' });
  return l;
}

if (import.meta.main) {
  const [dir, ...rest] = process.argv.slice(2);
  if (dir === undefined || rest.length > 0) throw new Error('usage: node evals/m5/setup.ts <dir>');
  const l = setup(resolve(dir));
  process.stdout.write(`${JSON.stringify({ fixture: l.dir, product: l.product })}\n`);
}
