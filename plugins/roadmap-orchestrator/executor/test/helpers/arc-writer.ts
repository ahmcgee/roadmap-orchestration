// Drives a generated scale arc (test/helpers/scale-arc.ts) the way a busy executor changes it, for console load tests: output
// streaming into the open invocations, bursts of journal events, a churning schedule, moving refs and a heartbeat. It also
// lays down an evidence tree of the size a long arc keeps. Every write is a real one, through the production writers where
// there is one; no console code is touched.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../src/core/fsx.ts';
import { arcId, unitId } from '../../src/core/ids.ts';
import { openJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import type { ScaleManifest } from './scale-arc.ts';

/** An evidence tree of `dirs` directories holding `files` empty files each, under the run's evidence/ (walks cost by entry count). */
export function padEvidence(runDir: string, dirs: number, files: number): void {
  for (let d = 0; d < dirs; d++) {
    const dir = join(runDir, 'evidence', 'pad', `s${d % 97}`, `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < files; f++) writeFileSync(join(dir, `f${f}`), '');
  }
}

export type WriterOptions = Readonly<{ outputMs: number; burstMs: number; burst: number; schedMs: number; refMs: number; heartbeatMs: number }>;
export const BUSY: WriterOptions = { outputMs: 250, burstMs: 2_000, burst: 12, schedMs: 300, refMs: 700, heartbeatMs: 1_000 };

export class ArcWriter {
  readonly #m: ScaleManifest;
  readonly #timers: NodeJS.Timeout[] = [];
  readonly #journal: ReturnType<typeof openJournal>;
  /** Each appended event's seq and when it was written: what a read's lag is measured against. */
  readonly appends: { seq: number; ms: number }[] = [];
  #toggle = false; #ref = 0; #line = 0;
  constructor(m: ScaleManifest) {
    this.#m = m;
    this.#journal = openJournal(absPath(m.runDir), arcId(m.arc));
  }
  get seq(): number { return this.#journal.view.highWater(); }
  start(o: WriterOptions = BUSY): void {
    const every = (ms: number, f: () => void) => this.#timers.push(setInterval(f, ms));
    const start = JSON.parse(readFileSync(join(this.#m.runDir, 'start.json'), 'utf8')) as { generation: number };
    const atomic = (path: string, text: string) => { const tmp = `${path}.${randomUUID()}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path); };
    every(o.outputMs, () => {
      for (const live of this.#m.live) appendFileSync(live.transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `progress line ${++this.#line}` }] } }) + '\n');
    });
    every(o.burstMs, () => {
      for (let n = 0; n < o.burst; n++) {
        const live = this.#m.live[n % this.#m.live.length]!;
        this.#journal.fact({ kind: 'stage-admitted', unit: unitId(live.unit), stage: 'build', waited: { totalMs: n, byReasonMs: { 'cpu-tokens': n } } });
        this.appends.push({ seq: this.#journal.view.highWater(), ms: Date.now() });
      }
    });
    every(o.schedMs, () => {
      this.#toggle = !this.#toggle;
      atomic(join(this.#m.runDir, 'sched.json'), JSON.stringify({ v: 2, arc: this.#m.arc, pid: process.pid,
        tasks: this.#m.live.map((l, i) => ({ unit: l.unit, state: this.#toggle && i === 0 ? 'in-chain' : 'in-stage' })), queue: [], jobQueue: [], drains: [] }));
    });
    every(o.refMs, () => {
      const commit = execFileSync('git', ['-C', this.#m.repo, '-c', 'user.email=writer@example.invalid', '-c', 'user.name=writer', 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', `churn ${++this.#ref}`]).toString().trim();
      execFileSync('git', ['-C', this.#m.repo, 'update-ref', 'refs/heads/roadmap/writer-churn', commit]);
    });
    every(o.heartbeatMs, () => atomic(join(this.#m.runDir, 'heartbeat.json'), canonicalJson({ v: 2, generation: start.generation, at: new Date().toISOString() })));
  }
  stop(): void { for (const t of this.#timers.splice(0)) clearInterval(t); }
  close(): void { this.stop(); this.#journal.close(); }
  /** How long ago the writer appended the first event a reader at `highWater` lacks (0: it has them all). */
  lagMs(highWater: number): number {
    const missing = this.appends.find((a) => a.seq > highWater);
    return missing ? Date.now() - missing.ms : 0;
  }
}
