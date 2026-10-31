// Residue-index compaction at `start` (M3 growth controls; DESIGN-1.0.md §2.9): the supervisor runs it once after
// its claim, before the first executor, so nothing else touches the index meanwhile.
//
// Retention (H1). A disposed pair (a residue and its disposition) is dropped only when no arc's resource fold still
// holds its instance: the fold of the key's arc and of the arc that disposed of it (`by.arc`), each read read-only
// from its run dir (`readJournal`). An instance is still held when it is `cleanup-failed`, or held by a reclaiming
// holder (a retry, a sweep or a job, RECLAIM_HOLDERS). That covers the window between a `cleaned` disposition and the
// `release` that follows it (src/resources/reserve.ts `retryReclaim`, crash point `retry.after-disposition`), in
// which the retry replays the disposed residue's recipe. Retention is read from the resource table, never from open
// intents alone. An arc whose log cannot be read (absent, or corrupt) keeps every pair it is part of. An undisposed
// residue is always kept.
//
// Nothing is rewritten below the threshold (COMPACT_THRESHOLD droppable pairs). Otherwise, in this order:
//   1. write the new index to COMPACT_TMP: a `compacted` head continuing the current file's chain, then the kept
//      lines re-chained (their records and times unchanged), verified as the next read will verify it;
//   2. `link` the current index to its archive name (`residueArchiveName` of its last line): the archive is the old
//      file itself, byte for byte;
//   3. `rename` COMPACT_TMP over the index.
// A crash after 1 leaves a stray tmp, removed by the next compaction; after 2, an archive linked to the unchanged
// index, which the next compaction finds (same inode) and continues from, or, if appends have since moved the
// index's last line on, unlinks before linking the index under its new name; after 3, the compacted index. Readers
// see the old index or the new one, never a mix. Crash points `residue.compact.after-*` (matrix row RESIDUE_COMPACT).
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { RECLAIM_HOLDERS, type ChainEnvelope, type ResidueLine, prevHash, serializeChainLine } from '../core/events.ts';
import { AlreadyExistsError, appendSync, durableLink, durableRename, durableUnlink } from '../core/fsx.ts';
import type { ArcId, ResourceInstance } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { EVENTS_FILE, LogCorruptError, readJournal } from '../core/log.ts';
import type { ResidueRecord } from '../core/records.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { RESIDUES, hostPath } from './hostdir.ts';
import {
  type CompactedHead, type CompactedLine, type DispositionEntry, RESIDUE_ARCHIVE, bodyOf, readResidueIndex, residueArchiveName, residueKeyText,
  verifyIndexBytes,
} from './residues.ts';

/** How many droppable pairs a start waits for before it rewrites the index. */
export const COMPACT_THRESHOLD = 64;
export const COMPACT_TMP = 'residues.jsonl.compact';

export type Compaction =
  | Readonly<{ kind: 'below-threshold'; droppable: number }>
  | Readonly<{ kind: 'compacted'; archive: string; dropped: number; kept: number }>;

/** The resource fold of one arc, or `unreadable` (no log in its run dir, or a corrupt one). */
type ArcFold = JournalView | 'unreadable';

function arcFold(runDir: AbsPath, arc: ArcId): ArcFold {
  if (!existsSync(join(runDir, EVENTS_FILE))) return 'unreadable';
  try {
    return readJournal(runDir, arc).view;
  } catch (error) {
    if (error instanceof LogCorruptError) return 'unreadable';
    throw error;
  }
}

/** Whether `view`'s resource table still holds `instance` for a failed cleanup or a reclaim of one. */
function holds(view: JournalView, instance: ResourceInstance): boolean {
  const status = view.resources().get(instance)?.status;
  if (status === undefined || status.state === 'free') return false;
  return status.state === 'cleanup-failed' || (RECLAIM_HOLDERS as readonly string[]).includes(status.holder.type);
}

/**
 * Compacts the index in `dir` when at least `threshold` disposed pairs may be dropped. `runDirOf` locates an arc's
 * run dir (the supervisor's: its repo's `roadmap-runtime/<arc>`, so an arc of another repo reads as unreadable and
 * keeps its pairs). Host-lock holders only, with no executor running.
 */
export function compactResidues(dir: AbsPath, runDirOf: (arc: ArcId) => AbsPath, threshold: number = COMPACT_THRESHOLD): Compaction {
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error(`compaction threshold ${threshold}: a positive integer`);
  const tmp = hostPath(dir, COMPACT_TMP);
  if (existsSync(tmp)) durableUnlink(tmp); // a compaction that crashed before its rename
  const index = readResidueIndex(dir);

  const folds = new Map<ArcId, ArcFold>();
  const foldOf = (arc: ArcId): ArcFold => {
    let fold = folds.get(arc);
    if (fold === undefined) {
      fold = arcFold(runDirOf(arc), arc);
      folds.set(arc, fold);
    }
    return fold;
  };
  const droppable = (d: DispositionEntry): boolean => [...new Set([d.key.arc, d.by.arc])].every((arc) => {
    const fold = foldOf(arc);
    return fold !== 'unreadable' && !holds(fold, d.key.resource);
  });
  const dropped = new Set([...index.dispositions].filter(([, d]) => droppable(d)).map(([k]) => k));
  if (dropped.size < threshold) return { kind: 'below-threshold', droppable: dropped.size };

  const { lastSeq: prevSeq, lastHash } = index;
  if (lastHash === null) throw new Error(`compacting an empty index with ${dropped.size} droppable pairs`);
  const archive = residueArchiveName(prevSeq, lastHash);
  const kept = index.lines.filter((l) => !dropped.has(residueKeyText(l.key)));
  const bytes = rewrite({ type: 'compacted', archive, prevSeq, prevHash: lastHash }, kept);
  verifyIndexBytes(dir, bytes);

  const fd = openSync(tmp, 'wx');
  try {
    appendSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  crashPoint('residue.compact.after-tmp');
  linkArchive(dir, archive);
  crashPoint('residue.compact.after-link');
  durableRename(tmp, hostPath(dir, RESIDUES));
  crashPoint('residue.compact.after-rename');
  return { kind: 'compacted', archive, dropped: dropped.size, kept: kept.length };
}

/** The head continuing the archived chain, then `kept` re-chained after it, each keeping its version, time and record. */
function rewrite(head: CompactedHead, kept: readonly ResidueLine[]): Buffer {
  const chunks: Buffer[] = [];
  let seq = head.prevSeq + 1;
  let prev = head.prevHash;
  const push = (text: string): void => {
    const b = Buffer.from(text, 'utf8');
    chunks.push(b);
    prev = prevHash(b);
    seq += 1;
  };
  push(serializeChainLine<CompactedHead>({ v: SCHEMA_VERSION, seq, prev, at: isoTimeOf(new Date()), ...head } as CompactedLine));
  for (const line of kept) {
    const envelope: ChainEnvelope = { v: line.v, seq, prev, at: line.at };
    push(serializeChainLine<ResidueRecord>({ ...envelope, ...bodyOf(line) } as ResidueLine));
  }
  return Buffer.concat(chunks);
}

/**
 * Links the current index to `archive`. An archive already there must be this very file: a compaction that
 * crashed after its link. A link a crashed compaction left under another name (appends since moved the index's
 * last line on) is removed first, so every archive holds exactly the file its name describes.
 */
function linkArchive(dir: AbsPath, archive: string): void {
  const index = hostPath(dir, RESIDUES);
  const target = hostPath(dir, archive);
  const ino = statSync(index).ino;
  for (const name of readdirSync(dir)) {
    if (name !== archive && RESIDUE_ARCHIVE.test(name) && statSync(hostPath(dir, name)).ino === ino) durableUnlink(hostPath(dir, name));
  }
  try {
    durableLink(index, target);
  } catch (error) {
    if (!(error instanceof AlreadyExistsError)) throw error;
    if (statSync(target).ino !== ino) throw new Error(`residue archive ${target} exists and is not ${index}`);
  }
}
