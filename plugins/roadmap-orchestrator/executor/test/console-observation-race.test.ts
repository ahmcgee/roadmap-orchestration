import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { test, type TestContext } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { Observer } from '../src/observation/observer.ts';
import { ConsoleError } from '../src/observation/protocol.ts';
import { consoleFixture } from './fixtures/console.ts';
import { parityArc } from './fixtures/status-parity.ts';

function fixture(t: TestContext) {
  const f = parityArc();
  // Restore named builtin imports as well as fs's default export after each fixture's spies.
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { ...f, run: { runDir: f.runDir, arc: arcId(f.d.arc) }, cache: new ObservationCache(f.hostDir, 'instance', 'repo') };
}

const heartbeat = JSON.stringify({ v: 2, generation: 1, at: '2026-06-01T00:00:00.000Z' });

test('capture retries when atomic publication removes a temporary file after dependency stamping', (t) => {
  const { run, cache } = fixture(t);
  const temp = join(run.runDir, 'heartbeat.json.race.tmp');
  const published = join(run.runDir, 'heartbeat.json');
  fs.writeFileSync(temp, heartbeat);
  const lstat = fs.lstatSync;
  let raced = 0;
  t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
    if (args[0] === temp) {
      // Dependency stamping excludes .tmp; containment has enumerated it, then the writer renames it.
      fs.renameSync(temp, published); raced++;
    }
    return lstat(...args);
  }) as typeof lstat);
  syncBuiltinESMExports();
  const e = cache.read(run);
  assert.equal(raced, 1);
  assert.equal(e.data.display.status.run.heartbeatAt, '2026-06-01T00:00:00.000Z');
  assert.equal(cache.read(run).data, e.data, 'only the complete retry was cached');
});

test('capture retries ENOENT inside Observer without converting it to corruption', (t) => {
  const { run, cache } = fixture(t);
  const path = join(run.runDir, 'heartbeat.json');
  fs.writeFileSync(path, heartbeat);
  const read = fs.readFileSync;
  let raced = 0;
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    if (args[0] === path && raced++ === 0) fs.unlinkSync(path);
    return read(...args);
  }) as typeof read);
  syncBuiltinESMExports();
  const e = cache.read(run);
  assert.equal(raced, 1);
  assert.equal(e.data.display.status.run.heartbeatAt, null);
});

test('repeated disappearing files exhaust the existing admission deadline as unavailable', (t) => {
  const { run, cache } = fixture(t);
  const temp = join(run.runDir, 'heartbeat.json.race.tmp');
  const readdir = fs.readdirSync, lstat = fs.lstatSync;
  let raced = 0;
  t.mock.method(fs, 'readdirSync', ((...args: Parameters<typeof readdir>) => {
    if (args[0] === run.runDir) fs.writeFileSync(temp, heartbeat);
    return readdir(...args);
  }) as typeof readdir);
  t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
    if (args[0] === temp) { fs.unlinkSync(temp); raced++; }
    return lstat(...args);
  }) as typeof lstat);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + raced * 1_000);
  syncBuiltinESMExports();
  assert.throws(() => cache.read(run), (error: unknown) => error instanceof ConsoleError && error.code === 'unavailable');
  assert.equal(raced, 2, 'the original two-second budget includes retries');
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(cache.read(run).data.display.status.arc, run.arc, 'failed attempts did not poison the cache');
});


test('status worker reports exhausted capture races as unavailable, not pruned evidence', { timeout: 10_000 }, async (t) => {
  const f = consoleFixture();
  // Fixture-only filesystem spies also exercise the real worker route/error boundary.
  const worker = new Worker(`
    const fs = require('node:fs');
    const { workerData: args, parentPort } = require('node:worker_threads');
    const temp = args.runDir + '/heartbeat.json.race.tmp';
    const readdir = fs.readdirSync, lstat = fs.lstatSync;
    let races = 0;
    const now = Date.now();
    Date.now = () => now + races * 1000;
    fs.readdirSync = (...params) => {
      if (params[0] === args.runDir && new Error().stack.includes('containment.ts')) fs.writeFileSync(temp, '{}');
      return readdir(...params);
    };
    fs.lstatSync = (...params) => {
      if (params[0] === temp && new Error().stack.includes('containment.ts')) { fs.unlinkSync(temp); races++; }
      return lstat(...params);
    };
    require('node:module').syncBuiltinESMExports();
    import(args.worker).then(() => parentPort.postMessage({ ready: true }));
  `, { eval: true, workerData: { ...f, instance: 'instance', repoId: 'repo', worker: new URL('../src/console/worker.ts', import.meta.url).href } });
  t.after(() => worker.terminate());
  await new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (m) => { if (m.ready) resolve(); });
  });
  const response = new Promise<{ error?: { code: string; message: string } }>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (m) => { if (m.id === 1) resolve(m); });
  });
  worker.postMessage({ id: 1, kind: 'read', path: ['arcs', f.arc, 'status'], params: {} });
  const reply = await response;
  assert.equal(reply.error?.code, 'unavailable');
  assert.match(reply.error!.message, /observation file disappeared/);
});


test('persistent capture races yield after one retry even when the admission clock has not advanced', (t) => {
  const { run, cache } = fixture(t);
  const temp = join(run.runDir, 'heartbeat.json.race.tmp');
  const readdir = fs.readdirSync, lstat = fs.lstatSync;
  let raced = 0;
  t.mock.method(fs, 'readdirSync', ((...args: Parameters<typeof readdir>) => {
    if (args[0] === run.runDir) fs.writeFileSync(temp, heartbeat);
    return readdir(...args);
  }) as typeof readdir);
  t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof lstat>) => {
    if (args[0] === temp) { fs.unlinkSync(temp); raced++; }
    return lstat(...args);
  }) as typeof lstat);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + (raced > 2 ? 2_000 : 0));
  syncBuiltinESMExports();
  assert.throws(() => cache.read(run), (error: unknown) => error instanceof ConsoleError && error.code === 'unavailable');
  assert.equal(raced, 2, 'persistent churn yields to the writer without spending the entire admission budget');
});

test('a failed cold capture retains its verified journal cursor for the retry', (t) => {
  const { run, cache } = fixture(t);
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
  const e = cache.read(run);
  assert.equal(observers.length, 2);
  assert.equal(observers[1], observers[0], 'the retry reuses the observer that already verified the journal');
  assert.equal(offsets[0], 0);
  assert.ok(offsets[1]! > 0, 'the retry starts at the previously verified journal offset');
  assert.equal(e.data.display.status.run.heartbeatAt, null);
  assert.equal(cache.read(run).data, e.data, 'only a complete admitted observation is published');
});


test('volatile admission races reuse the staged capture without publishing a partial observation', (t) => {
  const { run, cache } = fixture(t);
  const capture = Observer.prototype.capture;
  let captures = 0;
  t.mock.method(Observer.prototype, 'capture', function (this: Observer, ...args: Parameters<typeof capture>) {
    captures++;
    const reply = capture.apply(this, args);
    fs.writeFileSync(join(run.runDir, 'heartbeat.json'), heartbeat);
    return reply;
  });
  const e = cache.read(run);
  assert.equal(captures, 1, 'a heartbeat-only retry does not recapture immutable evidence');
  assert.equal(e.data.display.status.run.heartbeatAt, '2026-06-01T00:00:00.000Z');
  assert.equal(cache.read(run).data, e.data);
});


test('continuously changing capture dependencies yield without caching an unadmitted snapshot', (t) => {
  const { run, cache } = fixture(t);
  const receipt = join(run.runDir, 'commands', 'receipts', 'cmd-0000000000000001.rejected.json');
  const value = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  const capture = Observer.prototype.capture;
  let captures = 0;
  const spy = t.mock.method(Observer.prototype, 'capture', function (this: Observer, ...args: Parameters<typeof capture>) {
    const reply = capture.apply(this, args);
    fs.writeFileSync(receipt, JSON.stringify({ ...value, reason: `Changed ${++captures}` }));
    return reply;
  });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + (captures > 2 ? 2_000 : 0));
  assert.throws(() => cache.read(run), (error: unknown) => error instanceof ConsoleError && error.code === 'unavailable');
  assert.equal(captures, 2, 'dependency changes get one retry, then yield to the writer');
  spy.mock.restore();
  const e = cache.read(run);
  assert.equal(e.data.display.status.arc, run.arc);
  assert.equal(e.data.capture.materializations, 1, 'failed admissions did not publish their staged captures');
});
