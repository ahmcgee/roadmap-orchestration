// `roadmap brief --repo <path> [--json] [--ack <briefId>]` (M4a, OR-Q18, K9, H6, H16): a host act. Computes the brief
// payload since the last committed ack's coverage vector across the chain, its id, and the Markdown rendered from it; an
// ack recomputes it, refuses a stale id, then writes the pending marker, enqueues one `ack` per non-blocking item with a
// deterministic id, and commits the marker by rename. PLACEHOLDER (step 0a, H3): step C4 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { BriefId, CommandId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import type { BriefPayload } from '../phase0/types.ts';

export type BriefArgs = Readonly<{ repo: AbsPath; ack: BriefId | null }>;
/** `brief`: the payload, its id and Markdown; `acked`: the ack commands enqueued; `stale`: the id no longer matches (exit 78). */
export type BriefOutcome =
  | Readonly<{ kind: 'brief'; briefId: BriefId; payload: BriefPayload; markdown: string }>
  | Readonly<{ kind: 'acked'; briefId: BriefId; commands: readonly CommandId[] }>
  | Readonly<{ kind: 'stale'; expected: BriefId; actual: BriefId }>;

export async function brief(_args: BriefArgs): Promise<BriefOutcome> {
  return notYet('roadmap brief', 'C4');
}
