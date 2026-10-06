// TEMPORARY SCAFFOLDING (SCHEMAS.md "Record evolution"): read-time defaults for records written by the previous
// release (1.0.0-dev.6, the only one adopted: OR-L4), so HEAD adopts an arc it started. Delete each default (and its
// BACKLOG entry) once no arc started on that release is in flight. Nothing here rewrites a file.
//
// Each defaulted kind warns once per process on stderr (the executor's stderr is the supervisor's
// `supervisor.<token>.err` in the host dir).
import type { ClassCatalogue } from '../routing/classes.ts';
import type { CensusEntry, ClassifiedAdmit, Conversion, Obligations } from '../holistic/types.ts';
import type { MutantOf, RevisionSource } from './events.ts';
import type { FindingId, LaneId } from './ids.ts';

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
 * A checkpoint answer's `corpusAmendments` and `issueIntake` (M4a): a recorded dev.6 answer (`upgrade.dev6-checkpoint-open`)
 * has neither, read as none. Step B1 makes both required of the model's schema.
 */
export function checkpointOutputM4Default(key: 'corpusAmendments' | 'issueIntake'): readonly never[] {
  warnDefaulted(`checkpoint.${key}`, `a checkpoint answer without ${key} (written before 1.0.0-dev.7); read as none`);
  return [];
}

/**
 * A checkpoint `admit` op's `targets` (M4a rev 3, LR-m): absent on an answer recorded before it; read as none, so the
 * admit classifies on its structural targets alone (the rules of the obligations it declares, delivers or repairs).
 */
export function admitTargetsDefault(): readonly never[] {
  warnDefaulted('checkpoint.admit.targets', 'an admit op without targets (a checkpoint answer written before LR-m); read as none');
  return [];
}

/** A split child's `rule` (M4a): absent on a recorded dev.6 answer, whose children are docRef-anchored; read as null. */
export function splitChildRuleDefault(): null {
  warnDefaulted('checkpoint.splitChild.rule', 'a split child without rule (a checkpoint answer written before 1.0.0-dev.7); read as null');
  return null;
}

/**
 * A numbered-id list in plain string order (`["T-10","T-9"]`): how every release before 1.0.0-dev.7 validated and wrote
 * them, so a dev.6 record, an arc started before the fix, or a vision, obligations, ruling or Phase-0 file written for
 * them may hold one. It reads as written (byte-preserving); everything written now is in canonical order (`idsAscending`).
 */
export function legacyIdOrder(path: string): void {
  warnDefaulted('ids.string-order', `${path}: a numbered-id list in string order (written before 1.0.0-dev.7); read as written`);
}

/**
 * The class catalogue 1.0.0-dev.6 bound (frontier Opus 5.5 `high`, summit Fable 5.1 `high`), kept only so `status`
 * can join a dev.6 meter row's recorded `routingRev` (K12, src/status.ts `dev6RevAlias`). OR-L3: nothing routes under
 * it; HEAD binds every revision through `CLASS_CATALOGUE` (src/routing/classes.ts). A dev.6 dispatch record needs no
 * decoder: its `implementerSeatRev` reads back through `seatTripleOf` (src/pipeline/dispatch.ts) like any other.
 */
export const DEV6_CLASS_CATALOGUE: ClassCatalogue = {
  default: {
    efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    frontier: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    summit: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' },
  },
  'claude-only': {
    efficient: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    frontier: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    summit: { backend: 'claude', model: 'claude-fable-5-1', effort: 'high' },
  },
};

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
