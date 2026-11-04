import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {runUnit} from '../src/pipeline/unit.ts';
import {candidateTree, holisticArc} from './fixtures/brake-common.ts';
import {admitAll, SCENARIO_TIMEOUT_MS, planCheckStep} from './fixtures/stage-common.ts';
import {contextFor, gateStep, mulBuild, stepUntil} from './fixtures/unit-common.ts';
import {git, tmpDir} from './helpers/repo.ts';

for (const mode of ['dirty','moved'] as const) test(`candidate red retains the exact ${mode} checkout cause after removal`, {timeout:SCENARIO_TIMEOUT_MS}, async () => {
  const marker = join(tmpDir('candidate-integrity'),'tree');
  writeFileSync(marker,'');
  const script = `const fs = require('node:fs'), {execFileSync} = require('node:child_process');
    fs.appendFileSync(process.env.ROADMAP_WITNESS_FILE, JSON.stringify({testId:'t1',selected:1,outcome:'pass'})+'\\n');
    const tree = execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
    if (tree === fs.readFileSync(process.argv[1],'utf8')) {
      ${mode === 'dirty' ? "fs.writeFileSync('lane-output.txt','unexpected output');" : "execFileSync('git',['checkout','--detach','HEAD^'],{stdio:'ignore'});"}
    }`;
  const {d} = holisticArc({steps:[planCheckStep({decision:'approve'}),mulBuild(),gateStep({decision:'approve'})],
    units:[{id:'u1',obligations:['I-1']}],obligations:[{id:'I-1',testIds:['t1']}],
    mapping:[{system:'app',obligations:['I-1']}],trees:{},laneExtra:{journey:{argv:[process.execPath,'-e',script,marker]}},planExtra:{limits:{chargeable:1}}});
  const r = contextFor(d);
  try {
    await stepUntil(r,'u1',f => f.stage === 'gate' && f.outcome === 'approve');
    writeFileSync(marker,candidateTree(d,'u1'));
    const tip = git(d.repo,'rev-parse','main');
    const result = await runUnit(r.ctx,r.unit('u1'),admitAll);
    assert.equal(result.kind,'parked');
    if (result.kind !== 'parked') throw new Error(JSON.stringify(result));
    assert.match(result.needsUser.summary,mode === 'dirty' ? /dirty paths: lane-output.txt/ : new RegExp(`HEAD moved to ${tip}`));
    const detail = r.journal.view.unit(r.unit('u1').id).decided!.detail;
    assert.ok(detail?.kind === 'candidate-red' && detail.causes.includes('dirty/moved checkout'));
    assert.match(result.needsUser.recommendation,/clean lane outputs/);
  } finally {r.journal.close();}
});
