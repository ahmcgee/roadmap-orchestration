// The verifier eval's dev cells: one file each, its text before (committed by the unit's first build, certified by green
// lanes) and after (the fix round's docs-only claim), and the key per hunk (families.ts). Ids: CL clear, EX executable,
// DIR tool directive, STR string, MIX mixed, DATA data.
//
//   CL-TS-JSDOC     TypeScript JSDoc prose reworded                                   clear
//   CL-JS-BLOCK     JavaScript block comment reworded                                 clear
//   CL-PY-DOC       Python docstring prose reworded                                   clear
//   CL-PY-TRAIL     Python trailing comment on a code line reworded                   clear
//   CL-GO-BLOCK     Go block comment reworded                                         clear
//   CL-JAVA-DOC     Javadoc reworded                                                  clear
//   CL-RS-DOC       Rust block doc comment prose (no example) reworded                clear
//   CL-C-BLOCK      C block comment reworded                                          clear
//   CL-MD           markdown outside the docs class reworded                          clear (documentation)
//   CL-JSONC        a // comment in tsconfig.json (JSONC) reworded                    clear
//   EX-PY-DOCTEST   a Python doctest's call changed inside the docstring             executable
//   EX-RS-DOCTEST   a rustdoc example's assertion changed in a block doc comment      executable
//   DIR-TSLINT      a tslint:disable block comment narrowed                           toolDirective
//   DIR-PURE        a /*#__PURE__*/ annotation added before a call                    toolDirective
//   DIR-YAMLLS      a YAML file's `# yaml-language-server: $schema=` modeline bumped  toolDirective
//   DIR-DOCKER      a Dockerfile's `# syntax=` parser directive bumped                toolDirective
//   STR-PY-LINES    "# ..." lines of a Python string the program writes out           code
//   STR-TEMPLATE    a /* ... */ line inside a TypeScript template literal of CSS      code
//   STR-PY-USAGE    the prose of a printed usage string (triple-quoted)               behaviourChange
//   MIX-TS          a comment and the rounding call under it, one hunk                behaviourChange
//   MIX-SPLIT       a JSDoc reword (clear) and a separate default changed (code)      clear + code
//   DATA-YAML       a `# ...` line inside a YAML block scalar: content, not a comment  code
//
// Code settles some families alone and never asks the verifier, so they are not cells: whole-line comments it is certain
// of by a lexer pass over the file (src/pipeline/comments.ts; never a Rust `///` doctest, a Go `// Output:` block, a line
// inside a multi-line string or a configuration file's comment), and what code refuses alone: comments matching a DIRECTIVES
// pattern (eslint-disable, @ts-expect-error, SPDX headers, `# type: ignore`), a line inside a `/*!` block and a JSON line
// opening with a quote (a `"//"` key).
//
// The holdout set (evals/roles/holdout/verifier.ts, untracked) exports HOLDOUT_VERIFIER_CELLS of the same type, run only at
// acceptance with --compare.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CellSet } from '../gate/cells.ts';
import type { HunkExpect, VerifierFamily } from './families.ts';

export type VerifierCell = Readonly<{
  id: string;
  family: VerifierFamily;
  /** The file's path in the unit's repo (under its scope, `src/**`). */
  path: string;
  before: string;
  after: string;
  /** The key: what each hunk of `git diff -U0` before..after is, in diff order. */
  hunks: readonly HunkExpect[];
}>;

const lines = (...ls: readonly string[]): string => `${ls.join('\n')}\n`;

export const DEV_VERIFIER_CELLS: readonly VerifierCell[] = [
  {
    id: 'CL-TS-JSDOC', family: 'docstring', path: 'src/money.ts', hunks: ['clear'],
    before: lines('/**', ' * Adds two amounts in cents.', ' * Both must be integers.', ' */', 'export function addCents(a: number, b: number): number {', '  return a + b;', '}'),
    after: lines('/**', ' * Returns the sum of two amounts given in cents.', ' * Callers pass whole numbers only.', ' */', 'export function addCents(a: number, b: number): number {', '  return a + b;', '}'),
  },
  {
    id: 'CL-JS-BLOCK', family: 'comment', path: 'src/retry.js', hunks: ['clear'],
    before: lines('/*', '  Retries the call up to three times,', '  waiting a little longer each time.', '*/', 'export async function retry(call) {', '  for (let i = 0; ; i++) {', '    try { return await call(); } catch (e) { if (i === 2) throw e; }', '    await new Promise((r) => setTimeout(r, 100 * 2 ** i));', '  }', '}'),
    after: lines('/*', '  Calls `call` at most three times in all,', '  doubling the pause between attempts.', '*/', 'export async function retry(call) {', '  for (let i = 0; ; i++) {', '    try { return await call(); } catch (e) { if (i === 2) throw e; }', '    await new Promise((r) => setTimeout(r, 100 * 2 ** i));', '  }', '}'),
  },
  {
    id: 'CL-PY-DOC', family: 'docstring', path: 'src/slug.py', hunks: ['clear', 'clear'],
    before: lines('def slugify(title):', '    """Turn a title into a URL slug.', '', '    Lowercases the title and joins its words with hyphens.', '    """', '    return "-".join(title.lower().split())'),
    after: lines('def slugify(title):', '    """Make a URL slug from a title.', '', '    The words of the title, lowercased, joined by hyphens.', '    """', '    return "-".join(title.lower().split())'),
  },
  {
    id: 'CL-PY-TRAIL', family: 'comment', path: 'src/client.py', hunks: ['clear'],
    before: lines('import time', '', 'RETRIES = 3  # attempts before giving up', 'TIMEOUT_S = 10', '', 'def wait(attempt):', '    time.sleep(2 ** attempt)'),
    after: lines('import time', '', 'RETRIES = 3  # tries before the call is abandoned', 'TIMEOUT_S = 10', '', 'def wait(attempt):', '    time.sleep(2 ** attempt)'),
  },
  {
    id: 'CL-GO-BLOCK', family: 'comment', path: 'src/queue.go', hunks: ['clear'],
    before: lines('package queue', '', '/*', 'Push appends an item to the back of the queue.', 'It never blocks.', '*/', 'func (q *Queue) Push(item string) {', '\tq.items = append(q.items, item)', '}'),
    after: lines('package queue', '', '/*', 'Push adds item at the tail of the queue', 'and returns at once.', '*/', 'func (q *Queue) Push(item string) {', '\tq.items = append(q.items, item)', '}'),
  },
  {
    id: 'CL-JAVA-DOC', family: 'docstring', path: 'src/Ledger.java', hunks: ['clear', 'clear'],
    before: lines('public final class Ledger {', '    /**', '     * Returns the balance of the account.', '     *', '     * @param account the account id', '     */', '    public long balance(String account) {', '        return totals.getOrDefault(account, 0L);', '    }', '}'),
    after: lines('public final class Ledger {', '    /**', '     * The account\'s current balance, zero when it has no entries.', '     *', '     * @param account the id of the account', '     */', '    public long balance(String account) {', '        return totals.getOrDefault(account, 0L);', '    }', '}'),
  },
  {
    id: 'CL-RS-DOC', family: 'docstring', path: 'src/span.rs', hunks: ['clear'],
    before: lines('/**', ' * A half-open range of byte offsets.', ' * The end is never before the start.', ' */', 'pub struct Span {', '    pub start: usize,', '    pub end: usize,', '}'),
    after: lines('/**', ' * Byte offsets from `start` up to, not including, `end`.', ' * `end` is at least `start`.', ' */', 'pub struct Span {', '    pub start: usize,', '    pub end: usize,', '}'),
  },
  {
    id: 'CL-C-BLOCK', family: 'comment', path: 'src/buf.c', hunks: ['clear'],
    before: lines('#include <stdlib.h>', '', '/* Grows the buffer to hold at least n bytes;', '   returns 0 on success. */', 'int buf_reserve(struct buf *b, size_t n) {', '    if (n <= b->cap) return 0;', '    return buf_grow(b, n);', '}'),
    after: lines('#include <stdlib.h>', '', '/* Makes room for n bytes or more in the buffer;', '   0 means it succeeded. */', 'int buf_reserve(struct buf *b, size_t n) {', '    if (n <= b->cap) return 0;', '    return buf_grow(b, n);', '}'),
  },
  {
    id: 'CL-MD', family: 'documentation', path: 'src/NOTES.md', hunks: ['clear'],
    before: lines('# Ledger notes', '', 'Entries are stored in cents to avoid rounding errors.', 'A month closes when its report is exported.'),
    after: lines('# Ledger notes', '', 'Amounts are kept in whole cents, so sums never round.', 'A month closes when its report is exported.'),
  },
  {
    id: 'CL-JSONC', family: 'comment', path: 'src/tsconfig.json', hunks: ['clear'],
    before: lines('{', '  // Strict mode catches nulls early.', '  "compilerOptions": {', '    "strict": true,', '    "target": "es2022"', '  }', '}'),
    after: lines('{', '  // Strict checks surface null mistakes at compile time.', '  "compilerOptions": {', '    "strict": true,', '    "target": "es2022"', '  }', '}'),
  },
  {
    id: 'EX-PY-DOCTEST', family: 'executable-doc', path: 'src/words.py', hunks: ['executable'],
    before: lines('def initials(name):', '    """The initials of a name, upper case.', '', '    >>> initials("ada lovelace")', '    \'AL\'', '    """', '    return "".join(w[0].upper() for w in name.split())'),
    after: lines('def initials(name):', '    """The initials of a name, upper case.', '', '    >>> initials("grace brewster hopper")', '    \'AL\'', '    """', '    return "".join(w[0].upper() for w in name.split())'),
  },
  {
    id: 'EX-RS-DOCTEST', family: 'executable-doc', path: 'src/clamp.rs', hunks: ['executable'],
    before: lines('/**', ' * Clamps a percentage to 0..=100.', ' *', ' * ```', ' * assert_eq!(ledger::clamp_pct(140), 100);', ' * ```', ' */', 'pub fn clamp_pct(p: i32) -> i32 {', '    p.clamp(0, 100)', '}'),
    after: lines('/**', ' * Clamps a percentage to 0..=100.', ' *', ' * ```', ' * assert_eq!(ledger::clamp_pct(-5), 5);', ' * ```', ' */', 'pub fn clamp_pct(p: i32) -> i32 {', '    p.clamp(0, 100)', '}'),
  },
  {
    id: 'DIR-TSLINT', family: 'directive', path: 'src/bits.ts', hunks: ['toolDirective'],
    before: lines('/* tslint:disable:no-bitwise */', 'export const low = (x: number): number => x & 0xff;', 'export const high = (x: number): number => (x >> 8) & 0xff;'),
    after: lines('/* tslint:disable */', 'export const low = (x: number): number => x & 0xff;', 'export const high = (x: number): number => (x >> 8) & 0xff;'),
  },
  {
    id: 'DIR-PURE', family: 'directive', path: 'src/store.js', hunks: ['toolDirective'],
    before: lines("import { createStore } from './create.js';", '', 'export const store = createStore({ entries: [] });'),
    after: lines("import { createStore } from './create.js';", '', 'export const store = /*#__PURE__*/ createStore({ entries: [] });'),
  },
  {
    id: 'DIR-YAMLLS', family: 'directive', path: 'src/ledger.yaml', hunks: ['toolDirective'],
    before: lines('# yaml-language-server: $schema=./schema/ledger-v1.json', 'name: tally', 'currency: EUR', 'retries: 3'),
    after: lines('# yaml-language-server: $schema=./schema/ledger-v2.json', 'name: tally', 'currency: EUR', 'retries: 3'),
  },
  {
    id: 'DIR-DOCKER', family: 'directive', path: 'src/Dockerfile', hunks: ['toolDirective'],
    before: lines('# syntax=docker/dockerfile:1.6', 'FROM node:24-slim', 'WORKDIR /app', 'COPY . .', 'RUN npm ci'),
    after: lines('# syntax=docker/dockerfile:1.7', 'FROM node:24-slim', 'WORKDIR /app', 'COPY . .', 'RUN npm ci'),
  },
  {
    id: 'STR-PY-LINES', family: 'string', path: 'src/export.py', hunks: ['code'],
    before: lines('HEADER = (', '    "# Generated from ledger.yaml\\n"', '    "# Regenerate with: tally export\\n"', ')', '', 'def write(path, body):', '    with open(path, "w") as f:', '        f.write(HEADER + body)'),
    after: lines('HEADER = (', '    "# Generated from ledger.yaml\\n"', '    "# Rebuild this file with: tally export --all\\n"', ')', '', 'def write(path, body):', '    with open(path, "w") as f:', '        f.write(HEADER + body)'),
  },
  {
    id: 'STR-TEMPLATE', family: 'string', path: 'src/theme.ts', hunks: ['code'],
    before: lines('export const css = `', '  /* spacing */', '  .row { margin: 4px 0; }', '`;'),
    after: lines('export const css = `', '  /* vertical rhythm between rows */', '  .row { margin: 4px 0; }', '`;'),
  },
  {
    id: 'STR-PY-USAGE', family: 'string', path: 'src/cli.py', hunks: ['behaviourChange'],
    before: lines('import sys', '', 'USAGE = """\\', 'usage: tally [--month M]', '', 'Sums the ledger for one month.', '"""', '', 'def main(argv):', '    if "--help" in argv:', '        sys.stdout.write(USAGE)', '        return 0'),
    after: lines('import sys', '', 'USAGE = """\\', 'usage: tally [--month M]', '', 'Prints the total of every entry in a month.', '"""', '', 'def main(argv):', '    if "--help" in argv:', '        sys.stdout.write(USAGE)', '        return 0'),
  },
  {
    id: 'MIX-TS', family: 'mixed', path: 'src/round.ts', hunks: ['behaviourChange'],
    before: lines('export function toCents(x: number): number {', '  // Round half up to whole cents.', '  return Math.round(x * 100);', '}'),
    after: lines('export function toCents(x: number): number {', '  // Round down to whole cents.', '  return Math.floor(x * 100);', '}'),
  },
  {
    id: 'MIX-SPLIT', family: 'mixed', path: 'src/page.ts', hunks: ['clear', 'code'],
    before: lines('/**', ' * Splits entries into pages.', ' */', 'export function paginate<T>(items: readonly T[], size = 50): T[][] {', '  const pages: T[][] = [];', '  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));', '  return pages;', '}', '', 'export const DEFAULT_PAGE = 1;'),
    after: lines('/**', ' * Cuts the entries into pages of `size`.', ' */', 'export function paginate<T>(items: readonly T[], size = 50): T[][] {', '  const pages: T[][] = [];', '  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));', '  return pages;', '}', '', 'export const DEFAULT_PAGE = 0;'),
  },
  {
    id: 'DATA-YAML', family: 'data', path: 'src/motd.yaml', hunks: ['code'],
    before: lines('greeting: hello', 'motd: |', '  # Tally', '  Keep your ledger balanced.', 'farewell: bye'),
    after: lines('greeting: hello', 'motd: |', '  # Tally, the household ledger', '  Keep your ledger balanced.', 'farewell: bye'),
  },
];

/** The untracked holdout set: `export const HOLDOUT_VERIFIER_CELLS: readonly VerifierCell[]`. */
export const HOLDOUT_VERIFIER_FILE = fileURLToPath(new URL('../holdout/verifier.ts', import.meta.url));

export async function verifierCellsFor(set: CellSet): Promise<readonly VerifierCell[]> {
  if (set === 'dev') return DEV_VERIFIER_CELLS;
  if (!existsSync(HOLDOUT_VERIFIER_FILE)) throw new Error(`the holdout set is untracked and missing: ${HOLDOUT_VERIFIER_FILE} must export HOLDOUT_VERIFIER_CELLS`);
  const m = (await import(pathToFileURL(HOLDOUT_VERIFIER_FILE).href)) as { HOLDOUT_VERIFIER_CELLS?: readonly VerifierCell[] };
  if (m.HOLDOUT_VERIFIER_CELLS === undefined || m.HOLDOUT_VERIFIER_CELLS.length === 0) throw new Error(`${HOLDOUT_VERIFIER_FILE} exports no HOLDOUT_VERIFIER_CELLS`);
  return m.HOLDOUT_VERIFIER_CELLS;
}
