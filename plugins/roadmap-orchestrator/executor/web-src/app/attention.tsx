// Plain typed list; the compact Attention presentation is a later pass.
import { useRef } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { link, route, Time } from './shared.tsx';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow } from './plain-query.tsx';
import type { AttentionView } from '../../src/console/attention-protocol.ts';
export function Attention({arc}:{arc:string}) {
  const state=usePlainQuery<AttentionView>(arc,'attention',['blocking','subjectType','reason','q','sort','cursor','limit']),h=state.data,table=useRef<HTMLTableElement>(null);
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reload=()=>state.navigate({cursor:null},true);
  function move(ev:React.KeyboardEvent<HTMLTableElement>) {
    if((ev.target as HTMLElement).closest('input,select,button')||!['ArrowDown','ArrowUp','Home','End'].includes(ev.key))return;
    const links=[...table.current?.querySelectorAll<HTMLAnchorElement>('tbody a.request-link')??[]],n=links.indexOf(document.activeElement as HTMLAnchorElement);
    if(n<0)return;ev.preventDefault();links[ev.key==='Home'?0:ev.key==='End'?links.length-1:Math.max(0,Math.min(links.length-1,n+(ev.key==='ArrowDown'?1:-1)))]?.focus();
  }
  return <section className="panel"><header><h2>Attention</h2><p>Open human requests. Times in {zone}.</p></header>
    <form className="activity-filters" key={state.path} onSubmit={ev=>{ev.preventDefault();const values=new FormData(ev.currentTarget),next:Record<string,string|null>={};for(const key of ['blocking','subjectType','reason','q','sort','limit'])next[key]=String(values.get(key)??'')||null;state.navigate(next);}}>
      <label>Blocking<select name="blocking" defaultValue={state.params.get('blocking')??'all'}><option value="all">All requests</option><option value="1">Blocking</option><option value="0">Informational</option></select></label>
      <label>Subject<select name="subjectType" defaultValue={state.params.get('subjectType')??''}><option value="">All subjects</option>{['unit','arc','host','findings'].map(v=><option key={v} value={v}>{v}</option>)}</select></label>
      <label>Reason<input name="reason" defaultValue={state.params.get('reason')??''} placeholder="Recorded reason"/></label>
      <label>Search requests<input name="q" maxLength={200} defaultValue={state.params.get('q')??''}/></label>
      <label>Order<select name="sort" defaultValue={state.params.get('sort')??'oldest'}><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select></label>
      <label>Rows<select name="limit" defaultValue={state.params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label>
      <Button type="submit">Apply filters</Button><Button type="button" onClick={()=>state.navigate({blocking:null,subjectType:null,reason:null,q:null,sort:null,cursor:null,limit:null},true)}>Reset view</Button>
    </form>
    <PlainPageStatus {...state} data={h} reload={reload} version="attention"/>
    {h&&<><p>{h.counts.total} open human requests: {h.counts.blocking} blocking, {h.counts.informational} informational.</p>
      {!h.rows.length&&<p>{h.counts.total?'No open requests match these filters. Reset view to show all requests.':'No open human requests.'}</p>}
      <Table ref={table} aria-label="Open human requests" onKeyDown={move}><thead><TableRow>{['Request','Blocking state','Subject','Reason','Raised / age','Evidence'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{h.rows.map(r=>{const href=link(arc,route().tab,'requests',r.id);return <TableRow key={r.id} onClick={ev=>activateRow(ev,href)}><td><a className="request-link" href={href}>{r.summary.text}{r.summary.truncated?'… Open full request':''}</a><span className="cell-line">{r.id}</span></td><td>{r.blocking?'Ⅱ Blocking: Waiting for a human':'○ Nonblocking: For your information'}</td><td>{r.subject.type==='unit'?`${r.subject.id} ${r.subject.title}`:r.subject.type==='findings'?`${r.subject.count} findings`:r.subject.type==='arc'?'Arc':'Host'}</td><td>{r.reason}</td><td><time dateTime={r.raisedAt}>{new Date(r.raisedAt).toLocaleString('en-GB',{timeZone:zone})}</time><span className="cell-line"><Time at={r.raisedAt}/></span></td><td className="number">{r.evidenceCount}</td></TableRow>;})}</tbody></Table>
      <PlainPaging page={h.page} navigate={state.navigate}/>
    </>}
  </section>;
}
