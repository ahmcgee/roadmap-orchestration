// `integration.ff`: the publication critical section. On a green candidate, integration moves from T to
// exactly the tested candidate commit by CAS, with the approval fingerprint recorded in the intent.
// Postcondition: ref = new, new^1 = T, new^2 = the approved unit commit (merged = second-parent
// reachability, DESIGN §3 "Git truth"). Integration only moves forward.
//
// One classification of the integration ref (`observeIntegration`) serves planning, verify and recovery:
// - `published`: ref = new, or new is an ancestor of ref (later publications on top).
// - `pending`: ref = T, the CAS has not happened.
// - `advanced`: T is a strict ancestor of ref and new is not: the tip moved on without us. The ff is
//   `unpublished`; the caller re-checks the fingerprint and makes a fresh candidate (or re-gates).
// - `foreign`: anything else (integration rewound or rewritten): the caller stops with a needs-user.
//
// M3 (A4): a docs publication's `ff` (subject `docs{pub}`, no fingerprint) moves integration from T to its
// `docs.commit` commit, whose one parent is T (`publicationProblem`); `planDocsFf` plans it. A batch's is B2's.
import { crashPoint } from '../core/crash.ts';
import { type IntentOf, type OpExpect, type OpOutcome, parentUnit } from '../core/events.ts';
import type { Sha } from '../core/ids.ts';
import type { GitSteps, IntentBody } from '../core/interfaces.ts';
import type { ApprovalFingerprint } from '../core/records.ts';
import type { AbsPath, RefName } from '../core/values.ts';
import { GitError, gitRun, refTarget } from './git.ts';
import { parentsOf } from './mergein.ts';

export class FfStateError extends Error {
  readonly ref: RefName;
  constructor(ref: RefName, detail: string) {
    super(`integration.ff ${ref}: ${detail}`);
    this.name = 'FfStateError';
    this.ref = ref;
  }
}

/** `merge-base --is-ancestor a b` (true when a = b). */
export function isAncestor(repo: AbsPath, a: Sha, b: Sha): boolean {
  return gitRun(repo, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] }).code === 0;
}

export type IntegrationObservation =
  | Readonly<{ kind: 'published'; at: Sha }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'advanced'; tip: Sha }>
  | Readonly<{ kind: 'foreign'; observed: Sha | null }>;

export function observeIntegration(repo: AbsPath, ref: RefName, tip: Sha, next: Sha): IntegrationObservation {
  const at = refTarget(repo, ref);
  if (at === null) return { kind: 'foreign', observed: null };
  if (at === next || isAncestor(repo, next, at)) return { kind: 'published', at };
  if (at === tip) return { kind: 'pending' };
  if (isAncestor(repo, tip, at)) return { kind: 'advanced', tip: at };
  return { kind: 'foreign', observed: at };
}

/** null when `next` is a merge with parents [T, unitCommit] (the provenance a publication must carry). */
export function provenanceProblem(repo: AbsPath, next: Sha, tip: Sha, unitCommit: Sha): string | null {
  const parents = parentsOf(repo, next);
  return parents.join(' ') === `${tip} ${unitCommit}` ? null : `${next} has parents [${parents.join(', ')}], expected [${tip}, ${unitCommit}]`;
}

/**
 * The provenance an `ff` must carry, per what it publishes: a unit's merge [T, approved unit commit]; a docs
 * publication's commit, whose one parent is T. A batch's chain is step B2's.
 */
export function publicationProblem(repo: AbsPath, expect: OpExpect['integration.ff']): string | null {
  const { old, new: next } = expect;
  if (expect.subject === undefined) return provenanceProblem(repo, next, old, expect.fingerprint.unitCommit);
  switch (expect.subject.type) {
    case 'docs': {
      const parents = parentsOf(repo, next);
      return parents.join(' ') === old ? null : `${next} has parents [${parents.join(', ')}], expected [${old}]`;
    }
    case 'batch':
      throw new Error(`integration.ff of batch ${expect.subject.job}: not implemented (step B2)`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Planning

export type FfRequest = Readonly<{
  integration: RefName;
  /** The done candidate.merge intent whose commit the suite tested. */
  candidate: IntentOf<'candidate.merge'>;
  /** The approval fingerprint, recomputed at T by the caller and found valid. */
  fingerprint: ApprovalFingerprint;
}>;

export type FfDecision =
  | Readonly<{ kind: 'ff'; body: IntentBody<'integration.ff'> }>
  /** Integration advanced past T: no intent; the caller re-checks the fingerprint for a fresh candidate. */
  | Readonly<{ kind: 'unpublished'; tip: Sha }>
  /**
   * An executor-owned ref was moved by someone else: integration rewound or rewritten, or the candidate
   * ref no longer at the tested commit. The caller stops and raises a needs-user (stage table, ff row).
   */
  | Readonly<{ kind: 'foreign-mover'; ref: RefName; expected: Sha; observed: Sha | null }>;

export type FfPlan = Extract<FfDecision, { kind: 'ff' }>;

export function planFf(repo: AbsPath, request: FfRequest): FfDecision {
  const { integration, candidate, fingerprint } = request;
  const { integrationTip: tip, unitCommit, ref: candRef } = candidate.expect;
  const next = candidate.post.new;
  if (fingerprint.unitCommit !== unitCommit) throw new FfStateError(integration, `fingerprint unit commit ${fingerprint.unitCommit}, candidate merges ${unitCommit}`);
  const candAt = refTarget(repo, candRef);
  if (candAt !== next) return { kind: 'foreign-mover', ref: candRef, expected: next, observed: candAt };
  const problem = provenanceProblem(repo, next, tip, unitCommit);
  if (problem !== null) throw new FfStateError(integration, problem);
  const seen = observeIntegration(repo, integration, tip, next);
  switch (seen.kind) {
    case 'pending':
      return { kind: 'ff', body: { expect: { ref: integration, old: tip, new: next, fingerprint }, post: null } };
    case 'advanced':
      return { kind: 'unpublished', tip: seen.tip };
    case 'foreign':
      return { kind: 'foreign-mover', ref: integration, expected: tip, observed: seen.observed };
    case 'published':
      // The pipeline publishes a unit once; planning a second publication of the same candidate is a bug.
      throw new FfStateError(integration, `candidate ${next} is already published (integration at ${seen.at})`);
  }
}

/**
 * A docs publication's `ff` (A7): integration from T to the done `docs.commit`'s commit, whose tree its lanes
 * tested. The docs ref must still be at that commit; integration advanced past T (nothing publishes while the docs
 * publication holds the slot, so only a foreign mover can) or moved anywhere else is `foreign-mover`.
 */
export function planDocsFf(repo: AbsPath, integration: RefName, docs: IntentOf<'docs.commit'>): FfDecision {
  const tip = docs.expect.integrationTip;
  const next = docs.post.new;
  const at = refTarget(repo, docs.expect.ref);
  if (at !== next) return { kind: 'foreign-mover', ref: docs.expect.ref, expected: next, observed: at };
  const seen = observeIntegration(repo, integration, tip, next);
  switch (seen.kind) {
    case 'pending':
      return { kind: 'ff', body: { expect: { ref: integration, old: tip, new: next, subject: { type: 'docs', pub: docs.expect.pub } }, post: null } };
    case 'advanced':
    case 'foreign':
      return { kind: 'foreign-mover', ref: integration, expected: tip, observed: seen.kind === 'advanced' ? seen.tip : seen.observed };
    case 'published':
      throw new FfStateError(integration, `docs commit ${next} is already published (integration at ${seen.at})`);
  }
}

// ---------------------------------------------------------------------------------------------------
// The op

function act(repo: AbsPath, intent: IntentOf<'integration.ff'>): void {
  const { ref, old } = intent.expect;
  crashPoint('ff.act-start', parentUnit(intent.parent));
  // A CAS that loses to a mover is an answer (verify classifies it); a CAS that fails with the ref still
  // at old is a real failure.
  const r = gitRun(repo, ['update-ref', ref, intent.expect.new, old], { okCodes: [0, 128] });
  if (r.code !== 0 && refTarget(repo, ref) === old) throw new GitError(['update-ref', ref, intent.expect.new, old], r.code, 'CAS failed with the ref still at old');
  crashPoint('ff.act-end', parentUnit(intent.parent));
}

function verify(repo: AbsPath, intent: IntentOf<'integration.ff'>): OpOutcome['integration.ff'] {
  const { ref, old } = intent.expect;
  const next = intent.expect.new;
  const seen = observeIntegration(repo, ref, old, next);
  switch (seen.kind) {
    case 'published': {
      const problem = publicationProblem(repo, intent.expect);
      if (problem !== null) throw new FfStateError(ref, problem);
      return { kind: 'published' };
    }
    case 'advanced':
      return { kind: 'unpublished', tip: seen.tip };
    case 'foreign':
      return { kind: 'recovery-required', observed: seen.observed };
    case 'pending':
      throw new FfStateError(ref, `still at T ${old} after the act`);
  }
}

export function integrationFfSteps(repo: AbsPath): GitSteps<'integration.ff', FfPlan> {
  return {
    kind: 'integration.ff',
    prepare: async (plan) => plan.body,
    act: async (intent) => act(repo, intent),
    verify: async (intent) => verify(repo, intent),
  };
}
