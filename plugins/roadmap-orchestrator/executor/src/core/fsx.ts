// Durable filesystem primitives. Every file the executor creates or replaces goes through this module,
// and every create or rename is followed by an fsync of the file and of its parent directory, so a
// power loss or SIGKILL leaves either the old bytes or the new bytes, never a torn or vanished entry.
//
// Everything is synchronous on purpose: the durability path blocks until the kernel has the bytes,
// and nothing else may act in between.
//
// Ported (not imported) from the 0.x shared disk protocol
// (v0.20.0 skills/roadmap-orchestrate/scripts/protocol.mjs):
// - `atomic()` became `durableWrite()`: same sibling temp file opened `wx`, fsync, rename over the
//   target. Added the parent-directory fsync 0.x lacked; dropped its implicit `mkdir -p` (callers
//   create directories explicitly with `durableMkdir`).
// - `exclusive()` became `exclusiveCreate()`: same `wx` open that refuses an existing path. 0.x used it
//   for a short operation lock with a callback; here it is the write-once file create, and locking is
//   the host lock's job.
// - `monotonic()` became a generic counter-map check: 0.x hard-coded checkpoint fields (spend, rounds,
//   consults); the rule kept is "a counter never decreases and never disappears".
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export class AlreadyExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`refusing to create ${path}: it already exists (write-once file)`);
    this.name = 'AlreadyExistsError';
    this.path = path;
  }
}

export class CounterRegressionError extends Error {
  readonly counter: string;
  constructor(counter: string, before: number, after: number | undefined) {
    super(`counter ${counter} regressed from ${before} to ${after === undefined ? 'absent' : after}`);
    this.name = 'CounterRegressionError';
    this.counter = counter;
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(fd, bytes, written, bytes.length - written);
  }
}

function toBytes(bytes: Uint8Array | string): Uint8Array {
  return typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
}

/** Replace (or create) `path` with `bytes`: temp sibling, fsync, rename, fsync the parent directory. */
export function durableWrite(path: string, bytes: Uint8Array | string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx');
  try {
    writeAll(fd, toBytes(bytes));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  renameSync(temp, path);
  fsyncPath(dirname(path));
}

/** Create `path` with `bytes`, refusing if it already exists. The file and its parent are fsynced. */
export function exclusiveCreate(path: string, bytes: Uint8Array | string): void {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AlreadyExistsError(path);
    throw error;
  }
  try {
    writeAll(fd, toBytes(bytes));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncPath(dirname(path));
}

/** `rename` with both parent directories fsynced, so neither the removal nor the arrival is lost. */
export function durableRename(from: string, to: string): void {
  renameSync(from, to);
  fsyncPath(dirname(to));
  if (dirname(from) !== dirname(to)) fsyncPath(dirname(from));
}

/**
 * Hard-link `from` to `to`, refusing (AlreadyExistsError) if `to` exists; the new entry's directory is
 * fsynced. This is the host lock's claim primitive: `link` is atomic and never replaces.
 */
export function durableLink(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AlreadyExistsError(to);
    throw error;
  }
  fsyncPath(dirname(to));
}

/**
 * Write-once and atomic: `bytes` go to a durable temp file beside `path`, which is then linked to `path`
 * (AlreadyExistsError if it exists) and removed. A reader sees no file or the whole file, never an empty or
 * partial one, as it could between `exclusiveCreate`'s open and its write.
 */
export function exclusivePublish(path: string, bytes: Uint8Array | string): void {
  const temp = `${path}.${process.pid}.tmp`;
  exclusiveCreate(temp, bytes);
  try {
    durableLink(temp, path);
  } finally {
    durableUnlink(temp);
  }
}

/** `unlink` with the parent directory fsynced, so the removal is not lost. */
export function durableUnlink(path: string): void {
  unlinkSync(path);
  fsyncPath(dirname(path));
}

/**
 * `mkdir -p` where every directory it creates is made durable by fsyncing its parent.
 * An existing directory is fine; this is how the executor lays out its state tree idempotently.
 */
export function durableMkdir(path: string): void {
  const target = resolve(path);
  const first = mkdirSync(target, { recursive: true });
  if (first === undefined) return;
  // `first` is the outermost directory created; fsync from its parent down to `target`'s parent.
  let dir = target;
  const parents: string[] = [];
  while (dir !== first) {
    dir = dirname(dir);
    parents.push(dir);
  }
  parents.push(dirname(first));
  for (const parent of parents.reverse()) fsyncPath(parent);
}

/** Write the full buffer to an open fd, then fsync. Returns only after fsync covers every byte. */
export function appendSync(fd: number, bytes: Uint8Array | string): void {
  writeAll(fd, toBytes(bytes));
  fsyncSync(fd);
}

/**
 * Canonical JSON: object keys sorted at every depth, two-space indent, trailing newline, so equal
 * values always produce equal bytes. Refuses values JSON cannot represent faithfully.
 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value, '$'), null, 2)}\n`;
}

function canonicalize(value: unknown, at: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${at} is a non-finite number (${value})`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, i) => canonicalize(item, `${at}[${i}]`));
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key], `${at}.${key}`);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: ${at} is not JSON-representable (${typeof value})`);
}

export function atomicJson(path: string, value: unknown): void {
  durableWrite(path, canonicalJson(value));
}

/** Parse a JSON file. The result is `unknown`: callers validate it into their typed record. */
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Refuse if any counter in `before` is absent from `after` or smaller there. */
export function monotonic(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): void {
  for (const [counter, value] of Object.entries(before)) {
    const next = after[counter];
    if (next === undefined || next < value) throw new CounterRegressionError(counter, value, next);
  }
}
