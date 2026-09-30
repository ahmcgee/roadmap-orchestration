// M2 test support: per-unit fake-backend scenarios, the per-unit barrier, the estate pool scripts and the
// red-then-green lane script.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { reached, release, unitBarrierName } from './helpers/barrier.ts';
import { history, instanceDir, maxConcurrentOwners } from './helpers/estate.ts';
import { fixture, runUntilExit } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Step, readCalls, writeScenario } from './helpers/scenario.ts';

const FAKES = (name: string): string => fixture(`../fakes/${name}`);
const run = (script: string, args: readonly string[], env: Record<string, string> = {}) =>
  runUntilExit(process.execPath, [FAKES(script), ...args], { env: { PATH: process.env['PATH'] ?? '', ...env }, timeoutMs: 15_000 });

/** A claude call through the shim as `unit`'s worktree (cwd) or owner label; the step's `exit` act is its exit code. */
function call(binDir: string, how: { cwd: string } | { owner: string }) {
  const cwd = 'cwd' in how ? how.cwd : tmpDir('elsewhere');
  const env = { PATH: `${binDir}:/usr/bin:/bin`, ...('owner' in how ? { RESOURCE_OWNER: how.owner } : {}) };
  return runUntilExit('claude', ['-p'], { env, cwd, timeoutMs: 15_000 });
}

const exits = (unit: string | undefined, code: number, extra: Step['acts'] = []): Step =>
  ({ as: 'claude', ...(unit === undefined ? {} : { unit }), expect: {}, acts: [...extra, { type: 'exit', code }] }) as Step;

describe('fakes.per-unit-order', () => {
  it('each unit consumes its own steps in order, whatever the file interleaving or the peers running', async () => {
    const root = tmpDir('worktrees');
    const wt = (unit: string): string => {
      const dir = join(root, 'arc', unit);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const dir = tmpDir('scenario');
    const s = writeScenario(dir, [
      exits('b', 11, [{ type: 'barrier', name: 'hold', timeoutMs: 10_000, perUnit: true, progressMs: 50 }]),
      exits('a', 21),
      exits('b', 12),
      exits('a', 22),
    ]);
    // b starts first and parks at its own barrier; a's calls are unaffected and get a's steps, not b's.
    const b1 = call(s.binDir, { cwd: wt('b') });
    await reached(dir, unitBarrierName('b', 'hold'), 10_000);
    assert.equal((await call(s.binDir, { cwd: wt('a') })).code, 21);
    assert.equal((await call(s.binDir, { owner: 'arc/a' })).code, 22);
    assert.equal((await call(s.binDir, { cwd: wt('a') })).code, 99, 'a has no step left; b\'s are not a\'s to take');
    release(dir, unitBarrierName('b', 'hold'));
    const first = await b1;
    assert.equal(first.code, 11);
    assert.match(first.stdout, /^waiting b\.hold$/m);
    assert.equal((await call(s.binDir, { cwd: wt('b') })).code, 12);
    const calls = readCalls(s.path);
    assert.deepEqual(calls.map((c) => [c.unit, c.step]), [['b', 0], ['a', 1], ['a', 3], ['a', null], ['b', 2]]);
  });

  it('concurrent calls of one unit never share a step', async () => {
    const dir = tmpDir('scenario');
    const s = writeScenario(dir, [exits('u', 31), exits('u', 32), exits('u', 33), exits('u', 34)]);
    const results = await Promise.all([0, 1, 2, 3].map(() => call(s.binDir, { owner: `arc/u` }).then((r) => r.code)));
    assert.deepEqual(results.sort(), [31, 32, 33, 34]);
  });

  it('a scenario without units is unchanged: steps in file order for any caller', async () => {
    const s = writeScenario(tmpDir('scenario'), [exits(undefined, 41), exits(undefined, 42)]);
    assert.equal((await call(s.binDir, { owner: 'arc/x' })).code, 41);
    assert.equal((await call(s.binDir, { cwd: tmpDir('wt') })).code, 42);
  });
});

describe('barrier: per-unit names and progress', () => {
  it('the lane script parks at its unit\'s barrier, prints progress while waiting, and exits 0 once released', async () => {
    const dir = tmpDir('barrier');
    const lane = (unit: string) => run('lane-barrier.ts', [dir, 'lane', '10000', '30'], { RESOURCE_OWNER: `arc/${unit}` });
    const [x, y] = [lane('x'), lane('y')];
    await reached(dir, 'x.lane', 10_000);
    await reached(dir, 'y.lane', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    release(dir, 'x.lane');
    const rx = await x;
    assert.equal(rx.code, 0, rx.stderr);
    assert.match(rx.stdout, /^waiting x\.lane$/m);
    assert.ok((rx.stdout.match(/waiting x\.lane/g)?.length ?? 0) >= 2, 'progress repeats while parked');
    assert.equal(existsSync(join(dir, 'y.lane.release')), false, 'y is still parked');
    release(dir, 'y.lane');
    assert.equal((await y).code, 0);
  });
});

describe('estate pool scripts', () => {
  const pool = 'kind-lab';
  const env = (n: number, unit: string): Record<string, string> => ({ RESOURCE_INSTANCE_KIND_LAB: String(n), RESOURCE_OWNER: `arc/${unit}` });
  const estate = (cmd: string, state: string, n: number, unit: string, ...rest: string[]) => run('estate.ts', [cmd, state, pool, ...rest], env(n, unit));

  it('probe follows the exit contract per instance: 0 free, 10 own, 11 foreign', async () => {
    const state = tmpDir('estate');
    const dir = tmpDir('barrier');
    const holder = estate('hold', state, 1, 'a', dir, 'hold', '10000', '30');
    await reached(dir, 'a.hold', 10_000);
    assert.equal((await estate('probe', state, 1, 'a')).code, 10);
    assert.equal((await estate('probe', state, 1, 'b')).code, 11);
    assert.equal((await estate('probe', state, 2, 'b')).code, 0, 'instance 2 is a different directory');
    release(dir, 'a.hold');
    assert.equal((await holder).code, 0);
    assert.equal((await estate('probe', state, 1, 'b')).code, 0);
    assert.deepEqual(history(instanceDir(state, pool, 1)), ['enter arc/a', 'leave arc/a']);
  });

  it('a second owner of a held instance is a conflict the history shows', async () => {
    const state = tmpDir('estate');
    const dir = tmpDir('barrier');
    const holder = estate('hold', state, 1, 'a', dir, 'hold', '10000', '30');
    await reached(dir, 'a.hold', 10_000);
    assert.equal((await estate('hold', state, 1, 'b')).code, 1);
    release(dir, 'a.hold');
    await holder;
    assert.equal(maxConcurrentOwners(instanceDir(state, pool, 1)), 2);
  });

  it('two owners on different instances, then reuse of one after release, never overlap', async () => {
    const state = tmpDir('estate');
    const dir = tmpDir('barrier');
    const a = estate('hold', state, 1, 'a', dir, 'hold', '10000', '30');
    const b = estate('hold', state, 2, 'b', dir, 'hold', '10000', '30');
    await reached(dir, 'a.hold', 10_000);
    await reached(dir, 'b.hold', 10_000);
    release(dir, 'a.hold');
    release(dir, 'b.hold');
    assert.equal((await a).code, 0);
    assert.equal((await b).code, 0);
    assert.equal((await estate('hold', state, 1, 'c')).code, 0);
    for (const n of [1, 2]) assert.equal(maxConcurrentOwners(instanceDir(state, pool, n)), 1);
    assert.match(readFileSync(join(state, 'calls.log'), 'utf8'), /^hold kind-lab#1 arc\/a$/m);
  });

  it('teardown removes only the caller\'s occupant, and the marker file makes it fail exactly once', async () => {
    const state = tmpDir('estate');
    const dir = tmpDir('barrier');
    const holder = estate('hold', state, 1, 'a', dir, 'hold', '10000', '30');
    await reached(dir, 'a.hold', 10_000);
    assert.equal((await estate('teardown', state, 1, 'b')).code, 0);
    assert.equal((await estate('probe', state, 1, 'a')).code, 10, 'b\'s teardown left a\'s occupant');
    writeFileSync(join(state, `${pool}.teardown-fails-once`), '');
    assert.equal((await estate('teardown', state, 1, 'a')).code, 1);
    assert.equal(existsSync(join(state, `${pool}.teardown-fails-once`)), false);
    assert.equal((await estate('probe', state, 1, 'a')).code, 10, 'the failed teardown removed nothing');
    assert.equal((await estate('teardown', state, 1, 'a')).code, 0);
    assert.equal((await estate('probe', state, 1, 'a')).code, 0);
    release(dir, 'a.hold');
    await holder;
  });

  it('a missing instance variable or owner label throws', async () => {
    const state = tmpDir('estate');
    const noInstance = await run('estate.ts', ['probe', state, pool], { RESOURCE_OWNER: 'arc/a' });
    assert.notEqual(noInstance.code, 0);
    assert.match(noInstance.stderr, /RESOURCE_INSTANCE_KIND_LAB is not set/);
    const noOwner = await run('estate.ts', ['probe', state, pool], { RESOURCE_INSTANCE_KIND_LAB: '1' });
    assert.match(noOwner.stderr, /RESOURCE_OWNER is not set/);
  });
});

describe('red-green lane script', () => {
  it('fails the first run, passes every later one; the marker file is the state', async () => {
    const marker = join(tmpDir('rg'), 'marker');
    const first = await run('red-green.ts', [marker, 'boom']);
    assert.equal(first.code, 1);
    assert.equal(first.stderr, 'boom\n');
    for (let i = 0; i < 2; i++) {
      const later = await run('red-green.ts', [marker]);
      assert.equal(later.code, 0);
      assert.equal(later.stdout, 'green\n');
    }
  });
});
