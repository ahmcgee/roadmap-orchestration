// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): read-time defaults for records written by an earlier release,
// so HEAD adopts an arc it started. The previous release is 1.0.0-dev.7 (the only one adopted since 1.0.0-dev.8,
// OR-L4): its one default is at the end. The 1.0.0-dev.6 defaults above it are no longer adopted (no dev.6 arc was in
// flight at M4b step 0a); they go with the holistic `architecture-doc` variant (BACKLOG "Scaffolding to delete").
// Delete each default (and its BACKLOG entry) once no arc started on its release is in flight. Nothing here rewrites a
// file.
//
// Each defaulted kind warns once per process on stderr (the executor's stderr is the supervisor's
// `supervisor.<token>.err` in the host dir).
import type { CensusEntry, ClassifiedAdmit, Conversion, Obligations } from '../holistic/types.ts';
import type { DiffShown, GateLargeDiff, JudgmentInputs, MutantOf, RevisionSource } from './events.ts';
import type { FindingId, LaneId, ObligationId } from './ids.ts';
import type { PressureAvailability } from '../host/pressure.ts';
import type { LaunchCpu } from './records.ts';
import type { ClassTable } from '../routing/types.ts';
import type { UNPINNED } from './pins.ts';

const warned = new Set<string>();

function warnDefaulted(kind: string, detail: string): void {
  if (warned.has(kind)) return;
  warned.add(kind);
  process.stderr.write(`roadmap: upgrade default (${kind}): ${detail}\n`);
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.6 → M4a (1.0.0-dev.7). Byte-preserving (G14): the readers validate a record's canonical raw bytes with
// its new fields absent and return it as written; these helpers normalise it for the code that reads it, so a default
// never enters a hash, a chain or a comparison.
// Delete with the holistic `architecture-doc` variant once no dev.6 arc is in flight (BACKLOG "Scaffolding to delete").

/**
 * An obligations file's census (M4a): a dev.6 file (docRef obligations) has none, which reads as M3 semantics: the
 * census checks are vacuous for it. A corpus arc's file always carries one (the reader requires it beside rule anchors).
 */
export function censusOf(o: Obligations): readonly CensusEntry[] | null {
  if (o.census !== undefined) return o.census;
  warnDefaulted('obligations.census', 'an obligations file without a census (docRef obligations, a 1.0.0-dev.6 arc): census checks are vacuous');
  return null;
}


/**
 * A checkpoint `admit` op's `targets` (M4a rev 3, LR-m): absent on an answer recorded before it; read as none, so the
 * admit classifies on its structural targets alone (the rules of the obligations it declares, delivers or repairs).
 */
export function admitTargetsDefault(): readonly never[] {
  warnDefaulted('checkpoint.admit.targets', 'an admit op without targets (a checkpoint answer written before LR-m); read as none');
  return [];
}

/**
 * A checkpoint `admit` op's `spec` (run 10, D): the model now writes it as an object the schema constrains; an answer
 * recorded before wrote its JSON text, read as written (the bundle's spec reader validates it, as it did then).
 */
export function admitSpecTextDefault(text: string): string {
  warnDefaulted('checkpoint.admit.spec', 'an admit op whose spec is JSON text (a checkpoint answer written before run 10); read as written');
  return text;
}


/**
 * A checkpoint answer's ruling (2026-10-15, arc feedback #3): the model now writes it as an object `S_RULING` constrains; an
 * answer recorded before wrote its JSON text, read as written (the bundle parses it, as it did then). Scaffolding: deleted
 * once no arc started on 1.0.0-dev.9 is in flight.
 */
export function checkpointRulingTextDefault(text: string): string {
  warnDefaulted('checkpoint.rulings', 'a checkpoint ruling as JSON text (an answer written before 2026-10-15); read as written');
  return text;
}

/**
 * A numbered-id list in plain string order (`["T-10","T-9"]`): how every release before 1.0.0-dev.7 validated and wrote
 * them, so a dev.6 record, an arc started before the fix, or a vision, obligations, ruling or Phase-0 file written for
 * them may hold one. It reads as written (byte-preserving); everything written now is in canonical order (`idsAscending`).
 */
export function legacyIdOrder(path: string): void {
  warnDefaulted('ids.string-order', `${path}: a numbered-id list in string order (written before 1.0.0-dev.7); read as written`);
}


// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.6 → M4a rev 3 (still 1.0.0-dev.7, LR-g: no version bump). Byte-preserving as above; SCHEMAS.md "M4a rev 3:
// upgrade additions". Delete with the dev.6 layer (BACKLOG "Scaffolding to delete").

/** A 1.0.0-dev.6 dispatch record's bounds lack the smoke bounds (D2): read as the built-in ones. */
export function dev6SmokeBounds(): Readonly<{ smokeRounds: number; smokeRuns: number }> {
  warnDefaulted('dispatch.bounds.smoke', 'a dispatch record without smokeRounds and smokeRuns (written before M4a rev 3); read as 1 and 2');
  return { smokeRounds: 1, smokeRuns: 2 };
}

/**
 * A recorded lane rev equal to the lane's minimal form (`evidenceExcludes: []` omitted), as a generator hashing raw input
 * wrote it before 1.0.0-dev.7 (F15, run 5), compares equal to the normalised rev (`laneRevMatches`); warned once per lane.
 */
export function minimalLaneRev(lane: LaneId): true {
  warnDefaulted(`lane-rev.minimal.${lane}`, `lane ${lane}: a recorded rev of its minimal form (default fields omitted, before 1.0.0-dev.7) compares equal to its normalised rev`);
  return true;
}

/**
 * What a mutant spawn subject or `mutant.apply` intent was made for: its `of`, or a 1.0.0-dev.6 record's `finding`
 * (a finding's mutant, B3), read as `of: finding`.
 */
export function mutantSubjectDefault(x: Readonly<{ of: MutantOf }> | Readonly<{ finding: FindingId }>): MutantOf {
  if ('of' in x) return x.of;
  warnDefaulted('mutant.finding', 'a mutant record naming finding (written before M4a rev 3); read as of: finding');
  return { type: 'finding', finding: x.finding };
}

/**
 * The host signature table at 1.0.0-dev.6 (0a58349), frozen: a lane or journey spawn without `redRev` (an unstamped
 * dev.6 execution) is classified by it, never by the grown table, so its read-back never changes (Q20).
 */
export const HOST_SIGNATURES_DEV6 = [
  { id: 'golangci-lint-lock', pattern: /parallel golangci-lint is running/i },
  { id: 'kind-boot-timeout', pattern: /failed to create cluster:.*(timed out waiting for the condition|failed to init node with kubeadm)/i },
  { id: 'eagain', pattern: /\bEAGAIN\b|Resource temporarily unavailable/ },
  { id: 'enospc', pattern: /\bENOSPC\b|No space left on device/ },
] as const satisfies readonly Readonly<{ id: string; pattern: RegExp }>[];

/** A build answer's `experiments` (I3): a completed but unrecorded 1.0.0-dev.6 answer that recovery consumes has none. */
export function buildExperimentsDefault(): readonly never[] {
  warnDefaulted('build.experiments', 'a build answer without experiments (written before M4a rev 3); read as none');
  return [];
}

/**
 * A bundle revision's admit classification (OR-A1, Q4): its recorded `admits` and `conversions`, or `unclassified` for a
 * bundle that records none (a 1.0.0-dev.6 arc's, or an `architecture-doc` arc's, LR-h), which never counts against an
 * opportunity budget or a follow-up.
 */
export function bundleClassesOf(source: Extract<RevisionSource, { type: 'bundle' }>): Readonly<{ admits: readonly ClassifiedAdmit[]; conversions: readonly Conversion[] }> | 'unclassified' {
  if (source.admits !== undefined && source.conversions !== undefined) return { admits: source.admits, conversions: source.conversions };
  return 'unclassified';
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.7 → M4b (1.0.0-dev.8). SCHEMAS.md "M4b: upgrade". Delete once no arc started on 1.0.0-dev.7 is in flight
// (BACKLOG "Scaffolding to delete").

/**
 * A revision's routing provenance without `arcRoles` (M4b, R5): an arc 1.0.0-dev.7 started, read with the dev.7 role set
 * (no `flow` seat: its routing revs, seats in force and status tables are dev.7's) and the flow track off (`off-dev7`).
 */
export function dev7ArcRolesDefault(): null {
  warnDefaulted('routing.arcRoles', 'a routing provenance without arcRoles (an arc started on 1.0.0-dev.7): the dev.7 role set, the flow loop off');
  return null;
}

// M4b rev 3 (host pressure, still 1.0.0-dev.8): records an earlier executor wrote lack the pressure fields. Byte-preserving:
// the readers keep them absent, these read them.

/** A spawn's pressure: absent on a spawn an earlier executor closed, read as null (no pressure rule applies). */
export function spawnPressureOf(outcome: Readonly<{ pressure?: number | null }>): number | null {
  if (outcome.pressure !== undefined) return outcome.pressure;
  warnDefaulted('proc.spawn.pressure', 'a spawn result without pressure (closed before M4b rev 3); read as null');
  return null;
}

/** A start's schedstat availability: absent on a start before M4b rev 3, read as `unavailable` (its spawns carry no pressure). */
export function startPressureOf(fact: Readonly<{ pressure?: PressureAvailability }>): PressureAvailability {
  if (fact.pressure !== undefined) return fact.pressure;
  warnDefaulted('executor-started.pressure', 'an executor start without pressure (before M4b rev 3); read as unavailable');
  return 'unavailable';
}

/** A workload's cpu time: absent from an exit.json an earlier runner wrote, read as null (its launch has no pressure). */
export function exitCpuOf(exit: Readonly<{ cpu?: LaunchCpu | null }>): LaunchCpu | null {
  if (exit.cpu !== undefined) return exit.cpu;
  warnDefaulted('exit.cpu', 'an exit.json without cpu (a runner before M4b rev 3 calibration); its launch has no pressure');
  return null;
}

// M4b (paid run 3): a vacuity lens's mutant is exact replacements (`edits`); a lens call an earlier executor recorded asked
// for a hand-written unified diff. Delete once no audit an earlier executor started is running.

/** A recorded lens answer's mutant `patch` (before M4b's `edits`): read as written, syntax-checked at admission as before. */
export function lensPatchMutantDefault(patch: string): string {
  warnDefaulted('lens.mutant.patch', 'a lens answer whose mutant is a unified diff (recorded before M4b edits); read as written');
  return patch;
}

// The build answer's `final` (src/runner/report.ts): a build an earlier executor launched answered a schema without it.

/** A build answer without `final` (launched before the report rule): its session ended by itself, so it was final. */
export function buildFinalDefault(): true {
  warnDefaulted('build.final', 'a build answer without final (launched before the report rule); read as final');
  return true;
}

// Scope growth (2026-10-15, 1.0.0-dev.10): the plan-check answer's `scopeGrowth`. A plan-check call an earlier executor
// launched answered a schema without it; recovery consumes such an answer after an upgrade. Delete once no arc started on
// 1.0.0-dev.9 is in flight.

/** A plan-check answer without `scopeGrowth` (launched before scope growth): it proposed none. */
export function planCheckScopeGrowthDefault(): readonly never[] {
  warnDefaulted('plan-check.scopeGrowth', 'a plan-check answer without scopeGrowth (launched before scope growth); read as none proposed');
  return [];
}

/** A `reenter` op whose answer was recorded before `fixes` existed (`reenterFixesDefault`): distinct from an explicit null. */
export const FIXES_UNRECORDED = 'unrecorded';

/**
 * A checkpoint `reenter` op's `fixes` (arc feedback 2026-10-16): absent (not null: the schema requires the key, null for a
 * lineage with no failure) on an answer recorded before it, so the previous release recorded it. Read as `unrecorded`: the
 * re-entry is adopted as recorded, applied or not; the classifier's `fixes` requirement does not bind it (src/input/classify.ts `fixesReasons`, through the bundle proposer's `fixesUnrecorded`), and it
 * enters the plan without `fixes`. Delete once no arc started on 1.0.0-dev.10 is in flight (BACKLOG "Scaffolding to delete").
 */
export function reenterFixesDefault(): typeof FIXES_UNRECORDED {
  warnDefaulted('checkpoint.reenter.fixes', 'a reenter op without fixes (a checkpoint answer written before 2026-10-16); adopted as recorded, its fixes unchecked');
  return FIXES_UNRECORDED;
}

// Efficient judgment (owner ruling 2026-10-15, 1.0.0-dev.10): the built-in seat table moved planCheck.low/med, gate.low,
// lens.arc and flow.arc to the efficient class. Records carry a `routingRev`, never a table, and OR-L3 binds every revision
// through HEAD's seats and catalogue, so a rev an earlier executor recorded is one HEAD no longer rebuilds. Delete (with
// `resolveRoutingUnder`, when no other earlier table is left, and its place in `EARLIER_BUILTIN_SEATS`) once no arc started on 1.0.0-dev.9 is in flight.

/**
 * The built-in seats 1.0.0-dev.9 (and dev.7 and dev.8) hashed: frontier at every judgment tier but escalation, the
 * lenses, the pack review and the flow seat on frontier. Kept only so `status` can join such a meter row's recorded
 * `routingRev` to its revision's current table (src/status.ts `earlierRevAliases`); nothing routes under it. No judgment
 * seat could name the efficient class then (a Codex or Sonnet judgment was refused at startup), so HEAD's catalogue
 * resolves these seats to the triples dev.9 hashed.
 */
export const PRE_DEV10_BUILTIN_SEATS: ClassTable = {
  planCheck: { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' },
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  gate: { low: 'frontier', med: 'frontier', high: 'frontier', escalation: 'summit' },
  lens: { arc: 'frontier' },
  checkpoint: { arc: 'summit' },
  packReview: { arc: 'frontier' },
  flow: { arc: 'frontier' },  // The walk roles (dev.13) are in force only under a plan with milestones, which no earlier release's arc has: never hashed here.
  walkthrough: { arc: 'frontier' },
  polishJudge: { arc: 'frontier' },
};

// Gate risk ladder (owner direction 2026-10-17, 1.0.0-dev.12): the built-in seats moved gate.med to efficient (Sonnet
// 5.5); gate.low stays efficient (it moved to economy, then reverted after the paid gate role eval). As with efficient judgment above, OR-L3 binds every revision through HEAD's
// seats: an arc started on 1.0.0-dev.10 or dev.11 re-pins its units under the new rev without a park and judges under
// the ladder from then on, and status aliases the revs it recorded. Delete (with `PRE_DEV12_BUILTIN_SEATS`'s place in
// `EARLIER_BUILTIN_SEATS`) once no arc started on 1.0.0-dev.11 is in flight.

/**
 * The built-in seats 1.0.0-dev.10 and dev.11 hashed: efficient gated low, frontier med. Kept only so `status` can join such
 * a meter row's recorded `routingRev` to its revision's current table; nothing routes under it. The economy class did not
 * exist then (no built-in seat names it now either), and these seats name only classes whose bindings HEAD's catalogue keeps, so HEAD resolves them to the
 * triples dev.11 hashed.
 */
export const PRE_DEV12_BUILTIN_SEATS: ClassTable = {
  planCheck: { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' },
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  gate: { low: 'efficient', med: 'frontier', high: 'frontier', escalation: 'summit' },
  lens: { arc: 'efficient' },
  checkpoint: { arc: 'summit' },
  packReview: { arc: 'frontier' },
  flow: { arc: 'efficient' },  // The walk roles (dev.13) are in force only under a plan with milestones, which no earlier release's arc has: never hashed here.
  walkthrough: { arc: 'frontier' },
  polishJudge: { arc: 'frontier' },
};

// Experience-won routing (owner 2026-10-22, 1.0.0-dev.17): plan-check and the gate moved to frontier at every risk tier, and
// build.high to efficient (its builds consult an Opus advisor). As above, OR-L3 binds every revision through HEAD's seats:
// an arc started on 1.0.0-dev.12 to dev.16 re-pins its units under the new rev without a park while their implementer seat
// is unchanged (a unit at risk high that already built on frontier parks `routing-changed`: its session cannot move), and
// status aliases the revs it recorded. Delete (with `PRE_DEV17_BUILTIN_SEATS`'s place in `EARLIER_BUILTIN_SEATS`) once no
// arc started on 1.0.0-dev.16 or earlier is in flight.

/**
 * The built-in seats 1.0.0-dev.12 to dev.16 hashed: efficient plan-checked and gated low and med, frontier high; frontier
 * built high. Kept only so `status` can join such a meter row's recorded `routingRev` to its revision's current table;
 * nothing routes under it. These seats name only classes whose bindings HEAD's catalogue keeps, so HEAD resolves them to
 * the triples dev.16 hashed.
 */
export const PRE_DEV17_BUILTIN_SEATS: ClassTable = {
  planCheck: { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' },
  build: { low: 'efficient', med: 'efficient', high: 'frontier' },
  gate: { low: 'efficient', med: 'efficient', high: 'frontier', escalation: 'summit' },
  lens: { arc: 'efficient' },
  checkpoint: { arc: 'summit' },
  packReview: { arc: 'frontier' },
  flow: { arc: 'efficient' },
  walkthrough: { arc: 'frontier' },
  polishJudge: { arc: 'frontier' },
};

/** Every built-in seat table an earlier adopted release hashed, oldest first: what status aliases recorded revs under. */
export const EARLIER_BUILTIN_SEATS: readonly ClassTable[] = [PRE_DEV10_BUILTIN_SEATS, PRE_DEV12_BUILTIN_SEATS, PRE_DEV17_BUILTIN_SEATS];

// Plan defects (2026-10-16, 1.0.0-dev.11): a fresh arc's arc lanes declare `testPaths` and its witnesses `files`, and
// Phase 0 checks every witness file against its lane and its deliverers (src/phase0/rows.ts). Obligations an arc started
// on 1.0.0-dev.10 recorded may lack both; they read as undeclared (nothing to check) until an apply declares them. Delete,
// with the undeclared arm of the rows, once no arc started on 1.0.0-dev.10 is in flight.

/** An arc lane without `testPaths` in the obligations of an arc started before plan defects: its witness files go unchecked. */
export function laneTestPathsUndeclared(lane: LaneId): void {
  warnDefaulted('obligations.lanes.testPaths', `arc lane ${lane} declares no testPaths (an arc started before 2026-10-16); its witness files are not checked`);
}

/** A witness without `files` in the obligations of an arc started before plan defects: its files go unchecked. */
export function witnessFilesUndeclared(obligation: ObligationId): void {
  warnDefaulted('obligations.witness.files', `obligation ${obligation}'s witness declares no files (an arc started before 2026-10-16); its files are not checked`);
}

// Apply rebase (2026-10-16): an apply command carries the `base` it rebases from. One an earlier CLI queued
// carries `expectRev` instead (the plan rev it expected in force). Delete once no arc started on 1.0.0-dev.10 is in flight
// (BACKLOG "Scaffolding to delete"); `base` then becomes required alone.

/** A queued apply with `expectRev` (queued before the rebase): read as base null, the owner's files of their latest apply. */
export function applyExpectRevDefault(): null {
  warnDefaulted('apply.expectRev', 'an apply command with expectRev (queued before the apply rebase): rebased from the default base');
  return null;
}

/**
 * A queued apply without `visionEdit` (queued by a CLI before the flag, owner ruling 2026-10-16): read as a declared vision
 * edit, so the previous release's command is adopted, never refused as `vision-leak` (CLAUDE.md: its runtime state is never
 * refused). Every body the CLI writes now carries the field, `false` included. Delete once no arc started on 1.0.0-dev.10
 * is in flight (BACKLOG "Scaffolding to delete"); `visionEdit` then becomes required.
 */
export function applyVisionEditDefault(): true {
  warnDefaulted('apply.visionEdit', 'an apply command without visionEdit (queued before --vision-edit): read as a declared vision edit');
  return true;
}

/**
 * An `audit-started`'s `diffBudget` (the lens-range fix, 2026-10-16): absent on an audit an executor before it started
 * (1.0.0-dev.10), resumed now. Read as null: each of its lenses reviews its whole range in one call, as its recorded
 * calls did, so their attempt numbers stay its own; the attachments keep within today's budget. The next audit chunks.
 * Scaffolding: deleted once no audit an executor before the fix started is running; `diffBudget` then becomes required.
 */
export function auditDiffBudgetOf(s: Readonly<{ job: string; diffBudget?: number }>): number | null {
  if (s.diffBudget !== undefined) return s.diffBudget;
  warnDefaulted('audit-started.diffBudget', `${s.job}: an audit started before the lens-range fix; its lenses read their whole range in one call`);
  return null;
}

/**
 * A gate's `judgment-inputs` `diffShown` (1.0.0-dev.12, the bounded gate diff): absent on one a dev.11 executor recorded,
 * whose gate was shown its whole diff inline. Read as empty lists: nothing recorded either way. Scaffolding: deleted once
 * no arc started on 1.0.0-dev.11 is in flight (BACKLOG "Scaffolding to delete"); `diffShown` then becomes required on a
 * gate's.
 */
export function gateDiffShownOf(inputs: JudgmentInputs): DiffShown {
  if (inputs.stage !== 'gate') throw new Error(`${inputs.unit} ${inputs.stage}#${inputs.attempt}: only a gate's judgment-inputs record a diff shown`);
  if (inputs.diffShown !== undefined) return inputs.diffShown;
  warnDefaulted('judgment-inputs.diffShown', `${inputs.unit} gate#${inputs.attempt}: a gate a dev.11 executor recorded, shown its whole diff inline; read as nothing recorded`);
  return { inlined: [], notInlined: [] };
}

/**
 * A gate's `judgment-inputs` `largeDiff` (1.0.0-dev.12, the large-diff gate): absent on one a dev.11 executor recorded, which
 * had no large-diff threshold. Read as null: under the threshold, so its seat was the unit's own and its answer carries no
 * cluster map. Scaffolding: deleted once no arc started on 1.0.0-dev.11 is in flight (BACKLOG "Scaffolding to delete");
 * `largeDiff` then becomes required on a gate's.
 */
export function gateLargeDiffOf(inputs: JudgmentInputs): GateLargeDiff | null {
  if (inputs.stage !== 'gate') throw new Error(`${inputs.unit} ${inputs.stage}#${inputs.attempt}: only a gate's judgment-inputs record a large diff`);
  if (inputs.largeDiff !== undefined) return inputs.largeDiff;
  warnDefaulted('judgment-inputs.largeDiff', `${inputs.unit} gate#${inputs.attempt}: a gate a dev.11 executor recorded, before the large-diff threshold; read as under it`);
  return null;
}

/**
 * A gate answer's `clusters` (1.0.0-dev.12, the large-diff gate): absent on an answer a dev.11 gate gave, never asked for a
 * cluster map. Read as null: no map, which is what an answer under the large-diff threshold carries. Scaffolding: deleted
 * once no arc started on 1.0.0-dev.11 is in flight (BACKLOG "Scaffolding to delete"); `clusters` then becomes required in
 * `gateOutput`.
 */
export function gateClustersDefault(): null {
  warnDefaulted('gate.clusters', 'a gate answer without clusters (a dev.11 gate); read as no cluster map');
  return null;
}

/** A gate note's `debt` recorded before dev.13 asked for it (`gateNoteDebtDefault`): distinct from an explicit null. */
export const GATE_DEBT_UNRECORDED = 'unrecorded';

/**
 * A gate finding's `debt` (dev.13, the convergence tail): absent on an answer a dev.12 gate gave, which banked every
 * non-blank note. Read as `unrecorded`, banked as dev.12 banked it (src/pipeline/gate.ts `gateDebtNotes`), so a re-read at
 * recovery never changes what an approval banks. Scaffolding: deleted once no arc started on 1.0.0-dev.12 is in flight
 * (BACKLOG "Scaffolding to delete"); `debt` then becomes required in `gateOutput`.
 */
export function gateNoteDebtDefault(): typeof GATE_DEBT_UNRECORDED {
  warnDefaulted('gate.debt', 'a gate finding without debt (a dev.12 gate); a note banks as dev.12 banked it');
  return GATE_DEBT_UNRECORDED;
}

/**
 * A gate answer's `unreviewed` (1.0.0-dev.12 round 2): absent on an answer a dev.11 gate gave, which was never asked what it
 * did not read. Read as null: unknown, never "everything reviewed". Scaffolding: deleted once no arc started on
 * 1.0.0-dev.11 is in flight (BACKLOG "Scaffolding to delete"); `unreviewed` then becomes required in `gateOutput`.
 */
export function gateUnreviewedDefault(): null {
  warnDefaulted('gate.unreviewed', 'a gate answer without unreviewed (a dev.11 gate); read as unknown');
  return null;
}

/**
 * A plan's `planCheck.shape` (M4a rev 3 to dev.16): removed in dev.17, where every unit's plan-check is one fresh call. A plan
 * in force carrying it (an arc started on dev.16 or earlier) reads as `uniform`: the field is dropped at parse, and a
 * `by-builder` arc's units plan-check as any other's from here. Scaffolding: deleted once no arc started on 1.0.0-dev.16 is in
 * flight (BACKLOG "Scaffolding to delete"); the plan reader then refuses the field.
 */
export function planCheckShapeDefault(shape: 'uniform' | 'by-builder'): void {
  warnDefaulted('plan.planCheck.shape', `a plan with planCheck.shape ${shape} (removed in dev.17); read as uniform: every plan-check is one fresh call`);
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.16 → 1.0.0-dev.17 (lane topology). Scaffolding: deleted once no arc started on 1.0.0-dev.16 is in flight
// (BACKLOG "Scaffolding to delete"); `cadence` then becomes required on every lane and `inputs` is refused.

/** Where a lane is declared: a spec, the plan's suite, or the obligations' arc lanes (each defaults `tier` its own way). */
export type LaneKind = 'spec' | 'suite' | 'arc';

/**
 * A lane's `cadence` (dev.17) from the `tier` a dev.16 record declares: a fast lane is `build` (the builder runs it: a spec
 * or suite lane in its loop, an arc lane as its witness check); an estate lane is `unit` in a spec (the lanes stage) and
 * `candidate` in the suite or the arc lanes (the candidate merge). Warned once per lane kind.
 */
export function laneCadenceDefault(kind: LaneKind, tier: 'fast' | 'estate'): 'build' | 'unit' | 'candidate' {
  warnDefaulted(`lane.tier.${kind}`, `${kind === 'arc' ? 'an' : 'a'} ${kind} lane declaring tier (written before 1.0.0-dev.17); read as its cadence`);
  if (tier === 'fast') return 'build';
  return kind === 'spec' ? 'unit' : 'candidate';
}

/** The dev.16 `tier` a lane of `cadence` was declared with (`laneCadenceDefault` inverted; null: none, a dev.17 cadence). */
export function legacyTierOf(cadence: 'build' | 'unit' | 'candidate' | 'batch'): 'fast' | 'estate' | null {
  return cadence === 'build' ? 'fast' : cadence === 'batch' ? null : 'estate';
}

/**
 * A spec lane's `inputs` (M4a rev 3, F1a), folded into the reuse key in 1.0.0-dev.17 (a lane's inputs are its systems'
 * paths): a dev.16 spec declaring them reads without them; warned once.
 */
export function laneInputsDropped(lane: LaneId): void {
  warnDefaulted('lane.inputs', `lane ${lane}: inputs (written before 1.0.0-dev.17) are dropped; the lane's reuse key reads its systems' paths`);
}

/**
 * A recorded lane rev equal to the rev of the lane's dev.16 form (`tier` in place of `cadence`) compares equal to its
 * normalised rev (`laneRevMatches`), so a proof judgment over a dev.16 lane stays fresh; warned once per lane.
 */
export function tierLaneRev(lane: LaneId): true {
  warnDefaulted(`lane-rev.tier.${lane}`, `lane ${lane}: a recorded rev of its dev.16 form (tier, before 1.0.0-dev.17) compares equal to its normalised rev`);
  return true;
}

/**
 * The systems map a revision recorded (dev.17): absent on a revision a dev.16 executor applied, which had none. Read as no
 * map: every lane is selected everywhere and reads the whole tree (src/input/systems.ts).
 */
export function systemsMapDefault(): null {
  warnDefaulted('plan-applied.systemsMap', 'a revision without a systems map (applied before 1.0.0-dev.17); read as none');
  return null;
}

// 1.0.0-dev.16 → 1.0.0-dev.17 (design records and revision pins, SCHEMAS.md "dev.17 records"). Scaffolding: deleted once no
// arc started on 1.0.0-dev.16 is in flight (BACKLOG "Scaffolding to delete").

/**
 * A unit's kind (dev.17) from a spec without a design record: one a dev.16 executor wrote, or one no dev.17 plan-check has
 * designed yet. Read as `module` (src/core/records.ts `specKindOf`).
 */
export function designKindDefault(): 'module' {
  warnDefaulted('spec.design.kind', 'a spec without a design record (written before 1.0.0-dev.17, or not yet designed); its unit reads as kind module');
  return 'module';
}

/**
 * A spec's revision pins (dev.17): absent on a spec a dev.16 executor wrote. Every link of it reads `unpinned`: stale-unknown,
 * never fresh (src/core/records.ts `specPinOf`).
 */
export function specPinsDefault(): typeof UNPINNED {
  warnDefaulted('spec.pins', 'a spec without revision pins (written before 1.0.0-dev.17); its links read as unpinned (stale-unknown)');
  return 'unpinned';
}
