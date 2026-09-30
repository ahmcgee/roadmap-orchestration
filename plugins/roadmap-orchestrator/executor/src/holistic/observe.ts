// Observations (plan "Witnesses, observations, the transition table"; DESIGN-1.0.md §2.8 Witnesses, Ordering): the
// verdict of one obligation's witness tests in one record, and the observation store the transition table reads.
//
// Verdicts (pure, `verdictOf`) over the witness's declared test ids, a test id the record lacks counting as
// zero-selected:
//   - malformed → unwitnessed;
//   - any fail → not-held;
//   - every test selected ≥ 1 and passing → held;
//   - passes mixed with skip or zero-selected → partial;
//   - else (no pass) → unwitnessed.
//
// An observation is derived from a `witnessed{purpose: witness}` fact and its `witness.json`, keyed `(treeSha, lane,
// laneRev, envId)`. It is reused only when all four keys match and the kept file's bytes still hash to the fact's
// `recordsSha256`: a missing or changed file is no observation (the lane is witnessed again). A `mutant` record
// (G13) is never an observation: it carries the patched tree's real id and never certifies, even an unmodified
// tree whose key it shares. Observations are append-only; the one a key reads is the latest by log order, and the
// current status of an obligation is the observation on the current integration head, never the latest to complete.
import type { EnvId, Sha, Sha256Hex } from '../core/ids.ts';
import type { HolisticFold } from '../core/state.ts';
import { sha256Hex } from '../core/json.ts';
import {
  type ArcLaneDef, type ObservationKey, type ObservationVerdict, type VerdictOf, type WitnessRecord, type WitnessRef, laneRevOf, observationKeyText,
  witnessRecord,
} from './types.ts';

/** One obligation's verdict over its witness tests in one record (pure). */
export const verdictOf: VerdictOf = (record, witness) => {
  if (record.malformed) return 'unwitnessed';
  const byId = new Map(record.records.map((r) => [r.testId, r]));
  const outcomes = witness.testIds.map((id) => {
    const r = byId.get(id);
    return r === undefined || r.selected === 0 ? 'zero-selected' : r.outcome;
  });
  if (outcomes.includes('fail')) return 'not-held';
  if (outcomes.every((o) => o === 'pass')) return 'held';
  if (outcomes.includes('pass')) return 'partial';
  return 'unwitnessed';
};

/** A `witnessed` fact as the fold keeps it. */
export type WitnessedEntry = HolisticFold['witnessed'][number];

/** A certifying observation: its key, the kept record and its hash, and the seq of its `witnessed` fact. */
export type Observation = Readonly<{ key: ObservationKey; recordsSha256: Sha256Hex; record: WitnessRecord; seq: number }>;

/**
 * The observation of one `witnessed` fact, given its `witness.json` bytes (null when the file is missing). null
 * when it is not one: a mutant run (G13), or a missing or changed file. A file that hashes right but names another
 * key or purpose than its fact was written wrong: that throws.
 */
export function observationOf(entry: WitnessedEntry, bytes: string | null): Observation | null {
  if (entry.purpose !== 'witness') return null;
  if (bytes === null || sha256Hex(bytes) !== entry.recordsSha256) return null;
  const record = witnessRecord(JSON.parse(bytes), 'witness');
  const key: ObservationKey = { treeSha: entry.treeSha, lane: entry.lane, laneRev: entry.laneRev, envId: entry.envId };
  if (observationKeyText(record) !== observationKeyText(key) || record.purpose !== entry.purpose || record.inv !== entry.inv) {
    throw new Error(`witness record of ${entry.inv} (seq ${entry.seq}) names ${observationKeyText(record)} ${record.purpose}, its fact ${observationKeyText(key)} ${entry.purpose}`);
  }
  return { key, recordsSha256: entry.recordsSha256, record, seq: entry.seq };
}

/** The observations by key: the latest of each (by log order). */
export type ObservationStore = ReadonlyMap<string, Observation>;

export function observationStore(observations: Iterable<Observation>): ObservationStore {
  const out = new Map<string, Observation>();
  for (const o of observations) {
    const text = observationKeyText(o.key);
    const seen = out.get(text);
    if (seen === undefined || o.seq > seen.seq) out.set(text, o);
  }
  return out;
}

/** The key an arc lane's observation on a tree has in an environment. */
export const keyOf = (treeSha: Sha, lane: ArcLaneDef, envId: EnvId): ObservationKey => ({ treeSha, lane: lane.id, laneRev: laneRevOf(lane), envId });

/** The reusable observation for a key: all four keys equal (the hash was checked when it entered the store), else null. */
export const reuse = (store: ObservationStore, key: ObservationKey): Observation | null => store.get(observationKeyText(key)) ?? null;

/** An obligation's verdict on a key: null when nothing is observed there (missing, stale, or never run). */
export function observedVerdict(store: ObservationStore, key: ObservationKey, witness: WitnessRef): ObservationVerdict | null {
  if (witness.lane !== key.lane) throw new Error(`a witness on lane ${witness.lane} read on ${observationKeyText(key)}`);
  const o = reuse(store, key);
  return o === null ? null : verdictOf(o.record, witness);
}
