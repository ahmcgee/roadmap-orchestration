import { useContext, useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { get } from './shared.tsx';
import { Views } from './view-state.ts';
import { holisticFieldShape } from '../../src/console/view-shapes.ts';
import type { EvidencePreview, HolisticFieldView } from '../../src/console/temporal-protocol.ts';
// Only source-less fields use this path; event-backed fields keep their evidence drawer.
export function HolisticField({arc,value}:{arc:string;value:EvidencePreview}) {
  const store=useContext(Views),key=value.field?.key,saved=key?store?.ui.get(`holistic-field:${key}`) as {text:string;next:number|null;total:number}|undefined:undefined;
  const [data,setData]=useState(saved),[busy,setBusy]=useState(false),[error,setError]=useState(''),ticket=useRef(0);
  useEffect(()=>{ticket.current++;setData(saved);setError('');setBusy(false);return()=>{ticket.current++;};},[key,store?.generation]);
  async function more(){if(!key)return;const current=ticket.current;setBusy(true);setError('');try {
    const r=await get(`/arcs/${encodeURIComponent(arc)}/holistic/fields/${key}?after=${data?.next??0}`);
    if(current!==ticket.current)return;
    if(!holisticFieldShape(r.data)||r.data.key!==key||r.data.name!==value.field?.name)throw Error('Malformed Holistic field; reload this view');
    if(store&&!store.admit(r,false,true))throw Error('Field response was overtaken; retry');
    const field=r.data as HolisticFieldView;
    if(field.offset!==(data?.next??0)||data&&field.total!==data.total)throw Error('Holistic field changed; reload this view');
    const next={text:(data?.text??'')+field.text,next:field.next,total:field.total};setData(next);store?.ui.set(`holistic-field:${key}`,next);store?.trimUi();
  }catch(err){if(current===ticket.current)setError(err instanceof Error?err.message:String(err));}finally{if(current===ticket.current)setBusy(false);}}
  return <>{data?.text??value.text}{value.truncated&&!data&&'…'}{key&&data?.next!==null&&<p><Button disabled={busy} onClick={()=>void more()}>{data?'Read more recorded text':'Read full recorded field'}</Button>{data&&<small> {data.text.length} of {data.total} characters</small>}</p>}{error&&<p role="alert">{error}</p>}</>;
}
