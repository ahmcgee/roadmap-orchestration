// `roadmap corpus pin --repo <path> --commit <ref> --out <file>` (M4a, R2, H22): a host act. Resolves the corpus guide's
// source at `commit` (same-repo `git show`, other-repo `git -C`, checkout: the CLI's clone, fetched after its write-once
// `remote.json` is checked), parses the rules blocks, diffs them against the baseline's `json roadmap-rules` registry
// and writes the pin by atomic rename. PLACEHOLDER (step 0a, H3): step A1 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { Sha256Hex } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import type { CorpusPin } from '../corpus/types.ts';
import type { StartupRejection } from '../preflight/startup.ts';

export type CorpusPinArgs = Readonly<{ repo: AbsPath; commit: string; out: AbsPath }>;
/** `pinned`: written to `out` (its sha256); `refused`: the guide or the source fails a corpus row (exit 78). */
export type CorpusPinOutcome =
  | Readonly<{ kind: 'pinned'; pin: CorpusPin; sha256: Sha256Hex }>
  | Readonly<{ kind: 'refused'; rejection: Extract<StartupRejection, { kind: 'corpus-invalid' }> }>;

export async function corpusPin(_args: CorpusPinArgs): Promise<CorpusPinOutcome> {
  return notYet('roadmap corpus pin', 'A1');
}
