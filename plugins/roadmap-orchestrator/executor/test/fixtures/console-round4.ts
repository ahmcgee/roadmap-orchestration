import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { absPath } from '../../src/core/values.ts';
import { investigationFixture } from './console-investigations.ts';
import { opKey, unitId, sha256 } from '../../src/core/ids.ts';
export async function round4Fixture(){
 const f=await investigationFixture(14,{u1:'Publish multiplication support with clear handling of empty inputs, negative operands, decimal values, and boundary cases, together with readable checks that explain the result to a colleague who has never read the implementation.'});const j=f.journal;
 // C4 inspects real earlier-page navigation. Keep the terminal report last, with
 // enough retained context before it to require more than one 50-event page.
 const finished=readFileSync(f.finished.transcript,'utf8').trimEnd().split('\n');
 const terminal=finished.pop()!;
 const context=Array.from({length:55},(_,n)=>JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:`Recorded finished-history context ${n}`}]}}));
 writeFileSync(f.finished.transcript,[...finished,...context,terminal].join('\n')+'\n');
 const parent={type:'stage' as const,unit:unitId('u1'),stage:'retire' as const,attempt:3};
 const evidence=j.begin({kind:'evidence.snapshot',key:opKey('round4-evidence'),parent:{type:'arc'},deadlineAt:null,body:()=>({expect:{source:absPath(f.d.repo+'/retired-checkout'),dest:absPath(f.runDir+'/evidence/retired'),globs:[]},post:{manifest:absPath(f.runDir+'/evidence/retired/manifest.json')}})});j.done(evidence.op,'evidence.snapshot',{kind:'captured',files:0,manifestSha256:sha256('0'.repeat(64))},null);
 const retired=j.begin({kind:'worktree.remove',key:opKey('round4-retire'),parent,deadlineAt:null,body:()=>({expect:{path:absPath(f.d.repo+'/retired-checkout'),evidence:evidence.op},post:null})});j.done(retired.op,'worktree.remove',{kind:'removed'},null);
 for(const waited of [{totalMs:0,byReasonMs:{}},{totalMs:80000,byReasonMs:{'admission-hold:dependency':80000}}])j.fact({kind:'stage-admitted',unit:unitId('u1'),stage:'build',waited});
 for(const result of [{stage:'quiesce',outcome:'empty'},{stage:'evidence',outcome:'captured'},{stage:'salvage',outcome:'committed'},{stage:'teardown',outcome:'released'}] as const){const p=f.begin('u7',result.stage);j.fact({kind:'stage-outcome',unit:p.unit,...result,attempt:p.attempt,class:'advance',chargeable:false});}
 const failed=f.begin('u7','teardown');j.fact({kind:'stage-outcome',unit:failed.unit,stage:'teardown',attempt:failed.attempt,outcome:'cleanup-failed',class:'park',chargeable:false});
 for(const id of ['long-a','long-b'])appendFileSync(f.live.transcript,JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Read',input:{file_path:id+'-'+('input '.repeat(2500))}}]}})+'\n');
 return f;
}
