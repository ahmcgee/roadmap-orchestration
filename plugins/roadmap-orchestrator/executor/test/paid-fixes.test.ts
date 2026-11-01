import {DEV_CELLS} from '../evals/roles/gate/cells.ts';
import {buildFixture} from '../evals/roles/gate/fixture.ts';
import {setupGateArc} from '../evals/roles/gate/arc.ts';
import {contextFor, stepUntil} from './fixtures/unit-common.ts';
import {repositoryPaths} from '../evals/m4a/transcript.ts';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import * as schemas from '../src/prompts/schemas.ts';
import {SMOKE_SCHEMA} from '../src/preflight/smoke.ts';
import {schemaViolation} from '../src/backends/adapter.ts';
import {gradeSurfaceTrial, referenceAnswer, runSurface} from '../evals/roles/surface/run.ts';
import {hasInspection, readTranscript} from '../evals/roles/transcript.ts';
import {tmpDir} from './helpers/repo.ts';
import {judgmentSessionProblems} from '../evals/m1/check.ts';
import {backendArgv, freshJudgmentSession, resumedJudgmentSession} from '../src/backends/argv.ts';
import {routingRev, unitId} from '../src/core/ids.ts';
import {absPath} from '../src/core/values.ts';
import {writeLaunch} from './helpers/scenario.ts';
import {runPool} from '../evals/roles/pool.ts';

// Role schemas (including both experience variants) and health checks are every production output schema.
test('backend output schemas all have an explicit top-level object type', () => {
  const built = {...Object.fromEntries(Object.entries(schemas).filter(([name]) => name.endsWith('_SCHEMA'))), SMOKE_SCHEMA};
  for (const [name, schema] of Object.entries(built)) assert.equal((schema as {type?: unknown}).type, 'object', name);
  for (const [role, schema] of Object.entries(schemas.ROLE_SCHEMAS)) assert.ok(Object.values(built).includes(schema), role);
});

test('gate schema and parser agree on decision/directives, approval blockers, ordering and finding ids', () => {
  const base = referenceAnswer('pre-build', false) as Record<string, unknown>;
  for (const decision of ['approve', 'revise', 'escalate']) for (const directives of [[], ['Fix src/unit.js:1']]) {
    const value = {...base, decision, directives};
    const valid = decision === 'revise' ? directives.length > 0 : directives.length === 0;
    assert.equal(schemaViolation(schemas.GATE_SCHEMA, value) === null, valid, JSON.stringify(value));
    if (valid) assert.doesNotThrow(() => schemas.validateGateOutput(value));
    else assert.throws(() => schemas.validateGateOutput(value));
  }
  const {premises: _premises, ...missingPremises} = base;
  assert.match(schemaViolation(schemas.GATE_SCHEMA, missingPremises)!, /premises/);
  const note = (referenceAnswer('pre-build', true) as {findings: object[]}).findings[0]!;
  for (const value of [
    {...base, findings: [{...note, severity: 'blocking'}]},
    {...base, ordering: {blockers: ['u2']}},
    {...base, findings: [{...note, reraises: 'arc/136#1:2'}]},
  ]) {
    assert.notEqual(schemaViolation(schemas.GATE_SCHEMA, value), null);
    assert.throws(() => schemas.validateGateOutput(value));
  }
});

test('malformed surface trial is void and a subsequent trial still grades', () => {
  const malformed = {...referenceAnswer('pre-build', false) as object, directives: ['Fix it']};
  const graded = gradeSurfaceTrial('pre-build', false, malformed);
  assert.equal(graded.pass, false);
  assert.match(graded.void!, /directives/);
  assert.deepEqual(gradeSurfaceTrial('pre-build', false, referenceAnswer('pre-build', false)), {pass: true, void: null});
});

test('clean audit witness executes all sign quadrants and rejects a sign-from-first-operand mutant', async () => {
  const out = tmpDir('surface-clean');
  await runSurface(['campaignAudit', '--set', 'dev', '--n', '1', '--dry-run', '--out', out]);
  const cwd = join(out, 'clean-0/checkout');
  const {NODE_TEST_CONTEXT: _context, ...env} = process.env;
  const run = () => spawnSync(process.execPath, ['--test', 'test/unit.test.js'], {cwd, env, encoding: 'utf8'});
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  writeFileSync(join(cwd, 'src/unit.js'), 'export function mul(a,b) { return a<0 ? -Math.abs(a*b) : Math.abs(a*b); }');
  assert.equal(run().status, 1);
});

test('verifier shell inspection counts and corpus trials run a real source-free witness lane', async () => {
  for (const name of ['Bash', 'Read', 'Grep', 'Glob']) {
    assert.equal(hasInspection(readTranscript([{type: 'assistant', message: {content: [{type: 'tool_use', id: 'read', name, input: {command: 'cat src/unit.js'}}]}}])), true);
  }
  assert.equal(hasInspection(readTranscript([])), false);
  const cell = DEV_CELLS.find((c) => c.id === 'C3')!;
  const fixture = buildFixture(cell, {seed: 'paid-fixes', trial: 0, size: 150, scratch: tmpDir('witness-scratch')});
  const descriptor = setupGateArc(fixture, 'approve-all', 'med');
  const run = contextFor(descriptor);
  try {
    const obligations = JSON.parse(readFileSync(join(run.ctx.planDir, 'obligations.json'), 'utf8')) as {lanes: {argv: string[]; reporter: string}[]};
    const lane = obligations.lanes[0]!;
    for (const needle of repositoryPaths()) assert.ok(!JSON.stringify(lane).includes(needle), needle);
    assert.equal(lane.reporter, 'node-test');
    assert.deepEqual(lane.argv, ['node', '--test', 'packages/*/test/vessel-export.test.ts']);
    await stepUntil(run, 'u1', (f) => f.stage === 'gate');
    assert.equal(run.journal.view.unit(unitId('u1')).decided!.outcome, 'approve');
    const observations = run.journal.view.holistic().witnessed;
    assert.ok(observations.length > 0, 'the production witness stage certified the real test');
  } finally {run.journal.close();}
});

test('M1 judgment independence permits exactly one own repair and rejects session/cwd/schema/parent reuse', () => {
  const dir = tmpDir('judgment-check'), session = freshJudgmentSession();
  const triple = {backend: 'claude', model: 'claude-opus-5-5', effort: 'medium'} as const;
  const parent = {type: 'stage', unit: unitId('u1'), stage: 'gate', attempt: 1} as const;
  const launch = (repair: boolean) => {
    const chosen = repair ? resumedJudgmentSession(session.id) : session;
    return writeLaunch(tmpDir('judgment-inv'), {cwd: dir, stdinPath: null,
      argv: backendArgv({kind: 'claude-judgment', role: 'verifier', triple, session: chosen, schemaText: '{}', system: '', evidenceDirs: []}),
      terminal: {type: 'backend', purpose: 'backend', role: 'verifier', routingRev: routingRev('a'.repeat(16)), session: chosen, schemaPath: absPath(join(dir, 'schema.json')), outputPath: absPath(join(dir, 'stdout'))},
    });
  };
  const fresh = {inv: 'first', parent, launch: launch(false)}, repair = {inv: 'repair', parent, launch: launch(true)};
  assert.deepEqual(judgmentSessionProblems([fresh, repair]), []);
  const terminal = repair.launch.terminal;
  assert.equal(terminal.type, 'backend');
  if (terminal.type !== 'backend') throw new Error('expected backend');
  for (const calls of [
    [repair], [fresh, repair, repair], [fresh, {...fresh, inv: 'new-judgment'}],
    [fresh, {...repair, parent: {...parent, attempt: 2}}],
    [fresh, {...repair, launch: {...repair.launch, cwd: absPath('/another-checkout')}}],
    [fresh, {...repair, launch: {...repair.launch, terminal: {...terminal, schemaPath: absPath('/another-schema')}}}],
    [fresh, {...repair, launch: {...repair.launch, argv: fresh.launch.argv}}],
  ]) assert.ok(judgmentSessionProblems(calls).length > 0);
});


test('surface runner records a malformed paid-shape output and continues all trials through a fake CLI', () => {
  const root = tmpDir('surface-cli'), bin = join(root, 'bin'), out = join(root, 'out');
  mkdirSync(bin);
  const good = referenceAnswer('pre-build', true);
  const bad = {...referenceAnswer('pre-build', false) as object, directives: ['Not legal with approve']};
  const fake = join(bin, 'claude');
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => {\nconst answer = process.cwd().includes('clean-0') ? ${JSON.stringify(bad)} : ${JSON.stringify(good)};\nprocess.stdout.write(JSON.stringify({type:'result', structured_output:answer, total_cost_usd:0.25})+'\\n');\n});\n`);
  chmodSync(fake, 0o755);
  const {NODE_TEST_CONTEXT: _context, ...env} = process.env;
  const result = spawnSync(process.execPath, ['evals/roles/run.ts', 'pre-build', '--set', 'dev', '--n', '1', '--out', out], {env: {...env, PATH: `${bin}:${env['PATH']}`}, encoding: 'utf8'});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as {rows: {pass: boolean; void: string | null}[]; spent: number};
  assert.equal(summary.rows.length, 3);
  assert.match(summary.rows[0]!.void!, /directives/);
  assert.deepEqual(summary.rows.slice(1).map((r) => r.pass), [true, true]);
  assert.equal(summary.spent, 0.75);
});

test('role eval cap stops new trials and accounts for already in-flight trials', async () => {
  const result = await runPool([1, 2, 3], {parallel: 2, cap: 1, spent: (rows: readonly number[]) => rows.reduce((a, b) => a + b, 0), trial: async () => 2, log: () => {}});
  assert.deepEqual(result, {rows: [2, 2], notStarted: 1});
});


test('experience schema preserves the mode/verdict discriminant', () => {
  const polish = {final: true, decision: 'drop', evidence: ['comparison.txt'], reasons: ['No improvement'], premises: []};
  const value = {final: true, mode: 'polish', verdict: polish};
  assert.equal(schemaViolation(schemas.EXPERIENCE_SCHEMA, value), null);
  assert.doesNotThrow(() => schemas.validateExperienceOutput(value));
  const wrongMode = {...value, mode: 'walkthrough'};
  assert.notEqual(schemaViolation(schemas.EXPERIENCE_SCHEMA, wrongMode), null);
  assert.throws(() => schemas.validateExperienceOutput(wrongMode));
});
