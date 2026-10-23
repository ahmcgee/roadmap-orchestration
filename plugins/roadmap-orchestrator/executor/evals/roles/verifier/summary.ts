// Aggregating verifier trials (one docs-only claim each, graded per trial and per hunk) per cell, per family and per run,
// and the pass bar:
//
//   false-accept    no claim accepted on a cell with a not-clear hunk, in any trial: 0 (the costly error: a stale lane
//                   verdict carried over onto code no lane ran)
//   false-refusal   claims refused on all-clear cells <= 25% of their graded trials (a refusal only reruns the lanes)
//   stability       the same decision in every graded trial for >= 80% of the cells graded at least twice
//   voids           void trials (cap, error, code-decided, invalid, needle) <= 25% of all
//   cost-check      every call's per-model costs sum to its total_cost_usd
//   holdout-gap     (with a dev summary to compare) holdout trial accuracy within 15 points of dev
//
// Reported, never failed: per-hunk false accepts and false refusals, with Wilson intervals as for the trials; per key flag
// (executable, toolDirective, behaviourChange, code) how often a not-clear hunk's answer raised that flag; accuracy per
// family; cost (median and p90 per cell and per model) and wall time. A trial's cost is `spentOf`, as the gate's.
import type { CellSet } from '../gate/cells.ts';
import type { ModelTotals } from '../gate/summary.ts';
import { type Interval, fmtRate, median, quantile, wilson } from '../stats.ts';
import type { VerifierRow, VerifierVoidReason } from './arc.ts';
import { HUNK_EXPECTS, type HunkExpect, VERIFIER_FAMILIES } from './families.ts';

export type Criterion = Readonly<{ name: string; pass: boolean | null; detail: string }>;

export type VerifierCellSummary = Readonly<{
  cell: string;
  family: string;
  expected: 'accept' | 'refuse';
  trials: number;
  graded: number;
  accepted: number;
  refused: number;
  correct: number;
  voids: Readonly<Partial<Record<VerifierVoidReason, number>>>;
  cost: Readonly<{ median: number | null; p90: number | null }>;
  costByModel: Readonly<Record<string, Readonly<{ median: number | null; p90: number | null }>>>;
  wallMedianS: number | null;
}>;

export type VerifierSummary = Readonly<{
  role: 'verifier';
  set: CellSet;
  arm: string | null;
  trials: number;
  cells: readonly VerifierCellSummary[];
  /** Correct decisions over every trial (a void is not correct). */
  accuracy: Interval;
  /** Trials: accepted among graded trials of cells with a not-clear hunk; refused among graded trials of all-clear cells. */
  falseAccepts: Interval;
  falseRefusals: Interval;
  /** Hunks: cleared among graded not-clear hunks; not cleared among graded clear hunks. */
  hunkFalseAccepts: Interval;
  hunkFalseRefusals: Interval;
  /** Per not-clear key: how often the answer raised that flag. */
  flags: Readonly<Partial<Record<Exclude<HunkExpect, 'clear'>, Interval>>>;
  families: readonly Readonly<{ family: string; accuracy: Interval }>[];
  stability: Readonly<{ cells: number; same: number }>;
  criteria: readonly Criterion[];
  usage: Readonly<Record<string, ModelTotals>>;
  totalUsd: number;
  capped: Readonly<{ capUsd: number; notStarted: number }> | null;
}>;

export const spentOf = (r: VerifierRow): number => Math.max(r.usage?.totalUsd ?? 0, r.estimatedUsd);

/** The false-refusal bar: at most this share of the all-clear cells' graded trials refused. */
export const FALSE_REFUSAL_BAR = 0.25;

const graded = (rows: readonly VerifierRow[]): readonly VerifierRow[] => rows.filter((r) => r.void === null && r.decision !== null);

function cellSummary(rows: readonly VerifierRow[]): VerifierCellSummary {
  const g = graded(rows);
  const voids: Partial<Record<VerifierVoidReason, number>> = {};
  for (const r of rows) if (r.void !== null) voids[r.void.reason] = (voids[r.void.reason] ?? 0) + 1;
  const costs = rows.map(spentOf);
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.usage?.byModel ?? {})))].sort();
  const costByModel: Record<string, { median: number | null; p90: number | null }> = {};
  for (const m of models) {
    const xs = rows.map((r) => r.usage?.byModel[m]?.costUsd ?? 0);
    costByModel[m] = { median: median(xs), p90: quantile(xs, 0.9) };
  }
  return {
    cell: rows[0]!.cell, family: rows[0]!.family, expected: rows[0]!.expected, trials: rows.length, graded: g.length,
    accepted: g.filter((r) => r.decision === 'accept').length, refused: g.filter((r) => r.decision === 'refuse').length, correct: g.filter((r) => r.correct === true).length,
    voids, cost: { median: median(costs), p90: quantile(costs, 0.9) }, costByModel, wallMedianS: median(rows.map((r) => r.wallMs / 1000)),
  };
}

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null): string => (x === null ? '-' : `$${x.toFixed(3)}`);

/** The summary of `rows`; `compare`, a dev summary, adds the holdout-gap criterion. */
export function summariseVerifier(
  set: CellSet, rows: readonly VerifierRow[], compare: VerifierSummary | null = null, arm: string | null = null, capped: VerifierSummary['capped'] = null,
): VerifierSummary {
  const cellIds = [...new Set(rows.map((r) => r.cell))];
  const cells = cellIds.map((id) => cellSummary(rows.filter((r) => r.cell === id)));
  const g = graded(rows);
  const refuseCells = g.filter((r) => r.expected === 'refuse');
  const acceptCells = g.filter((r) => r.expected === 'accept');
  const falseAccepts = wilson(refuseCells.filter((r) => r.decision === 'accept').length, refuseCells.length);
  const falseRefusals = wilson(acceptCells.filter((r) => r.decision === 'refuse').length, acceptCells.length);
  const hunks = g.flatMap((r) => r.hunks);
  const notClear = hunks.filter((h) => h.expect !== 'clear');
  const clear = hunks.filter((h) => h.expect === 'clear');
  const flags: Partial<Record<Exclude<HunkExpect, 'clear'>, Interval>> = {};
  for (const e of HUNK_EXPECTS) {
    if (e === 'clear') continue;
    const mine = notClear.filter((h) => h.expect === e);
    if (mine.length > 0) flags[e] = wilson(mine.filter((h) => h.flagged === true).length, mine.length);
  }
  const accuracy = wilson(rows.filter((r) => r.correct === true).length, rows.length);
  // The families in their order, then any other a holdout cell names, as the rows first name them.
  const families = [...new Set<string>([...VERIFIER_FAMILIES, ...rows.map((r) => r.family)])].flatMap((family) => {
    const mine = rows.filter((r) => r.family === family);
    return mine.length === 0 ? [] : [{ family, accuracy: wilson(mine.filter((r) => r.correct === true).length, mine.length) }];
  });
  const twice = cellIds.map((id) => g.filter((r) => r.cell === id)).filter((xs) => xs.length >= 2);
  const stability = { cells: twice.length, same: twice.filter((xs) => xs.every((r) => r.decision === xs[0]!.decision)).length };
  const voids = rows.filter((r) => r.void !== null).length;
  const criteria: Criterion[] = [
    {
      name: 'false-accept', pass: falseAccepts.n === 0 ? null : falseAccepts.k === 0,
      detail: `trials ${fmtRate(falseAccepts)} of the not-clear cells' accepted; hunks ${fmtRate(wilson(notClear.filter((h) => h.clear).length, notClear.length))} cleared`,
    },
    {
      name: 'false-refusal', pass: falseRefusals.n === 0 ? null : (falseRefusals.rate ?? 0) <= FALSE_REFUSAL_BAR,
      detail: `trials ${fmtRate(falseRefusals)} of the clear cells' refused (bar ${pct(FALSE_REFUSAL_BAR)}); hunks ${fmtRate(wilson(clear.filter((h) => !h.clear).length, clear.length))} not cleared`,
    },
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
    role: 'verifier', set, arm, trials: rows.length, cells, accuracy, falseAccepts, falseRefusals,
    hunkFalseAccepts: wilson(notClear.filter((h) => h.clear).length, notClear.length), hunkFalseRefusals: wilson(clear.filter((h) => !h.clear).length, clear.length),
    flags, families, stability, criteria, usage, totalUsd: rows.reduce((a, r) => a + spentOf(r), 0), capped,
  };
}

/** The report: ARM, CELL and COST per cell, FALSE-ACCEPT, FALSE-REFUSAL, FLAG, FAMILY, PASS|FAIL|INFO, USAGE, TOTAL. */
export function verifierReportLines(s: VerifierSummary): readonly string[] {
  const out: string[] = [`ARM ${s.arm ?? 'unlabelled'}`];
  for (const c of s.cells) {
    out.push(`CELL ${c.cell} ${c.family} expect=${c.expected} trials=${c.trials} graded=${c.graded} accept=${c.accepted} refuse=${c.refused} correct=${c.correct}/${c.trials} `
      + `cost=${usd(c.cost.median)}/p90 ${usd(c.cost.p90)} wall=${c.wallMedianS?.toFixed(0) ?? '-'}s voids=${JSON.stringify(c.voids)}`);
    for (const [m, x] of Object.entries(c.costByModel)) out.push(`COST ${c.cell} ${m} median=${usd(x.median)} p90=${usd(x.p90)}`);
  }
  out.push(`FALSE-ACCEPT trials=${fmtRate(s.falseAccepts)} hunks=${fmtRate(s.hunkFalseAccepts)}`);
  out.push(`FALSE-REFUSAL trials=${fmtRate(s.falseRefusals)} hunks=${fmtRate(s.hunkFalseRefusals)}`);
  for (const [flag, i] of Object.entries(s.flags)) out.push(`FLAG ${flag} raised=${fmtRate(i)}`);
  for (const f of s.families) out.push(`FAMILY ${f.family} accuracy=${fmtRate(f.accuracy)}`);
  for (const k of s.criteria) out.push(`${k.pass === null ? 'INFO' : k.pass ? 'PASS' : 'FAIL'} ${k.name} ${k.detail}`);
  if (s.capped !== null) out.push(`INFO cap $${s.capped.capUsd.toFixed(2)}: ${s.capped.notStarted} trials not started`);
  for (const [m, u] of Object.entries(s.usage)) {
    out.push(`USAGE ${m} costUsd=${u.costUsd.toFixed(4)} input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens}`);
  }
  out.push(`TOTAL ${s.trials} trials ${usd(s.totalUsd)}`);
  return out;
}

export const verifierFailed = (s: VerifierSummary): boolean => s.criteria.some((k) => k.pass === false);
