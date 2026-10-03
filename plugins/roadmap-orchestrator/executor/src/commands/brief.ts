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
// `start` (`finishPendingAcks`). An ack of an id already committed (a rerun) reports the same commands and writes nothing.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Brief, computeBrief, renderBrief } from '../brief.ts';
import { acksDir } from '../chain.ts';
import { crashPoint } from '../core/crash.ts';
import { durableMkdir, durableRename, exclusivePublish } from '../core/fsx.ts';
import type { BriefId, CommandId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import { type AbsPath, isoTimeOf } from '../core/values.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { gitCommonDir } from '../git/git.ts';
import { runDir } from '../input/cli.ts';
import { type AckMarker, type BriefPayload, parseAckMarker } from '../phase0/types.ts';
import { ackCommandId, enqueueCommand } from './queue.ts';

export type BriefArgs = Readonly<{ repo: AbsPath; ack: BriefId | null }>;
/** `brief`: the payload, its id and Markdown; `acked`: the ack commands enqueued; `stale`: the id no longer matches (exit 78). */
export type BriefOutcome =
  | Readonly<{ kind: 'brief'; briefId: BriefId; payload: BriefPayload; markdown: string }>
  | Readonly<{ kind: 'acked'; briefId: BriefId; commands: readonly CommandId[] }>
  | Readonly<{ kind: 'stale'; expected: BriefId; actual: BriefId }>;

const PENDING = /^([0-9a-f]{16})\.pending\.json$/;
const pendingPath = (repo: AbsPath, id: BriefId): string => join(acksDir(repo), `${id}.pending.json`);
const committedPath = (repo: AbsPath, id: BriefId): string => join(acksDir(repo), `${id}.json`);

const readMarker = (path: string): AckMarker => parseAckMarker(JSON.parse(readFileSync(path, 'utf8')));

/** The ack commands of `marker`, one per item, by ordinal (R26). */
const commandsOf = (marker: AckMarker): readonly CommandId[] => marker.items.map((_, i) => ackCommandId(marker.at, i));

/** Steps 3–4 from the marker's bytes alone: enqueue each item's `ack` (idempotent), then commit the marker by rename. */
function commitMarker(repo: AbsPath, marker: AckMarker): readonly CommandId[] {
  const ids = commandsOf(marker);
  const common = gitCommonDir(repo);
  marker.items.forEach((item, i) => {
    enqueueCommand(runDir(common, item.arc), { v: SCHEMA_VERSION, id: ids[i]!, arc: item.arc, at: marker.at, body: { type: 'ack', needsUser: item.id, choice: null } });
  });
  crashPoint('brief.ack.after-enqueue');
  durableRename(pendingPath(repo, marker.briefId), committedPath(repo, marker.briefId));
  return ids;
}

/** Finishes every pending marker a crash left (steps 3–4); returns them. `start` calls it too. */
export function finishPendingAcks(repo: AbsPath): readonly AckMarker[] {
  const dir = acksDir(repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => PENDING.test(n)).sort().map((n) => {
    const marker = readMarker(join(dir, n));
    if (`${marker.briefId}.pending.json` !== n) throw new Error(`${join(dir, n)} holds the pending ack of brief ${marker.briefId}`);
    if (existsSync(committedPath(repo, marker.briefId))) throw new Error(`brief ${marker.briefId} is both pending and committed in ${dir}`);
    commitMarker(repo, marker);
    return marker;
  });
}

function ack(repo: AbsPath, b: Brief): readonly CommandId[] {
  const marker: AckMarker = { briefId: b.briefId, at: isoTimeOf(new Date()), chainHead: b.chainHead, coverage: b.payload.coverage, items: b.payload.items };
  durableMkdir(acksDir(repo));
  exclusivePublish(pendingPath(repo, b.briefId), canonicalJson(parseAckMarker(JSON.parse(canonicalJson(marker)))));
  crashPoint('brief.ack.after-pending');
  return commitMarker(repo, marker);
}

export async function brief(args: BriefArgs): Promise<BriefOutcome> {
  finishPendingAcks(args.repo);
  if (args.ack !== null && existsSync(committedPath(args.repo, args.ack))) {
    return { kind: 'acked', briefId: args.ack, commands: commandsOf(readMarker(committedPath(args.repo, args.ack))) };
  }
  const b = computeBrief(args.repo);
  if (args.ack === null) return { kind: 'brief', briefId: b.briefId, payload: b.payload, markdown: renderBrief(b.briefId, b.payload) };
  if (args.ack !== b.briefId) return { kind: 'stale', expected: args.ack, actual: b.briefId };
  return { kind: 'acked', briefId: b.briefId, commands: ack(args.repo, b) };
}
