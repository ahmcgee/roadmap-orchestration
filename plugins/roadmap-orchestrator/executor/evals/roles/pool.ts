// What every role eval's run shares (run.ts): the `--rebind` reader, one worker process per trial (trial.ts), and the
// pool that runs a queue of trials `parallel` at a time under the run's spend cap.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JsonValue } from '../../src/core/json.ts';
import { type RepoConfig, parseRepoConfig } from '../../src/routing/layers.ts';
import { modelInfo } from '../../src/routing/models.ts';
import { MODEL_IDS, type ModelId } from '../../src/routing/types.ts';
import type { WorkerArgs } from './trial.ts';

const WORKER = fileURLToPath(new URL('./trial.ts', import.meta.url));
const TRIAL_TIMEOUT_MS = 60 * 60_000;

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

/** `--<name> <v>`: an integer in lo..hi. */
export function intOption(name: string, v: string, lo: number, hi: number): number {
  const x = Number(v);
  if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`--${name} ${v}: an integer in ${lo}..${hi}`);
  return x;
}

/** `--<name> <usd>`: a positive amount, or null when absent. */
export function usdOption(name: string, v: string | undefined): number | null {
  if (v === undefined) return null;
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) throw new Error(`--${name} ${v}: a positive amount of USD`);
  return x;
}

/** Runs one trial's worker; null when it exited 0, else why it died. Its stdout lines go to `log` as they arrive. */
export function runWorker(a: WorkerArgs, log: (line: string) => void): Promise<string | null> {
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

/**
 * Runs `queue` `parallel` at a time; `trial` runs one job and returns its row. With `cap`, no job starts once the rows'
 * spend so far (`spent`) reaches it: the CAP line names the jobs not started, which the result counts.
 */
export async function runPool<J, R>(
  queue: J[], o: Readonly<{ parallel: number; cap: number | null; spent: (rows: readonly R[]) => number; trial: (job: J, rows: readonly R[]) => Promise<R>; log: (line: string) => void }>,
): Promise<Readonly<{ rows: R[]; notStarted: number }>> {
  const rows: R[] = [];
  let notStarted = 0;
  const next = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      if (o.cap !== null && o.spent(rows) >= o.cap) {
        notStarted += queue.length + 1;
        queue.length = 0;
        o.log(`CAP spend $${o.spent(rows).toFixed(2)} reached --cap $${o.cap.toFixed(2)}: ${notStarted} trials not started`);
        return;
      }
      rows.push(await o.trial(job, rows));
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.parallel, queue.length) }, next));
  return { rows, notStarted };
}
