// The role evals' fixture generator (evals/roles/gen/, evals/roles/gate/fixture.ts): determinism, the plants' self-tests
// and the codemods' consistency, over real git and real node --test. Named tests: roles.gen-deterministic,
// roles.plant-in-diff, roles.placement-omitted, roles.lane-invisible, roles.goldens-generator.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { boundedDiff } from '../src/git/boundeddiff.ts';
import { GATE_DIFF_BUDGET } from '../src/pipeline/gate.ts';
import { DEV_CELLS, type SweepCell, isCorpusCell, isExecCell } from '../evals/roles/gate/cells.ts';
import { DERIVED_PATTERNS, type Fixture, buildFixture, materialise, trimEnds } from '../evals/roles/gate/fixture.ts';
import { rng } from '../evals/roles/gen/prng.ts';
import { TEST_ARGV, generate, gitOut } from '../evals/roles/gen/tsrepo.ts';
import { tmpDir } from './helpers/repo.ts';

/** A sweep cell (the execution-only cells are roles-gate-exec.test.ts's). */
const cell = (id: string): SweepCell => {
  const c = DEV_CELLS.find((x) => x.id === id)!;
  if (isExecCell(c) || isCorpusCell(c)) throw new Error(`${id} is an execution-only cell`);
  return c;
};
/** A cell, or (`<id>*`) the cell with placement `any`: the same plant without the bounded-diff placement checks. */
const cellOf = (id: string): SweepCell => {
  if (!id.endsWith('*')) return cell(id);
  const c = cell(id.slice(0, -1));
  return { ...c, plant: { plant: c.plant!.plant, placement: 'any' } };
};
const build = (id: string, size: number, seed = 'gen-test', trial = 0): Fixture => buildFixture(cellOf(id), { seed, trial, size, scratch: tmpDir('roles-scratch') });

test('roles.gen-deterministic: the same seed gives the same trees and commits; another seed another tree', () => {
  const trees = (seed: string): readonly string[] => {
    const dir = tmpDir('roles-det');
    const { base, head } = materialise(build('G5', 300, seed), dir);
    return [base, head, gitOut(dir, ['rev-parse', `${head}^{tree}`])];
  };
  const a = trees('seed-a');
  assert.deepEqual(trees('seed-a'), a);
  assert.notEqual(trees('seed-b')[2], a[2]);
  assert.equal(generate('seed-a', 300).files.size, generate('seed-a', 300).files.size);
});

test('roles.size-knob: the file count follows the size knob within a few percent', () => {
  for (const size of [2000, 5000]) {
    const n = generate('size', size).files.size;
    assert.ok(Math.abs(n - size) / size < 0.03, `size ${size} gave ${n} files`);
  }
});

test('roles.plant-in-diff: every planted dev cell plants inside the diff, away from both ends, with its needle in place', () => {
  // Placement `any` only: the inlined and omitted cells are placement-omitted's (each placement check is a bounded diff).
  const sweeps = DEV_CELLS.flatMap((x) => (isExecCell(x) || isCorpusCell(x) ? [] : [x]));
  for (const c of [...sweeps.filter((x) => x.plant !== null && x.plant.placement === 'any'), cellOf('G2a*'), cellOf('G3a*')]) {
    const f = buildFixture(c, { seed: 'gen-test', trial: 0, size: 300, scratch: tmpDir('roles-scratch') });
    const swept = f.swept!;
    const p = f.key.plant!;
    assert.ok(f.key.changed.includes(p.path), `${c.id}: ${p.path} is not in the diff`);
    if (p.deletion) {
      assert.equal(f.head.has(p.path), false, `${c.id}: the deleted file is still there`);
      assert.equal(f.base.has(p.path), true);
      assert.ok(!f.key.removes.some((r) => r === p.path || p.path.startsWith(`${r}/`)), `${c.id}: the stray deletion is declared`);
    } else {
      assert.ok(f.head.get(p.path)!.includes(p.needle), `${c.id}: the needle ${p.needle} is not in ${p.path}`);
    }
    const eligible = trimEnds(c.plant!.plant.eligible({ repo: f.repo, swept, rng: rng('unused') }, c.plant!.plant.phase === 'source' ? swept.files : f.head));
    if (!p.deletion && c.plant!.plant.phase === 'source') assert.ok(eligible.includes(p.path), `${c.id}: ${p.path} is outside the trimmed eligible files`);
  }
});

test('roles.twins-identical: a family\'s planted and clean cells share the spec and the commit message', () => {
  for (const [planted, clean] of [['G4', 'G4c'], ['G5', 'G5c'], ['G6', 'G6c']] as const) {
    const a = build(planted, 300);
    const b = build(clean, 300);
    assert.deepEqual(a.acceptance, b.acceptance, planted);
    assert.equal(a.message, b.message, planted);
    assert.equal(b.key.plant, null);
  }
});

test('roles.placement-omitted: an omitted placement is really not inlined by the bounded diff, an inlined one is', () => {
  // Size 400: G3b's reworded sweep overflows the gate's budget (GATE_DIFF_BUDGET, 128 KiB) with changes no substitution
  // explains, so its plant can land not inlined; G2a's plant, the one such change in a pure rename, is inlined first.
  for (const [id, inlined] of [['G3b', false], ['G2a', true]] as const) {
    const f = build(id, 400);
    const dir = tmpDir('roles-place');
    const { base, head } = materialise(f, dir);
    const d = boundedDiff(absPath(dir), sha(base), sha(head), { budget: GATE_DIFF_BUDGET, derived: DERIVED_PATTERNS, removes: f.removes, dir: absPath(join(tmpDir('roles-bd'), 'bd')) });
    assert.equal(d.inlined.some((x) => x.path === f.key.plant!.path), inlined, `${id}: ${f.key.plant!.path}`);
    assert.equal(f.key.plant!.predicted, inlined ? 'inlined' : 'omitted');
  }
});

test('roles.lane-invisible: the lane is green on the base and on every planted tree; the goldens agree with the generator except a hand edit', () => {
  for (const id of ['G0', 'G2a*', 'G3a*', 'G4', 'G5', 'G6']) {
    const f = build(id, 300);
    const dir = tmpDir('roles-lane');
    materialise(f, dir);
    const lane = (): number | null => spawnSync(TEST_ARGV[0], TEST_ARGV.slice(1), { cwd: dir, encoding: 'utf8' }).status;
    if (id === 'G0') assert.equal(lane(), 0, 'the base is green');
    gitOut(dir, ['checkout', '--quiet', 'refs/fixture/unit']);
    assert.equal(lane(), 0, `${id}: the planted tree is green`);
    const regen = spawnSync(process.execPath, ['tools/gen-goldens.ts'], { cwd: dir, encoding: 'utf8' });
    assert.equal(regen.status, 0, regen.stderr);
    const drift = gitOut(dir, ['status', '--porcelain', '--', 'goldens']);
    assert.equal(drift, id === 'G4' ? `M ${f.key.plant!.path}` : '', `${id}: goldens vs their generator`);
  }
});
