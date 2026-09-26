// CLI entry: parses argv into the closed Command union (src/input/cli.ts) and runs it. Run commands find
// their run dir through the RunLocator: the host lock claim's, or `--repo` + `--arc` explicitly. Commands
// for the executor (`pause`, `stop`, `ack`, `resume`, `sweep`) only write a file into its durable queue and
// print the command id; the executor applies it and writes the receipts. Output is agent-facing JSON.
// `start` and `status` land in step 13b.
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { submitCommand } from '../commands/queue.ts';
import type { ArcId } from '../core/ids.ts';
import { canonicalJson } from '../core/json.ts';
import type { CommandBody } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { HOST_DIR } from '../host/hostdir.ts';
import { readClaim } from '../host/lock.ts';
import { CliError, type Command, type RunLocator, parseCommand, runDir } from '../input/cli.ts';
import { gitCommonDir } from '../preflight/checks.ts';
import { watch } from '../watch.ts';

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };

/** EX_USAGE: the arguments were wrong. */
const EXIT_USAGE = 64;

type Run = Readonly<{ runDir: AbsPath; arc: ArcId }>;

function locate(locator: RunLocator): Run {
  if (locator.type === 'explicit') {
    const repo = absPath(resolve(locator.repo));
    return { runDir: runDir(gitCommonDir(repo), locator.arc), arc: locator.arc };
  }
  const claim = readClaim(HOST_DIR);
  if (claim === null) throw new CliError(`no arc holds this host (${HOST_DIR}); name the run with --repo and --arc`);
  return { runDir: claim.runDir, arc: claim.arc };
}

function submit(locator: RunLocator, body: CommandBody): void {
  const run = locate(locator);
  const file = submitCommand(run.runDir, run.arc, body);
  process.stdout.write(`${canonicalJson({ command: file.id, arc: run.arc, type: body.type })}\n`);
}

async function runCommand(command: Command): Promise<void> {
  switch (command.command) {
    case 'version':
      process.stdout.write(`${pkg.version}\n`);
      return;
    case 'pause':
      return submit(command.run, { type: 'pause', target: command.target });
    case 'stop':
      return submit(command.run, { type: 'stop' });
    case 'ack':
      return submit(command.run, { type: 'ack', needsUser: command.id, choice: command.choice });
    case 'resume':
      return submit(command.run, { type: 'resume', target: command.target });
    case 'sweep':
      return submit(command.run, { type: 'sweep', resource: command.resource });
    case 'watch': {
      const run = locate(command.run);
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
      await watch(run.runDir, HOST_DIR, (line) => process.stdout.write(`${line}\n`), stop.signal);
      return;
    }
    case 'start':
    case 'status':
      process.stderr.write(`roadmap ${command.command}: not implemented (M1 step 13b)\n`);
      process.exitCode = EXIT_USAGE;
      return;
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  let command: Command;
  try {
    command = parseCommand(argv);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    process.stderr.write(`roadmap: ${error.message}\n`);
    process.exitCode = EXIT_USAGE;
    return;
  }
  try {
    await runCommand(command);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    process.stderr.write(`roadmap: ${error.message}\n`);
    process.exitCode = EXIT_USAGE;
  }
}
