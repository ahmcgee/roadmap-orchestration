// The concurrent crash matrix (M2 plan "Recovery and crash safety under concurrency", F20; G8): fake-backed M2
// arcs through the real supervised `roadmap start` (test/fixtures/cm-common.ts, on the whole-pipeline harness of
// test/fixtures/pm-common.ts), where the stepping unit A walks every whole-pipeline boundary label while its peer
// B is pinned in one of six states: a live build runner, a live judgment runner, a lane holding estate#1, a
// teardown, waiting for the publication slot (in memory only), or a retryable residue park.
//
// Enumeration: a recording run of each scenario (pm-record.ts, which records the unit each call site passes)
// lists the (label, unit, occurrence) triples its executor reached. A must reach exactly its row's labels. Then
// each cell crashes one of A's occurrences: the selector names A (`{label, unit: 'u1', occurrence}`), so only A's
// calls count. Startup and recovery occurrences are not crashed here (their labels are listed in
// CONCURRENT_EXCLUDED_LABELS; the whole-pipeline and recovery rows crash them).
//
// Sampling: as the whole-pipeline matrix does, each label at A's occurrence 1, and 2 where A reaches it more
// than once.
//
// Each crashed run asserts:
//   attribution  from the log at the crash (read while the supervisor is stopped): A's records in it are
//                exactly as many as the recording's at that occurrence, the last is the recording's, and the op
//                cut short (the record in flight, for a log append's label) is A's at the recorded stage;
//   the peer     pinned as its scenario says at the crash, and its oracle at the end (below);
//   the arc      ends as the recorded run did (the oracle: tree, provenance, one publication per unit, every
//                stage outcome, usage per invocation, no open intent), each backend step called once, one
//                crash; A's recovery trace is the whole-pipeline one for the label (pm-trace.ts), and the
//                peer's is adoption of whatever it had open.
//
// Peer oracles: build: its runner adopted (or re-adapted) and consumed once, each unit's workload intervals
// disjoint; judgment: the same, consumed against its recorded judgment-inputs; lane: adopted, the lanes
// reservation cleaned by a teardown bound to estate#1, no instance with two owners; teardown: adopted and run
// to its end, never killed; publication: one holder at a time, and each grant after a release goes to the
// best-ranked waiter (no claim of the uncrashed order); residue: the respawn is not refused, the park's
// outstanding targets and nextProbeAt unchanged.
//
// Also the named tests recover.no-duplicate-writer and residue.own-arc-respawn, at executor level.
//
// M3 (B8): the concurrent job rows (test/fixtures/cm-holistic.ts), where a job steps while units are in flight: an
// audit job and a checkpoint's bundle activation while two units are pinned in live builds, a repair batch's
// publication while a third unit is pinned in its live build, and a rule's docs publication preempting a unit's
// candidate. A job's crash points pass no unit, so each cell crashes the occurrence the
// recording attributes to the job (by its log's records: `sampleJob`), and asserts the op it hit: the log at the crash
// holds exactly the recording's records of that op's owner (the job, the command, or u1 for the preempting kill), the
// last one the same. The audit, bundle and batch rows then assert the peers' builds open at the crash and adopted once, and the arc's end
// as recorded (outcomes, product, every call once, the holistic records); the preempt row asserts safety (one slot
// holder at a time, the rule applied once with one docs ff, u1 published once onto the recorded tree).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, after, test } from 'node:test';
import { type Event, type IntentOf, type Parent, parseEventLine, prevHash, recordUnit } from '../src/core/events.ts';
import { INTEGRATION_SLOT, arcId, invocationId, parseInvocationId, unitId } from '../src/core/ids.ts';
import type { JournalView } from '../src/core/interfaces.ts';
import type { LogSnapshot } from '../src/core/log.ts';
import { Fold } from '../src/core/state.ts';
import { absPath } from '../src/core/values.ts';
import type { ExitReason } from '../src/executor.ts';
import { ownArcResidue, readResidues, undispositioned } from '../src/host/residues.ts';
import { requirePlanInForce } from '../src/input/inforce.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { resourceTable } from '../src/resources/reserve.ts';
import { runnerFiles } from '../src/runner/files.ts';
import { nextStage, rankOf } from '../src/schedule/ready.ts';
import { compareRank } from '../src/schedule/types.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { instanceDir, maxConcurrentOwners } from './helpers/estate.ts';
import { type Owner, assertNoSurvivors } from './helpers/reap.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import {
  type Boundary, CONCURRENT_AUDIT, CONCURRENT_BUILD, CONCURRENT_BUNDLE, CONCURRENT_EXCLUDED_LABELS, CONCURRENT_JUDGMENT, CONCURRENT_LANE, CONCURRENT_PREEMPT,
  CONCURRENT_BATCH, CONCURRENT_PUBLICATION, CONCURRENT_RESIDUE, CONCURRENT_TEARDOWN, crashCells,
} from './matrix.ts';
import {
  type Trace, UNCRASHED, assertOracle, needsUserExactly, noModelIds, oracleRun, outcomesOf, productTree, provenance, publicationsPerUnit, recoveryTrace,
  snapshotVerifies, unitStates, usagePerInvocation,
} from './oracle.ts';
import { HOLISTIC_PEERS, type HolisticPeer, type JobRow, STEPPING, layoutHolisticConcurrent, sampleJob } from './fixtures/cm-holistic.ts';
import { type Sampled, capturesInsideRevisions, describeRecord, holisticProduct, holisticRecords, ownerOf } from './fixtures/pm-holistic.ts';
import { A, B, C, type Concurrent, type Peer, PEERS, layoutConcurrent } from './fixtures/cm-common.ts';
import { type ExecRun, journalOf } from './fixtures/exec-common.ts';
import { type Hook, type Laid, callsMatchSteps, finalReason, supervisedRun } from './fixtures/pm-common.ts';
import { BATCH_TRACE, LABEL_TRACE, appendTrace, inRevisionAt } from './fixtures/pm-trace.ts';
import { startCli, startLine, startedGenerations, stateOf } from './fixtures/sup-common.ts';

after(assertNoSurvivors);

/** Supervised runs at once, as the whole-pipeline matrix runs them. */
const CONCURRENCY = 16;
const CELL = { timeout: 360_000 };

const ROWS: Readonly<Record<Peer, string>> = {
  build: CONCURRENT_BUILD, judgment: CONCURRENT_JUDGMENT, lane: CONCURRENT_LANE, teardown: CONCURRENT_TEARDOWN,
  publication: CONCURRENT_PUBLICATION, residue: CONCURRENT_RESIDUE,
};
/** The labels whose record is in flight when they fire: the crash leaves it out of the log. */
const IN_FLIGHT: readonly string[] = ['log.append.before-write', 'log.append.after-partial-write'];
/** What recovery may do to a pinned peer's open runner: adopt it, or re-adapt its exit.json once it exited. */
const PEER_RECOVERY = ['adopted', 'redone'] as const;

// ---------------------------------------------------------------------------------------------------
// Reading a log

const eventUnit = (view: JournalView, e: Event): string | undefined => recordUnit(e, (op) => view.latestIntent(op));

function parentStage(view: JournalView, p: Parent): string | null {
  if (p.type === 'stage') return p.stage;
  if (p.type === 'op') return parentStage(view, view.latestIntent(p.op).parent);
  return null;
}

/** The stage a record belongs to: its op's, a fact's own, or its invocation's; null for arc-level records. */
function eventStage(view: JournalView, e: Event): string | null {
  switch (e.type) {
    case 'intent':
      return parentStage(view, e.parent);
    case 'done':
    case 'abort':
      return parentStage(view, view.latestIntent(e.op).parent);
    case 'fact': {
      const f = e.fact as Readonly<{ stage?: unknown; inv?: unknown }>;
      if (typeof f.stage === 'string') return f.stage;
      if (typeof f.inv === 'string') return parentStage(view, view.latestIntent(parseInvocationId(f.inv as never).op).parent);
      return null;
    }
  }
}

type Described = Readonly<{ record: string; unit: string | null; stage: string | null }>;
const describe = (view: JournalView, e: Event): Described => ({
  record: e.type === 'fact' ? `fact ${e.fact.kind}` : e.type === 'abort' ? 'abort' : `${e.type} ${e.kind}`,
  unit: eventUnit(view, e) ?? null,
  stage: eventStage(view, e),
});

const eventsOf = (snap: LogSnapshot, unit: string): readonly Event[] => snap.events.filter((e) => eventUnit(snap.view, e) === unit);

/** The log's fold after `seq` (the view the executor had then), folded again from the file. */
function viewAt(r: ExecRun, seq: number): JournalView {
  const fold = new Fold(arcId(r.arc));
  const lines = readFileSync(join(r.runDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
  for (const line of lines.slice(0, seq)) fold.apply(parseEventLine(line), prevHash(Buffer.from(`${line}\n`, 'utf8')));
  return fold;
}

const spawnsOf = (snap: LogSnapshot): readonly (Event & IntentOf<'proc.spawn'>)[] =>
  snap.events.filter((e): e is Event & IntentOf<'proc.spawn'> => e.type === 'intent' && e.kind === 'proc.spawn');
const subjectUnit = (i: IntentOf<'proc.spawn'>): string | null => {
  const s = i.expect.subject;
  return 'unit' in s ? s.unit : null;
};
const openSpawns = (snap: LogSnapshot, unit: string): readonly IntentOf<'proc.spawn'>[] =>
  snap.view.openIntents().flatMap((i) => (i.kind === 'proc.spawn' && subjectUnit(i) === unit ? [i] : []));
const invOf = (i: IntentOf<'proc.spawn'>) => invocationId(i.op, i.ordinal);
const filesOf = (r: ExecRun, i: IntentOf<'proc.spawn'>) => runnerFiles(invocationDir(absPath(r.runDir), invOf(i)), invOf(i));

/**
 * No duplicate writer: each unit's workloads (every spawn whose subject names it) ran one at a time, from its
 * spawn intent to its runner's quiescence.
 */
function assertWorkloadsDisjoint(r: ExecRun, snap: LogSnapshot, unit: string): void {
  const intervals = spawnsOf(snap).filter((i) => subjectUnit(i) === unit).flatMap((i) => {
    const exit = filesOf(r, i).read('exit.json');
    return exit === null ? [] : [{ inv: invOf(i), start: Date.parse(i.at), end: Date.parse(exit.quiescedAt) }];
  }).sort((a, b) => a.start - b.start);
  for (let k = 1; k < intervals.length; k++) {
    const [prev, next] = [intervals[k - 1]!, intervals[k]!];
    assert.ok(next.start >= prev.end, `${unit}: ${next.inv} started before ${prev.inv} quiesced: two writers of one unit`);
  }
}

/** Per unit, at most one stage attempt open at any point of the log (one task per unit). */
function assertOneAttemptPerUnit(snap: LogSnapshot): void {
  const open = new Map<string, Set<number>>();
  const closed = new Set<string>();
  for (const e of snap.events) {
    if (e.type === 'intent' && e.parent.type === 'stage' && !closed.has(`${e.parent.unit}#${e.parent.attempt}`)) {
      const set = open.get(e.parent.unit) ?? new Set<number>();
      set.add(e.parent.attempt);
      open.set(e.parent.unit, set);
      assert.ok(set.size <= 1, `unit ${e.parent.unit} has attempts ${[...set].join(', ')} open at seq ${e.seq}`);
    }
    if (e.type === 'fact' && e.fact.kind === 'stage-outcome') {
      open.get(e.fact.unit)?.delete(e.fact.attempt);
      closed.add(`${e.fact.unit}#${e.fact.attempt}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// References

/** One of A's crash-point occurrences in the recording: how many of A's records were durable then. */
type Reached = Readonly<{ occurrence: number; aRecords: number }>;

type Reference = Readonly<{
  peer: Peer;
  reached: ReadonlyMap<string, readonly Reached[]>;
  snap: LogSnapshot;
  aRecords: readonly Event[];
  reason: ExitReason;
  tree: string;
  outcomes: Readonly<Record<string, readonly string[]>>;
}>;

/**
 * The recording file's executor lines, as A's occurrences. Every append that fsyncs carries its record's unit,
 * so counting A's `log.append.after-fsync` lines gives how many of A's records the log held at each point.
 */
function readReached(file: string): ReadonlyMap<string, readonly Reached[]> {
  const out = new Map<string, Reached[]>();
  const pids = new Set<string>();
  let aRecords = 0;
  for (const line of readFileSync(file, 'utf8').split('\n').filter((l) => l !== '')) {
    const [script, pid, label, unit] = line.split(' ') as [string, string, string, string];
    if (script !== 'executor.ts') continue;
    pids.add(pid);
    if (unit !== A) continue;
    if (label === 'log.append.after-fsync') aRecords += 1;
    const list = out.get(label) ?? [];
    list.push({ occurrence: list.length + 1, aRecords });
    out.set(label, list);
  }
  assert.equal(pids.size, 1, 'an uncrashed run has one executor');
  return out;
}

const baselineOf = (r: ExecRun): string => (JSON.parse(readFileSync(r.planPath, 'utf8')) as { baseline: string }).baseline;
const unitsOf = (peer: Peer): readonly string[] => (peer === 'publication' ? [A, B, C] : [A, B]);

async function reference(t: Owner, peer: Peer): Promise<Reference> {
  const c = layoutConcurrent(t, peer);
  const { r } = c.laid;
  const record = join(tmpDir('cm-record'), 'record');
  await supervisedRun(c.laid, { record, keyed: true });
  const snap = journalOf(r);
  const run = oracleRun(absPath(r.repo), absPath(r.runDir), arcId(r.arc));
  const ref: Reference = {
    peer,
    reached: readReached(record),
    snap,
    aRecords: eventsOf(snap, A),
    reason: finalReason(r),
    tree: git(r.repo, 'rev-parse', 'main^{tree}'),
    outcomes: Object.fromEntries(unitsOf(peer).map((u) => [u, outcomesOf(run, u)])),
  };
  assert.deepEqual(ref.reason, { kind: 'complete', units: unitsOf(peer).map((u) => ({ result: 'merged', unit: u })) }, `${peer}: the uncrashed run completes`);
  const aReached = [...ref.reached.values()].flat();
  assert.equal(Math.max(...aReached.map((x) => x.aRecords)), ref.aRecords.length, `${peer}: every record of A is counted by its append`);
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 }, `${peer}: every step called once`);
  assertOracle(run, expectedEnd(ref, r, UNCRASHED));
  // A walked beside its pinned peer: its first record comes after the edge the watcher resolved on the pin.
  const edge = snap.events.find((e) => e.type === 'fact' && e.fact.kind === 'edge-resolved' && e.fact.edge === 'a-go');
  assert.ok(edge !== undefined && ref.aRecords[0]!.seq > edge.seq, `${peer}: A starts once B is pinned`);
  peerReference(ref, c);
  return ref;
}

/** What `r`'s run must end as: the reference's end (its tree, outcomes), on `r`'s own baseline, with `trace`. */
function expectedEnd(ref: Reference, r: ExecRun, trace: Trace) {
  return {
    integration: 'main', baseline: baselineOf(r), tree: ref.tree,
    units: Object.fromEntries(unitsOf(ref.peer).map((u) => [u, 'merged' as const])), outcomes: ref.outcomes, needsUser: [], trace,
  };
}

/** What each reference shows of its peer beyond the oracle. */
function peerReference(ref: Reference, c: Concurrent): void {
  const { r } = c.laid;
  if (ref.peer === 'lane') {
    // A took estate#2 while B held estate#1.
    const lanes = spawnsOf(ref.snap).filter((i) => i.expect.subject.purpose === 'lane' && i.expect.subject.lane === 'estate-a');
    assert.deepEqual(lanes.map((i) => filesOf(r, i).read('launch.json')?.env['RESOURCE_INSTANCE_ESTATE']), ['2'], 'A\'s estate lane took estate#2');
  }
  // The rank check bites: after C's publication, B (waiting since its gate) is granted before A (since its own).
  if (ref.peer === 'publication') assert.ok(assertPublicationSafe(r, ref.snap) > 0, 'a grant was ranked against a waiter');
  if (ref.peer === 'residue') {
    const b = ref.outcomes[B]!;
    assert.ok(b.includes('teardown:cleanup-failed') && b.includes('teardown:released'), 'B parked on its teardown and ran it again once the park recovered');
  }
}

// ---------------------------------------------------------------------------------------------------
// The peer at the crash, and its oracle at the end

type AtCrash = Readonly<{ snap: LogSnapshot; residues: readonly string[] }>;

/** Asserts B's pinned state in the log at the crash; returns the peer invocation the crash left open, if any. */
function peerAtCrash(peer: Peer, crash: AtCrash): IntentOf<'proc.spawn'> | null {
  const { snap } = crash;
  const open = openSpawns(snap, B);
  const one = (what: string, match: (i: IntentOf<'proc.spawn'>) => boolean): IntentOf<'proc.spawn'> => {
    assert.equal(open.length, 1, `B has one invocation open at the crash: ${what}`);
    assert.ok(match(open[0]!), `B's open invocation is ${what}: ${JSON.stringify(open[0]!.expect.subject)}`);
    return open[0]!;
  };
  const s = (i: IntentOf<'proc.spawn'>) => i.expect.subject;
  switch (peer) {
    case 'build':
      return one('its build', (i) => s(i).purpose === 'backend' && (s(i) as { role: string }).role === 'build');
    case 'judgment': {
      const gate = one('its gate', (i) => s(i).purpose === 'backend' && (s(i) as { role: string }).role === 'gate');
      assert.ok(gate.parent.type === 'stage' && snap.view.judgmentInputs(unitId(B), 'gate', gate.parent.attempt) !== null, 'the gate\'s judgment-inputs are durable');
      return gate;
    }
    case 'lane': {
      const lane = one('its estate lane', (i) => s(i).purpose === 'lane' && (s(i) as { lane: string }).lane === 'estate-b');
      const e = resourceTable(snap.view).get('estate#1' as never)?.status;
      assert.ok(e !== undefined && e.state !== 'free' && 'unit' in e.holder && e.holder.unit === B, `estate#1 is held by B: ${JSON.stringify(e)}`);
      return lane;
    }
    case 'teardown':
      return one('its teardown of slow', (i) => s(i).purpose === 'teardown' && (s(i) as { resource: string }).resource === 'slow');
    case 'publication': {
      assert.deepEqual(open, [], 'B waits in memory: nothing of it is open');
      if (approvedIn(snap, A)) return null;
      const slot = resourceTable(snap.view).get(INTEGRATION_SLOT)?.status;
      assert.ok(slot !== undefined && slot.state !== 'free' && slot.holder.type === 'publication' && slot.holder.unit === C, `C holds the slot: ${JSON.stringify(slot)}`);
      assert.deepEqual(nextStage(snap.view.unit(unitId(B)), false), { kind: 'admission', stage: 'candidate' }, 'B waits for its candidate\'s slot');
      return openSpawns(snap, C)[0] ?? null;
    }
    case 'residue': {
      assert.deepEqual(open, [], 'B has nothing open in its park');
      const u = snap.view.unit(unitId(B));
      assert.equal(u.status, 'park-pending');
      assert.deepEqual(u.park?.park, { class: 'retryable', targets: [{ type: 'resource', instance: 'estate#1' }] });
      assert.deepEqual(u.park?.passed, []);
      assert.equal(crash.residues.length, 1, 'B\'s residue is undisposed in the host index');
      return null;
    }
  }
}

/** Whether `unit`'s gate had approved in `snap` (the publication pin is released then). */
const approvedIn = (snap: LogSnapshot, unit: string): boolean =>
  snap.events.some((e) => e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.unit === unit && e.fact.stage === 'gate' && e.fact.outcome === 'approve');

function peerEnd(peer: Peer, r: ExecRun, crash: AtCrash, pinnedInv: IntentOf<'proc.spawn'> | null, end: LogSnapshot): void {
  const crashSeq = crash.snap.events.at(-1)!.seq;
  const doneOf = (i: IntentOf<'proc.spawn'>) => end.view.doneOf(i.op);
  if (pinnedInv !== null) {
    const done = doneOf(pinnedInv);
    assert.ok(done !== null && (PEER_RECOVERY as readonly (string | null)[]).includes(done.recoveredBy), `the pinned ${pinnedInv.op} was adopted or re-adapted: ${JSON.stringify(done)}`);
  }
  for (const u of unitsOf(peer)) assertWorkloadsDisjoint(r, end, u);
  const bCalls = readCalls(r.scenarioPath).filter((c) => c.unit === B);
  switch (peer) {
    case 'build':
      assert.equal(bCalls.filter((c) => c.as === 'codex').length, 1, 'B\'s build called once');
      assert.equal(spawnsOf(end).filter((i) => subjectUnit(i) === B && i.expect.subject.purpose === 'backend' && (i.expect.subject as { role: string }).role === 'build').length, 1, 'B\'s build spawned once');
      return;
    case 'judgment': {
      assert.equal(bCalls.filter((c) => c.as === 'claude').length, 2, 'B\'s plan-check and gate, each called once');
      const gate = pinnedInv!.parent;
      if (gate.type !== 'stage') throw new Error('the gate is a stage op');
      const { attempt } = gate;
      const inputs = end.view.judgmentInputs(unitId(B), 'gate', attempt);
      const approval = end.events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'approval' && e.fact.unit === B && e.fact.attempt === attempt ? [e.fact] : []));
      assert.ok(inputs !== null && inputs.head !== null, 'recorded inputs with a head');
      assert.equal(approval.length, 1, 'one approval of the pinned gate');
      assert.equal(approval[0]!.fingerprint.unitCommit, inputs.head, 'the approval binds the recorded head');
      for (const c of approval[0]!.fingerprint.contractRevs) {
        assert.equal(c.blob, git(r.repo, 'rev-parse', `${inputs.tip}:${c.path}`), `${c.path} at the recorded tip`);
      }
      return;
    }
    case 'lane': {
      const held = resourceTable(crash.snap.view).get('estate#1' as never)!.status;
      if (held.state === 'free') throw new Error('estate#1 was held at the crash');
      const cleaned = end.events.some((e) => e.seq > crashSeq && e.type === 'intent' && e.kind === 'resource.transition'
        && JSON.stringify(e.expect.holder) === JSON.stringify(held.holder) && e.expect.edge.type === 'release' && e.expect.resources.includes('estate#1' as never));
      assert.ok(cleaned, 'the lanes reservation B held at the crash is released after it');
      const teardowns = spawnsOf(end).filter((i) => i.seq > crashSeq && subjectUnit(i) === B && i.expect.subject.purpose === 'teardown' && (i.expect.subject as { resource: string }).resource === 'estate#1');
      assert.ok(teardowns.length >= 1, 'B\'s estate#1 torn down after the crash');
      for (const i of [pinnedInv!, ...teardowns]) {
        const env = filesOf(r, i).read('launch.json')?.env;
        assert.equal(env?.['RESOURCE_INSTANCE_ESTATE'], '1', `${invOf(i)} is bound to estate#1`);
        assert.equal(env?.['RESOURCE_OWNER'], `${r.arc}/${B}`, `${invOf(i)} is B's`);
      }
      for (const n of [1, 2]) assert.ok(maxConcurrentOwners(instanceDir(r.stateDir, 'estate', n)) <= 1, `estate#${n} never had two owners`);
      return;
    }
    case 'teardown': {
      const inv = invOf(pinnedInv!);
      const result = filesOf(r, pinnedInv!).read('result.json');
      assert.ok(result?.type === 'command' && result.verdict === 'pass', `the teardown ran to its end and passed: ${JSON.stringify(result)}`);
      assert.equal(filesOf(r, pinnedInv!).read('exit.json')?.cause, 'exited', 'the teardown exited on its own');
      assert.deepEqual(end.view.opsOf('proc.kill').filter((k) => k.expect.inv === inv), [], 'the teardown was never killed');
      return;
    }
    case 'publication':
      void assertPublicationSafe(r, end);
      return;
    case 'residue': {
      assert.deepEqual(startedGenerations(r), [1, 2], 'the respawn started: its own residue did not refuse it');
      // The park only changes by a probe fact: just before the first one after the crash it is as the crash left it.
      const park = crash.snap.view.unit(unitId(B)).park!;
      const probes = end.events.filter((e) => e.seq > crashSeq && e.type === 'fact' && e.fact.kind === 'probe');
      assert.ok(probes.length > 0, 'B\'s park is probed again, and recovers');
      const before = viewAt(r, probes[0]!.seq - 1).unit(unitId(B)).park;
      assert.deepEqual([before?.seq, before?.park, before?.passed], [park.seq, park.park, park.passed], 'the restart left the park and its outstanding targets as they were');
      // nextProbeAt: no probe before it, but one a `resume` command runs (inside its command.apply op).
      const nextAt = crash.snap.events.flatMap((e) => (e.type === 'fact' && e.fact.kind === 'probe' ? [e.fact.nextProbeAt] : [])).at(-1);
      assert.ok(nextAt !== undefined && nextAt !== null, 'the failed probe before the crash set the next one');
      const commands = end.events.flatMap((e) => (e.type === 'intent' && e.kind === 'command.apply' ? [{ from: e.seq, to: end.events.find((d) => d.type === 'done' && d.op === e.op)?.seq ?? Infinity }] : []));
      const early = probes.filter((e) => Date.parse(e.at) < Date.parse(nextAt) && !commands.some((w) => e.seq > w.from && e.seq < w.to));
      assert.deepEqual(early.map((e) => e.seq), [], 'no probe of the park before its nextProbeAt but a resume\'s');
      const dispositions = readResidues(absPath(r.hostDir)).filter((l) => l.type === 'disposition');
      assert.equal(dispositions.length, 1, 'the residue is disposed once, when the park recovers');
      return;
    }
  }
}

/**
 * Publication safety: the slot has one holder at a time, and each grant of it after a release goes to the
 * best-ranked unit among those whose wait for it began before that release (so they were queued for it),
 * ranked as the arbiter ranks, on the log as it stood before the grant. Returns how many waiters a grant was
 * ranked against.
 */
function assertPublicationSafe(r: ExecRun, snap: LogSnapshot): number {
  const slot = snap.events.filter((e): e is Event & IntentOf<'resource.transition'> =>
    e.type === 'intent' && e.kind === 'resource.transition' && e.expect.resources.includes(INTEGRATION_SLOT));
  let holder: string | null = null;
  /** Each grant with the seq of the release before it (0 for the first). */
  const grants: { grant: Event & IntentOf<'resource.transition'>; released: number }[] = [];
  let released = 0;
  for (const e of slot) {
    const h = JSON.stringify(e.expect.holder);
    if (e.expect.edge.type === 'reserve') {
      assert.equal(holder, null, `seq ${e.seq}: the slot granted to ${h} while ${holder} holds it`);
      holder = h;
      grants.push({ grant: e, released });
    } else if (e.expect.edge.type === 'release') {
      assert.equal(h, holder, `seq ${e.seq}: the slot released by ${h}, not its holder ${holder}`);
      holder = null;
      released = e.seq;
    }
  }
  const waitsForSlot = (view: JournalView, plan: Parameters<typeof rankOf>[1], u: string, before: number): boolean => {
    const next = nextStage(view.unit(unitId(u)), false);
    return next?.kind === 'admission' && next.stage === 'candidate' && rankOf(view, plan, unitId(u)).waitStartSeq < before;
  };
  let compared = 0;
  for (const { grant: g, released: before } of grants) {
    if (before === 0) continue;
    const grantee = g.expect.holder.type === 'stage' || g.expect.holder.type === 'publication' ? g.expect.holder.unit : null;
    if (grantee === null) continue;
    const view = viewAt(r, g.seq - 1);
    const plan = requirePlanInForce(absPath(r.runDir), view).plan;
    const waiting = plan.units.map((u) => u.id).filter((u) => u !== grantee && waitsForSlot(view, plan, u, before));
    for (const w of waiting) {
      assert.ok(compareRank(rankOf(view, plan, unitId(grantee)), rankOf(view, plan, w)) < 0, `seq ${g.seq}: the slot granted to ${grantee}, ranked below ${w}, which waited for it`);
      compared += 1;
    }
  }
  return compared;
}

// ---------------------------------------------------------------------------------------------------
// A crash cell

type CellOptions = Readonly<{ hooks?: (r: ExecRun) => readonly Hook[]; check?: (r: ExecRun, crash: AtCrash, end: LogSnapshot) => void | Promise<void> }>;

/** Trace entries per unit: the recoveredBy values of the dones of that unit's ops. */
function recoveredBy(snap: LogSnapshot): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const e of snap.events) {
    if (e.type !== 'done' || e.recoveredBy === null) continue;
    const u = eventUnit(snap.view, e) ?? '-';
    out.set(u, [...(out.get(u) ?? []), `${e.kind}:${e.recoveredBy}`]);
  }
  return out;
}

async function crashCell(t: Owner, ref: Reference, label: string, occurrence: number, opts: CellOptions = {}): Promise<void> {
  const at = ref.reached.get(label)?.[occurrence - 1];
  if (at === undefined) throw new Error(`${ref.peer}: A never reached ${label}#${occurrence}`);
  const c = layoutConcurrent(t, ref.peer);
  const { r } = c.laid;
  const laid: Laid = { ...c.laid, hooks: [...c.laid.hooks, ...(opts.hooks?.(r) ?? [])] };
  const trigger = writeTrigger(tmpDir('cm-trigger'), { label, occurrence, unit: A });
  let crash: AtCrash | null = null;
  await supervisedRun(laid, {
    trigger, keyed: true,
    whileDown: (x) => void (crash = { snap: journalOf(x), residues: undispositioned(absPath(x.hostDir)).map((k) => JSON.stringify(k)) }),
  });
  assertFired(trigger);
  if (crash === null) throw new Error('the crash was not observed while the executor was down');
  const atCrash = crash as AtCrash;

  // Attribution: the log at the crash holds A's records up to the recorded point, and the op cut short is A's.
  const aAt = eventsOf(atCrash.snap, A);
  assert.equal(aAt.length, at.aRecords, `the log at the crash holds ${at.aRecords} records of A, as the recording had at ${label}#${occurrence}`);
  if (at.aRecords > 0) assert.deepEqual(describe(atCrash.snap.view, aAt.at(-1)!), describe(ref.snap.view, ref.aRecords[at.aRecords - 1]!), 'A\'s last record at the crash is the recording\'s');
  const inFlight = IN_FLIGHT.includes(label);
  const crashed = ref.aRecords[inFlight ? at.aRecords : at.aRecords - 1]!;
  const op = describe(ref.snap.view, crashed);
  assert.equal(op.unit, A, `the crashed op is A's: ${JSON.stringify(op)}`);
  assert.equal(op.stage, stageOf(ref, label, occurrence), 'the crashed op is at the recorded stage');
  const pinned = peerAtCrash(ref.peer, atCrash);

  // The end: one crash, the recorded end, every call once, A's trace and the peer's.
  assert.equal(stateOf(r).crashes.length, 1, 'one executor crash, which the supervisor restarted');
  assert.deepEqual(finalReason(r), ref.reason);
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 }, 'every backend call matched its step once: no completed call made twice');
  const aTrace = label.startsWith('log.append.') ? appendTrace(label, crashed) : LABEL_TRACE[label];
  if (aTrace === undefined) throw new Error(`no recovery trace is declared for ${label}`);
  const end = journalOf(r);
  const by = recoveredBy(end);
  const aBy = (by.get(A) ?? []).map((x) => x.split(':')[1]!);
  for (const v of aBy) assert.ok((aTrace.recoveredBy as readonly string[]).includes(v), `A's op recovered ${v}; ${label} allows ${aTrace.recoveredBy.join('|') || 'nothing'}: ${by.get(A)?.join(', ')}`);
  if (aTrace.required) assert.ok(aBy.length > 0, `A's cut-short op is recovered (${aTrace.recoveredBy.join('|')})`);
  const peerOpen = atCrash.snap.view.openIntents().some((i) => i.kind === 'proc.spawn' && subjectUnit(i) !== A);
  for (const [u, values] of by) {
    if (u === A) continue;
    for (const v of values) assert.ok(peerOpen && (PEER_RECOVERY as readonly string[]).includes(v.split(':')[1]!), `${u}: recovered ${v}, but only a pinned peer's open runner is adopted`);
  }
  const trace: Trace = {
    recoveredBy: [...new Set([...aTrace.recoveredBy, ...(peerOpen ? PEER_RECOVERY : [])])],
    required: aTrace.required || peerOpen,
    tailDiscarded: aTrace.tailDiscarded,
  };
  assertOracle(oracleRun(absPath(r.repo), absPath(r.runDir), arcId(r.arc)), expectedEnd(ref, r, trace));
  peerEnd(ref.peer, r, atCrash, pinned, end);
  await opts.check?.(r, atCrash, end);
}

/** The stage of A's op cut short at (label, occurrence), from the recording's log. */
function stageOf(ref: Reference, label: string, occurrence: number): string | null {
  const at = ref.reached.get(label)![occurrence - 1]!;
  return describe(ref.snap.view, ref.aRecords[IN_FLIGHT.includes(label) ? at.aRecords : at.aRecords - 1]!).stage;
}

// ---------------------------------------------------------------------------------------------------

type CellSpec = Readonly<{ name: string; run: (t: TestContext) => Promise<void> }>;

const rowLabels = (peer: Peer): readonly string[] => [...new Set(crashCells(ROWS[peer]).map((c) => c.label))].sort();
const boundaryOf = (peer: Peer, label: string): Boundary => crashCells(ROWS[peer]).find((c) => c.label === label)!.boundary;

function cellsOf(ref: Reference): readonly CellSpec[] {
  return rowLabels(ref.peer).flatMap((label) => {
    const count = ref.reached.get(label)?.length ?? 0;
    return (count >= 2 ? [1, 2] : [1]).map((occurrence) => ({
      name: `${ref.peer} ${boundaryOf(ref.peer, label)} ${label}@${A}#${occurrence} (${stageOf(ref, label, occurrence) ?? 'arc'})`,
      run: (t) => crashCell(t, ref, label, occurrence),
    }));
  });
}

test('concurrent crash matrix', { concurrency: CONCURRENCY, timeout: 45 * 60_000 }, async (t) => {
  const started = Date.now();
  const [refs, jobRefs] = await Promise.all([Promise.all(PEERS.map((peer) => reference(t, peer))), Promise.all(HOLISTIC_PEERS.map((peer) => jobReference(t, peer)))]);

  // Enumeration: A reached exactly its row's labels, and every excluded label is a start's or recovery's.
  for (const ref of refs) {
    assert.deepEqual([...ref.reached.keys()].filter((l) => !(l in CONCURRENT_EXCLUDED_LABELS)).sort(), rowLabels(ref.peer), `${ref.peer}: the labels A reached are its row's`);
  }
  const byPeer = new Map(refs.map((ref) => [ref.peer, ref]));
  const named: readonly CellSpec[] = [
    { name: 'recover.no-duplicate-writer', run: (c) => noDuplicateWriter(c, byPeer.get('build')!) },
    { name: 'residue.own-arc-respawn', run: (c) => ownArcRespawn(c, byPeer.get('residue')!) },
  ];
  // The job rows: each row's sampled labels are exactly its matrix labels.
  const jobs = new Map(jobRefs.map((ref) => [ref.peer, ref]));
  const jobCellSpecs = JOB_ROW_NAMES.flatMap((row) => {
    const ref = jobs.get(JOB_PEER[row])!;
    const sampled = sampleJob(row, ref.recordText, ref.snap);
    assert.deepEqual([...new Set(sampled.map((c) => c.label))].sort(), jobRowLabels(row), `${row}: the sampled labels are the row's`);
    return sampled.map((c): CellSpec => ({
      name: `${row} ${jobBoundaryOf(row, c.label)} ${c.label}#${c.occurrence} (${c.owner})`,
      run: (x) => jobCell(x, ref, row, c),
    }));
  });
  const cells = [...refs.flatMap(cellsOf), ...named, ...jobCellSpecs];
  await Promise.all(cells.map((c) => t.test(c.name, CELL, c.run)));
  t.diagnostic(`${cells.length} cells in ${Math.round((Date.now() - started) / 1000)} s: ${refs.map((r) => `${r.peer} ${cellsOf(r).length}`).join(', ')}, jobs ${jobCellSpecs.length}`);
});

// ---------------------------------------------------------------------------------------------------
// The concurrent job rows (M3 B8)

const JOB_ROWS: Readonly<Record<JobRow, string>> = { audit: CONCURRENT_AUDIT, bundle: CONCURRENT_BUNDLE, batch: CONCURRENT_BATCH, preempt: CONCURRENT_PREEMPT };
const JOB_ROW_NAMES: readonly JobRow[] = ['audit', 'bundle', 'batch', 'preempt'];
/** The scenario each job row steps in. */
const JOB_PEER: Readonly<Record<JobRow, HolisticPeer>> = { audit: 'jobs', bundle: 'jobs', batch: 'batch', preempt: 'preempt' };
/** The units whose build is live while the scenario's job steps. */
const LIVE_BUILDS: Readonly<Record<HolisticPeer, readonly string[]>> = { jobs: [A, B], batch: [C], preempt: [] };
/** The needs-user items every run of the scenario raises: the applied bundle's divergence digest. */
const JOB_NEEDS_USER: Readonly<Record<HolisticPeer, readonly string[]>> = { jobs: ['divergence-digest'], batch: [], preempt: [] };
const jobRowLabels = (row: JobRow): readonly string[] => [...new Set(crashCells(JOB_ROWS[row]).map((c) => c.label))].sort();
const jobBoundaryOf = (row: JobRow, label: string): Boundary => crashCells(JOB_ROWS[row]).find((c) => c.label === label)!.boundary;
/** The scenario's units in plan order (the batch scenario admits its repair units after u3). */
const jobUnits = (peer: HolisticPeer): readonly string[] => (peer === 'jobs' ? [A, B] : peer === 'batch' ? [C, A, B] : [A]);

type JobReference = Readonly<{
  peer: HolisticPeer; recordText: string; snap: LogSnapshot; reason: ExitReason; repo: string; tree: string; outcomes: Readonly<Record<string, readonly string[]>>;
}>;

/** The docs ffs published in a log. */
const docsFfs = (snap: LogSnapshot): number => snap.events.filter((e) => {
  if (e.type !== 'done' || e.kind !== 'integration.ff' || e.outcome.kind !== 'published') return false;
  const i = snap.view.latestIntent(e.op);
  return i.kind === 'integration.ff' && i.expect.subject?.type === 'docs';
}).length;
/** The commands applied in a log. */
const commandsApplied = (snap: LogSnapshot): number => snap.events.filter((e) => e.type === 'done' && e.kind === 'command.apply' && e.outcome.kind === 'applied').length;

async function jobReference(t: Owner, peer: HolisticPeer): Promise<JobReference> {
  const c = layoutHolisticConcurrent(t, peer);
  const { r } = c.laid;
  const record = join(tmpDir('cm-record'), 'record');
  await supervisedRun(c.laid, { record, keyed: true });
  const snap = journalOf(r);
  const run = oracleRun(absPath(r.repo), absPath(r.runDir), arcId(r.arc));
  const ref: JobReference = {
    peer, recordText: readFileSync(record, 'utf8'), snap, reason: finalReason(r), repo: r.repo, tree: git(r.repo, 'rev-parse', 'main^{tree}'),
    outcomes: Object.fromEntries(jobUnits(peer).map((u) => [u, outcomesOf(run, u)])),
  };
  assert.deepEqual(ref.reason, { kind: 'complete', units: jobUnits(peer).map((u) => ({ result: 'merged', unit: u })) }, `${peer}: the uncrashed run completes`);
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 }, `${peer}: every step called once`);
  const units = Object.fromEntries(jobUnits(peer).map((u) => [u, 'merged' as const]));
  assertOracle(run, { integration: 'main', baseline: baselineOf(r), tree: ref.tree, units, outcomes: ref.outcomes, needsUser: JOB_NEEDS_USER[peer], trace: UNCRASHED });
  if (peer !== 'preempt') {
    // The stepping jobs ran while the peers' builds were live.
    const stepping = JOB_ROW_NAMES.filter((row) => JOB_PEER[row] === peer).map((row) => `job:${STEPPING[row as keyof typeof STEPPING]}`);
    const window = snap.events.filter((e) => stepping.includes(ownerOf(snap.view, e)));
    const builds = spawnsOf(snap).filter((i) => LIVE_BUILDS[peer].includes(subjectUnit(i) ?? '') && i.expect.subject.purpose === 'backend' && (i.expect.subject as { role: string }).role === 'build');
    assert.equal(builds.length, LIVE_BUILDS[peer].length);
    for (const b of builds) {
      const done = snap.events.find((e) => e.type === 'done' && e.op === b.op)!;
      assert.ok(b.seq < window[0]!.seq && done.seq > window.at(-1)!.seq, `${subjectUnit(b)}'s build was live through ${stepping.join(' and ')}`);
    }
    if (peer === 'jobs') assert.ok(snap.events.some((e) => e.type === 'fact' && e.fact.kind === 'plan-applied' && e.fact.source?.type === 'bundle'), 'ckpt-1 applied its bundle');
    if (peer === 'batch') {
      const ffs = snap.view.opsOf('integration.ff').filter((i) => i.expect.subject?.type === 'batch');
      assert.equal(ffs.length, 1, 'u1 and u2 published as one batch');
      assert.equal(snap.view.holistic().findings.find((f) => f.id === 'F-1')?.state, 'resolved', 'the batch resolved F-1');
    }
  } else {
    assert.equal(ref.outcomes[A]!.filter((o) => o === 'candidate:preempted').length, 1, 'u1\'s candidate was preempted');
    assert.deepEqual([docsFfs(snap), commandsApplied(snap)], [1, 1], 'the rule applied once with one docs ff');
  }
  return ref;
}

/** Each owner's recovered dones, as `kind:recoveredBy`. */
function recoveredByOwner(snap: LogSnapshot): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const e of snap.events) {
    if (e.type !== 'done' || e.recoveredBy === null) continue;
    const o = ownerOf(snap.view, e);
    out.set(o, [...(out.get(o) ?? []), `${e.kind}:${e.recoveredBy}`]);
  }
  return out;
}

/**
 * One job row cell: the scenario crashed at the sampled occurrence (no unit selector: the recording attributed it to
 * the job), then the op it hit (the owner's records at the crash), the peers at the crash, and the end.
 */
async function jobCell(t: Owner, ref: JobReference, row: JobRow, c: Sampled): Promise<void> {
  const hc = layoutHolisticConcurrent(t, ref.peer);
  const { r } = hc.laid;
  const trigger = writeTrigger(tmpDir('cm-trigger'), { label: c.label, occurrence: c.occurrence });
  let atCrash: LogSnapshot | null = null;
  await supervisedRun(hc.laid, { trigger, keyed: true, whileDown: (x) => void (atCrash = journalOf(x)) });
  assertFired(trigger);
  if (atCrash === null) throw new Error('the crash was not observed while the executor was down');
  const crash = atCrash as LogSnapshot;

  // The op the crash hit: its owner's records at the crash are the recording's up to it.
  const owned = (snap: LogSnapshot) => snap.events.filter((e) => ownerOf(snap.view, e) === c.owner);
  const mine = owned(crash);
  assert.equal(mine.length, c.ownerRecords, `the log at the crash holds ${c.ownerRecords} records of ${c.owner}, as the recording had at ${c.label}#${c.occurrence} (${row})`);
  if (c.ownerRecords > 0) assert.equal(describeRecord(crash, mine.at(-1)!), describeRecord(ref.snap, owned(ref.snap)[c.ownerRecords - 1]!), `${c.owner}'s last record at the crash is the recording's`);

  // The peers at the crash.
  const crashSeq = crash.events.at(-1)!.seq;
  if (ref.peer !== 'preempt') {
    for (const u of LIVE_BUILDS[ref.peer]) {
      const open = openSpawns(crash, u);
      assert.ok(open.length === 1 && open[0]!.expect.subject.purpose === 'backend' && (open[0]!.expect.subject as { role: string }).role === 'build', `${u}'s build is live at the crash`);
    }
  } else {
    const kill = crash.events.find((e): e is Event & IntentOf<'proc.kill'> => e.type === 'intent' && e.kind === 'proc.kill' && e.expect.reason === 'preempt');
    assert.ok(kill !== undefined, 'the preempting kill of u1\'s candidate lane is in the log at the crash');
    const lane = crash.view.latestIntent(parseInvocationId(kill.expect.inv).op);
    assert.ok(lane.kind === 'proc.spawn' && lane.expect.subject.purpose === 'lane' && lane.expect.subject.unit === A && lane.expect.subject.set === 'suite', 'it kills u1\'s candidate suite lane');
  }

  // The end.
  assert.equal(stateOf(r).crashes.length, 1, 'one executor crash, which the supervisor restarted');
  assert.deepEqual(finalReason(r), ref.reason);
  const m = callsMatchSteps(r);
  assert.deepEqual(m, { steps: m.steps, calls: m.steps, unmatched: 0 }, 'every backend call matched its step once: no completed call made twice');
  const end = journalOf(r);
  const run = oracleRun(absPath(r.repo), absPath(r.runDir), arcId(r.arc));
  for (const u of jobUnits(ref.peer)) assertWorkloadsDisjoint(r, end, u);
  const units = Object.fromEntries(jobUnits(ref.peer).map((u) => [u, 'merged' as const]));
  if (ref.peer === 'preempt') {
    // Safety: the crash may let the candidate go green before the publication (its pin released by the restart).
    const verdicts = [
      productTree(run, 'main', ref.tree), provenance(run, 'main', baselineOf(r)), publicationsPerUnit(run, { [A]: 1 }), snapshotVerifies(run),
      unitStates(run, units), needsUserExactly(run, []), usagePerInvocation(run), noModelIds(run),
      recoveryTrace(run, { recoveredBy: ['reconciled', 'redone', 'adopted'], required: false, tailDiscarded: c.label === 'log.append.after-partial-write' }),
    ];
    assert.deepEqual(verdicts.filter((v) => !v.pass), []);
    assert.deepEqual([docsFfs(end), commandsApplied(end)], [1, 1], 'the rule applied once with one docs ff');
    assert.ok(outcomesOf(run, A).filter((o) => o === 'candidate:preempted').length <= 1, 'u1 preempted at most once');
    void assertPublicationSafe(r, end);
    return;
  }
  // The job's recovery is the label's (a log append's: the record's), the peers' the adoption of their live builds.
  const cut = ref.snap.events[c.seq - 1]!;
  const label = c.label.startsWith('log.append.') ? appendTrace(c.label, cut, inRevisionAt(ref.snap.events, cut.seq)) : (row === 'batch' ? BATCH_TRACE[c.label] : undefined) ?? LABEL_TRACE[c.label];
  if (label === undefined) throw new Error(`no recovery trace is declared for ${c.label}`);
  const by = recoveredByOwner(end);
  const jobBy = [...by].filter(([o]) => !o.startsWith('unit:')).flatMap(([, v]) => v.map((x) => x.split(':')[1]!));
  for (const v of jobBy) assert.ok((label.recoveredBy as readonly string[]).includes(v), `the job's op recovered ${v}; ${c.label} allows ${label.recoveredBy.join('|') || 'nothing'}: ${JSON.stringify([...by])}`);
  if (label.required) assert.ok(jobBy.length > 0, `the job's cut-short op is recovered (${label.recoveredBy.join('|')})`);
  const peers = LIVE_BUILDS[ref.peer];
  for (const [o, values] of by) {
    const u = o.slice('unit:'.length);
    if (o.startsWith('unit:') && !peers.includes(u)) assert.fail(`${u}: recovered ${values.join(', ')}, but it had no live build at the crash`);
  }
  for (const u of peers) {
    for (const v of by.get(`unit:${u}`) ?? []) assert.ok(v.startsWith('proc.spawn:') && (PEER_RECOVERY as readonly string[]).includes(v.split(':')[1]!), `${u}: recovered ${v}, but only its live build is adopted`);
    const builds = spawnsOf(end).filter((i) => subjectUnit(i) === u && i.expect.subject.purpose === 'backend' && (i.expect.subject as { role: string }).role === 'build');
    assert.equal(builds.length, 1, `${u}'s build spawned once`);
    const done = end.view.doneOf(builds[0]!.op);
    assert.ok(done !== null && done.recoveredBy !== null && (PEER_RECOVERY as readonly string[]).includes(done.recoveredBy), `${u}'s build, live at the crash, adopted or re-adapted once: ${JSON.stringify(done)}`);
    assert.ok(builds[0]!.seq < crashSeq, `${u}'s build is the one live at the crash`);
  }
  const trace: Trace = { recoveredBy: [...new Set([...label.recoveredBy, ...PEER_RECOVERY])], required: true, tailDiscarded: label.tailDiscarded };
  assertOracle(run, { integration: 'main', baseline: baselineOf(r), tree: git(r.repo, 'rev-parse', 'main^{tree}'), units, outcomes: ref.outcomes, needsUser: JOB_NEEDS_USER[ref.peer], trace });
  assert.deepEqual(holisticProduct(r.repo), holisticProduct(ref.repo), 'the product as uncrashed, and the same renderings');
  assert.deepEqual(holisticRecords(end), holisticRecords(ref.snap), 'the holistic layer\'s records as uncrashed');
  assert.deepEqual(capturesInsideRevisions(end.events), [], 'no input capture inside an open revision.commit (H2)');
}

// ---------------------------------------------------------------------------------------------------
// Named tests

/**
 * recover.no-duplicate-writer: A's build and B's build both live when the executor dies (A crashed right after
 * its build's runner started). While the restarted executor recovers, a second `roadmap start` is refused
 * host-busy (the host lock and handshake); both runners are adopted (or re-adapted), each once; every backend
 * call is made once (completed calls consumed with their recorded inputs); each unit's workloads ran one at a
 * time; and each unit had at most one stage attempt open at any point (one task per unit).
 */
async function noDuplicateWriter(t: Owner, ref: Reference): Promise<void> {
  // A's launch.after-spawn occurrence whose last record is its build's spawn intent: the build's runner started.
  const buildAt = ref.aRecords.findIndex((e) => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'backend' && e.expect.subject.role === 'build') + 1;
  const occurrence = ref.reached.get('launch.after-spawn')?.find((x) => x.aRecords === buildAt)?.occurrence;
  if (buildAt === 0 || occurrence === undefined) throw new Error('the recording has no launch of A\'s build');
  let refused: Awaited<ReturnType<typeof startCli>> | null = null;
  await crashCell(t, ref, 'launch.after-spawn', occurrence, {
    hooks: (r) => [{
      name: 'second-start', when: () => startedGenerations(r).length >= 2 && refused === null, act: async () => void (refused = await startCli(r, [])),
    }],
    check: (r, crash, end) => {
      const open = crash.snap.view.openIntents().filter((i): i is IntentOf<'proc.spawn'> => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'backend');
      assert.deepEqual(open.map((i) => [subjectUnit(i), (i.expect.subject as { role: string }).role]).sort(), [[A, 'build'], [B, 'build']], 'both builds were live at the crash');
      for (const i of open) assert.ok((PEER_RECOVERY as readonly (string | null)[]).includes(end.view.doneOf(i.op)?.recoveredBy ?? null), `${i.op} adopted or re-adapted once`);
      assert.ok(refused !== null, 'a second start was tried while the arc ran');
      const second = refused as Awaited<ReturnType<typeof startCli>>;
      assert.equal(second.code, 75, 'a second start is refused while the supervisor lives: never two executors');
      assert.equal(startLine(second).kind, 'refused');
      assertOneAttemptPerUnit(end);
      for (const u of [A, B]) assertWorkloadsDisjoint(r, end, u);
    },
  });
}

/**
 * residue.own-arc-respawn: the executor dies (at A's first spawn) while B's residue on estate#1 is undisposed
 * in the host index. The supervisor's respawn is not refused: the arc's own log proves the residue is its own
 * (A9); the park is kept as it was and recovers only through its probe.
 */
async function ownArcRespawn(t: Owner, ref: Reference): Promise<void> {
  await crashCell(t, ref, 'spawn.after-intent', 1, {
    check: (r, crash) => {
      const keys = undispositioned(absPath(r.hostDir));
      assert.deepEqual(keys, [], 'disposed by the end');
      assert.equal(crash.residues.length, 1, 'undisposed at the crash');
      const key = JSON.parse(crash.residues[0]!) as Parameters<typeof ownArcResidue>[1];
      assert.equal(key.unit, B);
      assert.ok(ownArcResidue(crash.snap.view, key), 'the arc\'s own log proves it owns the residue');
      assert.deepEqual(startedGenerations(r), [1, 2], 'the respawn started');
    },
  });
}

