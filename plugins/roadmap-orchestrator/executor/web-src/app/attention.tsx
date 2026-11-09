import { Table, TableHead, TableRow } from '../components/ui/table.tsx';
import { displayZone, formatInstant, link, pluralise, route, SignalMark, Time } from './shared.tsx';
import { usePlainQuery, PlainPageStatus, PlainPaging, activateRow, FilterBar, moveRowFocus } from './plain-query.tsx';
import { requestReasonWords } from '../../src/console/vocabulary.ts';
import type { AttentionView } from '../../src/console/attention-protocol.ts';
import type { RequestSummary } from '../../src/console/view-protocol.ts';
const subjectLabel=(s:RequestSummary['subject'])=>s.type==='findings'?pluralise(s.count,'finding'):s.type==='arc'?'Arc':'Host';
function countLine({total,blocking,informational}:AttentionView['counts']) {
  if(!blocking)return `${total} open: all for your information`;
  return informational?`${total} open: ${blocking} blocking, ${informational} for your information`:`${total} open: all blocking`;
}
function RequestRow({arc,r,zone}:{arc:string;r:RequestSummary;zone:string}) {
  const href=link(arc,route().tab,'requests',r.id);
  return <TableRow onClick={ev=>activateRow(ev,href)}>
    <td className="col-glyph">{r.blocking?<SignalMark state="held"/>:<i className="info-mark" aria-label="For your information">i</i>}</td>
    <td className="col-request"><a className="request-link" href={href}>{r.summary.text}{r.summary.truncated?'… Open full request':''}</a>
      <p className="request-recommendation"><b>Recommended: </b>{r.recommendationPreview.text}{r.recommendationPreview.truncated&&<span className="muted">… Open to read the rest</span>}</p></td>
    <td>{r.subject.type==='unit'?<><span className="unit-id">{r.subject.id}</span><span className="cell-line">{r.subject.title}</span></>:subjectLabel(r.subject)}</td>
    <td>{requestReasonWords(r.reason)}<span className="cell-line">{r.id}</span></td>
    <td><time dateTime={r.raisedAt}>{formatInstant(r.raisedAt,zone)}</time><span className="cell-line"><Time at={r.raisedAt}/></span></td>
    <td className="number">{r.evidenceCount?pluralise(r.evidenceCount,'file'):'None'}</td>
  </TableRow>;
}
const headers=['','Request','Subject','Reason','Raised','Evidence'];
export function Attention({arc}:{arc:string}) {
  const state=usePlainQuery<AttentionView>(arc,'attention',['blocking','subjectType','reason','q','sort','cursor','limit']),h=state.data;
  const zone=displayZone(),reload=()=>state.navigate({cursor:null},true);
  const blocking=h?.rows.filter(r=>r.blocking)??[],informational=h?.rows.filter(r=>!r.blocking)??[];
  const group=(label:string,rows:RequestSummary[])=>rows.length>0&&<>
    <tr className="group-row"><th colSpan={6} scope="colgroup">{label} ({rows.length})</th></tr>
    {rows.map(r=><RequestRow key={r.id} arc={arc} r={r} zone={zone}/>)}
  </>;
  return <section className="panel"><header className="panel-head"><div><h2>Attention</h2><p className="muted">Decisions waiting for you{h&&h.counts.total>0?`. ${countLine(h.counts)}`:''}</p></div></header>
    <FilterBar label="Attention" resetKey={state.path} search={state.params.get('q')??''} searchHelp="Searches recorded requests." dirty={['blocking','subjectType','reason','q','sort','limit'].some(k=>state.params.has(k))} activeFilters={(state.params.get('blocking')&&state.params.get('blocking')!=='all'?1:0)+['subjectType','reason'].filter(k=>state.params.get(k)).length} apply={values=>{const next:Record<string,string|null>={};for(const key of ['blocking','subjectType','reason','q','sort','limit'])next[key]=String(values.get(key)??'')||null;state.navigate(next);}} reset={()=>state.navigate({blocking:null,subjectType:null,reason:null,q:null,sort:null,cursor:null,limit:null},true)} window={<select name="blocking" aria-label="Blocking" className="filter-window" defaultValue={state.params.get('blocking')??'all'}><option value="all">All requests</option><option value="1">Blocking</option><option value="0">For your information</option></select>}>
      <div className="filter-grid"><label>Subject<select name="subjectType" defaultValue={state.params.get('subjectType')??''}><option value="">All subjects</option>{['unit','arc','host','findings'].map(v=><option key={v} value={v}>{v[0]!.toUpperCase()+v.slice(1)}</option>)}</select></label>
      <label>Reason<select name="reason" defaultValue={state.params.get('reason')??''}><option value="">All reasons</option>{h?.reasons.map(v=><option key={v} value={v}>{requestReasonWords(v)}</option>)}</select></label>
      <label>Order<select name="sort" defaultValue={state.params.get('sort')??'oldest'}><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select></label>
      <label>Rows<select name="limit" defaultValue={state.params.get('limit')??'50'}>{[25,50,100].map(n=><option key={n}>{n}</option>)}</select></label></div>
    </FilterBar>
    <PlainPageStatus {...state} data={h} reload={reload} version="attention" noun="request"/>
    {h&&<>
      {!h.rows.length&&<p>{h.counts.total?'No open requests match these filters. Reset view to show all requests.':'No open requests.'}</p>}
      <Table className="request-table" aria-label="Open human requests" onKeyDown={moveRowFocus}><thead><TableRow>{headers.map((t,n)=><TableHead key={n} className={n===5?'number':undefined}>{t}</TableHead>)}</TableRow></thead><tbody>{group('Blocking work',blocking)}{group('For your information',informational)}</tbody></Table>
      <PlainPaging page={h.page} navigate={state.navigate}/>
    </>}
  </section>;
}
