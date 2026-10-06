// Branded identifiers. Each id has one constructor that checks its textual form and throws
// InvalidIdError otherwise, so an unchecked string can never reach a place that wants an id. The forms
// are recorded in SCHEMAS.md ("Ids").
import { type Brand, type Read, SchemaError, answerSet, sortedBy } from './validate.ts';

export class InvalidIdError extends SchemaError {
  readonly idKind: string;
  constructor(idKind: string, path: string, form: string, value: unknown) {
    super(path, `${idKind} (${form})`, value);
    this.name = 'InvalidIdError';
    this.idKind = idKind;
  }
}

type IdReader<T> = (value: unknown, path?: string) => T;

function textual<B extends string>(kind: B, pattern: RegExp, form: string): IdReader<Brand<string, B>> {
  return (value, path = kind) => {
    if (typeof value !== 'string' || !pattern.test(value)) throw new InvalidIdError(kind, path, form, value);
    return value as Brand<string, B>;
  };
}

// Slugs are safe as git ref components and file names: lowercase, digits, inner hyphens.
const SLUG = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
const SLUG_FORM = 'lowercase letters, digits and inner hyphens, 1-64 chars';
const POS = '[1-9][0-9]{0,14}'; // ≤ 15 digits stays a safe integer
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ArcId = Brand<string, 'ArcId'>;
export const arcId: IdReader<ArcId> = textual('ArcId', new RegExp(`^${SLUG}$`), SLUG_FORM);

export type UnitId = Brand<string, 'UnitId'>;
export const unitId: IdReader<UnitId> = textual('UnitId', new RegExp(`^${SLUG}$`), SLUG_FORM);

export type ResourceName = Brand<string, 'ResourceName'>;
export const resourceName: IdReader<ResourceName> = textual('ResourceName', new RegExp(`^${SLUG}$`), SLUG_FORM);
/** The built-in serial resource. Never declared by a plan; always reserved last. */
export const INTEGRATION_SLOT = resourceName('integration-slot');

// Resource units (M2): what one reservation moves. A named resource is its own single instance; a declared
// pool `p` of size n has instances `p#1..p#n`; the built-in `@cpu` pool has tokens `@cpu#1..@cpu#N`. `@`
// cannot occur in a ResourceName slug, so `@cpu` never collides with a declared name (a resource named `cpu`
// is a named resource).

/** One instance of a declared estate pool: `<pool>#<n>`. */
export type PoolInstance = Brand<string, 'PoolInstance'>;
/** One token of the built-in `@cpu` pool: `@cpu#<n>`. Admission only: no workload binding, probe or teardown. */
export type CpuToken = Brand<string, 'CpuToken'>;
/** What a probe, teardown or residue names: a named resource or a pool instance. */
export type ResourceInstance = ResourceName | PoolInstance;
/** What a `resource.transition` moves. */
export type ResourceUnit = ResourceInstance | CpuToken;

/** The built-in cpu pool's name, as capacity and `status` show it. */
export const CPU_POOL = '@cpu';

const INSTANCE = new RegExp(`^(${SLUG})#(${POS})$`);
const CPU = new RegExp(`^@cpu#(${POS})$`);
const NAME = new RegExp(`^${SLUG}$`);
export const poolInstanceOf: IdReader<PoolInstance> = textual('PoolInstance', INSTANCE, '<pool>#<n>');
export const cpuTokenOf: IdReader<CpuToken> = textual('CpuToken', CPU, '@cpu#<n>');

export function poolInstance(pool: ResourceName, n: number): PoolInstance {
  return poolInstanceOf(`${pool}#${n}`);
}

export function cpuToken(n: number): CpuToken {
  return cpuTokenOf(`@cpu#${n}`);
}

export function resourceInstance(value: unknown, path = 'ResourceInstance'): ResourceInstance {
  if (typeof value === 'string' && INSTANCE.test(value)) return value as PoolInstance;
  if (typeof value === 'string' && NAME.test(value)) return value as ResourceName;
  throw new InvalidIdError('ResourceInstance', path, `a resource name or <pool>#<n>`, value);
}

export function resourceUnit(value: unknown, path = 'ResourceUnit'): ResourceUnit {
  if (typeof value === 'string' && CPU.test(value)) return value as CpuToken;
  if (typeof value === 'string' && (INSTANCE.test(value) || NAME.test(value))) return value as ResourceInstance;
  throw new InvalidIdError('ResourceUnit', path, 'a resource name, <pool>#<n> or @cpu#<n>', value);
}

export type ResourceUnitParts =
  | Readonly<{ type: 'named'; name: ResourceName }>
  | Readonly<{ type: 'instance'; pool: ResourceName; n: number }>
  | Readonly<{ type: 'cpu'; n: number }>;

export function parseResourceUnit(unit: ResourceUnit): ResourceUnitParts {
  const cpu = CPU.exec(unit);
  if (cpu !== null) return { type: 'cpu', n: Number(cpu[1]) };
  const inst = INSTANCE.exec(unit);
  if (inst !== null) return { type: 'instance', pool: inst[1] as ResourceName, n: Number(inst[2]) };
  return { type: 'named', name: unit as ResourceName };
}

/**
 * Lock order: named resources and pool instances ascending by name (instances of one pool numerically), then
 * `@cpu#*` numerically, then `integration-slot`. Over plain names it is the M1 order (ascending, the slot last).
 */
export function compareResourceUnits(a: ResourceUnit, b: ResourceUnit): number {
  const key = (u: ResourceUnit): readonly [number, string, number] => {
    if (u === INTEGRATION_SLOT) return [2, '', 0];
    const p = parseResourceUnit(u);
    switch (p.type) {
      case 'cpu': return [1, '', p.n];
      case 'instance': return [0, p.pool, p.n];
      case 'named': return [0, p.name, 0];
    }
  };
  const [ga, na, ia] = key(a);
  const [gb, nb, ib] = key(b);
  if (ga !== gb) return ga - gb;
  if (na !== nb) return na < nb ? -1 : 1;
  return ia - ib;
}

/** A contingent edge's id (plan `contingent[].id`), unique across the plan; `resolve-edge` names it. */
export type EdgeId = Brand<string, 'EdgeId'>;
export const edgeId: IdReader<EdgeId> = textual('EdgeId', new RegExp(`^${SLUG}$`), SLUG_FORM);

export type LaneId = Brand<string, 'LaneId'>;
export const laneId: IdReader<LaneId> = textual('LaneId', /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'a letter then letters, digits, _ . -, 1-64 chars');

/** Acceptance clauses, decisions and facts in a spec. */
export type ClauseId = Brand<string, 'ClauseId'>;
export const clauseId: IdReader<ClauseId> = textual('ClauseId', /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'a letter then letters, digits, _ . -, 1-64 chars');

export type RulingId = Brand<string, 'RulingId'>;
export const rulingId: IdReader<RulingId> = textual('RulingId', /^C-[0-9]+$/, 'C-<digits>');

export type Sha = Brand<string, 'Sha'>;
export const sha: IdReader<Sha> = textual('Sha', /^[0-9a-f]{40}$/, '40 lowercase hex');

/** Content hash of bytes (files, log lines, manifests). */
export type Sha256Hex = Brand<string, 'Sha256Hex'>;
export const sha256: IdReader<Sha256Hex> = textual('Sha256Hex', /^[0-9a-f]{64}$/, '64 lowercase hex');

export type RoutingRev = Brand<string, 'RoutingRev'>;
export const routingRev: IdReader<RoutingRev> = textual('RoutingRev', /^[0-9a-f]{16}$/, '16 lowercase hex');

/** One seat's resolved triple, hashed: records compare seats across routing revisions without a model id. */
export type SeatRev = Brand<string, 'SeatRev'>;
export const seatRev: IdReader<SeatRev> = textual('SeatRev', /^[0-9a-f]{16}$/, '16 lowercase hex');

export type CommandId = Brand<string, 'CommandId'>;
export const commandId: IdReader<CommandId> = textual('CommandId', /^cmd-[0-9a-f]{16}$/, 'cmd-<16 lowercase hex>');

export type JudgmentSessionId = Brand<string, 'JudgmentSessionId'>;
export const judgmentSessionId: IdReader<JudgmentSessionId> = textual('JudgmentSessionId', UUID, 'lowercase uuid');

export type ImplementerSessionId = Brand<string, 'ImplementerSessionId'>;
export const implementerSessionId: IdReader<ImplementerSessionId> = textual('ImplementerSessionId', UUID, 'lowercase uuid');

/** Groups the ops that must not overlap (≤1 open intent per key). Printable, no whitespace. */
export type OpKey = Brand<string, 'OpKey'>;
export const opKey: IdReader<OpKey> = textual('OpKey', /^[A-Za-z0-9._:/#@+=-]{1,256}$/, 'printable ASCII without whitespace, 1-256 chars');

export type SpecRev = Brand<number, 'SpecRev'>;
export function specRev(value: unknown, path = 'SpecRev'): SpecRev {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidIdError('SpecRev', path, 'an integer >= 1', value);
  }
  return value as SpecRev;
}

/** The plan in force's revision: 1 for the first plan an arc ran, one more per applied change (`plan-applied`). */
export type PlanRev = Brand<number, 'PlanRev'>;
export function planRev(value: unknown, path = 'PlanRev'): PlanRev {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidIdError('PlanRev', path, 'an integer >= 1', value);
  }
  return value as PlanRev;
}

// OpId = `<arc>/<seq>`: seq is the event-log seq of the op's first intent, so op ids are unique per arc
// and allocated by the journal with no separate counter.
export type OpId = Brand<string, 'OpId'>;
const OP = new RegExp(`^(${SLUG})/(${POS})$`);
export const opIdOf: IdReader<OpId> = textual('OpId', OP, '<arc>/<seq>');

export function opId(arc: ArcId, seq: number): OpId {
  return opIdOf(`${arc}/${seq}`);
}

export function parseOpId(op: OpId): { readonly arc: ArcId; readonly seq: number } {
  const m = OP.exec(op);
  if (m === null) throw new InvalidIdError('OpId', 'OpId', '<arc>/<seq>', op);
  return { arc: m[1] as ArcId, seq: Number(m[2]) };
}

// InvocationId = `<op>#<ordinal>`: ordinal 1 is the op's first intent, each retry intent increments it.
export type InvocationId = Brand<string, 'InvocationId'>;
const INV = new RegExp(`^(${SLUG}/${POS})#(${POS})$`);
export const invocationIdOf: IdReader<InvocationId> = textual('InvocationId', INV, '<arc>/<seq>#<ordinal>');

export function invocationId(op: OpId, ordinal: number): InvocationId {
  return invocationIdOf(`${op}#${ordinal}`);
}

export function parseInvocationId(inv: InvocationId): { readonly op: OpId; readonly ordinal: number } {
  const m = INV.exec(inv);
  if (m === null) throw new InvalidIdError('InvocationId', 'InvocationId', '<arc>/<seq>#<ordinal>', inv);
  return { op: m[1] as OpId, ordinal: Number(m[2]) };
}

/** The invocation's directory name under `<runDir>/inv/`: `<seq>-<ordinal>` (the arc is the run dir's). */
export function invocationDirName(inv: InvocationId): string {
  const { op, ordinal } = parseInvocationId(inv);
  return `${parseOpId(op).seq}-${ordinal}`;
}

// ---------------------------------------------------------------------------------------------------
// M3 ids (SCHEMAS.md "M3"). A numbered id's `<n>` is 1 for the first of its kind in the arc and one more for
// each later one, in log order; the fold checks the order where a fact opens it (`nextFindingId`,
// `nextDivergenceId`, `nextJobId` on the journal view). Ids are never reused.

function numbered<B extends string>(kind: B, prefix: string): Readonly<{ read: IdReader<Brand<string, B>>; of: (n: number) => Brand<string, B>; n: (id: Brand<string, B>) => number }> {
  const re = new RegExp(`^${prefix}-(${POS})$`);
  const read = textual(kind, re, `${prefix}-<n>`);
  return { read, of: (n) => read(`${prefix}-${n}`), n: (id) => Number(re.exec(id)?.[1]) };
}

/** A vision clause: `V-<n>`. A withdrawn clause keeps its id; ids are never reused (H16). */
export type VisionClauseId = Brand<string, 'VisionClauseId'>;
const V = numbered('VisionClauseId', 'V');
export const visionClauseId: IdReader<VisionClauseId> = V.read;

/** A vision open question: `Q-<n>`. A closed question keeps its id; ids are never reused. */
export type QuestionId = Brand<string, 'QuestionId'>;
const Q = numbered('QuestionId', 'Q');
export const questionId: IdReader<QuestionId> = Q.read;

/** An obligation: `I-<n>`. Ids survive amendments; a split child gets a new one. */
export type ObligationId = Brand<string, 'ObligationId'>;
const I = numbered('ObligationId', 'I');
export const obligationId: IdReader<ObligationId> = I.read;

/** A finding: `F-<n>`, numbered in the order the arc's `finding-opened` facts open them. */
export type FindingId = Brand<string, 'FindingId'>;
const F = numbered('FindingId', 'F');
export const findingId: IdReader<FindingId> = F.read;
export const findingIdOf = F.of;
export const findingSeq = F.n;

/** A divergence: `D-<n>`, numbered in the order the arc's `divergence` facts record them. */
export type DivergenceId = Brand<string, 'DivergenceId'>;
const D = numbered('DivergenceId', 'D');
export const divergenceId: IdReader<DivergenceId> = D.read;
export const divergenceIdOf = D.of;
export const divergenceSeq = D.n;

/**
 * A durable job the arc runs outside any unit: an audit, a checkpoint, a docs publication, a repair batch, the
 * baseline witness or (M4a) a pack review. `<kind>-<n>`, numbered per kind.
 */
export const JOB_KINDS = ['audit', 'ckpt', 'docs', 'batch', 'baseline', 'review'] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobId = Brand<string, 'JobId'>;
const JOB = new RegExp(`^(${JOB_KINDS.join('|')})-(${POS})$`);
export const jobIdOf: IdReader<JobId> = textual('JobId', JOB, `<${JOB_KINDS.join('|')}>-<n>`);

export function jobId(kind: JobKind, n: number): JobId {
  return jobIdOf(`${kind}-${n}`);
}

export function parseJobId(job: JobId): Readonly<{ kind: JobKind; n: number }> {
  const m = JOB.exec(job);
  if (m === null) throw new InvalidIdError('JobId', 'JobId', '<kind>-<n>', job);
  return { kind: m[1] as JobKind, n: Number(m[2]) };
}

/** A job id of one kind: `docs{pub}` names a `docs-<n>`, `batch` a `batch-<n>`, and so on. */
export function jobIdOfKind(kind: JobKind): IdReader<JobId> {
  return (value, path = 'JobId') => {
    const job = jobIdOf(value, path);
    if (parseJobId(job).kind !== kind) throw new InvalidIdError('JobId', path, `${kind}-<n>`, value);
    return job;
  };
}

// ---------------------------------------------------------------------------------------------------
// M4a ids (SCHEMAS.md "M4a"). Unlike the M3 ids these are global across the chain of arcs, except `M-<n>`.

/** A corpus rule: `T-<n>`, global across arcs; a retired id is never reused (the pin and the registry hold it). */
export type RuleId = Brand<string, 'RuleId'>;
const T = numbered('RuleId', 'T');
export const ruleId: IdReader<RuleId> = T.read;
export const ruleIdOf = T.of;
export const ruleSeq = T.n;

/** A debt item: `B-<n>`, global and stable across arcs (`debt.md`'s block holds the high-water). */
export type DebtId = Brand<string, 'DebtId'>;
const B = numbered('DebtId', 'B');
export const debtId: IdReader<DebtId> = B.read;
export const debtIdOf = B.of;
export const debtSeq = B.n;

/** A corpus amendment: `M-<n>`, numbered within its arc; cited across arcs as `<arc>/M-<n>` (`AmendmentRef`). */
export type AmendmentId = Brand<string, 'AmendmentId'>;
const M = numbered('AmendmentId', 'M');
export const amendmentId: IdReader<AmendmentId> = M.read;
export const amendmentIdOf = M.of;
export const amendmentSeq = M.n;

/** An amendment cited outside its arc: `<arc>/M-<n>`. */
export type AmendmentRef = Brand<string, 'AmendmentRef'>;
const AMENDMENT_REF = new RegExp(`^(${SLUG})/(M-${POS})$`);
export const amendmentRef: IdReader<AmendmentRef> = textual('AmendmentRef', AMENDMENT_REF, '<arc>/M-<n>');
export function amendmentRefOf(arc: ArcId, id: AmendmentId): AmendmentRef {
  return amendmentRef(`${arc}/${id}`);
}
export function parseAmendmentRef(ref: AmendmentRef): Readonly<{ arc: ArcId; id: AmendmentId }> {
  const m = AMENDMENT_REF.exec(ref);
  if (m === null) throw new InvalidIdError('AmendmentRef', 'AmendmentRef', '<arc>/M-<n>', ref);
  return { arc: m[1] as ArcId, id: m[2] as AmendmentId };
}
/** An amendment ref's sort key: by arc, then canonically by id (`a/M-9` before `a/M-10`). */
export function amendmentRefKey(ref: AmendmentRef): string {
  const { arc, id } = parseAmendmentRef(ref);
  return `${arc}\u0000${idKey(id)}`;
}

/**
 * A ranked Phase-0 question: `P-<n>`, global, never reused. No registry: the next id is 1 + the max across every
 * Phase-0 record in the verified chain closure (H23); a carried-forward question keeps its id and text.
 */
export type PhaseQuestionId = Brand<string, 'PhaseQuestionId'>;
const P = numbered('PhaseQuestionId', 'P');
export const phaseQuestionId: IdReader<PhaseQuestionId> = P.read;
export const phaseQuestionIdOf = P.of;
export const phaseQuestionSeq = P.n;

// ---------------------------------------------------------------------------------------------------
// M4a rev 3 ids (SCHEMAS.md "M4a rev 3").

/** A plan's known defect: `K-<n>`, plan-scoped and never reused (`plan.knownDefects`, F4). */
export type KnownDefectId = Brand<string, 'KnownDefectId'>;
const K = numbered('KnownDefectId', 'K');
export const knownDefectId: IdReader<KnownDefectId> = K.read;
export const knownDefectIdOf = K.of;

/** A checkpoint opportunity: `O-<n>`, arc-scoped, numbered in the order the arc's admits record them (OR-A1). */
export type OpportunityId = Brand<string, 'OpportunityId'>;
const O = numbered('OpportunityId', 'O');
export const opportunityId: IdReader<OpportunityId> = O.read;
export const opportunityIdOf = O.of;
export const opportunitySeq = O.n;

/**
 * A spec's witness item: `W-<n>`, a spec item id like an acceptance clause's (unique among the spec's items, never
 * reused); the next one is the next free `W-n` of the spec (R59).
 */
export type WitnessItemId = Brand<string, 'WitnessItemId'>;
const W = numbered('WitnessItemId', 'W');
export const witnessItemId: IdReader<WitnessItemId> = W.read;
export const witnessItemIdOf = W.of;
export const witnessItemSeq = W.n;

// ---------------------------------------------------------------------------------------------------
// The canonical order of numbered ids (`<letter>-<n>`: V, Q, I, F, D, T, B, M, P, K, O, W and the ruling ids C). Every list of
// them, in a record or in code, is in this one order: by letter, then by `<n>` as a number (T-9 < T-10 < T-100).
// Validators read such lists with `idsAscending`; code writes them with `canonicalIds` (or sorts with `compareIds`).
// Plain string order stays for keys that are not numbered ids (paths, slugs, job and needs-user ids).

export type NumberedId =
  | VisionClauseId | QuestionId | ObligationId | FindingId | DivergenceId | RuleId | DebtId | AmendmentId | PhaseQuestionId | RulingId | KnownDefectId
  | OpportunityId | WitnessItemId;

const NUMBERED_ID = /^([A-Z])-([0-9]+)$/;

/** A numbered id's sort key: string order of keys is the canonical order, and equal keys mean equal ids. */
export function idKey(id: NumberedId): string {
  const m = NUMBERED_ID.exec(id);
  if (m === null) throw new InvalidIdError('NumberedId', 'NumberedId', '<letter>-<n>', id);
  const digits = m[2] as string;
  return `${m[1]}-${String(digits.length).padStart(3, '0')}-${digits}`;
}

/** The canonical order of numbered ids, for `Array.prototype.sort`. */
export function compareIds(a: NumberedId, b: NumberedId): number {
  const x = idKey(a);
  const y = idKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `ids` once each, in canonical order: how code writes an id list, and how a judgment's id lists are normalised. */
export function canonicalIds<T extends NumberedId>(ids: Iterable<T>): T[] {
  return [...new Set(ids)].sort(compareIds);
}

/** A judgment answer's numbered ids: unique, any order, returned in canonical order (`answerSet`). */
export function answerIds<T extends NumberedId>(item: Read<T>, opts: { readonly nonEmpty?: boolean } = {}): Read<readonly T[]> {
  return answerSet(item, (t) => t, compareIds, opts);
}

const ID_ORDER = 'in id order (T-9 before T-10)';

/**
 * A list strictly ascending in canonical id order by `id` (sorted, unique). `legacyStringOrder` (TEMPORARY SCAFFOLDING,
 * SCHEMAS.md "Record evolution"): the list was read in plain string order before 1.0.0-dev.7, so a list strictly
 * ascending in that order (`["T-10","T-9"]`) still reads, as written, with a warning (`legacyIdOrder`).
 */
export function idsAscending<T>(item: Read<T>, id: (t: T) => NumberedId, opts: Readonly<{ nonEmpty?: boolean; legacyStringOrder?: true }> = {}): Read<readonly T[]> {
  return sortedBy(item, (t) => idKey(id(t)), { nonEmpty: opts.nonEmpty === true, order: ID_ORDER, ...(opts.legacyStringOrder === true ? { legacyKey: id } : {}) });
}

/** A list of numbered ids strictly ascending in canonical order (see `idsAscending`). */
export function idList<T extends NumberedId>(item: Read<T>, opts: Readonly<{ nonEmpty?: boolean; legacyStringOrder?: true }> = {}): Read<readonly T[]> {
  return idsAscending(item, (t) => t, opts);
}

/** A forge issue: `issue-<number>`, the only issue identity in outcomes, amendments and coverage checks (H18). */
export type IssueId = Brand<string, 'IssueId'>;
const ISSUE = new RegExp(`^issue-(${POS})$`);
export const issueId: IdReader<IssueId> = textual('IssueId', ISSUE, 'issue-<number>');
export const issueIdOf = (n: number): IssueId => issueId(`issue-${n}`);
export const issueNumber = (id: IssueId): number => Number(ISSUE.exec(id)?.[1]);

/** Pasted issue content and evidence only (H18): an issue's body `issue-<n>`, or one of its comments `issue-<n>/c-<id>`. */
export type IssueContentRef = Brand<string, 'IssueContentRef'>;
const ISSUE_CONTENT = new RegExp(`^issue-(${POS})(?:/c-(${POS}))?$`);
export const issueContentRef: IdReader<IssueContentRef> = textual('IssueContentRef', ISSUE_CONTENT, 'issue-<number> | issue-<number>/c-<id>');
/** The issue a content ref belongs to. */
export const issueOfContent = (ref: IssueContentRef): IssueId => issueIdOf(Number(ISSUE_CONTENT.exec(ref)?.[1]));

/** A brief: the first 16 hex of sha256 over its canonical payload (H16). */
export type BriefId = Brand<string, 'BriefId'>;
export const briefId: IdReader<BriefId> = textual('BriefId', /^[0-9a-f]{16}$/, '16 lowercase hex');

/** An arc lane's revision: first 16 hex of sha256 over its canonical definition (`laneRevOf`). */
export type LaneRev = Brand<string, 'LaneRev'>;
export const laneRev: IdReader<LaneRev> = textual('LaneRev', /^[0-9a-f]{16}$/, '16 lowercase hex');

/** A witness environment's identity: first 16 hex of sha256 over the lane's resolved environment (B1). */
export type EnvId = Brand<string, 'EnvId'>;
export const envId: IdReader<EnvId> = textual('EnvId', /^[0-9a-f]{16}$/, '16 lowercase hex');

// NeedsUserId forms: `nu-<seq>` (raised by the needsuser.raise op with that seq), `sup-<generation>-<n>`
// (supervisor crash limit, written without a journal), `host-<slug>` (host-level refusals such as a
// corrupt log, written before the journal is usable).
export type NeedsUserId = Brand<string, 'NeedsUserId'>;
export const needsUserId: IdReader<NeedsUserId> = textual(
  'NeedsUserId',
  new RegExp(`^(?:nu-${POS}|sup-${POS}-${POS}|host-${SLUG})$`),
  'nu-<seq> | sup-<generation>-<n> | host-<slug>',
);

export function needsUserIdForOp(op: OpId): NeedsUserId {
  return needsUserId(`nu-${parseOpId(op).seq}`);
}

export function supervisorNeedsUserId(generation: number, n: number): NeedsUserId {
  return needsUserId(`sup-${generation}-${n}`);
}

export function hostNeedsUserId(slug: string): NeedsUserId {
  return needsUserId(`host-${slug}`);
}
