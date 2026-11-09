import { Views } from './view-state.ts';
import { useContext, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { get } from './shared.tsx';
import { contentShape } from '../../src/console/view-shapes.ts';
import type { Continuation } from '../../src/console/detail-protocol.ts';
export { applyContent } from './detail-merge.ts';
import { applyContent } from './detail-merge.ts';
function label(path:(string|number)[]){return path.filter(k=>!['rows','unit','invocation'].includes(String(k))).map(k=>typeof k==='number'?k+1:String(k).replace(/([A-Z])/g,' $1').toLowerCase()).join(' · ');}
export function DetailContinuations({arc,path,detail,update}:{arc:string;path:string;detail:any;update:(value:any)=>void}) {
 const store=useContext(Views),request=useRef(0);
 useEffect(()=>()=>{request.current++;},[path,store?.generation]);
 const [error,setError]=useState(''),[busy,setBusy]=useState('');
 async function more(ref:Continuation){const ticket=request.current;setBusy(ref.next);setError('');try{
  const r=await get(`/arcs/${encodeURIComponent(arc)}/${path}?section=content&cursor=${encodeURIComponent(ref.next)}`);
  if(ticket!==request.current)return;
  if(!contentShape(r.data))throw Error('Malformed detail field; reload required');
  if(store&&!store.admit(r,false,true))throw Error('Detail response was overtaken; retry');
  update(applyContent(detail,r.data,ref));
 }catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy('');}}
 const reload=()=>{store?.ui.delete(`detail:${path}`);setError('');if(store)void store.load(path,true);};
 return <>{detail.continuations?.length>0&&<section className="detail-continuations"><h3>More recorded detail</h3><p className="muted">Long fields and nested lists continue here. Each control adds the next part in its original section.</p>{detail.continuations.map((r:Continuation)=><p key={r.next}><Button disabled={!!busy} onClick={()=>void more(r)}>Read more {label(r.path)}</Button><small> {r.offset} of {r.total} {r.kind==='text'?'characters':'items'}</small></p>)}</section>}{error&&<div><p role="alert">{error}</p><Button onClick={reload}>Reload detail</Button></div>}</>;
}
