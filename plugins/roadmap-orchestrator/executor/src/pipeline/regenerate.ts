// The regenerate check (dev.12): what a derived entry's regenerate lane runs (src/input/derived.ts `regenerateLane`, through
// src/entry/regenerate.ts), in the clean detached checkout of a unit's commit that the lane series made.
//
// 1. The checkout must be clean (`git status`, untracked files included, ignored ones not): the check reads every change
//    after the generator as the generator's, so a dirty checkout is a fault of the caller (exit 2), never a verdict.
// 2. The generator runs verbatim (no shell) from its declared cwd, its output on the lane's stdout and stderr.
// 3. Every path `git status` then shows is a difference: an output the commit does not hold byte for byte (modified,
//    added or deleted), or a file outside the entry's outputs that the generator wrote (the plan's outputs are incomplete,
//    or the generator writes beyond them: either way the commit is not what the generator produces). Each is named, with a
//    bounded difference (`git diff` of a tracked file, the head of a new one).
// 4. The checkout is put back as the commit holds it (tracked paths checked out, new files removed), so the series'
//    own cleanliness check certifies it and the lane's verdict is the one finding.
//
// Exit 0: the generator exited 0 and nothing differs. Exit 1: a difference, or a generator that failed or could not start.
// The lane expects 0, so either is red, with this output as its evidence.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RegenerateRequest } from '../input/derived.ts';
import { type RepoPath, matchesPattern, repoPath } from '../core/values.ts';

/** Files a report shows a difference of; the rest are named only. */
export const SHOWN_FILES = 20;
/** Lines of one file's difference shown. */
export const SHOWN_LINES = 60;
/** A shown line's characters (a minified golden is one long line). */
export const LINE_CHARS = 400;

export type Change = Readonly<{ path: RepoPath; state: 'modified' | 'added' | 'deleted'; output: boolean }>;

function gitOut(git: string, root: string, args: readonly string[]): string {
  const r = spawnSync(git, ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${root} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Every changed path of the checkout at `root` (untracked included, ignored not), by `git status --porcelain -z`. */
export function statusChanges(git: string, root: string, outputs: RegenerateRequest['outputs']): readonly Change[] {
  const fields = gitOut(git, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']).split('\0').filter((f) => f !== '');
  return fields.map((f): Change => {
    const xy = f.slice(0, 2);
    const path = repoPath(f.slice(3));
    const state = xy === '??' ? 'added' : xy.includes('D') ? 'deleted' : 'modified';
    return { path, state, output: outputs.some((o) => matchesPattern(path, o)) };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const clip = (line: string): string => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}... (${line.length} chars)` : line);

/** A new file's lines as additions, or one line for a binary one (a NUL byte). */
const addedLines = (bytes: Buffer): readonly string[] =>
  bytes.includes(0) ? [`Binary file, ${bytes.length} bytes`] : bytes.toString('utf8').split('\n').map((l) => `+${l}`);

/** A bounded difference of one change: `git diff` of a tracked path, the head of a new file, nothing for a deletion. */
function differenceLines(git: string, root: string, c: Change): readonly string[] {
  const lines = c.state === 'deleted' ? [] : c.state === 'added' ? addedLines(readFileSync(join(root, c.path))) : gitOut(git, root, ['diff', '--no-color', '-U3', '--', c.path]).split('\n');
  const body = lines.filter((l) => l !== '').map(clip);
  return body.length > SHOWN_LINES ? [...body.slice(0, SHOWN_LINES), `... ${body.length - SHOWN_LINES} more lines`] : body;
}

/** The report of `changes`: each named, the first SHOWN_FILES with their bounded difference, and what to do. */
export function reportLines(git: string, root: string, request: RegenerateRequest, changes: readonly Change[]): readonly string[] {
  const outputs = changes.filter((c) => c.output);
  const other = changes.filter((c) => !c.output);
  const out: string[] = [];
  if (outputs.length > 0) out.push(`regenerate: ${outputs.length} output${outputs.length === 1 ? '' : 's'} the commit does not hold as the generator writes ${outputs.length === 1 ? 'it' : 'them'}:`);
  for (const c of outputs) out.push(`- ${c.path}: ${c.state === 'modified' ? 'differs' : c.state === 'added' ? 'written by the generator, absent from the commit' : 'in the commit, not written by the generator'}`);
  if (other.length > 0) out.push(`regenerate: ${other.length} file${other.length === 1 ? '' : 's'} outside the declared outputs (${request.outputs.join(', ')}) that the generator changed:`);
  for (const c of other) out.push(`- ${c.path}: ${c.state}`);
  changes.slice(0, SHOWN_FILES).forEach((c) => {
    const lines = differenceLines(git, root, c);
    if (lines.length > 0) out.push('', `regenerate: difference of ${c.path} (- the commit, + the generator):`, ...lines);
  });
  if (changes.length > SHOWN_FILES) out.push('', `regenerate: ${changes.length - SHOWN_FILES} more changed files, named above, differences not shown`);
  out.push('', `regenerate: run ${JSON.stringify(request.argv)} from ${request.cwd} after changing the sources and commit what it writes, exactly as it writes it; never edit a generated file by hand.`);
  return out;
}

/** Puts the checkout back as the commit holds it: tracked changes checked out, new files removed. */
function restore(git: string, root: string, changes: readonly Change[]): void {
  const tracked = changes.filter((c) => c.state !== 'added').map((c) => c.path);
  if (tracked.length > 0) gitOut(git, root, ['checkout', 'HEAD', '--', ...tracked]);
  for (const c of changes.filter((x) => x.state === 'added')) rmSync(join(root, c.path), { force: true });
}

/** The check in the checkout at `root`, its report written through `write`; returns the exit code (see the header). */
export function runRegenerateCheck(git: string, root: string, request: RegenerateRequest, write: (line: string) => void): number {
  const dirty = statusChanges(git, root, request.outputs);
  if (dirty.length > 0) {
    write(`regenerate: the checkout at ${root} is not clean before the generator runs (${dirty.map((c) => c.path).join(', ')}); the check runs only in a clean checkout`);
    return 2;
  }
  const [program, ...args] = request.argv;
  if (program === undefined) throw new Error('a regenerate request with an empty argv'); // the plan reader requires non-empty
  write(`regenerate: running ${JSON.stringify(request.argv)} from ${request.cwd}`);
  const ran = spawnSync(program, args, { cwd: join(root, request.cwd), stdio: 'inherit', env: process.env });
  const changes = statusChanges(git, root, request.outputs);
  const report = changes.length === 0 ? [] : reportLines(git, root, request, changes);
  restore(git, root, changes);
  const failed = ran.error !== undefined ? `could not start: ${ran.error.message}` : ran.status !== 0 ? `exited ${ran.status ?? `on signal ${ran.signal}`}` : null;
  if (failed !== null) write(`regenerate: the generator ${failed}`);
  for (const line of report) write(line);
  if (failed === null && changes.length === 0) write(`regenerate: every output (${request.outputs.join(', ')}) is byte-identical to the commit`);
  return failed === null && changes.length === 0 ? 0 : 1;
}
