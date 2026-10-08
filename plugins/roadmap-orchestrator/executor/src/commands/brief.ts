// `roadmap brief --repo <path> [--json] [--ack <briefId>]` (M4a, OR-Q18, K9, H6, H16, R10, R26): a host act, no host
// lock. It prints the brief (src/brief.ts): the payload since the last committed ack's coverage vector across the chain,
// its id, and the Markdown rendered from it.
//
// `--ack <briefId>` (CLI `brief --ack`, crash rows BRIEF_ACK):
//   1. recomputes the payload and refuses an id that differs (`stale`: anything rendered changed, forge state included);
//   2. writes the pending marker `acks/<briefId>.pending.json` (write-once) with the payload's coverage vector and items,
//      the chain head and `at` (crash label `brief.ack.after-pending`);
//   3. enqueues one `ack` per item into its arc's run dir under its deterministic id (`ackCommandId(at, ordinal)`,
//      R26), idempotently (`enqueueCommand`) (crash label `brief.ack.after-enqueue`);
//   4. renames the marker to `acks/<briefId>.json`: the committed ack, which moves "since" and acks the chain's starts.
// A pending marker a crash left is finished (steps 3–4) from its bytes alone by the next `brief`, `brief --ack` or
// `start` (`finishPendingAcks`, src/chain.ts: the start path reaches it without this module's imports). An ack of an id already committed (a rerun) reports the same commands and writes nothing.
import { existsSync } from 'node:fs';
import { type Brief, computeBrief, renderBrief } from '../brief.ts';
import { ackCommandsOf, acksDir, commitAckMarker, committedAckPath, finishPendingAcks, pendingAckPath, readAckMarker } from '../chain.ts';
import { crashPoint } from '../core/crash.ts';
import { durableMkdir, exclusivePublish } from '../core/fsx.ts';
import type { BriefId, CommandId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { type AckMarker, type BriefPayload, parseAckMarker } from '../phase0/types.ts';

export type BriefArgs = Readonly<{ repo: AbsPath; ack: BriefId | null }>;
/** `brief`: the payload, its id and Markdown; `acked`: the ack commands enqueued; `stale`: the id no longer matches (exit 78). */
export type BriefOutcome =
  | Readonly<{ kind: 'brief'; briefId: BriefId; payload: BriefPayload; markdown: string }>
  | Readonly<{ kind: 'acked'; briefId: BriefId; commands: readonly CommandId[] }>
  | Readonly<{ kind: 'stale'; expected: BriefId; actual: BriefId }>;

function ack(repo: AbsPath, b: Brief): readonly CommandId[] {
  const marker: AckMarker = { briefId: b.briefId, at: isoTimeOf(new Date()), chainHead: b.chainHead, coverage: b.payload.coverage, items: b.payload.items };
  durableMkdir(acksDir(repo));
  exclusivePublish(pendingAckPath(repo, b.briefId), canonicalJson(parseAckMarker(JSON.parse(canonicalJson(marker)))));
  crashPoint('brief.ack.after-pending');
  return commitAckMarker(repo, marker);
}

export async function brief(args: BriefArgs): Promise<BriefOutcome> {
  finishPendingAcks(args.repo);
  if (args.ack !== null && existsSync(committedAckPath(args.repo, args.ack))) {
    return { kind: 'acked', briefId: args.ack, commands: ackCommandsOf(readAckMarker(committedAckPath(args.repo, args.ack))) };
  }
  const b = computeBrief(args.repo);
  if (args.ack === null) return { kind: 'brief', briefId: b.briefId, payload: b.payload, markdown: renderBrief(b.briefId, b.payload) };
  if (args.ack !== b.briefId) return { kind: 'stale', expected: args.ack, actual: b.briefId };
  return { kind: 'acked', briefId: b.briefId, commands: ack(args.repo, b) };
}
