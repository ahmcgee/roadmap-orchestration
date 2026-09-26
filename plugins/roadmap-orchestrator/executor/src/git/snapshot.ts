// `snapshot.publish`: copy the run's records one-way to `refs/roadmap/<arc>` (DESIGN §2.9), so no PR diff
// carries them and the arc's history survives the run dir.
//
// The input is frozen at an event high-water seq: the snapshot carries the first `highWater` lines of
// `events.jsonl` and the state the fold derives from exactly those lines (never the live `state.json`
// cache, which may already be ahead). Dispatch records (dispatch facts) and approval fingerprints (the
// `integration.ff` intents) are in that log. Beside it: each unit's spec, the needs-user files raised by
// then (with their acks), and the manifest of every captured evidence snapshot. Raw evidence, stdout and
// stderr, and worktrees never enter the tree: the tree is built from this allowlist only, and
// `verifySnapshot` refuses any path outside it.
//
// `manifest.json` lists the sha256 and size of every other file with the arc and the high-water mark. The
// blobs and the tree are written at prepare; the commit (parent = the old ref, or none) has recorded
// inputs, so act and any redo make the same id; the ref moves by CAS.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import { type CommitInputs, type Event, type IntentOf, type OpOutcome, parseEventLine } from '../core/events.ts';
import { canonicalJson as fileJson } from '../core/fsx.ts';
import { type ArcId, type OpId, type Sha, type Sha256Hex, type UnitId, arcId, parseOpId, sha, sha256 } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { EVENTS_FILE } from '../core/log.ts';
import { fold } from '../core/state.ts';
import { Fields, type Read, literal, nat, positive, sortedBy, version } from '../core/validate.ts';
import { type AbsPath, type RefName, type RepoPath, absPath, refName, repoPath } from '../core/values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { manifestPath } from './evidence.ts';
import { type Identity, catFileType, commitTree, git, gitRun, lsTree, refTarget, updateRefCas, writeTreeFromIndex } from './git.ts';

export class SnapshotStateError extends Error {
  readonly ref: RefName;
  constructor(ref: RefName, detail: string) {
    super(`snapshot ${ref}: ${detail}`);
    this.name = 'SnapshotStateError';
    this.ref = ref;
  }
}

export const snapshotRef = (arc: ArcId): RefName => refName(`refs/roadmap/${arc}`);

export const SNAPSHOT_SCHEMA = 'roadmap/1.0';
export const SNAPSHOT_MANIFEST = 'manifest.json';

/** Every path a snapshot tree may hold besides its manifest. Nothing else is ever collected or accepted. */
const ALLOWLIST: readonly RegExp[] = [
  /^events\.jsonl$/,
  /^state\.json$/,
  /^specs\/[a-z0-9-]+\.json$/,
  /^needs-user\/[a-z0-9-]+(\.ack)?\.json$/,
  /^evidence-manifests\/[1-9][0-9]*\.json$/,
];
const allowlisted = (path: string): boolean => ALLOWLIST.some((re) => re.test(path));

export type SnapshotFile = Readonly<{ path: RepoPath; sha256: Sha256Hex; size: number }>;

export type SnapshotManifest = Readonly<{
  v: SchemaVersion;
  schema: typeof SNAPSHOT_SCHEMA;
  arc: ArcId;
  /** The seq of the last event the snapshot's `events.jsonl` holds. */
  highWater: number;
  files: readonly SnapshotFile[];
}>;

const snapshotFile: Read<SnapshotFile> = (value, path) => {
  const f = new Fields(value, path);
  const out = { path: f.get('path', (v, p) => repoPath(v, p)), sha256: f.get('sha256', (v, p) => sha256(v, p)), size: f.get('size', nat) };
  f.end();
  return out;
};

export const snapshotManifest: Read<SnapshotManifest> = (value, path) => {
  const f = new Fields(value, path);
  const out = {
    v: f.get('v', version),
    schema: f.get('schema', literal(SNAPSHOT_SCHEMA)),
    arc: f.get('arc', (v, p) => arcId(v, p)),
    highWater: f.get('highWater', positive),
    files: f.get('files', sortedBy(snapshotFile, (e) => e.path, { nonEmpty: true })),
  };
  f.end();
  return out;
};

// ---------------------------------------------------------------------------------------------------
// Collecting the input

export type SnapshotPublishRequest = Readonly<{
  arc: ArcId;
  runDir: AbsPath;
  /** The journal's high-water seq when the snapshot was decided (`JournalView.highWater()`). */
  highWater: number;
  /** Each unit's spec file (the plan's `units[].spec`). */
  specs: readonly Readonly<{ unit: UnitId; path: AbsPath }>[];
  identity: Identity;
  message: string;
}>;

type Collected = ReadonlyMap<RepoPath, Buffer>;

/** The first `highWater` complete lines of the event log, byte for byte, and their parsed events. */
function eventsPrefix(runDir: AbsPath, highWater: number): { bytes: Buffer; events: readonly Event[] } {
  const all = readFileSync(join(runDir, EVENTS_FILE));
  let end = 0;
  const events: Event[] = [];
  for (let n = 0; n < highWater; n++) {
    const nl = all.indexOf(0x0a, end);
    if (nl === -1) throw new Error(`${runDir}/${EVENTS_FILE} has ${n} complete lines, fewer than the high-water mark ${highWater}`);
    events.push(parseEventLine(all.subarray(end, nl).toString('utf8')));
    end = nl + 1;
  }
  const last = events[events.length - 1];
  if (last?.seq !== highWater) throw new Error(`${runDir}/${EVENTS_FILE}: line ${highWater} has seq ${last?.seq}`);
  return { bytes: all.subarray(0, end), events };
}

/** Each done evidence.snapshot's manifest, checked against the hash its done record carries. */
function evidenceManifests(events: readonly Event[]): ReadonlyMap<OpId, Buffer> {
  const dest = new Map<OpId, AbsPath>();
  const out = new Map<OpId, Buffer>();
  for (const e of events) {
    if (e.type === 'intent' && e.kind === 'evidence.snapshot') dest.set(e.op, e.expect.dest);
    if (e.type === 'done' && e.kind === 'evidence.snapshot' && e.outcome.kind === 'captured') {
      const dir = dest.get(e.op);
      if (dir === undefined) throw new Error(`evidence.snapshot ${e.op}: done without an intent`);
      const bytes = readFileSync(manifestPath(dir));
      if (sha256Hex(bytes) !== e.outcome.manifestSha256) throw new Error(`evidence manifest ${manifestPath(dir)} hashes to ${sha256Hex(bytes)}, done record says ${e.outcome.manifestSha256}`);
      out.set(e.op, bytes);
    }
  }
  return out;
}

export function collectSnapshot(request: SnapshotPublishRequest): Collected {
  const { arc, runDir, highWater, specs } = request;
  const { bytes, events } = eventsPrefix(runDir, highWater);
  const state = fold(arc, events);
  const files = new Map<RepoPath, Buffer>();
  const put = (path: string, content: Buffer): void => {
    if (!allowlisted(path)) throw new Error(`snapshot: ${path} is not an allowlisted snapshot path`);
    if (files.has(repoPath(path))) throw new Error(`snapshot: ${path} collected twice`);
    files.set(repoPath(path), content);
  };
  put(EVENTS_FILE, bytes);
  put('state.json', Buffer.from(fileJson(state), 'utf8'));
  for (const spec of specs) put(`specs/${spec.unit}.json`, readFileSync(spec.path));
  for (const id of state.needsUser) {
    put(`needs-user/${id}.json`, readFileSync(join(runDir, 'needs-user', `${id}.json`)));
    const ack = join(runDir, 'needs-user', `${id}.ack.json`);
    if (existsSync(ack)) put(`needs-user/${id}.ack.json`, readFileSync(ack));
  }
  for (const [op, manifest] of evidenceManifests(events)) put(`evidence-manifests/${parseOpId(op).seq}.json`, manifest);
  return files;
}

const byPath = <T extends { readonly path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function manifestOf(arc: ArcId, highWater: number, files: Collected): SnapshotManifest {
  const entries = [...files].map(([path, bytes]) => ({ path, sha256: sha256(sha256Hex(bytes)), size: bytes.length })).sort(byPath);
  return { v: SCHEMA_VERSION, schema: SNAPSHOT_SCHEMA, arc, highWater, files: entries };
}

/** Writes each file as a blob and the whole set as a tree, through a temporary index. */
function writeSnapshotTree(repo: AbsPath, files: Collected): Sha {
  const tmp = mkdtempSync(join(tmpdir(), 'roadmap-snapshot-'));
  try {
    const indexFile = absPath(join(tmp, 'index'));
    const info = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, bytes]) => {
      const blob = sha(git(repo, ['hash-object', '-w', '--stdin'], { input: bytes }).trim());
      return `100644 ${blob}\t${path}\0`;
    });
    git(repo, ['update-index', '--add', '-z', '--index-info'], { indexFile, input: info.join('') });
    return writeTreeFromIndex(repo, indexFile);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------
// Verification

export type SnapshotVerification =
  | Readonly<{ kind: 'verified'; manifest: SnapshotManifest; manifestSha256: Sha256Hex }>
  | Readonly<{ kind: 'mismatch'; detail: string }>;

/**
 * Re-reads a snapshot commit: its tree holds `manifest.json` and exactly the files it lists, every file
 * allowlisted and hashing as listed, and `events.jsonl` ends at the manifest's high-water mark.
 */
export function verifySnapshot(repo: AbsPath, commit: Sha): SnapshotVerification {
  const mismatch = (detail: string): SnapshotVerification => ({ kind: 'mismatch', detail });
  const entries = lsTree(repo, commit);
  const manifestEntry = entries.find((e) => e.path === SNAPSHOT_MANIFEST);
  if (manifestEntry === undefined) return mismatch('no manifest.json');
  const manifestText = blobText(repo, manifestEntry.object);
  const manifest = snapshotManifest(JSON.parse(manifestText), `${commit}:${SNAPSHOT_MANIFEST}`);
  const listed = new Map(manifest.files.map((f) => [f.path as string, f]));
  for (const e of entries) {
    if (e.path === SNAPSHOT_MANIFEST) continue;
    if (!allowlisted(e.path)) return mismatch(`${e.path} is not an allowlisted snapshot path`);
    const want = listed.get(e.path);
    if (want === undefined) return mismatch(`${e.path} is not in the manifest`);
    const bytes = Buffer.from(blobText(repo, e.object), 'utf8');
    if (sha256Hex(bytes) !== want.sha256 || bytes.length !== want.size) return mismatch(`${e.path} hashes to ${sha256Hex(bytes)} (${bytes.length} bytes), manifest says ${want.sha256} (${want.size})`);
    listed.delete(e.path);
  }
  if (listed.size > 0) return mismatch(`manifest lists missing files ${[...listed.keys()].join(', ')}`);
  const events = entries.find((e) => e.path === EVENTS_FILE);
  if (events === undefined) return mismatch('no events.jsonl');
  const lines = blobText(repo, events.object).split('\n');
  if (lines.pop() !== '' || lines.length !== manifest.highWater) return mismatch(`events.jsonl holds ${lines.length} lines, high-water mark ${manifest.highWater}`);
  if (parseEventLine(lines[lines.length - 1]!).seq !== manifest.highWater) return mismatch(`events.jsonl ends at another seq than ${manifest.highWater}`);
  return { kind: 'verified', manifest, manifestSha256: sha256(sha256Hex(manifestText)) };
}

/** A blob's content. Every snapshot file is UTF-8 JSON the executor wrote, so text round-trips its bytes. */
const blobText = (repo: AbsPath, blob: Sha): string => gitRun(repo, ['cat-file', 'blob', blob]).stdout;

// ---------------------------------------------------------------------------------------------------
// The op

function prepare(repo: AbsPath, request: SnapshotPublishRequest): IntentBody<'snapshot.publish'> {
  const ref = snapshotRef(request.arc);
  const files = new Map(collectSnapshot(request));
  const manifestBytes = Buffer.from(canonicalJson(manifestOf(request.arc, request.highWater, files)), 'utf8');
  files.set(repoPath(SNAPSHOT_MANIFEST), manifestBytes);
  const old = refTarget(repo, ref);
  const commit: CommitInputs<readonly [] | readonly [Sha]> = {
    tree: writeSnapshotTree(repo, files),
    parents: old === null ? [] : [old],
    author: request.identity.author,
    committer: request.identity.committer,
    message: request.message,
    gpgsign: false,
  };
  return {
    expect: { ref, old, highWater: request.highWater, manifestSha256: sha256(sha256Hex(manifestBytes)), commit },
    post: { new: commitTree(repo, commit) },
  };
}

function act(repo: AbsPath, intent: IntentOf<'snapshot.publish'>): void {
  const { ref, old, commit } = intent.expect;
  const next = intent.post.new;
  crashPoint('snapshot.act-start');
  const at = refTarget(repo, ref);
  if (at !== old) throw new SnapshotStateError(ref, `at ${at ?? 'nothing'}, recorded old ${old ?? 'absent'}`);
  if (catFileType(repo, commit.tree) !== 'tree') throw new SnapshotStateError(ref, `recorded tree ${commit.tree} is missing`);
  const made = commitTree(repo, commit);
  if (made !== next) throw new SnapshotStateError(ref, `commit ${made}, recorded ${next}`);
  crashPoint('snapshot.after-commit-tree');
  updateRefCas(repo, ref, next, old ?? 'absent');
  crashPoint('snapshot.act-end');
}

/** null when the postcondition holds: ref = new, and its tree verifies against its own manifest at the recorded mark. */
export function snapshotPostcondition(repo: AbsPath, intent: IntentOf<'snapshot.publish'>): string | null {
  const { ref, highWater, manifestSha256 } = intent.expect;
  const next = intent.post.new;
  const at = refTarget(repo, ref);
  if (at !== next) return `${ref} at ${at ?? 'nothing'}, expected ${next}`;
  const check = verifySnapshot(repo, next);
  if (check.kind === 'mismatch') return check.detail;
  if (check.manifestSha256 !== manifestSha256) return `manifest hashes to ${check.manifestSha256}, recorded ${manifestSha256}`;
  if (check.manifest.highWater !== highWater) return `high-water mark ${check.manifest.highWater}, recorded ${highWater}`;
  return null;
}

function verify(repo: AbsPath, intent: IntentOf<'snapshot.publish'>): OpOutcome['snapshot.publish'] {
  const problem = snapshotPostcondition(repo, intent);
  if (problem !== null) throw new SnapshotStateError(intent.expect.ref, problem);
  return { kind: 'published' };
}

export function snapshotPublishSteps(repo: AbsPath): GitSteps<'snapshot.publish', SnapshotPublishRequest> {
  return {
    kind: 'snapshot.publish',
    prepare: async (request) => prepare(repo, request),
    act: async (intent) => act(repo, intent),
    verify: async (intent) => verify(repo, intent),
  };
}
