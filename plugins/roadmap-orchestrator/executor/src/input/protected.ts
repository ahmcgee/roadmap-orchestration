// One repository write boundary for salvage and candidate validation. The corpus pin is revisioned input.
import type { CorpusPin } from '../corpus/types.ts';
import { readGuideBytes } from '../corpus/guide.ts';
import { type RepoPath, type RepoPattern, matchesPattern, repoPath, repoPattern } from '../core/values.ts';
/** Runtime/owner inputs stay protected; owner-managed contracts are ordinary unit source. */
// The explicit dot branch also protects hidden entries: glob wildcards omit them.
const ROADMAP_INPUTS = repoPattern('.roadmap/{!(contracts),.*}');
export function protectedPaths(corpus: Readonly<{pin: Readonly<{value: CorpusPin}>; guide: Readonly<{bytes: Buffer}>}> | null): readonly RepoPattern[] {
  if (corpus === null) return [ROADMAP_INPUTS];
  const guide = readGuideBytes(corpus.guide.bytes).guide;
  if (guide.source.kind !== 'same-repo') return [ROADMAP_INPUTS];
  const root = guide.source.root === '.' ? '' : guide.source.root + '/';
  return [ROADMAP_INPUTS, ...corpus.pin.value.files.map((f) => repoPattern(root + f.path)), ...guide.include.map((p) => repoPattern(root + p))];
}

import type { AbsPath } from '../core/values.ts';
import type { JournalView } from '../core/interfaces.ts';
import { requirePlanInForce, revisionInForce } from './inforce.ts';
export const protectedPathsInForce = (runDir: AbsPath, view: JournalView): readonly RepoPattern[] =>
  protectedPaths(revisionInForce(runDir, requirePlanInForce(runDir, view)).corpus);

/** A protected directory protects all descendants, including hidden paths omitted by glob `**`. */
export function isProtectedPath(path: RepoPath, patterns: readonly RepoPattern[]): boolean {
  let ancestor = path;
  for (;;) {
    if (patterns.some((pattern) => matchesPattern(ancestor, pattern))) return true;
    const slash = ancestor.lastIndexOf('/');
    if (slash < 0) return false;
    ancestor = repoPath(ancestor.slice(0, slash));
  }
}
