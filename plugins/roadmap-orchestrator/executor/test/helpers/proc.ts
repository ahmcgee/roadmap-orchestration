// Spawning helpers shared by integrated tests.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** The child's complete environment; nothing is inherited implicitly. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs: number;
}

/** Absolute path of a script under test/fixtures. */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/**
 * Run `cmd` to completion and report how it ended. If it outlives `timeoutMs` it is SIGKILLed and the
 * promise rejects: a hung child is a test failure, never a result.
 */
export function runUntilExit(cmd: string, args: readonly string[], options: RunOptions): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} ${args.join(' ')} exceeded ${options.timeoutMs} ms; killed. stderr: ${stderr}`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** Run a TypeScript fixture script with this Node binary. */
export function runFixture(name: string, args: readonly string[], options: RunOptions): Promise<Exit> {
  return runUntilExit(process.execPath, [fixture(name), ...args], options);
}
