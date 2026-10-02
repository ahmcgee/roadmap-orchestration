// `mutant.apply` (M3 step B3; DESIGN-1.0.md §2.5 "Mutants are executed, never judged by reading"; plan "Mutant
// reproduction"): a vacuity finding's mutant (its patch, kept as `inputs/<patchSha256>.patch` when the finding opened)
// applied in a detached worktree at `at`, so its lane runs on the patched tree under `purpose: mutant` (G13: the
// record carries the patched tree's real id and never certifies).
//
// The outcome is a pure function of `at` and the patch (`patchedTree`, through a private index): the patched tree's id,
// or `inapplicable` with git's reason when the patch does not apply to `at`. The act makes the worktree (detached at
// `at`) and applies the patch to its index and files (`git apply --index`) when it applies; verify reads the worktree
// back and requires exactly that state: HEAD detached at `at`, and the index tree the patched tree with the files
// matching it (applied), or a clean checkout of `at` (inapplicable). The worktree is the caller's to remove
// (`worktree.remove`, citing the lane's evidence), as a verification checkout is.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { IntentOf, OpOutcome } from '../core/events.ts';
import { type FindingId, type Sha, type Sha256Hex, sha } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { inputPath } from '../input/inforce.ts';
import { catFileType, gitRun, readTree, revParse, statusPorcelainV2Z, symbolicHead, worktreeAdd, worktreeList, writeTreeFromIndex } from './git.ts';

/** Where a vacuity finding's mutant patch is kept: `inputs/<sha256>.patch` (named by its `finding-opened`). */
export const MUTANT_PATCH_INPUT = 'patch';

export class MutantStateError extends Error {
  constructor(worktree: AbsPath, detail: string) {
    super(`mutant.apply ${worktree}: ${detail}`);
    this.name = 'MutantStateError';
  }
}

export type MutantRequest = Readonly<{ worktree: AbsPath; at: Sha; finding: FindingId; patchSha256: Sha256Hex }>;

/** The kept patch of a finding's mutant; its absence is a bug (the finding's opener keeps it first). */
export function mutantPatchPath(runDir: AbsPath, patchSha256: Sha256Hex): AbsPath {
  const path = inputPath(runDir, patchSha256, MUTANT_PATCH_INPUT);
  if (!existsSync(path)) throw new Error(`the mutant patch ${patchSha256} is not kept at ${path}`);
  return path;
}

/** What the patch makes of `at`: the patched tree, or why it does not apply. Pure over the object store. */
export function patchedTree(repo: AbsPath, at: Sha, patch: AbsPath): Readonly<{ kind: 'applied'; tree: Sha }> | Readonly<{ kind: 'inapplicable'; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-mutant-'));
  try {
    const index = absPath(join(dir, 'index'));
    readTree(repo, revParse(repo, `${at}^{tree}`), index);
    const r = gitRun(repo, ['apply', '--cached', patch], { indexFile: index, okCodes: [0, 1, 128] });
    if (r.code !== 0) {
      const detail = gitRun(repo, ['apply', '--cached', '--check', patch], { indexFile: index, okCodes: [0, 1, 128] });
      return { kind: 'inapplicable', detail: `the patch does not apply to ${at} (git apply exited ${r.code}${detail.stdout === '' ? '' : `: ${detail.stdout.trim()}`})` };
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
export const mutantOutcome = (repo: AbsPath, runDir: AbsPath, intent: IntentOf<'mutant.apply'>): OpOutcome['mutant.apply'] =>
  patchedTree(repo, intent.expect.at, mutantPatchPath(runDir, intent.expect.patchSha256));

export function mutantApplySteps(repo: AbsPath, runDir: AbsPath): GitSteps<'mutant.apply', MutantRequest> {
  const outcomeOf = (intent: IntentOf<'mutant.apply'>): OpOutcome['mutant.apply'] => mutantOutcome(repo, runDir, intent);
  return {
    kind: 'mutant.apply',
    prepare: async (request): Promise<IntentBody<'mutant.apply'>> => {
      if (existsSync(request.worktree)) throw new MutantStateError(request.worktree, 'already exists');
      if (catFileType(repo, request.at) !== 'commit') throw new MutantStateError(request.worktree, `${request.at} is not a commit`);
      mutantPatchPath(runDir, request.patchSha256);
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
