// The owner record and the start handshake (plan "Host lock and ownership", R17).
//
// The supervisor claims the host lock, spawns the executor, publishes `host.owner.json` naming that
// executor, and only then writes `handshake.<generation>`. The executor blocks on the handshake, re-reads
// the owner record and performs no effect unless it names exactly itself under the claim it was started
// for. So a second executor (a double spawn, a crash between spawn and publish) can never act: the record
// names only one (pid, start). The supervisor (src/supervisor.ts) and the executor (src/executor.ts) use these.
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, canonicalJson, exclusivePublish, readJson } from '../core/fsx.ts';
import { type HandshakeFile, type HostOwner, type ProcIdentity, handshakeFile, hostOwner } from '../core/records.ts';
import type { AbsPath, Nonce } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { HOST_OWNER, handshakePath, hostPath } from './hostdir.ts';

/** The claim an owner record and a handshake belong to. */
export type ClaimRef = Readonly<{ nonce: Nonce; generation: number }>;

/** Atomic replace: `executor: null` before the spawn, then the spawned executor's identity. */
export function publishOwner(dir: AbsPath, claim: ClaimRef, executor: ProcIdentity | null): HostOwner {
  const owner: HostOwner = { v: SCHEMA_VERSION, nonce: claim.nonce, generation: claim.generation, executor };
  atomicJson(hostPath(dir, HOST_OWNER), owner);
  return owner;
}

/** The owner record, or null when none was ever published. Invalid content throws. */
export function readOwner(dir: AbsPath): HostOwner | null {
  const path = hostPath(dir, HOST_OWNER);
  return existsSync(path) ? hostOwner(readJson(path), HOST_OWNER) : null;
}

export type OwnerCheck = Readonly<{ kind: 'verified'; owner: HostOwner }> | Readonly<{ kind: 'mismatch'; detail: string }>;

/** Verified only when the record's nonce, generation, pid and start all equal the caller's. */
export function verifyOwner(dir: AbsPath, claim: ClaimRef, self: ProcIdentity): OwnerCheck {
  const owner = readOwner(dir);
  if (owner === null) return { kind: 'mismatch', detail: `${HOST_OWNER} is missing` };
  const expected = { nonce: claim.nonce, generation: claim.generation, executor: self };
  const actual = { nonce: owner.nonce, generation: owner.generation, executor: owner.executor };
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    return { kind: 'mismatch', detail: `${HOST_OWNER} names ${canonicalJson(actual).trim()}, expected ${canonicalJson(expected).trim()}` };
  }
  return { kind: 'verified', owner };
}

/**
 * Supervisor side: write-once, after the owner record naming the executor is durable. Published whole (by link): the
 * executor polls for the file and reads it as soon as it exists, so an empty or partial one would crash it.
 */
export function createHandshake(dir: AbsPath, claim: ClaimRef): void {
  const file: HandshakeFile = { v: SCHEMA_VERSION, nonce: claim.nonce, generation: claim.generation };
  exclusivePublish(handshakePath(dir, claim.generation), canonicalJson(file));
}

export class HandshakeTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`${path} did not appear within ${timeoutMs} ms; the supervisor never completed the handshake`);
    this.name = 'HandshakeTimeoutError';
  }
}

export class HandshakeMismatchError extends Error {
  constructor(path: string, found: HandshakeFile, claim: ClaimRef) {
    super(`${path} carries nonce ${found.nonce}, not this executor's claim nonce ${claim.nonce}`);
    this.name = 'HandshakeMismatchError';
  }
}

export class HandshakeAbandonedError extends Error {
  constructor(path: string) {
    super(`the supervisor that spawned this executor died before writing ${path}`);
    this.name = 'HandshakeAbandonedError';
  }
}

export class OwnerMismatchError extends Error {
  constructor(path: string, detail: string) {
    super(`handshake ${path} arrived but ${detail}`);
    this.name = 'OwnerMismatchError';
  }
}

const HANDSHAKE_POLL_MS = 50;

/**
 * Executor side: waits for `handshake.<generation>` of its claim, then verifies the owner record names
 * itself. Throws on timeout, when `supervisorAlive` turns false first (the handshake can then never come:
 * generations are never reissued), on a handshake of another claim, or on an owner mismatch; the executor
 * then exits without having performed any effect.
 */
export async function awaitHandshake(dir: AbsPath, claim: ClaimRef, self: ProcIdentity, timeoutMs: number, supervisorAlive: () => boolean): Promise<HostOwner> {
  const path = handshakePath(dir, claim.generation);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (!supervisorAlive()) throw new HandshakeAbandonedError(path);
    if (Date.now() >= deadline) throw new HandshakeTimeoutError(path, timeoutMs);
    await sleep(HANDSHAKE_POLL_MS);
  }
  const found = handshakeFile(readJson(path), `handshake.${claim.generation}`);
  if (found.nonce !== claim.nonce || found.generation !== claim.generation) throw new HandshakeMismatchError(path, found, claim);
  const check = verifyOwner(dir, claim, self);
  if (check.kind === 'mismatch') throw new OwnerMismatchError(path, check.detail);
  return check.owner;
}
