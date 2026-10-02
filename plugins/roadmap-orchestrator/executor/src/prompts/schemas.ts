// Structured results of the roles (M3 adds the arc roles `lens` and `checkpoint`), as strict JSON Schemas (every key required, no additional
// properties: what `codex exec --output-schema` demands and `claude -p --json-schema` accepts) plus the
// hand-written validators the adapter runs on the backend's terminal output. The schema is the model's
// contract; the validator is the executor's, and also enforces the cross-field rules a schema cannot
// state (a patch only with redirect, directives only with revise, no blocking finding on an approve).
//
// Derived from the M1 transition table (plan "Pipeline for one serial unit"):
//   planCheck: approve → build · redirect → spec.patch, re-check · infeasible → escalate · escalate → route up
// Both judgments also return their premises (claim + file:line evidence): the next round's handoff.
//   gate:      approve → integration slot · revise → fix round with directives · escalate → route up
//   build:     success → quiesce (the executor then salvages, runs lanes and gates; the report is evidence)
import {
  type ClauseId, type FindingId, type LaneId, type ObligationId, type RulingId, type UnitId, type VisionClauseId, clauseId, findingId, laneId,
  obligationId, rulingId, unitId, visionClauseId,
} from '../core/ids.ts';
import type { JsonValue } from '../core/json.ts';
import { BOUND_FIELDS, type Bounds, type NoteDef, type SpecPatchOp, specPatchOp } from '../core/records.ts';
import {
  Fields, type Read, SchemaError, arrayOf, assertUnique, envName, int, literal, nullable, object, oneOf, positive, str, tagged, text,
} from '../core/validate.ts';
import { type RepoPattern, repoPath, repoPattern } from '../core/values.ts';
import {
  ACTIVATIONS, type Activation, FINDING_DISPOSITIONS, FINDING_SEVERITIES as LENS_SEVERITIES, type FindingDisposition, type FindingSeverity, OBLIGATION_DISPOSITIONS,
  OWNER_ONLY_CLASSES, type DocRef, type ObligationDisposition, type ObservationKey, type OwnerOnlyClass, type WitnessRef, observationKey,
} from '../holistic/types.ts';
import { REENTRY_POINTS, type ReentryPoint } from '../input/plan.ts';
import { planCheckVisionConflict } from '../core/upgrade.ts';
import {
  JUDGMENT_SEATS, MODEL_CLASSES, type ModelClass, RISK_TIERS, ROLES, type RiskTier, type Role, SEATS, type Seat,
} from '../routing/types.ts';

// ---------------------------------------------------------------------------------------------------
// JSON Schema builders (strict subset: object, array, string, integer, boolean, enum, anyOf, null)

type Schema = JsonValue;
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
 * compares blobs); it trusts the rest unless it has evidence against one.
 */
export type Premise = Readonly<{ claim: string; evidence: readonly Readonly<{ path: string; line: number }>[] }>;
/** The premise cap the prompts state: the premises the decision relies on, not everything read. Not enforced. */
export const MAX_PREMISES = 12;

const S_PREMISES = sArr(sObj({ claim: S_STR, evidence: sArr(sObj({ path: S_STR, line: S_INT })) }));
const premise: Read<Premise> = object((f) => ({
  claim: f.get('claim', str),
  evidence: f.get('evidence', arrayOf(object((g) => ({ path: g.get('path', str), line: g.get('line', int(1, Number.MAX_SAFE_INTEGER)) })))),
}));

// ---------------------------------------------------------------------------------------------------
// planCheck

export const PLAN_CHECK_DECISIONS = ['approve', 'redirect', 'infeasible', 'escalate'] as const;

type PlanCheckCommon = Readonly<{
  /** The decision's justification: each reason cites the clause, contract or C-nn it rests on. */
  reasons: readonly string[];
  /** The unit's risk after the check: the dispatch floor or higher. The executor refuses a lower tier. */
  risk: RiskTier;
  /**
   * What the architect reads when the decision escalates or is infeasible; otherwise facts for the build and
   * the gate (defects in existing code, observations the decision does not rest on), or empty.
   */
  notes: string;
  premises: readonly Premise[];
  /**
   * R17: where the spec conflicts with the vision (read-only context), the clauses and a note. Each opens a P3
   * `plan-check` finding for the next checkpoint and is never a redirect by itself. Empty outside a holistic arc.
   */
  visionConflict: readonly VisionConflict[];
}>;
export type VisionConflict = Readonly<{ clauses: readonly VisionClauseId[]; note: string }>;
export type PlanCheckOutput =
  | (PlanCheckCommon & Readonly<{ decision: 'approve' | 'infeasible' | 'escalate'; patch: null }>)
  | (PlanCheckCommon & Readonly<{ decision: 'redirect'; patch: readonly SpecPatchOp[] }>);

// A lane's `env.set` is a map in spec.json, but a strict schema cannot describe open maps, so the model
// writes it as [{name, value}] and the validator converts before handing the op to records.ts.
const S_LANE_ITEM = sObj({
  id: S_STR,
  argv: sArr(S_STR),
  cwd: S_STR,
  env: sObj({ set: sArr(sObj({ name: S_STR, value: S_STR })), pass: sArr(S_STR) }),
  expectedExit: S_INT,
  tier: sEnum(['fast', 'estate']),
  resources: sArr(S_STR),
  evidenceGlobs: sArr(S_STR),
  evidenceExcludes: sArr(S_STR),
});
const S_ACCEPTANCE_ITEM = sObj({ id: S_STR, clause: S_STR, failLoudIfUndelivered: S_BOOL });
const S_NOTE_ITEM = sObj({ id: S_STR, text: S_STR });
const itemOps = (section: string, item: Schema): Schema[] =>
  ['add', 'replace'].map((op) => sObj({ op: sEnum([op]), section: sEnum([section]), item }));
const S_PATCH_OP: Schema = {
  anyOf: [
    ...itemOps('lanes', S_LANE_ITEM),
    ...itemOps('acceptance', S_ACCEPTANCE_ITEM),
    ...itemOps('decisions', S_NOTE_ITEM),
    ...itemOps('facts', S_NOTE_ITEM),
    sObj({ op: sEnum(['strike', 'defer']), id: S_STR }),
    sObj({ op: sEnum(['cite']), contracts: sArr(S_STR), rulings: sArr(S_STR) }),
  ],
};

export const PLAN_CHECK_SCHEMA: Schema = sObj({
  decision: sEnum(PLAN_CHECK_DECISIONS),
  reasons: sArr(S_STR),
  patch: sNullable(sArr(S_PATCH_OP)),
  risk: sEnum(RISK_TIERS),
  notes: S_STR,
  premises: S_PREMISES,
  visionConflict: sArr(sObj({ clauses: sArr(S_STR), note: S_STR })),
});

/** The wire form of one op: a lane item's env.set arrives as [{name, value}]. */
const wireOp: Read<SpecPatchOp> = (value, path) => {
  const f = new Fields(value, path);
  const op = f.get('op', oneOf(['add', 'replace', 'strike', 'defer', 'cite'] as const));
  if (op === 'strike' || op === 'defer' || op === 'cite') return specPatchOp(value, path);
  if (f.get('section', oneOf(['lanes', 'acceptance', 'decisions', 'facts'] as const)) !== 'lanes') return specPatchOp(value, path);
  const item = new Fields(f.get('item', (v) => v), `${path}.item`);
  const env = new Fields(item.get('env', (v) => v), `${path}.item.env`);
  const pairs = env.get('set', arrayOf(object((g) => ({ name: g.get('name', envName), value: g.get('value', text) }))));
  assertUnique(pairs, (p) => p.name, `${path}.item.env.set`);
  const set = Object.fromEntries(pairs.map((p) => [p.name, p.value]));
  const v = value as { readonly item: { readonly env: object } };
  return specPatchOp({ ...v, item: { ...v.item, env: { ...v.item.env, set } } }, path);
};

// Reads at validation time, after the M3 helpers below are initialised.
const visionConflict: Read<VisionConflict> = object((g) => ({ clauses: g.get('clauses', uniqueIds(vid, { nonEmpty: true })), note: g.get('note', str) }));

export const planCheckOutput: Read<PlanCheckOutput> = object((f): PlanCheckOutput => {
  const decision = f.get('decision', oneOf(PLAN_CHECK_DECISIONS));
  const common = {
    reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
    risk: f.get('risk', oneOf(RISK_TIERS)),
    notes: f.get('notes', text),
    premises: f.get('premises', arrayOf(premise)),
    visionConflict: planCheckVisionConflict(f.optional('visionConflict', arrayOf(visionConflict)), f.path),
  };
  if (decision === 'redirect') {
    return { ...common, decision, patch: f.get('patch', arrayOf(wireOp, { nonEmpty: true })) };
  }
  return { ...common, decision, patch: f.get('patch', literal(null)) };
});

export function validatePlanCheckOutput(value: unknown): PlanCheckOutput {
  return planCheckOutput(value, 'planCheck');
}

// ---------------------------------------------------------------------------------------------------
// build

export type LaneRun = Readonly<{ lane: LaneId; exit: number }>;
export type BuildOutput = Readonly<{
  /** Two or three sentences: what changed and why. */
  summary: string;
  /** The implementer's claim; the executor reads the truth from git at salvage. */
  changedPaths: readonly string[];
  /** Every fast lane the implementer ran before finishing, with its exit code. */
  lanesRun: readonly LaneRun[];
  /** What kept the unit from being complete; empty when it is. Decisions go to decisions.json, never here. */
  blockers: readonly string[];
}>;

export const BUILD_SCHEMA: Schema = sObj({
  summary: S_STR,
  changedPaths: sArr(S_STR),
  lanesRun: sArr(sObj({ lane: S_STR, exit: S_INT })),
  blockers: sArr(S_STR),
});

const decision: Read<NoteDef> = object((f) => ({ id: f.get('id', (v, p): ClauseId => clauseId(v, p)), text: f.get('text', str) }));

export const buildOutput: Read<BuildOutput> = object((f) => ({
  summary: f.get('summary', str),
  changedPaths: f.get('changedPaths', arrayOf(str)),
  lanesRun: f.get('lanesRun', arrayOf(object((g) => ({
    lane: g.get('lane', (v, p): LaneId => laneId(v, p)),
    exit: g.get('exit', int(0, 255)),
  })))),
  blockers: f.get('blockers', arrayOf(str)),
}));

export function validateBuildOutput(value: unknown): BuildOutput {
  return buildOutput(value, 'build');
}

/**
 * `decisions.json`, written by the implementer at the root of its evidence dir: every decision it took
 * that the spec did not settle. It is the one channel for decisions (the build report carries none), so
 * they survive a lost result. The executor snapshots it with the evidence and appends each entry to
 * the spec's `decisions` section (so the gate grades against it); ids must be fresh in the spec.
 */
export const DECISIONS_FILE = 'decisions.json';
export type DecisionsFile = Readonly<{ decisions: readonly NoteDef[] }>;
export const decisionsFile: Read<DecisionsFile> = object((f) => {
  const out = { decisions: f.get('decisions', arrayOf(decision)) };
  assertUnique(out.decisions, (d) => d.id, `${f.path}.decisions`);
  return out;
});

export function validateDecisionsFile(value: unknown): DecisionsFile {
  return decisionsFile(value, DECISIONS_FILE);
}

// ---------------------------------------------------------------------------------------------------
// gate

export const GATE_DECISIONS = ['approve', 'revise', 'escalate'] as const;
/** `blocking`: the merge cannot carry it (it has a directive). `note`: recorded, never blocks. */
export const FINDING_SEVERITIES = ['blocking', 'note'] as const;
/**
 * The directive cap the gate prompt states (anti-spiral core: the cap bounds reporting, never reading).
 * The validator does not enforce it: overflow banks in code (the gate stage), it is not malformed.
 */
export const MAX_DIRECTIVES = 5;

export type GateFinding = Readonly<{
  severity: (typeof FINDING_SEVERITIES)[number];
  path: string | null;
  text: string;
  /** A C-nn id or a contract path (with an optional #anchor) the finding rests on. */
  contractRef: string | null;
}>;
type GateCommon = Readonly<{ findings: readonly GateFinding[]; reasons: readonly string[]; premises: readonly Premise[] }>;
export type GateOutput =
  | (GateCommon & Readonly<{ decision: 'approve' | 'escalate'; directives: readonly [] }>)
  | (GateCommon & Readonly<{ decision: 'revise'; directives: readonly string[] }>);

export const GATE_SCHEMA: Schema = sObj({
  decision: sEnum(GATE_DECISIONS),
  findings: sArr(sObj({ severity: sEnum(FINDING_SEVERITIES), path: sNullable(S_STR), text: S_STR, contractRef: sNullable(S_STR) })),
  directives: sArr(S_STR),
  reasons: sArr(S_STR),
  premises: S_PREMISES,
});

const finding: Read<GateFinding> = object((f) => ({
  severity: f.get('severity', oneOf(FINDING_SEVERITIES)),
  path: f.get('path', nullable(str)),
  text: f.get('text', str),
  contractRef: f.get('contractRef', nullable(str)),
}));
const emptyList: Read<readonly []> = (value, path) => {
  if (!Array.isArray(value) || value.length !== 0) throw new SchemaError(path, 'an empty array (directives only with revise)', value);
  return [];
};

export const gateOutput: Read<GateOutput> = object((f): GateOutput => {
  const decision = f.get('decision', oneOf(GATE_DECISIONS));
  const common = {
    findings: f.get('findings', arrayOf(finding)), reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })), premises: f.get('premises', arrayOf(premise)),
  };
  if (decision === 'revise') return { ...common, decision, directives: f.get('directives', arrayOf(str, { nonEmpty: true })) };
  if (decision === 'approve') {
    const i = common.findings.findIndex((x) => x.severity === 'blocking');
    if (i >= 0) throw new SchemaError(`${f.path}.findings[${i}].severity`, 'no blocking finding on an approve', 'blocking');
  }
  return { ...common, decision, directives: f.get('directives', emptyList) };
});

export function validateGateOutput(value: unknown): GateOutput {
  return gateOutput(value, 'gate');
}

// ---------------------------------------------------------------------------------------------------
// M3 shared pieces

const S_IDS = sArr(S_STR);
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

/** A lens's finding. `cause` feeds the dedupe key (`findingKey`); a vacuity finding carries its mutant (a unified diff). */
export type LensFinding = Readonly<{
  severity: FindingSeverity;
  obligation: ObligationId | null;
  visionClauses: readonly VisionClauseId[];
  claim: string;
  cause: string;
  evidence: readonly Readonly<{ path: string; line: number }>[];
  mutant: Readonly<{ patch: string; lane: LaneId }> | null;
}>;
export type LensOutput = Readonly<{ findings: readonly LensFinding[]; reasons: readonly string[]; premises: readonly Premise[] }>;
/** The finding cap the lens prompt states (anti-spiral: it bounds reporting, never reading). Not enforced. */
export const MAX_LENS_FINDINGS = 8;

export const LENS_SCHEMA: Schema = sObj({
  findings: sArr(sObj({
    severity: sEnum(LENS_SEVERITIES),
    obligation: sNullable(S_STR),
    visionClauses: S_IDS,
    claim: S_STR,
    cause: S_STR,
    evidence: S_EVIDENCE_LINES,
    mutant: sNullable(sObj({ patch: S_STR, lane: S_STR })),
  })),
  reasons: sArr(S_STR),
  premises: S_PREMISES,
});

export const lensOutput: Read<LensOutput> = object((f) => ({
  findings: f.get('findings', arrayOf(object((g) => ({
    severity: g.get('severity', oneOf(LENS_SEVERITIES)),
    obligation: g.get('obligation', nullable(oid)),
    visionClauses: g.get('visionClauses', uniqueIds(vid)),
    claim: g.get('claim', str),
    cause: g.get('cause', str),
    evidence: g.get('evidence', lineEvidence),
    mutant: g.get('mutant', nullable(object((h) => ({ patch: h.get('patch', str), lane: h.get('lane', (v, p): LaneId => laneId(v, p)) })))),
  })))),
  reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
  premises: f.get('premises', arrayOf(premise)),
}));

export function validateLensOutput(value: unknown): LensOutput {
  return lensOutput(value, 'lens');
}

// ---------------------------------------------------------------------------------------------------
// checkpoint (M3, §2.8, OR-V): the one actor that amends; every op cites active vision clauses and evidence.

export const CHECKPOINT_DECISIONS = ['no-op', 'bundle'] as const;
export const BUNDLE_OP_KINDS = [
  'admit', 'patch-spec', 'reenter', 'cut', 'route', 'limits', 'obligation-split', 'obligation-dispose', 'invalidate-approval', 'rule', 'request',
] as const;
export type BundleOpKind = (typeof BUNDLE_OP_KINDS)[number];

/** A split child as the checkpoint writes it; its parent's text may be dropped only citing active clauses (a `split-dropped` divergence). */
export type SplitChild = Readonly<{ id: ObligationId; statement: string; docRef: DocRef; witness: WitnessRef; activation: Activation; deliveredBy: readonly UnitId[] }>;

/**
 * One op of a bundle (closed; A16: nothing here touches the vision, resource declarations, `.roadmap/config.json`,
 * `gc` or ref deletion, which are owner-only and reachable only as `request`). `admit.spec` is the new unit's
 * spec.json as text (validated by the spec reader at activation); `rule.ruling` names one of the output's `rulings`.
 */
export type BundleOpBody =
  | Readonly<{ op: 'admit'; unit: Readonly<{ id: UnitId; risk: RiskTier; scope: readonly RepoPattern[]; after: readonly UnitId[]; origin: 'checkpoint' | 'repair' }>; spec: string }>
  | Readonly<{ op: 'patch-spec'; unit: UnitId; patch: readonly SpecPatchOp[] }>
  | Readonly<{ op: 'reenter'; unit: UnitId; reenters: UnitId; enterAt: ReentryPoint | null; reset: RulingId | null }>
  | Readonly<{ op: 'cut'; unit: UnitId; reason: string }>
  | Readonly<{ op: 'route'; unit: UnitId; seats: readonly Readonly<{ role: Role; tier: Seat; class: ModelClass }>[] }>
  | Readonly<{ op: 'limits'; unit: UnitId | null; limits: readonly Readonly<{ field: keyof Bounds | 'convergenceK'; value: number }>[] }>
  | Readonly<{ op: 'obligation-split'; obligation: ObligationId; children: readonly SplitChild[] }>
  | Readonly<{ op: 'obligation-dispose'; obligation: ObligationId; disposition: ObligationDisposition; ruling: RulingId }>
  | Readonly<{ op: 'invalidate-approval'; unit: UnitId }>
  | Readonly<{ op: 'rule'; ruling: RulingId }>
  | Readonly<{ op: 'request'; class: OwnerOnlyClass; summary: string }>;
/** Every op cites active vision clauses (H16: never a withdrawn one) and its evidence, both non-empty. */
export type BundleOp = BundleOpBody & Readonly<{ cites: readonly VisionClauseId[]; evidence: readonly string[] }>;

export type CheckpointOutput = Readonly<{
  decision: (typeof CHECKPOINT_DECISIONS)[number];
  reasons: readonly string[];
  /** Empty exactly on a `no-op`. */
  ops: readonly BundleOp[];
  /** Ruling sidecars (`roadmap/ruling-m3`) as JSON text; empty on a `no-op`. */
  rulings: readonly string[];
  findingDispositions: readonly Readonly<{ finding: FindingId; disposition: FindingDisposition; reason: string }>[];
  /** H12: readings of the vision where it does not anticipate a situation; each records a divergence, even on a `no-op`. */
  interpretations: readonly Readonly<{ clauses: readonly VisionClauseId[]; situation: string; reading: string }>[];
  cites: Readonly<{ vision: readonly VisionClauseId[]; observations: readonly ObservationKey[]; findings: readonly FindingId[] }>;
  premises: readonly Premise[];
}>;

const LIMIT_FIELDS = [...BOUND_FIELDS, 'convergenceK'] as const;
const opSchema = (op: BundleOpKind, fields: { readonly [key: string]: Schema }): Schema =>
  sObj({ op: sEnum([op]), ...fields, cites: S_IDS, evidence: sArr(S_STR) });
const S_DOC_REF = sObj({ path: S_STR, anchor: S_STR, quotedText: S_STR });

export const CHECKPOINT_SCHEMA: Schema = sObj({
  decision: sEnum(CHECKPOINT_DECISIONS),
  reasons: sArr(S_STR),
  ops: sArr({
    anyOf: [
      opSchema('admit', { unit: sObj({ id: S_STR, risk: sEnum(RISK_TIERS), scope: S_IDS, after: S_IDS, origin: sEnum(['checkpoint', 'repair']) }), spec: S_STR }),
      opSchema('patch-spec', { unit: S_STR, patch: sArr(S_PATCH_OP) }),
      opSchema('reenter', { unit: S_STR, reenters: S_STR, enterAt: sNullable(sEnum(REENTRY_POINTS)), reset: sNullable(S_STR) }),
      opSchema('cut', { unit: S_STR, reason: S_STR }),
      opSchema('route', { unit: S_STR, seats: sArr(sObj({ role: sEnum(ROLES), tier: sEnum([...JUDGMENT_SEATS, 'arc']), class: sEnum(MODEL_CLASSES) })) }),
      opSchema('limits', { unit: sNullable(S_STR), limits: sArr(sObj({ field: sEnum(LIMIT_FIELDS), value: S_INT })) }),
      opSchema('obligation-split', {
        obligation: S_STR,
        children: sArr(sObj({
          id: S_STR, statement: S_STR, docRef: S_DOC_REF, witness: sObj({ lane: S_STR, testIds: S_IDS }), activation: sEnum(ACTIVATIONS), deliveredBy: S_IDS,
        })),
      }),
      opSchema('obligation-dispose', { obligation: S_STR, disposition: sEnum(OBLIGATION_DISPOSITIONS), ruling: S_STR }),
      opSchema('invalidate-approval', { unit: S_STR }),
      opSchema('rule', { ruling: S_STR }),
      opSchema('request', { class: sEnum(OWNER_ONLY_CLASSES), summary: S_STR }),
    ],
  }),
  rulings: sArr(S_STR),
  findingDispositions: sArr(sObj({ finding: S_STR, disposition: sEnum(FINDING_DISPOSITIONS), reason: S_STR })),
  interpretations: sArr(sObj({ clauses: S_IDS, situation: S_STR, reading: S_STR })),
  cites: sObj({ vision: S_IDS, observations: sArr(sObj({ treeSha: S_STR, lane: S_STR, laneRev: S_STR, envId: S_STR })), findings: S_IDS }),
  premises: S_PREMISES,
});

const rulingR: Read<RulingId> = (v, p) => rulingId(v, p);
const splitChild: Read<SplitChild> = object((g) => ({
  id: g.get('id', oid),
  statement: g.get('statement', str),
  docRef: g.get('docRef', object((h) => ({ path: h.get('path', (v, p) => repoPath(v, p)), anchor: h.get('anchor', str), quotedText: h.get('quotedText', str) }))),
  witness: g.get('witness', object((h) => ({ lane: h.get('lane', (v, p): LaneId => laneId(v, p)), testIds: h.get('testIds', uniqueIds(str, { nonEmpty: true })) }))),
  activation: g.get('activation', oneOf(ACTIVATIONS)),
  deliveredBy: g.get('deliveredBy', uniqueIds(unitR)),
}));

function opBody(f: Fields, op: BundleOpKind): BundleOpBody {
  switch (op) {
    case 'admit':
      return {
        op,
        unit: f.get('unit', object((g) => ({
          id: g.get('id', unitR), risk: g.get('risk', oneOf(RISK_TIERS)), scope: g.get('scope', uniqueIds((v, p) => repoPattern(v, p), { nonEmpty: true })),
          after: g.get('after', uniqueIds(unitR)), origin: g.get('origin', oneOf(['checkpoint', 'repair'] as const)),
        }))),
        spec: f.get('spec', str),
      };
    case 'patch-spec':
      return { op, unit: f.get('unit', unitR), patch: f.get('patch', arrayOf(wireOp, { nonEmpty: true })) };
    case 'reenter':
      return { op, unit: f.get('unit', unitR), reenters: f.get('reenters', unitR), enterAt: f.get('enterAt', nullable(oneOf(REENTRY_POINTS))), reset: f.get('reset', nullable(rulingR)) };
    case 'cut':
      return { op, unit: f.get('unit', unitR), reason: f.get('reason', str) };
    case 'route':
      return {
        op,
        unit: f.get('unit', unitR),
        seats: f.get('seats', arrayOf((v, p) => {
          const g = new Fields(v, p);
          const role = g.get('role', oneOf(ROLES));
          const tier = g.get('tier', oneOf(SEATS[role] as readonly Seat[]));
          const out = { role, tier, class: g.get('class', oneOf(MODEL_CLASSES)) };
          g.end();
          return out;
        }, { nonEmpty: true })),
      };
    case 'limits':
      return {
        op,
        unit: f.get('unit', nullable(unitR)),
        limits: f.get('limits', arrayOf(object((g) => ({ field: g.get('field', oneOf(LIMIT_FIELDS)), value: g.get('value', positive) })), { nonEmpty: true })),
      };
    case 'obligation-split':
      return { op, obligation: f.get('obligation', oid), children: f.get('children', arrayOf(splitChild, { nonEmpty: true })) };
    case 'obligation-dispose':
      return { op, obligation: f.get('obligation', oid), disposition: f.get('disposition', oneOf(OBLIGATION_DISPOSITIONS)), ruling: f.get('ruling', rulingR) };
    case 'invalidate-approval':
      return { op, unit: f.get('unit', unitR) };
    case 'rule':
      return { op, ruling: f.get('ruling', rulingR) };
    case 'request':
      return { op, class: f.get('class', oneOf(OWNER_ONLY_CLASSES)), summary: f.get('summary', str) };
  }
}

export const bundleOp: Read<BundleOp> = (value, path) => {
  const f = new Fields(value, path);
  const op = f.get('op', oneOf(BUNDLE_OP_KINDS));
  const out = { ...opBody(f, op), cites: f.get('cites', uniqueIds(vid, { nonEmpty: true })), evidence: f.get('evidence', arrayOf(str, { nonEmpty: true })) };
  f.end();
  return out;
};

export const checkpointOutput: Read<CheckpointOutput> = object((f) => {
  const out: CheckpointOutput = {
    decision: f.get('decision', oneOf(CHECKPOINT_DECISIONS)),
    reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
    ops: f.get('ops', arrayOf(bundleOp)),
    rulings: f.get('rulings', arrayOf(str)),
    findingDispositions: f.get('findingDispositions', arrayOf(object((g) => ({
      finding: g.get('finding', (v, p): FindingId => findingId(v, p)), disposition: g.get('disposition', oneOf(FINDING_DISPOSITIONS)), reason: g.get('reason', str),
    })))),
    interpretations: f.get('interpretations', arrayOf(object((g) => ({
      clauses: g.get('clauses', uniqueIds(vid, { nonEmpty: true })), situation: g.get('situation', str), reading: g.get('reading', str),
    })))),
    cites: f.get('cites', object((g) => ({
      vision: g.get('vision', uniqueIds(vid)),
      observations: g.get('observations', arrayOf(observationKey)),
      findings: g.get('findings', uniqueIds((v, p): FindingId => findingId(v, p))),
    }))),
    premises: f.get('premises', arrayOf(premise)),
  };
  if ((out.decision === 'no-op') !== (out.ops.length === 0)) throw new SchemaError(`${f.path}.ops`, out.decision === 'no-op' ? 'no ops on a no-op' : 'at least one op in a bundle', out.ops);
  if (out.decision === 'no-op' && out.rulings.length > 0) throw new SchemaError(`${f.path}.rulings`, 'no rulings on a no-op', out.rulings);
  return out;
});

export function validateCheckpointOutput(value: unknown): CheckpointOutput {
  return checkpointOutput(value, 'checkpoint');
}

// ---------------------------------------------------------------------------------------------------

export type RoleOutputs = {
  readonly planCheck: PlanCheckOutput;
  readonly build: BuildOutput;
  readonly gate: GateOutput;
  readonly lens: LensOutput;
  readonly checkpoint: CheckpointOutput;
};
export const ROLE_SCHEMAS: { readonly [R in Role]: Schema } = {
  planCheck: PLAN_CHECK_SCHEMA, build: BUILD_SCHEMA, gate: GATE_SCHEMA, lens: LENS_SCHEMA, checkpoint: CHECKPOINT_SCHEMA,
};
export const ROLE_VALIDATORS: { readonly [R in Role]: (value: unknown) => RoleOutputs[R] } = {
  planCheck: validatePlanCheckOutput,
  build: validateBuildOutput,
  gate: validateGateOutput,
  lens: validateLensOutput,
  checkpoint: validateCheckpointOutput,
};
