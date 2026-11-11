import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readClaim } from '../host/lock.ts';
import { locate, type Run } from '../cli/locate.ts';
import { ObserverJournal, type LogSnapshot } from '../core/log.ts';
import type { Event } from '../core/events.ts';
import type { NeedsUserRecord } from '../core/records.ts';
import { readJson } from '../core/fsx.ts';
import { runStart } from '../core/records.ts';
import { captureStatus } from '../status.ts';
import type { Status } from '../status.ts';
import { ForgeMemo, withForgeMemo } from '../commands/chain.ts';
import { summarize } from '../status/summary.ts';
import { recordOf } from '../needsuser.ts';
import { estate } from '../tui/estate.ts';
import { activityState } from '../tui/outcome.ts';
import { InvocationRelations } from '../tui/relations.ts';
import { ModelReader } from '../tui/models.ts';
import { TranscriptReader } from '../tui/transcript.ts';
import { type Display, type Entry, type Invocation, type ObserveRequest, type ObserveReply, pretty } from '../tui/types.ts';
import { InvocationTable, type OpenInvocation } from './invocations.ts';
import { type MemoWork, RecordMemo, withRecordMemo } from './memo.ts';
import type { WorkRun } from '../status-work.ts';

const FORGE_REFRESH_MS = 60_000;
const entry = (id: string, label: string, state: string, value: unknown): Entry => ({ id, label, state, body: pretty(value), links: [], provenance: 'validated runtime snapshot' });

/** What a capture is doing, for progress lines: reading journal bytes, deriving status, reading invocation rows, the estate. */
export type CapturePhase = 'journal' | 'status' | 'invocations' | 'estate';
/** What the last capture folded and read besides the memo's counts. */
export type FoldWork = Readonly<{ eventsFolded: number; rowsRead: number; deriveMs: number }>;

/** The exceptions an observation lists: a pure function of its status, its requests (in `needsUser` order) and its rows. */
export function exceptionsOf(s: Status, requests: readonly NeedsUserRecord[], rows: readonly Invocation[]): Entry[] {
  const records = new Map(requests.map((r) => [String(r.id), r]));
  return [
    ...s.needsUser.filter((n) => n.blocking).map((n) => entry(n.id, `Owner request ${n.id}: ${n.reason}`, 'waiting', records.get(String(n.id)))),
    ...s.parkedBackends.map((b) => entry(`backend:${b}`, `Parked backend ${b}`, 'parked', b)),
    ...s.host.jobQueue.filter((q) => q.pressureBlocked).map((q, i) => entry(`pressure-job:${i}`, `Pressure brake: host CPU saturated while other work holds tokens`, 'held', q)),
    ...s.holds.map((h, i) => entry(`hold:${i}`, `Hold ${pretty(h)}`, 'held', h)),
    ...s.units.filter((u) => u.state === 'blocked' || u.state === 'held' || u.state === 'parked' || u.waitingFor?.pressureBlocked || u.failures.length > 0)
      .map((u) => entry(`unit:${u.unit}`, `${u.unit}: ${u.state}${u.failures.length ? ' / recorded failures' : ''}`, u.failures.length ? 'failed' : u.state, u)),
    ...rows.filter((i) => /fault|fail|lost|malformed|refusal|stall|timeout/.test(activityState(i))).map((i) => ({ ...i, state: activityState(i), label: `${i.unit} ${i.role}: ${activityState(i)}` })),
  ];
}

/** Appended events that can change an invocation's relations (src/tui/relations.ts): only then are they read again. */
function touchesRelations(e: Event): boolean {
  if (e.type === 'fact') return ['plan-applied', 'obligation-latched', 'walk-started', 'witnessed', 'series-certified', 'smoke-ran'].includes(e.fact.kind);
  if (e.type !== 'intent' || e.kind !== 'proc.spawn') return false;
  const purpose = e.expect.subject.purpose;
  // A spawn under a job takes the milestone of that job's walk.
  return purpose === 'journey' || purpose === 'mutant' || purpose === 'bring-up' || e.parent.type === 'job';
}

export class Observer {
  captured: (ReturnType<typeof captureStatus> & { summary: ReturnType<typeof summarize>; requests: ReturnType<typeof recordOf>[] }) | null = null;
  get cursor() { return this.#journal?.cursor ?? null; }
  /** Called while a capture reads: journal bytes read of the journal's size, then invocation rows read of those due. */
  onProgress: ((phase: CapturePhase, done: number, of: number) => void) | null = null;
  #run: Run | null = null;
  #journal: ObserverJournal | null = null;
  #logs = new TranscriptReader();
  #models = new ModelReader();
  #relations = new InvocationRelations();
  #estate: { key: string; entries: Entry[] } | null = null;
  #view: LogSnapshot['view'] | null = null;
  #table: InvocationTable | null = null;
  /** How many of the journal's events the table and the relations have seen. */
  #folded = 0;
  #relationsDue = true;
  #estateChanged = false;
  #changes: Readonly<{ rows: readonly Invocation[]; estate: boolean }> = { rows: [], estate: false };
  /** Forge pull requests are re-read at most once a minute, not on every capture (see ForgeMemo). */
  #forge = new ForgeMemo(FORGE_REFRESH_MS);
  /** Immutable git answers, write-once records and parsed inputs, read once per journal (src/observation/memo.ts). */
  #memo = new RecordMemo();
  /** What the memo did since this observer was made: git spawns and record reads, with the hits that saved them. */
  get work(): Readonly<MemoWork> { return this.#memo.work; }
  /** What the last capture (successful or not) spawned and read. */
  lastWork: Readonly<MemoWork> = { gitSpawns: 0, gitHits: 0, recordReads: 0, recordHits: 0 };
  /** What the last capture (successful or not) folded from the journal, read of invocation rows, and spent deriving status. */
  lastFold: FoldWork = { eventsFolded: 0, rowsRead: 0, deriveMs: 0 };
  /** The write-once records read through the memo, each with its stamp when read: what an integrity sweep re-checks. */
  stamped(): ReadonlyMap<string, string> { return this.#memo.stamped(); }
  #lastRefresh: Readonly<{ alive: boolean; work: ReadonlyMap<string, WorkRun> }> = { alive: false, work: new Map() };

  /** The rows and whether the estate changed in the last successful capture, against the one before it. */
  changes(): Readonly<{ rows: readonly Invocation[]; estate: boolean }> { return this.#changes; }
  /** The invocations whose records the next capture reads again. */
  open(): readonly OpenInvocation[] { return this.#table?.open() ?? []; }

  /**
   * Forgets what `paths` (records found rewritten or removed) invalidate: each invocation whose directory holds one, the
   * relations when evidence changed, and the estate when a kept input changed (it reads content-addressed inputs and git blobs
   * its key already names). Every other settled invocation's row stands.
   */
  invalidate(paths: readonly string[]): void {
    if (paths.length === 0 || this.#run === null) return;
    this.#memo.forget(paths);
    const inv = join(this.#run.runDir, 'inv') + '/', inputs = join(this.#run.runDir, 'inputs'), evidence = join(this.#run.runDir, 'evidence') + '/';
    if (paths.some((path) => path === inputs || path.startsWith(inputs + '/'))) this.#estate = null;
    if (paths.some((path) => path.startsWith(evidence))) this.#relationsDue = true;
    this.#table?.invalidate(new Set(paths.filter((path) => path.startsWith(inv)).map((path) => path.slice(inv.length).split('/')[0]!)));
  }

  /**
   * Reads the open invocations' rows again without deriving status (their output streams moved; their records did not), with
   * the liveness and work metrics of the last capture. Returns the rows that changed. The next capture's `changes()` leaves them out.
   */
  refreshRows(): readonly Invocation[] {
    const table = this.#table;
    if (table === null) return [];
    const memo = this.#memo, before = { ...memo.work };
    try {
      return withRecordMemo(memo, () => {
        const changed = table.refresh(this.#lastRefresh.alive, this.#lastRefresh.work, null, { models: this.#models, logs: this.#logs });
        table.drainChanged();
        this.lastFold = { eventsFolded: 0, rowsRead: table.lastReads, deriveMs: 0 };
        return changed;
      });
    } finally { this.lastWork = { gitSpawns: memo.work.gitSpawns - before.gitSpawns, gitHits: memo.work.gitHits - before.gitHits, recordReads: memo.work.recordReads - before.recordReads, recordHits: memo.work.recordHits - before.recordHits }; }
  }

  observe(request: ObserveRequest): ObserveReply {
    try { return this.capture(request); }
    catch (error) {
      // Retain the last published model on the UI thread, never publish a partial observation.
      return { token: request.token, display: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Throw read failures intact so bounded console admission can retry transient filesystem races. */
  capture(request: ObserveRequest): ObserveReply {
    const run = request.pinned ?? (request.locator.type === 'host' && readClaim(request.hostDir) === null && this.#run !== null ? this.#run : locate(request.locator, request.hostDir));
    if (run.runDir !== this.#run?.runDir) {
      this.#run = run;
      this.#journal = new ObserverJournal(run.runDir, run.arc);
      this.#view = null;
    }
    const began = performance.now();
    const progress = this.onProgress;
    const known = this.#journal!.cursor.generation, held = this.#journal!.events;
    const snapshot = this.#journal!.read(progress === null ? undefined : (done, of) => progress('journal', done, of));
    const timing = { clock: Date.now(), foldMs: Math.round(performance.now() - began) };
    this.lastFold = { eventsFolded: snapshot.events.length - (this.#journal!.cursor.generation === known ? held : 0), rowsRead: 0, deriveMs: 0 };
    if (snapshot.view !== this.#view) {
      this.#table = new InvocationTable(run); this.#folded = 0; this.#relationsDue = true;
      this.#logs = new TranscriptReader(); this.#models = new ModelReader(); this.#relations = new InvocationRelations(); this.#estate = null; this.#view = snapshot.view;
      this.#memo = new RecordMemo();
    }
    const memo = this.#memo, before = { ...memo.work };
    try { return withRecordMemo(memo, () => this.#capture(request, run, snapshot, timing)); }
    finally { this.lastWork = { gitSpawns: memo.work.gitSpawns - before.gitSpawns, gitHits: memo.work.gitHits - before.gitHits, recordReads: memo.work.recordReads - before.recordReads, recordHits: memo.work.recordHits - before.recordHits }; }
  }

  #capture(request: ObserveRequest, run: Run, snapshot: LogSnapshot, timing: Readonly<{ clock: number; foldMs: number }>): ObserveReply {
    const table = this.#table!;
    this.onProgress?.('status', 0, 1);
    const derive = performance.now();
    const captured = withForgeMemo(this.#forge, () => captureStatus(run.runDir, run.arc, request.hostDir, snapshot, timing));
    const deriveMs = Math.round(performance.now() - derive);
    const s = captured.full;
    const events = snapshot.events;
    for (let i = this.#folded; i < events.length && !this.#relationsDue; i++) if (touchesRelations(events[i]!)) this.#relationsDue = true;
    table.extend(events, this.#folded);
    this.#folded = events.length;
    const relations = this.#relationsDue ? this.#relations.read(run.runDir, events) : null;
    const work = new Map([...s.host.work, ...s.units.flatMap((u) => u.work)].map((w) => [String(w.inv), w]));
    this.#lastRefresh = { alive: s.run.owner.state === 'alive', work };
    const progress = this.onProgress;
    table.refresh(this.#lastRefresh.alive, work, relations, { models: this.#models, logs: this.#logs }, progress === null ? undefined : (done, of) => progress('invocations', done, of));
    this.lastFold = { ...this.lastFold, rowsRead: table.lastReads, deriveMs };
    // A refresh that failed part way leaves the relations due, so every row gets them on the next one.
    this.#relationsDue = false;
    progress?.('estate', 0, 1);
    const invocations = table.sorted();
    const requests = s.needsUser.map((n) => recordOf(run.runDir, n.id));
    const startPath = join(run.runDir, 'start.json');
    const start = existsSync(startPath) ? runStart(readJson(startPath), startPath) : null;
    const estateKey = `${snapshot.view.holistic().debt.length}:${snapshot.view.planApplied()?.payloadSha256}:${snapshot.view.integrationHead()}:${s.units.map((u) => {
      const unit = snapshot.view.unit(u.unit); return `${unit.spec?.sha256}:${unit.status}`;
    }).join(',')}`;
    if (this.#estate?.key !== estateKey) { this.#estate = { key: estateKey, entries: estate(run.runDir, snapshot.view, start?.repo ?? null) }; this.#estateChanged = true; }
    const plan = this.#estate.entries.find((e) => e.id === 'plan');
    const milestoneUnits: Record<string, readonly string[]> = {};
    if (plan) {
      const parsed = JSON.parse(plan.body) as { milestones?: { id: string; units: string[] }[] };
      for (const m of parsed.milestones ?? []) milestoneUnits[m.id] = m.units;
    }
    const display: Display = { run, at: new Date().toISOString(), seq: snapshot.view.highWater(), status: s, invocations: invocations as Invocation[],
      estate: this.#estate.entries, exceptions: exceptionsOf(s, requests, invocations), milestoneUnits };
    this.captured = { ...captured, summary: summarize(captured.core, captured.events, captured.plan), requests };
    const changed = table.drainChanged();
    this.#changes = { rows: [...changed].map((id) => table.row(id)!), estate: this.#estateChanged };
    this.#estateChanged = false;
    return { token: request.token, display, error: null };
  }
}
