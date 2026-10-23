// The gate eval's execution-only cells and its read-only comparison arm (dev.13, the gate's shell), free tier: every plant
// fails its execution probe and passes the visible tests (so the lanes are green), every twin passes both; the X cells'
// fixtures through real git and the real lane; fake-gate trials over them end to end; the arm's argv rewrite, its `real`
// act, its ARM label and the exec-gain criterion. Named tests: roles.exec-plants, roles.exec-fixture, roles.exec-trials,
// roles.read-only-argv, roles.read-only-act, roles.exec-gain.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ACTING_JUDGE_TOOLS, JUDGMENT_TOOLS, backendArgv, freshJudgmentSession, resumedJudgmentSession } from '../src/backends/argv.ts';
import { sha } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { boundedDiff } from '../src/git/boundeddiff.ts';
import { judgmentReadDirs, judgmentSurface } from '../src/pipeline/dispatch.ts';
import { GATE_DIFF_BUDGET } from '../src/pipeline/gate.ts';
import { GATE_CHECKOUT } from '../src/prompts/gate/claude-opus-5-5.ts';
import { promptFor } from '../src/prompts/index.ts';
import { type TrialRow, gateArm } from '../evals/roles/gate/arc.ts';
import { DEV_CELLS, type ExecCell, isExecCell } from '../evals/roles/gate/cells.ts';
import { DERIVED_PATTERNS, buildFixture, materialise } from '../evals/roles/gate/fixture.ts';
import { READ_ONLY_CHECKOUT, readOnlyArgs, readOnlySystem } from '../evals/roles/gate/readonly.ts';
import { reportLines, summarise } from '../evals/roles/gate/summary.ts';
import { EXEC_FAMILIES, type ExecFeature, execFeature, variantCount } from '../evals/roles/gen/exec.ts';
import { TEST_ARGV, gitOut } from '../evals/roles/gen/tsrepo.ts';
import { run } from '../evals/roles/run.ts';
import { tmpDir } from './helpers/repo.ts';
import { readCalls, writeScenario } from './helpers/scenario.ts';

const T = { timeout: 600_000 };
const EXEC_CELLS: readonly ExecCell[] = DEV_CELLS.flatMap((c) => (isExecCell(c) ? [c] : []));

/** Lays `f`'s module and test under `dir`; the lane's exit status and the probe's. */
function runFeature(f: ExecFeature, dir: string): Readonly<{ lane: number | null; probe: number | null; probeErr: string }> {
  for (const [path, text] of [[f.modulePath, f.module], [f.testPath, f.test]] as const) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const lane = spawnSync(process.execPath, ['--test', f.testPath], { cwd: dir, encoding: 'utf8' }).status;
  const probe = join(tmpDir('roles-probe'), 'probe.ts');
  writeFileSync(probe, f.probe(pathToFileURL(join(dir, f.modulePath)).href));
  const p = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  return { lane, probe: p.status, probeErr: p.stderr };
}

test('roles.exec-plants: every variant\'s plant passes its visible tests and fails its probe; its twin passes both; they differ in the planted line alone', () => {
  for (const family of EXEC_FAMILIES) {
    for (let v = 0; v < variantCount(family); v++) {
      const plant = execFeature(family, v, 'cedar', true);
      const twin = execFeature(family, v, 'cedar', false);
      const label = `${family}/${plant.form}`;
      const p = runFeature(plant, tmpDir('roles-exec'));
      assert.equal(p.lane, 0, `${label}: the plant passes the visible tests (the lanes are green)`);
      assert.notEqual(p.probe, 0, `${label}: the plant fails its probe`);
      assert.match(p.probeErr, /AssertionError/, `${label}: by an assertion, not a crash`);
      const t = runFeature(twin, tmpDir('roles-exec'));
      assert.equal(t.lane, 0, `${label}: the twin passes the visible tests`);
      assert.equal(t.probe, 0, `${label}: the twin passes its probe: ${t.probeErr}`);
      assert.equal(twin.test, plant.test, `${label}: the same visible test`);
      const [a, b] = [plant.module.split('\n'), twin.module.split('\n')];
      const differ = a.flatMap((line, i) => (line === b[i] ? [] : [line.trim()]));
      assert.equal(a.length, b.length, label);
      assert.deepEqual(differ, [plant.needle], `${label}: only the planted line differs`);
      assert.ok(!/\b(TODO|FIXME|HACK|XXX|bug)\b/i.test(plant.module), `${label}: no comment points at the plant`);
    }
  }
});

test('roles.exec-fixture: an X cell adds its feature to one package of the base repo, its lane green and goldens regenerated; a plant and its twin share spec, message, package and variant; the probe tells them apart in the unit\'s tree', () => {
  for (const c of EXEC_CELLS) {
    const f = buildFixture(c, { seed: 'exec-test', trial: 1, size: 300, scratch: tmpDir('roles-scratch') });
    const twin = buildFixture(EXEC_CELLS.find((x) => x.family === c.family && x.exec.planted !== c.exec.planted)!, { seed: 'exec-test', trial: 1, size: 300, scratch: tmpDir('roles-scratch') });
    assert.deepEqual(f.acceptance, twin.acceptance, c.id);
    assert.equal(f.message, twin.message, c.id);
    assert.deepEqual(f.key.changed, twin.key.changed, `${c.id}: the same paths change`);
    const module = f.key.changed.find((p) => /\/src\/[a-z-]+\.ts$/.test(p))!;
    assert.deepEqual(f.key.changed.filter((p) => !p.startsWith('goldens/')), [module, module.replace('/src/', '/test/').replace(/\.ts$/, '.test.ts')], `${c.id}: the module and its test`);
    assert.equal(f.key.changed.filter((p) => p.startsWith('goldens/')).length, 1, `${c.id}: one package's golden`);
    if (c.exec.planted) assert.deepEqual([f.key.plant?.path, f.key.plant?.intended, f.key.plant?.kind], [module, 'inlined', `exec-${c.family}`]);
    else assert.equal(f.key.plant, null);
    const dir = tmpDir('roles-exec-repo');
    const { base, head } = materialise(f, dir);
    gitOut(dir, ['checkout', '--quiet', 'refs/fixture/unit']);
    assert.equal(spawnSync(TEST_ARGV[0], TEST_ARGV.slice(1), { cwd: dir, encoding: 'utf8' }).status, 0, `${c.id}: the unit lane is green`);
    assert.equal(spawnSync(process.execPath, ['tools/gen-goldens.ts'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(gitOut(dir, ['status', '--porcelain']), '', `${c.id}: the goldens are the generator's`);
    const d = boundedDiff(absPath(dir), sha(base), sha(head), { budget: GATE_DIFF_BUDGET, derived: DERIVED_PATTERNS, removes: [], dir: absPath(join(tmpDir('roles-bd'), 'bd')) });
    assert.ok(d.inlined.some((x) => x.path === module), `${c.id}: the module's diff is inlined`);
    // The variant the fixture picked, found by its module text; its probe run against the unit's own tree.
    const pkg = module.split('/')[1]!;
    const feature = EXEC_FAMILIES.flatMap((fam) => Array.from({ length: variantCount(fam) }, (_, v) => execFeature(fam, v, pkg, c.exec.planted)))
      .find((x) => x.modulePath === module && x.module === readFileSync(join(dir, module), 'utf8'))!;
    assert.ok(feature !== undefined && feature.family === c.family, `${c.id}: the module is its family's feature`);
    const probe = join(tmpDir('roles-probe'), 'probe.ts');
    writeFileSync(probe, feature.probe(pathToFileURL(join(dir, module)).href));
    const status = spawnSync(process.execPath, [probe], { encoding: 'utf8' }).status;
    assert.equal(status === 0, !c.exec.planted, `${c.id}: the probe ${c.exec.planted ? 'fails' : 'passes'} in the unit's tree`);
  }
});

test('roles.exec-trials: fake gates over the X cells end to end: green lanes, the plant caught by a gate that cites it, the twins passed by one that approves', T, async () => {
  const ids = EXEC_CELLS.map((c) => c.id);
  const go = async (gate: 'cite-plant' | 'approve-all'): Promise<readonly TrialRow[]> => {
    const out = join(tmpDir('roles-out'), 'run');
    await run({
      set: 'dev', n: 1, cells: ids, parallel: 2, size: 150, seed: 'harness', risk: 'med', config: null, out, compare: null, gate, cap: null, trialCap: null, readOnly: false, baseline: null,
    }, () => {});
    return readFileSync(join(out, 'trials.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as TrialRow);
  };
  const cited = await go('cite-plant');
  for (const r of cited) {
    assert.equal(r.void, null, `${r.cell}: ${JSON.stringify(r.void)}`);
    assert.ok(r.stages.includes('lanes:green'), `${r.cell}: ${r.stages.join(' ')}`);
    assert.equal(r.graded?.verdict, r.planted ? 'caught' : 'false-positive', r.cell);
    assert.equal(r.graded?.placement, r.planted ? 'inlined' : null, r.cell);
  }
  for (const r of await go('approve-all')) assert.equal(r.graded?.verdict, r.planted ? 'missed' : 'clean-pass', r.cell);
});

test('roles.read-only-argv: the arm rewrites an acting gate call into the dev.12 judgment profile: read-only tools, no permission mode or settings, the read surface listed, the checkout section swapped, all else the call\'s', () => {
  const ctx = { repo: absPath('/repo'), runDir: absPath('/run') };
  const evidenceDirs = judgmentReadDirs(ctx, [absPath('/run/evidence/u1/2-lanes'), absPath('/corpus')]);
  const triple = { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } as const;
  const system = promptFor('gate', triple.model).system;
  for (const session of [freshJudgmentSession(), resumedJudgmentSession(freshJudgmentSession().id)]) {
    const acting = backendArgv({ kind: 'claude-acting-judge', role: 'gate', triple, session, schemaText: '{"type":"object"}', system, mcpConfig: null, evidenceDirs, denyWrites: [ctx.repo, ctx.runDir] });
    const args = readOnlyArgs(acting.slice(1), ctx);
    const surface = judgmentSurface(ctx, readOnlySystem(system), evidenceDirs);
    assert.deepEqual(args, backendArgv({ kind: 'claude-judgment', role: 'planCheck', triple, session, schemaText: '{"type":"object"}', system: surface.system, evidenceDirs }).slice(1));
    assert.equal(args[args.indexOf('--tools') + 1], JUDGMENT_TOOLS);
    assert.ok(!args.includes('--permission-mode') && !args.includes('--append-system-prompt') && args.includes('--disable-slash-commands'));
    const text = args[args.indexOf('--system-prompt') + 1]!;
    assert.ok(text.includes(READ_ONLY_CHECKOUT) && !text.includes(GATE_CHECKOUT) && text.includes('<readable_directories>'));
  }
  assert.throws(() => readOnlyArgs(['-p', '--tools', JUDGMENT_TOOLS], ctx), /not an acting gate call/);
  assert.equal(ACTING_JUDGE_TOOLS.includes('Bash'), true);
  assert.equal(gateArm('med', null, true), 'gate.med frontier claude-opus-5-5:medium read-only');
});

test('roles.read-only-act: a real act with readOnly runs the next claude on PATH with the rewritten argv, the call\'s stdin and cwd', () => {
  const repo = tmpDir('roles-ro-repo');
  const runDir = tmpDir('roles-ro-run');
  const scenario = writeScenario(tmpDir('roles-ro'), [{ as: 'claude', expect: {}, acts: [{ type: 'real', readOnly: { repo, runDir } }] }]);
  const stub = tmpDir('roles-stub');
  const record = join(stub, 'record.json');
  writeFileSync(join(stub, 'claude'), `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin: fs.readFileSync(0, 'utf8') }));\nprocess.exit(0);\n`, { mode: 0o755 });
  const ctx = { repo: absPath(repo), runDir: absPath(runDir) };
  const triple = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' } as const;
  const session = freshJudgmentSession();
  const system = promptFor('gate', triple.model).system;
  const acting = backendArgv({ kind: 'claude-acting-judge', role: 'gate', triple, session, schemaText: '{}', system, mcpConfig: null, evidenceDirs: judgmentReadDirs(ctx, []), denyWrites: [ctx.repo, ctx.runDir] });
  const cwd = tmpDir('roles-cwd');
  const r = spawnSync(join(scenario.binDir, 'claude'), acting.slice(1), { cwd, input: 'the prompt\n', encoding: 'utf8', env: { ...process.env, PATH: `${scenario.binDir}:${stub}:${process.env['PATH']}` } });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[]; cwd: string; stdin: string };
  assert.deepEqual(seen, { argv: [...readOnlyArgs(acting.slice(1), ctx)], cwd, stdin: 'the prompt\n' });
  assert.equal(readCalls(scenario.path)[0]!.argv.includes('--permission-mode'), true, 'the call itself, as production made it, is on record');
});

test('roles.exec-gain: with the read-only arm\'s summary as baseline, the X cells\' detection is compared and each cell\'s cost reported against the arm\'s', () => {
  const row = (cell: string, family: string, planted: boolean, verdict: 'caught' | 'missed' | 'clean-pass', usd: number, experiments: number): TrialRow => ({
    set: 'dev', cell, family, trial: 0, planted, gate: 'real', outcome: 'approve', caught: null, decision: verdict === 'caught' ? 'revise' : 'approve', void: null,
    graded: {
      verdict, placement: planted ? 'inlined' : null, placementMiss: false, looked: planted ? true : null, localised: verdict === 'caught', blocking: verdict === 'caught' ? 1 : 0, spurious: 0,
      coverage: { omitted: 0, covered: 0, share: null }, unreviewed: { claimed: 0, declared: 0, silent: 0 },
    },
    readOnly: false, experiments, largeDiff: false, clusters: null, usage: null, estimatedUsd: usd, wallMs: 1000, turns: 1, load: 0, calls: 1, models: [],
    method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: '/x',
  });
  const baseline = summarise('dev', [row('X1', 'X1', true, 'missed', 1, 0), row('X1c', 'X1', false, 'clean-pass', 1, 0), row('G0', 'G0', true, 'caught', 1, 0)], null, 'gate.med efficient claude-sonnet-5-5:high read-only');
  const acting = summarise('dev', [row('X1', 'X1', true, 'caught', 3, 1), row('X1c', 'X1', false, 'clean-pass', 2, 0), row('G0', 'G0', true, 'caught', 1, 0)], null, 'gate.med efficient claude-sonnet-5-5:high', null, baseline);
  const gain = acting.criteria.find((c) => c.name === 'exec-gain')!;
  assert.equal(gain.pass, true, gain.detail);
  assert.match(gain.detail, /1\/1.*vs 0\/1/);
  assert.equal(acting.cells.find((c) => c.cell === 'X1')!.experiments, 1);
  const lines = reportLines(acting);
  assert.ok(lines.includes('INFO cost-vs-baseline X1 median=$3.000 baseline=$1.000 [gate.med efficient claude-sonnet-5-5:high read-only]'), lines.join('\n'));
  assert.equal(summarise('dev', [row('X1', 'X1', true, 'missed', 1, 0)], null, 'a', null, baseline).criteria.find((c) => c.name === 'exec-gain')!.pass, false, 'no gain fails');
  assert.equal(baseline.criteria.some((c) => c.name === 'exec-gain'), false, 'no baseline, no criterion');
});
