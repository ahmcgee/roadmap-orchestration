// Revision pins (dev.17, propagation; SCHEMAS.md "dev.17 records"): every link a spec or a design record carries names the
// revision of its target it was written against, so a change to the target makes the link stale by comparison, in code.
// A link with no pin (a dev.16 spec, `specPinsDefault`) reads `UNPINNED`: its staleness is unknown, never "fresh".
import { type ObligationId, type Sha, type VisionClauseId, obligationId, sha, visionClauseId } from './ids.ts';
import { type RepoPath, repoPath } from './values.ts';
import { type Read, literal, object, positive, tagged } from './validate.ts';

/** A requirement (obligation `I-n`) at its normative `rev` (`ObligationRev`). */
export type RequirementPin = Readonly<{ type: 'requirement'; id: ObligationId; rev: number }>;
/** A contract file at its blob. */
export type ContractPin = Readonly<{ type: 'contract'; path: RepoPath; blob: Sha }>;
/** A vision clause at the vision's `rev` (clauses carry none of their own). */
export type VisionClausePin = Readonly<{ type: 'vision-clause'; id: VisionClauseId; visionRev: number }>;
/** A repository file at its blob: what a design-record entry (an interface, a test or doc it breaks) pins. */
export type FilePin = Readonly<{ type: 'file'; path: RepoPath; blob: Sha }>;

export type Pin = RequirementPin | ContractPin | VisionClausePin | FilePin;
/** What a spec's own links pin (`SpecM1.pins`): its requirements (obligations, repairs, witness obligations) and cited contracts. */
export type SpecPin = RequirementPin | ContractPin;

/** A link written without a pin (a dev.16 record): stale-unknown. */
export const UNPINNED = 'unpinned';
export type Pinned<P extends Pin> = P | typeof UNPINNED;

/** The identity of a pin's target, without its revision: two pins of one target share it. */
export const pinTarget = (p: Pin): string => (p.type === 'requirement' || p.type === 'vision-clause' ? `${p.type}:${p.id}` : `${p.type}:${p.path}`);

export const requirementPin: Read<RequirementPin> = object((f) => ({
  type: f.get('type', literal('requirement')), id: f.get('id', (v, p) => obligationId(v, p)), rev: f.get('rev', positive),
}));
export const contractPin: Read<ContractPin> = object((f) => ({
  type: f.get('type', literal('contract')), path: f.get('path', (v, p) => repoPath(v, p)), blob: f.get('blob', (v, p) => sha(v, p)),
}));
export const visionClausePin: Read<VisionClausePin> = object((f) => ({
  type: f.get('type', literal('vision-clause')), id: f.get('id', (v, p) => visionClauseId(v, p)), visionRev: f.get('visionRev', positive),
}));
export const filePin: Read<FilePin> = object((f) => ({
  type: f.get('type', literal('file')), path: f.get('path', (v, p) => repoPath(v, p)), blob: f.get('blob', (v, p) => sha(v, p)),
}));

export const specPin: Read<SpecPin> = tagged<SpecPin['type'], SpecPin>('type', { requirement: requirementPin, contract: contractPin });
export const pin: Read<Pin> = tagged<Pin['type'], Pin>('type', { requirement: requirementPin, contract: contractPin, 'vision-clause': visionClausePin, file: filePin });

/**
 * The pins of `after` whose target `before` pinned at another revision or not at all, and the pins of `before` whose target
 * `after` dropped: what moved between two snapshots of the same links (dev.17, the delta re-gate: src/core/review.ts
 * `movedTargets`).
 */
export function movedPins(before: readonly Pin[], after: readonly Pin[]): readonly Pin[] {
  const key = (p: Pin): string => `${pinTarget(p)}@${p.type === 'requirement' ? p.rev : p.type === 'vision-clause' ? p.visionRev : p.blob}`;
  const was = new Map(before.map((p) => [pinTarget(p), key(p)]));
  const now = new Set(after.map(pinTarget));
  return [...after.filter((p) => was.get(pinTarget(p)) !== key(p)), ...before.filter((p) => !now.has(pinTarget(p)))];
}
