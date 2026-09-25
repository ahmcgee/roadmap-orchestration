// Integrated tests of the host lock, owner record and handshake (src/host/{lock,owner,liveness}.ts): real
// files, real processes for liveness (a sleeping child whose start time we read, then kill), real child
// supervisors racing for a takeover, and the host takeover row of the crash matrix.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { AlreadyExistsError, atomicJson } from '../src/core/fsx.ts';
import { type ArcId, arcId, invocationId, opId } from '../src/core/ids.ts';
import type { HostLockClaim, ProcIdentity, RecoveryLockClaim } from '../src/core/records.ts';
import { type AbsPath, absPath, isoTimeOf, nonce } from '../src/core/values.ts';
import { SCHEMA_VERSION } from '../src/core/version.ts';
import { exitCodeFor } from '../src/preflight/startup.ts';
import { HOST_LOCK, RECOVERY_LOCK, handshakePath, hostPath, openHostDir } from '../src/host/hostdir.ts';
import { isAlive, selfIdentity } from '../src/host/liveness.ts';
import { identityOf, readBootId, statOf } from '../src/contain/proc.ts';
import {
  type ClaimOutcome, type ClaimRequest, type PreviousArcVerdict, HostLockMismatchError, claimHost, lastGeneration, readClaim,
  releaseHost,
} from '../src/host/lock.ts';
import { HandshakeTimeoutError, awaitHandshake, createHandshake, publishOwner, verifyOwner } from '../src/host/owner.ts';
import { ARC, claimRecord, otherBoot } from './fixtures/host-records.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { type Exit, runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { HOST_TAKEOVER, crashCells } from './matrix.ts';

const WAIT_MS = 20_000;

function hostDir(): AbsPath {
  return openHostDir(absPath(join(tmpDir('host'), 'var-tmp-roadmap')));
}

function request(arc: ArcId = ARC): ClaimRequest {
  return { arc, runDir: absPath(`/repo/.git/roadmap-runtime/${arc}`), repo: absPath('/repo'), supervisor: selfIdentity() };
}

const reconciled = async (): Promise<PreviousArcVerdict> => ({ kind: 'reconciled' });
const neverCalled = async (): Promise<PreviousArcVerdict> => assert.fail('reconcilePrevious must not run');

/** A live process to stand in for another supervisor or executor. Kill it with `kill`. */
type Sleeper = Readonly<{ identity: ProcIdentity; kill: () => Promise<void> }>;
function sleeper(): Sleeper {
  const child: ChildProcess = spawn('sleep', ['300'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'sleep spawned');
  const { start } = identityOf(pid);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    identity: { pid, start },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

/** The identity of a process that has exited (and been reaped). */
async function deadIdentity(): Promise<ProcIdentity> {
  const s = sleeper();
  await s.kill();
  return s.identity;
}

function writeClaim(dir: AbsPath, claim: HostLockClaim): void {
  atomicJson(hostPath(dir, HOST_LOCK), claim);
}

/** A claim on the host whose owner record matches it, as a supervisor leaves it. */
function holdHost(dir: AbsPath, claim: HostLockClaim, executor: ProcIdentity | null): void {
  writeClaim(dir, claim);
  publishOwner(dir, claim, executor);
}

async function deadClaim(dir: AbsPath, opts: Readonly<{ arc?: ArcId; generation?: number }> = {}): Promise<HostLockClaim> {
  const claim = claimRecord({ supervisor: await deadIdentity(), bootId: readBootId(), ...opts });
  holdHost(dir, claim, null);
  return claim;
}

const lockBytes = (dir: AbsPath): string => readFileSync(hostPath(dir, HOST_LOCK), 'utf8');
const leftovers = (dir: AbsPath): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

function claimed(outcome: ClaimOutcome): Extract<ClaimOutcome, { kind: 'claimed' }> {
  assert.equal(outcome.kind, 'claimed', JSON.stringify(outcome));
  return outcome as Extract<ClaimOutcome, { kind: 'claimed' }>;
}

describe('liveness', () => {
  it('a live child is alive; once killed it is dead; a reused pid with another start time is dead', async () => {
    const s = sleeper();
    const boot = readBootId();
    assert.equal(isAlive(s.identity, boot), true);
    assert.equal(isAlive({ pid: s.identity.pid, start: s.identity.start + 1 }, boot), false);
    assert.equal(isAlive(s.identity, otherBoot()), false);
    await s.kill();
    assert.equal(statOf(s.identity.pid), null);
    assert.equal(isAlive(s.identity, boot), false);
  });
});

describe('claim and release', () => {
  it('claims a free host at generation 1 with link, leaving no temp file', async () => {
    const dir = hostDir();
    const got = claimed(await claimHost(dir, request(), neverCalled));
    assert.equal(got.previous, null);
    assert.equal(got.claim.generation, 1);
    assert.deepEqual(readClaim(dir), got.claim);
    assert.deepEqual(leftovers(dir), []);
  });

  it('release is nonce-checked and removes the claim; its write-once handshake stays', async () => {
    const dir = hostDir();
    const { claim } = claimed(await claimHost(dir, request(), neverCalled));
    const forged = { ...claim, nonce: nonce('0'.repeat(32)) };
    assert.throws(() => releaseHost(dir, forged), HostLockMismatchError);
    assert.deepEqual(readClaim(dir), claim);
    createHandshake(dir, claim);
    releaseHost(dir, claim);
    assert.equal(readClaim(dir), null);
    assert.equal(existsSync(handshakePath(dir, claim.generation)), true);
    assert.throws(() => releaseHost(dir, claim), HostLockMismatchError);
  });

  it('a takeover increments the generation of the claim it replaces', async () => {
    const dir = hostDir();
    const previous = await deadClaim(dir, { generation: 5 });
    const got = claimed(await claimHost(dir, request(), neverCalled));
    assert.deepEqual(got.previous, previous);
    assert.equal(got.claim.generation, 6);
    assert.deepEqual(readClaim(dir), got.claim);
    assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false);
    assert.deepEqual(leftovers(dir), []);
  });
});

describe('host.generation-monotonic', () => {
  it('a claim after a clean release continues the generation and gets a fresh handshake name', async () => {
    const dir = hostDir();
    const first = claimed(await claimHost(dir, request(), neverCalled)).claim;
    assert.equal(lastGeneration(dir), first.generation);
    createHandshake(dir, first);
    releaseHost(dir, first);
    const second = claimed(await claimHost(dir, request(), neverCalled)).claim;
    assert.ok(second.generation > first.generation, `${second.generation} > ${first.generation}`);
    assert.equal(lastGeneration(dir), second.generation);
    createHandshake(dir, second);
  });

  it('a takeover of a dead claim issues a generation strictly greater than the dead claim and every earlier one', async () => {
    const dir = hostDir();
    const first = claimed(await claimHost(dir, request(), neverCalled)).claim;
    releaseHost(dir, first);
    const dead = await deadClaim(dir, { generation: first.generation + 1 });
    const got = claimed(await claimHost(dir, request(), neverCalled));
    assert.deepEqual(got.previous, dead);
    assert.ok(got.claim.generation > dead.generation, `${got.claim.generation} > ${dead.generation}`);
    assert.equal(lastGeneration(dir), got.claim.generation);
  });
});

describe('host.live-owner-refused', () => {
  it('a live supervisor refuses with host-busy{owner}, exit 75, lock untouched', async () => {
    const dir = hostDir();
    const s = sleeper();
    try {
      const claim = claimRecord({ supervisor: s.identity, bootId: readBootId(), generation: 3 });
      holdHost(dir, claim, null);
      const before = lockBytes(dir);
      const outcome = await claimHost(dir, request(), neverCalled);
      assert.deepEqual(outcome, { kind: 'refused', rejection: { kind: 'host-busy', holder: 'owner', arc: ARC, generation: 3, pid: s.identity.pid } });
      assert.equal(exitCodeFor(outcome.kind === 'refused' ? outcome.rejection : assert.fail()), 75);
      assert.equal(lockBytes(dir), before);
      assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false);
    } finally {
      await s.kill();
    }
  });

  it('a dead supervisor with a live executor refuses with host-busy{owner} naming the executor', async () => {
    const dir = hostDir();
    const executor = sleeper();
    try {
      const claim = claimRecord({ supervisor: await deadIdentity(), bootId: readBootId() });
      holdHost(dir, claim, executor.identity);
      const before = lockBytes(dir);
      const outcome = await claimHost(dir, request(), neverCalled);
      assert.deepEqual(outcome, { kind: 'refused', rejection: { kind: 'host-busy', holder: 'owner', arc: ARC, generation: 1, pid: executor.identity.pid } });
      assert.equal(lockBytes(dir), before);
      assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false, 'the recovery lock is released on refusal');
    } finally {
      await executor.kill();
    }
  });
});

describe('host.dead-by-starttime', () => {
  it('a live pid whose start time differs from the claim is a dead claim and is taken over', async () => {
    const dir = hostDir();
    const s = sleeper();
    try {
      const reused = { pid: s.identity.pid, start: s.identity.start + 1 };
      const previous = claimRecord({ supervisor: reused, bootId: readBootId() });
      holdHost(dir, previous, reused);
      const got = claimed(await claimHost(dir, request(), neverCalled));
      assert.deepEqual(got.previous, previous);
    } finally {
      await s.kill();
    }
  });

  it('the same claim is refused while the pid and start match, and taken over once the process is killed', async () => {
    const dir = hostDir();
    const s = sleeper();
    const previous = claimRecord({ supervisor: s.identity, bootId: readBootId() });
    holdHost(dir, previous, null);
    assert.equal((await claimHost(dir, request(), neverCalled)).kind, 'refused');
    await s.kill();
    assert.deepEqual(claimed(await claimHost(dir, request(), neverCalled)).previous, previous);
  });
});

describe('host.dead-by-bootid', () => {
  it('a claim from another boot is dead even when its pid and start match a live process', async () => {
    const dir = hostDir();
    const previous = claimRecord({ supervisor: selfIdentity(), bootId: otherBoot() });
    holdHost(dir, previous, selfIdentity());
    const got = claimed(await claimHost(dir, request(), neverCalled));
    assert.deepEqual(got.previous, previous);
    assert.equal(got.claim.bootId, readBootId());
  });
});

describe('host.recovery-holder-dead', () => {
  function writeRecovery(dir: AbsPath, holder: ProcIdentity): RecoveryLockClaim {
    const claim: RecoveryLockClaim = { v: SCHEMA_VERSION, nonce: nonce('1'.repeat(32)), bootId: readBootId(), holder, at: isoTimeOf(new Date()) };
    atomicJson(hostPath(dir, RECOVERY_LOCK), claim);
    return claim;
  }

  it('a dead recovery holder refuses with recovery-holder-dead, exit 78, both locks untouched', async () => {
    const dir = hostDir();
    await deadClaim(dir);
    const holder = await deadIdentity();
    writeRecovery(dir, holder);
    const before = [lockBytes(dir), readFileSync(hostPath(dir, RECOVERY_LOCK), 'utf8')];
    const outcome = await claimHost(dir, request(), neverCalled);
    assert.deepEqual(outcome, { kind: 'refused', rejection: { kind: 'recovery-holder-dead', pid: holder.pid } });
    assert.equal(exitCodeFor(outcome.kind === 'refused' ? outcome.rejection : assert.fail()), 78);
    assert.deepEqual([lockBytes(dir), readFileSync(hostPath(dir, RECOVERY_LOCK), 'utf8')], before);
  });

  it('a live recovery holder refuses with host-busy{recovery}, exit 75', async () => {
    const dir = hostDir();
    const previous = await deadClaim(dir, { generation: 2 });
    const s = sleeper();
    try {
      writeRecovery(dir, s.identity);
      const outcome = await claimHost(dir, request(), neverCalled);
      assert.deepEqual(outcome, { kind: 'refused', rejection: { kind: 'host-busy', holder: 'recovery', arc: previous.arc, generation: 2, pid: s.identity.pid } });
      assert.equal(exitCodeFor(outcome.kind === 'refused' ? outcome.rejection : assert.fail()), 75);
    } finally {
      await s.kill();
    }
  });
});

describe('host.owner-mismatch-refused', () => {
  it('missing owner metadata refuses with owner-mismatch; the lock is untouched and the recovery lock released', async () => {
    const dir = hostDir();
    writeClaim(dir, claimRecord({ supervisor: await deadIdentity(), bootId: readBootId() }));
    const before = lockBytes(dir);
    const outcome = await claimHost(dir, request(), neverCalled);
    assert.equal(outcome.kind, 'refused');
    const rejection = outcome.kind === 'refused' ? outcome.rejection : assert.fail();
    assert.equal(rejection.kind, 'owner-mismatch');
    assert.match(rejection.kind === 'owner-mismatch' ? rejection.detail : '', /missing/);
    assert.equal(exitCodeFor(rejection), 78);
    assert.equal(lockBytes(dir), before);
    assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false);
  });

  it('an owner record of another claim (nonce or generation) refuses with owner-mismatch', async () => {
    for (const change of ['nonce', 'generation'] as const) {
      const dir = hostDir();
      const claim = claimRecord({ supervisor: await deadIdentity(), bootId: readBootId(), generation: 4 });
      writeClaim(dir, claim);
      publishOwner(dir, change === 'nonce' ? { nonce: nonce('2'.repeat(32)), generation: 4 } : { nonce: claim.nonce, generation: 3 }, null);
      const before = lockBytes(dir);
      const outcome = await claimHost(dir, request(), neverCalled);
      assert.equal(outcome.kind === 'refused' ? outcome.rejection.kind : outcome.kind, 'owner-mismatch', change);
      assert.equal(lockBytes(dir), before);
      assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false);
    }
  });
});

describe('host.cross-arc-live-runner', () => {
  const OLD = arcId('arc-old');
  const stranded = [invocationId(opId(OLD, 7), 1)];

  it('a previous arc with a live runner refuses with previous-arc-unreconciled; the lock is untouched', async () => {
    const dir = hostDir();
    const previous = await deadClaim(dir, { arc: OLD });
    const before = lockBytes(dir);
    const seen: HostLockClaim[] = [];
    const outcome = await claimHost(dir, request(arcId('arc-new')), async (claim) => {
      seen.push(claim);
      assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), true, 'reconciliation runs under the recovery lock');
      return { kind: 'unreconciled', invocations: stranded };
    });
    assert.deepEqual(seen, [previous]);
    assert.deepEqual(outcome, { kind: 'refused', rejection: { kind: 'previous-arc-unreconciled', arc: OLD, invocations: stranded } });
    assert.equal(exitCodeFor(outcome.kind === 'refused' ? outcome.rejection : assert.fail()), 78);
    assert.equal(lockBytes(dir), before);
    assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false);
  });

  it('a reconciled previous arc is taken over; the same arc is never reconciled by the hook', async () => {
    const dir = hostDir();
    const previous = await deadClaim(dir, { arc: OLD });
    assert.deepEqual(claimed(await claimHost(dir, request(arcId('arc-new')), reconciled)).previous, previous);
    const same = hostDir();
    await deadClaim(same);
    claimed(await claimHost(same, request(), neverCalled));
  });
});

/** Runs host-claim racers against `dir`; returns their outcomes once all have claimed or refused. */
async function race(dir: AbsPath, n: number, env: NodeJS.ProcessEnv = {}): Promise<{ outcomes: Record<string, ClaimOutcome | null>; pids: Exit[] }> {
  const work = tmpDir('race');
  const names = Array.from({ length: n }, (_, i) => `r${i}`);
  const running = names.map((name) => runFixture('host-claim.ts', [dir, ARC, work, name], { env: { PATH: process.env['PATH'], ...env }, timeoutMs: 60_000 }));
  await Promise.all(names.map((name) => until(join(work, `${name}.ready`))));
  writeFileSync(join(work, 'go'), '');
  // A racer killed at a crashPoint never writes its result: wait for each result or that racer's exit.
  const exited = names.map(() => false);
  running.forEach((p, i) => void p.then(() => (exited[i] = true), () => (exited[i] = true)));
  const results = await Promise.all(names.map(async (name, i) => {
    const file = join(work, `${name}.result.json`);
    await until(file, () => exited[i]!);
    return [name, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as ClaimOutcome : null] as const;
  }));
  writeFileSync(join(work, 'exit'), '');
  return { outcomes: Object.fromEntries(results), pids: await Promise.all(running) };
}

async function until(path: string, gaveUp: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!existsSync(path) && !gaveUp()) {
    if (Date.now() >= deadline) throw new Error(`${path} did not appear within ${WAIT_MS} ms`);
    await sleep(5);
  }
}

describe('host.racing-takeover', () => {
  it('4 processes race to take over a dead claim, 20 times: exactly one wins; the others see host-busy', async (t) => {
    const seen: Record<string, number> = {};
    for (let round = 0; round < 20; round++) {
      const dir = hostDir();
      const previous = await deadClaim(dir, { generation: 9 });
      const { outcomes, pids } = await race(dir, 4);
      for (const exit of pids) assert.equal(exit.code, 0, exit.stderr);
      const all = Object.values(outcomes);
      const winners = all.filter((o) => o?.kind === 'claimed') as Extract<ClaimOutcome, { kind: 'claimed' }>[];
      assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(outcomes)}`);
      const winner = winners[0]!;
      assert.equal(winner.previous?.nonce, previous.nonce);
      assert.equal(winner.claim.generation, 10);
      for (const o of all) {
        if (o?.kind !== 'refused') continue;
        const r = o.rejection;
        const tag = r.kind === 'host-busy' ? `host-busy{${r.holder}}` : r.kind;
        seen[tag] = (seen[tag] ?? 0) + 1;
        assert.equal(r.kind, 'host-busy', `round ${round}: ${JSON.stringify(o)}`);
        if (r.kind === 'host-busy' && r.holder === 'owner') {
          assert.equal(r.pid, winner.claim.supervisor.pid, 'a loser that found the new claim names the winner');
          assert.equal(r.generation, 10);
        }
      }
      assert.deepEqual(readClaim(dir), winner.claim);
      assert.equal(existsSync(hostPath(dir, RECOVERY_LOCK)), false);
      assert.deepEqual(leftovers(dir), []);
    }
    t.diagnostic(`loser outcomes over 20 rounds: ${JSON.stringify(seen)}`);
  });
});

describe('crash matrix: host takeover', () => {
  for (const cell of crashCells(HOST_TAKEOVER)) {
    it(`${cell.boundary} ${cell.label}: ${cell.recovery}`, async () => {
      const dir = hostDir();
      const previous = await deadClaim(dir);
      const trigger = writeTrigger(tmpDir('trigger'), { label: cell.label, occurrence: 1 });
      const { outcomes, pids } = await race(dir, 1, { ROADMAP_TEST_CRASH: trigger });
      assert.equal(pids[0]!.signal, 'SIGKILL', pids[0]!.stderr);
      assert.equal(outcomes['r0'], null);
      assertFired(trigger);
      const lock = readClaim(dir);
      assert.ok(lock !== null);
      if (cell.label === 'host.takeover.after-recovery-claim') assert.deepEqual(lock, previous);
      else assert.equal(lock.generation, previous.generation + 1, 'the crashed takeover renamed its claim in');
      const outcome = await claimHost(dir, request(), neverCalled);
      assert.equal(outcome.kind, 'refused');
      const rejection = outcome.kind === 'refused' ? outcome.rejection : assert.fail();
      assert.equal(rejection.kind, 'recovery-holder-dead');
      assert.equal(exitCodeFor(rejection), 78);
      assert.deepEqual(readClaim(dir), lock, 'the refused start changed nothing');
    });
  }
});

describe('owner record and handshake', () => {
  it('verifyOwner verifies only an exact nonce, generation, pid and start', async () => {
    const dir = hostDir();
    const claim = { nonce: nonce('3'.repeat(32)), generation: 2 };
    const self = selfIdentity();
    assert.equal(verifyOwner(dir, claim, self).kind, 'mismatch', 'no record');
    publishOwner(dir, claim, null);
    assert.equal(verifyOwner(dir, claim, self).kind, 'mismatch', 'no executor yet');
    publishOwner(dir, claim, self);
    assert.equal(verifyOwner(dir, claim, self).kind, 'verified');
    assert.equal(verifyOwner(dir, { ...claim, generation: 3 }, self).kind, 'mismatch');
    assert.equal(verifyOwner(dir, { ...claim, nonce: nonce('4'.repeat(32)) }, self).kind, 'mismatch');
    assert.equal(verifyOwner(dir, claim, { ...self, start: self.start + 1 }).kind, 'mismatch');
    assert.equal(verifyOwner(dir, claim, { pid: self.pid + 1, start: self.start }).kind, 'mismatch');
  });

  it('the executor blocks until the handshake, then verifies the owner record names it', async () => {
    const dir = hostDir();
    const claim = { nonce: nonce('5'.repeat(32)), generation: 1 };
    const self = selfIdentity();
    const waiting = awaitHandshake(dir, claim, self, WAIT_MS);
    await sleep(150);
    publishOwner(dir, claim, self);
    createHandshake(dir, claim);
    assert.deepEqual((await waiting).executor, self);
    assert.throws(() => createHandshake(dir, claim), AlreadyExistsError, 'the handshake is write-once');
  });

  it('a handshake whose owner record names another executor is refused; no handshake times out', async () => {
    const dir = hostDir();
    const claim = { nonce: nonce('6'.repeat(32)), generation: 1 };
    const self = selfIdentity();
    await assert.rejects(awaitHandshake(dir, claim, self, 200), HandshakeTimeoutError);
    const other = sleeper();
    try {
      publishOwner(dir, claim, other.identity);
      createHandshake(dir, claim);
      await assert.rejects(awaitHandshake(dir, claim, self, WAIT_MS), /host\.owner\.json names/);
    } finally {
      await other.kill();
    }
  });
});
