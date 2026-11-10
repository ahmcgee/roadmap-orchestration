// The time axis Timeline and Resources share: zone-aware ticks, greedy lanes, lane guides, backend-hold words and the whole-arc overview.
import { useRef, useState } from 'react';
import { elapsed, pluralise } from './shared.tsx';
import type { ArcOverview } from '../../src/console/temporal-protocol.ts';
/** Greedy lanes: runs that overlap in time never paint over each other. Runs that only touch at this scale share a lane. */
export function lanes<T>(items:T[],span:(t:T)=>[number,number],minWidth:(t:T)=>number){
  const ends:number[]=[];
  const placed=items.map(item=>({item,span:span(item)})).sort((a,b)=>a.span[0]-b.span[0]).map(({item,span:[a,b]})=>{
    let lane=ends.findIndex(end=>end<=a);if(lane<0){lane=ends.length;ends.push(0);}ends[lane]=Math.max(b,a+minWidth(item));return {item,lane,a,b};
  });
  return {placed,count:Math.max(1,ends.length)};
}
/** Offset of a zone from UTC at an instant, so axis ticks land on that zone's round hours and midnights. */
function zoneOffset(at:number,zone:string){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric'}).formatToParts(new Date(at)).map(x=>[x.type,Number(x.value)]));
  return Date.UTC(p['year']!,p['month']!-1,p['day']!,p['hour']!,p['minute']!)-Math.floor(at/60000)*60000;
}
const steps=[1/6,.5,1,2,5,15,30,60,120,180,360,720,1440,2880].map(m=>m*60000);
export function ticks(lo:number,hi:number,zone:string,target=8){
  const step=steps.find(s=>(hi-lo)/s<=target)??steps.at(-1)!,offset=zoneOffset(lo,zone),out:number[]=[];
  for(let t=Math.ceil((lo+offset)/step)*step-offset;t<hi;t+=step)out.push(t);
  const day=(t:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short'}).format(new Date(t));
  const hour=(t:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',...(step<60000?{second:'2-digit' as const}:{}),hourCycle:'h23'}).format(new Date(t));
  // A window shorter than the smallest step still states its two ends.
  if(out.length<2){const exact=(t:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(t));return [{t:lo,label:exact(lo)},{t:hi,label:exact(hi),end:true}];}
  return out.map((t,n)=>({t,end:false,label:step>=86400000||hour(t).startsWith('00:00')||n===0?`${day(t)}${step<86400000?` ${hour(t)}`:''}`:hour(t)}));
}
/** Faint guides under every lane at the axis ticks, so a bar reads against the shared clock.
 * A background tile one step wide; a percentage position p places it at (lane-tile)*p, so p=first/(100-step). */
export function tickGrid(axis:{t:number}[],x:(t:number)=>number){
  const step=axis.length>1?x(axis[1]!.t)-x(axis[0]!.t):100,first=axis.length?x(axis[0]!.t):0;
  return {'--tick-step':`${step}%`,'--tick-pos':step<100?`${first/(100-step)*100}%`:'0%'} as React.CSSProperties;
}
/** The whole arc at a glance: runs (or bookings) started per slice, backend holds beneath, the selected window outlined.
 * Drag across it to choose a window; select a point to move the current window there. The Filters menu has the same range as text. */
export function Overview({overview:o,noun,zone,lo,hi,open,short}:{overview:ArcOverview;noun:'run'|'booking';zone:string;lo:number;hi:number;open:(from:number,to:number)=>void;short:(at:string)=>string}) {
  const from=Date.parse(o.range.from),to=Date.parse(o.range.to),width=o.range.widthMs,plot=useRef<HTMLDivElement>(null),[drag,setDrag]=useState<[number,number]|null>(null);
  const x=(t:number)=>Math.max(0,Math.min(100,(t-from)/(to-from)*100)),max=Math.max(1,...o.buckets.map(b=>b.count));
  const at=(clientX:number)=>{const r=plot.current!.getBoundingClientRect();return from+Math.max(0,Math.min(1,(clientX-r.left)/r.width))*(to-from);};
  const slice=width>=86400000?'day':width>=3600000?`${width/3600000===1?'hour':`${width/3600000} hours`}`:`${width/60000} minutes`;
  const total=o.buckets.reduce((n,b)=>n+b.count,0);
  return <figure className="timeline-overview">
    <figcaption><strong>Whole arc</strong> <span className="muted">{noun==='run'?'Runs':'Bookings'} started per {slice}. Drag to choose a window.</span></figcaption>
    <div ref={plot} className="timeline-overview-plot" role="img" aria-label={`${pluralise(total,noun)} started across the whole arc, from ${short(o.range.from)} to ${short(o.range.to)}, with ${pluralise(o.backendHolds.matching,'backend hold')}. The selected window is ${short(new Date(lo).toISOString())} to ${short(new Date(hi).toISOString())}.`}
      onPointerDown={ev=>{if(ev.button!==0)return;ev.currentTarget.setPointerCapture(ev.pointerId);const t=at(ev.clientX);setDrag([t,t]);}}
      onPointerMove={ev=>{if(drag)setDrag([drag[0],at(ev.clientX)]);}}
      onPointerUp={ev=>{if(!drag)return;const end=at(ev.clientX),[a,b]=[Math.min(drag[0],end),Math.max(drag[0],end)];setDrag(null);
        if((b-a)/(to-from)*plot.current!.getBoundingClientRect().width>=6)open(a,b);else{const half=(hi-lo)/2;open(end-half,end+half);}}}
      onPointerCancel={()=>setDrag(null)}>
      {o.buckets.map(b=><span key={b.from} className="timeline-overview-bar" style={{left:`${x(Date.parse(b.from))}%`,width:`${Math.max(.3,x(Date.parse(b.to))-x(Date.parse(b.from)))}%`,height:`${Math.max(8,b.count/max*100)}%`}} title={`${short(b.from)} to ${short(b.to)}: ${pluralise(b.count,noun)} started`}/>)}
      {o.backendHolds.rows.map(h=>{const end=h.endedAt??h.terminalAt;return <span key={h.id} className="timeline-overview-hold" style={{left:`${x(Date.parse(h.startedAt))}%`,width:`${Math.max(.3,x(end?Date.parse(end):to)-x(Date.parse(h.startedAt)))}%`}} title={`${h.backend} unavailable from ${short(h.startedAt)}${end?` to ${short(end)}`:''}`}/>;})}
      <span className="timeline-overview-window" style={{left:`${x(lo)}%`,width:`${Math.max(.3,x(hi)-x(lo))}%`}}/>
      {drag&&<span className="timeline-overview-brush" style={{left:`${x(Math.min(...drag))}%`,width:`${Math.abs(x(drag[1])-x(drag[0]))}%`}}/>}
    </div>
    <div className="timeline-overview-time" aria-hidden="true">{ticks(from,to,zone,7).map(a=><span key={a.t} className={a.end?'axis-end':undefined} style={a.end?{right:0}:{left:`${x(a.t)}%`}}>{a.label}</span>)}</div>
    {o.backendHolds.matching>0&&<p className="timeline-overview-key muted"><i className="swatch timeline-hold-swatch" aria-hidden="true"/> Backend unavailable to new calls</p>}
  </figure>;
}
/** An interval that runs past the window's right edge. Its bar keeps its true start; the cap at the edge says it continues. */
export function ContinuesCap({href,top,label}:{href:string;top:number;label:string}) {
  return <a className="timeline-mark timeline-continues" style={{left:'100%',top:`${top}px`}} href={href} aria-label={label} title={label}/>;
}
/** "Open since 7 Nov, 19:58, for 2d 6h. Continues past this window." */
export function continuesWords(startedAt:string,endedAt:string|null,clock:number,short:(at:string)=>string) {
  return endedAt?`Ran from ${short(startedAt)} to ${short(endedAt)}, past the end of this window.`:`Open since ${short(startedAt)}, for ${elapsed(Math.max(0,clock-Date.parse(startedAt)))}. Continues past this window.`;
}
