// The witness protocol (plan "Witnesses, observations, the transition table"; DESIGN-1.0.md §2.8 Witnesses): how an
// arc lane's run becomes a witness record. The lane runs verbatim with `witnessEnv` added to its env; afterwards
// `collectWitness` reads its reporter's output and `witnessRecordOf` builds the record, which `writeWitnessRecord`
// keeps write-once as `witness.json` in the lane's evidence dir. The `witnessed` fact names that file's sha256.
//
// | Reporter       | Mechanism                                                                                   |
// |----------------|---------------------------------------------------------------------------------------------|
// | `node-test`    | NODE_OPTIONS loads the shipped `reporters/node-witness.mjs`, which appends witness lines to |
// |                | $ROADMAP_WITNESS_FILE (O_APPEND). The spec reporter stays on stdout for the lane's output.  |
// | `go-test-json` | the lane's stdout, parsed as test2json events (`go test -json`)                              |
// | `jsonl`        | a wrapper appends witness lines to $ROADMAP_WITNESS_FILE                                     |
//
// A witness line has a record's shape (`WitnessTest`), `{"testId": <string>, "selected": <nat>, "outcome": "pass" |
// "fail" | "skip" | "zero-selected"}`, with `selected` 0 exactly for `zero-selected` (a wrapper's explicit empty
// selection). The node reporter writes one line per test run (`selected` 1); a wrapper may write one per run or
// one per id. A test id is a name: the node reporter's is the test's name path from its outermost suite, joined
// with " > "; go's is test2json's `Test` (subtests `TestX/sub`). Lines with one id aggregate into one record:
// `selected` sums, and the outcome is fail if any failed, else skip if any was skipped, else pass, else
// zero-selected.
//
// Malformed output (a missing witness file, a line that does not parse, a torn last line, an unknown test2json
// action) makes the record `malformed` with no records: every declared test is unwitnessed. A lane whose own argv
// names a node test reporter must pair it with a destination (`node` refuses unpaired reporters).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EnvId, type InvocationId, type Sha, type Sha256Hex, envId, sha256 } from '../core/ids.ts';
import { exclusivePublish, canonicalJson as fileJson } from '../core/fsx.ts';
import { canonicalJson, sha256Hex } from '../core/json.ts';
import { SchemaError, nat, object, oneOf, str } from '../core/validate.ts';
import { SCHEMA_VERSION } from '../core/version.ts';
import { type AbsPath, absPath } from '../core/values.ts';
import {
  type ArcLaneDef, type Reporter, type WitnessOutcome, type WitnessPurpose, type WitnessRecord, type WitnessTest, WITNESS_OUTCOMES, laneRevOf,
  witnessRecord,
} from './types.ts';

/** The variable naming the file a `node-test` or `jsonl` lane's reporter appends witness lines to. */
export const WITNESS_FILE_ENV = 'ROADMAP_WITNESS_FILE';
/** The reporter's file in a witness run's evidence dir (a job lane's, a candidate journey's, a mutant's): raw evidence gc deletes. */
export const WITNESS_LINES = 'witness.lines';
/** The witness record's name in a lane's evidence dir. */
export const WITNESS_RECORD_FILE = 'witness.json';
/** The shipped node test reporter (plain JavaScript, loaded by the lane's node, not by the executor). */
export const NODE_WITNESS_REPORTER: AbsPath = absPath(fileURLToPath(new URL('../../reporters/node-witness.mjs', import.meta.url)));

/**
 * What a witness run adds to its lane's declared env. A node-test lane never sets NODE_OPTIONS (its reader refuses
 * one), so this owns it: the spec reporter keeps the lane's stdout readable, the witness reporter writes the file.
 */
export function witnessEnv(runner: Reporter, witnessFile: AbsPath): Readonly<Record<string, string>> {
  switch (runner) {
    case 'node-test':
      return {
        [WITNESS_FILE_ENV]: witnessFile,
        NODE_OPTIONS: [
          '--test-reporter=spec', '--test-reporter-destination=stdout',
          `--test-reporter=${NODE_WITNESS_REPORTER}`, '--test-reporter-destination=stderr',
        ].join(' '),
      };
    case 'jsonl':
      return { [WITNESS_FILE_ENV]: witnessFile };
    case 'go-test-json':
      return {};
  }
}

const witnessLine = object((f): WitnessTest => {
  const testId = f.get('testId', str);
  if (testId === '') throw new SchemaError(`${f.path}.testId`, 'a non-empty test id', testId);
  const out = { testId, selected: f.get('selected', nat), outcome: f.get('outcome', oneOf(WITNESS_OUTCOMES)) };
  if ((out.selected === 0) !== (out.outcome === 'zero-selected')) throw new SchemaError(`${f.path}.selected`, '0 exactly for zero-selected', out.selected);
  return out;
});

const RANK: { readonly [O in WitnessOutcome]: number } = { fail: 3, skip: 2, pass: 1, 'zero-selected': 0 };

/** Lines to records: one per test id, ascending, `selected` summed, the worst outcome kept. */
function aggregate(lines: readonly WitnessTest[]): readonly WitnessTest[] {
  const byId = new Map<string, { selected: number; outcome: WitnessOutcome }>();
  for (const { testId, selected, outcome } of lines) {
    const seen = byId.get(testId) ?? { selected: 0, outcome: 'zero-selected' };
    byId.set(testId, { selected: seen.selected + selected, outcome: RANK[outcome] > RANK[seen.outcome] ? outcome : seen.outcome });
  }
  return [...byId.keys()].sort().map((testId) => ({ testId, ...(byId.get(testId) as { selected: number; outcome: WitnessOutcome }) }));
}

/** Splits newline-terminated text into lines; null when the last line is torn (no final newline). */
function linesOf(textIn: string): readonly string[] | null {
  if (textIn === '') return [];
  if (!textIn.endsWith('\n')) return null;
  return textIn.slice(0, -1).split('\n');
}

/** The witness-line format (`node-test` and `jsonl`): records, or null when malformed. */
export function parseWitnessLines(textIn: string): readonly WitnessTest[] | null {
  const lines = linesOf(textIn);
  if (lines === null) return null;
  const out: WitnessTest[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      out.push(witnessLine(JSON.parse(line), `line ${i + 1}`));
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof SchemaError) return null;
      throw e;
    }
  }
  return aggregate(out);
}

/** test2json's actions (`go doc cmd/test2json`); any other is malformed output. */
const GO_ACTIONS = new Set(['start', 'run', 'pause', 'cont', 'pass', 'bench', 'fail', 'output', 'skip', 'build-output', 'build-fail']);
const GO_ENDS: Readonly<Record<string, WitnessOutcome>> = { pass: 'pass', fail: 'fail', skip: 'skip' };

/**
 * `go test -json` stdout: records, or null when malformed. Only events naming a `Test` count (package events do
 * not). A test that started but never ended (its binary died) is a failure.
 */
export function parseGoTestJson(stdout: string): readonly WitnessTest[] | null {
  const lines = linesOf(stdout);
  if (lines === null) return null;
  const running = new Map<string, string>();
  const out: WitnessTest[] = [];
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (e) {
      if (e instanceof SyntaxError) return null;
      throw e;
    }
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
    const { Action: action, Package: pkg, Test: test } = event as Record<string, unknown>;
    if (typeof action !== 'string' || !GO_ACTIONS.has(action)) return null;
    if (test === undefined) continue;
    if (typeof test !== 'string' || test === '' || (pkg !== undefined && typeof pkg !== 'string')) return null;
    const key = `${pkg ?? ''}\u0000${test}`;
    if (action === 'run') running.set(key, test);
    const end = GO_ENDS[action];
    if (end === undefined) continue;
    running.delete(key);
    out.push({ testId: test, selected: 1, outcome: end });
  }
  for (const testId of running.values()) out.push({ testId, selected: 1, outcome: 'fail' });
  return aggregate(out);
}

/** Where a finished lane run's reporter output is. `witnessFile` is what `witnessEnv` named. */
export type WitnessSources = Readonly<{ witnessFile: AbsPath; stdoutFile: AbsPath }>;

/** Reads and parses a finished lane run's reporter output: records, or null when malformed (a missing witness file included). */
export function collectWitness(runner: Reporter, sources: WitnessSources): readonly WitnessTest[] | null {
  if (runner === 'go-test-json') return parseGoTestJson(readFileSync(sources.stdoutFile, 'utf8'));
  let content: string;
  try {
    content = readFileSync(sources.witnessFile, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return parseWitnessLines(content);
}

/** Who ran and on what: the lane (its rev is derived), the environment, the tree, the invocation and the purpose. */
export type WitnessRun = Readonly<{ lane: ArcLaneDef; envId: EnvId; treeSha: Sha; inv: InvocationId; purpose: WitnessPurpose }>;

/** The witness record of one run; `tests` null (malformed) records nothing. */
export function witnessRecordOf(run: WitnessRun, tests: readonly WitnessTest[] | null): WitnessRecord {
  return {
    v: SCHEMA_VERSION,
    lane: run.lane.id,
    laneRev: laneRevOf(run.lane),
    envId: run.envId,
    treeSha: run.treeSha,
    inv: run.inv,
    runner: run.lane.reporter,
    purpose: run.purpose,
    records: tests ?? [],
    malformed: tests === null,
  };
}

/** Keeps `witness.json` write-once in the lane's evidence dir; returns the sha256 of its bytes (the fact's `recordsSha256`). */
export function writeWitnessRecord(dir: AbsPath, record: WitnessRecord): Sha256Hex {
  const bytes = fileJson(witnessRecord(record, 'witness'));
  exclusivePublish(join(dir, WITNESS_RECORD_FILE), bytes);
  return sha256(sha256Hex(bytes));
}

/** The host facts an environment identity binds besides the lane's passed-through variables. */
export type HostIdentity = Readonly<{ platform: string; arch: string; node: string }>;
export const hostIdentity = (): HostIdentity => ({ platform: process.platform, arch: process.arch, node: process.version });

/**
 * The environment identity (`envId`) an observation is keyed by, and a spec lane execution's (M4a rev 3, F1a: any
 * `LaneDef`): first 16 hex of sha256 over the host's platform, architecture and Node version and the values of the
 * variables the lane passes through from the host (absent ones as null). What the lane sets is in its `laneRev`; a
 * pool instance's binding is not identity (any instance of a pool is equivalent).
 */
export function envIdOf(lane: Pick<ArcLaneDef, 'env'>, host: HostIdentity, env: Readonly<Record<string, string | undefined>>): EnvId {
  const pass = Object.fromEntries([...lane.env.pass].sort().map((name) => [name, env[name] ?? null]));
  return envId(sha256Hex(canonicalJson({ host, pass })).slice(0, 16));
}
