// Aggregating walkthrough trials over slot observations (each graded trial observes 13 slots), per seed and per family,
// and the pass bar (plan §7, "Pass bar"):
//
//   recall           caught / planted slot observations >= 80% (Wilson interval reported)
//   family-catches   every family caught in >= 2 of its planted trials
//   zero-lucky       no catch without its journey exercised
//   twin-fp          false positives / twin slot observations <= 3/78
//   false-blocking   no `breaks` where `deviates` was expected, on a planted slot, a twin or off every slot: 0
//   stability        the same verdict in every graded trial for >= 80% of (seed, slot) pairs graded at least twice
//   voids            void trials (runaway, cap, error, needle, bring-up, invalid) <= 25% of all
//   cost-check       every call's per-model costs sum to its total_cost_usd
//   holdout-gap      (with a dev summary to compare) holdout recall within 15 points of dev
//
// Reported, never failed: misclassed (a `breaks` plant reported as `deviates`), stray findings (off every slot), the
// polish rate, screenshots, method (browser and shell calls, subagents) and
// cost (median and p90 per seed and per model, per catch, wall time, turns). A trial's cost is `spentOf`, as the gate's.
import { type Interval, fmtRate, median, quantile, wilson } from '../stats.ts';
import type { ModelTotals } from '../gate/summary.ts';
import type { CellSet } from '../gate/cells.ts';
import type { WalkRow, WalkVoidReason } from './arc.ts';
import { FAMILIES, FAMILY_IDS, type FamilyId } from './families.ts';
import type { SlotVerdict } from './grade.ts';

export type Criterion = Readonly<{ name: string; pass: boolean | null; detail: string }>;

export type WalkCellSummary = Readonly<{
  cell: string;
  trials: number;
  graded: number;
  voids: Readonly<Partial<Record<WalkVoidReason, number>>>;
  recall: Interval;
  twinFp: Interval;
  misclassed: number;
  lucky: number;
  falseBlocking: number;
  stray: number;
  polish: number;
  cost: Readonly<{ median: number | null; p90: number | null; perCatch: number | null }>;
  costByModel: Readonly<Record<string, Readonly<{ median: number | null; p90: number | null }>>>;
  wallMedianS: number | null;
  turnsMedian: number | null;
  browserMedian: number | null;
  shellMedian: number | null;
  screenshotsMedian: number | null;
}>;

export type FamilySummary = Readonly<{
  family: FamilyId;
  expected: string;
  caught: Interval;
  misclassed: number;
  lucky: number;
  twinFp: Interval;
  falseBlocking: number;
}>;

export type WalkSummary = Readonly<{
  role: 'walkthrough';
  set: CellSet;
  arm: string | null;
  trials: number;
  cells: readonly WalkCellSummary[];
  families: readonly FamilySummary[];
  recall: Interval;
  twinFp: Interval;
  stability: Readonly<{ pairs: number; same: number }>;
  criteria: readonly Criterion[];
  usage: Readonly<Record<string, ModelTotals>>;
  totalUsd: number;
  capped: Readonly<{ capUsd: number; notStarted: number }> | null;
}>;

export const spentOf = (r: WalkRow): number => Math.max(r.usage?.totalUsd ?? 0, r.estimatedUsd);

const graded = (rows: readonly WalkRow[]): readonly WalkRow[] => rows.filter((r) => r.void === null && r.graded !== null);
type Obs = Readonly<{ cell: string; trial: number; family: FamilyId; state: 'plant' | 'twin'; verdict: SlotVerdict; falseBlocking: boolean }>;
const observations = (rows: readonly WalkRow[]): readonly Obs[] =>
  graded(rows).flatMap((r) => r.graded!.slots.map((s) => ({ cell: r.cell, trial: r.trial, family: s.family, state: s.state, verdict: s.verdict, falseBlocking: s.falseBlocking })));

const count = (xs: readonly Obs[], v: SlotVerdict): number => xs.filter((o) => o.verdict === v).length;
const strayBreaks = (rows: readonly WalkRow[]): number => graded(rows).reduce((a, r) => a + r.graded!.stray.breaks, 0);

function cellSummary(rows: readonly WalkRow[]): WalkCellSummary {
  const obs = observations(rows);
  const plants = obs.filter((o) => o.state === 'plant');
  const twins = obs.filter((o) => o.state === 'twin');
  const voids: Partial<Record<WalkVoidReason, number>> = {};
  for (const r of rows) if (r.void !== null) voids[r.void.reason] = (voids[r.void.reason] ?? 0) + 1;
  const costs = rows.map(spentOf);
  const caught = count(plants, 'caught');
  const models = [...new Set(rows.flatMap((r) => Object.keys(r.usage?.byModel ?? {})))].sort();
  const costByModel: Record<string, { median: number | null; p90: number | null }> = {};
  for (const m of models) {
    const xs = rows.map((r) => r.usage?.byModel[m]?.costUsd ?? 0);
    costByModel[m] = { median: median(xs), p90: quantile(xs, 0.9) };
  }
  const g = graded(rows);
  return {
    cell: rows[0]!.cell, trials: rows.length, graded: g.length, voids,
    recall: wilson(caught, plants.length), twinFp: wilson(count(twins, 'false-positive'), twins.length),
    misclassed: count(plants, 'misclassed'), lucky: count(plants, 'lucky'), falseBlocking: obs.filter((o) => o.falseBlocking).length + strayBreaks(rows),
    stray: g.reduce((a, r) => a + r.graded!.stray.findings, 0), polish: g.reduce((a, r) => a + r.graded!.polish, 0),
    cost: { median: median(costs), p90: quantile(costs, 0.9), perCatch: caught > 0 ? costs.reduce((a, b) => a + b, 0) / caught : null },
    costByModel,
    wallMedianS: median(rows.map((r) => r.wallMs / 1000)), turnsMedian: median(rows.map((r) => r.turns)),
    browserMedian: median(rows.map((r) => r.method.browserCalls)), shellMedian: median(rows.map((r) => r.method.shellCalls)),
    screenshotsMedian: median(rows.map((r) => r.evidence.screenshots)),
  };
}

function familySummary(obs: readonly Obs[], family: FamilyId): FamilySummary {
  const mine = obs.filter((o) => o.family === family);
  const plants = mine.filter((o) => o.state === 'plant');
  const twins = mine.filter((o) => o.state === 'twin');
  return {
    family, expected: FAMILIES[family].expected, caught: wilson(count(plants, 'caught'), plants.length), misclassed: count(plants, 'misclassed'),
    lucky: count(plants, 'lucky'), twinFp: wilson(count(twins, 'false-positive'), twins.length), falseBlocking: mine.filter((o) => o.falseBlocking).length,
  };
}

/** (seed, slot) pairs graded at least twice, and those with one verdict in every graded trial. */
function stabilityOf(obs: readonly Obs[]): Readonly<{ pairs: number; same: number }> {
  const byPair = new Map<string, SlotVerdict[]>();
  for (const o of obs) byPair.set(`${o.cell}/${o.family}`, [...(byPair.get(`${o.cell}/${o.family}`) ?? []), o.verdict]);
  const pairs = [...byPair.values()].filter((vs) => vs.length >= 2);
  return { pairs: pairs.length, same: pairs.filter((vs) => vs.every((v) => v === vs[0])).length };
}

const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number | null): string => (x === null ? '-' : `$${x.toFixed(3)}`);

/** The summary of `rows`; `compare`, a dev summary, adds the holdout-gap criterion. */
export function summariseWalk(
  set: CellSet, rows: readonly WalkRow[], compare: WalkSummary | null = null, arm: string | null = null, capped: WalkSummary['capped'] = null,
): WalkSummary {
  const cellIds = [...new Set(rows.map((r) => r.cell))];
  const cells = cellIds.map((id) => cellSummary(rows.filter((r) => r.cell === id)));
  const obs = observations(rows);
  const plants = obs.filter((o) => o.state === 'plant');
  const twins = obs.filter((o) => o.state === 'twin');
  const recall = wilson(count(plants, 'caught'), plants.length);
  const twinFp = wilson(count(twins, 'false-positive'), twins.length);
  const families = FAMILY_IDS.map((f) => familySummary(obs, f));
  const planted = families.filter((f) => f.caught.n > 0);
  const short = planted.filter((f) => f.caught.k < 2);
  const lucky = count(plants, 'lucky');
  const falseBlocking = obs.filter((o) => o.falseBlocking).length + strayBreaks(rows);
  const stability = stabilityOf(obs);
  const voids = rows.filter((r) => r.void !== null).length;
  const criteria: Criterion[] = [
    { name: 'recall', pass: plants.length === 0 ? null : (recall.rate ?? 0) >= 0.8, detail: plants.length === 0 ? 'no planted slot graded' : fmtRate(recall) },
    {
      name: 'family-catches', pass: planted.length === 0 ? null : short.length === 0,
      detail: planted.length === 0 ? 'no planted slot graded' : short.length === 0 ? `every family caught at least twice (${planted.length} families)` : `under 2 catches: ${short.map((f) => `${f.family} ${f.caught.k}/${f.caught.n}`).join(', ')}`,
    },
    { name: 'zero-lucky', pass: plants.length === 0 ? null : lucky === 0, detail: `${lucky} lucky` },
    { name: 'twin-fp', pass: twins.length === 0 ? null : (twinFp.rate ?? 1) <= 3 / 78, detail: twins.length === 0 ? 'no twin slot graded' : `${fmtRate(twinFp)} (bar 3/78)` },
    { name: 'false-blocking', pass: obs.length === 0 ? null : falseBlocking === 0, detail: `${falseBlocking} breaks where deviates was expected or off every slot` },
    {
      name: 'stability', pass: stability.pairs === 0 ? null : stability.same / stability.pairs >= 0.8,
      detail: stability.pairs === 0 ? 'no (seed, slot) pair graded twice' : `${stability.same}/${stability.pairs} pairs with one verdict ${pct(stability.same / stability.pairs)}`,
    },
    { name: 'voids', pass: voids <= rows.length / 4, detail: `${voids}/${rows.length} void` },
    { name: 'cost-check', pass: rows.every((r) => r.usage === null || r.usage.check === 'ok'), detail: `${rows.filter((r) => r.usage?.check === 'mismatch').length} mismatched, ${rows.filter((r) => r.usage === null).length} without usage` },
  ];
  if (compare !== null) {
    const gap = recall.rate === null || compare.recall.rate === null ? null : Math.abs(recall.rate - compare.recall.rate);
    criteria.push({ name: 'holdout-gap', pass: gap === null ? false : gap <= 0.15, detail: `holdout ${pct(recall.rate)} [${arm ?? 'unlabelled'}] vs dev ${pct(compare.recall.rate)} [${compare.arm ?? 'unlabelled'}]` });
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
    role: 'walkthrough', set, arm, trials: rows.length, cells, families, recall, twinFp, stability, criteria, usage,
    totalUsd: rows.reduce((a, r) => a + spentOf(r), 0), capped,
  };
}

/** The report: ARM, a CELL line per seed, a FAMILY line per family, COST per seed and model, PASS|FAIL|INFO, USAGE, TOTAL. */
export function walkReportLines(s: WalkSummary): readonly string[] {
  const out: string[] = [`ARM ${s.arm ?? 'unlabelled'}`];
  for (const c of s.cells) {
    out.push(`CELL ${c.cell} trials=${c.trials} graded=${c.graded} caught=${fmtRate(c.recall)} twin-fp=${fmtRate(c.twinFp)} misclassed=${c.misclassed} lucky=${c.lucky} `
      + `false-blocking=${c.falseBlocking} stray=${c.stray} polish=${c.polish} cost=${usd(c.cost.median)}/p90 ${usd(c.cost.p90)} perCatch=${usd(c.cost.perCatch)} `
      + `wall=${c.wallMedianS?.toFixed(0) ?? '-'}s turns=${c.turnsMedian ?? '-'} browser=${c.browserMedian ?? '-'} shell=${c.shellMedian ?? '-'} screenshots=${c.screenshotsMedian ?? '-'} `
      + `voids=${JSON.stringify(c.voids)}`);
    for (const [m, x] of Object.entries(c.costByModel)) out.push(`COST ${c.cell} ${m} median=${usd(x.median)} p90=${usd(x.p90)}`);
  }
  for (const f of s.families) {
    out.push(`FAMILY ${f.family} expected=${f.expected} caught=${fmtRate(f.caught)} misclassed=${f.misclassed} lucky=${f.lucky} twin-fp=${fmtRate(f.twinFp)} false-blocking=${f.falseBlocking}`);
  }
  for (const k of s.criteria) out.push(`${k.pass === null ? 'INFO' : k.pass ? 'PASS' : 'FAIL'} ${k.name} ${k.detail}`);
  if (s.capped !== null) out.push(`INFO cap $${s.capped.capUsd.toFixed(2)}: ${s.capped.notStarted} trials not started`);
  for (const [m, u] of Object.entries(s.usage)) {
    out.push(`USAGE ${m} costUsd=${u.costUsd.toFixed(4)} input=${u.inputTokens} output=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheWriteTokens}`);
  }
  out.push(`TOTAL ${s.trials} trials ${usd(s.totalUsd)}`);
  return out;
}

export const walkFailed = (s: WalkSummary): boolean => s.criteria.some((k) => k.pass === false);
