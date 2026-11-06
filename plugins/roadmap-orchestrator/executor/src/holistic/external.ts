import type { CiFact } from '../core/events.ts';
import type { JournalView } from '../core/interfaces.ts';
import type { AbsPath } from '../core/values.ts';
import type { Sha } from '../core/ids.ts';
import { inputShaOf } from '../git/reusekey.ts';
import { systemsMapInForce } from '../input/systems.ts';
import { laneRevOf, type ArcLaneDef, type ObligationDef, type ObservationVerdict } from './types.ts';

type Attestation = Extract<CiFact, { kind: 'external-witness' }>;
const indexes = new WeakMap<JournalView, { seq: number; byRule: Map<string, Map<Sha, Attestation>> }>();
const ruleKey = (o: ObligationDef, rev: string): string => `${o.id}/${o.rev}/${rev}`;

/** Index once per verified view/high-water, retaining last-by-log-order selection. */
export function externalAttestations(repo: AbsPath, view: JournalView) {
  let index = indexes.get(view);
  if (index?.seq !== view.highWater()) {
    const byRule = new Map<string, Map<Sha, Attestation>>();
    for (const f of view.ciFacts()) {
      if (f.kind !== 'external-witness') continue;
      const key = `${f.obligation}/${f.obligationRev}/${f.laneRev}`;
      const inputs = byRule.get(key) ?? new Map<Sha, Attestation>();
      inputs.set(f.inputSha, f); byRule.set(key, inputs);
    }
    index = { seq: view.highWater(), byRule }; indexes.set(view, index);
  }
  const byRule = index.byRule;
  const revs = new Map<ArcLaneDef, ReturnType<typeof laneRevOf>>();
  const compatible = (lane: ArcLaneDef, o: ObligationDef) => {
    let rev = revs.get(lane);
    if (rev === undefined) { rev = laneRevOf(lane); revs.set(lane, rev); }
    return byRule.get(ruleKey(o, rev));
  };
  const attestation = (tree: Sha, lane: ArcLaneDef, o: ObligationDef): Attestation | null => {
    const inputs = compatible(lane, o);
    if (inputs === undefined) return null;
    return inputs.get(inputShaOf(repo, tree, lane, systemsMapInForce(view.planApplied()))) ?? null;
  };
  return Object.assign(attestation, { compatible: (lane: ArcLaneDef, o: ObligationDef) => compatible(lane, o) !== undefined });
}

/** The latest root attestation bound to this obligation revision, lane revision and tree's lane inputs. */
export function externalAttestation(repo: AbsPath, view: JournalView, tree: Sha, lane: ArcLaneDef, o: ObligationDef): Attestation | null {
  return externalAttestations(repo, view)(tree, lane, o);
}

/** External results bind the obligation revision and lane inputs, and survive unrelated publications. */
export function externalVerdict(repo: AbsPath, view: JournalView, tree: Sha, lane: ArcLaneDef, o: ObligationDef): ObservationVerdict | null {
  const result = externalAttestation(repo, view, tree, lane, o);
  return result === null ? null : result.result === 'pass' ? 'held' : 'not-held';
}
