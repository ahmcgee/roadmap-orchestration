// Fake witness lanes (test/fakes/witness-lane.ts): a `node-test` lane and a `jsonl` shell-wrapper lane that
// report per-test outcomes through `$ROADMAP_WITNESS_FILE`. A control file scripts which outcome each test id
// gets on which tree: the lane looks up the tree id of the working tree it runs in, so the same lane program
// passes on one tree and fails on another (a mutant's patched tree, a repaired tree) with no change to the plan.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WITNESS_OUTCOMES, type WitnessOutcome, type WitnessTest } from '../../src/holistic/types.ts';

export const WITNESS_LANE = fileURLToPath(new URL('../fakes/witness-lane.ts', import.meta.url));

/** One tree's script: the outcome per test id (an id absent here is not reported), or a garbled report. */
export type TreePlan = Readonly<{ outcomes: Readonly<Record<string, WitnessOutcome>>; malformed?: true }>;
/** Tree id (or `*`, the fallback for a tree with no entry of its own) → its script. */
export type WitnessControl = Readonly<{ trees: Readonly<Record<string, TreePlan>> }>;

/** Write the control file. Exclusive: a test scripts each tree once (`scriptTree` adds one later). */
export function writeWitnessControl(path: string, control: WitnessControl): void {
  writeFileSync(path, `${JSON.stringify(control, null, 2)}\n`, { flag: 'wx' });
}

/** Add or replace `tree`'s script in an existing control file. */
export function scriptTree(path: string, tree: string, plan: TreePlan): void {
  const control = JSON.parse(readFileSync(path, 'utf8')) as WitnessControl;
  writeFileSync(path, `${JSON.stringify({ trees: { ...control.trees, [tree]: plan } }, null, 2)}\n`);
}

const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The argv of a `node-test` lane, or of a `jsonl` lane: an executable shell wrapper written into `dir`
 * that execs the fake with the control file's absolute path embedded (as the backend shims do).
 */
export function witnessLaneArgv(reporter: 'node-test' | 'jsonl', dir: string, controlFile: string): readonly string[] {
  if (reporter === 'node-test') return [process.execPath, WITNESS_LANE, 'node-test', controlFile];
  const wrapper = join(dir, 'jsonl-lane.sh');
  if (!existsSync(wrapper)) {
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(WITNESS_LANE)} jsonl ${quote(controlFile)}\n`, { flag: 'wx' });
    chmodSync(wrapper, 0o755);
  }
  return [wrapper];
}

/** The records a witness file holds, in file order; throws on a line that is not a record (see `TreePlan.malformed`). */
export function readWitnessFile(path: string): readonly WitnessTest[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((line) => {
    const r = JSON.parse(line) as WitnessTest;
    if (!WITNESS_OUTCOMES.includes(r.outcome)) throw new Error(`${path}: bad outcome in ${line}`);
    return r;
  });
}
