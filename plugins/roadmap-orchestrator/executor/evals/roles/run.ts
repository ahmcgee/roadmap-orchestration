// Role evals (rung 3.5): N trials per cell of a role, each in its own worker process, graded against answer keys only the
// eval run dir holds, aggregated with Wilson intervals and per-model cost. Two roles: `gate` (below) and `walkthrough`
// (walkthrough/run.ts, its options and report there); the pool, the workers and `--rebind` are shared (pool.ts).
//
//   node evals/roles/run.ts gate --set dev|holdout [--n 3] [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1]
//                           [--risk low|med|high] [--rebind <class>=<model>:<effort> ...] [--out <dir>] [--compare <dev summary.json>]
//                           [--fake approve-all|revise-all|cite-every-path|cite-plant] [--cap <usd>] [--trial-cap <usd>]
//   node evals/roles/run.ts walkthrough --set dev|holdout [--n 3] [--cells S1,S2] [--parallel 2] [--rebind ...] [--out <dir>]
//                           [--compare <dev summary.json>] [--fake <walker>] [--cap <usd>] [--trial-cap <usd>]
//
// The gate's arm: `--risk` picks the gate seat (built-in: low and med efficient/Sonnet 5.5, high frontier/Opus 5.5)
// and `--rebind` (repeatable) rebinds a class for the run through the production mechanism, the repo config's
// `routing.classes` (e.g. `--risk low --rebind efficient=claude-opus-5-5:medium` runs Opus on the low seat). The ARM line,
// summary.json's `arm` and the compare criterion name the seat, its class and the model:effort serving it.
//
// Writes <out>/trials.jsonl (one row per trial, as each finishes), <out>/summary.json and <out>/<cell>-<trial>/ (key.json,
// prompt.txt, gate-<n>.jsonl, transcript.jsonl, answer.json, row.json); prints the workers' TRACE and BRAKE lines, a TRIAL
// line per trial, then the report (summary.ts: CELL, COST, PASS|FAIL|INFO, USAGE, TOTAL). Exits 1 on any FAIL.
// `--fake` swaps the real gate for a degenerate one (free: the harness and graders' own check); a real gate needs
// --size 2000..5000. Each trial is bounded by a 60-minute worker timeout on top of the gate's own judgment deadline.
//
// Spend caps, inside the arm: `--cap <usd>` starts no new trial once the spend of the trials finished so far reaches it
// (a running trial finishes; the CAP line and summary.json's `capped` count the trials not started), and `--trial-cap
// <usd>` kills a running trial's session once its live spend at list price passes it (arc.ts spend brake; the trial is
// void `cap`). A finished trial's spend is the larger of its CLI-reported cost and its transcript estimate, so a trial
// killed before its result still counts what it spent. Without the flags nothing is capped.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RepoConfig } from '../../src/routing/layers.ts';
import { RISK_TIERS, type RiskTier } from '../../src/routing/types.ts';
import { FAKE_GATES, type GateKind, type TrialRow, gateArm } from './gate/arc.ts';
import { type CellSet, cellsFor } from './gate/cells.ts';
import { type Summary, failed, reportLines, spentOf, summarise } from './gate/summary.ts';
import { intOption, rebindConfig, runPool, runWorker, usdOption } from './pool.ts';
import { median } from './stats.ts';
import type { GateWorkerArgs } from './trial.ts';
import { parseWalkRun, runWalk } from './walkthrough/run.ts';
import { walkFailed } from './walkthrough/summary.ts';

export { rebindConfig };

const USAGE = 'usage: node evals/roles/run.ts gate --set dev|holdout [--n 3] [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1] [--risk med] '
  + '[--rebind <class>=<model>:<effort> ...] [--out <dir>] [--compare <summary.json>] [--fake <kind>] [--cap <usd>] [--trial-cap <usd>]';

export type RunOptions = Readonly<{
  set: CellSet;
  n: number;
  cells: readonly string[] | null;
  parallel: number;
  size: number;
  seed: string;
  risk: RiskTier;
  /** `--rebind`'s class rebinds as the repo config that carries them, or null without one. */
  config: RepoConfig | null;
  out: string;
  compare: string | null;
  gate: GateKind;
  /** `--cap`: no trial starts once the finished trials' spend reaches this many USD; null: no cap. */
  cap: number | null;
  /** `--trial-cap`: a running trial is killed once its live spend passes this many USD; null: no cap. */
  trialCap: number | null;
}>;

export function parseRun(argv: readonly string[]): RunOptions {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true,
    options: {
      set: { type: 'string' }, n: { type: 'string', default: '3' }, cells: { type: 'string' }, parallel: { type: 'string', default: '4' },
      size: { type: 'string', default: '3000' }, seed: { type: 'string', default: 'roles-1' }, risk: { type: 'string', default: 'med' },
      rebind: { type: 'string', multiple: true }, out: { type: 'string' }, compare: { type: 'string' }, fake: { type: 'string' },
      cap: { type: 'string' }, 'trial-cap': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'gate') throw new Error(`${USAGE}\n(the gate's options; the walkthrough role's: node evals/roles/run.ts walkthrough --help)`);
  if (values.set !== 'dev' && values.set !== 'holdout') throw new Error(USAGE);
  const int = intOption;
  const usd = usdOption;
  const gate = values.fake === undefined ? 'real' : (FAKE_GATES as readonly string[]).includes(values.fake) ? (values.fake as GateKind) : null;
  if (gate === null) throw new Error(`--fake ${values.fake}: one of ${FAKE_GATES.join(', ')}`);
  if (!(RISK_TIERS as readonly string[]).includes(values.risk)) throw new Error(`--risk ${values.risk}: one of ${RISK_TIERS.join(', ')}`);
  const size = gate === 'real' ? int('size', values.size, 2000, 5000) : int('size', values.size, 100, 5000);
  const out = resolve(values.out ?? join('/var/tmp', `roles-gate-${values.set}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  // The trial dirs are needles (grade.ts): a dir that contains the host's temp dir would match every path the gate reads.
  if (resolve(tmpdir()).startsWith(out)) throw new Error(`--out ${out} contains the temp dir ${tmpdir()}, where the trials' arcs live`);
  return {
    set: values.set, n: int('n', values.n, 1, 100), cells: values.cells === undefined ? null : values.cells.split(','), parallel: int('parallel', values.parallel, 1, 16),
    size, seed: values.seed, risk: values.risk as RiskTier, config: rebindConfig(values.rebind ?? []), out, compare: values.compare ?? null, gate,
    cap: usd('cap', values.cap), trialCap: usd('trial-cap', values['trial-cap']),
  };
}

/** A row for a trial whose worker died before writing one. */
function errorRow(a: GateWorkerArgs, family: string, planted: boolean, detail: string): TrialRow {
  return {
    set: a.set, cell: a.cell, family, trial: a.trial, planted, gate: a.gate, outcome: null, caught: null, decision: null, void: { reason: 'error', detail }, graded: null,
    largeDiff: false, clusters: null, usage: null, estimatedUsd: 0, wallMs: 0, turns: 0, load: 0, calls: 0, models: [], method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: a.out,
  };
}

export async function run(o: RunOptions, log: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<Summary> {
  const all = await cellsFor(o.set);
  const unknown = (o.cells ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`no cell ${unknown.join(', ')} in the ${o.set} set (${all.map((c) => c.id).join(', ')})`);
  const cells = o.cells === null ? all : all.filter((c) => o.cells!.includes(c.id));
  if (existsSync(o.out) && readdirSync(o.out).length > 0) throw new Error(`--out ${o.out} is not empty`);
  mkdirSync(o.out, { recursive: true });
  const arm = gateArm(o.risk, o.config);
  writeFileSync(join(o.out, 'run.json'), `${JSON.stringify(o, null, 2)}\n`);
  const compare = o.compare === null ? null : (JSON.parse(readFileSync(o.compare, 'utf8')) as Summary);
  const queue = cells.flatMap((c) => Array.from({ length: o.n }, (_, trial) => ({ cell: c, trial })));
  const medianLoad = (rows: readonly TrialRow[], cell: string): number | null => median(rows.filter((r) => r.cell === cell && r.void === null).map((r) => r.load)) ?? null;
  const pooled = await runPool<(typeof queue)[number], TrialRow>(queue, {
    parallel: o.parallel, cap: o.cap, log, spent: (rows) => rows.reduce((a, r) => a + spentOf(r), 0),
    trial: async (job, done) => {
      const a: GateWorkerArgs = {
        role: 'gate', set: o.set, cell: job.cell.id, trial: job.trial, seed: o.seed, size: o.size, gate: o.gate, risk: o.risk, config: o.config,
        out: join(o.out, `${job.cell.id}-${job.trial}`), medianLoad: medianLoad(done, job.cell.id), trialCap: o.trialCap,
      };
      const died = await runWorker(a, log);
      const rowFile = join(a.out, 'row.json');
      const row = died === null && existsSync(rowFile) ? (JSON.parse(readFileSync(rowFile, 'utf8')) as TrialRow) : errorRow(a, job.cell.family, job.cell.plant !== null, died ?? 'no row.json');
      appendFileSync(join(o.out, 'trials.jsonl'), `${JSON.stringify(row)}\n`);
      log(`TRIAL ${row.cell}#${row.trial} ${row.void !== null ? `void:${row.void.reason} ${row.void.detail}` : row.caught !== null ? `caught-by:${row.caught}` : row.graded?.verdict} `
        + `outcome=${row.outcome} cost=$${spentOf(row).toFixed(3)} wall=${Math.round(row.wallMs / 1000)}s models=${row.models.join(',')}`);
      return row;
    },
  });
  const rows = pooled.rows;
  const notStarted = pooled.notStarted;
  rows.sort((x, y) => (x.cell === y.cell ? x.trial - y.trial : cells.findIndex((c) => c.id === x.cell) - cells.findIndex((c) => c.id === y.cell)));
  const summary = summarise(o.set, rows, compare, arm, o.cap === null ? null : { capUsd: o.cap, notStarted });
  writeFileSync(join(o.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const l of reportLines(summary)) log(l);
  log(`run dir ${o.out}`);
  return summary;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const fail = argv.find((a) => a === 'gate' || a === 'walkthrough') === 'walkthrough' ? walkFailed(await runWalk(parseWalkRun(argv))) : failed(await run(parseRun(argv)));
  process.exit(fail ? 1 : 0);
}
