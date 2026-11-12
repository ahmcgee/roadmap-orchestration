// dev.71 stage 1: an Activity read is answered from the newest capture whose index is built while the current capture's index
// is built; only a read that no built index can answer waits for the build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveConsole } from '../src/console/http.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { absPath } from '../src/core/values.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import type { Metadata } from '../src/console/view-protocol.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { until } from './fixtures/exec-common.ts';
import { frames, type Frame } from './helpers/console-lag.ts';
import { consoleGet } from './helpers/console-http.ts';

test('T4: with capture 1 indexed and capture 2 published, a read with no watermark is answered from capture 1 and one that needs capture 2 waits for its build', { timeout: 60_000 }, async (t) => {
  const f = await investigationFixture(); t.after(() => f.close());
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  t.after(() => s.close());
  const base = `${s.url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}`;
  const stream = new AbortController(); t.after(() => stream.abort());
  const seen: Frame[] = []; frames((await fetch(`${base}/events`, { signal: stream.signal })).body!, seen);
  await until(() => seen.some((x) => x.event === 'revision'), 30_000, 'first notice');
  const read = async (query = '') => { const began = performance.now(), r = await consoleGet(`${base}/activity${query}`); assert.equal(r.status, 200, await r.clone().text()); return { ...(await r.json() as { highWater: number; epoch: string }), ms: performance.now() - began }; };
  const first = await read();
  const notices = () => seen.filter((x) => x.event === 'revision' || x.event === 'heartbeat').map((x) => x.data as Metadata);
  const indexed = notices().at(-1)!;
  assert.equal(first.highWater, indexed.highWater, 'capture 1 is indexed');
  // A stage starts: Activity has a new row, so capture 2 needs an index of its own.
  f.begin('u9', 'build');
  await until(() => notices().some((n) => n.highWater > indexed.highWater && n.viewVersions.activity !== indexed.viewVersions.activity), 10_000, 'capture 2 published');
  const published = notices().at(-1)!;
  const [now, waits] = await Promise.all([read(), read(`?epoch=${published.epoch}&minHighWater=${published.highWater}`)]);
  assert.equal(now.highWater, indexed.highWater, 'answered from capture 1, whose index is built');
  assert.ok(now.ms < 250, `answered at once (${Math.round(now.ms)} ms)`);
  assert.ok(waits.highWater >= published.highWater, 'the read that needs capture 2 waited for its index');
  assert.ok((await read()).highWater >= published.highWater, 'the build for capture 2 was started by the first read');
});
