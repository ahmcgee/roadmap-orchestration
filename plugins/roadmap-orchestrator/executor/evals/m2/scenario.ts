// Fake-backed M2 runs (`driver --fake <story dir>`): the story is one M1 scenario file per unit
// (`<unit>.json`, evals/m1/scenario.ts: steps by role), since units run in parallel and each unit's calls come
// in its own order. The driver translates each into the fake backend's steps for the profile (evals/m1's
// `fakeSteps`), keyed by unit (test/helpers/scenario.ts `Step.unit`), and prepends the unkeyed backend smokes:
// one for the start and one for the supervisor's respawn after the driver's SIGKILL.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileName } from '../../src/routing/types.ts';
import type { Step } from '../../test/helpers/scenario.ts';
import { fakeSteps, readScenario } from '../m1/scenario.ts';
import { type FixtureUnit, REENTRY, UNITS } from './layout.ts';

export const STORY_UNITS: readonly FixtureUnit[] = [...UNITS, REENTRY];
/** Executor generations that smoke the backends: the start, and the respawn after the kill. */
const SMOKES = 2;

/** The fake backend steps that play the story in `dir` under `profile`. */
export function storySteps(dir: string, profile: ProfileName): readonly Step[] {
  const smoke = fakeSteps({ steps: [] }, profile);
  const units = STORY_UNITS.flatMap((unit) => {
    const file = join(dir, `${unit}.json`);
    if (!existsSync(file)) throw new Error(`story ${dir} has no ${unit}.json`);
    return fakeSteps(readScenario(file), profile).slice(smoke.length).map((s): Step => ({ ...s, unit }));
  });
  return [...Array.from({ length: SMOKES }, () => smoke).flat(), ...units];
}
