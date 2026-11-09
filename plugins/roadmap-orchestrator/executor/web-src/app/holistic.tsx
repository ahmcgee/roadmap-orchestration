import { HolisticField } from './holistic-field.tsx';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { displayZone, formatInstant, link, pluralise, route } from './shared.tsx';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow } from './plain-query.tsx';
import type { HolisticView } from '../../src/console/temporal-protocol.ts';

export function Holistic({arc}:{arc:string}) {
  const state=usePlainQuery<HolisticView>(arc,'holistic',['section','cursor','limit'],{section:'audits'}),h=state.data;
  const zone=route().query.get('zone')??displayZone();
  const time=(at:string|null)=>at?<time dateTime={at}>{formatInstant(at,zone)}</time>:'Time not recorded';
  const reload=()=>state.navigate({cursor:null},true),section=state.params.get('section');
  return <section aria-label="Holistic review"><h3>Holistic review</h3>
    <PlainPageStatus {...state} data={h} reload={reload} version="holistic" noun={section==='findings'?'finding':section==='decisions'?'decision':'audit'}/>
    {h&&<>{h.enabled?<>
      <p>Holistic audit: {h.currentAudit?.running?'Running':h.latestOutcome?h.latestOutcome.outcome==='completed'?'Completed':h.latestOutcome.outcome:'No audit recorded'}. <span style={{marginLeft:4}}>{pluralise(h.counts.findings,'active finding')}.</span></p>
      <p>{pluralise(h.counts.decisions,'root decision')} recorded. Checkpoint job detail is not included in this console yet.</p>
      <div className="local-tabs" aria-label="Holistic sections">{(['audits','findings','decisions'] as const).map(key=><Button key={key} aria-pressed={section===key} onClick={()=>state.navigate({section:key})}>{key==='audits'?'Audits':key==='findings'?'Active findings':'Root decisions'} ({h.counts[key]})</Button>)}</div>
      {!h.rows.length&&<p>No {section==='findings'?'active findings':section==='decisions'?'root decisions':'completed audits'} recorded.</p>}
      {section==='audits'&&<Table aria-label="Holistic audits"><thead><TableRow>{['Recorded at','Audit job','Outcome','Coverage and findings'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{h.rows.map(r=>r.type==='audit'&&<TableRow key={r.id} onClick={ev=>activateRow(ev,link(arc,route().tab,'events',r.detail.id))}><td>{time(r.at)}</td><td><a href={link(arc,route().tab,'events',r.detail.id)}>{r.job}</a></td><td>{r.outcome}</td><td>Holistic audit {r.outcome}: {pluralise(r.findingCount,'finding')}<ul>{r.coverage.map((c,j)=><li key={j}>{c.lens}: {c.from} to {c.to}</li>)}</ul>{r.coverageTruncated&&<a href={link(arc,route().tab,'events',r.detail.id)}>All {r.coverageCount} coverage ranges in evidence</a>}</td></TableRow>)}</tbody></Table>}
      {section==='findings'&&<Table aria-label="Active findings"><thead><TableRow><TableHead>ID</TableHead><TableHead>Claim</TableHead><TableHead>State</TableHead></TableRow></thead><tbody>{h.rows.map(r=>r.type==='finding'&&<TableRow key={r.id} onClick={ev=>activateRow(ev,r.detail?link(arc,route().tab,'events',r.detail.id):null)}><td>{r.detail?<a href={link(arc,route().tab,'events',r.detail.id)}>{r.id}</a>:r.id}</td><td>{r.detail?r.claim.text:<HolisticField key={r.claim.field?.key??r.id} arc={arc} value={r.claim}/>}{r.detail&&r.claim.truncated&&<>… {r.detail?<a href={link(arc,route().tab,'events',r.detail.id)}>Full claim</a>:'Source event unavailable'}</>}</td><td>{r.state}</td></TableRow>)}</tbody></Table>}
      {section==='decisions'&&<Table aria-label="Root decisions"><thead><TableRow>{['Decision','Kind','Ruled by','Recorded at'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{h.rows.map(r=>r.type==='decision'&&<TableRow key={r.id} onClick={ev=>activateRow(ev,r.detail?link(arc,route().tab,'events',r.detail.id):null)}><td><span className="cell-line">{r.recordId}</span>{r.detail?<a href={link(arc,route().tab,'events',r.detail.id)}>{r.oneLine.text}{r.oneLine.truncated?'… Open full evidence':''}</a>:<HolisticField key={r.oneLine.field?.key??r.id} arc={arc} value={r.oneLine}/>}</td><td>{r.kind}</td><td>{r.ruledBy.type}{'role' in r.ruledBy?` ${r.ruledBy.role}`:'command' in r.ruledBy&&r.ruledBy.command?` ${r.ruledBy.command}`:''}</td><td>{time(r.at)}</td></TableRow>)}</tbody></Table>}
      <label className="activity-day-jump">Rows per page<select aria-label="Holistic rows per page" value={state.params.get('limit')??'50'} onChange={ev=>state.navigate({limit:ev.target.value})}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label><PlainPaging page={h.page} navigate={state.navigate}/>
    </>:<p>No holistic layer is enabled for this arc.</p>}</>}
  </section>;
}
