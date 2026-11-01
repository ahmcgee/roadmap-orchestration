import { nonBlank } from '../core/validate.ts';
import { type SystemName,systemName } from '../core/ids.ts';
// Strict role-result schemas and validators. Verifier pre-build and diagnosis modes annotate;
// gate mode approves, requests a fix or escalates. Builders report grounding and experiments;
// campaign audits report findings and root requests. Cross-field checks supplement JSON Schema.
import { type ClauseId,type FailureModeId,type FindingId,type JourneyId,type LaneId,type ObligationId,type ReviewFindingId,type UnitId,type VisionClauseId,answerIds,clauseId,findingId,journeyId,laneId,obligationId,reviewFindingId,unitId,visionClauseId } from '../core/ids.ts';
import { type JsonValue } from '../core/json.ts';
import { type NoteDef,SPEC_SCHEMA,specM1 } from '../core/records.ts';
import { type ReviewDispute,reviewDispute } from '../core/review.ts';
import { Fields,type Read,SchemaError,arrayOf,assertUnique,envName,int,literal,nullable,object,oneOf,str,tagged,text } from '../core/validate.ts';
import { type RepoPath,type RepoPattern,matchesPattern,repoPath,repoPattern } from '../core/values.ts';
import { type FindingSeverity,FINDING_SEVERITIES as LENS_SEVERITIES,PACK_DISPOSITIONS,PACK_SEVERITIES,type PackDisposition,type PackSeverity,type PackTarget,packDisposition,packTarget } from '../holistic/types.ts';

import { type OrderingWait,orderingWait } from '../core/ordering.ts';

import { type ClauseLanes,type DesignChange,type DesignExperiment,type FailureModeProof,type NewSystem,type UnitKind,type Verification } from '../core/design.ts';
import type { MutantEdit } from '../git/mutant.ts';
import { type Role } from '../routing/types.ts';
import { specBytes } from '../spec/spec.ts';

// ---------------------------------------------------------------------------------------------------
// JSON Schema builders (strict subset: object, array, string, integer, boolean, enum, anyOf, null)

type Schema = JsonValue;
const S_IDS: Schema = {type: 'array', items: {type: 'string'}};
const S_STR: Schema = { type: 'string' };
const S_INT: Schema = { type: 'integer' };
const S_BOOL: Schema = { type: 'boolean' };
const sEnum = (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] });
const sArr = (items: Schema): Schema => ({ type: 'array', items });
const sNullable = (s: Schema): Schema => ({ anyOf: [s, { type: 'null' }] });
function sObj(properties: { readonly [key: string]: Schema }): Schema {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

// ---------------------------------------------------------------------------------------------------
// Premises: the judgments' round handoff (arc-1 feedback items 25 and 29)

/**
 * A claim about the repository a judgment's decision relies on, with the file:line evidence it read. The
 * next round of the same unit re-verifies only the premises whose files changed since (the executor
 * compares blobs); it trusts the rest unless it has evidence against one. Method, not invariant (W4, 2026-10-16): the key is
 * present (strict schema) but the list may be empty, and nothing caps it; an empty list re-checks nothing next round.
 */
export type Premise = Readonly<{ claim: string; evidence: readonly Readonly<{ path: string; line: number }>[] }>;

const S_PREMISES = sArr(sObj({ claim: S_STR, evidence: sArr(sObj({ path: S_STR, line: S_INT })) }));
const premise: Read<Premise> = object((f) => ({
  claim: f.get('claim', str),
  evidence: f.get('evidence', arrayOf(object((g) => ({ path: g.get('path', str), line: g.get('line', int(1, Number.MAX_SAFE_INTEGER)) })))),
}));

// ---------------------------------------------------------------------------------------------------
const LANE_ITEM_FIELDS = {
  id: S_STR,
  argv: sArr(S_STR),
  cwd: S_STR,
  env: sObj({ set: sArr(sObj({ name: S_STR, value: S_STR })), pass: sArr(S_STR) }),
  expectedExit: S_INT,
  cadence: sEnum(['build', 'unit']),
  resources: sArr(S_STR),
  evidenceGlobs: sArr(S_STR),
  evidenceExcludes: sArr(S_STR),
} as const;
const ACCEPTANCE_ITEM_FIELDS = { id: S_STR, clause: S_STR, failLoudIfUndelivered: S_BOOL } as const;
const NOTE_ITEM_FIELDS = { id: S_STR, text: S_STR } as const;
const sStated = (fields: { readonly [key: string]: Schema }): Schema => sObj({ ...fields, state: sEnum(['active', 'struck', 'deferred']) });
function laneFromWire(value: unknown, path: string): unknown {
  const item = new Fields(value, path);
  const env = new Fields(item.get('env', (v) => v), `${path}.env`);
  const pairs = env.get('set', arrayOf(object((g) => ({ name: g.get('name', envName), value: g.get('value', text) }))));
  assertUnique(pairs, (p) => p.name, `${path}.env.set`);
  const v = value as { readonly env: object };
  return { ...v, env: { ...v.env, set: Object.fromEntries(pairs.map((p) => [p.name, p.value])) } };
}
const S_FULL_SPEC = sObj({
  schema: sEnum([SPEC_SCHEMA]),
  unit: S_STR,
  rev: S_INT,
  lanes: sArr(sStated(LANE_ITEM_FIELDS)),
  acceptance: sArr(sStated(ACCEPTANCE_ITEM_FIELDS)),
  intent: S_STR,
  nonGoals: S_IDS,
  resources: S_IDS,
  decisions: sArr(sStated(NOTE_ITEM_FIELDS)),
  facts: sArr(sStated(NOTE_ITEM_FIELDS)),
  cites: sObj({ contracts: S_IDS, rulings: S_IDS }),
  obligations: S_IDS,
  repairs: S_IDS,
});
const fullSpec: Read<string> = (value, path) => {
  const f = new Fields(value, path);
  const lanes = f.get('lanes', arrayOf((v) => v));
  const v = value as Record<string, unknown>;
  const { obligations, repairs, ...rest } = v;
  const listed = (key: string, list: unknown): Record<string, unknown> => (Array.isArray(list) && list.length === 0 ? {} : { [key]: list });
  const spec = specM1({
    ...rest, lanes: lanes.map((l, i) => laneFromWire(l, `${path}.lanes[${i}]`)), ...listed('obligations', obligations), ...listed('repairs', repairs),
  }, path);
  return specBytes(spec).toString('utf8');
};

// Design records supplied by the root and pinned by code.
export type DesignAnswer = Readonly<{
  kind: UnitKind;
  changes: readonly DesignChange[];
  interfaces: readonly Readonly<{ type: 'contract' | 'file'; path: RepoPath }>[];
  failureModes: readonly Readonly<{ id: FailureModeId; mode: string; proof: FailureModeProof; requirements: readonly ObligationId[] }>[];
  clauses: readonly ClauseLanes[];
  breaks: Readonly<{ tests: readonly RepoPath[]; docs: readonly RepoPath[] }>;
  experiments: readonly DesignExperiment[];
  newSystem: NewSystem | null;
  verification: Verification | null;
}>;
// ---------------------------------------------------------------------------------------------------
// build

/** M4a rev 3 (I3, F25): a development check the implementer ran, named, with its argv and exit. */
export type Experiment = Readonly<{ name: string; argv: readonly string[]; exit: number }>;
export type Grounding = Readonly<{ specWrong: string | null; touches: readonly string[] }>;
export type TooBig = Readonly<{ estimate: string; suggestedChildren: readonly string[] }>;
export type BuildOutput = Readonly<{
  summary: string; blockers: readonly string[]; experiments: readonly Experiment[];
  grounding: Grounding; tooBig: TooBig | null; notes: readonly string[]; final: true;
}>;
const S_FINAL: Schema = { type: 'boolean', description: 'true for the final report; false only while waiting for something you started.' };
export const BUILD_SCHEMA: Schema = sObj({
  summary: S_STR, blockers: sArr(S_STR), experiments: sArr(sObj({ name: S_STR, argv: sArr(S_STR), exit: S_INT })),
  grounding: sObj({ specWrong: sNullable(S_STR), touches: sArr(S_STR) }),
  tooBig: sNullable(sObj({ estimate: S_STR, suggestedChildren: sArr(S_STR) })), notes: sArr(S_STR), final: S_FINAL,
});
const decision: Read<NoteDef> = object((f) => ({ id: f.get('id', (v, p): ClauseId => clauseId(v, p)), text: f.get('text', str) }));
const experiment: Read<Experiment> = object((g) => ({ name: g.get('name', str), argv: g.get('argv', arrayOf(text, { nonEmpty: true })), exit: g.get('exit', int(0, 255)) }));
export const buildOutput: Read<BuildOutput> = object((f) => ({
  summary: f.get('summary', str), blockers: f.get('blockers', arrayOf(str)), experiments: f.get('experiments', arrayOf(experiment)),
  grounding: f.get('grounding', object((g) => ({ specWrong: g.get('specWrong', nullable(text)), touches: g.get('touches', arrayOf(text)) }))),
  tooBig: f.get('tooBig', nullable(object((g) => ({ estimate: g.get('estimate', text), suggestedChildren: g.get('suggestedChildren', arrayOf(text, { nonEmpty: true })) })))),
  notes: f.get('notes', arrayOf(str)), final: f.get('final', literal(true)),
}));
export function validateBuildOutput(value: unknown): BuildOutput { return buildOutput(value, 'build'); }

/**
 * `decisions.json`, written by the implementer at the root of its evidence dir: every decision it took
 * that the spec did not settle. It is the one channel for decisions (the build report carries none), so
 * they survive a lost result. The executor snapshots it with the evidence and appends each entry to
 * the spec's `decisions` section (so the gate grades against it); ids must be fresh in the spec.
 */
export const DECISIONS_FILE = 'decisions.json';
/**
 * dev.17 (proportional review): `disputes`, the open gate findings (R-n) the implementer disputes rather than fixes, each with
 * its reason; the next gate rules on each once, and its ruling is final. Absent: none (the file is the implementer's, written
 * in session, so the absence is no older record).
 */
export type DecisionsFile = Readonly<{ decisions: readonly NoteDef[]; disputes: readonly ReviewDispute[] }>;
export const decisionsFile: Read<DecisionsFile> = object((f) => {
  const out = { decisions: f.get('decisions', arrayOf(decision)), disputes: f.optional('disputes', arrayOf(reviewDispute)) ?? [] };
  assertUnique(out.decisions, (d) => d.id, `${f.path}.decisions`);
  assertUnique(out.disputes, (d) => d.finding, `${f.path}.disputes`);
  return out;
});

export function validateDecisionsFile(value: unknown): DecisionsFile {
  return decisionsFile(value, DECISIONS_FILE);
}

// ---------------------------------------------------------------------------------------------------
// gate

export const GATE_DECISIONS = ['approve', 'revise', 'escalate'] as const;
/**
 * `blocking`: the merge cannot carry it (it has a directive). `note`: recorded, never blocks. `pre-existing` (dev.12 round
 * 2): a real defect the unit did not introduce, present at the base; recorded and handled as a note, never blocks.
 */
export const FINDING_SEVERITIES = ['blocking', 'note', 'pre-existing'] as const;

// dev.17 proportional review (SCHEMAS.md "Role input and output contracts"): types only; the gate schema and `gateOutput` take them when the
// review stages are wired.

/**
 * What a blocking finding must name. `test-inadequate`: a test cited as proof (requirement, acceptance item, failure mode)
 * does not verify it: weakened, vacuous or missing. A blocking finding without one is refused through the repair turn.
 */
export const DEFECT_CATEGORIES = ['incorrect-behaviour', 'contract-violation', 'security', 'requirement-unmet', 'test-inadequate', 'data-loss'] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];
/** dev.17's finding classes: `ride-along` (comments, docs) never causes a revise; drag makes it debt, else it is released. */
export const FINDING_SEVERITIES_DEV17 = [...FINDING_SEVERITIES, 'ride-along'] as const;
export type FindingSeverityDev17 = (typeof FINDING_SEVERITIES_DEV17)[number];


/**
 * dev.17: the gate's ruling on a builder's dispute of an open ledger finding (decisions.json `disputes`): `upheld` (the finding
 * stands) or `overruled` (it falls), with the reason. Once per dispute, final.
 */
export const DISPUTE_RULINGS = ['upheld', 'overruled'] as const;
export type DisputeRuling = Readonly<{ finding: ReviewFindingId; ruling: (typeof DISPUTE_RULINGS)[number]; reason: string }>;
/** dev.17: the changed hunk a finding on an unchanged file rests on (the delta re-gate): a path and a line on the head's side. */
export type HunkRef = Readonly<{ path: string; line: number }>;

/** dev.13: an ad hoc experiment the gate ran in its checkout, cited as a finding's evidence: the command as run and what it printed. */
export type GateExperiment = Readonly<{ command: string; output: string }>;
/**
 * dev.13 (owner ruling 2026-10-20: debt is for substantive issues that drag down future work): what a note's debt slows,
 * `drag` naming the future work and why. A note with none (null) is recorded in the gate record and never banked.
 */
export type GateDebt = Readonly<{ drag: string }>;
export type GateFinding = Readonly<{
  /** dev.17 adds `ride-along` (comments, docs): never a revise; debt when it names its drag, else released. */
  severity: FindingSeverityDev17;
  evidence: readonly string[];
  path: string | null;
  text: string;
  /** A C-nn id, a contract path (with an optional #anchor) or a corpus rule T-n the finding rests on. */
  contractRef: string | null;
  /**
   * dev.13: the experiments the finding cites as evidence, in the order they ran; empty when it rests on reading alone.
   * Required of a live answer; absent on a dev.12 answer, read as none (lasting: a dev.12 gate had no shell).
   */
  experiments: readonly GateExperiment[];
  /**
   * dev.13: whether a note is debt (`{drag}`) or not (null); read only on a note (a pre-existing defect always banks, a
   * blocking finding never). Required of a live answer; absent on a dev.12 answer, read as `unrecorded`
   * (`gateNoteDebtDefault`): banked as the dev.12 executor banked every note, so a re-read never changes what was banked.
   */
  debt: GateDebt | null;
  /**
   * dev.17 (proportional review): what a blocking finding must name (`DEFECT_CATEGORIES`); null on any other class. A dev.17
   * gate's blocking finding without one is refused through the repair turn (src/pipeline/review.ts).
   */
  defect: DefectCategory | null;
  /** dev.17: the ledger finding (R-n) this one raises again; a settled one only when its anchor blob changed. Null: a new finding. */
  reraises: ReviewFindingId | null;
  /** dev.17: on a delta re-gate, the changed hunk a blocking finding on an unchanged file rests on; null otherwise. */
  hunk: HunkRef | null;
}>;
/**
 * How deeply a cluster of a large diff was reviewed (1.0.0-dev.12, the large-diff gate): `description` (a subagent's
 * description of the cluster sufficed: a purely mechanical cluster its substitutions fully explain, with no deviation),
 * `routine` or `close` review of the cluster's raw hunks. Review depths, never models: records name roles.
 */
export const CLUSTER_REVIEWS = ['description', 'routine', 'close'] as const;
export type ClusterReview = (typeof CLUSTER_REVIEWS)[number];
/** One cluster of a large diff's cluster map: its id, the paths it covers (exact paths, directories or globs) and its review depth. */
export type GateCluster = Readonly<{ id: string; paths: readonly RepoPattern[]; review: ClusterReview }>;
type GateCommon = Readonly<{
  standing: readonly Readonly<{id: string; disposition: 'addressed' | 'rebutted'; evidence: readonly string[]}>[];
  findings: readonly GateFinding[]; reasons: readonly string[]; premises: readonly Premise[];
  /**
   * What the gate did not review, by repository path or path pattern; null on a dev.11 answer (`gateUnreviewedDefault`):
   * unknown. Above the large-diff threshold a file in a cluster counts as reviewed at the cluster's depth, and `unreviewed`
   * names only the gaps the gate admits beyond that.
   */

  /**
   * 1.0.0-dev.12: the cluster map, above the large-diff threshold only (null below it, and on a dev.11 answer:
   * `gateClustersDefault`). Code holds it to the diff: every changed path in exactly one cluster (src/pipeline/gate.ts
   * `gateAnswerFor`, `clusterCoverage`).
   */
  clusters: readonly GateCluster[] | null;
  /** dev.17: one ruling per dispute the gate was given, exactly; empty when it was given none. Absent on a dev.16 answer: none. */
  rulings: readonly DisputeRuling[];
}>;
export type GateOutput =
  | (GateCommon & Readonly<{ decision: 'approve'; directives: readonly [] }>)
  | (GateCommon & Readonly<{ decision: 'escalate'; directives: readonly []; ordering?: OrderingWait | null }>)
  | (GateCommon & Readonly<{ decision: 'revise'; directives: readonly string[] }>);

const GATE_FINDING_FIELDS = {
  evidence: sArr(S_STR), severity: sEnum(FINDING_SEVERITIES_DEV17), path: sNullable(S_STR), text: S_STR, contractRef: sNullable(S_STR), experiments: sArr(sObj({ command: S_STR, output: S_STR })),
  debt: sNullable(sObj({ drag: S_STR })), defect: sNullable(sEnum(DEFECT_CATEGORIES)), reraises: sNullable({type: 'string', pattern: '^R-[1-9][0-9]*$'}), hunk: sNullable(sObj({ path: S_STR, line: S_INT })),
} as const;
const GATE_FIELDS = {
  standing: sArr(sObj({id: S_STR, disposition: sEnum(['addressed', 'rebutted']), evidence: sArr(S_STR)})),
  decision: sEnum(GATE_DECISIONS),
  ordering: { anyOf: [sObj({ blockers: sArr(S_STR) }), { type: 'null' }], description: 'Only escalate solely because other units must merge first: name those unit IDs in blockers. Otherwise null. Code wakes the parked gate after all blockers merge.' },
  findings: sArr(sObj(GATE_FINDING_FIELDS)),
  directives: sArr(S_STR),
  reasons: sArr(S_STR),
  premises: S_PREMISES,

  clusters: sNullable(sArr(sObj({ id: S_STR, paths: sArr(S_STR), review: sEnum(CLUSTER_REVIEWS) }))),
  rulings: sArr(sObj({ finding: {type: 'string', pattern: '^R-[1-9][0-9]*$'}, ruling: sEnum(DISPUTE_RULINGS), reason: S_STR })),
} as const;
// The discriminator constrains directives and ordering in the model's schema as well as the reader.
export const GATE_SCHEMA: Schema = {
  ...sObj(GATE_FIELDS) as object,
  anyOf: GATE_DECISIONS.map((decision) => sObj({
    ...GATE_FIELDS,
    decision: sEnum([decision]),
    directives: {type: 'array', items: S_STR, ...(decision === 'revise' ? {minItems: 1} : {maxItems: 0})},
    ordering: decision === 'escalate' ? GATE_FIELDS.ordering : {type: 'null'},
    findings: decision === 'approve' ? sArr(sObj({
      ...GATE_FINDING_FIELDS,
      severity: sEnum(FINDING_SEVERITIES_DEV17.filter((s) => s !== 'blocking')),
    })) : GATE_FIELDS.findings,
  })),
};

const gateExperiment: Read<GateExperiment> = object((f) => ({ command: f.get('command', str), output: f.get('output', str) }));
const hunkRef: Read<HunkRef> = object((g) => ({ path: g.get('path', str), line: g.get('line', int(1, Number.MAX_SAFE_INTEGER)) }));
const finding: Read<GateFinding> = object((f) => {
 const out: GateFinding = {
  evidence: f.get('evidence', arrayOf(text)),
  severity: f.get('severity', oneOf(FINDING_SEVERITIES_DEV17)),
  path: f.get('path', nullable(str)),
  text: f.get('text', str),
  contractRef: f.get('contractRef', nullable(str)),
  experiments: f.get('experiments', arrayOf(gateExperiment)),
  debt: f.get('debt', nullable(object((g): GateDebt => ({ drag: g.get('drag', str) })))),
  defect: f.get('defect', nullable(oneOf(DEFECT_CATEGORIES))),
  reraises: f.get('reraises', nullable((v, p): ReviewFindingId => reviewFindingId(v, p))),
  hunk: f.get('hunk', nullable(hunkRef)),
 };
 if (out.experiments.length === 0 && !out.evidence.some((e) => /:\d+/.test(e))) throw new SchemaError(`${f.path}.evidence`, 'an experiment or path:line evidence', out.evidence);
 return out;
});
const disputeRuling: Read<DisputeRuling> = object((f) => ({
  finding: f.get('finding', (v, p): ReviewFindingId => reviewFindingId(v, p)), ruling: f.get('ruling', oneOf(DISPUTE_RULINGS)), reason: f.get('reason', str),
}));
const rulingList: Read<readonly DisputeRuling[]> = (value, path) => {
  const rulings = arrayOf(disputeRuling)(value, path);
  assertUnique(rulings, (r) => r.finding, path);
  return rulings;
};

const clusterEntry: Read<GateCluster> = object((f) => ({
  id: f.get('id', str), paths: f.get('paths', arrayOf((v, p) => repoPattern(v, p), { nonEmpty: true })), review: f.get('review', oneOf(CLUSTER_REVIEWS)),
}));
const clusterMap: Read<readonly GateCluster[]> = (value, path) => {
  const clusters = arrayOf(clusterEntry, { nonEmpty: true })(value, path);
  assertUnique(clusters, (c) => c.id, path);
  return clusters;
};
const emptyList: Read<readonly []> = (value, path) => {
  if (!Array.isArray(value) || value.length !== 0) throw new SchemaError(path, 'an empty array (directives only with revise)', value);
  return [];
};

export const gateOutput: Read<GateOutput> = object((f): GateOutput => {
  const decision = f.get('decision', oneOf(GATE_DECISIONS));
  const ordering = answerOrdering(f, decision === 'escalate');
  const common = {
    standing: f.get('standing', arrayOf(object((g) => ({id: g.get('id', text), disposition: g.get('disposition', oneOf(['addressed', 'rebutted'] as const)), evidence: g.get('evidence', arrayOf(text, {nonEmpty: true}))})))),
    findings: f.get('findings', arrayOf(finding)), reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })), premises: f.get('premises', arrayOf(premise)),

    clusters: f.get('clusters', nullable(clusterMap)),
    rulings: f.get('rulings', rulingList),
  };
  if (decision === 'revise') return { ...common, decision, directives: f.get('directives', arrayOf(str, { nonEmpty: true })) };
  if (decision === 'approve') {
    const i = common.findings.findIndex((x) => x.severity === 'blocking');
    if (i >= 0) throw new SchemaError(`${f.path}.findings[${i}].severity`, 'no blocking finding on an approve', 'blocking');
  }
  return { ...common, decision, directives: f.get('directives', emptyList), ...(decision !== 'escalate' || ordering === undefined ? {} : { ordering }) };
});

export function validateGateOutput(value: unknown): GateOutput {
  return gateOutput(value, 'gate');
}

/** How a cluster map covers a diff's paths: the paths no cluster matches, and those more than one does (with their ids). */
export type ClusterCoverage = Readonly<{ uncovered: readonly RepoPath[]; duplicated: readonly Readonly<{ path: RepoPath; clusters: readonly string[] }>[] }>;

/** Matches each of `paths` against the clusters' patterns (`matchesPattern`: an exact path, a directory or a glob). */
export function clusterCoverage(clusters: readonly GateCluster[], paths: readonly RepoPath[]): ClusterCoverage {
  const uncovered: RepoPath[] = [];
  const duplicated: { path: RepoPath; clusters: readonly string[] }[] = [];
  for (const path of paths) {
    const hits = clusters.filter((c) => c.paths.some((p) => matchesPattern(path, p))).map((c) => c.id);
    if (hits.length === 0) uncovered.push(path);
    else if (hits.length > 1) duplicated.push({ path, clusters: hits });
  }
  return { uncovered, duplicated };
}

// ---------------------------------------------------------------------------------------------------
// M3 shared pieces

const S_EVIDENCE_LINES = sArr(sObj({ path: S_STR, line: S_INT }));
const vid: Read<VisionClauseId> = (v, p) => visionClauseId(v, p);
const oid: Read<ObligationId> = (v, p) => obligationId(v, p);
const unitR: Read<UnitId> = (v, p) => unitId(v, p);
const uniqueIds = <T extends string>(read: Read<T>, opts: { readonly nonEmpty?: boolean } = {}): Read<readonly T[]> => (value, path) => {
  const out = arrayOf(read, opts)(value, path);
  assertUnique(out, (x) => x, path);
  return out;
};
const lineEvidence = arrayOf(object((g) => ({ path: g.get('path', str), line: g.get('line', int(1, Number.MAX_SAFE_INTEGER)) })));

// ---------------------------------------------------------------------------------------------------
// lens (M3, §2.5): one lens kind per call; findings only, the checkpoint acts.

/**
 * A vacuity finding's mutant: its exact replacements (`MutantEdit`), from which the executor has git write the patch
 * (`editsPatch`), or, read from a lens call an earlier executor recorded, the hand-written unified diff it asked for then
 * (`kind: patch`, `lensPatchMutantDefault`).
 */
export type LensMutant =
  | Readonly<{ kind: 'edits'; lane: LaneId; edits: readonly MutantEdit[] }>
  | Readonly<{ kind: 'patch'; lane: LaneId; patch: string }>;

/** A lens's finding. `cause` feeds the dedupe key (`findingKey`); a vacuity finding carries its mutant. */
export type LensFinding = Readonly<{
  severity: FindingSeverity;
  obligation: ObligationId | null;
  visionClauses: readonly VisionClauseId[];
  claim: string;
  cause: string;
  evidence: readonly Readonly<{ path: string; line: number }>[];
  mutant: LensMutant | null;
}>;
export type LensOutput = Readonly<{ findings: readonly LensFinding[]; reasons: readonly string[]; premises: readonly Premise[] }>;

export const LENS_SCHEMA: Schema = sObj({
  findings: sArr(sObj({
    severity: sEnum(LENS_SEVERITIES),
    obligation: sNullable(S_STR),
    visionClauses: S_IDS,
    claim: S_STR,
    cause: S_STR,
    evidence: S_EVIDENCE_LINES,
    mutant: sNullable(sObj({ lane: S_STR, edits: sArr(sObj({ path: S_STR, old: S_STR, new: S_STR })) })),
  })),
  reasons: sArr(S_STR),
  premises: S_PREMISES,
});

const lensMutant: Read<LensMutant> = object((h) => {
  const lane = h.get('lane', (v, p): LaneId => laneId(v, p));
  const edits = h.optional('edits', arrayOf(object((e): MutantEdit => ({ path: e.get('path', text), old: e.get('old', text), new: e.get('new', text) })), { nonEmpty: true }));
  if (edits !== undefined) return { kind: 'edits', lane, edits };
  throw new SchemaError(`${h.path}.edits`, 'mutant edits', edits);
});

export const lensOutput: Read<LensOutput> = object((f) => ({
  findings: f.get('findings', arrayOf(object((g) => ({
    severity: g.get('severity', oneOf(LENS_SEVERITIES)),
    obligation: g.get('obligation', nullable(oid)),
    visionClauses: g.get('visionClauses', answerIds(vid)),
    claim: g.get('claim', str),
    cause: g.get('cause', str),
    evidence: g.get('evidence', lineEvidence),
    mutant: g.get('mutant', nullable(lensMutant)),
  })))),
  reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
  premises: f.get('premises', arrayOf(premise)),
}));

export function validateLensOutput(value: unknown): LensOutput {
  return lensOutput(value, 'lens');
}

// ---------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------
// packReview (M4a, OR-Q16): the pack's blocking findings hold admission until acked or superseded; notes go to the brief.

/** One pack finding; its identity is its index in `findings` (K13: `(job, index)` everywhere). */
export type PackReviewFinding = Readonly<{ severity: PackSeverity; target: PackTarget; claim: string; evidence: readonly Readonly<{ path: string; line: number }>[] }>;
/**
 * `dispositions` (M4a rev 3, H3): a delta re-review's disposition of each unresolved earlier finding its inputs list, by
 * origin `(job, index)`; empty on a full review. Which ones it must name is the pack review's check (src/holistic/packreview.ts).
 */
export type PackReviewOutput = Readonly<{ findings: readonly PackReviewFinding[]; dispositions: readonly PackDisposition[]; reasons: readonly string[]; premises: readonly Premise[] }>;

export const PACK_REVIEW_SCHEMA: Schema = sObj({
  findings: sArr(sObj({
    severity: sEnum(PACK_SEVERITIES),
    target: {
      anyOf: [
        sObj({ type: sEnum(['unit']), id: S_STR }),
        sObj({ type: sEnum(['obligation']), id: S_STR }),
        sObj({ type: sEnum(['census']), rule: S_STR }),
        sObj({ type: sEnum(['rule']), id: S_STR }),
        sObj({ type: sEnum(['plan']) }),
      ],
    },
    claim: S_STR,
    evidence: S_EVIDENCE_LINES,
  })),
  dispositions: sArr(sObj({ job: S_STR, index: S_INT, disposition: sEnum(PACK_DISPOSITIONS) })),
  reasons: sArr(S_STR),
  premises: S_PREMISES,
});

export const packReviewOutput: Read<PackReviewOutput> = object((f) => ({
  findings: f.get('findings', arrayOf(object((g) => ({
    severity: g.get('severity', oneOf(PACK_SEVERITIES)), target: g.get('target', packTarget), claim: g.get('claim', str), evidence: g.get('evidence', lineEvidence),
  })))),
  dispositions: f.get('dispositions', arrayOf(packDisposition)),
  reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
  premises: f.get('premises', arrayOf(premise)),
}));

export function validatePackReviewOutput(value: unknown): PackReviewOutput {
  return packReviewOutput(value, 'packReview');
}

// ---------------------------------------------------------------------------------------------------
// walkthrough and polishJudge (dev.13): acting judges with a final report (`final`, as the build's: the runner ends the
// session 30 s after `final: true`, reaping the browser). The readers hold each answer to its shape and the rules inside
// it; what needs the walk's inputs (every journey reported, cited evidence present under the evidence dir, a design or
// contract path inside a milestone reference, vision clauses active, a floor's clause non-negotiable, a polish unit's
// scope covering a reference) is the walk job's
// validation (agent C), with the one repair turn every judgment takes.

export const WALK_JOURNEY_OUTCOMES = ['completed', 'blocked'] as const;
export type WalkJourneyOutcome = (typeof WALK_JOURNEY_OUTCOMES)[number];
/** `breaks` mints a P1 (class 1: the milestone node stays unpassed), `deviates` a P2 (class 2). There is no walkthrough P3. */
export const WALK_FINDING_CLASSES = ['breaks', 'deviates'] as const;
export type WalkFindingClass = (typeof WALK_FINDING_CLASSES)[number];
/**
 * What a walk finding is measured against (owner ruling 2026-10-18: a `breaks` is a defect whose later fix would force
 * rework of what is built on it). The journey itself (it cannot be completed as its user or client would); a contract
 * (`path` inside one of the milestone's references, where the interface is stated; `anchor` the place in it;
 * `dependents` who builds on it: clients, scripts, consumers, later units); a floor (`source` a non-negotiable vision
 * clause or a reference's quality-floor section, which the walk job checks); the milestone's design reference (`path`
 * inside one of its references, `anchor` the place in it); or an active vision clause.
 */
export type WalkAgainst =
  | Readonly<{ type: 'journey' }>
  | Readonly<{ type: 'contract'; path: RepoPath; anchor: string; dependents: string }>
  | Readonly<{ type: 'floor'; text: string; source: RepoPath | VisionClauseId }>
  | Readonly<{ type: 'design'; path: RepoPath; anchor: string }>
  | Readonly<{ type: 'vision'; clause: VisionClauseId }>;
/** `breaks` cites the journey, a contract or a floor; `deviates` the design, the vision or a floor. */
export const WALK_AGAINST: { readonly [C in WalkFindingClass]: readonly WalkAgainst['type'][] } = {
  breaks: ['journey', 'contract', 'floor'],
  deviates: ['design', 'vision'],
};
export type WalkJourneyReport = Readonly<{ journey: JourneyId; outcome: WalkJourneyOutcome; evidence: readonly string[]; note: string }>;
export type WalkFinding = Readonly<{
  class: WalkFindingClass; journey: JourneyId; evidence: readonly string[]; claim: string; cause: string; against: WalkAgainst; paths: readonly RepoPath[];
}>;
/**
 * A polish proposal, authored as a full unit (R3): its id, scope (covering one of the milestone's references) and spec,
 * the strict full-spec wire object (`S_FULL_SPEC`), read into spec.json's canonical text. Code admits it with origin `polish`.
 */
export type WalkPolish = Readonly<{
  journey: JourneyId; evidence: readonly string[]; text: string; unit: Readonly<{ id: UnitId; systems: readonly SystemName[]; spec: string }>;
}>;
export type WalkthroughOutput = Readonly<{
  final: true;
  journeys: readonly WalkJourneyReport[];
  findings: readonly WalkFinding[];
  polish: readonly WalkPolish[];
  premises: readonly Premise[];
  reasons: readonly string[];
}>;

const S_EVIDENCE = sArr(S_STR);
export const WALKTHROUGH_SCHEMA: Schema = sObj({
  final: S_FINAL,
  journeys: sArr(sObj({ journey: S_STR, outcome: sEnum(WALK_JOURNEY_OUTCOMES), evidence: S_EVIDENCE, note: S_STR })),
  findings: sArr(sObj({
    class: sEnum(WALK_FINDING_CLASSES), journey: S_STR, evidence: S_EVIDENCE, claim: S_STR, cause: S_STR,
    against: {
      anyOf: [
        sObj({ type: sEnum(['journey']) }),
        sObj({ type: sEnum(['contract']), path: S_STR, anchor: S_STR, dependents: S_STR }),
        sObj({ type: sEnum(['floor']), text: S_STR, source: S_STR }),
        sObj({ type: sEnum(['design']), path: S_STR, anchor: S_STR }),
        sObj({ type: sEnum(['vision']), clause: S_STR }),
      ],
    },
    paths: S_IDS,
  })),
  polish: sArr(sObj({ journey: S_STR, evidence: S_EVIDENCE, text: S_STR, unit: sObj({ id: S_STR, systems: S_IDS, spec: S_FULL_SPEC }) })),
  premises: S_PREMISES,
  reasons: sArr(S_STR),
});

const journeyR: Read<JourneyId> = (v, p) => journeyId(v, p);
const evidenceList: Read<readonly string[]> = arrayOf(str);
const walkAgainst: Read<WalkAgainst> = tagged('type', {
  journey: object((g): WalkAgainst => ({ type: g.get('type', literal('journey')) })),
  contract: object((g): WalkAgainst => ({
    type: g.get('type', literal('contract')), path: g.get('path', (v, p) => repoPath(v, p)), anchor: g.get('anchor', str), dependents: g.get('dependents', str),
  })),
  floor: object((g): WalkAgainst => ({
    type: g.get('type', literal('floor')), text: g.get('text', str),
    source: g.get('source', (v, p): RepoPath | VisionClauseId => (typeof v === 'string' && /^V-[0-9]+$/.test(v) ? visionClauseId(v, p) : repoPath(v, p))),
  })),
  design: object((g): WalkAgainst => ({ type: g.get('type', literal('design')), path: g.get('path', (v, p) => repoPath(v, p)), anchor: g.get('anchor', str) })),
  vision: object((g): WalkAgainst => ({ type: g.get('type', literal('vision')), clause: g.get('clause', vid) })),
});

export const walkthroughOutput: Read<WalkthroughOutput> = object((f) => {
  const out: WalkthroughOutput = {
    final: f.get('final', literal(true)),
    journeys: f.get('journeys', arrayOf(object((g): WalkJourneyReport => ({
      journey: g.get('journey', journeyR), outcome: g.get('outcome', oneOf(WALK_JOURNEY_OUTCOMES)), evidence: g.get('evidence', evidenceList), note: g.get('note', str),
    })), { nonEmpty: true })),
    findings: f.get('findings', arrayOf(object((g): WalkFinding => ({
      class: g.get('class', oneOf(WALK_FINDING_CLASSES)), journey: g.get('journey', journeyR), evidence: g.get('evidence', arrayOf(str, { nonEmpty: true })),
      claim: g.get('claim', str), cause: g.get('cause', str), against: g.get('against', walkAgainst), paths: g.get('paths', uniqueIds((v, p): RepoPath => repoPath(v, p))),
    })))),
    polish: f.get('polish', arrayOf(object((g): WalkPolish => ({
      journey: g.get('journey', journeyR), evidence: g.get('evidence', arrayOf(str, { nonEmpty: true })), text: g.get('text', str),
      unit: g.get('unit', object((h) => ({ id: h.get('id', unitR), systems: h.get('systems', uniqueIds((v, p) => systemName(v, p), { nonEmpty: true })), spec: h.get('spec', fullSpec) }))),
    })))),
    premises: f.get('premises', arrayOf(premise)),
    reasons: f.get('reasons', arrayOf(str)),
  };
  assertUnique(out.journeys, (j) => j.journey, `${f.path}.journeys`);
  assertUnique(out.polish, (x) => x.unit.id, `${f.path}.polish`);
  const reported = new Set<string>(out.journeys.map((j) => j.journey));
  out.findings.forEach((x, i) => {
    if (!reported.has(x.journey)) throw new SchemaError(`${f.path}.findings[${i}].journey`, 'a journey this report reports', x.journey);
    if (!WALK_AGAINST[x.class].includes(x.against.type)) throw new SchemaError(`${f.path}.findings[${i}].against`, `${WALK_AGAINST[x.class].join(' | ')} for a ${x.class} finding`, x.against);
  });
  out.polish.forEach((x, i) => {
    if (!reported.has(x.journey)) throw new SchemaError(`${f.path}.polish[${i}].journey`, 'a journey this report reports', x.journey);
  });
  out.journeys.forEach((j, i) => {
    if (j.outcome === 'blocked' && !out.findings.some((x) => x.class === 'breaks' && x.journey === j.journey)) {
      throw new SchemaError(`${f.path}.journeys[${i}].outcome`, 'a blocked journey with at least one breaks finding on it', j.outcome);
    }
  });
  return out;
});

export function validateWalkthroughOutput(value: unknown): WalkthroughOutput {
  return walkthroughOutput(value, 'walkthrough');
}

export const POLISH_DECISIONS = ['keep', 'drop'] as const;
export type PolishDecision = (typeof POLISH_DECISIONS)[number];
/** The polish judge's answer: keep or drop the tweak, from walking the journey on both instances; `evidence` its captures. */
export type PolishJudgeOutput = Readonly<{ final: true; decision: PolishDecision; evidence: readonly string[]; reasons: readonly string[]; premises: readonly Premise[] }>;
export const POLISH_JUDGE_SCHEMA: Schema = sObj({ final: S_FINAL, decision: sEnum(POLISH_DECISIONS), evidence: S_EVIDENCE, reasons: sArr(S_STR), premises: S_PREMISES });
export const polishJudgeOutput: Read<PolishJudgeOutput> = object((f) => ({
  final: f.get('final', literal(true)),
  decision: f.get('decision', oneOf(POLISH_DECISIONS)),
  evidence: f.get('evidence', arrayOf(str, { nonEmpty: true })),
  reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
  premises: f.get('premises', arrayOf(premise)),
}));
export function validatePolishJudgeOutput(value: unknown): PolishJudgeOutput {
  return polishJudgeOutput(value, 'polishJudge');
}

// ---------------------------------------------------------------------------------------------------
// One milestone experience verdict, with a mode-specific payload.
export type ExperienceOutput = Readonly<{final: true; mode: 'walkthrough'; verdict: WalkthroughOutput}> | Readonly<{final: true; mode: 'polish'; verdict: PolishJudgeOutput}>;
export const EXPERIENCE_SCHEMA: Schema = {
  ...sObj({final: S_FINAL, mode: sEnum(['walkthrough', 'polish']), verdict: {anyOf: [WALKTHROUGH_SCHEMA, POLISH_JUDGE_SCHEMA]}}) as object,
  anyOf: [
    sObj({final: S_FINAL, mode: sEnum(['walkthrough']), verdict: WALKTHROUGH_SCHEMA}),
    sObj({final: S_FINAL, mode: sEnum(['polish']), verdict: POLISH_JUDGE_SCHEMA}),
  ],
};
export const experienceOutput: Read<ExperienceOutput> = tagged<'walkthrough' | 'polish', ExperienceOutput>('mode', {
  walkthrough: object((f) => ({final: f.get('final', literal(true)), mode: f.get('mode', literal('walkthrough')), verdict: f.get('verdict', walkthroughOutput)})),
  polish: object((f) => ({final: f.get('final', literal(true)), mode: f.get('mode', literal('polish')), verdict: f.get('verdict', polishJudgeOutput)})),
});
export function validateExperienceOutput(v: unknown): ExperienceOutput { return experienceOutput(v, 'experienceVerdict'); }
export function experienceWalk(v: unknown): WalkthroughOutput { const out = validateExperienceOutput(v); if (out.mode !== 'walkthrough') throw new SchemaError('experience.mode', 'walkthrough', out.mode); return out.verdict; }
export function experiencePolish(v: unknown): PolishJudgeOutput { const out = validateExperienceOutput(v); if (out.mode !== 'polish') throw new SchemaError('experience.mode', 'polish', out.mode); return out.verdict; }
export type CampaignAuditOutput = LensOutput & Readonly<{requests: readonly Readonly<{op: 'request'; summary: string; evidence: readonly string[]; dismisses: FindingId | null; counterEvidence: string | null}>[]}>;
export const CAMPAIGN_AUDIT_SCHEMA: Schema = {...LENS_SCHEMA as object, properties: {...(LENS_SCHEMA as {properties: object}).properties, requests: sArr(sObj({op: sEnum(['request']), summary: S_STR, evidence: sArr(S_STR), dismisses: sNullable(S_STR), counterEvidence: sNullable({type: 'string', pattern: '\\S'})}))}, required: [...(LENS_SCHEMA as {required: string[]}).required, 'requests']} as Schema;
export const campaignAuditOutput: Read<CampaignAuditOutput> = (value, path) => {
  const f = new Fields(value, path);
  const requests = f.get('requests', arrayOf(object((g) => {
    const out = {op: g.get('op', literal('request')), summary: g.get('summary', text), evidence: g.get('evidence', arrayOf(text, {nonEmpty: true})), dismisses: g.get('dismisses', nullable((v, p) => findingId(v, p))), counterEvidence: g.get('counterEvidence', nullable(nonBlank))};
    if (out.dismisses !== null && out.counterEvidence === null) throw new SchemaError(`${g.path}.counterEvidence`, 'counter-evidence for a requested finding dismissal', null);
    return out;
  })));
  const {requests: _r, ...rest} = value as Record<string, unknown>;
  return {...lensOutput(rest, path), requests};
};
export function validateCampaignAuditOutput(v: unknown): CampaignAuditOutput { return campaignAuditOutput(v, 'campaignAudit'); }

export type RoleOutputs = {
  readonly experienceVerdict: ExperienceOutput;
  readonly campaignAudit: CampaignAuditOutput;
  readonly build: BuildOutput;
  readonly packReview: PackReviewOutput;
  readonly verifier: GateOutput;
};
export const ROLE_SCHEMAS: { readonly [R in Role]: Schema } = {
  experienceVerdict: EXPERIENCE_SCHEMA, campaignAudit: CAMPAIGN_AUDIT_SCHEMA,
  build: BUILD_SCHEMA, packReview: PACK_REVIEW_SCHEMA, 
  verifier: GATE_SCHEMA,
};
export const ROLE_VALIDATORS: { readonly [R in Role]: (value: unknown) => RoleOutputs[R] } = {
  experienceVerdict: validateExperienceOutput, campaignAudit: validateCampaignAuditOutput,
  build: validateBuildOutput,
  packReview: validatePackReviewOutput,
  verifier: validateGateOutput,
};

function answerOrdering(f: Fields, allowed: boolean): OrderingWait | null | undefined {
  const ordering = f.optional('ordering', nullable(orderingWait));

  if (ordering != null && !allowed) throw new SchemaError(`${f.path}.ordering`, 'null outside an ordering escalation or infeasible decision', ordering);
  return ordering;
}
