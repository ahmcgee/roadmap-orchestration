// Record builders shared by the journal and fold tests: valid records of a few kinds, and `chain()` to
// wrap records into a correctly chained event sequence (or raw lines) that tests can then break.
import { type Event, type IntentRecord, type LogRecord, prevHash, serializeEvent } from '../../src/core/events.ts';
import {
  type ArcId, type InvocationId, type OpId, arcId, commandId, invocationId, needsUserId, opId, opKey, routingRev, sha, sha256, unitId,
} from '../../src/core/ids.ts';
import type { Stage } from '../../src/core/records.ts';
import { type IsoTime, absPath, gitDate, isoTime, refName } from '../../src/core/values.ts';
import type { Role } from '../../src/routing/types.ts';

export const ARC = arcId('arc-1');
export const AT = isoTime('2026-09-25T12:00:00.000Z');
export const DEADLINE = isoTime('2026-09-25T13:00:00.000Z');
export const H = sha256('d'.repeat(64));
export const REV = routingRev('0123456789abcdef');
export const U1 = unitId('u1');

export const stageParent = (stage: Stage, attempt: number, unit = U1) => ({ type: 'stage', unit, stage, attempt }) as const;

/** A backend proc.spawn intent (ordinal given) for op `<arc>/<seq>`. */
export function spawnIntent(seq: number, opts: Readonly<{ ordinal?: number; key?: string; deadlineAt?: IsoTime | null; stage?: Stage; attempt?: number; role?: Role }> = {}): IntentRecord {
  const attempt = opts.attempt ?? 1;
  return {
    type: 'intent',
    op: opId(ARC, seq),
    kind: 'proc.spawn',
    key: opKey(opts.key ?? `spawn:${seq}`),
    parent: stageParent(opts.stage ?? 'build', attempt),
    ordinal: opts.ordinal ?? 1,
    deadlineAt: opts.deadlineAt === undefined ? DEADLINE : opts.deadlineAt,
    expect: { subject: { purpose: 'backend', role: opts.role ?? 'build', routingRev: REV, unit: U1, attempt }, launchSha256: H },
    post: null,
  };
}

export const spawnResult = (op: OpId): LogRecord =>
  ({ type: 'done', op, kind: 'proc.spawn', outcome: { kind: 'result', resultSha256: H, summary: { type: 'backend', outcome: 'success' } }, recoveredBy: null });
export const spawnLost = (op: OpId): LogRecord =>
  ({ type: 'done', op, kind: 'proc.spawn', outcome: { kind: 'lost', treeEffects: false }, recoveredBy: 'reconciled' });

export function meter(inv: InvocationId, role: Role, input: number, output: number, cacheRead: number | null): LogRecord {
  return { type: 'fact', fact: { kind: 'meter', inv, role, routingRev: REV, unit: { unit: U1, attempt: 1 }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: null } } };
}

export const inv1 = (seq: number, ordinal = 1): InvocationId => invocationId(opId(ARC, seq), ordinal);

export function needsUserIntent(seq: number): IntentRecord {
  return {
    type: 'intent', op: opId(ARC, seq), kind: 'needsuser.raise', key: opKey(`needs-user:${seq}`), parent: { type: 'arc' }, ordinal: 1, deadlineAt: null,
    expect: { id: needsUserId(`nu-${seq}`), path: absPath(`/run/needs-user/nu-${seq}.json`) }, post: { sha256: H },
  };
}

export function snapshotIntent(seq: number, highWater: number): IntentRecord {
  const sig = { name: 'roadmap', email: 'roadmap@localhost', date: gitDate('1790000000 +0000') };
  return {
    type: 'intent', op: opId(ARC, seq), kind: 'snapshot.publish', key: opKey('snapshot'), parent: { type: 'arc' }, ordinal: 1, deadlineAt: null,
    expect: {
      ref: refName('refs/roadmap/arc-1'), old: null, highWater, manifestSha256: H,
      commit: { tree: sha('c'.repeat(40)), parents: [], author: sig, committer: sig, message: 'snapshot', gpgsign: false },
    },
    post: { new: sha('b'.repeat(40)) },
  };
}

export function commandIntent(seq: number, key = 'command'): IntentRecord {
  return {
    type: 'intent', op: opId(ARC, seq), kind: 'command.apply', key: opKey(key), parent: { type: 'arc' }, ordinal: 1, deadlineAt: null,
    expect: { command: commandId('cmd-0123456789abcdef'), commandSha256: H }, post: null,
  };
}

/** Wraps records into events seq 1.. with a correct chain. */
export function chain(records: readonly LogRecord[], arc: ArcId = ARC): Event[] {
  const out: Event[] = [];
  let prev: Event | null = null;
  for (const [i, record] of records.entries()) {
    const event = { v: 1, seq: i + 1, prev: prev === null ? null : prevHash(Buffer.from(serializeEvent(prev))), at: AT, arc, ...record } as Event;
    out.push(event);
    prev = event;
  }
  return out;
}

/** The raw bytes of a log holding `events` exactly as given (no re-chaining). */
export function logBytes(events: readonly Event[]): Buffer {
  return Buffer.from(events.map(serializeEvent).join(''), 'utf8');
}
