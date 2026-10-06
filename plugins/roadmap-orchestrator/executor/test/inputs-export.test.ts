// M4a rev 3 step N6 (I1, F17): `roadmap inputs export --repo <repo> --arc <arc> --out <dir>` (src/commands/inputs.ts),
// over real arcs whose run dir is the repo's (`<git common dir>/roadmap-runtime/<arc>`): the current input view from the
// run dir's kept inputs, a plan-check's post-plan spec patch included, the CLI as a child. Named tests:
// cli.inputs-export-current-revs, cli.inputs-export-refuses-existing-out.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { exportInputs } from '../src/commands/inputs.ts';
import { arcId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { runDir } from '../src/input/cli.ts';
import { gitCommonDir } from '../src/preflight/checks.ts';
import { runUntilExit } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { corpusHolisticArc } from './fixtures/corpus-holistic.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, contextFor, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));

/** The descriptor with its run dir where `roadmap` finds it: the repo's (made). */
function atRepoRunDir(d: ArcDescriptor): ArcDescriptor {
  const dir = runDir(gitCommonDir(absPath(d.repo)), arcId(d.arc));
  mkdirSync(dir, { recursive: true });
  return { ...d, runDir: dir };
}

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name))).sort();
}

const exportCli = (d: ArcDescriptor, out: string) =>
  runUntilExit(process.execPath, [BIN, 'inputs', 'export', '--repo', d.repo, '--arc', d.arc, '--out', out], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/' }, timeoutMs: 60_000 });

describe('roadmap inputs export', () => {
  test('cli.inputs-export-current-revs: the plan in force and each spec at its current rev, the plan-check machine patch included; export.json names the revs', T, async () => {
    const decision = { id: 'R9', text: 'Use the existing multiply helper.' };
    const d = atRepoRunDir(setupArc({ steps: [planCheckStep({ decision: 'redirect', patch: [{ op: 'add', section: 'decisions', item: decision }] })] }));
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'plan-check');
      assert.deepEqual(outcomes(d), ['plan-check:redirect']);
    } finally {
      r.journal.close();
    }
    const out = join(tmpDir('export'), 'inputs');
    const exit = await exportCli(d, out);
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(JSON.parse(exit.stdout), { planRev: 1, specRevs: { u1: 2 } });
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'export.json'), 'utf8')), { planRev: 1, specRevs: { u1: 2 } });
    assert.deepEqual(filesUnder(out), ['export.json', 'plan.json', 'rulings.md', 'u1.json']);
    const spec = JSON.parse(readFileSync(join(out, 'u1.json'), 'utf8')) as { rev: number; decisions: readonly { id: string }[] };
    assert.equal(spec.rev, 2, 'the patched spec in force');
    assert.ok(spec.decisions.some((x) => x.id === 'R9'));
    assert.deepEqual(readFileSync(join(out, 'plan.json')), readFileSync(d.planPath), 'the plan in force is the file applied');
  });

  test('cli.inputs-export-refuses-existing-out: an existing --out is refused and left untouched; a corpus arc exports its revision inputs, the vision under repo/', T, async () => {
    const a = await corpusHolisticArc([]);
    const d = atRepoRunDir(a.d);
    contextFor(d).journal.close();
    const existing = tmpDir('export-existing');
    const refused = await exportCli(d, existing);
    assert.equal(refused.code, 64);
    assert.match(refused.stderr, /exists; name a directory that does not/);
    assert.deepEqual(readdirSync(existing), []);

    const out = absPath(join(tmpDir('export'), 'inputs'));
    const done = await exportInputs({ repo: absPath(d.repo), arc: arcId(d.arc), out });
    assert.deepEqual(done, { planRev: 1, specRevs: { u1: 1 } });
    const files = filesUnder(out);
    for (const f of ['export.json', 'plan.json', 'u1.json', 'obligations.json', 'repo/.roadmap/vision.json']) assert.ok(files.includes(f), `${f} in ${files.join(', ')}`);
    const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { corpus: string; phase0: string };
    assert.ok(existsSync(join(out, plan.corpus)) && existsSync(join(out, plan.phase0)), 'the pin and the Phase-0 record beside the plan');
  });
});
