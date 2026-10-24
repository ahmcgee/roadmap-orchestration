// The flaky ledger (dev.17, lane topology; SCHEMAS.md "dev.17 records"): arc-wide, one entry per test (a lane and a test
// id) or per lane (a lane whose reporter names no failing test). Types and readers only; the lanes stage keeps it.
import { type EnvId, type InvocationId, type LaneId, type Sha, type UnitId, envId, invocationIdOf, laneId, sha, unitId } from './ids.ts';
import { type Read, SchemaError, arrayOf, literal, nullable, object, str, tagged } from './validate.ts';
import { type RepoPath, repoPath } from './values.ts';

export type FlakyKey = Readonly<{ type: 'test'; lane: LaneId; testId: string }> | Readonly<{ type: 'lane'; lane: LaneId }>;

/**
 * One flake: a red run then a green run of the lane on the same tree and environment, the red one failing `failing` (the
 * test ids its reporter named; empty for a lane key). Never a stochastic lane's (k-of-n).
 */
export type FlakyEvent = Readonly<{ tree: Sha; env: EnvId | null; failing: readonly string[]; red: InvocationId; green: InvocationId }>;

/** A key's flakes in order, and the deflake units minted for it in order (a third flake raises needs-user instead). */
export type FlakyLedgerEntry = Readonly<{ key: FlakyKey; events: readonly FlakyEvent[]; deflakes: readonly UnitId[] }>;

/** The key's identity, for lookups and uniqueness. */
export const flakyKeyOf = (k: FlakyKey): string => (k.type === 'test' ? `test:${k.lane}:${k.testId}` : `lane:${k.lane}`);

/**
 * The test file a test id names: its first name-path segment (" > ", src/holistic/witness.ts) when that is a repo path, as a
 * runner whose outermost suite is the file writes it (`apps/x/test/a.test.ts > suite > test`); else null. A suite name that
 * reads as a path names no file the systems map knows, so it classifies unmapped.
 */
export function testFileOf(testId: string): RepoPath | null {
  try {
    return repoPath(testId.split(' > ')[0]!);
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return null;
  }
}

const lane: Read<LaneId> = (v, p) => laneId(v, p);
export const flakyKey: Read<FlakyKey> = tagged<FlakyKey['type'], FlakyKey>('type', {
  test: object((f) => ({ type: f.get('type', literal('test')), lane: f.get('lane', lane), testId: f.get('testId', str) })),
  lane: object((f) => ({ type: f.get('type', literal('lane')), lane: f.get('lane', lane) })),
});

const inv: Read<InvocationId> = (v, p) => invocationIdOf(v, p);
export const flakyEvent: Read<FlakyEvent> = object((f) => ({
  tree: f.get('tree', (v, p) => sha(v, p)),
  env: f.get('env', nullable((v, p) => envId(v, p))),
  failing: f.get('failing', arrayOf(str)),
  red: f.get('red', inv),
  green: f.get('green', inv),
}));

export const flakyLedgerEntry: Read<FlakyLedgerEntry> = object((f) => ({
  key: f.get('key', flakyKey),
  events: f.get('events', arrayOf(flakyEvent, { nonEmpty: true })),
  deflakes: f.get('deflakes', arrayOf((v, p) => unitId(v, p))),
}));
