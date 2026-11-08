import { useContext, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { Clock, elapsed, link, money, route, SignalMark } from './shared.tsx';
import type { Envelope } from './types.ts';

type Sort = 'redChecks' | 'elapsedMs' | 'spend' | 'rounds';
export function AllUnits({e}:{e:Envelope}) {
  const [sort,setSort] = useState<{key:Sort;descending:boolean}|null>(null);
  const [blocked,setBlocked] = useState(false);
  const m=e.data.console,clock=useContext(Clock),now=m.resources.endAt?Date.parse(m.resources.endAt):clock;
  const rows=m.presentation.units.map((u,index)=>({u,index})).filter(({u})=>!blocked||u.reasons.length>0);
  if(sort)rows.sort((a,b)=>{
    const value=(u:typeof a.u)=>sort.key==='spend'&&!u.spendCoverage.recorded?null:u[sort.key];
    const av=value(a.u),bv=value(b.u);
    if(av==null||bv==null)return av==null?(bv==null?a.index-b.index:1):-1;
    return (sort.descending?bv-av:av-bv)||a.index-b.index;
  });
  const header=(key:Sort,label:string,name:string)=> <TableHead className="number" aria-sort={sort?.key===key?(sort.descending?'descending':'ascending'):'none'}><button aria-label={`Sort by ${name}`} onClick={()=>setSort({key,descending:sort?.key===key?!sort.descending:true})}>{label}</button></TableHead>;
  return <section className="panel"><header><h2>All units</h2><p className="muted">Every unit in plan order. Journey elapsed, red checks, rounds and spend are lifetime records.</p><Button aria-pressed={blocked} onClick={()=>setBlocked(!blocked)}>Current blockers</Button></header>
    <Table aria-label="All units"><thead><TableRow><TableHead>Unit</TableHead><TableHead>Current state / stage</TableHead><TableHead>Current blockers</TableHead>{header('elapsedMs','Journey elapsed','elapsed')}{header('redChecks','Red checks','red checks')}{header('rounds','Rounds','rounds')}{header('spend','Recorded spend','spend')}</TableRow></thead><tbody>{rows.map(({u})=> <TableRow key={u.id}>
      <td className="unit-identity"><a href={link(e.arc,route().tab,'units',u.id)} title={`${u.id}: ${u.title}`}><strong>{u.id}</strong><span>{u.title}</span></a></td>
      <td><SignalMark state={m.graph.units.find(g=>g.id===u.id)!.status}/>{u.state}<span className="cell-line">{u.stage}</span></td>
      <td className="unit-blockers">{u.reasons.length?<><ul>{u.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul><span title={u.waitSince?`Wait started ${new Date(u.waitSince).toLocaleString()}`:undefined}>{u.waitSince?`Waiting ${elapsed(Math.max(0,now-Date.parse(u.waitSince)))}`:'Wait start not recorded'}</span></>:<span>No current blocker recorded</span>}</td>
      <td className="number" title={u.elapsedMs===null?'Not recorded':`${u.elapsedMs} ms`}>{elapsed(u.elapsedMs)}</td><td className="number">{u.redChecks}</td><td className="number">{u.rounds}</td><td className="number">{u.spendCoverage.recorded?money(u.spend):'Not recorded'}{u.spendCoverage.estimated>0&&<small className="cell-line">{u.spendCoverage.estimated} estimated</small>}{u.spendCoverage.unavailable>0&&<small className="cell-line">Partial: {u.spendCoverage.unavailable} unavailable</small>}</td>
    </TableRow>)}</tbody></Table>
  </section>;
}
