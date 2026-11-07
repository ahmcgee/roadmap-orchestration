import type { Writable } from 'node:stream';
import { canonicalJson } from '../core/json.ts';
/** Small notices only. A full socket pauses delivery until drain; it is not itself a failed client. */
export class SseWriter {
  #out: Writable; #blocked = false; #queue = new Map<string,string>(); #timer: NodeJS.Timeout | null = null; #timeout: number;
  constructor(out: Writable, timeoutMs = 2000) {
    this.#out=out;this.#timeout=timeoutMs;
    out.on('drain',()=>{this.#blocked=false;if(this.#timer)clearTimeout(this.#timer);this.#timer=null;this.#flush();});
    out.once('close',()=>{if(this.#timer)clearTimeout(this.#timer);this.#queue.clear();});
  }
  send(event:string,data:unknown,id?:string) {
    const frame=`${id?`id: ${id}\n`:''}event: ${event}\ndata: ${canonicalJson(data)}\n\n`;
    if(Buffer.byteLength(frame)>4096)throw new Error('SSE notice exceeds 4 KiB; fetch content through GET');
    this.#queue.set(event,frame);this.#flush();
  }
  #flush(){
    if(this.#blocked||this.#out.destroyed)return;
    for(const [key,frame] of this.#queue){this.#queue.delete(key);if(!this.#out.write(frame)){
      this.#blocked=true;this.#timer=setTimeout(()=>this.#out.destroy(),this.#timeout);this.#timer.unref();return;
    }}
  }
}
