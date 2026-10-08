// `roadmap status`'s M4a keys (src/status.ts; DESIGN-1.0.md §2.4 A-M4-13), in process over a real corpus arc (corpus-unit's:
// a real repo, a real pin, a real run dir and fold) whose log is written directly with the frozen M4a facts, and the
// read-time timings over a synthetic log. Named tests: status.corpus-census, status.recorded-config (paid M4a run 12),
// status.timings.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import type { Event, Fact } from '../src/core/events.ts';
import {
  amendmentIdOf, arcId, debtId, divergenceIdOf, envId, invocationId, issueId, jobId, opKey, sha, sha256, unitId,
} from '../src/core/ids.ts';
import { debtKey } from '../src/debt/ledger.ts';
import { witnessDir } from '../src/git/snapshot.ts';
import { type ArcLaneDef, laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { witnessRecordOf, writeWitnessRecord } from '../src/holistic/witness.ts';
import { type Status, stageTimings, status } from '../src/status.ts';
import { DEFAULT_REPO } from './helpers/forge.ts';
import { withForge } from './helpers/corpusarc.ts';
import { tipTree } from './fixtures/brake-common.ts';
import { corpusHolisticArc } from './fixtures/corpus-holistic.ts';
import { type ArcRun, contextFor } from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';

const T = { timeout: 60_000 };

const statusOf = (r: ArcRun): Status => status(r.ctx.runDir, arcId(r.d.arc), r.ctx.hostDir);

/** The journey lane of the obligations file in force. */
const journeyOf = (r: ArcRun): ArcLaneDef => parseObligations(JSON.parse(readFileSync(join(r.ctx.planDir, 'obligations.json'), 'utf8'))).lanes[0]!;

/** A witness run of `lane` on `tree` under `baseline-1` passing `t1`: its record kept where the snapshot finds it, then `witnessed`. */
function witnessHeld(r: ArcRun, lane: ArcLaneDef, tree: string): void {
  const j = jobId('baseline', 1);
  const { op } = r.journal.begin({
    kind: 'proc.spawn', key: opKey(`lane:baseline-1:${lane.id}`), parent: { type: 'job', job: j }, deadlineAt: null,
    body: () => ({ expect: { subject: { purpose: 'journey', lane: lane.id, laneRev: laneRevOf(lane), at: sha(git(r.d.repo, 'rev-parse', 'main')), owner: { type: 'job', job: j } }, launchSha256: sha256('c'.repeat(64)) }, post: null }),
  });
  const inv = invocationId(op, 1);
  const base = { lane: lane.id, laneRev: laneRevOf(lane), envId: envId('fedcba9876543210'), treeSha: sha(tree), inv, purpose: 'witness', for: { type: 'job', job: j } } as const;
  const dir = witnessDir(r.ctx.runDir, base);
  mkdirSync(dir, { recursive: true });
  const recordsSha256 = writeWitnessRecord(dir, witnessRecordOf({ lane, envId: base.envId, treeSha: base.treeSha, inv, purpose: 'witness' }, [{ testId: 't1', selected: 1, outcome: 'pass' }]));
  r.journal.fact({ kind: 'witnessed', ...base, recordsSha256 });
}

describe('status M4a', () => {
  it('status.corpus-census: a corpus arc shows its pin, its census (each rule\'s state, held on the head, % held), its amendments, debt, issue captures and intake, its pack reviews and holds, and its chain', T, async () => {
    const a = await corpusHolisticArc([]);
    const r = contextFor(a.d);
    try {
      let s = await withForge(a.forge, () => statusOf(r));
      assert.deepEqual(s.corpus, {
        pinSha256: a.pinSha256, source: { kind: 'same-repo', commit: a.baseline, root: 'docs/corpus' }, files: a.pin.files.length,
        rules: { active: a.pin.rules.length, retired: 0, highWater: a.pin.highWater }, phase0Sha256: s.corpus?.phase0Sha256,
      });
      assert.match(s.corpus?.phase0Sha256 ?? '', /^[0-9a-f]{64}$/);
      // The census before any witness: T-1's obligation is not held yet; the other rules are out of the slice.
      const others = a.pin.rules.filter((x) => x.id !== 'T-1').map((x) => ({ rule: x.id, state: { type: 'out-of-slice' }, held: null }));
      assert.deepEqual(s.census, {
        rules: [{ rule: 'T-1', state: { type: 'obligation', id: 'I-1' }, held: false }, ...others],
        counts: { held: 0, obligationRules: 1, outOfSlice: others.length, untestable: 0, prodOnly: 0 }, heldPct: 0,
      });
      // Before the first admission a pack review is due and holds every admission (K14, H9), with the baseline owed.
      assert.deepEqual(s.packReview, { state: 'due', reviews: [] });
      assert.deepEqual(s.holds, ['baseline', 'pack-review']);
      assert.deepEqual([s.amendments, s.debt, s.issues], [[], { banked: [], ledger: [] }, { lastCapture: null, intake: [] }]);
      // The chain of a bootstrap arc integrating on main: position 1, acked, no PR; no K committed in this repo.
      // The arc has no ref yet, so the next start waits for it.
      assert.deepEqual(s.chain, {
        arcs: [{ arc: r.d.arc, previousArc: null, acked: true, pr: { type: 'none' } }], k: null, unackedStarts: [],
        nextStart: { allowed: false, reason: 'previous-incomplete', arc: r.d.arc }, position: 1,
      });

      // The journey lane passes t1 on the head's tree: I-1 holds, so T-1 is held (100%).
      witnessHeld(r, journeyOf(r), tipTree(a.d));
      // A review running, then ended with a blocking finding and a note (its item not raised here); the key it bound is
      // not the current one, so another is due.
      r.journal.fact({ kind: 'pack-review-started', job: jobId('review', 1), planRev: 1, inputsSha256: sha256('a'.repeat(64)), key: sha256('b'.repeat(64)) } as Fact);
      assert.deepEqual(statusOf(r).packReview?.state, 'running');
      r.journal.fact({
        kind: 'pack-review-ended', job: jobId('review', 1), outcome: 'completed', findings: [
          { index: 0, severity: 'blocking', target: { type: 'plan' }, claim: 'the slice is too wide', evidence: [] },
          { index: 1, severity: 'note', target: { type: 'plan' }, claim: 'the cut line is vague', evidence: [] },
        ],
      } as Fact);
      // A checkpoint capture and its intake; an amendment from a divergence; a banked note.
      r.journal.fact({ kind: 'issues-captured', job: jobId('ckpt', 1), sha256: sha256('c'.repeat(64)), repo: DEFAULT_REPO, filtered: { comments: 2, pullRequests: 1 } } as Fact);
      r.journal.fact({ kind: 'issue-intake', job: jobId('ckpt', 1), issue: issueId('issue-3'), outcome: { type: 'none', reason: 'tracked by u1' } } as Fact);
      r.journal.fact({
        kind: 'corpus-amendment', id: amendmentIdOf(1), source: { type: 'divergence', divergence: divergenceIdOf(1) }, rules: [], proposal: 'Name the tide window.', why: 'D-1', evidence: [],
      } as Fact);
      const what = 'Tidy the berth helpers.';
      r.journal.fact({
        kind: 'debt-banked', id: debtId('B-1'), bankReason: 'gate-note', what, key: debtKey({ unit: unitId('u1'), bankReason: 'gate-note', what }),
        source: { type: 'gate', unit: unitId('u1'), attempt: 1, index: 0 },
      } as Fact);

      s = await withForge(a.forge, () => statusOf(r));
      assert.deepEqual(s.census?.rules[0], { rule: 'T-1', state: { type: 'obligation', id: 'I-1' }, held: true });
      assert.deepEqual([s.census?.counts.held, s.census?.heldPct], [1, 100]);
      assert.deepEqual(s.packReview, {
        state: 'due',
        reviews: [{ job: 'review-1', planRev: 1, key: 'b'.repeat(64), outcome: 'completed', blocking: 1, notes: 1, needsUser: null, superseded: false }],
      });
      assert.ok(s.holds.includes('pack-review'));
      assert.deepEqual(s.issues, {
        lastCapture: { job: 'ckpt-1', sha256: 'c'.repeat(64), repo: DEFAULT_REPO, filtered: { comments: 2, pullRequests: 1 } },
        intake: [{ job: 'ckpt-1', issue: 'issue-3', outcome: { type: 'none', reason: 'tracked by u1' } }],
      });
      assert.deepEqual(s.amendments, [{ id: 'M-1', source: { type: 'divergence', divergence: 'D-1' }, rules: [], proposal: 'Name the tide window.', why: 'D-1' }]);
      assert.deepEqual(s.debt, {
        banked: [{ id: 'B-1', bankReason: 'gate-note', what, seq: s.debt?.banked[0]?.seq }],
        ledger: [{ id: 'B-1', state: 'open', originArc: r.d.arc, what }],
      });
    } finally {
      r.journal.close();
    }
  });
});

test('status.recorded-config (paid M4a run 12): K is the config committed at the baseline and routing the revision\'s provenance; a changed or scrambled live config changes nothing and crashes nothing', T, async () => {
  const a = await corpusHolisticArc([], { baseline: { '.roadmap/config.json': `${JSON.stringify({ chain: { k: 2 } })}\n` } });
  const r = contextFor(a.d);
  try {
    // Status as read here, without the fold's own timing (`foldMs` differs between any two reads).
    const read = async (): Promise<unknown> => JSON.parse(JSON.stringify(await withForge(a.forge, () => statusOf(r)), (key, v: unknown) => (key === 'foldMs' ? undefined : v)));
    const before = await read();
    assert.equal((before as Status).chain?.k, 2);
    const live = join(a.d.repo, '.roadmap', 'config.json');
    for (const bytes of [`${JSON.stringify({ chain: { k: 5 }, routing: { profile: 'claude-only' } })}\n`, 'Scrambled: not JSON.\n']) {
      writeFileSync(live, bytes);
      assert.deepEqual(await read(), before, bytes);
    }
  } finally {
    r.journal.close();
  }
});

test('status.timings: per stage in stage order, the completed attempts\' count, lower median and maximum, from the first op to the outcome; an attempt with no op is not timed; `after` counts only later outcomes', () => {
  let seq = 0;
  const at = (s: number): string => new Date(Date.UTC(2026, 9, 3, 0, 0, s)).toISOString();
  const intent = (unit: string, stage: string, attempt: number, s: number): Event => {
    seq += 1;
    return { type: 'intent', seq, at: at(s), parent: { type: 'stage', unit, stage, attempt } } as unknown as Event;
  };
  const outcome = (unit: string, stage: string, attempt: number, s: number): Event => {
    seq += 1;
    return { type: 'fact', seq, at: at(s), fact: { kind: 'stage-outcome', unit, stage, attempt, outcome: 'x', class: 'advance', chargeable: false } } as unknown as Event;
  };
  const events = [
    intent('u1', 'build', 1, 0), intent('u1', 'build', 1, 5), outcome('u1', 'build', 1, 60),
    intent('u2', 'build', 2, 10), outcome('u2', 'build', 2, 40),
    intent('u1', 'gate', 3, 100), outcome('u1', 'gate', 3, 110),
    intent('u3', 'build', 1, 0), outcome('u3', 'build', 1, 90),
    outcome('u4', 'quiesce', 1, 120),
  ];
  assert.deepEqual(stageTimings(events), [
    { stage: 'build', count: 3, p50Ms: 60_000, maxMs: 90_000 },
    { stage: 'gate', count: 1, p50Ms: 10_000, maxMs: 10_000 },
  ]);
  // The brief's delta: only the outcomes after seq 7 (u3's build; the untimed quiesce adds nothing).
  assert.deepEqual(stageTimings(events, 7), [{ stage: 'build', count: 1, p50Ms: 90_000, maxMs: 90_000 }]);
  assert.deepEqual(stageTimings(events, seq), []);
});
