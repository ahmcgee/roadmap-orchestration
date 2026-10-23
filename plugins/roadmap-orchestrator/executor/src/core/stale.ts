// Propagation records (dev.17, experience-won E; SCHEMAS.md "dev.17: propagation"): what a revision changed that other
// records link to (its stale targets), every link the change left stale, and what a propagation unit re-witnesses. Code
// computes them at the revision (src/holistic/propagation.ts `staleSetOf`, no model) and journals them (`stale-set`); this
// module is the records and their readers.
import {
  type FailureModeId, type ObligationId, type Sha, type UnitId, type VisionClauseId, failureModeId, obligationId, sha, unitId, visionClauseId,
} from './ids.ts';
import { type Pinned, type SpecPin, UNPINNED, specPin } from './pins.ts';
import { type RepoPath, repoPath } from './values.ts';
import { type Read, Fields, SchemaError, arrayOf, assertUnique, literal, object, oneOf, positive, sortedBy, str, tagged } from './validate.ts';

/**
 * What a revision changed that links name: a requirement whose normative rev rose (`from` → `to`), a contract a ruling's
 * contract ops rewrote, or a vision clause the owner edited or withdrew (at the vision's new `visionRev`).
 */
export type StaleTarget =
  | Readonly<{ type: 'requirement'; id: ObligationId; from: number; to: number }>
  | Readonly<{ type: 'contract'; path: RepoPath }>
  | Readonly<{ type: 'vision-clause'; id: VisionClauseId; visionRev: number }>;

/** A stale target's identity without its revisions: what a stale link names as its cause. */
export type StaleCause =
  | Readonly<{ type: 'requirement'; id: ObligationId }>
  | Readonly<{ type: 'contract'; path: RepoPath }>
  | Readonly<{ type: 'vision-clause'; id: VisionClauseId }>;

/** A spec link's target: a requirement or a cited contract (`SpecPin`'s targets). */
export type SpecLinkTarget = Readonly<{ type: 'requirement'; id: ObligationId }> | Readonly<{ type: 'contract'; path: RepoPath }>;

/**
 * A link a revision left stale. The unit links (`spec`, `failure-mode`, `interface`) are an unmerged unit's: its plan-check
 * updates or confirms each (`staleLinkKey` names it there). `obligation`: an obligation serving a changed vision clause that
 * the revision did not revise (the checkpoint's to reconcile; a vision revision triggers a drift audit). `witness`: merged
 * artifacts, the declared witness files of an obligation the change reaches, which a propagation unit re-witnesses.
 */
export type StaleLink =
  | Readonly<{ type: 'spec'; unit: UnitId; target: SpecLinkTarget; pinned: Pinned<SpecPin>; cause: StaleCause }>
  | Readonly<{ type: 'failure-mode'; unit: UnitId; failureMode: FailureModeId; requirement: ObligationId; pinned: number; cause: StaleCause }>
  | Readonly<{ type: 'interface'; unit: UnitId; path: RepoPath; pinned: Sha; cause: StaleCause }>
  | Readonly<{ type: 'obligation'; obligation: ObligationId; cause: Extract<StaleCause, { type: 'vision-clause' }> }>
  | Readonly<{ type: 'witness'; obligation: ObligationId; files: readonly RepoPath[]; cause: Exclude<StaleCause, { type: 'vision-clause' }> }>;

/** The links of one unit, which its plan-check answers. */
export type UnitStaleLink = Extract<StaleLink, { unit: UnitId }>;

/** A revision's stale set: its targets (non-empty) and the links they leave stale, transitively. */
export type StaleSet = Readonly<{ targets: readonly StaleTarget[]; links: readonly StaleLink[] }>;

/**
 * How a unit's plan-check answered one of its stale links (`staleLinkKey`): `updated` (its redirect's patch changes the spec
 * to the change) or `confirmed` (the spec holds as written under the change), with why.
 */
export const STALE_OUTCOMES = ['updated', 'confirmed'] as const;
export type StaleOutcome = (typeof STALE_OUTCOMES)[number];
export type StaleAnswer = Readonly<{ link: string; outcome: StaleOutcome; reason: string }>;

/** What a propagation unit re-witnesses: a changed requirement at its new rev, or a changed contract. */
export type PropagationTarget = Readonly<{ type: 'requirement'; id: ObligationId; rev: number }> | Readonly<{ type: 'contract'; path: RepoPath }>;

/** A cause's identity text (`pinTarget`'s form). */
export const causeKey = (c: StaleCause | SpecLinkTarget | PropagationTarget): string => (c.type === 'contract' ? `contract:${c.path}` : `${c.type}:${c.id}`);

/** The key a unit's plan-check answers a stale link of it by: unique among the unit's links. */
export function staleLinkKey(l: UnitStaleLink): string {
  switch (l.type) {
    case 'spec':
      return causeKey(l.target);
    case 'failure-mode':
      return `failure-mode:${l.failureMode}:${l.requirement}`;
    case 'interface':
      return `interface:${l.path}`;
  }
}

/** Whether a stale link is a unit's (plan-check answers it). */
export const isUnitLink = (l: StaleLink): l is UnitStaleLink => l.type === 'spec' || l.type === 'failure-mode' || l.type === 'interface';

const oid: Read<ObligationId> = (v, p) => obligationId(v, p);
const path: Read<RepoPath> = (v, p) => repoPath(v, p);

export const staleTarget: Read<StaleTarget> = tagged<StaleTarget['type'], StaleTarget>('type', {
  requirement: object((f) => {
    const out = { type: f.get('type', literal('requirement')), id: f.get('id', oid), from: f.get('from', positive), to: f.get('to', positive) };
    if (out.to <= out.from) throw new SchemaError(`${f.path}.to`, `a rev above ${out.from} (a requirement's rev rises)`, out.to);
    return out;
  }),
  contract: object((f) => ({ type: f.get('type', literal('contract')), path: f.get('path', path) })),
  'vision-clause': object((f) => ({ type: f.get('type', literal('vision-clause')), id: f.get('id', (v, p) => visionClauseId(v, p)), visionRev: f.get('visionRev', positive) })),
});

const staleCause: Read<StaleCause> = tagged<StaleCause['type'], StaleCause>('type', {
  requirement: object((f) => ({ type: f.get('type', literal('requirement')), id: f.get('id', oid) })),
  contract: object((f) => ({ type: f.get('type', literal('contract')), path: f.get('path', path) })),
  'vision-clause': object((f) => ({ type: f.get('type', literal('vision-clause')), id: f.get('id', (v, p) => visionClauseId(v, p)) })),
});

const specLinkTarget: Read<SpecLinkTarget> = tagged<SpecLinkTarget['type'], SpecLinkTarget>('type', {
  requirement: object((f) => ({ type: f.get('type', literal('requirement')), id: f.get('id', oid) })),
  contract: object((f) => ({ type: f.get('type', literal('contract')), path: f.get('path', path) })),
});

const pinned: Read<Pinned<SpecPin>> = (v, p) => (v === UNPINNED ? UNPINNED : specPin(v, p));
const unitR: Read<UnitId> = (v, p) => unitId(v, p);

export const staleLink: Read<StaleLink> = tagged<StaleLink['type'], StaleLink>('type', {
  spec: object((f) => ({
    type: f.get('type', literal('spec')), unit: f.get('unit', unitR), target: f.get('target', specLinkTarget), pinned: f.get('pinned', pinned), cause: f.get('cause', staleCause),
  })),
  'failure-mode': object((f) => ({
    type: f.get('type', literal('failure-mode')), unit: f.get('unit', unitR), failureMode: f.get('failureMode', (v, p) => failureModeId(v, p)),
    requirement: f.get('requirement', oid), pinned: f.get('pinned', positive), cause: f.get('cause', staleCause),
  })),
  interface: object((f) => ({
    type: f.get('type', literal('interface')), unit: f.get('unit', unitR), path: f.get('path', path), pinned: f.get('pinned', (v, p) => sha(v, p)), cause: f.get('cause', staleCause),
  })),
  obligation: object((f) => ({
    type: f.get('type', literal('obligation')), obligation: f.get('obligation', oid),
    cause: f.get('cause', object((g) => ({ type: g.get('type', literal('vision-clause')), id: g.get('id', (v, p) => visionClauseId(v, p)) }))),
  })),
  witness: object((f) => ({
    type: f.get('type', literal('witness')), obligation: f.get('obligation', oid), files: f.get('files', sortedBy(path, (x) => x, { nonEmpty: true })),
    cause: f.get('cause', tagged<'requirement' | 'contract', Exclude<StaleCause, { type: 'vision-clause' }>>('type', {
      requirement: object((g) => ({ type: g.get('type', literal('requirement')), id: g.get('id', oid) })),
      contract: object((g) => ({ type: g.get('type', literal('contract')), path: g.get('path', path) })),
    })),
  })),
});

/** A stale set's fields (the payload's `stale`, a `stale-set` fact's): targets unique, each link caused by one of them. */
export function staleSetFields(f: Fields): StaleSet {
  const out = { targets: f.get('targets', arrayOf(staleTarget, { nonEmpty: true })), links: f.get('links', arrayOf(staleLink)) };
  assertUnique(out.targets, causeKey, `${f.path}.targets`);
  const causes = new Set(out.targets.map(causeKey));
  out.links.forEach((l, i) => {
    if (!causes.has(causeKey(l.cause))) throw new SchemaError(`${f.path}.links[${i}].cause`, 'a target of the set', l.cause);
  });
  return out;
}
export const staleSet: Read<StaleSet> = object(staleSetFields);

export const staleAnswer: Read<StaleAnswer> = object((f) => ({ link: f.get('link', str), outcome: f.get('outcome', oneOf(STALE_OUTCOMES)), reason: f.get('reason', str) }));

export const propagationTarget: Read<PropagationTarget> = tagged<PropagationTarget['type'], PropagationTarget>('type', {
  requirement: object((f) => ({ type: f.get('type', literal('requirement')), id: f.get('id', oid), rev: f.get('rev', positive) })),
  contract: object((f) => ({ type: f.get('type', literal('contract')), path: f.get('path', path) })),
});
