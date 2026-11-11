// A console on an arc of a real long arc's shape, under the load a real browser puts on it. dev.60 and dev.61 passed their
// tests with one polite reader on an arc whose cost drivers were small; this one scales the drivers (invocation records, an
// evidence tree, git spawn cost), runs several concurrent readers, and asserts the work each capture does, not only outcomes.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitCommonDir } from '../../src/git/git.ts';
import { absPath } from '../../src/core/values.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import type { ArcStats } from '../../src/console/http.ts';
import { ArcWriter, padEvidence } from '../helpers/arc-writer.ts';
import { generateScaleArc, ownScaleArc } from '../helpers/scale-arc.ts';
import { tmpDir } from '../helpers/repo.ts';

const COLD_MS = 20_000, SWEEP_BOUND_MS = 120_000, RSS_BUDGET_MB = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Read = { name: string; status: number; ms: number; highWater?: number | undefined; ageMs?: number; epoch?: string | undefined; error?: string | undefined };

test('a busy arc of real shape: cold start once, every read answered from memory under concurrent readers, work per capture bounded', { timeout: 20 * 60_000 }, async (t) => {
  const m = await generateScaleArc(tmpDir('console-real-shape'), { units: 40, invocations: 9_000 });
  assert.ok(m.invocations >= 9_000, `${m.invocations} invocations`);
  padEvidence(m.runDir, 2_000, 9);
  const release = await ownScaleArc(m); t.after(release);
  const running = m.live.length + 2; // the generator leaves its live agents, a lane and a publication slot open

  // A git that costs 5 ms a spawn, and more on demand.
  const shims = mkdtempSync(join(tmpdir(), 'roadmap-real-shape-git-')); t.after(() => rmSync(shims, { recursive: true, force: true }));
  const delay = join(shims, 'delay'); writeFileSync(delay, '0.005');
  const real = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  writeFileSync(join(shims, 'git'), `#!/bin/sh\nsleep "$(cat '${delay}')"\nexec '${real}' "$@"\n`); chmodSync(join(shims, 'git'), 0o755);

  // The arc is already busy when the console starts.
  const writer = new ArcWriter(m); t.after(() => writer.close());
  writer.start();
  await sleep(3_000);
  const common = gitCommonDir(absPath(m.repo));
  const child = fork(new URL('../fixtures/console-serve.ts', import.meta.url), [JSON.stringify({ repo: m.repo, common, hostDir: m.hostDir, host: '127.0.0.1', port: 0 })],
    { env: { ...process.env, PATH: `${shims}:${process.env['PATH']}` }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.connected) child.disconnect(); setTimeout(() => child.kill('SIGKILL'), 5_000).unref(); });
  let log = ''; child.stderr!.on('data', (d) => { log += d; });
  const started = performance.now();
  const url = await new Promise<string>((resolve, reject) => { child.on('message', (msg: { kind: string; url?: string }) => { if (msg.kind === 'ready') resolve(msg.url!); }); child.once('exit', (code) => reject(new Error(`console exited ${code}: ${log}`))); });
  let asked = 0; const answers = new Map<number, (v: ArcStats | null) => void>();
  child.on('message', (msg: { kind: string; id?: number; value?: ArcStats | null }) => { if (msg.kind === 'stats') { answers.get(msg.id!)?.(msg.value ?? null); answers.delete(msg.id!); } });
  const stats = () => new Promise<ArcStats>((resolve, reject) => { const id = ++asked; answers.set(id, (v) => v ? resolve(v) : reject(new Error('no collector for the arc'))); child.send({ kind: 'stats', id, arc: m.arc }); });
  const rss = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${child.pid}/status`, 'utf8'))![1]) / 1024;
  const api = `${url}/api/${CONSOLE_PROTOCOL}`, base = `${api}/arcs/${m.arc}`;

  // A browser read: respond-async with the pending token polled, as web-src/app/prepared-read.ts does, bounded at 30 s.
  const prepared = async (name: string, path: string): Promise<Read> => {
    const began = performance.now(), u = new URL(`${base}${path}`);
    for (;;) {
      let r: Response;
      try { r = await fetch(u, { headers: { prefer: 'respond-async' }, signal: AbortSignal.timeout(35_000) }); }
      catch (error) { return { name, status: 0, ms: performance.now() - began, error: String(error) }; }
      const body = await r.json() as { pending?: string; highWater?: number; checkedAt?: string; epoch?: string; error?: { message: string } };
      if (r.status === 202 && body.pending) { u.searchParams.set('pending', body.pending); continue; }
      return { name, status: r.status, ms: performance.now() - began, highWater: body.highWater, ...(body.checkedAt ? { ageMs: Date.now() - Date.parse(body.checkedAt) } : {}), epoch: body.epoch, error: body.error?.message };
    }
  };
  const strict = async (name: string, path: string): Promise<Read> => {
    const began = performance.now();
    try { const r = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(2_100) }); await r.arrayBuffer(); return { name, status: r.status, ms: performance.now() - began }; }
    catch { return { name, status: 0, ms: performance.now() - began }; }
  };

  // 1. Cold: the first shell within the bound.
  let cold: Read;
  do cold = await prepared('shell', '/shell'); while (cold.status !== 200 && performance.now() - started < COLD_MS);
  const coldMs = performance.now() - started;
  assert.equal(cold.status, 200); assert.ok(coldMs <= COLD_MS, `first shell after ${Math.round(coldMs)} ms`);
  const epoch = cold.epoch!;

  // Readers: three tabs (an event stream each, reloading shell, graph and activity on every revision notice, one in flight
  // per view) and a strict status probe and a discovery read every second, all at once.
  const reads: Read[] = [], streams: string[] = [];
  let latest = cold.highWater!, loading = true;
  t.after(() => { loading = false; });
  const tab = async () => {
    const inflight = new Set<string>();
    const reload = (name: string, q: string) => { if (inflight.has(name)) return; inflight.add(name); void prepared(name, `/${name}${q}`).then((r) => { reads.push(r); inflight.delete(name); }); };
    const c = new AbortController(); t.after(() => c.abort());
    try {
      const r = await fetch(`${base}/events`, { signal: c.signal }); assert.equal(r.status, 200);
      const reader = r.body!.getReader(); let buf = '';
      while (loading) {
        const { value, done } = await reader.read(); if (done) break;
        buf += new TextDecoder().decode(value);
        for (let i = buf.indexOf('\n\n'); i !== -1; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === 'error') streams.push(data ?? 'error');
          if ((event === 'revision' || event === 'reset') && data) {
            const n = JSON.parse(data) as { epoch: string; highWater: number }; latest = Math.max(latest, n.highWater);
            const q = `?epoch=${encodeURIComponent(n.epoch)}&minHighWater=${n.highWater}`;
            reload('shell', q); reload('graph', q); reload('activity', q);
          }
        }
      }
    } catch (error) { if (loading) streams.push(String(error)); } finally { c.abort(); }
  };
  const tabs = [tab(), tab(), tab()];
  const probe = (async () => { while (loading) { const [s, a] = await Promise.all([strict('status', `/arcs/${m.arc}/status?summary=1`), strict('arcs', '/arcs')]); reads.push(s, a); await sleep(1_000); } })();
  const lags: number[] = [];
  const sampler = (async () => { while (loading) { lags.push(writer.lagMs(latest)); await sleep(500); } })();

  // 2, 3. Twenty seconds of that.
  const warm = (await stats()).captures.length;
  const touched = readdirSync(join(m.runDir, 'inv')).map((d) => join(m.runDir, 'inv', d, 'launch.json')).find((p) => { try { readFileSync(p); return !m.live.some((l) => p.includes(`/${l.routeId}/`)); } catch { return false; } })!;
  const at = new Date(); utimesSync(touched, at, at); // touched, unchanged: the sweep re-reads it and finds nothing wrong
  await sleep(20_000);
  const browser = reads.filter((r) => ['shell', 'graph', 'activity'].includes(r.name)), arcs = reads.filter((r) => r.name === 'arcs');
  assert.ok(browser.length >= 30, `${browser.length} browser reads`);
  assert.deepEqual(browser.filter((r) => r.status !== 200).map((r) => `${r.name}:${r.status} ${r.error}`), [], "every browser read is answered");
  const p99 = browser.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(browser.length * 0.99)]!;
  assert.ok(p99 < 1_000, `browser read p99 ${Math.round(p99)} ms`);
  assert.ok(arcs.every((r) => r.status === 200 && r.ms < 100), `/arcs: ${JSON.stringify(arcs.map((r) => [r.status, Math.round(r.ms)]))}`);
  assert.ok(lags.every((l) => l <= 5_000), `lag behind the writer at every sample: max ${Math.max(...lags)} ms`);
  assert.deepEqual(streams, [], 'no stream errors');

  // 4. Work per capture after the cold start: in proportion to the open invocations, never to the arc's records.
  const work = (await stats()).captures.slice(warm);
  assert.ok(work.length >= 5, `${work.length} captures`);
  for (const w of work) {
    assert.ok(w.statCalls <= 1_500 + 8 * running, `statCalls ${w.statCalls}`);
    assert.ok(w.recordReads <= 20 + 8 * running, `recordReads ${w.recordReads}`);
    assert.ok(w.gitSpawns <= 20, `gitSpawns ${w.gitSpawns}`);
    assert.ok(w.rowsRead <= running + 2, `rowsRead ${w.rowsRead}`);
  }

  // 5. A storm of sixty concurrent reads for five seconds does not stop publication.
  const before = (await stats()).captures.length, stormEnd = Date.now() + 5_000, storm: Read[] = [];
  const routes = ['/shell', '/graph', '/activity', '/metadata', '/timeline', '/effort'];
  await Promise.all(Array.from({ length: 60 }, async (_, n) => { while (Date.now() < stormEnd) storm.push(await prepared(routes[n % routes.length]!, routes[n % routes.length]!)); }));
  const during = (await stats()).captures.length - before;
  assert.ok(during >= 3, `${during} captures published during the storm`);
  // Every storm read is answered at once: served, or refused by browser preparation's reader bound (beyond it: unavailable).
  assert.deepEqual(storm.filter((r) => r.status !== 200 && !(r.status === 503 && /too many browser read/.test(r.error ?? ''))).map((r) => `${r.name}:${r.status} ${r.error}`), [], 'the storm is answered');
  assert.ok(storm.filter((r) => r.status === 200).length >= 60, `${storm.filter((r) => r.status === 200).length} storm reads served`);
  assert.ok(storm.every((r) => r.ms < 5_000), 'no storm read waits on another');

  // 6. Memory.
  const rssMb = rss();
  assert.ok(rssMb < RSS_BUDGET_MB, `RSS ${Math.round(rssMb)} MB`);

  // 7. Git at 400 ms a spawn for fifteen seconds: the log says once that the console is behind, then once that it caught up;
  // reads stay answered, and what they are as of ages.
  const slowFrom = reads.length;
  // What a read is as of, sampled every quarter second: fresh while captures are fast, older while git is slow.
  const sampleAges = async (ms: number) => { const ages: number[] = [], end = Date.now() + ms; while (Date.now() < end) { const r = await prepared('metadata', '/metadata'); if (r.ageMs !== undefined) ages.push(r.ageMs); await sleep(250); } return ages; };
  const normalAges = await sampleAges(3_000);
  writeFileSync(delay, '0.4'); const slowAges = await sampleAges(15_000); writeFileSync(delay, '0.005');
  for (let n = 0; n < 60 && !/caught up with arc/.test(log); n++) await sleep(1_000);
  const slow = reads.slice(slowFrom).filter((r) => ['shell', 'graph', 'activity'].includes(r.name));
  assert.deepEqual(slow.filter((r) => r.status !== 200).map((r) => `${r.name}:${r.status} ${r.error}`), []);
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1] ?? 0;
  assert.ok(slow.length > 0 && Math.max(...slowAges) >= 1_500 && Math.max(...slowAges) > 2 * median(normalAges), `what the reads are as of ages while captures are slow: up to ${Math.round(Math.max(...slowAges))} ms, against a median of ${Math.round(median(normalAges))} ms`);
  assert.equal((log.match(new RegExp(`console is behind arc ${m.arc}`, 'g')) ?? []).length, 1, log);
  assert.equal((log.match(new RegExp(`console caught up with arc ${m.arc}`, 'g')) ?? []).length, 1, log);

  // 1 (end). One fold, never restarted, one epoch.
  const end = await stats();
  assert.equal(end.folded, end.seq, 'the events folded over the run are the journal, once');
  assert.ok(reads.every((r) => r.epoch === undefined || r.epoch === epoch), 'one epoch');
  assert.ok(storm.every((r) => r.epoch === undefined || r.epoch === epoch));
  assert.doesNotMatch(log, /launch\.json/, 'the touched record is not corruption');

  // 8. A settled invocation's launch.json rewritten with other content: reads answer the corruption within the sweep's bound.
  const rewritten = readdirSync(join(m.runDir, 'inv')).map((d) => join(m.runDir, 'inv', d, 'launch.json')).find((p) => p !== touched && !m.live.some((l) => p.includes(`/${l.routeId}/`)) && (() => { try { readFileSync(p); return true; } catch { return false; } })())!;
  const record = JSON.parse(readFileSync(rewritten, 'utf8')); writeFileSync(rewritten, JSON.stringify({ ...record, argv: [...record.argv, '--rewritten'] }));
  const sweepFrom = Date.now(); let refused: Read;
  for (;;) { refused = await prepared('shell', '/shell'); if (refused.status !== 200 || Date.now() - sweepFrom > SWEEP_BOUND_MS) break; await sleep(1_000); }
  loading = false; writer.stop();
  await Promise.all([...tabs, probe, sampler]);
  assert.equal(refused.status, 500, `within ${Math.round((Date.now() - sweepFrom) / 1000)} s`);
  t.diagnostic(JSON.stringify({ coldMs: Math.round(coldMs), invocations: m.invocations, events: end.seq, p99: Math.round(p99), rssMb: Math.round(rssMb), captures: work.length, stormCaptures: during,
    sweepMs: Date.now() - sweepFrom, maxLagMs: Math.max(...lags), work: work.at(-1) }));
});
