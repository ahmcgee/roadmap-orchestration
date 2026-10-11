// A unit's spec.json: the run input the plan's `units[].spec` names, never a product-tree file. Reading
// goes through the frozen `specM1` validator; writing is canonical and durable, so the bytes of a written
// spec are a function of its value and the `spec.patch` op can predict its file hash before acting.
//
// The revision is the integer `rev` the file carries (SCHEMAS.md: `SpecRev` is an integer >= 1, bumped by
// exactly one per `spec.patch`). Content identity is the sha256 of the file's bytes, which the op records.
import { readFileSync } from 'node:fs';
import { type Sha256Hex, type UnitId, sha256 } from '../core/ids.ts';
import { durableWrite, canonicalJson as fileJson } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import { type SpecM1, specM1 } from '../core/records.ts';
import { type AbsPath, type RepoPattern, matchesPattern, repoPath } from '../core/values.ts';

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

/** The exact bytes `writeSpec` puts on disk: canonical (sorted keys), indented for human readers. */
export function specBytes(spec: SpecM1): Buffer {
  return Buffer.from(fileJson(spec), 'utf8');
}

export function writeSpec(path: AbsPath, spec: SpecM1): void {
  durableWrite(path, specBytes(spec));
}

export function bytesSha256(bytes: Buffer): Sha256Hex {
  return sha256(sha256Hex(bytes));
}

export function fileSha256(path: AbsPath): Sha256Hex {
  return bytesSha256(readFileSync(path));
}

/** A glob character: a scope pattern without one names exactly one path (a file, or a directory and what it holds). */
const GLOB_CHAR = /[*?[{]/;

/**
 * Why a unit's lanes may not declare their `evidenceGlobs` (authoring time only: the classifier's spec rows, so every
 * apply, start, flow apply and checkpoint bundle; a fresh start (`settlePlan`); a plan-check redirect's patch
 * (src/pipeline/stages.ts `evidenceRefusal`); never a read of a spec already in force). Declared evidence is what a lane's run writes: salvage never
 * commits it and the transient check refuses it at the candidate. So an entry covering a pattern of the unit's
 * scope, a literal path the scope names (its own source or tests) or the very same pattern, leaves the unit's work
 * there unmergeable. One reason per lane, entry and scope pattern, over every lane, active or not (the transient
 * check reads them all). `scope`: the plan entry's and the spec's.
 */
export function evidenceScopeConflicts(unit: UnitId, scope: readonly RepoPattern[], spec: SpecM1): readonly string[] {
  const patterns = [...new Set(scope)].sort();
  return spec.lanes.flatMap((lane) => lane.evidenceGlobs.flatMap((glob) => patterns
    .filter((s) => s === glob || (!GLOB_CHAR.test(s) && matchesPattern(repoPath(s.replace(/\/+$/, '')), glob)))
    .map((s) => `unit ${unit} lane ${lane.id}: evidenceGlobs entry \`${glob}\` covers \`${s}\` of the unit's scope. evidenceGlobs declare `
      + `the files the lane's run writes (its outputs), which are never committed or merged, so the unit's own work there could never `
      + `reach integration: drop the entry, or narrow it to the lane's outputs (never source or tests)`)));
}
