// Bounded selected-field expansion. Keys refer only to projected allowlisted DTO
// fields, never filesystem paths. No observation or canonical object is retained.
import { randomBytes, createHmac } from 'node:crypto';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { sha256Hex } from '../core/json.ts';
import { versioned } from './views.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { retainedReport } from './reports.ts';
import type { Continuation, ContentView } from './detail-protocol.ts';
const secret=randomBytes(32), entries=new Map<string,{arc:string;epoch:string;instance:string;entity:string;data:any;resolve?: (e:Envelope)=>any;bytes:number;reports:string[];touched:number}>();
const MAX_BYTES=16*1024*1024;
let retainedBytes=0;
const sign=(s:string)=>createHmac('sha256',secret).update(s).digest('hex');
function cursor(key:string,offset:number,path:(string|number)[],hash:string){const raw=Buffer.from(JSON.stringify({key,offset,path,hash})).toString('base64url');return `${raw}.${sign(raw)}`;}
const protectedText=new Set(['id','routeId','unit','source','target','reenters','root','supersededBy','state','signal','stage','outcome','execution','kind','type','at','startedAt','endedAt','arcEndedAt','waitSince','viewVersion','next','basis']);
const scope={basis:'current' as const,from:null,to:null};
function reportIds(e:Envelope,data:any):string[]{
 const routes=new Set<string>((data.journey?.rows??[]).flatMap((s:any)=>s.activities));
 // Only report-backed selected rows need evidence revalidation on expansion.
 return e.data.display.invocations.filter(i=>i.execution==='agent'&&routes.has(invocationDirName(invocationIdOf(i.id)))).filter(i=>retainedReport(e,i.id)!==null).map(i=>i.id);
}
function bytes(e:Envelope,data:unknown){return Buffer.byteLength(JSON.stringify({...e,data})) + 1;}
function bounded(e:Envelope,entity:string,data:any,budget:number,offset=0,path:(string|number)[]=[],reports:string[]=[],generation?:string,resolve?:(e:Envelope)=>any):any {
 for(let cap=4096,rows=100;cap>=32;cap=Math.floor(cap/2),rows=Math.max(1,Math.floor(rows/2))){
  const pending:{ref:Continuation;value:string|unknown[]}[]=[];
  function trim(value:any,p:(string|number)[],start=0):any {
   if(typeof value==='string'){
    const last=p.at(-1),parent=p.at(-2);
    if(protectedText.has(String(last))||last==='epoch'||last==='observedAt'||last==='checkedAt'||last==='protocol'||last==='instance'||last==='repoId'||last==='arc')return value;
    // IDs inside nested reference lists remain exact; the list itself can page.
    if(typeof last==='number'&&['activities','systems','deps','milestones','edges','drainFor'].includes(String(parent)))return value;
    let end=Math.min(value.length,start+cap);if(end<value.length&&/[\uD800-\uDBFF]/.test(value[end-1]!))end--;
    if(end<value.length)pending.push({ref:{path:p,kind:'text',total:value.length,next:'',offset:end},value});
    return value.slice(start,end);
   }
   if(Array.isArray(value)){
    const end=Math.min(value.length,start+rows);
    if(end<value.length)pending.push({ref:{path:p,kind:'list',total:value.length,next:'',offset:end},value});
    return value.slice(start,end).map((v,i)=>trim(v,[...p,start+i]));
   }
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,trim(v,[...p,k])]));
   return value;
  }
  const out=path.length?versioned({content:{path,kind:typeof data==='string'?'text':'list',value:trim(data,path,offset),offset,next:null,total:data.length},continuations:[] as Continuation[]},scope):trim(data,[]);
  // Reserve actual opaque-token space before making the candidate reviewable.
  out.continuations=pending.map(p=>({...p.ref,next:cursor('0'.repeat(24),p.ref.offset,p.ref.path,'0'.repeat(64))}));
  if(bytes(e,out)>budget)continue;
  let key=generation;
  if(pending.length&&!key){
   let size=Buffer.byteLength(JSON.stringify(data));const dynamic=size>MAX_BYTES;
   if(dynamic&&!resolve)throw new ConsoleError('unavailable','Selected detail exceeds retained expansion capacity');
   if(dynamic)size=512+reports.length*128;
   key=randomBytes(12).toString('hex');entries.set(key,{arc:e.arc,epoch:e.epoch,instance:e.instance,entity,data:dynamic?null:structuredClone(data),...(dynamic&&resolve?{resolve}:{}),bytes:size,reports,touched:Date.now()});retainedBytes+=size;
  }
  for(let n=0;n<pending.length;n++)out.continuations[n].next=cursor(key!,pending[n]!.ref.offset,pending[n]!.ref.path,sha256Hex(JSON.stringify(pending[n]!.value)));
  while(entries.size>64||retainedBytes>MAX_BYTES){const k=entries.keys().next().value!;retainedBytes-=entries.get(k)!.bytes;entries.delete(k);}
  return out;
 }
 throw new ConsoleError('unavailable','Selected identity metadata exceeds the detail byte ceiling');
}
export function boundDetail<T>(e:Envelope,entity:string,data:T,budget:number,resolve?:(e:Envelope)=>T):T {
 const projected=bounded(e,entity,data,budget,0,[],reportIds(e,data),undefined,resolve);
 if(projected.viewVersion)projected.viewVersion=sha256Hex(JSON.stringify(data,(key,value)=>['next','viewVersion','asOf','elapsedMs'].includes(key)?null:value));
 return projected;
}
export function contentDetail(e:Envelope,entity:string,token:string,budget:number):ContentView {
 let parsed:{key:string;offset:number;path:(string|number)[];hash:string};
 try{const [raw,sig,...rest]=token.split('.');if(token.length>1024||!raw||sig!==sign(raw)||rest.length)throw Error();parsed=JSON.parse(Buffer.from(raw,'base64url').toString());if(!Array.isArray(parsed.path)||parsed.path.some(p=>typeof p!=='number'&&typeof p!=='string'||['__proto__','prototype','constructor'].includes(String(p)))||!Number.isSafeInteger(parsed.offset)||parsed.offset<0)throw Error();}catch{throw new ConsoleError('invalid','invalid field continuation');}
 const entry=entries.get(parsed.key);if(!entry||Date.now()-entry.touched>15*60*1000)throw new ConsoleError('reset','Detail field expired; reopen this detail');
 if(entry.arc!==e.arc||entry.epoch!==e.epoch||entry.instance!==e.instance||entry.entity!==entity)throw new ConsoleError('invalid','foreign field continuation');
 for(const id of entry.reports)if(!retainedReport(e,id))throw new ConsoleError('reset','Selected report is no longer retained; reopen this detail');
 entries.delete(parsed.key);entries.set(parsed.key,entry);entry.touched=Date.now();
 let value=entry.resolve?entry.resolve(e):entry.data;for(const part of parsed.path)value=value[part];
 if(sha256Hex(JSON.stringify(value))!==parsed.hash)throw new ConsoleError('reset','Selected field changed; reopen this detail');
 if(typeof value!=='string'&&!Array.isArray(value))throw new ConsoleError('invalid','field continuation is not expandable');
 return bounded(e,entity,value,budget,parsed.offset,parsed.path,entry.reports,parsed.key);
}
