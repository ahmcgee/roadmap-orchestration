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
import { dependencyStamp, fileStamp } from './dependencies.ts';
import { checkRunContainment } from './containment.ts';
import { Observer } from './observer.ts';
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
  read(run: Run, admission: Admission = {}): Envelope {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const startPath = join(run.runDir, 'start.json');
      const common = existsSync(startPath) ? gitCommonDir(runStart(readJson(startPath), startPath).repo) : commonDirOfRun(run.runDir);
      const heart = join(run.runDir, 'heartbeat.json');
      const watch = join(run.runDir, 'watch.lease.json');
      const journalPath = join(run.runDir, EVENTS_FILE);
      const paths = [run.runDir, join(common, 'roadmap-runtime'), join(common, 'roadmap'), join(common, 'refs'), join(common, 'packed-refs'), join(common, 'HEAD'), this.hostDir];
      const excluded = new Set([heart, watch, journalPath]);
      const stable = dependencyStamp(paths, excluded) + JSON.stringify(ownerState(run.runDir, this.hostDir));
      const volatile = fileStamp(heart) + JSON.stringify(supervision(run.runDir));
      const journal = fileStamp(journalPath);
      let c = this.#runs.get(run.runDir);
      const observer = c?.observer ?? new Observer();
      const materialize = !c || c.stable !== stable || c.journal !== journal;
      if (materialize) {
        checkRunContainment(run.runDir);
        if (c && c.stable !== stable) observer.invalidateEvidence();
        const reply = observer.observe({ locator: { type: 'host' }, pinned: run, hostDir: this.hostDir, token: 0 });
        if (reply.error || !reply.display || !observer.captured) throw new ConsoleError('corruption', reply.error ?? 'no captured observation');
        // Check every sampled dependency again before publishing. A changed input is retried, never mixed.
        if (stable !== dependencyStamp(paths, excluded) + JSON.stringify(ownerState(run.runDir, this.hostDir)) || volatile !== fileStamp(heart) + JSON.stringify(supervision(run.runDir)) || journal !== fileStamp(journalPath)) {
          if (Date.now() < deadline) continue;
          throw new ConsoleError('unavailable', 'observation inputs changed throughout bounded catch-up');
        }
        const captured = observer.captured;
        const generation = observer.cursor!.generation;
        const epoch = !c || c.generation !== generation ? randomUUID() : c.epoch;
        const data: ObservationData = structuredClone({ display: reply.display, summary: captured.summary, requests: captured.requests, events: captured.events, plan: captured.plan,
          capture: { clock: captured.clock, foldMs: captured.foldMs, source: stable + journal, materializations: (c?.base.capture.materializations ?? 0) + 1 } });
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
      if (stable !== dependencyStamp(paths, excluded) + JSON.stringify(ownerState(run.runDir, this.hostDir)) || volatile !== fileStamp(heart) + JSON.stringify(supervision(run.runDir)) || journal !== fileStamp(journalPath)) {
        if (Date.now() < deadline) continue;
        throw new ConsoleError('unavailable', 'observation dependencies changed at request admission');
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
  }
}
