// Gathering for one arc, as plain synchronous logic: the console's collector worker (src/console/collector.ts) runs its loop,
// and tests drive `step` directly. A step samples what changed (src/observation/changes.ts), captures when the journal or a
// stable record moved, and publishes the change as a message: what is published is complete and says what it is as of.
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../cli/locate.ts';
import type { ArcId } from '../core/ids.ts';
import { readJson } from '../core/fsx.ts';
import { EVENTS_FILE } from '../core/log.ts';
import type { NeedsUserRecord } from '../core/records.ts';
import { heartbeat } from '../core/records.ts';
import type { AbsPath, IsoTime } from '../core/values.ts';
import type { PlanM1 } from '../input/plan.ts';
import { type OwnerState, type Status, ownerState } from '../status.ts';
import type { summarize } from '../status/summary.ts';
import type { Entry, Invocation } from '../tui/types.ts';
import { type Supervision, supervision } from '../watch-lease.ts';
import { ChangeDetector, openMoved, type Sample } from './changes.ts';
import { checkContained, checkRunContainment } from './containment.ts';
import { stampOf } from './memo.ts';
import { type CapturePhase, Observer } from './observer.ts';
import { ConsoleError, type ConsoleCode } from './protocol.ts';

export type CollectorPhase = 'load' | CapturePhase | 'idle';
/** What one capture did: product telemetry, in the console's behind line and `server.stats(arc)`. */
export type CaptureWork = Readonly<{ eventsFolded: number; rowsRead: number; statCalls: number; recordReads: number; gitSpawns: number; deriveMs: number; captureMs: number }>;
export type JournalPosition = Readonly<{ identity: string; offset: number; size: number; seq: number }>;
export type Summary = ReturnType<typeof summarize>;
export type CollectorMessage =
  /** Toward main: what the collector is doing (`done` of `of` units of the phase). */
  | Readonly<{ kind: 'progress'; arc: ArcId; phase: CollectorPhase; done: number; of: number; at: number }>
  /** A verified journal prefix, sent as soon as the fold reaches it, so the serve worker parses it alongside the capture. */
  | Readonly<{ kind: 'journal'; arc: ArcId; epoch: string; identity: string; offset: number }>
  /** One capture: the arc as of `asOf` or newer. `estate` null: unchanged since the previous observation. `rows`: new or changed rows. */
  | Readonly<{ kind: 'observation'; arc: ArcId; epoch: string; asOf: number; clock: number; foldMs: number; journal: JournalPosition;
      run: Run; status: Status; summary: Summary; plan: PlanM1 | null; requests: readonly NeedsUserRecord[];
      milestoneUnits: Record<string, readonly string[]>; estate: readonly Entry[] | null; rows: readonly Invocation[]; work: CaptureWork }>
  /** Open invocations' rows read again because their output moved; the journal position and status stand. */
  | Readonly<{ kind: 'rows'; arc: ArcId; epoch: string; asOf: number; rows: readonly Invocation[]; work: CaptureWork }>
  /** Nothing newer than the published observation as of `at`: the volatile overlay as it is now. */
  | Readonly<{ kind: 'checked'; arc: ArcId; at: number; heartbeatAt: IsoTime | null; supervision: Supervision; owner: OwnerState }>
  /** A capture failed for a reason other than a race: reads of the arc answer this until a capture succeeds. */
  | Readonly<{ kind: 'failed'; arc: ArcId; at: number; error: Readonly<{ code: ConsoleCode; message: string }> }>
  | Readonly<{ kind: 'log'; message: string }>;

/** How long the loop sleeps: a second, 100 ms after a poke, never closer to a capture than its floor (150 ms or half its time). */
export const COLLECT = { idleMs: 1_000, pokeMs: 100, floorMs: 150, rowsMs: 5_000, sweepMs: 20, racesBeforeLog: 5 } as const;

/** The integrity sweep: write-once records re-stamped against their read-time stamp, and the run walked for escaping symlinks. */
class Sweep {
  readonly #runDir: string;
  #root: string | null = null;
  #records: [string, string][] = [];
  #at = 0;
  #walk: string[] = [];
  constructor(runDir: string) { this.#runDir = runDir; }
  /**
   * Re-checks the next slice of `stamped` for `budgetMs`, then walks the next slice of the run directory for `budgetMs`.
   * Returns the records found rewritten or removed, and the entries found escaping the run.
   */
  step(stamped: ReadonlyMap<string, string>, budgetMs: number): Readonly<{ found: string[]; escapes: string[] }> {
    const found: string[] = [], escapes: string[] = [];
    const recordsUntil = performance.now() + budgetMs;
    if (this.#at >= this.#records.length) { this.#records = [...stamped]; this.#at = 0; }
    while (this.#at < this.#records.length && performance.now() < recordsUntil) {
      const [path, stamp] = this.#records[this.#at++]!;
      if (stamped.get(path) === stamp && stampOf(path) !== stamp) found.push(path);
    }
    const walkUntil = performance.now() + budgetMs;
    if (!existsSync(this.#runDir)) return { found, escapes };
    this.#root ??= realpathSync(this.#runDir);
    while (performance.now() < walkUntil) {
      if (this.#walk.length === 0) this.#walk = [this.#runDir];
      const path = this.#walk.pop()!;
      try { checkContained(this.#root, path, this.#walk); }
      catch (error) { if (!(error instanceof ConsoleError)) throw error; escapes.push(path); }
      if (this.#walk.length === 0) break;
    }
    return { found, escapes };
  }
}
const errorOf = (error: unknown): Readonly<{ code: ConsoleCode; message: string }> =>
  ({ code: error instanceof ConsoleError ? error.code : 'corruption', message: error instanceof Error ? error.message : String(error) });

export class ArcCollector {
  readonly run: Run;
  readonly #hostDir: AbsPath;
  readonly #emit: (m: CollectorMessage) => void;
  readonly #observer = new Observer();
  readonly #changes: ChangeDetector;
  readonly #sweep: Sweep;
  /** The sample the published observation is as of. */
  #published: Sample | null = null;
  /** The last sample a capture failed on (not a race): it is not tried again until something moves. */
  #failedOn: Sample | null = null;
  #failure: Readonly<{ code: ConsoleCode; message: string }> | null = null;
  #epoch = '';
  #epochGeneration = -1;
  #poked = false;
  #floorUntil = 0;
  #rowsAt = 0;
  #races = 0;
  /** Records the sweep found rewritten or removed since the last capture. */
  #rewritten: string[] = [];
  /** Entries the sweep found escaping the run: every capture checks them again, and fails while one still escapes. */
  #escapes = new Set<string>();
  /** Journal events folded by captures that did not publish (a race, a failure): the next published capture counts them. */
  #folded = 0;
  constructor(run: Run, hostDir: AbsPath, common: AbsPath, emit: (m: CollectorMessage) => void) {
    this.run = run; this.#hostDir = hostDir; this.#emit = emit;
    this.#changes = new ChangeDetector(run.runDir, common, hostDir);
    this.#sweep = new Sweep(run.runDir);
  }
  /** A watched path changed, or a strict read asked for a check: the next step runs as soon as the floor allows. Returns the delay. */
  poke(now: number): number { this.#poked = true; return Math.max(COLLECT.pokeMs, this.#floorUntil - now); }
  /** One iteration. Returns how long the loop may sleep (ms). Never throws for a race. */
  step(now: number): number {
    this.#poked = false;
    let captured = false;
    try {
      // The integrity sweep first, so what it finds is captured in this step.
      if (this.#published !== null) {
        const { found, escapes } = this.#sweep.step(this.#observer.stamped(), COLLECT.sweepMs);
        this.#rewritten.push(...found, ...escapes);
        for (const path of escapes) this.#escapes.add(path);
      }
      const sample = this.#changes.sample(this.#observer.open());
      const published = this.#published;
      const differs = (before: Sample) => sample.journal !== before.journal || sample.stable !== before.stable || openMoved(before, sample);
      const moved = published === null || this.#rewritten.length > 0 || differs(published);
      const retry = this.#failedOn === null || this.#rewritten.length > 0 || differs(this.#failedOn);
      if (moved && retry) captured = this.#capture(sample, now);
      // Failed on this very sample: nothing moved since, so the failure stands as of now.
      else if (moved) this.#emit({ kind: 'failed', arc: this.run.arc, at: now, error: this.#failure! });
      else if (sample.output !== published!.output && now - this.#rowsAt >= COLLECT.rowsMs) this.#rows(sample, now);
      else this.#checked(now);
    } catch (error) {
      // A file that moved while a sample or the overlay read it is a race: the next step looks again.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#emit({ kind: 'failed', arc: this.run.arc, at: now, error: errorOf(error) });
    }
    this.#emit({ kind: 'progress', arc: this.run.arc, phase: 'idle', done: 0, of: 0, at: Date.now() });
    const sleep = this.#poked || this.#rewritten.length > 0 ? COLLECT.pokeMs : COLLECT.idleMs;
    return Math.max(sleep, captured ? this.#floorUntil - Date.now() : 0);
  }
  #capture(sample: Sample, now: number): boolean {
    const o = this.#observer, cold = this.#published === null;
    // Records a sample saw change, and records the sweep found rewritten, are read again; every other row and record stands.
    o.invalidate([...sample.changed.filter((path) => !path.endsWith(`/${EVENTS_FILE}`)), ...this.#rewritten]);
    this.#rewritten = [];
    const began = performance.now();
    let phaseAt = 0;
    const identity = sample.journal.split(':').slice(0, 2).join(':');
    o.onProgress = (phase, done, of) => {
      if (phase === 'journal') {
        this.#assignEpoch();
        this.#emit({ kind: 'journal', arc: this.run.arc, epoch: this.#epoch, identity, offset: o.cursor!.offset });
      }
      const at = Date.now();
      if (done === 0 || at - phaseAt >= 1_000) { phaseAt = at; this.#emit({ kind: 'progress', arc: this.run.arc, phase, done, of, at }); }
    };
    let reply;
    try {
      if (cold) { this.#emit({ kind: 'progress', arc: this.run.arc, phase: 'load', done: 0, of: 1, at: Date.now() }); checkRunContainment(this.run.runDir); }
      else if (this.#escapes.size > 0) {
        const root = realpathSync(this.run.runDir);
        for (const path of this.#escapes) checkContained(root, path, []);
      }
      reply = o.capture({ locator: { type: 'host' }, pinned: this.run, hostDir: this.#hostDir, token: 0 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The journal events this attempt folded stay folded: the next published capture's work counts them.
      this.#folded += o.lastFold.eventsFolded;
      if (code === 'ENOENT') {
        // A record moved while it was read: the cursor and the rows stand, and the next step tries again.
        if (++this.#races === COLLECT.racesBeforeLog) this.#emit({ kind: 'log', message: `console collector for arc ${this.run.arc}: ${COLLECT.racesBeforeLog} captures in a row raced a writer (${(error as NodeJS.ErrnoException).path ?? (error as Error).message}); the last observation stands` });
        return false;
      }
      this.#failedOn = sample; this.#failure = errorOf(error);
      this.#emit({ kind: 'failed', arc: this.run.arc, at: now, error: this.#failure });
      return false;
    } finally { o.onProgress = null; }
    const captureMs = Math.round(performance.now() - began);
    this.#races = 0; this.#failedOn = null; this.#escapes.clear();
    this.#assignEpoch();
    const display = reply.display!, captured = o.captured!, changes = o.changes(), cursor = o.cursor!;
    this.#emit({ kind: 'observation', arc: this.run.arc, epoch: this.#epoch, asOf: now, clock: captured.clock, foldMs: captured.foldMs,
      journal: { identity: cursor.identity, offset: cursor.offset, size: cursor.size, seq: display.seq }, run: this.run,
      status: display.status, summary: captured.summary, plan: captured.plan, requests: captured.requests, milestoneUnits: display.milestoneUnits,
      estate: cold || changes.estate ? display.estate : null, rows: cold ? display.invocations : changes.rows,
      work: { ...o.lastFold, eventsFolded: o.lastFold.eventsFolded + this.#folded, statCalls: sample.statCalls, recordReads: o.lastWork.recordReads, gitSpawns: o.lastWork.gitSpawns, captureMs } });
    this.#folded = 0;
    this.#published = sample; this.#rowsAt = now;
    this.#floorUntil = Date.now() + Math.max(COLLECT.floorMs, captureMs / 2);
    return true;
  }
  #rows(sample: Sample, now: number): void {
    const began = performance.now();
    const rows = this.#observer.refreshRows();
    this.#published = { ...this.#published!, output: sample.output }; this.#rowsAt = now;
    if (rows.length === 0) { this.#checked(now); return; }
    const o = this.#observer;
    this.#emit({ kind: 'rows', arc: this.run.arc, epoch: this.#epoch, asOf: now, rows,
      work: { ...o.lastFold, statCalls: sample.statCalls, recordReads: o.lastWork.recordReads, gitSpawns: o.lastWork.gitSpawns, captureMs: Math.round(performance.now() - began) } });
  }
  #checked(now: number): void {
    const path = join(this.run.runDir, 'heartbeat.json');
    const heartbeatAt = existsSync(path) ? heartbeat(readJson(path), path).at : null;
    this.#emit({ kind: 'checked', arc: this.run.arc, at: now, heartbeatAt, supervision: supervision(this.run.runDir), owner: ownerState(this.run.runDir, this.#hostDir) });
  }
  /** A new epoch when the journal cursor reset (replacement, truncation, a changed prefix, a corrupt line). */
  #assignEpoch(): void {
    const generation = this.#observer.cursor!.generation;
    if (generation !== this.#epochGeneration) { this.#epoch = randomUUID(); this.#epochGeneration = generation; }
  }
}
