// One repository write boundary for salvage and candidate validation. The corpus pin is revisioned input.
import type { CorpusPin } from '../corpus/types.ts';
import { readGuideBytes } from '../corpus/guide.ts';
import { type RepoPattern, repoPattern } from '../core/values.ts';
/** The roadmap directory and same-repository pinned corpus files. External corpus files live outside this repo. */
export function protectedPaths(corpus: Readonly<{pin: Readonly<{value: CorpusPin}>; guide: Readonly<{bytes: Buffer}>}> | null): readonly RepoPattern[] {
  if (corpus === null) return [repoPattern('.roadmap')];
  const guide = readGuideBytes(corpus.guide.bytes).guide;
  if (guide.source.kind !== 'same-repo') return [repoPattern('.roadmap')];
  const root = guide.source.root === '.' ? '' : guide.source.root + '/';
  return [repoPattern('.roadmap'), ...corpus.pin.value.files.map((f) => repoPattern(root + f.path)), ...guide.include.map((p) => repoPattern(root + p))];
}

import type { AbsPath } from '../core/values.ts';
import type { JournalView } from '../core/interfaces.ts';
import { requirePlanInForce, revisionInForce } from './inforce.ts';
export const protectedPathsInForce = (runDir: AbsPath, view: JournalView): readonly RepoPattern[] =>
  protectedPaths(revisionInForce(runDir, requirePlanInForce(runDir, view)).corpus);
