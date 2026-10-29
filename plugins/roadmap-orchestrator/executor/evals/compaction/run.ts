import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { trial, type Budget, type Stage, type Trial } from './driver.ts';
import { json, write } from './fixture.ts';
import { setName, type SetName } from './spec.ts';

export type Options = Readonly<{ set: SetName; n: number; stage: Stage; cap: number | null; compare: string | null }>;
export function options(args: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i]!, v = args[i + 1];
    if (!['--set', '--n', '--stage', '--cap', '--compare'].includes(k) || v === undefined || flags.has(k)) throw new Error('usage: node evals/compaction/run.ts --set dev|holdout --n N [--stage a|b|both] [--cap usd] [--compare summary.json]');
    flags.set(k, v);
  }
  if (!flags.has('--set') || !flags.has('--n')) throw new Error('--set and --n are required');
  const n = Number(flags.get('--n'));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('--n must be a positive integer');
  const stage = flags.get('--stage') ?? 'both';
  if (stage !== 'a' && stage !== 'b' && stage !== 'both') throw new Error('--stage must be a, b or both');
  const cap = flags.has('--cap') ? Number(flags.get('--cap')) : null;
  if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) throw new Error('--cap must be positive USD');
  return { set: setName(flags.get('--set')!), n, stage, cap, compare: flags.get('--compare') ?? null };
}
export type Summary = Readonly<{ schema: 'roadmap/compaction-eval'; set: SetName; stage: Stage; requested: number; trials: readonly Trial[]; costUsd: number; pass: boolean; recall: number | null; comparison: { devRecall: number | null; gap: number | null; stageB: { devPassRate: number; passRate: number; pass: boolean } | null; pass: boolean } | null }>;
export function summarise(opts: Options, trials: readonly Trial[], baseline: Summary | null): Summary {
  const recalls = trials.flatMap((t) => t.a?.recall === undefined ? [] : [t.a.recall]);
  const recall = recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null;
  if (baseline && (opts.set !== 'holdout' || baseline.set !== 'dev' || baseline.stage !== opts.stage)) throw new Error('--compare requires a holdout run and a dev summary with the same enabled stages');
  const bRate = (rows: readonly Trial[]): number => rows.length ? rows.filter((t) => t.b?.pass).length / rows.length : 0;
  const stageB = baseline && opts.stage !== 'a' ? { devPassRate: bRate(baseline.trials), passRate: bRate(trials), pass: bRate(trials) >= bRate(baseline.trials) - 0.15 } : null;
  const comparison = baseline ? { devRecall: baseline.recall, gap: baseline.recall === null || recall === null ? null : baseline.recall - recall, stageB,
    pass: (opts.stage === 'b' || (baseline.recall !== null && recall !== null && recall >= baseline.recall - 0.15)) && (stageB?.pass ?? true) } : null;
  return { schema: 'roadmap/compaction-eval', set: opts.set, stage: opts.stage, requested: opts.n, trials, costUsd: trials.reduce((a, t) => a + t.costUsd, 0), recall, comparison,
    pass: trials.length === opts.n && trials.every((t) => t.failure === null && (opts.stage === 'b' || t.a?.pass === true) && (opts.stage === 'a' || t.b?.pass === true)) && (comparison?.pass ?? true) };
}
export async function run(opts: Options): Promise<{ path: string; summary: Summary }> {
  const root = resolve('/var/tmp/compaction-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  const budget: Budget = { spent: 0, cap: opts.cap };
  const rows: Trial[] = [];
  const baseline = opts.compare === null ? null : JSON.parse(readFileSync(opts.compare, 'utf8')) as Summary;
  if (baseline && (baseline.schema !== 'roadmap/compaction-eval' || baseline.set !== 'dev' || opts.set !== 'holdout' || baseline.stage !== opts.stage || !Array.isArray(baseline.trials))) throw new Error('--compare requires a dev compaction summary with the same enabled stages, for a holdout run');
  for (let n = 1; n <= opts.n; n++) {
    if (budget.cap !== null && budget.spent >= budget.cap) break;
    rows.push(await trial(join(root, String(n)), opts.set, opts.stage, n, budget));
    write(join(root, 'summary.json'), json(summarise(opts, rows, baseline)));
  }
  const summary = summarise(opts, rows, baseline);
  const path = join(root, 'summary.json');
  write(path, json(summary));
  return { path, summary };
}
if (import.meta.main) {
  const r = await run(options(process.argv.slice(2)));
  process.stdout.write(json({ summary: r.path, pass: r.summary.pass, costUsd: r.summary.costUsd }));
  process.exitCode = r.summary.pass ? 0 : 1;
}
