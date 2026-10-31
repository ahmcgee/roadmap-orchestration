import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandId, laneId, obligationId, sha, sha256 } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { laneDef } from '../src/core/records.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { inputShaOf } from '../src/git/reusekey.ts';
import { readCalls } from './helpers/scenario.ts';
import { ciReasons, lanePlacementReasons } from '../src/input/ci.ts';
import { parseCommand } from '../src/input/cli.ts';
import { attemptSignals } from '../src/pipeline/attempts.ts';
import { pinDispatch } from '../src/pipeline/dispatch.ts';
import { lanes } from '../src/pipeline/stages.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { witness } from '../src/commands/witness.ts';
import { externalVerdict } from '../src/holistic/external.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { captureLaunch } from '../src/pipeline/capture.ts';
import { unitSteps, moduleFiles } from './fixtures/audit-common.ts';
import { checkpointContext } from './fixtures/checkpoint-common.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { contextFor } from './fixtures/unit-common.ts';
import { DB, admitAll, keptSpec, setupUnit, started, U1, SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { git } from './helpers/repo.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS * 2 };
const lane = (extra: Record<string, unknown> = {}) => laneDef({ id: 'ci', argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, cadence: 'unit', resources: [], evidenceGlobs: [], ...extra }, 'lane');

test('ci placement: expensive/whole-repo move to candidate; shared and cross-system lanes declare milestone placement; integration unit lanes require spikes', () => {
  assert.match(lanePlacementReasons(lane({ cost: 'expensive' })).join(), /move to candidate/);
  assert.match(lanePlacementReasons(lane({ inputs: ['**'] })).join(), /move to candidate/);
  assert.deepEqual(lanePlacementReasons(lane({ cadence: 'candidate', cost: 'expensive', placement: 'local' })), []);
  assert.match(lanePlacementReasons(lane({ cadence: 'milestone', placement: 'local' })).join(), /shared-resource or cross-system/);
  assert.deepEqual(lanePlacementReasons(lane({ cadence: 'milestone', placement: 'shared-resource' })), []);
  const run = setupUnit({ steps: [], lanes: [] });
  assert.match(lanePlacementReasons(lane({ kind: 'integration' }), run.unit).join(), /except in a spike/);
  assert.deepEqual(lanePlacementReasons(lane({ kind: 'integration' }), { ...run.unit, spike: { question: 'Can this cluster run?' } }), []);
  assert.match(ciReasons({ ...run.ctx.plan(), milestones: [{ id: 'MS-1', lanes: ['missing'] }] as never }, []).join(), /unknown lane missing/);
});

test('ci reuse: explicit inputs filter ls-tree even without a systems map, including additions and removals', () => {
  const run = setupUnit({ steps: [], lanes: [] });
  const tree = () => sha(git(run.repo, 'rev-parse', 'HEAD^{tree}'));
  const l = lane({ inputs: ['src/**'], systems: ['app'], cost: 'cheap', estMin: 1 });
  const key = inputShaOf(run.ctx.repo, tree(), l, null);
  writeFileSync(join(run.repo, 'unrelated.txt'), 'elsewhere');
  git(run.repo, 'add', '.'); git(run.repo, 'commit', '-qm', 'unrelated');
  assert.equal(inputShaOf(run.ctx.repo, tree(), l, null), key);
  writeFileSync(join(run.repo, 'src/add.js'), 'changed');
  git(run.repo, 'add', '.'); git(run.repo, 'commit', '-qm', 'input');
  assert.notEqual(inputShaOf(run.ctx.repo, tree(), l, null), key);
  git(run.repo, 'rm', '-q', 'src/add.js'); git(run.repo, 'commit', '-qm', 'delete input');
  assert.notEqual(inputShaOf(run.ctx.repo, tree(), l, null), key);
});

test('ci attempts: all uncharged attempts count; plan-check excluded; M4 at 8/20 and hard cap at 16/40; chain cleanup is allowed', () => {
  const run = setupUnit({ steps: [], lanes: [] });
  for (let n = 1; n <= 7; n++) run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'build', attempt: n, outcome: 'interrupted', class: 'hold', chargeable: false });
  for (let n = 8; n < 13; n++) run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'plan-check', attempt: n, outcome: 'interrupted', class: 'hold', chargeable: false });
  assert.deepEqual(attemptSignals(run.journal, U1, true), { builds: 7, judged: 7, capped: false });
  run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'build', attempt: 13, outcome: 'interrupted', class: 'hold', chargeable: false });
  assert.deepEqual(attemptSignals(run.journal, U1, true), { builds: 8, judged: 8, capped: false });
  for (let n = 14; n <= 21; n++) run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'build', attempt: n, outcome: 'interrupted', class: 'hold', chargeable: false });
  assert.equal(attemptSignals(run.journal, U1, false).capped, false);
  assert.equal(attemptSignals(run.journal, U1, true).capped, true);
  assert.equal(run.journal.view.unit(U1).status, 'park-pending');
  attemptSignals(run.journal, U1, true);
  assert.deepEqual(run.journal.view.ciFacts().map((f) => f.kind), ['attempt-marker', 'attempt-capped']);
  assert.equal(run.journal.view.unit(U1).counters.chargeableFailures, 0);
  const stages = setupUnit({ steps: [], lanes: [] });
  for (let n = 1; n <= 40; n++) {
    stages.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'lanes', attempt: n, outcome: 'interrupted', class: 'hold', chargeable: false });
    if (n === 19) assert.equal(attemptSignals(stages.journal, U1, true).capped, false);
    if (n === 20) { attemptSignals(stages.journal, U1, true); assert.equal(stages.journal.view.ciFacts().filter((f) => f.kind === 'attempt-marker').length, 1); }
    if (n === 39) assert.equal(attemptSignals(stages.journal, U1, true).capped, false);
  }
  assert.deepEqual(attemptSignals(stages.journal, U1, true), { builds: 0, judged: 40, capped: true });
});

for (const baseGreen of [true, false]) test(`ci repeated red compares diffBase (${baseGreen ? 'green charges regression' : 'red follows base-red'})`, T, async () => {
  const command = baseGreen ? 'if grep -q BROKEN src/add.js; then echo "src/add.js:1 ASSERTION_ADD broken sum"; exit 1; fi' : 'echo "src/add.js:1 ASSERTION_ADD broken sum"; exit 1';
  const run = setupUnit({ steps: [], lanes: [{ id: 'check', argv: ['sh', '-c', command] }] });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  git(run.repo, 'checkout', '-qb', 'side');
  writeFileSync(join(run.repo, 'src/add.js'), 'BROKEN'); git(run.repo, 'add', '.'); git(run.repo, 'commit', '-qm', 'broken');
  const at = sha(git(run.repo, 'rev-parse', 'HEAD')); git(run.repo, 'checkout', '-q', 'main');
  assert.equal(started(await lanes(run.ctx, run.unit, at)).outcome.kind, 'red');
  const second = started(await lanes(run.ctx, run.unit, at));
  if (baseGreen) { assert.ok(second.fix?.kind === 'fix'); assert.match(second.fix.fix.directives.join(), /green.*diffBase/); }
  assert.equal(second.outcome.kind, baseGreen ? 'regression' : 'base-red');
  assert.equal(run.journal.view.unit(U1).decided?.chargeable, baseGreen);
  assert.ok(run.journal.view.ciFacts().some((f) => f.kind === 'lane-base-compared' && f.result === (baseGreen ? 'pass' : 'fail')));
});

test('ci external witness: root command records immutable evidence, refuses local witness, and reopens a delivered unit on fail', T, async () => {
  const h = holisticArc({ steps: unitSteps('u1', moduleFiles('mul', '*')), obligations: [{ id: 'I-1', activation: 'future', deliveredBy: ['u1'], testIds: ['ci'] }], trees: {}, mapping: [], laneExtra: { journey: { witnessClass: 'external', inputs: ['src/**'] } } });
  const run = contextFor(h.d);
  const { w } = checkpointContext(run);
  const tick = setInterval(() => w.arbiter.wake(), 20);
  try { assert.deepEqual(await runUnit(w.stage, w.stage.plan().units[0]!, admitAll), { kind: 'merged' }); } finally { clearInterval(tick); }
  assert.equal(run.journal.view.unit(w.stage.plan().units[0]!.id).status, 'retired');
  const parsed = parseCommand(['witness', 'I-1', '--result', 'pass', '--evidence', 'https://ci.example/run/1']);
  assert.equal(parsed.command, 'witness');
  const evidence = absPath(join(h.d.repo, 'ci-result.json'));
  writeFileSync(evidence, '{"passed":true}');
  const body = { type: 'witness', obligation: obligationId('I-1'), result: 'pass', evidence: 'https://ci.example/run/1', evidenceFile: null } as const;
  const out = witness(w.commands, commandId('cmd-1111111111111111'), body);
  assert.equal(out.kind, 'applied');
  const defs = holisticInForce(run.ctx).obligations!;
  const tree = sha(git(h.d.repo, 'rev-parse', `${run.ctx.plan().integrationBranch}^{tree}`));
  assert.equal(externalVerdict(run.ctx.repo, run.journal.view, tree, defs.lanes[0]!, defs.obligations[0]!), 'held');
  assert.equal(witness(w.commands, commandId('cmd-2222222222222222'), { ...body, result: 'fail' }).kind, 'applied');
  assert.equal(externalVerdict(run.ctx.repo, run.journal.view, tree, defs.lanes[0]!, defs.obligations[0]!), 'not-held');
  assert.equal(run.journal.view.unit(run.ctx.plan().units[0]!.id).status, 'active');
  assert.equal(run.journal.view.unit(run.ctx.plan().units[0]!.id).approval, null);
  assert.equal(run.journal.view.ciFacts().filter((f) => f.kind === 'external-witness').length, 2);
  const bytes = readFileSync(evidence);
  const fileBody = { ...body, evidence, evidenceFile: { path: evidence, sha256: sha256(sha256Hex(bytes)) } };
  assert.equal(witness(w.commands, commandId('cmd-3333333333333333'), fileBody).kind, 'applied');
  writeFileSync(evidence, 'changed');
  assert.equal(witness(w.commands, commandId('cmd-4444444444444444'), fileBody).kind, 'rejected');
  const local = contextFor(holisticArc({ steps: [], obligations: [{ id: 'I-1', testIds: ['ci'] }], trees: {}, mapping: [] }).d);
  assert.equal(witness(checkpointContext(local).w.commands, commandId('cmd-5555555555555555'), body).kind, 'rejected');
  assert.throws(() => parseCommand(['witness', 'I-1', '--result', 'green', '--evidence', 'x']), /pass|fail/);
});

test('ci capture requires a leased slot and preserves stack/script/state declarations', () => {
  const capture = lane({ kind: 'capture', resources: ['ports'], capture: { up: ['node', 'scripts/dev.ts'], script: ['node', 'scripts/capture.ts'], states: ['home', 'empty'], port: 'ports', portBase: 21000 } });
  assert.throws(() => captureLaunch(capture, {}, absPath('/tmp/captures')), /leased pool/);
  const launch = captureLaunch(capture, { RESOURCE_INSTANCE_PORTS: '2' }, absPath('/tmp/captures'));
  assert.equal(launch.env['ROADMAP_CAPTURE_PORT'], '21002');
  assert.equal(launch.env['ROADMAP_CAPTURE_SLOT'], '2');
  assert.deepEqual(JSON.parse(launch.env['ROADMAP_CAPTURE_STATES']!), ['home', 'empty']);
  assert.throws(() => lane({ kind: 'capture', resources: ['ports'], capture: { up: ['true'], script: ['true'], states: ['../escape'], port: 'ports' } }), /safe file names/);
});


test('ci spike delivers the gated report and retires without a candidate or integration merge', T, async () => {
  const run = setupUnit({ steps: unitSteps(U1, { ...moduleFiles('mul', '*'), 'src/add.js': 'export function add(a,b){ return a+b; }' }), resources: [DB], unit: { spike: { question: 'Can multiplication use this stack?' } } });
  const base = git(run.repo, 'rev-parse', 'main');
  assert.deepEqual(await runUnit(run.ctx, run.unit, admitAll), { kind: 'merged' });
  assert.equal(run.journal.view.unit(U1).status, 'retired');
  assert.equal(git(run.repo, 'rev-parse', 'main'), base);
  assert.equal(run.journal.view.opsOf('candidate.merge').length, 0);
  assert.equal(run.journal.view.opsOf('integration.ff').length, 0);
  assert.equal(run.journal.view.ciFacts().filter((f) => f.kind === 'spike-completed').length, 1);
  assert.ok(run.journal.view.opsOf('evidence.snapshot').length > 0);
});

for (const where of ['spec', 'suite'] as const) test(`ci capture (${where}) boots the stack on its leased port, executes the repo script and keeps screenshots for the gate`, T, async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const capture = { id: 'capture', argv: ['node', 'scripts/capture.cjs'], kind: 'capture' as const, resources: ['ports'], capture: { up: ['node', 'scripts/dev.cjs'], script: ['node', 'scripts/capture.cjs'], states: ['home', 'empty'], port: 'ports' } };
  const run = setupUnit({ steps: where === 'suite' ? unitSteps(U1, { 'src/add.js': 'export function add(a,b){ return a+b; }' }) : [],
    resourceDefs: [{ name: 'ports', pool: { size: 2 }, probe: { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } }, teardown: { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } } }],
    files: {
      'scripts/dev.cjs': "require('node:http').createServer((q,s)=>s.end('ready')).listen(Number(process.env.ROADMAP_CAPTURE_PORT), '127.0.0.1');",
      'scripts/capture.cjs': `const fs=require('node:fs'),path=require('node:path'); (async()=>{ for(let n=0;n<200;n++){ try { const r=await fetch('http://127.0.0.1:'+process.env.ROADMAP_CAPTURE_PORT); if(r.ok) break; }catch{} await new Promise(r=>setTimeout(r,10)); if(n===199) process.exit(2); } for(const state of JSON.parse(process.env.ROADMAP_CAPTURE_STATES)) fs.writeFileSync(path.join(process.env.ROADMAP_CAPTURE_DIR,state+'.png'),Buffer.from('${png}','base64')); })();`,
    },
    lanes: where === 'spec' ? [capture] : [], suite: where === 'suite' ? [capture] : [],
  });
  pinDispatch(run.ctx, run.unit, keptSpec(run.journal));
  let output: string;
  if (where === 'suite') {
    assert.deepEqual(await runUnit(run.ctx, run.unit, admitAll), { kind: 'merged' });
    const call = readCalls(run.scenario.path).find((c) => c.stdin.includes('<lane_ledger>') && c.stdin.includes('- capture: pass'));
    assert.ok(call, 'the gate receives capture evidence from the suite');
    const snapshot = run.journal.view.opsOf('evidence.snapshot').find((i) => i.expect.globs.includes(repoPattern('captures/**')));
    assert.ok(snapshot); output = join(snapshot.expect.dest, 'files');
  } else {
    const done = started(await lanes(run.ctx, run.unit, run.base));
    assert.equal(done.outcome.kind, 'green'); output = done.ledger[0]!.fixDirs[0]!;
  }
  for (const state of ['home', 'empty']) assert.equal(readFileSync(join(output, 'captures', state+'.png')).toString('base64'), png);
  assert.ok([...run.journal.view.resources().values()].every((r) => r.status.state === 'free'));
});
