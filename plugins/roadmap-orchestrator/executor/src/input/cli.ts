// The CLI surface, parsed into a closed Command union so step 13 wires a fixed set of commands. Pure:
// no git, no fs. Paths are returned as given; step 13 resolves them against the caller's cwd.
import { posix } from 'node:path';
import {
  type ArcId, type DivergenceId, type EdgeId, type NeedsUserId, type PlanRev, type ResourceName, type UnitId, arcId, divergenceId, edgeId, needsUserId,
  planRev, resourceName, unitId,
} from '../core/ids.ts';
import { LENS_KIND_NAMES, type LensKindName, type PauseTarget, type ResumeTarget } from '../core/records.ts';
import { oneOf } from '../core/validate.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import { type ModelClass, type ProfileName, backend, modelClass, profileName } from '../routing/types.ts';

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * `profile: null` when `--profile` is absent, so `selectProfile` can let `.roadmap/config.json` choose.
 * `waitMs`: how long `start` waits for readiness (`--wait <ms>`), null for the default (START_WAIT_MS).
 */
export type StartArgs = Readonly<{ repo: string; plan: string; profile: ProfileName | null; waitMs: number | null }>;

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
  | Readonly<{ command: 'sweep'; resource: ResourceName | null; run: RunLocator }>
  /** Put the edited plan.json and specs in force; `dryRun` classifies them read-only and queues nothing. */
  | Readonly<{ command: 'apply'; expectRev: PlanRev | null; dryRun: boolean; run: RunLocator }>
  /** A contingent edge's condition is met, on the architect's evidence (M2). */
  | Readonly<{ command: 'resolve-edge'; edge: EdgeId; evidence: string; run: RunLocator }>
  /** Admission limited to these units (ascending, unique), or unlimited again (`--clear`: null) (M2). */
  | Readonly<{ command: 'run-only'; units: readonly UnitId[] | null; run: RunLocator }>
  /** M3: a ruling sidecar file (`roadmap/ruling-m3`), hashed and queued. */
  | Readonly<{ command: 'rule'; record: string; run: RunLocator }>
  /** M3 (H13): the compensating revision of one divergence. */
  | Readonly<{ command: 'reverse'; divergence: DivergenceId; run: RunLocator }>
  /** M3: an alternate implementer entry for a parked or preparing unit; `class` null keeps its routing. */
  | Readonly<{ command: 'steer'; unit: UnitId; brief: string; budgetMin: number; class: ModelClass | null; resume: boolean; run: RunLocator }>
  | Readonly<{ command: 'merge-in'; unit: UnitId; run: RunLocator }>
  /** M3: an audit of these lenses (`--lens a,b`, ascending), or of the arc's lens set (null). */
  | Readonly<{ command: 'audit'; lenses: readonly LensKindName[] | null; run: RunLocator }>
  | Readonly<{ command: 'close-admissions'; run: RunLocator }>
  /** M3 (A20, H5): prunes sealed arcs of `repo` and the host dir, keeping the last `keep` (null: the default). A CLI action, not a command. */
  | Readonly<{ command: 'gc'; repo: string; keep: number | null; dryRun: boolean }>;

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
  const p = parseRest(argv, { repo: 'value', plan: 'value', profile: 'value', wait: 'value' }, 'start');
  positionals(p, 'start', 0);
  const repo = value(p, 'repo');
  const plan = value(p, 'plan');
  if (repo === undefined) throw new CliError('start: --repo <path> is required');
  if (plan === undefined) throw new CliError('start: --plan <plan.json> is required');
  const profile = value(p, 'profile');
  const wait = value(p, 'wait');
  return {
    repo, plan,
    profile: profile === undefined ? null : arg('start', '--profile', (v, path) => profileName(v, path ?? '--profile'), profile),
    waitMs: wait === undefined ? null : waitMs(wait),
  };
}

/** `--wait <ms>`: a positive integer of milliseconds, digits only. */
function waitMs(raw: string): number {
  return positiveInt('start', '--wait', raw, 'milliseconds');
}

/** A positive integer option, digits only. */
function positiveInt(command: string, option: string, raw: string, what: string): number {
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new CliError(`${command}: ${option} takes a positive integer of ${what}, got ${JSON.stringify(raw)}`);
  return n;
}

/** Exactly one positional argument, named `what` in the error. */
function onePositional(p: Parsed, command: string, what: string): string {
  const [v] = positionals(p, command, 1);
  if (v === undefined) throw new CliError(`${command}: ${what} is required`);
  return v;
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
    case 'apply': {
      const p = parseRest(rest, { ...LOCATOR, 'expect-rev': 'value', 'dry-run': 'switch' }, command);
      positionals(p, command, 0);
      const rev = value(p, 'expect-rev');
      if (rev !== undefined && !/^[1-9][0-9]*$/.test(rev)) throw new CliError(`apply: --expect-rev takes a plan revision (a positive integer), got ${JSON.stringify(rev)}`);
      return { command, expectRev: rev === undefined ? null : planRev(Number(rev)), dryRun: p.flags.has('dry-run'), run: locator(p, command) };
    }
    case 'resolve-edge': {
      const p = parseRest(rest, { ...LOCATOR, evidence: 'value' }, command);
      const [edge] = positionals(p, command, 1);
      if (edge === undefined) throw new CliError('resolve-edge: <edge> is required');
      const evidence = value(p, 'evidence');
      if (evidence === undefined || evidence.trim() === '') throw new CliError('resolve-edge: --evidence <text> is required');
      return { command, edge: arg(command, '<edge>', edgeId, edge), evidence, run: locator(p, command) };
    }
    case 'run-only': {
      const p = parseRest(rest, { ...LOCATOR, clear: 'switch' }, command);
      const clear = p.flags.has('clear');
      if ((p.positionals.length === 0) === !clear) throw new CliError('run-only: give either <unit>... or --clear');
      const units = [...new Set(p.positionals.map((u) => arg(command, '<unit>', unitId, u)))].sort();
      return { command, units: clear ? null : units, run: locator(p, command) };
    }
    case 'rule': {
      const p = parseRest(rest, LOCATOR, command);
      return { command, record: onePositional(p, command, '<record.json>'), run: locator(p, command) };
    }
    case 'reverse': {
      const p = parseRest(rest, LOCATOR, command);
      return { command, divergence: arg(command, '<D-n>', divergenceId, onePositional(p, command, '<D-n>')), run: locator(p, command) };
    }
    case 'steer': {
      const p = parseRest(rest, { ...LOCATOR, brief: 'value', budget: 'value', class: 'value', resume: 'switch' }, command);
      const u = onePositional(p, command, '<unit>');
      const brief = value(p, 'brief');
      const budget = value(p, 'budget');
      if (brief === undefined) throw new CliError('steer: --brief <file> is required');
      if (budget === undefined) throw new CliError('steer: --budget <minutes> is required');
      const c = value(p, 'class');
      return {
        command, unit: arg(command, '<unit>', unitId, u), brief, budgetMin: positiveInt(command, '--budget', budget, 'minutes'),
        class: c === undefined ? null : arg(command, '--class', (v, path) => modelClass(v, path ?? '--class'), c), resume: p.flags.has('resume'), run: locator(p, command),
      };
    }
    case 'merge-in': {
      const p = parseRest(rest, LOCATOR, command);
      return { command, unit: arg(command, '<unit>', unitId, onePositional(p, command, '<unit>')), run: locator(p, command) };
    }
    case 'audit': {
      const p = parseRest(rest, { ...LOCATOR, lens: 'value' }, command);
      positionals(p, command, 0);
      const raw = value(p, 'lens');
      const lenses = raw === undefined ? null : [...new Set(raw.split(',').map((l) => arg(command, '--lens', (v, path) => oneOf(LENS_KIND_NAMES)(v, path ?? '--lens'), l)))].sort();
      return { command, lenses, run: locator(p, command) };
    }
    case 'close-admissions': {
      const p = parseRest(rest, LOCATOR, command);
      positionals(p, command, 0);
      return { command, run: locator(p, command) };
    }
    case 'gc': {
      const p = parseRest(rest, { repo: 'value', keep: 'value', 'dry-run': 'switch' }, command);
      positionals(p, command, 0);
      const repo = value(p, 'repo');
      if (repo === undefined) throw new CliError('gc: --repo <path> is required');
      const keep = value(p, 'keep');
      return { command, repo, keep: keep === undefined ? null : positiveInt(command, '--keep', keep, 'arcs'), dryRun: p.flags.has('dry-run') };
    }
    default:
      throw new CliError(
        `unknown command ${JSON.stringify(command ?? '')}; expected one of --version, start, status, watch, stop, pause, ack, resume, sweep, apply, resolve-edge, run-only, rule, reverse, steer, merge-in, audit, close-admissions, gc`,
      );
  }
}

/** The run dir: `<git common dir>/roadmap-runtime/<arc>`. The caller passes the absolute common dir. */
export function runDir(gitCommonDir: AbsPath, arc: ArcId): AbsPath {
  return absPath(posix.join(gitCommonDir, 'roadmap-runtime', arc));
}
