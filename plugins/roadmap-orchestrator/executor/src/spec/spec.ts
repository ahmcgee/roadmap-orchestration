import { git } from '../git/git.ts';
import { type SystemsMap, inUnitSystems } from '../input/systems.ts';
// A unit's spec.json: the run input the plan's `units[].spec` names, never a product-tree file. Reading
// goes through the frozen `specM1` validator; writing is canonical and durable, so the bytes of a written
// spec are a function of its value and the `spec.patch` op can predict its file hash before acting.
//
// The revision is the integer `rev` the file carries (SCHEMAS.md: `SpecRev` is an integer >= 1, bumped by
// exactly one per `spec.patch`). Content identity is the sha256 of the file's bytes, which the op records.
import { readFileSync } from 'node:fs';
import { type Sha256Hex, type UnitId, type SystemName, sha256 } from '../core/ids.ts';
import { canonicalJson as fileJson } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import { type SpecM1, specM1 } from '../core/records.ts';
import { type AbsPath, type RepoPath, type RepoPattern, matchesPattern, mayOverlap, repoPath } from '../core/values.ts';

export class SpecFileError extends Error {
  readonly path: AbsPath;
  constructor(path: AbsPath, detail: string) {
    super(`spec file ${path}: ${detail}`);
    this.name = 'SpecFileError';
    this.path = path;
  }
}

/** Parse and validate spec bytes read from `path` (the path only names the file in errors). */
export function parseSpec(bytes: Buffer, path: AbsPath): SpecM1 {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new SpecFileError(path, `not JSON: ${(error as Error).message}`);
  }
  return specM1(raw, 'spec');
}

export function loadSpec(path: AbsPath): SpecM1 {
  return parseSpec(readFileSync(path), path);
}

/** A spec's canonical bytes (sorted keys), indented for human readers: what the executor keeps for a spec it builds. */
export function specBytes(spec: SpecM1): Buffer {
  return Buffer.from(fileJson(spec), 'utf8');
}

export function bytesSha256(bytes: Buffer): Sha256Hex {
  return sha256(sha256Hex(bytes));
}

export function fileSha256(path: AbsPath): Sha256Hex {
  return bytesSha256(readFileSync(path));
}

/** Authoring guard: lane outputs cannot hide tracked source/tests of the unit's systems or repository protection.
 * Called only for touched units (all units at first start), never while reading an unchanged spec in force.
 * Only tracked paths an evidenceGlobs entry covers are classified: classifying every tracked path against a large
 * systems map is millions of glob matches per unit, enough to stall a start past its readiness watchdog.
 */
export function evidenceScopeConflicts(
  unit: UnitId, systems: readonly SystemName[], spec: SpecM1,
  context: Readonly<{ repo: AbsPath; at: string; map: SystemsMap | null; protectedPaths: readonly RepoPattern[] }>,
): readonly string[] {
  if (spec.lanes.every((lane) => lane.evidenceGlobs.length === 0)) return [];
  const tracked = git(context.repo, ['ls-tree', '-r', '--name-only', '-z', context.at]).split('\0').filter((p) => p !== '').map((p) => repoPath(p));
  const map = context.map;
  const own = (p: RepoPath): boolean => map !== null && inUnitSystems(map, systems, p);
  return spec.lanes.flatMap((lane) => lane.evidenceGlobs.flatMap((glob) => [
    ...tracked.filter((p) => matchesPattern(p, glob) && own(p)).map((p) => `tracked path \`${p}\` of the unit's systems`),
    ...context.protectedPaths.filter((p) => mayOverlap(glob, p)).map((p) => `protectedPaths entry \`${p}\``),
  ].map((covered) => `unit ${unit} lane ${lane.id}: evidenceGlobs entry \`${glob}\` covers ${covered}. evidenceGlobs declare `
    + `the files the lane's run writes (its outputs), which are never committed or merged: narrow the entry to lane outputs.`)));
}
