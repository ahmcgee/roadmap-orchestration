import type { CiFact } from '../core/events.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import type { Sha } from '../core/ids.ts';
import { inputShaOf } from '../git/reusekey.ts';
import { systemsMapInForce } from '../input/systems.ts';
import { laneRevOf, type ArcLaneDef, type ObligationDef, type ObservationVerdict } from './types.ts';

/** The latest root attestation bound to this obligation revision, lane revision and tree's lane inputs. */
export function externalAttestation(repo: AbsPath, view: JournalView, tree: Sha, lane: ArcLaneDef, o: ObligationDef): Extract<CiFact, { kind: 'external-witness' }> | null {
  const input = inputShaOf(repo, tree, lane, systemsMapInForce(view.planApplied()));
  const rev = laneRevOf(lane);
  const result = view.ciFacts().filter((f) => f.kind === 'external-witness' && f.obligation === o.id && f.obligationRev === o.rev && f.laneRev === rev && f.inputSha === input).at(-1);
  return result?.kind === 'external-witness' ? result : null;
}

/** External results bind the obligation revision and lane inputs, and survive unrelated publications. */
export function externalVerdict(repo: AbsPath, view: JournalView, tree: Sha, lane: ArcLaneDef, o: ObligationDef): ObservationVerdict | null {
  const result = externalAttestation(repo, view, tree, lane, o);
  return result === null ? null : result.result === 'pass' ? 'held' : 'not-held';
}
