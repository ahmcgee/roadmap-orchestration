// The split revision (dev.17, design pass; DESIGN-1.0.md "Design pass"; SCHEMAS.md "dev.17: the design pass"). A plan-check
// that finds its unit oversize (mixed concerns, or more than the gate reads inline) answers `split`: child units, the edges
// among them and, for mixed concerns, the skeleton that lands first. Code builds and applies it:
//
//   specs      each child's spec is the parent's in force with the child's unit id, rev 1, its own scope, the parent's active
//              acceptance and witness items it takes (their text unchanged), the obligations it declares, its own pinned
//              design record, and the parent's active lanes, decisions, facts, cites, resources, removes, repairs and
//              forces; plus, when the skeleton's spanning lane is a batch lane, that lane forced on every child whose
//              design touches its systems (the skeleton included), so the spanning test runs for each.
//   plan       the parent cut (`splitCutReason`), the children inserted after it in topological order, each at the parent's
//              pinned risk floor (or its plan risk when higher), with its resources, `cpu`, routing layer, limits,
//              priority and origin, after the parent's own `after` and the children the edges put before it; every unit
//              that ran after the parent runs after every child; every milestone listing the parent lists the children.
//   checks     src/pipeline/design.ts `splitFaults` (scope, the items' partition, obligations, each child sized, acyclic,
//              the skeleton), then the apply core over the revision (`evaluateRevision`, proposer `split{unit, children}`,
//              src/input/classify.ts `splitRows`). Every reason is a plan defect: the repair turn, then a park.
//   apply      `plan-check split{children}` is recorded first (a hold: the unit leaves its task), then the revision
//              commits under the fence (`commitUnderFence`, source `split{unit, inv}`), cutting the held unit. Crash labels
//              `split.after-hold`, `split.after-commit`. A crash between them is finished at the next start
//              (`finishSplit`, from the recorded call); a commit the arc moved under is refused with a needs-user, and
//              `resume <unit>` re-runs the plan-check.
import { dirname, join, posix } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { DesignRecord } from '../core/design.ts';
import { type InvocationId, type LaneId, type Sha, type UnitId, specRev } from '../core/ids.ts';
import { type NeedsUserContent, SPEC_SCHEMA, type SpecM1, effectiveScope, specForces, specWitnesses } from '../core/records.ts';
import { maxTier } from '../core/state.ts';
import { SchemaError } from '../core/validate.ts';
import { absPath } from '../core/values.ts';
import { type FencedCommitContext, type RevisionVerdict, commitUnderFence, evaluateRevision } from '../commands/apply.ts';
import { type Proposer, splitCutReason } from '../input/classify.ts';
import { type InputFile, type InputFiles, inForceFiles, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { type PlanM1, type PlanUnit, parsePlan } from '../input/plan.ts';
import { dependentsClosure } from '../input/systems.ts';
import type { SplitDecision, UnitSplitChild } from '../prompts/schemas.ts';
import { DOCS_NOT_YET } from '../recover/revision.ts';
import { specBytes } from '../spec/spec.ts';
import { type DesignFaults, splitFaults } from './design.ts';
import { type StageContext, type StageParent, dispatchOf } from './dispatch.ts';
import { mapInForce } from './lanes.ts';
import { holisticInForce, loadUnitSpec } from './stages.ts';

/** The lanes the skeleton's spanning lane adds to a child's forces: the lane, when it is a batch lane the child's design touches. */
function skeletonForces(ctx: Pick<StageContext, 'plan' | 'journal' | 'runDir'>, split: SplitDecision, design: DesignRecord): readonly LaneId[] {
  if (split.skeleton === null) return [];
  const id = split.skeleton.lane;
  const lane = [...ctx.plan().suite.lanes, ...(holisticInForce(ctx).obligations?.lanes ?? [])].find((l) => l.id === id);
  if (lane === undefined || lane.cadence !== 'batch') return [];
  const map = mapInForce(ctx.journal.view);
  if (map === null || lane.systems === undefined || design.changes.some((c) => c.system === null)) return [id];
  const touched = dependentsClosure(map, design.changes.flatMap((c) => (c.system === null ? [] : [c.system])));
  return lane.systems.some((s) => touched.has(s)) ? [id] : [];
}

/** A child's spec as the split lands it (see the header). */
export function childSpec(parent: SpecM1, child: UnitSplitChild, design: DesignRecord, extraForces: readonly LaneId[]): SpecM1 {
  const takes = new Set<string>(child.items);
  const active = <T extends Readonly<{ state: string }>>(items: readonly T[]): readonly T[] => items.filter((i) => i.state === 'active');
  const witnesses = active(specWitnesses(parent)).filter((w) => takes.has(w.id));
  const forces = [...new Set([...specForces(parent), ...extraForces])];
  return {
    schema: SPEC_SCHEMA,
    unit: child.unit,
    rev: specRev(1),
    lanes: active(parent.lanes),
    acceptance: active(parent.acceptance).filter((a) => takes.has(a.id)),
    scope: child.scope,
    resources: parent.resources,
    decisions: active(parent.decisions),
    facts: active(parent.facts),
    cites: parent.cites,
    ...(child.obligations.length === 0 ? {} : { obligations: child.obligations }),
    ...(parent.repairs === undefined ? {} : { repairs: parent.repairs }),
    ...(witnesses.length === 0 ? {} : { witnesses }),
    ...(parent.removes === undefined ? {} : { removes: parent.removes }),
    ...(forces.length === 0 ? {} : { forces }),
    design,
  };
}

/** The children in an order every edge respects (`from` first), stable in answer order otherwise. */
function topological(split: SplitDecision): readonly UnitSplitChild[] {
  const out: UnitSplitChild[] = [];
  const left = [...split.children];
  while (left.length > 0) {
    const i = left.findIndex((c) => !split.edges.some((e) => e.to === c.unit && left.some((l) => l.unit === e.from)));
    if (i < 0) throw new Error('a split with a cycle reached its plan: splitFaults refuses one first');
    out.push(left.splice(i, 1)[0]!);
  }
  return out;
}

type RawUnit = Record<string, unknown> & { id: string; after?: string[] };
type RawPlan = Record<string, unknown> & { units: RawUnit[]; milestones?: (Record<string, unknown> & { units: string[] })[] };

/** The revision in force with `split` of `unit` applied (see the header), or why it cannot be built. */
function splitFiles(
  ctx: StageContext, unit: PlanUnit, parent: SpecM1, split: SplitDecision, designs: ReadonlyMap<UnitId, DesignRecord>,
): Readonly<{ files: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const raw = JSON.parse(current.planBytes.toString('utf8')) as RawPlan;
  const at = raw.units.findIndex((u) => u.id === unit.id);
  const entry = raw.units[at];
  if (entry === undefined) throw new Error(`split of ${unit.id}: not in the plan in force`);
  const children = topological(split);
  const ids = children.map((c) => c.unit as string);
  const risk = maxTier(unit.risk, dispatchOf(view, unit.id).riskFloor);
  const specDir = posix.dirname(unit.spec);
  const specPath = (id: string): string => (specDir === '.' ? `${id}.json` : `${specDir}/${id}.json`);
  const keep = ['resources', 'origin', 'cpu', 'routing', 'limits', 'priority'] as const;
  const rawChildren = children.map((c): RawUnit => ({
    id: c.unit, spec: specPath(c.unit), risk, scope: [...c.scope],
    ...Object.fromEntries(keep.flatMap((k) => (entry[k] === undefined ? [] : [[k, entry[k]]]))),
    after: [...(entry.after ?? []), ...split.edges.filter((e) => e.to === c.unit).map((e) => e.from)],
  }));
  entry['cut'] = { reason: splitCutReason(ids as UnitId[]) };
  raw.units.splice(at + 1, 0, ...rawChildren);
  for (const u of raw.units) {
    if (u.after?.includes(unit.id) === true && !ids.includes(u.id)) u.after = [...u.after.filter((a) => a !== unit.id), ...ids];
  }
  for (const m of raw.milestones ?? []) if (m.units.includes(unit.id)) m.units = m.units.flatMap((u) => (u === unit.id ? ids : [u]));
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  let plan: PlanM1;
  try {
    plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return { reasons: [`the plan with the split applied does not parse: ${error.message}`] };
  }
  const specs = new Map<UnitId, InputFile>(current.specs);
  for (const c of children) {
    const design = designs.get(c.unit);
    if (design === undefined) throw new Error(`split of ${unit.id}: child ${c.unit} without its pinned design`);
    const spec = childSpec(parent, c, design, skeletonForces(ctx, split, design));
    specs.set(c.unit, { path: absPath(join(dirname(ctx.planFile), specPath(c.unit))), bytes: specBytes(spec) });
  }
  return { files: { ...current, plan, planBytes, specs: new Map(plan.units.map((u) => [u.id, specs.get(u.id)!] as const)) } };
}

/** The proposer of the split of `unit` into `split`'s children. */
const proposerOf = (unit: UnitId, split: SplitDecision): Extract<Proposer, { type: 'split' }> => ({ type: 'split', unit, children: split.children.map((c) => c.unit) });

/** The split judged: its faults, or (none) the revision the apply core accepted. */
export type SplitVerdict = Readonly<{ kind: 'faults'; faults: DesignFaults }> | Readonly<{ kind: 'accepted'; evaluated: Extract<RevisionVerdict, { kind: 'accepted' }> }>;

/** Judges `split` of `unit` (its spec in force `parent`, the tip the plan-check read): code's checks, then the apply core's. */
export function judgeSplit(ctx: StageContext, unit: PlanUnit, parent: SpecM1, split: SplitDecision, tip: Sha): SplitVerdict {
  const scope = effectiveScope(dispatchOf(ctx.journal.view, unit.id));
  const designs = new Map<UnitId, DesignRecord>();
  const faults = splitFaults(ctx, parent, scope.include, split, tip, (c, d) => {
    designs.set(c.unit, d);
    return childSpec(parent, c, d, skeletonForces(ctx, split, d));
  });
  if (faults.reasons.length + faults.defects.length > 0) return { kind: 'faults', faults };
  const built = splitFiles(ctx, unit, parent, split, designs);
  if ('reasons' in built) return { kind: 'faults', faults: { reasons: [], defects: built.reasons } };
  const rctx = { runDir: ctx.runDir, view: ctx.journal.view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.hostEnv };
  const evaluated = evaluateRevision(rctx, built.files, proposerOf(unit.id, split));
  if (evaluated.kind === 'rejected') return { kind: 'faults', faults: { reasons: [], defects: evaluated.reasons.map((r) => `the split revision is refused: ${r}`) } };
  if (evaluated.kind === 'unchanged') throw new Error(`split of ${unit.id}: a cut and new units left the plan unchanged`);
  return { kind: 'accepted', evaluated };
}

/** The needs-user of a split the arc moved under before it could commit. */
function movedNeedsUser(unit: PlanUnit, reasons: readonly string[]): NeedsUserContent {
  return {
    blocking: true,
    subject: { type: 'unit', unit: unit.id },
    reason: 'plan-defect',
    summary: `Unit ${unit.id}: its plan-check split it, but the split revision no longer lands: ${reasons.join('; ')}. The unit is held at plan-check, uncharged.`,
    recommendation: `\`roadmap resume ${unit.id}\` runs its plan-check again on the plan as it is now.`,
    options: [],
    evidence: [],
  };
}

/** Commits the accepted split of `unit` (the plan-check's held attempt `parent`, call `inv`); a needs-user when the arc moved under it. */
export async function commitSplit(
  ctx: StageContext, unit: PlanUnit, parent: StageParent, inv: InvocationId, split: SplitDecision, evaluated: Extract<RevisionVerdict, { kind: 'accepted' }>,
): Promise<NeedsUserContent | null> {
  crashPoint('split.after-hold', unit.id);
  const fenced: FencedCommitContext = {
    journal: ctx.journal, runDir: ctx.runDir, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.hostEnv, docs: DOCS_NOT_YET,
  };
  const proposer = proposerOf(unit.id, split);
  const out = await commitUnderFence(fenced, evaluated, proposer, { type: 'split', unit: unit.id, inv }, parent);
  if (out.kind === 'rejected') return movedNeedsUser(unit, out.reasons);
  crashPoint('split.after-commit', unit.id);
  return null;
}

/** The answer a split hold recorded, judged again at the next start: what `finishSplit` lands (null when it no longer judges). */
export type HeldSplit = Readonly<{ split: SplitDecision; inv: InvocationId; tip: Sha }>;

/**
 * A crash between a `split` hold and its commit: the revision judged again from the held attempt's recorded answer against
 * the plan in force, and committed; a needs-user when it no longer lands (`resume` re-runs the plan-check). Null when the
 * unit is not so held (cut already, or held for another reason).
 */
export async function finishSplit(ctx: StageContext, unit: PlanUnit, held: HeldSplit, parent: StageParent): Promise<NeedsUserContent | null> {
  const verdict = judgeSplit(ctx, unit, loadUnitSpec(ctx, unit).spec, held.split, held.tip);
  if (verdict.kind === 'faults') return movedNeedsUser(unit, [...verdict.faults.reasons, ...verdict.faults.defects]);
  return commitSplit(ctx, unit, parent, held.inv, held.split, verdict.evaluated);
}
