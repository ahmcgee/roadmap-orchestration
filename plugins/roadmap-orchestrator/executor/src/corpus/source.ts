// Resolving a corpus guide's source at a commit (M4a "Corpus, pin and census" 2, H22): the git repo holding the corpus,
// the commit, and the files under `root`.
//   same-repo   the product repo itself;
//   other-repo  the git repo at the guide's absolute `path`;
//   checkout    a clone the CLI owns at `$(git-common-dir)/roadmap/corpus/<sha256 of the canonical remote>/repo`,
//               where the root agent commits. Its write-once `remote.json` `{remote}` beside `repo/` is published
//               before the first clone; every later use first requires it to equal the guide's canonical remote
//               (`source-remote-mismatch`). A clone is made in a temp sibling and renamed into place, so a crash
//               leaves no half clone. `fetch` (the pin CLI) fetches `origin` before resolving `rev`; re-derivation
//               of a pinned commit fetches only when the clone lacks it.
// Files are read as UTF-8 text (the corpus is Markdown); their sha256 is over those bytes. A source git cannot read
// (no repo, no such commit, no `root` at it, a failed clone or fetch) is the row `source-unreadable{detail}`.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Sha, type Sha256Hex, sha256 } from '../core/ids.ts';
import { canonicalJson, durableMkdir, durableRename, exclusivePublish } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import { type Read, object, str } from '../core/validate.ts';
import { type AbsPath, type RepoPath, absPath, matchesPattern, repoPath } from '../core/values.ts';
import { GitError, git, gitCommonDir, gitRun, lsTree, revParse } from '../git/git.ts';
import type { CorpusProblem } from '../phase0/types.ts';
import type { CorpusGuide, CorpusSource, PinSource } from './types.ts';

/**
 * The guide's remote as the cache keys it and the pin records it: trimmed, trailing slashes dropped. Nothing more is
 * folded (a `.git` suffix may name a different local repo), so two spellings of one remote are two clones, never one
 * clone for two remotes.
 */
export function canonicalRemote(remote: string): string {
  return remote.trim().replace(/\/+$/, '');
}

/** The checkout cache directory of a remote: keyed by the full sha256 of its canonical form (H22). */
export function checkoutCacheDir(repo: AbsPath, remote: string): AbsPath {
  return absPath(join(gitCommonDir(repo), 'roadmap', 'corpus', sha256Hex(canonicalRemote(remote))));
}

export const REMOTE_FILE = 'remote.json';
const remoteFile: Read<Readonly<{ remote: string }>> = object((f) => ({ remote: f.get('remote', str) }));

/** One file of the corpus at the commit: its path under root and its text. */
export type SourceFile = Readonly<{ path: RepoPath; text: string; sha256: Sha256Hex }>;

/** The source resolved at one commit: the pin's `source` and every included file, ascending by path. */
export type OpenedSource = Readonly<{ source: PinSource; files: readonly SourceFile[] }>;

export type SourceOutcome = Readonly<{ kind: 'opened'; opened: OpenedSource }> | Readonly<{ kind: 'refused'; problem: CorpusProblem }>;

export type Revision = Readonly<{ rev: string; fetch: boolean }>;

const unreadable = (detail: string): SourceOutcome => ({ kind: 'refused', problem: { type: 'source-unreadable', detail } });

/** Runs `step`, turning a git failure into `source-unreadable` with git's own message. */
function readable<T>(step: () => T): T | SourceOutcome {
  try {
    return step();
  } catch (error) {
    if (error instanceof GitError) return unreadable(error.message);
    throw error;
  }
}
const refusedOutcome = (v: unknown): v is SourceOutcome => typeof v === 'object' && v !== null && 'kind' in v && (v as SourceOutcome).kind === 'refused';

/** The checkout clone for `remote`, cloned on first use; `remote.json` checked or written first. */
function checkoutClone(repo: AbsPath, remote: string): AbsPath | SourceOutcome {
  const canonical = canonicalRemote(remote);
  const dir = checkoutCacheDir(repo, canonical);
  const file = join(dir, REMOTE_FILE);
  if (existsSync(file)) {
    if (remoteFile(JSON.parse(readFileSync(file, 'utf8')), file).remote !== canonical) return { kind: 'refused', problem: { type: 'source-remote-mismatch' } };
  } else {
    durableMkdir(dir);
    exclusivePublish(file, canonicalJson({ remote: canonical }));
  }
  const clone = absPath(join(dir, 'repo'));
  if (existsSync(clone)) return clone;
  const temp = join(dir, `repo.${process.pid}.tmp`);
  rmSync(temp, { recursive: true, force: true });
  const cloned = readable(() => git(dir, ['clone', '--quiet', '--', remote, temp]));
  if (refusedOutcome(cloned)) return cloned;
  durableRename(temp, clone);
  return clone;
}

/** The git repo the source lives in. */
function sourceRepo(repo: AbsPath, source: CorpusSource): AbsPath | SourceOutcome {
  switch (source.kind) {
    case 'same-repo':
      return repo;
    case 'other-repo':
      return existsSync(source.path) ? source.path : unreadable(`other-repo ${source.path} does not exist`);
    case 'checkout':
      return checkoutClone(repo, source.remote);
  }
}

function pinSourceOf(source: CorpusSource, commit: Sha): PinSource {
  switch (source.kind) {
    case 'same-repo':
      return { kind: 'same-repo', commit, root: source.root };
    case 'other-repo':
      return { kind: 'other-repo', commit, path: source.path, root: source.root };
    case 'checkout':
      return { kind: 'checkout', commit, remote: canonicalRemote(source.remote), root: source.root };
  }
}

const hasCommit = (repo: AbsPath, rev: string): boolean => gitRun(repo, ['cat-file', '-e', `${rev}^{commit}`], { okCodes: [0, 1, 128] }).code === 0;
const treeOf = (commit: Sha, root: RepoPath): string => (root === '.' ? `${commit}^{tree}` : `${commit}:${root}`);

/** The guide's source at `at.rev`: every blob under `root` matching an include pattern. */
export function openSource(repo: AbsPath, guide: CorpusGuide, at: Revision): SourceOutcome {
  const where = sourceRepo(repo, guide.source);
  if (refusedOutcome(where)) return where;
  const root = guide.source.root;
  const read = readable((): OpenedSource => {
    if (guide.source.kind === 'checkout' && (at.fetch || !hasCommit(where, at.rev))) git(where, ['fetch', '--quiet', 'origin']);
    const commit = revParse(where, `${at.rev}^{commit}`);
    const files = lsTree(where, treeOf(commit, root))
      .filter((e) => e.type === 'blob' && guide.include.some((p) => matchesPattern(e.path, p)))
      .map((e): SourceFile => {
        const text = git(where, ['cat-file', 'blob', e.object]);
        return { path: repoPath(e.path), text, sha256: sha256(sha256Hex(text)) };
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { source: pinSourceOf(guide.source, commit), files };
  });
  return refusedOutcome(read) ? read : { kind: 'opened', opened: read };
}
