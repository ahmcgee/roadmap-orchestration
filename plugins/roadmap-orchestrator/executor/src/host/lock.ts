// The host lock (plan "Host lock and ownership", R17-R18): at most one supervisor, hence one executor, per
// host.
//
// Claim: write the claim record to a temp file durably, `link` it to `host.lock` (atomic, never replaces:
// EEXIST means someone holds it), unlink the temp. A held lock whose supervisor is alive refuses with
// `host-busy` (exit 75). A dead one is taken over, and every takeover is serialised by a second lock,
// `host.recovery.lock`, claimed the same way:
//
//   claim recovery lock → re-read host.lock → supervisor dead (checked above) and, per host.owner.json,
//   executor dead → previous arc reconciled if it differs from ours → `rename` our claim over host.lock →
//   unlink the recovery lock.
//
// A dead recovery holder is never broken automatically: a takeover died midway, and a user decides
// (`recovery-holder-dead`, exit 78). Refusals are returned as StartupRejections, never thrown.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { crashPoint } from '../core/crash.ts';
import { AlreadyExistsError, canonicalJson, durableLink, durableRename, durableUnlink, exclusiveCreate, readJson } from '../core/fsx.ts';
import type { ArcId, InvocationId } from '../core/ids.ts';
import { type HostLockClaim, type ProcIdentity, type RecoveryLockClaim, hostLockClaim, recoveryLockClaim } from '../core/records.ts';
import { type AbsPath, type Nonce, isoTimeOf, nonce } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import { HOST_LOCK, RECOVERY_LOCK, handshakePath, hostPath } from './hostdir.ts';
import { currentBootId, isAlive } from './liveness.ts';
import { readOwner } from './owner.ts';

export type ClaimRequest = Readonly<{ arc: ArcId; runDir: AbsPath; repo: AbsPath; supervisor: ProcIdentity }>;

/** What the caller's reconciliation of a previous claim's run dir found (R18; the engine is step 14b). */
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
    super(`refusing to release ${file}: ${detail}`);
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

/**
 * Claims the host for `request`, taking over a dead claim if needed. `reconcilePrevious` runs only for a
 * dead claim of another arc, while the recovery lock is held.
 */
export async function claimHost(dir: AbsPath, request: ClaimRequest, reconcilePrevious: ReconcilePrevious): Promise<ClaimOutcome> {
  const id = newNonce();
  const boot = currentBootId();
  const claimOf = (generation: number): HostLockClaim => ({
    v: SCHEMA_VERSION, nonce: id, generation, bootId: boot, supervisor: request.supervisor,
    arc: request.arc, runDir: request.runDir, repo: request.repo,
  });

  // Each pass either claims, refuses, or observed the lock change hands under it (a release between our
  // link and read, or another takeover finishing while we waited on the recovery lock) and looks again.
  for (;;) {
    if (linkClaim(dir, HOST_LOCK, id, claimOf(1))) return { kind: 'claimed', claim: claimOf(1), previous: null };
    const previous = readClaim(dir);
    if (previous === null) continue;
    if (isAlive(previous.supervisor, previous.bootId)) {
      return { kind: 'refused', rejection: { kind: 'host-busy', holder: 'owner', arc: previous.arc, generation: previous.generation, pid: previous.supervisor.pid } };
    }

    const recovery: RecoveryLockClaim = { v: SCHEMA_VERSION, nonce: id, bootId: boot, holder: request.supervisor, at: isoTimeOf(new Date()) };
    if (!linkClaim(dir, RECOVERY_LOCK, id, recovery)) {
      const holder = readRecoveryClaim(dir);
      if (holder === null) continue;
      if (isAlive(holder.holder, holder.bootId)) {
        return { kind: 'refused', rejection: { kind: 'host-busy', holder: 'recovery', arc: previous.arc, generation: previous.generation, pid: holder.holder.pid } };
      }
      return { kind: 'refused', rejection: { kind: 'recovery-holder-dead', pid: holder.holder.pid } };
    }
    crashPoint('host.takeover.after-recovery-claim');

    const outcome = await takeover(dir, previous, claimOf(previous.generation + 1), request, reconcilePrevious);
    if (outcome === 'changed') {
      releaseRecovery(dir, id);
      continue;
    }
    if (outcome.kind === 'claimed') crashPoint('host.takeover.after-rename');
    releaseRecovery(dir, id);
    return outcome;
  }
}

/** Runs under the recovery lock. 'changed': host.lock is no longer `previous`, so the caller looks again. */
async function takeover(
  dir: AbsPath, previous: HostLockClaim, next: HostLockClaim, request: ClaimRequest, reconcilePrevious: ReconcilePrevious,
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
  if (owner.executor !== null && isAlive(owner.executor, previous.bootId)) {
    return { kind: 'refused', rejection: { kind: 'host-busy', holder: 'owner', arc: previous.arc, generation: previous.generation, pid: owner.executor.pid } };
  }

  if (previous.arc !== request.arc) {
    const verdict = await reconcilePrevious(previous);
    if (verdict.kind === 'unreconciled') {
      return { kind: 'refused', rejection: { kind: 'previous-arc-unreconciled', arc: previous.arc, invocations: verdict.invocations } };
    }
  }

  const temp = hostPath(dir, `${HOST_LOCK}.${next.nonce}.tmp`);
  exclusiveCreate(temp, canonicalJson(next));
  durableRename(temp, hostPath(dir, HOST_LOCK));
  return { kind: 'claimed', claim: next, previous };
}

/**
 * Nonce-checked release. The claim's handshake file goes with it: after a release the next claim starts
 * again at generation 1 and must be able to create its own `handshake.1`.
 */
export function releaseHost(dir: AbsPath, claim: HostLockClaim): void {
  const held = readClaim(dir);
  if (held === null) throw new HostLockMismatchError(HOST_LOCK, 'the host is not claimed');
  if (held.nonce !== claim.nonce) throw new HostLockMismatchError(HOST_LOCK, `it carries nonce ${held.nonce}, not ours (${claim.nonce})`);
  const handshake = handshakePath(dir, claim.generation);
  if (existsSync(handshake)) durableUnlink(handshake);
  durableUnlink(hostPath(dir, HOST_LOCK));
}
