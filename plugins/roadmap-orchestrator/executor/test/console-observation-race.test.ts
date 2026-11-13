import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { COLLECT } from '../src/observation/collect.ts';
import { Observer } from '../src/observation/observer.ts';
import { CONSOLE_PROTOCOL, type Envelope } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';
import { parityArc } from './fixtures/status-parity.ts';
import { ObservedArc } from './helpers/observations.ts';

function fixture(t: TestContext) {
  const f = parityArc();
  // Restore named builtin imports as well as fs's default export after each fixture's spies.
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const run = { runDir: f.runDir, arc: arcId(f.d.arc) };
  return { ...f, run, arc: new ObservedArc(f.hostDir, 'instance', 'repo', run) };
}
const heartbeat = JSON.stringify({ v: 2, generation: 1, at: '2026-06-01T00:00:00.000Z' });
const kinds = (a: ObservedArc) => a.messages.map((m) => m.kind).filter((k) => k !== 'progress' && k !== 'journal');
const reasonOf = (e: Envelope, command: string): string | undefined => { const r = e.data.display.status.commands.receipts.find((r) => r.command === command); return r && 'reason' in r ? r.reason : undefined; };
const observations = (a: ObservedArc) => a.messages.filter((m) => m.kind === 'observation');
const folded = (a: ObservedArc) => observations(a).reduce((n, m) => n + (m.kind === 'observation' ? m.work.eventsFolded : 0), 0);
const journalLines = (runDir: string) => fs.readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length;

// Keep a real dependency present for each attempt, but remove it at the Observer's read.
function disappearingHeartbeat(t: TestContext, runDir: string, onRace: () => void): void {
  const path = join(runDir, 'heartbeat.json');
  fs.writeFileSync(path, heartbeat);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (args[0] !== path) return read(...args);
    fs.unlinkSync(path); onRace();
    try { return read(...args); }
    finally { fs.writeFileSync(path, heartbeat); }
  }) as typeof read);
}

test('a dependency republished during a capture: the capture is published as of its sample, and the next step captures again', (t) => {
  const { run, arc } = fixture(t);
  const receipt = join(run.runDir, 'commands', 'receipts', 'cmd-000000000000000c.rejected.json');
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const capture = Observer.prototype.capture;
  let raced = 0;
  t.mock.method(Observer.prototype, 'capture', function (this: Observer, ...args: Parameters<typeof capture>) {
    const reply = capture.apply(this, args);
    if (raced++ === 0) fs.writeFileSync(receipt, JSON.stringify({ ...value, reason: 'Republished during the capture' }));
    return reply;
  });
  const first = arc.read();
  assert.equal(first.data.capture.materializations, 1, 'published as of the sample taken before the capture read anything');
  assert.notEqual(reasonOf(first, value.command), 'Republished during the capture');
  const next = arc.read();
  assert.equal(raced, 2, 'the record that changed during the capture differs from that sample, so the next step captures again');
  assert.equal(next.data.capture.materializations, 2);
  assert.equal(reasonOf(next, value.command), 'Republished during the capture');
  assert.equal(arc.read().data, next.data, 'and then it stands');
});

test('ENOENT inside a capture publishes nothing and keeps the cursor; the next step succeeds without a second fold', (t) => {
  const { run, arc } = fixture(t);
  const path = join(run.runDir, 'heartbeat.json');
  fs.writeFileSync(path, heartbeat);
  const read = fs.readFileSync;
  let raced = 0;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (args[0] === path && raced++ === 0) fs.unlinkSync(path);
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  arc.collector.step(Date.now());
  assert.equal(raced, 1);
  assert.deepEqual(kinds(arc), [], 'no observation, no failure, no check');
  assert.equal(arc.model.envelope(), null);
  const e = arc.read();
  assert.equal(e.data.display.status.run.heartbeatAt, null);
  assert.equal(observations(arc).length, 1);
  assert.equal(folded(arc), journalLines(run.runDir), 'the journal was folded once');
});

test('persistent capture races publish nothing and log once after five in a row', (t) => {
  const { run, arc } = fixture(t);
  let raced = 0;
  disappearingHeartbeat(t, run.runDir, () => { raced++; });
  syncBuiltinESMExports();
  for (let i = 0; i < COLLECT.racesBeforeLog + 2; i++) arc.collector.step(Date.now());
  assert.ok(raced >= COLLECT.racesBeforeLog + 2);
  assert.equal(observations(arc).length, 0);
  const logs = arc.messages.filter((m) => m.kind === 'log');
  assert.equal(logs.length, 1, 'one log line, after five');
  assert.match(logs[0]!.kind === 'log' ? logs[0]!.message : '', /5 captures in a row raced a writer .*heartbeat\.json/);
  assert.equal(arc.messages.some((m) => m.kind === 'failed'), false, 'a race is never a failure');
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(arc.read().data.display.status.arc, run.arc, 'failed attempts did not poison the collector');
  assert.equal(folded(arc), journalLines(run.runDir));
});

test('a strict read through the console answers unavailable at two seconds while every check races, not pruned evidence', { timeout: 30_000 }, async (t) => {
  const f = consoleFixture();
  const dir = fs.mkdtempSync(join(tmpdir(), 'roadmap-race-console-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const flag = join(dir, 'race'), path = join(f.runDir, 'heartbeat.json');
  fs.writeFileSync(path, heartbeat);
  // Every thread of the console (main, serve worker, collector) loads this: once the flag exists, each read of the heartbeat races.
  fs.writeFileSync(join(dir, 'race.mjs'), `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const path = ${JSON.stringify(path)}, flag = ${JSON.stringify(flag)}, heartbeat = ${JSON.stringify(heartbeat)}, read = fs.readFileSync;
    fs.readFileSync = (...params) => {
      if (params[0] !== path || !fs.existsSync(flag)) return read(...params);
      fs.unlinkSync(path);
      try { return read(...params); } finally { fs.writeFileSync(path, heartbeat); }
    };
    syncBuiltinESMExports();`);
  fs.writeFileSync(join(dir, 'serve.ts'), `
    const { serveConsole } = await import(${JSON.stringify(new URL('../src/console/http.ts', import.meta.url).href)});
    const s = await serveConsole(${JSON.stringify({ repo: f.repo, common: f.common, hostDir: f.hostDir, host: '127.0.0.1', port: 0 })});
    process.stdout.write(s.url + '\\n');`);
  const child = spawn(process.execPath, ['--import', join(dir, 'race.mjs'), join(dir, 'serve.ts')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const url = await new Promise<string>((resolve, reject) => {
    let out = ''; child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()); });
    child.once('exit', (code) => reject(new Error(`console exited ${code}: ${stderr}`)));
  });
  const status = `${url}/api/${CONSOLE_PROTOCOL}/arcs/${f.arc}/status`;
  assert.equal((await fetch(status)).status, 200, 'the arc is observed and verified');
  fs.writeFileSync(flag, '');
  const began = performance.now();
  const response = await fetch(status), body = await response.json() as { error?: { code: string; message: string } };
  const took = performance.now() - began;
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.error?.code, 'unavailable');
  assert.match(body.error!.message, /has not verified the arc since this request arrived/);
  assert.ok(took >= 1_900 && took < 4_000, `answered at its two-second budget (${Math.round(took)} ms)`);
});

test('persistent capture races keep the collector loop running: a step returns promptly every time', (t) => {
  const { run, arc } = fixture(t);
  let raced = 0;
  disappearingHeartbeat(t, run.runDir, () => { raced++; });
  syncBuiltinESMExports();
  for (let i = 0; i < 3; i++) {
    const sleep = arc.collector.step(Date.now());
    assert.ok(sleep > 0 && sleep <= COLLECT.idleMs, 'the loop sleeps and steps again; nothing spends a budget on retries');
  }
  assert.equal(raced, 3, 'one attempt per step: churn yields to the writer');
  assert.equal(observations(arc).length, 0);
});

test('a failed cold capture retains its verified journal cursor for the next step', (t) => {
  const { run, arc } = fixture(t);
  const path = join(run.runDir, 'heartbeat.json');
  fs.writeFileSync(path, heartbeat);
  const read = fs.readFileSync, capture = Observer.prototype.capture;
  const observers: Observer[] = [];
  const offsets: number[] = [];
  t.mock.method(Observer.prototype, 'capture', function (this: Observer, ...args: Parameters<typeof capture>) {
    observers.push(this); offsets.push(this.cursor?.offset ?? 0);
    return capture.apply(this, args);
  });
  let raced = 0;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (args[0] === path && raced++ === 0) fs.unlinkSync(path);
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  arc.collector.step(Date.now());
  const e = arc.read();
  assert.equal(observers.length, 2);
  assert.equal(observers[1], observers[0], 'the retry reuses the observer that already verified the journal');
  assert.equal(offsets[0], 0);
  assert.ok(offsets[1]! > 0, 'the retry starts at the previously verified journal offset');
  assert.equal(e.data.display.status.run.heartbeatAt, null);
  assert.equal(folded(arc), journalLines(run.runDir));
  assert.equal(arc.read().data, e.data, 'only a complete observation is published');
});

test('a heartbeat written during a capture is the next step\'s overlay, never a second capture', (t) => {
  const { run, arc } = fixture(t);
  const capture = Observer.prototype.capture;
  let captures = 0;
  t.mock.method(Observer.prototype, 'capture', function (this: Observer, ...args: Parameters<typeof capture>) {
    captures++;
    const reply = capture.apply(this, args);
    fs.writeFileSync(join(run.runDir, 'heartbeat.json'), heartbeat);
    return reply;
  });
  const first = arc.read();
  const e = arc.read();
  assert.equal(captures, 1, 'a heartbeat-only change does not recapture immutable evidence');
  // dev.75: the heartbeat is the check's, which the status route applies; a check makes no revision.
  assert.equal((arc.model.status(e, false) as typeof e.data.display.status).run.heartbeatAt, '2026-06-01T00:00:00.000Z');
  assert.equal(e.revision, first.revision); assert.equal(e.highWater, first.highWater);
  assert.equal(e.data.capture.materializations, first.data.capture.materializations);
  assert.equal(arc.read().data, e.data);
});

test('continuously changing capture dependencies: every step publishes the capture as of its sample and converges', (t) => {
  const { run, arc } = fixture(t);
  const receipt = join(run.runDir, 'commands', 'receipts', 'cmd-000000000000000c.rejected.json');
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const capture = Observer.prototype.capture;
  let captures = 0;
  const spy = t.mock.method(Observer.prototype, 'capture', function (this: Observer, ...args: Parameters<typeof capture>) {
    const reply = capture.apply(this, args);
    fs.writeFileSync(receipt, JSON.stringify({ ...value, reason: `Changed ${++captures}` }));
    return reply;
  });
  const reasons = [1, 2, 3].map(() => reasonOf(arc.read(), value.command));
  assert.equal(captures, 3, 'each step captures what changed since its sample');
  assert.deepEqual(reasons, [value.reason, 'Changed 1', 'Changed 2'], 'each published capture is complete as of its sample, one change behind the writer');
  spy.mock.restore();
  const e = arc.read();
  assert.equal(reasonOf(e, value.command), 'Changed 3');
  assert.equal(e.data.capture.materializations, 4);
  assert.equal(arc.read().data, e.data, 'once the writer stops, the observation stands');
});

test('a step that races defers the capture to the next step without publishing partial data', (t) => {
  const { run, arc } = fixture(t);
  const path = join(run.runDir, 'heartbeat.json');
  fs.writeFileSync(path, heartbeat);
  const read = fs.readFileSync;
  const captures = t.mock.method(Observer.prototype, 'capture');
  let raced = 0;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (args[0] === path && raced++ === 0) fs.unlinkSync(path);
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  arc.collector.step(Date.now());
  assert.equal(captures.mock.callCount(), 1, 'no recapture within the step competes with the writer');
  assert.equal(arc.model.envelope(), null);
  arc.collector.step(Date.now());
  assert.equal(captures.mock.callCount(), 2, 'the next step captures the now-stable run');
  const e = arc.model.envelope()!;
  assert.equal(e.data.display.status.run.heartbeatAt, null);
  assert.equal(e.data.capture.materializations, 1, 'the raced step did not publish partial data');
  assert.equal(arc.read().data, e.data, 'reads are served the published capture');
});
