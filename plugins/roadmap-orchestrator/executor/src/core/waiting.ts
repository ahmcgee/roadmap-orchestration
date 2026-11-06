// Durable, completed waiting measurements. Concurrent reasons deliberately do not add up to totalMs.
import { resourceName } from './ids.ts';
import { type Read, Fields, SchemaError, nat, object } from './validate.ts';

export const ADMISSION_HOLDS = ['paused', 'drain', 'run-only', 'backend-parked', 'breaker', 'base-red', 'blocking-item', 'finding-blocked', 'known-defect', 'host-pressure', 'compare', 'deflake', 'dependency', 'contingent-edge', 'milestone', 'baseline', 'pack-review', 'repair-batch'] as const;
export type AdmissionHold = typeof ADMISSION_HOLDS[number];
export type WaitReason = 'cpu-pressure' | 'memory-pressure' | 'cpu-tokens' | 'publication-slot' | 'queue-precedence' | `named-resource:${string}` | `admission-hold:${AdmissionHold}`;
export type Waited = Readonly<{ totalMs: number; byReasonMs: Readonly<Partial<Record<WaitReason, number>>> }>;

export function waitReason(value: unknown, path: string): WaitReason {
  if (typeof value === 'string') {
    if (['cpu-pressure', 'memory-pressure', 'cpu-tokens', 'publication-slot', 'queue-precedence'].includes(value)) return value as WaitReason;
    if (value.startsWith('named-resource:')) { resourceName(value.slice('named-resource:'.length), path); return value as WaitReason; }
    if (value.startsWith('admission-hold:') && (ADMISSION_HOLDS as readonly string[]).includes(value.slice('admission-hold:'.length))) return value as WaitReason;
  }
  throw new SchemaError(path, 'a closed waiting reason', value);
}

export const waited: Read<Waited> = object((f) => {
  const byReasonMs = f.get('byReasonMs', (v, p) => {
    // Validate an object with dynamic, closed reason keys, without expanding legacy disk bytes.
    const fields = new Fields(v, p);
    const raw = v as Record<string, unknown>;
    const out: Partial<Record<WaitReason, number>> = {};
    for (const key of Object.keys(raw)) out[waitReason(key, p)] = fields.get(key, nat);
    fields.end();
    return out;
  });
  return { totalMs: f.get('totalMs', nat), byReasonMs };
});

let warned = false;
export function warnUnmeasuredWaiting(): void {
  if (warned) return;
  warned = true;
  process.emitWarning('legacy reservation has no waited measurement; historical waiting is unmeasured (further occurrences are not repeated)', { code: 'ROADMAP_UPGRADE' });
}
