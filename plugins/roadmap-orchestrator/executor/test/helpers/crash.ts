// Test side of the crashPoint facility (src/core/crash.ts).
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TriggerSpec {
  readonly label: string;
  readonly occurrence: number;
  /** Only the calls that pass this unit count (G8). */
  readonly unit?: string;
}

/** Write a crash trigger into `dir`; returns its absolute path for ROADMAP_TEST_CRASH. */
export function writeTrigger(dir: string, spec: TriggerSpec): string {
  const path = join(dir, 'crash-trigger.json');
  writeFileSync(path, JSON.stringify(spec), { flag: 'wx' });
  return path;
}

/** The trigger was consumed: renamed to `.fired`, original gone. */
export function assertFired(path: string): void {
  assert.equal(existsSync(path), false, `crash trigger ${path} still armed`);
  assert.equal(existsSync(`${path}.fired`), true, `crash trigger ${path} has no .fired`);
}
