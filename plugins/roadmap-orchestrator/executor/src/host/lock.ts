// The host lock (plan "Host lock and ownership", R17-R18): at most one supervisor, hence one executor, per
// host.
//
// Every claim is serialised by a second lock, `host.recovery.lock`, claimed by `link` from a durable temp
// file (atomic, never replaces: EEXIST means someone holds it). A held host.lock whose supervisor is alive
// refuses with `host-busy` (exit 75) before that. Then, under the recovery lock:
//
//   fresh      host.lock absent → issue the next generation → `link` our claim → owner record{executor: null}
//   takeover   host.lock names a dead supervisor → per host.owner.json, executor dead → previous arc
//              reconciled if it differs from ours → issue → `rename` our claim over it → owner record
//   renew      the live supervisor's own claim → issue → `rename` → owner record (a new claim per executor)
//
// and unlink the recovery lock. Generations are monotonic per host directory: `host.generation` holds the
// last one issued and is written durably before any claim carrying it is published, so a claim after a
// clean release continues from it and a `handshake.<generation>` file is never reused.
//
// A dead recovery holder is never broken automatically: a takeover died midway, and a user decides
// (`recovery-holder-dead`, exit 78). Refusals are returned as StartupRejections, never thrown.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { readBootId } from '../contain/proc.ts';
import { crashPoint } from '../core/crash.ts';
import {
  AlreadyExistsError, canonicalJson, durableLink, durableRename, durableUnlink, durableWrite, exclusiveCreate, readJson,
} from '../core/fsx.ts';
import type { ArcId, InvocationId } from '../core/ids.ts';
import { type HostLockClaim, type ProcIdentity, type RecoveryLockClaim, hostLockClaim, recoveryLockClaim } from '../core/records.ts';
import { type AbsPath, type Nonce, isoTimeOf, nonce } from '../core/values.ts';
import { SchemaError } from '../core/validate.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { HOST_GENERATION, HOST_LOCK, RECOVERY_LOCK, hostPath } from './hostdir.ts';
import { isAlive } from './liveness.ts';
import { publishOwner, readOwner } from './owner.ts';

export type ClaimRequest = Readonly<{ arc: ArcId; runDir: AbsPath; repo: AbsPath; supervisor: ProcIdentity }>;

/** What reconciling a dead claim's run dir of another arc found (R18; `reconcilePreviousArc` in recover.ts). */
export type PreviousArcVerdict =
  | Readonly<{ kind: 'reconciled' }>
  | Readonly<{ kind: 'unreconciled'; invocations: readonly InvocationId[] }>;
export type ReconcilePrevious = (previous: HostLockClaim) => Promise<PreviousArcVerdict>;

export type HostRefusal = Extract<StartupRejection, { kind: 'host-busy' | 'recovery-holder-dead' | 'owner-mismatch' | 'previous-arc-unreconciled' }>;

export type ClaimOutcome =
  /** `previous` is the dead claim taken over, or null for a claim of a free host. */
  | Readonly<{ kind: 'claimed'; claim: HostLockClaim; previous: HostLockClaim | null }>
  | Readonly<{ kind: 'refused'; rejection: HostRefusal }>;

export class HostLockMismatchError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not this claim's: ${detail}`);
    this.name = 'HostLockMismatchError';
  }
}

function newNonce(): Nonce {
  return nonce(randomBytes(16).toString('hex'));
}

/** The current claim, or null when the host is free. */
export function readClaim(dir: AbsPath): HostLockClaim | null {
  const path = hostPath(dir, HOST_LOCK);
  return existsSync(path) ? hostLockClaim(readJson(path), HOST_LOCK) : null;
}

export function readRecoveryClaim(dir: AbsPath): RecoveryLockClaim | null {
  const path = hostPath(dir, RECOVERY_LOCK);
  return existsSync(path) ? recoveryLockClaim(readJson(path), RECOVERY_LOCK) : null;
}

/** The last generation issued on this host, 0 before the first claim ever. */
export function lastGeneration(dir: AbsPath): number {
  const path = hostPath(dir, HOST_GENERATION);
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, 'utf8');
  if (!/^[1-9][0-9]*\n$/.test(text)) throw new SchemaError(HOST_GENERATION, 'a positive integer and a newline', text);
  return Number(text);
}

function issueGeneration(dir: AbsPath, generation: number): void {
  durableWrite(hostPath(dir, HOST_GENERATION), `${generation}\n`);
}

/** Durable temp file → `link` to `name`. False when `name` already exists. The temp never survives. */
function linkClaim(dir: AbsPath, name: string, id: Nonce, record: unknown): boolean {
  const temp = hostPath(dir, `${name}.${id}.tmp`);
  exclusiveCreate(temp, canonicalJson(record));
  try {
    durableLink(temp, hostPath(dir, name));
    return true;
  } catch (error) {
    if (error instanceof AlreadyExistsError) return false;
    throw error;
  } finally {
    durableUnlink(temp);
  }
}

function releaseRecovery(dir: AbsPath, id: Nonce): void {
  const held = readRecoveryClaim(dir);
  if (held === null || held.nonce !== id) {
    throw new HostLockMismatchError(RECOVERY_LOCK, held === null ? 'it is gone' : `it carries nonce ${held.nonce}, not ours (${id})`);
  }
  durableUnlink(hostPath(dir, RECOVERY_LOCK));
}

/** How long a claim waits for another live claimer's short critical section before failing loudly. */
const RECOVERY_WAIT_MS = 30_000;
const RECOVERY_POLL_MS = 10;

/**
 * Claims the host for `request`, taking over a dead claim if needed. Every claim, fresh or takeover, runs
 * under `host.recovery.lock` (the uniform claim path, lead ruling 14a), so issuing the generation, publishing
 * the claim and publishing its owner record (`executor: null`) are one critical section: a crash inside it
 * leaves a dead recovery holder (`recovery-holder-dead`), never a claim without its owner record.
 * `reconcilePrevious` runs only for a dead claim of another arc, inside the same section.
 */
export async function claimHost(dir: AbsPath, request: ClaimRequest, reconcilePrevious: ReconcilePrevious): Promise<ClaimOutcome> {
  const id = newNonce();
  const boot = readBootId();
  const claimOf = (generation: number): HostLockClaim => ({
    v: SCHEMA_VERSION, nonce: id, generation, bootId: boot, supervisor: request.supervisor,
    arc: request.arc, runDir: request.runDir, repo: request.repo,
  });
  const recovery: RecoveryLockClaim = { v: SCHEMA_VERSION, nonce: id, bootId: boot, holder: request.supervisor, at: isoTimeOf(new Date()) };

  // Each pass either claims, refuses, or observed the lock change hands under it (a claim or release
  // between our read and the recovery lock, or another takeover finishing while we waited) and looks again.
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  for (;;) {
    const previous = readClaim(dir);
    if (previous !== null && isAlive(previous.supervisor, previous.bootId)) return busyOwner(previous, previous.supervisor);

    if (!linkClaim(dir, RECOVERY_LOCK, id, recovery)) {
      const holder = readRecoveryClaim(dir);
      if (holder === null) continue;
      if (!isAlive(holder.holder, holder.bootId)) return { kind: 'refused', rejection: { kind: 'recovery-holder-dead', pid: holder.holder.pid } };
      const now = readClaim(dir);
      if (now !== null) {
        return { kind: 'refused', rejection: { kind: 'host-busy', holder: 'recovery', arc: now.arc, generation: now.generation, pid: holder.holder.pid } };
      }
      // The host is free and another start is inside its fresh claim, which takes milliseconds.
      if (Date.now() >= deadline) throw new Error(`${RECOVERY_LOCK} stayed held by live pid ${holder.holder.pid} over a free host for ${RECOVERY_WAIT_MS} ms`);
      await sleep(RECOVERY_POLL_MS);
      continue;
    }
    if (previous !== null) crashPoint('host.takeover.after-recovery-claim');

    const outcome = previous === null ? fresh(dir, claimOf) : await takeover(dir, previous, claimOf, request, reconcilePrevious);
    if (outcome !== 'changed' && outcome.kind === 'claimed' && previous !== null) crashPoint('host.takeover.after-rename');
    releaseRecovery(dir, id);
    if (outcome !== 'changed') return outcome;
  }
}

function busyOwner(claim: HostLockClaim, live: ProcIdentity): ClaimOutcome {
  return { kind: 'refused', rejection: { kind: 'host-busy', holder: 'owner', arc: claim.arc, generation: claim.generation, pid: live.pid } };
}

/** Runs under the recovery lock. 'changed': the host was claimed after we saw it free. */
function fresh(dir: AbsPath, claimOf: (generation: number) => HostLockClaim): ClaimOutcome | 'changed' {
  if (readClaim(dir) !== null) return 'changed';
  const claim = claimOf(lastGeneration(dir) + 1);
  issueGeneration(dir, claim.generation);
  // Every claimer holds the recovery lock to link, so nobody can have linked since the read above.
  if (!linkClaim(dir, HOST_LOCK, claim.nonce, claim)) throw new Error(`${HOST_LOCK} appeared while ${RECOVERY_LOCK} was held by nonce ${claim.nonce}`);
  publishOwner(dir, claim, null);
  return { kind: 'claimed', claim, previous: null };
}

/** Runs under the recovery lock. 'changed': host.lock is no longer `previous`, so the caller looks again. */
async function takeover(
  dir: AbsPath, previous: HostLockClaim, claimOf: (generation: number) => HostLockClaim, request: ClaimRequest,
  reconcilePrevious: ReconcilePrevious,
): Promise<ClaimOutcome | 'changed'> {
  const current = readClaim(dir);
  if (current === null || current.nonce !== previous.nonce) return 'changed';

  const owner = readOwner(dir);
  if (owner === null) {
    return { kind: 'refused', rejection: { kind: 'owner-mismatch', detail: `host.owner.json is missing for the dead claim of arc ${previous.arc}, generation ${previous.generation}` } };
  }
  if (owner.nonce !== previous.nonce || owner.generation !== previous.generation) {
    return {
      kind: 'refused',
      rejection: { kind: 'owner-mismatch', detail: `host.owner.json names nonce ${owner.nonce} generation ${owner.generation}; the dead claim is nonce ${previous.nonce} generation ${previous.generation}` },
    };
  }
  // The executor runs on the claim's boot; `executor: null` means the supervisor died before spawning one.
  if (owner.executor !== null && isAlive(owner.executor, previous.bootId)) return busyOwner(previous, owner.executor);

  if (previous.arc !== request.arc) {
    const verdict = await reconcilePrevious(previous);
    if (verdict.kind === 'unreconciled') {
      return { kind: 'refused', rejection: { kind: 'previous-arc-unreconciled', arc: previous.arc, invocations: verdict.invocations } };
    }
  }

  // Strictly past the dead claim and past anything issued since (a takeover that died after issuing).
  const next = claimOf(Math.max(previous.generation, lastGeneration(dir)) + 1);
  replaceClaim(dir, next);
  return { kind: 'claimed', claim: next, previous };
}

/** Issues `next`'s generation, renames it over host.lock and publishes its owner record with no executor yet. */
function replaceClaim(dir: AbsPath, next: HostLockClaim): void {
  issueGeneration(dir, next.generation);
  const temp = hostPath(dir, `${HOST_LOCK}.${next.nonce}.tmp`);
  exclusiveCreate(temp, canonicalJson(next));
  durableRename(temp, hostPath(dir, HOST_LOCK));
  publishOwner(dir, next, null);
}

/**
 * A live supervisor's next claim, for the next executor it spawns after one exited: same supervisor, arc
 * and run dir, a new nonce and the next generation, so the new executor gets its own write-once
 * `handshake.<generation>`. Under the recovery lock like every claim; the claim held must be `held`.
 */
export async function renewClaim(dir: AbsPath, held: HostLockClaim): Promise<HostLockClaim> {
  const id = newNonce();
  const recovery: RecoveryLockClaim = { v: SCHEMA_VERSION, nonce: id, bootId: held.bootId, holder: held.supervisor, at: isoTimeOf(new Date()) };
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  while (!linkClaim(dir, RECOVERY_LOCK, id, recovery)) {
    // Only a start that saw the host free before our claim can hold it now, briefly (it then sees our claim).
    const holder = readRecoveryClaim(dir);
    if (holder !== null && !isAlive(holder.holder, holder.bootId)) throw new Error(`cannot renew claim ${held.nonce}: ${RECOVERY_LOCK} is held by dead pid ${holder.holder.pid}`);
    if (Date.now() >= deadline) throw new Error(`cannot renew claim ${held.nonce}: ${RECOVERY_LOCK} stayed held for ${RECOVERY_WAIT_MS} ms`);
    await sleep(RECOVERY_POLL_MS);
  }
  const current = readClaim(dir);
  if (current === null || current.nonce !== held.nonce) {
    throw new HostLockMismatchError(HOST_LOCK, current === null ? 'the host is not claimed' : `it carries nonce ${current.nonce}, not ours (${held.nonce})`);
  }
  const next: HostLockClaim = { ...held, nonce: id, generation: Math.max(held.generation, lastGeneration(dir)) + 1 };
  replaceClaim(dir, next);
  releaseRecovery(dir, id);
  return next;
}

/** Nonce-checked release. The handshake stays: generations never repeat, so no later claim needs its name. */
export function releaseHost(dir: AbsPath, claim: HostLockClaim): void {
  const held = readClaim(dir);
  if (held === null) throw new HostLockMismatchError(HOST_LOCK, 'the host is not claimed');
  if (held.nonce !== claim.nonce) throw new HostLockMismatchError(HOST_LOCK, `it carries nonce ${held.nonce}, not ours (${claim.nonce})`);
  durableUnlink(hostPath(dir, HOST_LOCK));
}
