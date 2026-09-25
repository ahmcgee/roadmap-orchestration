// A unit's spec.json: the run input the plan's `units[].spec` names, never a product-tree file. Reading
// goes through the frozen `specM1` validator; writing is canonical and durable, so the bytes of a written
// spec are a function of its value and the `spec.patch` op can predict its file hash before acting.
//
// The revision is the integer `rev` the file carries (SCHEMAS.md: `SpecRev` is an integer >= 1, bumped by
// exactly one per `spec.patch`). Content identity is the sha256 of the file's bytes, which the op records.
import { readFileSync } from 'node:fs';
import { type Sha256Hex, sha256 } from '../core/ids.ts';
import { durableWrite, canonicalJson as fileJson } from '../core/fsx.ts';
import { sha256Hex } from '../core/json.ts';
import { type SpecM1, specM1 } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';

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
