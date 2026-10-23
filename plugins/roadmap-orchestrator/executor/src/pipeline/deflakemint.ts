// The code-applied deflake revision and the flaky ledger's items (dev.17; DESIGN-1.0.md §4 "Flaky ledger", SCHEMAS.md
// "dev.17: the flaky ledger"). What is due is src/pipeline/deflake.ts `deflakeDue`; this module acts on it. No model call.
//
// `applyDeflake` (the scheduler's `deflake` job, every arc, holistic or not):
//   1. each key flaking again after two deflake units raises one non-blocking `flake-recurring` item (subject the arc,
//      evidence the flake's red and green runs); no third deflake is minted. Raised once per flake (`recurringRaised`).
//   2. the keys due a deflake unit are admitted as deflake units in one revision under the revision fence, through THE admit
//      path (src/holistic/bundle.ts `admitUnit`, `fillMappedObligations`, then the classifier, `evaluateRevision`): one
//      unit per lane and count, `deflake-<n>`, origin `deflake` with its keys, risk `med`, `after: []` and in no milestone
//      (milestone-exempt), ranked with the repair units (`ORIGIN_RANK`). Its spec seed (`deflakeSpec`) carries the lane
//      (a spec lane copied from the unit that saw it; a suite lane in `forces`; an arc lane's failing tests as witness
//      items), the outcomes it may reach, the flakes it fixes, and the earlier deflake units of its keys (a second deflake
//      is told of the first). A lane no longer defined anywhere is due nothing. The commit is `plan-applied{source:
//      deflake}`, proposer `deflake` (src/input/classify.ts `deflakeRows`); a commit the arc moved under is retried at the
//      next run. Not while the arc drains (admissions closed).
//
// `raiseDeflakeParked` (each scheduler iteration): a deflake unit parked raises one non-blocking `deflake-parked` item per
// park, parented by the parking stage attempt, next to whatever item the park raises itself. Its edges dropped with the park
// (deflake.ts `deflakeHold`).
//
// Crash labels: `deflake.after-recurring` (an item raised, the revision not yet), `deflake.after-revision`.
import { join } from 'node:path';
import { type FencedCommitContext, commitUnderFence, evaluateRevision } from '../commands/apply.ts';
import { crashPoint } from '../core/crash.ts';
import type { Parent } from '../core/events.ts';
import type { FlakyKey } from '../core/flaky.ts';
import { type ClauseId, type UnitId, unitId, witnessItemIdOf } from '../core/ids.ts';
import type { Journal, JournalView } from '../core/interfaces.ts';
import { SPEC_SCHEMA, type SpecM1 } from '../core/records.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPattern, absPath, repoPattern } from '../core/values.ts';
import { type RawPlan, admitUnit, fillMappedObligations } from '../holistic/bundle.ts';
import { type InputFile, type InputFiles, inForceFiles, requirePlanInForce, revisionInForce } from '../input/inforce.ts';
import { lineageMembers } from '../input/envelope.ts';
import { type PlanM1, type PlanUnit, parsePlan } from '../input/plan.ts';
import { systemsMapInForce } from '../input/systems.ts';
import { raiseNeedsUser, raisedWithReason, readNeedsUser } from '../needsuser.ts';
import { parseSpec } from '../spec/spec.ts';
import { type MintGroup, type Recurring, deflakeDue, deflakeState, deflakeUnits, flakeRuns, keyLabel } from './deflake.ts';
import { invocationDir } from './invoke.ts';

/** What the deflake revision needs: the fenced commit's context and the repository. */
export type DeflakeContext = FencedCommitContext & Readonly<{ repo: AbsPath }>;

/** Whether `r`'s item is raised: a `flake-recurring` item whose evidence names its flake's red run. */
function recurringRaised(view: JournalView, runDir: AbsPath, r: Recurring): boolean {
  const red = invocationDir(runDir, r.flake.fact.event.red);
  return view.opsOf('needsuser.raise').some((i) => {
    if (view.doneOf(i.op) === null) return false;
    const item = readNeedsUser(runDir, i.expect.id);
    return item?.reason === 'flake-recurring' && item.evidence.includes(red);
  });
}

/** What the deflake job has to do now: the groups to mint (none while draining) and the recurring items not yet raised. */
function due(ctx: Readonly<{ runDir: AbsPath; journal: Readonly<{ view: JournalView }> }>, plan: PlanM1): Readonly<{ mint: readonly MintGroup[]; recurring: readonly Recurring[] }> {
  const view = ctx.journal.view;
  const d = deflakeDue(view, plan);
  return { mint: view.holistic().draining === null ? d.mint : [], recurring: d.recurring.filter((r) => !recurringRaised(view, ctx.runDir, r)) };
}

/** Whether the deflake job has work (the scheduler's question). */
export function deflakeJobPending(ctx: Readonly<{ runDir: AbsPath; journal: Readonly<{ view: JournalView }> }>): boolean {
  const d = due(ctx, requirePlanInForce(ctx.runDir, ctx.journal.view).plan);
  return d.mint.length > 0 || d.recurring.length > 0;
}

/** The `deflake-<n>` ids for `count` new units: the next free ones after the plan's deflake units. */
function nextIds(plan: PlanM1, count: number): readonly UnitId[] {
  const taken = new Set<string>(plan.units.map((u) => u.id));
  const out: UnitId[] = [];
  for (let n = deflakeUnits(plan).length + 1; out.length < count; n++) {
    const id = `deflake-${n}`;
    if (!taken.has(id)) out.push(unitId(id));
  }
  return out;
}

/** A group's lane as its set defines it now: a spec lane of the unit that saw it, a plan suite lane, an arc lane; null when gone. */
function laneSource(ctx: DeflakeContext, current: InputFiles, plan: PlanM1, g: MintGroup): Readonly<{ spec: SpecM1['lanes'][number] | null; owner: PlanUnit | null }> | null {
  const owner = g.flakes.map((x) => x.fact.owner).find((o) => o.type === 'unit');
  const ownerUnit = owner?.type === 'unit' ? plan.units.find((u) => u.id === owner.unit) ?? null : null;
  switch (g.set) {
    case 'spec': {
      if (ownerUnit === null) return null;
      const file = current.specs.get(ownerUnit.id);
      if (file?.bytes == null) return null;
      const spec = parseSpec(file.bytes, file.path);
      const lane = spec.lanes.find((l) => l.id === g.lane && l.state === 'active');
      return lane === undefined ? null : { spec: lane, owner: ownerUnit };
    }
    case 'suite':
      return plan.suite.lanes.some((l) => l.id === g.lane) ? { spec: null, owner: ownerUnit } : null;
    case 'arc': {
      const lanes = revisionInForce(ctx.runDir, requirePlanInForce(ctx.runDir, ctx.journal.view)).obligations?.value.lanes ?? [];
      return lanes.some((l) => l.id === g.lane) ? { spec: null, owner: ownerUnit } : null;
    }
  }
}

/** A deflake unit's scope: its lane's systems' paths and tests, else the scope of the unit whose spec lane it is, else the tree. */
function deflakeScope(plan: PlanM1, view: JournalView, g: MintGroup, owner: PlanUnit | null): readonly RepoPattern[] {
  const map = systemsMapInForce(view.planApplied());
  const def = plan.suite.lanes.find((l) => l.id === g.lane);
  if (map !== null && def?.systems !== undefined) {
    const out = new Set<RepoPattern>();
    for (const s of def.systems) for (const p of [...(map.systems[s]?.paths ?? []), ...(map.systems[s]?.tests ?? [])]) out.add(p);
    if (out.size > 0) return [...out].sort();
  }
  if (g.set === 'spec' && owner !== null) return owner.scope;
  return [repoPattern('**')];
}

/** The text of a deflake unit's spec (`unit` rev 1): its lane, outcomes, flakes and earlier deflakes (see the header). */
function deflakeSpec(id: UnitId, g: MintGroup, lane: SpecM1['lanes'][number] | null, scope: readonly RepoPattern[], view: JournalView): string {
  const keys = g.keys.map(keyLabel).join('; ');
  const testKeys = g.keys.filter((k): k is Extract<FlakyKey, { type: 'test' }> => k.type === 'test');
  const clause = 'A-1' as ClauseId;
  const spec = {
    schema: SPEC_SCHEMA, unit: id, rev: 1,
    lanes: lane === null ? [] : [{ ...lane, state: 'active' }],
    acceptance: [{
      id: clause, state: 'active', failLoudIfUndelivered: true,
      clause: `${keys} passes on every run of the same tree and environment: the nondeterminism that made it fail and then pass is gone.`,
    }],
    scope, resources: [],
    decisions: [{
      id: 'D-1', state: 'active',
      text: 'Two outcomes only. Fix the test or the code under it so that it is deterministic; or, when the lane needs more cpu or resources than it '
        + 'declares, say so (an infeasible plan-check naming the need), and the owner declares it through an apply. A cause outside the repository is the '
        + 'environment probe\'s to catch, never a reason to release the flake. Never quarantine, skip or weaken the test.',
    }],
    facts: [
      { id: 'F-1', state: 'active', text: `The flakes this unit fixes (each a red run, then a green rerun of the same tree): ${flakeRuns(g.flakes).join('; ')}.` },
      ...g.previous.map((d, i) => ({
        id: `F-${i + 2}`, state: 'active',
        text: `Deflake unit ${d} was minted for ${keys} before and is ${deflakeState(view, d)}; the flake came back after it. Read what it changed and why it was not enough.`,
      })),
    ],
    cites: { contracts: [], rulings: [] },
    ...(g.set === 'suite' ? { forces: [g.lane] } : {}),
    ...(g.set === 'arc' && testKeys.length > 0
      ? { witnesses: testKeys.map((k, i) => ({ id: witnessItemIdOf(i + 1), state: 'active', lane: k.lane, testId: k.testId, clause, skeleton: 'the existing test, unchanged in what it asserts' })) }
      : {}),
  };
  return JSON.stringify(spec);
}

export type DeflakeOutcome =
  | Readonly<{ kind: 'none' }>
  /** The recurring items raised, and the deflake units admitted in one revision (none when nothing was due). */
  | Readonly<{ kind: 'applied'; admitted: readonly UnitId[]; recurring: number }>
  /** The commit found the arc moved under it: the next run evaluates again. */
  | Readonly<{ kind: 'retry'; reasons: readonly string[] }>;

/** Raises the recurring items, then admits the due deflake units (see the header). */
export async function applyDeflake(ctx: DeflakeContext): Promise<DeflakeOutcome> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const d = due(ctx, inForce.plan);
  if (d.mint.length === 0 && d.recurring.length === 0) return { kind: 'none' };
  for (const r of d.recurring) {
    const { red, green } = r.flake.fact.event;
    raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking: false, subject: { type: 'arc' }, reason: 'flake-recurring',
      summary: `${keyLabel(r.key)} flaked again (${red} red, then ${green} green) after deflake units ${r.deflakes.join(' and ')}; no further deflake unit is minted.`,
      recommendation: 'Read both deflake units and the evidence of this flake, then fix the test or declare the lane\'s cpu or resource need with `roadmap apply`. The lane keeps running; nothing is quarantined.',
      options: [], evidence: [invocationDir(ctx.runDir, red), invocationDir(ctx.runDir, green)],
    }, { type: 'arc' });
    crashPoint('deflake.after-recurring');
  }
  if (d.mint.length === 0) return { kind: 'applied', admitted: [], recurring: d.recurring.length };
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const raw = JSON.parse(current.planBytes.toString('utf8')) as RawPlan;
  const specs = new Map<UnitId, InputFile>(current.specs);
  const sources = d.mint.flatMap((g) => {
    const s = laneSource(ctx, current, inForce.plan, g);
    return s === null ? [] : [{ g, ...s }];
  });
  // Every due lane is gone (no longer defined where it was): nothing to admit; the job waits like any job with nothing done.
  if (sources.length === 0) return d.recurring.length === 0 ? { kind: 'none' } : { kind: 'applied', admitted: [], recurring: d.recurring.length };
  const ids = nextIds(inForce.plan, sources.length);
  const reasons: string[] = [];
  sources.forEach(({ g, spec, owner }, i) => {
    const id = ids[i]!;
    const scope = deflakeScope(inForce.plan, view, g, owner);
    const admitted = admitUnit(raw, specs, { id, risk: 'med', scope, after: [], resources: [], origin: 'deflake', deflake: { keys: g.keys } },
      deflakeSpec(id, g, spec, scope, view), absPath(join(ctx.planFile, '..', `${id}.json`)), `deflake unit ${id}`);
    if ('reasons' in admitted) reasons.push(...admitted.reasons);
  });
  if (reasons.length > 0) throw new Error(`the deflake revision's own units are refused by the admit path: ${reasons.join('; ')}`);
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  let plan: PlanM1;
  try {
    plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    if (error instanceof SchemaError) throw new Error(`the plan with the deflake units admitted does not parse: ${error.message}`);
    throw error;
  }
  fillMappedObligations(revisionInForce(ctx.runDir, inForce).obligations?.value ?? null, plan, specs, new Set(ids));
  const files: InputFiles = { ...current, plan, planBytes, specs: new Map(plan.units.map((u) => [u.id, specs.get(u.id) ?? { path: absPath(join(ctx.planFile, '..', `${u.id}.json`)), bytes: null }] as const)) };
  const rctx = { runDir: ctx.runDir, view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const verdict = evaluateRevision(rctx, files, { type: 'deflake' });
  if (verdict.kind === 'rejected') throw new Error(`the deflake revision admitting ${ids.join(', ')} is refused: ${verdict.reasons.join('; ')}`);
  if (verdict.kind === 'unchanged') throw new Error(`admitting ${ids.join(', ')} left the plan unchanged`);
  const out = await commitUnderFence(ctx, verdict, { type: 'deflake' }, { type: 'deflake' }, { type: 'arc' });
  if (out.kind === 'rejected') return { kind: 'retry', reasons: out.reasons };
  crashPoint('deflake.after-revision');
  return { kind: 'applied', admitted: ids, recurring: d.recurring.length };
}

/** The parking stage attempt of `unit`, the parent of its `deflake-parked` item. */
function parkParent(view: JournalView, unit: UnitId): Parent {
  const d = view.unit(unit).decided;
  if (d === null) throw new Error(`deflake unit ${unit} is parked without a decided outcome`);
  return { type: 'stage', unit, stage: d.stage, attempt: d.attempt };
}

/** Raises one `deflake-parked` item per park of a deflake unit's lineage head (see the header). */
export function raiseDeflakeParked(ctx: Readonly<{ journal: Journal; runDir: AbsPath; plan: () => PlanM1 }>): void {
  const view = ctx.journal.view;
  for (const u of deflakeUnits(ctx.plan())) {
    if (deflakeState(view, u.id) !== 'parked') continue;
    const head = lineageMembers(view, u.id).at(-1)!;
    const parent = parkParent(view, head);
    if (raisedWithReason(view, ctx.runDir, parent, 'deflake-parked') !== null) continue;
    const keys = u.deflake!.keys.map(keyLabel).join('; ');
    raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking: false, subject: { type: 'unit', unit: head }, reason: 'deflake-parked',
      summary: `Deflake unit ${head} (${keys}) parked; the units held for it run again, with the flake forgiven as before.`,
      recommendation: `Answer the park's own item and \`roadmap resume ${head}\`, or declare the lane's cpu or resource need with \`roadmap apply\` and cut ${head}.`,
      options: [], evidence: [],
    }, parent);
  }
}
