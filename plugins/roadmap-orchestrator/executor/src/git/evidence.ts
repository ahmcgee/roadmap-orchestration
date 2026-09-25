// `evidence.snapshot`: copy an invocation's evidence (lane outputs, stdout/stderr, decisions.json) out of
// the place it was produced into the run dir, with a sha256 manifest. The manifest is written last and
// durably, so its presence with `complete: true` means every listed file was copied first. Worktree
// removal and retire require a verified manifest (`VerifiedManifest`), so evidence cannot be lost to a
// cleanup that ran first.
//
// Layout of a snapshot dir `dest`: `dest/files/<path>` for each captured file, `dest/manifest.json`.
// Copying is idempotent: a re-run compares hashes and fills only the gaps (a missing or half-copied
// file), then rewrites the same manifest bytes.
import { existsSync, globSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome } from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type OpId, type Sha256Hex, sha256 } from '../core/ids.ts';
import type { IntentBody, JournalView, Reconciler } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { type Brand, Fields, type Read, literal, nat, sortedBy, version } from '../core/validate.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, repoPath } from '../core/values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { reconcileEvidenceSnapshot } from '../recover/evidence.ts';

export const MANIFEST_FILE = 'manifest.json';
export const FILES_DIR = 'files';

export type ManifestEntry = Readonly<{ path: RepoPath; sha256: Sha256Hex; size: number }>;

/** Only ever written complete: an incomplete snapshot has no manifest at all. */
export type EvidenceManifest = Readonly<{ v: SchemaVersion; complete: true; files: readonly ManifestEntry[] }>;

/** A manifest whose every file was re-hashed and matched. Only `verifyManifest` makes one. */
export type VerifiedManifest = Brand<EvidenceManifest, 'VerifiedManifest'>;

/** A done `evidence.snapshot` op and its verified manifest: what `worktree.remove` requires. */
export type CapturedEvidence = Readonly<{ op: OpId; manifest: VerifiedManifest; manifestSha256: Sha256Hex }>;

export class ManifestMismatchError extends Error {
  readonly dir: AbsPath;
  constructor(dir: AbsPath, detail: string) {
    super(`evidence snapshot ${dir}: ${detail}`);
    this.name = 'ManifestMismatchError';
    this.dir = dir;
  }
}

export const manifestEntry: Read<ManifestEntry> = (value, path) => {
  const f = new Fields(value, path);
  const out = { path: f.get('path', (v, p) => repoPath(v, p)), sha256: f.get('sha256', (v, p) => sha256(v, p)), size: f.get('size', nat) };
  f.end();
  return out;
};

export const evidenceManifest: Read<EvidenceManifest> = (value, path) => {
  const f = new Fields(value, path);
  const out = {
    v: f.get('v', version),
    complete: f.get('complete', literal(true)),
    files: f.get('files', sortedBy(manifestEntry, (e) => e.path)),
  };
  f.end();
  return out;
};

export const manifestPath = (dir: AbsPath): AbsPath => absPath(join(dir, MANIFEST_FILE));
const filePath = (dir: AbsPath, path: RepoPath): string => join(dir, FILES_DIR, path);

const hashFile = (path: string): Sha256Hex => sha256(sha256Hex(readFileSync(path)));

/** sha256 of a file's bytes, or null when it is absent. */
export function fileSha256(path: string): Sha256Hex | null {
  return existsSync(path) ? hashFile(path) : null;
}

/**
 * Copies `from` to `to` durably unless `to` already holds the same bytes. `expected` is the content hash
 * the caller recorded; a source that no longer matches it is refused, never captured under the old hash.
 */
export function copyIfChanged(from: string, to: string, expected: Sha256Hex): void {
  const bytes = readFileSync(from);
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error(`copy ${from}: content hash ${actual}, recorded ${expected}`);
  if (fileSha256(to) === expected) return;
  durableMkdir(dirname(to));
  durableWrite(to, bytes);
}

/** Every regular file under `source` matching one of `globs`, sorted, with its hash and size. */
export function listEvidence(source: AbsPath, globs: readonly RepoPattern[]): readonly ManifestEntry[] {
  const out = new Map<string, ManifestEntry>();
  for (const rel of globSync([...globs], { cwd: source })) {
    const full = join(source, rel);
    const st = lstatSync(full);
    if (st.isDirectory()) continue;
    if (!st.isFile()) throw new Error(`evidence ${full}: not a regular file (symlinks and special files are not captured)`);
    out.set(rel, { path: repoPath(rel), sha256: hashFile(full), size: st.size });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export type SnapshotCheck =
  | Readonly<{ kind: 'verified'; manifest: VerifiedManifest; manifestSha256: Sha256Hex }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'mismatch'; detail: string }>;

/** Re-reads a snapshot dir: its manifest, then every listed file's hash. A malformed manifest throws. */
export function checkManifest(dir: AbsPath): SnapshotCheck {
  const path = manifestPath(dir);
  if (!existsSync(path)) return { kind: 'absent' };
  const bytes = readFileSync(path);
  const manifest = evidenceManifest(JSON.parse(bytes.toString('utf8')), path);
  for (const entry of manifest.files) {
    const actual = fileSha256(filePath(dir, entry.path));
    if (actual !== entry.sha256) return { kind: 'mismatch', detail: `${entry.path}: ${actual ?? 'absent'}, manifest says ${entry.sha256}` };
  }
  return { kind: 'verified', manifest: manifest as VerifiedManifest, manifestSha256: sha256(sha256Hex(bytes)) };
}

/** True when the snapshot has its (complete) manifest. Says nothing about the files; see verifyManifest. */
export function manifestComplete(dir: AbsPath): boolean {
  const path = manifestPath(dir);
  if (!existsSync(path)) return false;
  return evidenceManifest(JSON.parse(readFileSync(path, 'utf8')), path).complete;
}

/** The manifest, after re-hashing every file it lists. Throws ManifestMismatchError otherwise. */
export function verifyManifest(dir: AbsPath): VerifiedManifest {
  const check = checkManifest(dir);
  if (check.kind === 'absent') throw new ManifestMismatchError(dir, 'no manifest (the snapshot never completed)');
  if (check.kind === 'mismatch') throw new ManifestMismatchError(dir, check.detail);
  return check.manifest;
}

/**
 * The captured evidence of a done `evidence.snapshot` op, re-verified now: its manifest re-hashed and equal
 * to the one the done record names. A string says why it is not (the caller throws or parks).
 */
export function readCapturedEvidence(view: JournalView, op: OpId): CapturedEvidence | string {
  const done = view.doneOf(op);
  const intent = view.latestIntent(op);
  if (done === null || done.kind !== 'evidence.snapshot' || intent.kind !== 'evidence.snapshot') return `${op} is not a done evidence.snapshot`;
  const check = checkManifest(intent.expect.dest);
  if (check.kind === 'absent') return `${op}: manifest absent`;
  if (check.kind === 'mismatch') return `${op}: ${check.detail}`;
  if (check.manifestSha256 !== done.outcome.manifestSha256) return `${op}: manifest differs from the one the snapshot recorded`;
  return { op, manifest: check.manifest, manifestSha256: check.manifestSha256 };
}

/** readCapturedEvidence, throwing when the evidence is not captured: what a caller of worktree.remove uses. */
export function capturedEvidence(view: JournalView, op: OpId): CapturedEvidence {
  const captured = readCapturedEvidence(view, op);
  if (typeof captured === 'string') throw new Error(`evidence not captured: ${captured}`);
  return captured;
}

export type SnapshotRequest = Readonly<{ source: AbsPath; globs: readonly RepoPattern[]; dest: AbsPath }>;

function prepare(request: SnapshotRequest): Promise<IntentBody<'evidence.snapshot'>> {
  if (!lstatSync(request.source).isDirectory()) throw new Error(`evidence source ${request.source} is not a directory`);
  const { source, globs, dest } = request;
  return Promise.resolve({ expect: { source, globs, dest }, post: { manifest: manifestPath(dest) } });
}

function act(intent: IntentOf<'evidence.snapshot'>): Promise<void> {
  const { source, globs, dest } = intent.expect;
  crashPoint('evidence.act-start');
  const files = listEvidence(source, globs);
  durableMkdir(join(dest, FILES_DIR));
  for (const entry of files) {
    copyIfChanged(join(source, entry.path), filePath(dest, entry.path), entry.sha256);
    crashPoint('evidence.after-partial-copy');
  }
  const manifest: EvidenceManifest = { v: SCHEMA_VERSION, complete: true, files };
  durableWrite(manifestPath(dest), canonicalJson(manifest));
  crashPoint('evidence.act-end');
  return Promise.resolve();
}

function verify(intent: IntentOf<'evidence.snapshot'>): Promise<OpOutcome['evidence.snapshot']> {
  const check = checkManifest(intent.expect.dest);
  if (check.kind !== 'verified') throw new ManifestMismatchError(intent.expect.dest, check.kind === 'absent' ? 'no manifest' : check.detail);
  return Promise.resolve({ kind: 'captured', manifestSha256: check.manifestSha256, files: check.manifest.files.length });
}

/**
 * `evidence.snapshot` is not a git kind (`GitOp` is limited to those), so it has its own op record of the
 * same shape: prepare records the inputs, act copies, verify re-reads the manifest, reconcile per the table.
 */
export type EvidenceSnapshotOp = Readonly<{
  kind: 'evidence.snapshot';
  prepare(request: SnapshotRequest): Promise<IntentBody<'evidence.snapshot'>>;
  act(intent: IntentOf<'evidence.snapshot'>): Promise<void>;
  verify(intent: IntentOf<'evidence.snapshot'>): Promise<OpOutcome['evidence.snapshot']>;
  reconcile: Reconciler<'evidence.snapshot'>;
}>;

export const evidenceSnapshotOp: EvidenceSnapshotOp = { kind: 'evidence.snapshot', prepare, act, verify, reconcile: reconcileEvidenceSnapshot };
