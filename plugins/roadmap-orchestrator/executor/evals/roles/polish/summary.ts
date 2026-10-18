// Aggregating polish-judge trials (one decision each) per cell, per family and per run, and the pass bar (plan §7, "Polish
// judge cells"):
//
//   accuracy      in every run (trial index), correct decisions >= 10/12 of the run's cells (keep on a better after-state,
//                 drop on a worse or neutral one; a void is not correct)
//   worse-kept    no worse after-state kept, in any run: 0 (the costly error: a kept regression lands)
//   stability     the same decision in every graded trial for >= 80% of the cells graded at least twice
//   voids         void trials (runaway, cap, error, needle, bring-up, invalid) <= 25% of all
//   cost-check    every call's per-model costs sum to its total_cost_usd
//   holdout-gap   (with a dev summary to compare) holdout accuracy within 15 points of dev
//
// Reported, never failed: the keep rate per variant (better, worse, neutral), per family, method (browser and shell
// calls, screenshots, repair turns) and cost (median and p90 per cell and per model, wall time, turns). A trial's cost is
// `spentOf`, as the gate's.
import { type Interval, fmtRate, median, quantile, wilson } from '../stats.ts';
import type { CellSet } from '../gate/cells.ts';
import type { ModelTotals } from '../gate/summary.ts';
import type { PolishRow, PolishVoidReason } from './arc.ts';
import { POLISH_FAMILY_IDS, VARIANTS, type Variant } from './families.ts';

export type Criterion = Readonly<{ name: string; pass: boolean | null; detail: string }>;

export type PolishCellSummary = Readonly<{
  cell: string;
  family: string;
  variant: Variant;
  trials: number;
  graded: number;
  kept: number;
  dropped: number;
  correct: number;
  voids: Readonly<Partial<Record<PolishVoidReason, number>>>;
  repairTurns: number;
  cost: Readonly<{ median: number | null; p90: number | null }>;
  costByModel: Readonly<Record<string, Readonly<{ median: number | null; p90: number | null }>>>;
  wallMedianS: number | null;
  turnsMedian: number | null;
  browserMedian: number | null;
  shellMedian: number | null;
  screenshotsMedian: number | null;
}>;

export type RunSummary = Readonly<{ trial: number; cells: number; correct: number; worseKept: number; pass: boolean }>;

export type PolishSummary = Readonly<{
  role: 'polishJudge';
  set: CellSet;
  arm: string | null;
  trials: number;
  cells: readonly PolishCellSummary[];
  runs: readonly RunSummary[];
  accuracy: Interval;
  keepRate: Readonly<Record<Variant, Interval>>;
  families: readonly Readonly<{ family: string; accuracy: Interval }>[];
  stability: Readonly<{ cells: number; same: number }>;
  criteria: readonly Criterion[];
  usage: Readonly<Record<string, ModelTotals>>;
  totalUsd: number;
  capped: Readonly<{ capUsd: number; notStarted: number }> | null;
}>;

export const spentOf = (r: PolishRow): number => Math.max(r.usage?.totalUsd ?? 0, r.estimatedUsd);

/** The run bar: at least 10 of 12 correct, scaled to the cells a run holds (a run over a subset needs the same share). */
export const BAR = { correct: 10, of: 12 } as const;
const runPasses = (correct: number, cells: number): boolean => correct * BAR.of >= BAR.correct * cells;

const graded = (rows: readonly PolishRow[]): readonly PolishRow[] => rows.filter((r) => r.void === null && r.decision !== null);

function cellSummary(rows: readonly PolishRow[]): PolishCellSummary {
  const g = graded(rows);
  const voids: Partial<Record<PolishVoidReason, number>> = {};
  for (const r of rows) if (r.void !== null) voids[r.void.reason] = (voids[r.void.reason] ?? 0) + 1;
  const costs = rows.map(spentOf);
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.usage?.byModel ?? {})))].sort();
  const costByModel: Record<string, { median: number | null; p90: number | null }> = {};
  for (const m of models) {
    const xs = rows.map((r) => r.usage?.byModel[m]?.costUsd ?? 0);
    costByModel[m] = { median: median(xs), p90: quantile(xs, 0.9) };
  }
  return {
    cell: rows[0]!.cell, family: rows[0]!.family, variant: rows[0]!.variant, trials: rows.length, graded: g.length,
    kept: g.filter((r) => r.decision === 'keep').length, dropped: g.filter((r) => r.decision === 'drop').length, correct: g.filter((r) => r.correct === true).length,
    voids, repairTurns: rows.filter((r) => r.calls >= 2).length,
    cost: { median: median(costs), p90: quantile(costs, 0.9) }, costByModel,
    wallMedianS: median(rows.map((r) => r.wallMs / 1000)), turnsMedian: median(rows.map((r) => r.turns)),
    browserMedian: median(rows.map((r) => r.method.browserCalls)), shellMedian: median(rows.map((r) => r.method.shellCalls)),
    screenshotsMedian: median(rows.map((r) => r.evidence.screenshots)),
  };
}

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null): string => (x === null ? '-' : `$${x.toFixed(3)}`);

/** The summary of `rows`; `compare`, a dev summary, adds the holdout-gap criterion. */
export function summarisePolish(
  set: CellSet, rows: readonly PolishRow[], compare: PolishSummary | null = null, arm: string | null = null, capped: PolishSummary['capped'] = null,
): PolishSummary {
  const cellIds = [...new Set(rows.map((r) => r.cell))];
  const cells = cellIds.map((id) => cellSummary(rows.filter((r) => r.cell === id)));
  const g = graded(rows);
  const runs = [...new Set(rows.map((r) => r.trial))].sort((a, b) => a - b).map((trial): RunSummary => {
    const mine = rows.filter((r) => r.trial === trial);
    const correct = mine.filter((r) => r.correct === true).length;
    const worseKept = mine.filter((r) => r.variant === 'worse' && r.decision === 'keep').length;
    return { trial, cells: mine.length, correct, worseKept, pass: runPasses(correct, mine.length) };
  });
  const accuracy = wilson(rows.filter((r) => r.correct === true).length, rows.length);
  const keepRate = Object.fromEntries(VARIANTS.map((v) => {
    const mine = g.filter((r) => r.variant === v);
    return [v, wilson(mine.filter((r) => r.decision === 'keep').length, mine.length)];
  })) as Record<Variant, Interval>;
  // The dev families in their order, then any other a cell carries (the holdout's), as the rows first name them.
  const families = [...new Set<string>([...POLISH_FAMILY_IDS, ...rows.map((r) => r.family)])].flatMap((family) => {
    const mine = rows.filter((r) => r.family === family);
    return mine.length === 0 ? [] : [{ family, accuracy: wilson(mine.filter((r) => r.correct === true).length, mine.length) }];
  });
  const twice = cellIds.map((id) => g.filter((r) => r.cell === id)).filter((xs) => xs.length >= 2);
  const stability = { cells: twice.length, same: twice.filter((xs) => xs.every((r) => r.decision === xs[0]!.decision)).length };
  const worse = g.filter((r) => r.variant === 'worse');
  const worseKept = worse.filter((r) => r.decision === 'keep').length;
  const voids = rows.filter((r) => r.void !== null).length;
  const criteria: Criterion[] = [
    {
      name: 'accuracy', pass: runs.length === 0 ? null : runs.every((r) => r.pass),
      detail: `${runs.map((r) => `run ${r.trial} ${r.correct}/${r.cells}`).join(', ')} (bar ${BAR.correct}/${BAR.of} of each run's cells); overall ${fmtRate(accuracy)}`,
    },
    { name: 'worse-kept', pass: worse.length === 0 ? null : worseKept === 0, detail: `${worseKept} of ${worse.length} worse after-states kept` },
    {
      name: 'stability', pass: stability.cells === 0 ? null : stability.same / stability.cells >= 0.8,
      detail: stability.cells === 0 ? 'no cell graded twice' : `${stability.same}/${stability.cells} cells with one decision ${pct(stability.same / stability.cells)}`,
    },
    { name: 'voids', pass: voids <= rows.length / 4, detail: `${voids}/${rows.length} void` },
    { name: 'cost-check', pass: rows.every((r) => r.usage === null || r.usage.check === 'ok'), detail: `${rows.filter((r) => r.usage?.check === 'mismatch').length} mismatched, ${rows.filter((r) => r.usage === null).length} without usage` },
  ];
  if (compare !== null) {
    const gap = accuracy.rate === null || compare.accuracy.rate === null ? null : Math.abs(accuracy.rate - compare.accuracy.rate);
    criteria.push({ name: 'holdout-gap', pass: gap === null ? false : gap <= 0.15, detail: `holdout ${pct(accuracy.rate)} [${arm ?? 'unlabelled'}] vs dev ${pct(compare.accuracy.rate)} [${compare.arm ?? 'unlabelled'}]` });
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
  return {
    role: 'polishJudge', set, arm, trials: rows.length, cells, runs, accuracy, keepRate, families, stability, criteria, usage,
    totalUsd: rows.reduce((a, r) => a + spentOf(r), 0), capped,
  };
}

/** The report: ARM, a CELL line per cell, COST per cell and model, RUN per run, KEEP per variant, FAMILY, PASS|FAIL|INFO, USAGE, TOTAL. */
export function polishReportLines(s: PolishSummary): readonly string[] {
  const out: string[] = [`ARM ${s.arm ?? 'unlabelled'}`];
  for (const c of s.cells) {
    out.push(`CELL ${c.cell} ${c.family} ${c.variant} trials=${c.trials} graded=${c.graded} keep=${c.kept} drop=${c.dropped} correct=${c.correct}/${c.trials} `
      + `repair-turns=${c.repairTurns} cost=${usd(c.cost.median)}/p90 ${usd(c.cost.p90)} wall=${c.wallMedianS?.toFixed(0) ?? '-'}s turns=${c.turnsMedian ?? '-'} `
      + `browser=${c.browserMedian ?? '-'} shell=${c.shellMedian ?? '-'} screenshots=${c.screenshotsMedian ?? '-'} voids=${JSON.stringify(c.voids)}`);
    for (const [m, x] of Object.entries(c.costByModel)) out.push(`COST ${c.cell} ${m} median=${usd(x.median)} p90=${usd(x.p90)}`);
  }
  for (const r of s.runs) out.push(`RUN ${r.trial} correct=${r.correct}/${r.cells} worse-kept=${r.worseKept} ${r.pass ? 'pass' : 'fail'}`);
  for (const v of VARIANTS) out.push(`KEEP ${v} ${fmtRate(s.keepRate[v])}`);
  for (const f of s.families) out.push(`FAMILY ${f.family} accuracy=${fmtRate(f.accuracy)}`);
  for (const k of s.criteria) out.push(`${k.pass === null ? 'INFO' : k.pass ? 'PASS' : 'FAIL'} ${k.name} ${k.detail}`);
  if (s.capped !== null) out.push(`INFO cap $${s.capped.capUsd.toFixed(2)}: ${s.capped.notStarted} trials not started`);
  for (const [m, u] of Object.entries(s.usage)) {
    out.push(`USAGE ${m} costUsd=${u.costUsd.toFixed(4)} input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens}`);
  }
  out.push(`TOTAL ${s.trials} trials ${usd(s.totalUsd)}`);
  return out;
}

export const polishFailed = (s: PolishSummary): boolean => s.criteria.some((k) => k.pass === false);
