// The verifier role eval's run (rung 3.5; evals/roles/run.ts dispatches `verifier` here):
//
//   node evals/roles/run.ts verifier --set dev|holdout [--n 3] [--cells CL-PY-DOC,EX-PY-DOCTEST] [--parallel 4]
//                           [--rebind <class>=<model>:<effort> ...] [--out <dir>] [--compare <dev summary.json>]
//                           [--fake oracle|clear-all|refuse-all|overspend] [--cap <usd>] [--trial-cap <usd>]
//
// The arm is the verifier seat (`verifier.med`, built-in economy: Haiku 5.5 high); `--rebind` rebinds a class through the
// repo config, as for the gate. `--fake` swaps the real call for a degenerate verifier (arc.ts `FAKE_VERIFIERS`, free).
// Writes <out>/trials.jsonl, <out>/summary.json and <out>/<cell>-<trial>/ (key.json, prompt.txt, verifier-<n>.jsonl,
// transcript.jsonl, answer.json, row.json); prints the BRAKE lines, a TRIAL line per trial, then the report (summary.ts).
// Exits 1 on any FAIL. Each trial is bounded by the worker's 60-minute timeout and the verifier's judgment deadline.
// `--cap` and `--trial-cap` work as for the gate.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { RepoConfig } from '../../../src/routing/layers.ts';
import type { CellSet } from '../gate/cells.ts';
import { intOption, rebindConfig, runPool, runWorker, usdOption } from '../pool.ts';
import { FAKE_VERIFIERS, type VerifierKind, type VerifierRow, type VerifierWorkerArgs, verifierArm } from './arc.ts';
import { type VerifierCell, verifierCellsFor } from './cells.ts';
import { type VerifierSummary, spentOf, summariseVerifier, verifierReportLines } from './summary.ts';

const USAGE = 'usage: node evals/roles/run.ts verifier --set dev|holdout [--n 3] [--cells CL-PY-DOC,EX-PY-DOCTEST] [--parallel 4] [--rebind <class>=<model>:<effort> ...] '
  + `[--out <dir>] [--compare <summary.json>] [--fake ${FAKE_VERIFIERS.join('|')}] [--cap <usd>] [--trial-cap <usd>]`;

export type VerifierRunOptions = Readonly<{
  set: CellSet;
  n: number;
  cells: readonly string[] | null;
  parallel: number;
  config: RepoConfig | null;
  out: string;
  compare: string | null;
  verifier: VerifierKind;
  cap: number | null;
  trialCap: number | null;
}>;

export function parseVerifierRun(argv: readonly string[]): VerifierRunOptions {
  const { values, positionals } = parseArgs({
    args: [...argv], allowPositionals: true,
    options: {
      set: { type: 'string' }, n: { type: 'string', default: '3' }, cells: { type: 'string' }, parallel: { type: 'string', default: '4' },
      rebind: { type: 'string', multiple: true }, out: { type: 'string' }, compare: { type: 'string' }, fake: { type: 'string' },
      cap: { type: 'string' }, 'trial-cap': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || positionals[0] !== 'verifier') throw new Error(USAGE);
  if (values.set !== 'dev' && values.set !== 'holdout') throw new Error(USAGE);
  const verifier = values.fake === undefined ? 'real' : (FAKE_VERIFIERS as readonly string[]).includes(values.fake) ? (values.fake as VerifierKind) : null;
  if (verifier === null) throw new Error(`--fake ${values.fake}: one of ${FAKE_VERIFIERS.join(', ')}`);
  const out = resolve(values.out ?? join('/var/tmp', `roles-verifier-${values.set}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  // The run dir is a needle (arc.ts): a dir that contains the host's temp dir would match every path the session touches.
  if (resolve(tmpdir()).startsWith(out)) throw new Error(`--out ${out} contains the temp dir ${tmpdir()}, where the trials' arcs live`);
  return {
    set: values.set, n: intOption('n', values.n, 1, 100), cells: values.cells === undefined ? null : values.cells.split(','),
    parallel: intOption('parallel', values.parallel, 1, 16), config: rebindConfig(values.rebind ?? []), out, compare: values.compare ?? null, verifier,
    cap: usdOption('cap', values.cap), trialCap: usdOption('trial-cap', values['trial-cap']),
  };
}

/** A row for a trial whose worker died before writing one. */
function errorRow(a: VerifierWorkerArgs, cell: VerifierCell, detail: string): VerifierRow {
  return {
    set: a.set, cell: a.cell, family: cell.family, trial: a.trial, verifier: a.verifier, expected: cell.hunks.every((h) => h === 'clear') ? 'accept' : 'refuse',
    void: { reason: 'error', detail }, decision: null, correct: null, reason: null, hunks: [], usage: null, estimatedUsd: 0, wallMs: 0, turns: 0, calls: 0, models: [], dir: a.out,
  };
}

function trialLine(r: VerifierRow): string {
  return `TRIAL ${r.cell}#${r.trial}${r.void !== null ? ` void:${r.void.reason} ${r.void.detail.split('\n')[0]}` : ` expect=${r.expected} ${r.decision} ${r.correct === true ? 'correct' : 'wrong'}`} `
    + `hunks=${r.hunks.map((h) => `${h.id}:${h.clear ? 'clear' : 'not-clear'}`).join(',')} cost=$${spentOf(r).toFixed(4)} wall=${Math.round(r.wallMs / 1000)}s models=${r.models.join(',')}`;
}

export async function runVerifier(o: VerifierRunOptions, log: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<VerifierSummary> {
  const all = await verifierCellsFor(o.set);
  const unknown = (o.cells ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknown.length > 0) throw new Error(`no cell ${unknown.join(', ')} in the verifier ${o.set} set (${all.map((c) => c.id).join(', ')})`);
  const cells = o.cells === null ? all : all.filter((c) => o.cells!.includes(c.id));
  if (existsSync(o.out) && readdirSync(o.out).length > 0) throw new Error(`--out ${o.out} is not empty`);
  mkdirSync(o.out, { recursive: true });
  const arm = verifierArm(o.config);
  writeFileSync(join(o.out, 'run.json'), `${JSON.stringify(o, null, 2)}\n`);
  const compare = o.compare === null ? null : (JSON.parse(readFileSync(o.compare, 'utf8')) as VerifierSummary);
  // Run by run: every cell's trial 0, then every cell's trial 1, so a capped run leaves whole runs behind it.
  const queue = Array.from({ length: o.n }, (_, trial) => cells.map((c) => ({ cell: c, trial }))).flat();
  const { rows, notStarted } = await runPool<(typeof queue)[number], VerifierRow>(queue, {
    parallel: o.parallel, cap: o.cap, log, spent: (rs) => rs.reduce((a, r) => a + spentOf(r), 0),
    trial: async (job) => {
      const a: VerifierWorkerArgs = {
        role: 'verifier', set: o.set, cell: job.cell.id, trial: job.trial, verifier: o.verifier, config: o.config, out: join(o.out, `${job.cell.id}-${job.trial}`), trialCap: o.trialCap,
      };
      const died = await runWorker(a, log);
      const rowFile = join(a.out, 'row.json');
      const row = died === null && existsSync(rowFile) ? (JSON.parse(readFileSync(rowFile, 'utf8')) as VerifierRow) : errorRow(a, job.cell, died ?? 'no row.json');
      appendFileSync(join(o.out, 'trials.jsonl'), `${JSON.stringify(row)}\n`);
      log(trialLine(row));
      return row;
    },
  });
  rows.sort((x, y) => (x.cell === y.cell ? x.trial - y.trial : cells.findIndex((c) => c.id === x.cell) - cells.findIndex((c) => c.id === y.cell)));
  const summary = summariseVerifier(o.set, rows, compare, arm, o.cap === null ? null : { capUsd: o.cap, notStarted });
  writeFileSync(join(o.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const l of verifierReportLines(summary)) log(l);
  log(`run dir ${o.out}`);
  return summary;
}
