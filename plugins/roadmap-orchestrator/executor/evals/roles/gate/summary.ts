// Aggregating gate trials: per cell (rates with Wilson intervals, coverage, cost median/p90 overall and per model, cost per
// caught defect, wall time, turns, voids) and the pass criteria over the whole set:
//
//   planted-detection  caught / graded planted trials >= 80%
//   zero-lucky         no catch without a look at the plant
//   clean-fp           false positives / graded clean trials <= 1/12
//   precision          blocking findings localised to the plant / all blocking findings on planted trials >= 50%
//   voids              void trials (runaway, cap, error, needle, placement-miss) <= 25% of all
//   cost-check         every call's per-model costs sum to its total_cost_usd
//   holdout-gap        (with a dev summary to compare) holdout detection within 15 points of dev
//
// Coverage (the median share of not-inlined files the session read; target 90%), the gate's claimed coverage against it
// (`silent`: not-inlined files neither read nor declared unreviewed, median per trial) and the method (tools, subagents)
// are reported, never failed. A trial the executor's regenerate check stopped before the gate (dev.12, `caught`) is counted
// per cell (`regenerate`) and is in no criterion: it measures code, not the gate.
//
// The large-diff gate (1.0.0-dev.12), reported per cell, never failed: of the trials whose diff was over the threshold, how
// many answers carried a cluster map and how many maps covered every path exactly once, and the files per review depth
// summed over the maps. A trial's cost is `spentOf`: its CLI-reported cost, or its transcript estimate when that is larger
// (a session the spend brake killed has no result). With `--cap`, `capped` counts the trials the cap kept from starting.
import { CLUSTER_REVIEWS, type ClusterReview } from '../../../src/prompts/schemas.ts';
import { type Interval, fmtRate, median, quantile, wilson } from '../stats.ts';
import type { TrialRow, VoidReason } from './arc.ts';

export type CellSummary = Readonly<{
  cell: string;
  family: string;
  planted: boolean;
  trials: number;
  graded: number;
  /** dev.12: trials the executor's regenerate check stopped before any gate (caught by code, never graded). */
  regenerate: number;
  voids: Readonly<Partial<Record<VoidReason, number>>>;
  /** Planted cells: caught of graded. Clean cells: false positives of graded. */
  rate: Interval;
  lucky: number;
  coverageMedian: number | null;
  /** Median per trial of not-inlined files the gate neither read nor named in `unreviewed`. */
  silentMedian: number | null;
  cost: Readonly<{ median: number | null; p90: number | null; perCatch: number | null }>;
  costByModel: Readonly<Record<string, Readonly<{ median: number | null; p90: number | null }>>>;
  wallMedianS: number | null;
  turnsMedian: number | null;
  loadMedian: number | null;
  /** Method, reported: subagents spawned per trial (median) and the models they ran on. */
  subagentsMedian: number | null;
  subagentModels: readonly string[];
  /** The large-diff gate: trials over the threshold, answers with a cluster map, maps covering every path exactly once. */
  clusters: Readonly<{ required: number; mapped: number; complete: number }>;
  /** Files per review depth, summed over the cell's cluster maps. */
  reviewMix: Readonly<Record<ClusterReview, number>>;
}>;

export type Criterion = Readonly<{ name: string; pass: boolean | null; detail: string }>;

export type ModelTotals = Readonly<{ costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;

export type Summary = Readonly<{
  set: 'dev' | 'holdout';
  /** The arm measured (arc.ts `gateArm`: seat, class, model:effort), null when the caller names none; absent in a summary written before arms. */
  arm: string | null;
  trials: number;
  cells: readonly CellSummary[];
  detection: Interval;
  falsePositives: Interval;
  coverageMedian: number | null;
  criteria: readonly Criterion[];
  usage: Readonly<Record<string, ModelTotals>>;
  totalUsd: number;
  /** `--cap`: the cap and how many trials it kept from starting; null without one (absent in a summary written before caps). */
  capped: Readonly<{ capUsd: number; notStarted: number }> | null;
}>;

const graded = (rows: readonly TrialRow[]): readonly TrialRow[] => rows.filter((r) => r.void === null && r.graded !== null);
/** What a finished trial spent: its CLI-reported cost, or its transcript estimate when that is larger (a call killed before its result). */
export const spentOf = (r: TrialRow): number => Math.max(r.usage?.totalUsd ?? 0, r.estimatedUsd);
const costOf = spentOf;

function cellSummary(rows: readonly TrialRow[]): CellSummary {
  const first = rows[0]!;
  const g = graded(rows);
  const voids: Partial<Record<VoidReason, number>> = {};
  for (const r of rows) if (r.void !== null) voids[r.void.reason] = (voids[r.void.reason] ?? 0) + 1;
  const caught = g.filter((r) => r.graded!.verdict === 'caught').length;
  const fps = g.filter((r) => r.graded!.verdict === 'false-positive').length;
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.usage?.byModel ?? {})))].sort();
  const costByModel: Record<string, { median: number | null; p90: number | null }> = {};
  for (const m of models) {
    const xs = rows.map((r) => r.usage?.byModel[m]?.costUsd ?? 0);
    costByModel[m] = { median: median(xs), p90: quantile(xs, 0.9) };
  }
  const shares = rows.flatMap((r) => (r.graded?.coverage.share === null || r.graded === null ? [] : [r.graded.coverage.share]));
  const costs = rows.map(costOf);
  const maps = rows.flatMap((r) => (r.clusters === null ? [] : [r.clusters]));
  const reviewMix = Object.fromEntries(CLUSTER_REVIEWS.map((d) => [d, maps.reduce((a, m) => a + m.depth[d], 0)])) as Record<ClusterReview, number>;
  return {
    cell: first.cell, family: first.family, planted: first.planted, trials: rows.length, graded: g.length, regenerate: rows.filter((r) => r.caught === 'regenerate').length, voids,
    rate: first.planted ? wilson(caught, g.length) : wilson(fps, g.length),
    lucky: g.filter((r) => r.graded!.verdict === 'lucky').length,
    coverageMedian: median(shares),
    silentMedian: median(rows.flatMap((r) => (r.graded === null ? [] : [r.graded.unreviewed.silent]))),
    cost: { median: median(costs), p90: quantile(costs, 0.9), perCatch: first.planted && caught > 0 ? costs.reduce((a, b) => a + b, 0) / caught : null },
    costByModel,
    wallMedianS: median(rows.map((r) => r.wallMs / 1000)),
    turnsMedian: median(rows.map((r) => r.turns)),
    loadMedian: median(rows.map((r) => r.load)),
    subagentsMedian: median(rows.map((r) => r.method.subagents.length)),
    subagentModels: [...new Set(rows.flatMap((r) => r.method.subagents.flatMap((a) => (a.model === null ? [] : [a.model]))))].sort(),
    clusters: { required: rows.filter((r) => r.largeDiff).length, mapped: maps.length, complete: maps.filter((m) => m.uncovered === 0 && m.duplicated === 0).length },
    reviewMix,
  };
}

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null): string => (x === null ? '-' : `$${x.toFixed(3)}`);

/** The summary of `rows`; `compare`, a dev summary, adds the holdout-gap criterion. */
export function summarise(
  set: 'dev' | 'holdout', rows: readonly TrialRow[], compare: Summary | null = null, arm: string | null = null, capped: Summary['capped'] = null,
): Summary {
  const cellIds = [...new Set(rows.map((r) => r.cell))];
  const cells = cellIds.map((id) => cellSummary(rows.filter((r) => r.cell === id)));
  const g = graded(rows);
  const planted = g.filter((r) => r.planted);
  const clean = g.filter((r) => !r.planted);
  const detection = wilson(planted.filter((r) => r.graded!.verdict === 'caught').length, planted.length);
  const falsePositives = wilson(clean.filter((r) => r.graded!.verdict === 'false-positive').length, clean.length);
  const lucky = planted.filter((r) => r.graded!.verdict === 'lucky').length;
  const blocking = planted.reduce((a, r) => a + r.graded!.blocking, 0);
  const localised = planted.reduce((a, r) => a + (r.graded!.blocking - r.graded!.spurious), 0);
  const voids = rows.filter((r) => r.void !== null).length;
  const shares = rows.flatMap((r) => (r.graded === null || r.graded.coverage.share === null ? [] : [r.graded.coverage.share]));
  const coverageMedian = median(shares);
  const anyPlanted = rows.some((r) => r.planted);
  const anyClean = rows.some((r) => !r.planted);
  const criteria: Criterion[] = [
    { name: 'planted-detection', pass: anyPlanted ? planted.length > 0 && (detection.rate ?? 0) >= 0.8 : null, detail: anyPlanted ? fmtRate(detection) : 'no planted cell run' },
    { name: 'zero-lucky', pass: anyPlanted ? lucky === 0 : null, detail: `${lucky} lucky` },
    { name: 'clean-fp', pass: anyClean ? clean.length > 0 && (falsePositives.rate ?? 1) <= 1 / 12 : null, detail: anyClean ? fmtRate(falsePositives) : 'no clean cell run' },
    { name: 'precision', pass: blocking === 0 ? null : localised / blocking >= 0.5, detail: blocking === 0 ? 'no blocking finding on a planted trial' : `${localised}/${blocking} blocking findings localised ${pct(localised / blocking)}` },
    { name: 'voids', pass: voids <= rows.length / 4, detail: `${voids}/${rows.length} void` },
    { name: 'cost-check', pass: rows.every((r) => r.usage === null || r.usage.check === 'ok'), detail: `${rows.filter((r) => r.usage?.check === 'mismatch').length} mismatched, ${rows.filter((r) => r.usage === null).length} without usage` },
  ];
  if (compare !== null) {
    const gap = detection.rate === null || compare.detection.rate === null ? null : Math.abs(detection.rate - compare.detection.rate);
    criteria.push({ name: 'holdout-gap', pass: gap === null ? false : gap <= 0.15, detail: `holdout ${pct(detection.rate)} [${arm ?? 'unlabelled'}] vs dev ${pct(compare.detection.rate)} [${compare.arm ?? 'unlabelled'}]` });
  }
  const usage: Record<string, ModelTotals> = {};
  for (const r of rows) {
    for (const [m, u] of Object.entries(r.usage?.byModel ?? {})) {
      const t = usage[m] ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      usage[m] = {
        costUsd: t.costUsd + u.costUsd, inputTokens: t.inputTokens + u.inputTokens, outputTokens: t.outputTokens + u.outputTokens,
        cacheReadTokens: t.cacheReadTokens + u.cacheReadTokens, cacheWriteTokens: t.cacheWriteTokens + u.cacheWriteTokens,
      };
    }
  }
  return { set, arm, trials: rows.length, cells, detection, falsePositives, coverageMedian, criteria, usage, totalUsd: rows.reduce((a, r) => a + costOf(r), 0), capped };
}

/** The report: the ARM line, one CELL line per cell, COST lines per cell and model, a PASS|FAIL|INFO line per criterion, USAGE per model. */
export function reportLines(s: Summary): readonly string[] {
  const out: string[] = [`ARM ${s.arm ?? 'unlabelled'}`];
  for (const c of s.cells) {
    out.push(`CELL ${c.cell} ${c.planted ? 'planted' : 'clean'} trials=${c.trials} graded=${c.graded} regenerate=${c.regenerate} ${c.planted ? 'caught' : 'fp'}=${fmtRate(c.rate)} lucky=${c.lucky} `
      + `coverage=${pct(c.coverageMedian)} silent=${c.silentMedian ?? '-'} cost=${usd(c.cost.median)}/p90 ${usd(c.cost.p90)} perCatch=${usd(c.cost.perCatch)} wall=${c.wallMedianS?.toFixed(0) ?? '-'}s `
      + `turns=${c.turnsMedian ?? '-'} subagents=${c.subagentsMedian ?? '-'}${c.subagentModels.length > 0 ? ` (${c.subagentModels.join(',')})` : ''} voids=${JSON.stringify(c.voids)} `
      + `clusters=${c.clusters.complete}/${c.clusters.required} mapped=${c.clusters.mapped} mix=${CLUSTER_REVIEWS.map((d) => `${d}:${c.reviewMix[d]}`).join(',')}`);
    for (const [m, x] of Object.entries(c.costByModel)) out.push(`COST ${c.cell} ${m} median=${usd(x.median)} p90=${usd(x.p90)}`);
  }
  for (const k of s.criteria) out.push(`${k.pass === null ? 'INFO' : k.pass ? 'PASS' : 'FAIL'} ${k.name} ${k.detail}`);
  out.push(`INFO coverage-median ${pct(s.coverageMedian)} (target 90%)`);
  if (s.capped !== null) out.push(`INFO cap $${s.capped.capUsd.toFixed(2)}: ${s.capped.notStarted} trials not started`);
  for (const [m, u] of Object.entries(s.usage)) {
    out.push(`USAGE ${m} costUsd=${u.costUsd.toFixed(4)} input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens}`);
  }
  out.push(`TOTAL ${s.trials} trials ${usd(s.totalUsd)}`);
  return out;
}

export const failed = (s: Summary): boolean => s.criteria.some((k) => k.pass === false);
