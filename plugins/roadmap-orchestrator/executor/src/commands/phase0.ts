// `roadmap phase0 check --repo <path> (--plan <file> | --from-ref <arc>)` (M4a, OR-Q16, K20): read-only, no host lock,
// deterministic. Runs `runChecks`' pure rows and the shared `phase0Rows`; `--from-ref` resolves every input by the digests
// the arc's verified ref recorded and omits the live rows (forge, host, tree). Exit 0 with no rows, else 78.
// PLACEHOLDER (step 0a, H3): step C1 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { VisionClauseId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import type { Phase0Source } from '../input/cli.ts';
import type { StartupRejection } from '../preflight/startup.ts';

export type Phase0CheckArgs = Readonly<{ repo: AbsPath; source: Phase0Source }>;
/** The rows found (empty: green) and the active world clauses whose census rules are not all held on the baseline (R15). */
export type Phase0CheckReport = Readonly<{ rows: readonly StartupRejection[]; sliceCandidates: readonly VisionClauseId[] }>;

export async function phase0Check(_args: Phase0CheckArgs): Promise<Phase0CheckReport> {
  return notYet('roadmap phase0 check', 'C1');
}
