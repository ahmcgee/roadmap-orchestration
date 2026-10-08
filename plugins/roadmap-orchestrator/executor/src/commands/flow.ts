// `roadmap flow …` (M4b, plan "Decisions"). `flow accept|reject <proposal> --reason <text>`: the root agent's decision on a
// flow proposal, queued as a `flow-decide` command (scope ∅, idempotent by proposal id); its effect journals
// `flow-decided` and acks the proposal's `flow-proposal` item, a rejection adding its RC-9 key, and an accepted appliable
// proposal then moves through `pending-proof` (a suite argv) → `pending-apply` → `applied` | `refused`. `flow request
// --reason <text>`: a `flow-request` command (RC-5: past the cooldown, once per cooldown window), journalling
// `flow-requested`. `flow given --repo <path> --lever <class> --note <text>`: a host act that appends a write-once host
// given (src/flow/givens.ts) under this host's fingerprint. PLACEHOLDER (step 0a): step B2 replaces this module in place.
import { notYet } from '../core/notyet.ts';
import type { ArcId, CommandId, ProposalId } from '../core/ids.ts';
import type { AbsPath } from '../core/values.ts';
import type { FlowLever, HostGiven } from '../flow/types.ts';
import type { RunLocator } from '../input/cli.ts';

export type FlowArgs =
  | Readonly<{ type: 'decide'; proposal: ProposalId; decision: 'accept' | 'reject'; reason: string; run: RunLocator }>
  | Readonly<{ type: 'request'; reason: string; run: RunLocator }>
  | Readonly<{ type: 'given'; repo: AbsPath; lever: FlowLever; note: string }>;

/** `submitted`: the queued command; `given`: the host given written (or the equal one already there); `refused`: exit 78. */
export type FlowCommandOutcome =
  | Readonly<{ kind: 'submitted'; command: CommandId; arc: ArcId }>
  | Readonly<{ kind: 'given'; given: HostGiven }>
  | Readonly<{ kind: 'refused'; reason: string }>;

export async function flowCommand(_args: FlowArgs, _hostDir: AbsPath): Promise<FlowCommandOutcome> {
  return notYet('roadmap flow', 'B2');
}
