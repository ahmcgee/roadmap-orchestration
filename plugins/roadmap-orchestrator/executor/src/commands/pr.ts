// `roadmap pr --repo <path> --arc <arc>` (M4a, OR-Q19, OR-L5, OR-L7): a host act, idempotent, the forge its only record.
// Pushes the arc's integration branch with a lease, finds its PR by head or creates it (base `main` for the chain's first
// arc, else the previous arc's branch) with a code-rendered body, re-targets a PR whose base merged, and flags a
// squash-merged base as needs-rebase. A failure is a CLI error. PLACEHOLDER (step 0a, H3): step A3 replaces it in place.
import { notYet } from '../core/notyet.ts';
import type { ArcId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';

export type PrArgs = Readonly<{ repo: AbsPath; arc: ArcId }>;
export type PrOutcome = Readonly<{ number: number; url: string; base: string; created: boolean; retargeted: boolean; needsRebase: boolean }>;

export async function openPr(_args: PrArgs): Promise<PrOutcome> {
  return notYet('roadmap pr', 'A3');
}
