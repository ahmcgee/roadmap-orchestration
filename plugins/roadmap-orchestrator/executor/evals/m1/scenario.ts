// Fake-backed M1 runs (`driver --fake <scenario.json>`): a scenario tells the arc's story by role, not by
// CLI, so one file serves both profiles. The driver translates it into the fake backend's steps
// (test/helpers/scenario.ts) for the profile it runs: judgment roles are Claude in both profiles; `build` is
// Codex under `default` and the Claude implementer under `claude-only`. The profile's backend smoke is
// prepended, and every build step ends with the implementer's report.
//
//   {"steps": [
//     {"role": "planCheck", "answer": <plan-check output>},
//     {"role": "build", "round": "fresh" | "resume", "acts": [<world acts>], "stdinContains"?: [...]},
//     {"role": "gate", "answer": <gate output>, "stdinContains"?: [...]}
//   ]}
//
// World acts are the fake's (`commit`, `stage`, `dirty`, `readFromPrompt`, `writeToPrompt`); paths are
// relative to the call's working directory, the unit worktree.
import { readFileSync } from 'node:fs';
import type { JsonValue } from '../../src/core/json.ts';
import type { ProfileName } from '../../src/routing/types.ts';
import type { Expect, Step, WorldAct } from '../../test/helpers/scenario.ts';

export type M1Step =
  | Readonly<{ role: 'planCheck' | 'gate'; answer: JsonValue; stdinContains?: readonly string[] }>
  | Readonly<{ role: 'build'; round: 'fresh' | 'resume'; acts: readonly WorldAct[]; stdinContains?: readonly string[] }>;

export type M1Scenario = Readonly<{ steps: readonly M1Step[] }>;

const WORLD_ACTS: ReadonlySet<string> = new Set(['commit', 'stage', 'dirty', 'readFromPrompt', 'writeToPrompt']);

class ScenarioError extends Error {
  constructor(field: string, detail: string) {
    super(`scenario ${field}: ${detail}`);
    this.name = 'ScenarioError';
  }
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strings(v: unknown, field: string): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) throw new ScenarioError(field, `expected an array of strings, got ${JSON.stringify(v)}`);
  return v as string[];
}

function onlyKeys(v: Readonly<Record<string, unknown>>, keys: readonly string[], field: string): void {
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new ScenarioError(field, `unknown field ${k}`);
}

function m1Step(v: unknown, field: string): M1Step {
  if (!isRecord(v)) throw new ScenarioError(field, `expected an object, got ${JSON.stringify(v)}`);
  const stdinContains = strings(v['stdinContains'], `${field}.stdinContains`);
  const extra = stdinContains === undefined ? {} : { stdinContains };
  switch (v['role']) {
    case 'planCheck':
    case 'gate':
      onlyKeys(v, ['role', 'answer', 'stdinContains'], field);
      if (!isRecord(v['answer'])) throw new ScenarioError(`${field}.answer`, `expected an object, got ${JSON.stringify(v['answer'])}`);
      return { role: v['role'], answer: v['answer'] as JsonValue, ...extra };
    case 'build': {
      onlyKeys(v, ['role', 'round', 'acts', 'stdinContains'], field);
      const round = v['round'];
      if (round !== 'fresh' && round !== 'resume') throw new ScenarioError(`${field}.round`, `expected fresh or resume, got ${JSON.stringify(round)}`);
      const acts = v['acts'];
      if (!Array.isArray(acts)) throw new ScenarioError(`${field}.acts`, 'expected an array');
      acts.forEach((a: unknown, i) => {
        if (!isRecord(a) || typeof a['type'] !== 'string' || !WORLD_ACTS.has(a['type'])) {
          throw new ScenarioError(`${field}.acts[${i}]`, `expected one of ${[...WORLD_ACTS].join(', ')}, got ${JSON.stringify(a)}`);
        }
      });
      return { role: 'build', round, acts: acts as WorldAct[], ...extra };
    }
    default:
      throw new ScenarioError(`${field}.role`, `expected planCheck, build or gate, got ${JSON.stringify(v['role'])}`);
  }
}

export function readScenario(path: string): M1Scenario {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(raw) || !Array.isArray(raw['steps'])) throw new ScenarioError('steps', `${path} holds no steps array`);
  onlyKeys(raw, ['steps'], path);
  return { steps: raw['steps'].map((s: unknown, i) => m1Step(s, `steps[${i}]`)) };
}

/** The report every fake build ends with (the build role's output schema). */
const BUILD_REPORT: JsonValue = { summary: 'Did the work.', changedPaths: [], lanesRun: [], blockers: [], experiments: [] };
const SMOKE_OK: JsonValue = { ok: true };

/** A judgment call: read-only tools, a fresh session id, never a resume or a permission mode. */
const JUDGMENT: Expect = { argv: ['-p', '--tools', 'Read,Grep,Glob', '--session-id', '--no-session-persistence'], argvLacks: ['--resume', '--permission-mode'] };

/** The smoke `roadmap start` runs first: Claude, then Codex under `default` (BACKENDS order); Claude alone under `claude-only`. */
function smokeSteps(profile: ProfileName): readonly Step[] {
  const claude: Step = { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: SMOKE_OK }] };
  const codex: Step = { as: 'codex', expect: { argv: ['exec'] }, acts: [{ type: 'emit', value: SMOKE_OK }] };
  return profile === 'default' ? [claude, codex] : [claude];
}

function buildExpect(profile: ProfileName, round: 'fresh' | 'resume'): Expect {
  if (profile === 'default') return { argv: round === 'fresh' ? ['exec', '-C'] : ['exec', 'resume'] };
  return { argv: ['-p', '--permission-mode', round === 'fresh' ? '--session-id' : '--resume'], argvLacks: ['--tools'] };
}

/** The fake backend steps that play `scenario` under `profile`. */
export function fakeSteps(scenario: M1Scenario, profile: ProfileName): readonly Step[] {
  const steps = scenario.steps.map((s): Step => {
    const stdin: Expect = s.stdinContains === undefined ? {} : { stdinContains: s.stdinContains };
    if (s.role !== 'build') return { as: 'claude', expect: { ...JUDGMENT, ...stdin }, acts: [{ type: 'emit', value: s.answer }] };
    const acts = [...s.acts, { type: 'emit', value: BUILD_REPORT } as const];
    const expect = { ...buildExpect(profile, s.round), ...stdin };
    return profile === 'default' ? { as: 'codex', expect, acts } : { as: 'claude', expect, acts };
  });
  return [...smokeSteps(profile), ...steps];
}
