import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError, get, protocol } from './shared.tsx';
import { ViewStore } from './view-store.ts';
/** How long the stream may be silent: past five seconds the page asks for /metadata itself; past ten the stream is opened again
 * (one that is open but dead never recovers by itself). */
const SILENT = { pollMs: 5_000, reopenMs: 10_000 } as const;
export function useObservation(arc:string|null,onSelection:(arc:string|null)=>void) {
  const store=useMemo(()=>arc?new ViewStore(arc,protocol,get):null,[arc]);
  useSyncExternalStore(store?.subscribe??(()=>()=>{}),store?.snapshot??(()=>0));
  useEffect(()=>{
    if(!store||!arc)return;
    let stream:EventSource,heard=Date.now();
    const failed=(err:unknown)=>{store.error=err instanceof Error?err.message:String(err);if(err instanceof ApiError&&err.code==='protocol')store.reload=true;store.emit();};
    const notice=(event:Event,reset=false)=>{heard=Date.now();try{const raw=JSON.parse((event as MessageEvent).data);store.notice(raw,reset);onSelection(raw.selected);}catch(err){failed(err);}};
    const open=()=>{
      heard=Date.now();
      stream=new EventSource(`${api}/arcs/${encodeURIComponent(arc)}/events`);
      stream.onopen=()=>{heard=Date.now();store.connected=true;store.opened=true;store.pulsed=false;store.emit();};
      stream.addEventListener('revision',ev=>notice(ev));stream.addEventListener('heartbeat',ev=>notice(ev));stream.addEventListener('reset',ev=>notice(ev,true));
      stream.addEventListener('pulse',ev=>{heard=Date.now();try{store.pulse(JSON.parse((ev as MessageEvent).data));}catch(err){failed(err);}});
      // A server notice named "error" carries data and arrives on an open stream; only a connection error (no data) disconnects.
      stream.addEventListener('error',ev=>{const data=(ev as MessageEvent).data;if(data){heard=Date.now();store.contactAt=heard;try{const raw=JSON.parse(data);store.error=raw.message;if(raw.code==='protocol')store.reload=true;}catch{store.error='Console observation error';}}else store.connected=false;store.emit();});
    };
    open();
    let alive=true,attempts=0,timer:ReturnType<typeof setTimeout>;
    const retry=async()=>{
      if(Date.now()-heard>SILENT.reopenMs){stream.close();store.connected=false;store.emit();open();}
      if(store.contactAt===null||Date.now()-store.contactAt>SILENT.pollMs){
        try{store.notice(await get(`/arcs/${encodeURIComponent(arc)}/metadata`),false,true);attempts=0;if(!store.connected){const selected=await get('/arcs');onSelection(selected.selected);}}catch{attempts++;}
      }
      if(alive)timer=setTimeout(()=>void retry(),Math.min(30_000,3000*2**Math.min(attempts,3)));
    };timer=setTimeout(()=>void retry(),3000);
    const visible=()=>{if(document.visibilityState==='visible')void get(`/arcs/${encodeURIComponent(arc)}/metadata`).then(raw=>store.notice(raw)).catch(()=>{});};
    window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;clearTimeout(timer);stream.close();store.dispose();window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
  },[store]);
  return store;
}
