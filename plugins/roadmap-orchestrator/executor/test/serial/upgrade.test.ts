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
const PREVIOUS_RELEASE = '1.0.0-dev.41';
const PREVIOUS_REF = '82887487052bba7235f16b73d0fd22d82b6d9b48';
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
  execFileSync('git', ['archive', '-o', archive, PREVIOUS_REF, relative], {cwd: sourceRoot});
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const previous = join(root, relative);
  assert.equal(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8')).version, PREVIOUS_RELEASE);
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
