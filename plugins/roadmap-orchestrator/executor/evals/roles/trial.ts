// One role-eval trial in its own process (run.ts spawns one per trial): `node evals/roles/trial.ts '<WorkerArgs JSON>'`.
// Trace and brake lines go to stdout; the trial's row is <out>/row.json. Its scratch dirs (repo, worktrees, arc run dir)
// are removed when it exits 0 (test/helpers/repo.ts tmpDir); its artifacts stay in <out>.
import { enableCompileCache } from 'node:module';
import type { RepoConfig } from '../../src/routing/layers.ts';
import type { RiskTier } from '../../src/routing/types.ts';
import type { GateKind } from './gate/arc.ts';
import type { CellSet } from './gate/cells.ts';

export type WorkerArgs = Readonly<{
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
}>;

async function main(): Promise<void> {
  enableCompileCache();
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("usage: node evals/roles/trial.ts '<WorkerArgs JSON>'");
  const a = JSON.parse(raw) as WorkerArgs;
  const { cellsFor } = await import('./gate/cells.ts');
  const { runGateTrial } = await import('./gate/arc.ts');
  const cell = (await cellsFor(a.set)).find((c) => c.id === a.cell);
  if (cell === undefined) throw new Error(`no cell ${a.cell} in the ${a.set} set`);
  await runGateTrial({ ...a, cell, log: (line) => process.stdout.write(`${line}\n`) });
  process.exit(0);
}

if (import.meta.main) await main();
