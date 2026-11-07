import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { ObservationCache } from '../src/observation/cache.ts';
import { ConsoleError, statusBytes, validateEnvelope } from '../src/observation/protocol.ts';
import { parityArc } from './fixtures/status-parity.ts';

function fixture() {
  const f = parityArc();
  const run = { runDir: f.runDir, arc: arcId(f.d.arc) };
  const cache = new ObservationCache(f.hostDir, 'instance', 'repo');
  return { ...f, run, cache };
}

test('one captured observation supplies exact canonical full and summary transport bytes', () => {
  const { cache, run } = fixture();
  const e = cache.read(run);
  assert.equal(statusBytes(e, false), canonicalJson(e.data.display.status) + '\n');
  assert.equal(statusBytes(e, true), canonicalJson(e.data.summary) + '\n');
  assert.equal(e.data.capture.foldMs, e.data.display.status.host.log.foldMs);
  assert.ok(Number.isFinite(e.data.capture.clock));
  assert.equal(e.highWater, e.data.display.seq);
  assert.equal(validateEnvelope(JSON.parse(JSON.stringify(e)), { instance: e.instance, repoId: e.repoId, arc: e.arc }).revision, e.revision);
  assert.throws(() => validateEnvelope({ ...e, protocol: 'old' }, { instance: e.instance, repoId: e.repoId, arc: e.arc }), /protocol/);
  assert.throws(() => validateEnvelope({ ...e, data: {} }, { instance: e.instance, repoId: e.repoId, arc: e.arc }), /payload/);
});

test('unchanged dependencies reuse expensive captures, heartbeat invalidates only volatile fields, receipts invalidate independently', () => {
  const { cache, run } = fixture();
  const first = cache.read(run);
  const checked = cache.read(run);
  assert.equal(checked.data, first.data);
  assert.equal(checked.revision, first.revision);
  writeFileSync(join(run.runDir, 'heartbeat.json'), JSON.stringify({ v: 2, generation: 1, at: '2026-06-01T00:00:00.000Z' }));
  const next = cache.read(run);
  assert.equal(next.highWater, first.highWater);
  assert.ok(next.revision > first.revision);
  assert.equal(next.data.display.status.run.heartbeatAt, '2026-06-01T00:00:00.000Z');
  assert.equal(next.data.capture.materializations, first.data.capture.materializations);
  const file = join(run.runDir, 'commands', 'receipts', 'cmd-0000000000000001.rejected.json');
  const receipt = JSON.parse(readFileSync(file, 'utf8')); receipt.reason = 'Changed side file';
  writeFileSync(file, JSON.stringify(receipt));
  assert.ok(cache.read(run).data.capture.materializations > next.data.capture.materializations);
  writeFileSync(file, '{}');
  assert.throws(() => cache.read(run));
});

test('partial tails stay read-only, journal replacement resets epoch, corrupt complete lines never publish', () => {
  const { cache, run } = fixture();
  const first = cache.read(run);
  const path = join(run.runDir, 'events.jsonl');
  const original = readFileSync(path);
  appendFileSync(path, '{"incomplete":');
  assert.equal(cache.read(run).highWater, first.highWater);
  assert.equal(readFileSync(path).length, original.length + 14);
  writeFileSync(path, original);
  const reset = cache.read(run);
  assert.notEqual(reset.epoch, first.epoch);
  assert.throws(() => cache.read(run, { epoch: first.epoch }), (e: unknown) => e instanceof ConsoleError && e.code === 'reset');
  assert.throws(() => cache.read(run, { minHighWater: first.highWater + 1 }), /watermark/);
  appendFileSync(path, 'broken\n');
  assert.throws(() => cache.read(run), /corrupt|JSON|Unexpected/);
});
