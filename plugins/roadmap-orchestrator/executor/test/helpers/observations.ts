// Observations as the console publishes them, driven in-thread: each read runs one collector step for its run
// (src/observation/collect.ts) and applies what it published to that run's serve model (src/console/model.ts).
import { commonDirOfRun } from '../../src/answers.ts';
import type { ArcId } from '../../src/core/ids.ts';
import { type AbsPath, absPath } from '../../src/core/values.ts';
import { ArcModel } from '../../src/console/model.ts';
import { ArcCollector, type CollectorMessage } from '../../src/observation/collect.ts';
import { type Admission, ConsoleError, type Envelope } from '../../src/observation/protocol.ts';

type RunLike = Readonly<{ runDir: string; arc: ArcId | string }>;
export class ObservedArc {
  readonly collector: ArcCollector;
  readonly model: ArcModel;
  /** Every message the collector published, in order. */
  readonly messages: CollectorMessage[] = [];
  constructor(hostDir: AbsPath | string, instance: string, repoId: string, run: RunLike) {
    const r = { runDir: absPath(run.runDir), arc: run.arc as ArcId, at: '' };
    this.model = new ArcModel(r, instance, repoId);
    this.collector = new ArcCollector(r, absPath(hostDir), absPath(commonDirOfRun(r.runDir)), (m) => { this.messages.push(m); this.model.apply(m, Date.now()); });
  }
  /** One collector step, then the published envelope as a browser read with `admission` is answered (a park is unavailable). */
  read(admission: Admission = {}): Envelope {
    const arrivedAt = Date.now();
    this.collector.step(arrivedAt);
    const verdict = this.model.admit(admission, arrivedAt, false);
    if (verdict.kind === 'park') throw new ConsoleError('unavailable', `read parked (${verdict.park})`);
    return verdict.envelope;
  }
}
/** One ObservedArc per run, as the console keeps one model per maintained arc. */
export class Observations {
  readonly #hostDir: string; readonly #instance: string; readonly #repoId: string;
  readonly #arcs = new Map<string, ObservedArc>();
  constructor(hostDir: AbsPath | string, instance: string, repoId: string) { this.#hostDir = hostDir; this.#instance = instance; this.#repoId = repoId; }
  arc(run: RunLike): ObservedArc {
    let arc = this.#arcs.get(run.runDir);
    if (!arc) { arc = new ObservedArc(this.#hostDir, this.#instance, this.#repoId, run); this.#arcs.set(run.runDir, arc); }
    return arc;
  }
  read(run: RunLike, admission: Admission = {}): Envelope { return this.arc(run).read(admission); }
}
