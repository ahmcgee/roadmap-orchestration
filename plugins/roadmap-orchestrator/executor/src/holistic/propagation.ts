// The code-applied propagation revision (dev.17, experience-won E; DESIGN-1.0.md §2.8 "Propagation"; SCHEMAS.md "dev.17:
// propagation"): the merged artifacts a requirement or contract change left stale (the witness links of a stale set,
// src/holistic/staleset.ts) are re-witnessed by a propagation unit code mints, one per changed requirement and one per
// changed contract, through THE admit path a checkpoint `admit` and a polish proposal take (src/holistic/bundle.ts
// `admitUnit`, `fillMappedObligations`, then the classifier, `evaluateRevision`). No model call.
//
// Due (`propagationDue`): the first stale set, in log order, with a witness group (a changed requirement, a changed contract)
// that no unit of the plan carries and no refusal settled. Each such group is refused (`propagation-refused{rev, target,
// reasons}`, settled: never minted) when
//   - the arc is draining (admissions closed);
//   - none of its witness files is at the integration tip (nothing merged to re-witness: a future obligation not yet
//     delivered, say);
//   - the admit path or the classifier refuses its unit minted alone.
// The rest are minted together, each a unit `propagate-r<rev>-<target>` with origin `propagation` (milestone-exempt, ranked
// with repairs), `propagation{rev, target}`, risk `med`, no resources, `after` the propagation units of the same target still to
// land, its scope the witness files at the tip (the stale files), and a spec code writes: one acceptance clause per obligation
// it re-witnesses (its witness verifies it as now stated), facts naming what changed, the obligations it declares (the
// mapping's for its scope added, as for every code-written spec) and their pins at the revisions in force, the contract cited
// and pinned at the tip. Its proof is its candidate: the brake grades each declared obligation held there, at its new rev. The
// whole revision refused (the units refused together, each accepted alone) refuses each with its reasons. The commit is
// `plan-applied{source: propagation{rev}}` with proposer `propagation{rev}` (src/input/classify.ts `propagationRows`); a
// commit the arc moved under is retried at the next run.
// Crash labels: `propagation.after-refused` (a refusal written, the revision not yet), `propagation.after-revision`.
import { join } from 'node:path';
import { crashPoint } from '../core/crash.ts';
import type { ObligationId, PlanRev, Sha, UnitId } from '../core/ids.ts';
import { unitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { sha256Hex } from '../core/json.ts';
import { type PropagationTarget, causeKey } from '../core/stale.ts';
import { SchemaError } from '../core/validate.ts';
import { type AbsPath, type RepoPath, absPath, branchRef, repoPattern } from '../core/values.ts';
import { type FencedCommitContext, type RevisionVerdict, commitUnderFence, evaluateRevision } from '../commands/apply.ts';
import { git, gitRun, revParse } from '../git/git.ts';
import {
  type InputFile, type InputFiles, inForceFiles, obligationsAtRev, payloadAtRev, requirePlanInForce, revisionInForce,
} from '../input/inforce.ts';
import { type PlanM1, type PropagationOrigin, parsePlan } from '../input/plan.ts';
import { parseSpec, specBytes } from '../spec/spec.ts';
import { type RawPlan, admitUnit, fillMappedObligations } from './bundle.ts';
import { pendingPropagations, pinsOf, witnessGroups } from './staleset.ts';
import type { ObligationDef, Obligations } from './types.ts';

/** What the propagation revision needs: the fenced commit's context and the repository. */
export type PropagationContext = FencedCommitContext & Readonly<{ repo: AbsPath }>;

/** One propagation a stale set asks for: its target, the obligations it re-witnesses and their witness files. */
type Item = Readonly<{ target: PropagationTarget; obligations: readonly ObligationId[]; files: readonly RepoPath[] }>;
type Due = Readonly<{ rev: PlanRev; items: readonly Item[] }>;

const itemKey = (rev: PlanRev, target: PropagationTarget): string => `${rev}|${causeKey(target)}`;

/** The stale set whose propagations the revision has yet to settle, with them (see the header); null when none. */
export function propagationDue(view: JournalView, plan: PlanM1): Due | null {
  const settled = new Set([
    ...plan.units.flatMap((u) => (u.propagation === undefined ? [] : [itemKey(u.propagation.rev, u.propagation.target)])),
    ...view.propagationFacts().flatMap((x) => (x.fact.kind === 'propagation-refused' ? [itemKey(x.fact.rev, x.fact.target)] : [])),
  ]);
  for (const x of view.propagationFacts()) {
    if (x.fact.kind !== 'stale-set') continue;
    const set = x.fact;
    const items = witnessGroups(set).flatMap((g): Item[] => {
      let target: PropagationTarget;
      if (g.cause.type === 'requirement') {
        const id = g.cause.id;
        const t = set.targets.find((s) => s.type === 'requirement' && s.id === id);
        if (t?.type !== 'requirement') throw new Error(`the stale set of rev ${set.rev} has a witness link of ${id}, which is none of its requirement targets`);
        target = { type: 'requirement', id, rev: t.to };
      } else target = { type: 'contract', path: g.cause.path };
      if (settled.has(itemKey(set.rev, target))) return [];
      return [{ target, obligations: [...new Set(g.links.map((l) => l.obligation))].sort(), files: [...new Set(g.links.flatMap((l) => l.files))].sort() }];
    });
    if (items.length > 0) return { rev: set.rev, items };
  }
  return null;
}

/** Whether the propagation revision has a stale set to settle now (the scheduler's question). */
export const propagationPending = (ctx: PropagationContext): boolean => propagationDue(ctx.journal.view, requirePlanInForce(ctx.runDir, ctx.journal.view).plan) !== null;

/** The id of the propagation unit of `target` in the stale set of `rev`. */
export function propagationUnitId(rev: PlanRev, target: PropagationTarget): UnitId {
  const slug = target.type === 'requirement' ? target.id.toLowerCase() : `c-${sha256Hex(target.path).slice(0, 8)}`;
  return unitId(`propagate-r${rev}-${slug}`);
}

/** What the change was, for the facts of the spec: the requirement's statement before and after, or the contract's ops. */
function changeFacts(ctx: PropagationContext, rev: PlanRev, item: Item, now: Obligations | null): readonly string[] {
  const view = ctx.journal.view;
  const t = item.target;
  if (t.type === 'requirement') {
    const before = obligationsAtRev(view, ctx.runDir, rev - 1)?.obligations.find((o) => o.id === t.id);
    const after = now?.obligations.find((o) => o.id === t.id);
    return [
      `Requirement ${t.id} changed at plan rev ${rev}: from rev ${before?.rev ?? '?'} ("${before?.statement ?? '?'}") to rev ${t.rev} ("${after?.statement ?? '?'}").`,
      `The files in scope are its witness files, which were written against its earlier rev: bring them in line with rev ${t.rev} so its witness verifies it as now stated.`,
    ];
  }
  const ops = (payloadAtRev(view, ctx.runDir, rev).publication?.contractOps ?? []).filter((o) => o.path === t.path);
  return [
    `Contract ${t.path} changed at plan rev ${rev}: ${ops.map((o) => `at ${o.anchor}, "${o.oldText}" became "${o.newText}"`).join('; ') || 'its text was rewritten'}.`,
    `The files in scope are the witness files of the obligations that bind it (${item.obligations.join(', ')}): bring them in line with the contract as it now reads.`,
  ];
}

/** The spec code writes for `item`'s propagation unit (spec.json's text, before the mapping's obligations and the pins). */
function propagationSpec(ctx: PropagationContext, plan: PlanM1, rev: PlanRev, id: UnitId, item: Item, files: readonly RepoPath[], now: Obligations | null): string {
  const byId = new Map<string, ObligationDef>((now?.obligations ?? []).map((o) => [o.id, o]));
  const acceptance = item.obligations.map((oid, i) => {
    const o = byId.get(oid);
    if (o?.witness === undefined || o.witness === null) throw new Error(`the propagation of ${causeKey(item.target)} re-witnesses ${oid}, which has no witness in force`);
    return {
      id: `A${i + 1}`, state: 'active', failLoudIfUndelivered: true,
      clause: `${oid} (rev ${o.rev}) holds as now stated, and its witness verifies it: lane ${o.witness.lane}, tests ${o.witness.testIds.join(', ')}. Statement: ${o.statement}`,
    };
  });
  const facts = changeFacts(ctx, rev, item, now).map((text, i) => ({ id: `F${i + 1}`, text, state: 'active' }));
  const contracts = item.target.type === 'contract' && plan.contracts.includes(item.target.path) ? [item.target.path] : [];
  return JSON.stringify({
    schema: 'roadmap/spec-m1', unit: id, rev: 1, lanes: [], acceptance, scope: files, resources: [], decisions: [], facts,
    cites: { contracts, rulings: [] }, obligations: item.obligations,
  });
}

/** The revision in force with `items` minted, or every reason the admit path refuses. */
function mintedFiles(
  ctx: PropagationContext, current: InputFiles, rev: PlanRev, items: readonly Readonly<{ item: Item; files: readonly RepoPath[] }>[], blobAt: (path: RepoPath) => Sha | null,
): Readonly<{ files: InputFiles }> | Readonly<{ reasons: readonly string[] }> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const now = revisionInForce(ctx.runDir, inForce).obligations?.value ?? null;
  const raw = JSON.parse(current.planBytes.toString('utf8')) as RawPlan;
  const specs = new Map<UnitId, InputFile>(current.specs);
  const specPath = (id: UnitId): AbsPath => absPath(join(ctx.planFile, '..', `${id}.json`));
  const reasons: string[] = [];
  const pending = pendingPropagations(view, inForce.plan);
  for (const { item, files } of items) {
    const id = propagationUnitId(rev, item.target);
    const after = pending.filter((u) => causeKey(u.propagation!.target) === causeKey(item.target)).map((u) => u.id);
    const origin: PropagationOrigin = { rev, target: item.target };
    const admitted = admitUnit(raw, specs, { id, risk: 'med', scope: files.map((p) => repoPattern(p)), after, resources: [], origin: 'propagation', propagation: origin },
      propagationSpec(ctx, inForce.plan, rev, id, item, files, now), specPath(id), `the propagation of ${causeKey(item.target)} (unit ${id})`);
    if ('reasons' in admitted) reasons.push(...admitted.reasons);
  }
  if (reasons.length > 0) return { reasons };
  const planBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  let plan: PlanM1;
  try {
    plan = parsePlan(JSON.parse(planBytes.toString('utf8')));
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    return { reasons: [`the plan with the propagation units minted does not parse: ${error.message}`] };
  }
  const minted = new Set(items.map(({ item }) => propagationUnitId(rev, item.target)));
  fillMappedObligations(now, plan, specs, minted);
  // The pins of every link the minted spec carries, at the revisions in force and the tip.
  for (const id of minted) {
    const f = specs.get(id)!;
    const spec = parseSpec(f.bytes!, f.path);
    specs.set(id, { path: f.path, bytes: specBytes({ ...spec, pins: pinsOf(spec, now, blobAt) }) });
  }
  return { files: { ...current, plan, planBytes, specs: new Map(plan.units.map((u) => [u.id, specs.get(u.id) ?? { path: specPath(u.id), bytes: null }] as const)) } };
}

/** `items` minted and judged by the classifier: the accepted verdict, or the reasons. */
function evaluate(
  ctx: PropagationContext, current: InputFiles, rev: PlanRev, items: readonly Readonly<{ item: Item; files: readonly RepoPath[] }>[], blobAt: (path: RepoPath) => Sha | null,
): Extract<RevisionVerdict, { kind: 'accepted' }> | Readonly<{ kind: 'rejected'; reasons: readonly string[] }> {
  const built = mintedFiles(ctx, current, rev, items, blobAt);
  if ('reasons' in built) return { kind: 'rejected', reasons: built.reasons };
  const rctx = { runDir: ctx.runDir, view: ctx.journal.view, hostDir: ctx.hostDir, planFile: ctx.planFile, routingBase: ctx.routingBase, laneEnv: ctx.laneEnv };
  const verdict = evaluateRevision(rctx, built.files, { type: 'propagation', rev });
  if (verdict.kind === 'unchanged') throw new Error(`the propagation revision of rev ${rev} left the plan unchanged`);
  return verdict;
}

export type PropagationOutcome =
  | Readonly<{ kind: 'none' }>
  /** The due stale set's propagations are settled: `minted` in one revision (none when every one was refused), the rest refused. */
  | Readonly<{ kind: 'applied'; minted: readonly UnitId[]; refused: readonly PropagationTarget[] }>
  /** The commit found the arc moved under it: the next run evaluates again. */
  | Readonly<{ kind: 'retry'; reasons: readonly string[] }>;

/** Settles the due stale set's propagations (see the header). */
export async function applyPropagation(ctx: PropagationContext): Promise<PropagationOutcome> {
  const view = ctx.journal.view;
  const inForce = requirePlanInForce(ctx.runDir, view);
  const due = propagationDue(view, inForce.plan);
  if (due === null) return { kind: 'none' };
  const tip = revParse(ctx.repo, branchRef(inForce.plan.integrationBranch));
  const atTip = new Set(git(ctx.repo, ['ls-tree', '-r', '-z', '--name-only', tip]).split('\0').filter((f) => f !== ''));
  const blobAt = (path: RepoPath): Sha | null => {
    const r = gitRun(ctx.repo, ['rev-parse', '--verify', '-q', `${tip}:${path}`], { okCodes: [0, 1, 128] });
    return r.code === 0 ? r.stdout.trim() as Sha : null;
  };
  const current = inForceFiles(ctx.runDir, view, inForce, revisionInForce(ctx.runDir, inForce), ctx.planFile, ctx.repo);
  const refused: PropagationTarget[] = [];
  const refuse = (item: Item, reasons: readonly string[]): void => {
    ctx.journal.fact({ kind: 'propagation-refused', rev: due.rev, target: item.target, reasons });
    refused.push(item.target);
    crashPoint('propagation.after-refused');
  };
  const draining = view.holistic().draining;
  const alone: { item: Item; files: readonly RepoPath[] }[] = [];
  for (const item of due.items) {
    const files = item.files.filter((f) => atTip.has(f));
    const pre: string[] = [];
    if (draining !== null) pre.push(`the arc is draining (admissions closed by ${draining.command}): no propagation unit is minted`);
    if (files.length === 0) pre.push(`none of its witness files (${item.files.join(', ')}) is at the integration tip ${tip}: nothing merged to re-witness`);
    const verdict = pre.length > 0 ? { kind: 'rejected' as const, reasons: pre } : evaluate(ctx, current, due.rev, [{ item, files }], blobAt);
    if (verdict.kind === 'rejected') refuse(item, verdict.reasons);
    else alone.push({ item, files });
  }
  if (alone.length === 0) return { kind: 'applied', minted: [], refused };
  const together = evaluate(ctx, current, due.rev, alone, blobAt);
  if (together.kind === 'rejected') {
    for (const { item } of alone) refuse(item, [`minted together with the rest of the stale set of rev ${due.rev}: ${together.reasons.join('; ')}`]);
    return { kind: 'applied', minted: [], refused };
  }
  const source = { type: 'propagation', rev: due.rev } as const;
  const out = await commitUnderFence(ctx, together, source, source, { type: 'arc' });
  if (out.kind === 'rejected') return { kind: 'retry', reasons: out.reasons };
  crashPoint('propagation.after-revision');
  return { kind: 'applied', minted: alone.map(({ item }) => propagationUnitId(due.rev, item.target)), refused };
}
