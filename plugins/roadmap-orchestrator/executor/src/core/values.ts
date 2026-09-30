// Branded scalar values that are not ids: paths, ref names, timestamps, host tokens. Same contract as
// ids.ts: one checking constructor per brand, SchemaError on a malformed value.
import { matchesGlob, posix } from 'node:path';
import { type Brand, SchemaError } from './validate.ts';

type Reader<T> = (value: unknown, path?: string) => T;

function checked<B extends string>(kind: B, form: string, ok: (s: string) => boolean): Reader<Brand<string, B>> {
  return (value, path = kind) => {
    if (typeof value !== 'string' || !ok(value)) throw new SchemaError(path, `${kind} (${form})`, value);
    return value as Brand<string, B>;
  };
}

/** Absolute, normalised POSIX path with no trailing slash (except `/`). */
export type AbsPath = Brand<string, 'AbsPath'>;
export const absPath = checked('AbsPath', 'absolute normalised path', (s) =>
  s.startsWith('/') && !s.includes('\0') && posix.normalize(s) === s && (s === '/' || !s.endsWith('/')));

function relativeOk(s: string): boolean {
  if (s === '.') return true;
  if (s.startsWith('/') || s.endsWith('/') || s.includes('\0')) return false;
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A path inside the product tree, relative to its root; `.` is the root itself. */
export type RepoPath = Brand<string, 'RepoPath'>;
export const repoPath = checked('RepoPath', 'relative path inside the repo, no . or .. segments', relativeOk);

/** A path relative to the directory holding plan.json (run inputs: specs, the rulings ledger). */
export type PlanPath = Brand<string, 'PlanPath'>;
export const planPath = checked('PlanPath', 'relative path under the plan directory, no . or .. segments', (s) => s !== '.' && relativeOk(s));

/** A git pathspec-style glob relative to the repo root (scope entries, evidence globs). */
export type RepoPattern = Brand<string, 'RepoPattern'>;
export const repoPattern = checked('RepoPattern', 'relative glob, no leading /, no .. segments', (s) =>
  s.length > 0 && !s.startsWith('/') && !s.includes('\0') && s.split('/').every((seg) => seg !== '..'));

/** `pattern` as a glob, or as a directory prefix (`src` and `src/` both cover `src/a/b`). */
export function matchesPattern(path: RepoPath, pattern: RepoPattern): boolean {
  const p = pattern.replace(/\/+$/, '');
  return path === p || path.startsWith(`${p}/`) || matchesGlob(path, p) || matchesGlob(path, `${p}/**`);
}

// git check-ref-format rules, applied per component.
function refComponentsOk(s: string): boolean {
  if (s.endsWith('/') || s.endsWith('.') || s.includes('..') || s.includes('@{') || s === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(s)) return false;
  return s.split('/').every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
}

/** A full ref name, `refs/...`. */
export type RefName = Brand<string, 'RefName'>;
export const refName = checked('RefName', 'refs/... valid under git check-ref-format', (s) => s.startsWith('refs/') && refComponentsOk(s));

/** A short branch name; its ref is `refs/heads/<name>`. */
export type BranchName = Brand<string, 'BranchName'>;
export const branchName = checked('BranchName', 'branch name valid under git check-ref-format', (s) => !s.startsWith('-') && refComponentsOk(s));

export function branchRef(name: BranchName): RefName {
  return refName(`refs/heads/${name}`);
}

/** UTC timestamp exactly as `Date.prototype.toISOString` prints it. */
export type IsoTime = Brand<string, 'IsoTime'>;
export const isoTime = checked('IsoTime', 'YYYY-MM-DDTHH:MM:SS.mmmZ', (s) => {
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString() === s;
});

export function isoTimeOf(date: Date): IsoTime {
  return isoTime(date.toISOString());
}

/** git's raw date form, `<unix seconds> <+|-HHMM>`, as used in commit identities. */
export type GitDate = Brand<string, 'GitDate'>;
export const gitDate = checked('GitDate', '<unix seconds> <+|-HHMM>', (s) => /^(0|[1-9][0-9]{0,11}) [+-][0-9]{4}$/.test(s));

/** `/proc/sys/kernel/random/boot_id`. */
export type BootId = Brand<string, 'BootId'>;
export const bootId = checked('BootId', 'lowercase uuid', (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s));

/** A host-lock claim nonce: 32 lowercase hex from a CSPRNG. */
export type Nonce = Brand<string, 'Nonce'>;
export const nonce = checked('Nonce', '32 lowercase hex', (s) => /^[0-9a-f]{32}$/.test(s));
