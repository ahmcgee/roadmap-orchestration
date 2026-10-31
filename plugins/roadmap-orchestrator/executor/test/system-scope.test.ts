import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { systemName } from '../src/core/ids.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import { parsePlan } from '../src/input/plan.ts';
import { parseCorpusPin } from '../src/corpus/types.ts';
import { protectedPaths } from '../src/input/protected.ts';
import { inUnitSystems, systemReach, systemTraits, systemsMap } from '../src/input/systems.ts';
import { classifySalvage } from '../src/git/salvage.ts';
import { revParse } from '../src/git/git.ts';
import { transientViolations } from '../src/git/transient.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { parseSpec } from '../src/spec/spec.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { appendSteps, contextFor, gateStep, mulBuild, setupArc } from './fixtures/unit-common.ts';
import { check, corpusArc, editPlan, filesOf } from './helpers/corpusarc.ts';
import { git, writeFiles } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';

const names = (...values: string[]) => values.map((s) => systemName(s));

test('systems are required and declared; intent/nonGoals are required on specs; traits are closed', async () => {
  const arc = await corpusArc();
  const plan = JSON.parse(readFileSync(arc.planPath, 'utf8'));
  const missing = structuredClone(plan);
  delete missing.units[0].systems;
  assert.throws(() => parsePlan(missing), /systems/);
  for (const systems of [[], ['app', 'app']]) assert.throws(() => parsePlan({ ...plan, units: [{ ...plan.units[0], systems }] }), /systems/);
  editPlan(arc, (p) => ({ ...p, units: plan.units.map((u: object) => ({ ...u, systems: ['unknown'] })) }));
  assert.match(JSON.stringify((await check(arc)).rows), /unknown.*declared system/);
  const path = absPath(join(arc.planDir, 'u1.json'));
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of ['intent', 'nonGoals']) {
    const copy = { ...spec }; delete copy[field];
    assert.throws(() => parseSpec(Buffer.from(JSON.stringify(copy)), path), new RegExp(field));
  }
  assert.throws(() => parseSpec(Buffer.from(JSON.stringify({ ...spec, nonGoals: [] })), path), /nonGoals/);
  assert.throws(() => systemsMap({ systems: { app: { paths: ['src/**'], traits: ['unknown'] } } }, 'map'), /traits/);
});

test('reach uses direct system membership, shared areas and contract consumers; traits follow actual systems', () => {
  const map = systemsMap({ systems: {
    api: { paths: ['api/**'], tests: ['test/api/**'], traits: ['redacts'] },
    store: { paths: ['store/**'], dependsOn: ['api'], traits: ['persistent'] },
  }, shared: [{ paths: ['lock.json'], dependents: ['api', 'store'] }], contracts: { 'contract.md': ['api'] } }, 'map');
  assert.equal(inUnitSystems(map, names('store'), repoPath('api/index.ts')), false, 'a dependent is not the path owner');
  assert.deepEqual(systemReach(map, names('api'), ['api/x.ts', 'test/api/x.ts', 'lock.json', 'contract.md', 'store/x.ts', 'unmapped.ts'].map((p) => repoPath(p))), ['store/x.ts', 'unmapped.ts']);
  assert.deepEqual(systemTraits(map, names('api', 'store')), ['persistent', 'redacts']);
});

test('salvage and transient share protected pinned paths; other product paths survive', async () => {
  const arc = await corpusArc();
  const corpus = filesOf(arc).corpus;
  assert.ok(corpus !== null);
  assert.ok(corpus.pin.bytes !== null && corpus.guide.bytes !== null);
  const pin = parseCorpusPin(JSON.parse(corpus.pin.bytes.toString('utf8')));
  const boundary = protectedPaths({ pin: { value: pin }, guide: { bytes: corpus.guide.bytes } });
  const pinned = `docs/corpus/${pin.files[0]!.path}`;
  writeFiles(arc.repo, { [pinned]: 'protected change\n', '.roadmap/extra.md': 'protected\n', 'docs/corpus/new.md': 'new protected file\n', 'outside/new.ts': 'product\n' });
  const classified = classifySalvage({ protectedPaths: boundary, excluded: [], rejectedRoot: absPath(join(arc.planDir, 'rejected')) }, arc.repo, revParse(arc.repo, 'HEAD'));
  assert.deepEqual(classified.approved.map((p) => p.path), ['outside/new.ts']);
  assert.deepEqual(classified.rejected.entries.map((p) => [p.path, p.reason]), [['.roadmap/extra.md', 'protected-path'], [pinned, 'protected-path'], ['docs/corpus/new.md', 'protected-path']].sort());
  assert.deepEqual(transientViolations({ protectedPaths: boundary, evidenceGlobs: [] }, [repoPath(pinned), repoPath('docs/corpus/new.md'), repoPath('.roadmap/extra.md'), repoPath('outside/new.ts')]).map((p) => [p.path, p.rule]), classified.rejected.entries.map((p) => [p.path, p.reason]));
});

test('writes beyond unit systems merge and reach the gate with intent/nonGoals', { timeout: SCENARIO_TIMEOUT_MS }, async () => {
  const d = setupArc({ steps: [] });
  const specPath = join(d.planPath, '..', 'u1.json');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  spec.intent = 'Make multiplication correct.'; spec.nonGoals = ['Do not change addition.'];
  writeFileSync(specPath, JSON.stringify(spec));
  appendSteps(d, [planCheckStep({ decision: 'approve' }), mulBuild({ 'outside/helper.js': 'export const helper = 1;\n' }), gateStep({ decision: 'approve' })]);
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.equal(git(d.repo, 'show', 'main:outside/helper.js'), 'export const helper = 1;');
    const gate = readCalls(d.scenarioPath).find((c) => c.stdin.includes('<reach>'))!;
    assert.match(gate.stdin, /<reach>\n?- outside\/helper.js/);
    for (const call of readCalls(d.scenarioPath).filter((c) => c.as === 'codex' || c.stdin.includes('<reach>'))) {
      assert.match(call.stdin, /Make multiplication correct/);
      assert.match(call.stdin, /Do not change addition/);
    }
  } finally { r.journal.close(); }
});

test('system overlap is advisory, including when units share an entire system', async () => {
  const arc = await corpusArc();
  const spec = JSON.parse(readFileSync(join(arc.planDir, 'u1.json'), 'utf8'));
  writeFileSync(join(arc.planDir, 'u2.json'), JSON.stringify({ ...spec, unit: 'u2' }));
  editPlan(arc, (p) => ({ ...p, units: [...p['units'] as object[], { id: 'u2', spec: 'u2.json', risk: 'low', systems: ['app'], resources: [] }] }));
  const report = await check(arc);
  assert.deepEqual(report.rows, []);
  assert.deepEqual(report.advisories, [{ kind: 'system-overlap', units: ['u1', 'u2'], systems: ['app'] }]);
});
