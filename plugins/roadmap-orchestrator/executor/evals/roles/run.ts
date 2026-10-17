// Role evals (rung 3.5): N trials per cell of a role, each in its own worker process, graded against answer keys only the
// eval run dir holds, aggregated with Wilson intervals and per-model cost.
//
//   node evals/roles/run.ts gate --set dev|holdout [--n 3] [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1]
//                           [--risk low|med|high] [--rebind <class>=<model>:<effort> ...] [--out <dir>] [--compare <dev summary.json>]
//                           [--fake approve-all|revise-all|cite-every-path|cite-plant]
//
// The arm: `--risk` picks the gate seat (built-in: low economy/Haiku 5.5, med efficient/Sonnet 5.5, high frontier/Opus 5.5)
// and `--rebind` (repeatable) rebinds a class for the run through the production mechanism, the repo config's
// `routing.classes` (e.g. `--risk low --rebind economy=claude-opus-5-5:medium` runs Opus on the low seat). The ARM line,
// summary.json's `arm` and the compare criterion name the seat, its class and the model:effort serving it.
//
// Writes <out>/trials.jsonl (one row per trial, as each finishes), <out>/summary.json and <out>/<cell>-<trial>/ (key.json,
// prompt.txt, gate-<n>.jsonl, transcript.jsonl, answer.json, row.json); prints the workers' TRACE and BRAKE lines, a TRIAL
// line per trial, then the report (summary.ts: CELL, COST, PASS|FAIL|INFO, USAGE, TOTAL). Exits 1 on any FAIL.
// `--fake` swaps the real gate for a degenerate one (free: the harness and graders' own check); a real gate needs
// --size 2000..5000. Each trial is bounded by a 60-minute worker timeout on top of the gate's own judgment deadline.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { JsonValue } from '../../src/core/json.ts';
import { type RepoConfig, parseRepoConfig } from '../../src/routing/layers.ts';
import { modelInfo } from '../../src/routing/models.ts';
import { MODEL_IDS, type ModelId, RISK_TIERS, type RiskTier } from '../../src/routing/types.ts';
import { FAKE_GATES, type GateKind, type TrialRow, gateArm } from './gate/arc.ts';
import { type CellSet, cellsFor } from './gate/cells.ts';
import { type Summary, failed, reportLines, summarise } from './gate/summary.ts';
import { median } from './stats.ts';
import type { WorkerArgs } from './trial.ts';

const WORKER = fileURLToPath(new URL('./trial.ts', import.meta.url));
const TRIAL_TIMEOUT_MS = 60 * 60_000;
const USAGE = 'usage: node evals/roles/run.ts gate --set dev|holdout [--n 3] [--cells G0,G3a] [--parallel 4] [--size 3000] [--seed roles-1] [--risk med] '
  + '[--rebind <class>=<model>:<effort> ...] [--out <dir>] [--compare <summary.json>] [--fake <kind>]';

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
}>;

export function parseRun(argv: readonly string[]): RunOptions {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true,
    options: {
      set: { type: 'string' }, n: { type: 'string', default: '3' }, cells: { type: 'string' }, parallel: { type: 'string', default: '4' },
      size: { type: 'string', default: '3000' }, seed: { type: 'string', default: 'roles-1' }, risk: { type: 'string', default: 'med' },
      rebind: { type: 'string', multiple: true }, out: { type: 'string' }, compare: { type: 'string' }, fake: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'gate') throw new Error(`${USAGE}\n(only the gate role has evals so far)`);
  if (values.set !== 'dev' && values.set !== 'holdout') throw new Error(USAGE);
  const int = (name: string, v: string, lo: number, hi: number): number => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`--${name} ${v}: an integer in ${lo}..${hi}`);
    return x;
  };
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
  };
}

/**
 * `--rebind <class>=<model>:<effort>` flags as the repo config `.roadmap/config.json` would hold (`routing.classes`), read
 * by the production config reader (unknown class, model or effort refused); null without a flag.
 */
export function rebindConfig(flags: readonly string[]): RepoConfig | null {
  if (flags.length === 0) return null;
  const classes: Record<string, JsonValue> = {};
  for (const flag of flags) {
    const m = /^([a-z]+)=([a-z0-9.-]+):([a-z]+)$/.exec(flag);
    if (m === null) throw new Error(`--rebind ${flag}: <class>=<model>:<effort>`);
    const [, cls, model, effort] = m as unknown as [string, string, string, string];
    if (!(MODEL_IDS as readonly string[]).includes(model)) throw new Error(`--rebind ${flag}: model one of ${MODEL_IDS.join(', ')}`);
    if (Object.hasOwn(classes, cls)) throw new Error(`--rebind ${flag}: ${cls} rebound twice`);
    classes[cls] = { backend: modelInfo(model as ModelId).backend, model, effort };
  }
  return parseRepoConfig({ routing: { classes } });
}

/** A row for a trial whose worker died before writing one. */
function errorRow(a: WorkerArgs, family: string, planted: boolean, detail: string): TrialRow {
  return {
    set: a.set, cell: a.cell, family, trial: a.trial, planted, gate: a.gate, outcome: null, caught: null, decision: null, void: { reason: 'error', detail }, graded: null, usage: null,
    wallMs: 0, turns: 0, load: 0, calls: 0, models: [], method: { available: [], tools: {}, subagents: [], firstReadS: null, firstAgentS: null, denials: 0, unavailable: [] }, stages: [], dir: a.out,
  };
}

function runWorker(a: WorkerArgs, log: (line: string) => void): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(a)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const l of lines) log(l);
    });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString('utf8')).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), TRIAL_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done(code === 0 ? null : `worker exited ${code ?? signal}: ${err.trim().split('\n').slice(-5).join(' | ')}`);
    });
  });
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
  const rows: TrialRow[] = [];
  const medianLoad = (cell: string): number | null => median(rows.filter((r) => r.cell === cell && r.void === null).map((r) => r.load)) ?? null;
  const next = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const a: WorkerArgs = {
        role: 'gate', set: o.set, cell: job.cell.id, trial: job.trial, seed: o.seed, size: o.size, gate: o.gate, risk: o.risk, config: o.config,
        out: join(o.out, `${job.cell.id}-${job.trial}`), medianLoad: medianLoad(job.cell.id),
      };
      const died = await runWorker(a, log);
      const rowFile = join(a.out, 'row.json');
      const row = died === null && existsSync(rowFile) ? (JSON.parse(readFileSync(rowFile, 'utf8')) as TrialRow) : errorRow(a, job.cell.family, job.cell.plant !== null, died ?? 'no row.json');
      rows.push(row);
      appendFileSync(join(o.out, 'trials.jsonl'), `${JSON.stringify(row)}\n`);
      log(`TRIAL ${row.cell}#${row.trial} ${row.void === null ? row.graded?.verdict : `void:${row.void.reason} ${row.void.detail}`} `
        + `outcome=${row.outcome} cost=$${(row.usage?.totalUsd ?? 0).toFixed(3)} wall=${Math.round(row.wallMs / 1000)}s models=${row.models.join(',')}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.parallel, queue.length) }, next));
  rows.sort((x, y) => (x.cell === y.cell ? x.trial - y.trial : cells.findIndex((c) => c.id === x.cell) - cells.findIndex((c) => c.id === y.cell)));
  const summary = summarise(o.set, rows, compare, arm);
  writeFileSync(join(o.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const l of reportLines(summary)) log(l);
  log(`run dir ${o.out}`);
  return summary;
}

if (import.meta.main) {
  const summary = await run(parseRun(process.argv.slice(2)));
  process.exit(failed(summary) ? 1 : 0);
}
