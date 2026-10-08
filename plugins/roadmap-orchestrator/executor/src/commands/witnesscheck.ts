// `roadmap witness-check --lane-file <file>` (M4a rev 3, D1, R56): a host act an implementer runs in its worktree. Reads
// the write-once lane file the executor published (`WitnessLaneFile`, src/holistic/types.ts; `publishWitnessLaneFiles`,
// src/pipeline/witnesscheck.ts), runs that lane itself in the current worktree with a fresh witness file per execution,
// collects its records (`collectWitness`) and compares them with the file's required ids (`missingWitnesses`,
// src/holistic/required.ts, the comparator the lanes stage uses): exit 0, or 78 with `{missing, failed, malformed}`.
//
// The lane runs as the runner would run it: argv verbatim (no shell), in `<worktree>/<cwd>` (the worktree is the git
// top level of the current directory), with only the declared env (`set`, and `pass` copied from this process's env)
// plus the reporter's (`witnessEnv`), so argv[0] resolves on the declared PATH as it does for the executor. Its exit code
// is not the verdict: the records are. The lane's stdout and stderr go to this command's stderr; the reporter output is
// kept in a fresh `mkdtemp` directory (a Go lane's records are its stdout capture there) and removed afterwards, so a
// second run never reads the first one's records.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestRef } from '../core/events.ts';
import { readJson } from '../core/fsx.ts';
import type { LaneId } from '../core/ids.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { git } from '../git/git.ts';
import { missingWitnesses } from '../holistic/required.ts';
import { type WitnessLaneFile, witnessLaneFile } from '../holistic/types.ts';
import { collectWitness, witnessEnv } from '../holistic/witness.ts';
import { CliError } from '../input/cli.ts';

export type WitnessCheckArgs = Readonly<{ laneFile: AbsPath; cwd: AbsPath }>;
/** `passed`: every required id passed (exit 0); `missing`: what did not (exit 78). */
export type WitnessCheckOutcome =
  | Readonly<{ kind: 'passed' }>
  | Readonly<{ kind: 'missing'; missing: readonly TestRef[]; failed: readonly TestRef[]; malformed: readonly LaneId[] }>;

/** The witness lines file and the stdout capture inside a run's fresh directory. */
const WITNESS_LINES = 'witness.lines';
const STDOUT = 'stdout';

export async function witnessCheck(args: WitnessCheckArgs): Promise<WitnessCheckOutcome> {
  if (!existsSync(args.laneFile)) throw new CliError(`witness-check: no lane file ${args.laneFile}`);
  const file = witnessLaneFile(readJson(args.laneFile), args.laneFile);
  const worktree = absPath(git(args.cwd, ['rev-parse', '--show-toplevel']).replace(/\n$/, ''));
  const dir = absPath(mkdtempSync(join(tmpdir(), `roadmap-witness-${file.lane}-`)));
  try {
    await runLane(file, absPath(join(worktree, file.cwd)), dir);
    const tests = collectWitness(file.reporter, { witnessFile: absPath(join(dir, WITNESS_LINES)), stdoutFile: absPath(join(dir, STDOUT)) });
    const required = file.required.map((testId): TestRef => ({ lane: file.lane, testId }));
    const m = missingWitnesses([{ lane: file.lane, records: tests ?? [], malformed: tests === null }], required);
    return m.missing.length === 0 && m.failed.length === 0 ? { kind: 'passed' } : { kind: 'missing', ...m };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The lane's env: what it declares, and the reporter's; a lane declaring what the reporter sets is a bug its reader refuses. */
function laneEnv(file: WitnessLaneFile, witnessFile: AbsPath): Readonly<Record<string, string>> {
  const env: Record<string, string> = { ...file.env.set };
  for (const name of file.env.pass) {
    const value = process.env[name];
    if (value === undefined) throw new CliError(`witness-check: lane ${file.lane} passes ${name}, which this environment lacks`);
    env[name] = value;
  }
  for (const [name, value] of Object.entries(witnessEnv(file.reporter, witnessFile))) {
    if (Object.hasOwn(env, name)) throw new Error(`lane ${file.lane} declares ${name}, which the witness reporter sets`);
    env[name] = value;
  }
  return env;
}

/** Runs the lane to its end: stdout kept in `dir` and echoed to stderr, stderr to stderr. */
function runLane(file: WitnessLaneFile, cwd: AbsPath, dir: AbsPath): Promise<void> {
  const [program, ...rest] = file.argv;
  const out = createWriteStream(join(dir, STDOUT));
  return new Promise((resolve, reject) => {
    const child = spawn(program!, rest, { cwd, env: laneEnv(file, absPath(join(dir, WITNESS_LINES))), stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk: Buffer) => {
      out.write(chunk);
      process.stderr.write(chunk);
    });
    child.once('error', (error) => reject(new CliError(`witness-check: lane ${file.lane} did not start: ${error.message}`)));
    child.once('close', () => out.end(() => resolve()));
  });
}
