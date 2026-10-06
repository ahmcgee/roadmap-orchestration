// M4a rev 3 build-stage changes through the unit driver, integrated (real processes, real git, fake backends):
// F8 8d, a resolve round may commit after the merge (`resolvedHead`, src/git/mergein.ts) but must hold the merge of
// [old, T]: build.resolve-follow-up-commits-accepted, build.resolve-without-merge-in-chain-malformed; I3, the build
// answer's per-call schema (the spec's fast lane ids, `experiments`) and the resume round quoting why an answer was
// malformed: build.lane-enum-schema, build.experiments-accepted, build.malformed-keeps-error.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { unitBranch } from '../src/pipeline/dispatch.ts';
import { step } from '../src/pipeline/unit.ts';
import { RESOLVE_DIRECTIVE, RESUME_DIRECTIVE } from '../src/prompts/directives.ts';
import { reached, release } from './helpers/barrier.ts';
import { git } from './helpers/repo.ts';
import { type CallRecord, type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import {
  type ArcDescriptor, type ArcRun, MUL, MUL_LANE, U1, codexStep, contextFor, gateStep, literal, mulBuild, outcomes, setupArc, stepUntil, unitWorktreePath,
} from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

const PRE_LANES = ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released'];
const MERGED = ['gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

const parentsOf = (repo: string, commit: string): readonly string[] => git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
const codexCalls = (d: ArcDescriptor): readonly CallRecord[] => readCalls(d.scenarioPath).filter((c) => c.as === 'codex');

// ---------------------------------------------------------------------------------------------------
// 8d: the resolve round's HEAD chain

const UNIT_ADD = 'export function add(a, b) {\n  return a + b; // unit u1\n}\n';
const TIP_ADD = 'export function add(a, b) {\n  return b + a; // integration\n}\n';
const RESOLVED_ADD = 'export function add(a, b) {\n  return a + b; // resolved\n}\n';

/**
 * u1 approved by its gate with a change to src/add.js; then the integration tip changes src/add.js too, so the candidate
 * conflicts and its merge-in leaves MERGE_HEAD = T for a resolve round (`resolve`, the steps after the first gate).
 */
async function toResolve(resolve: readonly Step[]): Promise<Readonly<{ r: ArcRun; approved: string; tip: string }>> {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild({ 'src/add.js': UNIT_ADD }), gateStep({ decision: 'approve' }), ...resolve] });
  const r = contextFor(d);
  await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
  const approved = r.journal.view.unit(U1).approval!.fingerprint.unitCommit;
  writeFileSync(join(d.repo, 'src', 'add.js'), TIP_ADD);
  git(d.repo, 'commit', '--quiet', '-am', 'integration changes add');
  const tip = git(d.repo, 'rev-parse', 'main');
  await stepUntil(r, 'u1', (f) => f.stage === 'candidate');
  assert.equal(outcomes(d).at(-1), 'candidate:conflict');
  assert.equal(git(unitWorktreePath(r), 'rev-parse', 'MERGE_HEAD'), tip);
  return { r, approved, tip };
}

describe('8d: resolve rounds', () => {
  test('build.resolve-follow-up-commits-accepted: a resolve round that commits the merge, then a non-merge follow-up commit, is a success; the unit merges with both', T, async () => {
    const { r, approved, tip } = await toResolve([
      codexStep([
        { type: 'commit', message: 'resolve the merge', files: { 'src/add.js': RESOLVED_ADD } },
        { type: 'commit', message: 'follow-up after the merge', files: { 'src/extra.js': 'export const extra = 1;\n' } },
      ], { argv: ['exec', 'resume'], stdinContains: [RESOLVE_DIRECTIVE] }),
      gateStep({ decision: 'approve' }),
    ]);
    const { d } = r;
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.equal(outcomes(d).at(-1), 'build:success', 'the HEAD descends from the merge through a non-merge commit');
      await stepUntil(r, 'u1', (f) => f.stage === 'snapshot');
      assert.deepEqual(outcomes(d), [
        ...PRE_LANES, 'lanes:green', 'gate:approve', 'candidate:conflict',
        ...PRE_LANES.slice(1), 'lanes:green', ...MERGED,
      ]);
      const unitCommit = git(d.repo, 'rev-parse', unitBranch(arcId(d.arc), U1));
      const [merge] = parentsOf(d.repo, unitCommit);
      assert.equal(parentsOf(d.repo, unitCommit).length, 1, 'the unit head is the follow-up commit');
      assert.deepEqual(parentsOf(d.repo, merge!), [approved, tip], 'its parent is the merge [old, T]');
      assert.equal(`${git(d.repo, 'show', 'main:src/add.js')}\n`, RESOLVED_ADD);
      assert.equal(`${git(d.repo, 'show', 'main:src/extra.js')}\n`, 'export const extra = 1;\n');
    } finally {
      r.journal.close();
    }
  });

  test('build.resolve-without-merge-in-chain-malformed: a resolve round that abandons the merge and commits the resolution as a plain commit is malformed', T, async () => {
    const { r } = await toResolve([
      codexStep([
        { type: 'barrier', name: 'resolve', timeoutMs: 120_000 },
        { type: 'commit', message: 'resolve without the merge', files: { 'src/add.js': RESOLVED_ADD } },
      ], { argv: ['exec', 'resume'], stdinContains: [RESOLVE_DIRECTIVE] }),
    ]);
    const { d } = r;
    try {
      const building = stepUntil(r, 'u1', (f) => f.stage === 'build');
      await reached(d.scenarioDir, 'resolve', 60_000);
      // The implementer abandons the merge: its next commit is an ordinary one on the old head.
      git(unitWorktreePath(r), 'merge', '--abort');
      release(d.scenarioDir, 'resolve');
      await building;
      assert.equal(outcomes(d).at(-1), 'build:malformed', 'no merge of [old, T] in the HEAD chain');
      const head = git(unitWorktreePath(r), 'rev-parse', 'HEAD');
      assert.equal(parentsOf(d.repo, head).length, 1, 'the round left a plain commit');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// I3: the build answer schema, per call

const LINT_LANE = { id: 'lint', argv: ['node', '-e', '0'] } as const;

/** The JSON schema a codex call was launched with (`--output-schema <path>`). */
function schemaOf(call: CallRecord): Record<string, unknown> {
  const i = call.argv.indexOf('--output-schema');
  assert.ok(i >= 0, `a codex call without --output-schema: ${call.argv.join(' ')}`);
  return JSON.parse(readFileSync(call.argv[i + 1]!, 'utf8')) as Record<string, unknown>;
}

type JsonSchema = Readonly<{ properties: Record<string, JsonSchema>; items: JsonSchema; enum?: readonly string[]; required?: readonly string[] }>;

describe('I3: the build answer schema', () => {
  test('build.lane-enum-schema: the build call\'s schema enumerates the spec\'s fast lane ids in lanesRun[].lane and has experiments', T, async () => {
    const d = setupArc({ units: [{ id: 'u1', lanes: [MUL_LANE, LINT_LANE] }], steps: [planCheckStep({ decision: 'approve' }), mulBuild()] });
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.equal(outcomes(d).at(-1), 'build:success');
      const [build] = codexCalls(d);
      const schema = schemaOf(build!) as unknown as JsonSchema;
      assert.deepEqual([...schema.properties['lanesRun']!.items.properties['lane']!.enum!].sort(), ['lint', 'mul']);
      const experiments = schema.properties['experiments']!;
      assert.deepEqual(Object.keys(experiments.items.properties).sort(), ['argv', 'exit', 'name']);
      assert.ok(schema.required?.includes('experiments'), 'experiments is required');
    } finally {
      r.journal.close();
    }
  });

  test('build.experiments-accepted: an answer naming the spec\'s lanes and listing experiments is a success', T, async () => {
    const report = { ...BUILD_REPORT, lanesRun: [{ lane: 'mul', exit: 0 }], experiments: [{ name: 'probe add', argv: ['node', '-e', 'import("./src/add.js")'], exit: 0 }] };
    const d = setupArc({
      steps: [planCheckStep({ decision: 'approve' }), { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: report }] }],
    });
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.deepEqual(outcomes(d), ['plan-check:approve', 'build:success']);
    } finally {
      r.journal.close();
    }
  });

  test('build.malformed-keeps-error: an answer naming a lane outside the spec\'s fast lanes is malformed, and the resume round quotes why after RESUME_DIRECTIVE', T, async () => {
    const report = { ...BUILD_REPORT, lanesRun: [{ lane: 'suite', exit: 0 }] };
    const d = setupArc({
      steps: [
        planCheckStep({ decision: 'approve' }),
        { as: 'codex', expect: { argv: ['exec', '-C'] }, acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: report }] },
        codexStep([], { argv: ['exec', 'resume'], stdinContains: [RESUME_DIRECTIVE] }),
      ],
    });
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.equal(outcomes(d).at(-1), 'build:malformed');
      await step(r.ctx, r.unit('u1'));
      assert.equal(outcomes(d).at(-1), 'build:success', 'the resume round answered');
      const resume = codexCalls(d).at(-1)!;
      assert.equal(resume.step, 2, 'the resume call matched its step');
      // RESUME_DIRECTIVE, then why: the validation error, naming the lane field and the lane.
      assert.match(resume.stdin, new RegExp(`${literal(RESUME_DIRECTIVE)}[\\s\\S]*Why it did not match: [^\\n]*lanesRun[^\\n]*`));
      assert.match(resume.stdin, /Why it did not match: [^\n]*suite/);
    } finally {
      r.journal.close();
    }
  });
});
