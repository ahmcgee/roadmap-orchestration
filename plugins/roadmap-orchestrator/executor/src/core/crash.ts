// The executor's single test seam. Production code calls `crashPoint(label)` at every boundary a crash
// test needs to hit (journal writes, runner, host and git operations). With no trigger configured it
// does nothing.
//
// A test configures a trigger by setting ROADMAP_TEST_CRASH to the absolute path of a JSON file
// `{label, occurrence, unit?}`. When this process reaches `label` for the `occurrence`-th time (1-based,
// counted per process, per label), it renames the trigger to `<path>.fired` and SIGKILLs itself. With
// `unit` (M2, G8: the plan's `<label>@<unit>:<n>`), only the calls that pass that unit count, so a scenario
// with concurrent units crashes the op of the unit it names; call sites pass the unit when they have one. The
// rename happens first so a restarted process with the same environment never fires again; a missing
// trigger file next to an existing `.fired` therefore means "already fired", while a missing trigger
// with no `.fired` is a misconfigured test and fails loudly.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { UnitId } from './ids.ts';

const ENV = 'ROADMAP_TEST_CRASH';

type Trigger =
  | { readonly kind: 'none' }
  | { readonly kind: 'fired' }
  | { readonly kind: 'armed'; readonly path: string; readonly label: string; readonly unit: string | null; readonly occurrence: number };

let trigger: Trigger | undefined;
const reached = new Map<string, number>();

/** The trigger path from the environment, for recording in launch.json.test.crash. */
export function crashTriggerFromEnv(): string | undefined {
  return process.env[ENV];
}

function loadTrigger(): Trigger {
  const path = crashTriggerFromEnv();
  if (path === undefined) return { kind: 'none' };
  if (!isAbsolute(path)) throw new Error(`${ENV} must be an absolute path, got ${JSON.stringify(path)}`);
  if (!existsSync(path)) {
    if (existsSync(`${path}.fired`)) return { kind: 'fired' };
    throw new Error(`${ENV} names ${path}, which does not exist (and has no .fired sibling)`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`crash trigger ${path}: not an object`);
  const { label, occurrence, unit } = raw as { label?: unknown; occurrence?: unknown; unit?: unknown };
  if (typeof label !== 'string' || label === '') {
    throw new Error(`crash trigger ${path}: label must be a non-empty string, got ${JSON.stringify(label)}`);
  }
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1) {
    throw new Error(`crash trigger ${path}: occurrence must be an integer >= 1, got ${JSON.stringify(occurrence)}`);
  }
  if (unit !== undefined && (typeof unit !== 'string' || unit === '')) {
    throw new Error(`crash trigger ${path}: unit, when present, must be a non-empty string, got ${JSON.stringify(unit)}`);
  }
  return { kind: 'armed', path, label, unit: unit ?? null, occurrence };
}

/** `unit`: the unit whose op reaches this label, when the call site has one (G8). */
export function crashPoint(label: string, unit?: UnitId): void {
  trigger ??= loadTrigger();
  if (trigger.kind !== 'armed' || trigger.label !== label) return;
  if (trigger.unit !== null && trigger.unit !== unit) return;
  const count = (reached.get(label) ?? 0) + 1;
  reached.set(label, count);
  if (count !== trigger.occurrence) return;
  renameSync(trigger.path, `${trigger.path}.fired`);
  process.kill(process.pid, 'SIGKILL');
}
