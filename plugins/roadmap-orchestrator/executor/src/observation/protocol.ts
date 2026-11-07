import { createRequire } from 'node:module';
import { canonicalJson } from '../core/json.ts';
import type { ArcId } from '../core/ids.ts';
import type { Display } from '../tui/types.ts';
import type { summarize } from '../status/summary.ts';
import type { Event } from '../core/events.ts';
import type { PlanM1 } from '../input/plan.ts';

export const CONSOLE_PROTOCOL = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
export type ConsoleCode = 'reset' | 'conflict' | 'unavailable' | 'corruption' | 'protocol' | 'not-found' | 'invalid';
export class ConsoleError extends Error {
  readonly code: ConsoleCode;
  constructor(code: ConsoleCode, message: string) { super(message); this.name = 'ConsoleError'; this.code = code; }
}
export type ObservationData = Readonly<{
  display: Display; summary: ReturnType<typeof summarize>; events: readonly Event[]; plan: PlanM1 | null;
  capture: Readonly<{ clock: number; foldMs: number; source: string; materializations: number }>;
}>;
export type Envelope<T = ObservationData> = Readonly<{
  protocol: string; instance: string; repoId: string; arc: ArcId; epoch: string;
  highWater: number; revision: number; observedAt: string; checkedAt: string; data: T;
}>;
export type Fence = Readonly<{ identity: string; size: number }>;
export type Admission = Readonly<{ minHighWater?: number; epoch?: string; revision?: number; fence?: Fence }>;
export const statusBytes = (e: Envelope, summary: boolean): string => canonicalJson(summary ? e.data.summary : e.data.display.status) + '\n';

/** Transport validation is intentionally strict: an incompatible or malformed server never triggers local fallback. */
export function validateEnvelope(raw: unknown, expected: Readonly<{ instance: string; repoId: string; arc: ArcId }>): Envelope {
  const e = raw as Envelope | null;
  if (!e || e.protocol !== CONSOLE_PROTOCOL) throw new ConsoleError('protocol', 'console protocol/version mismatch; reload required');
  if (e.instance !== expected.instance || e.repoId !== expected.repoId || e.arc !== expected.arc) throw new ConsoleError('conflict', 'console identity mismatch');
  if (typeof e.epoch !== 'string' || !Number.isSafeInteger(e.highWater) || e.highWater < 0 || !Number.isSafeInteger(e.revision) || e.revision < 1
    || !Number.isFinite(Date.parse(e.checkedAt)) || !Number.isFinite(Date.parse(e.observedAt))
    || !e.data || typeof e.data !== 'object' || !e.data.display?.status || e.data.display.status.arc !== e.arc || e.data.summary?.arc !== e.arc
    || !Array.isArray(e.data.display.status.units) || !Array.isArray(e.data.events) || !e.data.capture || !Number.isFinite(e.data.capture.clock)) {
    throw new ConsoleError('protocol', 'malformed console payload');
  }
  return e;
}
