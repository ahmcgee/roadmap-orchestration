import { HolisticField } from './holistic-field.tsx';
import { Button } from '../components/ui/button.tsx';
import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { displayZone, formatInstant, link, pluralise, route } from './shared.tsx';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow, moveRowFocus } from './plain-query.tsx';
import { decisionKindWords, plainWords, ruledByWords, stageWords } from '../../src/console/vocabulary.ts';
import type { HolisticFinding, HolisticView } from '../../src/console/temporal-protocol.ts';
const shortSha=(sha:string)=>/^[0-9a-f]{12,}$/.test(sha)?sha.slice(0,7):sha;
const checked=(c:{lens:string;from:string;to:string})=>c.from===c.to?`Checked ${c.lens} at ${shortSha(c.from)}`:`Checked ${c.lens} from ${shortSha(c.from)} to ${shortSha(c.to)}`;
const foundBy=(s:NonNullable<HolisticFinding['foundBy']>)=>s.type==='audit'?s.job:s.type==='stage'?`${s.unit}, ${stageWords(s.stage)}`:'Demo check';

export function Holistic({arc}:{arc:string}) {
  const state=usePlainQuery<HolisticView>(arc,'holistic',['section','cursor','limit'],{section:'audits'}),h=state.data;
  const zone=route().query.get('zone')??displayZone();
  const time=(at:string|null)=>at?<time dateTime={at}>{formatInstant(at,zone)}</time>:'Not recorded';
  const reload=()=>state.navigate({cursor:null},true),section=state.params.get('section');
  return <section aria-label="Holistic review"><h3>Holistic review</h3>
    <PlainPageStatus {...state} data={h} reload={reload} version="holistic" noun={section==='findings'?'finding':section==='decisions'?'decision':'audit'}/>
    {h&&<>{h.enabled?<>
      <div className="holistic-summary"><p>{h.currentAudit?.running?'Audit running':h.latestOutcome?`Latest audit ${h.latestOutcome.outcome==='completed'?'finished':h.latestOutcome.outcome}`:'No audits recorded'}{h.latestOutcome&&<> {time(h.latestOutcome.at)}</>}</p><p>{pluralise(h.counts.findings,'active finding')}</p><p>{pluralise(h.counts.decisions,'root decision')}</p><p className="muted">Checkpoint details aren't available here yet.</p></div>
      <div className="local-tabs" aria-label="Holistic sections">{(['audits','findings','decisions'] as const).map(key=><Button key={key} aria-pressed={section===key} onClick={()=>state.navigate({section:key})}>{key==='audits'?'Audits':key==='findings'?'Active findings':'Root decisions'} ({h.counts[key]})</Button>)}</div>
      {!h.rows.length&&<p>No {section==='findings'?'active findings':section==='decisions'?'root decisions':'audits finished'}.</p>}
      {section==='audits'&&<Table aria-label="Holistic audits" onKeyDown={moveRowFocus}><thead><TableRow>{['Finished','Audit','Result','New findings','What it checked'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{h.rows.map(r=>r.type==='audit'&&<TableRow key={r.id} onClick={ev=>activateRow(ev,link(arc,route().tab,'events',r.detail.id))}><td>{time(r.at)}</td><td><a href={link(arc,route().tab,'events',r.detail.id)}>{r.job}</a></td><td>{r.outcome==='completed'?'Finished':plainWords(r.outcome)}</td><td title="Findings this audit filed. Findings opened elsewhere are listed under Active findings.">{pluralise(r.findingCount,'new finding')}</td><td><ul className="coverage-list">{r.coverage.map((c,j)=><li key={j}>{checked(c)}</li>)}</ul>{r.coverageTruncated&&<a href={link(arc,route().tab,'events',r.detail.id)}>All {r.coverageCount} checks</a>}</td></TableRow>)}</tbody></Table>}
      {section==='findings'&&<Table aria-label="Active findings" onKeyDown={moveRowFocus}><thead><TableRow>{['ID','Claim','State','Found by'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{h.rows.map(r=>r.type==='finding'&&<TableRow key={r.id} onClick={ev=>activateRow(ev,r.detail?link(arc,route().tab,'events',r.detail.id):null)}><td>{r.detail?<a href={link(arc,route().tab,'events',r.detail.id)}>{r.id}</a>:r.id}</td><td>{r.detail?r.claim.text:<HolisticField key={r.claim.field?.key??r.id} arc={arc} value={r.claim}/>}{r.detail&&r.claim.truncated&&<>… <a href={link(arc,route().tab,'events',r.detail.id)}>Full claim</a></>}</td><td>{plainWords(r.state)}</td><td>{r.foundBy?foundBy(r.foundBy):'Not recorded'}{r.foundAt&&<span className="cell-line">{time(r.foundAt)}</span>}</td></TableRow>)}</tbody></Table>}
      {section==='decisions'&&<Table aria-label="Root decisions" onKeyDown={moveRowFocus}><thead><TableRow>{['Decision','Kind','Ruled by','Recorded'].map(t=><TableHead key={t}>{t}</TableHead>)}</TableRow></thead><tbody>{h.rows.map(r=>r.type==='decision'&&<TableRow key={r.id} onClick={ev=>activateRow(ev,r.detail?link(arc,route().tab,'events',r.detail.id):null)}><td><span className="cell-line">{r.recordId}</span>{r.detail?<a href={link(arc,route().tab,'events',r.detail.id)}>{r.oneLine.text}{r.oneLine.truncated?'… Open full decision':''}</a>:<HolisticField key={r.oneLine.field?.key??r.id} arc={arc} value={r.oneLine}/>}</td><td>{decisionKindWords(r.kind)}</td><td>{ruledByWords(r.ruledBy)}</td><td>{time(r.at)}</td></TableRow>)}</tbody></Table>}
      <label className="activity-day-jump">Rows per page<select aria-label="Holistic rows per page" value={state.params.get('limit')??'50'} onChange={ev=>state.navigate({limit:ev.target.value})}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label><PlainPaging page={h.page} navigate={state.navigate}/>
    </>:<p>No holistic layer is enabled for this arc.</p>}</>}
  </section>;
}
