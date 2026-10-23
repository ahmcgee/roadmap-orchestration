// One role-eval trial in its own process (run.ts spawns one per trial): `node evals/roles/trial.ts '<WorkerArgs JSON>'`.
// Trace and brake lines go to stdout; the trial's row is <out>/row.json. Its scratch dirs (repo, worktrees, arc run dir,
// evidence dir) are removed when it exits 0 (test/helpers/repo.ts tmpDir); its artifacts stay in <out>.
import { enableCompileCache } from 'node:module';
import type { RepoConfig } from '../../src/routing/layers.ts';
import type { RiskTier } from '../../src/routing/types.ts';
import type { GateKind } from './gate/arc.ts';
import type { CellSet } from './gate/cells.ts';
import type { PolishWorkerArgs } from './polish/arc.ts';
import type { ScaffoldWorkerArgs } from './scaffold/arc.ts';
import type { WalkWorkerArgs } from './walkthrough/arc.ts';

export type GateWorkerArgs = Readonly<{
  role: 'gate';
  set: CellSet;
  cell: string;
  trial: number;
  seed: string;
  size: number;
  gate: GateKind;
  risk: RiskTier;
  /** The repo config of `--rebind` (`routing.classes`), or null. */
  config: RepoConfig | null;
  out: string;
  medianLoad: number | null;
  /** `--trial-cap`: the live spend in USD over which the trial's session is killed (void `cap`), or null. */
  trialCap: number | null;
  /** `--read-only`: the read-only comparison arm (dev.13). */
  readOnly: boolean;
}>;

/** The roles with evals: a worker runs one trial of one. */
export type WorkerArgs = GateWorkerArgs | WalkWorkerArgs | PolishWorkerArgs | ScaffoldWorkerArgs;

async function main(): Promise<void> {
  enableCompileCache();
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("usage: node evals/roles/trial.ts '<WorkerArgs JSON>'");
  const a = JSON.parse(raw) as WorkerArgs;
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  if (a.role === 'gate') {
    const { cellsFor } = await import('./gate/cells.ts');
    const { runGateTrial } = await import('./gate/arc.ts');
    const cell = (await cellsFor(a.set)).find((c) => c.id === a.cell);
    if (cell === undefined) throw new Error(`no cell ${a.cell} in the ${a.set} set`);
    await runGateTrial({ ...a, cell, log });
  } else if (a.role === 'polishJudge') {
    const { polishCellsFor } = await import('./polish/cells.ts');
    const { runPolishTrial } = await import('./polish/arc.ts');
    const cell = (await polishCellsFor(a.set)).find((c) => c.id === a.cell);
    if (cell === undefined) throw new Error(`no cell ${a.cell} in the polishJudge ${a.set} set`);
    await runPolishTrial({ ...a, cell, log });
  } else if (a.role === 'scaffold') {
    const { scaffoldCellsFor } = await import('./scaffold/cells.ts');
    const { runScaffoldTrial } = await import('./scaffold/arc.ts');
    const cell = (await scaffoldCellsFor(a.set)).find((c) => c.id === a.cell);
    if (cell === undefined) throw new Error(`no cell ${a.cell} in the scaffold ${a.set} set`);
    await runScaffoldTrial({ ...a, cell, log });
  } else {
    const { walkCellsFor } = await import('./walkthrough/cells.ts');
    const { runWalkTrial } = await import('./walkthrough/arc.ts');
    const cell = (await walkCellsFor(a.set)).find((c) => c.id === a.cell);
    if (cell === undefined) throw new Error(`no cell ${a.cell} in the walkthrough ${a.set} set`);
    await runWalkTrial({ ...a, cell, log });
  }
  process.exit(0);
}

// A failed trial's last stderr line is its error's message (runWorker's void detail keeps the tail, where Node's own
// uncaught-error print ends in stack frames).
if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`${e instanceof Error ? e.stack : message}\ntrial error: ${message.replaceAll('\n', ' | ')}\n`);
    process.exit(1);
  }
}
