// `salvage.commit` (R8): turn whatever an implementer left in its worktree into one deterministic commit
// on the unit branch, through a controlled temporary index, so nothing rides along by accident.
//
// Classify `status --porcelain=v2 -z` (every staged, unstaged and untracked path, one per path). Approved =
// inside the pinned scope, not under `.roadmap/`, not a declared evidence/state path. Ignored files are
// never approved and never touched, so status runs without `--ignored` (listing every file of an ignored
// `node_modules` would buy nothing). Everything else is rejected: its content is copied out to
// `<rejectedRoot>/<rejectedManifestSha256>/` with a manifest, then restored from HEAD (tracked) or
// removed (untracked) in the worktree.
//
// The tree: a temporary GIT_INDEX_FILE copied from the real index → rejected paths reset to the old tree
// (so pre-staged rejected content cannot ride along) → approved paths updated from the worktree
// (additions, modifications, deletions) → write-tree. The act: re-derive the approved set, rejected
// manifest and tree and check them against the record → copy rejected content out → commit-tree with the
// recorded inputs → `update-ref <branch> new old` (CAS) → read-tree new into the real index → restore
// rejected paths. Postcondition: branch = HEAD = new, real index tree = new's tree, status clean except
// ignored.
//
// Determinism: the tree follows from the worktree content and the rules, and the commit from the tree,
// parent, recorded identity, dates and message, so a redo from the same inputs makes the same object.
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { CommitInputs, IntentOf, OpOutcome } from '../core/events.ts';
import { durableMkdir, durableWrite } from '../core/fsx.ts';
import { type Sha, type Sha256Hex, sha256 } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { Fields, type Read, bool, literal, nat, nullable, object, oneOf, sortedBy, version } from '../core/validate.ts';
import { type AbsPath, type RefName, type RepoPath, type RepoPattern, absPath, repoPath } from '../core/values.ts';
import { SCHEMA_VERSION, type SchemaVersion } from '../core/version.ts';
import { copyIfChanged, fileSha256 } from './evidence.ts';
import {
  type Identity, type TreeEntry, commitTree, git, gitPath, lsTree, readTree, refTarget, revParse, statusPorcelainV2Z,
  symbolicHead, updateRefCas, writeTreeFromIndex,
} from './git.ts';

/** The unit's pinned rules, from its dispatch record and spec. Recovery rebuilds the op from the same rules. */
export type SalvageRules = Readonly<{
  /** The pinned scope envelope (dispatch record). A path is in scope if it matches a pattern or lies under one. */
  scope: readonly RepoPattern[];
  /** Declared evidence and state paths (spec lane `evidenceGlobs`): never committed. */
  excluded: readonly RepoPattern[];
  /** Rejected content is preserved under `<rejectedRoot>/<rejectedManifestSha256>/`. */
  rejectedRoot: AbsPath;
}>;

export type SalvageRequest = Readonly<{ worktree: AbsPath; branch: RefName; identity: Identity; message: string }>;

/** An approved path: `present` → its worktree content is committed; absent → it is deleted. */
export type ApprovedChange = Readonly<{ path: RepoPath; present: boolean }>;

export type RejectReason = 'roadmap-dir' | 'excluded' | 'out-of-scope';

/** `tracked`: the path exists in the old tree (restored from HEAD), else it is removed. `content: null`: deleted in the worktree. */
export type RejectedEntry = Readonly<{
  path: RepoPath;
  reason: RejectReason;
  tracked: boolean;
  content: Readonly<{ sha256: Sha256Hex; size: number }> | null;
}>;

export type RejectedManifest = Readonly<{ v: SchemaVersion; complete: true; entries: readonly RejectedEntry[] }>;

export type SalvageClassification = Readonly<{ old: Sha; approved: readonly ApprovedChange[]; rejected: RejectedManifest }>;

export type SalvagePlan = Readonly<{ request: SalvageRequest; classification: SalvageClassification }>;

/** Nothing approved and nothing rejected: there is nothing to commit and no intent is written. */
export type SalvageDecision = Readonly<{ kind: 'no-change' }> | Readonly<{ kind: 'commit'; plan: SalvagePlan }>;

/** Conflict entries in the index: salvage refuses and the caller parks with the tree preserved. */
export class SalvageUnmergedError extends Error {
  readonly worktree: AbsPath;
  readonly paths: readonly RepoPath[];
  constructor(worktree: AbsPath, paths: readonly RepoPath[]) {
    super(`salvage ${worktree}: unmerged paths ${paths.join(', ')}`);
    this.name = 'SalvageUnmergedError';
    this.worktree = worktree;
    this.paths = paths;
  }
}

export class SalvageStateError extends Error {
  readonly worktree: AbsPath;
  constructor(worktree: AbsPath, detail: string) {
    super(`salvage ${worktree}: ${detail}`);
    this.name = 'SalvageStateError';
    this.worktree = worktree;
  }
}

// ---------------------------------------------------------------------------------------------------
// Classification

/** `pattern` as a glob, or as a directory prefix (`src` and `src/` both cover `src/a/b`). */
export function matchesPattern(path: RepoPath, pattern: RepoPattern): boolean {
  const p = pattern.replace(/\/+$/, '');
  return path === p || path.startsWith(`${p}/`) || matchesGlob(path, p) || matchesGlob(path, `${p}/**`);
}

const matchesAny = (path: RepoPath, patterns: readonly RepoPattern[]): boolean => patterns.some((p) => matchesPattern(path, p));

function rejectReason(rules: SalvageRules, path: RepoPath): RejectReason | null {
  if (path === '.roadmap' || path.startsWith('.roadmap/')) return 'roadmap-dir';
  if (matchesAny(path, rules.excluded)) return 'excluded';
  if (!matchesAny(path, rules.scope)) return 'out-of-scope';
  return null;
}

const byPath = <T extends { readonly path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function oldTreeMap(worktree: AbsPath, old: Sha): ReadonlyMap<RepoPath, TreeEntry> {
  return new Map(lsTree(worktree, old).map((e) => [e.path, e]));
}

/** Classifies every changed path of the worktree against the rules. Throws SalvageUnmergedError on conflicts. */
export function classifySalvage(rules: SalvageRules, worktree: AbsPath, old: Sha): SalvageClassification {
  const status = statusPorcelainV2Z(worktree, false);
  const unmerged = status.filter((s) => s.type === 'unmerged').map((s) => s.path);
  if (unmerged.length > 0) throw new SalvageUnmergedError(worktree, unmerged);
  const tracked = oldTreeMap(worktree, old);
  const approved: ApprovedChange[] = [];
  const rejected: RejectedEntry[] = [];
  for (const entry of status) {
    if (entry.type !== 'changed' && entry.type !== 'untracked') continue;
    const full = join(worktree, entry.path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    const reason = rejectReason(rules, entry.path);
    if (reason === null) {
      approved.push({ path: entry.path, present: stat !== undefined });
      continue;
    }
    if (stat !== undefined && !stat.isFile()) throw new SalvageStateError(worktree, `rejected path ${entry.path} is not a regular file; cannot preserve it`);
    rejected.push({
      path: entry.path,
      reason,
      tracked: tracked.has(entry.path),
      content: stat === undefined ? null : { sha256: sha256(sha256Hex(readFileSync(full))), size: stat.size },
    });
  }
  return { old, approved: approved.sort(byPath), rejected: { v: SCHEMA_VERSION, complete: true, entries: rejected.sort(byPath) } };
}

export const approvedSetSha256 = (approved: readonly ApprovedChange[]): Sha256Hex => sha256(sha256Hex(canonicalJson(approved)));
const manifestBytes = (manifest: RejectedManifest): string => canonicalJson(manifest);
export const rejectedManifestSha256 = (manifest: RejectedManifest): Sha256Hex => sha256(sha256Hex(manifestBytes(manifest)));

/** Decides whether there is anything to salvage. The worktree's HEAD must be attached to `request.branch`. */
export function planSalvage(rules: SalvageRules, request: SalvageRequest): SalvageDecision {
  const attached = symbolicHead(request.worktree);
  if (attached !== request.branch) throw new SalvageStateError(request.worktree, `HEAD on ${attached ?? 'detached'}, expected ${request.branch}`);
  const old = revParse(request.worktree, request.branch);
  const classification = classifySalvage(rules, request.worktree, old);
  if (classification.approved.length === 0 && classification.rejected.entries.length === 0) return { kind: 'no-change' };
  return { kind: 'commit', plan: { request, classification } };
}

// ---------------------------------------------------------------------------------------------------
// Rejected content

const rejectedEntry: Read<RejectedEntry> = object((f) => ({
  path: f.get('path', (v, p) => repoPath(v, p)),
  reason: f.get('reason', oneOf(['roadmap-dir', 'excluded', 'out-of-scope'] as const)),
  tracked: f.get('tracked', bool),
  content: f.get('content', nullable(object((g) => ({ sha256: g.get('sha256', (v, p) => sha256(v, p)), size: g.get('size', nat) })))),
}));

const rejectedManifest: Read<RejectedManifest> = (value, path) => {
  const f = new Fields(value, path);
  const out = { v: f.get('v', version), complete: f.get('complete', literal(true)), entries: f.get('entries', sortedBy(rejectedEntry, (e) => e.path)) };
  f.end();
  return out;
};

export const rejectedDir = (rules: SalvageRules, manifestSha: Sha256Hex): AbsPath => absPath(join(rules.rejectedRoot, manifestSha));
const rejectedFile = (dir: AbsPath, path: RepoPath): string => join(dir, 'files', path);
const rejectedManifestPath = (dir: AbsPath): string => join(dir, 'manifest.json');

export type RejectedCheck = Readonly<{ kind: 'complete'; manifest: RejectedManifest }> | Readonly<{ kind: 'incomplete'; detail: string }>;

/** Re-reads a copy-out: the manifest must hash to the recorded value and every copied file must match it. */
export function checkRejected(dir: AbsPath, expected: Sha256Hex): RejectedCheck {
  const path = rejectedManifestPath(dir);
  if (!existsSync(path)) return { kind: 'incomplete', detail: 'no manifest' };
  const bytes = readFileSync(path);
  if (sha256Hex(bytes) !== expected) return { kind: 'incomplete', detail: `manifest hashes to ${sha256Hex(bytes)}, recorded ${expected}` };
  const manifest = rejectedManifest(JSON.parse(bytes.toString('utf8')), path);
  for (const entry of manifest.entries) {
    if (entry.content !== null && fileSha256(rejectedFile(dir, entry.path)) !== entry.content.sha256) {
      return { kind: 'incomplete', detail: `${entry.path} not copied intact` };
    }
  }
  return { kind: 'complete', manifest };
}

/** Idempotent: copies what is missing or differs, then writes the manifest last. */
function copyOut(dir: AbsPath, worktree: AbsPath, manifest: RejectedManifest): void {
  for (const entry of manifest.entries) {
    if (entry.content !== null) copyIfChanged(join(worktree, entry.path), rejectedFile(dir, entry.path), entry.content.sha256);
  }
  durableMkdir(dir);
  durableWrite(rejectedManifestPath(dir), manifestBytes(manifest));
}

// ---------------------------------------------------------------------------------------------------
// The tree, the index reconcile, the postcondition

/** Builds the salvage tree in a temporary copy of the worktree's index. The real index is not touched. */
function buildTree(worktree: AbsPath, classification: SalvageClassification): Sha {
  const tracked = oldTreeMap(worktree, classification.old);
  const tmp = mkdtempSync(join(tmpdir(), 'roadmap-salvage-'));
  try {
    const index = absPath(join(tmp, 'index'));
    copyFileSync(gitPath(worktree, 'index'), index);
    const opts = { indexFile: index };
    const rejected = classification.rejected.entries;
    const restore = rejected.flatMap((e) => {
      const t = tracked.get(e.path);
      return t === undefined ? [] : [`${t.mode} ${t.object}\t${t.path}\0`];
    });
    const drop = rejected.filter((e) => !tracked.has(e.path)).map((e) => `${e.path}\0`);
    if (restore.length > 0) git(worktree, ['update-index', '-z', '--index-info'], { ...opts, input: restore.join('') });
    if (drop.length > 0) git(worktree, ['update-index', '-z', '--force-remove', '--stdin'], { ...opts, input: drop.join('') });
    const approved = classification.approved.map((a) => `${a.path}\0`);
    if (approved.length > 0) git(worktree, ['update-index', '-z', '--add', '--remove', '--stdin'], { ...opts, input: approved.join('') });
    return writeTreeFromIndex(worktree, index);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Brings the real index and the worktree to the new commit: read-tree it into the index, restore rejected
 * tracked paths from it and remove rejected untracked ones (their content is already copied out).
 * Idempotent, so recovery finishes an interrupted run by calling it again.
 */
export function finishIndexReconcile(worktree: AbsPath, next: Sha, rejected: RejectedManifest): void {
  readTree(worktree, next);
  crashPoint('salvage.after-read-tree');
  const tracked = rejected.entries.filter((e) => e.tracked).map((e) => `${e.path}\0`);
  if (tracked.length > 0) {
    git(worktree, ['--literal-pathspecs', 'checkout', next, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: tracked.join('') });
  }
  for (const entry of rejected.entries) if (!entry.tracked) rmSync(join(worktree, entry.path), { force: true });
}

/** null when the postcondition holds, else what is wrong. */
export function salvagePostcondition(intent: IntentOf<'salvage.commit'>): string | null {
  const { worktree, branch, commit } = intent.expect;
  const next = intent.post.new;
  const at = refTarget(worktree, branch);
  if (at !== next) return `${branch} at ${at ?? 'nothing'}, expected ${next}`;
  const head = revParse(worktree, 'HEAD');
  if (head !== next) return `HEAD at ${head}, expected ${next}`;
  const indexTree = writeTreeFromIndex(worktree, gitPath(worktree, 'index'));
  if (indexTree !== commit.tree) return `index tree ${indexTree}, expected ${commit.tree}`;
  const dirty = statusPorcelainV2Z(worktree, false);
  if (dirty.length > 0) return `status not clean: ${dirty.map((s) => s.path).join(', ')}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The op

function prepare(plan: SalvagePlan): IntentBody<'salvage.commit'> {
  const { request, classification } = plan;
  const commit: CommitInputs<readonly [Sha]> = {
    tree: buildTree(request.worktree, classification),
    parents: [classification.old],
    author: request.identity.author,
    committer: request.identity.committer,
    message: request.message,
    gpgsign: false,
  };
  const next = commitTree(request.worktree, commit);
  return {
    expect: {
      worktree: request.worktree,
      branch: request.branch,
      old: classification.old,
      approvedSetSha256: approvedSetSha256(classification.approved),
      rejectedManifestSha256: rejectedManifestSha256(classification.rejected),
      commit,
    },
    post: { new: next },
  };
}

/**
 * Re-derives the intent's inputs from the worktree and checks them against the record: the approved set,
 * the rejected manifest and the tree. The worktree is this intent's input, so a mismatch means someone
 * changed it after the intent was written; the string says what differs.
 */
export function rederiveInputs(rules: SalvageRules, intent: IntentOf<'salvage.commit'>): SalvageClassification | string {
  const { worktree, old, commit } = intent.expect;
  const c = classifySalvage(rules, worktree, old);
  if (approvedSetSha256(c.approved) !== intent.expect.approvedSetSha256) return 'the approved path set differs from the recorded one';
  if (rejectedManifestSha256(c.rejected) !== intent.expect.rejectedManifestSha256) return 'the rejected content differs from the recorded manifest';
  const tree = buildTree(worktree, c);
  if (tree !== commit.tree) return `the approved content builds tree ${tree}, recorded ${commit.tree}`;
  return c;
}

function act(rules: SalvageRules, intent: IntentOf<'salvage.commit'>): void {
  const { worktree, branch, old, commit } = intent.expect;
  const next = intent.post.new;
  crashPoint('salvage.act-start');
  const at = refTarget(worktree, branch);
  if (at !== old) throw new SalvageStateError(worktree, `${branch} at ${at ?? 'nothing'}, recorded old ${old}`);
  const c = rederiveInputs(rules, intent);
  if (typeof c === 'string') throw new SalvageStateError(worktree, c);
  copyOut(rejectedDir(rules, intent.expect.rejectedManifestSha256), worktree, c.rejected);
  crashPoint('salvage.after-copy-out');
  const made = commitTree(worktree, commit);
  if (made !== next) throw new SalvageStateError(worktree, `commit ${made}, recorded ${next}`);
  crashPoint('salvage.after-commit-tree');
  updateRefCas(worktree, branch, next, old);
  crashPoint('salvage.after-cas');
  finishIndexReconcile(worktree, next, c.rejected);
  crashPoint('salvage.act-end');
}

function verify(intent: IntentOf<'salvage.commit'>): OpOutcome['salvage.commit'] {
  const problem = salvagePostcondition(intent);
  if (problem !== null) throw new SalvageStateError(intent.expect.worktree, problem);
  return { kind: 'committed' };
}

export function salvageCommitSteps(rules: SalvageRules): GitSteps<'salvage.commit', SalvagePlan> {
  return {
    kind: 'salvage.commit',
    prepare: async (plan) => prepare(plan),
    act: async (intent) => act(rules, intent),
    verify: async (intent) => verify(intent),
  };
}
