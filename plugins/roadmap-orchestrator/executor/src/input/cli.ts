// The CLI surface, parsed into a closed Command union so step 13 wires a fixed set of commands. Pure:
// no git, no fs. Paths are returned as given; step 13 resolves them against the caller's cwd.
import { posix } from 'node:path';
import { type ArcId, type NeedsUserId, type ResourceName, arcId, needsUserId, resourceName, unitId } from '../core/ids.ts';
import type { PauseTarget, ResumeTarget } from '../core/records.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { type ProfileName, backend, profileName } from '../routing/types.ts';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** `profile: null` when `--profile` is absent, so `selectProfile` can let `.roadmap/config.json` choose. */
export type StartArgs = Readonly<{ repo: string; plan: string; profile: ProfileName | null }>;

/**
 * How a run command finds its run: through the host lock claim (the one live arc on this host), or
 * explicitly by repo and arc (run dir derived from the repo's git common dir), which also reaches a run
 * with no live owner.
 */
export type RunLocator = Readonly<{ type: 'host' }> | Readonly<{ type: 'explicit'; repo: string; arc: ArcId }>;

export type Command =
  | Readonly<{ command: 'version' }>
  | Readonly<{ command: 'start'; args: StartArgs }>
  | Readonly<{ command: 'status'; run: RunLocator }>
  | Readonly<{ command: 'watch'; run: RunLocator }>
  | Readonly<{ command: 'stop'; run: RunLocator }>
  | Readonly<{ command: 'pause'; target: PauseTarget; run: RunLocator }>
  | Readonly<{ command: 'ack'; id: NeedsUserId; choice: string | null; run: RunLocator }>
  | Readonly<{ command: 'resume'; target: ResumeTarget; run: RunLocator }>
  | Readonly<{ command: 'sweep'; resource: ResourceName | null; run: RunLocator }>;

type Parsed = Readonly<{ positionals: readonly string[]; flags: ReadonlyMap<string, string | true> }>;

/** `--name value` options and `--name` switches; each at most once; nothing outside `allowed`. */
function parseRest(argv: readonly string[], allowed: Readonly<Record<string, 'value' | 'switch'>>, command: string): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = allowed[name];
    if (kind === undefined) throw new CliError(`${command}: unknown option ${arg}`);
    if (flags.has(name)) throw new CliError(`${command}: ${arg} given twice`);
    if (kind === 'switch') {
      flags.set(name, true);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${command}: ${arg} needs a value`);
    flags.set(name, value);
    i++;
  }
  return { positionals, flags };
}

function value(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function positionals(p: Parsed, command: string, max: number): readonly string[] {
  if (p.positionals.length > max) throw new CliError(`${command}: unexpected argument ${JSON.stringify(p.positionals[max])}`);
  return p.positionals;
}

/** Wraps an id constructor so a malformed argument is a CliError naming the command. */
function arg<T>(command: string, what: string, read: (v: unknown, path?: string) => T, raw: string): T {
  try {
    return read(raw, `${command} ${what}`);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

const LOCATOR = { repo: 'value', arc: 'value' } as const;

function locator(p: Parsed, command: string): RunLocator {
  const repo = value(p, 'repo');
  const arc = value(p, 'arc');
  if (repo === undefined && arc === undefined) return { type: 'host' };
  if (repo === undefined || arc === undefined) throw new CliError(`${command}: --repo and --arc go together`);
  return { type: 'explicit', repo, arc: arg(command, '--arc', arcId, arc) };
}

export function parseStartArgs(argv: readonly string[]): StartArgs {
  const p = parseRest(argv, { repo: 'value', plan: 'value', profile: 'value' }, 'start');
  positionals(p, 'start', 0);
  const repo = value(p, 'repo');
  const plan = value(p, 'plan');
  if (repo === undefined) throw new CliError('start: --repo <path> is required');
  if (plan === undefined) throw new CliError('start: --plan <plan.json> is required');
  const profile = value(p, 'profile');
  return { repo, plan, profile: profile === undefined ? null : arg('start', '--profile', (v, path) => profileName(v, path ?? '--profile'), profile) };
}

export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  switch (command) {
    case '--version': {
      if (rest.length > 0) throw new CliError('--version takes no arguments');
      return { command: 'version' };
    }
    case 'start':
      return { command: 'start', args: parseStartArgs(rest) };
    case 'status':
    case 'watch':
    case 'stop': {
      const p = parseRest(rest, LOCATOR, command);
      positionals(p, command, 0);
      return { command, run: locator(p, command) };
    }
    case 'pause': {
      const p = parseRest(rest, { ...LOCATOR, all: 'switch' }, command);
      const [u] = positionals(p, command, 1);
      const all = p.flags.has('all');
      if ((u === undefined) === !all) throw new CliError('pause: give exactly one of <unit> or --all');
      const target: PauseTarget = u === undefined ? { type: 'all' } : { type: 'unit', unit: arg(command, '<unit>', unitId, u) };
      return { command, target, run: locator(p, command) };
    }
    case 'ack': {
      const p = parseRest(rest, { ...LOCATOR, choice: 'value' }, command);
      const [id] = positionals(p, command, 1);
      if (id === undefined) throw new CliError('ack: <needs-user-id> is required');
      return { command, id: arg(command, '<needs-user-id>', needsUserId, id), choice: value(p, 'choice') ?? null, run: locator(p, command) };
    }
    case 'resume': {
      const p = parseRest(rest, { ...LOCATOR, backend: 'value' }, command);
      const [u] = positionals(p, command, 1);
      const b = value(p, 'backend');
      if (u !== undefined && b !== undefined) throw new CliError('resume: give at most one of <unit> or --backend');
      let target: ResumeTarget = { type: 'all' };
      if (u !== undefined) target = { type: 'unit', unit: arg(command, '<unit>', unitId, u) };
      if (b !== undefined) target = { type: 'backend', backend: arg(command, '--backend', (v, path) => backend(v, path ?? '--backend'), b) };
      return { command, target, run: locator(p, command) };
    }
    case 'sweep': {
      const p = parseRest(rest, { ...LOCATOR, resource: 'value' }, command);
      positionals(p, command, 0);
      const r = value(p, 'resource');
      return { command, resource: r === undefined ? null : arg(command, '--resource', resourceName, r), run: locator(p, command) };
    }
    default:
      throw new CliError(`unknown command ${JSON.stringify(command ?? '')}; expected one of --version, start, status, watch, stop, pause, ack, resume, sweep`);
  }
}

/** The run dir: `<git common dir>/roadmap-runtime/<arc>`. The caller passes the absolute common dir. */
export function runDir(gitCommonDir: AbsPath, arc: ArcId): AbsPath {
  return absPath(posix.join(gitCommonDir, 'roadmap-runtime', arc));
}
