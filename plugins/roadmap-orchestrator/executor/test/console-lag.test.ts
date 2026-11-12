// dev.71 stage 1: a console whose captures are slower than five seconds still answers every browser read at once from the last
// published observation, says how old it is through a once-a-second pulse, and keeps the strict CLI read's contract.
// The capture is made slow by a git on PATH that waits while a flag file exists (the collector spawns git on every capture).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveConsole } from '../src/console/http.ts';
import { gitCommonDir } from '../src/git/git.ts';
import { unitId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { CONSOLE_PROTOCOL } from '../src/observation/protocol.ts';
import { pulseShape } from '../src/console/view-shapes.ts';
import type { Pulse } from '../src/console/view-protocol.ts';
import { investigationFixture } from './fixtures/console-investigations.ts';
import { until } from './fixtures/exec-common.ts';
import { frames, slowGit, type Frame } from './helpers/console-lag.ts';

test('T3: with captures over five seconds every browser read answers at once with its real age, pulses say how far behind, and strict /status keeps its contract', { timeout: 120_000 }, async (t) => {
  const f = await investigationFixture(), git = slowGit(), path = process.env['PATH'];
  t.after(() => { process.env['PATH'] = path; git.close(); f.close(); });
  // The collector worker takes its environment when it starts, inside serveConsole.
  process.env['PATH'] = `${git.dir}:${path}`;
  const s = await serveConsole({ repo: absPath(f.d.repo), common: gitCommonDir(absPath(f.d.repo)), hostDir: f.hostDir, host: '127.0.0.1', port: 0 });
  t.after(() => s.close());
  const api = `${s.url}/api/${CONSOLE_PROTOCOL}`, base = `${api}/arcs/${f.arc}`;
  const stream = new AbortController(); t.after(() => stream.abort());
  const seen: Frame[] = []; frames((await fetch(`${base}/events`, { signal: stream.signal })).body!, seen);
  await until(() => seen.some((x) => x.event === 'revision'), 30_000, 'first notice');
  await until(() => seen.some((x) => x.event === 'pulse'), 5_000, 'first pulse');
  assert.ok(seen.filter((x) => x.event === 'pulse').every((x) => pulseShape(x.data)), 'a pulse is exactly its shape');
  const pulses = () => seen.filter((x) => x.event === 'pulse').map((x) => ({ ...(x.data as Pulse), at: x.at }));
  // The arc keeps writing, so every step of the collector is a capture.
  let appending = true;
  const appends = (async () => { while (appending) { f.journal.fact({ kind: 'stage-admitted', unit: unitId('u7'), stage: 'build', waited: { totalMs: 1, byReasonMs: { 'cpu-tokens': 1 } } }); await new Promise((r) => setTimeout(r, 700)); } })();
  t.after(() => { appending = false; return appends; });
  git.slow(true);
  await until(() => pulses().some((p) => p.asOfAgeMs > 5_000), 30_000, 'a pulse more than five seconds behind');
  const slowFrom = Date.now();

  // A browser read, as web-src/app/prepared-read.ts makes it.
  const read = async (route: string) => {
    const began = performance.now(), u = new URL(`${base}/${route}`); let answers = 0;
    for (;;) {
      const r = await fetch(u, { headers: { prefer: 'respond-async' } }), body = await r.json() as { pending?: string; checkedAt?: string };
      answers++;
      if (r.status !== 202) return { status: r.status, ms: performance.now() - began, ageMs: Date.now() - Date.parse(body.checkedAt!), answers };
      u.searchParams.set('pending', body.pending!);
    }
  };
  for (const route of ['shell', 'graph', 'metadata', 'timeline', 'activity']) {
    const r = await read(route);
    assert.equal(r.status, 200, route);
    assert.ok(r.ms <= 1_000, `${route} answered in ${Math.round(r.ms)} ms`);
    assert.ok(r.ageMs > 5_000, `${route} carries its real age (${r.ageMs} ms)`);
  }
  // The strict CLI read still needs a check made after it arrived: none can finish within its two seconds.
  const began = performance.now(), status = await fetch(`${base}/status`), strict = await status.json() as { error: { message: string } };
  const strictMs = performance.now() - began;
  assert.equal(status.status, 503); assert.equal(strict.error.message, 'console has not verified the arc since this request arrived');
  assert.ok(strictMs >= 1_950 && strictMs < 3_000, `strict read answered after ${Math.round(strictMs)} ms`);
  await new Promise((r) => setTimeout(r, 4_000));
  const behind = pulses().filter((p) => p.at >= slowFrom);
  assert.ok(behind.length >= 4, `${behind.length} pulses`);
  for (let i = 1; i < behind.length; i++) assert.ok(behind[i]!.at - behind[i - 1]!.at <= 2_000, `pulses ${behind[i]!.at - behind[i - 1]!.at} ms apart`);
  assert.ok(behind.every((p) => p.behind && p.arc === f.arc), 'behind, said by the server');
  // Between two publishes the age grows with the clock.
  const growing = behind.slice(1).map((p, i) => [behind[i]!, p] as const).filter(([a, b]) => b.asOfAgeMs > a.asOfAgeMs);
  assert.ok(growing.length >= 3, `${growing.length} pulse pairs with the same observation`);
  for (const [a, b] of growing) assert.ok(Math.abs((b.asOfAgeMs - a.asOfAgeMs) - (b.at - a.at)) <= 400, `age grew ${b.asOfAgeMs - a.asOfAgeMs} ms in ${b.at - a.at} ms`);

  appending = false; await appends;
  git.slow(false);
  const fastFrom = Date.now();
  await until(() => pulses().some((p) => p.at >= fastFrom && p.asOfAgeMs < 2_000 && !p.behind), 5_000, 'a pulse caught up within five seconds');
});
