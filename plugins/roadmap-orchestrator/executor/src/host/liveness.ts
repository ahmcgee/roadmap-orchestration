// Host-level liveness: a claim records its process identity and the boot it was made on, and a process of
// another boot is dead whatever /proc says now. Reading an identity is src/contain/proc.ts's job alone.
import { identityOf, isAlive as isRunning, readBootId } from '../contain/proc.ts';
import type { ProcIdentity } from '../core/records.ts';
import type { BootId } from '../core/values.ts';

/** This process as a host record names it: `(pid, start)`, without the session id. */
export function selfIdentity(): ProcIdentity {
  const { pid, start } = identityOf(process.pid);
  return { pid, start };
}

/** Alive only on the same boot, with the pid present, not a zombie, and its start time unchanged. */
export function isAlive(proc: ProcIdentity, recordedBoot: BootId): boolean {
  return recordedBoot === readBootId() && isRunning(proc);
}
