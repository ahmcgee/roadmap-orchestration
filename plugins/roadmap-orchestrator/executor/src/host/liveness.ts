// Process liveness by identity: a pid alone is reused, so a process is `(pid, start)` on one boot.
//
// MERGE NOTE: step 3a owns process identity in src/contain/proc.ts. This is a minimal stand-in so the
// host lock could land in parallel; fold `procStart` onto proc.ts at merge and delete this file's copy.
import { readFileSync } from 'node:fs';
import type { ProcIdentity } from '../core/records.ts';
import { type BootId, bootId } from '../core/values.ts';

/** Start time (clock ticks since boot, /proc/<pid>/stat field 22), or null when no such process exists. */
export function procStart(pid: number): number | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Fields after the parenthesised comm, which may itself contain spaces or parentheses.
  const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
  if (!Number.isSafeInteger(start)) throw new Error(`/proc/${pid}/stat: unparsable start time in ${JSON.stringify(stat)}`);
  return start;
}

export function currentBootId(): BootId {
  return bootId(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), '/proc/sys/kernel/random/boot_id');
}

export function selfIdentity(): ProcIdentity {
  const start = procStart(process.pid);
  if (start === null) throw new Error(`/proc/${process.pid}/stat is missing for this very process`);
  return { pid: process.pid, start };
}

/** Alive only on the same boot, with the pid present and its start time unchanged (a reused pid is dead). */
export function isAlive(proc: ProcIdentity, recordedBoot: BootId): boolean {
  return recordedBoot === currentBootId() && procStart(proc.pid) === proc.start;
}
