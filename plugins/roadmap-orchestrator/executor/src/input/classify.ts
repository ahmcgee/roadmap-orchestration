// The classifier of a plan change (owner ruling 2026-09-29; SCHEMAS.md "Plan in force"): the files an apply
// (or a start) would put in force, against the plan in force and what the log says each unit has done. Every
// change is classified; any refused change refuses the whole apply, and the rejection lists every reason.
// Pure but for reading kept spec bytes and the rulings ledger (never the live spec in place of a kept one): no
// effect, so `apply --dry-run` runs it as is, and `apply` runs it again just before its commit (A12). The
// per-edit rules:
//
//   add a unit                  now; its id was never planned before and is not reserved (`reservedUnitIdReason`);
//                               never already cut
//   remove a unit               only if it never started
//   unit order                  the started units keep their relative order (G3); a legacy arc keeps dev.4's
//                               rule, the started units first in their order (its frontier is plan order)
//   an undispatched unit        any plan field and its spec, now
//   a dispatched unit's plan    scope, a lower risk, resources, spec path and a new `after`: refused (dropping an
//                               `after` is allowed; M3: a higher risk is re-pinned at dispatch, step A3)
//   risk floor (M3, A3)         an undispatched unit's risk below its Phase-0 floor (its risk in the first revision that
//                               planned it): refused unless its spec cites an active ruling that applies to it
//   a dispatched unit's spec    lane evidenceGlobs/evidenceExcludes at its rev: in force at once (`evidence`);
//                               the next rev (`revision`), scope and resources unchanged: pending until the
//                               unit re-opens on it (an in-flight unit at its next stage boundary that allows
//                               it, a unit parked at a judgment stage by `resume <unit>`); taking a pending
//                               revision back (`withdrawn`); anything else, and any edit of a merged,
//                               approved, publishing, stopped or finally parked unit: refused
//   cut (M2)                    refused on a merged or superseded unit and on one in a task (active past its
//                               first dispatch and not paused, or with an attempt a crash cut short); a cut is
//                               final; every unit that runs `after` a cut unit is cut too or drops the edge
//   re-entry (M2)               `reenters` only on a unit added now; the old unit parked or held (not merged,
//                               cut or superseded: one successor per unit); the new scope within the lineage's
//                               envelope (its root's first pin, prepare.ts `withinEnvelope`); its risk not
//                               below the lineage's floor; `reset` cites an active ruling of the ledger
//   effective graph (F15)       acyclic with every superseded unit replaced by its lineage head, the edges that
//                               activate only after preparation included
//   routing                     re-resolved; the caller refuses unsupported seats and smokes new backends
//   resources and pools         add: now; change (a pool's size included) or remove: refused while a unit of it
//                               (the name, or any instance of the pool) is held or a residue names it. A
//                               waiter is in a stage, so the arc-wide drain of a resource edit (A12) already
//                               excludes one
//   capacity                    over capacity (an `@cpu` request above the pool's size): refused
//   suite lanes                 now (the next candidate runs them); refused while a unit is at a candidate
//   arc, integrationBranch, baseline, worktreeRoot: always refused
//
// M3 (plan "Obligations as a revisioned input"; step A2). Who proposes the revision (`Proposer`) decides what
// it may touch:
//   rulings ledger + sidecars   executor-owned after start (A3): only `rule` and a checkpoint bundle change them; a
//                               differing ledger or sidecar from an apply, a start or a reverse is refused
//   vision                      owner-only (A14): only an architect `apply` changes it (`visionEditReasons`)
//   holistic                    may be added (`holistic`, with the vision), never removed; its audit settings and
//                               its obligations file stay once in force; `holistic.advances` (owner-only: only an
//                               `apply` changes it, `advances`) names active clauses of the revision's vision, one a
//                               world clause (`advancesReasons`), checked on every revision
//   obligations                 `classifyObligations` (src/holistic/obligations.ts): added, split, witness (also
//                               every obligation witnessed by a changed arc lane), disposed by a ruling in force
//                               (a split parent stays split: never disposed), restored, edited; `mapping`. A
//                               checkpoint split's dropped text is returned for its `split-dropped` divergence
//   route                       a unit's routing layer: any class at any seat (DESIGN §4 "Routing profiles"); the
//                               unit's routing re-resolved (`routing{routingRev, unit}`) and its unsupported seats
//                               refused; a moved implementer seat parks it `routing-changed` at dispatch (A3)
//   limits                      the plan's (`limits{null}`) or a unit's (`limits{unit}`); a bound below what a unit
//                               has spent is refused
//   scope growth                a dispatched unit's plan and spec scope may grow when its spec cites an active
//                               ruling that applies to the unit and names exactly the added patterns (in
//                               backticks); the unit is re-pinned (A3) and the transient check allows them (A4)
//   spec obligations, repairs   declared obligations exist and cover every non-exempt obligation a mapping pattern
//                               that may overlap the unit's scope names (prefix-conservative); a `repair` unit
//                               declares repairs, each an obligation or a finding of the arc
//
// `commandScope` (A12) is the units a mutation must find idle or awaiting admission: an apply's follow from
// its classification.
import type { IntentOf, PlanChange, PlanField } from '../core/events.ts';
import { PLAN_FIELDS } from '../core/events.ts';
import {
  type JobId, type ObligationId, type ResourceName, type ResourceUnit, type RulingId, type UnitId, type VisionClauseId,
  parseResourceUnit,
} from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import {
  type ApplyManifest, type Bounds, type ResidueKey, type RevisionManifest, type SpecM1, BOUND_FIELDS, isRevisionManifest, specObligations, specRepairs,
} from '../core/records.ts';
import { type UnitState, maxTier } from '../core/state.ts';
import { applyInputsOf, isLegacy, unkeptSpecReason } from '../core/upgrade.ts';
import { SchemaError } from '../core/validate.ts';
import type { AbsPath, RepoPattern } from '../core/values.ts';
import { undispositioned } from '../host/residues.ts';
import { classifyObligations } from '../holistic/obligations.ts';
import { type ObligationDisposition, type Obligations, type RulingSidecar, type Vision, isExempt, parseObligations, parseRulingSidecar, parseVision } from '../holistic/types.ts';
import { advancesReasons, visionEditReasons } from '../holistic/vision.ts';
import { withinEnvelope } from '../pipeline/prepare.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { cpuCapacity, overCapacity } from '../resources/pool.ts';
import { resourceTable } from '../resources/reserve.ts';
import { type ResolvedRouting, unsupportedSeats } from '../routing/layers.ts';
import { RISK_TIERS, type RiskTier, UNIT_ROLES } from '../routing/types.ts';
import { readJournal } from '../core/log.ts';
import { effectiveGraph, findCycle } from '../schedule/graph.ts';
import type { CommandScope, ScopeOf } from '../schedule/types.ts';
import { type Ruling, parseRulings } from '../spec/rulings.ts';
import { SpecFileError, bytesSha256, parseSpec } from '../spec/spec.ts';
import {
  type InForce, type InputFiles, PLAN_INPUT, type RevisionInForce, type RoutingBase, SPEC_INPUT, inputPath, keptInput, planInForce, planManifestOf, planRouting,
  readInputFiles, revisionInForce, revisionManifestOf, unitRouting,
} from './inforce.ts';
import { type PlanM1, type PlanUnit, boundsOf, parsePlan, reservedUnitIdReason } from './plan.ts';

/**
 * Who proposes a revision (G1), as far as its rules differ: an architect's `apply`, `rule` or `reverse` command, a
 * start whose files differ, a checkpoint bundle (its cites back a split that drops text), or the executor's own
 * machine revision. Its source (`RevisionSource`) is the payload's.
 */
export type Proposer =
  | Readonly<{ type: 'apply' | 'rule' | 'reverse' | 'start' | 'executor' }>
  | Readonly<{ type: 'bundle'; job: JobId; cites: readonly VisionClauseId[]; evidence: readonly string[] }>;

/** The revision's inputs beyond plan and specs, parsed (what renders and the payload are built from). */
export type NextInputs = Readonly<{
  ledger: readonly Ruling[];
  sidecars: readonly RulingSidecar[];
  obligations: Obligations | null;
  vision: Vision | null;
  /** What changed against the inputs in force. */
  changed: Readonly<{ rulings: boolean; obligations: boolean; vision: boolean }>;
}>;

export type Classified =
  | Readonly<{ kind: 'unchanged' }>
  /**
   * `scoped`: the units whose plan entry or spec changed, for the startup rows an apply re-runs. `routings`: every
   * routing the revision changed (the plan's, and each re-routed unit's), for the smoke of newly seated backends.
   * `dispositions`: the weakenings and the rulings that allow them; `dropped`: a checkpoint split's dropped text.
   */
  | Readonly<{
    kind: 'accepted'; changes: readonly PlanChange[]; scoped: readonly UnitId[]; routings: readonly ResolvedRouting[];
    dispositions: readonly Readonly<{ obligation: ObligationId; disposition: ObligationDisposition; ruling: RulingId }>[];
    dropped: readonly Readonly<{ obligation: ObligationId; sentences: readonly string[] }>[];
    inputs: NextInputs;
  }>
  | Readonly<{ kind: 'rejected'; reasons: readonly string[] }>;

export type ClassifyInput = Readonly<{
  runDir: AbsPath;
  view: JournalView;
  inForce: InForce;
  /** The inputs in force beyond plan and specs (src/input/inforce.ts `revisionInForce`). */
  revision: RevisionInForce;
  next: InputFiles;
  /** Residues on this host not yet disposed of: a resource they name keeps its declaration. */
  residues: readonly ResidueKey[];
  /** The arc's profile and repo config: a plan's and a unit's routing resolve under them. */
  routing: RoutingBase;
  proposer: Proposer;
}>;

const FIXED = ['arc', 'integrationBranch', 'baseline', 'worktreeRoot'] as const;
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Two specs equal but for their lanes' evidenceGlobs and evidenceExcludes. */
export function sameBesidesEvidence(a: SpecM1, b: SpecM1): boolean {
  const blank = (s: SpecM1): string => canonicalJson({ ...s, lanes: s.lanes.map((l) => ({ ...l, evidenceGlobs: [], evidenceExcludes: [] })) });
  return blank(a) === blank(b);
}

/** A unit whose gate approved it and which is publishing or merged: its spec is fixed. */
export function approvedOrPublishing(u: UnitState): boolean {
  if (u.status === 'retired') return true;
  if (u.decided === null) return false;
  const d = decidedBy(u.decided);
  return d.kind === 'retire' || (d.kind === 'stage' && ['candidate', 'ff', 'snapshot'].includes(d.target.stage));
}

/** Whether the unit ever started a stage or was pinned: it may no longer be removed. */
export const started = (view: JournalView, unit: UnitId): boolean => view.dispatchOf(unit) !== null || view.unit(unit).counters.attempts > 0;

/**
 * The executor's own revision that set the unit's recorded spec, or null when the architect's did: the
 * implementer's recorded decisions appended at the evidence stage (`spec.patch` by `executor`, lead ruling,
 * step 12). Since A12 it can land while an architect's revision is still unapplied, taking the rev that
 * revision meant to set.
 */
function machineRevision(view: JournalView, unit: UnitId, recorded: Readonly<{ sha256: string }>): IntentOf<'spec.patch'> | null {
  return view.opsOf('spec.patch').find((i) => i.parent.type === 'stage' && i.parent.unit === unit && i.expect.patch.by.role === 'executor'
    && view.doneOf(i.op) !== null && i.post.newSha256 === recorded.sha256) ?? null;
}

/**
 * Why an architect's revision at `rev` is stale because the executor's machine revision took that rev first
 * (lead ruling: kept a rejection, no auto-rebase): it names the intervening revision and where its bytes are.
 */
function staleAfterMachineRevision(runDir: AbsPath, unit: UnitId, path: AbsPath, rev: number, machine: IntentOf<'spec.patch'>): string {
  const { newRev, newSha256 } = machine.post;
  const at = machine.parent.type === 'stage' ? `${machine.parent.stage} attempt ${machine.parent.attempt}` : 'a stage';
  return `unit ${unit}: its spec ${path} is at rev ${rev}, but the unit's spec is now rev ${newRev}, a revision the executor wrote from `
    + `the build's evidence (the implementer's recorded decisions, appended at ${at}) before your edit was applied; `
    + `re-apply your edit on top of rev ${newRev} (kept at ${inputPath(runDir, newSha256, SPEC_INPUT)}) and set rev ${newRev + 1}`;
}

/** The spec change of a dispatched unit, or why it is refused; null when the file is the unit's spec. */
function dispatchedSpec(
  input: ClassifyInput, unit: PlanUnit, u: UnitState, path: AbsPath, bytes: Buffer, spec: SpecM1, inputs: NextInputs,
): PlanChange | string | null {
  const recorded = u.spec;
  if (recorded === null) throw new Error(`unit ${unit.id} is dispatched without a recorded spec`);
  const sha = bytesSha256(bytes);
  const pending = u.pendingRevision;
  if (sha === pending?.sha256) return null;
  const change = (edit: Extract<PlanChange, { type: 'spec' }>['edit']): PlanChange => ({ type: 'spec', unit: unit.id, edit, specRev: spec.rev, specSha256: sha });
  if (sha === recorded.sha256) return pending === null ? null : change('withdrawn');
  const status = u.status;
  if (approvedOrPublishing(u)) return `unit ${unit.id} is ${status === 'retired' ? 'merged' : 'approved and publishing'}; its spec is fixed`;
  if (status === 'stop-pending') return `unit ${unit.id} stopped the arc; its spec is fixed`;
  if (status === 'park-pending' && (u.decided === null || !['plan-check', 'gate'].includes(u.decided.stage))) {
    return `unit ${unit.id} is parked at ${u.decided?.stage}, which is final in M1; re-enter the work under a new unit id`;
  }
  if (u.open !== null) {
    return `unit ${unit.id} has ${u.open.stage} attempt ${u.open.attempt} cut short by a crash; apply its spec edit once the executor has recorded that attempt`;
  }
  const kept = keptInput(input.runDir, recorded.sha256, SPEC_INPUT);
  if (kept === null) return unkeptSpecReason(unit.id, path);
  const was = parseSpec(kept, path);
  if (!same(was.resources, spec.resources)) return `unit ${unit.id} is dispatched: its spec's scope and resources may not change`;
  const growth = scopeGrowthReason(unit.id, 'spec\'s scope', 'its spec\'s scope and resources may not change', was.scope, spec.scope, spec, inputs);
  if (growth !== null) return growth;
  const machine = spec.rev <= recorded.rev && !(spec.rev === recorded.rev && sameBesidesEvidence(was, spec)) ? machineRevision(input.view, unit.id, recorded) : null;
  if (machine !== null) return staleAfterMachineRevision(input.runDir, unit.id, path, spec.rev, machine);
  if (spec.rev === recorded.rev) {
    if (!sameBesidesEvidence(was, spec)) {
      return `unit ${unit.id}: its spec ${path} changed but is still at rev ${recorded.rev}; a revision sets rev ${recorded.rev + 1} `
        + '(lane evidenceGlobs and evidenceExcludes may change at the current rev)';
    }
    if (pending !== null) return `unit ${unit.id} has revision ${pending.rev} pending; apply that revision, or the recorded spec to withdraw it, before an evidence-only edit`;
    return change('evidence');
  }
  if (spec.rev !== recorded.rev + 1) {
    return `unit ${unit.id}: its spec ${path} is at rev ${spec.rev}, but the unit's recorded rev is ${recorded.rev}; a revision sets rev ${recorded.rev + 1}`;
  }
  return change('revision');
}

/** A plan unit without its M2 lifecycle fields and its M3 routing layer and limits (their own edit classes), for comparing the rest of its entry. */
function entryOf(u: PlanUnit): Omit<PlanUnit, 'cut' | 'reenters' | 'routing' | 'limits'> {
  const { cut: _cut, reenters: _reenters, routing: _routing, limits: _limits, ...rest } = u;
  return rest;
}

/** The revision's ledger: its rulings, or why it does not load. */
type Ledger = Readonly<{ path: AbsPath; rulings: readonly Ruling[] }> | Readonly<{ path: AbsPath; error: string }>;

/** Why `ruling` may not back `what`: not in the revision's ledger, withdrawn, or the ledger does not load; null when it may. */
function rulingReason(ledger: Ledger, ruling: RulingId, what: string): string | null {
  if ('error' in ledger) return `${what} cites ruling ${ruling}, but the rulings ledger does not load: ${ledger.error}`;
  const r = ledger.rulings.find((x) => x.id === ruling);
  if (r === undefined) return `${what} cites ruling ${ruling}, which the ledger ${ledger.path} does not hold`;
  return r.status === 'withdrawn' ? `${what} cites ruling ${ruling}, which ${r.by} withdrew` : null;
}

const riskAbove = (a: RiskTier, b: RiskTier): boolean => RISK_TIERS.indexOf(a) > RISK_TIERS.indexOf(b);

/**
 * A unit's Phase-0 risk floor: its risk in the first plan revision that planned it (read from the kept plans the log's
 * revisions name); null for a unit the plan in force does not hold yet (its risk is its floor).
 */
function phase0Risk(input: ClassifyInput, unit: UnitId): RiskTier | null {
  for (const e of readJournal(input.runDir, input.view.arc).events) {
    if (e.type !== 'fact' || e.fact.kind !== 'plan-applied') continue;
    const bytes = keptInput(input.runDir, e.fact.planSha256, PLAN_INPUT);
    if (bytes === null) throw new Error(`plan rev ${e.fact.rev} names plan ${e.fact.planSha256}, which is not kept`);
    const planned = parsePlan(JSON.parse(bytes.toString('utf8'))).units.find((u) => u.id === unit);
    if (planned !== undefined) return planned.risk;
  }
  return null;
}

/**
 * Why `unit`'s risk may not be what the revision sets (DESIGN §2.3 `route`): below its Phase-0 floor without its spec
 * citing an active ruling that applies to it. Null when allowed.
 */
function riskFloorReason(input: ClassifyInput, unit: PlanUnit, spec: SpecM1 | null, inputs: NextInputs, ledger: Ledger): string | null {
  const floor = phase0Risk(input, unit.id);
  if (floor === null || !riskAbove(floor, unit.risk)) return null;
  const ruled = (spec?.cites.rulings ?? []).some((id) => {
    const s = inputs.sidecars.find((x) => x.id === id);
    return rulingReason(ledger, id, `unit ${unit.id}'s risk`) === null && s !== undefined && s.status === 'active'
      && s.appliesTo.type === 'units' && s.appliesTo.units.includes(unit.id);
  });
  return ruled ? null : `unit ${unit.id}: risk ${unit.risk} is below its Phase-0 floor ${floor}; lowering it needs its spec to cite an active ruling for ${unit.id}`;
}

/** Whether the unit is in a task (A12, as the log shows it): active past its first dispatch and not paused, or with an attempt a crash cut short. */
function inTask(view: JournalView, u: UnitState): boolean {
  if (u.open !== null) return true;
  const c = view.control();
  return u.status === 'active' && started(view, u.unit) && !c.pausedAll && !c.pausedUnits.includes(u.unit);
}

/** Why `unit` may not be cut now, or null. */
function cutRefusal(view: JournalView, unit: UnitId): string | null {
  const u = view.unit(unit);
  switch (u.status) {
    case 'retired': return `unit ${unit} is merged; it cannot be cut`;
    case 'superseded': return `unit ${unit} is superseded by ${u.supersededBy}; cut its lineage's head instead`;
    case 'cut': throw new Error(`unit ${unit} is cut in the log but not in the plan in force`);
    default:
      if (!inTask(view, u)) return null;
      return `unit ${unit} is in a task (${u.open === null ? `past ${u.stage}` : `at ${u.open.stage}`}); pause it, or let it park, before cutting it`;
  }
}

/**
 * The re-entry rows of `unit` (added now, `reenters` set): the old unit parked or held, the scope within the
 * lineage's envelope, the risk at least its floor, a `reset` backed by an active ruling. Its change, or reasons.
 */
function reentryRow(
  view: JournalView, ledger: Ledger, unit: PlanUnit, cutNow: ReadonlySet<UnitId>,
): Extract<PlanChange, { type: 'unit-reentered' }> | readonly string[] {
  const re = unit.reenters;
  if (re === undefined) throw new Error(`reentryRow of ${unit.id}, which re-enters nothing`);
  const old = view.unit(re.unit);
  if (cutNow.has(re.unit)) return [`unit ${unit.id} re-enters ${re.unit}, which this apply cuts`];
  switch (old.status) {
    case 'park-pending':
    case 'held':
      break;
    case 'retired': return [`unit ${unit.id} re-enters ${re.unit}, which is merged`];
    case 'cut': return [`unit ${unit.id} re-enters ${re.unit}, which is cut`];
    case 'superseded': throw new Error(`unit ${re.unit} is superseded, yet no other unit of the plan re-enters it`);
    default: return [`unit ${unit.id} re-enters ${re.unit}, which is ${old.status}; only a parked or held unit is re-entered`];
  }
  const reasons: string[] = [];
  const root = old.lineage?.root ?? re.unit;
  const envelope = view.dispatchesOf(root)[0]?.scope;
  if (envelope === undefined) {
    reasons.push(`unit ${unit.id} re-enters ${re.unit}, whose lineage (root ${root}) was never dispatched, so it has no scope envelope`);
  } else {
    const outside = unit.scope.filter((p) => !withinEnvelope(p, envelope));
    if (outside.length > 0) reasons.push(`unit ${unit.id}: scope ${outside.join(', ')} lies outside its lineage's envelope ${envelope.join(', ')} (${root}'s first pin)`);
  }
  if (old.risk !== null && maxTier(unit.risk, old.risk) !== unit.risk) reasons.push(`unit ${unit.id}: risk ${unit.risk} is below its lineage's floor ${old.risk}`);
  if (re.reset !== undefined) {
    const r = rulingReason(ledger, re.reset.ruling, `unit ${unit.id}'s reset`);
    if (r !== null) reasons.push(r);
  }
  return reasons.length > 0 ? reasons : { type: 'unit-reentered', unit: unit.id, reenters: re.unit, reset: re.reset !== undefined };
}

/** Whether a resource unit belongs to declaration `name`: the name itself, or an instance of the pool. */
function unitOf(u: ResourceUnit, name: ResourceName): boolean {
  const p = parseResourceUnit(u);
  return (p.type === 'named' && p.name === name) || (p.type === 'instance' && p.pool === name);
}

/** Parses a revisioned JSON input for the classifier: its value, or the reason it does not load. */
function parsedInput<T>(what: string, path: AbsPath, bytes: Buffer | null, parse: (v: unknown) => T, reasons: string[]): T | null {
  if (bytes === null) {
    reasons.push(`the ${what} ${path} does not exist`);
    return null;
  }
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
    reasons.push(`the ${what} ${path} does not load: ${error.message}`);
    return null;
  }
}

/** The revision's ledger, sidecars, obligations and vision, parsed, and what changed against the inputs in force. */
function nextInputsOf(input: ClassifyInput, reasons: string[]): Readonly<{ ledger: Ledger; inputs: NextInputs }> {
  const { next, revision } = input;
  let ledger: Ledger;
  if (next.ledger.bytes === null) ledger = { path: next.ledger.path, error: `${next.ledger.path} does not exist` };
  else {
    try {
      ledger = { path: next.ledger.path, rulings: parseRulings(next.ledger.bytes.toString('utf8'), next.ledger.path) };
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      ledger = { path: next.ledger.path, error: error.message };
    }
  }
  const sidecars: RulingSidecar[] = [];
  for (const [id, file] of next.sidecars) {
    const s = parsedInput('ruling sidecar', file.path, file.bytes, parseRulingSidecar, reasons);
    if (s === null) continue;
    if (s.id !== id) reasons.push(`the ruling sidecar ${file.path} holds ${s.id}`);
    else if ('rulings' in ledger && !ledger.rulings.some((r) => r.id === id)) reasons.push(`the ruling sidecar ${file.path} names ${id}, which the ledger does not hold`);
    else sidecars.push(s);
  }
  const obligations = next.obligations === null ? null : parsedInput('obligations file', next.obligations.path, next.obligations.bytes, parseObligations, reasons);
  const vision = next.vision === null ? null : parsedInput('vision file', next.vision.path, next.vision.bytes, parseVision, reasons);
  const sha = (bytes: Buffer | null | undefined): string | null => (bytes === null || bytes === undefined ? null : bytesSha256(bytes));
  const sidecarShas = Object.fromEntries([...next.sidecars].map(([id, f]) => [id, bytesSha256(f.bytes)]));
  return {
    ledger,
    inputs: {
      ledger: 'rulings' in ledger ? ledger.rulings : [],
      sidecars,
      obligations,
      vision,
      changed: {
        rulings: sha(next.ledger.bytes) !== revision.ledger.sha256 || !same(sidecarShas, revision.manifest.rulings.sidecars),
        obligations: sha(next.obligations?.bytes) !== (revision.obligations?.sha256 ?? null),
        vision: sha(next.vision?.bytes) !== (revision.vision?.sha256 ?? null),
      },
    },
  };
}

/** The literal prefix of a pattern (before its first glob character): two patterns may overlap when one's prefixes the other's. */
const literalPrefix = (p: string): string => {
  const i = p.search(/[*?[{]/);
  return i === -1 ? p : p.slice(0, i);
};
/** Prefix-conservative overlap of two repo patterns: false only when no path can match both. */
export function mayOverlap(a: string, b: string): boolean {
  const x = literalPrefix(a);
  const y = literalPrefix(b);
  return x.startsWith(y) || y.startsWith(x);
}

/** What a unit has spent of each counted bound (the time bounds count nothing). */
function spentOf(u: UnitState): Readonly<Partial<Record<keyof Bounds, number>>> {
  return {
    chargeable: u.counters.chargeableFailures,
    redirects: u.counters.redirects - u.redirectBase,
    reviseRounds: u.counters.reviseRounds,
    candidateReds: u.counters.candidateReds,
    retries: Math.max(0, ...Object.values(u.counters.retries)),
  };
}

/** Backticked tokens of a ruling statement: the patterns it names. */
const namedPatterns = (statement: string): readonly string[] => [...statement.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/**
 * Why a dispatched unit's scope may not become `now` (was `was`): it may only grow, and only when its spec in the
 * revision cites an active ruling applying to the unit whose statement names exactly the added patterns. Null when allowed.
 */
function scopeGrowthReason(
  unit: UnitId, what: string, fixed: string, was: readonly RepoPattern[], now: readonly RepoPattern[], spec: SpecM1 | null, inputs: NextInputs,
): string | null {
  if (same([...was].sort(), [...now].sort())) return null;
  const added = now.filter((p) => !was.includes(p)).sort();
  if (was.some((p) => !now.includes(p))) return `unit ${unit} is dispatched: ${fixed} (a scope may only grow, backed by a ruling)`;
  const backing = (spec?.cites.rulings ?? []).find((id) => {
    const r = inputs.ledger.find((x) => x.id === id);
    const s = inputs.sidecars.find((x) => x.id === id);
    if (r?.status !== 'active' || s === undefined || s.status !== 'active') return false;
    if (s.appliesTo.type !== 'units' || !s.appliesTo.units.includes(unit)) return false;
    return same([...new Set(namedPatterns(s.statement).filter((p) => !was.includes(p as RepoPattern)))].sort(), added);
  });
  return backing === undefined
    ? `unit ${unit} is dispatched: its ${what} grows by ${added.join(', ')} without its spec citing an active ruling for ${unit} that names exactly those patterns`
    : null;
}

/** Classifies the files against the plan in force. */
export function classify(input: ClassifyInput): Classified {
  const { view, inForce, next, proposer } = input;
  const cur = inForce.plan;
  const plan = next.plan;
  const legacy = isLegacy(view);
  const reasons: string[] = [];
  const changes: PlanChange[] = [];
  const scoped = new Set<UnitId>();
  const { ledger, inputs } = nextInputsOf(input, reasons);

  for (const field of FIXED) {
    if (!same(cur[field], plan[field])) reasons.push(`${field} may never change (in force: ${String(cur[field])}; plan.json: ${String(plan[field])})`);
  }

  // Units: removals, additions, order.
  const curIds = cur.units.map((u) => u.id);
  const nextIds = plan.units.map((u) => u.id);
  const planned = new Set(view.plannedUnits());
  const reentering: PlanUnit[] = [];
  for (const u of cur.units) {
    if (nextIds.includes(u.id)) continue;
    if (started(view, u.id)) reasons.push(`unit ${u.id} has started; it cannot be removed`);
    else changes.push({ type: 'unit-removed', unit: u.id });
  }
  for (const u of plan.units) {
    if (curIds.includes(u.id)) continue;
    const reserved = reservedUnitIdReason(u.id);
    if (planned.has(u.id)) reasons.push(`unit id ${u.id} was planned before; ids are never reused`);
    else if (u.cut !== undefined) reasons.push(`unit ${u.id} is added cut; add it without \`cut\`, or leave it out`);
    else if (reserved !== null) reasons.push(reserved);
    else {
      changes.push({ type: 'unit-added', unit: u.id });
      scoped.add(u.id);
      if (u.reenters !== undefined) reentering.push(u);
    }
  }
  // G3: a DAG arc starts units out of plan order, so the started ones keep only their relative order. A legacy
  // arc's frontier is plan order itself (dev.4), so there they stay first. A re-entry that has not prepared
  // yet has started nothing of its own: its attempts are its lineage's.
  const startedIds = curIds.filter((id) => view.dispatchOf(id) !== null || (view.unit(id).lineage === null && started(view, id)));
  const keptStarted = startedIds.filter((id) => nextIds.includes(id));
  const orderReason = legacy
    ? (same(nextIds.slice(0, startedIds.length), startedIds) ? null : `the units that have started (${startedIds.join(', ')}) must stay first in plan order, in their order`)
    : (same(nextIds.filter((id) => keptStarted.includes(id)), keptStarted) ? null : `the units that have started must keep their relative order (${keptStarted.join(', ')})`);
  if (orderReason !== null) reasons.push(orderReason);
  else {
    const common = (ids: readonly UnitId[]) => ids.filter((id) => curIds.includes(id) && nextIds.includes(id));
    if (!same(common(curIds), common(nextIds))) changes.push({ type: 'order' });
  }

  // Units in both: their plan entries and their specs.
  const cutNow = new Set<UnitId>();
  const specs = new Map<UnitId, SpecM1>();
  for (const unit of plan.units) {
    const was = cur.units.find((u) => u.id === unit.id);
    const file = next.specs.get(unit.id);
    if (file === undefined) throw new Error(`classify: no spec entry for ${unit.id}`);
    let spec: SpecM1 | null = null;
    if (file.bytes === null) reasons.push(`unit ${unit.id}: its spec ${file.path} does not exist`);
    else {
      try {
        spec = parseSpec(file.bytes, file.path);
        if (spec.unit !== unit.id) {
          reasons.push(`unit ${unit.id}: ${file.path} is the spec of unit ${spec.unit}`);
          spec = null;
        }
      } catch (error) {
        if (!(error instanceof SchemaError || error instanceof SpecFileError)) throw error;
        reasons.push(`unit ${unit.id}: its spec does not load: ${error.message}`);
      }
    }
    if (spec !== null) specs.set(unit.id, spec);
    if (was === undefined) continue;
    if (!same(was.reenters, unit.reenters)) reasons.push(`unit ${unit.id}: \`reenters\` is set when a unit is added, never after`);
    if (was.cut !== undefined && unit.cut === undefined) reasons.push(`unit ${unit.id} is cut; a cut is final`);
    if (was.cut === undefined && unit.cut !== undefined) {
      cutNow.add(unit.id);
      const refusal = cutRefusal(view, unit.id);
      const ruling = unit.cut.ruling === undefined ? null : rulingReason(ledger, unit.cut.ruling, `unit ${unit.id}'s cut`);
      if (refusal !== null) reasons.push(refusal);
      if (ruling !== null) reasons.push(ruling);
      if (refusal === null && ruling === null) {
        changes.push({ type: 'unit-cut', unit: unit.id });
        scoped.add(unit.id);
      }
    }
    const pinned = view.dispatchOf(unit.id) !== null;
    if (!same(entryOf(was), entryOf(unit))) {
      // M3 (DESIGN §2.3 `route`, step A3): a unit's risk may rise at any time (a dispatched unit is re-pinned at the
      // higher floor, and one whose implementer seat that moves after its build started parks `routing-changed`); it
      // never goes below its Phase-0 floor (its risk when it was planned) without a ruling for it.
      // (A dispatched unit's lower risk is refused below as a fixed field.)
      const lowered = pinned ? null : riskFloorReason(input, unit, spec, inputs, ledger);
      if (lowered !== null) reasons.push(lowered);
      if (!pinned) {
        if (lowered === null) {
          changes.push({ type: 'unit-changed', unit: unit.id });
          scoped.add(unit.id);
        }
      } else {
        const fixed = (['spec', 'risk', 'resources'] as const).filter((k) => !same(was[k], unit[k]) && !(k === 'risk' && riskAbove(unit.risk, was.risk)));
        const added = unit.after.filter((a) => !was.after.includes(a));
        const growth = same(was.scope, unit.scope) ? null : scopeGrowthReason(unit.id, 'scope', 'its scope may not change', was.scope, unit.scope, spec, inputs);
        for (const k of fixed) reasons.push(`unit ${unit.id} is dispatched: its ${k} may not change`);
        if (growth !== null) reasons.push(growth);
        if (added.length > 0) reasons.push(`unit ${unit.id} is dispatched: it may not run after ${added.join(', ')} as well`);
        if (fixed.length === 0 && added.length === 0 && growth === null) {
          changes.push({ type: 'unit-changed', unit: unit.id });
          scoped.add(unit.id);
        }
      }
    }
    if (file.bytes === null || spec === null) continue;
    if (!pinned) {
      if (bytesSha256(file.bytes) !== inForce.manifest.specs[unit.id]) {
        changes.push({ type: 'spec', unit: unit.id, edit: 'undispatched', specRev: spec.rev, specSha256: bytesSha256(file.bytes) });
        scoped.add(unit.id);
      }
      continue;
    }
    const c = dispatchedSpec(input, unit, view.unit(unit.id), file.path, file.bytes, spec, inputs);
    if (typeof c === 'string') reasons.push(c);
    else if (c !== null) {
      changes.push(c);
      scoped.add(unit.id);
    }
  }

  // Cuts: no unit left waiting on one (D1: a cut unit never merges).
  const cut = new Set(plan.units.filter((u) => u.cut !== undefined).map((u) => u.id));
  for (const u of plan.units) {
    const on = u.cut === undefined ? u.after.filter((a) => cut.has(a)) : [];
    if (on.length > 0) reasons.push(`unit ${u.id} runs after ${on.join(', ')}, which is cut: cut ${u.id} too, or drop its \`after\``);
  }

  // Re-entries (one successor per unit), then the effective graph (F15), the edges that activate only once a
  // successor prepared included.
  const byOld = new Map<UnitId, UnitId[]>();
  for (const u of plan.units) if (u.reenters !== undefined) byOld.set(u.reenters.unit, [...(byOld.get(u.reenters.unit) ?? []), u.id]);
  const chains = [...byOld].filter(([, units]) => units.length > 1);
  for (const [old, units] of chains) reasons.push(`units ${units.join(', ')} each re-enter ${old}; a lineage is a chain: re-enter its head`);
  for (const unit of reentering) {
    if (chains.some(([old]) => old === unit.reenters?.unit)) continue;
    const row = reentryRow(view, ledger, unit, cutNow);
    if ('type' in row) {
      changes.push(row);
      scoped.add(row.reenters);
    } else reasons.push(...row);
  }
  if (chains.length === 0) {
    const cycle = findCycle(effectiveGraph(plan.units));
    if (cycle !== null) reasons.push(`the unit graph has a cycle once each re-entered unit stands for its lineage's head: ${cycle.join(' → ')}`);
  }

  // Routing: the plan's layer, then each unit's (`route`, M3).
  const routings: ResolvedRouting[] = [];
  if (!same(cur.routing, plan.routing)) {
    const resolved = planRouting(input.routing, plan);
    if (resolved.rev !== planRouting(input.routing, cur).rev) {
      routings.push(resolved);
      changes.push({ type: 'routing', routingRev: resolved.rev });
    }
  }
  for (const unit of plan.units) {
    const was = cur.units.find((u) => u.id === unit.id);
    if (same(was?.routing, unit.routing)) continue;
    const resolved = unitRouting(input.routing, plan, unit);
    const unsupported = unsupportedSeats(resolved, unit.id).filter((r) => r.kind === 'unsupported-routing' && (UNIT_ROLES as readonly string[]).includes(r.role));
    reasons.push(...unsupported.map((r) => canonicalJson(r)));
    if (was === undefined || unsupported.length > 0 || resolved.rev === unitRouting(input.routing, cur, was).rev) continue;
    routings.push(resolved);
    changes.push({ type: 'routing', routingRev: resolved.rev, unit: unit.id });
    scoped.add(unit.id);
  }

  // Limits (M3): never below what a unit has spent.
  const limitsChecked = new Set<UnitId>();
  const checkLimits = (unit: PlanUnit): void => {
    const was = cur.units.find((u) => u.id === unit.id);
    if (limitsChecked.has(unit.id) || was === undefined) return;
    limitsChecked.add(unit.id);
    const before = boundsOf(cur, was);
    const bounds = boundsOf(plan, unit);
    const spent = spentOf(view.unit(unit.id));
    for (const k of BOUND_FIELDS) {
      const s = spent[k];
      if (s !== undefined && bounds[k] !== before[k] && bounds[k] < s) reasons.push(`unit ${unit.id}: its ${k} bound ${bounds[k]} is below what it has spent (${s})`);
    }
  };
  if (!same(cur.limits, plan.limits)) {
    changes.push({ type: 'limits', unit: null });
    for (const unit of plan.units) checkLimits(unit);
  }
  for (const unit of plan.units) {
    const was = cur.units.find((u) => u.id === unit.id);
    if (was === undefined || same(was.limits, unit.limits)) continue;
    changes.push({ type: 'limits', unit: unit.id });
    scoped.add(unit.id);
    checkLimits(unit);
  }

  // Resources and pools: a declaration's units are its name, or every instance of the pool.
  const table = resourceTable(view);
  const names = new Set<ResourceName>([...cur.resources, ...plan.resources].map((r) => r.name));
  for (const name of [...names].sort()) {
    const was = cur.resources.find((r) => r.name === name);
    const now = plan.resources.find((r) => r.name === name);
    if (was !== undefined && now !== undefined && same(was, now)) continue;
    if (was === undefined) {
      changes.push({ type: 'resource', resource: name, edit: 'added' });
      continue;
    }
    const held = [...table].filter(([u, e]) => unitOf(u, name) && (e.pending !== null || e.status.state !== 'free'));
    const residue = input.residues.some((k) => unitOf(k.resource, name));
    if (held.length > 0 || residue) {
      const detail = held.map(([u, e]) => (was.pool === undefined ? e.status.state : `${u} ${e.status.state}`)).join(', ');
      reasons.push(`resource ${name} is ${held.length > 0 ? `held (${detail})` : 'named by an undisposed residue'}; its declaration may not change until it is free and swept`);
    } else {
      changes.push({ type: 'resource', resource: name, edit: now === undefined ? 'removed' : 'changed' });
    }
  }
  if (changes.some((c) => c.type === 'resource' && c.edit !== 'added')) for (const u of plan.units) scoped.add(u.id);

  // Capacity: no request above its pool's size (a legacy arc requests no `@cpu`, so none of its can be).
  for (const row of overCapacity(plan, { cpu: cpuCapacity(plan) }, specs, view)) reasons.push(canonicalJson(row));

  // Suite lanes.
  if (!same(cur.suite, plan.suite)) {
    const atCandidate = cur.units.filter((u) => {
      const s = view.unit(u.id);
      return s.decided?.stage === 'candidate' && (s.status === 'active' || s.status === 'held');
    });
    const open = view.openIntents().some((i) => i.kind === 'candidate.merge' || (i.parent.type === 'stage' && i.parent.stage === 'candidate'));
    if (open || atCandidate.length > 0) {
      reasons.push(`the suite lanes may not change while a candidate is under way (${open ? 'a candidate op is open' : `unit ${atCandidate.map((u) => u.id).join(', ')} is past a candidate attempt`})`);
    } else {
      changes.push({ type: 'suite' });
    }
  }

  // The other plan fields.
  for (const field of PLAN_FIELDS) {
    if (!same(cur[field as PlanField], plan[field as PlanField])) changes.push({ type: 'plan-field', field });
  }
  if (changes.some((c) => c.type === 'plan-field' && (c.field === 'contracts' || c.field === 'rulings'))) for (const u of plan.units) scoped.add(u.id);

  // M3: the rulings ledger and its sidecars (A3), holistic (A5), the vision (A14), the obligations.
  if (inputs.changed.rulings && proposer.type !== 'rule' && proposer.type !== 'bundle') {
    reasons.push(`the rulings ledger ${next.ledger.path} or its sidecars differ from the ledger in force: it is executor-owned after start (A3); a ruling lands through \`roadmap rule\``);
  }
  if (cur.holistic !== undefined && plan.holistic === undefined) reasons.push('holistic may be added, never removed (A5)');
  if (cur.holistic === undefined && plan.holistic !== undefined) changes.push({ type: 'holistic' });
  if (cur.holistic !== undefined && plan.holistic !== undefined && !same(cur.holistic.audit, plan.holistic.audit)) {
    reasons.push('holistic.audit may not change once holistic is in force');
  }
  const prevVision = input.revision.vision?.value ?? null;
  if (inputs.changed.vision && inputs.vision !== null && !same(prevVision, inputs.vision)) {
    if (proposer.type !== 'apply') reasons.push(`the vision is owner-only (A14): only an architect \`apply\` changes it, not a ${proposer.type}`);
    else {
      const why = visionEditReasons(prevVision, inputs.vision);
      reasons.push(...why);
      if (why.length === 0) changes.push({ type: 'vision', rev: inputs.vision.rev });
    }
  }
  // The arc's slice of the vision (owner-only, like the vision): it fits the revision's vision whatever changed.
  if (plan.holistic !== undefined && inputs.vision !== null) reasons.push(...advancesReasons(inputs.vision, plan.holistic.advances));
  if (cur.holistic !== undefined && plan.holistic !== undefined && !same(cur.holistic.advances, plan.holistic.advances)) {
    if (proposer.type !== 'apply') reasons.push(`holistic.advances is owner-only: only an architect \`apply\` changes it, not a ${proposer.type}`);
    else changes.push({ type: 'advances' });
  }
  const obligations = obligationRows(input, inputs, reasons);
  changes.push(...obligations.changes);
  specRows(input, inputs, specs, changes, reasons);

  if (reasons.length > 0) return { kind: 'rejected', reasons };
  // No change but other bytes (whitespace, key order): the new bytes come into force with no change listed.
  const sameInputs = !inputs.changed.rulings && !inputs.changed.obligations && !inputs.changed.vision;
  if (changes.length === 0 && bytesSha256(next.planBytes) === inForce.manifest.planSha256 && sameSpecs(input) && sameInputs) return { kind: 'unchanged' };
  return {
    kind: 'accepted', changes, scoped: plan.units.map((u) => u.id).filter((id) => scoped.has(id)), routings,
    dispositions: obligations.dispositions, dropped: obligations.dropped, inputs,
  };
}

type ObligationRows = Readonly<{
  changes: readonly PlanChange[];
  dispositions: Extract<Classified, { kind: 'accepted' }>['dispositions'];
  dropped: Extract<Classified, { kind: 'accepted' }>['dropped'];
}>;

/** The obligation edit classes (src/holistic/obligations.ts), mapped to plan changes; a split parent is never disposed. */
function obligationRows(input: ClassifyInput, inputs: NextInputs, reasons: string[]): ObligationRows {
  const prev = input.revision.obligations?.value ?? null;
  const next = inputs.obligations;
  const none = { changes: [], dispositions: [], dropped: [] };
  if (prev !== null && input.next.obligations === null) {
    if (input.next.plan.holistic !== undefined) reasons.push('the obligations file may not be dropped once in force; retire each obligation by a ruling instead');
    return none;
  }
  if (next === null || !inputs.changed.obligations) return none;
  const author = input.proposer.type === 'bundle' ? { type: 'checkpoint' as const, cites: input.proposer.cites } : { type: 'architect' as const };
  const v = classifyObligations(prev, next, {
    vision: inputs.vision, rulings: inputs.sidecars, author,
    latched: new Set(input.view.holistic().latched.map((l) => l.obligation)), published: new Set(input.view.publications().map((p) => p.unit)),
  });
  reasons.push(...v.reasons);
  const changes: PlanChange[] = [];
  const dispositions: ObligationRows['dispositions'][number][] = [];
  const dropped: ObligationRows['dropped'][number][] = [];
  const edited = new Set<string>();
  for (const c of v.changes) {
    if (c.type === 'disposed') {
      const was = prev?.obligations.find((o) => o.id === c.id);
      if (was?.state.type === 'split') {
        reasons.push(`${c.id} is split into ${was.state.children.join(', ')} and stays split: disposition its children instead (H14)`);
        continue;
      }
      dispositions.push({ obligation: c.id, disposition: c.disposition, ruling: c.ruling });
    }
    if (c.type === 'split' && c.dropped.length > 0) dropped.push({ obligation: c.id, sentences: c.dropped });
    changes.push({ type: 'obligation', id: c.id, edit: c.type });
    edited.add(`${c.id}\u0000${c.type}`);
  }
  // A changed arc lane re-witnesses every obligation it witnesses (their proof judgments bind its laneRev).
  for (const o of next.obligations) {
    if (o.witness === null || !v.lanes.includes(o.witness.lane) || edited.has(`${o.id}\u0000witness`) || edited.has(`${o.id}\u0000added`)) continue;
    if (prev?.obligations.some((p) => p.id === o.id) !== true) continue;
    changes.push({ type: 'obligation', id: o.id, edit: 'witness' });
  }
  if (v.mapping) changes.push({ type: 'mapping' });
  const units = new Set(input.next.plan.units.map((u) => u.id));
  for (const o of next.obligations) {
    const unknown = isExempt(o) ? [] : o.deliveredBy.filter((u) => !units.has(u));
    if (unknown.length > 0) reasons.push(`${o.id} is delivered by ${unknown.join(', ')}, which the plan does not list`);
  }
  return { changes, dispositions, dropped };
}

/**
 * The spec rows of every unit the revision adds or whose spec or entry it changes: its declared obligations exist and
 * cover every non-exempt obligation of a mapping pattern that may overlap its scope (prefix-conservative); a `repair`
 * unit declares repairs, each an obligation or a finding of the arc.
 */
function specRows(input: ClassifyInput, inputs: NextInputs, specs: ReadonlyMap<UnitId, SpecM1>, changes: readonly PlanChange[], reasons: string[]): void {
  const touched = new Set<UnitId>(changes.flatMap((c) => (c.type === 'spec' || c.type === 'unit-added' || c.type === 'unit-changed' ? [c.unit] : [])));
  const obligations = inputs.obligations;
  const findings = new Set<string>(input.view.holistic().findings.map((f) => f.id));
  for (const unit of input.next.plan.units) {
    const spec = specs.get(unit.id);
    if (!touched.has(unit.id) || spec === undefined) continue;
    const declared = specObligations(spec);
    const byId = new Map((obligations?.obligations ?? []).map((o) => [o.id, o]));
    const unknown = declared.filter((id) => !byId.has(id));
    if (unknown.length > 0) reasons.push(`unit ${unit.id} declares obligations ${unknown.join(', ')}, which are not in force`);
    if (obligations !== null) {
      const scope = [...new Set([...unit.scope, ...spec.scope])];
      const owed = [...new Set(obligations.mapping.paths.filter((m) => scope.some((p) => mayOverlap(p, m.pattern))).flatMap((m) => m.obligations))]
        .filter((id) => !isExempt(byId.get(id)!) && !declared.includes(id)).sort();
      if (owed.length > 0) reasons.push(`unit ${unit.id}'s scope may touch paths mapped to ${owed.join(', ')}; its spec declares them in \`obligations\``);
    }
    const repairs = specRepairs(spec);
    if (unit.origin === 'repair' && repairs.length === 0) reasons.push(`unit ${unit.id} is a repair unit: its spec names what it repairs in \`repairs\``);
    const bad = repairs.filter((r) => (r.startsWith('F-') ? !findings.has(r) : !byId.has(r as ObligationId)));
    if (bad.length > 0) reasons.push(`unit ${unit.id} repairs ${bad.join(', ')}, which the arc does not hold`);
  }
}

/** Whether every unit's spec file is its spec in force (by hash). */
function sameSpecs(input: ClassifyInput): boolean {
  return [...input.next.specs].every(([unit, file]) => {
    if (file.bytes === null) return false;
    const sha = bytesSha256(file.bytes);
    const u = input.view.unit(unit);
    return sha === (u.pendingRevision?.sha256 ?? u.spec?.sha256 ?? input.inForce.manifest.specs[unit]);
  });
}

// ---------------------------------------------------------------------------------------------------
// Command scopes (A12)

const ARC: CommandScope = { type: 'arc' };
const NONE: CommandScope = { type: 'none' };
const unitsScope = (units: Iterable<UnitId>): CommandScope => {
  const sorted = [...new Set(units)].sort();
  return sorted.length === 0 ? NONE : { type: 'units', units: sorted };
};

/**
 * The scope of an accepted apply's changes: routing, resource and pool, capacity and the other plan-wide
 * fields, and suite edits → the arc; unit and spec edits, cuts and re-entries → those units (a re-entry's old
 * unit too); an order change → the units whose relative order moved.
 */
export function changesScope(changes: readonly PlanChange[], cur: PlanM1, next: PlanM1): CommandScope {
  const units = new Set<UnitId>();
  for (const c of changes) {
    switch (c.type) {
      case 'routing':
      case 'limits':
        if (c.unit === undefined || c.unit === null) return ARC;
        units.add(c.unit);
        break;
      case 'resource':
      case 'suite':
      case 'plan-field':
      case 'obligation':
      case 'mapping':
      case 'vision':
      case 'holistic':
      case 'advances':
        return ARC;
      case 'unit-added':
      case 'unit-removed':
      case 'unit-changed':
      case 'unit-cut':
      case 'spec':
        units.add(c.unit);
        break;
      case 'unit-reentered':
        units.add(c.unit).add(c.reenters);
        break;
      case 'order': {
        const nextIds = next.units.map((u) => u.id);
        const was = cur.units.map((u) => u.id).filter((id) => nextIds.includes(id));
        const now = nextIds.filter((id) => was.includes(id));
        was.forEach((id, i) => {
          if (now[i] !== id) units.add(id);
        });
        break;
      }
    }
  }
  return unitsScope(units);
}

// ---------------------------------------------------------------------------------------------------
// An apply's proposal (G15)

/**
 * The proposal an `apply` command makes: the files as they are, when they still hash to its manifest. A 1.0.0-dev.5
 * command's plan manifest (G15, `applyInputsOf`) is read as the ledger live (the files' own), no obligations and no
 * vision; its bytes are never rewritten. Otherwise why it no longer holds: files missing, or changed since hashed.
 */
export function applyProposal(files: InputFiles, manifest: ApplyManifest): Readonly<{ next: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const actual = revisionManifestOf(files);
  if ('missing' in actual) return { reasons: actual.missing };
  if (isRevisionManifest(manifest)) {
    return same(actual, manifest) ? { next: files } : { reasons: [manifestMismatch(files, manifest, actual)] };
  }
  const inputs = applyInputsOf(manifest);
  if (inputs.rulings !== 'live') throw new Error('a plan manifest reads the ledger live');
  const proposal: InputFiles = { ...files, obligations: inputs.obligations, vision: inputs.vision };
  return same(planManifestOf(actual), planManifestOf(manifest)) ? { next: proposal } : { reasons: [manifestMismatch(files, manifest, actual)] };
}

/** Which files no longer hash to what the command's manifest recorded. */
function manifestMismatch(files: InputFiles, expected: ApplyManifest, actual: RevisionManifest): string {
  const differ: string[] = [];
  if (expected.planSha256 !== actual.planSha256) differ.push(files.planFile);
  const units = new Set([...Object.keys(expected.specs), ...Object.keys(actual.specs)] as UnitId[]);
  for (const u of [...units].sort()) {
    if (expected.specs[u] !== actual.specs[u]) differ.push(files.specs.get(u)?.path ?? `the spec of ${u} (no longer in the plan)`);
  }
  if (isRevisionManifest(expected)) {
    if (!same(expected.rulings, actual.rulings)) differ.push(files.ledger.path);
    if (expected.obligations !== actual.obligations) differ.push(files.obligations?.path ?? 'the obligations file (no longer in the plan)');
    if (expected.vision !== actual.vision) differ.push(files.vision?.path ?? 'the vision file (no longer in the plan)');
  }
  return `the files changed since \`roadmap apply\` hashed them: ${differ.join(', ')}; run it again`;
}

// ---------------------------------------------------------------------------------------------------
// Command scopes, continued

/** What an apply's scope reads: its classification's inputs. */
export type ScopeContext = Readonly<{
  runDir: AbsPath;
  hostDir: AbsPath;
  planFile: AbsPath;
  routingBase: RoutingBase;
}>;

/**
 * A12's `ScopeOf`, bound to what an apply's classification reads: `resume` (all) → the arc; `resume <u>` →
 * {u}; `resume --backend`, `sweep`, `resolve-edge`, `run-only` → none; `apply` → its changes' scope
 * (`changesScope`) over the files as they are; none when it would be rejected or change nothing (it then
 * touches nothing); the arc when the files no longer hash to its manifest (they may be restored before it
 * applies, so nothing narrower is safe).
 */
export function commandScope(sc: ScopeContext): ScopeOf {
  return (body, view) => {
    switch (body.type) {
      case 'resume':
        return body.target.type === 'all' ? ARC : body.target.type === 'unit' ? unitsScope([body.target.unit]) : NONE;
      case 'sweep':
      case 'resolve-edge':
      case 'run-only':
      case 'rule':
      case 'audit':
      case 'close-admissions':
        return NONE;
      // M3 (plan "Commands"): `reverse` restores revisions of any artifact; `steer` and `merge-in` touch their unit.
      case 'reverse':
        return ARC;
      case 'steer':
      case 'merge-in':
        return unitsScope([body.unit]);
      case 'apply': {
        const inForce = planInForce(sc.runDir, view);
        if (inForce === null) return NONE;
        let files: InputFiles;
        try {
          files = readInputFiles(sc.planFile);
        } catch (error) {
          if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
          return NONE;
        }
        const proposal = applyProposal(files, body.manifest);
        if ('reasons' in proposal) return ARC;
        const verdict = classify({
          runDir: sc.runDir, view, inForce, revision: revisionInForce(sc.runDir, inForce, sc.planFile), next: proposal.next,
          residues: undispositioned(sc.hostDir), routing: sc.routingBase, proposer: { type: 'apply' },
        });
        return verdict.kind === 'accepted' ? changesScope(verdict.changes, inForce.plan, proposal.next.plan) : NONE;
      }
    }
  };
}
