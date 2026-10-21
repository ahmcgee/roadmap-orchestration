// The shared Phase-0 startup rows (M4a "`roadmap phase0 check`", step C1): one rule, run by `start` (src/preflight/
// checks.ts), `apply` (src/commands/apply.ts) and `roadmap phase0 check` (src/commands/phase0.ts, both modes).
// Synchronous: git and gh run as spawnSync reads.
//
//   1. corpus      the pin re-derived from the guide committed at the plan's baseline (LR-A1-1), its source at the pinned
//                  commit and the baseline's rules registry, and required equal (`corpus-invalid`: pin-drift, rule-reused,
//                  rule-retired-reappears, rules-in-vision, guide-missing, source-unreadable, source-remote-mismatch); for
//                  a same-repo source, no unit scope and no plan contract overlapping the corpus file set (every pinned
//                  file plus every path matching root/include, R32): `scope-overlaps-corpus`, `contract-overlaps-corpus`.
//                  Malformed corpus text throws `CorpusFormatError` (LR-A1-2), never a row.
//   2-3. census    one state per active pinned rule, none dangling, every obligation's rule resolved: a binding one's
//                  active, a waived or deferred one's active or retired (LR-C1-2; src/holistic/rederive.ts
//                  `censusProblems`), a retired one's not asked (2026-10-21; 1.0.0-dev.16). An exempt obligation need not
//                  be in the census. A corpus arc names its obligations file (LR-0a-2).
//                  Then the pack's specs against the census (M4a rev 3, H3, F07; `spec-census-mismatch`, the one
//                  predicate src/holistic/rederive.ts `specCensusMismatches`, which the classifier also runs on every
//                  revision: run 10, C).
//   4. debt        every open item of the baseline's `debt.md` block dispositioned (`debt-undispositioned`); a third
//                  `keep` of an item kept in each of the two previous arcs needs a question whose text names the item
//                  (`debt-kept-twice-unasked`); question ids against the chain closure (`question-reused`, H23).
//   5. amendments  every amendment of the previous arc's verified ref dispositioned (`amendment-undispositioned`);
//                  intake against the kept capture the record names (`capture-missing`, `intake-missing`,
//                  `intake-unknown`, `intake-duplicate`, H8).
//   5a. answers    (a fresh start, live) every owner answer in force in the answer log (`roadmap answer`, src/answers.ts)
//                  applied: the record marks its question `answered` with its text, or, for a question the record
//                  does not carry, the newest earlier arc of the chain carrying it does (`answer-unapplied`).
//   6. vision      confirmed against the pin (`vision-unconfirmed`, src/holistic/vision.ts).
//   7. forge       (live) the issue policy trusted (`issue-policy-untrusted`, OR-L6) and the capture's repo the one
//                  `gh repo view` resolves now (`capture-foreign`).
//   8. chain       (a fresh start, live) K, the baseline rules and the ack limit (src/chain.ts; H12, R11).
//   9. tree        (live) `.roadmap/{vision.json, corpus.md, config.json}` equal to their blobs at HEAD (`tree-uncommitted`,
//                  K18), for every arc.
//  10. references  (advisory, never a rejection; every arc, every mode; scope growth 2026-10-15) per unit whose spec declares
//                  `removes`: each entry searched for literally (`git grep -l -F`) at the integration tip (the baseline before
//                  the branch exists), the hits inside the unit's scope (plan and spec) or under `.roadmap/` dropped:
//                  `scope-references-outside{unit, removed, referrers}`, the referrers being the patterns its scope lacks
//                  (`scopeReferences`, which plan-check reads too).
//  11. plan defects (every mode; plan defects 2026-10-16) `plan-defect{defects}`, what no build round could fix:
//                  - derived files (every arc): an output inside the scope of a unit that covers none of its entry's
//                    sources (`derived-output-owned`); for a same-repo corpus, an output that may reach the corpus file
//                    set (`derived-overlaps-corpus`).
//                  - witnesses (a corpus arc's binding obligations): each declared witness file inside its lane
//                    (`witness-not-in-lane`, src/holistic/witnessfiles.ts `laneMisses`), and present at the integration
//                    tip (the baseline before the branch exists) or inside the effective scope of a deliverer or a unit
//                    a deliverer runs after, transitively (`witness-file-unreachable`). At a fresh start every arc lane
//                    declares `testPaths` and every binding witness `files` (`lane-test-paths-undeclared`,
//                    `witness-files-undeclared`). Otherwise each lane and witness is judged on its own (2026-10-21;
//                    1.0.0-dev.16): a declared one is checked, an undeclared one (an arc started before 2026-10-16) is
//                    read as undeclared with a logged warning, whatever the others declare.
//                  - milestone references (every arc; 2026-10-21, 1.0.0-dev.16): a milestone whose reference dirs hold more
//                    than `MILESTONE_REFERENCES_BUDGET` bytes of text at the integration tip (the baseline before the branch
//                    exists), naming its largest text files (`milestone-references-oversize`). Every such file is inlined
//                    whole into each prompt that reads the milestone, so an oversize set parks its first paid call
//                    `context-exceeded` (the field case: a 1.5 MB compiled bundle under a design dir, a 3.3 MB build prompt).
//  12. vision leak (an apply only; owner ruling 2026-10-16) the vision of the apply's files rebased onto the files in force
//                  (src/input/rebase.ts) differs from the vision in force, so the owner's vision file changed, and the
//                  apply does not declare a vision edit (`apply --vision-edit`): `vision-leak{inForce, committed,
//                  draft}` (`visionLeak`). The next arc's vision is drafted in `<inputs>/_next/vision.md` and reaches
//                  `.roadmap/vision.json` only in the between-arc window, so a draft committed there mid-arc never rides
//                  along with an unrelated apply. Not one of `phase0Rows`: it reads the revision in force, which only a
//                  running arc has.
//  13. regenerate (advisory, never a rejection; every arc, every mode; dev.12) a derived entry declaring no `regenerate` whose
//                  outputs a live unit's effective scope may reach: `derived-unregenerated{outputs, units}`. Its outputs are
//                  checked by no regeneration, so a hand edit in them is caught only by a reader (src/input/derived.ts).
//  14. design first (advisory, never a rejection; every arc, every mode; dev.13) a live unit of a milestone that does not run
//                  after the milestone's design unit, transitively: `milestone-unit-before-design{milestone, unit, design}`.
//  15. milestones (every arc, every mode; dev.13) milestones on a plan without `holistic`: `milestones-need-holistic`.
//                  `walk-tools-missing` (the bring-up programs and the walkthrough MCP servers) is not one of these rows: its
//                  smoke is a backend call (see `milestonesNeedHolisticRows`).
// A record that names something absent (a debt disposition of no open item, a promote to a unit the plan does not
// hold, a resolve by a ruling the ledger does not hold active, an intake act on an unknown unit or rule, an amendment
// disposition of no amendment) is `plan-invalid{schema}` naming it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { answerLog, latestAnswers, refQuestions, unappliedOf } from '../answers.ts';
import { type ArcRef, amendmentsOf, chainBack, committedAcks, completedHeadOf, previousIncomplete, questionClosure, quotaOf } from '../chain.ts';
import { type ArcId, type DebtId, type IssueId, type MilestoneId, type Sha256Hex, type UnitId, issueId, phaseQuestionSeq, sha, sha256 } from '../core/ids.ts';
import { type SpecM1, specRemoves } from '../core/records.ts';
import { sha256Hex } from '../core/json.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, type RepoPattern, absPath, matchesPattern, repoPath, repoPattern } from '../core/values.ts';
import { readGuideBytes } from '../corpus/guide.ts';
import { rederivePin } from '../corpus/pin.ts';
import { EMPTY_REGISTRY, registryAt } from '../corpus/registry.ts';
import type { OpenedSource } from '../corpus/source.ts';
import { type CorpusGuide, type CorpusPin, activeRules, parseCorpusPin } from '../corpus/types.ts';
import { EMPTY_LEDGER, keptInEachOfLastTwoArcs, openItems } from '../debt/ledger.ts';
import type { DebtLedger } from '../debt/types.ts';
import { DEBT_DOC, parseDebtBlock } from '../docs/debt.ts';
import { resolveRepo } from '../forge/gh.ts';
import { queryPolicy } from '../forge/policy.ts';
import { trusted } from '../forge/trust.ts';
import { type IssueCapture, parseIssueCapture, sameRepo } from '../forge/types.ts';
import { git, gitCommonDir, gitRun } from '../git/git.ts';
import { censusProblems, specCensusMismatches } from '../holistic/rederive.ts';
import {
  type Obligations, type PlanDefect, type Vision, isExempt, parseObligations, parseVision,
} from '../holistic/types.ts';
import { laneMisses } from '../holistic/witnessfiles.ts';
import { laneTestPathsUndeclared, witnessFilesUndeclared } from '../core/upgrade.ts';
import { coversSource, derivedWidening } from '../input/derived.ts';
import { visionUnconfirmed } from '../holistic/vision.ts';
import { mayOverlap } from '../input/classify.ts';
import { isLive } from '../preflight/lanerows.ts';
import { type PlanM1, type PlanUnit, derivedOf, designUnitOf, milestonesNeedHolistic, milestonesOf } from '../input/plan.ts';
import type { StartupRejection } from '../preflight/startup.ts';
import type { RepoConfig } from '../routing/layers.ts';
import { type Ruling, type RulingCorpus, parseRulings } from '../spec/rulings.ts';
import { SpecFileError, parseSpec } from '../spec/spec.ts';
import type { CorpusInForce, InputFiles } from '../input/inforce.ts';
import { type ChainProblem, type CorpusProblem, type Phase0Problem, type Phase0Record, type PhaseQuestion, parsePhase0Record } from './types.ts';

type Row<K extends StartupRejection['kind']> = Extract<StartupRejection, { kind: K }>;

/**
 * Which live rows run: the answers (5a) and the chain (8), a fresh start's; the forge (7) and the tree (9). Rows 1-6 and
 * 10-11 always run; `fresh` makes row 11 require declared test paths and witness files.
 */
export type Phase0Mode = Readonly<{ forge: boolean; chain: boolean; answers: boolean; tree: boolean; fresh: boolean }>;
/** `start` of a fresh arc and `phase0 check --plan`: everything. */
export const FRESH_START: Phase0Mode = { forge: true, chain: true, answers: true, tree: true, fresh: true };
/** `start` of an arc with a plan in force: no chain or answer rows (it is not a new start). */
export const RESTART: Phase0Mode = { forge: true, chain: false, answers: false, tree: true, fresh: false };
/** `apply`: no forge, no chain, no answers (an answer that comes mid-arc is applied by an apply, not refused by one). */
export const APPLY: Phase0Mode = { forge: false, chain: false, answers: false, tree: true, fresh: false };
/** `phase0 check --from-ref`: the recorded closure alone (K20). */
export const FROM_REF: Phase0Mode = { forge: false, chain: false, answers: false, tree: false, fresh: false };

/** What the rows read of a plan's inputs: bytes as the files (or a ref) hold them, null when absent. */
export type Phase0Input = Readonly<{
  repo: AbsPath;
  plan: PlanM1;
  /** The repo config read now (K for the chain rows); null when none. */
  config: RepoConfig | null;
  /** Where the inputs are named from, for `plan-invalid` details (a plan file, or `refs/roadmap/<arc>`). */
  where: string;
  pin: Buffer | null;
  guide: Buffer | null;
  phase0: Buffer | null;
  capture: Buffer | null;
  obligations: Buffer | null;
  vision: Buffer | null;
  /** Per unit of the plan: its spec's bytes, null when the file does not exist (the spec rows report it). */
  specs: ReadonlyMap<UnitId, Buffer | null>;
  /** The rulings ledger the inputs carry (a `resolve` disposition names an active ruling of it). */
  ledger: readonly Ruling[];
}>;

/**
 * Row 10 (scope growth, 2026-10-15), advisory: files outside a unit's scope that still name something its spec `removes`.
 * `referrers` ascending, non-empty: the patterns the unit's scope would need to keep them working.
 */
export type ScopeReference = Readonly<{ kind: 'scope-references-outside'; unit: UnitId; removed: string; referrers: readonly RepoPath[] }>;

/**
 * Row 13 (dev.12), advisory: a derived entry declaring no `regenerate` whose outputs are in the effective scope of `units`
 * (ascending, live ones): nothing checks that those outputs are what their generator writes, so a hand edit in them is
 * caught only by a reader.
 */
export type DerivedUnregenerated = Readonly<{ kind: 'derived-unregenerated'; outputs: readonly RepoPattern[]; units: readonly UnitId[] }>;

/**
 * dev.13, advisory: a unit of milestone `milestone` that does not descend (through `after`, transitively) from the
 * milestone's design unit `design`, so it may build before the design it builds to exists.
 */
export type MilestoneUnitBeforeDesign = Readonly<{ kind: 'milestone-unit-before-design'; milestone: MilestoneId; unit: UnitId; design: UnitId }>;

/** A Phase-0 advisory: never a refusal (rows 10, 13 and 14, dev.13's `milestone-unit-before-design`). */
export type Phase0Advisory = ScopeReference | DerivedUnregenerated | MilestoneUnitBeforeDesign;

/**
 * The rows found, and on a clean re-derivation the source the pin read (its files are what a start or apply keeps).
 * `advisories`: rows 10's, 13's and 14's, which never refuse.
 */
export type Phase0Outcome = Readonly<{ rows: readonly StartupRejection[]; opened: OpenedSource | null; pin: CorpusPin | null; advisories: readonly Phase0Advisory[] }>;

/** The rows' input over files as a start or an apply reads them (the ledger's rulings parsed; it loads, group 1 checked). */
export function phase0InputOf(files: InputFiles, config: RepoConfig | null): Phase0Input {
  const c = files.corpus;
  return {
    repo: files.repo, plan: files.plan, config, where: files.planFile,
    pin: c?.pin.bytes ?? null, guide: c?.guide.bytes ?? null, phase0: c?.phase0.bytes ?? null, capture: c?.capture?.bytes ?? null,
    obligations: files.obligations?.bytes ?? null, vision: files.vision?.bytes ?? null,
    specs: new Map([...files.specs].map(([unit, file]) => [unit, file.bytes])),
    ledger: files.ledger.bytes === null ? [] : parseRulings(files.ledger.bytes.toString('utf8'), files.ledger.path),
  };
}

const schemaRow = (field: string, detail: string): Row<'plan-invalid'> => ({ kind: 'plan-invalid', problem: { type: 'schema', field, detail } });

/** Parses `bytes` with `parse`, or pushes why it does not load (absent included). */
function load<T>(rows: StartupRejection[], field: string, where: string, bytes: Buffer | null, parse: (v: unknown) => T): T | null {
  if (bytes === null) {
    rows.push(schemaRow(field, `${where}: absent`));
    return null;
  }
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    rows.push(schemaRow(field, `${where}: ${error.message}`));
    return null;
  }
}

/** The shared rows over `input` (one rule for start, apply and `phase0 check`). */
export function phase0Rows(input: Phase0Input, mode: Phase0Mode): Phase0Outcome {
  const rows: StartupRejection[] = [];
  if (mode.tree) rows.push(...treeUncommitted(input.repo));
  const { plan } = input;
  rows.push(...milestonesNeedHolisticRows(plan));
  const advisories = [...referenceRows(input), ...derivedUnregenerated(plan), ...milestoneUnitsBeforeDesign(plan)];
  const defects: PlanDefect[] = [...derivedOwned(plan), ...referencesOversize(input.repo, plan)];
  if (plan.target !== 'corpus') {
    if (defects.length > 0) rows.push({ kind: 'plan-defect', defects });
    return { rows, opened: null, pin: null, advisories };
  }
  const where = (what: string): string => `${input.where} (${what})`;
  if (plan.holistic.obligations === undefined) rows.push(schemaRow('plan.holistic.obligations', 'a corpus arc names its obligations file (the census lives there)'));
  const pin = load(rows, 'plan.corpus', where('the corpus pin'), input.pin, parseCorpusPin);
  const duplicates = duplicateIntake(input.phase0);
  const record = duplicates.length > 0 ? null : load(rows, 'plan.phase0', where('the Phase-0 record'), input.phase0, parsePhase0Record);
  const obligations = plan.holistic.obligations === undefined ? null : load(rows, 'plan.holistic.obligations', where('the obligations'), input.obligations, parseObligations);
  const vision = load(rows, '.roadmap/vision.json', where('the vision record'), input.vision, parseVision);
  const corpus: CorpusProblem[] = [];
  const p0: Phase0Problem[] = duplicates.map((issue) => ({ type: 'intake-duplicate', issue }));
  let opened: OpenedSource | null = null;
  let guide: CorpusGuide | null = null;

  // 1. The pin re-derived, and the corpus file set kept clear of units and contracts.
  if (pin !== null) {
    const read = input.guide === null ? null : readGuideBytes(input.guide);
    guide = read?.guide ?? null;
    const re = rederivePin(input.repo, pin, read, registryAt(input.repo, plan.baseline) ?? EMPTY_REGISTRY);
    if (re.kind === 'refused') corpus.push(...re.problems);
    else opened = re.opened;
    if (guide !== null && guide.source.kind === 'same-repo') {
      corpus.push(...overlapProblems(plan, pin, guide));
      defects.push(...derivedOnCorpus(plan, corpusFileSet(pin, guide)));
    }
  }
  // 2-3. The census.
  if (pin !== null && obligations !== null) {
    if (obligations.census === undefined) rows.push(schemaRow('plan.holistic.obligations', `${where('the obligations')}: a corpus arc's obligations are rule-anchored with a census`));
    else {
      p0.push(...censusProblems({ ...obligations, census: obligations.census }, pin));
      p0.push(...specCensusMismatches(parsedSpecs(input), obligations, obligations.census));
    }
  }
  // 11. The witnesses against their lanes and deliverers.
  if (obligations !== null) defects.push(...witnessDefects(input, obligations, mode.fresh));
  // 4-5. Debt, questions, amendments, intake.
  const previous = plan.chain === undefined ? null : chainBack(input.repo, plan.chain.previousArc);
  let capture: IssueCapture | null = null;
  if (record !== null) {
    p0.push(...debtProblems(input, record, rows));
    p0.push(...questionProblems(record, previous?.arcs ?? []));
    p0.push(...amendmentProblems(record, previous?.arcs.at(-1) ?? null, rows));
    capture = captureOf(input, record, p0, rows, where('the issue capture'));
    if (capture !== null) p0.push(...intakeProblems(record, capture));
    actedReferences(record, plan, pin, rows);
    if (mode.answers) p0.push(...answerProblems(input.repo, record, previous?.arcs ?? []));
  }
  // 6. The vision confirmed against the pin.
  if (vision !== null && pin !== null) {
    try {
      const v = visionUnconfirmed(vision, pin);
      if (v !== null) rows.push(v);
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      rows.push(schemaRow('.roadmap/vision.json', `${where('the vision record')}: ${error.message}`));
    }
  }
  if (corpus.length > 0) rows.push({ kind: 'corpus-invalid', problems: corpus });
  // 7. The forge, live: the policy, and the capture's repo.
  if (mode.forge) {
    const identity = resolveRepo(input.repo);
    const trust = trusted(queryPolicy(input.repo, identity));
    if (trust.kind === 'untrusted') rows.push({ kind: 'issue-policy-untrusted', ...trust.untrusted });
    if (capture !== null && !sameRepo(capture.repo, identity)) p0.push({ type: 'capture-foreign', expected: identity, actual: capture.repo });
  }
  if (p0.length > 0) rows.push({ kind: 'phase0-invalid', problems: p0 });
  if (defects.length > 0) rows.push({ kind: 'plan-defect', defects });
  // 8. The chain, at a fresh start.
  if (mode.chain) {
    const c = chainRow(input, guide, previous?.arcs ?? [], previous?.missing ?? null);
    if (c !== null) rows.push({ kind: 'chain-invalid', problem: c });
  }
  return { rows, opened: rows.length === 0 ? opened : null, pin, advisories };
}

// ---------------------------------------------------------------------------------------------------
// 1. Corpus overlap (R32)

/** A corpus path under its source's `root`: its product-repo path for a `same-repo` corpus. */
export const underRoot = (root: RepoPath, path: string): string => (root === '.' ? path : `${root}/${path}`);

/** A same-repo corpus's file set: its pinned files' product paths, and its include patterns rooted. */
export function corpusFileSet(pin: CorpusPin, guide: CorpusGuide): Readonly<{ files: readonly RepoPath[]; patterns: readonly RepoPattern[] }> {
  const root = guide.source.root;
  return { files: pin.files.map((f) => repoPath(underRoot(root, f.path))), patterns: guide.include.map((p) => repoPattern(underRoot(root, p))) };
}

/** Whether a product path is in the corpus file set: a pinned file, or a path an include pattern matches. */
export const inCorpusSet = (set: ReturnType<typeof corpusFileSet>, path: RepoPath): boolean =>
  set.files.includes(path) || set.patterns.some((p) => matchesPattern(path, p));

/** What `validateRuling` reads of a corpus arc's pin in force: its active rules, and the same-repo corpus file set (R32). */
export function rulingCorpusOf(c: CorpusInForce): RulingCorpus {
  const guide = readGuideBytes(c.guide.bytes).guide;
  const set = guide.source.kind === 'same-repo' ? corpusFileSet(c.pin.value, guide) : null;
  return {
    rules: new Map(c.pin.value.rules.map((r) => [r.id, r.textSha256])),
    inFileSet: (path) => set !== null && inCorpusSet(set, path),
  };
}

/** Whether scope pattern `s` may reach the corpus file set: it matches a pinned file, or may overlap an include pattern (R32). */
export const scopeOverlapsCorpus = (set: ReturnType<typeof corpusFileSet>, s: RepoPattern): boolean =>
  set.files.some((f) => matchesPattern(f, s)) || set.patterns.some((p) => mayOverlap(s, p));

function overlapProblems(plan: PlanM1, pin: CorpusPin, guide: CorpusGuide): readonly CorpusProblem[] {
  const set = corpusFileSet(pin, guide);
  const out: CorpusProblem[] = [];
  for (const u of plan.units) {
    if (u.scope.some((s) => scopeOverlapsCorpus(set, s))) out.push({ type: 'scope-overlaps-corpus', unit: u.id });
  }
  for (const c of plan.contracts) if (inCorpusSet(set, c)) out.push({ type: 'contract-overlaps-corpus', path: c });
  return out;
}

// ---------------------------------------------------------------------------------------------------
// 10. References outside a unit's scope (scope growth, 2026-10-15)

/**
 * The files at `at` outside `scope` (and outside `.roadmap/`) that still name each of `removes`, searched for literally
 * (`git grep -l -F`); one entry per removed string with referrers. The plan-check of the unit reads the same scan.
 */
export function scopeReferences(repo: AbsPath, at: string, unit: UnitId, scope: readonly RepoPattern[], removes: readonly string[]): readonly ScopeReference[] {
  return removes.flatMap((removed) => {
    const r = gitRun(repo, ['grep', '-l', '-z', '-F', '-e', removed, at, '--'], { okCodes: [0, 1] });
    const referrers = [...new Set(r.stdout.split('\0').filter((x) => x !== '').map((hit) => repoPath(hit.slice(at.length + 1))))]
      .filter((p) => !p.startsWith('.roadmap/') && !scope.some((s) => matchesPattern(p, s)))
      .sort();
    return referrers.length === 0 ? [] : [{ kind: 'scope-references-outside' as const, unit, removed, referrers }];
  });
}

/** The commit row 10 searches: the integration tip, or the baseline before the integration branch exists. */
export function referenceCommit(repo: AbsPath, plan: PlanM1): string {
  const tip = gitRun(repo, ['rev-parse', '--verify', '-q', `refs/heads/${plan.integrationBranch}^{commit}`], { okCodes: [0, 1] });
  return tip.code === 0 ? tip.stdout.trim() : plan.baseline;
}

/** Row 10 over the plan's units whose spec loads and declares `removes`. */
function referenceRows(input: Phase0Input): readonly ScopeReference[] {
  const specs = parsedSpecs(input).filter((s) => specRemoves(s).length > 0);
  if (specs.length === 0) return [];
  const at = referenceCommit(input.repo, input.plan);
  return specs.flatMap((spec) => {
    const unit = input.plan.units.find((u) => u.id === spec.unit);
    if (unit === undefined) throw new Error(`a parsed spec of ${spec.unit}, which the plan does not hold`);
    return scopeReferences(input.repo, at, unit.id, [...unit.scope, ...spec.scope], specRemoves(spec));
  });
}

// ---------------------------------------------------------------------------------------------------
// 11. Plan defects (2026-10-16)

/** A unit's effective scope as its dispatch would pin it: its plan scope and the derived outputs it takes in. */
const unitEffectiveScope = (plan: PlanM1, u: PlanUnit): readonly RepoPattern[] => [...u.scope, ...derivedWidening(plan, u.scope)];

/** Each derived output inside the scope of a unit that covers none of its entry's sources. */
function derivedOwned(plan: PlanM1): readonly PlanDefect[] {
  return derivedOf(plan).flatMap((d) => d.outputs.flatMap((output) => plan.units
    .filter((u) => !coversSource(u.scope, d) && u.scope.some((s) => mayOverlap(s, output)))
    .map((u): PlanDefect => ({ type: 'derived-output-owned', output, unit: u.id }))));
}

/** Row 13: each derived entry without `regenerate` whose outputs a live unit's effective scope may reach. */
function derivedUnregenerated(plan: PlanM1): readonly DerivedUnregenerated[] {
  return derivedOf(plan).filter((d) => d.regenerate === undefined).flatMap((d) => {
    const units = plan.units.filter((u) => isLive(plan, u) && unitEffectiveScope(plan, u).some((s) => d.outputs.some((o) => mayOverlap(s, o)))).map((u) => u.id).sort();
    return units.length === 0 ? [] : [{ kind: 'derived-unregenerated' as const, outputs: d.outputs, units }];
  });
}

/**
 * Row 14 (dev.13), advisory: each live unit of a milestone that does not run after the milestone's design unit (through
 * `after`, transitively), so it may build before the design it builds to exists. A supplied design has no unit.
 */
function milestoneUnitsBeforeDesign(plan: PlanM1): readonly MilestoneUnitBeforeDesign[] {
  return milestonesOf(plan).flatMap((m) => {
    const design = designUnitOf(m);
    if (design === null) return [];
    return plan.units.filter((u) => m.units.includes(u.id) && isLive(plan, u) && !withDependencies(plan, u.after).some((d) => d.id === design))
      .map((u) => ({ kind: 'milestone-unit-before-design' as const, milestone: m.id, unit: u.id, design }));
  });
}

/**
 * The text a milestone's reference dirs may inline into a prompt (2026-10-21; 1.0.0-dev.16). Every text file under them goes
 * whole into each plan-check, build and gate prompt of the milestone's units and into its walkthrough, beside the spec, the
 * contracts, the architecture doc and the session's own reads. A design reference is prose, tokens and wireframes a model
 * reads whole; 512 KiB (about 150K tokens) is far more than one needs and leaves most of a 1M-token window for the rest,
 * so a set over it almost surely carries build output or comps (the field case's 1.5 MB bundle and 330 KB of comps).
 * Code knows no model's window, so this is that judgement, not a measurement: a set under it can still outgrow a smaller
 * window, which the call's `context-exceeded` park then names.
 */
export const MILESTONE_REFERENCES_BUDGET = 524_288;

/** How many of an oversize set's largest files the defect names. */
const LARGEST_NAMED = 5;

/**
 * Every file under the reference dirs `dirs` at `tip`, in path order, once each: its text, or null for a binary file (a NUL
 * in its first 8000 bytes, git's own rule). A dir absent at `tip` has none. What a prompt inlines (src/pipeline/stages.ts
 * `unitMilestones`, src/walk/walk.ts) and what row 11 measures.
 */
export function referenceFiles(repo: AbsPath, tip: string, dirs: readonly RepoPath[]): readonly Readonly<{ path: RepoPath; text: string | null }>[] {
  if (dirs.length === 0) return [];
  const paths = git(repo, ['ls-tree', '-r', '-z', '--name-only', tip, '--', ...new Set(dirs)]).split('\0').filter((f) => f !== '').sort();
  return paths.map((p) => {
    const text = git(repo, ['cat-file', 'blob', `${tip}:${p}`]);
    return { path: repoPath(p), text: text.slice(0, 8000).includes('\0') ? null : text };
  });
}

/** Row 11: each milestone whose reference dirs hold more text at the tip than `MILESTONE_REFERENCES_BUDGET`. */
function referencesOversize(repo: AbsPath, plan: PlanM1): readonly PlanDefect[] {
  const milestones = milestonesOf(plan);
  if (milestones.length === 0) return [];
  const at = referenceCommit(repo, plan);
  return milestones.flatMap((m): PlanDefect[] => {
    const sized = referenceFiles(repo, at, m.references).flatMap((f) => (f.text === null ? [] : [{ path: f.path, bytes: Buffer.byteLength(f.text, 'utf8') }]));
    const bytes = sized.reduce((n, f) => n + f.bytes, 0);
    if (bytes <= MILESTONE_REFERENCES_BUDGET) return [];
    const largest = [...sized].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, LARGEST_NAMED);
    return [{ type: 'milestone-references-oversize', milestone: m.id, bytes, budget: MILESTONE_REFERENCES_BUDGET, largest }];
  });
}

/** Each derived output that may reach a same-repo corpus file set. */
const derivedOnCorpus = (plan: PlanM1, set: ReturnType<typeof corpusFileSet>): readonly PlanDefect[] =>
  [...new Set(derivedOf(plan).flatMap((d) => d.outputs))].filter((o) => scopeOverlapsCorpus(set, o)).map((output) => ({ type: 'derived-overlaps-corpus', output }));

/** `units` and every unit they run after, transitively. */
function withDependencies(plan: PlanM1, units: readonly UnitId[]): readonly PlanUnit[] {
  const seen = new Set<UnitId>();
  const visit = (id: UnitId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const d of plan.units.find((u) => u.id === id)?.after ?? []) visit(d);
  }
  units.forEach(visit);
  return plan.units.filter((u) => seen.has(u.id));
}

/**
 * Row 11's witness half over the obligations (binding ones: active, not exempt). A fresh start requires every lane's
 * `testPaths` and every witness's `files`; otherwise each is judged on its own (2026-10-21): what is declared is checked,
 * what is not is the logged-warning read of an arc started before 2026-10-16, so a checkpoint that declares one witness's
 * files never turns the arc's other witnesses into defects.
 */
function witnessDefects(input: Phase0Input, obligations: Obligations, fresh: boolean): readonly PlanDefect[] {
  const { plan } = input;
  const binding = obligations.obligations.filter((o) => o.state.type === 'active' && !isExempt(o) && o.witness !== null);
  const out: PlanDefect[] = [];
  for (const lane of obligations.lanes) {
    if (lane.testPaths !== undefined) continue;
    if (fresh) out.push({ type: 'lane-test-paths-undeclared', lane: lane.id });
    else laneTestPathsUndeclared(lane.id);
  }
  let tip: ReadonlySet<string> | null = null;
  const atTip = (file: RepoPath): boolean => {
    tip ??= new Set(git(input.repo, ['ls-tree', '-r', '-z', '--name-only', referenceCommit(input.repo, plan)]).split('\0').filter((f) => f !== ''));
    return tip.has(file);
  };
  for (const o of binding) {
    const w = o.witness!;
    if (w.files === undefined) {
      if (fresh) out.push({ type: 'witness-files-undeclared', obligation: o.id });
      else witnessFilesUndeclared(o.id);
      continue;
    }
    // A witness on no arc lane is the classifier's refusal (every revision), not this row's.
    const lane = obligations.lanes.find((l) => l.id === w.lane);
    const reach = withDependencies(plan, o.deliveredBy).map((u) => unitEffectiveScope(plan, u));
    for (const file of w.files) {
      const missing = lane === undefined ? null : laneMisses(lane, file);
      if (missing !== null) out.push({ type: 'witness-not-in-lane', obligation: o.id, lane: w.lane, file, missing });
      if (!atTip(file) && !reach.some((scope) => scope.some((p) => matchesPattern(file, p)))) {
        out.push({ type: 'witness-file-unreachable', obligation: o.id, file, units: o.deliveredBy });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// 3. The pack's specs against the census (H3)

/**
 * The specs of the plan's units that parse, in plan order: one absent or unparsable is the spec rows' to report, so the
 * path given to the parser is never shown.
 */
function parsedSpecs(input: Phase0Input): readonly SpecM1[] {
  return input.plan.units.flatMap((u) => {
    const bytes = input.specs.get(u.id) ?? null;
    if (bytes === null) return [];
    try {
      return [parseSpec(bytes, absPath(join(input.repo, u.spec)))];
    } catch (error) {
      if (error instanceof SchemaError || error instanceof SpecFileError) return [];
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// 4-5. Debt, questions, amendments, intake

/**
 * The debt ledger published at `rev` of the product repo (`.roadmap/debt.md`; a corpus arc's baseline holds the previous
 * arc's), the empty ledger when it has none. Phase 0 dispositions its open items; the arc's banking and rendering
 * (src/pipeline/{gate,publish}.ts) continue from it.
 */
export function baselineDebtAt(repo: AbsPath, rev: string): DebtLedger {
  const r = gitRun(repo, ['cat-file', 'blob', `${rev}:${DEBT_DOC}`], { okCodes: [0, 128] });
  return (r.code === 0 ? parseDebtBlock(r.stdout) : null) ?? EMPTY_LEDGER;
}

/** A question names a debt item when its text holds the id as a word (`bears` holds only `T-n` and `V-n`). */
const names = (text: string, id: DebtId): boolean => new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^0-9])`).test(text);

function debtProblems(input: Phase0Input, record: Phase0Record, rows: StartupRejection[]): readonly Phase0Problem[] {
  const open = openItems(baselineDebtAt(input.repo, input.plan.baseline));
  const byId = new Map(record.debt.map((d) => [d.id, d.disposition]));
  const units = new Set<UnitId>(input.plan.units.map((u) => u.id));
  const out: Phase0Problem[] = [];
  for (const d of record.debt) {
    const where = `plan.phase0.debt.${d.id}`;
    if (!open.some((i) => i.id === d.id)) rows.push(schemaRow(where, `${d.id} is not an open item of the baseline's debt ledger`));
    else if (d.disposition.type === 'promote' && !units.has(d.disposition.unit)) rows.push(schemaRow(where, `promotes ${d.id} to ${d.disposition.unit}, which the plan does not hold`));
    else if (d.disposition.type === 'resolve') {
      const ruling = d.disposition.ruling;
      if (!input.ledger.some((r) => r.id === ruling && r.status === 'active')) rows.push(schemaRow(where, `resolves ${d.id} by ${ruling}, which is not an active ruling of the ledger`));
    }
  }
  for (const item of open) {
    const d = byId.get(item.id);
    if (d === undefined) out.push({ type: 'debt-undispositioned', id: item.id });
    else if (d.type === 'keep' && keptInEachOfLastTwoArcs(item) && !record.questions.some((q) => names(q.text, item.id))) out.push({ type: 'debt-kept-twice-unasked', id: item.id });
  }
  return out;
}

/** H23: a question keeps its id and text across the chain; a new one takes an id above the closure's highest. */
function questionProblems(record: Phase0Record, closure: readonly ArcRef[]): readonly Phase0Problem[] {
  const seen = questionClosure(closure);
  const max = Math.max(0, ...[...seen.keys()].map((id) => phaseQuestionSeq(id)));
  return record.questions.flatMap((q): Phase0Problem[] => {
    const texts = seen.get(q.id);
    const reused = texts === undefined ? phaseQuestionSeq(q.id) <= max : texts.size !== 1 || !texts.has(q.text);
    return reused ? [{ type: 'question-reused', id: q.id }] : [];
  });
}

function amendmentProblems(record: Phase0Record, previous: ArcRef | null, rows: StartupRejection[]): readonly Phase0Problem[] {
  const owed = previous === null ? [] : amendmentsOf(previous).map((a) => a.id);
  for (const a of record.amendments) if (!owed.includes(a.id)) rows.push(schemaRow(`plan.phase0.amendments.${a.id}`, `${a.id} is not an amendment of the previous arc's verified ref`));
  return owed.filter((id) => !record.amendments.some((a) => a.id === id)).map((id) => ({ type: 'amendment-undispositioned', id }));
}

/** The capture the record names, when its bytes are there and hash to the record's sha256; else `capture-missing`. */
function captureOf(input: Phase0Input, record: Phase0Record, p0: Phase0Problem[], rows: StartupRejection[], where: string): IssueCapture | null {
  if (input.capture === null || sha256Hex(input.capture) !== record.issueCapture.sha256) {
    p0.push({ type: 'capture-missing' });
    return null;
  }
  return load(rows, 'plan.phase0.issueCapture', where, input.capture, parseIssueCapture);
}

/** 5a. Every answer in force applied by the record, or by the newest earlier arc of the chain carrying its question. */
function answerProblems(repo: AbsPath, record: Phase0Record, chain: readonly ArcRef[]): readonly Phase0Problem[] {
  const latest = latestAnswers(answerLog(gitCommonDir(repo)));
  function* records(): Generator<readonly PhaseQuestion[]> {
    yield record.questions;
    for (const ref of [...chain].reverse()) {
      const q = refQuestions(ref);
      if (q !== null) yield q;
    }
  }
  return unappliedOf(latest, records()).map((a) => ({ type: 'answer-unapplied', question: a.question }));
}

/** Exactly one outcome per issue of the kept capture (H8). */
function intakeProblems(record: Phase0Record, capture: IssueCapture): readonly Phase0Problem[] {
  const captured = new Set<IssueId>(capture.issues.map((i) => i.id));
  const recorded = new Set<IssueId>(record.intake.map((x) => x.issue));
  return [
    ...capture.issues.filter((i) => !recorded.has(i.id)).map((i): Phase0Problem => ({ type: 'intake-missing', issue: i.id })),
    ...record.intake.filter((x) => !captured.has(x.issue)).map((x): Phase0Problem => ({ type: 'intake-unknown', issue: x.issue })),
  ];
}

/** The issues the raw record lists more than once (the reader refuses them; the row names them), ascending. */
function duplicateIntake(bytes: Buffer | null): readonly IssueId[] {
  if (bytes === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return [];
  }
  const intake = (raw as { intake?: unknown }).intake;
  if (!Array.isArray(intake)) return [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const x of intake) {
    const issue = (x as { issue?: unknown } | null)?.issue;
    if (typeof issue !== 'string') continue;
    if (seen.has(issue)) twice.add(issue);
    seen.add(issue);
  }
  return [...twice].flatMap((i) => {
    try {
      return [issueId(i)];
    } catch {
      return [];
    }
  }).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
}

/** Phase 0's `acted` names units of the plan or active rules of the pin (R29). */
function actedReferences(record: Phase0Record, plan: PlanM1, pin: CorpusPin | null, rows: StartupRejection[]): void {
  const units = new Set<string>(plan.units.map((u) => u.id));
  const rules = pin === null ? null : activeRules(pin);
  for (const x of record.intake) {
    if (x.outcome.type !== 'acted') continue;
    const on = x.outcome.on;
    const unknown = on.type === 'units' ? on.ids.filter((u) => !units.has(u)) : rules === null ? [] : on.ids.filter((r) => !rules.has(r));
    if (unknown.length > 0) rows.push(schemaRow(`plan.phase0.intake.${x.issue}`, `acts on ${unknown.join(', ')}, which the ${on.type === 'units' ? 'plan does not hold' : 'pin does not hold active'}`));
  }
}

// ---------------------------------------------------------------------------------------------------
// 8. The chain (H12, R11)

/**
 * The first chain problem of a start, in order: the previous arc complete in its verified ref, the baseline one
 * non-merge commit on its completed head touching only `.roadmap/` inputs and same-repo corpus paths, K set, and the
 * unacked starts (this one included) within K. A bootstrap arc (no `chain`) has none. The previous-arc and K rows are
 * src/chain.ts's `previousIncomplete` and `quotaOf`, which `nextStartOf` answers for `chain status` too.
 */
function chainRow(input: Phase0Input, guide: CorpusGuide | null, arcs: readonly ArcRef[], missing: ArcId | null): ChainProblem | null {
  const chain = input.plan.chain;
  if (chain === undefined) return null;
  const previous = missing === chain.previousArc ? null : arcs.at(-1) ?? null;
  const incomplete = previousIncomplete(chain.previousArc, previous);
  if (incomplete !== null) return incomplete;
  // No row: the previous arc's ref holds a done completion.
  const baseline = baselineProblem(input, chain.previousHead, completedHeadOf(previous!)!.head, guide);
  if (baseline !== null) return { type: 'baseline', baseline };
  const quota = quotaOf(arcs.map((a) => a.arc), input.config?.chain?.k ?? null, committedAcks(input.repo));
  switch (quota.reason) {
    case 'within-k':
      return null;
    case 'limit':
      return { type: 'limit', k: quota.k, unacked: quota.unacked };
    case 'k-unset':
      return { type: 'k-unset' };
  }
}

/** The `.roadmap/` files a between-arc commit may touch besides same-repo corpus paths (OR-L7). */
export const BETWEEN_ARC_FILES = ['.roadmap/vision.json', '.roadmap/corpus.md', '.roadmap/config.json'] as const;

function baselineProblem(input: Phase0Input, previousHead: string, completedHead: string, guide: CorpusGuide | null): Extract<ChainProblem, { type: 'baseline' }>['baseline'] | null {
  if (previousHead !== completedHead) return { type: 'previous-head-mismatch' };
  const baseline = input.plan.baseline;
  const parents = git(input.repo, ['rev-list', '--parents', '-n', '1', baseline]).trim().split(' ').slice(1);
  if (parents.length > 1) return { type: 'merge-commit' };
  if (parents.length === 0 || sha(parents[0]) !== previousHead) return { type: 'parent-mismatch' };
  const changed = git(input.repo, ['diff', '--name-only', '--no-renames', '-z', previousHead, baseline]).split('\0').filter((p) => p !== '').map((p) => repoPath(p));
  const root = guide !== null && guide.source.kind === 'same-repo' ? guide.source.root : null;
  const corpusPath = (p: RepoPath): boolean => guide !== null && root !== null && guide.include.some((i) => matchesPattern(p, repoPattern(underRoot(root, i))));
  const outside = changed.filter((p) => !(BETWEEN_ARC_FILES as readonly string[]).includes(p) && !corpusPath(p)).sort();
  return outside.length > 0 ? { type: 'paths', paths: outside } : null;
}

// ---------------------------------------------------------------------------------------------------
// 9. The tree (K18), and the rows `phase0 check` adds

/** `.roadmap/{vision.json, corpus.md, config.json}` whose working-tree bytes are not their blob at HEAD (either side absent included). */
export function treeUncommitted(repo: AbsPath): readonly Row<'tree-uncommitted'>[] {
  const paths = BETWEEN_ARC_FILES.filter((p) => {
    const file = join(repo, p);
    const tree = existsSync(file) ? sha256Hex(readFileSync(file)) : null;
    const r = gitRun(repo, ['cat-file', 'blob', `HEAD:${p}`], { okCodes: [0, 128] });
    const head = r.code === 0 ? sha256Hex(Buffer.from(r.stdout, 'utf8')) : null;
    return tree !== head;
  }).map((p) => repoPath(p));
  return paths.length === 0 ? [] : [{ kind: 'tree-uncommitted', paths }];
}

/** H4, R17: a fresh arc's holistic plan targets a corpus (an `architecture-doc` target stays for non-holistic arcs). */
export function holisticNeedsCorpus(plan: PlanM1): readonly Row<'holistic-needs-corpus'>[] {
  return plan.target === 'architecture-doc' && plan.holistic !== undefined ? [{ kind: 'holistic-needs-corpus' }] : [];
}

/**
 * Row 15 (dev.13): milestones on a plan without the holistic layer (ruling 2: a walk's findings need the ledger, the
 * checkpoint and fix units). Every mode: an apply adding milestones to a plan without `holistic` is refused too.
 */
export function milestonesNeedHolisticRows(plan: PlanM1): readonly Row<'milestones-need-holistic'>[] {
  return milestonesNeedHolistic(plan) ? [{ kind: 'milestones-need-holistic' }] : [];
}

// `walk-tools-missing` (dev.13, agent A): the bring-up programs (argv0) and, for a `browser` journey, the walkthrough MCP
// servers' smoke. The smoke is a backend call, so the row is not one of these synchronous rows: start, apply and
// `phase0 check` run it beside them.

/** The parsed vision and obligations of `input`, when they load (for `sliceCandidates`). */
export function visionAndObligations(input: Phase0Input): Readonly<{ vision: Vision | null; obligations: Obligations | null }> {
  const quiet = <T>(bytes: Buffer | null, parse: (v: unknown) => T): T | null => {
    const rows: StartupRejection[] = [];
    return load(rows, '', '', bytes, parse);
  };
  return { vision: quiet(input.vision, parseVision), obligations: quiet(input.obligations, parseObligations) };
}


// ---------------------------------------------------------------------------------------------------
// 12. The vision leak (an apply only)

/** Where the next arc's vision draft belongs: `_next/vision.md` in the inputs dir that holds the arc's plan dir. */
export const nextVisionDraft = (planFile: AbsPath): AbsPath => absPath(join(dirname(dirname(planFile)), '_next', 'vision.md'));

/**
 * Row 12: the apply's vision rebased onto the files in force (`committed`: its bytes' sha256, null when absent) is not the vision in force
 * (`inForce`), and the apply does not declare a vision edit.
 */
export function visionLeak(planFile: AbsPath, vision: Buffer | null, inForce: Sha256Hex | null, declared: boolean): readonly Row<'vision-leak'>[] {
  const committed = vision === null ? null : sha256(sha256Hex(vision));
  if (declared || committed === inForce) return [];
  return [{ kind: 'vision-leak', inForce, committed, draft: nextVisionDraft(planFile) }];
}
