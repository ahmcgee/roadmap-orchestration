// Runtime boundary for the first UI DTO routes. Does not require a full observation or journal.
import { CONSOLE_PROTOCOL, ConsoleError, type Envelope } from '../observation/protocol.ts';
import { CONSOLE_UI_SCHEMA, type GraphView, type ShellView } from './view-protocol.ts';

import { shellShape, graphShape } from './view-shapes.ts';
export function validateViewEnvelope<K extends 'shell' | 'graph'>(raw: unknown, kind: K, expected: {instance: string; repoId: string; arc: string}): Envelope<K extends 'shell' ? ShellView : GraphView> {
  const e = raw as Envelope<unknown> | null;
  if (!e || e.protocol !== CONSOLE_PROTOCOL) throw new ConsoleError('protocol', 'console protocol/version mismatch; reload required');
  if (e.instance !== expected.instance || e.repoId !== expected.repoId || e.arc !== expected.arc) throw new ConsoleError('conflict', 'console identity mismatch');
  if (typeof e.epoch !== 'string' || !Number.isSafeInteger(e.highWater) || e.highWater < 0 || !Number.isSafeInteger(e.revision) || e.revision < 1 || !Number.isFinite(Date.parse(e.observedAt)) || !Number.isFinite(Date.parse(e.checkedAt))
    || !(kind === 'shell' ? shellShape : graphShape)(e.data)) throw new ConsoleError('protocol', 'malformed console view or UI schema mismatch; reload required');
  if (kind === 'shell' && (e.data as ShellView).identity.arc !== e.arc) throw new ConsoleError('conflict', 'console shell identity mismatch');
  return e as Envelope<K extends 'shell' ? ShellView : GraphView>;
}
