// The classifier of a plan change (owner ruling 2026-09-29; SCHEMAS.md "Plan in force"): the files an apply
// (or a start) would put in force, against the plan in force and what the log says each unit has done. Every
// change is classified; any refused change refuses the whole apply, and the rejection lists every reason.
// Pure but for reading kept spec bytes and the rulings ledger (never the live spec in place of a kept one): no
// effect, so `apply --dry-run` runs it as is, and `apply` runs it again just before its commit (A12). The
// per-edit rules:
//
//   add a unit                  now; its id was never planned before; never already cut
//   remove a unit               only if it never started
//   unit order                  the started units keep their relative order (G3); a legacy arc keeps dev.4's
//                               rule, the started units first in their order (its frontier is plan order)
//   an undispatched unit        any plan field and its spec, now
//   a dispatched unit's plan    scope, risk, resources, spec path and a new `after`: refused (dropping an
//                               `after` is allowed)
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
// `commandScope` (A12) is the units a mutation must find idle or awaiting admission: an apply's follow from
// its classification.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IntentOf, PlanChange, PlanField } from '../core/events.ts';
import { PLAN_FIELDS } from '../core/events.ts';
import { type ResourceName, type ResourceUnit, type RulingId, type UnitId, parseResourceUnit } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { ResidueKey, SpecM1 } from '../core/records.ts';
import { type UnitState, maxTier } from '../core/state.ts';
import { isLegacy, unkeptSpecReason } from '../core/upgrade.ts';
import { SchemaError } from '../core/validate.ts';
import type { AbsPath } from '../core/values.ts';
import { undispositioned } from '../host/residues.ts';
import { withinEnvelope } from '../pipeline/prepare.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { cpuCapacity, overCapacity } from '../resources/pool.ts';
import { resourceTable } from '../resources/reserve.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import { effectiveGraph, findCycle } from '../schedule/graph.ts';
import type { CommandScope, ScopeOf } from '../schedule/types.ts';
import { loadRulings } from '../spec/rulings.ts';
import { SpecFileError, bytesSha256, parseSpec } from '../spec/spec.ts';
import { type InForce, type InputFiles, SPEC_INPUT, inputPath, keptInput, manifestOf, planInForce, readInputFiles } from './inforce.ts';
import type { PlanM1, PlanUnit } from './plan.ts';

export type Classified =
  | Readonly<{ kind: 'unchanged' }>
  /** `scoped`: the units whose plan entry or spec changed, for the startup rows an apply re-runs. */
  | Readonly<{ kind: 'accepted'; changes: readonly PlanChange[]; scoped: readonly UnitId[]; routing: ResolvedRouting | null }>
  | Readonly<{ kind: 'rejected'; reasons: readonly string[] }>;

export type ClassifyInput = Readonly<{
  runDir: AbsPath;
  view: JournalView;
  inForce: InForce;
  next: InputFiles;
  /** Residues on this host not yet disposed of: a resource they name keeps its declaration. */
  residues: readonly ResidueKey[];
  /** Resolves a plan's routing under the arc's profile and repo config. */
  resolve: (plan: PlanM1) => ResolvedRouting;
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
  input: ClassifyInput, unit: PlanUnit, u: UnitState, path: AbsPath, bytes: Buffer, spec: SpecM1,
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
  if (!same(was.scope, spec.scope) || !same(was.resources, spec.resources)) {
    return `unit ${unit.id} is dispatched: its spec's scope and resources may not change`;
  }
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

/** A plan unit without its M2 lifecycle fields, for comparing the rest of its entry. */
function entryOf(u: PlanUnit): Omit<PlanUnit, 'cut' | 'reenters'> {
  const { cut: _cut, reenters: _reenters, ...rest } = u;
  return rest;
}

/** Why `ruling` may not back `what`: not in the next plan's ledger, withdrawn, or the ledger does not load; null when it may. */
function rulingReason(next: InputFiles, ruling: RulingId, what: string): string | null {
  const file = join(dirname(next.planFile), next.plan.rulings);
  if (!existsSync(file)) return `${what} cites ruling ${ruling}, but the rulings ledger ${file} does not exist`;
  let rulings;
  try {
    rulings = loadRulings(file);
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return `${what} cites ruling ${ruling}, but the rulings ledger does not load: ${error.message}`;
  }
  const r = rulings.find((x) => x.id === ruling);
  if (r === undefined) return `${what} cites ruling ${ruling}, which the ledger ${file} does not hold`;
  return r.status === 'withdrawn' ? `${what} cites ruling ${ruling}, which ${r.by} withdrew` : null;
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
  view: JournalView, next: InputFiles, unit: PlanUnit, cutNow: ReadonlySet<UnitId>,
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
    const r = rulingReason(next, re.reset.ruling, `unit ${unit.id}'s reset`);
    if (r !== null) reasons.push(r);
  }
  return reasons.length > 0 ? reasons : { type: 'unit-reentered', unit: unit.id, reenters: re.unit, reset: re.reset !== undefined };
}

/** Whether a resource unit belongs to declaration `name`: the name itself, or an instance of the pool. */
function unitOf(u: ResourceUnit, name: ResourceName): boolean {
  const p = parseResourceUnit(u);
  return (p.type === 'named' && p.name === name) || (p.type === 'instance' && p.pool === name);
}

/** Classifies the files against the plan in force. */
export function classify(input: ClassifyInput): Classified {
  const { view, inForce, next } = input;
  const cur = inForce.plan;
  const plan = next.plan;
  const legacy = isLegacy(view);
  const reasons: string[] = [];
  const changes: PlanChange[] = [];
  const scoped = new Set<UnitId>();

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
    if (planned.has(u.id)) reasons.push(`unit id ${u.id} was planned before; ids are never reused`);
    else if (u.cut !== undefined) reasons.push(`unit ${u.id} is added cut; add it without \`cut\`, or leave it out`);
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
      const ruling = unit.cut.ruling === undefined ? null : rulingReason(next, unit.cut.ruling, `unit ${unit.id}'s cut`);
      if (refusal !== null) reasons.push(refusal);
      if (ruling !== null) reasons.push(ruling);
      if (refusal === null && ruling === null) {
        changes.push({ type: 'unit-cut', unit: unit.id });
        scoped.add(unit.id);
      }
    }
    const pinned = view.dispatchOf(unit.id) !== null;
    if (!same(entryOf(was), entryOf(unit))) {
      if (!pinned) {
        changes.push({ type: 'unit-changed', unit: unit.id });
        scoped.add(unit.id);
      } else {
        const fixed = (['spec', 'risk', 'scope', 'resources'] as const).filter((k) => !same(was[k], unit[k]));
        const added = unit.after.filter((a) => !was.after.includes(a));
        for (const k of fixed) reasons.push(`unit ${unit.id} is dispatched: its ${k} may not change`);
        if (added.length > 0) reasons.push(`unit ${unit.id} is dispatched: it may not run after ${added.join(', ')} as well`);
        if (fixed.length === 0 && added.length === 0) {
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
    const c = dispatchedSpec(input, unit, view.unit(unit.id), file.path, file.bytes, spec);
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
    const row = reentryRow(view, next, unit, cutNow);
    if ('type' in row) {
      changes.push(row);
      scoped.add(row.reenters);
    } else reasons.push(...row);
  }
  if (chains.length === 0) {
    const cycle = findCycle(effectiveGraph(plan.units));
    if (cycle !== null) reasons.push(`the unit graph has a cycle once each re-entered unit stands for its lineage's head: ${cycle.join(' → ')}`);
  }

  // Routing.
  let routing: ResolvedRouting | null = null;
  if (!same(cur.routing, plan.routing)) {
    const resolved = input.resolve(plan);
    if (resolved.rev !== input.resolve(cur).rev) {
      routing = resolved;
      changes.push({ type: 'routing', routingRev: resolved.rev });
    }
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

  if (reasons.length > 0) return { kind: 'rejected', reasons };
  // No change but other bytes (whitespace, key order): the new bytes come into force with no change listed.
  if (changes.length === 0 && bytesSha256(next.planBytes) === inForce.manifest.planSha256 && sameSpecs(input)) return { kind: 'unchanged' };
  return { kind: 'accepted', changes, scoped: plan.units.map((u) => u.id).filter((id) => scoped.has(id)), routing };
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
      case 'resource':
      case 'suite':
      case 'plan-field':
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

/** What an apply's scope reads: its classification's inputs. */
export type ScopeContext = Readonly<{
  runDir: AbsPath;
  hostDir: AbsPath;
  planFile: AbsPath;
  resolve: (plan: PlanM1) => ResolvedRouting;
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
        return NONE;
      case 'apply': {
        const inForce = planInForce(sc.runDir, view);
        if (inForce === null) return NONE;
        let next: InputFiles;
        try {
          next = readInputFiles(sc.planFile);
        } catch (error) {
          if (!(error instanceof SchemaError || error instanceof SyntaxError)) throw error;
          return NONE;
        }
        if (canonicalJson(manifestOf(next)) !== canonicalJson(body.manifest)) return ARC;
        const verdict = classify({ runDir: sc.runDir, view, inForce, next, residues: undispositioned(sc.hostDir), resolve: sc.resolve });
        return verdict.kind === 'accepted' ? changesScope(verdict.changes, inForce.plan, next.plan) : NONE;
      }
    }
  };
}
