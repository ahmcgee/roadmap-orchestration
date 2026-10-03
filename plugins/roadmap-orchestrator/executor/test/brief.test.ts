// M4a step C4: `roadmap brief` (src/brief.ts, src/commands/brief.ts) and `roadmap chain status` (src/commands/chain.ts)
// over real chained corpus arcs: real repos and pins, real run dirs and folds, real snapshot refs (the brief reads only
// them), the fake forge for the PRs, the CLI as a child for the crash rows (BRIEF_ACK). Named tests:
// brief.since-ack-across-arcs, brief.coverage-vector, brief.payload-hash-whole, brief.markdown-from-payload,
// brief.ack-stale-refused, brief.ack-nonblocking-only, brief.ack-crash-rerun, brief.ack-crash-start, brief.ack-ids-ordinal, chain.status-render.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, test } from 'node:test';
import { renderBrief } from '../src/brief.ts';
import { acksDir } from '../src/chain.ts';
import { brief } from '../src/commands/brief.ts';
import { chainStatus } from '../src/commands/chain.ts';
import { MAX_ACK_ITEMS, ackCommandId, enqueueCommand, incomingPath } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { type BriefId, type NeedsUserId, amendmentIdOf, arcId, commandId, debtId, divergenceIdOf, issueId, jobId, needsUserId, ruleId, sha256 } from '../src/core/ids.ts';
import { canonicalJson } from '../src/core/json.ts';
import { EVENTS_FILE, type OpenJournal, openJournal } from '../src/core/log.ts';
import type { NeedsUserReason } from '../src/core/records.ts';
import { absPath, isoTime } from '../src/core/values.ts';
import { debtKey } from '../src/debt/ledger.ts';
import { snapshotRequestOf } from '../src/git/snapshot.ts';
import { PACK_REVIEW_INPUTS_SCHEMA } from '../src/holistic/types.ts';
import { PACK_REVIEW_INPUT, keepInput } from '../src/input/inforce.ts';
import { selfIdentity } from '../src/host/liveness.ts';
import { claimHost, releaseHost } from '../src/host/lock.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { type BriefPayload, parseAckMarker, parseBriefPayload } from '../src/phase0/types.ts';
import { executorIdentity } from '../src/pipeline/stages.ts';
import { runChecks } from '../src/preflight/checks.ts';
import { snapshotPublishOp } from '../src/recover/ops.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { type CorpusArc, betweenArc, corpusArc, editPhase0, inForce, newHostDir, nextArc, runDirOfArc, seal, withForge } from './helpers/corpusarc.ts';
import { runUntilExit } from './helpers/proc.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { BRIEF_ACK, crashCells } from './matrix.ts';
import { runOp } from './fixtures/git-common.ts';

const T = { timeout: 120_000 };
const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));
type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------------
// The arcs

/** The arc's journal: its run dir's, or (first) its files put in force as revision 1. */
const journalOf = (a: CorpusArc): OpenJournal => (existsSync(join(runDirOfArc(a), EVENTS_FILE)) ? openJournal(runDirOfArc(a), a.arc) : inForce(a));

let snapshots = 0;
/** Writes `write`'s facts to the arc's log (put in force first if needed), then publishes its snapshot ref when `publish`. */
async function write(a: CorpusArc, facts: (j: OpenJournal) => void, publish = true): Promise<void> {
  const j = journalOf(a);
  try {
    facts(j);
    if (publish) {
      await runOp(j, snapshotPublishOp(a.repo), `snapshot:${a.arc}:${++snapshots}`, snapshotRequestOf({
        view: j.view, runDir: runDirOfArc(a), identity: executorIdentity(), message: `roadmap ${a.arc}: snapshot\n`,
      }));
    }
  } finally {
    j.close();
  }
}

const item = (j: OpenJournal, a: CorpusArc, reason: NeedsUserReason, blocking: boolean): NeedsUserId => raiseNeedsUser(j, runDirOfArc(a), {
  blocking, subject: { type: 'arc' }, reason, summary: reason, recommendation: 'look', options: [], evidence: [],
}, { type: 'arc' });

function checkpointInputs(j: OpenJournal, n: number): void {
  const v = j.view.planApplied()!.visionSha256!;
  j.fact({
    kind: 'checkpoint-inputs', job: jobId('ckpt', n), trigger: { type: 'audit', job: jobId('audit', 1) }, generation: 1,
    vector: { plan: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, visionSha256: v, contracts: [] }, headSha: '1'.repeat(40), visionSha256: v, findings: [], observations: [],
  } as unknown as Fact);
}

function divergence(j: OpenJournal, n: number, job: number, index: number, what: string): void {
  j.fact({
    kind: 'divergence', id: divergenceIdOf(n), index, job: jobId('ckpt', job), type: 'interpretation', from: 'V-1', what, cites: ['V-1'], evidence: ['e'],
    preimage: { planRev: 1, specs: {}, obligationsSha256: null, ledgerSha256: null, contracts: [] }, compensation: { hint: 'h', kind: 'none' },
  } as unknown as Fact);
}

/** A pack review that ended with one note, its inputs kept as the snapshot closure requires. */
function packReviewWithNote(j: OpenJournal, a: CorpusArc, claim: string): void {
  const inputs = {
    schema: PACK_REVIEW_INPUTS_SCHEMA, job: 'review-1', planRev: 1, planSha256: 'a'.repeat(64), specs: [{ unit: 'u1', sha256: 'b'.repeat(64) }],
    obligationsSha256: 'c'.repeat(64), corpusPinSha256: 'd'.repeat(64), phase0Sha256: 'e'.repeat(64), visionSha256: 'f'.repeat(64), head: '1'.repeat(40), routingRev: '0123456789abcdef',
  };
  const inputsSha256 = keepInput(runDirOfArc(a), Buffer.from(canonicalJson(inputs)), PACK_REVIEW_INPUT);
  j.fact({ kind: 'pack-review-started', job: jobId('review', 1), planRev: 1, inputsSha256, key: sha256('9'.repeat(64)) } as Fact);
  j.fact({ kind: 'pack-review-ended', job: jobId('review', 1), outcome: 'completed', findings: [{ index: 0, severity: 'note', target: { type: 'plan' }, claim, evidence: [] }] } as Fact);
}

type Chained = Readonly<{
  a1: CorpusArc;
  a2: CorpusArc;
  /** arc-2's open items by reason; arc-1's open digest (a done arc's: never acked). */
  items: Readonly<Record<'digest' | 'bound' | 'owner' | 'owed' | 'arc1Digest', NeedsUserId>>;
}>;

/**
 * Arc 1 sealed (complete) with a divergence, its amendment and an open non-blocking digest; the between-arc commit;
 * arc 2 chained over it with a Phase-0 record that curates, asks and dispositions arc 1's amendment, in force with a
 * divergence, a digest and a convergence bound (non-blocking), an owner request (blocking), an owed audit, banked debt,
 * an issue outcome and a pack-review note, its snapshot published.
 */
async function chained(): Promise<Chained> {
  const a1 = await corpusArc();
  let arc1Digest: NeedsUserId | null = null;
  const h1 = await seal(a1, {
    before: (j) => {
      checkpointInputs(j, 1);
      divergence(j, 1, 1, 0, 'trust means tested');
      j.fact({
        kind: 'corpus-amendment', id: amendmentIdOf(1), source: { type: 'divergence', divergence: divergenceIdOf(1) }, rules: [ruleId('T-2')], proposal: 'Name the tide window in every booking.', why: 'D-1', evidence: [],
      } as Fact);
      arc1Digest = item(j, a1, 'divergence-digest', false);
      j.fact({ kind: 'divergence-digest', needsUser: arc1Digest, ids: [divergenceIdOf(1)] } as Fact);
    },
  });
  betweenArc(a1.repo, h1);
  const a2 = await nextArc(a1, h1, 'arc-2');
  editPhase0(a2, (r) => ({
    ...r,
    amendments: [{ id: 'arc-1/M-1', disposition: { type: 'applied', rules: ['T-2'] } }],
    curation: [{ tier: 'structural', what: 'merged the two overviews', files: ['0010_Overview.md'], rules: ['T-1'] }],
    questions: [{ id: 'P-1', rank: 1, text: 'Is the cancellation window 24 h or 48 h?', files: ['0010_Overview.md'], bears: ['T-2'], assumption: '48 h', state: { type: 'open' } }],
  }));
  const ids: Partial<Record<keyof Chained['items'], NeedsUserId>> = { arc1Digest: arc1Digest! };
  await write(a2, (j) => {
    checkpointInputs(j, 1);
    divergence(j, 1, 1, 0, 'a berth is a slot');
    ids.digest = item(j, a2, 'divergence-digest', false);
    j.fact({ kind: 'divergence-digest', needsUser: ids.digest, ids: [divergenceIdOf(1)] } as Fact);
    ids.bound = item(j, a2, 'convergence-bound', false);
    ids.owner = item(j, a2, 'owner-request', true);
    ids.owed = item(j, a2, 'audit-owed', false);
    const what = 'Tidy the berth helpers.';
    j.fact({ kind: 'debt-banked', id: debtId('B-1'), bankReason: 'gate-note', what, key: debtKey({ unit: null, bankReason: 'gate-note', what }), source: { type: 'gate', unit: 'u1', attempt: 1, index: 0 } } as unknown as Fact);
    j.fact({ kind: 'issue-intake', job: jobId('ckpt', 1), issue: issueId('issue-1'), outcome: { type: 'none', reason: 'already planned' } } as Fact);
    packReviewWithNote(j, a2, 'the cut line is vague');
  });
  return { a1, a2, items: ids as Chained['items'] };
}

/** `roadmap brief` in process with the arcs' forge on PATH. */
const briefOf = (a: CorpusArc, ack: string | null = null) => withForge(a.forge, () => brief({ repo: a.repo, ack: ack as BriefId | null }));
async function payloadOf(a: CorpusArc): Promise<Readonly<{ id: BriefId; payload: BriefPayload; markdown: string }>> {
  const b = await briefOf(a);
  assert.equal(b.kind, 'brief');
  if (b.kind !== 'brief') throw new Error('unreachable');
  return { id: b.briefId, payload: b.payload, markdown: b.markdown };
}
const arcOf = (p: BriefPayload, arc: string) => p.arcs.find((x) => x.arc === arc)!;
/** The incoming command files of the arc's run dir, by name. */
const incoming = (a: CorpusArc): readonly string[] => {
  const dir = join(runDirOfArc(a), 'commands', 'incoming');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
const ackFiles = (a: CorpusArc): readonly string[] => (existsSync(acksDir(a.repo)) ? readdirSync(acksDir(a.repo)).sort() : []);

async function cli(a: CorpusArc, args: readonly string[], env: Readonly<Record<string, string>> = {}) {
  return runUntilExit(process.execPath, [BIN, ...args], { env: { PATH: a.forge.path, HOME: process.env['HOME'] ?? '/', ...env }, timeoutMs: 60_000 });
}

// ---------------------------------------------------------------------------------------------------

describe('roadmap brief', () => {
  it('brief.since-ack-across-arcs: everything since the last ack across every chained arc; an ack moves "since" for each; later events show alone', T, async () => {
    const { a2, items } = await chained();
    const first = await payloadOf(a2);
    const p = first.payload;
    assert.deepEqual(p.chain, { position: 2, k: 1, unackedStarts: ['arc-2'] });
    assert.deepEqual(p.arcs.map((x) => x.arc), ['arc-1', 'arc-2']);
    const one = arcOf(p, 'arc-1');
    assert.deepEqual(one.slice, { advances: ['V-1'], why: 'the first slice' }, 'the Phase-0 slice in force (Q19)');
    assert.deepEqual(arcOf(p, 'arc-2').slice, { advances: ['V-1'], why: 'the first slice' });
    assert.deepEqual(one.divergences, [{ id: 'D-1', type: 'interpretation', what: 'trust means tested' }]);
    assert.deepEqual(one.digests, [{ needsUser: items.arc1Digest, ids: ['D-1'] }]);
    assert.deepEqual(one.decisions, ['divergence D-1: interpretation: trust means tested (ckpt-1)']);
    assert.deepEqual(one.amendments, [{ id: 'arc-1/M-1', rules: ['T-2'], proposal: 'Name the tide window in every booking.' }]);
    assert.deepEqual(one.census, { held: 0, obligationRules: 1, outOfSlice: 1, untestable: 1, prodOnly: 0 });
    assert.deepEqual(one.intake, [{ issue: 'issue-1', job: null, outcome: { type: 'none', reason: 'tracked already' } }], 'arc 1\'s Phase-0 intake');
    assert.deepEqual(one.pr, { type: 'none' }, 'arc 1 integrates on main');
    const two = arcOf(p, 'arc-2');
    assert.deepEqual(two.divergences, [{ id: 'D-1', type: 'interpretation', what: 'a berth is a slot' }]);
    assert.deepEqual(two.curation, [{ tier: 'structural', what: 'merged the two overviews', files: ['0010_Overview.md'], rules: ['T-1'] }]);
    assert.deepEqual(two.questions, [{ id: 'P-1', rank: 1, text: 'Is the cancellation window 24 h or 48 h?', assumption: '48 h', state: { type: 'open' } }]);
    assert.deepEqual(two.debt, { banked: [{ id: 'B-1', what: 'Tidy the berth helpers.' }], dispositioned: [] });
    assert.deepEqual(two.intake, [
      { issue: 'issue-1', job: null, outcome: { type: 'none', reason: 'tracked already' } },
      { issue: 'issue-1', job: 'ckpt-1', outcome: { type: 'none', reason: 'already planned' } },
    ]);
    assert.deepEqual(two.packReviewNotes, [{ job: 'review-1', index: 0, claim: 'the cut line is vague' }]);
    assert.deepEqual(two.amendments, []);
    assert.deepEqual(two.pr, { type: 'none' });
    assert.deepEqual(p.items, [{ arc: 'arc-2', id: items.digest }, { arc: 'arc-2', id: items.bound }].sort((x, y) => (x.id < y.id ? -1 : 1)));

    const acked = await briefOf(a2, first.id);
    assert.equal(acked.kind, 'acked', JSON.stringify(acked));
    // After the ack: nothing new in either arc, its starts acked, its items enqueued (acked) whether applied or not.
    const after = (await payloadOf(a2)).payload;
    assert.deepEqual(after.chain.unackedStarts, []);
    assert.deepEqual(after.items, []);
    for (const x of after.arcs) {
      assert.deepEqual([x.divergences, x.digests, x.decisions, x.amendments, x.debt.banked, x.intake, x.questions, x.curation, x.packReviewNotes], [[], [], [], [], [], [], [], [], []], x.arc);
    }
    assert.deepEqual(arcOf(after, 'arc-1').census, one.census, 'the census is the ref\'s, not a delta');
    // arc 2 moves on: only what came after the ack shows, in arc 2 alone.
    await write(a2, (j) => divergence(j, 2, 1, 1, 'a tide window is an hour'));
    const later = (await payloadOf(a2)).payload;
    assert.deepEqual(arcOf(later, 'arc-2').divergences, [{ id: 'D-2', type: 'interpretation', what: 'a tide window is an hour' }]);
    assert.deepEqual(arcOf(later, 'arc-2').decisions, ['divergence D-2: interpretation: a tide window is an hour (ckpt-1)']);
    assert.deepEqual(arcOf(later, 'arc-1').divergences, []);
  });

  it('brief.coverage-vector: the last ack\'s vector alone defines each delta: events not yet in a ref are not there; refs grown after the ack show their tail; an arc absent from the vector starts at seq 0', T, async () => {
    const { a2 } = await chained();
    const first = await payloadOf(a2);
    const ref = (arc: string): Readonly<{ commit: string; highWater: number }> => {
      const commit = git(a2.repo, 'rev-parse', `refs/roadmap/${arc}`);
      const manifest = JSON.parse(git(a2.repo, 'cat-file', 'blob', `${commit}:manifest.json`)) as { highWater: number };
      return { commit, highWater: manifest.highWater };
    };
    assert.deepEqual(first.payload.coverage, ['arc-1', 'arc-2'].map((arc) => ({ arc, snapshotCommit: ref(arc).commit, highWater: ref(arc).highWater })));
    assert.equal((await briefOf(a2, first.id)).kind, 'acked');
    const marker = parseAckMarker(JSON.parse(readFileSync(join(acksDir(a2.repo), `${first.id}.json`), 'utf8')));
    assert.deepEqual([marker.coverage, marker.chainHead, marker.items], [first.payload.coverage, 'arc-2', first.payload.items]);
    const acked = await payloadOf(a2);
    // A divergence in arc 2's log but not in its ref: not in the brief, whose id is unchanged.
    await write(a2, (j) => divergence(j, 2, 1, 1, 'unpublished reading'), false);
    assert.equal((await payloadOf(a2)).id, acked.id);
    // Published: the ref grew past the vector, and its tail shows.
    await write(a2, () => undefined);
    const grown = await payloadOf(a2);
    assert.deepEqual(arcOf(grown.payload, 'arc-2').divergences, [{ id: 'D-2', type: 'interpretation', what: 'unpublished reading' }]);
    assert.deepEqual(grown.payload.coverage.find((c) => c.arc === 'arc-2'), { arc: 'arc-2', snapshotCommit: ref('arc-2').commit, highWater: ref('arc-2').highWater });
    // A later committed ack whose vector names arc 1 alone: arc 2's delta starts at seq 0 again.
    const vector = { briefId: 'f'.repeat(16), at: '2999-01-01T00:00:00.000Z', chainHead: 'arc-2', coverage: [first.payload.coverage[0]], items: [] };
    writeFileSync(join(acksDir(a2.repo), `${'f'.repeat(16)}.json`), canonicalJson(vector));
    const again = (await payloadOf(a2)).payload;
    assert.deepEqual(arcOf(again, 'arc-2').divergences.map((d) => d.id), ['D-1', 'D-2']);
    assert.deepEqual(arcOf(again, 'arc-1').divergences, []);
  });

  it('brief.payload-hash-whole / brief.ack-stale-refused: a forge change alone (a PR opened) changes the id; the old id is refused stale, writing nothing', T, async () => {
    const { a2 } = await chained();
    const before = await payloadOf(a2);
    const number = a2.forge.addPull({ head: 'harbour/arc-2', base: 'main' });
    const after = await payloadOf(a2);
    assert.notEqual(after.id, before.id);
    const pr = arcOf(after.payload, 'arc-2').pr;
    assert.ok(pr.type === 'pr' && pr.number === number && pr.state === 'open' && pr.base === 'main' && !pr.needsRebase, JSON.stringify(pr));
    // Everything else is the same payload: the id hashes the whole of it.
    assert.deepEqual({ ...after.payload, arcs: after.payload.arcs.map((x) => ({ ...x, pr: null })) }, { ...before.payload, arcs: before.payload.arcs.map((x) => ({ ...x, pr: null })) });
    assert.deepEqual(await briefOf(a2, before.id), { kind: 'stale', expected: before.id, actual: after.id });
    assert.deepEqual([ackFiles(a2), incoming(a2)], [[], []], 'a stale ack writes no marker and enqueues nothing');
    const r = await cli(a2, ['brief', '--repo', a2.repo, '--ack', before.id]);
    assert.deepEqual([r.code, JSON.parse(r.stdout)], [78, { stale: { expected: before.id, actual: after.id } }]);
  });

  it('brief.markdown-from-payload: the Markdown is rendered from the payload alone; the CLI prints it, or the payload with --json', T, async () => {
    const { a2, items } = await chained();
    const b = await payloadOf(a2);
    assert.equal(renderBrief(b.id, parseBriefPayload(JSON.parse(canonicalJson(b.payload)))), b.markdown);
    for (const text of [
      `# Roadmap brief ${b.id}`, 'chain: position 2, K 1, unacked starts: arc-2', `ack: roadmap brief --repo <repo> --ack ${b.id}`, '### arc-1', '### arc-2', 'slice: advances V-1: the first slice',
      'D-1 interpretation: a berth is a slot', '#### Questions (working assumptions)', '#1 P-1 open: Is the cancellation window 24 h or 48 h? — assuming: 48 h',
      'arc-1/M-1 (T-2): Name the tide window in every booking.', 'B-1: Tidy the berth helpers.', 'review-1#0: the cut line is vague',
      'census: 0% held (0/1 obligation rules held; 1 out of slice, 1 untestable, 0 prod-only)', `arc-2/${items.digest}`,
    ]) assert.ok(b.markdown.includes(text), `${text}\n---\n${b.markdown}`);
    // Another payload renders another text: the Markdown depends on nothing else.
    const changed = { ...b.payload, chain: { ...b.payload.chain, k: 3 } };
    assert.match(renderBrief(b.id, changed), /K 3,/);
    const md = await cli(a2, ['brief', '--repo', a2.repo]);
    assert.deepEqual([md.code, md.stdout], [0, b.markdown]);
    const json = await cli(a2, ['brief', '--repo', a2.repo, '--json']);
    assert.deepEqual([json.code, JSON.parse(json.stdout)], [0, { briefId: b.id, payload: JSON.parse(canonicalJson(b.payload)) }]);
  });

  it('brief.ack-nonblocking-only: an ack enqueues one ack per open non-blocking digest and convergence-bound item of a live arc, never a blocking item, another reason or a done arc\'s', T, async () => {
    const { a1, a2, items } = await chained();
    const b = await payloadOf(a2);
    const expected = [items.digest, items.bound].sort();
    assert.deepEqual(b.payload.items.map((i) => [i.arc, i.id]), expected.map((id) => ['arc-2', id]));
    const acked = await briefOf(a2, b.id);
    assert.equal(acked.kind, 'acked');
    if (acked.kind !== 'acked') throw new Error('unreachable');
    assert.equal(acked.commands.length, 2);
    assert.deepEqual(incoming(a2), acked.commands.map((c) => `${c}.json`));
    const bodies = acked.commands.map((c) => JSON.parse(readFileSync(incomingPath(runDirOfArc(a2), c), 'utf8')) as Json);
    assert.deepEqual(bodies.map((f) => [f['arc'], f['body']]), expected.map((id) => ['arc-2', { type: 'ack', needsUser: id, choice: null }]));
    assert.deepEqual(incoming(a1), [], 'arc 1 is done: its open digest is not acked by a brief');
    assert.ok(!bodies.some((f) => [items.owner, items.owed].includes((f['body'] as { needsUser: NeedsUserId }).needsUser)));
    // A rerun of the committed id reports the same commands and writes nothing.
    assert.deepEqual(await briefOf(a2, b.id), acked);
    assert.deepEqual(incoming(a2), acked.commands.map((c) => `${c}.json`));
    assert.deepEqual(ackFiles(a2), [`${b.id}.json`]);
  });

  for (const cell of crashCells(BRIEF_ACK)) {
    it(`brief.ack-crash-rerun @ ${cell.label}: ${cell.recovery}`, T, async () => {
      const { a2 } = await chained();
      const b = await payloadOf(a2);
      const trigger = writeTrigger(tmpDir('brief-crash'), { label: cell.label, occurrence: 1 });
      const crashed = await cli(a2, ['brief', '--repo', a2.repo, '--ack', b.id], { ROADMAP_TEST_CRASH: trigger });
      assertFired(trigger);
      assert.notEqual(crashed.code, 0);
      assert.deepEqual(ackFiles(a2), [`${b.id}.pending.json`], 'the marker is still pending');
      assert.equal(incoming(a2).length, cell.label === 'brief.ack.after-pending' ? 0 : 2);
      const marker = parseAckMarker(JSON.parse(readFileSync(join(acksDir(a2.repo), `${b.id}.pending.json`), 'utf8')));
      const ids = marker.items.map((_, i) => ackCommandId(marker.at, i));
      if (cell.label === 'brief.ack.after-enqueue') {
        // A plain brief finishes the pending marker from its bytes alone, then the ack's rerun reports it.
        assert.equal((await cli(a2, ['brief', '--repo', a2.repo])).code, 0);
        assert.deepEqual(ackFiles(a2), [`${b.id}.json`]);
      }
      const rerun = await cli(a2, ['brief', '--repo', a2.repo, '--ack', b.id]);
      assert.deepEqual([rerun.code, JSON.parse(rerun.stdout)], [0, { acked: b.id, commands: ids }]);
      assert.deepEqual(ackFiles(a2), [`${b.id}.json`]);
      assert.deepEqual(incoming(a2), ids.map((c) => `${c}.json`), 'each ack command once, under its deterministic id');
      assert.deepEqual((await payloadOf(a2)).payload.chain.unackedStarts, [], 'the committed marker acks the chain head');
    });

    it(`brief.ack-crash-start @ ${cell.label}: the next start finishes the pending marker before its rows read the acks`, T, async () => {
      const { a2 } = await chained();
      const b = await payloadOf(a2);
      const trigger = writeTrigger(tmpDir('brief-crash'), { label: cell.label, occurrence: 1 });
      const crashed = await cli(a2, ['brief', '--repo', a2.repo, '--ack', b.id], { ROADMAP_TEST_CRASH: trigger });
      assertFired(trigger);
      assert.notEqual(crashed.code, 0);
      assert.deepEqual(ackFiles(a2), [`${b.id}.pending.json`], 'the marker is still pending');
      const marker = parseAckMarker(JSON.parse(readFileSync(join(acksDir(a2.repo), `${b.id}.pending.json`), 'utf8')));
      const ids = marker.items.map((_, i) => ackCommandId(marker.at, i));
      // `roadmap start` of arc 2 (its startup checks, as the executor runs them).
      const hostDir = newHostDir();
      const out = await withForge(a2.forge, () => runChecks({
        repo: a2.repo, planFile: a2.planPath, profile: null, hostDir, env: process.env, respawn: null,
        claim: (ctx) => claimHost(ctx.hostDir, { arc: ctx.plan.arc, runDir: ctx.runDir, repo: ctx.repo, supervisor: selfIdentity() }, async () => assert.fail('no previous arc')),
      }));
      out.journal?.close();
      if (out.claim !== null) releaseHost(hostDir, out.claim);
      assert.equal(out.kind, 'passed', JSON.stringify(out.kind === 'refused' ? out.rejections : 'passed'));
      assert.deepEqual(ackFiles(a2), [`${b.id}.json`], 'start committed the marker');
      assert.deepEqual(incoming(a2), ids.map((c) => `${c}.json`), 'each ack command once, under its deterministic id');
      assert.deepEqual((await payloadOf(a2)).payload.chain.unackedStarts, [], 'the committed marker acks the chain head');
      const rerun = await cli(a2, ['brief', '--repo', a2.repo, '--ack', b.id]);
      assert.deepEqual([rerun.code, JSON.parse(rerun.stdout)], [0, { acked: b.id, commands: ids }]);
    });
  }
});

test('brief.ack-ids-ordinal: an ack command id is the marker\'s at (ms) and the item\'s ordinal (H21, R26): submission order, no collision, more than 65536 items fail loud; enqueueing is idempotent by bytes', () => {
  const at = isoTime('2026-10-03T12:00:00.000Z');
  const ms = Date.parse(at).toString(16).padStart(12, '0');
  assert.equal(ackCommandId(at, 0), `cmd-${ms}0000`);
  assert.equal(ackCommandId(at, 0x2a), `cmd-${ms}002a`);
  assert.equal(ackCommandId(at, MAX_ACK_ITEMS - 1), `cmd-${ms}ffff`);
  assert.throws(() => ackCommandId(at, MAX_ACK_ITEMS), /ordinal 65536 outside 0\.\.65535/);
  const ids = [0, 1, 2, 10, 255].map((i) => ackCommandId(at, i));
  assert.deepEqual([...ids].sort(), ids, 'ids sort in item order');
  assert.ok(ackCommandId(isoTime('2026-10-03T12:00:00.001Z'), 0) > ackCommandId(at, MAX_ACK_ITEMS - 1), 'a later marker\'s acks sort after');
  const runDir = absPath(tmpDir('brief-enqueue'));
  mkdirSync(runDir, { recursive: true });
  const file = { v: 1, id: ackCommandId(at, 0), arc: arcId('arc-2'), at, body: { type: 'ack', needsUser: needsUserId('nu-3'), choice: null } } as const;
  assert.equal(enqueueCommand(runDir, file), true);
  assert.equal(enqueueCommand(runDir, file), false, 'the same bytes are already enqueued');
  assert.throws(() => enqueueCommand(runDir, { ...file, body: { ...file.body, needsUser: needsUserId('nu-4') } }), /exists with other bytes/);
  assert.equal(commandId(file.id), file.id);
});

test('chain.status-render: the chain oldest first with previous arcs, acked starts and PRs (non-fatal), K and the unacked starts; the CLI prints it', T, async () => {
  const { a1, a2 } = await chained();
  const status = () => withForge(a2.forge, () => chainStatus({ repo: a2.repo }));
  assert.deepEqual(await status(), {
    arcs: [
      { arc: 'arc-1', previousArc: null, acked: true, pr: { type: 'none' } },
      { arc: 'arc-2', previousArc: 'arc-1', acked: false, pr: { type: 'none' } },
    ],
    k: 1, unackedStarts: ['arc-2'],
  });
  const number = a2.forge.addPull({ head: 'harbour/arc-2', base: 'main' });
  const pr = { type: 'pr', number, url: `https://forge.test/tidewater/harbour/pull/${number}`, state: 'open', base: 'main', needsRebase: false };
  assert.deepEqual((await status()).arcs[1]?.pr, pr);
  const b = await payloadOf(a2);
  assert.equal((await briefOf(a2, b.id)).kind, 'acked');
  assert.deepEqual((await status()).arcs.map((x) => x.acked), [true, true]);
  const r = await cli(a2, ['chain', 'status', '--repo', a2.repo]);
  assert.deepEqual([r.code, JSON.parse(r.stdout)], [0, JSON.parse(canonicalJson(await status()))]);
  // A forge that fails answers unavailable for each arc, never an error.
  const broken = tmpDir('broken-gh');
  writeFileSync(join(broken, 'gh'), '#!/bin/sh\necho "gh: no network" >&2\nexit 1\n');
  chmodSync(join(broken, 'gh'), 0o755);
  const down = await withForge({ ...a1.forge, path: `${broken}:${process.env['PATH'] ?? ''}` }, () => chainStatus({ repo: a2.repo }));
  assert.ok(down.arcs.every((x) => x.pr.type === 'unavailable' && /no network/.test(x.pr.reason)), JSON.stringify(down.arcs));
});
