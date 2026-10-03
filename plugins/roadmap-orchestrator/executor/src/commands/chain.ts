// `roadmap chain status --repo <path>` (M4a, OR-Q19, K10, H20): read-only. The chain as `src/chain.ts` derives it from
// the plans in `refs/roadmap/*`, the ack log and `config.chain.k`, with each arc's PR looked up on the forge (non-fatal).
// PLACEHOLDER (step 0a, H3): step C4 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { ArcId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import type { BriefPr } from '../phase0/types.ts';

export type ChainStatusArgs = Readonly<{ repo: AbsPath }>;
/** The chain oldest first: each arc's previous arc, whether its start is acked, and its PR; K and the unacked starts. */
export type ChainStatus = Readonly<{
  arcs: readonly Readonly<{ arc: ArcId; previousArc: ArcId | null; acked: boolean; pr: BriefPr }>[];
  k: number | null;
  unackedStarts: readonly ArcId[];
}>;

export async function chainStatus(_args: ChainStatusArgs): Promise<ChainStatus> {
  return notYet('roadmap chain status', 'C4');
}
