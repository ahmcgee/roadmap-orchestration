import type { Metadata, ViewEnvelope } from '../../src/console/view-protocol.ts';
import { pulseShape, shellShape, graphShape, unitShape, unitSummaryShape, invocationShape, milestoneShape, metadataShape, activityShape, activityChangesShape, activityDetailShape, timelineShape, intervalsShape, holdsShape, holisticShape, attentionShape, requestShape, effortShape, effortScopeShape, resourcesShape, resourceDetailShape, resourceReasonsShape } from '../../src/console/view-shapes.ts';
import { ApiError } from './prepared-read.ts';
/** `failures`: failed loads in a row; `retry`: the timer of the next attempt, after 1, 2, 4, 8, then every 15 seconds; `code`: the
 * last failure's API code ('' for none). `endedAt`/`tookMs`: when the last load ended and how long it took, which pace the next
 * automatic one (`trailing`, its timer). */
export type Entry={value:ViewEnvelope<any>|null;error:string;code:string;loading:boolean;version:string|null;failures:number;controller?:AbortController;task?:Promise<void>;retry?:ReturnType<typeof setTimeout>;
  endedAt?:number;tookMs?:number;trailing?:ReturnType<typeof setTimeout>};
/** How a load is asked: `auto`, because the view's version moved (or it has none yet); `refresh`, the same for a view frozen
 * against notices that follows one version itself (the Resources "now" strip); `force`, by the person (a retry, a navigation). */
type Mode='auto'|'refresh'|'force';
export type Connection='connecting'|'connected'|'reconnecting'|'offline';
export type Lag=Readonly<{shown:boolean;ageMs:number}>;
const RETRY_MS=[1000,2000,4000,8000,15_000];
/** An automatic load of a view that was just loaded (whatever it answered) waits until max(PACE_MS, twice its last load's time) after that load ended;
 * versions arriving meanwhile make one trailing load. So a burst of notices costs a view two loads, and a server twice as slow
 * is asked half as often. */
const PACE_MS=1000;
/** The page's connection and how old its data is, both in the browser's own clock: `connected` while the stream is open and
 * heard from in the last five seconds. The lag line shows past five seconds behind and stays until under two, so captures of
 * three to five seconds do not make it blink; that hysteresis is `store.lagShown`, updated here as `now` ticks. */
export function lagState(store:ViewStore,now:number,discoveryFailed=false):Readonly<{connection:Connection;lag:Lag}> {
  const connection:Connection=store.contactAt===null?(discoveryFailed||store.error?'offline':'connecting'):store.connected&&now-store.contactAt<=5000?'connected':store.opened||store.connected?'reconnecting':'connecting';
  const ageMs=store.asOfAt===null?0:Math.max(0,now-store.asOfAt);
  store.lagShown=store.asOfAt!==null&&(store.lagShown?ageMs>=2000:ageMs>5000);
  return {connection,lag:{shown:store.lagShown,ageMs}};
}
const error=(message:string,code='protocol')=>Object.assign(new ApiError(message),{code});
/** One Arc stream, bounded route cache and one in-flight read per normalized route. */
export class ViewStore {
  active=new Map<string,number>();
  ui=new Map<string,unknown>();
  entries=new Map<string,Entry>();listeners=new Set<()=>void>();metadata:Metadata|null=null;identity:ViewEnvelope<unknown>|null=null;
  /** `opened`: the event stream has connected at least once, so a drop is a reconnection, not a first connection.
   * `contactAt`: when the server was last heard from (any stream frame, or a metadata poll); `asOfAt`: the instant the page's
   * data is as of, from the latest pulse's age (until a connection's first pulse, the notice's checkedAt); `behind`: the
   * latest pulse's word. `checkedAt` is the newest verification seen, for the pill's title only. */
  checkedAt:string|null=null;connected=false;opened=false;error='';reload=false;generation=0;sequence=0;
  contactAt:number|null=null;asOfAt:number|null=null;behind=false;pulsed=false;lagShown=false;
  readonly arc:string;readonly protocol:string;readonly read:(path:string,signal:AbortSignal)=>Promise<any>;
  constructor(arc:string,protocol:string,read:(path:string,signal:AbortSignal)=>Promise<any>){this.arc=arc;this.protocol=protocol;this.read=read;}
  emit=()=>{this.sequence++;for(const fn of this.listeners)fn();};
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  snapshot=()=>this.sequence;
  frozen(path:string){if(path.startsWith('resources/details/booking-')&&!path.includes('cursor='))return false;return path.startsWith('resources')||['activity','timeline','timeline/intervals','timeline/holds','holistic','attention','effort'].includes(path.split('?')[0]!);}
  keyVersion(path:string):string|null {
    if(!this.metadata)return null;
    const key=path.startsWith('resources/details/effort-')?'effort':path.startsWith('resources')?'resources':path.startsWith('effort?')?'effort':path.startsWith('attention')||path.startsWith('requests/')?'attention':path.startsWith('timeline')?'timeline':path.startsWith('holistic')?'holistic':path.startsWith('activity')?'activity':path==='shell'?'shell':path==='graph'?'graph':path.startsWith('milestones/')?'graph':path.startsWith('units/')||path.startsWith('invocations/')?'activity':null;
    return key?this.metadata.viewVersions[key]:JSON.stringify(this.metadata.viewVersions);
  }
  entry(path:string) {let e=this.entries.get(path);if(!e){e={value:null,error:'',code:'',loading:false,version:null,failures:0};this.entries.set(path,e);}return e;}
  admit(raw:any,reset=false,view=false) {
    if(!raw||raw.protocol!==this.protocol)throw error('Reload required: executor version changed');
    if(raw.arc!==this.arc||typeof raw.instance!=='string'||typeof raw.repoId!=='string'||typeof raw.epoch!=='string'||!Number.isSafeInteger(raw.highWater)||raw.highWater<0||!Number.isSafeInteger(raw.revision)||raw.revision<1||!Number.isFinite(Date.parse(raw.checkedAt))||!Number.isFinite(Date.parse(raw.observedAt)))throw error('Malformed console identity');
    const old=this.identity;
    if(old&&!reset&&(raw.instance!==old.instance||raw.repoId!==old.repoId||raw.epoch!==old.epoch))throw error('Observation conflict: verifying a new prefix','conflict');
    // An overtaken notice cannot overwrite newer metadata. A view is judged against its own entry (`load`): it may be a capture
    // behind the notices, and never moves the identity back.
    if(old&&!reset&&!view&&(raw.highWater<old.highWater||raw.revision<old.revision))return false;
    if(!old||reset||raw.revision>=old.revision)this.identity=raw;
    if(!this.checkedAt||Date.parse(raw.checkedAt)>=Date.parse(this.checkedAt))this.checkedAt=raw.checkedAt;
    return true;
  }
  /** A metadata notice from the stream, or from a poll (`polled`): either is contact; a poll carries no pulse, so its
   * checkedAt is the as-of, as a notice's is before a connection's first pulse. */
  notice(raw:any,reset=false,polled=false) {
    if(!metadataShape(raw))throw error('Malformed metadata or UI schema mismatch');
    this.contactAt=Date.now();
    if(polled||!this.pulsed)this.asOfAt=Date.parse(raw.checkedAt);
    if(reset){for(const key of this.ui.keys())if(key.startsWith('detail:')||key.startsWith('scroll:')||key.startsWith('disclosures:')||key.startsWith('holistic-field:')||key.startsWith('window:'))this.ui.delete(key);this.generation++;for(const e of this.entries.values()){e.controller?.abort();clearTimeout(e.retry);clearTimeout(e.trailing);}this.entries.clear();this.identity=null;this.metadata=null;}
    if(!this.admit(raw,reset))return;
    this.metadata=raw;this.error='';this.emit();
  }
  /** The stream's once-a-second word: how old the latest observation is, measured by the server. */
  pulse(raw:any) {
    if(!pulseShape(raw)||raw.arc!==this.arc)throw error('Malformed pulse or UI schema mismatch');
    const now=Date.now();this.contactAt=now;this.asOfAt=now-raw.asOfAgeMs;this.behind=raw.behind;this.pulsed=true;this.emit();
  }
  /** Loads `path` when its version moved (`force`: now, whatever it shows). The one place a notice turns into a request. */
  load(path:string,force=false):Promise<void>{return this.#load(path,force?'force':'auto');}
  /** Loads a view frozen against notices again, paced as a notice's load is: the caller follows its version. */
  refresh(path:string):Promise<void>{return this.#load(path,'refresh');}
  async #load(path:string,mode:Mode):Promise<void> {
    const entry=this.entry(path),version=this.keyVersion(path);
    if(entry.task){if(entry.controller?.signal.aborted){await entry.task;return this.#load(path,mode);}return entry.task;}
    if(mode==='auto'&&entry.value&&(this.frozen(path)||entry.version===version))return;
    // Paced whether the last load succeeded or not: a view the server keeps refusing (an expired anchor) is asked no faster.
    if(mode!=='force'&&entry.endedAt!==undefined){
      const at=entry.endedAt+Math.max(PACE_MS,2*entry.tookMs!);
      if(Date.now()<at){
        if(entry.trailing===undefined){const generation=this.generation;entry.trailing=setTimeout(()=>{delete entry.trailing;if(generation===this.generation&&this.active.has(path))void this.#load(path,mode);},at-Date.now());}
        return;
      }
    }
    clearTimeout(entry.trailing);delete entry.trailing;
    const c=new AbortController(),generation=this.generation,began=Date.now();entry.controller=c;entry.loading=true;clearTimeout(entry.retry);delete entry.retry;
    const task=(async()=>{
      try {
        // Each view asks only for what it already showed, a position this console served: a read never waits for a capture.
        // Activity's new-events count asks for the position the notice names (one this console published): counted on an
        // older capture's index it would miss the new events.
        const identity=this.identity,mark=path.startsWith('activity/changes?')&&this.metadata?`&minHighWater=${this.metadata.highWater}`:entry.value?`&minHighWater=${entry.value.highWater}`:'';
        const query=identity?`${path.includes('?')?'&':'?'}epoch=${encodeURIComponent(identity.epoch)}${mark}`:'';
        const raw=await this.read(`/arcs/${encodeURIComponent(this.arc)}/${path}${query}`,c.signal);
        if(c.signal.aborted||generation!==this.generation)return;
        const check=path.startsWith('resources/details/effort-')?effortScopeShape:path.startsWith('resources/details/')?resourceDetailShape:path.startsWith('resources/reasons?')?resourceReasonsShape:path.startsWith('resources?')?resourcesShape:path.startsWith('effort?')?effortShape:path.startsWith('attention?')?attentionShape:path.startsWith('requests/')?requestShape:path.startsWith('timeline/intervals?')?intervalsShape:path.startsWith('timeline/holds?')?holdsShape:path.startsWith('timeline?')?timelineShape:path.startsWith('holistic?')?holisticShape:path.split('?')[0]==='activity'?activityShape:path.startsWith('activity/changes?')?activityChangesShape:path.startsWith('activity/')?activityDetailShape:path==='shell'?shellShape:path==='graph'?graphShape:path.startsWith('units/')?path.includes('section=summary')?unitSummaryShape:unitShape:path.startsWith('milestones/')?milestoneShape:path.startsWith('invocations/')?invocationShape:(v:unknown)=>!!v;
        if(!check(raw.data))throw error('Malformed view or UI schema mismatch; reload required');
        const entity=decodeURIComponent(path.split('?')[0]!.split('/')[1]??'');
        if(path.startsWith('units/')&&raw.data.unit.id!==entity||path.startsWith('milestones/')&&raw.data.id!==entity||path.startsWith('invocations/')&&raw.data.invocation.routeId!==entity)throw error('Selected detail identity mismatch','conflict');
        if(path.startsWith('resources/details/')&&raw.data.key!==decodeURIComponent(path.split('?')[0]!.split('/')[2]!))throw error('Selected scope identity mismatch','conflict');
        if(path.startsWith('requests/')&&raw.data.id!==entity)throw error('Selected request identity mismatch','conflict');
        if(path.startsWith('activity/')&&!path.startsWith('activity/changes?')&&raw.data.row.id!==entity)throw error('Selected Activity identity mismatch','conflict');
        if(entry.value&&(raw.highWater<entry.value.highWater||raw.revision<entry.value.revision))throw error('Overtaken view response; retry','conflict');
        this.admit(raw,false,true);
        entry.value=raw;entry.error='';entry.code='';entry.failures=0;
        // Initial SSE notice arriving during the read is deduplicated by the actual content version.
        entry.version=path==='shell'||path==='graph'||path.startsWith('timeline')||path.startsWith('holistic')||path.startsWith('attention?')||path.startsWith('effort?')||path.startsWith('resources?')?raw.data.viewVersion:version??this.keyVersion(path);
        this.error='';
        this.entries.delete(path);this.entries.set(path,entry);
        let bytes=0;for(const value of this.entries.values())bytes+=JSON.stringify(value.value).length*2;
        for(const [key,value] of this.entries){if((this.entries.size<=24&&bytes<=4*1024*1024)||key===path)break;if(!this.active.has(key)&&!value.loading){bytes-=JSON.stringify(value.value).length*2;this.entries.delete(key);}}
      }catch(err){if(!c.signal.aborted){
        entry.error=err instanceof Error?err.message:String(err);entry.code=err instanceof ApiError?err.code??'':'';entry.failures++;
        // A failed load keeps what the view had and tries again by itself while the view is open; a changed executor never.
        if(err instanceof ApiError&&err.code==='protocol')this.reload=true;
        else if(this.active.has(path))entry.retry=setTimeout(()=>{delete entry.retry;if(generation===this.generation&&this.active.has(path))void this.load(path,true);},RETRY_MS[Math.min(entry.failures,RETRY_MS.length)-1]);
      }}
      finally{if(generation===this.generation){entry.loading=false;delete entry.task;entry.endedAt=Date.now();entry.tookMs=entry.endedAt-began;this.emit();const current=this.keyVersion(path);if(!this.frozen(path)&&!c.signal.aborted&&!entry.error&&this.active.has(path)&&current!==null&&current!==version&&entry.version!==current)void this.load(path);}}
    })();entry.task=task;this.emit();return task;
  }
  trimUi(){let bytes=0;for(const value of this.ui.values())bytes+=JSON.stringify(value).length*2;for(const [key,value] of this.ui){if(bytes<=4*1024*1024&&this.ui.size<=64)break;bytes-=JSON.stringify(value).length*2;this.ui.delete(key);}}
  /** The view at `path` is no longer shown: its read and its retry stop. */
  abort(path:string){const e=this.entries.get(path);if(!e)return;e.controller?.abort();clearTimeout(e.retry);delete e.retry;clearTimeout(e.trailing);delete e.trailing;}
  dispose(){this.generation++;for(const e of this.entries.values()){e.controller?.abort();clearTimeout(e.retry);clearTimeout(e.trailing);}}
}
