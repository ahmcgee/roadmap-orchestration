import type { Metadata, ViewEnvelope } from '../../src/console/view-protocol.ts';
import { shellShape, graphShape, unitShape, unitSummaryShape, invocationShape, milestoneShape, metadataShape } from '../../src/console/view-shapes.ts';
import { ApiError } from './prepared-read.ts';
export type Entry={value:ViewEnvelope<any>|null;error:string;loading:boolean;version:string|null;controller?:AbortController;task?:Promise<void>};
const error=(message:string,code='protocol')=>Object.assign(new ApiError(message),{code});
/** One Arc stream, bounded route cache and one in-flight read per normalized route. */
export class ViewStore {
  active=new Map<string,number>();
  ui=new Map<string,unknown>();
  entries=new Map<string,Entry>();listeners=new Set<()=>void>();metadata:Metadata|null=null;identity:ViewEnvelope<unknown>|null=null;
  checkedAt:string|null=null;connected=false;error='';reload=false;generation=0;sequence=0;
  readonly arc:string;readonly protocol:string;readonly read:(path:string,signal:AbortSignal)=>Promise<any>;
  constructor(arc:string,protocol:string,read:(path:string,signal:AbortSignal)=>Promise<any>){this.arc=arc;this.protocol=protocol;this.read=read;}
  emit=()=>{this.sequence++;for(const fn of this.listeners)fn();};
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  snapshot=()=>this.sequence;
  keyVersion(path:string):string|null {
    if(!this.metadata)return null;
    const key=path==='shell'?'shell':path==='graph'?'graph':path.startsWith('milestones/')?'graph':path.startsWith('units/')||path.startsWith('invocations/')?'activity':null;
    return key?this.metadata.viewVersions[key]:JSON.stringify(this.metadata.viewVersions);
  }
  entry(path:string) {let e=this.entries.get(path);if(!e){e={value:null,error:'',loading:false,version:null};this.entries.set(path,e);}return e;}
  admit(raw:any,reset=false,view=false) {
    if(!raw||raw.protocol!==this.protocol)throw error('Reload required: executor version changed');
    if(raw.arc!==this.arc||typeof raw.instance!=='string'||typeof raw.repoId!=='string'||typeof raw.epoch!=='string'||!Number.isSafeInteger(raw.highWater)||raw.highWater<0||!Number.isSafeInteger(raw.revision)||raw.revision<1||!Number.isFinite(Date.parse(raw.checkedAt))||!Number.isFinite(Date.parse(raw.observedAt)))throw error('Malformed console identity');
    const old=this.identity;
    if(old&&!reset&&(raw.instance!==old.instance||raw.repoId!==old.repoId||raw.epoch!==old.epoch))throw error('Observation conflict: verifying a new prefix','conflict');
    if(old&&!reset&&(raw.highWater<old.highWater||!view&&raw.revision<old.revision))return false; // An overtaken concurrent response cannot overwrite newer content.
    if(!old||reset||raw.revision>=old.revision)this.identity=raw;
    if(!this.checkedAt||Date.parse(raw.checkedAt)>=Date.parse(this.checkedAt))this.checkedAt=raw.checkedAt;
    return true;
  }
  notice(raw:any,reset=false) {
    if(!metadataShape(raw))throw error('Malformed metadata or UI schema mismatch');
    if(reset){this.generation++;for(const e of this.entries.values())e.controller?.abort();this.entries.clear();this.identity=null;this.metadata=null;}
    if(!this.admit(raw,reset))return;
    this.metadata=raw;this.error='';this.emit();
  }
  async load(path:string,force=false):Promise<void> {
    const entry=this.entry(path),version=this.keyVersion(path);
    if(entry.task){if(entry.controller?.signal.aborted){await entry.task;return this.load(path,force);}return entry.task;}
    if(!force&&entry.value&&entry.version===version)return;
    const c=new AbortController(),generation=this.generation;entry.controller=c;entry.loading=true;entry.error='';
    const task=(async()=>{
      try {
        const identity=this.identity;
        const query=identity?`${path.includes('?')?'&':'?'}epoch=${encodeURIComponent(identity.epoch)}&minHighWater=${identity.highWater}`:'';
        const raw=await this.read(`/arcs/${encodeURIComponent(this.arc)}/${path}${query}`,c.signal);
        if(c.signal.aborted||generation!==this.generation)return;
        const check=path==='shell'?shellShape:path==='graph'?graphShape:path.startsWith('units/')?path.includes('section=summary')?unitSummaryShape:unitShape:path.startsWith('milestones/')?milestoneShape:path.startsWith('invocations/')?invocationShape:(v:unknown)=>!!v;
        if(!check(raw.data))throw error('Malformed view or UI schema mismatch; reload required');
        const entity=decodeURIComponent(path.split('?')[0]!.split('/')[1]??'');
        if(path.startsWith('units/')&&raw.data.unit.id!==entity||path.startsWith('milestones/')&&raw.data.id!==entity||path.startsWith('invocations/')&&raw.data.invocation.routeId!==entity)throw error('Selected detail identity mismatch','conflict');
        if(entry.value&&(raw.highWater<entry.value.highWater||raw.revision<entry.value.revision))throw error('Overtaken view response; retry','conflict');
        if(!this.admit(raw,false,true))throw error('Journal advanced during this read; retry','conflict');
        entry.value=raw;
        // Initial SSE notice arriving during the read is deduplicated by the actual content version.
        entry.version=path==='shell'||path==='graph'?raw.data.viewVersion:version??this.keyVersion(path);
        this.error='';
        this.entries.delete(path);this.entries.set(path,entry);
        let bytes=0;for(const [key,value] of this.entries)if(key!=='snapshot')bytes+=JSON.stringify(value.value).length*2;
        for(const [key,value] of this.entries){if((this.entries.size<=24&&bytes<=4*1024*1024)||key===path)break;if(key!=='snapshot'&&!this.active.has(key)&&!value.loading){bytes-=JSON.stringify(value.value).length*2;this.entries.delete(key);}}
      }catch(err){if(!c.signal.aborted){entry.error=err instanceof Error?err.message:String(err);if(err instanceof ApiError&&err.code==='protocol')this.reload=true;}}
      finally{if(generation===this.generation){entry.loading=false;delete entry.task;this.emit();const current=this.keyVersion(path);if(!c.signal.aborted&&!entry.error&&this.active.has(path)&&current!==null&&current!==version&&entry.version!==current)void this.load(path);}}
    })();entry.task=task;this.emit();return task;
  }
  abort(path:string){this.entries.get(path)?.controller?.abort();}
  dispose(){this.generation++;for(const e of this.entries.values())e.controller?.abort();}
}
