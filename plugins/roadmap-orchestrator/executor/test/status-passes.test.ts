// dev.79 (T11): the passes status makes over every event (src/status/passes.ts) are reducers, so passes extended over a
// journal in any chunks hold what passes folded from nothing over the same events hold, and a capture that extends kept
// passes derives the bytes one folding from nothing derives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prevHash, serializeEvent, type Event } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { readJournal } from '../src/core/log.ts';
import { Fold } from '../src/core/state.ts';
import { absPath } from '../src/core/values.ts';
import { captureStatus } from '../src/status.ts';
import { StatusPasses } from '../src/status/passes.ts';
import { summarize } from '../src/status/summary.ts';
import { generateScaleArc } from './helpers/scale-arc.ts';
import { tmpDir } from './helpers/repo.ts';

/** Every field of the passes at `view`'s position, as JSON: what two folds to the same position must agree on. */
function fields(p: StatusPasses, view: Fold): Record<string, string> {
  return {
    intentTimes: canonicalJson([...p.intentTimes]), attemptStarts: canonicalJson([...p.attemptStarts]), stageTimings: canonicalJson(p.stageTimings),
    meter: canonicalJson(p.meter), waiting: canonicalJson(p.waiting), findingTimes: canonicalJson(p.findingTimes.metrics(view.holistic().findings)),
    reservations: canonicalJson(p.reservations.spawns), certification: canonicalJson([...p.certification.attempts]), laneRuns: canonicalJson(p.laneRuns),
    grinding: canonicalJson(p.grinding), waste: canonicalJson(p.waste), decisionSources: canonicalJson(p.decisionSources),
    summary: canonicalJson({ ...p.summary.caught, estimatedCalls: p.summary.estimatedCalls, verdicts: p.summary.verdicts, laneSpawns: p.summary.laneSpawns }),
  };
}
function same(a: Record<string, string>, b: Record<string, string>, label: string): void {
  for (const k of Object.keys(b)) assert.equal(a[k], b[k], `${label}: ${k}`);
}
/** A seeded generator (mulberry32). */
function random(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('T11: passes extended in random chunkings equal passes folded from nothing, field by field; a capture extending kept passes derives the same bytes', { timeout: 600_000 }, async () => {
  const m = await generateScaleArc(tmpDir('status-passes'));
  const runDir = absPath(m.runDir), arc = arcId(m.arc), hostDir = absPath(m.hostDir);
  const events = readJournal(runDir, arc).events;
  assert.ok(events.length > 1_000, `the scale journal has ${events.length} events`);
  const positions = Array.from({ length: 20 }, (_, i) => Math.round(((i + 1) * events.length) / 20));
  // The fold and the passes from nothing at each position.
  const view = new Fold(arc), expected = new Map<number, Record<string, string>>();
  for (let n = 0, at = 0; at < positions.length; at++) {
    for (; n < positions[at]!; n++) view.apply(events[n]!, prevHash(Buffer.from(serializeEvent(events[n]!), 'utf8')));
    expected.set(positions[at]!, fields(StatusPasses.of(events.slice(0, positions[at])), view));
  }
  const views = new Map<number, Fold>();
  const viewAt = (n: number): Fold => {
    let f = views.get(n);
    if (f === undefined) { f = new Fold(arc); for (const e of events.slice(0, n)) f.apply(e, prevHash(Buffer.from(serializeEvent(e), 'utf8'))); views.set(n, f); }
    return f;
  };
  for (let run = 0; run < 50; run++) {
    const next = random(run + 1), p = new StatusPasses(), journal: Event[] = [];
    let at = 0;
    while (journal.length < events.length) {
      // Chunks of 1 to 400 events, never past the next checked position.
      const stop = positions[at]!, size = Math.max(1, Math.min(stop - journal.length, Math.ceil(next() ** 3 * 400)));
      journal.push(...events.slice(journal.length, journal.length + size));
      p.extend(journal);
      assert.equal(p.folded, journal.length);
      if (journal.length === stop) { same(fields(p, viewAt(stop)), expected.get(stop)!, `run ${run} at ${stop}`); at++; }
    }
  }

  // A capture extending one kept set of passes, against one folding its own from nothing, at each position.
  const kept = new StatusPasses(), live = new Fold(arc);
  for (let n = 0, at = 0; at < positions.length; at++) {
    for (; n < positions[at]!; n++) live.apply(events[n]!, prevHash(Buffer.from(serializeEvent(events[n]!), 'utf8')));
    const snapshot = { view: live, events: events.slice(0, positions[at]) }, timing = { clock: Date.parse('2026-11-01T00:00:00.000Z'), foldMs: 0 };
    const extended = captureStatus(runDir, arc, hostDir, snapshot, timing, kept), fresh = captureStatus(runDir, arc, hostDir, snapshot, timing);
    assert.equal(kept.folded, positions[at]);
    assert.equal(canonicalJson(extended.full), canonicalJson(fresh.full), `status at ${positions[at]}`);
    assert.equal(canonicalJson(summarize(extended.core, extended.events, extended.plan, kept)), canonicalJson(summarize(fresh.core, fresh.events, fresh.plan)), `summary at ${positions[at]}`);
  }
});

test('passes refuse a journal that is not the one they folded, grown', () => {
  const e = (seq: number) => ({ v: 2, arc: 'a', seq, at: '2026-01-01T00:00:00.000Z', prev: null, type: 'fact', fact: { kind: 'containment-mode', mode: 'session' } }) as unknown as Event;
  const journal = [e(1), e(2), e(3)], p = new StatusPasses();
  p.extend(journal);
  assert.throws(() => p.extend(journal.slice(0, 2)), /the journal has 2 events, 3 were folded/);
  assert.throws(() => p.extend([e(1), e(2), e(3), e(4)]), /event 3 is not the one folded/);
  p.extend([...journal, e(4)]);
  assert.equal(p.folded, 4);
});
