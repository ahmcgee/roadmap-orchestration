// The classifier of a plan change (owner ruling 2026-09-29; SCHEMAS.md "Plan in force"): the files an apply
// (or a start) would put in force, against the plan in force and what the log says each unit has done. Every
// change is classified; any refused change refuses the whole apply, and the rejection lists every reason.
// Pure but for reading kept spec bytes (never the live file in their place): no effect, so `apply --dry-run`
// runs it as is. The per-edit rules:
//
//   add a unit                  now; its id was never planned before
//   remove a unit               only if it never started
//   unit order                  the started units stay first, in their order
//   an undispatched unit        any plan field and its spec, now
//   a dispatched unit's plan    scope, risk, resources, spec path and a new `after`: refused (dropping an
//                               `after` is allowed)
//   a dispatched unit's spec    lane evidenceGlobs/evidenceExcludes at its rev: in force at once (`evidence`);
//                               the next rev (`revision`), scope and resources unchanged: pending until the
//                               unit re-opens on it (an in-flight unit at its next stage boundary that allows
//                               it, a unit parked at a judgment stage by `resume <unit>`); taking a pending
//                               revision back (`withdrawn`); anything else, and any edit of a merged,
//                               approved, publishing, stopped or finally parked unit: refused
//   routing                     re-resolved; the caller refuses unsupported seats and smokes new backends
//   resources                   add: now; change or remove: refused while held or a residue names it
//   suite lanes                 now (the next candidate runs them); refused while a unit is at a candidate
//   arc, integrationBranch, baseline, worktreeRoot: always refused
import type { PlanChange, PlanField } from '../core/events.ts';
import { PLAN_FIELDS } from '../core/events.ts';
import type { ResourceName, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { canonicalJson } from '../core/json.ts';
import type { ResidueKey, SpecM1 } from '../core/records.ts';
import type { UnitState } from '../core/state.ts';
import { unkeptSpecReason } from '../core/upgrade.ts';
import { SchemaError } from '../core/validate.ts';
import type { AbsPath } from '../core/values.ts';
import { decidedBy } from '../pipeline/transitions.ts';
import { resourceTable } from '../resources/reserve.ts';
import type { ResolvedRouting } from '../routing/layers.ts';
import { SpecFileError, bytesSha256, parseSpec } from '../spec/spec.ts';
import { type InForce, type InputFiles, SPEC_INPUT, keptInput } from './inforce.ts';
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

/** Classifies the files against the plan in force. */
export function classify(input: ClassifyInput): Classified {
  const { view, inForce, next } = input;
  const cur = inForce.plan;
  const plan = next.plan;
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
  for (const u of cur.units) {
    if (nextIds.includes(u.id)) continue;
    if (started(view, u.id)) reasons.push(`unit ${u.id} has started; it cannot be removed`);
    else changes.push({ type: 'unit-removed', unit: u.id });
  }
  for (const u of plan.units) {
    if (curIds.includes(u.id)) continue;
    if (planned.has(u.id)) reasons.push(`unit id ${u.id} was planned before; ids are never reused`);
    else {
      changes.push({ type: 'unit-added', unit: u.id });
      scoped.add(u.id);
    }
  }
  const startedIds = curIds.filter((id) => started(view, id));
  if (!same(nextIds.slice(0, startedIds.length), startedIds)) {
    reasons.push(`the units that have started (${startedIds.join(', ')}) must stay first in plan order, in their order`);
  } else {
    const common = (ids: readonly UnitId[]) => ids.filter((id) => curIds.includes(id) && nextIds.includes(id) && !startedIds.includes(id));
    if (!same(common(curIds), common(nextIds))) changes.push({ type: 'order' });
  }

  // Units in both: their plan entries and their specs.
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
    if (was === undefined) continue;
    const pinned = view.dispatchOf(unit.id) !== null;
    if (!same(was, unit)) {
      if (!pinned) {
        changes.push({ type: 'unit-changed', unit: unit.id });
        scoped.add(unit.id);
      } else {
        const fixed = (['spec', 'risk', 'scope', 'resources'] as const).filter((k) => !same(was[k], unit[k]));
        const added = unit.after.filter((a) => !was.after.includes(a));
        for (const k of fixed) reasons.push(`unit ${unit.id} is dispatched: its ${k} may not change`);
        if (added.length > 0) reasons.push(`unit ${unit.id} is dispatched: it may not run after ${added.join(', ')} as well`);
        if (fixed.length === 0 && added.length === 0) changes.push({ type: 'unit-changed', unit: unit.id });
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

  // Routing.
  let routing: ResolvedRouting | null = null;
  if (!same(cur.routing, plan.routing)) {
    const resolved = input.resolve(plan);
    if (resolved.rev !== input.resolve(cur).rev) {
      routing = resolved;
      changes.push({ type: 'routing', routingRev: resolved.rev });
    }
  }

  // Resources.
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
    const entry = table.get(name);
    const held = entry !== undefined && (entry.pending !== null || entry.status.state !== 'free');
    const residue = input.residues.some((k) => k.resource === name);
    if (held || residue) {
      reasons.push(`resource ${name} is ${held ? `held (${entry?.status.state})` : 'named by an undisposed residue'}; its declaration may not change until it is free and swept`);
    } else {
      changes.push({ type: 'resource', resource: name, edit: now === undefined ? 'removed' : 'changed' });
    }
  }
  if (changes.some((c) => c.type === 'resource' && c.edit !== 'added')) for (const u of plan.units) scoped.add(u.id);

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
