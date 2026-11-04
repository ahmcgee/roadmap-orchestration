import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {applyCommand} from '../src/commands/apply.ts';
import {submitCommand} from '../src/commands/queue.ts';
import {sha} from '../src/core/ids.ts';
import {absPath} from '../src/core/values.ts';
import {arcJourneyLane, laneRuntime, runJourneySeries} from '../src/pipeline/lanes.ts';
import {holisticInForce} from '../src/pipeline/stages.ts';
import {candidateTree, holisticArc, tipTree} from './fixtures/brake-common.ts';
import {wire} from './fixtures/publish-common.ts';
import {SCENARIO_TIMEOUT_MS, planCheckStep} from './fixtures/stage-common.ts';
import {U1, applyBody, contextFor, gateStep, mulBuild, outcomes, stepUntil, syncInputs} from './fixtures/unit-common.ts';
import {git} from './helpers/repo.ts';
import {scriptTree} from './helpers/witness.ts';

for (const changed of [true, false]) test(`witness-reuse.${changed ? 'changed-witness-runs' : 'covered-witness-reuses'}: a certified record must cover current witness ids`, {timeout:SCENARIO_TIMEOUT_MS}, async () => {
  const {d, control} = holisticArc({steps:[planCheckStep({decision:'approve'}), mulBuild(), gateStep({decision:'approve'})],
    units:[{id:'u1', obligations:['I-1']}], obligations:[{id:'I-1', testIds:['t1']}],
    mapping:[{system:'app', obligations:['I-1']}], laneExtra:{journey:{inputs:['src/**']}}, trees:{}});
  const r = contextFor(d), w = wire(r);
  try {
    await stepUntil(r, 'u1', f => f.stage === 'gate' && f.outcome === 'approve');
    const tree = candidateTree(d, 'u1');
    scriptTree(control, tree, {outcomes:{t1:'pass'}});
    const lane = holisticInForce(r.ctx).obligations!.lanes[0]!;
    const parent = {type:'stage', unit:U1, stage:'gate', attempt:r.journal.view.unit(U1).decided!.attempt} as const;
    await runJourneySeries(r.ctx, {type:'unit', parent, rt:laneRuntime(r.ctx,U1)}, [arcJourneyLane(lane)],
      {path:absPath(join(d.runDir,'certified')), checkout:{type:'detached', at:sha(git(d.repo,'rev-parse',`roadmap/${d.arc}/u1`))}}, {reuse:false, stop:()=>false});
    const before = r.journal.view.opsOf('proc.spawn').filter(i => i.expect.subject.purpose === 'journey' && i.parent.type === 'stage' && i.parent.stage === 'candidate').length;
    if (changed) {
      syncInputs(r);
      const path = join(d.planPath,'..','obligations.json');
      const raw = JSON.parse(readFileSync(path,'utf8'));
      raw.obligations[0] = {...raw.obligations[0], rev:1, witness:{...raw.obligations[0].witness, testIds:['t2']},
        proofJudgment:{verdict:'proves', obligationRev:1, witness:{testIds:['t2']}}};
      writeFileSync(path, JSON.stringify(raw));
      scriptTree(control, '*', {outcomes:{t2:'pass'}});
      scriptTree(control, tipTree(d), {outcomes:{t2:'pass'}});
      const result = await applyCommand(w.commands, submitCommand(r.ctx.runDir,r.ctx.plan().arc,applyBody(d)));
      assert.equal(result.kind,'applied',JSON.stringify(result));
      scriptTree(control, tree, {outcomes:{t2:'pass'}});
      scriptTree(control, tipTree(d), {outcomes:{t2:'pass'}});
    }
    await stepUntil(r, 'u1', f => f.stage === 'candidate');
    assert.equal(outcomes(d).at(-1),'candidate:green', 'current witness passes; the old record must not grade it red');
    const after = r.journal.view.opsOf('proc.spawn').filter(i => i.expect.subject.purpose === 'journey' && i.parent.type === 'stage' && i.parent.stage === 'candidate').length;
    assert.equal(after - before, changed ? 1 : 0, changed ? 'the changed witness needs a new observation' : 'valid reuse stays free');
  } finally {r.journal.close();}
});
