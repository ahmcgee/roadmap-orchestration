// The handover (dev.17, field feedback 2026-10-23 item 1; DESIGN-1.0.md §4 "Handover"): what a build session that does not
// continue its own is told of the work before it, built in code from the executor's records alone. A re-entry, a reopen whose
// session cannot be resumed, a seat moved to another model, a steer, a session that never persisted and a continue that
// cannot resume all start a fresh session; keeping a session is an optimisation, never the guarantee that the history reaches
// the builder (a session cannot change model, a resume re-reads its whole transcript, and it carries stale beliefs).
//
// Present exactly when the round's session is fresh and the lineage has work before it: the unit re-enters another, or the unit
// has an earlier build attempt (`handoverOf`; the build stage renders it on a fresh call only). Its parts, each list but `unmet`
// (bounded by the spec) bounded to its most recent HANDOVER_ITEMS_MAX:
//   lineage     the unit, then each unit it re-enters
//   diagnosis   the lineage's failure outcomes, lane failures and reverted out-of-scope paths (`lineageDiagnosis`, the
//               checkpoint's `ParkDiagnosis` of a park trigger)
//   gate        the lineage's latest gate answer: its decision and directives
//   findings    the lineage's unsettled blocking ledger findings (src/pipeline/review.ts), with their text
//   unmet       the spec's active acceptance clauses still unmet at the latest attempt (`unmetClauses`)
//   witnesses   the required witness tests missing or failing at the lineage's latest red witness check
//   decisions   the decisions the units it re-enters recorded (their specs' decisions section, which decisions.json feeds)
//               that this unit's spec does not hold, active or deferred
//   report      the lineage's latest build report: its summary and blockers
//   evidence    the failing lanes' evidence dirs of the lineage's latest red lanes attempt, while on disk (gc removes them)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type TestRef, testRefKey } from '../core/events.ts';
import type { ClauseId, UnitId } from '../core/ids.ts';
import type { JournalView } from '../core/interfaces.ts';
import { type SpecM1, specWitnesses } from '../core/records.ts';
import { type AbsPath, type RepoPath, absPath } from '../core/values.ts';
import { SPEC_INPUT, inputPath, requirePlanInForce, specBytesOf, specShaInForce } from '../input/inforce.ts';
import type { Handover, ParkDiagnosis } from '../prompts/inputs.ts';
import { validateBuildOutput, validateGateOutput } from '../prompts/schemas.ts';
import { parseSpec } from '../spec/spec.ts';
import type { StageParent } from './dispatch.ts';
import { laneFailures, outcomeRef, outcomeText } from './failures.ts';
import { specSeriesRoot } from './lanes.ts';
import { ledgerTexts, unitLedger } from './review.ts';
import { type JudgmentReader, judgmentOutput, judgmentSpawns, salvageRejections } from './stages.ts';

/** How many entries each of the handover's lists carries at most: the most recent. */
export const HANDOVER_ITEMS_MAX = 10;

const recent = <T>(items: readonly T[]): readonly T[] => items.slice(-HANDOVER_ITEMS_MAX);

/** The unit, then each unit it re-enters, from the log. */
export function lineageOf(view: JournalView, unit: UnitId): readonly UnitId[] {
  const out = [unit];
  for (let l = view.unit(unit).lineage; l !== null; l = view.unit(l.reenters).lineage) out.push(l.reenters);
  return out;
}

/**
 * Arc feedback 2026-10-16 (ckpt re-entered u1e1 without finding why its 41 attempts failed): the lineage of `unit` as the
 * executor's records show it, the unit first, then each unit it re-entered: its failure outcomes and lane failures (with the
 * references a re-entry cites, src/pipeline/failures.ts), the out-of-scope paths salvage reverted, the required witness tests
 * found missing or failing, and the lineage's re-entries with the failures they cited. A checkpoint's park trigger reads it
 * whole; a handover, bounded.
 */
export function lineageDiagnosis(ctx: JudgmentReader, unit: UnitId): ParkDiagnosis {
  const view = ctx.journal.view;
  const lineage = lineageOf(view, unit);
  const units = lineage.map((u) => {
    const failed = view.unit(u).failures;
    const reverted = new Map<RepoPath, number>();
    for (const s of salvageRejections(ctx, u)) for (const p of new Set(s.paths)) reverted.set(p, (reverted.get(p) ?? 0) + 1);
    const witnesses = new Map<string, Readonly<{ test: TestRef; reason: 'missing' | 'failed'; attempt: number }>>();
    for (const f of failed) {
      const d = f.fact.detail;
      if (d?.kind !== 'witnesses-missing') continue;
      for (const test of d.missing) witnesses.set(testRefKey(test), { test, reason: 'missing', attempt: f.fact.attempt });
      for (const test of d.failed) witnesses.set(testRefKey(test), { test, reason: 'failed', attempt: f.fact.attempt });
    }
    return {
      unit: u,
      outcomes: failed.map((f) => ({ ref: outcomeRef(f), text: outcomeText(f) })),
      lanes: laneFailures(ctx, { id: u }).map((l) => ({ ref: l.ref, class: l.class, hostSuspected: l.hostSuspected === null ? null : l.hostSuspected.signatures })),
      reverted: [...reverted].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, salvages]) => ({ path, salvages })),
      witnesses: [...witnesses].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, w]) => w),
    };
  });
  const plan = requirePlanInForce(ctx.runDir, view).plan;
  const reentries = lineage.slice(0, -1).reverse().map((u) => {
    const re = plan.units.find((x) => x.id === u)?.reenters;
    if (re === undefined) throw new Error(`unit ${u} has a lineage, but the plan in force records no re-entry for it`);
    return { unit: u, reenters: re.unit, fixes: re.fixes ?? null };
  });
  return { units, reentries };
}

/** A kept spec by its hash. */
const keptSpec = (ctx: JudgmentReader, sha: Parameters<typeof specBytesOf>[1]): SpecM1 => parseSpec(specBytesOf(ctx.runDir, sha), inputPath(ctx.runDir, sha, SPEC_INPUT));

/**
 * The spec the lineage's work was last judged against: the spec of the lineage's latest gate attempt (its `judgment-inputs`);
 * with no gate in the lineage, the spec in force of the unit it re-enters; null for a unit of its own with no gate.
 */
function baselineSpec(ctx: JudgmentReader, lineage: readonly UnitId[]): SpecM1 | null {
  const view = ctx.journal.view;
  for (const u of lineage) {
    const judged = judgmentSpawns(ctx, u, 'gate').flatMap((s) => (s.parent.type === 'stage' ? [view.judgmentInputs(u, 'gate', s.parent.attempt)] : [])).filter((j) => j !== null).at(-1);
    if (judged !== undefined) return keptSpec(ctx, judged.specSha256);
  }
  return lineage.length > 1 ? keptSpec(ctx, specShaInForce(view, lineage[1]!)) : null;
}

/**
 * The required witness tests missing or failing at the lineage's latest red witness check: the unit's latest `witnesses-missing`
 * outcome when no lanes attempt of it ended green since, else none; a unit with neither defers to the unit it re-enters.
 */
function latestWitnessMisses(ctx: JudgmentReader, lineage: readonly UnitId[]): Handover['witnesses'] {
  const view = ctx.journal.view;
  for (const u of lineage) {
    const red = view.unit(u).failures.filter((f) => f.fact.detail?.kind === 'witnesses-missing').at(-1);
    const green = view.review().greenLanes(u);
    if (red !== undefined && (green === null || green < red.fact.attempt)) {
      const d = red.fact.detail;
      if (d?.kind !== 'witnesses-missing') throw new Error('unreachable: filtered on witnesses-missing');
      return [...d.missing.map((test) => ({ test, reason: 'missing' as const, unit: u, attempt: red.fact.attempt })), ...d.failed.map((test) => ({ test, reason: 'failed' as const, unit: u, attempt: red.fact.attempt }))];
    }
    if (green !== null) return [];
  }
  return [];
}

/**
 * The active acceptance clauses of `spec` still unmet at the lineage's latest attempt, in spec order: `new` when the baseline
 * (`baselineSpec`) does not hold it active with the same text, else `witness-missing`/`witness-failed` when an active witness item
 * of it names a test the latest red witness check found missing or failing. With no baseline no clause reads as new.
 */
export function unmetClauses(ctx: JudgmentReader, lineage: readonly UnitId[], spec: SpecM1): Handover['unmet'] {
  const baseline = baselineSpec(ctx, lineage);
  const judged = new Map((baseline?.acceptance ?? []).filter((a) => a.state === 'active').map((a) => [a.id as string, a.clause]));
  const misses = new Map(latestWitnessMisses(ctx, lineage).map((w) => [testRefKey(w.test), w.reason]));
  const witnessed = (clause: ClauseId): 'missing' | 'failed' | null => {
    const reasons = specWitnesses(spec).filter((w) => w.state === 'active' && w.clause === clause).map((w) => misses.get(testRefKey(w)) ?? null);
    return reasons.includes('missing') ? 'missing' : reasons.includes('failed') ? 'failed' : null;
  };
  return spec.acceptance.filter((a) => a.state === 'active').flatMap((a): Handover['unmet'] => {
    if (baseline !== null && judged.get(a.id) !== a.clause) return [{ clause: a.id, text: a.clause, why: 'new' as const }];
    const w = witnessed(a.id);
    return w === null ? [] : [{ clause: a.id, text: a.clause, why: w === 'missing' ? 'witness-missing' as const : 'witness-failed' as const }];
  });
}

/** The build spawns of `units`, in log order, outside the attempt `current`. */
function earlierBuilds(view: JournalView, units: readonly UnitId[], current: StageParent) {
  return view.opsOf('proc.spawn').filter((i) => {
    const s = i.expect.subject;
    if (s.purpose !== 'backend' || s.role !== 'build' || !units.includes(s.unit) || i.parent.type !== 'stage') return false;
    return !(i.parent.unit === current.unit && i.parent.stage === current.stage && i.parent.attempt === current.attempt);
  });
}

/**
 * The handover of build attempt `parent` of `unit` on `spec`, for a fresh session (the header); null when the lineage has no work
 * before it: the unit re-enters nothing and has no earlier build attempt.
 */
export function handoverOf(ctx: JudgmentReader, unit: UnitId, spec: SpecM1, parent: StageParent): Handover | null {
  const view = ctx.journal.view;
  const lineage = lineageOf(view, unit);
  const builds = earlierBuilds(view, lineage, parent);
  if (lineage.length === 1 && builds.length === 0) return null;
  const diagnosis = lineageDiagnosis(ctx, unit);

  let gate: Handover['gate'] = null;
  for (const u of lineage) {
    const answered = judgmentSpawns(ctx, u, 'gate').flatMap((s) => {
      const out = s.parent.type === 'stage' ? judgmentOutput(ctx, s, validateGateOutput) : null;
      return out === null || s.parent.type !== 'stage' ? [] : [{ unit: u, attempt: s.parent.attempt, decision: out.decision, directives: out.directives }];
    }).at(-1);
    if (answered !== undefined) {
      gate = answered;
      break;
    }
  }

  const findings = lineage.slice().reverse().flatMap((u) => {
    const texts = ledgerTexts(ctx, u);
    return unitLedger(ctx, u).filter((e) => e.outcome === null).map((e) => {
      const f = texts.get(e.id);
      return { id: e.id, unit: u, path: e.path, defect: f?.defect ?? null, text: f?.text ?? '(text not recorded)' };
    });
  });

  const decisions = lineage.slice(1).reverse().flatMap((u) => {
    const theirs = keptSpec(ctx, specShaInForce(view, u));
    return theirs.decisions.flatMap((d) => (d.state === 'struck' || spec.decisions.some((x) => x.id === d.id) ? [] : [{ unit: u, id: d.id, text: d.text, state: d.state }]));
  });

  const reports = builds.flatMap((s) => {
    const out = judgmentOutput(ctx, s, validateBuildOutput);
    return out === null || s.parent.type !== 'stage' ? [] : [{ unit: s.parent.unit, attempt: s.parent.attempt, summary: out.summary, blockers: recent(out.blockers) }];
  });

  let evidence: readonly AbsPath[] = [];
  for (const u of lineage) {
    const failures = laneFailures(ctx, { id: u });
    const attempt = failures.at(-1)?.attempt;
    if (attempt === undefined) continue;
    const root = specSeriesRoot(ctx.runDir, { type: 'stage', unit: u, stage: 'lanes', attempt });
    evidence = failures.filter((f) => f.attempt === attempt).map((f) => absPath(join(root, f.lane))).filter((d) => existsSync(d));
    break;
  }

  return {
    lineage,
    diagnosis: {
      units: diagnosis.units.map((u) => ({ ...u, outcomes: recent(u.outcomes), lanes: recent(u.lanes), reverted: recent(u.reverted), witnesses: recent(u.witnesses) })),
      reentries: recent(diagnosis.reentries),
    },
    gate: gate === null ? null : { ...gate, directives: recent(gate.directives) },
    findings: recent(findings),
    unmet: unmetClauses(ctx, lineage, spec),
    witnesses: recent(latestWitnessMisses(ctx, lineage)),
    decisions: recent(decisions),
    report: reports.at(-1) ?? null,
    evidence: recent(evidence),
  };
}
