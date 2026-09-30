// The red-lane protocol's decisions (src/pipeline/redlane.ts) and the host signature table
// (src/host/signatures.ts), pure. Named test: redlane.classify. The protocol run on real lanes is in
// lanes.test.ts (lanes.flake-red-green, lanes.red-red, lanes.signature-no-evidence).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HostSample } from '../src/host/sample.ts';
import { HOST_SIGNATURES, SIGNATURE_TAIL_BYTES, matchSignatures, outputSignatures } from '../src/host/signatures.ts';
import { type LaneHost, type RerunEnd, abortReason, afterRerun, classifyRed, redLane, waitForClearHost } from '../src/pipeline/redlane.ts';
import { tmpDir } from './helpers/repo.ts';

const sample = (load1: number, memAvailableKb = 900_000): HostSample => ({ load1, cpus: 16, memTotalKb: 1_000_000, memAvailableKb });
const CLEAR = sample(1);
const BUSY = sample(20);
const host = (start: HostSample, end: HostSample): LaneHost => ({ start, end });

test('redlane.classify: signature with busy-host evidence reruns after a clear host; without evidence it is blocked; no signature is a diagnostic rerun', async () => {
  // The table: each signature's documented text matches, ordinary failures match none.
  assert.deepEqual(HOST_SIGNATURES.map((s) => s.id), ['golangci-lint-lock', 'kind-boot-timeout', 'eagain', 'enospc']);
  assert.deepEqual(matchSignatures('level=error msg="Running error: parallel golangci-lint is running"'), ['golangci-lint-lock']);
  assert.deepEqual(matchSignatures('ERROR: failed to create cluster: timed out waiting for the condition'), ['kind-boot-timeout']);
  assert.deepEqual(matchSignatures('ERROR: failed to create cluster: failed to init node with kubeadm: exit status 1'), ['kind-boot-timeout']);
  assert.deepEqual(matchSignatures('bash: fork: Resource temporarily unavailable'), ['eagain']);
  assert.deepEqual(matchSignatures('Error: spawn EAGAIN'), ['eagain']);
  assert.deepEqual(matchSignatures('write /tmp/x: No space left on device'), ['enospc']);
  assert.deepEqual(matchSignatures('Error: ENOSPC: no space left on device, write'), ['enospc']);
  assert.deepEqual(matchSignatures('expected 3, got 4\nnot ok 1 - add'), []);
  assert.deepEqual(matchSignatures('EAGAINST the odds'), [], 'a signature is a whole token');

  // Output files: both are searched, in table order, only their tails.
  const dir = tmpDir('signatures');
  writeFileSync(join(dir, 'stdout'), 'No space left on device\n');
  writeFileSync(join(dir, 'stderr'), 'fork: Resource temporarily unavailable\n');
  assert.deepEqual(outputSignatures([join(dir, 'stdout'), join(dir, 'stderr')]), ['eagain', 'enospc']);
  writeFileSync(join(dir, 'long'), `EAGAIN\n${'x'.repeat(SIGNATURE_TAIL_BYTES)}`);
  assert.deepEqual(outputSignatures([join(dir, 'long')]), [], 'a signature before the tail is not read');

  // Busy is at either sample: runnable tasks per cpu, or memory.
  assert.deepEqual(classifyRed({ signatures: ['eagain'], host: host(BUSY, CLEAR) }), { kind: 'host-signature', signatures: ['eagain'] });
  assert.deepEqual(classifyRed({ signatures: ['enospc'], host: host(CLEAR, sample(1, 10_000)) }), { kind: 'host-signature', signatures: ['enospc'] });
  assert.deepEqual(classifyRed({ signatures: ['eagain'], host: host(CLEAR, CLEAR) }), { kind: 'signature-without-evidence', signatures: ['eagain'] });
  assert.deepEqual(classifyRed({ signatures: ['eagain'], host: null }), { kind: 'signature-without-evidence', signatures: ['eagain'] }, 'no samples, no evidence');
  assert.deepEqual(classifyRed({ signatures: [], host: host(BUSY, BUSY) }), { kind: 'diagnostic' }, 'a busy host without a signature is a diagnostic rerun');

  // After the rerun.
  const run = (red: boolean, signatures: readonly ('eagain' | 'enospc')[] = []) => ({ red, evidence: { signatures, host: host(CLEAR, CLEAR) } });
  assert.deepEqual(afterRerun('host-signature', run(false)), { kind: 'pass' }, 'green once the host is clear: a pass');
  assert.deepEqual(afterRerun('host-signature', run(true)), { kind: 'red', flaky: false }, 'red on a clear host without a signature: the tree\'s red');
  assert.equal(afterRerun('host-signature', run(true, ['enospc'])).kind, 'blocked', 'the host again: no verdict');
  assert.deepEqual(afterRerun('diagnostic', run(false)), { kind: 'red', flaky: true }, 'red then green: flaky, still red');
  assert.deepEqual(afterRerun('diagnostic', run(true)), { kind: 'red', flaky: false });

  // The protocol: a signature without evidence never reruns; a busy host that clears reruns once.
  let reruns = 0;
  const rerun = async (): Promise<RerunEnd<string, never>> => {
    reruns += 1;
    return { kind: 'ran', run: 'rerun', verdict: run(false) };
  };
  const live = new AbortController().signal;
  const blocked = await redLane({ signatures: ['eagain'], host: host(CLEAR, CLEAR) }, rerun, { sample: () => CLEAR, signal: live });
  assert.equal(blocked.kind, 'blocked');
  assert.equal(reruns, 0);
  const samples = [BUSY, CLEAR];
  const passed = await redLane({ signatures: ['eagain'], host: host(BUSY, BUSY) }, rerun, { sample: () => samples.shift() ?? CLEAR, signal: live });
  assert.deepEqual(passed, { kind: 'reran', reason: 'host-signature', verdict: { kind: 'pass' }, rerun: 'rerun' });
  assert.equal(reruns, 1);
  assert.deepEqual(samples, [], 'the wait sampled until the host was clear');

  // The wait: a timeout, and a cancel that names pause or stop.
  assert.deepEqual(await waitForClearHost(() => BUSY, live, 50), { kind: 'timeout' });
  const paused = new AbortController();
  paused.abort('pause');
  assert.deepEqual(await waitForClearHost(() => BUSY, paused.signal), { kind: 'interrupted', reason: 'pause' });
  const odd = new AbortController();
  odd.abort('other');
  assert.throws(() => abortReason(odd.signal), /not pause or stop/);
});
