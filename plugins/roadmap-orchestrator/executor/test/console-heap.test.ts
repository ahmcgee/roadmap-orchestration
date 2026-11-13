// The console's heap policy as main runs it (src/console/http.ts): each worker reports its heap from its first observation,
// and a worker out of memory HEAP.stopAfter times in a row is not restarted, every read then answering why. Out of memory is
// what the runtime says on the worker's `error` event (`ERR_WORKER_OUT_OF_MEMORY`); these tests emit that event on the real
// worker and terminate it, so main's own handlers run. A real collector exhausting a real heap is
// test/serial/console-collector-memory.test.ts's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { HEAP, RESTART_MS, serveConsole } from '../src/console/http.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';

const T = { timeout: 120_000 };
const outOfMemory = () => Object.assign(new Error('Worker terminated due to reaching memory limit: JS heap out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' });
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
/** Every worker main starts, in order, by the `exit` listener main gives each; and the console's log lines. */
function watchWorkers(t: { mock: { method: typeof test.mock.method } }, onStart: (w: Worker) => void = () => {}, onLine: (line: string) => void = () => {}) {
  const started: Worker[] = [], lines: string[] = [];
  const on = Worker.prototype.on;
  t.mock.method(Worker.prototype, 'on', function (this: Worker, event: string, listener: (...a: unknown[]) => void) {
    const out = on.call(this, event, listener);
    if (event === 'exit' && !started.includes(this)) { started.push(this); onStart(this); }
    return out;
  });
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const line = String(chunk); lines.push(line); onLine(line);
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  });
  return { started, lines };
}
const kill = (w: Worker) => setImmediate(() => { w.emit('error', outOfMemory()); void w.terminate(); });

test('a collector reports its heap from its first observation', T, async (t) => {
  const f = consoleFixture();
  const { lines } = watchWorkers(t);
  const s = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  assert.equal((await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/status`)).status, 200);
  await until('a collector heap report', () => s.stats(f.arc)?.heap != null, 20_000);
  const heap = s.stats(f.arc)!.heap!;
  assert.equal(heap.near, false);
  assert.ok(heap.usedMb > 0 && heap.limitMb > heap.usedMb, JSON.stringify(heap));
  assert.ok(heap.sizes.events > 0 && heap.sizes.memo.stamps > 0, JSON.stringify(heap.sizes));
  assert.ok(lines.some((l) => l.includes(`console collector for arc ${f.arc}: heap ${heap.usedMb} of ${heap.limitMb} MB`) && /process RSS \d+ MB/.test(l)), lines.join(''));
  await until('a serve worker heap report', () => lines.some((l) => /console serve worker: heap \d+ of \d+ MB .*; tab views \d+; process RSS/.test(l)), 20_000);
});

test(`a collector out of memory ${HEAP.stopAfter} times in a row before it observes is not restarted; its arc's reads say why`, T, async (t) => {
  const f = consoleFixture();
  // The first worker is the serve worker; every collector runs out of memory before its first capture.
  const { started, lines } = watchWorkers(t, (w) => { if (started.length > 1) kill(w); });
  const s = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  await until('the first out-of-memory exit', () => lines.some((l) => l.includes(`console collector for arc ${f.arc} exited (out of memory at its`)), 20_000);
  assert.ok(lines.some((l) => l.includes('no report yet') && l.includes(`restarting it in ${RESTART_MS[0] / 1000}s`)), lines.join(''));
  await until(`the collector stopped after ${HEAP.stopAfter} exits`, () => lines.some((l) => l.includes(`console collector for arc ${f.arc} stopped: out of memory ${HEAP.stopAfter} times in a row`)), RESTART_MS[0] + RESTART_MS[1] + 20_000);
  assert.equal(started.length, 1 + HEAP.stopAfter, 'one serve worker and three collectors');
  assert.ok(lines.some((l) => /It will not be restarted; restart the console to try again, and report these lines\./.test(l)));
  for (const path of ['status', 'graph']) {
    const answer = await fetch(`${base}/${path}`);
    assert.equal(answer.status, 503, path);
    assert.match(await answer.text(), new RegExp(`stopped collecting this arc after running out of memory ${HEAP.stopAfter} times in a row at its \\d+ MB heap limit; see the console log`), path);
  }
  assert.equal(s.stats(f.arc), null, 'no collector runs for it');
  assert.equal((await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs`)).status, 200, 'the console stays up');
});

test(`the serve worker out of memory ${HEAP.stopAfter} times in a row is not restarted; every read says why`, T, async (t) => {
  const f = consoleFixture();
  // A serve worker restart starts the serve worker first, then the collectors: the first worker after the restart is armed.
  let armed = false;
  const { started, lines } = watchWorkers(t, (w) => { if (armed) { armed = false; kill(w); } }, (line) => { if (line.includes('console serve worker ran out of memory')) armed = true; });
  const s = await serveConsole({ ...f, host: '127.0.0.1', port: 0 }); t.after(() => s.close());
  assert.equal((await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/status`)).status, 200);
  kill(started[0]!);
  await until(`the serve worker stopped after ${HEAP.stopAfter} exits`, () => lines.some((l) => l.includes(`console serve worker stopped: out of memory ${HEAP.stopAfter} times in a row`)), RESTART_MS[0] + RESTART_MS[1] + 20_000);
  assert.ok(lines.some((l) => l.includes(`console serve worker ran out of memory at its`) && l.includes(`restarting it in ${RESTART_MS[0] / 1000}s`)), lines.join(''));
  for (const path of [`arcs/${f.arc}/status`, 'arcs']) {
    const answer = await fetch(`${s.url}/api/${CONSOLE_PROTOCOL}/${path}`);
    assert.equal(answer.status, 503, path);
    assert.match(await answer.text(), new RegExp(`stopped serving after its serve worker ran out of memory ${HEAP.stopAfter} times in a row at its \\d+ MB heap limit; see the console log`), path);
  }
});

// dev.75 (S-f): the serve worker collects its own garbage as a collector does: one policy (`heapTidy`), 128 MB over what its
// last collection left for the serve worker (192 MB for a collector), and only when `gc` is exposed (--expose-gc).
test('a worker\'s tidy collects once its used heap is its margin over what the last collection left', async () => {
  const { heapTidy } = await import('../src/console/messages.ts');
  let used = 300, collections = 0;
  const tidy = heapTidy(128, () => { collections++; used = 200; }, () => used);
  assert.equal(tidy(), true, 'the first call collects: nothing is settled yet');
  assert.equal(collections, 1);
  used = 327; assert.equal(tidy(), false, 'under the margin');
  used = 328; assert.equal(tidy(), true, 'at the margin over the 200 MB left');
  assert.equal(collections, 2);
  const unexposed = heapTidy(128, undefined, () => 10_000);
  assert.equal(unexposed(), false, 'without --expose-gc nothing is collected');
});
