import { createRequire } from 'node:module';
import { canonicalJson } from '../core/json.ts';
import type { ArcId } from '../core/ids.ts';
import type { Display } from '../tui/types.ts';
import type { summarize } from '../status/summary.ts';
import type { Event } from '../core/events.ts';
import type { PlanM1 } from '../input/plan.ts';
import type { CaptureWork } from './collect.ts';
import type { ViewVersions } from '../console/view-protocol.ts';

export const CONSOLE_PROTOCOL = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
export type ConsoleCode = 'reset' | 'conflict' | 'unavailable' | 'corruption' | 'protocol' | 'not-found' | 'invalid';
export class ConsoleError extends Error {
  readonly code: ConsoleCode;
  constructor(code: ConsoleCode, message: string) { super(message); this.name = 'ConsoleError'; this.code = code; }
}
export type ObservationData = Readonly<{
  requests: readonly import('../core/records.ts').NeedsUserRecord[];
  display: Display; summary: ReturnType<typeof summarize>; events: readonly Event[]; plan: PlanM1 | null;
  /**
   * `materializations` counts the captures published in this console, so it names one: view caches key on it (`captureKey`).
   * `viewVersions`: what the notice of this data says, computed once when a serve model published it (src/console/model.ts);
   * absent on data no model published (a test's), whose versions are computed from it when asked (src/console/metadata.ts).
   */
  capture: Readonly<{ clock: number; foldMs: number; materializations: number; work: CaptureWork; viewVersions?: ViewVersions }>;
}>;
/** Which capture an envelope's data is, within its console: what derived views are cached by. A check or a rows refresh keeps it. */
export const captureKey = (e: Envelope): string => `${e.instance}:${e.arc}:${e.epoch}:${e.data.capture.materializations}`;
export type Envelope<T = ObservationData> = Readonly<{
  protocol: string; instance: string; repoId: string; arc: ArcId; epoch: string;
  highWater: number; revision: number; observedAt: string; checkedAt: string; data: T;
}>;
export type Fence = Readonly<{ identity: string; size: number }>;
export type Admission = Readonly<{ minHighWater?: number; epoch?: string; revision?: number; fence?: Fence }>;
export const statusBytes = (e: Envelope, summary: boolean): string => canonicalJson(summary ? e.data.summary : e.data.display.status) + '\n';

/** Transport validation is strict. The status client handles version mismatch before validation; malformed data still fails. */
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

/** Status transport carries only the canonical object, not the observer's evidence working set. */
export function validateStatusEnvelope(raw: unknown, expected: Readonly<{ instance: string; repoId: string; arc: ArcId }>, summary: boolean): Envelope<unknown> {
  const e = raw as Envelope<unknown> | null;
  if (!e || e.protocol !== CONSOLE_PROTOCOL) throw new ConsoleError('protocol', 'console protocol/version mismatch; reload required');
  if (e.instance !== expected.instance || e.repoId !== expected.repoId || e.arc !== expected.arc) throw new ConsoleError('conflict', 'console identity mismatch');
  const data = e.data as Record<string, unknown> | null;
  const required = summary ? ['arc', 'state', 'stop', 'supervision', 'planRev', 'progress', 'spend', 'milestones', 'caught', 'verdicts', 'captures', 'needsUser', 'waste', 'demo', 'completion', 'waiting']
    : ['arc', 'supervision', 'run', 'units', 'edges', 'runOnly', 'needsUser', 'commands', 'host', 'spend', 'plan', 'completion', 'milestones', 'waiting'];
  if (typeof e.epoch !== 'string' || !Number.isSafeInteger(e.highWater) || e.highWater < 0 || !Number.isSafeInteger(e.revision) || e.revision < 1 || !Number.isFinite(Date.parse(e.checkedAt)) || !Number.isFinite(Date.parse(e.observedAt))
    || !data || typeof data !== 'object' || data['arc'] !== e.arc || required.some((k) => !Object.hasOwn(data, k)) || !Array.isArray(data['needsUser']) || !Array.isArray(data['milestones'])
    || (summary ? typeof data['progress'] !== 'object' || data['progress'] === null : !Array.isArray(data['units']) || typeof data['run'] !== 'object' || data['run'] === null || typeof data['host'] !== 'object' || data['host'] === null)) {
    throw new ConsoleError('protocol', 'malformed canonical console status payload');
  }
  canonicalJson(data); // All nested values must remain JSON representable; stdout uses these exact values.
  return e;
}
