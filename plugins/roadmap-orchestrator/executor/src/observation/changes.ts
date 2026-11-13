// What changed in a run since the last sample, at a cost that grows with the arc's live parts (its open invocations and
// small control directories), never with its settled invocations or its evidence. Never follows symlinks.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readBootId } from '../contain/proc.ts';
import { sha256Hex } from '../core/json.ts';
import { EVENTS_FILE } from '../core/log.ts';
import type { AbsPath } from '../core/values.ts';
import { DEMO_FILE, readDemoRecord } from '../demo/records.ts';
import { ownerState } from '../status.ts';
import { detachedAlive } from '../walk/bringup.ts';
import { supervision } from '../watch-lease.ts';
import type { OpenInvocation } from './invocations.ts';
import { type Sampled, stampOf } from './memo.ts';

/** A file's identity and version (`dev:ino:size:mtime:ctime`), or `missing`. */
export const fileStamp = stampOf;
/** A directory's identity and member names (temp files left out), or a file's stamp. */
export function dirStamp(path: string): Readonly<{ stamp: string; members: readonly string[] }> {
  let s;
  try { s = lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { stamp: 'missing', members: [] }; throw e; }
  if (!s.isDirectory()) return { stamp: `file:${fileStamp(path)}`, members: [] };
  const members = readdirSync(path).filter((n) => !n.endsWith('.tmp')).sort();
  return { stamp: `dir:${s.dev}:${s.ino}:${members.join('\0')}`, members };
}

/**
 * One sample: `journal` the journal's stamp; `stable` everything else a capture derives from that is not write-once (the
 * write-once records are trusted once read, and the integrity sweep re-checks them); `volatile` the heartbeat and the watch
 * lease, an overlay; `output` open invocations' output streams; `changed` the paths whose stamp differs from the previous sample.
 */
export type Sample = Readonly<{ journal: string; stable: string; volatile: string; output: string; changed: readonly string[]; statCalls: number;
  /** The open invocations' runner records, by path: compared path by path, since the open set itself moves only with the journal. */
  open: ReadonlyMap<string, string>;
  /** Parts of `stable`, as derivation cell keys (src/observation/memo.ts `Sampled`). */
  sampled: Sampled }>;
/** Whether a record open in both samples changed (an invocation joining or leaving the open set is a journal change). */
export function openMoved(before: Sample, now: Sample): boolean {
  for (const [path, stamp] of now.open) { const was = before.open.get(path); if (was !== undefined && was !== stamp) return true; }
  return false;
}

export class ChangeDetector {
  readonly runDir: AbsPath;
  readonly common: AbsPath;
  readonly hostDir: AbsPath;
  #previous: ReadonlyMap<string, string> = new Map<string, string>();
  constructor(runDir: AbsPath, common: AbsPath, hostDir: AbsPath) { this.runDir = runDir; this.common = common; this.hostDir = hostDir; }
  /** One sample, its `changed` against the previous one. */
  sample(open: readonly OpenInvocation[]): Sample {
    const { rows, sample } = this.#take(open);
    const changed: string[] = [];
    for (const [path, stamp] of rows) if (this.#previous.get(path) !== stamp) changed.push(path);
    for (const path of this.#previous.keys()) if (!rows.has(path)) changed.push(path);
    this.#previous = rows;
    return { ...sample, changed };
  }
  /** A sample that leaves the previous one as it is: what the next `sample` compares with does not move. `changed` is empty. */
  peek(open: readonly OpenInvocation[]): Sample { return { ...this.#take(open).sample, changed: [] }; }
  #take(open: readonly OpenInvocation[]): Readonly<{ rows: ReadonlyMap<string, string>; sample: Omit<Sample, 'changed'> }> {
    const rows = new Map<string, string>();
    let statCalls = 0;
    const file = (path: string) => { statCalls++; rows.set(path, fileStamp(path)); };
    const tree = (path: string) => {
      statCalls++;
      const { stamp, members } = dirStamp(path);
      rows.set(path, stamp);
      if (stamp.startsWith('dir:')) for (const name of members) tree(join(path, name));
    };
    const r = this.runDir;
    const journal = fileStamp(join(r, EVENTS_FILE)); statCalls++;
    for (const name of ['start.json', 'status.rejection.json', 'sched.json']) file(join(r, name));
    for (const name of ['host.lock', 'host.owner.json', DEMO_FILE]) file(join(this.hostDir, name));
    // The repository's config too: git's answers depend on it, and a broken one must surface as a failed capture.
    for (const name of ['HEAD', 'packed-refs', 'config']) file(join(this.common, name));
    for (const dir of [join(r, 'commands', 'incoming'), join(r, 'commands', 'receipts'), join(r, 'needs-user'), join(this.common, 'roadmap', 'answers'), join(this.common, 'refs')]) tree(dir);
    // Kept inputs are content-addressed and write-once: their names are enough here; the sweep re-checks their bytes.
    statCalls++; rows.set(join(r, 'inputs'), dirStamp(join(r, 'inputs')).stamp);
    const records = new Map<string, string>();
    for (const inv of open) for (const name of ['launch.json', 'runner.json', 'result.json', 'exit.json']) {
      statCalls++; const path = join(inv.dir, name), stamp = fileStamp(path);
      records.set(path, stamp);
    }
    const demo = readDemoRecord(this.hostDir)?.serving;
    // Status uses boot + pid/start identity, including zombie detection, for demo serving.
    const liveness = JSON.stringify([demo ? [demo.boot === readBootId(), ...demo.processes.map(detachedAlive)] : null, ownerState(r, this.hostDir)]);
    const stable = sha256Hex([...rows].map(([path, stamp]) => `${path}:${stamp}`).join('\n') + liveness);
    const part = (inside: (path: string) => boolean): string => sha256Hex([...rows].filter(([path]) => inside(path)).map(([path, stamp]) => `${path}:${stamp}`).join('\n'));
    const c = this.common, receipts = join(r, 'commands', 'receipts'), incoming = join(r, 'commands', 'incoming');
    const refs = [join(c, 'HEAD'), join(c, 'packed-refs'), join(c, 'config')], refsDir = join(c, 'refs');
    // A repository whose refs are in a reftable keeps none of them in these files: its ref lookups are not cached.
    statCalls++;
    const refsPart = fileStamp(join(c, 'reftable')) === 'missing' ? part((path) => refs.includes(path) || path === refsDir || path.startsWith(refsDir + '/')) : null;
    const within = (dir: string) => (path: string) => path === dir || path.startsWith(dir + '/');
    const sampled: Sampled = { runDir: r, common: c, refs: refsPart, receipts: part((path) => within(receipts)(path) || within(incoming)(path)) };
    const outputs: string[] = [];
    for (const inv of open) for (const name of ['stdout', 'stderr']) {
      statCalls++; const path = join(inv.dir, name), stamp = fileStamp(path);
      rows.set(path, stamp); outputs.push(`${path}:${stamp}`);
    }
    const heartbeat = fileStamp(join(r, 'heartbeat.json')); statCalls++;
    for (const [path, stamp] of records) rows.set(path, stamp);
    return { rows, sample: { journal, stable, volatile: heartbeat + JSON.stringify(supervision(r)), output: sha256Hex(outputs.join('\n')), statCalls, open: records, sampled } };
  }
}
