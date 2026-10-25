// A corpus arc's holistic jobs (M4a step C3): corpus-unit's arc (u1, I-1 at T-1 held on every tree) with L = {vision},
// so one lens call per audit, and a fake forge (its `gh` first on PATH while a job runs, so no read reaches a real forge:
// `withForge` in process, `forgeEnv` for a child). Shared by test/amendments.test.ts, test/packreview.test.ts and their
// crash child (corpus-job-child.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { type Forge, makeForge } from '../helpers/forge.ts';
import type { Step } from '../helpers/scenario.ts';
import { type CorpusUnitArc, type CorpusUnitOptions, setupCorpusArc } from './corpus-unit.ts';

export type CorpusHolisticArc = CorpusUnitArc & Readonly<{ forge: Forge }>;

/** The corpus arc with `steps` scripted and L = {vision}, with an empty fake forge. */
export async function corpusHolisticArc(steps: readonly Step[], opts: CorpusUnitOptions = {}): Promise<CorpusHolisticArc> {
  const a = await setupCorpusArc(steps, opts);
  const plan = JSON.parse(readFileSync(a.d.planPath, 'utf8')) as Record<string, Record<string, unknown>>;
  writeFileSync(a.d.planPath, JSON.stringify({ ...plan, holistic: { ...plan['holistic'], audit: { lenses: ['vision'] } } }));
  return { ...a, forge: makeForge() };
}

/** A child's env with the arc's fake gh first on PATH (and `extra`, e.g. ROADMAP_TEST_CRASH). */
export const forgeEnv = (a: CorpusHolisticArc, extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => ({ ...process.env, PATH: a.forge.path, ...extra });
