// Scripted arc judgments for the fake claude backend: a lens (per lens kind, per job) and a checkpoint
// (per job). Each builder returns a value already accepted by the frozen output reader (src/prompts/schemas.ts),
// so a fake never emits an answer the executor could not have been given; the emitting step is selected per
// job and lens by the scenario keys (`unit` = the job id, `lens`; see StepBase in scenario.ts).
import type { JsonValue } from '../../src/core/json.ts';
import type { LensKindName } from '../../src/core/records.ts';
import { validateCheckpointOutput, validateLensOutput, validatePackReviewOutput } from '../../src/prompts/schemas.ts';
import type { ClaudeAct, Step } from './scenario.ts';

type Obj = { readonly [key: string]: JsonValue };

export type LensFindingSpec = Readonly<{
  severity?: 'P1' | 'P2' | 'P3';
  obligation?: string | null;
  visionClauses?: readonly string[];
  claim?: string;
  cause?: string;
  evidence?: readonly Readonly<{ path: string; line: number }>[];
  mutant?: Readonly<{ patch: string; lane: string }> | null;
}>;

/** A lens's answer: `findings` with defaults filled (a P2 citing V-1), plus the required reasons and premises. */
export function lensAnswer(findings: readonly LensFindingSpec[] = []): JsonValue {
  const value: Obj = {
    findings: findings.map((f, i) => ({
      severity: f.severity ?? 'P2',
      obligation: f.obligation ?? null,
      visionClauses: [...(f.visionClauses ?? ['V-1'])],
      claim: f.claim ?? `claim ${i + 1}`,
      cause: f.cause ?? `cause ${i + 1}`,
      evidence: (f.evidence ?? [{ path: 'src/a.ts', line: 1 }]).map((e) => ({ ...e })),
      mutant: f.mutant ?? null,
    })),
    reasons: ['scripted lens'],
    premises: [],
  };
  validateLensOutput(value);
  return value;
}

const cites = { cites: ['V-1'], evidence: ['scripted evidence'] } as const;

/** An op the reader accepts and activation accepts on a plan with a unit `unit`: an arc-wide limits change. */
export const VALID_OP: JsonValue = { op: 'limits', unit: null, limits: [{ field: 'convergenceK', value: 3 }], ...cites };
/** An op the reader accepts but activation refuses: it cuts a unit the plan does not have and cites a clause the vision lacks. */
export const INVALID_OP: JsonValue = { op: 'cut', unit: 'no-such-unit', reason: 'scripted invalid op', cites: ['V-999'], evidence: ['scripted evidence'] };

export type CheckpointSpec = Readonly<{
  decision: 'no-op' | 'bundle';
  ops?: readonly JsonValue[];
  rulings?: readonly string[];
  findingDispositions?: readonly Readonly<{ finding: string; disposition: 'dismissed' | 'deferred' | 'accepted'; reason: string }>[];
  interpretations?: readonly Readonly<{ clauses: readonly string[]; situation: string; reading: string }>[];
  /** M4a: amendments the checkpoint proposes (`rules` are `T-n` ids). */
  corpusAmendments?: readonly Readonly<{ rules: readonly string[]; proposal: string; why: string }>[];
  /** M4a: one outcome per captured issue (`issue` is an `issue-<number>` id); the outcome objects are the wire form. */
  issueIntake?: readonly Readonly<{ issue: string; outcome: JsonValue }>[];
}>;

/** Issue-intake outcomes in the checkpoint's wire form (H17: `acted` names ops of the same output). */
export const intakeOutcome = {
  finding: (claim: string, severity: 'P2' | 'P3' = 'P2', cause = 'scripted cause'): JsonValue => ({ type: 'finding', severity, claim, cause }),
  amendment: (rules: readonly string[], proposal: string): JsonValue => ({ type: 'amendment', rules: [...rules], proposal }),
  actedOps: (indexes: readonly number[]): JsonValue => ({ type: 'acted', on: { type: 'ops', indexes: [...indexes] } }),
  none: (reason: string): JsonValue => ({ type: 'none', reason }),
} as const;

/** A checkpoint's answer, validated by the frozen reader (so a no-op with ops, or a bundle without, throws here). */
export function checkpointAnswer(spec: CheckpointSpec): JsonValue {
  const value: Obj = {
    decision: spec.decision,
    reasons: ['scripted checkpoint'],
    ops: [...(spec.ops ?? [])],
    rulings: [...(spec.rulings ?? [])],
    findingDispositions: (spec.findingDispositions ?? []).map((d) => ({ ...d })),
    interpretations: (spec.interpretations ?? []).map((i) => ({ clauses: [...i.clauses], situation: i.situation, reading: i.reading })),
    cites: { vision: ['V-1'], observations: [], findings: [] },
    premises: [],
    corpusAmendments: (spec.corpusAmendments ?? []).map((a) => ({ rules: [...a.rules], proposal: a.proposal, why: a.why })),
    issueIntake: (spec.issueIntake ?? []).map((e) => ({ issue: e.issue, outcome: e.outcome })),
  };
  validateCheckpointOutput(value);
  return value;
}

/** The literal partial bundle (A18): two ops, the second invalid at activation. Applying it whole must apply neither. */
export function twoOpBundleSecondInvalid(first: JsonValue = VALID_OP, second: JsonValue = INVALID_OP): JsonValue {
  return checkpointAnswer({ decision: 'bundle', ops: [first, second] });
}

/** A no-op that only records how it read the vision (H12): its interpretation becomes a divergence. */
export function interpretationOnlyNoop(clauses: readonly string[] = ['V-1'], situation = 'scripted situation', reading = 'scripted reading'): JsonValue {
  return checkpointAnswer({ decision: 'no-op', interpretations: [{ clauses, situation, reading }] });
}

const step = (key: { unit?: string; lens?: LensKindName }, acts: readonly ClaudeAct[]): Step => ({ as: 'claude', ...key, expect: {}, acts });

/** A lens call of `lens` in job `job` answers `findings`; `extra` acts (commit, hang, barrier...) run first. */
export function lensStep(job: string | undefined, lens: LensKindName, findings: readonly LensFindingSpec[] = [], extra: readonly ClaudeAct[] = []): Step {
  return step({ ...(job === undefined ? {} : { unit: job }), lens }, [...extra, { type: 'emit', value: lensAnswer(findings) }]);
}

/** A checkpoint call of job `job` (a `ckpt-n`) answers `answer`. */
export function checkpointStep(job: string | undefined, answer: JsonValue, extra: readonly ClaudeAct[] = []): Step {
  return step(job === undefined ? {} : { unit: job }, [...extra, { type: 'emit', value: answer }]);
}

export type PackFindingSpec = Readonly<{
  severity?: 'blocking' | 'note';
  /** The finding's target in wire form; default the plan. */
  target?: JsonValue;
  claim?: string;
  evidence?: readonly Readonly<{ path: string; line: number }>[];
}>;

/** Pack-review targets in wire form. */
export const packTargetOf = {
  unit: (id: string): JsonValue => ({ type: 'unit', id }),
  obligation: (id: string): JsonValue => ({ type: 'obligation', id }),
  census: (rule: string): JsonValue => ({ type: 'census', rule }),
  rule: (id: string): JsonValue => ({ type: 'rule', id }),
  plan: (): JsonValue => ({ type: 'plan' }),
} as const;

/** A pack review's answer (OR-Q16), validated by the frozen reader: defaults a note on the plan. */
export function packReviewAnswer(findings: readonly PackFindingSpec[] = []): JsonValue {
  const value: Obj = {
    findings: findings.map((f, i) => ({
      severity: f.severity ?? 'note',
      target: f.target ?? packTargetOf.plan(),
      claim: f.claim ?? `pack claim ${i + 1}`,
      evidence: (f.evidence ?? [{ path: 'docs/corpus/0010_Overview.md', line: 1 }]).map((e) => ({ ...e })),
    })),
    reasons: ['scripted pack review'],
    premises: [],
  };
  validatePackReviewOutput(value);
  return value;
}

/** A pack-review call of job `review-<n>` answers `findings`; `extra` acts (commit, hang, barrier...) run first. */
export function packReviewStep(job: string | undefined, findings: readonly PackFindingSpec[] = [], extra: readonly ClaudeAct[] = []): Step {
  return step(job === undefined ? {} : { unit: job }, [...extra, { type: 'emit', value: packReviewAnswer(findings) }]);
}
