// The design record (dev.17, design pass; SCHEMAS.md "dev.17 records"): what a unit's plan-check settles about the change
// before it is built, carried on the spec (`SpecM1.design`). Code binds it only as far as code can check (DESIGN-1.0.md):
// its paths against the pinned scope, its interfaces against the risk trigger, its failure modes against the test items,
// its breaks against the builder's departures. This module is the record and its reader; the checks live with the stages.
import {
  type FailureModeId, type LaneId, type SystemName, type WitnessItemId, failureModeId, laneId, systemName, witnessItemId,
} from './ids.ts';
import { type ContractPin, type FilePin, type RequirementPin, contractPin, filePin, requirementPin } from './pins.ts';
import { type RepoPattern, repoPattern } from './values.ts';
import { type Read, arrayOf, assertUnique, literal, nat, nullable, object, oneOf, positive, str, tagged } from './validate.ts';

/**
 * `module`: the unit changes one system (or seams only). `integration`: it spans systems at their seams and is proven by a
 * spanning candidate or batch lane. A spec without a design record reads `module` (`designKindDefault`).
 */
export const UNIT_KINDS = ['module', 'integration'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** One area the unit changes: a system of the map (null: none, a path the map does not cover, or no map) and its paths. */
export type DesignChange = Readonly<{
  system: SystemName | null;
  paths: readonly RepoPattern[];
  /** The changed lines the plan-check estimates here; the record's size estimate is their sum (`designSize`). */
  lines: number;
}>;

/** A test item a failure mode is proven by: a witness item of the spec, or a test of one of its lanes. */
export type TestItemRef = Readonly<{ type: 'witness'; item: WitnessItemId }> | Readonly<{ type: 'test'; lane: LaneId; testId: string }>;

/** How a failure mode is covered: a test item, or `untested` with why (an unmapped failure mode blocks an approve). */
export type FailureModeProof = Readonly<{ type: 'test'; test: TestItemRef }> | Readonly<{ type: 'untested'; reason: string }>;

export type FailureMode = Readonly<{
  id: FailureModeId;
  mode: string;
  proof: FailureModeProof;
  /** The requirements the failure mode bears on, each at the rev the record was written against (may be none). */
  requirements: readonly RequirementPin[];
}>;

/** A contract or a plain path the unit's change crosses, pinned at its blob when the record was written. */
export type DesignInterface = ContractPin | FilePin;

/** What the change breaks that the unit must update: existing tests and docs, each at its blob when the record was written. */
export type DesignBreaks = Readonly<{ tests: readonly FilePin[]; docs: readonly FilePin[] }>;

/** An experiment the plan-check ran in its checkout, as run, and what it printed. */
export type DesignExperiment = Readonly<{ command: string; output: string }>;

/** A system the unit creates (a `scaffold` decision writes it first): its name, paths and test-file glob. */
export type NewSystem = Readonly<{ name: SystemName; paths: readonly RepoPattern[]; tests: readonly RepoPattern[] }>;

/**
 * How a deflake unit proves its fix: `reproduce-then-fix` (the induced `condition` fails the old tree and passes the new),
 * the expected method; or `repeat` with a rationale. `runs` is what code caps against the verification budget.
 */
export type Verification =
  | Readonly<{ type: 'reproduce-then-fix'; condition: string; runs: number }>
  | Readonly<{ type: 'repeat'; rationale: string; runs: number }>;

export type DesignRecord = Readonly<{
  kind: UnitKind;
  changes: readonly DesignChange[];
  interfaces: readonly DesignInterface[];
  failureModes: readonly FailureMode[];
  breaks: DesignBreaks;
  experiments: readonly DesignExperiment[];
  /** Absent: the unit creates no system (lasting). */
  newSystem?: NewSystem;
  /** A deflake unit's only; absent on every other unit (lasting). */
  verification?: Verification;
}>;

/** The record's size estimate: the changed lines of all its changes. */
export const designSize = (d: DesignRecord): number => d.changes.reduce((n, c) => n + c.lines, 0);

const pattern: Read<RepoPattern> = (v, p) => repoPattern(v, p);
const patterns = arrayOf(pattern, { nonEmpty: true });

export const designChange: Read<DesignChange> = object((f) => ({
  system: f.get('system', nullable((v, p) => systemName(v, p))), paths: f.get('paths', patterns), lines: f.get('lines', nat),
}));

export const testItemRef: Read<TestItemRef> = tagged<TestItemRef['type'], TestItemRef>('type', {
  witness: object((f) => ({ type: f.get('type', literal('witness')), item: f.get('item', (v, p) => witnessItemId(v, p)) })),
  test: object((f) => ({ type: f.get('type', literal('test')), lane: f.get('lane', (v, p) => laneId(v, p)), testId: f.get('testId', str) })),
});

export const failureModeProof: Read<FailureModeProof> = tagged<FailureModeProof['type'], FailureModeProof>('type', {
  test: object((f) => ({ type: f.get('type', literal('test')), test: f.get('test', testItemRef) })),
  untested: object((f) => ({ type: f.get('type', literal('untested')), reason: f.get('reason', str) })),
});

const failureMode: Read<FailureMode> = object((f) => {
  const out = {
    id: f.get('id', (v, p) => failureModeId(v, p)), mode: f.get('mode', str), proof: f.get('proof', failureModeProof),
    requirements: f.get('requirements', arrayOf(requirementPin)),
  };
  assertUnique(out.requirements, (r) => r.id, `${f.path}.requirements`);
  return out;
});

const designInterface: Read<DesignInterface> = tagged<DesignInterface['type'], DesignInterface>('type', { contract: contractPin, file: filePin });

const breaks: Read<DesignBreaks> = object((f) => {
  const out = { tests: f.get('tests', arrayOf(filePin)), docs: f.get('docs', arrayOf(filePin)) };
  assertUnique([...out.tests, ...out.docs], (b) => b.path, `${f.path}.<paths>`);
  return out;
});

export const designExperiment: Read<DesignExperiment> = object((f) => ({ command: f.get('command', str), output: f.get('output', str) }));

export const newSystem: Read<NewSystem> = object((f) => ({
  name: f.get('name', (v, p) => systemName(v, p)), paths: f.get('paths', patterns), tests: f.get('tests', arrayOf(pattern)),
}));

export const verification: Read<Verification> = tagged<Verification['type'], Verification>('type', {
  'reproduce-then-fix': object((f) => ({ type: f.get('type', literal('reproduce-then-fix')), condition: f.get('condition', str), runs: f.get('runs', positive) })),
  repeat: object((f) => ({ type: f.get('type', literal('repeat')), rationale: f.get('rationale', str), runs: f.get('runs', positive) })),
});

export const designRecord: Read<DesignRecord> = object((f) => {
  const ns = f.optional('newSystem', newSystem);
  const v = f.optional('verification', verification);
  const out: DesignRecord = {
    kind: f.get('kind', oneOf(UNIT_KINDS)),
    changes: f.get('changes', arrayOf(designChange, { nonEmpty: true })),
    interfaces: f.get('interfaces', arrayOf(designInterface)),
    failureModes: f.get('failureModes', arrayOf(failureMode)),
    breaks: f.get('breaks', breaks),
    experiments: f.get('experiments', arrayOf(designExperiment)),
    ...(ns === undefined ? {} : { newSystem: ns }),
    ...(v === undefined ? {} : { verification: v }),
  };
  assertUnique(out.interfaces, (i) => i.path, `${f.path}.interfaces`);
  assertUnique(out.failureModes, (m) => m.id, `${f.path}.failureModes`);
  return out;
});
