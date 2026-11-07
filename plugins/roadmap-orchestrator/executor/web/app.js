/* Roadmap console: classic scripts, React.createElement, no build or runtime downloads. */
(() => {
  'use strict';
  const R = window.React;
  const D = window.AtlasDesignSystem_ee04f2;
  const h = R.createElement;
  const { useState, useEffect, useRef } = R;
  const protocol = document.querySelector('meta[name="roadmap-protocol"]').content;
  const api = `/api/${protocol}`;
  const pluralise = (n, singular, plural = singular + 's') => `${n} ${n === 1 ? singular : plural}`;
  const money = (n) => `$${n.toFixed(2)}`;
  const elapsed = (ms) => ms == null ? 'unrecorded' : ms < 1000 ? `${Math.round(ms)} ms` : D.formatElapsed(ms);
  const words = (value) => typeof value === 'string' ? value : JSON.stringify(value);
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    return parts[0] === 'runs' ? { arc: parts[1], tab: parts[2] || 'overview', unit: parts[3] === 'units' ? parts[4] : null, inv: parts[3] === 'invocations' ? parts[4] : null } : { arc: null, tab: 'overview', unit: null, inv: null };
  }
  const link = (arc, tab = 'overview', kind, id) => `#/runs/${encodeURIComponent(arc)}/${tab}${kind ? `/${kind}/${encodeURIComponent(id)}` : ''}`;
  async function get(path, signal) {
    const response = await fetch(`${api}${path}`, { signal, cache: 'no-store' });
    let value;
    try { value = await response.json(); } catch { throw new Error('Malformed console response'); }
    if (!response.ok) { const error = new Error(value.error?.message || `Console response ${response.status}`); error.code = value.error?.code; throw error; }
    if (value.protocol !== protocol) { const error = new Error('Reload required: executor version changed'); error.code = 'protocol'; throw error; }
    return value;
  }
  function Panel({ title, subtitle, children, extra }) {
    return h('section', { className: 'panel' }, h('div', { className: 'panelhead' }, h('div', null, h('h2', null, title), subtitle && h('p', { className: 'muted' }, subtitle)), extra), children);
  }
  const effortTotal = (row) => ['agent', 'deterministic', 'held', 'queued'].reduce((n, k) => n + (row?.[k] || 0), 0);
  function Effort({ row }) {
    const total = effortTotal(row);
    return total > 0 ? h('div', { className: 'recorded-effort' }, h('p', null, `${elapsed(total)} recorded`), h(D.BreakdownBar, { row }))
      : h('p', { className: 'empty-effort' }, 'No recorded effort yet.');
  }
  function Notice({ hold }) {
    const [recommendation, ...rest] = (hold.detail || '').split(' After reviewing');
    return h('div', { className: 'owner-notice' }, h(D.HoldNotice, { hold: { ...hold, detail: undefined } }),
      recommendation && h('p', null, h('strong', null, 'Recommendation: '), recommendation),
      rest.length > 0 && h('p', null, `After reviewing${rest.join(' After reviewing')}`));
  }
  const Clock = R.createContext(Date.now());
  function relativeTime(at,now) {const n=Math.max(0,Math.floor((now-Date.parse(at))/1000));return n<2?'just now':n<60?`${n}s ago`:n<3600?`${Math.floor(n/60)}m ago`:n<86400?`${Math.floor(n/3600)}h ago`:`${Math.floor(n/86400)}d ago`;}
  function Time({at,prefix=''}) { const now=R.useContext(Clock);if(!at)return h('span',null,'Time unrecorded');const ms=Math.max(0,now-Date.parse(at)),n=Math.floor(ms/1000);return h('time',{dateTime:at,title:new Date(at).toLocaleString()},prefix+(n<2?'just now':n<60?`${n}s ago`:n<3600?`${Math.floor(n/60)}m ago`:n<86400?`${Math.floor(n/3600)}h ago`:`${Math.floor(n/86400)}d ago`)); }
  const wordsState=s=>({pass:'Passed',success:'Succeeded',fail:'Failed',running:'Running',pending:'Ready',held:'On hold',unowned:'Stopped'}[s]||s);
  const stageName=s=>({'pre-build':'Plan review',build:'Build',lanes:'Checks',gate:'Review',candidate:'Integration check',ff:'Merge',snapshot:'Publish snapshot',verifier:'Review'}[s]||(s.startsWith('lane:')?`Check: ${s.slice(5)}`:s));
  const info=(e,a)=>e.data.console.presentation.activityInfo.find(i=>i.id===a.id)||{label:stageName(a.stage),attempt:a.attempt,round:1,spend:0,findings:[]};
  function UnitLink({e,unit,children}){const u=e.data.console.presentation.units.find(u=>u.id===unit);return h('a',{title:u?.title,href:link(e.arc,'overview','units',unit),'aria-label':`Open ${unit} details`},children||u?.title||unit);}
  function Attention({model,arc,tab}) {
    const rows=[...model.attention].sort((a,b)=>Number(b.blocking)-Number(a.blocking));
    return h(Panel,{title:'Attention',subtitle:`${pluralise(rows.length,'open human request')}`},!rows.length&&h('p',null,'Nothing needs a human response.'),rows.map(r=>h('article',{key:r.id,className:'detailsection'},h('h3',null,r.summary),h('p',null,r.blocking?'Blocking · Waiting for a human':'Nonblocking · For your information'),h('p',null,r.subject.type==='unit'?h('a',{href:link(arc,tab,'units',r.subject.unit)},`Affected unit: ${r.subject.unit}`):'Affected: whole arc'),h(Notice,{hold:{reason:'query',label:r.blocking?'Owner decision needed':'Owner notice',detail:r.recommendation}}),r.options.length>0&&h('ul',null,r.options.map(o=>h('li',{key:o.id},h('p',null,o.label),h('code',null,`roadmap ack ${r.id} --choice ${o.id}`)))),!r.options.length&&h('p',null,'To respond in your terminal:'),!r.options.length&&h('code',null,`roadmap ack ${r.id}`),r.evidence.map((path,i)=>h('p',{key:i},r.evidenceLinks?.[i]?h('a',{href:link(arc,tab,'invocations',r.evidenceLinks[i])},`Evidence: ${path.split('/').slice(-2).join('/')}`):path)))));
  }
  function Overview({e,selected,setSelected,open}){
    const m=e.data.console,s=e.data.display.status,p=m.presentation,now=R.useContext(Clock);
    const withdrawn=s.units.filter(u=>['cut','superseded'].includes(u.state)).length;
    const active=p.units.filter(u=>['Running','Preparing'].includes(u.state)),waiting=p.units.filter(u=>u.reasons.length&&!['Merged','Withdrawn','Replaced'].includes(u.state));
    const focus=m.graph.units.find(u=>u.id===selected)||m.graph.units.find(u=>u.status==='active')||m.graph.units[0];
    const visible=new Set([focus?.id,...active.map(u=>u.id),...m.graph.units.filter(u=>u.id.startsWith('milestone:')).map(u=>u.id)]);
    m.graph.edges.forEach(([a,b])=>{if(a===focus?.id||b===focus?.id){visible.add(a);visible.add(b);}});
    const nodes=m.graph.units.length>20?m.graph.units.filter(u=>visible.has(u.id)).slice(0,16):m.graph.units;
    return h(R.Fragment,null,h('div',{className:'metrics'},
      h(D.MetricTile,{label:'Progress',value:`${e.data.summary.progress.merged} / ${e.data.summary.progress.total-withdrawn}`,caption:`${withdrawn} withdrawn · plan revision ${s.plan?.rev??'unrecorded'}`}),
      h(D.MetricTile,{label:'Recorded spend',value:money(e.data.summary.spend.costUsd),caption:'From recorded usage'}),
      h('a',{href:link(e.arc,'attention'),'aria-label':`Attention: ${pluralise(m.attention.length,'open item')}`},h(D.MetricTile,{label:'Open items',value:m.attention.length,caption:`${m.attention.filter(r=>r.blocking).length} waiting on you`})),
      h(D.MetricTile,{label:'CPU in use',value:`${m.tokenOccupancy} / ${p.cpuCapacity??'?'}`,caption:'CPU cores in use'})),
      h(Panel,{title:p.run.endedAt?'Outcome':'Now'},p.run.endedAt?h('p',{className:'outcome'},`${p.run.state}. ${pluralise(e.data.summary.progress.merged,'unit')} merged; ${withdrawn} withdrawn. Recorded spend ${money(e.data.summary.spend.costUsd)}. Elapsed ${elapsed(p.run.elapsedMs)}.`):h('div',{className:'now-grid'},!active.length&&h('p',null,'No unit is currently running.'),active.map(u=>{const a=m.activities.find(a=>a.unit===u.id&&a.status==='active');return h('article',{className:'now-row',key:u.id},h(UnitLink,{e,unit:u.id},h(R.Fragment,null,h('strong',null,u.title),h('small',null,u.id))),h('p',null,`${u.stage==='Build'?'Building':u.stage==='Checks'?'Running checks':u.stage} · ${a?info(e,a).label:'Between recorded operations'} · ${elapsed(a?.startedAt?now-Date.parse(a.startedAt):u.elapsedMs)}`),a&&h('a',{href:link(e.arc,'overview','invocations',a.routeId)},a.kind==='agentic'?`Live agent history: ${u.id}`:`Current check: ${u.id}`));}),waiting.map(u=>h('article',{key:u.id,className:'now-row'},h(UnitLink,{e,unit:u.id},`${u.title} (${u.id})`),h('p',null,u.reasons.join(' · ')),u.waitSince&&h('p',{className:'muted'},`Waiting ${elapsed(now-Date.parse(u.waitSince))}`)))),h('a',{href:link(e.arc,'attention')},`${pluralise(m.attention.length,'open item')} · View Attention`)),
      h(Panel,{title:'Units',subtitle:nodes.length<m.graph.units.length?`Activity neighborhood · ${pluralise(p.units.length,'unit')} in the Units table`:'Select a unit to explore its journey'},focus&&h('div',{className:'selection'},h('strong',null,focus.id),h('span',{className:'selection-intent',title:p.units.find(u=>u.id===focus.id)?.title},p.units.find(u=>u.id===focus.id)?.title||focus.label),h('button',{onClick:()=>open(focus.id),'aria-label':`Open ${focus.id} details`},'Details ↗')),
        h('div',{className:'graph'},h(D.UnitGraph,{units:nodes.map(n=>({...n,label:n.id.length>14?n.id.slice(0,13)+'…':n.id,meta:undefined,elapsedMs:undefined,hold:n.status==='held'?{short:'see details'}:undefined})),edges:m.graph.edges.filter(([a,b])=>nodes.some(u=>u.id===a)&&nodes.some(u=>u.id===b)),selectedId:focus?.id,onSelect:setSelected,onOpen:open,height:380})),
        h('div',{className:'unit-list'},p.units.filter(u=>m.graph.units.length<=20||nodes.some(n=>n.id===u.id)).map(u=>h(UnitLink,{key:u.id,e,unit:u.id},h('span',{className:'unit-card-text'},`${u.title} · ${u.state} (${u.id})`)))),p.units.length>20&&h('p',null,h('a',{href:link(e.arc,'units')},`All ${pluralise(p.units.length,'unit')}`))),
      h('div',{className:'columns'},h(Panel,{title:'Recorded effort',subtitle:'Recorded work and waiting, not wall-clock time'},h(Effort,{row:m.time.total})),h(Panel,{title:'Milestone gates'},s.milestones.length?s.milestones.map(g=>h('p',{key:g.id},h('a',{href:link(e.arc,'overview','units',`milestone:${g.id}`)},e.data.plan?.milestones.find(m=>m.id===g.id)?.text||g.id),` · ${g.id} · ${g.passed?'gate passed':'gate not passed'}`)):h('p',null,'No milestone gates.'))),
      h(Panel,{title:'Recent activity',extra:h('a',{href:link(e.arc,'activity')},'View all activity')},h(ActivityRows,{e,rows:p.feed.filter(row=>!row.housekeeping).slice(0,6)})));
  }
  function Units({e}){const now=R.useContext(Clock);const [sort,setSort]=useState('id'),[desc,setDesc]=useState(false);const p=e.data.console.presentation;
    const rows=p.units.map(u=>({...u,elapsedMs:u.startedAt&&!u.endedAt&&!p.run.endedAt?Math.max(0,now-Date.parse(u.startedAt)):u.elapsedMs})).sort((a,b)=>(typeof a[sort]==='number'?a[sort]-b[sort]:String(a[sort]??'').localeCompare(String(b[sort]??'')))*(desc?-1:1));
    const cols=[['id','Unit'],['state','State'],['stage','Current stage'],['elapsedMs','Elapsed'],['rounds','Rounds'],['attempts','Stage attempts'],['redChecks','Red checks'],['spend','Spend'],['reasons','Waiting reason']];
    return h(Panel,{title:'Units',subtitle:'Every unit · select a column to sort'},h('div',{className:'tablewrap'},h('table',{'aria-label':'All units'},h('thead',null,h('tr',null,cols.map(([key,label])=>h('th',{key,'aria-sort':sort===key?(desc?'descending':'ascending'):'none'},h('button',{onClick:()=>{setDesc(sort===key?!desc:['elapsedMs','redChecks','spend'].includes(key));setSort(key);},'aria-label':`Sort by ${label.toLowerCase()}`},label))))),h('tbody',null,rows.map(u=>h('tr',{key:u.id},h('td',{className:'unit-intent'},h(UnitLink,{e,unit:u.id},u.title),h('small',null,u.id)),h('td',null,u.state),h('td',null,u.stage),h('td',null,elapsed(u.elapsedMs)),h('td',null,u.rounds),h('td',null,u.attempts),h('td',null,u.redChecks),h('td',null,money(u.spend)),h('td',null,u.reasons.join('; ')||'—',u.reasons.length>0&&h('small',null,u.waitSince?`Waiting ${elapsed(now-Date.parse(u.waitSince))}`:'Wait start not recorded'))))))));
  }
  function ActivityRows({e,rows}){return h('ol',{className:'activity-feed'},rows.map(row=>h('li',{key:row.id},h(Time,{at:row.at}),h('a',{href:row.unit?link(e.arc,'overview','units',row.unit):link(e.arc,row.tab||'activity')},row.text))));}
  function Activity({e}){const [housekeeping,setHousekeeping]=useState(false);const [page,setPage]=useState(0),[rows,setRows]=useState(null),[error,setError]=useState('');useEffect(()=>{get(`/runs/${e.arc}/activity?offset=${page*30}&housekeeping=${housekeeping?1:0}`).then(r=>setRows(r.data)).catch(err=>setError(err.message));},[e.arc,e.revision,page,housekeeping]);const p=e.data.console.presentation;
    return h(Panel,{title:'Activity',subtitle:'What happened, newest first'},h('label',{className:'housekeeping-toggle'},h('input',{type:'checkbox',checked:housekeeping,onChange:ev=>{setPage(0);setHousekeeping(ev.target.checked);}}),' Show housekeeping steps'),error&&h('p',{role:'alert'},error),rows&&h(ActivityRows,{e,rows:rows.rows}),h('div',{className:'runbar'},page>0&&h('button',{onClick:()=>setPage(page-1)},'Newer activity'),rows?.more&&h('button',{onClick:()=>setPage(page+1)},'Earlier activity')),
      h('section',{className:'detailsection'},h('h3',null,'Holistic review'),p.holistic.enabled?h(R.Fragment,null,h('p',null,`Holistic audit: ${p.holistic.audit?.running?'Running':p.holistic.audits.length?'Completed':'No audit recorded'}. ${pluralise(p.holistic.activeFindings.length,'active finding')}.`),p.holistic.activeFindings.map((f,i)=>h('p',{key:i},`${f.id}: ${f.claim||f.what||f.title||f.summary||'Finding recorded'} · ${f.state||'active'}`)),h('p',null,`${pluralise(p.holistic.checkpoint.length,'Root decision')} recorded. Checkpoint job detail is not included in this console yet.`)):h('p',null,'No holistic layer is enabled for this arc.')));
  }
  function Resources({e,open}){const m=e.data.console,p=m.presentation,[all,setAll]=useState(false),now=R.useContext(Clock);const openStarts=m.resources.bookings.filter(b=>b.state!=='done').map(b=>b.waitFrom??b.from);const end=m.resources.endAt?m.resources.now:Math.max(m.resources.now,(now-m.resources.origin)/1000),start=all||m.resources.endAt?0:Math.max(0,Math.min(end-120,...openStarts));const slots=m.resources.bookings.filter(b=>b.resource==='integration-slot');
    return h(R.Fragment,null,h(Panel,{title:'Integration slot'},slots.some(b=>b.state==='holding')?slots.filter(b=>b.state==='holding').map(b=>h('p',{key:b.id},`${b.label} holds the integration slot · held ${elapsed((end-b.from)*1000)}`)):h('p',null,'Integration slot is free.'),slots.filter(b=>b.state==='waiting').sort((a,b)=>a.from-b.from).map((b,i)=>h('p',{key:b.id},`Queue position ${i+1}: ${b.label} · waiting ${elapsed((end-b.from)*1000)}`))),
      h(Panel,{title:'Time & resources',subtitle:'Recorded work and waiting, not wall-clock time'},h(Effort,{row:m.time.total}),h('section',{className:'waiting-table'},h('h3',null,'Waiting by reason'),Object.keys(p.waitReasons).length?h('table',{'aria-label':'Waiting by reason'},h('thead',null,h('tr',null,['Reason','Total','Count'].map(v=>h('th',{key:v},v)))),h('tbody',null,Object.entries(p.waitReasons).filter(([,ms])=>ms>0).map(([reason,ms])=>h('tr',{key:reason},h('td',null,reason),h('td',null,elapsed(ms)),h('td',null,p.waitReasonCounts[reason]))))):h('p',null,'No completed waiting measurements.')),m.time.unmeasuredReservations>0&&h('p',null,`${pluralise(m.time.unmeasuredReservations,'unmeasured reservation')} · duration not recorded`),m.time.unallocated>0&&h('p',null,`${elapsed(m.time.unallocated)} waiting spans overlapping reasons.`),m.resources.unknownQueueStarts>0&&h('p',null,`${pluralise(m.resources.unknownQueueStarts,'queue entry has an unrecorded start','queue entries have an unrecorded start')}.`),
      h('div',{className:'runbar'},h('button',{onClick:()=>setAll(v=>!v),'aria-pressed':all},all?'Recent window':'ALL'),h('span',null,m.resources.endAt?`Finished run · ${elapsed(end*1000)}`:'Recent activity window')),
      m.resources.resources.length?h(D.ResourceSchedule,{...m.resources,start,end:Math.max(end,1),now:end,tickEvery:Math.max(1,Math.ceil((end-start)/6)),timeFormat:n=>elapsed(n*1000),title:'Resource bookings',onSelect:open}):h('p',null,'No named resource bookings.'),h('ul',{className:'booking-list','aria-label':'Resource booking details'},m.resources.bookings.filter(b=>b.state!=='waiting').map(b=>h('li',{key:b.id},h('a',{title:new Date(m.resources.origin+b.from*1000).toLocaleString(),href:link(e.arc,'overview','units',b.unitId||b.label)},`${b.label} ${b.state==='done'?'held':'holds'} ${b.resource} ${elapsed(((b.to??end)-b.from)*1000)} at ${elapsed(b.from*1000)}`))))),
      h(CpuEvidence,{e}));
  }
  function CpuEvidence({e}) {
    const m=e.data.console,p=m.presentation,stages=new Map(),units=new Map();
    for(const row of m.cpu){const a=p.activityInfo.find(a=>a.id===row.id),key=`${row.unit}:${a?.stage}:${a?.attempt}`;if(!stages.has(key))stages.set(key,{key,unit:row.unit,activity:a,rows:[]});stages.get(key).rows.push(row);}
    for(const g of stages.values()){
      const measured=g.rows.filter(r=>r.measured?.wallMs>0&&r.reserved>0),wall=measured.reduce((n,r)=>n+r.measured.wallMs,0),reservedTime=measured.reduce((n,r)=>n+r.reserved*r.measured.wallMs,0);
      g.ratio=reservedTime?measured.reduce((n,r)=>n+r.measured.runMs,0)/reservedTime:null;
      g.reserved=wall?reservedTime/wall:null;
      if(!units.has(g.unit))units.set(g.unit,[]);units.get(g.unit).push(g);
    }
    const measured=[...stages.values()].filter(g=>g.ratio!=null),over=measured.filter(g=>g.ratio<.1).length,under=measured.filter(g=>g.ratio>1.25).length;
    return h(Panel,{title:'CPU evidence',subtitle:`CPU in use: ${m.tokenOccupancy} of ${pluralise(p.cpuCapacity??'unrecorded','core')}`},
      p.units.filter(u=>u.reasons.some(r=>/pressure/i.test(r))).map(u=>h('p',{key:u.id},`${u.id}: ${u.reasons.filter(r=>/pressure/i.test(r)).join(', ')}`)),
      h('p',null,measured.length?`${over} of ${pluralise(measured.length,'measured stage')} used under 10% of the cores they reserved${under?`; ${under} used over 125%`:''}.`:'No measured CPU reservations.'),
      h('table',{'aria-label':'CPU evidence'},[...units].map(([unit,groups])=>h('tbody',{key:unit,'data-cpu-group':unit},
        h('tr',null,h('th',{scope:'rowgroup'},h(UnitLink,{e,unit},unit),h('span',{className:'cpu-intent',title:p.units.find(u=>u.id===unit)?.title},p.units.find(u=>u.id===unit)?.title||'Arc work'))),
        groups.map(g=>h('tr',{key:g.key},h('td',{title:g.rows.map(r=>`${r.id}: reservation basis ${r.basis}; demand ${r.demand??'unrecorded'}`).join('; ')},`${stageName(g.activity?.stage||'Recorded work')} · attempt ${g.activity?.attempt??'unrecorded'} — ${g.ratio==null?'CPU measurement or reservation unrecorded':`used ${Math.round(g.ratio*100)}% of ${pluralise(Number(g.reserved.toFixed(2)),'reserved core')}`}`)))))));
  }
  function UnitDetail({e,id,close,stale}) {
    const m=e.data.console,p=m.presentation,u=p.units.find(u=>u.id===id);
    const gate=e.data.display.status.milestones.find(g=>`milestone:${g.id}`===id);
    const now=R.useContext(Clock);const [housekeeping,setHousekeeping]=useState(false);
    if(gate)return h(Dialog,{title:`Milestone ${gate.id}`,close},h('p',null,`${gate.passed?'Gate passed':'Gate not passed'} · ${gate.state}`));
    if(!u)return h(Dialog,{title:'Unit unavailable',close},h('p',null,'This unit is absent from the applied plan.'));
    const activities=m.activities.filter(a=>a.unit===id);
    const rounds=[...new Set(u.journey.map(r=>r.round))];
    const activityRow=routeId=>{
      const a=activities.find(a=>a.routeId===routeId);if(!a)return null;
      const ai=info(e,a);
      return h('p',{key:routeId,className:'journey-activity'},`${a.kind==='agentic'?`Agent · ${a.model||'model unrecorded'}`:ai.label} · ${money(ai.spend)} · ${a.elapsedMs==null?'In progress':elapsed(a.elapsedMs)} · `,h('a',{href:link(e.arc,'overview','invocations',routeId),'aria-label':`${ai.label} attempt ${ai.attempt}: ${a.kind==='agentic'?'agent history':'check log'}`},a.kind==='agentic'?'Agent history ›':'Check log ›'));
    };
    const waiting=w=>h('div',{key:w.at,className:'journey-wait'},h('strong',null,'Waiting during '+w.stage),' · ',h(Time,{at:w.at}),w.reasons.map(r=>h('p',{key:r.reason},`${r.reason}: ${elapsed(r.ms)}`)));
    const stageRow=step=>h('li',{key:step.id},
      h('div',{className:'journey-heading'},h('strong',null,`${step.label} · attempt ${step.attempt}`),h('span',null,step.outcome),h(Time,{at:step.endedAt||step.at})),
      step.findingTitles.map((title,i)=>h('p',{key:i,className:'finding'},title)),step.notes.map(n=>h('p',{key:n},n)),
      u.waiting.filter(w=>w.stage===step.label&&Date.parse(w.at)>=Date.parse(step.at)&&(!step.endedAt||Date.parse(w.at)<=Date.parse(step.endedAt))).map(waiting),
      step.activities.map(activityRow));
    return h(Dialog,{title:id,close},
      h('p',{className:'unit-purpose'},u.title),h('p',{className:'unit-state'},`${u.state} · ${u.stage}`),u.summary!==u.title&&h('p',null,u.summary),
      h('div',{className:'unit-facts'},h('span',null,`${pluralise(u.rounds,'round')} · ${pluralise(u.attempts,'stage attempt')}`),h('span',null,`Spend ${money(u.spend)}`),h('span',null,`Elapsed ${elapsed(u.startedAt?Math.max(0,(u.endedAt||p.run.endedAt?Date.parse(u.endedAt||p.run.endedAt):now)-Date.parse(u.startedAt)):null)}`)),
      u.reasons.length>0&&h('p',{className:'notice'},u.reasons.join(' · ')),
      u.lineage&&h('p',null,'Re-entry from ',h(UnitLink,{e,unit:u.lineage.reenters},u.lineage.reenters)),
      m.attention.filter(r=>r.subject.type==='unit'&&r.subject.unit===id).map(r=>h('section',{key:r.id},h('h3',null,r.summary),h(Notice,{hold:{reason:'query',label:r.blocking?'Waiting on a human':'Owner notice',detail:r.recommendation}}),h('a',{href:link(e.arc,'attention')},'View request and evidence'))),
      h('h3',null,'Journey'),h('label',{className:'housekeeping-toggle'},h('input',{type:'checkbox',checked:housekeeping,onChange:ev=>setHousekeeping(ev.target.checked)}),' Show housekeeping steps'),
      rounds.length?rounds.map(round=>h('section',{className:'journey-round',key:round},h('h3',null,`Round ${round}`),h('ol',null,u.journey.filter(s=>s.round===round&&(housekeeping||!s.housekeeping)).map(stageRow)))):h('p',null,'No stage attempts recorded yet.'),
      h(Effort,{row:m.time.rows.find(row=>row.id===id)||{}}),
      u.waiting.length>0&&h('section',{className:'detailsection'},h('h3',null,'Recorded waiting'),u.waiting.map(waiting)),
      h('section',{className:'detailsection'},h('h3',null,'Acceptance'),h('ul',null,u.acceptance.map((text,i)=>h('li',{key:i},text)))),
      h('section',{className:'detailsection'},h('h3',null,'Checks'),e.data.display.status.units.find(v=>v.unit===id)?.certification?.lanes.map((l,i)=>h('p',{key:i},`Check: ${l.id} · ${l.verdict==='pass'?'Passed':l.verdict==='fail'?'Failed':l.state}`)))
    );
  }
  function Dialog({ title, close, children, className='' }) {
    const ref = useRef(null);
    useEffect(() => {
      const previous = document.activeElement;
      const panel = ref.current;
      panel.querySelector('button')?.focus();
      const key = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const elements = [...panel.querySelectorAll('button, a[href], input, select, summary, [tabindex="0"]')].filter((el) => !el.disabled && el.getClientRects().length);
        if (!elements.length) { event.preventDefault(); return; }
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      panel.addEventListener('keydown', key);
      return () => { panel.removeEventListener('keydown', key); previous?.focus(); };
    }, []);
    return h('div', { className: 'detail', onClick: (ev) => ev.target === ev.currentTarget && close() }, h('section', { ref, className: `detailpanel ${className}`, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'detail-title' },
      h('div', { className: 'detailhead' }, h('div', null, h('div', { className: 'eyebrow' }, 'Roadmap · recorded detail'), h('h2', { id: 'detail-title' }, title)), h('button', { onClick: close, 'aria-label': 'Close details' }, 'Close ✕')), children));
  }
  function HistoryField({ event, field, base, identity }) {
    const [pages, setPages] = useState([]), [cursor, setCursor] = useState(0), [size, setSize] = useState(null), [error, setError] = useState('');
    const load = () => get(`${base}/history-field?identity=${encodeURIComponent(identity)}&ref=${encodeURIComponent(event.refs?.[field] || event.id)}&field=${field}&after=${cursor}`)
      .then(r => { setPages([r.data.text]); setCursor(r.data.next); setSize(r.data.size); setError(''); }).catch(err => setError(err.message));
    return h('details', { className: 'history-expansion', onToggle: ev => { if (ev.currentTarget.open && size === null) load(); } },
      h('summary', null, `Expand full ${field} (preview truncated)`),
      error && h('p', { role: 'alert' }, error), pages.map((text, i) => h('pre', { key: i }, text)),
      size !== null && h('p', { className: 'muted' }, `Characters ${Math.max(0, cursor - pages.join('').length)}–${cursor} of ${size}`),
      size !== null && cursor < size && h('button', { onClick: load }, `Next ${field} page`));
  }
  // Agent history: inert Markdown, schema-aware reports and compact tool records.
  const historyLabel = value => String(value).replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ').replaceAll('-',' ').replace(/^./,c=>c.toUpperCase());
  const historyJson = text => { try { return JSON.parse(text); } catch { return null; } };
  const historyEmpty = value => value == null || value === '' || (Array.isArray(value) ? !value.length : typeof value === 'object' && Object.values(value).every(historyEmpty));
  function HistoryInline({text}) {
    return String(text).split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part,i)=>{
      if(part.startsWith('`'))return h('code',{key:i},part.slice(1,-1));
      if(part.startsWith('**'))return h('strong',{key:i},part.slice(2,-2));
      const link=/^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if(link && /^https?:\/\//i.test(link[2]))return h('a',{key:i,href:link[2],target:'_blank',rel:'noreferrer'},link[1]);
      return part;
    });
  }
  function HistoryMarkdown({text}) {
    const lines=String(text||'').replace(/\r/g,'').split('\n'), blocks=[];
    for(let i=0;i<lines.length;){
      const line=lines[i], fence=/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if(fence){const code=[];i++;while(i<lines.length&&!new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i]))code.push(lines[i++]);i++;blocks.push(h('pre',{key:blocks.length},h('code',null,code.join('\n'))));continue;}
      if(!line.trim()){i++;continue;}
      const heading=/^(#{1,6})\s+(.+)$/.exec(line);
      if(heading){blocks.push(h(`h${Math.min(6,heading[1].length+2)}`,{key:blocks.length},h(HistoryInline,{text:heading[2]})));i++;continue;}
      const item=/^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
      if(item){const ordered=/^\s*\d/.test(line),items=[];while(i<lines.length){const m=/^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(lines[i]);if(!m)break;items.push(h('li',{key:i++},h(HistoryInline,{text:m[1]})));}blocks.push(h(ordered?'ol':'ul',{key:blocks.length},items));continue;}
      if(/^>\s?/.test(line)){const quote=[];while(i<lines.length&&/^>\s?/.test(lines[i]))quote.push(lines[i++].replace(/^>\s?/,''));blocks.push(h('blockquote',{key:blocks.length},h(HistoryMarkdown,{text:quote.join('\n')})));continue;}
      const paragraph=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^\s*(?:#{1,6}\s|[-*+] |\d+[.)] |`{3,}|~{3,}|>)/.test(lines[i]))paragraph.push(lines[i++]);
      blocks.push(h('p',{key:blocks.length},h(HistoryInline,{text:paragraph.join('\n')})));
    }
    return h('div',{className:'history-markdown'},blocks);
  }
  function HistoryValue({value,name=''}) {
    if(historyEmpty(value))return null;
    if(Array.isArray(value))return name==='argv'?h('pre',null,h('code',null,value.join(' '))):h('ul',null,value.filter(v=>!historyEmpty(v)).map((v,i)=>h('li',{key:i},h(HistoryValue,{value:v,name:name==='evidence'?'evidence':''}))));
    if(typeof value==='object'){
      if(typeof value.path==='string'&&typeof value.line==='number')return h('code',{className:'history-evidence'},`${value.path}:${value.line}`);
      const order=['title','claim','text','what','summary','description','name','severity','path','evidence','command','argv','exit','output'];
      const fields=Object.entries(value).filter(([,v])=>!historyEmpty(v)).sort(([a],[b])=>(order.includes(a)?order.indexOf(a):order.length)-(order.includes(b)?order.indexOf(b):order.length));
      return h('dl',{className:'history-fields'},fields.map(([key,v])=>h('div',{key},h('dt',null,historyLabel(key)),h('dd',null,h(HistoryValue,{value:v,name:key})))));
    }
    if(['decision','outcome','severity'].includes(name))return h('span',{className:'history-status','data-status':String(value)},historyLabel(value));
    if(['path','file','contractRef','evidence'].includes(name))return h('code',{className:'history-evidence'},String(value));
    if(['command','output','old_string','new_string','content','code','function'].includes(name))return h('pre',null,h('code',null,String(value)));
    return typeof value==='string'?h(HistoryMarkdown,{text:value}):h('span',null,typeof value==='boolean'?(value?'Yes':'No'):String(value));
  }
  function VerdictCard({value}) {
    if(value==null)return null;
    if(typeof value!=='object'||Array.isArray(value))return h('section',{className:'history-verdict','aria-label':'Agent report'},h('h3',null,'Agent report'),h(HistoryValue,{value}));
    if(value.mode&&value.verdict&&typeof value.verdict==='object')value={mode:value.mode,...value.verdict};
    const decision=value.decision || (typeof value.outcome==='string'?value.outcome:null) || (value.final===true?'Report complete':value.final===false?'Interim report':value.ok===true?'Passed':value.ok===false?'Failed':'Report recorded');
    const order=['summary','reasons','findings','premises','grounding','experiments'];
    const fields=Object.entries(value).filter(([key])=>!['decision','final'].includes(key)).sort(([a],[b])=>(order.includes(a)?order.indexOf(a):order.length)-(order.includes(b)?order.indexOf(b):order.length));
    const empty=fields.filter(([,v])=>historyEmpty(v)).map(([key])=>historyLabel(key));
    return h('section',{className:'history-verdict','aria-label':'Agent verdict'},
      h('div',{className:'history-verdict-head'},h('h3',null,'Agent report'),h('span',{className:'history-status','data-status':String(decision)},historyLabel(decision))),
      fields.filter(([key,v])=>!historyEmpty(v)&&!(key==='outcome'&&typeof v==='string')).map(([key,v])=>h('section',{key,className:'history-verdict-section'},h('h4',null,historyLabel(key)),h(HistoryValue,{value:v,name:key}))),
      empty.length>0&&h('p',{className:'muted history-empty'},`Empty sections: ${empty.join(', ')}.`));
  }
  // Only envelopes emitted by src/prompts are headings; document Markdown stays literal.
  const briefSections=new Set('affected audited_range base_comparison browser build_lanes builder_touches cap_and_allowance changed checkout contracts_index decisions delta diff direction_text disputes driving_the_product escalation evidence_dir evidence_dirs executable_checks failing_lane_evidence finding_bar findings_and_evidence findings_ledger fix_round grounding_first handover history how_your_session_ends implementation intent journeys judging kept_tweaks lane_ledger large_diff last_lane_series lenses merged_units method milestone milestones non_goals not_inlined notes obligations open_findings orientation owner_branches plan previous_findings prior_findings prior_round product reach reach_traits references report required_checks rules_index safety seeing specs standing standing_items standing_obligations subagents suite_lanes system_notes system_traits systems tweak_diff undeclared_contracts unit_policy unit_systems vision vision_first walkthrough_findings witness_checks witnesses_and_lanes working_unattended workspace worktree your_checkout'.split(' '));
  function BriefInstructions({text}) {
    let fence=null,chunk=[];const blocks=[];
    const flush=()=>{const body=chunk.join('\n').trim();chunk=[];if(!body)return;const value=historyJson(body);blocks.push(value!==null?h(HistoryValue,{key:blocks.length,value}):h(HistoryMarkdown,{key:blocks.length,text:body}));};
    for(const line of String(text||'').split('\n')){
      const mark=/^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if(mark){if(!fence)fence=mark[1];else if(mark[1][0]===fence[0]&&mark[1].length>=fence.length)fence=null;chunk.push(line);continue;}
      if(fence){chunk.push(line);continue;}
      for(const part of line.split(/(<\/?[a-z_]+>|<\/?pasted_content id="[a-f0-9]+">)/g)){
        const tag=/^<(\/?)([a-z_]+)(?: id="[a-f0-9]+")?>$/.exec(part);
        if(tag&&(briefSections.has(tag[2])||tag[2]==='pasted_content')){flush();if(!tag[1])blocks.push(h('h4',{key:blocks.length},tag[2]==='pasted_content'?'Recorded diff':historyLabel(tag[2])));}
        else if(part)chunk.push(part);
      }
    }
    flush();return h('div',{className:'history-instructions'},blocks);
  }
  function SeatBrief({brief}) {
    return h('div',{className:'history-seat-brief'},brief.mode&&h('p',null,h('strong',null,'Mode: '),historyLabel(brief.mode)),
      brief.documents.map((doc,i)=>h('details',{key:i,className:'history-document',open:doc.content.length<1600},h('summary',null,doc.source),h(HistoryMarkdown,{text:doc.content}))),
      h('section',null,h('h3',null,'Instructions'),h(BriefInstructions,{text:brief.instructions})));
  }
  function useHistoryText(event,field,base,identity) {
    const [full,setFull]=useState(null),[error,setError]=useState('');
    const original=event?.[field],ref=event?.refs?.[field]||event?.id,truncated=event?.truncated?.includes(field);
    useEffect(()=>{
      setFull(null);setError('');if(!truncated)return;
      const c=new AbortController();
      (async()=>{let after=0,text='';for(;;){const r=(await get(`${base}/history-field?identity=${encodeURIComponent(identity)}&ref=${encodeURIComponent(ref)}&field=${field}&after=${after}`,c.signal)).data;text+=r.text;after=r.next;if(after>=r.size){setFull(text);return;}if(text.length>=8*1024*1024)throw new Error('Record exceeds the history decoder bound');}})().catch(err=>{if(!c.signal.aborted)setError(err.message);});
      return()=>c.abort();
    },[original,ref,truncated,field,base,identity]);
    return {text:full??original,ready:!truncated||full!==null,error};
  }
  // File history helpers: deterministic, bounded work; no filesystem guesses.
  const fileLines = text => text === '' ? [] : String(text).replace(/\n$/, '').split('\n');
  function fileDiff(oldText,newText,oldStart=null,newStart=oldStart,eof=true) {
    const tokens=text=>fileLines(text).map((line,i,all)=>line+(i<all.length-1||!eof||text.endsWith('\n')?'\n':''));
    const a=tokens(oldText),b=tokens(newText),ops=[];
    let prefix=0,suffix=0;
    while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
    while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    for(let i=0;i<prefix;i++)ops.push([' ',a[i]]);
    const aa=a.slice(prefix,a.length-suffix),bb=b.slice(prefix,b.length-suffix);
    if(aa.length*bb.length<=250000){
      const table=Array.from({length:aa.length+1},()=>new Uint32Array(bb.length+1));
      for(let i=aa.length-1;i>=0;i--)for(let j=bb.length-1;j>=0;j--)table[i][j]=aa[i]===bb[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
      let i=0,j=0;while(i<aa.length||j<bb.length){if(i<aa.length&&j<bb.length&&aa[i]===bb[j]){ops.push([' ',aa[i++]]);j++;}else if(i<aa.length&&(j===bb.length||table[i+1][j]>=table[i][j+1]))ops.push(['-',aa[i++]]);else ops.push(['+',bb[j++]]);}
    }else{aa.forEach(line=>ops.push(['-',line]));bb.forEach(line=>ops.push(['+',line]));}
    for(let i=a.length-suffix;i<a.length;i++)ops.push([' ',a[i]]);
    let old=oldStart,next=newStart;
    const numbered=ops.map(([kind,text])=>{const row={kind,text:text.replace(/\n$/,''),noNewline:eof&&!text.endsWith('\n'),oldCursor:old,nextCursor:next,old:kind==='+'?null:old,next:kind==='-'?null:next};if(kind!=='+'&&old!==null)old++;if(kind!=='-'&&next!==null)next++;return row;});
    const ranges=[];
    for(let i=0;i<numbered.length;i++)if(numbered[i].kind!==' '){const start=Math.max(0,i-3),end=Math.min(numbered.length,i+4),last=ranges.at(-1);if(last&&start<=last[1])last[1]=end;else ranges.push([start,end]);}
    const rows=[];
    for(const [start,end] of ranges){const chunk=numbered.slice(start,end),oldCount=chunk.filter(r=>r.kind!=='+').length,newCount=chunk.filter(r=>r.kind!=='-').length;
      const o=oldStart===null?null:chunk[0].oldCursor-(oldCount===0?1:0),n=newStart===null?null:chunk[0].nextCursor-(newCount===0?1:0);
      rows.push({kind:'@',text:o!=null&&n!=null?`@@ -${o},${oldCount} +${n},${newCount} @@`:'@@ changed lines @@'},...chunk.flatMap(row=>row.noNewline?[row,{kind:'@',text:'\\ No newline at end of file'}]:[row]));
    }
    highlightFileRows(rows);
    return {rows,added:ops.filter(r=>r[0]==='+').length,removed:ops.filter(r=>r[0]==='-').length};
  }
  function highlightFileRows(rows) {
    // A cheap common-word boundary highlight within adjacent replacement lines.
    for(let i=0;i<rows.length;i++)if(rows[i].kind==='-'){
      let end=i;while(rows[end]?.kind==='-')end++;
      let plus=end;while(rows[plus]?.kind==='+')plus++;
      for(let k=0;k<Math.min(end-i,plus-end);k++){
        const left=rows[i+k],right=rows[end+k];if(left.text.length+right.text.length>4000)continue;
        let p=0,s=0;while(p<left.text.length&&p<right.text.length&&left.text[p]===right.text[p])p++;
        while(p>0&&/\w/.test(left.text[p-1])&&/\w/.test(left.text[p]||right.text[p]||''))p--;
        while(s<left.text.length-p&&s<right.text.length-p&&left.text.at(-1-s)===right.text.at(-1-s))s++;
        while(s>0&&/\w/.test(left.text[left.text.length-s])&&/\w/.test(left.text[left.text.length-s-1]||right.text[right.text.length-s-1]||''))s--;
        left.mark=[p,left.text.length-s];right.mark=[p,right.text.length-s];
      }i=end-1;
    }
  }
  function resultFileDiff(text) {
    let patches;try{patches=JSON.parse(text).filePatch;}catch{return null;}
    if(!Array.isArray(patches)||!patches.length)return null;
    const rows=[];let added=0,removed=0;
    for(const patch of patches){
      if(!Number.isSafeInteger(patch.oldStart)||!Number.isSafeInteger(patch.newStart)||!Array.isArray(patch.lines))return null;
      let old=patch.oldStart,next=patch.newStart;
      rows.push({kind:'@',text:`@@ -${old},${patch.oldLines} +${next},${patch.newLines} @@`});
      for(const line of patch.lines){
        if(typeof line!=='string')return null;
        if(line.startsWith('\\ No newline')){rows.push({kind:'@',text:line});continue;}
        if(![' ','-','+'].includes(line[0]))return null;
        const kind=line[0];rows.push({kind,text:line.slice(1),old:kind==='+'?null:old,next:kind==='-'?null:next});
        if(kind!=='-')next++;if(kind!=='+')old++;if(kind==='+')added++;if(kind==='-')removed++;
      }
    }
    highlightFileRows(rows);return {rows,added,removed};
  }
  function readFilePreview(output,data) {
    const numbered=String(output||'').split('\n').map(line=>/^\s*(\d+)(?:→|\t)(.*)$/.exec(line)).filter(Boolean);
    if(numbered.length)return {text:numbered.map(m=>m[2]).join('\n'),start:Number(numbered[0][1]),end:Number(numbered.at(-1)[1])};
    const text=String(output||''),start=Number(data.offset)||1;
    return {text,start,end:start+fileLines(text).length-1};
  }
  function shellWritePath(command) {
    const match=/^\s*cat\s*>\s*(?:'([^'\n]+)'|"([^"$`\n]+)"|([^\s<>;&|$`]+))\s*<<-?\s*['"]?([\w-]+)['"]?\s*\n([\s\S]*?)\n\4\s*$/.exec(command);
    return match&&!match[5].split('\n').some(line=>line.trim()===match[4])?(match[1]||match[2]||match[3]):null;
  }
  function fileHistory(events) {
    const files=new Map(),views=new Map();
    for(const e of events){
      if(e.type!=='tool')continue;
      let data;try{data=JSON.parse(e.input);}catch{continue;}
      if(!data||typeof data!=='object')continue;
      const path=data.file_path||data.path,key=`${e.parent||''}:${path}`,before=files.get(key);
      const complete=!e.truncated?.includes('input'),outputReady=!e.truncated?.includes('output');
      if(e.tool==='Read'){
        const read=readFilePreview(e.output,data);views.set(e.id,{read});
        if(e.status==='passed'&&outputReady&&read.start!==null)files.set(key,{...read,eofKnown:false,whole:read.start===1&&fileLines(read.text).length<(Number(data.limit)||2000)});
      }else if(e.tool==='Write'&&complete&&typeof data.content==='string'){
        const result=e.status==='passed'?(e.fileResult?.kind||(/^File created successfully at:/.test(e.output||'')?'create':/has been (?:updated|overwritten) successfully|overwrote existing file/i.test(e.output||'')?'update':null)):null;
        const kind=result||(before?'update':null);
        views.set(e.id,{kind,diff:kind==='update'?(before?.whole?fileDiff(before.text,data.content,1,1,before.eofKnown):resultFileDiff(e.text)):null});
        if(e.status==='passed')files.set(key,{text:data.content,start:1,whole:true,eofKnown:true});
        else if(!e.status)files.delete(key);
      }else if(['Edit','MultiEdit'].includes(e.tool)&&complete){
        const edits=e.tool==='MultiEdit'?data.edits||[]:[data];let current=before?{...before}:null;const rows=[];let added=0,removed=0;
        for(const edit of edits){
          const old=String(edit.old_string??''),next=String(edit.new_string??'');let positions=[];
          if(current&&old){for(let at=current.text.indexOf(old);at>=0;at=current.text.indexOf(old,at+old.length)){positions.push(current.start+current.text.slice(0,at).split('\n').length-1);if(!edit.replace_all)break;}}
          if(!positions.length&&e.tool==='Edit')positions=e.fileResult?.starts||[];
          if(!positions.length)positions=[null];
          let delta=0;for(const start of positions){const diff=fileDiff(old,next,start,start===null?null:start+delta,false);rows.push(...diff.rows);added+=diff.added;removed+=diff.removed;delta+=fileLines(next).length-fileLines(old).length;}
          if(current&&old&&current.text.includes(old))current.text=edit.replace_all?current.text.split(old).join(next):current.text.replace(old,()=>next);else current=null;
        }
        views.set(e.id,{diff:before&&current?fileDiff(before.text,current.text,before.start,before.start,before.eofKnown):resultFileDiff(e.text)||{rows,added,removed},replaceAll:edits.some(edit=>edit.replace_all)});
        if(e.status==='passed'&&current)files.set(key,current);else if(e.status!=='failed')files.delete(key);
      }else if(['Bash','Command'].includes(e.tool)){
        // Shell mutations cannot reliably update the native-tool snapshot.
        const command=data.command||'';if(shellWritePath(command)||/\btee\b|\bsed\s+-[a-z]*i|writeFile(?:Sync)?\s*\(|appendFile(?:Sync)?\s*\(|write_text\s*\(|write_bytes\s*\(|open\([^\n]+['"](?:w|a|x)[+b]?['"]/.test(command))files.clear();
      }
    }
    return views;
  }
  // End file history helpers.
  const FileHistory=R.createContext({views:new Map(),hydrate:()=>{}});
  function FileHistoryProvider({events,children}) {
    const [hydrated,setHydrated]=useState({});
    const hydrate=R.useCallback((id,fields)=>setHydrated(old=>{const before=old[id];if(before?.input===fields.input&&before?.output===fields.output&&before?.text===fields.text)return old;return {...old,[id]:fields};}),[]);
    useEffect(()=>{const ids=new Set(events.map(e=>e.id));setHydrated(old=>Object.keys(old).some(id=>!ids.has(id))?Object.fromEntries(Object.entries(old).filter(([id])=>ids.has(id))):old);},[events]);
    const resolved=R.useMemo(()=>events.map(e=>hydrated[e.id]?{...e,...hydrated[e.id],truncated:(e.truncated||[]).filter(f=>!(f in hydrated[e.id]))}:e),[events,hydrated]);
    const views=R.useMemo(()=>fileHistory(resolved),[resolved]),value=R.useMemo(()=>({views,hydrate}),[views,hydrate]);
    return h(FileHistory.Provider,{value},children);
  }
  function FileLines({rows,diff=false,path='',start=1}) {
    const [all,setAll]=useState(false),shown=all?rows:rows.slice(0,40);
    const tint=text=>{
      if(!/\.(?:[cm]?[jt]sx?|json|md|sh|css|html?)$/i.test(path))return text;
      return text.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:const|let|var|function|return|export|import|from|true|false|null|if|else|class|async|await)\b|^\s*#.*$|\/\/.*$)/g).map((part,i)=>/^(?:["']|\s*#|\/\/)/.test(part)||/^(?:const|let|var|function|return|export|import|from|true|false|null|if|else|class|async|await)$/.test(part)?h('span',{key:i,className:'history-syntax'},part):part);
    };
    return h(R.Fragment,null,h('pre',{className:diff?'history-diff':'history-code'},shown.map((row,i)=>{
      const text=diff?row.text:row,mark=diff&&row.mark;
      return h('div',{key:i,className:diff?`history-diff-line history-diff-${({'-':'remove','+':'add','@':'hunk',' ':'context'})[row.kind]}`:'history-code-line'},
        diff?(row.kind!=='@'&&h(R.Fragment,null,row.old!=null&&h('small',{className:'history-line-number'},row.old),row.next!=null&&h('small',{className:'history-line-number'},row.next))):h('small',{className:'history-line-number'},start+i),
        h('code',null,diff&&row.kind!=='@'?`${row.kind} `:'',mark?h(R.Fragment,null,text.slice(0,mark[0]),h('mark',null,text.slice(...mark)),text.slice(mark[1])):diff?text:tint(text),'\n'));
    })),rows.length>40&&h('button',{className:'history-show-all',onClick:()=>setAll(!all)},all?'Show less':`Show all (${rows.length} lines)`));
  }
  function NativeTool({event,base,identity,onLayout}) {
    const input=useHistoryText(event,'input',base,identity),output=useHistoryText(event,'output',base,identity),patch=useHistoryText(event,'text',base,identity);
    const {views,hydrate}=R.useContext(FileHistory),view=views.get(event.id)||{};
    const data=event.inputFormat==='json'?historyJson(input.text):null;
    useEffect(()=>{if(input.ready&&output.ready&&patch.ready)hydrate(event.id,{input:input.text,output:output.text,text:patch.text});},[event.id,input.text,output.text,patch.text,input.ready,output.ready,patch.ready,hydrate]);
    R.useLayoutEffect(()=>{onLayout?.();},[input.ready,output.ready,patch.ready]);
    const tool=event.tool||'Tool result',path=data?.file_path||data?.path;
    const shell=['bash','command','bash_placeholder'].includes(tool.toLowerCase()),fileTool=['Edit','MultiEdit','Write','Read'].includes(tool);
    const title=path?`${tool==='Read'?'Read · ':fileTool?'':tool+' · '}${path}`:tool==='Grep'?`Grep · ${data?.pattern||'search'}`:tool==='Glob'?`Glob · ${data?.pattern||'files'}`:data?.description?`${tool} · ${data.description}`:historyLabel(tool.replace(/^mcp__playwright__browser_/, 'Browser '));
    const expansion=field=>event.truncated?.includes(field)?h(HistoryField,{event,field,base,identity}):null;
    const status=event.status&&h('span',{className:event.status==='failed'?'history-tool-error':'history-tool-ok',title:event.status==='passed'?'Succeeded':undefined},event.status==='failed'?'Error':fileTool?'✓':'Done');
    const errors=event.status==='failed'&&h('details',{className:'tool-output history-tool-error',open:true},h('summary',null,'Output · error'),h('pre',null,output.text),expansion('output'));
    if(tool==='Read'&&data){
      const read=view.read||readFilePreview(output.text,data),range=event.status==='failed'?'read failed':event.output==null?'reading…':read.end<read.start?'empty file':read.start!==null?`lines ${read.start}–${read.end}`:data.offset?`from line ${data.offset}${data.limit?` · ${data.limit} requested`:''}`:data.limit?`first ${data.limit} lines requested`:'line range unrecorded';
      return h(R.Fragment,null,h('details',{className:'history-read'},h('summary',null,h('strong',{title:path},title),h('small',{className:'muted'},range),event.status==='passed'&&h('small',{className:'muted'},'Show output'),status),event.status!=='failed'&&h('pre',null,h('code',null,read.text))),event.truncated?.includes('input')&&h('div',{className:'tool-input'},expansion('input')),errors);
    }
    const writes=shell&&shellWritePath(data?.command||input.text||'');
    return h(R.Fragment,null,h('header',{className:'history-event-head'},h('strong',null,title),h('span',{className:'history-file-meta'},view.kind&&h('small',{className:`history-file-badge history-file-${view.kind}`},view.kind==='create'?'new file':'overwrote existing file'),view.replaceAll&&h('small',{className:'history-file-badge'},'replace_all'),view.diff&&h('small',{className:'history-diff-count'},h('span',{className:'history-count-add'},`+${view.diff.added}`),h('span',{className:'history-count-remove'},` −${view.diff.removed}`)),status)),
      event.title&&h('small',{className:'muted'},event.title),input.error&&h('p',{role:'alert'},input.error),output.error&&h('p',{role:'alert'},output.error),patch.error&&h('p',{role:'alert'},patch.error),
      event.input!=null&&h('div',{className:'tool-input'},!input.ready?h('p',{className:'muted'},'Reading recorded tool input…'):shell?h(R.Fragment,null,writes&&h('small',{className:'muted'},`writes ${writes}`),h('pre',{className:'history-command'},h('code',null,data?.command||event.input))):
      ['Edit','MultiEdit'].includes(tool)&&data?(view.diff?h(FileLines,{rows:view.diff.rows,diff:true}):h('p',{className:'muted'},'Preparing diff…')):
      tool==='Write'&&data?(view.diff?h(FileLines,{rows:view.diff.rows,diff:true}):h(FileLines,{rows:fileLines(data.content||''),path})):
      data?h(HistoryValue,{value:Object.fromEntries(Object.entries(data).filter(([key])=>!['file_path','path','description'].includes(key)))}):event.input&&h('pre',null,event.input),!fileTool&&expansion('input')),
      errors,!fileTool&&event.status!=='failed'&&event.output!=null&&h('details',{className:'tool-output'},h('summary',null,'Show output'),h('pre',null,event.output),expansion('output')));
  }
  function AgentEvent({event,base,identity,onLayout}) {
    const now=R.useContext(Clock),unknown=event.unknown;
    const expansion=field=>event.truncated?.includes(field)?h(HistoryField,{event,field,base,identity}):null;
    const structured=event.tool==='StructuredOutput';
    const title=unknown?`${(event.title||'Transcript record').replace(/^Unknown\s*/,'')} · recorded event`:structured?(event.status==='failed'?'Report rejected':'Report submitted'):event.type==='result'?'Agent finished':event.title||historyLabel(event.type==='message'?'Agent':event.type);
    return h('article',{className:`history-event history-${event.type}${unknown?' history-unforeseen':''}`,'data-event-id':event.id,'data-tool':event.tool,'data-tool-id':event.toolId,title:event.at?new Date(event.at).toLocaleString():undefined},
      event.parent&&h('small',{className:'muted'},`Subagent of ${event.parent}`),
      event.type==='tool'&&!structured?h(NativeTool,{event,base,identity,onLayout}):h(R.Fragment,null,
        h('header',{className:'history-event-head'},h('strong',null,title),event.at&&h('time',null,relativeTime(event.at,now))),
        unknown?h('details',null,h('summary',null,'Raw event payload'),h('pre',null,historyJson(event.text)?JSON.stringify(historyJson(event.text),null,2):event.text),expansion('text')):
        structured&&event.status==='failed'?h('details',{open:true,className:'tool-output'},h('summary',null,'Output · error'),h('pre',null,event.output),expansion('output')):
        !structured&&event.type!=='result'&&h(R.Fragment,null,h(HistoryMarkdown,{text:event.text}),expansion('text'))),
      (event.tokens!=null||event.elapsedMs!=null)&&h('small',{className:'muted history-event-meta'},[event.tokens!=null?`${pluralise(event.tokens,'token')}`:'',event.elapsedMs!=null?elapsed(event.elapsedMs):''].filter(Boolean).join(' · ')));
  }
  function TranscriptVerdict({event,base,identity,onLayout}) {
    const field=event?.tool==='StructuredOutput'?'input':'text',value=useHistoryText(event,field,base,identity);
    R.useLayoutEffect(()=>{onLayout?.();},[value.ready]);
    if(value.error)return h('p',{role:'alert'},value.error);
    if(!event)return null;
    if(!value.ready)return h('p',{className:'muted'},'Reading agent report…');
    return h(VerdictCard,{value:historyJson(value.text)||value.text});
  }

  function AgentDetail({ e, id, activity, close, stale }) {
    const base = `/runs/${e.arc}/invocations/${id}`;
    const [history, setHistory] = useState(null), [error, setError] = useState(''), [brief, setBrief] = useState(null), [result, setResult] = useState(null);
    const [following, setFollowing] = useState(true), [earlier, setEarlier] = useState(false);
    const scroll = useRef(null), follow = useRef(true), placedScroll = useRef(null);
    useEffect(() => {
      const c = new AbortController(); setHistory(null); setBrief(null); setError(''); setResult(null); setEarlier(false); follow.current=true; setFollowing(true); placedScroll.current=null;
      get(`${base}/prompt?after=0`, c.signal).then(r => setBrief(r.data)).catch(err => { if (!c.signal.aborted) setError(err.message); });
      let fetching=false, again=false;
      const load = async (notice) => {
        if(fetching){again=true;return;} fetching=true;
        try {
          const next=(await get(`${base}/history`,c.signal)).data;
          setHistory(old=>{
            if(!old||notice?.reset||old.identity!==next.identity)return next;
            if(!follow.current)return {...old,state:next.state,endedAt:next.endedAt,unseen:(old.unseen||0)+(notice?.changed||0)};
            const events=new Map(old.events.map(event=>[event.id,event]));for(const event of next.events)events.set(event.id,event);
            const kept=[...events.values()].slice(-200);return {...next,events:kept,before:kept[0]?.id==='0:0'?null:kept[0]?.id};
          });setError('');
        }catch(err){if(!c.signal.aborted)setError(err.message);}finally{fetching=false;if(again&&!c.signal.aborted){again=false;load();}}
      };
      load();
      const stream = new EventSource(`${api}/runs/${e.arc}/events?invocation=${id}`);
      stream.addEventListener('history', ev => load(JSON.parse(ev.data)));
      stream.addEventListener('history-error', ev => { if (ev.data) setError(JSON.parse(ev.data).message); });
      return () => { c.abort(); stream.close(); };
    }, [base]);
    const followLayout=()=>{
      if(!follow.current||!scroll.current)return;
      const verdict=completed?scroll.current.querySelector('.history-verdict'):null;
      scroll.current.scrollTop=verdict?scroll.current.scrollTop+verdict.getBoundingClientRect().top-scroll.current.getBoundingClientRect().top:scroll.current.scrollHeight;
      placedScroll.current=scroll.current.scrollTop;
    };
    R.useLayoutEffect(followLayout,[history,result]);
    const back = () => { location.hash = link(e.arc, 'overview', 'units', activity.unit).slice(1); };
    const more = () => {
      follow.current = false; setFollowing(false);
      get(`${base}/history?before=${history.before}&identity=${encodeURIComponent(history.identity)}`).then(r => {
        setEarlier(true); setHistory(old => ({ ...old, before: r.data.before, events: [...new Map([...r.data.events, ...old.events].map(event => [event.id, event])).values()].slice(0, 200) }));
      }).catch(err => setError(err.message));
    };
    const latest = () => get(`${base}/history`).then(r => { setEarlier(false); follow.current = true; setFollowing(true); setHistory(r.data); }).catch(err => setError(err.message));
    const completed = history?.endedAt != null || ['success', 'pass', 'fail', 'fault', 'lost'].includes(history?.state);
    const live = history?.state === 'running' && !completed && !stale;
    const model = history?.session?.model || [...(history?.events || [])].reverse().find(event => event.model)?.model || activity.model;
    const usage = [...(history?.events || [])].reverse().find(event => event.tokens != null)?.tokens;
    useEffect(()=>{
      if(!completed)return;
      const c=new AbortController();get(`${base}/result`,c.signal).then(r=>setResult(r.data)).catch(err=>{if(!c.signal.aborted)setResult({unavailable:err.message});});return()=>c.abort();
    },[base,completed]);
    const verdictEvent=[...(history?.events||[])].reverse().find(event=>event.report||(event.tool==='StructuredOutput'&&event.status!=='failed'));
    return h(Dialog, { title: `Agent history · ${info(e,activity).label}`, close, className:'agent-detail' },
      h('button', { onClick: back }, `‹ Back to unit ${activity.unit}`),
      h('div', { className: 'history-meta' }, h('strong', null, live ? 'Running' : completed ? 'Finished' : history?.state || 'Connecting'),
        h('span', null, model || 'Model unrecorded'), usage != null && h('span', null, `${pluralise(usage,'recorded token')}`)),
      history?.session && h('details', { className:'history-session' }, h('summary',null,'Session · '+(history.session.model || model || 'model unrecorded')), h('p',null,`Tools: ${history.session.tools.join(', ') || 'unrecorded'}`),history.session.notices.map(n=>h('p',{key:n},n))),
      h('details', { className: 'history-brief' }, h('summary', null, 'Brief · recorded seat prompt'),
        brief?.brief ? h(SeatBrief,{brief:brief.brief}) : brief ? h(R.Fragment, null, h(HistoryMarkdown,{text:brief.lines.join('\n')}), brief.end < brief.size && h('button', { onClick: () => get(`${base}/prompt?after=${brief.end}`).then(r => setBrief(r.data)).catch(err => setError(err.message)) }, `Next brief page (${brief.end} of ${pluralise(brief.size,'byte')})`)) : h('p', null, 'Reading retained brief…')),
      error && h('p', { role: 'alert' }, error),
      h('div', { className: 'history-controls' }, history?.before != null && h('button', { onClick: more }, 'Show earlier'), live && h('button', { onClick: latest }, following ? 'Following live tail' : `Follow live tail${history?.unseen ? ` (${pluralise(history.unseen,'update')})` : ''}`), completed && (earlier||!following||history?.unseen) && h('button',{onClick:latest},'Show latest'), earlier && h('span', null, `Earlier history · latest ${pluralise(200,'event')} retained in view`)),
      h('div', { className: 'history-scroll', ref: scroll, tabIndex: 0, 'aria-label': 'Agent transcript', onScroll: ev => { if(placedScroll.current!=null&&Math.abs(ev.currentTarget.scrollTop-placedScroll.current)<1){placedScroll.current=null;return;}placedScroll.current=null;follow.current = ev.currentTarget.scrollHeight - ev.currentTarget.scrollTop - ev.currentTarget.clientHeight < 48; setFollowing(follow.current); } },
        h(FileHistoryProvider,{key:history?.identity,events:history?.events||[]},history?.events.map(event => h(AgentEvent, { key: `${history.identity}:${event.id}`, event, activity:{...activity,name:`${info(e,activity).label} · attempt ${info(e,activity).attempt}`}, base, identity: history.identity, onLayout:followLayout }))),
        result?.report!=null?h(VerdictCard,{value:result.report}):h(TranscriptVerdict,{event:verdictEvent,base,identity:history?.identity,onLayout:followLayout}),
        history && !history.events.length && h('p', null, 'Waiting for complete transcript records…'),
        live && h('p', { className: 'history-live', role: 'status' }, 'Agent is working', h('span', { className: 'history-caret', 'aria-hidden': true }))),
      h('div', { className: 'history-links' },
        h('details',{onToggle:ev=>{if(ev.currentTarget.open&&!result)get(`${base}/result`).then(r=>setResult(r.data)).catch(err=>setResult({unavailable:err.message}));}},h('summary',null,'Raw result.json'),
          result?.raw?h('pre',{className:'record'},result.raw):h('p',{className:'muted'},result?.unavailable||'Reading retained result…')),
        h(TranscriptText,{base})));
  }

  function TranscriptText({base}) {
    const [page,setPage]=useState(null),[error,setError]=useState('');
    const load=after=>get(`${base}/log?source=stdout&after=${after}`).then(r=>setPage(r.data)).catch(e=>setError(e.message));
    return h('details',{onToggle:ev=>{if(ev.currentTarget.open&&!page)load(0);}},h('summary',null,'Transcript text'),error&&h('p',{role:'alert'},error),page&&h(R.Fragment,null,h('pre',{className:'record'},page.text),h('p',null,`Bytes ${page.after}–${page.next} of ${page.size}`),page.after>0&&h('button',{onClick:()=>load(Math.max(0,page.after-65536))},'Show earlier text'),page.next<page.size&&h('button',{onClick:()=>load(page.next)},'Next text page')));
  }
  function InvocationDetail(props) {
    const activity = props.e.data.console.activities.find(a => a.routeId === props.id);
    return activity?.kind === 'agentic' ? h(AgentDetail, { ...props, activity }) : h(CommandDetail, props);
  }
  function CommandDetail({ e, id, close, stale }) {
    const activity = e.data.console.activities.find((a) => a.routeId === id);
    const [source, setSource] = useState('stdout'), [page, setPage] = useState(null), [error, setError] = useState('');
    const [result, setResult] = useState(null);
    useEffect(() => {
      const c = new AbortController(); setPage(null); setError(''); setResult(null);
      if (source === 'result') get(`/runs/${e.arc}/invocations/${id}/result`, c.signal).then((r) => setResult(r.data)).catch((err) => { if (!c.signal.aborted) setError(err.message); });
      else get(`/runs/${e.arc}/invocations/${id}/log?source=${source}&after=0`, c.signal).then((r) => setPage(r.data)).catch((err) => { if (!c.signal.aborted) setError(err.message); });
      return () => c.abort();
    }, [id, source]);
    const more = () => get(`/runs/${e.arc}/invocations/${id}/log?source=${source}&after=${page.next}&identity=${page.identity}`).then((r) => setPage(r.data)).catch((err) => setError(err.message));
    const phase = activity && { id: activity.id, name: info(e,activity).label, status: activity.status === 'held' ? 'pending' : activity.status,
      ...(activity.elapsedMs == null ? {} : { elapsedMs: activity.elapsedMs }), summary: `${source} · ${page ? `bytes ${page.after}–${page.next} of ${page.size}` : 'recorded output'}`, lines: (page?.text || '').split('\n').map((text) => ({ level: 'info', text })) };
    return h(Dialog, { title: activity ? info(e,activity).label : `Invocation ${id}`, close },
      h('div', { className: 'runbar' }, ['stdout', 'stderr', 'runner.log', 'result'].map((s) => h('button', { key: s, onClick: () => setSource(s), 'aria-pressed': source === s }, s))),
      error && h('p', { role: 'alert', className: 'notice' }, error),
      result && h('pre', { className: 'record' }, result.lines.join('\n')),
      page?.text && h('p',{className:'log-summary'},h('strong',null,'First output on this page: '),page.text.split('\n')[0]),
      page && activity && h(D.StepLog, { activity: { ...activity, name: info(e,activity).label, startedAt: undefined, status: stale && activity.status === 'active' ? 'pending' : activity.status, kind: 'deterministic' }, log: { summary: 'Text-only recorded output; timestamps and levels are not inferred.', phases: [phase] } }),
      page && page.after > 0 && h('button', { onClick: () => get(`/runs/${e.arc}/invocations/${id}/log?source=${source}&after=${Math.max(0,page.after-65536)}&identity=${page.identity}`).then(r=>setPage(r.data)).catch(err=>setError(err.message)) }, 'Show earlier log'),
      page && page.next < page.size && h('button', { onClick: more }, 'Next log page'));
  }
  function App() {
    const [where, setWhere] = useState(route), [runs, setRuns] = useState([]), [selectedArc, setArc] = useState(null);
    const [e, setEnvelope] = useState(null), [error, setError] = useState(''), [checkedAt, setCheckedAt] = useState(null);
    const [selected, setSelected] = useState(null), [now, setNow] = useState(Date.now());
    const current = useRef(null);
    useEffect(() => { const f = () => setWhere(route()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
    useEffect(() => {
      const c = new AbortController();
      const poll = () => get('/runs', c.signal).then((r) => { setRuns(r.runs); setArc(where.arc || r.selected); }).catch((err) => { if (!c.signal.aborted) setError(err.code === 'protocol' ? 'Reload required: executor version changed' : err.message); });
      poll(); const timer = setInterval(poll, 2000); return () => { c.abort(); clearInterval(timer); };
    }, [where.arc]);
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
    useEffect(() => {
      current.current = null; setEnvelope(null); setCheckedAt(null); setError('');
      if (!selectedArc) return;
      const c = new AbortController(); let fetching = false, again = false;
      async function capture(reset = false) {
        if (fetching) { again = true; return; } fetching = true;
        try {
          const previous = reset ? null : current.current;
          const query = previous ? `?epoch=${previous.epoch}&revision=${previous.revision}&minHighWater=${previous.highWater}` : '';
          const next = await get(`/runs/${selectedArc}/snapshot${query}`, c.signal);
          if (!next.data?.console || next.arc !== selectedArc || !next.instance || !next.epoch || !Number.isSafeInteger(next.highWater) || !Number.isFinite(Date.parse(next.checkedAt))) throw new Error('Malformed observation payload');
          if (previous && (next.epoch !== previous.epoch || next.highWater < previous.highWater || next.revision < previous.revision)) throw new Error('Observation conflict: reconnect to reset');
          current.current = next; setEnvelope(next); setCheckedAt(next.checkedAt); setError('');
        } catch (err) {
          if (c.signal.aborted) return;
          if (err.code === 'reset' || err.code === 'conflict') { fetching = false; setError('Observation reset; verifying a new journal prefix'); return capture(true); }
          setError(err.code === 'protocol' ? 'Reload required: executor version changed' : err.message);
        } finally { fetching = false; if (again) { again = false; void capture(); } }
      }
      capture();
      const stream = new EventSource(`${api}/runs/${selectedArc}/events`);
      stream.addEventListener('revision', () => capture());
      stream.addEventListener('reset', () => { setError('Observation reset; verifying a new journal prefix'); capture(true); });
      stream.addEventListener('heartbeat', (event) => { try { const notice = JSON.parse(event.data); if (current.current && notice.epoch === current.current.epoch && Number.isFinite(Date.parse(notice.checkedAt))) { current.current = { ...current.current, checkedAt: notice.checkedAt }; setCheckedAt(notice.checkedAt); } } catch { setError('Malformed verification heartbeat'); } });
      stream.addEventListener('error', (event) => { if (event.data) { try { setError(JSON.parse(event.data).message); } catch { setError('Console observation error'); } } });
      const retry = setInterval(() => { if (!current.current || Date.now() - Date.parse(current.current.checkedAt) > 5000) capture(); }, 3000);
      return () => { c.abort(); stream.close(); clearInterval(retry); };
    }, [selectedArc]);
    const stale = !checkedAt || now - Date.parse(checkedAt) > 5000 || Boolean(error);
    const arc = selectedArc, tab = ['overview', 'units', 'activity', 'resources', 'attention'].includes(where.tab) ? where.tab : 'overview';
    const open = (id) => { location.hash = link(arc, tab, 'units', id).slice(1); };
    const close = () => { location.hash = link(arc, tab).slice(1); };
    const p=e?.data.console.presentation,clock=stale?Date.parse(checkedAt||e?.observedAt||new Date(now).toISOString()):now;
    const hostUrl=new URL(location.origin);if(hostUrl.hostname==='127.0.0.1'||hostUrl.hostname==='[::1]')hostUrl.hostname='localhost';
    const header=h('header',{className:'topline',inert:where.unit||where.inv?'':undefined,'aria-hidden':where.unit||where.inv?true:undefined},h('div',null,h('div',{className:'identity'},h('h1',null,'Roadmap'),h('span',{className:'eyebrow'},arc||'Run console')),h('p',{className:'run-state'},p?.run.state||'Connecting'),p&&h('p',{className:'run-times'},h(Time,{at:p.run.startedAt,prefix:'Started '}),' · ',`Elapsed ${elapsed(p.run.endedAt?p.run.elapsedMs:clock-Date.parse(p.run.startedAt))}`,p.run.endedAt&&h(R.Fragment,null,' · ',h(Time,{at:p.run.endedAt,prefix:'Ended '})))),
      h('div',{className:'connection',role:'status'},h(D.StatusIndicator,{status:stale?'down':'operational',label:stale?'Disconnected/stale':'Connected'}),checkedAt&&h(Time,{at:checkedAt,prefix:stale?'Last updated ':'Updated '}),h('a',{href:hostUrl.origin},hostUrl.origin)));
    return h(Clock.Provider, {value:clock}, h(R.Fragment, null, h('a', { className: 'skip', href: '#content', onClick: (ev) => { ev.preventDefault(); document.getElementById('content').focus(); } }, 'Skip to content'), h('div', { className: 'shell', 'data-stale': stale }, header,
      h('div', { className: 'runbar', inert:where.unit||where.inv?'':undefined,'aria-hidden':where.unit||where.inv?true:undefined }, h('label', null, 'Run ', h('select', { 'aria-label': 'Run', value: arc || '', onChange: (ev) => { location.hash = link(ev.target.value).slice(1); } }, runs.length ? runs.map((r) => h('option', { key: r.arc, value: r.arc }, r.arc)) : h('option', { value: '' }, 'No retained runs'))),
        h('a', { href: '#/' }, where.arc ? 'Follow current run' : 'Following current run'),
        h('nav', { className: 'nav', 'aria-label': 'Roadmap views' }, [['overview', 'Overview'], ['units','Units'], ['activity','Activity'], ['resources', 'Time & resources'], ['attention', 'Attention']].map(([key, text]) => h('a', { key, href: arc ? link(arc, key) : '#/', 'aria-current': key === tab ? 'page' : undefined }, text)))),
      error && h('p', { role: 'alert', className: 'notice' }, error),
      h('main', { id: 'content', tabIndex: -1, inert:where.unit||where.inv?'':undefined,'aria-hidden':where.unit||where.inv?true:undefined }, e ? tab === 'units' ? h(Units,{e}) : tab === 'activity' ? h(Activity,{e}) : tab === 'resources' ? h(Resources, { e, open }) : tab === 'attention' ? h(Attention, { model: e.data.console, arc, tab }) : h(Overview, { e, selected, setSelected, open }) : h('p', { className: 'empty' }, arc ? 'Waiting for a verified observation…' : 'No retained runs in this repository.')),
      e && where.unit && h(UnitDetail, { e, id: where.unit, close, stale }),
      e && where.inv && h(InvocationDetail, { e, id: where.inv, close, stale }))));
  }
  class ErrorBoundary extends R.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    render() { return this.state.error ? h('main', { className: 'shell' }, h('h1', null, 'Roadmap'), h('p', { role: 'alert' }, `Console rendering failed: ${this.state.error.message}`)) : this.props.children; }
  }
  window.ReactDOM.createRoot(document.getElementById('root')).render(h(ErrorBoundary, null, h(App)));
})();
