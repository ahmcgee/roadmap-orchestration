// The /proc view containment is built on: process identity is (pid, start), where `start` is field 22 of
// /proc/<pid>/stat (clock ticks since boot), so a reused pid is never mistaken for the process we meant.
// Only processes owned by this uid are scanned: the executor, its runners and every workload run as one
// uid in the devcontainer, and another uid's environ is unreadable anyway.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { ProcIdentity } from '../core/records.ts';
import { type BootId, bootId } from '../core/values.ts';

export type ProcStat = Readonly<{ pid: number; state: string; ppid: number; sid: number; start: number }>;

/**
 * `env` is null for a non-dumpable process (one that ran a setuid binary or called prctl(PR_SET_DUMPABLE, 0)):
 * the kernel refuses its environ even to its own uid. Such a process can be matched by session only.
 */
export type ProcInfo = ProcStat & Readonly<{ env: ReadonlyMap<string, string> | null }>;

/** A process that vanished between listing and reading raises ENOENT or ESRCH: it is simply gone. */
function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ESRCH';
}

export function readBootId(): BootId {
  return bootId(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
}

/** Parses /proc/<pid>/stat. `comm` (field 2) may hold spaces and parens, so fields are split after the last `)`. */
export function parseStat(pid: number, text: string): ProcStat {
  const close = text.lastIndexOf(')');
  const rest = text.slice(close + 2).split(' ');
  // rest[0] is field 3 (state): field n is rest[n - 3].
  const field = (n: number): string => {
    const value = rest[n - 3];
    if (value === undefined) throw new Error(`/proc/${pid}/stat: field ${n} missing in ${JSON.stringify(text)}`);
    return value;
  };
  return { pid, state: field(3), ppid: Number(field(4)), sid: Number(field(6)), start: Number(field(22)) };
}

/** The stat of a live pid, or null when it is gone. */
export function statOf(pid: number): ProcStat | null {
  try {
    return parseStat(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if (vanished(error)) return null;
    throw error;
  }
}

export function identityOf(pid: number): ProcIdentity & Readonly<{ sid: number }> {
  const stat = statOf(pid);
  if (stat === null) throw new Error(`process ${pid} is gone before its identity could be read`);
  return { pid, start: stat.start, sid: stat.sid };
}

/** Alive = the pid exists with the same start time and is not a zombie (a zombie has ended; only its entry remains). */
export function isAlive(id: ProcIdentity): boolean {
  const stat = statOf(id.pid);
  return stat !== null && stat.start === id.start && stat.state !== 'Z';
}

export function parseEnviron(bytes: Buffer): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of bytes.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return env;
}

function readEnviron(pid: number): Map<string, string> | null {
  try {
    return parseEnviron(readFileSync(`/proc/${pid}/environ`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') return null;
    throw error;
  }
}

/** Every live (non-zombie) process of this uid with its exec-time environment. */
export function scan(): readonly ProcInfo[] {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('process.getuid is unavailable: containment needs Linux');
  const out: ProcInfo[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    try {
      if (statSync(`/proc/${pid}`).uid !== uid) continue;
      const stat = parseStat(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (stat.state === 'Z') continue;
      out.push({ ...stat, env: readEnviron(pid) });
    } catch (error) {
      if (vanished(error)) continue;
      throw error;
    }
  }
  return out;
}

/**
 * Signal a process only if it is still the one we identified. The pid could in principle be reused between
 * the check and the kill; with start times read milliseconds earlier that window is accepted.
 */
export function signal(id: ProcIdentity, sig: NodeJS.Signals): void {
  if (id.pid === process.pid) throw new Error(`refusing to signal self (${sig})`);
  const stat = statOf(id.pid);
  if (stat === null || stat.start !== id.start) return;
  try {
    process.kill(id.pid, sig);
  } catch (error) {
    if (vanished(error)) return;
    throw error;
  }
}
