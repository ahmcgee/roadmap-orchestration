// Aggregating scaffold trials (one verdict each: what code decided) per cell, per family and per run, and the pass bar:
//
//   landed        in every run (trial index), a skeleton landed (scaffolded on the first attempt or after the retry) in
//                 >= 3/4 of the run's cells; a void or a plan-defect park does not land. A park costs the owner a plan fix.
//   first-try     overall, at least half the graded trials scaffolded on the first attempt: a retry is a second call and
//                 a second dry run.
//   voids         void trials (runaway, cap, error, needle) <= 25% of all
//   cost-check    every call's per-model costs sum to its total_cost_usd
//   holdout-gap   (with a dev summary to compare) the holdout's landed rate within 15 points of dev's
//
// The bars are first guesses, to re-derive once a paid run has measured the seat. Reported, never failed: the verdicts
// per cell, the landed and first-try rates per family, the refusals by kind (code's reasons, classified), the skeleton's
// size (files and added lines: a skeleton is small), method and cost (median and p90 per cell and per model, wall time,
// turns). A trial's cost is `spentOf`, as the other roles'.
import { type Interval, fmtRate, median, quantile, wilson } from '../stats.ts';
import type { CellSet } from '../gate/cells.ts';
import type { ModelTotals } from '../gate/summary.ts';
import type { ScaffoldRow, ScaffoldVoidReason } from './arc.ts';

export type Criterion = Readonly<{ name: string; pass: boolean | null; detail: string }>;

/** Code's refusal reasons by kind (src/pipeline/scaffold.ts): what a writer missed. */
export const REFUSAL_KINDS = ['nothing', 'outside', 'entry-point', 'lane-exit', 'not-ran', 'schema', 'other'] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];

export function refusalKind(reason: string): RefusalKind {
  if (/wrote nothing/.test(reason)) return 'nothing';
  if (/outside .* paths/.test(reason)) return 'outside';
  if (/^entry points? /.test(reason)) return 'entry-point';
  if (/did not exit/.test(reason)) return 'lane-exit';
  if (/does not show the load test/.test(reason)) return 'not-ran';
  if (/does not match its schema/.test(reason)) return 'schema';
  return 'other';
}

export type ScaffoldCellSummary = Readonly<{
  cell: string;
  family: string;
  trials: number;
  graded: number;
  first: number;
  retry: number;
  defect: number;
  voids: Readonly<Partial<Record<ScaffoldVoidReason, number>>>;
  cost: Readonly<{ median: number | null; p90: number | null }>;
  costByModel: Readonly<Record<string, Readonly<{ median: number | null; p90: number | null }>>>;
  wallMedianS: number | null;
  turnsMedian: number | null;
  filesMedian: number | null;
  linesMedian: number | null;
}>;

export type RunSummary = Readonly<{ trial: number; cells: number; landed: number; first: number; pass: boolean }>;

export type ScaffoldSummary = Readonly<{
  role: 'scaffold';
  set: CellSet;
  arm: string | null;
  trials: number;
  cells: readonly ScaffoldCellSummary[];
  runs: readonly RunSummary[];
  landed: Interval;
  first: Interval;
  families: readonly Readonly<{ family: string; landed: Interval; first: Interval }>[];
  refusals: Readonly<Record<RefusalKind, number>>;
  criteria: readonly Criterion[];
  usage: Readonly<Record<string, ModelTotals>>;
  totalUsd: number;
  capped: Readonly<{ capUsd: number; notStarted: number }> | null;
}>;

export const spentOf = (r: ScaffoldRow): number => Math.max(r.usage?.totalUsd ?? 0, r.estimatedUsd);

/** The run bar: a skeleton landed in at least 3 of 4 cells, scaled to the cells a run holds. */
export const BAR = { landed: 3, of: 4 } as const;
/** The first-try bar: the share of graded trials scaffolded on the first attempt. */
export const FIRST_TRY = 0.5;
const runPasses = (landed: number, cells: number): boolean => landed * BAR.of >= BAR.landed * cells;

const isLanded = (r: ScaffoldRow): boolean => r.verdict === 'first' || r.verdict === 'retry';
const graded = (rows: readonly ScaffoldRow[]): readonly ScaffoldRow[] => rows.filter((r) => r.void === null && r.verdict !== null);

function cellSummary(rows: readonly ScaffoldRow[]): ScaffoldCellSummary {
  const g = graded(rows);
  const voids: Partial<Record<ScaffoldVoidReason, number>> = {};
  for (const r of rows) if (r.void !== null) voids[r.void.reason] = (voids[r.void.reason] ?? 0) + 1;
  const costs = rows.map(spentOf);
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.usage?.byModel ?? {})))].sort();
  const costByModel: Record<string, { median: number | null; p90: number | null }> = {};
  for (const m of models) {
    const xs = rows.map((r) => r.usage?.byModel[m]?.costUsd ?? 0);
    costByModel[m] = { median: median(xs), p90: quantile(xs, 0.9) };
  }
  const landed = rows.filter(isLanded);
  return {
    cell: rows[0]!.cell, family: rows[0]!.family, trials: rows.length, graded: g.length,
    first: g.filter((r) => r.verdict === 'first').length, retry: g.filter((r) => r.verdict === 'retry').length, defect: g.filter((r) => r.verdict === 'defect').length,
    voids, cost: { median: median(costs), p90: quantile(costs, 0.9) }, costByModel,
    wallMedianS: median(rows.map((r) => r.wallMs / 1000)), turnsMedian: median(rows.map((r) => r.turns)),
    filesMedian: median(landed.map((r) => r.files.length)), linesMedian: median(landed.map((r) => r.linesAdded ?? 0)),
  };
}

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null): string => (x === null ? '-' : `$${x.toFixed(3)}`);

/** The summary of `rows`; `compare`, a dev summary, adds the holdout-gap criterion. */
export function summariseScaffold(
  set: CellSet, rows: readonly ScaffoldRow[], compare: ScaffoldSummary | null = null, arm: string | null = null, capped: ScaffoldSummary['capped'] = null,
): ScaffoldSummary {
  const cellIds = [...new Set(rows.map((r) => r.cell))];
  const cells = cellIds.map((id) => cellSummary(rows.filter((r) => r.cell === id)));
  const g = graded(rows);
  const runs = [...new Set(rows.map((r) => r.trial))].sort((a, b) => a - b).map((trial): RunSummary => {
    const mine = rows.filter((r) => r.trial === trial);
    const landed = mine.filter(isLanded).length;
    return { trial, cells: mine.length, landed, first: mine.filter((r) => r.verdict === 'first').length, pass: runPasses(landed, mine.length) };
  });
  const landed = wilson(rows.filter(isLanded).length, rows.length);
  const first = wilson(g.filter((r) => r.verdict === 'first').length, g.length);
  const families = [...new Set(rows.map((r) => r.family))].map((family) => {
    const mine = rows.filter((r) => r.family === family);
    const mineGraded = graded(mine);
    return { family, landed: wilson(mine.filter(isLanded).length, mine.length), first: wilson(mineGraded.filter((r) => r.verdict === 'first').length, mineGraded.length) };
  });
  const refusals = Object.fromEntries(REFUSAL_KINDS.map((k) => [k, 0])) as Record<RefusalKind, number>;
  for (const r of rows) for (const reasons of r.refusals) for (const reason of reasons) refusals[refusalKind(reason)] += 1;
  const voids = rows.filter((r) => r.void !== null).length;
  const criteria: Criterion[] = [
    {
      name: 'landed', pass: runs.length === 0 ? null : runs.every((r) => r.pass),
      detail: `${runs.map((r) => `run ${r.trial} ${r.landed}/${r.cells}`).join(', ')} (bar ${BAR.landed}/${BAR.of} of each run's cells); overall ${fmtRate(landed)}`,
    },
    { name: 'first-try', pass: g.length === 0 ? null : (first.rate ?? 0) >= FIRST_TRY, detail: `${fmtRate(first)} of graded trials scaffolded on the first attempt (bar ${pct(FIRST_TRY)})` },
    { name: 'voids', pass: voids <= rows.length / 4, detail: `${voids}/${rows.length} void` },
    { name: 'cost-check', pass: rows.every((r) => r.usage === null || r.usage.check === 'ok'), detail: `${rows.filter((r) => r.usage?.check === 'mismatch').length} mismatched, ${rows.filter((r) => r.usage === null).length} without usage` },
  ];
  if (compare !== null) {
    const gap = landed.rate === null || compare.landed.rate === null ? null : Math.abs(landed.rate - compare.landed.rate);
    criteria.push({ name: 'holdout-gap', pass: gap === null ? false : gap <= 0.15, detail: `holdout ${pct(landed.rate)} [${arm ?? 'unlabelled'}] vs dev ${pct(compare.landed.rate)} [${compare.arm ?? 'unlabelled'}]` });
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
  return { role: 'scaffold', set, arm, trials: rows.length, cells, runs, landed, first, families, refusals, criteria, usage, totalUsd: rows.reduce((a, r) => a + spentOf(r), 0), capped };
}

/** The report: ARM, a CELL line per cell, COST per cell and model, RUN per run, FAMILY, REFUSALS, PASS|FAIL|INFO, USAGE, TOTAL. */
export function scaffoldReportLines(s: ScaffoldSummary): readonly string[] {
  const out: string[] = [`ARM ${s.arm ?? 'unlabelled'}`];
  for (const c of s.cells) {
    out.push(`CELL ${c.cell} ${c.family} trials=${c.trials} graded=${c.graded} first=${c.first} retry=${c.retry} defect=${c.defect} `
      + `cost=${usd(c.cost.median)}/p90 ${usd(c.cost.p90)} wall=${c.wallMedianS?.toFixed(0) ?? '-'}s turns=${c.turnsMedian ?? '-'} `
      + `files=${c.filesMedian ?? '-'} lines=${c.linesMedian ?? '-'} voids=${JSON.stringify(c.voids)}`);
    for (const [m, x] of Object.entries(c.costByModel)) out.push(`COST ${c.cell} ${m} median=${usd(x.median)} p90=${usd(x.p90)}`);
  }
  for (const r of s.runs) out.push(`RUN ${r.trial} landed=${r.landed}/${r.cells} first=${r.first} ${r.pass ? 'pass' : 'fail'}`);
  for (const f of s.families) out.push(`FAMILY ${f.family} landed=${fmtRate(f.landed)} first=${fmtRate(f.first)}`);
  out.push(`REFUSALS ${REFUSAL_KINDS.map((k) => `${k}=${s.refusals[k]}`).join(' ')}`);
  for (const k of s.criteria) out.push(`${k.pass === null ? 'INFO' : k.pass ? 'PASS' : 'FAIL'} ${k.name} ${k.detail}`);
  if (s.capped !== null) out.push(`INFO cap $${s.capped.capUsd.toFixed(2)}: ${s.capped.notStarted} trials not started`);
  for (const [m, u] of Object.entries(s.usage)) {
    out.push(`USAGE ${m} costUsd=${u.costUsd.toFixed(4)} input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens}`);
  }
  out.push(`TOTAL ${s.trials} trials ${usd(s.totalUsd)}`);
  return out;
}

export const scaffoldFailed = (s: ScaffoldSummary): boolean => s.criteria.some((k) => k.pass === false);
