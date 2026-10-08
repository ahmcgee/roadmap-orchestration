// A corpus arc for tests (M4a step C1): a product repo whose baseline commit holds the sample corpus (test/helpers/
// corpus.ts) under `docs/corpus`, its guide, `.roadmap/vision.json` (confirmed against the vision doc) and
// `.roadmap/config.json`; and a plan dir beside it with plan.json (target corpus), a spec, the ledger, rule-anchored
// obligations with their census, the pin (`roadmap corpus pin` at the baseline), the issue capture (`roadmap issues
// --out` against a fake forge) and the Phase-0 record naming it. `phase0Check` over it is green. Tests then edit the
// files (`edit*`), commit between arcs (`betweenArc`), put the arc in force (`inForce`) or seal it with a terminal
// snapshot (`seal`), and chain the next arc onto it (`nextArc`).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureIssues } from '../../src/commands/issues.ts';
import { corpusPin } from '../../src/commands/corpus.ts';
import { phase0Check } from '../../src/commands/phase0.ts';
import { type ArcId, type Sha, arcId, sha } from '../../src/core/ids.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { type OpenJournal, openJournal } from '../../src/core/log.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import type { CorpusPin } from '../../src/corpus/types.ts';
import { laneRevOf, parseObligations } from '../../src/holistic/types.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { snapshotRequestOf } from '../../src/git/snapshot.ts';
import { openHostDir } from '../../src/host/hostdir.ts';
import { runDir as runDirOf } from '../../src/input/cli.ts';
import { type InputFiles, keepCorpusFiles, readInputFiles, recordPlan } from '../../src/input/inforce.ts';
import { executorIdentity } from '../../src/pipeline/stages.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../../src/phase0/rows.ts';
import type { StartupRejection } from '../../src/preflight/startup.ts';
import { snapshotPublishOp } from '../../src/recover/ops.ts';
import { runOp } from '../fixtures/git-common.ts';
import { type BuiltCorpus, DEFAULT_CORPUS_ROOT, sampleCorpus } from './corpus.ts';
import { type Forge, makeForge } from './forge.ts';
import { commitAll, git, makeRepo, tmpDir, writeFiles } from './repo.ts';

type Json = Record<string, unknown>;

export const VISION_DOC = '0005_Vision.md';
export const PIN_FILE = 'corpus.pin.json';
export const PHASE0_FILE = 'phase0.json';
export const CAPTURE_FILE = 'issues.json';

/** The vision record: V-1 a world clause the arc advances, V-2 a purpose; confirmed against `visionText` unless `confirmed` is false. */
export function visionRecord(visionText: string | null): Json {
  return {
    schema: 'roadmap/vision-m3', rev: 1,
    confirmation: visionText === null ? null : { ref: `corpus:${VISION_DOC}#sha256:${sha256Hex(visionText)}`, at: '2026-10-01T00:00:00.000Z' },
    clauses: [
      { id: 'V-1', kind: 'world', text: 'Every vessel finds a berth.', rank: null, state: 'active' },
      { id: 'V-2', kind: 'purpose', text: 'A calm harbour.', rank: null, state: 'active' },
    ],
    questions: [],
  };
}

const lane = (id: string): Json => ({ id, argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [] });
const arcLane = { ...lane('journey'), reporter: 'jsonl' };
/** The journey lane's revision as the reader computes it (over the lane with its defaults filled in). */
const LANE_REV = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [arcLane], obligations: [], mapping: { paths: [] } }).lanes[0]!);

/** The obligations file: I-1 anchored at T-1 (`activation`), and a census over T-1..T-3 (T-2 out of slice, T-3 untestable). */
export function obligationsFile(pin: CorpusPin, opts: Readonly<{ activation?: 'must-hold' | 'future'; census?: readonly Json[] }> = {}): Json {
  const t1 = pin.rules.find((r) => r.id === 'T-1');
  assert.ok(t1 !== undefined, 'the sample corpus pins T-1');
  const witness = { lane: 'journey', testIds: ['t1'] };
  return {
    schema: 'roadmap/obligations-m3', cutLine: 'the berth booking ships', lanes: [arcLane],
    obligations: [{
      id: 'I-1', rev: 1, statement: 'A berth is never double-booked.', rule: { id: 'T-1', textSha256: t1.textSha256 }, serves: ['V-1'], witness,
      proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV, witness }, deliveredBy: opts.activation === 'future' ? ['u1'] : [],
      activation: opts.activation ?? 'must-hold', contracts: [], state: { type: 'active' },
    }],
    mapping: { paths: [] },
    census: opts.census ?? [
      { rule: 'T-1', state: { type: 'obligation', id: 'I-1' } }, { rule: 'T-2', state: { type: 'out-of-slice' } }, { rule: 'T-3', state: { type: 'untestable' } },
    ],
  };
}

export type CorpusArc = Readonly<{
  arc: ArcId;
  repo: AbsPath;
  planDir: string;
  planPath: AbsPath;
  forge: Forge;
  corpus: BuiltCorpus;
}>;

export type CorpusArcOptions = Readonly<{
  arc?: string;
  /** An existing repo (a chained arc's): its HEAD is the baseline. */
  repo?: AbsPath;
  forge?: Forge;
  /** Extra plan fields (e.g. `chain`), and a unit scope other than `src/**`. */
  plan?: Json;
  scope?: readonly string[];
  /** `.roadmap/config.json` (default `{chain: {k: 1}}`; null: none). */
  config?: Json | null;
  /** Extra baseline files for a fresh repo. */
  files?: Readonly<Record<string, string>>;
  activation?: 'must-hold' | 'future';
}>;

/** Runs `fn` with `forge`'s fake gh first on PATH (gh runs with the process env). */
export async function withForge<T>(forge: Forge, fn: () => Promise<T> | T): Promise<T> {
  const before = process.env['PATH'];
  process.env['PATH'] = forge.path;
  try {
    return await fn();
  } finally {
    process.env['PATH'] = before;
  }
}

/** A fresh corpus arc (or the next one in `opts.repo`), green under `phase0 check`. */
export async function corpusArc(opts: CorpusArcOptions = {}): Promise<CorpusArc> {
  const corpus = sampleCorpus();
  const visionText = corpus.files[`${DEFAULT_CORPUS_ROOT}/${VISION_DOC}`]!;
  const roadmap = {
    '.roadmap/vision.json': `${JSON.stringify(visionRecord(visionText), null, 2)}\n`,
    ...(opts.config === null ? {} : { '.roadmap/config.json': `${JSON.stringify(opts.config ?? { chain: { k: 1 } })}\n` }),
  };
  let repo: AbsPath;
  if (opts.repo === undefined) {
    repo = absPath(makeRepo(tmpDir('c1-repo'), { files: { 'README.md': 'harbour\n', 'src/berths.ts': 'export {};\n', ...corpus.files, ...roadmap, ...opts.files } }));
  } else repo = opts.repo;
  const baseline = git(repo, 'rev-parse', 'HEAD');
  const forge = opts.forge ?? makeForge();
  if (opts.forge === undefined) forge.addIssue({ title: 'A berth was double-booked', labels: ['roadmap:bug'], body: 'twice', association: 'OWNER', author: 'tidewater' });
  const planDir = tmpDir('c1-plan');
  const arc = arcId(opts.arc ?? 'arc-1');
  const out = absPath(join(planDir, PIN_FILE));
  const pinned = await corpusPin({ repo, commit: baseline, baseline: sha(baseline), out });
  assert.equal(pinned.kind, 'pinned', JSON.stringify(pinned));
  if (pinned.kind !== 'pinned') throw new Error('unreachable');
  const captured = await withForge(forge, () => captureIssues({ repo, out: absPath(join(planDir, CAPTURE_FILE)) }));
  assert.equal(captured.kind, 'captured');
  if (captured.kind !== 'captured') throw new Error('unreachable');
  writeFileSync(join(planDir, 'u1.json'), JSON.stringify({
    schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [{ ...lane('unit'), state: 'active' }],
    acceptance: [{ id: 'A1', clause: 'It works.', failLoudIfUndelivered: true, state: 'active' }],
    scope: opts.scope ?? ['src/**'], resources: [], decisions: [], facts: [], cites: { contracts: [], rulings: [] }, obligations: ['I-1'],
  }));
  writeFileSync(join(planDir, 'rulings.md'), '# Rulings\n\nC-1 — Helpers live in src/.\n');
  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(obligationsFile(pinned.pin, { activation: opts.activation ?? 'must-hold' })));
  writePhase0(planDir, {
    issueCapture: { file: CAPTURE_FILE, sha256: captured.sha256 },
    intake: captured.capture.issues.map((i) => ({ issue: i.id, outcome: { type: 'none', reason: 'tracked already' } })),
  });
  const planPath = absPath(join(planDir, 'plan.json'));
  writeFileSync(planPath, JSON.stringify({
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline, worktreeRoot: tmpDir('c1-wt'), contracts: [], rulings: 'rulings.md',
    direction: 'berth booking', suite: { lanes: [lane('suite')] }, resources: [],
    units: [{ id: 'u1', spec: 'u1.json', risk: 'low', scope: opts.scope ?? ['src/**'], resources: [] }],
    corpus: PIN_FILE, phase0: PHASE0_FILE, holistic: { advances: ['V-1'], obligations: 'obligations.json' },
    ...opts.plan,
  }));
  return { arc, repo, planDir, planPath, forge, corpus };
}

/** Writes the Phase-0 record with `over` on a minimal one. */
export function writePhase0(planDir: string, over: Json): void {
  writeFileSync(join(planDir, PHASE0_FILE), JSON.stringify({
    schema: 'roadmap/phase0-m4', curation: [], corpusDivergences: [], questions: [], debt: [], amendments: [],
    issueCapture: { file: CAPTURE_FILE, sha256: '0'.repeat(64) }, intake: [], slice: { advances: ['V-1'], why: 'the first slice' }, ...over,
  }));
}

export const readJsonFile = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
export const editJsonFile = (path: string, edit: (j: Json) => Json): void => writeFileSync(path, JSON.stringify(edit(readJsonFile(path))));
export const phase0Of = (a: CorpusArc): Json => readJsonFile(join(a.planDir, PHASE0_FILE));
export const editPhase0 = (a: CorpusArc, edit: (j: Json) => Json): void => editJsonFile(join(a.planDir, PHASE0_FILE), edit);
export const editPlan = (a: CorpusArc, edit: (j: Json) => Json): void => editJsonFile(a.planPath, edit);

/** `phase0 check --plan` over the arc, with its forge on PATH. */
export async function check(a: CorpusArc): Promise<Awaited<ReturnType<typeof phase0Check>>> {
  return withForge(a.forge, () => phase0Check({ repo: a.repo, source: { type: 'plan', plan: a.planPath } }));
}

/** The kinds of `rows`, and the problems of the first row of `kind`. */
export const kinds = (rows: readonly StartupRejection[]): readonly string[] => rows.map((r) => r.kind);
export function rowOf<K extends StartupRejection['kind']>(rows: readonly StartupRejection[], kind: K): Extract<StartupRejection, { kind: K }> {
  const row = rows.find((r) => r.kind === kind);
  assert.ok(row !== undefined, `a ${kind} row in ${JSON.stringify(rows)}`);
  return row as Extract<StartupRejection, { kind: K }>;
}

export const runDirOfArc = (a: CorpusArc): AbsPath => runDirOf(gitCommonDir(a.repo), a.arc);
export const newHostDir = (): AbsPath => openHostDir(absPath(join(tmpDir('c1-host'), 'roadmap')));

/** The arc's files as a start reads them. */
export const filesOf = (a: CorpusArc): InputFiles => readInputFiles(a.planPath, a.repo);

/** Puts the arc's files in force as revision 1, as a fresh start does (the corpus files kept first). Returns the open journal. */
export function inForce(a: CorpusArc): OpenJournal {
  const files = filesOf(a);
  const rows = phase0Rows(phase0InputOf(files, null), APPLY);
  assert.deepEqual(rows.rows, []);
  const runDir = runDirOfArc(a);
  mkdirSync(runDir, { recursive: true });
  keepCorpusFiles(runDir, rows.opened?.files ?? []);
  const j = openJournal(runDir, a.arc);
  recordPlan(j, runDir, files, [], { profile: 'default', config: null });
  return j;
}

/**
 * The arc in force, completed at a commit of its own on its integration branch unless `complete` is false, and its
 * terminal snapshot published; `before` runs facts first (amendments). Returns the completed head.
 */
export async function seal(a: CorpusArc, opts: Readonly<{ complete?: boolean; before?: (j: OpenJournal) => void }> = {}): Promise<Sha> {
  const branch = String(readJsonFile(a.planPath)['integrationBranch']);
  git(a.repo, 'checkout', '--quiet', branch);
  writeFiles(a.repo, { [`src/${a.arc}.ts`]: `export const done = '${a.arc}';\n` });
  const head = sha(commitAll(a.repo, `${a.arc} work`));
  const j = inForce(a);
  try {
    opts.before?.(j);
    if (opts.complete !== false) j.fact({ kind: 'arc-completed', planRev: j.view.planApplied()!.rev, head, highWater: j.view.highWater(), units: [] });
    await runOp(j, snapshotPublishOp(a.repo), `snapshot:${a.arc}`, snapshotRequestOf({ view: j.view, runDir: runDirOfArc(a), identity: executorIdentity(), message: `roadmap ${a.arc}: terminal snapshot\n` }));
  } finally {
    j.close();
  }
  return head;
}

/**
 * The between-arc commit on `head` (OR-L7): `files` (default a config edit) committed as the next arc's baseline, with
 * the repo detached there. Returns the baseline.
 */
export function betweenArc(repo: AbsPath, head: Sha, files: Readonly<Record<string, string | null>> = {}): Sha {
  git(repo, 'checkout', '--quiet', '--detach', head);
  writeFiles(repo, Object.keys(files).length === 0 ? { '.roadmap/config.json': `${JSON.stringify({ chain: { k: 1 } }, null, 2)}\n` } : files);
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'between arcs');
  return sha(git(repo, 'rev-parse', 'HEAD'));
}

/**
 * The next arc chained on `previous` (completed at `head`): its integration branch `harbour/<name>` cut at the repo's
 * HEAD (its baseline), checked out.
 */
export async function nextArc(previous: CorpusArc, head: Sha, name: string, opts: CorpusArcOptions = {}): Promise<CorpusArc> {
  const branch = `harbour/${name}`;
  git(previous.repo, 'checkout', '--quiet', '-B', branch);
  return corpusArc({
    ...opts, arc: name, repo: previous.repo, forge: previous.forge,
    plan: { integrationBranch: branch, chain: { previousArc: previous.arc, previousHead: head }, ...opts.plan },
  });
}
