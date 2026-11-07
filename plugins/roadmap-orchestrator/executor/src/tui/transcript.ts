import { openSync, closeSync, fstatSync, readSync, type Stats } from 'node:fs';
import type { LogPage } from './types.ts';

export { safe } from './text.ts';
import { safe } from './text.ts';
import { decodeReport, label, project, record, summary } from './projection.ts';

/** Structured events and their legacy text projection share one decoder. No backend execution parsing lives here. */
export type TranscriptEvent = {
  type: 'prompt' | 'thinking' | 'tool' | 'message' | 'handoff' | 'result' | 'error';
  at?: string; elapsedMs?: number; tokens?: number; model?: string; tool?: string; toolId?: string; parent?: string;
  title?: string; text?: string; input?: string; output?: string; status?: 'passed' | 'failed';
  resultFor?: string; unknown?: boolean; literalOnly?: boolean;
  /** Internal presentation instructions retain the terminal's exact historical text. Never sent over HTTP. */
  legacy: { heading?: string; body?: unknown; literal?: string[] }[];
};
const readable = (v: unknown): string => typeof v === 'string' ? v : project(decodeReport(v)).map(r => r.text).join('\n');
export function decodeTranscript(line: string): TranscriptEvent[] {
  let value: unknown;
  try { value = JSON.parse(line); } catch {
    return [{ type: 'message', text: line, unknown: true, literalOnly: true, legacy: [{ literal: [/^\s*\{/.test(line) ? `[malformed JSON] ${safe(line)}` : safe(line)] }] }];
  }
  const e = record(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [{ type: 'message', text: line, unknown: true, literalOnly: true, legacy: [{ literal: project(value).map(r => r.text) }] }];
  const type = String(e['type'] ?? 'unknown');
  const message = record(e['message']); const content = message['content'] ?? e['content'];
  const usage = record(e['usage'] ?? message['usage']);
  const input = usage['input_tokens'], output = usage['output_tokens'];
  const tokens = typeof input === 'number' || typeof output === 'number'
    ? (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0)
      + (typeof usage['cache_creation_input_tokens'] === 'number' ? usage['cache_creation_input_tokens'] : 0)
      + (typeof usage['cache_read_input_tokens'] === 'number' ? usage['cache_read_input_tokens'] : 0) : undefined;
  const parent = e['parent_tool_use_id'] ?? e['parent_id'];
  const model = message['model'] ?? e['model'];
  const at = e['timestamp'] ?? e['at'];
  const meta = { ...(parent ? { parent: String(parent) } : {}), ...(typeof model === 'string' ? { model } : {}),
    ...(typeof at === 'string' ? { at } : {}), ...(tokens !== undefined ? { tokens } : {}),
    ...(typeof e['duration_ms'] === 'number' ? { elapsedMs: e['duration_ms'] } : {}) };
  const event = (fields: Omit<TranscriptEvent, 'legacy'>, heading: string, body: unknown): TranscriptEvent => ({ ...meta, ...fields, legacy: [{ heading, body }] });
  const literal = (fields: Omit<TranscriptEvent, 'legacy'>, rows: string[]): TranscriptEvent => ({ ...meta, ...fields, legacy: [{ literal: rows }] });
  if (Array.isArray(content)) return content.map((part: unknown) => {
    const p = record(part);
    switch (p['type']) {
      case 'text': return event({ type: message['role'] === 'user' ? 'prompt' : 'message', text: readable(p['text']) }, `${String(message['role'] ?? type)}:`, p['text']);
      case 'thinking': return event({ type: 'thinking', text: readable(p['thinking']) }, 'Thinking:', p['thinking']);
      case 'tool_use': return event({ type: 'tool', tool: String(p['name']), toolId: String(p['id']), input: readable(p['input']) }, `tool ${String(p['name'])} [${String(p['id'])}]`, p['input']);
      case 'tool_result': return event({ type: 'tool', toolId: String(p['tool_use_id']), resultFor: String(p['tool_use_id']), output: readable(p['content']), status: p['is_error'] ? 'failed' : 'passed' }, `Tool result [${String(p['tool_use_id'])}]${p['is_error'] ? ' · error' : ''}`, p['content']);
      default: return event({ type: 'message', title: `Unknown ${String(p['type'] ?? 'event')}`, text: line, unknown: true }, `Event: ${String(p['type'] ?? 'unknown')}`, p);
    }
  }).map((item, index) => { if (index === 0) return item; const { tokens: _tokens, ...rest } = item; return rest; });
  if ((type === 'user' || type === 'assistant') && typeof content === 'string') return [event({ type: type === 'user' ? 'prompt' : 'message', text: content }, `Event: ${type}`, e)];
  if (type.startsWith('item.')) {
    const item = record(e['item']);
    const stage = type === 'item.completed' ? 'Completed' : type === 'item.started' ? 'Started' : 'Updated';
    if (item['type'] === 'agent_message' || item['type'] === 'reasoning') return [event({ type: item['type'] === 'reasoning' ? 'thinking' : 'message', text: readable(item['text']) }, item['type'] === 'reasoning' ? 'Thinking:' : 'Assistant:', item['text'])];
    if (item['type'] === 'command_execution') {
      const rows = [`${stage} command: ${safe(String(item['command'] ?? 'unavailable'))}`];
      if (item['exit_code'] !== undefined) rows.push(`  Exit code: ${String(item['exit_code'])}`);
      const out = literal({ type: 'tool', tool: 'Command', toolId: String(item['id'] ?? ''), input: String(item['command'] ?? 'unavailable'),
        ...(item['aggregated_output'] !== undefined ? { output: readable(item['aggregated_output']) } : {}),
        ...(type === 'item.completed' ? { resultFor: String(item['id'] ?? ''), status: item['exit_code'] === 0 ? 'passed' as const : 'failed' as const } : {}) }, rows);
      if (item['aggregated_output'] !== undefined) out.legacy.push({ heading: 'Output:', body: item['aggregated_output'] });
      return [out];
    }
    return [event({ type: 'message', title: `${stage} ${label(String(item['type'] ?? 'item'))}`, text: line, unknown: true }, `${stage} ${label(String(item['type'] ?? 'item'))} [${String(item['id'] ?? '')}]`, item)];
  }
  if (type === 'result') {
    const report = decodeReport(e['structured_output'] ?? e['result'] ?? e);
    const out = event({ type: e['is_error'] === true ? 'error' : 'result', title: summary(report), text: readable(report), status: e['is_error'] === true ? 'failed' : 'passed' }, `final report: ${summary(report)}`, report);
    if (e['is_error'] === true) out.legacy.unshift({ literal: ['Agent reported an error'] });
    return [out];
  }
  if (type === 'stream_event') {
    const stream = record(e['event']); const delta = record(stream['delta']);
    if (typeof delta['text'] === 'string') return [event({ type: 'message', text: delta['text'] }, 'Assistant:', delta['text'])];
    if (typeof delta['thinking'] === 'string') return [event({ type: 'thinking', text: delta['thinking'] }, 'Thinking:', delta['thinking'])];
    return [event({ type: 'message', title: `Stream: ${label(String(stream['type'] ?? 'event'))}`, text: line, unknown: true }, `Stream: ${label(String(stream['type'] ?? 'event'))}`, stream)];
  }
  if (type === 'thread.started') return [literal({ type: 'handoff', title: 'Session started', text: String(e['thread_id'] ?? 'unavailable') }, [`Session started: ${String(e['thread_id'] ?? 'unavailable')}`])];
  if (type === 'turn.started') return [literal({ type: 'handoff', text: 'Turn started' }, ['Turn started'])];
  if (type === 'turn.completed') return [event({ type: 'result', title: 'Turn completed', text: readable(e['usage'] ?? e), status: 'passed' }, 'Turn completed', e['usage'] ?? e)];
  if (type === 'turn.failed' || type === 'error') return [event({ type: 'error', text: readable(e['error'] ?? e['message'] ?? e), status: 'failed' }, 'Agent error', e['error'] ?? e['message'] ?? e)];
  // Init is known metadata for the console, with the same historical terminal projection.
  if (type === 'system' && e['subtype'] === 'init') return [event({ type: 'handoff', title: 'Session started', text: typeof model === 'string' ? `Model: ${model}` : 'Model unrecorded' }, `Event: ${type}`, e)];
  return [event({ type: 'message', title: `Unknown ${type}`, text: line, unknown: true }, `Event: ${type}`, e)];
}

export function renderTranscript(events: readonly TranscriptEvent[], expanded: boolean): string[] {
  const preview = (v: unknown): string[] => {
    const rows = project(decodeReport(v)).map(row => row.text);
    if (expanded) return rows;
    let used = 0; const out: string[] = [];
    for (const row of rows) {
      if (out.length >= 8 || used + row.length > 480) {
        if (!out.length) out.push(row.slice(0, 240));
        out.push('… [e: expand]'); break;
      }
      out.push(row); used += row.length;
    }
    return out;
  };
  return events.flatMap(e => e.literalOnly ? e.legacy.flatMap(part => part.literal ?? []) : e.legacy.flatMap(part => part.literal ?? [part.heading!, ...preview(part.body).map(text => '  ' + text)])
    .flatMap(text => safe((e.parent ? `[parent ${e.parent}] ` : '') + text).split('\n')));
}
export function normalize(line: string, expanded: boolean): string[] { return renderTranscript(decodeTranscript(line), expanded); }

export const PAGE_BYTES = 64 * 1024;
// A tiny prefix check distinguishes append growth from a file rewritten in place between polls.
function prefixOf(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(Math.min(128, size));
  const length = readSync(fd, bytes, 0, bytes.length, 0);
  return bytes.subarray(0, length);
}
const samePrefix = (before: Buffer, after: Buffer): boolean => before.equals(after.subarray(0, before.length));
/** Bounded decoded LRU; arbitrary offsets allow backwards paging without indexing or rereading whole logs. */
export class TranscriptReader {
  readonly cache = new Map<string, LogPage>();
  #tails = new Map<string, { identity: string; size: number; mtime: number; carry: Buffer; latest: string; prefix: Buffer }>();
  /** Activity snippets have a cursor per open invocation; they must not evict the selected transcript's pages. */
  latest(path: string): string {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return 'Log unavailable';
    }
    try {
      const st = fstatSync(fd); const identity = `${st.dev}:${st.ino}`;
      const previous = this.#tails.get(path);
      const prefix = previous?.size === st.size && previous.mtime === st.mtimeMs && previous.identity === identity ? previous.prefix : prefixOf(fd, st.size);
      const valid = previous?.identity === identity && previous.size <= st.size
        && (previous.size !== st.size || previous.mtime === st.mtimeMs) && samePrefix(previous.prefix, prefix);
      if (valid && previous.size === st.size) return previous.latest;
      const start = Math.max(valid ? previous.size : 0, st.size - PAGE_BYTES);
      const bytes = Buffer.alloc(st.size - start);
      let n = 0;
      while (n < bytes.length) { const got = readSync(fd, bytes, n, bytes.length - n, start + n); if (!got) break; n += got; }
      const combined = Buffer.concat([valid && start === previous.size ? previous.carry : Buffer.alloc(0), bytes.subarray(0, n)]).subarray(-PAGE_BYTES);
      const text = combined.toString('utf8').replace(/\n$/, '');
      const last = text.slice(text.lastIndexOf('\n') + 1);
      const normalized = last ? normalize(last, false) : [];
      const latest = last ? normalized.slice(0, normalized[0]?.startsWith('final report:') ? 1 : 2).map((row) => row.trim()).join(' ').slice(0, 240) : valid ? previous.latest : '';
      this.#tails.set(path, { identity, size: start + n, mtime: st.mtimeMs, carry: Buffer.from(combined.subarray(combined.lastIndexOf(10) + 1)), latest, prefix });
      return latest;
    } finally { closeSync(fd); }
  }
  forgetLatest(path: string): void { this.#tails.delete(path); }
  #blocks = new Map<string, Buffer>();
  #files = new Map<string, { size: number; mtime: number; identity: string; prefix: Buffer }>();
  /** Cache aligned raw blocks; append refreshes read new bytes plus a small rewrite-detection prefix. */
  private bytes(fd: number, path: string, start: number, end: number, st: Stats): Buffer {
    const identity = `${st.dev}:${st.ino}`;
    const previous = this.#files.get(path);
    const prefix = prefixOf(fd, st.size);
    if (previous && (!samePrefix(previous.prefix, prefix) || previous.identity !== identity || st.size < previous.size || (st.size === previous.size && st.mtimeMs !== previous.mtime))) {
      for (const key of this.#blocks.keys()) if (key.startsWith(`${path}:`)) this.#blocks.delete(key);
    }
    this.#files.delete(path);
    this.#files.set(path, { size: st.size, mtime: st.mtimeMs, identity, prefix });
    while (this.#files.size > 8) this.#files.delete(this.#files.keys().next().value!);
    const chunks: Buffer[] = [];
    for (let base = Math.floor(start / PAGE_BYTES) * PAGE_BYTES; base < end; base += PAGE_BYTES) {
      const key = `${path}:${identity}:${base}`;
      const length = Math.min(PAGE_BYTES, end - base);
      const cached = this.#blocks.get(key) ?? Buffer.alloc(0);
      let block = cached;
      if (cached.length < length) {
        block = Buffer.alloc(length); cached.copy(block);
        let n = cached.length;
        while (n < length) { const got = readSync(fd, block, n, length - n, base + n); if (!got) break; n += got; }
        block = block.subarray(0, n);
      }
      this.#blocks.delete(key); this.#blocks.set(key, block);
      while (this.#blocks.size > 8) this.#blocks.delete(this.#blocks.keys().next().value!);
      chunks.push(block.subarray(Math.max(0, start - base), Math.min(block.length, end - base)));
    }
    return Buffer.concat(chunks);
  }
  read(path: string, before: number | null, normalized: boolean, expanded: boolean, after?: number): LogPage {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { key: path, start: 0, end: 0, size: 0, lines: ['Unavailable or pruned log'], error: 'Unavailable or pruned log' };
    }
    try {
      const st = fstatSync(fd);
      const end = Math.min(before ?? st.size, st.size);
      const start = Math.min(end, Math.max(0, after ?? end - PAGE_BYTES));
      const key = `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${start}:${end}:${normalized}:${expanded}`;
      const cached = this.cache.get(key);
      if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
      const bytes = this.bytes(fd, path, start, end, st);
      const n = bytes.length;
      // Pages partition bytes at record boundaries. Oversize records remain inspectable in bounded fragments.
      // A page read forward (`after`) starts where the previous page ended, possibly inside a record: keep it.
      const preceding = Buffer.alloc(1);
      const boundary = start === 0 || (readSync(fd, preceding, 0, 1, start - 1) === 1 && preceding[0] === 10);
      const first = !boundary && after === undefined ? bytes.indexOf(10) : -1;
      const offset = first >= 0 && first < n - 1 ? first + 1 : 0;
      const last = bytes.lastIndexOf(10);
      const limit = before !== null && end < st.size && last >= offset ? last + 1 : n;
      const text = bytes.subarray(offset, limit).toString('utf8');
      const lines = text.replace(/\n$/, '').split('\n').flatMap((line) => normalized ? normalize(line, expanded) : [safe(line)]);
      if (!boundary && (after !== undefined || first < 0)) lines.unshift('[record exceeds page: fragment; raw view available]');
      const page = { key: path, start: start + offset, end: start + limit, size: st.size, lines, error: null };
      this.cache.set(key, page);
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
      return page;
    } finally { closeSync(fd); }
  }
}
