import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { invocationDirName, invocationIdOf } from '../core/ids.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { ConsoleError, type Envelope } from '../observation/protocol.ts';
import { HISTORY_PAGE, HistoryTail } from '../tui/history.ts';
import { LogReader } from '../tui/log-reader.ts';
import { consoleTranscript, parseSeatBrief } from './agent-history.ts';
import { openEvidence } from './evidence.ts';

/** Open histories alone are tailed; cache and per-read work have fixed bounds. */
export class ConsoleHistories {
  #tails = new Map<string, HistoryTail>();
  #logs = new LogReader();
  #pending = new Map<string, ReturnType<HistoryTail['read']>>();
  #capture(key: string, tail: HistoryTail, path: string, fd: number) {
    const delta = tail.read(path, fd); const old = this.#pending.get(key);
    const events = new Map((delta.reset ? [] : old?.events ?? []).map(e => [e.id, e]));
    for (const event of delta.events) events.set(event.id, event);
    const combined = { ...delta, reset: delta.reset || Boolean(old?.reset), events: [...events.values()].slice(-200) };
    this.#pending.set(key, combined);
    while (this.#pending.size > 16) this.#pending.delete(this.#pending.keys().next().value!);
    return combined;
  }
  selected(e: Envelope, id: string) {
    const i = e.data.display.invocations.find(i => invocationDirName(invocationIdOf(i.id)) === id);
    if (!i || i.execution !== 'agent') throw new ConsoleError('not-found', 'recorded agentic invocation required');
    return i;
  }
  #open(e: Envelope, id: string) {
    const i = this.selected(e, id); const root = e.data.display.run.runDir;
    const path = join(invocationDir(root, invocationIdOf(i.id)), 'stdout');
    const fd = openEvidence(root, path);
    const key = `${e.arc}:${id}`;
    let tail = this.#tails.get(key); if (!tail) tail = new HistoryTail(consoleTranscript);
    this.#tails.delete(key); this.#tails.set(key, tail);
    while (this.#tails.size > 16) this.#tails.delete(this.#tails.keys().next().value!);
    return { i, path, fd, tail, key };
  }
  poll(e: Envelope, id: string) {
    const { i, path, fd, tail, key } = this.#open(e, id);
    try { const delta = this.#capture(key, tail, path, fd); this.#pending.delete(key); return { invocation: id, ...delta, state: i.state, endedAt: i.endedAt }; }
    finally { closeSync(fd); }
  }
  page(e: Envelope, id: string, before?: string, identity?: string) {
    const { i, path, fd, tail, key } = this.#open(e, id);
    try {
      this.#capture(key, tail, path, fd);
      if (identity && identity !== tail.identity) throw new ConsoleError('reset', 'transcript replaced or truncated; reload history');
      try { return { invocation: id, pageSize:HISTORY_PAGE, ...tail.page(path, before, fd), state: i.state, endedAt: i.endedAt }; }
      catch (error) { throw new ConsoleError('invalid', (error as Error).message); }
    } finally { closeSync(fd); }
  }
  field(e: Envelope, id: string, ref: string, field: string, after: number, identity?: string) {
    const { path, fd, tail, key } = this.#open(e, id);
    try {
      this.#capture(key, tail, path, fd);
      if (!identity || identity !== tail.identity) throw new ConsoleError('reset', 'transcript identity is required and must match');
      try { return tail.expand(path, ref, field, after, fd); }
      catch (error) { throw new ConsoleError('invalid', (error as Error).message); }
    } finally { closeSync(fd); }
  }
  prompt(e: Envelope, id: string, after: number) {
    const selected = this.selected(e, id);
    const reply = this.#logs.read({ run: e.data.display.run, selected, token: 0, log: { inv: selected.id, source: 'prompt', after, before: after + 4096, expanded: false } });
    if (reply.error) throw new ConsoleError('corruption', reply.error);
    const log = reply.log!;
    if (after !== 0 || log.size > 8 * 1024 * 1024) return log;
    const full = this.#logs.read({ run: e.data.display.run, selected, token: 0, log: { inv: selected.id, source: 'prompt', after: 0, before: null, expanded: false } });
    if (full.error) throw new ConsoleError('corruption', full.error);
    return { ...log, brief: parseSeatBrief(full.log!.lines.join('\n')) };
  }
}
