// The suite-lane proof (plan "Decisions", RC-4, R8): job kind `proof`, spawn purpose `proof` (no `witnessed`; its records
// are kept as `inputs/<sha>.flow-proof.json` and named only by `flow-proof`), `@cpu` per the lane's cost, two clean
// checkouts of the integration head, the lane's exact env plus `witnessEnv` (a lane env setting NODE_OPTIONS is
// `unprovable`). `preserved` iff the `(testId, selected, outcome)` multisets are equal and the old one is non-empty with
// ≥ 1 pass; `red` reruns once, then refuses unremembered; `changed` and `unprovable` refuse and are remembered.
// PLACEHOLDER (step 0a): step B2 replaces this module in place.
import type { JobId } from '../core/ids.ts';
import type { Journal } from '../core/interfaces.ts';
import { notYet } from '../core/notyet.ts';
import type { AbsPath } from '../core/values.ts';
import type { FlowProposal } from './types.ts';

export type ProofContext = Readonly<{ runDir: AbsPath; repo: AbsPath; journal: Journal }>;

/** Runs proof job `job` for an accepted suite-lane proposal to its `flow-proof`. */
export async function runProof(_ctx: ProofContext, _proposal: FlowProposal, _job: JobId): Promise<void> {
  return notYet('runProof', 'B2');
}
