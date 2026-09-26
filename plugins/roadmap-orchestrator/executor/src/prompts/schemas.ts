// Structured results of the three roles, as strict JSON Schemas (every key required, no additional
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
import { type ClauseId, type LaneId, clauseId, laneId } from '../core/ids.ts';
import type { JsonValue } from '../core/json.ts';
import { type NoteDef, type SpecPatchOp, specPatchOp } from '../core/records.ts';
import {
  Fields, type Read, SchemaError, arrayOf, assertUnique, envName, int, literal, nullable, object, oneOf, str, text,
} from '../core/validate.ts';
import { RISK_TIERS, type RiskTier, type Role } from '../routing/types.ts';

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
}>;
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

export const planCheckOutput: Read<PlanCheckOutput> = object((f): PlanCheckOutput => {
  const decision = f.get('decision', oneOf(PLAN_CHECK_DECISIONS));
  const common = {
    reasons: f.get('reasons', arrayOf(str, { nonEmpty: true })),
    risk: f.get('risk', oneOf(RISK_TIERS)),
    notes: f.get('notes', text),
    premises: f.get('premises', arrayOf(premise)),
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

export type RoleOutputs = { readonly planCheck: PlanCheckOutput; readonly build: BuildOutput; readonly gate: GateOutput };
export const ROLE_SCHEMAS: { readonly [R in Role]: Schema } = { planCheck: PLAN_CHECK_SCHEMA, build: BUILD_SCHEMA, gate: GATE_SCHEMA };
export const ROLE_VALIDATORS: { readonly [R in Role]: (value: unknown) => RoleOutputs[R] } = {
  planCheck: validatePlanCheckOutput,
  build: validateBuildOutput,
  gate: validateGateOutput,
};
