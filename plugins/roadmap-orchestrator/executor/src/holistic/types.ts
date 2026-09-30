// The holistic layer's records (M3, frozen in step 0a; SCHEMAS.md "M3: the holistic layer"): the vision, the
// obligations file, witness records, ruling sidecars, findings and divergences, and the frozen signatures the
// later steps implement (impact selection, observations). Types, readers and pure helpers only: no I/O.
//
// Owners of the behaviour: A1 (obligations, impact, re-derivation, vision coverage, rulings), B1 (witnesses,
// observations, the transition table in table.ts), B3 (findings), B5 (audits, coverage), B6 (checkpoint, bundles,
// divergences).
import {
  type FindingId, type InvocationId, type JobId, type LaneId, type LaneRev, type ObligationId, type RulingId, type Sha, type Sha256Hex,
  type UnitId, type VisionClauseId, envId, findingId, invocationIdOf, jobIdOf, laneId, laneRev, obligationId, rulingId, sha, sha256, unitId,
  visionClauseId, type EnvId,
} from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { LENS_KIND_NAMES, type LaneDef, type LensKindName, laneDef } from '../core/records.ts';
import {
  type Read, Fields, SchemaError, arrayOf, assertUnique, bool, literal, nat, nullable, object, oneOf, positive, sortedBy, str, tagged,
  text, version,
} from '../core/validate.ts';
import { type IsoTime, type RepoPath, type RepoPattern, isoTime, repoPath, repoPattern } from '../core/values.ts';
import type { SchemaVersion } from '../core/version.ts';
import { type FreshRole, ROLES } from '../routing/types.ts';

const vid: Read<VisionClauseId> = (v, p) => visionClauseId(v, p);
const oid: Read<ObligationId> = (v, p) => obligationId(v, p);
const fid: Read<FindingId> = (v, p) => findingId(v, p);
const rid: Read<RulingId> = (v, p) => rulingId(v, p);
const shaR: Read<Sha> = (v, p) => sha(v, p);
const sha256R: Read<Sha256Hex> = (v, p) => sha256(v, p);
const pathR: Read<RepoPath> = (v, p) => repoPath(v, p);
const jobR: Read<JobId> = (v, p) => jobIdOf(v, p);
const byId = <T extends Readonly<{ id: string }>>(t: T): string => t.id;

function docRefFields(g: Fields): DocRef {
  return { path: g.get('path', pathR), anchor: g.get('anchor', str), quotedText: g.get('quotedText', str) };
}

// ---------------------------------------------------------------------------------------------------
// Lenses (§2.5; A15 adds `vision`)

export const LENS_KINDS = LENS_KIND_NAMES;
export type LensKind = LensKindName;
export const lensKind: Read<LensKind> = oneOf(LENS_KINDS);

// ---------------------------------------------------------------------------------------------------
// The vision (OR-V, A14, H16): `holistic.vision` in plan.json names this file.

export const VISION_SCHEMA = 'roadmap/vision-m3';
export const VISION_CLAUSE_KINDS = ['purpose', 'serves', 'good', 'non-negotiable', 'tradeoff'] as const;
export type VisionClauseKind = (typeof VISION_CLAUSE_KINDS)[number];
export const CLAUSE_STATES = ['active', 'withdrawn'] as const;
export type ClauseState = (typeof CLAUSE_STATES)[number];

/** `rank` orders the tradeoffs (1 first) and is null for every other kind. A withdrawn clause stays in the file. */
export type VisionClause = Readonly<{ id: VisionClauseId; kind: VisionClauseKind; text: string; rank: number | null; state: ClauseState }>;

/**
 * The root record (OR-V). Owner-only: only an architect `apply` changes it. `confirmation` is the Phase-0
 * playback's confirmation reference, stored unverified (verification is M4).
 */
export type Vision = Readonly<{
  schema: typeof VISION_SCHEMA;
  rev: number;
  confirmation: Readonly<{ ref: string; at: IsoTime }> | null;
  clauses: readonly VisionClause[];
}>;

const visionClause: Read<VisionClause> = object((f) => {
  const out = {
    id: f.get('id', vid),
    kind: f.get('kind', oneOf(VISION_CLAUSE_KINDS)),
    text: f.get('text', str),
    rank: f.get('rank', nullable(positive)),
    state: f.get('state', oneOf(CLAUSE_STATES)),
  };
  if ((out.kind === 'tradeoff') !== (out.rank !== null)) throw new SchemaError(`${f.path}.rank`, out.kind === 'tradeoff' ? 'a rank for a tradeoff' : 'null (only a tradeoff is ranked)', out.rank);
  return out;
});

export const vision: Read<Vision> = object((f) => {
  const out: Vision = {
    schema: f.get('schema', literal(VISION_SCHEMA)),
    rev: f.get('rev', positive),
    confirmation: f.get('confirmation', nullable(object((g) => ({ ref: g.get('ref', str), at: g.get('at', (v, p) => isoTime(v, p)) })))),
    clauses: f.get('clauses', arrayOf(visionClause, { nonEmpty: true })),
  };
  assertUnique(out.clauses, byId, `${f.path}.clauses`);
  if (!out.clauses.some((c) => c.state === 'active')) throw new SchemaError(`${f.path}.clauses`, 'at least one active clause', out.clauses);
  return out;
});

export function parseVision(value: unknown): Vision {
  return vision(value, 'vision');
}

export const activeClauses = (v: Vision): readonly VisionClauseId[] => v.clauses.filter((c) => c.state === 'active').map((c) => c.id);

// ---------------------------------------------------------------------------------------------------
// Obligations (§2.8; LR-b, H14): `holistic.obligations` in plan.json names this file.

export const OBLIGATIONS_SCHEMA = 'roadmap/obligations-m3';

/** How an arc lane reports per-test results (R1: the reporter is the lane's; R3: all three, `go` untested for real). */
export const REPORTERS = ['node-test', 'go-test-json', 'jsonl'] as const;
export type Reporter = (typeof REPORTERS)[number];
/** An arc lane: owned by no unit, run in candidates, audits, the baseline job and close-out. */
export type ArcLaneDef = LaneDef & Readonly<{ reporter: Reporter }>;

export const ACTIVATIONS = ['future', 'must-hold'] as const;
export type Activation = (typeof ACTIVATIONS)[number];

export type DocRef = Readonly<{ path: RepoPath; anchor: string; quotedText: string }>;
export type WitnessRef = Readonly<{ lane: LaneId; testIds: readonly string[] }>;
/**
 * "This test proves this statement", judged at Phase 0 and bound to both revisions: the obligation's `rev` and
 * the witness lane's `laneRev`. A change of either makes it stale (the classifier asks a fresh one).
 */
export type ProofJudgment = Readonly<{ verdict: 'proves' | 'insufficient'; obligationRev: number; laneRev: LaneRev }>;

/** H14: a split parent's witness and proof are null; every other state keeps both. */
export type ObligationState =
  | Readonly<{ type: 'active' }>
  | Readonly<{ type: 'split'; children: readonly ObligationId[] }>
  | Readonly<{ type: 'waived' | 'deferred' | 'retired'; ruling: RulingId }>;

export type ObligationDef = Readonly<{
  id: ObligationId;
  /** The normative revision (`obligationRevs`); evidence refreshes never bump it. */
  rev: number;
  statement: string;
  docRef: DocRef;
  /** The vision clauses it serves; non-empty in an arc with a vision (checked by the classifier, A1). */
  serves: readonly VisionClauseId[];
  witness: WitnessRef | null;
  proofJudgment: ProofJudgment | null;
  /** The units whose publication delivers a `future` obligation (non-empty for one). */
  deliveredBy: readonly UnitId[];
  activation: Activation;
  parent?: ObligationId;
  /** The contracts it binds: a candidate touching one selects it. */
  contracts: readonly RepoPath[];
  state: ObligationState;
}>;

export type MappingEntry = Readonly<{ pattern: RepoPattern; obligations: readonly ObligationId[] }>;

export type Obligations = Readonly<{
  schema: typeof OBLIGATIONS_SCHEMA;
  cutLine: string;
  lanes: readonly ArcLaneDef[];
  obligations: readonly ObligationDef[];
  /** The one authoritative impact mapping (§2.8), revisioned with the obligations. */
  mapping: Readonly<{ paths: readonly MappingEntry[] }>;
}>;

const arcLaneDef: Read<ArcLaneDef> = (value, path) => {
  const reporter = new Fields(value, path).get('reporter', oneOf(REPORTERS));
  const { reporter: _reporter, ...rest } = value as Record<string, unknown>;
  const lane = laneDef(rest, path);
  // The node-test reporter is loaded through NODE_OPTIONS (B1): a lane that sets its own is refused.
  if (reporter === 'node-test' && (Object.hasOwn(lane.env.set, 'NODE_OPTIONS') || lane.env.pass.includes('NODE_OPTIONS'))) {
    throw new SchemaError(`${path}.env`, 'no NODE_OPTIONS on a node-test lane (the witness reporter is loaded through it)', lane.env);
  }
  return { ...lane, reporter };
};

const obligationState: Read<ObligationState> = tagged('type', {
  active: object((f): ObligationState => ({ type: f.get('type', literal('active')) })),
  split: object((f): ObligationState => ({ type: f.get('type', literal('split')), children: f.get('children', sortedBy(oid, (c) => c, { nonEmpty: true })) })),
  waived: object((f): ObligationState => ({ type: f.get('type', literal('waived')), ruling: f.get('ruling', rid) })),
  deferred: object((f): ObligationState => ({ type: f.get('type', literal('deferred')), ruling: f.get('ruling', rid) })),
  retired: object((f): ObligationState => ({ type: f.get('type', literal('retired')), ruling: f.get('ruling', rid) })),
});

export const docRef: Read<DocRef> = object(docRefFields);

const witnessRef: Read<WitnessRef> = object((f) => {
  const out = { lane: f.get('lane', (v, p) => laneId(v, p)), testIds: f.get('testIds', arrayOf(str, { nonEmpty: true })) };
  assertUnique(out.testIds, (t) => t, `${f.path}.testIds`);
  return out;
});

const proofJudgment: Read<ProofJudgment> = object((f) => ({
  verdict: f.get('verdict', oneOf(['proves', 'insufficient'] as const)),
  obligationRev: f.get('obligationRev', positive),
  laneRev: f.get('laneRev', (v, p) => laneRev(v, p)),
}));

const obligationDef: Read<ObligationDef> = object((f) => {
  const parent = f.optional('parent', oid);
  const out: ObligationDef = {
    id: f.get('id', oid),
    rev: f.get('rev', positive),
    statement: f.get('statement', str),
    docRef: f.get('docRef', docRef),
    serves: f.get('serves', sortedBy(vid, (c) => c)),
    witness: f.get('witness', nullable(witnessRef)),
    proofJudgment: f.get('proofJudgment', nullable(proofJudgment)),
    deliveredBy: f.get('deliveredBy', sortedBy((v, p) => unitId(v, p), (u) => u)),
    activation: f.get('activation', oneOf(ACTIVATIONS)),
    ...(parent === undefined ? {} : { parent }),
    contracts: f.get('contracts', sortedBy(pathR, (c) => c)),
    state: f.get('state', obligationState),
  };
  const split = out.state.type === 'split';
  if ((out.witness === null) !== split) throw new SchemaError(`${f.path}.witness`, split ? 'null on a split parent' : 'a witness', out.witness);
  if ((out.proofJudgment === null) !== split) throw new SchemaError(`${f.path}.proofJudgment`, split ? 'null on a split parent' : 'a proof judgment', out.proofJudgment);
  if (out.activation === 'future' && out.deliveredBy.length === 0) throw new SchemaError(`${f.path}.deliveredBy`, 'the delivering units of a future obligation', out.deliveredBy);
  if (out.parent === out.id) throw new SchemaError(`${f.path}.parent`, 'an obligation other than itself', out.parent);
  return out;
});

export const obligations: Read<Obligations> = object((f) => {
  const out: Obligations = {
    schema: f.get('schema', literal(OBLIGATIONS_SCHEMA)),
    cutLine: f.get('cutLine', str),
    lanes: f.get('lanes', arrayOf(arcLaneDef)),
    obligations: f.get('obligations', arrayOf(obligationDef)),
    mapping: f.get('mapping', object((g) => ({
      paths: g.get('paths', arrayOf(object((h) => ({
        pattern: h.get('pattern', (v, p) => repoPattern(v, p)),
        obligations: h.get('obligations', sortedBy(oid, (o) => o, { nonEmpty: true })),
      })))),
    }))),
  };
  assertUnique(out.lanes, byId, `${f.path}.lanes`);
  assertUnique(out.obligations, byId, `${f.path}.obligations`);
  assertUnique(out.mapping.paths, (e) => e.pattern, `${f.path}.mapping.paths`);
  const ids = new Map(out.obligations.map((o) => [o.id, o]));
  const lanes = new Set(out.lanes.map((l) => l.id));
  out.obligations.forEach((o, i) => {
    const at = `${f.path}.obligations[${i}]`;
    if (o.witness !== null && !lanes.has(o.witness.lane)) throw new SchemaError(`${at}.witness.lane`, 'an arc lane of this file', o.witness.lane);
    if (o.parent !== undefined) {
      const p = ids.get(o.parent);
      if (p === undefined || p.state.type !== 'split' || !p.state.children.includes(o.id)) throw new SchemaError(`${at}.parent`, 'a split parent listing this child', o.parent);
    }
    if (o.state.type === 'split') {
      for (const c of o.state.children) if (ids.get(c)?.parent !== o.id) throw new SchemaError(`${at}.state.children`, `children naming ${o.id} as their parent`, c);
    }
  });
  out.mapping.paths.forEach((e, i) => e.obligations.forEach((o) => {
    if (!ids.has(o)) throw new SchemaError(`${f.path}.mapping.paths[${i}].obligations`, 'obligations of this file', o);
  }));
  return out;
});

export function parseObligations(value: unknown): Obligations {
  return obligations(value, 'obligations');
}

/** First 16 hex of sha256 over an arc lane's canonical definition: what observations and proof judgments bind. */
export function laneRevOf(lane: ArcLaneDef): LaneRev {
  return laneRev(sha256Hex(canonicalJson(lane)).slice(0, 16));
}

/** An obligation is exempt while waived, deferred or retired (only a disposition ruling exempts one). */
export const isExempt = (o: ObligationDef): boolean => o.state.type === 'waived' || o.state.type === 'deferred' || o.state.type === 'retired';

/** Vision coverage (A1's `visionCoverage`; `status.vision.coverage`, every lens and checkpoint prompt). */
export type VisionCoverage = Readonly<{
  /** Active clauses no active obligation serves. */
  unservedClauses: readonly VisionClauseId[];
  /** Active obligations serving no clause. */
  obligationsServingNone: readonly ObligationId[];
  /** H16: withdrawn clauses still cited, and by what (an obligation, a ruling or a divergence id). */
  withdrawnCited: readonly Readonly<{ clause: VisionClauseId; citedBy: readonly string[] }>[];
}>;

// ---------------------------------------------------------------------------------------------------
// Witness records (`witness.json` in a lane's evidence dir; B1 writes them)

export const WITNESS_OUTCOMES = ['pass', 'fail', 'skip', 'zero-selected'] as const;
export type WitnessOutcome = (typeof WITNESS_OUTCOMES)[number];
/** One test id's result in one lane run: how many tests it selected and how they ended. */
export type WitnessTest = Readonly<{ testId: string; selected: number; outcome: WitnessOutcome }>;
/** `witness` certifies a tree; `mutant` (G13) records a mutated tree's run and never certifies. */
export const WITNESS_PURPOSES = ['witness', 'mutant'] as const;
export type WitnessPurpose = (typeof WITNESS_PURPOSES)[number];

/** One arc lane run's per-test records. `malformed`: the reporter output did not parse, so every declared test is unwitnessed. */
export type WitnessRecord = Readonly<{
  v: SchemaVersion;
  lane: LaneId;
  laneRev: LaneRev;
  envId: EnvId;
  /** The tree the lane ran on (for a mutant, the patched tree's real id). */
  treeSha: Sha;
  inv: InvocationId;
  runner: Reporter;
  purpose: WitnessPurpose;
  /** Ascending by test id; empty when malformed. */
  records: readonly WitnessTest[];
  malformed: boolean;
}>;

export const witnessRecord: Read<WitnessRecord> = object((f) => {
  const out: WitnessRecord = {
    v: f.get('v', version),
    lane: f.get('lane', (v, p) => laneId(v, p)),
    laneRev: f.get('laneRev', (v, p) => laneRev(v, p)),
    envId: f.get('envId', (v, p) => envId(v, p)),
    treeSha: f.get('treeSha', shaR),
    inv: f.get('inv', (v, p) => invocationIdOf(v, p)),
    runner: f.get('runner', oneOf(REPORTERS)),
    purpose: f.get('purpose', oneOf(WITNESS_PURPOSES)),
    records: f.get('records', sortedBy(object((g) => ({ testId: g.get('testId', str), selected: g.get('selected', nat), outcome: g.get('outcome', oneOf(WITNESS_OUTCOMES)) })), (r) => r.testId)),
    malformed: f.get('malformed', bool),
  };
  if (out.malformed && out.records.length > 0) throw new SchemaError(`${f.path}.records`, 'none when malformed', out.records);
  return out;
});

/** An observation's verdict for one obligation on one tree (§2.8; computed by B1's `verdictOf`). */
export const OBSERVATION_VERDICTS = ['held', 'not-held', 'partial', 'unwitnessed'] as const;
export type ObservationVerdict = (typeof OBSERVATION_VERDICTS)[number];
/** What an observation is keyed by and reused on (all four, plus the records' hash). */
export type ObservationKey = Readonly<{ treeSha: Sha; lane: LaneId; laneRev: LaneRev; envId: EnvId }>;
export const observationKey: Read<ObservationKey> = object((f) => ({
  treeSha: f.get('treeSha', shaR), lane: f.get('lane', (v, p) => laneId(v, p)), laneRev: f.get('laneRev', (v, p) => laneRev(v, p)), envId: f.get('envId', (v, p) => envId(v, p)),
}));
export const observationKeyText = (k: ObservationKey): string => `${k.treeSha}/${k.lane}/${k.laneRev}/${k.envId}`;

/** B1's pure verdict over one obligation's witness tests in one record (frozen signature). */
export type VerdictOf = (record: WitnessRecord, witness: WitnessRef) => ObservationVerdict;

// ---------------------------------------------------------------------------------------------------
// Impact selection (§2.8; A1's `src/holistic/impact.ts` implements it, A3's fingerprint and B2's candidate read it)

/** What a candidate's selection reads. `changedPaths`: the merge-base diff's paths. */
export type ImpactInput = Readonly<{
  obligations: Obligations;
  /** Every unit the candidate publishes (one, or a batch's members), with its spec's declared obligations and repairs. */
  units: readonly Readonly<{ unit: UnitId; declared: readonly ObligationId[]; repairs: readonly ObligationId[] }>[];
  /** The declared obligations of the units' dependency closure. */
  closure: readonly ObligationId[];
  changedPaths: readonly RepoPath[];
  /** A revision publication's obligations added, split or re-witnessed (G12); empty for a unit candidate. */
  revised: readonly ObligationId[];
}>;
/** The selected obligations, ascending, split closure applied (H14: a selected child selects its parent and back). */
export type SelectObligations = (input: ImpactInput) => readonly ObligationId[];

// ---------------------------------------------------------------------------------------------------
// Ruling sidecars (§2.6; G21): `rule <record.json>` and a bundle's rulings. A1 validates them against the ledger.

export const RULING_SCHEMA = 'roadmap/ruling-m3';
export const RULING_KINDS = ['constraint', 'decision', 'deviation', 'disposition'] as const;
export type RulingKind = (typeof RULING_KINDS)[number];
export const DOC_RELATIONS = ['consistent', 'refines', 'deviates'] as const;
export type RulingDocRef = DocRef & Readonly<{ relation: (typeof DOC_RELATIONS)[number] }>;
/** An anchor-exact contract edit: the one match of `oldText` under `anchor` in `path` becomes `newText`. */
export type ContractOp = Readonly<{ path: RepoPath; anchor: string; oldText: string; newText: string }>;
/** Weakening dispositions (LR-c; "Obligations as a revisioned input"): `amended` covers a statement, docRef or activation change. */
export const OBLIGATION_DISPOSITIONS = ['waived', 'deferred', 'retired', 'amended'] as const;
export type ObligationDisposition = (typeof OBLIGATION_DISPOSITIONS)[number];
export const RULING_LIFETIMES = ['arc', 'standing'] as const;
export const RULING_STATUSES = ['active', 'superseded', 'withdrawn'] as const;

/** Who rules: the architect, or the checkpoint of a job (citing active clauses and evidence). */
export type RuledBy = Readonly<{ type: 'architect' }> | Readonly<{ type: 'checkpoint'; job: JobId }>;
/**
 * G21: the model judgment of semantic consistency, stored with the revisions it judged. A sidecar whose
 * `judgedRevs` differ from the revisions in force at its commit is stale and refused.
 */
export type Consistency = Readonly<{
  verdict: 'consistent' | 'inconsistent';
  judgedRevs: Readonly<{
    head: Sha;
    ledgerSha256: Sha256Hex;
    obligationsSha256: Sha256Hex | null;
    visionSha256: Sha256Hex | null;
    contracts: readonly Readonly<{ path: RepoPath; blob: Sha }>[];
  }>;
  /** A judgment role and the routing revision it ran under (never a model), or the architect. */
  by: Readonly<{ type: 'judgment'; role: FreshRole; routingRev: string }> | Readonly<{ type: 'architect' }>;
}>;

export type RulingSidecar = Readonly<{
  schema: typeof RULING_SCHEMA;
  id: RulingId;
  statement: string;
  kind: RulingKind;
  ruledBy: RuledBy;
  trigger: string;
  supersedes: readonly Readonly<{ id: RulingId; part: string | null }>[];
  condition: string | null;
  docRefs: readonly RulingDocRef[];
  contractRefs: readonly RepoPath[];
  contractOps: readonly ContractOp[];
  obligations: readonly ObligationId[];
  obligationDispositions: readonly Readonly<{ id: ObligationId; disposition: ObligationDisposition }>[];
  /** Active vision clauses; non-empty for a checkpoint's ruling. */
  cites: readonly VisionClauseId[];
  evidence: readonly string[];
  appliesTo: Readonly<{ type: 'arc' }> | Readonly<{ type: 'units'; units: readonly UnitId[] }>;
  lifetime: (typeof RULING_LIFETIMES)[number];
  status: (typeof RULING_STATUSES)[number];
  consistency: Consistency;
}>;

const contractRevs = sortedBy(object((g) => ({ path: g.get('path', pathR), blob: g.get('blob', shaR) })), (e) => e.path);

export const consistency: Read<Consistency> = object((f) => ({
  verdict: f.get('verdict', oneOf(['consistent', 'inconsistent'] as const)),
  judgedRevs: f.get('judgedRevs', object((g) => ({
    head: g.get('head', shaR),
    ledgerSha256: g.get('ledgerSha256', sha256R),
    obligationsSha256: g.get('obligationsSha256', nullable(sha256R)),
    visionSha256: g.get('visionSha256', nullable(sha256R)),
    contracts: g.get('contracts', contractRevs),
  }))),
  by: f.get('by', tagged<'judgment' | 'architect', Consistency['by']>('type', {
    judgment: object((g) => ({
      type: g.get('type', literal('judgment')),
      role: g.get('role', oneOf(ROLES.filter((r): r is FreshRole => r !== 'build'))),
      routingRev: g.get('routingRev', (v, p) => { const s = str(v, p); if (!/^[0-9a-f]{16}$/.test(s)) throw new SchemaError(p, 'a routing revision (16 lowercase hex)', v); return s; }),
    })),
    architect: object((g) => ({ type: g.get('type', literal('architect')) })),
  })),
}));

export const contractOp: Read<ContractOp> = object((f) => ({
  path: f.get('path', pathR), anchor: f.get('anchor', str), oldText: f.get('oldText', str), newText: f.get('newText', text),
}));

export const rulingSidecar: Read<RulingSidecar> = object((f) => {
  const out: RulingSidecar = {
    schema: f.get('schema', literal(RULING_SCHEMA)),
    id: f.get('id', rid),
    statement: f.get('statement', str),
    kind: f.get('kind', oneOf(RULING_KINDS)),
    ruledBy: f.get('ruledBy', tagged<'architect' | 'checkpoint', RuledBy>('type', {
      architect: object((g) => ({ type: g.get('type', literal('architect')) })),
      checkpoint: object((g) => ({ type: g.get('type', literal('checkpoint')), job: g.get('job', jobR) })),
    })),
    trigger: f.get('trigger', str),
    supersedes: f.get('supersedes', arrayOf(object((g) => ({ id: g.get('id', rid), part: g.get('part', nullable(str)) })))),
    condition: f.get('condition', nullable(str)),
    docRefs: f.get('docRefs', arrayOf(object((g) => ({ ...docRefFields(g), relation: g.get('relation', oneOf(DOC_RELATIONS)) })), { nonEmpty: true })),
    contractRefs: f.get('contractRefs', sortedBy(pathR, (c) => c)),
    contractOps: f.get('contractOps', arrayOf(contractOp)),
    obligations: f.get('obligations', sortedBy(oid, (o) => o)),
    obligationDispositions: f.get('obligationDispositions', sortedBy(object((g) => ({ id: g.get('id', oid), disposition: g.get('disposition', oneOf(OBLIGATION_DISPOSITIONS)) })), byId)),
    cites: f.get('cites', sortedBy(vid, (c) => c)),
    evidence: f.get('evidence', arrayOf(str)),
    appliesTo: f.get('appliesTo', tagged<'arc' | 'units', RulingSidecar['appliesTo']>('type', {
      arc: object((g) => ({ type: g.get('type', literal('arc')) })),
      units: object((g) => ({ type: g.get('type', literal('units')), units: g.get('units', sortedBy((v, p) => unitId(v, p), (u) => u, { nonEmpty: true })) })),
    })),
    lifetime: f.get('lifetime', oneOf(RULING_LIFETIMES)),
    status: f.get('status', oneOf(RULING_STATUSES)),
    consistency: f.get('consistency', consistency),
  };
  if (out.docRefs.some((d) => d.relation === 'deviates') && out.contractOps.length === 0) throw new SchemaError(`${f.path}.contractOps`, 'the contract ops of a deviating ruling', out.contractOps);
  if (out.ruledBy.type === 'checkpoint' && (out.cites.length === 0 || out.evidence.length === 0)) {
    throw new SchemaError(`${f.path}.cites`, 'active vision clauses and evidence for a checkpoint ruling', { cites: out.cites, evidence: out.evidence });
  }
  return out;
});


export function parseRulingSidecar(value: unknown): RulingSidecar {
  return rulingSidecar(value, 'ruling');
}

// ---------------------------------------------------------------------------------------------------
// Findings (§2.8; B3)

export const FINDING_SEVERITIES = ['P1', 'P2', 'P3'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
/** Who opened it: a lens, code over a witness (a must-hold not held on an audit snapshot), or plan-check (R17). */
export const FINDING_LENSES = [...LENS_KINDS, 'witness', 'plan-check'] as const;
export type FindingLens = (typeof FINDING_LENSES)[number];
/** `fixed-on-branch` (R5): the owner's gate approved. `resolved` and `ruled` are terminal. */
export const FINDING_STATES = ['open', 'owned', 'fixed-on-branch', 'resolved', 'ruled'] as const;
export type FindingStateName = (typeof FINDING_STATES)[number];
/** A cited evidence item: a path (repo or evidence dir) and its blob when it names one; a changed blob lifts a dismissal. */
export type FindingEvidence = Readonly<{ path: string; blob: Sha | null }>;
export type FindingSource = Readonly<{ type: 'job'; job: JobId }> | Readonly<{ type: 'stage'; unit: UnitId; stage: 'plan-check'; attempt: number }>;
/** A vacuity finding's mutant: the patch (kept content-addressed) and the lane that should kill it. */
export type MutantRef = Readonly<{ patchSha256: Sha256Hex; lane: LaneId }>;
/** Who ruled a finding: a checkpoint's `findingDispositions`, a ruling, or code (a mutant not reproduced). */
export type FindingRuledBy = Readonly<{ type: 'checkpoint'; job: JobId }> | Readonly<{ type: 'ruling'; ruling: RulingId }> | Readonly<{ type: 'code'; reason: 'not-reproduced' }>;
export const FINDING_DISPOSITIONS = ['dismissed', 'deferred', 'accepted'] as const;
export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number];
/** A `finding-transition`'s target. */
export type FindingTo =
  | Readonly<{ state: 'open' }>
  | Readonly<{ state: 'owned' | 'fixed-on-branch'; unit: UnitId }>
  | Readonly<{ state: 'resolved' }>
  | Readonly<{ state: 'ruled'; disposition: FindingDisposition; by: FindingRuledBy }>;

/** The legal moves (the fold refuses any other): open → owned | ruled; owned → fixed-on-branch | open | ruled; fixed-on-branch → resolved | owned | open | ruled. */
export const FINDING_MOVES: { readonly [S in FindingStateName]: readonly FindingStateName[] } = {
  open: ['owned', 'ruled'],
  owned: ['fixed-on-branch', 'open', 'ruled'],
  'fixed-on-branch': ['resolved', 'owned', 'open', 'ruled'],
  resolved: [],
  ruled: [],
};

/** `key = sha256(lens, obligation, cause)` (canonical JSON of the three): dedupe merges an open finding's key. */
export function findingKey(lens: FindingLens, obligation: ObligationId | null, cause: string): Sha256Hex {
  return sha256(sha256Hex(canonicalJson({ lens, obligation, cause })));
}

export const findingEvidence: Read<FindingEvidence> = object((f) => ({ path: f.get('path', str), blob: f.get('blob', nullable(shaR)) }));
export const findingSource: Read<FindingSource> = tagged('type', {
  job: object((f): FindingSource => ({ type: f.get('type', literal('job')), job: f.get('job', jobR) })),
  stage: object((f): FindingSource => ({ type: f.get('type', literal('stage')), unit: f.get('unit', (v, p) => unitId(v, p)), stage: f.get('stage', literal('plan-check')), attempt: f.get('attempt', positive) })),
});
export const mutantRef: Read<MutantRef> = object((f) => ({ patchSha256: f.get('patchSha256', sha256R), lane: f.get('lane', (v, p) => laneId(v, p)) }));
export const findingTo: Read<FindingTo> = tagged('state', {
  open: object((f): FindingTo => ({ state: f.get('state', literal('open')) })),
  owned: object((f): FindingTo => ({ state: f.get('state', literal('owned')), unit: f.get('unit', (v, p) => unitId(v, p)) })),
  'fixed-on-branch': object((f): FindingTo => ({ state: f.get('state', literal('fixed-on-branch')), unit: f.get('unit', (v, p) => unitId(v, p)) })),
  resolved: object((f): FindingTo => ({ state: f.get('state', literal('resolved')) })),
  ruled: object((f): FindingTo => ({
    state: f.get('state', literal('ruled')),
    disposition: f.get('disposition', oneOf(FINDING_DISPOSITIONS)),
    by: f.get('by', tagged<'checkpoint' | 'ruling' | 'code', FindingRuledBy>('type', {
      checkpoint: object((g) => ({ type: g.get('type', literal('checkpoint')), job: g.get('job', jobR) })),
      ruling: object((g) => ({ type: g.get('type', literal('ruling')), ruling: g.get('ruling', rid) })),
      code: object((g) => ({ type: g.get('type', literal('code')), reason: g.get('reason', literal('not-reproduced')) })),
    })),
  })),
});

// ---------------------------------------------------------------------------------------------------
// Audits and checkpoints (§2.5, §2.8; B5, B6)

/** Why an audit runs (coalesced into one `audit-started`). */
export type AuditTrigger =
  /** Every N publications (D3, N = `holistic.audit.every`, default 5). */
  | Readonly<{ type: 'cadence' }>
  /** R8: a publication left a selected future or exempt obligation unwitnessed. */
  | Readonly<{ type: 'unwitnessed'; obligation: ObligationId }>
  /** A revision from a rule, a bundle, `reverse`, or an architect spec, obligation or vision edit: `L ∩ {drift, vision}`. */
  | Readonly<{ type: 'drift'; planRev: number }>
  | Readonly<{ type: 'wall-clock' }>
  | Readonly<{ type: 'requested'; command: string }>
  /** H9: at the final head, every lens in L with an outstanding range. */
  | Readonly<{ type: 'final' }>;

export const auditTrigger: Read<AuditTrigger> = tagged('type', {
  cadence: object((f): AuditTrigger => ({ type: f.get('type', literal('cadence')) })),
  unwitnessed: object((f): AuditTrigger => ({ type: f.get('type', literal('unwitnessed')), obligation: f.get('obligation', oid) })),
  drift: object((f): AuditTrigger => ({ type: f.get('type', literal('drift')), planRev: f.get('planRev', positive) })),
  'wall-clock': object((f): AuditTrigger => ({ type: f.get('type', literal('wall-clock')) })),
  requested: object((f): AuditTrigger => ({ type: f.get('type', literal('requested')), command: f.get('command', (v, p) => { const s = str(v, p); if (!/^cmd-[0-9a-f]{16}$/.test(s)) throw new SchemaError(p, 'a command id', v); return s; }) })),
  final: object((f): AuditTrigger => ({ type: f.get('type', literal('final')) })),
});

/** What a checkpoint runs for: a completed audit, or an operator-design park (OR-Q1). */
export type CheckpointTrigger = Readonly<{ type: 'audit'; job: JobId }> | Readonly<{ type: 'park'; unit: UnitId; seq: number }>;
export const checkpointTrigger: Read<CheckpointTrigger> = tagged('type', {
  audit: object((f): CheckpointTrigger => ({ type: f.get('type', literal('audit')), job: f.get('job', jobR) })),
  park: object((f): CheckpointTrigger => ({ type: f.get('type', literal('park')), unit: f.get('unit', (v, p) => unitId(v, p)), seq: f.get('seq', positive) })),
});

/**
 * The revision vector a checkpoint read (`checkpoint-inputs`) and a bundle's staleness check compares (H3: the
 * vision sha always): the plan rev, each spec's rev, the obligations, ledger and vision bytes, the contract blobs.
 */
export type RevisionVector = Readonly<{
  plan: number;
  specs: Readonly<Record<UnitId, number>>;
  obligationsSha256: Sha256Hex | null;
  ledgerSha256: Sha256Hex | null;
  visionSha256: Sha256Hex;
  contracts: readonly Readonly<{ path: RepoPath; blob: Sha }>[];
}>;

const specRevs: Read<Readonly<Record<UnitId, number>>> = (value, path) => {
  const f = new Fields(value, path);
  const out: Record<UnitId, number> = {};
  for (const key of Object.keys(value as object)) out[unitId(key, `${path}.${key}`)] = f.get(key, positive);
  f.end();
  return out;
};
export const revisionVector: Read<RevisionVector> = object((f) => ({
  plan: f.get('plan', positive),
  specs: f.get('specs', specRevs),
  obligationsSha256: f.get('obligationsSha256', nullable(sha256R)),
  ledgerSha256: f.get('ledgerSha256', nullable(sha256R)),
  visionSha256: f.get('visionSha256', sha256R),
  contracts: f.get('contracts', contractRevs),
}));

/** A bundle's outcome other than an applied revision (which is its `plan-applied{source: bundle}`). */
export type BundleRejection = 'stale' | 'evidence' | 'invalid';
export type BundleOutcome =
  | Readonly<{ kind: 'no-op' }>
  | Readonly<{ kind: 'rejected'; reason: BundleRejection; detail: string }>
  /** Held for the architect: a `bundle-request` (A9, draining, a brake) or an `owner-request` (A16). */
  | Readonly<{ kind: 'requested'; needsUser: string }>;

// ---------------------------------------------------------------------------------------------------
// Divergences (OR-V.6, A10, H11, H12, H13)

/** What a checkpoint act departed from; `interpretation` is a reading of the vision on a situation it does not anticipate (H12). */
export const DIVERGENCE_KINDS = ['target-departed', 'obligation-departed', 'plan-departed', 'contract-departed', 'split-dropped', 'interpretation'] as const;
export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];
/** The revisions of exactly the artifacts the act touched, before it (H13: no executable inverse is recorded). */
export type Preimage = Readonly<{
  planRev: number;
  specs: Readonly<Record<UnitId, number>>;
  obligationsSha256: Sha256Hex | null;
  ledgerSha256: Sha256Hex | null;
  contracts: readonly Readonly<{ path: RepoPath; blob: Sha }>[];
}>;
/** How to undo it: restore the recorded revisions (`reverse <D-n>`), a verified repair unit (a product effect), or nothing. */
export const COMPENSATION_KINDS = ['restore-revision', 'repair-unit', 'none'] as const;
export type Compensation = Readonly<{ hint: string; kind: (typeof COMPENSATION_KINDS)[number] }>;

export const preimage: Read<Preimage> = object((f) => ({
  planRev: f.get('planRev', positive),
  specs: f.get('specs', specRevs),
  obligationsSha256: f.get('obligationsSha256', nullable(sha256R)),
  ledgerSha256: f.get('ledgerSha256', nullable(sha256R)),
  contracts: f.get('contracts', contractRevs),
}));
export const compensation: Read<Compensation> = object((f) => ({ hint: f.get('hint', str), kind: f.get('kind', oneOf(COMPENSATION_KINDS)) }));

/** A divergence before its id: what a revision payload carries and the fold numbers when it is appended. */
export type DivergenceDraft = Readonly<{
  job: JobId;
  /** Named `type`, not the plan's `kind`: the `divergence` fact's own `kind` is its discriminator. */
  type: DivergenceKind;
  /** A reference to what it departed from: `plan rev 4`, `I-2 rev 1`, `docs/target.md#anchor`, a clause list. */
  from: string;
  what: string;
  /** Active vision clauses, non-empty. */
  cites: readonly VisionClauseId[];
  evidence: readonly string[];
  preimage: Preimage;
  compensation: Compensation;
}>;
export const divergenceDraftFields = (f: Fields): DivergenceDraft => ({
  job: f.get('job', jobR),
  type: f.get('type', oneOf(DIVERGENCE_KINDS)),
  from: f.get('from', str),
  what: f.get('what', str),
  cites: f.get('cites', sortedBy(vid, (c) => c, { nonEmpty: true })),
  evidence: f.get('evidence', arrayOf(str, { nonEmpty: true })),
  preimage: f.get('preimage', preimage),
  compensation: f.get('compensation', compensation),
});
export const divergenceDraft: Read<DivergenceDraft> = object(divergenceDraftFields);

// ---------------------------------------------------------------------------------------------------
// Owner-only acts (A16, H10)

/** The closed set a checkpoint may only `request`: never express as an op, and nested effects convert to it. */
export const OWNER_ONLY_CLASSES = [
  'destructive', 'cost', 'legal', 'vision', 'resource', 'config', 'gc', 'ref-deletion', 'lane-program', 'env-prerequisite', 'contract-path',
] as const;
export type OwnerOnlyClass = (typeof OWNER_ONLY_CLASSES)[number];
