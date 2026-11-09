import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError, get, protocol } from './shared.tsx';
import { ViewStore } from './view-store.ts';
export function useObservation(arc:string|null,onSelection:(arc:string|null)=>void) {
  const store=useMemo(()=>arc?new ViewStore(arc,protocol,get):null,[arc]);
  useSyncExternalStore(store?.subscribe??(()=>()=>{}),store?.snapshot??(()=>0));
  useEffect(()=>{
    if(!store||!arc)return;
    const stream=new EventSource(`${api}/arcs/${encodeURIComponent(arc)}/events`);
    stream.onopen=()=>{store.connected=true;store.emit();};
    const notice=(event:Event,reset=false)=>{try{const raw=JSON.parse((event as MessageEvent).data);store.notice(raw,reset);onSelection(raw.selected);}catch(err){store.error=err instanceof Error?err.message:String(err);if(err instanceof ApiError&&err.code==='protocol')store.reload=true;store.emit();}};
    stream.addEventListener('revision',ev=>notice(ev));stream.addEventListener('heartbeat',ev=>notice(ev));stream.addEventListener('reset',ev=>notice(ev,true));
    stream.addEventListener('error',ev=>{store.connected=false;const data=(ev as MessageEvent).data;if(data){try{const raw=JSON.parse(data);store.error=raw.message;if(raw.code==='protocol')store.reload=true;}catch{store.error='Console observation error';}}store.emit();});
    let alive=true,attempts=0,timer:ReturnType<typeof setTimeout>;
    const retry=async()=>{
      if(!store.checkedAt||Date.now()-Date.parse(store.checkedAt)>5000){
        try{store.notice(await get(`/arcs/${encodeURIComponent(arc)}/metadata`));attempts=0;if(!store.connected){const selected=await get('/arcs');onSelection(selected.selected);}}catch{attempts++;}
      }
      if(alive)timer=setTimeout(()=>void retry(),Math.min(30_000,3000*2**Math.min(attempts,3)));
    };timer=setTimeout(()=>void retry(),3000);
    const visible=()=>{if(document.visibilityState==='visible')void get(`/arcs/${encodeURIComponent(arc)}/metadata`).then(raw=>store.notice(raw)).catch(()=>{});};
    window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;clearTimeout(timer);stream.close();store.dispose();window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
  },[store]);
  return store;
}
