// Phase 0, chain and brief records (M4a, frozen in step 0a; SCHEMAS.md "M4a"): the Phase-0 record, the problems the
// shared startup rows report (`phase0Rows`, C1's src/phase0/rows.ts, run by `start`, `apply` and `phase0 check`), the
// brief ack marker and the brief payload (C4). Types and readers only.
import { OUTCOME_STAGES, type OutcomeStage } from '../core/events.ts';
import {
  type AmendmentRef, type ArcId, type ClauseId, type DebtId, type DivergenceId, type IssueId, type JobId, type NeedsUserId, type ObligationId, type PhaseQuestionId,
  type RuleId, type Sha, type Sha256Hex, type UnitId, type VisionClauseId, amendmentRef, arcId, briefId, clauseId, debtId, divergenceId, issueId, issueNumber,
  amendmentRefKey, compareIds, idList, jobIdOf, needsUserId, obligationId, phaseQuestionId, ruleId, sha, sha256, unitId, visionClauseId, type BriefId,
  type FindingId, type OpportunityId, type WitnessItemId, findingId, opportunityId, witnessItemId,
} from '../core/ids.ts';
import { type Read, SchemaError, arrayOf, assertUnique, bool, literal, nat, nullable, object, oneOf, positive, sortedBy, str, tagged } from '../core/validate.ts';
import { type IsoTime, type PlanPath, type RepoPath, isoTime, planPath, repoPath } from '../core/values.ts';
import { type DebtDisposition, debtDisposition } from '../debt/types.ts';
import {
  type IssueIntakeOutcome, type Phase0IntakeOutcome, type RepoIdentity, ISSUE_CREATION_POLICIES, REPO_VISIBILITIES, type IssueCreationPolicy,
  type RepoVisibility, issueIntakeOutcome, phase0IntakeOutcome, repoIdentity,
} from '../forge/types.ts';
import { CENSUS_STATES, CONVERSION_REASONS, DIVERGENCE_KINDS, type ConversionReason, type DivergenceKind } from '../holistic/types.ts';

/** A census state's name (`obligation`, `out-of-slice`, `untestable`, `prod-only`). */
export type CensusStateName = (typeof CENSUS_STATES)[number];

const pathR: Read<RepoPath> = (v, p) => repoPath(v, p);
const sha256R: Read<Sha256Hex> = (v, p) => sha256(v, p);
const ruleR: Read<RuleId> = (v, p) => ruleId(v, p);
const vidR: Read<VisionClauseId> = (v, p) => visionClauseId(v, p);
const rules: Read<readonly RuleId[]> = idList(ruleR, { legacyStringOrder: true });
const files: Read<readonly RepoPath[]> = sortedBy(pathR, (p) => p, { nonEmpty: true });

// ---------------------------------------------------------------------------------------------------
// The Phase-0 record (`roadmap/phase0-m4`, `plan.phase0`; revisioned like the vision, an `apply` edit class `phase0`).
// Every handling entry names its source files (K21), paths under the corpus root.

export const PHASE0_SCHEMA = 'roadmap/phase0-m4';

export const CURATION_TIERS = ['structural', 'fact-currency'] as const;
export type CurationTier = (typeof CURATION_TIERS)[number];

/** An autonomous curation (structural or fact-currency): the curation digest. */
export type Curation = Readonly<{ tier: CurationTier; what: string; files: readonly RepoPath[]; rules: readonly RuleId[] }>;
/** A semantic curation the vision resolved, reversible by restoring the preimaged files. */
export type CorpusDivergence = Readonly<{
  tier: 'semantic'; what: string; preimage: Readonly<{ pinSha256: Sha256Hex; files: readonly Readonly<{ path: RepoPath; sha256: Sha256Hex }>[] }>;
  cites: readonly VisionClauseId[]; rules: readonly RuleId[];
}>;
export type QuestionState = Readonly<{ type: 'open' }> | Readonly<{ type: 'answered'; answer: string; at: IsoTime }>;
/** A ranked question where the vision is silent, with the working assumption the arc acts on. */
export type PhaseQuestion = Readonly<{
  id: PhaseQuestionId; rank: number; text: string; files: readonly RepoPath[]; bears: readonly (RuleId | VisionClauseId)[]; assumption: string; state: QuestionState;
}>;
export type AmendmentDisposition =
  | Readonly<{ type: 'applied'; rules: readonly RuleId[] }>
  | Readonly<{ type: 'rejected' | 'deferred'; reason: string }>;

export type Phase0Record = Readonly<{
  schema: typeof PHASE0_SCHEMA;
  curation: readonly Curation[];
  corpusDivergences: readonly CorpusDivergence[];
  /** Ascending by id; ranks unique. */
  questions: readonly PhaseQuestion[];
  /** One per `open` item of the baseline's debt block, ascending by id. */
  debt: readonly Readonly<{ id: DebtId; disposition: DebtDisposition }>[];
  /** One per amendment of the previous arc's verified ref, ascending. */
  amendments: readonly Readonly<{ id: AmendmentRef; disposition: AmendmentDisposition }>[];
  /** The canonical issue capture beside the plan (`roadmap issues --out`, H8, R30). */
  issueCapture: Readonly<{ file: PlanPath; sha256: Sha256Hex }>;
  /** One outcome per IssueId of the capture, ascending by issue number. */
  intake: readonly Readonly<{ issue: IssueId; outcome: Phase0IntakeOutcome }>[];
  slice: Readonly<{ advances: readonly VisionClauseId[]; why: string }>;
}>;

const curation: Read<Curation> = object((f) => ({
  tier: f.get('tier', oneOf(CURATION_TIERS)), what: f.get('what', str), files: f.get('files', files), rules: f.get('rules', rules),
}));
const corpusDivergence: Read<CorpusDivergence> = object((f) => ({
  tier: f.get('tier', literal('semantic')),
  what: f.get('what', str),
  preimage: f.get('preimage', object((g) => ({
    pinSha256: g.get('pinSha256', sha256R),
    files: g.get('files', sortedBy(object((h) => ({ path: h.get('path', pathR), sha256: h.get('sha256', sha256R) })), (x) => x.path, { nonEmpty: true })),
  }))),
  cites: f.get('cites', idList(vidR, { nonEmpty: true, legacyStringOrder: true })),
  rules: f.get('rules', rules),
}));
const questionState: Read<QuestionState> = tagged('type', {
  open: object((f): QuestionState => ({ type: f.get('type', literal('open')) })),
  answered: object((f): QuestionState => ({ type: f.get('type', literal('answered')), answer: f.get('answer', str), at: f.get('at', (v, p) => isoTime(v, p)) })),
});
/** A rule or a vision clause a question bears on. */
const bearsOn: Read<RuleId | VisionClauseId> = (value, path) =>
  typeof value === 'string' && value.startsWith('T-') ? ruleId(value, path) : visionClauseId(value, path);
const phaseQuestion: Read<PhaseQuestion> = object((f) => ({
  id: f.get('id', (v, p) => phaseQuestionId(v, p)),
  rank: f.get('rank', positive),
  text: f.get('text', str),
  files: f.get('files', files),
  bears: f.get('bears', idList(bearsOn, { nonEmpty: true, legacyStringOrder: true })),
  assumption: f.get('assumption', str),
  state: f.get('state', questionState),
}));
const amendmentDisposition: Read<AmendmentDisposition> = tagged('type', {
  applied: object((f): AmendmentDisposition => ({ type: f.get('type', literal('applied')), rules: f.get('rules', rules) })),
  rejected: object((f): AmendmentDisposition => ({ type: f.get('type', literal('rejected')), reason: f.get('reason', str) })),
  deferred: object((f): AmendmentDisposition => ({ type: f.get('type', literal('deferred')), reason: f.get('reason', str) })),
});

export const phase0Record: Read<Phase0Record> = object((f) => {
  const out: Phase0Record = {
    schema: f.get('schema', literal(PHASE0_SCHEMA)),
    curation: f.get('curation', arrayOf(curation)),
    corpusDivergences: f.get('corpusDivergences', arrayOf(corpusDivergence)),
    questions: f.get('questions', arrayOf(phaseQuestion)),
    debt: f.get('debt', arrayOf(object((g) => ({ id: g.get('id', (v, p) => debtId(v, p)), disposition: g.get('disposition', debtDisposition) })))),
    amendments: f.get('amendments', sortedBy(object((g) => ({ id: g.get('id', (v, p) => amendmentRef(v, p)), disposition: g.get('disposition', amendmentDisposition) })), (a) => amendmentRefKey(a.id), { order: 'by arc, then id', legacyKey: (a) => a.id })),
    issueCapture: f.get('issueCapture', object((g) => ({ file: g.get('file', (v, p) => planPath(v, p)), sha256: g.get('sha256', sha256R) }))),
    intake: f.get('intake', arrayOf(object((g) => ({ issue: g.get('issue', (v, p) => issueId(v, p)), outcome: g.get('outcome', phase0IntakeOutcome) })))),
    slice: f.get('slice', object((g) => ({ advances: g.get('advances', idList(vidR, { nonEmpty: true, legacyStringOrder: true })), why: g.get('why', str) }))),
  };
  out.questions.forEach((q, i) => {
    if (i > 0 && !(compareIds(out.questions[i - 1]!.id, q.id) < 0)) throw new SchemaError(`${f.path}.questions[${i}]`, 'questions strictly ascending by number', q.id);
  });
  assertUnique(out.questions, (q) => String(q.rank), `${f.path}.questions[].rank`);
  out.debt.forEach((d, i) => {
    if (i > 0 && !(compareIds(out.debt[i - 1]!.id, d.id) < 0)) throw new SchemaError(`${f.path}.debt[${i}]`, 'one disposition per item, ascending by number', d.id);
  });
  out.intake.forEach((x, i) => {
    if (i > 0 && !(issueNumber(out.intake[i - 1]!.issue) < issueNumber(x.issue))) throw new SchemaError(`${f.path}.intake[${i}]`, 'one outcome per issue, ascending by number', x.issue);
  });
  return out;
});

export function parsePhase0Record(value: unknown): Phase0Record {
  return phase0Record(value, 'phase0');
}

// ---------------------------------------------------------------------------------------------------
// The startup rows' problems (shared by `start`, `apply` and `phase0 check`; the rows themselves are
// src/preflight/startup.ts kinds).

export type CorpusProblem =
  | Readonly<{ type: 'pin-drift' }>
  | Readonly<{ type: 'rule-reused'; id: RuleId }>
  | Readonly<{ type: 'rule-retired-reappears'; id: RuleId }>
  | Readonly<{ type: 'rules-in-vision' }>
  | Readonly<{ type: 'guide-missing' }>
  | Readonly<{ type: 'source-unreadable'; detail: string }>
  | Readonly<{ type: 'source-remote-mismatch' }>
  | Readonly<{ type: 'scope-overlaps-corpus'; unit: UnitId }>
  | Readonly<{ type: 'contract-overlaps-corpus'; path: RepoPath }>;

export const corpusProblem: Read<CorpusProblem> = tagged('type', {
  'pin-drift': object((f): CorpusProblem => ({ type: f.get('type', literal('pin-drift')) })),
  'rule-reused': object((f): CorpusProblem => ({ type: f.get('type', literal('rule-reused')), id: f.get('id', ruleR) })),
  'rule-retired-reappears': object((f): CorpusProblem => ({ type: f.get('type', literal('rule-retired-reappears')), id: f.get('id', ruleR) })),
  'rules-in-vision': object((f): CorpusProblem => ({ type: f.get('type', literal('rules-in-vision')) })),
  'guide-missing': object((f): CorpusProblem => ({ type: f.get('type', literal('guide-missing')) })),
  'source-unreadable': object((f): CorpusProblem => ({ type: f.get('type', literal('source-unreadable')), detail: f.get('detail', str) })),
  'source-remote-mismatch': object((f): CorpusProblem => ({ type: f.get('type', literal('source-remote-mismatch')) })),
  'scope-overlaps-corpus': object((f): CorpusProblem => ({ type: f.get('type', literal('scope-overlaps-corpus')), unit: f.get('unit', (v, p) => unitId(v, p)) })),
  'contract-overlaps-corpus': object((f): CorpusProblem => ({ type: f.get('type', literal('contract-overlaps-corpus')), path: f.get('path', pathR) })),
});

export type Phase0Problem =
  | Readonly<{ type: 'census-incomplete'; rules: readonly RuleId[] }>
  | Readonly<{ type: 'census-dangling'; rules: readonly RuleId[] }>
  | Readonly<{ type: 'obligation-rule-unresolved'; obligation: ObligationId }>
  | Readonly<{ type: 'debt-undispositioned' | 'debt-kept-twice-unasked'; id: DebtId }>
  | Readonly<{ type: 'amendment-undispositioned'; id: AmendmentRef }>
  | Readonly<{ type: 'intake-missing' | 'intake-unknown' | 'intake-duplicate'; issue: IssueId }>
  | Readonly<{ type: 'capture-missing' }>
  | Readonly<{ type: 'capture-foreign'; expected: RepoIdentity; actual: RepoIdentity }>
  | Readonly<{ type: 'question-reused'; id: PhaseQuestionId }>
  /**
   * The owner-answer channel (src/answers.ts): a question whose latest recorded owner answer (`roadmap answer`) the new
   * arc's Phase-0 record does not mark `answered` with that text (nor, for a question the record does not carry, an
   * earlier arc of the chain). A fresh start's row only.
   */
  | Readonly<{ type: 'answer-unapplied'; question: PhaseQuestionId }>
  /**
   * M4a rev 3 (H3, F07): a pack spec's item that disagrees with the census: a declared obligation (`I-n`) whose rule's
   * census state is not `obligation` naming it or its split parent, or an acceptance clause (`A-n`) or (run 10) witness
   * item (`W-n`) naming a rule whose census state is `out-of-slice`. `state` is the rule's census state.
   */
  | Readonly<{ type: 'spec-census-mismatch'; unit: UnitId; item: ObligationId | ClauseId | WitnessItemId; rule: RuleId; state: CensusStateName }>;

const ruleSet: Read<readonly RuleId[]> = idList(ruleR);
const issueProblem = (type: 'intake-missing' | 'intake-unknown' | 'intake-duplicate'): Read<Phase0Problem> =>
  object((f): Phase0Problem => ({ type: f.get('type', literal(type)), issue: f.get('issue', (v, p) => issueId(v, p)) }));
const debtProblem = (type: 'debt-undispositioned' | 'debt-kept-twice-unasked'): Read<Phase0Problem> =>
  object((f): Phase0Problem => ({ type: f.get('type', literal(type)), id: f.get('id', (v, p) => debtId(v, p)) }));
export const phase0Problem: Read<Phase0Problem> = tagged('type', {
  'census-incomplete': object((f): Phase0Problem => ({ type: f.get('type', literal('census-incomplete')), rules: f.get('rules', ruleSet) })),
  'census-dangling': object((f): Phase0Problem => ({ type: f.get('type', literal('census-dangling')), rules: f.get('rules', ruleSet) })),
  'obligation-rule-unresolved': object((f): Phase0Problem => ({ type: f.get('type', literal('obligation-rule-unresolved')), obligation: f.get('obligation', (v, p) => obligationId(v, p)) })),
  'debt-undispositioned': debtProblem('debt-undispositioned'),
  'debt-kept-twice-unasked': debtProblem('debt-kept-twice-unasked'),
  'amendment-undispositioned': object((f): Phase0Problem => ({ type: f.get('type', literal('amendment-undispositioned')), id: f.get('id', (v, p) => amendmentRef(v, p)) })),
  'intake-missing': issueProblem('intake-missing'),
  'intake-unknown': issueProblem('intake-unknown'),
  'intake-duplicate': issueProblem('intake-duplicate'),
  'capture-missing': object((f): Phase0Problem => ({ type: f.get('type', literal('capture-missing')) })),
  'capture-foreign': object((f): Phase0Problem => ({ type: f.get('type', literal('capture-foreign')), expected: f.get('expected', repoIdentity), actual: f.get('actual', repoIdentity) })),
  'question-reused': object((f): Phase0Problem => ({ type: f.get('type', literal('question-reused')), id: f.get('id', (v, p) => phaseQuestionId(v, p)) })),
  'answer-unapplied': object((f): Phase0Problem => ({ type: f.get('type', literal('answer-unapplied')), question: f.get('question', (v, p) => phaseQuestionId(v, p)) })),
  'spec-census-mismatch': object((f): Phase0Problem => ({
    type: f.get('type', literal('spec-census-mismatch')), unit: f.get('unit', (v, p) => unitId(v, p)),
    item: f.get('item', (v, p) => (typeof v === 'string' && /^I-[0-9]+$/.test(v) ? obligationId(v, p) : typeof v === 'string' && /^W-[0-9]+$/.test(v) ? witnessItemId(v, p) : clauseId(v, p))),
    rule: f.get('rule', ruleR), state: f.get('state', oneOf(CENSUS_STATES)),
  })),
});

/** Why the chain refuses a start (H12, R11); the baseline rules apply in order. */
export type ChainBaselineProblem =
  | Readonly<{ type: 'previous-head-mismatch' | 'merge-commit' | 'parent-mismatch' }>
  | Readonly<{ type: 'paths'; paths: readonly RepoPath[] }>;
export type ChainProblem =
  | Readonly<{ type: 'limit'; k: number; unacked: number }>
  | Readonly<{ type: 'baseline'; baseline: ChainBaselineProblem }>
  | Readonly<{ type: 'previous-incomplete'; arc: ArcId }>
  | Readonly<{ type: 'k-unset' }>;

const chainBaselineProblem: Read<ChainBaselineProblem> = tagged('type', {
  'previous-head-mismatch': object((f): ChainBaselineProblem => ({ type: f.get('type', literal('previous-head-mismatch')) })),
  'merge-commit': object((f): ChainBaselineProblem => ({ type: f.get('type', literal('merge-commit')) })),
  'parent-mismatch': object((f): ChainBaselineProblem => ({ type: f.get('type', literal('parent-mismatch')) })),
  paths: object((f): ChainBaselineProblem => ({ type: f.get('type', literal('paths')), paths: f.get('paths', files) })),
});
export const chainProblem: Read<ChainProblem> = tagged('type', {
  limit: object((f): ChainProblem => ({ type: f.get('type', literal('limit')), k: f.get('k', positive), unacked: f.get('unacked', nat) })),
  baseline: object((f): ChainProblem => ({ type: f.get('type', literal('baseline')), baseline: f.get('baseline', chainBaselineProblem) })),
  'previous-incomplete': object((f): ChainProblem => ({ type: f.get('type', literal('previous-incomplete')), arc: f.get('arc', (v, p) => arcId(v, p)) })),
  'k-unset': object((f): ChainProblem => ({ type: f.get('type', literal('k-unset')) })),
});

/**
 * Whether a start chained on the chain's head would pass the chain rows that need no plan of it (paid M4a run 12): the
 * head complete, K set, and the unacked starts with it within K (src/chain.ts `nextStartOf`, the one predicate
 * `chainRow` applies too). `unacked` counts the next start itself. The baseline rows need the next plan: only `start`
 * and `phase0 check` decide them.
 */
export type NextStart =
  | Readonly<{ allowed: true; reason: 'within-k'; k: number; unacked: number }>
  | Readonly<{ allowed: false; reason: 'limit'; k: number; unacked: number }>
  | Readonly<{ allowed: false; reason: 'k-unset' }>
  | Readonly<{ allowed: false; reason: 'previous-incomplete'; arc: ArcId }>;
export const nextStart: Read<NextStart> = tagged('reason', {
  'within-k': object((f): NextStart => ({ allowed: f.get('allowed', literal(true)), reason: f.get('reason', literal('within-k')), k: f.get('k', positive), unacked: f.get('unacked', positive) })),
  limit: object((f): NextStart => ({ allowed: f.get('allowed', literal(false)), reason: f.get('reason', literal('limit')), k: f.get('k', positive), unacked: f.get('unacked', positive) })),
  'k-unset': object((f): NextStart => ({ allowed: f.get('allowed', literal(false)), reason: f.get('reason', literal('k-unset')) })),
  'previous-incomplete': object((f): NextStart => ({ allowed: f.get('allowed', literal(false)), reason: f.get('reason', literal('previous-incomplete')), arc: f.get('arc', (v, p) => arcId(v, p)) })),
});

/** `issue-policy-untrusted{visibility, policy}` (OR-L6): the policy the forge answered. */
export type UntrustedPolicy = Readonly<{ visibility: RepoVisibility; policy: IssueCreationPolicy }>;
export const untrustedPolicyFields = { visibility: oneOf(REPO_VISIBILITIES), policy: oneOf(ISSUE_CREATION_POLICIES) } as const;

// ---------------------------------------------------------------------------------------------------
// The brief ack log (K9, K10, H6): write-once files in `$(git-common-dir)/roadmap/acks/`, `<briefId>.pending.json`
// committed by rename to `<briefId>.json`. Nothing is rewritten, so no lock (R27).

/** Per chained arc: its ref's commit and that snapshot's high-water when the brief was computed (H6). */
export type CoverageEntry = Readonly<{ arc: ArcId; snapshotCommit: Sha; highWater: number }>;
/** A non-blocking item a brief rendered for a live arc (R10): what an ack of the brief acknowledges. */
export type AckItem = Readonly<{ arc: ArcId; id: NeedsUserId }>;

export type AckMarker = Readonly<{
  briefId: BriefId;
  at: IsoTime;
  /** The chain's newest arc when acked: every chained start up to it is acked. */
  chainHead: ArcId;
  /** Ascending by arc. */
  coverage: readonly CoverageEntry[];
  /** Ascending by arc, then id, unique; each gets one `ack` command with a deterministic id (R26). */
  items: readonly AckItem[];
}>;

const coverageEntry: Read<CoverageEntry> = object((f) => ({
  arc: f.get('arc', (v, p) => arcId(v, p)), snapshotCommit: f.get('snapshotCommit', (v, p) => sha(v, p)), highWater: f.get('highWater', nat),
}));
const ackItem: Read<AckItem> = object((f) => ({ arc: f.get('arc', (v, p) => arcId(v, p)), id: f.get('id', (v, p) => needsUserId(v, p)) }));
const coverage: Read<readonly CoverageEntry[]> = sortedBy(coverageEntry, (c) => c.arc);
const ackItems: Read<readonly AckItem[]> = sortedBy(ackItem, (i) => `${i.arc}\u0000${i.id}`);

export const ackMarker: Read<AckMarker> = object((f) => ({
  briefId: f.get('briefId', (v, p) => briefId(v, p)),
  at: f.get('at', (v, p) => isoTime(v, p)),
  chainHead: f.get('chainHead', (v, p) => arcId(v, p)),
  coverage: f.get('coverage', coverage),
  items: f.get('items', ackItems),
}));

export function parseAckMarker(value: unknown): AckMarker {
  return ackMarker(value, 'ack');
}

// ---------------------------------------------------------------------------------------------------
// The brief payload (`roadmap/brief-m4`, H16): one canonical JSON value holding every rendered field, the coverage
// vector and the item list, and no clock. `briefId` = the first 16 hex of sha256 over its canonical bytes; the
// Markdown is rendered from it alone (C4's src/brief.ts).

export const BRIEF_SCHEMA = 'roadmap/brief-m4';

/** A chained arc's pull request as the forge answered (non-fatal: `unavailable`). */
export type BriefPr =
  | Readonly<{ type: 'pr'; number: number; url: string; state: 'open' | 'merged' | 'closed'; base: string; needsRebase: boolean }>
  | Readonly<{ type: 'none' }>
  | Readonly<{ type: 'unavailable'; reason: string }>;

/** `status.timings` (LR-c): per stage, the completed attempts' count, median and maximum duration. */
export type StageTiming = Readonly<{ stage: OutcomeStage; count: number; p50Ms: number; maxMs: number }>;

/** Everything a brief renders of one chained arc since the coverage it starts from. */
export type BriefArc = Readonly<{
  arc: ArcId;
  /** The arc's Phase-0 slice in force at its ref (not a delta; Q19: the root agent picks it, the owner sees it here); null without a Phase-0 record. */
  slice: Readonly<{ advances: readonly VisionClauseId[]; why: string }> | null;
  divergences: readonly Readonly<{ id: DivergenceId; type: DivergenceKind; what: string }>[];
  digests: readonly Readonly<{ needsUser: NeedsUserId; ids: readonly DivergenceId[] }>[];
  decisions: readonly string[];
  curation: readonly Curation[];
  corpusDivergences: readonly CorpusDivergence[];
  debt: Readonly<{
    banked: readonly Readonly<{ id: DebtId; what: string }>[];
    dispositioned: readonly Readonly<{ id: DebtId; disposition: DebtDisposition }>[];
  }>;
  /** `job` null: the arc's Phase-0 intake; else a checkpoint's. */
  intake: readonly (Readonly<{ issue: IssueId; job: null; outcome: Phase0IntakeOutcome }> | Readonly<{ issue: IssueId; job: JobId; outcome: IssueIntakeOutcome }>)[];
  questions: readonly Readonly<{ id: PhaseQuestionId; rank: number; text: string; assumption: string; state: QuestionState }>[];
  /** M4a rev 3 (OR-A1): `admit` names the converted checkpoint admit an amendment came from (R35); null otherwise. */
  amendments: readonly Readonly<{ id: AmendmentRef; rules: readonly RuleId[]; proposal: string; admit: BriefConversion | null }>[];
  /** The pack reviews' `note` findings (a blocking one is its review's needs-user item), each by `(job, index)` (K13). */
  packReviewNotes: readonly Readonly<{ job: JobId; index: number; claim: string }>[];
  /** `% held` = held / obligationRules (obligation-state rules held on the head); null outside a corpus arc. */
  census: Readonly<{ held: number; obligationRules: number; outOfSlice: number; untestable: number; prodOnly: number }> | null;
  timings: readonly StageTiming[];
  pr: BriefPr;
  /** M4a rev 3 (OR-A1; corpus arcs, empty elsewhere): the checkpoint admits the delta classified, in log order. */
  admits: readonly BriefAdmit[];
  /** The arc's opportunities at its ref (not a delta). */
  opportunities: readonly BriefOpportunity[];
  /** The drift indicator at the ref: each merged non-opportunity admit with findings attributed to its merge outside the slice. */
  drift: readonly BriefDrift[];
}>;

export const ADMIT_CLASS_NAMES = ['repair', 'oversight', 'opportunity'] as const;
export type BriefConversion = Readonly<{ job: JobId; index: number; reason: ConversionReason }>;
export type BriefAdmit = Readonly<{
  job: JobId; index: number; unit: UnitId; class: (typeof ADMIT_CLASS_NAMES)[number]; clauses: readonly VisionClauseId[]; followUp: OpportunityId | null;
}>;
export type BriefOpportunity = Readonly<{
  id: OpportunityId; clauses: readonly VisionClauseId[]; units: readonly UnitId[]; followUps: number; spentUsd: number;
  overrun: readonly Readonly<{ job: JobId; index: number }>[];
}>;
export type BriefDrift = Readonly<{ unit: UnitId; job: JobId; findings: readonly Readonly<{ id: FindingId; clauses: readonly VisionClauseId[] }>[] }>;

export type BriefPayload = Readonly<{
  schema: typeof BRIEF_SCHEMA;
  coverage: readonly CoverageEntry[];
  items: readonly AckItem[];
  chain: Readonly<{ position: number; k: number | null; unackedStarts: readonly ArcId[]; nextStart: NextStart }>;
  /** The owner's recorded answers no Phase-0 record applies yet (src/answers.ts), ascending by question; read default `[]`. */
  answers: readonly OwnerAnswer[];
  /** Ascending by arc. */
  arcs: readonly BriefArc[];
}>;

const briefPr: Read<BriefPr> = tagged('type', {
  pr: object((f): BriefPr => ({
    type: f.get('type', literal('pr')), number: f.get('number', positive), url: f.get('url', str), state: f.get('state', oneOf(['open', 'merged', 'closed'] as const)),
    base: f.get('base', str), needsRebase: f.get('needsRebase', bool),
  })),
  none: object((f): BriefPr => ({ type: f.get('type', literal('none')) })),
  unavailable: object((f): BriefPr => ({ type: f.get('type', literal('unavailable')), reason: f.get('reason', str) })),
});
const divR: Read<DivergenceId> = (v, p) => divergenceId(v, p);
const briefIntake: Read<BriefArc['intake'][number]> = object((f) => {
  const issue = f.get('issue', (v, p) => issueId(v, p));
  const job = f.get('job', nullable((v, p) => jobIdOf(v, p)));
  return job === null ? { issue, job, outcome: f.get('outcome', phase0IntakeOutcome) } : { issue, job, outcome: f.get('outcome', issueIntakeOutcome) };
});
const briefConversion: Read<BriefConversion> = object((g) => ({
  job: g.get('job', (v, p) => jobIdOf(v, p)), index: g.get('index', nat), reason: g.get('reason', oneOf(CONVERSION_REASONS)),
}));
/** A non-negative finite number (a spend in USD). */
const nonNegative: Read<number> = (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new SchemaError(p, 'a non-negative number', v);
  return v;
};
const briefArc: Read<BriefArc> = object((f) => ({
  arc: f.get('arc', (v, p) => arcId(v, p)),
  slice: f.get('slice', nullable(object((g) => ({ advances: g.get('advances', idList(vidR, { nonEmpty: true, legacyStringOrder: true })), why: g.get('why', str) })))),
  divergences: f.get('divergences', arrayOf(object((g) => ({ id: g.get('id', divR), type: g.get('type', oneOf(DIVERGENCE_KINDS)), what: g.get('what', str) })))),
  digests: f.get('digests', arrayOf(object((g) => ({ needsUser: g.get('needsUser', (v, p) => needsUserId(v, p)), ids: g.get('ids', arrayOf(divR, { nonEmpty: true })) })))),
  decisions: f.get('decisions', arrayOf(str)),
  curation: f.get('curation', arrayOf(curation)),
  corpusDivergences: f.get('corpusDivergences', arrayOf(corpusDivergence)),
  debt: f.get('debt', object((g) => ({
    banked: g.get('banked', arrayOf(object((h) => ({ id: h.get('id', (v, p) => debtId(v, p)), what: h.get('what', str) })))),
    dispositioned: g.get('dispositioned', arrayOf(object((h) => ({ id: h.get('id', (v, p) => debtId(v, p)), disposition: h.get('disposition', debtDisposition) })))),
  }))),
  intake: f.get('intake', arrayOf(briefIntake)),
  questions: f.get('questions', arrayOf(object((g) => ({
    id: g.get('id', (v, p) => phaseQuestionId(v, p)), rank: g.get('rank', positive), text: g.get('text', str), assumption: g.get('assumption', str), state: g.get('state', questionState),
  })))),
  amendments: f.get('amendments', arrayOf(object((g) => ({
    id: g.get('id', (v, p) => amendmentRef(v, p)), rules: g.get('rules', rules), proposal: g.get('proposal', str), admit: g.get('admit', nullable(briefConversion)),
  })))),
  packReviewNotes: f.get('packReviewNotes', arrayOf(object((g) => ({ job: g.get('job', (v, p) => jobIdOf(v, p)), index: g.get('index', nat), claim: g.get('claim', str) })))),
  census: f.get('census', nullable(object((g) => ({
    held: g.get('held', nat), obligationRules: g.get('obligationRules', nat), outOfSlice: g.get('outOfSlice', nat), untestable: g.get('untestable', nat), prodOnly: g.get('prodOnly', nat),
  })))),
  timings: f.get('timings', arrayOf(object((g) => ({
    stage: g.get('stage', oneOf(OUTCOME_STAGES)),
    count: g.get('count', positive), p50Ms: g.get('p50Ms', nat), maxMs: g.get('maxMs', nat),
  })))),
  pr: f.get('pr', briefPr),
  admits: f.get('admits', arrayOf(object((g): BriefAdmit => ({
    job: g.get('job', (v, p) => jobIdOf(v, p)), index: g.get('index', nat), unit: g.get('unit', (v, p) => unitId(v, p)), class: g.get('class', oneOf(ADMIT_CLASS_NAMES)),
    clauses: g.get('clauses', idList(vidR)), followUp: g.get('followUp', nullable((v, p) => opportunityId(v, p))),
  })))),
  opportunities: f.get('opportunities', arrayOf(object((g): BriefOpportunity => ({
    id: g.get('id', (v, p) => opportunityId(v, p)), clauses: g.get('clauses', idList(vidR, { nonEmpty: true })), units: g.get('units', arrayOf((v, p) => unitId(v, p), { nonEmpty: true })),
    followUps: g.get('followUps', nat), spentUsd: g.get('spentUsd', nonNegative), overrun: g.get('overrun', arrayOf(object((h) => ({ job: h.get('job', (v, p) => jobIdOf(v, p)), index: h.get('index', nat) })))),
  })))),
  drift: f.get('drift', arrayOf(object((g): BriefDrift => ({
    unit: g.get('unit', (v, p) => unitId(v, p)), job: g.get('job', (v, p) => jobIdOf(v, p)),
    findings: g.get('findings', arrayOf(object((h) => ({ id: h.get('id', (v, p) => findingId(v, p)), clauses: h.get('clauses', idList(vidR, { nonEmpty: true })) })), { nonEmpty: true })),
  })))),
}));

export const briefPayload: Read<BriefPayload> = object((f) => {
  const out: BriefPayload = {
    schema: f.get('schema', literal(BRIEF_SCHEMA)),
    coverage: f.get('coverage', coverage),
    items: f.get('items', ackItems),
    chain: f.get('chain', object((g) => ({
      position: g.get('position', positive), k: g.get('k', nullable(positive)), unackedStarts: g.get('unackedStarts', arrayOf((v, p) => arcId(v, p))),
      nextStart: g.get('nextStart', nextStart),
    }))),
    answers: f.optional('answers', arrayOf(ownerAnswer)) ?? [],
    arcs: f.get('arcs', sortedBy(briefArc, (a) => a.arc)),
  };
  return out;
});

export function parseBriefPayload(value: unknown): BriefPayload {
  return briefPayload(value, 'brief');
}

// ---------------------------------------------------------------------------------------------------
// The owner-answer log (src/answers.ts): write-once files `$(git-common-dir)/roadmap/answers/<P-n>.<k>.json`, the k-th
// answer the owner recorded to question P-n (`roadmap answer`); the highest k is in force, the earlier ones superseded.

export const ANSWER_SCHEMA = 'roadmap/answer-m4a';

export type OwnerAnswer = Readonly<{
  schema: typeof ANSWER_SCHEMA;
  question: PhaseQuestionId;
  /** 1 for the first answer to the question; each later one supersedes the one before. */
  k: number;
  answer: string;
  at: IsoTime;
  /** The arc whose Phase-0 record in force held the question open when the answer was recorded. */
  arc: ArcId;
}>;

export const ownerAnswer: Read<OwnerAnswer> = object((f) => ({
  schema: f.get('schema', literal(ANSWER_SCHEMA)),
  question: f.get('question', (v, p) => phaseQuestionId(v, p)),
  k: f.get('k', positive),
  answer: f.get('answer', str),
  at: f.get('at', (v, p) => isoTime(v, p)),
  arc: f.get('arc', (v, p) => arcId(v, p)),
}));

export function parseOwnerAnswer(value: unknown): OwnerAnswer {
  return ownerAnswer(value, 'answer');
}
