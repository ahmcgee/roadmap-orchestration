// The regenerate check (dev.12; src/input/derived.ts, src/pipeline/regenerate.ts): a plan `derived` entry declaring
// `regenerate` is a fast suite lane at the lanes stage for a unit whose diff touches its sources or outputs. The generator
// runs in the clean checkout of the unit's commit and every output must come out byte-identical to what the commit holds:
// a hand edit hidden in a regenerated output is the unit's red, with evidence naming the output and the difference, and
// the gate is told per entry whether regeneration verified the outputs it touches. Real processes, real git, fake
// backends. Named tests: regenerate.check, lanes.regenerate-hand-edit, lanes.regenerate-clean.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { IntentOf } from '../src/core/events.ts';
import { type Sha, sha } from '../src/core/ids.ts';
import { STDOUT_FILE } from '../src/core/records.ts';
import { repoPath, repoPattern } from '../src/core/values.ts';
import { worktreeList } from '../src/git/git.ts';
import { regenerateLaneId, parsePlan } from '../src/input/plan.ts';
import { resolveArgv0 } from '../src/preflight/argv0.ts';
import { pinDispatch, type StageParent } from '../src/pipeline/dispatch.ts';
import { regeneratedChecks } from '../src/pipeline/gate.ts';
import { runRegenerateCheck } from '../src/pipeline/regenerate.ts';
import { fastSuiteRoot, lanes } from '../src/pipeline/stages.ts';
import { git, makeRepo, tmpDir } from './helpers/repo.ts';
import { type LaneJson, SCENARIO_TIMEOUT_MS, type StageRun, U1, keptSpec, outcomeFacts, setupUnit, spawnIntents, started } from './fixtures/stage-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

/** The generator: gen/golden.json, one upper-cased line of src/words.txt per entry. */
const GENERATOR = `import { readFileSync, writeFileSync } from 'node:fs';
const words = readFileSync('src/words.txt', 'utf8').split('\\n').filter((w) => w !== '');
writeFileSync('gen/golden.json', JSON.stringify({ words: words.map((w) => w.toUpperCase()) }, null, 2) + '\\n');
`;
const golden = (...words: string[]): string => `${JSON.stringify({ words: words.map((w) => w.toUpperCase()) }, null, 2)}\n`;
const GEN = { argv: ['node', 'gen/gen.mjs'], cwd: '.', env: { set: {}, pass: ['PATH'] } };
const WORDS = { sources: ['src/words.txt', 'gen/gen.mjs'], outputs: ['gen/golden.json'], regenerate: GEN };
/** An entry without a generator: nothing checks its output. */
const NOTES = { sources: ['src/notes.txt'], outputs: ['gen/notes.txt'] };
const BASE_FILES = { 'gen/gen.mjs': GENERATOR, 'src/words.txt': 'alpha\nbeta\n', 'gen/golden.json': golden('alpha', 'beta'), 'src/notes.txt': 'n\n', 'gen/notes.txt': 'N\n' };
const UNIT: LaneJson = { id: 'unit', argv: ['true'] };

const git0 = (): string => {
  const r = resolveArgv0({ argv: ['git'], env: { set: {}, pass: ['PATH'] } }, process.env);
  assert.ok(r.kind === 'program');
  return r.realpath;
};

test('regenerate.check: the generator\'s changes are named with their difference, outputs and undeclared files alike, and put back; a dirty checkout is refused', () => {
  const repo = makeRepo(tmpDir('regen-check'), { files: { ...BASE_FILES, 'gen/golden.json': golden('alpha', 'HAND') } });
  const lines: string[] = [];
  const request = { argv: ['node', 'gen/gen.mjs'], cwd: repoPath('.'), outputs: [repoPattern('gen/golden.json')] };
  assert.equal(runRegenerateCheck(git0(), repo, request, (l) => lines.push(l)), 1);
  const text = lines.join('\n');
  assert.match(text, /regenerate: 1 output the commit does not hold as the generator writes it:\n- gen\/golden\.json: differs/);
  assert.match(text, /regenerate: difference of gen\/golden\.json \(- the commit, \+ the generator\):[\s\S]*-\s+"HAND"[\s\S]*\+\s+"BETA"/);
  assert.match(text, /run \["node","gen\/gen\.mjs"\] from \. after changing the sources/);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'the checkout is put back as the commit holds it');

  // A generator writing beyond its declared outputs: named, and removed.
  writeFileSync(join(repo, 'gen/gen.mjs'), `${GENERATOR}writeFileSync('stray.txt', 'x\\n');\n`);
  writeFileSync(join(repo, 'gen/golden.json'), golden('alpha', 'beta'));
  git(repo, 'commit', '-qam', 'stray');
  const stray: string[] = [];
  assert.equal(runRegenerateCheck(git0(), repo, request, (l) => stray.push(l)), 1);
  assert.match(stray.join('\n'), /1 file outside the declared outputs \(gen\/golden\.json\) that the generator changed:\n- stray\.txt: added/);
  assert.equal(git(repo, 'status', '--porcelain'), '');

  // Clean: exit 0. Dirty before the run: exit 2, nothing run.
  writeFileSync(join(repo, 'gen/gen.mjs'), GENERATOR);
  git(repo, 'commit', '-qam', 'clean');
  const clean: string[] = [];
  assert.equal(runRegenerateCheck(git0(), repo, request, (l) => clean.push(l)), 0);
  assert.match(clean.at(-1)!, /every output \(gen\/golden\.json\) is byte-identical to the commit/);
  writeFileSync(join(repo, 'src/words.txt'), 'dirty\n');
  assert.equal(runRegenerateCheck(git0(), repo, request, () => {}), 2);
  // A generator that cannot start is red.
  git(repo, 'checkout', '--', 'src/words.txt');
  const missing: string[] = [];
  assert.equal(runRegenerateCheck(git0(), repo, { ...request, argv: ['no-such-generator-r3'] }, (l) => missing.push(l)), 1);
  assert.match(missing.join('\n'), /the generator could not start/);
});

type LaneSubject = Readonly<{ lane: string; set: string; at: Sha }>;
const laneSpawns = (run: StageRun): readonly LaneSubject[] => spawnIntents(run).flatMap((i: IntentOf<'proc.spawn'>) => {
  const s = i.expect.subject;
  return s.purpose === 'lane' ? [{ lane: s.lane, set: s.set, at: s.at }] : [];
});

/** A commit of the unit's own on a side branch off the integration tip. */
function unitCommit(run: StageRun, files: Readonly<Record<string, string>>): Sha {
  git(run.repo, 'checkout', '-q', '-b', 'side');
  for (const [path, text] of Object.entries(files)) writeFileSync(join(run.repo, path), text);
  git(run.repo, 'add', '-A');
  git(run.repo, 'commit', '-q', '-m', 'unit work');
  const at = sha(git(run.repo, 'rev-parse', 'HEAD'));
  git(run.repo, 'checkout', '-q', 'main');
  return at;
}

const setup = (): StageRun => {
  const run = setupUnit({ steps: [], lanes: [UNIT], files: BASE_FILES, derived: [WORDS, NOTES] });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  return run;
};
const lanesParent = (attempt: number): StageParent => ({ type: 'stage', unit: U1, stage: 'lanes', attempt });
const fastCheckouts = (run: StageRun) => worktreeList(run.repo).filter((w) => w.path.includes('.fast-'));

test('lanes.regenerate-hand-edit: an output edited by hand beside its regenerated change is the unit\'s red, its evidence naming the output and the difference', T, async () => {
  const run = setup();
  const id = regenerateLaneId(parsePlan(JSON.parse(readFileSync(run.ctx.planFile, 'utf8'))).derived![0]!);
  // gamma regenerated, and beta hand-edited to BETTA.
  const salvaged = unitCommit(run, { 'src/words.txt': 'alpha\nbeta\ngamma\n', 'gen/golden.json': golden('alpha', 'betta', 'gamma') });
  const done = started(await lanes(run.ctx, run.unit, salvaged));
  assert.equal(done.outcome.kind, 'red', 'a red lane in a certified checkout (the check put the tree back)');
  const fact = outcomeFacts(run).at(-1)!;
  assert.ok(fact.kind === 'stage-outcome');
  assert.equal(fact.chargeable, false, 'the first certification red uses the allowance');
  assert.equal(run.journal.view.unit(U1).counters.unchargedLanesReds, 1);
  assert.ok(done.fix !== null, 'the hand edit returns to a fix round with evidence');
  // The spec lane, the check at the salvage SHA and its diagnostic rerun, then the check on the base alone (green).
  assert.deepEqual(laneSpawns(run).map((s) => [s.lane, s.set, s.at]), [['unit', 'spec', salvaged], [id, 'suite', salvaged], [id, 'suite', salvaged], [id, 'suite', run.base]]);
  assert.deepEqual(fastCheckouts(run), []);
  const dir = join(fastSuiteRoot(run.runDir, lanesParent(done.attempt), 'suite'), id, 'output', 'files');
  const stdout = readFileSync(join(dir, STDOUT_FILE), 'utf8');
  assert.match(stdout, /- gen\/golden\.json: differs/);
  assert.match(stdout, /-\s+"BETTA"[\s\S]*\+\s+"BETA"/);
  assert.ok(done.fix?.kind === 'fix' && done.fix.fix.failingEvidenceDirs.some((d) => d === dir), 'the fix round reads the check\'s output');
  // What a gate of this attempt would be told: the outputs differ, with the evidence.
  const paths = [repoPath('gen/golden.json'), repoPath('src/words.txt')];
  const checks = regeneratedChecks(run.ctx, lanesParent(done.attempt), salvaged, paths);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.state, 'differs');
});

test('lanes.regenerate-clean: outputs as the generator writes them pass; an untouched entry runs nothing; the gate is told verified or no generator', T, async () => {
  const run = setup();
  const id = regenerateLaneId(parsePlan(JSON.parse(readFileSync(run.ctx.planFile, 'utf8'))).derived![0]!);
  const salvaged = unitCommit(run, { 'src/words.txt': 'alpha\nbeta\ngamma\n', 'gen/golden.json': golden('alpha', 'beta', 'gamma'), 'src/notes.txt': 'm\n', 'gen/notes.txt': 'M\n' });
  const done = started(await lanes(run.ctx, run.unit, salvaged));
  assert.equal(done.outcome.kind, 'green');
  assert.deepEqual(laneSpawns(run).map((s) => [s.lane, s.set]), [['unit', 'spec'], [id, 'suite']]);
  const paths = [repoPath('gen/golden.json'), repoPath('gen/notes.txt'), repoPath('src/notes.txt'), repoPath('src/words.txt')];
  assert.deepEqual(regeneratedChecks(run.ctx, lanesParent(done.attempt), salvaged, paths), [
    { state: 'verified', outputs: ['gen/golden.json'], argv: GEN.argv },
    { state: 'no-generator', outputs: ['gen/notes.txt'] },
  ]);
  assert.deepEqual(regeneratedChecks(run.ctx, lanesParent(done.attempt), salvaged, [repoPath('src/other.js')]), [], 'no output touched: nothing to tell');

  // A diff touching neither the sources nor the outputs runs no check.
  const other = setup();
  const untouched = unitCommit(other, { 'src/other.js': 'export const x = 1;\n' });
  assert.equal(started(await lanes(other.ctx, other.unit, untouched)).outcome.kind, 'green');
  assert.deepEqual(laneSpawns(other).map((s) => s.lane), ['unit']);
});
