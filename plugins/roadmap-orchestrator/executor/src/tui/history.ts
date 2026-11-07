// Bounded structured transcript projection, shared with the console. Complete records only.
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { decodeTranscript, type TranscriptEvent } from './transcript.ts';
export const HISTORY_PAGE = 50;
const WINDOW = 1024 * 1024;
const RECORD_LIMIT = 8 * WINDOW;
const FIELD_LIMIT = 4096;
const PREVIEW_LIMIT = 1000;
export type HistoryEvent = TranscriptEvent & { id: string; truncated?: string[]; refs?: Partial<Record<'text' | 'input' | 'output' | 'title', string>> };
export type HistoryPreview = Omit<HistoryEvent, 'legacy'> & { truncated: string[] };
export function previewEvent(event: HistoryEvent): HistoryPreview {
  const { legacy: _legacy, ...out } = event;
  const truncated: string[] = [...(event.truncated ?? [])];
  for (const field of ['text', 'input', 'output', 'title'] as const) if (out[field] !== undefined && out[field].length > PREVIEW_LIMIT) {
    out[field] = out[field].slice(0, PREVIEW_LIMIT); truncated.push(field);
  }
  return { ...out, truncated };
}
export function expandEvent(event: HistoryEvent, field: string, after: number) {
  if (!['text', 'input', 'output', 'title'].includes(field)) throw new Error('unknown event field');
  const text = event[field as 'text'] ?? '';
  if (!Number.isSafeInteger(after) || after < 0 || after > text.length) throw new Error('invalid expansion cursor');
  return { text: text.slice(after, after + FIELD_LIMIT), next: Math.min(text.length, after + FIELD_LIMIT), size: text.length };
}
export function pairEvents(events: readonly HistoryEvent[]): HistoryEvent[] {
  const out: HistoryEvent[] = []; const tools = new Map<string, number>();
  for (const event of events) {
    const key = `${event.parent ?? ''}:${event.toolId ?? ''}`;
    const previous = event.toolId ? tools.get(key) : undefined;
    if (event.type === 'tool' && previous !== undefined) {
      const before = out[previous]!;
      out[previous] = { ...before, ...event, id: before.id,
        ...((before.tool ?? event.tool) !== undefined ? { tool: (before.tool ?? event.tool)! } : {}),
        ...((before.input ?? event.input) !== undefined ? { input: (before.input ?? event.input)! } : {}), refs: { ...before.refs, ...event.refs }, legacy: before.legacy };
    } else {
      if (event.type === 'tool' && event.toolId) tools.set(key, out.length);
      out.push(event.resultFor && !event.tool ? { ...event, tool: event.resultFor, title: 'Tool result · call is on an earlier page' } : event);
    }
  }
  return out;
}
function bytes(fd: number, from: number, to: number) {
  const data = Buffer.alloc(Math.max(0, to - from)); let n = 0;
  while (n < data.length) { const got = readSync(fd, data, n, data.length - n, from + n); if (!got) break; n += got; }
  return data.subarray(0, n);
}
function decode(fd: number, start: number, end: number, decoder: typeof decodeTranscript): HistoryEvent[] {
  if (end - start > RECORD_LIMIT) return [{ id: `${start}:0`, type: 'error', title: 'Oversize transcript record',
    text: 'This record exceeds the 8 MiB decoder bound. Its complete bytes remain available in the paged raw transcript.', legacy: [] }];
  return decoder(bytes(fd, start, end).toString('utf8')).map((e, i) => ({ ...e, id: `${start}:${i}`,
    refs: Object.fromEntries(['text', 'input', 'output', 'title'].filter(f => f in e).map(f => [f, `${start}:${i}`])) }));
}
export class HistoryTail {
  readonly decoder: typeof decodeTranscript;
  constructor(decoder = decodeTranscript) { this.decoder = decoder; }
  #identity = ''; #generation = randomUUID(); #size = 0; #mtime = 0; #prefix = Buffer.alloc(0); #anchor = Buffer.alloc(0);
  #scan = 0; #line = 0; #events: HistoryEvent[] = [];
  #session: {model?:string;tools:string[];notices:string[]} = {tools:[],notices:[]};
  #metadata(events: HistoryEvent[]) { for (const e of events) if(e.session){ if(e.session.model)this.#session.model=e.session.model; if(e.session.tools?.length)this.#session.tools=e.session.tools; if(e.session.notice)this.#session.notices=[...new Set([...this.#session.notices,e.session.notice])].slice(-8); } return events.filter(e=>!e.session); }
  #pendingTools = new Map<string, HistoryEvent>();
  get retained() { return this.#events.length; }
  get identity() { return `${this.#identity}:${this.#generation}`; }
  get cursor() { return this.#line; }
  // The caller may supply an already containment-verified descriptor. The TUI can use a direct local path.
  read(path: string, opened?: number) {
    const fd = opened ?? openSync(path, 'r');
    try {
      const st = fstatSync(fd); const identity = `${st.dev}:${st.ino}`; const prefix = bytes(fd, 0, Math.min(128, st.size));
      const reset = this.#identity !== '' && (this.#identity !== identity || st.size < this.#size
        || !this.#anchor.equals(bytes(fd, Math.max(0, this.#scan - this.#anchor.length), this.#scan))
        || (st.size === this.#size && st.mtimeMs !== this.#mtime) || !this.#prefix.equals(prefix.subarray(0, this.#prefix.length)));
      if (!this.#identity || reset) {
        this.#generation = randomUUID(); this.#events = []; this.#pendingTools.clear(); this.#session={tools:[],notices:[]};
        const header=bytes(fd,0,Math.min(st.size,65536));let begin=0;for(let nl=header.indexOf(10);nl>=0;nl=header.indexOf(10,begin)){this.#metadata(decode(fd,begin,nl,this.decoder));begin=nl+1;}
        this.#scan = Math.max(0, st.size - WINDOW); this.#line = this.#scan;
        if (this.#scan > 0) { const head = bytes(fd, this.#scan, st.size); const nl = head.indexOf(10); this.#scan = nl < 0 || nl === head.length - 1 ? 0 : this.#scan + nl + 1; this.#line = this.#scan; }
      }
      this.#identity = identity; this.#size = st.size; this.#mtime = st.mtimeMs; this.#prefix = prefix;
      const chunk = bytes(fd, this.#scan, Math.min(st.size, this.#scan + WINDOW));
      const fresh: HistoryEvent[] = [];
      for (let offset = chunk.indexOf(10); offset >= 0; offset = chunk.indexOf(10, offset + 1)) {
        const end = this.#scan + offset;
        fresh.push(...decode(fd, this.#line, end, this.decoder)); this.#line = end + 1;
      }
      this.#scan += chunk.length; this.#anchor = bytes(fd, Math.max(0, this.#scan - 128), this.#scan);
      const previous = new Map(this.#events.map(e => [e.id, e]));
      const staged: HistoryEvent[] = [];
      for (const event of this.#metadata(fresh)) {
        if (event.type === 'tool' && event.toolId) {
          const key = `${event.parent ?? ''}:${event.toolId}`;
          if (event.resultFor) {
            const call = this.#pendingTools.get(key);
            if (call && !previous.has(call.id)) staged.push(call);
            this.#pendingTools.delete(key);
          } else if (!event.status) {
            this.#pendingTools.set(key, { ...previewEvent(event), legacy: [] });
            while (this.#pendingTools.size > 256) this.#pendingTools.delete(this.#pendingTools.keys().next().value!);
          }
        }
        staged.push(event);
      }
      this.#events = pairEvents([...this.#events, ...staged]).slice(-200).map(e => previous.get(e.id) === e ? e : { ...previewEvent(e), legacy: [] });
      const events = this.#events.filter(e => previous.get(e.id) !== e).map(previewEvent);
      return { reset, identity: this.identity, cursor: this.cursor, events, pending: this.#scan < st.size };
    } finally { if (opened === undefined) closeSync(fd); }
  }
  page(path: string, before?: string | number, opened?: number) {
    const fd = opened ?? openSync(path, 'r');
    try {
      if (before === undefined) {
        const events = this.#events.slice(-HISTORY_PAGE); const first = events[0]?.id;
        return { session:this.#session, identity: this.identity, cursor: this.cursor, events: events.map(previewEvent), before: first && first !== '0:0' ? first : null };
      }
      if (!/^(0|[1-9][0-9]*)(:(0|[1-9][0-9]*))?$/.test(String(before))) throw new Error('invalid history cursor');
      const [byte = 0, part = 0] = String(before).split(':').map(Number);
      if (!Number.isSafeInteger(byte) || !Number.isSafeInteger(part) || byte > this.#line) throw new Error('invalid history cursor');
      const remainder = part ? bytes(fd, byte, Math.min(this.#line, byte + RECORD_LIMIT)) : Buffer.alloc(0);
      const newline = remainder.indexOf(10);
      const end = part && newline >= 0 ? byte + newline + 1 : byte;
      const start = Math.max(0, byte - WINDOW); const chunk = bytes(fd, start, end);
      const preceding = start ? bytes(fd, start - 1, start)[0] : 10;
      let offset = preceding === 10 ? 0 : chunk.indexOf(10) + 1;
      const decoded: HistoryEvent[] = [];
      for (let nl = chunk.indexOf(10, offset); nl >= 0; nl = chunk.indexOf(10, offset)) {
        decoded.push(...decode(fd, start + offset, start + nl, this.decoder)); offset = nl + 1;
      }
      // A long record can span the whole normal window. Recover its boundary within the decoder
      // bound, or expose an explicit oversize fragment; never silently skip it while paging backwards.
      if (!decoded.length && start > 0 && end > 0) {
        const from = Math.max(0, end - RECORD_LIMIT - 1); const wider = bytes(fd, from, end);
        const terminal = wider[wider.length - 1] === 10 ? wider.length - 1 : wider.length;
        const previous = wider.lastIndexOf(10, terminal - 1);
        const recordStart = previous >= 0 ? from + previous + 1 : from;
        if (previous >= 0 || from === 0) decoded.push(...decode(fd, recordStart, from + terminal, this.decoder));
        else decoded.push({ id: `${start}:0`, type: 'error', title: 'Oversize transcript record',
          text: 'This record crosses the bounded history page. Inspect its full bytes through the paged raw transcript.', legacy: [] });
      }
      const eligible = decoded.filter(e => { const [at = 0, index = 0] = e.id.split(':').map(Number); return at < byte || at === byte && index < part; });
      const events = pairEvents(this.#metadata(eligible)).slice(-HISTORY_PAGE);
      const first = events[0]?.id ?? (start ? `${start}:0` : undefined);
      return { session:this.#session, identity: this.identity, cursor: this.cursor, events: events.map(previewEvent), before: first && first !== '0:0' ? first : null };
    } finally { if (opened === undefined) closeSync(fd); }
  }
  expand(path: string, ref: string, field: string, after: number, opened?: number) {
    if (!/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(ref)) throw new Error('invalid event reference');
    const [offset, index] = ref.split(':').map(Number) as [number, number];
    if (!Number.isSafeInteger(offset) || offset >= this.#line) throw new Error('event reference exceeds complete transcript');
    const fd = opened ?? openSync(path, 'r');
    try {
      if (offset && bytes(fd, offset - 1, offset)[0] !== 10) throw new Error('event reference is not a record boundary');
      const chunk = bytes(fd, offset, Math.min(this.#line, offset + RECORD_LIMIT + 1)); const nl = chunk.indexOf(10);
      if (nl < 0) throw new Error('oversize record: use the bounded raw transcript endpoint');
      const event = decode(fd, offset, offset + nl, this.decoder)[index]; if (!event) throw new Error('event reference is absent');
      return expandEvent(event, field, after);
    } finally { if (opened === undefined) closeSync(fd); }
  }
}
