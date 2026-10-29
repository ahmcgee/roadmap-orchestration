// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): read-time defaults for records written by an earlier release,
// so HEAD adopts an arc it started. The previous release is 1.0.0-dev.7 (the only one adopted since 1.0.0-dev.8,
// OR-L4): its one default is at the end. The 1.0.0-dev.6 defaults above it are no longer adopted (no dev.6 arc was in
// flight at M4b step 0a); they go with the holistic `architecture-doc` variant (BACKLOG "Scaffolding to delete").
// Delete each default (and its BACKLOG entry) once no arc started on its release is in flight. Nothing here rewrites a
// file.
//
// Each defaulted kind warns once per process on stderr (the executor's stderr is the supervisor's
// `supervisor.<token>.err` in the host dir).
import type { CheckpointTrigger, CensusEntry, ClassifiedAdmit, Conversion, Obligations } from '../holistic/types.ts';
import type { DiffShown, FlakeOn, FlakyFact, GateLargeDiff, JudgmentInputs, MutantOf, Parent, RevisionSource } from './events.ts';
import type { ApprovalBlobs, GateReview } from './review.ts';
import type { FindingId, JobId, LaneId, ObligationId, UnitId, Sha256Hex } from './ids.ts';
import type { PressureAvailability } from '../host/pressure.ts';
import type { LaunchCpu, ResultFile } from './records.ts';
import { canonicalJson } from './json.ts';
import type { CpuBasis } from './cpu.ts';
import type { ClassTable, Triple } from '../routing/types.ts';

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
  verifier: { low: 'economy', med: 'economy', high: 'economy' },  // dev.17: never hashed under an earlier table (`DEV17_ROLES`).
  // The scaffold role (dev.17) is in force only in a `dev17` arc, which no earlier release started: never hashed here.
  scaffold: { low: 'economy', med: 'economy', high: 'economy' },
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
  verifier: { low: 'economy', med: 'economy', high: 'economy' },  // dev.17: never hashed under an earlier table (`DEV17_ROLES`).
  // The scaffold role (dev.17) is in force only in a `dev17` arc, which no earlier release started: never hashed here.
  scaffold: { low: 'economy', med: 'economy', high: 'economy' },
};

// Experience-won routing (owner 2026-10-22, 1.0.0-dev.17): plan-check and the gate moved to frontier at every risk tier, and
// build.high to efficient (its builds consult an Opus advisor). As above, OR-L3 binds every revision through HEAD's seats:
// an arc started on 1.0.0-dev.12 to dev.16 re-pins its units under the new rev without a park, and status aliases the revs
// it recorded. A unit at risk high whose build already started on frontier keeps that pinned seat through to its merge
// (`implementerSeatKept`; its session cannot move); units not yet started build under the new seats. Delete (with
// `PRE_DEV17_BUILTIN_SEATS`'s place in `EARLIER_BUILTIN_SEATS`, `ResolvedRouting.preDev17Rev` and `implementerSeatKept`) once no arc started on
// 1.0.0-dev.16 or earlier is in flight.

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
  verifier: { low: 'economy', med: 'economy', high: 'economy' },  // dev.17: never hashed under an earlier table (`DEV17_ROLES`).
  // The scaffold role (dev.17) is in force only in a `dev17` arc, which no earlier release started: never hashed here.
  scaffold: { low: 'economy', med: 'economy', high: 'economy' },
};

/** Every built-in seat table an earlier adopted release hashed, oldest first: what status aliases recorded revs under. */
export const EARLIER_BUILTIN_SEATS: readonly ClassTable[] = [PRE_DEV10_BUILTIN_SEATS, PRE_DEV12_BUILTIN_SEATS, PRE_DEV17_BUILTIN_SEATS];

/**
 * A started implementer whose pinned routing is dev.16's built-in seats (`ResolvedRouting.preDev17Rev`: a release upgrade,
 * not an owner edit) and whose seat the new seats move (dev.16 built high on frontier): it keeps its pinned seat through to its merge, as its
 * session cannot move; src/pipeline/dispatch.ts `repin`. Delete with `PRE_DEV17_BUILTIN_SEATS` once no arc started on
 * 1.0.0-dev.16 or earlier is in flight.
 */
export function implementerSeatKept(unit: string, seat: string): void {
  warnDefaulted(`dispatch.implementerSeat.${unit}`, `unit ${unit} started building on ${seat} under an earlier release's built-in seats; it keeps that seat through to its merge (the new seats apply to units not yet started)`);
}

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

// 1.0.0-dev.16 → 1.0.0-dev.17 (design records, SCHEMAS.md "dev.17 records"; propagation, "dev.17: propagation"). Scaffolding:
// deleted once no arc started on 1.0.0-dev.16 is in flight (BACKLOG "Scaffolding to delete"). A spec without revision pins
// is no default: it is a lasting state (an owner's spec no plan-check has revised), read as unpinned (`specPinOf`).

/**
 * A unit's kind (dev.17) from a spec without a design record: one a dev.16 executor wrote, or one no dev.17 plan-check has
 * designed yet. Read as `module` (src/core/records.ts `specKindOf`).
 */
export function designKindDefault(): 'module' {
  warnDefaulted('spec.design.kind', 'a spec without a design record (written before 1.0.0-dev.17, or not yet designed); its unit reads as kind module');
  return 'module';
}

/**
 * dev.17 (propagation): a plan-check answer without `staleLinks`, recorded before dev.17 (its call consumed after the
 * upgrade). Read as none answered: the arc it ran in recorded no stale set, so it had none to answer.
 */
export function planCheckStaleLinksDefault(): readonly never[] {
  warnDefaulted('plan-check.staleLinks', 'a plan-check answer without staleLinks (launched before 1.0.0-dev.17); read as none answered');
  return [];
}

// 1.0.0-dev.16 → 1.0.0-dev.17 (design pass, DESIGN-1.0.md "Design pass"). Scaffolding: deleted once no arc started on
// 1.0.0-dev.16 is in flight.

/**
 * A plan-check answer without `design` (recorded before the design pass): it carried no design record. Read as none: such an
 * answer is only read back (notes, the round handoff), never judged again.
 */
export function planCheckDesignDefault(): null {
  warnDefaulted('plan-check.design', 'a plan-check answer without a design record (recorded before 1.0.0-dev.17); read as none');
  return null;
}

/**
 * The flaky ledger (dev.17): an arc whose revision in force an executor before 1.0.0-dev.17 applied ran without one, and
 * its flakes were charged as red. Read as an empty ledger at the upgrade: flakes its units met before are not in it.
 */
export function flakyLedgerDefault(): void {
  warnDefaulted('flaky.ledger', 'an arc whose revision in force was applied before 1.0.0-dev.17 has no flaky ledger; it starts empty at the upgrade');
}

// ---------------------------------------------------------------------------------------------------
// Proportional review (dev.17; SCHEMAS.md "Proportional review"). A dev.16 arc is adopted: its gate answers, build answers,
// approvals and judgment inputs predate the ledger, the delta and the docs-only claim. Delete once no arc started on
// 1.0.0-dev.16 is in flight.

/**
 * A gate finding's `defect`, `reraises` and `hunk` (dev.17): absent on an answer a dev.16 gate gave, read as null. Such an
 * answer is never held to the dev.17 rules: its attempt's `judgment-inputs` carry no `review` (`gateReviewOf`).
 */
export function gateFindingReviewDefault(): null {
  warnDefaulted('gate.finding.review', 'a gate finding without defect, reraises or hunk (an answer written before 1.0.0-dev.17); read as null');
  return null;
}

/** A gate answer's `rulings` (dev.17): absent on a dev.16 answer, which was given no disputes; read as none. */
export function gateRulingsDefault(): readonly never[] {
  warnDefaulted('gate.rulings', 'a gate answer without rulings (written before 1.0.0-dev.17); read as none');
  return [];
}

/** A build answer's `docsOnlySince` (dev.17): absent on a dev.16 answer, read as null (no claim: the lanes run as normal). */
export function buildDocsOnlySinceDefault(): null {
  warnDefaulted('build.docsOnlySince', 'a build answer without docsOnlySince (written before 1.0.0-dev.17); read as null');
  return null;
}

/**
 * The review a gate attempt was given (dev.17): absent on a gate attempt a dev.16 executor captured, whose answer is read
 * without the ledger, dispute and delta rules (null), and on a plan-check's.
 */
export function gateReviewOf(inputs: JudgmentInputs): GateReview | null {
  if (inputs.stage !== 'gate' || inputs.review !== undefined) return inputs.review ?? null;
  warnDefaulted('judgment-inputs.review', `gate ${inputs.unit}#${inputs.attempt}: judgment inputs without a review (captured before 1.0.0-dev.17); its answer is read without the ledger rules`);
  return null;
}

/**
 * What an approval approved by blob (dev.17): absent on a dev.16 approval, so the unit's next gate reviews in full and starts
 * its findings ledger empty (no finding of a dev.16 gate is ledgered).
 */
export function approvalBlobsOf(approval: Readonly<{ unit: string; blobs: ApprovalBlobs | null }>): ApprovalBlobs | null {
  if (approval.blobs === null) warnDefaulted(`approval.blobs.${approval.unit}`, `unit ${approval.unit}: an approval without blobs (recorded before 1.0.0-dev.17); its next gate reviews in full`);
  return approval.blobs;
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.16 -> dev.17 (field feedback 2026-10-23, U). dev.17's Claude reader classifies a usage limit in any result
// (not the last alone) and records what a result-less judgment streamed, so it can adapt a dev.16 invocation's files to
// a result other than the one dev.16 wrote. Recovery re-adapts an invocation whose result.json was written but whose done
// was not (a crash between them); the recorded result is the call's reading, so it is adopted as written, warned.
// Delete once no arc started on 1.0.0-dev.16 is in flight (BACKLOG "Scaffolding to delete").

/**
 * The recorded `result.json` of an invocation, adopted when it is what dev.16's reader made of the files HEAD's reads
 * differently, and only then: equal to HEAD's result less what dev.16 did not read, `usage.streamed`; or, where HEAD
 * finds a usage limit in a result before the last and the record names none, equal but for `outcome` and
 * `backendErrors`. Null otherwise: the caller's write-once conflict stands (an input file changed).
 */
export function earlierReaderResultDefault(recorded: ResultFile, fresh: ResultFile): ResultFile | null {
  if (recorded.type !== 'backend' || fresh.type !== 'backend') return null;
  const usage = fresh.usage.kind === 'unavailable' ? { kind: fresh.usage.kind, reason: fresh.usage.reason } : fresh.usage;
  const dev16 = { ...fresh, usage };
  const limit = (r: typeof fresh): boolean => r.backendErrors.some((e) => e.class === 'usage-limit');
  const unclassified = (r: typeof fresh): string => canonicalJson({ ...r, outcome: null, backendErrors: [] });
  const adopted = canonicalJson(recorded) === canonicalJson(dev16) || (limit(fresh) && !limit(recorded) && unclassified(recorded) === unclassified(dev16));
  if (!adopted) return null;
  warnDefaulted('result.earlier-reader', `${recorded.inv}: result.json was adapted by 1.0.0-dev.16's reader; adopted as recorded`);
  return recorded;
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.17 -> dev.18 (deflake scope, 2026-10-23). Delete once no arc started on 1.0.0-dev.17 or earlier is in flight
// (BACKLOG "Scaffolding to delete"); `fix` then becomes required on the problem.

/**
 * A `scope-overlaps-corpus` problem's `fix` (dev.18): absent on one a dev.17 executor wrote (a refused start's
 * `status.rejection.json` or refused exit line, read back by `status` and `start`). Read as the fix dev.18 names
 * (src/phase0/types.ts `scopeOverlapFix`).
 */
export function scopeOverlapFixDefault(unit: UnitId): void {
  warnDefaulted('scope-overlaps-corpus.fix', `unit ${unit}: a scope-overlaps-corpus problem without fix (written before 1.0.0-dev.18); read as the fix dev.18 names`);
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.20 -> dev.21 (unit flakes, 2026-10-24). Delete once no arc started on 1.0.0-dev.20 or earlier is in flight
// (BACKLOG "Scaffolding to delete"); `on` then becomes required on `flake-observed`.

/**
 * A `flake-observed` fact's `on` (dev.21): absent on one an earlier executor wrote, which forgave every unit's flake and
 * minted deflakes from all of them. Read from its red run's spawn (`spawnParent`): a job's, or a candidate's, `tip`; any
 * other unit stage's (its lanes stage, its scaffold) `unit`, so it never mints. A lanes stage's run on the unit's diff base
 * reads `unit` too (its tree is not recorded): such a flake mints only once it is seen on the tip again.
 */
export function flakeOnDefault(fact: FlakyFact, spawnParent: Parent): FlakeOn {
  warnDefaulted('flake-observed.on', 'a flake-observed fact without on (written before 1.0.0-dev.21); read from its red run\'s stage: a candidate\'s or a job\'s is the tip\'s, any other unit stage\'s the unit\'s');
  if (fact.owner.type === 'job') return 'tip';
  if (spawnParent.type !== 'stage') throw new Error(`flake-observed of ${fact.event.red}: a unit's lane run whose spawn's parent is ${spawnParent.type}, not a stage`);
  return spawnParent.stage === 'candidate' ? 'tip' : 'unit';
}

// ---------------------------------------------------------------------------------------------------
// 1.0.0-dev.20 -> dev.21 (GitHub issues removed, 2026-10-24): the executor no longer captures, mirrors or reacts to issues.
// What an earlier executor or plan wrote for them reads as written (byte-preserving) and is never acted on: the
// `issue-intake` and `issues-captured` facts, `checkpoint-inputs.issues`, a `phase0` plan change's `issuesSha256`, a
// revision manifest's `phase0Issues`, a Phase-0 record's `issueCapture` and `intake`, a recorded checkpoint answer's
// `issueIntake`, and an `issue-policy-untrusted` needs-user item (it holds no admission). An amendment an issue's intake
// recorded (`source: issue`) and a finding it opened (lens `issue`) stay what they are. Delete once no arc started on
// 1.0.0-dev.20 or earlier is in flight (BACKLOG "Scaffolding to delete"); the readers then refuse these fields and kinds.

/** A field, fact or item `what` of the removed issues integration: read as written, ignored. Warned once per `what`. */
export function issuesIgnored(what: string): void {
  warnDefaulted(`issues.${what}`, `${what} (the GitHub issues integration, removed in 1.0.0-dev.21) is read as written and ignored`);
}

/** A dev.20 audit-only skip: read as its audit trigger, without changing the record's hashed bytes. */
export function checkpointSkipTriggerOf(s: Readonly<{ trigger?: CheckpointTrigger; audit?: JobId }>): CheckpointTrigger {
  if (s.trigger !== undefined) return s.trigger;
  if (s.audit === undefined) throw new Error('a checkpoint skip without its trigger or legacy audit');
  warnDefaulted('checkpoint-skipped.trigger', 'an audit-only checkpoint skip (before milestone cadence); read as its audit trigger');
  return { type: 'audit', job: s.audit };
}

/**
 * Before the 2026-10-24 summit effort change, builtin summit seats hashed xhigh. Status aliases those recorded revs
 * to today's bindings; a repo's explicit class rebind keeps its own effort. Delete once no pre-change arc is in flight.
 */
export function summitXhighTriple(triple: Triple): Triple {
  return { ...triple, effort: 'xhigh' };
}

/** A lane or launch without timeoutMin retains the previous release's six-hour backstop. */
export function laneTimeoutDefault(): void {
  warnDefaulted('lane.timeoutMin', 'a lane without timeoutMin; retains the six-hour deadline backstop');
}

/** Ordering metadata was absent on older parks and judgment answers: never infer a wait from their prose. */
export function orderingDefault(): null {
  warnDefaulted('ordering', 'a park or judgment answer without ordering metadata; no automatic blocker wake');
  return null;
}

// Calibrated resources: absent measurement keys and reservation bases on earlier records stay unmeasured.
export function spawnCpuKeyOf(spawn: Readonly<{ cpuKey?: Sha256Hex }>): Sha256Hex | null {
  if (spawn.cpuKey !== undefined) return spawn.cpuKey;
  warnDefaulted('proc.spawn.cpuKey', 'a spawn without a CPU calibration key; excluded from calibration');
  return null;
}

export function reservationCpuBasisOf(expect: Readonly<{ cpuBasis?: CpuBasis }>): CpuBasis | null {
  if (expect.cpuBasis !== undefined) return expect.cpuBasis;
  warnDefaulted('resource.transition.cpuBasis', 'a reservation without a CPU basis; its recorded tokens remain authoritative');
  return null;
}

export function environmentResourcesDefault(): readonly never[] {
  warnDefaulted('environment.resources', 'an environment without resources; read as []');
  return [];
}

export function schedulerPressureBlockedDefault(): false {
  warnDefaulted('sched.pressureBlocked', 'an earlier scheduler view has no admission brake; read as false');
  return false;
}
