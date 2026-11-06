import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { runDir } from '../../src/input/cli.ts';
import { gitCommonDir,runChecks } from '../../src/preflight/checks.ts';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyCommand } from '../../src/commands/apply.ts';
import { submitCommand } from '../../src/commands/queue.ts';
import { keptPayload, inputPath, REVISION_INPUT } from '../../src/input/inforce.ts';
import { parseRevisionPayload } from '../../src/core/events.ts';
import { recover } from '../../src/recover/recover.ts';
import { tmpDir } from '../helpers/repo.ts';
import { wire } from '../fixtures/publish-common.ts';
import { type ArcDescriptor, contextFor, applyBody, syncInputs, setupArc } from '../fixtures/unit-common.ts';
// Pin a real previous executor: it must write the state this release adopts.
const PREVIOUS_RELEASE = '1.0.0-dev.44';
const PREVIOUS_REF = '12d943594af72d5070668e40cbc758e5314e93ef';
const LEGACY_PUBLICATION_RELEASE = '1.0.0-dev.41';
const LEGACY_PUBLICATION_REF = '82887487052bba7235f16b73d0fd22d82b6d9b48';
// Keep the one-off dev.33 schema-2 cut refusal as a separate regression.
const PRE_SCHEMA_2_RELEASE = '1.0.0-dev.32';
test('upgrade.previous-schema: startup refuses schema 1 loudly before claiming or recovering', async () => {
  const d = setupArc({steps: []});
  const dir = runDir(gitCommonDir(absPath(d.repo)), arcId(d.arc));
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'start.json'), JSON.stringify({v: 1, release: PRE_SCHEMA_2_RELEASE}));
  let claimed = false;
  const result = await runChecks({repo: absPath(d.repo), planFile: absPath(d.planPath), profile: 'default', hostDir: absPath(d.hostDir), env: process.env, respawn: null,
    claim: async () => {claimed = true; throw new Error('must refuse before claim');}});
  assert.equal(result.kind, 'refused');
  if (result.kind !== 'refused') throw new Error('schema 1 was adopted');
  assert.equal(claimed, false);
  assert.equal(result.rejections[0]?.kind, 'schema-version');
  assert.match(JSON.stringify(result.rejections), /schema 1.*requires schema 2.*original executor/);
});


test('upgrade.previous-release: dev.41 publication state is read, recovered and extended without rewriting kept bytes', {timeout: 120_000}, async () => {
  const root = tmpDir('previous-executor');
  const relative = 'plugins/roadmap-orchestrator/executor';
  const sourceRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: import.meta.dirname, encoding: 'utf8'}).trim();
  const archive = join(root, 'previous.tar');
  execFileSync('git', ['archive', '-o', archive, LEGACY_PUBLICATION_REF, relative], {cwd: sourceRoot});
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const previous = join(root, relative);
  assert.equal(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8')).version, LEGACY_PUBLICATION_RELEASE);
  const moduleUrl = (path: string) => pathToFileURL(join(previous, path)).href;
  const script = `
    import {publishArc, wire} from ${JSON.stringify(moduleUrl('test/fixtures/publish-common.ts'))};
    import {contextFor, applyBody, syncInputs} from ${JSON.stringify(moduleUrl('test/fixtures/unit-common.ts'))};
    import {applyCommand} from ${JSON.stringify(moduleUrl('src/commands/apply.ts'))};
    import {submitCommand} from ${JSON.stringify(moduleUrl('src/commands/queue.ts'))};
    import {readFileSync, writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const d = publishArc({steps: []});
    const r = contextFor(d), w = wire(r);
    const timer = setInterval(() => w.arbiter.wake(), 20);
    try {
      syncInputs(r);
      const ledger = join(d.planPath, '..', 'rulings.md');
      writeFileSync(ledger, readFileSync(ledger, 'utf8') + 'C-2 — finite inputs only.\\n');
      const outcome = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d)));
      if (outcome.kind !== 'applied') throw new Error(JSON.stringify(outcome));
      // Transfer this test helper's temporary-directory cleanup to the parent, which owns TMPDIR.
      process.removeAllListeners('exit');
      process.stdout.write(JSON.stringify(d));
    } finally {clearInterval(timer); r.journal.close();}
  `;
  const d = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8', timeout: 90_000, env: {...process.env, TMPDIR: root}})) as ArcDescriptor;
  const r = contextFor(d), w = wire(r);
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => {warnings.push(warning);};
  process.on('warning', onWarning);
  try {
    const revision = r.journal.view.planApplied()!;
    assert.equal(revision.rev, 2);
    const path = inputPath(r.ctx.runDir, revision.payloadSha256!, REVISION_INPUT);
    const before = readFileSync(path);
    const raw = JSON.parse(before.toString('utf8'));
    assert.deepEqual(raw.publication.contractOps, [], 'actual dev.41 executor wrote the legacy field');
    assert.deepEqual(keptPayload(r.ctx.runDir, revision.payloadSha256!).publication, {renders: raw.publication.renders});
    for (const contractOps of [[{path: '.roadmap/contracts/api.md', anchor: '#api', oldText: 'a', newText: 'b'}], null, {}]) {
      assert.throws(() => parseRevisionPayload({...raw, publication: {...raw.publication, contractOps}}), /empty legacy contractOps array/);
    }
    assert.deepEqual((await recover({stage: w.stage, commands: w.commands})).parked, []);
    assert.deepEqual(readFileSync(path), before, 'original content-addressed bytes remain untouched');
    syncInputs(r);
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
    writeFileSync(d.planPath, JSON.stringify({...plan, direction: 'Continue the previous release arc'}));
    const next = await applyCommand(w.commands, submitCommand(r.ctx.runDir, r.ctx.plan().arc, applyBody(d)));
    assert.equal(next.kind, 'applied', JSON.stringify(next));
    assert.equal(r.journal.view.planApplied()!.rev, 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(warnings.some((warning) => /ignoring legacy contractOps/.test(warning.message)), 'adoption logs its compatibility default');
  } finally {process.off('warning', onWarning); r.journal.close();}
});

test('upgrade.dev44-candidate-red: real previous-release reds default their absent cause without rewriting the log', {timeout: 120_000}, async () => {
  const root = tmpDir('dev44-executor');
  const relative = 'plugins/roadmap-orchestrator/executor';
  const archive = join(root, 'previous.tar');
  execFileSync('git', ['archive', '-o', archive, PREVIOUS_REF, relative], {cwd: execFileSync('git', ['rev-parse', '--show-toplevel'], {cwd: import.meta.dirname, encoding: 'utf8'}).trim()});
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const previous = join(root, relative);
  assert.equal(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8')).version, PREVIOUS_RELEASE);
  const url = (path: string) => pathToFileURL(join(previous, path)).href;
  const script = `
    import {holisticArc, tipTree, candidateTree} from ${JSON.stringify(url('test/fixtures/brake-common.ts'))};
    import {contextFor, mulBuild, gateStep, stepUntil} from ${JSON.stringify(url('test/fixtures/unit-common.ts'))};
    import {planCheckStep, admitAll} from ${JSON.stringify(url('test/fixtures/stage-common.ts'))};
    import {runUnit} from ${JSON.stringify(url('src/pipeline/unit.ts'))};
    import {scriptTree} from ${JSON.stringify(url('test/helpers/witness.ts'))};
    const {d, control} = holisticArc({steps: [planCheckStep({decision:'approve'}), mulBuild(), gateStep({decision:'approve'})],
      units: [{id:'u1', obligations:['I-1']}], obligations: [{id:'I-1', testIds:['t1']}],
      mapping: [{system:'app', obligations:['I-1']}], trees: {}, planExtra: {limits: {chargeable: 1}}});
    const r = contextFor(d);
    try {
      scriptTree(control, tipTree(d), {outcomes:{t1:'pass'}});
      await stepUntil(r, 'u1', f => f.stage === 'gate' && f.outcome === 'approve');
      scriptTree(control, candidateTree(d, 'u1'), {outcomes:{t1:'fail'}});
      const result = await runUnit(r.ctx, r.unit('u1'), admitAll);
      if (result.kind !== 'parked') throw new Error(JSON.stringify(result));
      process.removeAllListeners('exit'); process.stdout.write(JSON.stringify(d));
    } finally {r.journal.close();}
  `;
  const d = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding:'utf8', timeout:90_000, env:{...process.env, TMPDIR:root}})) as ArcDescriptor;
  const path = join(d.runDir, 'events.jsonl');
  const before = readFileSync(path);
  const warnings: Error[] = [];
  const onWarning = (w: Error) => warnings.push(w);
  process.on('warning', onWarning);
  const r = contextFor(d);
  try {
    const detail = r.journal.view.unit(r.unit('u1').id).decided!.detail;
    assert.equal(detail?.kind, 'candidate-red');
    if (detail?.kind !== 'candidate-red') throw new Error('missing compatibility default');
    assert.equal(detail.path, 'legacy');
    assert.deepEqual(detail.evidence, []);
    assert.deepEqual(readFileSync(path), before);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(warnings.some((w) => /defaulting legacy candidate red cause/.test(w.message)));
  } finally {process.off('warning', onWarning); r.journal.close();}
});

test('upgrade.dev53-throughput: held reservation, queued apply, needs-user and kept CPU collision adopt without rewriting bytes', { timeout: 120_000 }, async () => {
  const root = tmpDir('dev53-throughput');
  const relative = 'plugins/roadmap-orchestrator/executor';
  const archive = join(root, 'previous.tar');
  const sourceRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
  execFileSync('git', ['archive', '-o', archive, '0725b5c3a80c2f170db641ed81f4f823b0471bdf', relative], { cwd: sourceRoot });
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const previous = join(root, relative);
  assert.equal(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8')).version, '1.0.0-dev.53');
  const url = (path: string) => pathToFileURL(join(previous, path)).href;
  const script = `
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {join,dirname} from 'node:path';
    import {setupArc,contextFor,applyBody,syncInputs} from ${JSON.stringify(url('test/fixtures/unit-common.ts'))};
    import {runDir} from ${JSON.stringify(url('src/input/cli.ts'))};
    import {gitCommonDir} from ${JSON.stringify(url('src/preflight/checks.ts'))};
    import {absPath} from ${JSON.stringify(url('src/core/values.ts'))};
    import {reserve} from ${JSON.stringify(url('src/resources/reserve.ts'))};
    import {jobId} from ${JSON.stringify(url('src/core/ids.ts'))};
    import {submitCommand,writeReceipt} from ${JSON.stringify(url('src/commands/queue.ts'))};
    import {raiseNeedsUser} from ${JSON.stringify(url('src/needsuser.ts'))};
    const make = () => {const original=setupArc({steps:[]});const dir=runDir(gitCommonDir(absPath(original.repo)),original.arc);mkdirSync(dir,{recursive:true});return {...original,runDir:dir};};
    const normal=make(), r=contextFor(normal);
    const item=raiseNeedsUser(r.journal,r.ctx.runDir,{blocking:true,subject:{type:'arc'},reason:'owner-request',summary:'Answer after upgrading',recommendation:'Revise',options:[],evidence:[]},{type:'arc'});
    reserve(r.ctx,{type:'job',job:jobId('audit',1)},{named:[],pools:[],cpu:1,publication:false},{type:'job',job:jobId('audit',1)});
    syncInputs(r);writeFileSync(normal.planPath,JSON.stringify({...JSON.parse(readFileSync(normal.planPath,'utf8')),direction:'Queued on dev53'}));
    const command=submitCommand(r.ctx.runDir,r.ctx.plan().arc,applyBody(normal));
    r.journal.fact({kind:'apply-queued',command:command.id,waitsFor:[r.ctx.plan().units[0].id]});
    writeReceipt(r.ctx.runDir,{v:2,command:command.id,state:'queued',at:command.at,waitsFor:[r.ctx.plan().units[0].id],reason:'Waiting at boundary'});
    r.journal.close();
    const collision=make(), path=join(dirname(collision.planPath),'u1.json'), spec=JSON.parse(readFileSync(path,'utf8'));
    spec.lanes[0].env.set.ROADMAP_CPU='9';writeFileSync(path,JSON.stringify(spec));contextFor(collision).journal.close();
    process.removeAllListeners('exit');process.stdout.write(JSON.stringify({normal,collision,command:command.id,item}));
  `;
  const data = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMPDIR: root } })) as { normal: ArcDescriptor; collision: ArcDescriptor; command: string; item: string };
  const { readCommand, terminalReceipt } = await import('../../src/commands/queue.ts');
  const { commandId, needsUserId } = await import('../../src/core/ids.ts');
  const { readJournal } = await import('../../src/core/log.ts');
  const path = join(data.normal.runDir, 'events.jsonl'), before = readFileSync(path);
  const incoming = join(data.normal.runDir, 'commands', 'incoming', `${data.command}.json`), commandBytes = readFileSync(incoming);
  const r = contextFor(data.normal);
  try {
    assert.equal([...r.journal.view.resources().values()].filter((e) => e.status.state !== 'free').length, 1);
    assert.ok(r.journal.view.applyQueued(commandId(data.command)));
    const legacy = readCommand(r.ctx.runDir, commandId(data.command), r.ctx.plan().arc).file;
    assert.ok(legacy.body.type === 'apply');
    assert.equal(Object.hasOwn(legacy.body, 'resolves'), false, 'the optional legacy field stays absent; the apply consumer supplies the empty-list default');
    const w = wire(r); await recover({ stage: w.stage, commands: w.commands });
    assert.ok([...r.journal.view.resources().values()].every((e) => e.status.state === 'free'));
    assert.equal((await applyCommand(w.commands, legacy)).kind, 'applied', 'the adopted queued apply executes with absent resolves defaulting empty');
    assert.ok(r.journal.view.planAppliedBy(commandId(data.command)));
    assert.equal(r.journal.view.ackOf(needsUserId(data.item)), null);
    assert.deepEqual(readFileSync(path).subarray(0, before.length), before);
    assert.deepEqual(readFileSync(incoming), commandBytes);
    syncInputs(r); writeFileSync(r.d.planPath, JSON.stringify({ ...JSON.parse(readFileSync(r.d.planPath, 'utf8')), direction: 'Answer the adopted request' }));
    const next = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { ...applyBody(r.d), resolves: [needsUserId(data.item)] });
    assert.equal((await applyCommand(w.commands, next)).kind, 'applied');
    const receipt = terminalReceipt(r.ctx.runDir, next.id); assert.ok(receipt?.state === 'applied'); assert.deepEqual(receipt.resolved, [data.item]);
  } finally { r.journal.close(); }
  let reachedClaim = false;
  await assert.rejects(runChecks({ repo: absPath(data.collision.repo), planFile: absPath(data.collision.planPath), profile: null, hostDir: absPath(data.collision.hostDir), env: process.env,
    respawn: { runDir: absPath(data.collision.runDir), arc: arcId(data.collision.arc) }, claim: async () => { reachedClaim = true; throw new Error('adoption reached claim'); } }), /adoption reached claim/);
  assert.equal(reachedClaim, true, 'kept CPU collision is not an adoption refusal');
  const c = contextFor(data.collision);
  try {
    const { startScheduler, stopScheduler } = await import('../fixtures/sched-common.ts');
    const { openItems } = await import('../../src/needsuser.ts');
    const scheduled = startScheduler(c);
    const defect = openItems(c.ctx.runDir, c.journal.view).find((n) => n.reason === 'plan-defect');
    assert.ok(defect, 'legacy collision becomes actionable before any stage starts');
    assert.equal(c.journal.view.unit(c.ctx.plan().units[0]!.id).counters.attempts, 0);
    await stopScheduler(c, scheduled);
    const original = readJournal(c.ctx.runDir, c.ctx.plan().arc).events.find((e) => e.type === 'fact' && e.fact.kind === 'plan-applied'); assert.ok(original);
  } finally { c.journal.close(); }
});
