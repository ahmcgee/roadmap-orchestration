// A mutant patch's syntax, checked before anything rests on it (M4a rev 3, H6, F14; final in step N0). `git apply
// --numstat` parses the patch and prints its stats without applying it or touching any index or tree: read-only. A patch
// git cannot parse is `corrupt`, kept apart from one that parses but no longer applies (`inapplicable`, src/git/mutant.ts),
// and its stderr is kept as the reason. Finding admission refuses a corrupt draft (N5); `reproduce` parks one (N3).
import { GitError, gitRun } from './git.ts';
import type { AbsPath } from '../core/values.ts';

export type PatchCheck = Readonly<{ kind: 'ok' }> | Readonly<{ kind: 'corrupt'; stderr: string }>;

/** Whether git can parse `patch` (its bytes), run in `repo`; never applies it. */
export function checkPatch(repo: AbsPath, patch: Uint8Array | string): PatchCheck {
  try {
    gitRun(repo, ['apply', '--numstat', '-'], { input: patch });
    return { kind: 'ok' };
  } catch (error) {
    if (!(error instanceof GitError) || error.code === null) throw error;
    return { kind: 'corrupt', stderr: error.stderr.trim() };
  }
}
