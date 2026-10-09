// `mutant.apply` (M3 step B3; DESIGN-1.0.md §2.5 "Mutants are executed, never judged by reading"; plan "Mutant
// reproduction"): a mutant patch (kept as `inputs/<patchSha256>.patch`) applied in a detached worktree at `at`, so a lane
// runs on the patched tree under `purpose: mutant` (G13: the record carries the patched tree's real id and never
// certifies). M4a rev 3 (D2): a mutant is made `of` a vacuity finding (its patch, kept when the finding opened) or of a
// unit attempt's mutation smoke (the attempt's production diff reversed, src/pipeline/smoke.ts); every intent is written
// with `of` (a 1.0.0-dev.6 intent's `finding` reads as `of: finding`, `mutantSubjectDefault`).
//
// The outcome is a pure function of `at` and the patch (`patchedTree`, through a private index): the patched tree's id,
// or `inapplicable` with git's stderr when the patch does not apply to `at`. A patch git cannot parse at all is `corrupt`
// (H6, F14: `git apply --numstat` fails; its stderr kept), distinct from `inapplicable`: callers check it before the op
// (reproduce parks it, smoke reads it as inconclusive), and `prepare` refuses one, so no intent ever names a corrupt
// patch. The act makes the worktree (detached at `at`) and applies the patch to its index and files (`git apply
// --index`) when it applies; verify reads the worktree back and requires exactly that state: HEAD detached at `at`, and
// the index tree the patched tree with the files matching it (applied), or a clean checkout of `at` (inapplicable). The
// worktree is the caller's to remove (`worktree.remove`, citing the lane's evidence), as a verification checkout is.
//
// M4b (paid run 3): a vacuity lens writes its mutant as exact replacements (`MutantEdit`), and `editsPatch` has git write
// the patch from them against the audited tree, so a finding's kept patch is never hand-written.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome } from '../core/events.ts';
import type { MutantOf } from '../core/events.ts';
import { type Sha, type Sha256Hex, sha } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, absPath, repoPath } from '../core/values.ts';
import { inputPath } from '../input/inforce.ts';
import { checkPatch } from './patchcheck.ts';
import { GitError, catFileType, git, gitRun, readTree, revParse, statusPorcelainV2Z, symbolicHead, worktreeAdd, worktreeList, writeTreeFromIndex } from './git.ts';

/** Where a mutant patch is kept: `inputs/<sha256>.patch` (a finding's, named by its `finding-opened`; a smoke's, by its intent). */
export const MUTANT_PATCH_INPUT = 'patch';

export class MutantStateError extends Error {
  constructor(worktree: AbsPath, detail: string) {
    super(`mutant.apply ${worktree}: ${detail}`);
    this.name = 'MutantStateError';
  }
}

export type MutantRequest = Readonly<{ worktree: AbsPath; at: Sha; of: MutantOf; patchSha256: Sha256Hex }>;

/** A kept mutant patch; its absence is a bug (the finding's opener, or the smoke run, keeps it first). */
export function mutantPatchPath(runDir: AbsPath, patchSha256: Sha256Hex): AbsPath {
  const path = inputPath(runDir, patchSha256, MUTANT_PATCH_INPUT);
  if (!existsSync(path)) throw new Error(`the mutant patch ${patchSha256} is not kept at ${path}`);
  return path;
}

/** What a patch makes of a tree: the patched tree, why it does not apply (git's stderr), or why git cannot parse it. */
export type PatchedTree =
  | Readonly<{ kind: 'applied'; tree: Sha }>
  | Readonly<{ kind: 'inapplicable'; detail: string }>
  | Readonly<{ kind: 'corrupt'; detail: string }>;

/** What the patch makes of `at`: the patched tree, or why it does not apply, or that it is corrupt. Pure over the object store. */
export function patchedTree(repo: AbsPath, at: Sha, patch: AbsPath): PatchedTree {
  const check = checkPatch(repo, readFileSync(patch));
  if (check.kind === 'corrupt') return { kind: 'corrupt', detail: `the patch is corrupt: ${check.stderr}` };
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-mutant-'));
  try {
    const index = absPath(join(dir, 'index'));
    readTree(repo, revParse(repo, `${at}^{tree}`), index);
    try {
      gitRun(repo, ['apply', '--cached', patch], { indexFile: index });
    } catch (error) {
      if (!(error instanceof GitError) || error.code === null) throw error;
      return { kind: 'inapplicable', detail: `the patch does not apply to ${at} (git apply exited ${error.code}${error.stderr.trim() === '' ? '' : `: ${error.stderr.trim()}`})` };
    }
    return { kind: 'applied', tree: writeTreeFromIndex(repo, index) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * One exact replacement of a vacuity lens's mutant (M4b; replaces the hand-written unified diff, whose hunk counts a
 * model miscounts: paid M4b run 3, audit-4): in `path` (relative to the repository root), the one occurrence of `old`
 * becomes `new` (which may be empty).
 */
export type MutantEdit = Readonly<{ path: string; old: string; new: string }>;

/** A mutant's edits as a patch git wrote against `at`, or why they cannot be made there. */
export type EditsPatch = Readonly<{ kind: 'patch'; patch: string }> | Readonly<{ kind: 'refused'; reason: string }>;

/**
 * The unified diff `edits` make of `at`, written by git (`diff --full-index` between `at`'s tree and the edited one,
 * built through a private index), so it always parses and applies to `at`. Edits apply in order, each to the file as
 * the earlier ones left it; one is refused when its path names no file at `at`, its `old` occurs there other than
 * exactly once (or is empty), or it changes nothing. Writes only objects to the store.
 */
export function editsPatch(repo: AbsPath, at: Sha, edits: readonly MutantEdit[]): EditsPatch {
  const files = new Map<RepoPath, Readonly<{ mode: string; text: string }>>();
  for (const [i, e] of edits.entries()) {
    const where = `edit ${i + 1} (${e.path})`;
    let path: RepoPath;
    try {
      path = repoPath(e.path);
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      return { kind: 'refused', reason: `${where}: the path is not relative to the repository root` };
    }
    let file = files.get(path);
    if (file === undefined) {
      const entry = git(repo, ['ls-tree', '-z', at, '--', path]).split('\0').filter((s) => s !== '');
      const m = entry.length === 1 ? /^(100644|100755) blob ([0-9a-f]{40})\t/.exec(entry[0]!) : null;
      if (m === null) return { kind: 'refused', reason: `${where}: no regular file at that path in ${at}` };
      file = { mode: m[1]!, text: git(repo, ['cat-file', 'blob', m[2]!]) };
    }
    if (e.old === '') return { kind: 'refused', reason: `${where}: old is empty` };
    const count = file.text.split(e.old).length - 1;
    if (count !== 1) return { kind: 'refused', reason: `${where}: old occurs ${count} times in the file at ${at}, not exactly once` };
    if (e.old === e.new) return { kind: 'refused', reason: `${where}: new equals old, so it changes nothing` };
    files.set(path, { mode: file.mode, text: file.text.replace(e.old, () => e.new) });
  }
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-mutant-'));
  try {
    const index = absPath(join(dir, 'index'));
    const tree = revParse(repo, `${at}^{tree}`);
    readTree(repo, tree, index);
    for (const [path, { mode, text }] of files) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: text }).trim();
      git(repo, ['update-index', '--cacheinfo', `${mode},${blob},${path}`], { indexFile: index });
    }
    const patch = git(repo, ['diff', '--no-renames', '--full-index', '--no-ext-diff', '--no-textconv', tree, writeTreeFromIndex(repo, index)]);
    return { kind: 'patch', patch };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const listed = (repo: AbsPath, path: AbsPath): boolean => worktreeList(repo).some((e) => e.path === path);

/** The worktree's state against the expected outcome: null when it is exactly that, else what differs. */
export function mutantProblem(repo: AbsPath, expect: IntentOf<'mutant.apply'>['expect'], outcome: OpOutcome['mutant.apply']): string | null {
  const { worktree, at } = expect;
  if (!listed(repo, worktree) || !existsSync(worktree)) return 'no worktree';
  const head = revParse(worktree, 'HEAD');
  if (head !== at) return `HEAD ${head}, expected ${at}`;
  if (symbolicHead(worktree) !== null) return 'HEAD is attached, expected detached';
  if (outcome.kind === 'inapplicable') return statusPorcelainV2Z(worktree, false).length === 0 ? null : 'not a clean checkout of the commit';
  const index = sha(gitRun(worktree, ['write-tree']).stdout.trim());
  if (index !== outcome.tree) return `the index tree is ${index}, expected the patched tree ${outcome.tree}`;
  const files = gitRun(worktree, ['diff', '--quiet'], { okCodes: [0, 1] });
  return files.code === 0 ? null : 'the files differ from the patched index';
}

/** The outcome an intent's recorded inputs make: what verify and the reconciler compare the worktree with. */
export function mutantOutcome(repo: AbsPath, runDir: AbsPath, intent: IntentOf<'mutant.apply'>): OpOutcome['mutant.apply'] {
  const made = patchedTree(repo, intent.expect.at, mutantPatchPath(runDir, intent.expect.patchSha256));
  // `prepare` refuses a corrupt patch, so an intent naming one is a bug.
  if (made.kind === 'corrupt') throw new MutantStateError(intent.expect.worktree, `its intent names a corrupt patch: ${made.detail}`);
  return made;
}

export function mutantApplySteps(repo: AbsPath, runDir: AbsPath): GitSteps<'mutant.apply', MutantRequest> {
  const outcomeOf = (intent: IntentOf<'mutant.apply'>): OpOutcome['mutant.apply'] => mutantOutcome(repo, runDir, intent);
  return {
    kind: 'mutant.apply',
    prepare: async (request): Promise<IntentBody<'mutant.apply'>> => {
      if (existsSync(request.worktree)) throw new MutantStateError(request.worktree, 'already exists');
      if (catFileType(repo, request.at) !== 'commit') throw new MutantStateError(request.worktree, `${request.at} is not a commit`);
      const made = patchedTree(repo, request.at, mutantPatchPath(runDir, request.patchSha256));
      if (made.kind === 'corrupt') throw new MutantStateError(request.worktree, made.detail);
      return { expect: request, post: null };
    },
    act: async (intent) => {
      const { worktree, at, patchSha256 } = intent.expect;
      crashPoint('mutant.act-start');
      if (!listed(repo, worktree)) worktreeAdd(repo, worktree, { type: 'detached', at });
      crashPoint('mutant.after-worktree');
      if (outcomeOf(intent).kind === 'applied') gitRun(worktree, ['apply', '--index', mutantPatchPath(runDir, patchSha256)]);
      crashPoint('mutant.act-end');
    },
    verify: async (intent) => {
      const outcome = outcomeOf(intent);
      const problem = mutantProblem(repo, intent.expect, outcome);
      if (problem !== null) throw new MutantStateError(intent.expect.worktree, problem);
      return outcome;
    },
  };
}
