import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AlreadyExistsError,
  CounterRegressionError,
  appendSync,
  atomicJson,
  canonicalJson,
  durableMkdir,
  durableRename,
  durableWrite,
  exclusiveCreate,
  monotonic,
  readJson,
} from '../src/core/fsx.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';

test('fsx.durable-write-no-temp', () => {
  const dir = tmpDir('fsx');
  const target = join(dir, 'state.json');
  durableWrite(target, 'hello\n');
  assert.equal(readFileSync(target, 'utf8'), 'hello\n');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('fsx.durable-write-replaces-atomically', async () => {
  const dir = tmpDir('fsx');
  const target = join(dir, 'target');
  const size = 256 * 1024;
  const versions = [Buffer.alloc(size, 'A'), Buffer.alloc(size, 'B')] as const;
  durableWrite(target, versions[0]);

  const reader = runFixture('reader-child.ts', [target, '300'], { env: process.env, timeoutMs: 30_000 });
  let finished = false;
  const settled = reader.finally(() => (finished = true));

  // Keep replacing the file for as long as the reader reads; runFixture's timeout bounds a stuck reader.
  let writes = 0;
  while (!finished) {
    writes++;
    durableWrite(target, versions[writes % 2]!);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const exit = await settled;

  assert.equal(exit.code, 0, `reader saw a torn file: ${exit.stderr}`);
  const seen = JSON.parse(exit.stdout) as { a: number; b: number };
  assert.equal(seen.a + seen.b, 300);
  assert.ok(seen.a > 0 && seen.b > 0, `reader never observed a replacement (${exit.stdout.trim()}, ${writes} writes)`);
  assert.deepEqual(readdirSync(dir), ['target']);
});

test('fsx.append-full-buffer', () => {
  const dir = tmpDir('fsx');
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, 'first\n');
  const big = Buffer.alloc(4 * 1024 * 1024 + 7, 'x');
  const fd = openSync(path, 'a');
  try {
    appendSync(fd, big);
    appendSync(fd, 'last\n');
  } finally {
    closeSync(fd);
  }
  const bytes = readFileSync(path);
  assert.equal(bytes.length, 6 + big.length + 5);
  assert.equal(bytes.subarray(0, 6).toString(), 'first\n');
  assert.ok(bytes.subarray(6, 6 + big.length).equals(big));
  assert.equal(bytes.subarray(6 + big.length).toString(), 'last\n');
});

test('fsx.exclusive-create-refuses-second', () => {
  const dir = tmpDir('fsx');
  const path = join(dir, 'handshake.1');
  exclusiveCreate(path, 'one');
  assert.throws(() => exclusiveCreate(path, 'two'), AlreadyExistsError);
  assert.equal(readFileSync(path, 'utf8'), 'one');
});

test('fsx.monotonic-never-decreases', () => {
  monotonic({ attempts: 1, retries: 0 }, { attempts: 1, retries: 2, extra: 5 });
  assert.throws(() => monotonic({ attempts: 2 }, { attempts: 1 }), CounterRegressionError);
  assert.throws(() => monotonic({ attempts: 2 }, {}), /counter attempts regressed from 2 to absent/);
});

test('fsx.rename-and-mkdir', () => {
  const dir = tmpDir('fsx');
  const nested = join(dir, 'a', 'b', 'c');
  durableMkdir(nested);
  durableMkdir(nested);
  const from = join(dir, 'from.txt');
  durableWrite(from, 'moved');
  durableRename(from, join(nested, 'to.txt'));
  assert.equal(existsSync(from), false);
  assert.equal(readFileSync(join(nested, 'to.txt'), 'utf8'), 'moved');
});

test('fsx.atomic-json-canonical', () => {
  const dir = tmpDir('fsx');
  const path = join(dir, 'x.json');
  atomicJson(path, { b: 1, a: { d: [true, null], c: 'x' } });
  assert.equal(readFileSync(path, 'utf8'), canonicalJson({ a: { c: 'x', d: [true, null] }, b: 1 }));
  assert.deepEqual(readJson(path), { a: { c: 'x', d: [true, null] }, b: 1 });
  assert.throws(() => canonicalJson({ a: undefined }), /\$\.a is not JSON-representable/);
  assert.throws(() => canonicalJson({ n: Number.NaN }), /\$\.n is a non-finite number/);
  assert.throws(() => canonicalJson(new Date()), /not JSON-representable/);
});
