// `roadmap corpus pin --repo <path> --commit <ref> --out <file>` (M4a, R2, H22): a host act, no host lock. Reads the
// corpus guide committed at the product repo's HEAD, resolves its source at `commit` (same-repo: the product repo;
// other-repo: `git -C <path>`; checkout: the CLI's clone, fetched after its write-once `remote.json` is checked; see
// src/corpus/source.ts), parses the rules blocks, diffs them against the rules registry published at HEAD's
// `.roadmap/invariants.md` and writes the pin to `out` by atomic rename. A re-run on the same inputs writes the same
// bytes. HEAD is the baseline the next start's arc grows from: the skill commits `.roadmap/` before pinning.
import type { Sha256Hex } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import { guideAt } from '../corpus/guide.ts';
import { derivePin, writePin } from '../corpus/pin.ts';
import { EMPTY_REGISTRY, registryAt } from '../corpus/registry.ts';
import { openSource } from '../corpus/source.ts';
import type { CorpusPin } from '../corpus/types.ts';
import type { CorpusProblem } from '../phase0/types.ts';
import type { StartupRejection } from '../preflight/startup.ts';

export type CorpusPinArgs = Readonly<{ repo: AbsPath; commit: string; out: AbsPath }>;
/** `pinned`: written to `out` (its sha256); `refused`: the guide or the source fails a corpus row (exit 78). */
export type CorpusPinOutcome =
  | Readonly<{ kind: 'pinned'; pin: CorpusPin; sha256: Sha256Hex }>
  | Readonly<{ kind: 'refused'; rejection: Extract<StartupRejection, { kind: 'corpus-invalid' }> }>;

const refused = (problems: readonly CorpusProblem[]): CorpusPinOutcome => ({ kind: 'refused', rejection: { kind: 'corpus-invalid', problems } });

export async function corpusPin(args: CorpusPinArgs): Promise<CorpusPinOutcome> {
  const guide = guideAt(args.repo, 'HEAD');
  if (guide === null) return refused([{ type: 'guide-missing' }]);
  const source = openSource(args.repo, guide.guide, { rev: args.commit, fetch: true });
  if (source.kind === 'refused') return refused([source.problem]);
  const derived = derivePin(guide, source.opened, registryAt(args.repo, 'HEAD') ?? EMPTY_REGISTRY);
  if (derived.kind === 'refused') return refused(derived.problems);
  return { kind: 'pinned', pin: derived.pin, sha256: writePin(args.out, derived.pin) };
}
