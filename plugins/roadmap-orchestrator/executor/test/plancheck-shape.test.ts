// M4a rev 3 step N3, E: the plan-check shape by builder class and the in-session assessment, through the unit driver in a
// corpus arc (real processes, real git, fake backends; test/fixtures/checks-common.ts). Named tests: plancheck.*,
// build.assess-*, and the crash rows "Plan-check acceptance patch", "Plan-check in-session" and "Build assess" (labels
// plancheck.after-witness-patch, plancheck.after-pin-in-session, build.after-assess).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Fact } from '../src/core/events.ts';
import type { JsonValue } from '../src/core/json.ts';
import { arcId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import type { StageContext } from '../src/pipeline/dispatch.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import type { RoutingLayer } from '../src/routing/types.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { type CallRecord, type ClaudeAct, type Step, readCalls } from './helpers/scenario.ts';
import { type ChecksArc, type ChecksOptions, checksArc, outcomeFacts } from './fixtures/checks-common.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, MUL, contextFor, gateStep, isGateCall, mulBuild, outcomes, stepUntil } from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const BY_BUILDER = (p: Record<string, unknown>): void => { p['planCheck'] = { shape: 'by-builder' }; };

const facts = (d: ArcDescriptor): readonly Fact[] => readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));
const sessionArg = (c: CallRecord, flag: '--session-id' | '--resume'): string | null => {
  const i = c.argv.indexOf(flag);
  return i === -1 ? null : c.argv[i + 1]!;
};
const isAssess = (c: CallRecord): boolean => (c.argv[c.argv.indexOf('--json-schema') + 1] ?? '').includes('"planAssessment"');
const isPlanCheck = (c: CallRecord): boolean => c.as === 'claude' && c.argv.includes('--no-session-persistence') && !isGateCall(c);

/** A claude implementer's fresh in-session assessment answering `a` (after `before` acts). */
function assessStep(a: Readonly<{ feasible?: boolean; riskFloor?: string; visionConflict?: readonly JsonValue[]; notes?: string }>, before: readonly ClaudeAct[] = []): Step {
  return {
    as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions', '--session-id'], stdinContains: ['This invocation is the assessment, not the build.'] },
    acts: [...before, { type: 'emit', value: { planAssessment: {
      feasible: a.feasible ?? true, riskFloor: a.riskFloor ?? 'med', visionConflict: [...(a.visionConflict ?? [])], premises: [], notes: a.notes ?? 'add mul beside add',
    } } }],
  };
}
/** The implementing invocation: the assessment's session resumed, mul committed. */
const implementStep: Step = {
  as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions', '--resume'], stdinContains: ['Your assessment is recorded. Now build the unit'] },
  acts: [{ type: 'commit', message: 'add mul', files: MUL }, { type: 'emit', value: BUILD_REPORT }],
};

/** A run of the arc under `layer` (the routing's plan layer): its classes decide the builder class. */
function under(a: ChecksArc, layer: RoutingLayer | null): ArcRun {
  const r = contextFor(a.d);
  const routing = resolveRouting({ profile: 'default', classes: null, repoConfig: null, plan: layer, unit: null });
  const ctx: StageContext = { ...r.ctx, routing: () => routing };
  return { ...r, ctx };
}
/** build.med on frontier (so a med unit assesses in session), build.high on `high`. */
const frontierMed = (high: 'frontier' | 'efficient' = 'frontier'): RoutingLayer => ({ build: { med: 'frontier', high } });

async function arc(opts: Omit<ChecksOptions, 'plan'> & Readonly<{ plan?: ChecksOptions['plan'] }>): Promise<ChecksArc> {
  return checksArc({ ...opts, plan: (p) => { BY_BUILDER(p); opts.plan?.(p); } });
}

describe('plan-check shape (E)', () => {
  test('plancheck.shape-uniform-default: without `planCheck.shape` the plan-check is the uniform call, even for a frontier builder', T, async () => {
    const a = await checksArc({ steps: [planCheckStep({ decision: 'approve' }), { ...implementStep, expect: { argv: ['--session-id'] } }] });
    const r = under(a, frontierMed());
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.deepEqual(outcomes(a.d).slice(0, 2), ['plan-check:approve', 'build:success']);
      assert.equal(readCalls(a.d.scenarioPath).filter(isAssess).length, 0);
    } finally {
      r.journal.close();
    }
  });

  test('plancheck.in-session-frontier-no-call: a frontier builder makes no plan-check call; its fresh build assesses, then implements in the same session', T, async () => {
    const a = await arc({ steps: [assessStep({}), implementStep, gateStep({ decision: 'approve' })] });
    const r = under(a, frontierMed());
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'gate');
      assert.deepEqual(outcomes(a.d), ['plan-check:in-session', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve']);
      const calls = readCalls(a.d.scenarioPath);
      assert.equal(calls.filter(isPlanCheck).length, 0, 'no plan-check call');
      const [assess, implement] = calls;
      assert.ok(isAssess(assess!));
      assert.equal(sessionArg(implement!, '--resume'), sessionArg(assess!, '--session-id'), 'the implementing call resumes the assessment\'s session');
      assert.equal(r.journal.view.dispatchOf(r.unit('u1').id)?.riskFloor, 'med', 'the pin is the plan-check\'s');
    } finally {
      r.journal.close();
    }
  });

  test('plancheck.efficient-acceptance-witnesses-patched: an efficient builder\'s check maps clauses to witness items through the patch channel; D1 then requires them', T, async () => {
    const item = { id: 'W-1', lane: 'journey', testId: 't9', clause: 'A1', skeleton: "test('t9', () => assert.equal(mul(2, 3), 6))" };
    const a = await arc({
      steps: [
        planCheckStep({ decision: 'redirect', patch: [{ op: 'add', section: 'witnesses', item }] }, { stdinContains: ['<acceptance_shape>', 'the next free id, W-1'] }),
        planCheckStep({ decision: 'approve' }), mulBuild(),
      ],
    });
    const r = under(a, null);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      const pcs = readCalls(a.d.scenarioPath).filter(isPlanCheck);
      assert.match(pcs[0]!.argv[pcs[0]!.argv.indexOf('--json-schema') + 1]!, /"witnesses"/, 'the acceptance schema');
      const spec = loadUnitSpec(r.ctx, r.unit('u1')).spec;
      assert.equal(spec.rev, 2, 'one machine patch');
      assert.deepEqual(spec.witnesses?.map((w) => [w.id, w.testId, w.state]), [['W-1', 't9', 'active']]);
      const f = outcomeFacts(a.d).filter((x) => x.stage === 'lanes').at(-1)!;
      assert.deepEqual(f.detail, { kind: 'witnesses-missing', missing: [{ lane: 'journey', testId: 't9' }], failed: [] }, 'D1 enforces the new item');
    } finally {
      r.journal.close();
    }
  });

  test('plancheck.acceptance-prose-ops-refused: an acceptance-shape redirect editing anything but witness items, facts or cites is malformed', T, async () => {
    const a = await arc({ steps: [planCheckStep({ decision: 'redirect', patch: [{ op: 'add', section: 'decisions', item: { id: 'R9', text: 'Use the parser.' } }] })] });
    const r = under(a, null);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'plan-check');
      assert.deepEqual(outcomes(a.d), ['plan-check:malformed']);
    } finally {
      r.journal.close();
    }
  });

  test('plancheck.witness-id-reused-malformed: a witness item reusing an id the spec holds is malformed (id-reused)', T, async () => {
    const item = { id: 'W-1', lane: 'journey', testId: 't9', clause: 'A1', skeleton: 's' };
    const a = await arc({ steps: [planCheckStep({ decision: 'redirect', patch: [{ op: 'add', section: 'witnesses', item }] }, { stdinContains: ['the next free id, W-2'] })], witnesses: [{ id: 'W-1', testId: 't1' }] });
    const r = under(a, null);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'plan-check');
      assert.deepEqual(outcomes(a.d), ['plan-check:malformed']);
      assert.equal(loadUnitSpec(r.ctx, r.unit('u1')).spec.rev, 1, 'nothing patched');
    } finally {
      r.journal.close();
    }
  });
});

describe('in-session assessment (R55)', () => {
  test('build.assess-infeasible-escalates: `feasible: false` is build `infeasible{notes}`: the unit parks for a spec revision, nothing implemented', T, async () => {
    const a = await arc({ steps: [assessStep({ feasible: false, notes: 'The corpus forbids a mul.' })] });
    const r = under(a, frontierMed());
    try {
      const s = await stepUntil(r, 'u1', (f) => f.stage === 'build').then(() => null, (e: Error) => e);
      assert.ok(s === null || /ended parked/.test(s.message), String(s));
      const f = outcomeFacts(a.d).at(-1)!;
      assert.deepEqual([f.stage, f.outcome, f.class, f.detail], ['build', 'infeasible', 'park', { kind: 'infeasible', notes: 'The corpus forbids a mul.' }]);
      assert.equal(readCalls(a.d.scenarioPath).length, 1, 'no implementing call');
    } finally {
      r.journal.close();
    }
  });

  test('build.assess-risk-raised-reseats: a raised floor whose seat binds another model is `risk-raised`: a fresh build there', T, async () => {
    const a = await arc({ steps: [assessStep({ riskFloor: 'high' }), mulBuild()] });
    const r = under(a, frontierMed('efficient'));
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build' && f.outcome === 'success');
      assert.deepEqual(outcomes(a.d).slice(0, 3), ['plan-check:in-session', 'build:risk-raised', 'build:success']);
      assert.equal(r.journal.view.dispatchOf(r.unit('u1').id)?.riskFloor, 'high');
      assert.deepEqual(readCalls(a.d.scenarioPath).map((c) => c.as), ['claude', 'codex'], 'the fresh build runs on the raised seat');
    } finally {
      r.journal.close();
    }
  });

  test('build.assess-understated-risk-raised-same-seat: a raised floor on the same seat raises the risk and implements in the session', T, async () => {
    const a = await arc({ steps: [assessStep({ riskFloor: 'high' }), implementStep] });
    const r = under(a, frontierMed('frontier'));
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.deepEqual(outcomes(a.d), ['plan-check:in-session', 'build:success']);
      assert.equal(r.journal.view.dispatchOf(r.unit('u1').id)?.riskFloor, 'high');
    } finally {
      r.journal.close();
    }
  });

  test('build.assess-vision-conflict-finding: each vision conflict opens a P3 finding sourced at the build; the build goes on', T, async () => {
    const a = await arc({ steps: [assessStep({ visionConflict: [{ clauses: ['V-1'], note: 'mul rounds berths' }] }), implementStep] });
    const r = under(a, frontierMed());
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.deepEqual(outcomes(a.d), ['plan-check:in-session', 'build:success']);
      const opened = facts(a.d).filter((f) => f.kind === 'finding-opened');
      assert.deepEqual(opened.map((f) => f.kind === 'finding-opened' && [f.severity, f.visionClauses, f.source]), [['P3', ['V-1'], { type: 'stage', unit: 'u1', stage: 'build', attempt: 2 }]]);
    } finally {
      r.journal.close();
    }
  });

  test('build.assess-edits-malformed: an assessment that changes the tree is malformed; its retry assesses again, fresh', T, async () => {
    const a = await arc({ steps: [assessStep({}, [{ type: 'dirty', files: { 'src/scratch.js': '// x\n' } }]), assessStep({}), implementStep] });
    const r = under(a, frontierMed());
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'build' && f.outcome === 'success');
      assert.deepEqual(outcomes(a.d), ['plan-check:in-session', 'build:malformed', 'build:success']);
      const [first, second] = readCalls(a.d.scenarioPath);
      assert.ok(isAssess(first!) && isAssess(second!));
      assert.notEqual(sessionArg(second!, '--session-id'), null, 'a fresh session');
    } finally {
      r.journal.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash rows (identical replay)

async function crashThenResume(a: ChecksArc, label: string, layer: RoutingLayer | null): Promise<void> {
  const trigger = writeTrigger(tmpDir('shape-crash'), { label, occurrence: 1, unit: 'u1' });
  const env = { ...process.env, ROADMAP_TEST_CRASH: trigger, ...(layer === null ? {} : { ROADMAP_TEST_ROUTING_LAYER: JSON.stringify(layer) }) };
  const first = await runFixture('shape-child.ts', [JSON.stringify(a.d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(first.signal, 'SIGKILL', `killed at ${label}: ${first.stderr}`);
  assertFired(trigger);
  const second = await runFixture('shape-child.ts', [JSON.stringify(a.d), 'u1'], { env, timeoutMs: SCENARIO_TIMEOUT_MS });
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { kind: 'merged' });
}

const MERGED = ['quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published'];

describe('crash rows', () => {
  test('crash "Plan-check in-session" (plancheck.after-pin-in-session): the restart records in-session once; no plan-check call', T, async () => {
    const a = await arc({ steps: [assessStep({}), implementStep, gateStep({ decision: 'approve' })] });
    await crashThenResume(a, 'plancheck.after-pin-in-session', frontierMed());
    assert.deepEqual(outcomes(a.d), ['plan-check:in-session', 'build:success', ...MERGED]);
    assert.equal(readCalls(a.d.scenarioPath).filter(isPlanCheck).length, 0);
  });

  test('crash "Build assess" (build.after-assess): the completed assessment is read, never asked again; the implementing call resumes it', T, async () => {
    const a = await arc({ steps: [assessStep({}), implementStep, gateStep({ decision: 'approve' })] });
    await crashThenResume(a, 'build.after-assess', frontierMed());
    assert.deepEqual(outcomes(a.d), ['plan-check:in-session', 'build:success', ...MERGED]);
    const calls = readCalls(a.d.scenarioPath);
    assert.equal(calls.filter(isAssess).length, 1, 'one assessment');
    assert.equal(sessionArg(calls[1]!, '--resume'), sessionArg(calls[0]!, '--session-id'));
  });

  test('crash "Plan-check acceptance patch" (plancheck.after-witness-patch): the patch is found, never applied twice', T, async () => {
    const item = { id: 'W-1', lane: 'journey', testId: 't9', clause: 'A1', skeleton: 's' };
    const a = await arc({
      steps: [planCheckStep({ decision: 'redirect', patch: [{ op: 'add', section: 'witnesses', item }] }), planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })],
      trees: { '*': { outcomes: { t1: 'pass', t9: 'pass' } } },
    });
    await crashThenResume(a, 'plancheck.after-witness-patch', null);
    assert.deepEqual(outcomes(a.d), ['plan-check:redirect', 'plan-check:approve', 'build:success', ...MERGED]);
    const patches = readJournal(absPath(a.d.runDir), arcId(a.d.arc)).events.filter((e) => e.type === 'intent' && e.kind === 'spec.patch');
    assert.equal(patches.filter((e) => e.type === 'intent' && e.kind === 'spec.patch' && e.expect.patch.by.role === 'planCheck').length, 1);
  });
});
