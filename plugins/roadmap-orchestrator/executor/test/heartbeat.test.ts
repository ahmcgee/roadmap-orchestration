// dev.76: the executor's heartbeat says its one thread is alive and getting work done (src/host/heartbeat.ts). The timer
// that writes it fires only when the event loop gets a turn, so a long synchronous stretch used to starve it; the
// watchdog SIGKILLs an executor whose heartbeat is 5 minutes old. Each git call's return now beats it (at most every
// HEARTBEAT_MS), so a stretch that keeps completing git calls keeps it fresh, while one that completes nothing does not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { heartbeat } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { revParse } from '../src/git/git.ts';
import { HEARTBEAT_FILE, HEARTBEAT_MS, startHeartbeat } from '../src/host/heartbeat.ts';
import { makeRepo, tmpDir } from './helpers/repo.ts';

/** The heartbeat's `at`, in ms. */
const beatAt = (runDir: string): number => Date.parse(heartbeat(JSON.parse(readFileSync(join(runDir, HEARTBEAT_FILE), 'utf8')), HEARTBEAT_FILE).at);

/** Runs `work` until `ms` have passed, without yielding to the event loop: the heartbeat's timer cannot fire meanwhile. */
function busyFor(ms: number, work: () => void): void {
  const until = Date.now() + ms;
  while (Date.now() < until) work();
}

test('heartbeat.progress-beats: a synchronous stretch of slow git calls longer than HEARTBEAT_MS advances the heartbeat; one that completes nothing leaves it unwritten', { timeout: 120_000 }, () => {
  const runDir = absPath(tmpDir('heartbeat'));
  const repo = absPath(makeRepo(tmpDir('heartbeat-repo'), { files: { 'a.txt': 'a\n' } }));
  // Every git call takes 1.5 s (a contended host), through a PATH shim in front of the real git.
  const bin = tmpDir('slow-git');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 1.5\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env['PATH'];
  const stop = startHeartbeat(runDir, 1);
  try {
    const first = beatAt(runDir);
    process.env['PATH'] = `${bin}:${path}`;
    let calls = 0;
    busyFor(HEARTBEAT_MS + 3_000, () => { revParse(repo, 'HEAD'); calls++; });
    process.env['PATH'] = path;
    const during = beatAt(runDir);
    assert.ok(during - first >= HEARTBEAT_MS, `the heartbeat advanced ${during - first} ms over ${calls} git calls with the timer starved`);
    // A stretch that completes no call (a wedged derivation) writes nothing: the watchdog still sees it.
    busyFor(HEARTBEAT_MS + 1_000, () => undefined);
    assert.equal(beatAt(runDir), during, 'nothing beat while nothing was done');
  } finally {
    process.env['PATH'] = path;
    stop();
  }
});
