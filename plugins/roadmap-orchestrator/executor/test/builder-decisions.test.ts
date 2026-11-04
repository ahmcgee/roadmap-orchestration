import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {applyCommand} from '../src/commands/apply.ts';
import {submitCommand} from '../src/commands/queue.ts';
import {loadUnitSpec} from '../src/pipeline/stages.ts';
import {runUnit} from '../src/pipeline/unit.ts';
import {wire} from './fixtures/publish-common.ts';
import {SCENARIO_TIMEOUT_MS, admitAll, planCheckStep} from './fixtures/stage-common.ts';
import {appendSteps, applyBody, codexStep, contextFor, gateStep, mulBuild, setupArc, stepUntil, syncInputs, workDirPattern} from './fixtures/unit-common.ts';

test('builder decisions preserve a root edit, record disagreement as a departure, and can replace their own text', {timeout:SCENARIO_TIMEOUT_MS}, async () => {
  const d = setupArc({steps:[]});
  const report = (d1:string, d2:string) => ({type:'writeToPrompt' as const, pattern:workDirPattern(d), file:'decisions.json',
    text:JSON.stringify({decisions:[{id:'D1',text:d1},{id:'D2',text:d2}]})});
  appendSteps(d, [planCheckStep({decision:'approve'}), mulBuild({}, [report('original builder choice','builder choice')]),
    gateStep({decision:'revise', reasons:['Improve the implementation.'], directives:['Improve the implementation.']}), planCheckStep({decision:'approve'}),
    codexStep([report('original builder choice','revised builder choice')], {argv:['exec','resume']}), gateStep({decision:'approve'})]);
  const r = contextFor(d), w = wire(r);
  try {
    await stepUntil(r,'u1',f => f.stage === 'gate' && f.outcome === 'revise');
    syncInputs(r);
    const path = join(d.planPath,'..','u1.json');
    const spec = JSON.parse(readFileSync(path,'utf8'));
    spec.rev++;
    spec.decisions.find((x:{id:string}) => x.id === 'D1').text = 'root revised choice';
    writeFileSync(path,JSON.stringify(spec));
    const result = await applyCommand(w.commands,submitCommand(r.ctx.runDir,r.ctx.plan().arc,applyBody(d)));
    assert.equal(result.kind,'applied',JSON.stringify(result));
    const finish = await runUnit(r.ctx,r.unit('u1'),admitAll);
    assert.equal(finish.kind,'merged',JSON.stringify(finish));
    const decisions = loadUnitSpec(r.ctx,r.unit('u1')).spec.decisions;
    assert.equal(decisions.find(x => x.id === 'D1')!.text,'root revised choice');
    assert.equal(decisions.find(x => x.id === 'D2')!.text,'revised builder choice');
    assert.ok(decisions.some(x => x.id.startsWith('departure.') && x.text.includes('D1') && x.text.includes('original builder choice')));
  } finally {r.journal.close();}
});
