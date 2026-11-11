import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../cli/locate.ts';
import type { Event } from '../core/events.ts';
import type { AbsPath } from '../core/values.ts';
import { invocationDirName, invocationId, invocationIdOf } from '../core/ids.ts';
import { sha256Hex } from '../core/json.ts';
import { invocationDir } from '../pipeline/invoke.ts';
import { withoutRecordMemo } from './memo.ts';
import { JUDGMENT_SESSION_ROLES } from '../routing/types.ts';
import { launchSha256 } from '../runner/launch.ts';
import { runnerFiles } from '../runner/files.ts';
import type { WorkRun } from '../status-work.ts';
import type { ModelReader } from '../tui/models.ts';
import type { TranscriptReader } from '../tui/transcript.ts';
import { type Invocation, pretty } from '../tui/types.ts';

/** An invocation the table still reads on every refresh: its runner may write its records and output. */
export type OpenInvocation = Readonly<{ id: string; dir: string }>;
/** What `InvocationRelations.read` attaches to a row. */
export type Relations = Pick<Invocation, 'relatedUnits' | 'context' | 'assessment' | 'milestone'>;
export type RelationMap = ReadonlyMap<string, Relations>;
type Terminal = Readonly<{ at: string; value: unknown; state: string; resultSha256: string | null }>;
type Slot = {
  readonly intent: Extract<Event, { type: 'intent'; kind: 'proc.spawn' }>;
  readonly dir: AbsPath;
  terminal: Terminal | null;
  /** The row as last read from the records, without relations. */
  base: Invocation | null;
  relations: Relations | undefined;
  row: Invocation | null;
  /** Read again at the next refresh: open, newly settled (its final read), or invalidated. */
  due: boolean;
};

/**
 * The invocation rows of one journal, kept across captures. A row is read from its records while its invocation is open,
 * once more when its settlement is folded, and then never again unless a record of it is invalidated (a rewrite the integrity
 * sweep found). Rows keep the journal's order; `sorted` is the display order and is rebuilt only when a row changed.
 */
export class InvocationTable {
  readonly run: Run;
  constructor(run: Run) { this.run = run; }
  #slots = new Map<string, Slot>();
  #ordinal = new Map<string, number>();
  #changed = new Set<string>();
  #sorted: Invocation[] | null = [];
  /** How many rows the last refresh read from their records. */
  lastReads = 0;
  /** How many invocations the table holds. */
  get size(): number { return this.#slots.size; }
  /** Folds `events[from..]`: new spawn intents become open rows; a settlement marks its row for one final read. */
  extend(events: readonly Event[], from: number): void {
    for (let i = from; i < events.length; i++) {
      const e = events[i]!;
      if (e.type === 'intent' && e.kind === 'proc.spawn') {
        this.#ordinal.set(e.op, e.ordinal);
        const id = invocationId(e.op, e.ordinal);
        this.#slots.set(id, { intent: e, dir: invocationDir(this.run.runDir, id), terminal: null, base: null, relations: undefined, row: null, due: true });
      }
      if ((e.type === 'done' && e.kind === 'proc.spawn') || e.type === 'abort') {
        const slot = this.#slots.get(invocationId(e.op, this.#ordinal.get(e.op) ?? 1));
        if (slot === undefined) continue;
        slot.terminal = { at: e.at, value: e.type === 'abort' ? { reason: e.reason } : { outcome: e.outcome, recoveredBy: e.recoveredBy },
          state: e.type === 'abort' ? `aborted:${e.reason.code}` : e.outcome.kind, resultSha256: e.type === 'done' && e.outcome.kind === 'result' ? e.outcome.resultSha256 : null };
        slot.due = true;
      }
    }
  }
  /**
   * Reads (again) every open row, every row whose settlement is new, and every invalidated row, and attaches `relations` to
   * every row whose relations changed. A settled row is built once, with its work metrics merged then. A read of an open row
   * that races its runner (`ENOENT`) keeps the row it had and tries again at the next refresh. Returns the changed rows.
   */
  refresh(alive: boolean, work: ReadonlyMap<string, WorkRun>, relations: RelationMap | null, readers: Readonly<{ models: ModelReader; logs: TranscriptReader }>, onProgress?: (done: number, of: number) => void): readonly Invocation[] {
    const changed: Invocation[] = [];
    let due = 0;
    for (const slot of this.#slots.values()) if (slot.due) due++;
    this.lastReads = 0;
    for (const [id, slot] of this.#slots) {
      let dirty = false;
      if (slot.due) {
        if (++this.lastReads % 500 === 0) onProgress?.(this.lastReads, due);
        // An open invocation's records are read past the memo: its runner is still writing them, and a rewrite must show.
        try { slot.base = slot.terminal === null ? withoutRecordMemo(() => readRow(slot, alive, readers)) : readRow(slot, alive, readers); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || slot.base === null) throw error;
          continue;
        }
        const metrics = work.get(id);
        if (metrics) slot.base = { ...slot.base, work: metrics, body: pretty({ ...JSON.parse(slot.base.body), work: metrics }) };
        if (slot.terminal !== null) { slot.due = false; readers.logs.forgetLatest(join(slot.dir, 'stdout')); }
        dirty = true;
      }
      if (relations !== null) {
        const next = relations.get(id);
        if (!dirty && !sameRelations(slot.relations, next)) dirty = true;
        slot.relations = next;
      }
      if (!dirty) continue;
      // Relations come last so a row read once keeps the assessment a later fact gives it.
      const { assessment: _assessment, ...base } = slot.base!;
      slot.row = { ...base, ...slot.relations };
      this.#changed.add(id); changed.push(slot.row);
    }
    if (changed.length > 0) this.#sorted = null;
    return changed;
  }
  /** Open rows by start time, then settled rows newest first. */
  sorted(): readonly Invocation[] {
    if (this.#sorted === null) {
      const rows: Invocation[] = [];
      for (const slot of this.#slots.values()) if (slot.row !== null) rows.push(slot.row);
      this.#sorted = rows.sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || (a.endedAt === null ? byTime(a.startedAt, b.startedAt) : byTime(b.endedAt!, a.endedAt)));
    }
    return this.#sorted;
  }
  /** The invocations still read on every refresh. */
  open(): readonly OpenInvocation[] {
    const out: OpenInvocation[] = [];
    for (const [id, slot] of this.#slots) if (slot.terminal === null) out.push({ id, dir: slot.dir });
    return out;
  }
  /** Reads the rows of these invocation directory names again at the next refresh. */
  invalidate(dirNames: ReadonlySet<string>): void {
    for (const [id, slot] of this.#slots) if (dirNames.has(invocationDirName(invocationIdOf(id)))) slot.due = true;
  }
  /** The ids of the rows changed since the last call. */
  drainChanged(): ReadonlySet<string> { const out = this.#changed; this.#changed = new Set(); return out; }
  row(id: string): Invocation | null { return this.#slots.get(id)?.row ?? null; }
  reset(): void { this.#slots.clear(); this.#ordinal.clear(); this.#changed.clear(); this.#sorted = []; }
}

/** Recorded times are fixed-width ISO instants: their code-point order is their time order (localeCompare is slower, same answer). */
export const byTime = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sameRelations = (a: Relations | undefined, b: Relations | undefined): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function readRow(slot: Slot, alive: boolean, readers: Readonly<{ models: ModelReader; logs: TranscriptReader }>): Invocation {
  const e = slot.intent, dir = slot.dir;
  const id = invocationId(e.op, e.ordinal);
  const files = runnerFiles(dir, id);
  const launch = files.read('launch.json');
  if (launch !== null && launchSha256(launch) !== e.expect.launchSha256) throw new Error(`${dir}/launch.json does not hash to its recorded launchSha256`);
  const result = files.read('result.json');
  const exit = files.read('exit.json');
  files.read('runner.json'); // Validate identity bindings, even though liveness comes from the host owner.
  const done = slot.terminal;
  if (result !== null && done?.resultSha256 && sha256Hex(readFileSync(join(dir, 'result.json'))) !== done.resultSha256) throw new Error(`${dir}/result.json does not hash to its recorded resultSha256`);
  const subject = e.expect.subject;
  const unit = subject.purpose === 'mutant' && 'of' in subject && subject.of.type === 'smoke' ? subject.of.unit : 'unit' in subject && subject.unit ? subject.unit : 'owner' in subject && subject.owner.type === 'unit' ? subject.owner.unit : 'job' in subject ? subject.job : e.parent.type === 'job' ? e.parent.job : 'arc';
  const role = launch?.terminal.type === 'backend' ? launch.terminal.role : 'role' in subject ? subject.role : 'lane' in subject ? `${subject.purpose}:${subject.lane}` : subject.purpose;
  const session = result?.type === 'backend' ? result.session ?? '' : launch?.terminal.type === 'backend' && 'id' in launch.terminal.session ? launch.terminal.session.id : '';
  const state = done && done.state !== 'result' ? done.state : result?.type === 'backend' ? result.outcome.kind : result?.type === 'command' ? result.verdict
    : done?.state ?? (exit ? `exited:${exit.cause}` : alive ? 'running' : 'unowned');
  const output = ['stdout', 'stderr'].flatMap((f) => {
    const p = join(dir, f); return existsSync(p) ? [statSync(p).mtimeMs] : [];
  });
  const inputKind = launch?.terminal.type === 'backend' ? launch.terminal.session.mode === 'fresh' ? 'initial'
    : JUDGMENT_SESSION_ROLES.some((judgmentRole) => judgmentRole === role) ? 'repair' : 'resume' : undefined;
  return {
    launchSha256: e.expect.launchSha256,
    ...(inputKind ? { inputKind } : {}),
    ...((launch?.terminal.type === 'backend' || result?.type === 'backend') ? readers.models.read(launch, join(dir, 'stdout')) : {}),
    ...('unit' in subject && subject.unit || e.parent.type === 'stage' ? { scope: 'unit' as const }
      : subject.purpose === 'arc-backend' || e.parent.type === 'arc' ? { scope: 'arc' as const } : {}),
    ...(launch ? { execution: launch.terminal.type === 'backend' ? 'agent' as const : 'command' as const } : result ? { execution: result.type === 'backend' ? 'agent' as const : 'command' as const } : {}),
    id, label: `${unit} / ${role}${inputKind === 'repair' ? ' / repair' : inputKind === 'resume' ? ' / resumed' : ''}`, state,
    body: pretty({ subject, parent: e.parent, session, outcome: state, resultAvailable: result !== null, exit, settlement: done?.value ?? null }),
    links: [], provenance: 'validated runtime snapshot',
    unit, role, session, attempt: 'attempt' in subject ? subject.attempt : e.parent.type === 'stage' ? e.parent.attempt : e.ordinal,
    startedAt: e.at, endedAt: done?.at ?? exit?.endedAt ?? null,
    quietMs: output.length ? Math.max(0, Date.now() - Math.max(...output)) : null,
    latest: readers.logs.latest(join(dir, 'stdout')),
  };
}
