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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome } from '../core/events.ts';
import type { MutantOf } from '../core/events.ts';
import { type Sha, type Sha256Hex, sha } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { inputPath } from '../input/inforce.ts';
import { checkPatch } from './patchcheck.ts';
import { GitError, catFileType, gitRun, readTree, revParse, statusPorcelainV2Z, symbolicHead, worktreeAdd, worktreeList, writeTreeFromIndex } from './git.ts';

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
