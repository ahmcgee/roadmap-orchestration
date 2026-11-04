// Linux seat affinity: reservation numbers are one-based CPU ids, never remapped to the allowed mask.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type { Parent, SpawnSubject } from '../core/events.ts';
import { parseResourceUnit } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { sameHolder } from '../core/state.ts';
import { resolveArgv0 } from '../preflight/argv0.ts';

export function tasksetPath(env: Readonly<Record<string, string | undefined>>): string | null {
  const resolved = resolveArgv0({ argv: ['taskset'], env: { set: {}, pass: ['PATH'] } }, env);
  return resolved.kind === 'program' ? resolved.realpath : null;
}

/** Read the calling thread's actual affinity, including any container or inherited taskset restriction. */
export function allowedCores(): readonly number[] {
  const list = /^Cpus_allowed_list:\s*([\d,-]+)$/m.exec(readFileSync('/proc/thread-self/status', 'utf8'))?.[1];
  if (list === undefined) throw new Error('cannot read Cpus_allowed_list from /proc/thread-self/status');
  return list.split(',').flatMap((part) => {
    const [lo, hi = lo] = part.split('-').map(Number);
    if (lo === undefined || hi === undefined || hi < lo) throw new Error(`invalid CPU affinity range ${part}`);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });
}

export function validatePinnedCores(cores: readonly number[]): void {
  const count = availableParallelism();
  const allowed = allowedCores();
  for (const core of cores) {
    if (!Number.isSafeInteger(core) || core < 0 || core >= count || !allowed.includes(core)) {
      throw new Error(`reserved @cpu#${core + 1} maps to core ${core}, outside availableParallelism ${count} or current affinity mask ${allowed.join(',')}`);
    }
  }
}

/** Only agent seats are pinned. Commands, backend smokes and seats holding no CPU keep inherited affinity. */
export function seatPinnedCores(view: JournalView, subject: SpawnSubject, parent: Parent): readonly number[] | null {
  if (subject.purpose !== 'backend' && subject.purpose !== 'arc-backend') return null;
  while (parent.type === 'op') parent = view.latestIntent(parent.op).parent;
  if (parent.type !== 'stage' && parent.type !== 'job') return null;
  const holder = parent;
  const cores = [...view.resources()].flatMap(([unit, entry]) => {
    const part = parseResourceUnit(unit);
    const status = entry.status;
    if (part.type !== 'cpu' || status.state === 'free' || !sameHolder(status.holder, holder)) return [];
    if (entry.pending !== null || (status.state !== 'reserved' && status.state !== 'running')) {
      throw new Error(`seat cannot launch while ${unit} is ${status.state} or transitioning`);
    }
    return [part.n - 1];
  }).sort((a, b) => a - b);
  if (cores.length === 0) return null;
  validatePinnedCores(cores);
  return cores;
}
