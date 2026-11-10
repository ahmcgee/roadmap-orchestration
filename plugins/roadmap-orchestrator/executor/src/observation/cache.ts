import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { commonDirOfRun } from '../answers.ts';
import type { Run } from '../cli/locate.ts';
import { readJson } from '../core/fsx.ts';
import { EVENTS_FILE } from '../core/log.ts';
import { gitCommonDir } from '../git/git.ts';
import { runStart } from '../core/records.ts';
import { heartbeat } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { ownerState } from '../status.ts';
import { supervision } from '../watch-lease.ts';
import { observationStamp, fileStamp } from './dependencies.ts';
import { checkRunContainment } from './containment.ts';
import { Observer } from './observer.ts';
import { retryObservation } from './retry.ts';
import { type Admission, type Envelope, type ObservationData, CONSOLE_PROTOCOL, ConsoleError } from './protocol.ts';

type Cached = { observer: Observer; stable: string; volatile: string; journal: string; epoch: string; generation: number; base: ObservationData; envelope: Envelope };
/** One cursor per maintained run, bounded retained working set. All work happens on the observation worker. */
export class ObservationCache {
  readonly hostDir: AbsPath;
  readonly instance: string;
  readonly repoId: string;
  #runs = new Map<string, Cached>();
  #pinned = new Set<string>();
  pin(arc: string): void { this.#pinned.add(arc); }
  unpin(arc: string): void { this.#pinned.delete(arc); }
  constructor(hostDir: AbsPath, instance: string, repoId: string) { this.hostDir = hostDir; this.instance = instance; this.repoId = repoId; }
  read(run: Run, admission: Admission = {}): Envelope { return this.#capture(run, admission, true); }
  /** A background check yields races to the next watch/poll instead of competing with the writer. */
  maintain(run: Run): Envelope { return this.#capture(run, {}, false); }
  #capture(run: Run, admission: Admission, retry: boolean): Envelope {
    // A changing run must yield CPU to its writer. One immediate retry handles an atomic
    // rename without turning admission into two seconds of repeated cold captures.
    let c = this.#runs.get(run.runDir);
    const observer = c?.observer ?? new Observer();
    let evidenceStamp = c?.stable;
    return retryObservation((dependenciesChanged) => {
      const heart = join(run.runDir, 'heartbeat.json');
      const journalPath = join(run.runDir, EVENTS_FILE);
      const { stable: stableStamp, volatile: volatileStamp } = this.#stamps(run);
      const stable = stableStamp();
      const volatile = volatileStamp();
      const journal = fileStamp(journalPath);
      const materialize = !c || c.stable !== stable || c.journal !== journal;
      if (materialize) {
        checkRunContainment(run.runDir);
        if (evidenceStamp !== undefined && evidenceStamp !== stable) observer.invalidateEvidence();
        evidenceStamp = stable;
        const reply = observer.capture({ locator: { type: 'host' }, pinned: run, hostDir: this.hostDir, token: 0 });
        if (reply.error || !reply.display || !observer.captured) throw new ConsoleError('corruption', reply.error ?? 'no captured observation');
        const captured = observer.captured;
        const generation = observer.cursor!.generation;
        const epoch = !c || c.generation !== generation ? randomUUID() : c.epoch;
        // The derived models are copied so the observer's own caches never alias a published observation. The events are not:
        // `captured.events` is already this capture's own array, and parsed events are never mutated, so a deep copy of the
        // whole journal on every append would only cost time and memory in proportion to the log.
        const data: ObservationData = { ...structuredClone({ display: reply.display, summary: captured.summary, requests: captured.requests, plan: captured.plan }), events: captured.events,
          capture: { clock: captured.clock, foldMs: captured.foldMs, source: stable + journal, materializations: (c?.base.capture.materializations ?? 0) + 1 } };
        const at = new Date(captured.clock).toISOString();
        c = { observer, stable, volatile, journal, epoch, generation, base: data, envelope: {
          protocol: CONSOLE_PROTOCOL, instance: this.instance, repoId: this.repoId, arc: run.arc, epoch,
          highWater: reply.display.seq, revision: (c?.envelope.revision ?? 0) + 1, observedAt: at, checkedAt: at, data,
        } };
      }
      if (!c) throw new Error('observation cache did not capture');
      const now = Date.now();
      let data = c.envelope.data;
      // A heartbeat changes no immutable evidence or plan. Live elapsed times advance from the capture's clock.
      const moving = c.base.display.status.units.some((u) => u.running !== null || u.waitingFor?.tokenWaitMs != null)
        || c.base.display.invocations.some((i) => i.endedAt === null);
      if (c.volatile !== volatile || moving) {
        const base = c.base;
        const delta = now - base.capture.clock;
        const s = base.display.status;
        const runState = { ...s.run, heartbeatAt: existsSync(heart) ? heartbeat(readJson(heart), heart).at : null };
        const units = s.units.map((u) => ({ ...u,
          running: u.running === null ? null : { ...u.running, elapsed: u.running.elapsed === null ? null : u.running.elapsed + delta },
          waitingFor: u.waitingFor === null ? null : { ...u.waitingFor, ...(typeof u.waitingFor.tokenWaitMs === 'number' ? { tokenWaitMs: u.waitingFor.tokenWaitMs + delta } : {}) },
        }));
        data = { ...base, display: { ...base.display, at: new Date(now).toISOString(), status: { ...s, units, run: runState, supervision: supervision(run.runDir) },
          invocations: base.display.invocations.map((i) => i.endedAt !== null || i.quietMs === null ? i : { ...i, quietMs: i.quietMs + delta }) },
          summary: { ...base.summary, supervision: supervision(run.runDir) } };
      }
      // A race check guards a materialization against records changing under it. Without one, the cached observation was
      // already verified against `stable`, and re-stamping every record (the costliest step of an idle capture) proves nothing more.
      // The journal is not part of it: it is append-only and the observer verifies the prefix it read, so with the records unchanged
      // across the capture, the capture is exactly the arc as of that prefix (its highWater). Events appended meanwhile are the next
      // check's work. Counting them as a race discarded every capture of a live arc that appends faster than a capture takes.
      if ((materialize && stable !== stableStamp()) || volatile !== volatileStamp()) {
        dependenciesChanged();
      }
      const changed = data !== c.envelope.data;
      const envelope: Envelope = { ...c.envelope, checkedAt: new Date(now).toISOString(), data,
        revision: c.envelope.revision + (changed ? 1 : 0), observedAt: changed ? new Date(now).toISOString() : c.envelope.observedAt };
      c = { ...c, volatile, envelope };
      this.#runs.delete(run.runDir); this.#runs.set(run.runDir, c);
      while (this.#runs.size > 8 + this.#pinned.size) {
        const oldest = [...this.#runs].find(([, value]) => !this.#pinned.has(value.envelope.arc));
        if (!oldest) break;
        this.#runs.delete(oldest[0]);
      }
      return admit(envelope, admission, journalPath, observer);
    }, retry);
  }
  /** The record stamps a capture is verified against: everything it reads but the journal (stable), and the heartbeat (volatile). */
  #stamps(run: Run) {
    const startPath = join(run.runDir, 'start.json');
    const common = existsSync(startPath) ? gitCommonDir(runStart(readJson(startPath), startPath).repo) : commonDirOfRun(run.runDir);
    return {
      stable: () => observationStamp(run.runDir, common, this.hostDir) + JSON.stringify(ownerState(run.runDir, this.hostDir)),
      volatile: () => fileStamp(join(run.runDir, 'heartbeat.json')) + JSON.stringify(supervision(run.runDir)),
    };
  }
  /**
   * The observation the background checks keep current, without catching up on the journal: what a browser read is served, so
   * it never waits on a fold of the journal while the checks keep up. It stands only while its last check is recent, it reaches
   * the requested watermark, and every record it was verified against is unchanged now: it is then the arc as of its highWater,
   * and events appended since are the next check's work (a second away). Otherwise the reader catches up itself (`read`).
   */
  prepared(run: Run, admission: Admission = {}): Envelope | null {
    const c = this.#runs.get(run.runDir);
    if (!c || Date.now() - Date.parse(c.envelope.checkedAt) > PREPARED_MS || (admission.minHighWater ?? 0) > c.envelope.highWater) return null;
    const stamps = this.#stamps(run);
    if (stamps.stable() !== c.stable || stamps.volatile() !== c.volatile) return null;
    return admit(c.envelope, admission, join(run.runDir, EVENTS_FILE), c.observer);
  }
}
/** A prepared observation is current while the background check that made it is this recent (it checks every second). */
export const PREPARED_MS = 2_000;
function admit(envelope: Envelope, admission: Admission, journalPath: string, observer: Observer): Envelope {
  if (admission.epoch !== undefined && admission.epoch !== envelope.epoch) throw new ConsoleError('reset', `journal epoch changed to ${envelope.epoch}`);
  if ((admission.minHighWater ?? 0) > envelope.highWater) throw new ConsoleError('unavailable', 'requested watermark is not yet verified');
  if ((admission.revision ?? 0) > envelope.revision) throw new ConsoleError('conflict', 'requested revision is ahead of this server');
  if (admission.fence) {
    const st = statSync(journalPath);
    if (`${st.dev}:${st.ino}` !== admission.fence.identity) throw new ConsoleError('reset', 'journal fence identity changed');
    if (observer.cursor!.size < admission.fence.size) throw new ConsoleError('unavailable', 'journal fence not inspected');
  }
  return envelope;
}
