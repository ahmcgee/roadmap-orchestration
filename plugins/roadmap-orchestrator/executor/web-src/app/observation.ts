import { useEffect, useRef, useState } from 'react';
import { api, ApiError, get } from './shared.tsx';
import type { Envelope } from './types.ts';
export function useObservation(arc: string | null) {
  const [e,setEnvelope]=useState<Envelope|null>(null), [error,setError]=useState(''), [checkedAt,setCheckedAt]=useState<string|null>(null), [connected,setConnected]=useState(false), [reload,setReload]=useState(false);
  const current=useRef<Envelope|null>(null);
  useEffect(()=>{
    current.current=null;setEnvelope(null);setCheckedAt(null);setError('');setConnected(false);
    if(!arc)return;
    const c=new AbortController();let fetching=false,again=false,resetPending=false;
    async function capture(reset=false):Promise<void>{
      resetPending ||= reset;
      if(fetching){again=true;return;}fetching=true;
      try{
        const previous=resetPending?null:current.current;resetPending=false;
        const query=previous?`?epoch=${encodeURIComponent(previous.epoch)}&revision=${previous.revision}&minHighWater=${previous.highWater}`:'';
        const next:Envelope=await get(`/arcs/${encodeURIComponent(arc!)}/snapshot${query}`,c.signal);
        if(!next.data?.console||next.arc!==arc||!next.instance||!next.epoch||!Number.isSafeInteger(next.highWater)||!Number.isFinite(Date.parse(next.checkedAt)))throw new Error('Malformed observation payload');
        if(previous&&(next.epoch!==previous.epoch||next.instance!==previous.instance||next.highWater<previous.highWater||next.revision<previous.revision))throw new ApiError('Observation conflict: reconnect to reset');
        current.current=next;setEnvelope(next);setCheckedAt(next.checkedAt);setError('');
      }catch(err){
        if(c.signal.aborted)return;
        if(err instanceof ApiError&&(err.code==='reset'||err.code==='conflict')){setError('Observation reset; verifying a new journal prefix');resetPending=true;again=true;}
        else {const message=err instanceof Error?err.message:String(err);setError(message);if(err instanceof ApiError&&err.code==='protocol')setReload(true);}
      }finally{fetching=false;if(again&&!c.signal.aborted){again=false;void capture();}}
    }
    void capture();
    const stream=new EventSource(`${api}/arcs/${encodeURIComponent(arc)}/events`);
    stream.onopen=()=>setConnected(true);
    stream.addEventListener('revision',()=>void capture());
    stream.addEventListener('reset',()=>{setError('Observation reset; verifying a new journal prefix');void capture(true);});
    stream.addEventListener('heartbeat',(event)=>{try{const notice=JSON.parse((event as MessageEvent<string>).data);if(current.current&&notice.epoch===current.current.epoch&&Number.isFinite(Date.parse(notice.checkedAt))){current.current={...current.current,checkedAt:notice.checkedAt};setCheckedAt(notice.checkedAt);}}catch{setError('Malformed verification heartbeat');}});
    stream.addEventListener('error',(event)=>{setConnected(false);const data=(event as MessageEvent<string>).data;if(data){try{const notice=JSON.parse(data);setError(notice.message);if(notice.code==='protocol')setReload(true);}catch{setError('Console observation error');}}});
    const retry=setInterval(()=>{if(!current.current||Date.now()-Date.parse(current.current.checkedAt)>5000)void capture();},3000);
    return()=>{c.abort();stream.close();clearInterval(retry);};
  },[arc]);
  return {e,error,checkedAt,connected,reload};
}
