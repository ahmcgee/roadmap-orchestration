// Hand-written validation primitives. Every boundary reader takes `unknown` and either returns the typed
// value or throws a SchemaError naming the field path and the offending value. A reader is a plain
// function `(value, path) => T`, so readers compose without a library.
import { legacyIdOrder } from './upgrade.ts';
import { SCHEMA_VERSION, type SchemaVersion } from './version.ts';

declare const brand: unique symbol;
/** A nominal subtype: a `Brand<string, 'Sha'>` is a string only the Sha constructor can produce. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Read<T> = (value: unknown, path: string) => T;

export class SchemaError extends Error {
  readonly field: string;
  readonly value: unknown;
  constructor(field: string, expected: string, value: unknown) {
    super(`${field}: expected ${expected}, got ${show(value)}`);
    this.name = 'SchemaError';
    this.field = field;
    this.value = value;
  }
}

function show(value: unknown): string {
  if (value === undefined) return 'nothing (field missing)';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Reads the fields of one JSON object. `end()` rejects any key no reader asked for. */
export class Fields {
  readonly path: string;
  readonly #obj: Readonly<Record<string, unknown>>;
  readonly #read = new Set<string>();

  constructor(value: unknown, path: string) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SchemaError(path, 'an object', value);
    }
    this.#obj = value as Readonly<Record<string, unknown>>;
    this.path = path;
  }

  get<T>(key: string, read: Read<T>): T {
    this.#read.add(key);
    return read(this.#obj[key], `${this.path}.${key}`);
  }

  /** For fields the schema marks optional: absent → undefined; present → read. */
  optional<T>(key: string, read: Read<T>): T | undefined {
    this.#read.add(key);
    if (!Object.hasOwn(this.#obj, key)) return undefined;
    return read(this.#obj[key], `${this.path}.${key}`);
  }

  end(): void {
    for (const key of Object.keys(this.#obj)) {
      if (!this.#read.has(key)) throw new SchemaError(`${this.path}.${key}`, 'no such field', this.#obj[key]);
    }
  }
}

export const str: Read<string> = (value, path) => {
  if (typeof value !== 'string' || value.length === 0) throw new SchemaError(path, 'a non-empty string', value);
  return value;
};

/** A string that may be empty (commit messages, free text the schema allows to be blank). */
export const text: Read<string> = (value, path) => {
  if (typeof value !== 'string') throw new SchemaError(path, 'a string', value);
  return value;
};

export const bool: Read<boolean> = (value, path) => {
  if (typeof value !== 'boolean') throw new SchemaError(path, 'a boolean', value);
  return value;
};

export function int(min: number, max: number = Number.MAX_SAFE_INTEGER): Read<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new SchemaError(path, `an integer in [${min}, ${max}]`, value);
    }
    return value;
  };
}

export const nat = int(0);
export const positive = int(1);

export function literal<const T extends string | number | boolean | null>(expected: T): Read<T> {
  return (value, path) => {
    if (value !== expected) throw new SchemaError(path, JSON.stringify(expected), value);
    return expected;
  };
}

export function oneOf<const T extends readonly string[]>(values: T): Read<T[number]> {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      throw new SchemaError(path, `one of ${values.join(' | ')}`, value);
    }
    return value as T[number];
  };
}

export function nullable<T>(read: Read<T>): Read<T | null> {
  return (value, path) => (value === null ? null : read(value, path));
}

export function arrayOf<T>(item: Read<T>, opts: { readonly nonEmpty?: boolean } = {}): Read<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) throw new SchemaError(path, 'an array', value);
    if (opts.nonEmpty === true && value.length === 0) throw new SchemaError(path, 'a non-empty array', value);
    return value.map((v, i) => item(v, `${path}[${i}]`));
  };
}

/**
 * An array whose elements are strictly ascending by `key` (sorted and unique), so equal sets serialise equally; `order`
 * says what the order is in the error. `legacyKey` (scaffolding, numbered-id lists only: `idsAscending` in ids.ts): a
 * list strictly ascending by it instead reads as written, with a warning (`legacyIdOrder`).
 */
export function sortedBy<T>(
  item: Read<T>, key: (t: T) => string, opts: Readonly<{ nonEmpty?: boolean; order?: string; legacyKey?: (t: T) => string }> = {},
): Read<readonly T[]> {
  const read = arrayOf(item, opts.nonEmpty === true ? { nonEmpty: true } : {});
  return (value, path) => {
    const out = read(value, path);
    const bad = firstUnordered(out, key);
    if (bad === null) return out;
    if (opts.legacyKey !== undefined && firstUnordered(out, opts.legacyKey) === null) {
      legacyIdOrder(path);
      return out;
    }
    throw new SchemaError(`${path}[${bad}]`, `entries strictly ascending${opts.order === undefined ? '' : ` ${opts.order}`} (sorted, no duplicates)`, value);
  };
}

/** The index of the first element not strictly above its predecessor by `key`, or null. */
function firstUnordered<T>(items: readonly T[], key: (t: T) => string): number | null {
  for (let i = 1; i < items.length; i++) if (!(key(items[i - 1] as T) < key(items[i] as T))) return i;
  return null;
}

/**
 * A judgment answer's set: an array without duplicates (`key`), in any order, returned sorted by `compare`. The model's
 * order never decides validity; the records built from the answer get the canonical order their readers require.
 */
export function answerSet<T>(item: Read<T>, key: (t: T) => string, compare: (a: T, b: T) => number, opts: { readonly nonEmpty?: boolean } = {}): Read<readonly T[]> {
  const read = arrayOf(item, opts);
  return (value, path) => {
    const out = read(value, path);
    assertUnique(out, key, path);
    return [...out].sort(compare);
  };
}

/** Rejects duplicate keys among already-read items; `path` names the array. */
export function assertUnique<T>(items: readonly T[], key: (t: T) => string, path: string): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) throw new SchemaError(`${path}[${i}]`, 'a unique id', k);
    seen.add(k);
  });
}

/** A JSON object of string → string (environment blocks). Keys must be environment variable names. */
export const stringMap: Read<Readonly<Record<string, string>>> = (value, path) => {
  const f = new Fields(value, path);
  const out: Record<string, string> = {};
  for (const key of Object.keys(value as object)) {
    envName(key, `${path}.${key}`);
    out[key] = f.get(key, text);
  }
  f.end();
  return out;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const envName: Read<string> = (value, path) => {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) throw new SchemaError(path, 'an environment variable name', value);
  return value;
};

export const version: Read<SchemaVersion> = literal(SCHEMA_VERSION);

/** Reads `value` as an object and hands its fields to `build`, then rejects unknown keys. */
export function object<T>(build: (f: Fields) => T): Read<T> {
  return (value, path) => {
    const f = new Fields(value, path);
    const out = build(f);
    f.end();
    return out;
  };
}

/** Dispatches on a string discriminator field, then reads the whole object with the chosen reader. */
export function tagged<const K extends string, T>(field: string, readers: { readonly [P in K]: Read<T> }): Read<T> {
  const tags = Object.keys(readers) as K[];
  return (value, path) => {
    const tag = new Fields(value, path).get(field, oneOf(tags));
    return readers[tag](value, path);
  };
}
