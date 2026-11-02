// Per-system notes are ordinary product files, selected at the role's checkout commit. Only their
// paths enter the neutral role input; the corpus remains the source of normative claims.
import type { Sha, SystemName } from '../core/ids.ts';
import { type AbsPath, type RepoPath, repoPath } from '../core/values.ts';
import { lsTree } from '../git/git.ts';
import type { RepoConfig } from '../routing/layers.ts';

export function systemNotes(repo: AbsPath, head: Sha, systems: readonly SystemName[], config: RepoConfig | null): readonly RepoPath[] {
  if (systems.length === 0) return [];
  const root = config?.systemNotesDir ?? 'docs/systems';
  const paths = new Set(systems.map((s) => repoPath(`${root === '.' ? '' : `${root}/`}${s}.md`)));
  return lsTree(repo, head).filter((e) => (e.mode === '100644' || e.mode === '100755') && paths.has(e.path)).map((e) => e.path).sort();
}
