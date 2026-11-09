// Hash query state stays separate from API admission and opaque paging tokens.
export const activityFields=['window','from','to','zone','afterSeq','beforeSeq','unit','milestone','stage','kind','role','backend','model','outcome','q','housekeeping','order','limit'] as const;
export function activityParams(query:URLSearchParams,zone=Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const result=new URLSearchParams();
  for(const key of activityFields)for(const value of query.getAll(key))result.append(key,value);
  // Activity opens on the latest events regardless of age: a quiet arc never reads as an empty window.
  if(!result.has('window')&&!result.has('from')&&!result.has('to'))result.set('window','arc');
  if(!result.has('zone'))result.set('zone',zone);
  return result;
}
export function shiftDay(day:string,delta:number){return new Date(Date.parse(`${day}T00:00:00Z`)+delta*86400_000).toISOString().slice(0,10);}
/** Resolve a calendar boundary in the selected IANA zone, including DST days.
 * Midnight skipped by a zone change resolves to the first instant of that date. */
export function dayRange(day:string,zone:string):{from:string;to:string} {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)throw Error('Choose a valid calendar day');
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
  const boundary=(date:string)=>{
    let lo=Date.parse(`${date}T00:00:00Z`)-36*3600_000,hi=lo+72*3600_000;
    while(hi-lo>1){const mid=Math.floor((hi+lo)/2);if(format.format(mid)<date)lo=mid;else hi=mid;}
    if(format.format(hi)!==date)throw Error('This calendar day does not exist in the selected timezone');
    return new Date(hi).toISOString();
  };
  return {from:boundary(day),to:boundary(shiftDay(day,1))};
}

/** Browser-local reading position, written only on leaving the console. Never a journal fact. */
const VISIT_KEY='roadmap.previousVisit';
export function saveVisit(marker:{arc:string;epoch:string;highWater:number}) {try{localStorage.setItem(VISIT_KEY,JSON.stringify(marker));}catch{/* storage can be disabled */}}
export function previousVisit(arc:string,epoch:string|undefined):number|null {
  try{const m=JSON.parse(localStorage.getItem(VISIT_KEY)??'null') as {arc:string;epoch:string;highWater:number}|null;return m&&m.arc===arc&&m.epoch===epoch&&Number.isSafeInteger(m.highWater)?m.highWater:null;}catch{return null;}
}
