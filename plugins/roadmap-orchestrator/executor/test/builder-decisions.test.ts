import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {type LogRecord, prevHash, serializeEvent} from '../src/core/events.ts';
import {type Sha256Hex, opId, opKey, planRev, specRev} from '../src/core/ids.ts';
import {Fold} from '../src/core/state.ts';
import {absPath} from '../src/core/values.ts';
import {keepInput, SPEC_INPUT} from '../src/input/inforce.ts';
import {builderDecisions} from '../src/pipeline/design.ts';
import {ARC, H, REV, U1, appliedFields, chain, inv1, spawnIntent, stageParent} from './fixtures/log-records.ts';
import {tmpDir} from './helpers/repo.ts';
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

test('builder decision ownership uses a view-only context and ordered plan/patch history', () => {
  const d = setupArc({steps:[]});
  const runDir = absPath(tmpDir('builder-view-only'));
  const path = absPath(join(d.planPath,'..','u1.json'));
  const base = JSON.parse(readFileSync(path,'utf8'));
  const keep = (rev: number, decisions: readonly {id: string; text: string; state?: 'active' | 'struck' | 'deferred'}[]) =>
    keepInput(runDir,Buffer.from(JSON.stringify({...base,rev,decisions:decisions.map(d => ({state:'active',...d}))})),SPEC_INPUT);
  const root = keep(1,[{id:'D1',text:'root'},{id:'D2',text:'root'}]);
  const built = keep(2,[{id:'D1',text:'builder'},{id:'D2',text:'builder'}]);
  const edited = keep(3,[{id:'D1',text:'root edited'},{id:'D2',text:'builder'}]);
  const revised = keep(4,[{id:'D1',text:'root edited'},{id:'D2',text:'revised'}]);
  const verifier = keep(5,[{id:'D1',text:'verifier edited'},{id:'D2',text:'revised'}]);
  const struck = keep(6,[{id:'D1',text:'verifier edited'},{id:'D2',text:'revised',state:'struck'}]);
  const plan = (rev: number, hash: Sha256Hex): LogRecord => ({type:'fact',fact:{kind:'plan-applied',rev:planRev(rev),planSha256:H,
    specs:{[U1]:hash},command:null,changes:[],source:{type:'start'},payloadSha256:H,rulingsSha256:H,
    routingProvenance:appliedFields(rev,null).routingProvenance,...(rev === 1 ? {scheduling:'dag' as const} : {})}});
  const records: LogRecord[] = [plan(1,root),spawnIntent(2)];
  const patch = (old: Sha256Hex, hash: Sha256Hex, rev: number, role: 'executor' | 'verifier', target = path): void => {
    const op = opId(ARC,records.length + 1);
    records.push({type:'intent',kind:'spec.patch',op,ordinal:1,key:opKey(`patch:${op}`),parent:stageParent('evidence',1),deadlineAt:null,
      expect:{path:target,oldSha256:old,expectRev:specRev(rev),patch:{expectRev:specRev(rev),ops:[],by:role === 'executor' ? {role,inv:inv1(2)} : {role,inv:inv1(2),routingRev:REV}}},
      post:{newSha256:hash,newRev:specRev(rev + 1)}});
    records.push({type:'done',kind:'spec.patch',op,outcome:{kind:'patched'},recoveredBy:null});
  };
  patch(root,built,1,'executor');
  records.push(plan(2,edited));
  patch(edited,revised,3,'executor');
  patch(revised,root,4,'verifier',absPath(join(d.planPath,'..','other.json')));
  patch(revised,verifier,4,'verifier');
  const f = new Fold(ARC);
  const apply = () => {
    for (const e of chain(records).slice(f.highWater())) f.apply(e,prevHash(Buffer.from(serializeEvent(e))));
  };
  apply();
  assert.deepEqual(f.specHistory(U1,path).map(e => e.hash),[root,built,edited,revised,verifier]);
  const ctx = {runDir,journal:{view:{spawnsOfUnit:f.spawnsOfUnit.bind(f),specHistory:f.specHistory.bind(f)}}};
  assert.deepEqual([...builderDecisions(ctx,U1,path)],['D2']);
  records.push(plan(3,struck));
  apply();
  assert.deepEqual([...builderDecisions(ctx,U1,path)],[]);
  patch(struck,built,6,'executor');
  records.pop(); // An open patch never transfers authorship.
  apply();
  assert.deepEqual([...builderDecisions(ctx,U1,path)],[]);
  assert.equal(existsSync(join(runDir,'events.jsonl')),false,'this context has kept specs and an in-memory view, never a journal file');
  const restored = new Fold(ARC);
  for (const e of chain(records)) restored.apply(e,prevHash(Buffer.from(serializeEvent(e))));
  assert.deepEqual(restored.specHistory(U1,path),f.specHistory(U1,path));
});
