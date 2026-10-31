import { runSurface } from './surface/run.ts';
// Role eval dispatcher. `verifier` runs gate mode; `pre-build` and `campaignAudit` use the
// three-cell surface dev sets. --dry-run on either new set performs no backend calls.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RepoConfig } from '../../src/routing/layers.ts';
import { RISK_TIERS, type RiskTier } from '../../src/routing/types.ts';
import { FAKE_GATES, type GateKind, type TrialRow, gateArm } from './gate/arc.ts';
import { type CellSet, cellsFor, isPlanted } from './gate/cells.ts';
import { type Summary, failed, reportLines, spentOf, summarise } from './gate/summary.ts';
import { intOption, rebindConfig, runPool, runWorker, usdOption } from './pool.ts';
import { median } from './stats.ts';
import type { GateWorkerArgs } from './trial.ts';
import { parsePolishRun, runPolish } from './polish/run.ts';
import { polishFailed } from './polish/summary.ts';
import { type EvalRole, TRIGGERS } from './triggers.ts';
import { parseWalkRun, runWalk } from './walkthrough/run.ts';
import { walkFailed } from './walkthrough/summary.ts';

export { rebindConfig };

const USAGE = 'usage: node evals/roles/run.ts gate --set dev|holdout [--n 3] [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1] [--risk med] '
  + '[--rebind <class>=<model>:<effort> ...] [--out <dir>] [--compare <summary.json>] [--fake <kind>] [--cap <usd>] [--trial-cap <usd>] [--read-only] [--baseline <summary.json>]';

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
  /** `--read-only`: the dev.12 gate's read-only profile, the comparison arm (dev.13). */
  readOnly: boolean;
  /** `--baseline`: the read-only arm's summary.json on the same cells, or null. */
  baseline: string | null;
}>;

export function parseRun(argv: readonly string[]): RunOptions {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true,
    options: {
      set: { type: 'string' }, n: { type: 'string', default: '3' }, cells: { type: 'string' }, parallel: { type: 'string', default: '4' },
      size: { type: 'string', default: '3000' }, seed: { type: 'string', default: 'roles-1' }, risk: { type: 'string', default: 'med' },
      rebind: { type: 'string', multiple: true }, out: { type: 'string' }, compare: { type: 'string' }, fake: { type: 'string' },
      cap: { type: 'string' }, 'trial-cap': { type: 'string' }, 'read-only': { type: 'boolean', default: false }, baseline: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'gate') throw new Error(`${USAGE}\n(the gate's options; another role's: node evals/roles/run.ts walkthrough|polishJudge|verifier|scaffold --help)`);
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
    cap: usd('cap', values.cap), trialCap: usd('trial-cap', values['trial-cap']), readOnly: values['read-only'], baseline: values.baseline ?? null,
  };
}

/** A row for a trial whose worker died before writing one. */
function errorRow(a: GateWorkerArgs, family: string, planted: boolean, detail: string): TrialRow {
  return {
    set: a.set, cell: a.cell, family, trial: a.trial, planted, gate: a.gate, outcome: null, caught: null, decision: null, void: { reason: 'error', detail }, graded: null,
    readOnly: a.readOnly, experiments: 0, largeDiff: false, clusters: null, usage: null, estimatedUsd: 0, wallMs: 0, turns: 0, load: 0, calls: 0, models: [], method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: a.out,
  };
}

export async function run(o: RunOptions, log: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<Summary> {
  const all = await cellsFor(o.set);
  const unknown = (o.cells ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`no cell ${unknown.join(', ')} in the ${o.set} set (${all.map((c) => c.id).join(', ')})`);
  const cells = o.cells === null ? all : all.filter((c) => o.cells!.includes(c.id));
  if (existsSync(o.out) && readdirSync(o.out).length > 0) throw new Error(`--out ${o.out} is not empty`);
  mkdirSync(o.out, { recursive: true });
  const arm = gateArm(o.risk, o.config, o.readOnly);
  const baseline = o.baseline === null ? null : (JSON.parse(readFileSync(o.baseline, 'utf8')) as Summary);
  if (baseline !== null && (o.readOnly || baseline.arm === null || !baseline.arm.endsWith(' read-only'))) throw new Error(`--baseline compares an acting run with a --read-only run's summary (its arm ${baseline.arm})`);
  writeFileSync(join(o.out, 'run.json'), `${JSON.stringify(o, null, 2)}\n`);
  const compare = o.compare === null ? null : (JSON.parse(readFileSync(o.compare, 'utf8')) as Summary);
  const queue = cells.flatMap((c) => Array.from({ length: o.n }, (_, trial) => ({ cell: c, trial })));
  const medianLoad = (rows: readonly TrialRow[], cell: string): number | null => median(rows.filter((r) => r.cell === cell && r.void === null).map((r) => r.load)) ?? null;
  const pooled = await runPool<(typeof queue)[number], TrialRow>(queue, {
    parallel: o.parallel, cap: o.cap, log, spent: (rows) => rows.reduce((a, r) => a + spentOf(r), 0),
    trial: async (job, done) => {
      const a: GateWorkerArgs = {
        role: 'gate', set: o.set, cell: job.cell.id, trial: job.trial, seed: o.seed, size: o.size, gate: o.gate, risk: o.risk, config: o.config,
        out: join(o.out, `${job.cell.id}-${job.trial}`), medianLoad: medianLoad(done, job.cell.id), trialCap: o.trialCap, readOnly: o.readOnly,
      };
      const died = await runWorker(a, log);
      const rowFile = join(a.out, 'row.json');
      const row = died === null && existsSync(rowFile) ? (JSON.parse(readFileSync(rowFile, 'utf8')) as TrialRow) : errorRow(a, job.cell.family, isPlanted(job.cell), died ?? 'no row.json');
      appendFileSync(join(o.out, 'trials.jsonl'), `${JSON.stringify(row)}\n`);
      log(`TRIAL ${row.cell}#${row.trial} ${row.void !== null ? `void:${row.void.reason} ${row.void.detail}` : row.caught !== null ? `caught-by:${row.caught}` : row.graded?.verdict} `
        + `outcome=${row.outcome} cost=$${spentOf(row).toFixed(3)} wall=${Math.round(row.wallMs / 1000)}s models=${row.models.join(',')}`);
      return row;
    },
  });
  const rows = pooled.rows;
  const notStarted = pooled.notStarted;
  rows.sort((x, y) => (x.cell === y.cell ? x.trial - y.trial : cells.findIndex((c) => c.id === x.cell) - cells.findIndex((c) => c.id === y.cell)));
  const summary = summarise(o.set, rows, compare, arm, o.cap === null ? null : { capUsd: o.cap, notStarted }, baseline);
  writeFileSync(join(o.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const l of reportLines(summary)) log(l);
  log(`run dir ${o.out}`);
  return summary;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const role = argv.find((a): a is EvalRole => (Object.keys(TRIGGERS) as readonly string[]).includes(a)) ?? 'gate';
  const fail = role === 'pre-build' || role === 'campaignAudit' ? !(await runSurface(argv)) : role === 'walkthrough' ? walkFailed(await runWalk(parseWalkRun(argv)))
    : role === 'polishJudge' ? polishFailed(await runPolish(parsePolishRun(argv)))
    : role === 'verifier' ? failed(await run(parseRun(argv.map((a) => a === 'verifier' ? 'gate' : a))))
    : failed(await run(parseRun(argv)));
  process.exit(fail ? 1 : 0);
}
