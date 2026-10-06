// The holistic layer's records (M3, frozen in step 0a; SCHEMAS.md "M3: the holistic layer"): the vision, the
// obligations file, witness records, ruling sidecars, findings and divergences, and the frozen signatures the
// later steps implement (impact selection, observations). Types, readers and pure helpers only: no I/O.
//
// Owners of the behaviour: A1 (obligations, impact, re-derivation, vision coverage, rulings), B1 (witnesses,
// observations, the transition table in table.ts), B3 (findings), B5 (audits, coverage), B6 (checkpoint, bundles,
// divergences).
import {
  type FindingId, type InvocationId, type JobId, type LaneId, type LaneRev, type ObligationId, type PlanRev, type QuestionId, type RoutingRev, type RuleId,
  type RulingId, type Sha, type Sha256Hex, type UnitId, type VisionClauseId, envId, findingId, invocationIdOf, jobIdOf, jobIdOfKind, laneId, laneRev,
  obligationId, planRev, questionId, routingRev, ruleId, ruleSeq, rulingId, sha, sha256, unitId, visionClauseId, type EnvId, idList, idsAscending,
  type OpportunityId, opportunityId,
} from '../core/ids.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import {
  LENS_KIND_NAMES, type LaneDef, type LensKindName, type RepairRef, type Stage, laneDef, laneEnv, refuseLaneInputs, repairRef,
} from '../core/records.ts';
import { minimalLaneRev } from '../core/upgrade.ts';
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
const ruleR: Read<RuleId> = (v, p) => ruleId(v, p);
const ruleRefR: Read<RuleRef> = object((g) => ({ id: g.get('id', ruleR), textSha256: g.get('textSha256', sha256R) }));

// ---------------------------------------------------------------------------------------------------
// Lenses (§2.5; A15 adds `vision`)

export const LENS_KINDS = LENS_KIND_NAMES;
export type LensKind = LensKindName;
export const lensKind: Read<LensKind> = oneOf(LENS_KINDS);

// ---------------------------------------------------------------------------------------------------
// The vision (OR-V, A14, H16): `holistic.vision` in plan.json names this file.

export const VISION_SCHEMA = 'roadmap/vision-m3';
/**
 * `world` is a prose scene of the target world: who is there, what they do and experience, and why it is better than
 * today; it may describe a horizon beyond this arc. The other kinds are its facets.
 */
export const VISION_CLAUSE_KINDS = ['world', 'purpose', 'serves', 'good', 'non-negotiable', 'tradeoff'] as const;
export type VisionClauseKind = (typeof VISION_CLAUSE_KINDS)[number];
export const CLAUSE_STATES = ['active', 'withdrawn'] as const;
export type ClauseState = (typeof CLAUSE_STATES)[number];

/** `rank` orders the tradeoffs (1 first) and is null for every other kind. A withdrawn clause stays in the file. */
export type VisionClause = Readonly<{ id: VisionClauseId; kind: VisionClauseKind; text: string; rank: number | null; state: ClauseState }>;

export const QUESTION_STATES = ['open', 'closed'] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

/**
 * A vision open question: one whose answer would change the target world (not a design question, which a unit's
 * spec or a ruling settles). `bears` names the active clauses it bears on; `assumption` is the working assumption the
 * arc acts on meanwhile. A closed question stays in the file as it was (its `bears` need only name clauses of the file);
 * ids are never reused.
 */
export type VisionQuestion = Readonly<{ id: QuestionId; text: string; bears: readonly VisionClauseId[]; assumption: string; state: QuestionState }>;

/**
 * The root record (OR-V). Owner-only: only an architect `apply` changes it. `confirmation` is the Phase-0
 * playback's confirmation reference (`parseConfirmationRef`): since M4a `corpus:<path under root>#sha256:<hex>`, verified
 * at every start and apply against the pinned corpus file (C1); the M3 form `vision.md#sha256:<hex>` an adopted dev.6
 * (`architecture-doc`) arc carries is never verified (only a corpus arc's is). At least one active `world` clause.
 */
export type Vision = Readonly<{
  schema: typeof VISION_SCHEMA;
  rev: number;
  confirmation: Readonly<{ ref: string; at: IsoTime }> | null;
  clauses: readonly VisionClause[];
  questions: readonly VisionQuestion[];
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

const visionQuestion: Read<VisionQuestion> = object((f) => ({
  id: f.get('id', (v, p) => questionId(v, p)),
  text: f.get('text', str),
  bears: f.get('bears', idList(vid, { nonEmpty: true, legacyStringOrder: true })),
  assumption: f.get('assumption', str),
  state: f.get('state', oneOf(QUESTION_STATES)),
}));

export const vision: Read<Vision> = object((f) => {
  const out: Vision = {
    schema: f.get('schema', literal(VISION_SCHEMA)),
    rev: f.get('rev', positive),
    confirmation: f.get('confirmation', nullable(object((g) => ({ ref: g.get('ref', str), at: g.get('at', (v, p) => isoTime(v, p)) })))),
    clauses: f.get('clauses', arrayOf(visionClause, { nonEmpty: true })),
    questions: f.get('questions', arrayOf(visionQuestion)),
  };
  assertUnique(out.clauses, byId, `${f.path}.clauses`);
  if (!out.clauses.some((c) => c.state === 'active' && c.kind === 'world')) throw new SchemaError(`${f.path}.clauses`, 'at least one active world clause', out.clauses);
  assertUnique(out.questions, byId, `${f.path}.questions`);
  // An open question bears on active clauses; a closed one stays as it was, so its clauses need only be in the file.
  out.questions.forEach((q, i) => q.bears.forEach((id) => {
    const c = out.clauses.find((x) => x.id === id);
    if (c === undefined || (q.state === 'open' && c.state !== 'active')) {
      throw new SchemaError(`${f.path}.questions[${i}].bears`, q.state === 'open' ? 'active clauses of this vision' : 'clauses of this vision', id);
    }
  }));
  return out;
});

export function parseVision(value: unknown): Vision {
  return vision(value, 'vision');
}

export const activeClauses = (v: Vision): readonly VisionClauseId[] => v.clauses.filter((c) => c.state === 'active').map((c) => c.id);

/**
 * A vision confirmation reference (OR-V+, R18): `corpus` names a corpus file by its path under the corpus root and the
 * sha256 of its confirmed bytes; `m3` is the dev.6 form `vision.md#sha256:<hex>` (path relative to the plan), which is
 * never verified. Anything else is malformed.
 */
export type ConfirmationRef =
  | Readonly<{ form: 'corpus'; path: RepoPath; sha256: Sha256Hex }>
  | Readonly<{ form: 'm3'; path: string; sha256: Sha256Hex }>;
export function parseConfirmationRef(ref: string, path = 'vision.confirmation.ref'): ConfirmationRef {
  const m = /^(corpus:)?(.+)#sha256:([0-9a-f]{64})$/.exec(ref);
  if (m === null) throw new SchemaError(path, 'corpus:<path>#sha256:<hex> (or the M3 form <file>#sha256:<hex>)', ref);
  const hash = sha256(m[3], path);
  return m[1] === undefined ? { form: 'm3', path: m[2] as string, sha256: hash } : { form: 'corpus', path: repoPath(m[2], path), sha256: hash };
}

// ---------------------------------------------------------------------------------------------------
// Obligations (§2.8; LR-b, H14): `holistic.obligations` in plan.json names this file.

export const OBLIGATIONS_SCHEMA = 'roadmap/obligations-m3';

/** How an arc lane reports per-test results (R1: the reporter is the lane's; R3: all three, `go` untested for real). */
export const REPORTERS = ['node-test', 'go-test-json', 'jsonl'] as const;
export type Reporter = (typeof REPORTERS)[number];
/**
 * An arc lane: owned by no unit, run in candidates, audits, the baseline job and close-out. `testPaths` (M4a rev 3, D2):
 * the repo patterns its test files live under, non-empty when present; mutation smoke reverts only the production diff
 * outside them (absent: smoke `notRun{no-test-paths}`).
 */
export type ArcLaneDef = LaneDef & Readonly<{ reporter: Reporter; testPaths?: readonly RepoPattern[] }>;

export const ACTIVATIONS = ['future', 'must-hold'] as const;
export type Activation = (typeof ACTIVATIONS)[number];

export type DocRef = Readonly<{ path: RepoPath; anchor: string; quotedText: string }>;
/** A corpus rule by identity (M4a): what a rule obligation, the census and a ruling's rule ref bind. */
export type RuleRef = Readonly<{ id: RuleId; textSha256: Sha256Hex }>;
/**
 * What an obligation is anchored at (M4a, A-M4-3): exactly one of a document reference (`architecture-doc` arcs) or a
 * pinned corpus rule (corpus arcs). Read only through `obligationSource`.
 */
export type ObligationAnchor = Readonly<{ docRef: DocRef; rule?: never }> | Readonly<{ rule: RuleRef; docRef?: never }>;
/** An obligation's anchor as its readers see it: the doc ref's fields, or the rule (as `rulingRefSource` reads a sidecar ref). */
export type ObligationSource = Readonly<{ kind: 'doc' } & DocRef> | Readonly<{ kind: 'rule'; rule: RuleRef }>;
/** The only reader of an obligation's anchor (H10; test target.no-direct-access). */
export function obligationSource(o: ObligationAnchor): ObligationSource {
  if (o.rule !== undefined) return { kind: 'rule', rule: o.rule };
  const d = o.docRef as DocRef;
  return { kind: 'doc', path: d.path, anchor: d.anchor, quotedText: d.quotedText };
}
export type WitnessRef = Readonly<{ lane: LaneId; testIds: readonly string[] }>;
/**
 * "This test proves this statement", judged at Phase 0 and bound to everything it judged: the obligation's `rev`,
 * the witness lane's `laneRev`, and the complete witness definition (`witness`: the lane id and every test id, in
 * the obligation's order; Checkpoint A). A change of any makes it stale (the classifier asks a fresh one).
 */
export type ProofJudgment = Readonly<{ verdict: 'proves' | 'insufficient'; obligationRev: number; laneRev: LaneRev; witness: WitnessRef }>;

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
}> & ObligationAnchor;

/**
 * A corpus arc's census (M4a, OR-Q13): one state per active pinned rule. `obligation` names the obligation whose
 * `rule.id` is the rule; the others say why no obligation tests it.
 */
export type CensusState =
  | Readonly<{ type: 'obligation'; id: ObligationId }>
  | Readonly<{ type: 'out-of-slice' | 'untestable' | 'prod-only' }>;
export const CENSUS_STATES = ['obligation', 'out-of-slice', 'untestable', 'prod-only'] as const;
export type CensusEntry = Readonly<{ rule: RuleId; state: CensusState }>;

export type MappingEntry = Readonly<{ pattern: RepoPattern; obligations: readonly ObligationId[] }>;

export type Obligations = Readonly<{
  schema: typeof OBLIGATIONS_SCHEMA;
  cutLine: string;
  lanes: readonly ArcLaneDef[];
  obligations: readonly ObligationDef[];
  /** The one authoritative impact mapping (§2.8), revisioned with the obligations. */
  mapping: Readonly<{ paths: readonly MappingEntry[] }>;
  /**
   * M4a: present exactly when the obligations are rule-anchored (a corpus arc), ascending by rule number. Absent on a
   * dev.6 file (`censusOf`: none, census checks vacuous).
   */
  census?: readonly CensusEntry[];
}>;

export const arcLaneDef: Read<ArcLaneDef> = (value, path) => {
  const g = new Fields(value, path);
  const reporter = g.get('reporter', oneOf(REPORTERS));
  const testPaths = g.optional('testPaths', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true }));
  const { reporter: _reporter, testPaths: _testPaths, ...rest } = value as Record<string, unknown>;
  const lane = laneDef(rest, path);
  refuseLaneInputs(lane, path, 'arc');
  // The node-test reporter is loaded through NODE_OPTIONS (B1): a lane that sets its own is refused.
  if (reporter === 'node-test' && (Object.hasOwn(lane.env.set, 'NODE_OPTIONS') || lane.env.pass.includes('NODE_OPTIONS'))) {
    throw new SchemaError(`${path}.env`, 'no NODE_OPTIONS on a node-test lane (the witness reporter is loaded through it)', lane.env);
  }
  if (testPaths !== undefined) assertUnique(testPaths, (t) => t, `${path}.testPaths`);
  return { ...lane, reporter, ...(testPaths === undefined ? {} : { testPaths }) };
};

const obligationState: Read<ObligationState> = tagged('type', {
  active: object((f): ObligationState => ({ type: f.get('type', literal('active')) })),
  split: object((f): ObligationState => ({ type: f.get('type', literal('split')), children: f.get('children', idList(oid, { nonEmpty: true, legacyStringOrder: true })) })),
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
  witness: f.get('witness', witnessRef),
}));

const obligationAnchor = (f: Fields): ObligationAnchor => {
  const doc = f.optional('docRef', docRef);
  const rule = f.optional('rule', ruleRefR);
  if ((doc === undefined) === (rule === undefined)) throw new SchemaError(`${f.path}.docRef`, 'exactly one of docRef and rule', { docRef: doc, rule });
  return doc !== undefined ? { docRef: doc } : { rule: rule as RuleRef };
};

const censusState: Read<CensusState> = tagged('type', {
  obligation: object((f): CensusState => ({ type: f.get('type', literal('obligation')), id: f.get('id', oid) })),
  'out-of-slice': object((f): CensusState => ({ type: f.get('type', literal('out-of-slice')) })),
  untestable: object((f): CensusState => ({ type: f.get('type', literal('untestable')) })),
  'prod-only': object((f): CensusState => ({ type: f.get('type', literal('prod-only')) })),
});
/** One entry per rule, ascending by rule number. */
const censusEntries: Read<readonly CensusEntry[]> = idsAscending(object((f): CensusEntry => ({ rule: f.get('rule', ruleR), state: f.get('state', censusState) })), (e) => e.rule);

const obligationDef: Read<ObligationDef> = object((f) => {
  const parent = f.optional('parent', oid);
  const out: ObligationDef = {
    id: f.get('id', oid),
    rev: f.get('rev', positive),
    statement: f.get('statement', str),
    ...obligationAnchor(f),
    serves: f.get('serves', idList(vid, { legacyStringOrder: true })),
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
  const census = f.optional('census', censusEntries);
  const out: Obligations = {
    schema: f.get('schema', literal(OBLIGATIONS_SCHEMA)),
    cutLine: f.get('cutLine', str),
    lanes: f.get('lanes', arrayOf(arcLaneDef)),
    obligations: f.get('obligations', arrayOf(obligationDef)),
    mapping: f.get('mapping', object((g) => ({
      paths: g.get('paths', arrayOf(object((h) => ({
        pattern: h.get('pattern', (v, p) => repoPattern(v, p)),
        obligations: h.get('obligations', idList(oid, { nonEmpty: true, legacyStringOrder: true })),
      })))),
    }))),
    ...(census === undefined ? {} : { census }),
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
  // M4a: one anchor kind per file, and a census exactly with rule anchors (a corpus arc's file).
  const ruled = out.obligations.filter((o) => obligationSource(o).kind === 'rule');
  if (ruled.length > 0 && ruled.length < out.obligations.length) throw new SchemaError(`${f.path}.obligations`, 'one anchor kind for every obligation (all docRef or all rule)', ruled.map((o) => o.id));
  if (out.census === undefined && ruled.length > 0) throw new SchemaError(`${f.path}.census`, 'a census beside rule-anchored obligations', undefined);
  if (out.census !== undefined) {
    if (ruled.length < out.obligations.length) throw new SchemaError(`${f.path}.census`, 'absent beside docRef-anchored obligations', out.census);
    const inCensus = new Map<ObligationId, RuleId>();
    out.census.forEach((e, i) => {
      if (e.state.type !== 'obligation') return;
      const o = ids.get(e.state.id);
      const src = o === undefined ? null : obligationSource(o);
      if (src?.kind !== 'rule' || src.rule.id !== e.rule) throw new SchemaError(`${f.path}.census[${i}].state.id`, `an obligation of this file anchored at ${e.rule}`, e.state.id);
      if (inCensus.has(e.state.id)) throw new SchemaError(`${f.path}.census[${i}].state.id`, 'an obligation the census names once', e.state.id);
      inCensus.set(e.state.id, e.rule);
    });
    // LR-C1-2: an exempt obligation binds nothing, so the census (one state per active rule) need not name it. M4a C3: a
    // split child on its parent's rule is counted through the ancestor the census names (one state per rule; a
    // checkpoint's split never edits the census, Phase 0's).
    const counted = (o: ObligationDef): boolean => {
      const rule = (obligationSource(o) as Extract<ObligationSource, { kind: 'rule' }>).rule.id;
      for (let at: ObligationDef | undefined = o; at !== undefined; at = at.parent === undefined ? undefined : ids.get(at.parent)) {
        if (inCensus.get(at.id) === rule) return true;
      }
      return false;
    };
    ruled.forEach((o) => {
      if (!isExempt(o) && !counted(o)) throw new SchemaError(`${f.path}.census`, `an entry naming ${o.id} or the split parent it restates (every rule obligation is in the census unless exempt)`, out.census);
    });
  }
  return out;
});

export function parseObligations(value: unknown): Obligations {
  return obligations(value, 'obligations');
}

/**
 * A lane's revision (F7, R64): the first 16 hex of sha256 over its validated, normalised definition, what observations,
 * proof judgments and (M4a rev 3) lane-reuse identities bind. Normalised = re-read through its reader (`arcLaneDef` for an
 * arc lane, `laneDef` for a spec lane), so a field the reader defaults is explicit (`evidenceExcludes: []`) whatever the
 * caller wrote, and an absent-means-none field (`cpu`, `inputs`, `testPaths`) stays absent: one encoding per lane. A
 * generator that hashes raw JSON gets the executor's rev (F15). The executor's dev.6 revs are this form already.
 */
export function laneRevOf(lane: LaneDef | ArcLaneDef): LaneRev {
  return laneRev(sha256Hex(canonicalJson(normalisedLane(lane))).slice(0, 16));
}
/** A lane re-read through its reader; a spec lane item's `state` is the item's, not the definition's, so it is left out. */
function normalisedLane(lane: LaneDef | ArcLaneDef): LaneDef | ArcLaneDef {
  const { state: _state, ...def } = lane as LaneDef & Readonly<{ state?: unknown }>;
  return 'reporter' in def ? arcLaneDef(def, 'lane') : laneDef(def, 'lane');
}

/**
 * Whether a recorded lane rev is `lane`'s (F7): its normalised rev, or (TEMPORARY SCAFFOLDING, `minimalLaneRev` in
 * src/core/upgrade.ts) the rev of its minimal form, a default-valued field omitted (`evidenceExcludes: []`), as a
 * generator hashing raw input wrote it before 1.0.0-dev.7 (run 5). Every comparison of a recorded rev with a lane goes here.
 */
export function laneRevMatches(recorded: LaneRev, lane: LaneDef | ArcLaneDef): boolean {
  if (recorded === laneRevOf(lane)) return true;
  const { evidenceExcludes, ...minimal } = normalisedLane(lane);
  if (evidenceExcludes.length > 0) return false;
  return recorded === laneRev(sha256Hex(canonicalJson(minimal)).slice(0, 16)) && minimalLaneRev(lane.id);
}

/** An obligation is exempt while waived, deferred or retired (only a disposition ruling exempts one). */
export const isExempt = (o: ObligationDef): boolean => o.state.type === 'waived' || o.state.type === 'deferred' || o.state.type === 'retired';

/** Vision coverage (A1's `visionCoverage`; `status.vision.coverage`, every lens and checkpoint prompt). */
export type VisionCoverage = Readonly<{
  /** Active clauses the arc advances (`holistic.advances`) that no active obligation serves: a real gap. */
  unservedAdvanced: readonly VisionClauseId[];
  /** Active clauses outside `holistic.advances`: the horizon beyond this arc, expected and never a gap. */
  horizon: readonly VisionClauseId[];
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
export type DocRelation = (typeof DOC_RELATIONS)[number];
/** A rule ref's relations (K19): a ruling never deviates from the corpus; a departure is a divergence plus an amendment. */
export const RULE_RELATIONS = ['consistent', 'refines'] as const;
export type RuleRelation = (typeof RULE_RELATIONS)[number];
export type RulingDocRef = DocRef & Readonly<{ relation: DocRelation }>;
/** M4a: a ruling's reference to a pinned corpus rule, resolved in the pin (C1). */
export type RulingRuleRef = Readonly<{ rule: RuleId; textSha256: Sha256Hex; relation: RuleRelation }>;
/** One entry of a sidecar's `docRefs` (on disk told apart by `rule`); read only through `rulingRefSource`. */
export type RulingRef = RulingDocRef | RulingRuleRef;
export type RulingRefSource =
  | Readonly<{ kind: 'doc'; path: RepoPath; anchor: string; quotedText: string; relation: DocRelation }>
  | Readonly<{ kind: 'rule'; rule: RuleId; textSha256: Sha256Hex; relation: RuleRelation }>;
/** The only reader of a sidecar ref's arm (H10). */
export function rulingRefSource(d: RulingRef): RulingRefSource {
  return 'rule' in d
    ? { kind: 'rule', rule: d.rule, textSha256: d.textSha256, relation: d.relation }
    : { kind: 'doc', path: d.path, anchor: d.anchor, quotedText: d.quotedText, relation: d.relation };
}
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
    /** M4a: the corpus pin in force (a corpus arc); absent: none (lasting). */
    corpusSha256?: Sha256Hex;
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
  docRefs: readonly RulingRef[];
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
  judgedRevs: f.get('judgedRevs', object((g) => {
    const corpusSha256 = g.optional('corpusSha256', sha256R);
    return {
      head: g.get('head', shaR),
      ledgerSha256: g.get('ledgerSha256', sha256R),
      obligationsSha256: g.get('obligationsSha256', nullable(sha256R)),
      visionSha256: g.get('visionSha256', nullable(sha256R)),
      contracts: g.get('contracts', contractRevs),
      ...(corpusSha256 === undefined ? {} : { corpusSha256 }),
    };
  })),
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

/** A doc ref `{path, anchor, quotedText, relation}`, or (M4a) a rule ref `{rule, textSha256, relation: consistent | refines}` (K19). */
const rulingRef: Read<RulingRef> = (value, path) => typeof value === 'object' && value !== null && Object.hasOwn(value, 'rule')
  ? object((g): RulingRef => ({ rule: g.get('rule', ruleR), textSha256: g.get('textSha256', sha256R), relation: g.get('relation', oneOf(RULE_RELATIONS)) }))(value, path)
  : object((g): RulingRef => ({ ...docRefFields(g), relation: g.get('relation', oneOf(DOC_RELATIONS)) }))(value, path);

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
    docRefs: f.get('docRefs', arrayOf(rulingRef, { nonEmpty: true })),
    contractRefs: f.get('contractRefs', sortedBy(pathR, (c) => c)),
    contractOps: f.get('contractOps', arrayOf(contractOp)),
    obligations: f.get('obligations', idList(oid, { legacyStringOrder: true })),
    obligationDispositions: f.get('obligationDispositions', idsAscending(object((g) => ({ id: g.get('id', oid), disposition: g.get('disposition', oneOf(OBLIGATION_DISPOSITIONS)) })), (d) => d.id, { legacyStringOrder: true })),
    cites: f.get('cites', idList(vid, { legacyStringOrder: true })),
    evidence: f.get('evidence', arrayOf(str)),
    appliesTo: f.get('appliesTo', tagged<'arc' | 'units', RulingSidecar['appliesTo']>('type', {
      arc: object((g) => ({ type: g.get('type', literal('arc')) })),
      units: object((g) => ({ type: g.get('type', literal('units')), units: g.get('units', sortedBy((v, p) => unitId(v, p), (u) => u, { nonEmpty: true })) })),
    })),
    lifetime: f.get('lifetime', oneOf(RULING_LIFETIMES)),
    status: f.get('status', oneOf(RULING_STATUSES)),
    consistency: f.get('consistency', consistency),
  };
  if (out.docRefs.some((d) => rulingRefSource(d).relation === 'deviates') && out.contractOps.length === 0) throw new SchemaError(`${f.path}.contractOps`, 'the contract ops of a deviating ruling', out.contractOps);
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
/** Who opened it: a lens, code over a witness (a must-hold not held on an audit snapshot), plan-check (R17), or issue intake (M4a). */
/** M4a: `issue` (a checkpoint's issue intake opens a P2 or P3 finding, C3). */
export const FINDING_LENSES = [...LENS_KINDS, 'witness', 'plan-check', 'issue'] as const;
export type FindingLens = (typeof FINDING_LENSES)[number];
/** `fixed-on-branch` (R5): the owner's gate approved. `resolved` and `ruled` are terminal. */
export const FINDING_STATES = ['open', 'owned', 'fixed-on-branch', 'resolved', 'ruled'] as const;
export type FindingStateName = (typeof FINDING_STATES)[number];
/** A cited evidence item: a path (repo or evidence dir) and its blob when it names one; a changed blob lifts a dismissal. */
export type FindingEvidence = Readonly<{ path: string; blob: Sha | null }>;
/**
 * `stage`: a plan-check's vision conflict (R17), or (M4a rev 3, E) the in-session assessment's at the unit's build attempt;
 * both open P3 `plan-check`-lens findings.
 */
export type FindingSource = Readonly<{ type: 'job'; job: JobId }> | Readonly<{ type: 'stage'; unit: UnitId; stage: 'plan-check' | 'build'; attempt: number }>;
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
  stage: object((f): FindingSource => ({
    type: f.get('type', literal('stage')), unit: f.get('unit', (v, p) => unitId(v, p)), stage: f.get('stage', oneOf(['plan-check', 'build'] as const)),
    attempt: f.get('attempt', positive),
  })),
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
  /**
   * A revision from a rule, a bundle, `reverse`, or an architect spec, obligation or vision edit: `L ∩ {drift, vision}`.
   * `specsOnly` (M4a rev 3, H2, R61): a bundle revision changing only these units and their specs, which runs the vision
   * lens alone over the spec deltas (non-empty, ascending); absent: a full drift (lasting).
   */
  | Readonly<{ type: 'drift'; planRev: number; specsOnly?: readonly UnitId[] }>
  | Readonly<{ type: 'wall-clock' }>
  | Readonly<{ type: 'requested'; command: string }>
  /** H9: at the final head, every lens in L with an outstanding range. */
  | Readonly<{ type: 'final' }>;

export const auditTrigger: Read<AuditTrigger> = tagged('type', {
  cadence: object((f): AuditTrigger => ({ type: f.get('type', literal('cadence')) })),
  unwitnessed: object((f): AuditTrigger => ({ type: f.get('type', literal('unwitnessed')), obligation: f.get('obligation', oid) })),
  drift: object((f): AuditTrigger => {
    const specsOnly = f.optional('specsOnly', sortedBy((v, p) => unitId(v, p), (u) => u, { nonEmpty: true }));
    return { type: f.get('type', literal('drift')), planRev: f.get('planRev', positive), ...(specsOnly === undefined ? {} : { specsOnly }) };
  }),
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

/**
 * A bundle's outcome other than an applied revision (which is its `plan-applied{source: bundle}`). `busy` (M4a rev 3, C5,
 * R50): the bundle touched a unit with an open stage attempt (`units`, ascending by unit); it is decided again only once
 * each attempt has closed, and never counts toward `secondInvalid`.
 */
export const BUNDLE_REJECTIONS = ['stale', 'evidence', 'invalid', 'busy'] as const;
export type BundleRejection = (typeof BUNDLE_REJECTIONS)[number];
/** An open stage attempt a `busy` rejection names. */
export type BusyAttempt = Readonly<{ unit: UnitId; stage: Stage; attempt: number }>;
export type BundleOutcome =
  /** `conversions` (M4a rev 3, OR-A1): every op converted (none left to apply); absent: none (lasting). */
  | Readonly<{ kind: 'no-op'; conversions?: readonly Conversion[] }>
  /** `units` exactly on a `busy` rejection (non-empty). */
  | Readonly<{ kind: 'rejected'; reason: BundleRejection; detail: string; units?: readonly BusyAttempt[] }>
  /** Held for the architect: a `bundle-request` (A9, draining, a brake) or an `owner-request` (A16). */
  | Readonly<{ kind: 'requested'; needsUser: string }>;

// ---------------------------------------------------------------------------------------------------
// Checkpoint admit classes (M4a rev 3, OR-A1, LR-k; src/holistic/admits.ts classifies, N2)

/** Opportunities an arc may admit (OR-A1); unmeasured. */
export const OPPORTUNITY_BUDGET = 1;
/** Follow-up repairs one opportunity may carry (LR-k, R48). */
export const OPPORTUNITY_FOLLOW_UPS = 1;
/**
 * The class code gives a checkpoint `admit` (R45's decision table, corpus arcs only, LR-h). `repair`: it restores an
 * in-slice obligation or behaviour that does not hold (`refs`: its spec's repairs, non-empty), the follow-up of
 * opportunity `followUp` when its attribution lies wholly in that opportunity's lineage. `oversight`: a gap within the
 * owner-selected slice. `opportunity`: it advances clauses outside the slice (`clauses`, joining `holistic.advances`).
 * `unrelated` is never a class: such an admit converts.
 */
export type AdmitClass =
  | Readonly<{ type: 'repair'; refs: readonly RepairRef[]; followUp: OpportunityId | null }>
  | Readonly<{ type: 'oversight'; clauses: readonly VisionClauseId[] }>
  | Readonly<{ type: 'opportunity'; id: OpportunityId; clauses: readonly VisionClauseId[] }>;
/** An admit of a bundle as its decision record keeps it: the op's index in the checkpoint answer, its unit, its class. */
export type ClassifiedAdmit = Readonly<{ index: number; unit: UnitId; class: AdmitClass }>;
export const CONVERSION_REASONS = ['unrelated', 'over-budget', 'follow-up-overrun'] as const;
export type ConversionReason = (typeof CONVERSION_REASONS)[number];
/**
 * An admit code dropped from a bundle (R35): it becomes a corpus amendment (and, for `follow-up-overrun`, a debt item
 * naming `opportunity`). `opportunity` is non-null exactly for `follow-up-overrun`.
 */
export type Conversion = Readonly<{ index: number; unit: UnitId; reason: ConversionReason; opportunity: OpportunityId | null }>;

const repairRefsR: Read<readonly RepairRef[]> = (value, path) => {
  const out = arrayOf(repairRef, { nonEmpty: true })(value, path);
  assertUnique(out, (r) => r, path);
  return out;
};
export const admitClass: Read<AdmitClass> = tagged('type', {
  repair: object((f): AdmitClass => ({ type: f.get('type', literal('repair')), refs: f.get('refs', repairRefsR), followUp: f.get('followUp', nullable((v, p) => opportunityId(v, p))) })),
  oversight: object((f): AdmitClass => ({ type: f.get('type', literal('oversight')), clauses: f.get('clauses', idList(vid, { nonEmpty: true })) })),
  opportunity: object((f): AdmitClass => ({
    type: f.get('type', literal('opportunity')), id: f.get('id', (v, p) => opportunityId(v, p)), clauses: f.get('clauses', idList(vid, { nonEmpty: true })),
  })),
});
export const classifiedAdmit: Read<ClassifiedAdmit> = object((f) => ({ index: f.get('index', nat), unit: f.get('unit', (v, p) => unitId(v, p)), class: f.get('class', admitClass) }));
export const conversion: Read<Conversion> = object((f) => {
  const out = {
    index: f.get('index', nat), unit: f.get('unit', (v, p) => unitId(v, p)), reason: f.get('reason', oneOf(CONVERSION_REASONS)),
    opportunity: f.get('opportunity', nullable((v, p) => opportunityId(v, p))),
  };
  if ((out.reason === 'follow-up-overrun') !== (out.opportunity !== null)) {
    throw new SchemaError(`${f.path}.opportunity`, out.reason === 'follow-up-overrun' ? 'the opportunity a follow-up overran' : 'null (only a follow-up overrun names one)', out.opportunity);
  }
  return out;
});
/** A bundle's admits or conversions: ascending by op index, each index once. */
export const byIndex = <T extends Readonly<{ index: number }>>(item: Read<T>): Read<readonly T[]> => sortedBy(item, (x) => String(x.index).padStart(6, '0'), { nonEmpty: true, order: 'by op index' });

// ---------------------------------------------------------------------------------------------------
// A witness-check lane file (`<evidenceDir>/witness/<lane>.json`, M4a rev 3 D1, R56): what `roadmap witness-check` runs

export const WITNESS_LANE_FILE_DIR = 'witness';
/**
 * Published write-once before a build call, one per fast required lane: the lane's argv, cwd (relative to the worktree),
 * env, reporter, and the test ids the unit must make pass (ascending). Same bytes on a retry (the spec rev and the
 * required set fix them); a differing file fails loud.
 */
export type WitnessLaneFile = Readonly<{
  v: SchemaVersion; lane: LaneId; argv: readonly string[]; cwd: RepoPath; env: Readonly<{ set: Readonly<Record<string, string>>; pass: readonly string[] }>;
  reporter: Reporter; required: readonly string[];
}>;
export const witnessLaneFile: Read<WitnessLaneFile> = object((f) => ({
  v: f.get('v', version),
  lane: f.get('lane', (v, p) => laneId(v, p)),
  argv: f.get('argv', arrayOf(text, { nonEmpty: true })),
  cwd: f.get('cwd', pathR),
  env: f.get('env', laneEnv),
  reporter: f.get('reporter', oneOf(REPORTERS)),
  required: f.get('required', sortedBy(str, (t) => t, { nonEmpty: true })),
}));

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
  cites: f.get('cites', idList(vid, { nonEmpty: true, legacyStringOrder: true })),
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

// ---------------------------------------------------------------------------------------------------
// Pack review (M4a, OR-Q16; C3 runs the job, `packReviewKey` is src/holistic/packreview.ts)

export const PACK_REVIEW_INPUTS_SCHEMA = 'roadmap/pack-review-inputs-m4';

/**
 * What a pack review binds (K8), kept as `inputs/<sha>.pack-review.json` before its spawn; recovery consumes only these
 * bytes. Without `job` (R28) its canonical hash is the required-review key.
 */
export type PackReviewInputs = Readonly<{
  schema: typeof PACK_REVIEW_INPUTS_SCHEMA;
  job: JobId;
  planRev: PlanRev;
  planSha256: Sha256Hex;
  /** Every unit's spec in force, ascending by unit. */
  specs: readonly Readonly<{ unit: UnitId; sha256: Sha256Hex }>[];
  obligationsSha256: Sha256Hex;
  corpusPinSha256: Sha256Hex;
  phase0Sha256: Sha256Hex;
  visionSha256: Sha256Hex;
  head: Sha;
  routingRev: RoutingRev;
}>;

const reviewJobR: Read<JobId> = (v, p) => jobIdOfKind('review')(v, p);
export const packReviewInputs: Read<PackReviewInputs> = object((f) => ({
  schema: f.get('schema', literal(PACK_REVIEW_INPUTS_SCHEMA)),
  job: f.get('job', reviewJobR),
  planRev: f.get('planRev', (v, p) => planRev(v, p)),
  planSha256: f.get('planSha256', sha256R),
  specs: f.get('specs', sortedBy(object((g) => ({ unit: g.get('unit', (v, p) => unitId(v, p)), sha256: g.get('sha256', sha256R) })), (s) => s.unit, { nonEmpty: true })),
  obligationsSha256: f.get('obligationsSha256', sha256R),
  corpusPinSha256: f.get('corpusPinSha256', sha256R),
  phase0Sha256: f.get('phase0Sha256', sha256R),
  visionSha256: f.get('visionSha256', sha256R),
  head: f.get('head', shaR),
  routingRev: f.get('routingRev', (v, p) => routingRev(v, p)),
}));

export function parsePackReviewInputs(value: unknown): PackReviewInputs {
  return packReviewInputs(value, 'packReviewInputs');
}

export const PACK_SEVERITIES = ['blocking', 'note'] as const;
export type PackSeverity = (typeof PACK_SEVERITIES)[number];
/** What a pack finding is about. */
export type PackTarget =
  | Readonly<{ type: 'unit'; id: UnitId }>
  | Readonly<{ type: 'obligation'; id: ObligationId }>
  | Readonly<{ type: 'census'; rule: RuleId }>
  | Readonly<{ type: 'rule'; id: RuleId }>
  | Readonly<{ type: 'plan' }>;
/** One pack finding as `pack-review-ended` records it; its identity is `(job, index)` everywhere (K13). */
export type PackFinding = Readonly<{
  index: number; severity: PackSeverity; target: PackTarget; claim: string; evidence: readonly Readonly<{ path: string; line: number }>[];
}>;

export const packTarget: Read<PackTarget> = tagged('type', {
  unit: object((f): PackTarget => ({ type: f.get('type', literal('unit')), id: f.get('id', (v, p) => unitId(v, p)) })),
  obligation: object((f): PackTarget => ({ type: f.get('type', literal('obligation')), id: f.get('id', oid) })),
  census: object((f): PackTarget => ({ type: f.get('type', literal('census')), rule: f.get('rule', ruleR) })),
  rule: object((f): PackTarget => ({ type: f.get('type', literal('rule')), id: f.get('id', ruleR) })),
  plan: object((f): PackTarget => ({ type: f.get('type', literal('plan')) })),
});
export const packEvidence: Read<PackFinding['evidence'][number]> = object((f) => ({ path: f.get('path', str), line: f.get('line', positive) }));
export const packFinding: Read<PackFinding> = object((f) => ({
  index: f.get('index', nat),
  severity: f.get('severity', oneOf(PACK_SEVERITIES)),
  target: f.get('target', packTarget),
  claim: f.get('claim', str),
  evidence: f.get('evidence', arrayOf(packEvidence)),
}));
