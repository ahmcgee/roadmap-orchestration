// D1/D2/D3/D8/D10, independent of selected-detail report enrichment.
import { ConsoleError } from '../observation/protocol.ts';
import { sha256Hex } from '../core/json.ts';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import type { BackendHold } from './activity-protocol.ts';
import type { Envelope } from '../observation/protocol.ts';
import { CollectionPages, responseBound } from './collection-pages.ts';
import { allowParams, choice, invalid, known, list, pageLimit, timeParams, resolveTime, intersects } from './query-params.ts';
import { projectionIndex, timelineIntervals, holisticSummaries } from './tab-projections.ts';
import { backendHolds, activityKey } from './backend-holds.ts';
import { arcTerminal } from './tokens.ts';
import { versioned, preview } from './views.ts';
import { unitSignal } from './signals.ts';
import type { Interval, TrackMark } from './view-protocol.ts';
import type { TimelineFilters, TimelineView, IntervalsView, HoldsView, HolisticView, TrackSummary, HolisticAudit, HolisticFinding, HolisticDecision, EvidencePreview, HolisticFieldView } from './temporal-protocol.ts';

const temporalFields = ['window', 'from', 'to', 'zone', 'unit', 'milestone', 'state', 'stage', 'execution', 'q', 'sort', 'subject', 'cursor', 'limit'];
function timelineQuery(params: Record<string, string>): TimelineFilters {
  const q = params['q'] ?? ''; if (q.length > 200) invalid('Timeline search is limited to 200 characters');
  return {...timeParams(params), unit: list(params, 'unit'), milestone: list(params, 'milestone'), state: list(params, 'state'), stage: list(params, 'stage'), execution: list(params, 'execution'),
    q: q.toLowerCase(), sort: choice(params, 'sort', ['plan', 'open', 'longest-open'], 'plan'), subject: params['subject'] ?? null};
}
/** At most 16 marks per track. A crowded track groups items by where they start in the window (16 equal slices,
 * items already open at the window start in the first): one item stays exact, several become a counted cluster.
 * A cluster spans its first and last start; it is never presented as continuous activity. */
export function sliceMarks<T extends {id: string; startedAt: string}, M, C>(rows: T[], lo: number, hi: number, exact: (r: T) => M, cluster: (batch: T[]) => C): (M | C)[] {
  const sorted = [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  if (sorted.length <= 16) return sorted.map(exact);
  const slices = new Map<number, T[]>(), width = Math.max(1, (hi - lo) / 16);
  for (const r of sorted) {const n = Math.max(0, Math.min(15, Math.floor((Date.parse(r.startedAt) - lo) / width))); slices.set(n, [...slices.get(n) ?? [], r]);}
  return [...slices].sort(([a], [b]) => a - b).map(([, batch]) => batch.length === 1 ? exact(batch[0]!) : cluster(batch));
}
function marks(rows: Interval[], subject: string, lo: number, hi: number): TrackMark[] {
  return sliceMarks<Interval, TrackMark, TrackMark>(rows, lo, hi, r => ({type: 'interval', id: r.id, startedAt: r.startedAt, endedAt: r.endedAt, stage: r.stage, outcome: r.outcome, invocation: r.invocation}), batch => {
    const countsByOutcome: Record<string, number> = {};
    for (const row of batch) countsByOutcome[row.outcome] = (countsByOutcome[row.outcome] ?? 0) + 1;
    return {type: 'cluster', from: batch[0]!.startedAt, to: batch.at(-1)!.startedAt, count: batch.length, countsByOutcome, subject};
  });
}
/** Overview slice widths: the smallest that keeps the whole Arc within 168 slices. */
const OVERVIEW_WIDTHS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(m => m * 60_000);
/** The whole Arc at a glance, whatever the window: recorded starts per slice, and every backend hold (first 64). */
export function arcOverview(bounds: {from: string | null; to: string}, starts: readonly string[], arcHolds: BackendHold[]) {
  const arcFrom = Date.parse(bounds.from ?? bounds.to), arcTo = Date.parse(bounds.to) + 1;
  const widthMs = OVERVIEW_WIDTHS.find(w => (arcTo - arcFrom) / w <= 168) ?? OVERVIEW_WIDTHS.at(-1)!, start = Math.floor(arcFrom / widthMs) * widthMs;
  const buckets = new Map<number, number>();
  for (const at of starts) {const n = Math.floor((Date.parse(at) - start) / widthMs); buckets.set(n, (buckets.get(n) ?? 0) + 1);}
  return {range: {from: new Date(start).toISOString(), to: new Date(arcTo).toISOString(), widthMs},
    buckets: [...buckets].sort(([a],[b]) => a-b).map(([n,count]) => ({from: new Date(start+n*widthMs).toISOString(), to: new Date(Math.min(arcTo,start+(n+1)*widthMs)).toISOString(), count})),
    backendHolds: {rows: arcHolds.slice(0,64), matching: arcHolds.length}};
}
// A field key identifies exact retained text, without manufacturing an event/date.
function sourceField(e:Envelope,type:string,id:string,name:'claim'|'oneLine',text:string):EvidencePreview {
  if(text.length<=240)return {text,truncated:false,detail:null};
  const key=sha256Hex(JSON.stringify([e.instance,e.repoId,e.arc,e.epoch,type,id,name,text]));
  let end=240;if(/[\uD800-\uDBFF]/.test(text[end-1]!))end--;
  return {text:text.slice(0,end),truncated:true,detail:null,field:{key,name}};
}
export class ConsoleTemporal {
  readonly pages = new CollectionPages();
  timeline(e: Envelope, params: Record<string, string>, section: 'tracks' | 'intervals' | 'holds' = 'tracks', sourceVersion?: string): TimelineView | IntervalsView | HoldsView {
    allowParams(params, temporalFields);
    if (section === 'tracks' && params['subject'] !== undefined) invalid('subject is an exact interval filter; use unit for tracks');
    if (section !== 'tracks' && params['sort'] !== undefined) invalid('track sorting is only available for tracks');
    if (section === 'holds' && ['unit','milestone','state','stage','execution','q','subject'].some(k => params[k] !== undefined)) invalid('backend holds support only time filters');
    const filters = timelineQuery(params), limit = pageLimit(params, section === 'intervals');
    const data = this.pages.page<Interval | BackendHold | TrackSummary, object>(e, `timeline:${section}`, filters, limit, params['cursor'], () => {
      const {scope, bounds} = resolveTime(e, filters), index = projectionIndex(e), intervals = timelineIntervals(e, index);
      const states = new Map(e.data.display.status.units.map(u => [String(u.unit), u.state]));
      const execution = new Map(index.invocations.rows.map(r => [invocationDirName(invocationIdOf(r.invocation.id)), r.invocation.execution ?? 'unknown']));
      // The recorded values the text filters accept; served with tracks so the browser offers only these.
      const facets = {unit: [...index.identities.keys()], milestone: (e.data.plan?.milestones ?? []).map(m => String(m.id)), stage: [...new Set(intervals.map(r => r.stage))].sort()};
      known(filters.unit, facets.unit, 'unit');
      known(filters.milestone, facets.milestone, 'milestone');
      known(filters.state, ['preparing','ready','running','waiting','blocked','held','parked','awaiting-admission','merged','cut','superseded'], 'current unit state');
      known(filters.stage, facets.stage, 'stage');
      known(filters.execution, ['agent','command','unknown'], 'execution');
      if (filters.subject !== null) known([filters.subject], [...new Set(intervals.map(r => `${r.subject.type}:${r.subject.id}`))], 'subject');
      const matching = intervals.filter(r => {
        const unit = r.subject.type === 'unit' ? r.subject.id : null;
        return (!filters.subject || filters.subject === `${r.subject.type}:${r.subject.id}`)
          && (!filters.unit.length || unit !== null && filters.unit.includes(unit))
          && (!filters.milestone.length || unit !== null && e.data.display.status.milestones.some(m => filters.milestone.includes(m.id) && m.members.includes(unit as never)))
          && (!filters.state.length || unit !== null && filters.state.includes(states.get(unit)!))
          && (!filters.stage.length || filters.stage.includes(r.stage))
          && (!filters.execution.length || filters.execution.includes(execution.get(r.id)!))
          && (!filters.q || `${r.subject.id} ${r.subject.title}`.toLowerCase().includes(filters.q));
      });
      const selected = matching.filter(r => intersects(r.startedAt, r.endedAt, scope.from, scope.to, bounds.to));
      const arcHolds = backendHolds(e.data.events, e.epoch, arcTerminal(e.data)), holds = arcHolds.filter(h => intersects(h.startedAt, h.endedAt ?? h.terminalAt, scope.from, scope.to, bounds.to));
      const base = {...versioned({filters, bounds}, scope), ...(sourceVersion ? {viewVersion: sourceVersion} : {})};
      if (section === 'intervals') return {rows: selected.sort((a,b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)), context: base};
      if (section === 'holds') return {rows: holds, context: base};
      const tracks = new Map<string, Interval[]>();
      for (const interval of selected) {const key = `${interval.subject.type}:${interval.subject.id}`; const rows = tracks.get(key) ?? []; rows.push(interval); tracks.set(key, rows);}
      const planOrder = [...index.identities.keys()];
      const lo = Date.parse(scope.from ?? bounds.from ?? bounds.to), hi = Date.parse(scope.to ?? bounds.to);
      const rows: TrackSummary[] = [...tracks].map(([id, calls]) => ({id, subject: calls[0]!.subject, state: states.get(calls[0]!.subject.id) ?? null,
        signal: calls[0]!.subject.type === 'unit' && states.has(calls[0]!.subject.id) ? unitSignal(states.get(calls[0]!.subject.id)!) : null,
        intervalCount: calls.length, openCount: calls.filter(i => i.endedAt === null).length,
        firstAt: calls.map(i => i.startedAt).sort()[0]!, lastAt: calls.some(i => i.endedAt === null) ? null : calls.map(i => i.endedAt!).sort().at(-1)!,
        marks: marks(calls, id, lo, hi), detail: calls[0]!.subject.type === 'unit' ? {type: 'unit', id: calls[0]!.subject.id} : null}));
      const longest = (t: TrackSummary) => Math.min(...tracks.get(t.id)!.filter(i => i.endedAt === null).map(i => Date.parse(i.startedAt)));
      const order = (a: TrackSummary, b: TrackSummary) => {
        if (a.subject.type === 'unit' && b.subject.type === 'unit') return planOrder.indexOf(a.subject.id) - planOrder.indexOf(b.subject.id);
        return a.subject.type === 'unit' ? -1 : b.subject.type === 'unit' ? 1 : a.id.localeCompare(b.id);
      };
      rows.sort((a,b) => (filters.sort === 'open' ? Number(b.openCount > 0) - Number(a.openCount > 0) : filters.sort === 'longest-open' ? (Number(a.openCount === 0) - Number(b.openCount === 0) || (a.openCount && b.openCount ? longest(a) - longest(b) : 0)) : 0) || order(a,b));
      // The overview covers the whole Arc whatever the window, so the owner can see where to look. Each run counts at its recorded start.
      return {rows, context: {...base, facets, overview: arcOverview(bounds, matching.map(i => i.startedAt), arcHolds)}};
    });
    return responseBound(e, data, limit >= 100 && section !== 'intervals' || limit === 200 ? 256*1024 : 128*1024) as TimelineView | IntervalsView | HoldsView;
  }
  field(e:Envelope,key:string,params:Record<string,string>):HolisticFieldView {
    allowParams(params,['after']);
    const raw=params['after']??'0',after=Number(raw);
    if(!/^(0|[1-9][0-9]*)$/.test(raw)||!Number.isSafeInteger(after))invalid('invalid field offset');
    const s=e.data.display.status;
    const candidates=[...s.findings.active.map(f=>({type:'finding',id:String(f.id),name:'claim' as const,text:f.claim})),...s.decisionsSince.map(d=>({type:'decision',id:`${d.seq}:${d.id}`,name:'oneLine' as const,text:d.oneLine}))];
    const selected=candidates.find(f=>sourceField(e,f.type,f.id,f.name,f.text).field?.key===key);
    if(!selected)throw new ConsoleError('not-found','Holistic field is no longer retained at this identity; reload this view');
    if(after>selected.text.length||after>0&&/[\uD800-\uDBFF]/.test(selected.text[after-1]!)&&/[\uDC00-\uDFFF]/.test(selected.text[after]!))invalid('field offset exceeds text or splits a Unicode character');
    let end=Math.min(selected.text.length,after+2048);if(end<selected.text.length&&/[\uD800-\uDBFF]/.test(selected.text[end-1]!))end--;
    return responseBound(e,versioned({key,name:selected.name,text:selected.text.slice(after,end),offset:after,next:end<selected.text.length?end:null,total:selected.text.length},{basis:'current',from:null,to:null}),16*1024);
  }
  holistic(e: Envelope, params: Record<string, string>, sourceVersion?: string): HolisticView {
    allowParams(params, ['section','cursor','limit']);
    const section = choice(params, 'section', ['audits','findings','decisions'], 'audits'), limit = pageLimit(params);
    const data = this.pages.page(e, 'holistic', {section}, limit, params['cursor'], () => {
      const s = e.data.display.status, summaries = holisticSummaries(e), events = new Map(e.data.events.map(ev => [Number(ev.seq),ev]));
      const audits = summaries.filter(r => r.type === 'audit'), current = s.audit;
      const opened = new Map(e.data.events.flatMap(ev => ev.type === 'fact' && ev.fact.kind === 'finding-opened' ? [[String(ev.fact.id),ev] as const] : []));
      const rows: (HolisticAudit | HolisticFinding | HolisticDecision)[] = summaries.flatMap<HolisticAudit | HolisticFinding | HolisticDecision>(r => {
        if (r.type === 'audit') {
          if (section !== 'audits') return [];
          const ev = events.get(Number(r.id))!;
          const covered = ev.type === 'fact' && ev.fact.kind === 'audit-ended' ? ev.fact.covered : [];
          return [{...r, coverage: covered.slice(0,3).map(c => ({lens:c.lens,from:c.from,to:c.to})), coverageTruncated: covered.length > 3,
            detail: {type:'event',id:activityKey(e.epoch,Number(r.id),'audit-ended')}} as HolisticAudit];
        }
        if (r.type === 'finding') {
          if (section !== 'findings') return [];
          const ev = opened.get(r.id), detail = ev ? {type:'event' as const,id:activityKey(e.epoch,ev.seq,'finding-opened')} : null;
          const source = ev?.type === 'fact' && ev.fact.kind === 'finding-opened' ? ev.fact.source : null;
          const foundBy: HolisticFinding['foundBy'] = source === null ? null : source.type === 'job' ? {type: 'audit', job: source.job} : source.type === 'stage' ? {type: 'stage', unit: source.unit, stage: source.stage} : {type: 'other'};
          return [{...r, detail, foundBy, foundAt: ev?.at ?? null, claim:detail ? preview(s.findings.active.find(f=>f.id===r.id)!.claim,detail) : sourceField(e,'finding',r.id,'claim',s.findings.active.find(f=>f.id===r.id)!.claim)} as HolisticFinding];
        }
        const detail = events.has(r.seq) ? {type:'event' as const,id:`${activityKey(e.epoch,r.seq,'decision')}-${sha256Hex(r.id).slice(0,24)}`} : null;
        return section === 'decisions' ? [{...r, id:`${r.seq}:${r.id}`, recordId:r.id, detail, oneLine:detail ? {...r.oneLine,detail} : sourceField(e,'decision',`${r.seq}:${r.id}`,'oneLine',s.decisionsSince.find(d=>Number(d.seq)===r.seq&&d.id===r.id)!.oneLine)} as HolisticDecision] : [];
      });
      // Audits and decisions are latest first, findings retain canonical order.
      if (section === 'audits' || section === 'decisions') rows.reverse();
      return {rows, context: {...versioned({section, enabled:s.holistic, currentAudit:current ? {running:current.running !== null,job:current.running} : null,
        latestOutcome: audits.length ? {at:audits.at(-1)!.at,job:audits.at(-1)!.job,outcome:audits.at(-1)!.outcome,verdict:audits.at(-1)!.verdict} : null,
        counts:{audits:audits.length,findings:s.findings.active.length,raised:e.data.summary.caught.uniqueFindings,decisions:s.decisionsSince.length}}, {basis:'current',from:null,to:null}), ...(sourceVersion ? {viewVersion:sourceVersion} : {})}};
    });
    return responseBound(e,data,limit===100?128*1024:64*1024) as HolisticView;
  }
}
