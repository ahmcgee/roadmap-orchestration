import { fileURLToPath } from 'node:url';
import type { LaneDef } from '../core/records.ts';
import type { AbsPath } from '../core/values.ts';
import { instanceEnvVar } from '../resources/pool.ts';

/** The reserved pool instance is a per-worktree slot; its repo-configured env binds ports and other resources. */
export function captureLaunch(lane: LaneDef, env: Readonly<Record<string, string>>, dir: AbsPath): Readonly<{ argv: readonly string[]; env: Readonly<Record<string, string>> }> {
  if (lane.capture === undefined) return { argv: lane.argv, env };
  const slot = env[instanceEnvVar(lane.capture.port)];
  if (slot === undefined) throw new Error(`capture ${lane.id}: ${lane.capture.port} must be a leased pool instance`);
  return { argv: [process.execPath, fileURLToPath(new URL('./capture-runner.ts', import.meta.url))], env: { ...env,
    ROADMAP_CAPTURE_CONFIG: JSON.stringify(lane.capture), ROADMAP_CAPTURE_DIR: dir,
    ROADMAP_CAPTURE_STATES: JSON.stringify(lane.capture.states), ROADMAP_CAPTURE_SLOT: slot,
  } };
}
