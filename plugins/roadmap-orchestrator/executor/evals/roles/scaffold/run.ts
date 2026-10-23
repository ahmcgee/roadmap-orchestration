// The scaffold role eval's run (rung 3.5; evals/roles/run.ts dispatches `scaffold` here):
//
//   node evals/roles/run.ts scaffold --set dev|holdout [--n 3] [--cells module,imports-map] [--parallel 2] [--rebind <class>=<model>:<effort> ...]
//                           [--out <dir>] [--compare <dev summary.json>] [--fake <writer>] [--cap <usd>] [--trial-cap <usd>]
//
// The arm is the scaffold seat (`scaffold.med`, built-in economy: Haiku 5.5 high); `--rebind` rebinds a class through the
// repo config, as for the gate. `--fake` swaps the real writer for a degenerate one (arc.ts `FAKE_WRITERS`, free). Writes
// <out>/trials.jsonl, <out>/summary.json and <out>/<cell>-<trial>/ (key.json, prompt-<n>.txt per attempt, argv.json,
// scaffold-<n>.jsonl (each call's stdout), transcript.jsonl, answer.json, skeleton.diff when one landed, row.json); prints
// the TRACE and BRAKE lines, a TRIAL line per trial, then the report (summary.ts). Exits 1 on any FAIL. Each trial is bounded
// by the worker's 60-minute timeout and the stage's 30-minute call deadline. `--cap` and `--trial-cap` work as for the gate.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RepoConfig } from '../../../src/routing/layers.ts';
import type { CellSet } from '../gate/cells.ts';
import { intOption, rebindConfig, runPool, runWorker, usdOption } from '../pool.ts';
import { median } from '../stats.ts';
import { FAKE_WRITERS, type ScaffoldRow, type ScaffoldWorkerArgs, type WriterKind, scaffoldSeat } from './arc.ts';
import { type ScaffoldCell, scaffoldCellsFor } from './cells.ts';
import { type ScaffoldSummary, scaffoldReportLines, spentOf, summariseScaffold } from './summary.ts';

const USAGE = 'usage: node evals/roles/run.ts scaffold --set dev|holdout [--n 3] [--cells module,imports-map] [--parallel 2] [--rebind <class>=<model>:<effort> ...] '
  + `[--out <dir>] [--compare <summary.json>] [--fake ${FAKE_WRITERS.join('|')}] [--cap <usd>] [--trial-cap <usd>]`;

export type ScaffoldRunOptions = Readonly<{
  set: CellSet;
  n: number;
  cells: readonly string[] | null;
  parallel: number;
  config: RepoConfig | null;
  out: string;
  compare: string | null;
  writer: WriterKind;
  cap: number | null;
  trialCap: number | null;
}>;

export function parseScaffoldRun(argv: readonly string[]): ScaffoldRunOptions {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true,
    options: {
      set: { type: 'string' }, n: { type: 'string', default: '3' }, cells: { type: 'string' }, parallel: { type: 'string', default: '2' },
      rebind: { type: 'string', multiple: true }, out: { type: 'string' }, compare: { type: 'string' }, fake: { type: 'string' },
      cap: { type: 'string' }, 'trial-cap': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'scaffold') throw new Error(USAGE);
  if (values.set !== 'dev' && values.set !== 'holdout') throw new Error(USAGE);
  const writer = values.fake === undefined ? 'real' : (FAKE_WRITERS as readonly string[]).includes(values.fake) ? (values.fake as WriterKind) : null;
  if (writer === null) throw new Error(`--fake ${values.fake}: one of ${FAKE_WRITERS.join(', ')}`);
  const out = resolve(values.out ?? join('/var/tmp', `roles-scaffold-${values.set}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  // The run dir is a needle (arc.ts): a dir that contains the host's temp dir would match every path the session touches.
  if (resolve(tmpdir()).startsWith(out)) throw new Error(`--out ${out} contains the temp dir ${tmpdir()}, where the trials' arcs live`);
  return {
    set: values.set, n: intOption('n', values.n, 1, 100), cells: values.cells === undefined ? null : values.cells.split(','),
    parallel: intOption('parallel', values.parallel, 1, 8), config: rebindConfig(values.rebind ?? []), out, compare: values.compare ?? null, writer,
    cap: usdOption('cap', values.cap), trialCap: usdOption('trial-cap', values['trial-cap']),
  };
}

/** A row for a trial whose worker died before writing one. */
function errorRow(a: ScaffoldWorkerArgs, cell: ScaffoldCell, detail: string): ScaffoldRow {
  return {
    set: a.set, cell: a.cell, family: cell.family, trial: a.trial, writer: a.writer, void: { reason: 'error', detail }, verdict: null, outcomes: [], refusals: [],
    files: [], linesAdded: null, usage: null, estimatedUsd: 0, wallMs: 0, turns: 0, load: 0, calls: 0, models: [],
    method: { available: [], tools: {}, shellCalls: 0, subagents: [], denials: 0, unavailable: [] }, dir: a.out,
  };
}

function trialLine(r: ScaffoldRow): string {
  return `TRIAL ${r.cell}#${r.trial}${r.void !== null ? ` void:${r.void.reason} ${r.void.detail.split('\n')[0]}` : ` ${r.verdict}`} `
    + `calls=${r.calls} files=${r.files.length} cost=$${spentOf(r).toFixed(3)} wall=${Math.round(r.wallMs / 1000)}s models=${r.models.join(',')}`;
}

export async function runScaffold(o: ScaffoldRunOptions, log: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<ScaffoldSummary> {
  const all = await scaffoldCellsFor(o.set);
  const unknown = (o.cells ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`no cell ${unknown.join(', ')} in the scaffold ${o.set} set (${all.map((c) => c.id).join(', ')})`);
  const cells = o.cells === null ? all : all.filter((c) => o.cells!.includes(c.id));
  if (existsSync(o.out) && readdirSync(o.out).length > 0) throw new Error(`--out ${o.out} is not empty`);
  mkdirSync(o.out, { recursive: true });
  const { arm } = scaffoldSeat(o.config);
  writeFileSync(join(o.out, 'run.json'), `${JSON.stringify(o, null, 2)}\n`);
  const compare = o.compare === null ? null : (JSON.parse(readFileSync(o.compare, 'utf8')) as ScaffoldSummary);
  // Run by run: every cell's trial 0, then every cell's trial 1, so a capped run leaves whole runs behind it.
  const queue = Array.from({ length: o.n }, (_, trial) => cells.map((c) => ({ cell: c, trial }))).flat();
  const medianLoad = (rows: readonly ScaffoldRow[], cell: string): number | null => median(rows.filter((r) => r.cell === cell && r.void === null).map((r) => r.load));
  const { rows, notStarted } = await runPool<(typeof queue)[number], ScaffoldRow>(queue, {
    parallel: o.parallel, cap: o.cap, log, spent: (rs) => rs.reduce((a, r) => a + spentOf(r), 0),
    trial: async (job, done) => {
      const a: ScaffoldWorkerArgs = {
        role: 'scaffold', set: o.set, cell: job.cell.id, trial: job.trial, writer: o.writer, config: o.config,
        out: join(o.out, `${job.cell.id}-${job.trial}`), medianLoad: medianLoad(done, job.cell.id), trialCap: o.trialCap,
      };
      const died = await runWorker(a, log);
      const rowFile = join(a.out, 'row.json');
      const row = died === null && existsSync(rowFile) ? (JSON.parse(readFileSync(rowFile, 'utf8')) as ScaffoldRow) : errorRow(a, job.cell, died ?? 'no row.json');
      appendFileSync(join(o.out, 'trials.jsonl'), `${JSON.stringify(row)}\n`);
      log(trialLine(row));
      return row;
    },
  });
  rows.sort((x, y) => (x.cell === y.cell ? x.trial - y.trial : cells.findIndex((c) => c.id === x.cell) - cells.findIndex((c) => c.id === y.cell)));
  const summary = summariseScaffold(o.set, rows, compare, arm, o.cap === null ? null : { capUsd: o.cap, notStarted });
  writeFileSync(join(o.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const l of scaffoldReportLines(summary)) log(l);
  log(`run dir ${o.out}`);
  return summary;
}
