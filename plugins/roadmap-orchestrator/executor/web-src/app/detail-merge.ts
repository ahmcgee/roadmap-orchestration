import type { Continuation } from '../../src/console/detail-protocol.ts';
/** A continuation addresses one already-displayed field. Offsets are rebased
 * when a bounded page has been appended to an earlier selected page. */
export function applyContent(old:any,reply:any,used:Continuation) {
 const out={...structuredClone(old),_anchored:true},c=reply.content;
 let parent=out;for(const key of used.path.slice(0,-1))parent=parent[key];
 const key=used.path.at(-1)!;
 if(c.kind==='text')parent[key]=parent[key].slice(0,used.offset)+c.value;
 else parent[key].splice(used.offset,parent[key].length-used.offset,...c.value);
 out.continuations=[...(old.continuations??[]).filter((r:Continuation)=>r.next!==used.next),...reply.continuations.map((r:Continuation)=>({...r,path:[...used.path,...r.path.slice(c.path.length).map((part:string|number,i:number)=>c.kind==='list'&&i===0&&typeof part==='number'?part+used.offset-c.offset:part)],offset:r.path.length===c.path.length?r.offset+used.offset-c.offset:r.offset}))];
 return out;
}
export function mergeDetailPage(old:any,reply:any,section:string) {
 const prefix=section==='intent'?old.intent.text.length:old[section].rows.length;
 const continuations=(reply.continuations??[]).filter((c:Continuation)=>c.path[0]===section).map((c:Continuation)=>({...c,
  offset:section==='intent'||c.kind==='list'&&c.path.length===2?c.offset+prefix:c.offset,
  path:c.path.map((p:string|number,i:number)=>i===2&&typeof p==='number'?p+prefix:p),
 }));
 return {...old,_anchored:true,[section]:section==='intent'?{...reply.intent,text:old.intent.text+reply.intent.text}:{...reply[section],rows:[...old[section].rows,...reply[section].rows]},continuations:[...(old.continuations??[]),...continuations]};
}
