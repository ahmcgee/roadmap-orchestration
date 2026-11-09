import { useState } from 'react';
import type { InvocationView } from '../../src/console/detail-protocol.ts';
import { elapsed, get, link, route } from './shared.tsx';
import { Button } from '../components/ui/button.tsx';
export function InvocationFacts({arc,id,detail}:{arc:string;id:string;detail:InvocationView}) {
  const [related,setRelated]=useState(detail.related),[error,setError]=useState('');
  const a=detail.actor,m=detail.measured;
  async function more(){try{const r=await get(`/arcs/${encodeURIComponent(arc)}/invocations/${encodeURIComponent(id)}?section=related&cursor=${encodeURIComponent(related.next!)}`);setRelated(old=>({...r.data.related,rows:[...old.rows,...r.data.related.rows]}));}catch(err){setError(err instanceof Error?err.message:String(err));}}
  return <details className="invocation-facts"><summary>Invocation facts</summary><dl>
    <div><dt>Role</dt><dd>{a.role}</dd></div><div><dt>Backend</dt><dd>{a.backend??'Not recorded'}</dd></div><div><dt>Model</dt><dd>{a.model??'Not recorded'}</dd></div><div><dt>Requested model</dt><dd>{a.requestedModel??'Not recorded'}</dd></div>
    <div><dt>Measured execution wall time</dt><dd>{elapsed(m?.wallMs)}</dd></div><div><dt>Measured CPU run time</dt><dd>{elapsed(m?.runMs)}</dd></div><div><dt>Measured CPU wait time</dt><dd>{elapsed(m?.waitMs)}</dd></div><div><dt>Reserved CPU cores</dt><dd>{detail.reservedCpu??'Not recorded'}</dd></div>
  </dl>{related.total>0&&<section><h3>Related units ({related.total})</h3>{related.rows.map(u=><a className="cell-line" key={u.id} href={link(arc,route().tab,'units',u.id)}>{u.id} {u.title}</a>)}{related.next&&<Button onClick={()=>void more()}>Show more related units</Button>}</section>}{error&&<p role="alert">{error}</p>}</details>;
}
