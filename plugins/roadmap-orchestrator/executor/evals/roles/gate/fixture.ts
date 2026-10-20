// One gate trial's fixture: the base repo (the seed's, shared by every cell and trial), the cell's sweep, the trial's plant
// (file, symbol and form from the trial's seed), the spec, the commit message and the answer key.
//
// Placement: a cell asks for its plant's file inlined, not inlined, or either. The fixture tries candidate files and keeps
// the first whose planted tree lands on the asked side under the production bounded diff (src/git/boundeddiff.ts) at the
// gate's own budget (`GATE_DIFF_BUDGET`) over a scratch repository. The unplanted tree predicts nothing: the bounded
// diff inlines first what the sweep's substitutions do not explain, which a plant itself is. The trial then reads the
// truth from what the gate recorded it was shown (its `judgment-inputs` `diffShown`, grade.ts): a trial whose plant
// landed on the other side is void (`placement-miss`), never graded.
//
// An execution-only cell (dev.13, gen/exec.ts) adds its family's feature, planted or its twin, to a package of the seed's
// base repo and regenerates the goldens; the variant and the package come from `<seed>/<family>/<trial>`. Its plant is
// expected inlined (a two-file diff), with no prediction checked before the trial.
import { join } from 'node:path';
import { sha } from '../../../src/core/ids.ts';
import { absPath, repoPattern } from '../../../src/core/values.ts';
import { boundedDiff } from '../../../src/git/boundeddiff.ts';
import { GATE_DIFF_BUDGET } from '../../../src/pipeline/gate.ts';
import { execFeature, variantCount } from '../gen/exec.ts';
import type { PlantContext, Planted } from '../gen/plant.ts';
import { rng } from '../gen/prng.ts';
import { type FileMap, GOLDEN_SCRIPT_PATH, REWORDED, type Repo, SHARED, type Swept, finish, generate, gitOut, importCommits, initRepo, sorted, sweep } from '../gen/tsrepo.ts';
import { type Cell, type ExecCell, type Placement, isExecCell } from './cells.ts';

/**
 * The plan's derived files: goldens/ is regenerated from the generator and the modules, by the generator the synthetic repo
 * carries (tools/gen-goldens.ts, gen/golden-script.ts). So the executor's regenerate check catches a hand-edited golden
 * (G4) at the lanes stage, before any gate: the G4 cell measures that check, and its clean twin G4c the gate told the
 * goldens were verified by regeneration.
 */
export const DERIVED = [{
  sources: ['tools/gen-goldens.ts', 'packages/**'], outputs: ['goldens/**'],
  regenerate: { argv: ['node', GOLDEN_SCRIPT_PATH], cwd: '.', env: { set: {}, pass: ['PATH'] } },
}] as const;
/** The derived outputs as the gate passes them to the bounded diff. */
export const DERIVED_PATTERNS = DERIVED.flatMap((x) => x.outputs.map((o) => repoPattern(o)));

export type AnswerKey = Readonly<{
  cell: string;
  trial: number;
  seed: string;
  size: number;
  /** `predicted`: the side the fixture placed it on (null for placement `any`, which is not predicted). */
  plant: (Planted & Readonly<{ intended: Placement; predicted: 'inlined' | 'omitted' | null }>) | null;
  /** What the spec declares removed. */
  removes: readonly string[];
  /** Every path the unit's diff changes (no rename detection: a move is its old path deleted and its new one added). */
  changed: readonly string[];
}>;

export type Clause = Readonly<{ id: string; clause: string }>;

export type Fixture = Readonly<{
  cell: Cell;
  repo: Repo;
  /** The sweep a sweep cell ran; null for an execution-only cell. */
  swept: Swept | null;
  /** What the spec declares removed. */
  removes: readonly string[];
  base: FileMap;
  head: FileMap;
  acceptance: readonly Clause[];
  message: string;
  key: AnswerKey;
}>;

export type FixtureOptions = Readonly<{ seed: string; trial: number; size: number; /** An empty dir for the placement checks. */ scratch: string }>;

/** The spec's acceptance clauses: the sweep, stated so that every collateral change is outside it. */
function clauses(repo: Repo, s: Swept): Clause[] {
  if (s.spec.scope === 'package') {
    return [
      { id: 'A1', clause: `Rename \`${s.from}\` (packages/${s.pkg}/src/${s.pkg}-base.ts) to \`${s.to}\` at its definition and every use in packages/${s.pkg}/; behaviour is unchanged.` },
      { id: 'A2', clause: 'goldens/ is regenerated with `node tools/gen-goldens.ts`, never edited by hand. Nothing else changes.' },
    ];
  }
  const out: Clause[] = [
    { id: 'A1', clause: `Rename the shared helper \`${s.from}\` (packages/shared/src/measure.ts) to \`${s.to}\` at its definition and every use; behaviour is unchanged.` },
  ];
  if (s.spec.move) out.push({ id: `A${out.length + 1}`, clause: 'Move every module under packages/*/legacy/ to packages/*/core/, unchanged apart from the rename; update the imports that name them.' });
  if (s.spec.tests !== 'none') {
    out.push({ id: `A${out.length + 1}`, clause: `Migrate every test assertion of the form \`assert.ok(x === v, m)\` to \`assert.${s.spec.tests}(x, v, m)\`, keeping its operands and its message.` });
  }
  if (s.spec.reword === true) out.push({ id: `A${out.length + 1}`, clause: `Reword every exported function's doc comment to read \`/** <name>: ${REWORDED.replace('$1: ', '')} */\`.` });
  if (s.arity !== null) out.push({ id: `A${out.length + 1}`, clause: `Give \`${s.arity.name}\` (${s.arity.path}) an optional third parameter \`c = 0\`, unused for now: a later unit uses it.` });
  if (s.removes.length > 0) {
    out.push({ id: `A${out.length + 1}`, clause: `Remove exactly ${s.removes.map((r) => `\`${r}\``).join(' and ')} (a directory with everything under it): the unit deletes nothing else.` });
  }
  out.push({ id: `A${out.length + 1}`, clause: 'goldens/ is regenerated with `node tools/gen-goldens.ts`, never edited by hand. Every other line is unchanged.' });
  return out;
}

function message(s: Swept): string {
  if (s.spec.scope === 'package') return `Rename ${s.from} to ${s.to}\n`;
  const parts = [`rename ${s.from} to ${s.to}`];
  if (s.spec.move) parts.push('move legacy/ to core/');
  if (s.spec.tests !== 'none') parts.push('migrate test assertions');
  if (s.spec.reword === true) parts.push('reword doc comments');
  if (s.spec.remove) parts.push('remove the deprecated package');
  parts.push('regenerate goldens');
  return `Sweep: ${parts.join(', ')}\n`;
}

/** Paths whose content differs between `a` and `b`, or that only one has, in path order. */
export function changedPaths(a: FileMap, b: FileMap): readonly string[] {
  const all = new Set([...a.keys(), ...b.keys()]);
  return [...all].filter((p) => a.get(p) !== b.get(p)).sort();
}

/** The first and last tenth of `paths` (path order) dropped, from ten paths up: a plant never sits at either end of its candidates. */
export function trimEnds(paths: readonly string[]): readonly string[] {
  const s = [...paths].sort();
  const cut = s.length >= 10 ? Math.floor(s.length / 10) : 0;
  return s.slice(cut, s.length - cut);
}

/** Which changed files the gate's bounded diff inlines (a scratch repo holding the base, one commit per tree). */
function placementOracle(scratch: string, base: FileMap, removes: readonly string[]): (head: FileMap) => ReadonlySet<string> {
  initRepo(scratch);
  const [baseSha] = importCommits(scratch, [{ ref: 'refs/heads/main', message: 'base\n', files: base, parent: null }]);
  let n = 0;
  return (head) => {
    n += 1;
    const [headSha] = importCommits(scratch, [{ ref: `refs/heads/try-${n}`, message: 'try\n', files: head, parent: null }]);
    const d = boundedDiff(absPath(scratch), sha(baseSha!), sha(headSha!), {
      budget: GATE_DIFF_BUDGET, derived: DERIVED_PATTERNS, removes, dir: absPath(join(scratch, `bd-${n}`)),
    });
    return new Set(d.inlined.map((f) => f.path));
  };
}

const side = (inlined: ReadonlySet<string>, path: string): 'inlined' | 'omitted' => (inlined.has(path) ? 'inlined' : 'omitted');

/** Up to this many candidate files are tried before a cell is infeasible at this size and seed (a loud failure). */
const CANDIDATES = 20;

/** An execution-only cell's fixture: the feature (planted or its twin) and its test added to one package, goldens regenerated. */
function buildExecFixture(cell: ExecCell, o: FixtureOptions): Fixture {
  const repo = generate(o.seed, o.size);
  const g = rng(`${o.seed}/${cell.family}/${o.trial}`);
  const pkg = g.pick(repo.packages.filter((p) => p.name !== repo.deprecated && p.name !== SHARED)).name;
  const f = execFeature(cell.family, g.int(variantCount(cell.family)), pkg, cell.exec.planted);
  for (const path of [f.modulePath, f.testPath]) if (repo.files.has(path)) throw new Error(`cell ${cell.id}: the base repo already has ${path}`);
  const head = finish(sorted(new Map([...repo.files, [f.modulePath, f.module], [f.testPath, f.test]])));
  const acceptance: Clause[] = [
    { id: 'A1', clause: `Add \`${f.name}\` to ${f.modulePath}: ${f.behaviour}` },
    { id: 'A2', clause: `Test \`${f.name}\` in ${f.testPath}, which the unit lane runs.` },
    { id: 'A3', clause: 'goldens/ is regenerated with `node tools/gen-goldens.ts`, never edited by hand. Nothing else changes.' },
  ];
  const plant: AnswerKey['plant'] = cell.exec.planted
    ? { kind: `exec-${cell.family}`, path: f.modulePath, form: f.form, needle: f.needle, deletion: false, intended: 'inlined', predicted: null }
    : null;
  return {
    cell, repo, swept: null, removes: [], base: repo.files, head, acceptance, message: `Add ${f.name}\n`,
    key: { cell: cell.id, trial: o.trial, seed: o.seed, size: o.size, plant, removes: [], changed: changedPaths(repo.files, head) },
  };
}

export function buildFixture(cell: Cell, o: FixtureOptions): Fixture {
  if (isExecCell(cell)) return buildExecFixture(cell, o);
  const repo = generate(o.seed, o.size);
  const swept = sweep(repo, cell.sweep, cell.decoy, `${o.seed}/${cell.family}`);
  const acceptance = clauses(repo, swept);
  const done = (head: FileMap, plant: AnswerKey['plant']): Fixture => ({
    cell, repo, swept, removes: swept.removes, base: repo.files, head, acceptance, message: message(swept),
    key: { cell: cell.id, trial: o.trial, seed: o.seed, size: o.size, plant, removes: swept.removes, changed: changedPaths(repo.files, head) },
  });
  if (cell.plant === null) return done(finish(swept.files), null);

  const { plant, placement } = cell.plant;
  const ctx: PlantContext = { repo, swept, rng: rng(`${o.seed}/${cell.id}/${o.trial}`) };
  const at = plant.phase === 'source' ? swept.files : finish(swept.files);
  // Placement `any` checks nothing (the bounded diff of a large sweep takes seconds per tree).
  const oracle = placement === 'any' ? null : placementOracle(o.scratch, repo.files, swept.removes);
  const eligible = trimEnds(plant.eligible(ctx, at));
  for (const path of ctx.rng.shuffle(eligible).slice(0, CANDIDATES)) {
    const applied = plant.apply(ctx, at, path);
    if (applied === null) continue;
    const head = plant.phase === 'source' ? finish(applied.files) : applied.files;
    const landed = oracle === null ? null : side(oracle(head), applied.planted.path);
    if (landed !== null && landed !== placement) continue;
    return done(head, { ...applied.planted, intended: placement, predicted: landed });
  }
  throw new Error(`cell ${cell.id} trial ${o.trial}: no ${placement} file for a ${plant.kind} plant among ${eligible.length} eligible (size ${o.size}, seed ${o.seed})`);
}

/** Lays the fixture's base (branch main, checked out) and its unit commit (`refs/fixture/unit`) into a fresh repo at `dir`. */
export function materialise(f: Fixture, dir: string): Readonly<{ base: string; head: string }> {
  initRepo(dir);
  const [base, head] = importCommits(dir, [
    { ref: 'refs/heads/main', message: 'Workspace baseline\n', files: f.base, parent: null },
    { ref: 'refs/fixture/unit', message: f.message, files: f.head, parent: 'refs/heads/main' },
  ]);
  gitOut(dir, ['reset', '--quiet', '--hard', 'main']);
  return { base: base!, head: head! };
}

