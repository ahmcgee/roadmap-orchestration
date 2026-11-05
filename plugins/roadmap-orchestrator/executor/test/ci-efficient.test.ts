import { recover } from '../src/recover/recover.ts';
import { wire } from './fixtures/publish-common.ts';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { commandId, laneId, obligationId, sha, sha256, unitId } from '../src/core/ids.ts';
import { sha256Hex } from '../src/core/json.ts';
import { laneDef } from '../src/core/records.ts';
import { absPath, repoPattern } from '../src/core/values.ts';
import { inputShaOf } from '../src/git/reusekey.ts';
import { readCalls } from './helpers/scenario.ts';
import { ciReasons, lanePlacementReasons } from '../src/input/ci.ts';
import { parseCommand } from '../src/input/cli.ts';
import { attemptSignals } from '../src/pipeline/attempts.ts';
import { pinDispatch, unitWorktree } from '../src/pipeline/dispatch.ts';
import { lanes } from '../src/pipeline/stages.ts';
import { haltResult, runUnit } from '../src/pipeline/unit.ts';
import { witness } from '../src/commands/witness.ts';
import { externalVerdict } from '../src/holistic/external.ts';
import { holisticInForce } from '../src/pipeline/stages.ts';
import { captureLaunch } from '../src/pipeline/capture.ts';
import { unitSteps, moduleFiles } from './fixtures/audit-common.ts';
import { checkpointContext } from './fixtures/checkpoint-common.ts';
import { holisticArc } from './fixtures/brake-common.ts';
import { applyBody, contextFor, codexStep, gateStep, mulBuild, setupArc, syncInputs } from './fixtures/unit-common.ts';
import { DB, admitAll, planCheckStep, keptSpec, setupUnit, started, U1, SCENARIO_TIMEOUT_MS } from './fixtures/stage-common.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { readNeedsUser } from '../src/needsuser.ts';
import { intents } from './fixtures/invoke-specs.ts';
import { milestoneJson } from './fixtures/walk-common.ts';


const T = { timeout: SCENARIO_TIMEOUT_MS * 2 };
const lane = (extra: Record<string, unknown> = {}) => laneDef({ id: 'ci', argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, cadence: 'unit', resources: [], evidenceGlobs: [], ...extra }, 'lane');

test('ci placement: expensive/whole-repo move to candidate; shared and cross-system lanes declare milestone placement; integration unit lanes require spikes', () => {
  assert.match(lanePlacementReasons(lane({ cost: 'expensive' })).join(), /move to candidate/);
  assert.match(lanePlacementReasons(lane({ inputs: ['**'] })).join(), /move to candidate/);
  assert.deepEqual(lanePlacementReasons(lane({ cadence: 'candidate', cost: 'expensive', placement: 'local' })), []);
  assert.match(lanePlacementReasons(lane({ cadence: 'batch', placement: 'local' })).join(), /shared-resource or cross-system/);
  assert.deepEqual(lanePlacementReasons(lane({ cadence: 'batch', placement: 'shared-resource' })), []);
  assert.throws(() => lane({ estMin: 1 }), /estMin/);
  assert.throws(() => lane({ kind: 'integration' }), /capture/);
  assert.throws(() => lane({ cadence: 'milestone' }), /batch/);
  const run = setupUnit({ steps: [], lanes: [] });
  assert.deepEqual(lanePlacementReasons(lane({ cadence: 'candidate', cost: 'expensive', placement: 'local' }), run.unit), []);
  assert.match(lanePlacementReasons(lane({ placement: 'shared-resource' }), run.unit).join(), /except in a spike/);
  assert.deepEqual(lanePlacementReasons(lane({ placement: 'shared-resource' }), { ...run.unit, spike: { question: 'Can this cluster run?' } }), []);
  assert.match(ciReasons({ ...run.ctx.plan(), milestones: [{ id: 'MS-1', lanes: ['missing'] }] as never }, []).join(), /unknown lane missing/);
});

test('ci reuse: explicit inputs filter ls-tree even without a systems map, including additions and removals', () => {
  const run = setupUnit({ steps: [], lanes: [] });
  const tree = () => sha(git(run.repo, 'rev-parse', 'HEAD^{tree}'));
  const l = lane({ inputs: ['src/**'], systems: ['app'], cost: 'cheap' });
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

test('ci attempts: all uncharged attempts count; plan-check excluded; M4 at 8/20 and hard cap at 16/40; chain cleanup is allowed', async () => {
  const run = setupUnit({ steps: [], lanes: [] });
  for (let n = 1; n <= 7; n++) run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'build', attempt: n, outcome: 'interrupted', class: 'hold', chargeable: false });
  for (let n = 8; n < 13; n++) run.journal.fact({ kind: 'stage-outcome', unit: U1, stage: 'pre-build', attempt: n, outcome: 'interrupted', class: 'hold', chargeable: false });
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
  const replayed = haltResult(stages.ctx, stages.unit);
  assert.deepEqual(await runUnit(stages.ctx, stages.unit, admitAll), replayed, 'live and restarted caps return the same blocking owner item');
  assert.equal(replayed?.needsUser?.blocking, true);
  assert.equal(replayed?.needsUser?.reason, 'attempt-cap');
  stages.journal.fact({ kind: 'steered', unit: U1, command: commandId('cmd-aaaaaaaaaaaaaaaa'), brief: sha256('0'.repeat(64)), budgetMin: 1, resume: true });
  assert.equal(stages.journal.view.unit(U1).status, 'active');
  assert.deepEqual(await runUnit(stages.ctx, stages.unit, admitAll), replayed, 'a root-reactivated unit over its cap still returns a park, never null');
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
  if (!baseGreen) {
    assert.equal(second.fix, null, 'no further fix round for the base red');
    assert.equal(second.next.kind, 'stage');
    const notice = run.journal.view.opsOf('needsuser.raise').map((i) => readNeedsUser(run.runDir, i.expect.id)).find((n) => n?.reason === 'base-red')!;
    assert.deepEqual(notice.subject, { type: 'arc' });
    const payload = JSON.parse(notice.recommendation.match(/\{"knownDefects".*\}/)![0]);
    assert.deepEqual(payload.knownDefects, [{ id: 'K-1', match: { type: 'output', lane: 'check', contains: 'src/add.js:<n> ASSERTION_ADD broken sum' }, fixUnit: 'root-named-fix-unit' }]);
    const prior = run.journal.view.opsOf('proc.spawn').length;
    assert.equal(started(await lanes(run.ctx, run.unit, at)).outcome.kind, 'base-red');
    assert.equal(run.journal.view.opsOf('proc.spawn').length - prior, 1, 'one lane execution, no diagnostic or repeated base comparison');
  }
  if (baseGreen) {
    assert.equal(started(await lanes(run.ctx, run.unit, at)).outcome.kind, 'regression');
    const comparisons = run.journal.view.ciFacts().filter((f) => f.kind === 'lane-base-compared');
    assert.equal(comparisons.length, 2);
    assert.ok(comparisons.every((f) => f.kind === 'lane-base-compared' && existsSync(f.evidence)));
    assert.equal(comparisons[0]!.kind === 'lane-base-compared' && comparisons[0]!.evidence, comparisons[1]!.kind === 'lane-base-compared' && comparisons[1]!.evidence, 'a cached comparison keeps the original evidence directory');
  }
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
  const body = { type: 'witness', obligation: obligationId('I-1'), expectedHead: sha(git(h.d.repo, 'rev-parse', run.ctx.plan().integrationBranch)), result: 'pass', evidence: 'https://ci.example/run/1', evidenceFile: null } as const;
  assert.equal(witness(w.commands, commandId('cmd-0000000000000000'), { ...body, expectedHead: sha('0'.repeat(40)) }).kind, 'rejected');
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
  assert.equal(witness(w.commands, commandId('cmd-3333333333333333'), fileBody).kind, 'applied', 'replay consumes the durable result after the original file changes');
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
  for (const changed of [true, false]) {
  const run = setupUnit({ steps: changed ? unitSteps(U1, { ...moduleFiles('mul', '*'), 'src/add.js': 'export function add(a,b){ return a+b; }' }) : [planCheckStep({ decision: 'approve' }), codexStep([]), gateStep({ decision: 'approve' })], ...(changed ? {} : { lanes: [{ id: 'experiment', argv: ['true'], placement: 'shared-resource', resources: [DB] }] }), resources: [DB], unit: { spike: { question: 'Can multiplication use this stack?' } } });
  const base = git(run.repo, 'rev-parse', 'main');
  assert.deepEqual(await runUnit(run.ctx, run.unit, admitAll), { kind: 'merged' });
  assert.equal(run.journal.view.unit(U1).status, 'retired');
  const calls = readCalls(run.scenario.path);
  assert.ok(calls.some((c) => c.stdin.includes('Question: Can multiplication use this stack?')));
  assert.ok(calls.some((c) => c.stdin.includes('The report and its evidence are the deliverable')));
  assert.equal(git(run.repo, 'rev-parse', 'main'), base);
  assert.equal(run.journal.view.opsOf('candidate.merge').length, 0);
  assert.equal(existsSync(unitWorktree(run.ctx.plan().worktreeRoot, run.ctx.plan().arc, U1)), false, 'spike checkouts are removed after their evidence is kept');
  assert.equal(run.journal.view.opsOf('integration.ff').length, 0);
  assert.equal(run.journal.view.ciFacts().filter((f) => f.kind === 'spike-completed').length, 1);
  assert.ok(run.journal.view.opsOf('evidence.snapshot').length > 0);
  }
});

for (const where of ['spec', 'suite'] as const) for (const designCited of [false, true]) test(`ci capture (${where}, design=${designCited}) boots the stack on its leased port, executes the repo script and keeps screenshots for the gate`, T, async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const capture = { id: 'capture', argv: ['node', 'scripts/capture.cjs'], kind: 'capture' as const, resources: ['ports'], capture: { up: ['node', 'scripts/dev.cjs'], script: ['node', 'scripts/capture.cjs'], states: ['home', 'empty'], port: 'ports' } };
  const h = holisticArc({ steps: unitSteps(U1, { 'src/add.js': 'export function add(a,b){ return a+b; }' }),
    obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [], trees: { '*': { outcomes: { t1: 'pass' } } },
    units: [{ id: U1, lanes: where === 'spec' ? [capture] : [] }], suite: where === 'suite' ? [capture] : [],
    planExtra: {
      resources: [{ name: 'ports', pool: { size: 2 }, probe: { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } }, teardown: { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } } }],
      ...(designCited ? { milestones: [milestoneJson({ references: ['contracts'], bringUp: { setup: [], serve: [], env: {}, seed: [] }, journeys: [{ id: 'J-1', text: 'Read the captured states.', via: 'shell', entry: 'node --version', budget: null }] })] } : {}),
    },
    beforeStart: (d) => {
      mkdirSync(join(d.repo, 'scripts'), { recursive: true });
      writeFileSync(join(d.repo, 'scripts/dev.cjs'), "require('node:http').createServer((q,s)=>s.end('ready')).listen(Number(process.env.ROADMAP_CAPTURE_PORT), '127.0.0.1');");
      writeFileSync(join(d.repo, 'scripts/capture.cjs'), `const fs=require('node:fs'),path=require('node:path'); (async()=>{ for(let n=0;n<200;n++){ try { const r=await fetch('http://127.0.0.1:'+process.env.ROADMAP_CAPTURE_PORT); if(r.ok) break; }catch{} await new Promise(r=>setTimeout(r,10)); if(n===199) process.exit(2); } for(const state of JSON.parse(process.env.ROADMAP_CAPTURE_STATES)) fs.writeFileSync(path.join(process.env.ROADMAP_CAPTURE_DIR,state+'.png'),Buffer.from('${png}','base64')); })();`);
      git(d.repo, 'add', '.'); git(d.repo, 'commit', '-qm', 'capture stack and repo script');
      const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
      writeFileSync(d.planPath, JSON.stringify({ ...plan, baseline: git(d.repo, 'rev-parse', 'main') }));
    },
  });
  const run = contextFor(h.d);
  assert.deepEqual(await runUnit(run.ctx, run.unit(U1), admitAll), { kind: 'merged' });
  assert.equal(run.journal.view.completedLanesOutcome(U1)?.outcome, 'green');
  const call = readCalls(h.d.scenarioPath).find((c) => c.stdin.includes('<lane_ledger>'));
  assert.ok(call, 'the gate ran');
  assert.equal(call.stdin.includes('- capture: pass'), designCited, 'only a design-cited gate receives capture evidence');
  const snapshot = run.journal.view.opsOf('evidence.snapshot').find((i) => i.expect.globs.includes(repoPattern('captures/**')));
  assert.ok(snapshot);
  assert.equal(call.stdin.includes(join(snapshot.expect.dest, '..')), designCited, 'capture evidence directories follow the design citation');
  const output = join(snapshot.expect.dest, 'files');
  for (const state of ['home', 'empty']) assert.equal(readFileSync(join(output, 'captures', state+'.png')).toString('base64'), png);
  assert.ok([...run.journal.view.resources().values()].every((r) => r.status.state === 'free'));
});

test('ci candidate spec lane runs on the candidate containing the current tip with spec/unit attribution', T, async () => {
  const run = setupUnit({
    steps: unitSteps(U1, { 'src/add.js': 'export function add(a,b){ return a+b; }' }),
    lanes: [{ id: 'tip-check', cadence: 'candidate', cost: 'expensive', placement: 'local', argv: ['sh', '-c', 'test -f tip-only.txt && grep -q "a+b" src/add.js && git rev-parse HEAD'] }],
  });
  let tip = '';
  assert.deepEqual(await runUnit(run.ctx, run.unit, async (next) => {
    if (next.stage === 'candidate') {
      writeFileSync(join(run.repo, 'tip-only.txt'), 'a peer published this after the gate');
      git(run.repo, 'add', '.'); git(run.repo, 'commit', '-qm', 'peer tip');
      tip = git(run.repo, 'rev-parse', 'main');
    }
    return true;
  }), { kind: 'merged' });
  const spawns = intents(run.runDir, 'proc.spawn').flatMap((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'lane' && i.expect.subject.lane === 'tip-check' ? [i] : []);
  assert.equal(spawns.length, 1, 'no unit-cadence execution');
  const spawn = spawns[0]!;
  const candidate = run.journal.view.opsOf('candidate.merge')[0]!;
  assert.equal(candidate.expect.integrationTip, tip);
  assert.deepEqual(spawn.parent, candidate.parent);
  assert.ok(spawn.expect.subject.purpose === 'lane');
  assert.equal(spawn.expect.subject.set, 'spec');
  assert.equal(spawn.expect.subject.at, candidate.post.new);
  assert.equal(git(run.repo, 'rev-parse', 'main'), candidate.post.new);
});

test('ci spike apply refuses a new resource and durably raises a blocking owner request', T, async () => {
  const h = holisticArc({ steps: [], obligations: [{ id: 'I-1', testIds: ['ci'] }], trees: {}, mapping: [] });
  const run = contextFor(h.d);
  const { w } = checkpointContext(run);
  syncInputs(run);
  const plan = JSON.parse(readFileSync(h.d.planPath, 'utf8'));
  plan.resources.push({ name: 'new-cluster', probe: { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } }, teardown: { argv: ['true'], cwd: '.', env: { set: {}, pass: ['PATH'] } } });
  plan.units[0].resources = ['new-cluster'];
  plan.units[0].spike = { question: 'Does this new cluster work?' };
  writeFileSync(h.d.planPath, JSON.stringify(plan));
  const command = submitCommand(run.ctx.runDir, run.journal.view.arc, applyBody(h.d));
  const out = await applyCommand(w.commands, command);
  assert.equal(out.kind, 'rejected');
  assert.ok(out.kind === 'rejected' && /spike resource new-cluster is new/.test(out.reason));
  const requests = run.journal.view.opsOf('needsuser.raise').map((i) => readNeedsUser(run.ctx.runDir, i.expect.id)).filter((n) => n?.reason === 'owner-request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.blocking, true);
  assert.equal(run.ctx.plan().resources.some((r) => r.name === 'new-cluster'), false);
  assert.deepEqual(await applyCommand(w.commands, command), out);
  assert.equal(run.journal.view.opsOf('needsuser.raise').length, 1, 'replay does not duplicate the request');
});

test('ci candidate spec red reaches the delivering unit fix round with its evidence', T, async () => {
  const run = setupUnit({
    steps: [...unitSteps(U1, { 'src/add.js': '/* BROKEN */ export function add(a,b){ return a-b; }' }),
      { ...codexStep([{ type: 'commit', message: 'fix candidate check', files: { 'src/add.js': 'export function add(a,b){ return a+b; }' } }]), unit: U1 }, { ...gateStep({ decision: 'approve' }), unit: U1 }],
    lanes: [{ id: 'candidate-proof', cadence: 'candidate', cost: 'expensive', argv: ['sh', '-c', '! grep -q BROKEN src/add.js'] }],
  });
  assert.deepEqual(await runUnit(run.ctx, run.unit, admitAll), { kind: 'merged' });
  const call = readCalls(run.scenario.path).filter((c) => c.as === 'codex').at(-1);
  assert.ok(call, 'candidate red resumes the delivering builder');
  assert.match(call.stdin, /candidate-proof/);
  assert.match(call.stdin, /candidate\/_spec/);
  assert.equal(run.journal.view.unit(U1).counters.candidateReds, 1);
});

test('ci noRerunPatterns is optional, literal and rejects empty patterns', () => {
  assert.equal(lane().noRerunPatterns, undefined);
  assert.deepEqual(lane({ noRerunPatterns: ['G104', 'compile error'] }).noRerunPatterns, ['G104', 'compile error']);
  assert.throws(() => lane({ noRerunPatterns: [''] }), /noRerunPatterns/);
  assert.throws(() => lane({ noRerunPatterns: [] }), /noRerunPatterns/);
});

test('ci candidate suite keeps one arc checkout and ignored caches across different units; unit verification retires', T, async () => {
  const hits = join(tmpDir('candidate-cache'), 'hits');
  const d = setupArc({ units: [{ id: 'u1' }, { id: 'u2' }], suite: [{ id: 'cache', cadence: 'candidate', argv: ['sh', '-c', `if test -f out/cache; then echo hit >> '${hits}'; else echo miss >> '${hits}'; fi; mkdir -p out; echo cache > out/cache`] }],
    steps: [
      { ...mulBuild(), unit: 'u1' }, { ...gateStep({ decision: 'approve' }), unit: 'u1' },
      { ...mulBuild({ 'src/second.js': 'export const second = true;\n' }), unit: 'u2' }, { ...gateStep({ decision: 'approve' }), unit: 'u2' },
    ] });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), admitAll), { kind: 'merged' });
    assert.equal(readFileSync(hits, 'utf8'), 'miss\nhit\n');
    const creates = r.journal.view.opsOf('worktree.create').filter((i) => i.expect.path.endsWith('/.candidate.verify'));
    assert.equal(creates.length, 2);
    assert.equal(new Set(creates.map((i) => i.expect.path)).size, 1);
    assert.deepEqual(creates.map((i) => i.expect.reset), [undefined, true], 'first add keeps its original recovery protocol; the next unit resets');
    for (const id of ['u1', 'u2']) assert.equal(existsSync(join(r.ctx.plan().worktreeRoot, d.arc, `${id}.verify`)), false, 'unit verification removed at retirement');
  } finally { r.journal.close(); }
});

test('ci reset permission residue parks the unit with paths and ownership fix, leaving a recoverable intent', T, async () => {
  const fix = codexStep([{ type: 'commit', message: 'fix dirt', files: { 'src/other.js': 'export const other = true;\n' } }], { argv: ['exec', 'resume'] });
  const d = setupArc({ units: [{ id: 'u1', lanes: [{ id: 'locked', argv: ['sh', '-c', 'mkdir -p locked; echo residue > locked/file; chmod 555 locked'] }] }], suite: [], steps: [mulBuild(), fix] });
  const r = contextFor(d);
  const locked = join(r.ctx.plan().worktreeRoot, d.arc, 'u1.verify', 'locked');
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.equal(result.kind, 'parked');
    if (result.kind !== 'parked') throw new Error('permission failure did not park');
    assert.equal(result.needsUser.reason, 'residue');
    assert.match(result.needsUser.summary, /locked\/file/);
    assert.match(result.needsUser.recommendation, /sudo chown -R/);
    assert.equal(r.journal.view.unit(unitId('u1')).decided?.outcome, 'checkout-residue');
    assert.ok(r.journal.view.openIntents().some((i) => i.kind === 'worktree.create' && i.expect.reset === true));
    assert.ok(r.journal.view.opsOf('needsuser.raise').some((i) => readNeedsUser(r.ctx.runDir, i.expect.id)?.reason === 'residue'));
    const w = wire(r);
    const blocked = await recover(w);
    assert.ok(blocked.parked.length > 0, 'recovery redo also parks the permission failure');
    chmodSync(locked, 0o755);
    const fixed = await recover(w);
    assert.deepEqual(fixed.parked, [], 'restoring permissions lets recovery finish the same intent');
    assert.equal(r.journal.view.openIntents().length, 0);

  } finally { if (existsSync(locked)) chmodSync(locked, 0o755); r.journal.close(); }
});
