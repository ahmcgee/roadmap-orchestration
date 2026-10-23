// The handover (src/pipeline/handover.ts; field feedback 2026-10-23 items 1, 2 and 4), integrated over real git, real lanes
// and the fake backends: a build call on a fresh session gets the handover, built from the records alone, and a resumed one
// does not. Each round kind: a re-entry's first build, a reopen that keeps its session (Claude `--resume <id>`), a reopen whose
// risk raise moves the seat (fresh), a resolve round after a conflicted re-entry, which goes back to its builder once when it
// committed only the merge while clauses are unmet. The steer round's handover is asserted in steer.test.ts.
// Named tests: handover.reentry, handover.reopen-keeps-session, handover.seat-move, handover.resolve-continues.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CommandOutcome, applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import { type UnitId, reviewFindingId, unitId } from '../src/core/ids.ts';
import type { CommandBody } from '../src/core/records.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { handoverOf } from '../src/pipeline/handover.ts';
import { loadUnitSpec } from '../src/pipeline/stages.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { NO_SESSION_NOTE, RESOLVE_DIRECTIVE, RESPEC_DIRECTIVE, RESPEC_FRESH_DIRECTIVE, resolveUnmetDirective } from '../src/prompts/directives.ts';
import { type Handover, handoverText } from '../src/prompts/inputs.ts';
import { parseRepoConfig } from '../src/routing/layers.ts';
import { commitAll, git } from './helpers/repo.ts';
import { type CallRecord, type ClaudeAct, type Step, readCalls } from './helpers/scenario.ts';
import { BUILD_REPORT, SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import { editPlan, editSpec } from './fixtures/route-common.ts';
import { addUnit } from './fixtures/sched-m3-common.ts';
import {
  type ArcRun, MUL, U1, appendSteps, applyBody, codexStep, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc, stepUntil, workDirPattern,
} from './fixtures/unit-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const live = (): Gate => admitAll;
const U2: UnitId = unitId('u2');
const NEW_CLAUSE = { id: 'A2', clause: 'mul(0, 5) is 0', failLoudIfUndelivered: true, state: 'active' };
const MUL_BROKEN = { ...MUL, 'src/mul.js': 'export function mul(a, b) {\n  return a + b;\n}\n' };
const MUL_ZERO_TEST = { 'test/mul-zero.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { mul } from '../src/mul.js';\n\ntest('mul zero', () => assert.equal(mul(0, 5), 0));\n" };

async function command(r: ArcRun, body: CommandBody): Promise<CommandOutcome> {
  return applyCommand(commandContextFor(r), submitCommand(r.ctx.runDir, r.ctx.plan().arc, body));
}

/** Runs u1 to its park and raises the park's item, as the scheduler would; the attempt that parked it. */
async function park(r: ArcRun): Promise<number> {
  const parked = await runUnit(r.ctx, r.unit('u1'), live());
  assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'escalation', JSON.stringify(parked));
  const f = r.journal.view.unit(U1).decided!;
  raiseNeedsUser(r.journal, r.ctx.runDir, parked.needsUser, { type: 'stage', unit: U1, stage: f.stage, attempt: f.attempt });
  return f.attempt;
}

/**
 * u2 re-entering u1 (parked at gate attempt `attempt`): u1's spec with A2 added and no decisions, applied. Returns the arc reopened
 * on the applied plan (a context's plan does not follow an apply); `r` is closed.
 */
async function reenter(r: ArcRun, attempt: number): Promise<ArcRun> {
  addUnit(r.d, 'u2');
  editSpec(r.d, 'u2', (s) => {
    s['acceptance'] = [...(s['acceptance'] as unknown[]), NEW_CLAUSE];
    s['decisions'] = [];
  });
  editPlan(r.d, (p) => Object.assign(p.units.find((u) => u['id'] === 'u2')!, { reenters: { unit: 'u1', fixes: `u1/gate#${attempt}` } }));
  const applied = await command(r, applyBody(r.d));
  assert.equal(applied.kind, 'applied', JSON.stringify(applied));
  r.journal.close();
  return contextFor(r.d);
}

/** The handover a fresh build of `unit` gets now, from the records (the attempt is any not yet started). */
const handoverNow = (r: ArcRun, unit: UnitId): Handover | null =>
  handoverOf(r.ctx, unit, loadUnitSpec(r.ctx, r.unit(unit)).spec, { type: 'stage', unit, stage: 'build', attempt: 999 });

/** The first line of any handover: its presence in a prompt, without naming its prose. */
const HANDOVER_OPENS = (h: Handover): string => handoverText(h).split('\n')[0]!;

const isBuildCall = (c: CallRecord): boolean => c.as === 'codex' || (c.argv[c.argv.indexOf('--json-schema') + 1] ?? '').includes('"changedPaths"');
const flag = (argv: readonly string[], name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

/** A Claude implementer round: `acts`, then the report. */
const claudeBuild = (acts: readonly ClaudeAct[], expect: Step['expect']): Step => ({ as: 'claude', expect, acts: [...acts, { type: 'emit', value: BUILD_REPORT }] });

test('handover.reentry: a re-entry\'s first build is a fresh session given the handover, every part read from the records of the unit it re-enters', T, async () => {
  const thread = '00000000-0000-4000-8000-0000000ab001';
  const decisions = JSON.stringify({ decisions: [{ id: 'D1', text: 'HANDOVER-DECISION: mul multiplies, never adds' }] });
  const fixReport = { ...BUILD_REPORT, summary: 'HANDOVER-SUMMARY: fixed mul', blockers: ['HANDOVER-BLOCKER: mul of floats unchecked'] };
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' })] });
  appendSteps(d, [
    // u1: a red build, a fix round (resumed) that fixes it and records a decision, a gate revise with a blocking finding, a
    // second fix round, then two escalations: the park.
    { ...codexStep([{ type: 'commit', message: 'add mul (broken)', files: MUL_BROKEN }], { argv: ['exec', '-C'] }), threadId: thread } as Step,
    {
      as: 'codex', expect: { argv: ['exec', 'resume', thread] },
      acts: [{ type: 'commit', message: 'fix mul', files: MUL }, { type: 'writeToPrompt', pattern: workDirPattern(d), file: 'decisions.json', text: decisions }, { type: 'emit', value: BUILD_REPORT }],
    },
    gateStep({ decision: 'revise', directives: ['HANDOVER-DIRECTIVE: test mul(0, n)'], findings: [{ severity: 'blocking', path: 'src/mul.js', text: 'HANDOVER-FINDING: mul(0, n) untested', contractRef: null, experiments: [], debt: null }] }),
    { as: 'codex', expect: { argv: ['exec', 'resume', thread] }, acts: [{ type: 'commit', message: 'more tests', files: { 'test/mul-two.test.js': MUL['test/mul.test.js'] } }, { type: 'emit', value: fixReport }] },
    gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
    // u2: plan-check, then the fresh build the test checks, then the gate.
    planCheckStep({ decision: 'approve' }),
    codexStep([{ type: 'commit', message: 'mul zero', files: MUL_ZERO_TEST }], { argv: ['exec', '-C'], argvLacks: ['resume'] }),
    gateStep({ decision: 'approve' }),
  ]);
  let r = contextFor(d);
  try {
    const attempt = await park(r);
    assert.equal(handoverNow(r, U1) === null, false, 'u1 has earlier builds');
    r = await reenter(r, attempt);
    await stepUntil(r, 'u2', (f) => f.stage === 'plan-check' && f.outcome === 'approve');

    const h = handoverNow(r, U2);
    assert.ok(h !== null);
    assert.deepEqual(h.lineage, [U2, U1]);
    assert.deepEqual(h.diagnosis.units.map((u) => u.unit), [U2, U1]);
    assert.ok(h.diagnosis.units[1]!.outcomes.some((o) => o.ref === `u1/gate#${attempt}`), 'the park, by the reference a re-entry cites');
    assert.deepEqual(h.diagnosis.units[1]!.lanes.map((l) => [l.class, l.ref.endsWith('/mul')]), [['red', true]]);
    assert.deepEqual(h.diagnosis.reentries, [{ unit: U2, reenters: U1, fixes: `u1/gate#${attempt}` }]);
    assert.deepEqual(h.gate, { unit: U1, attempt, decision: 'escalate', directives: [] });
    assert.deepEqual(h.findings, [{ id: reviewFindingId('R-1'), unit: U1, path: 'src/mul.js', defect: 'incorrect-behaviour', text: 'HANDOVER-FINDING: mul(0, n) untested' }]);
    assert.deepEqual(h.unmet, [{ clause: 'A2', text: 'mul(0, 5) is 0', why: 'new' }]);
    assert.deepEqual(h.witnesses, []);
    assert.deepEqual(h.decisions, [{ unit: U1, id: 'D1', text: 'HANDOVER-DECISION: mul multiplies, never adds', state: 'active' }]);
    assert.deepEqual([h.report?.unit, h.report?.summary, h.report?.blockers], [U1, fixReport.summary, fixReport.blockers]);
    assert.equal(h.evidence.length, 1);
    assert.ok(h.evidence[0]!.endsWith('/mul'), h.evidence[0]);

    assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), live()), { kind: 'merged' });
    const builds = readCalls(d.scenarioPath).filter(isBuildCall);
    const fresh = builds.at(-1)!;
    assert.notEqual(fresh.step, null, 'the re-entry\'s build was a fresh exec');
    assert.ok(fresh.stdin.includes(handoverText(h)), 'the handover, as built from the records');
    for (const resumed of builds.slice(1, 3)) assert.ok(!resumed.stdin.includes(HANDOVER_OPENS(h)), 'a resumed session gets no handover');
    assert.ok(!builds[0]!.stdin.includes(HANDOVER_OPENS(h)), 'the lineage\'s first build has nothing to hand over');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('handover.reopen-keeps-session: a reopen resumes the kept implementer session by id (Claude `--resume <id>`), told the spec was amended, with no handover', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      claudeBuild([{ type: 'commit', message: 'add mul', files: MUL }], { argv: ['--permission-mode', 'bypassPermissions', '--session-id'], argvLacks: ['--resume'] }),
      gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
      planCheckStep({ decision: 'approve' }),
      claudeBuild([{ type: 'commit', message: 'mul zero', files: MUL_ZERO_TEST }], { argv: ['--permission-mode', 'bypassPermissions', '--resume'], argvLacks: ['--session-id'], stdinContains: [RESPEC_DIRECTIVE, 'mul(0, 5) is 0'] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  // build.med on frontier: the implementer is Claude.
  const r = contextFor({ ...d, config: parseRepoConfig({ routing: { seats: { build: { med: 'frontier' } } } }) });
  try {
    await park(r);
    editSpec(d, 'u1', (s) => {
      s['acceptance'] = [...(s['acceptance'] as unknown[]), NEW_CLAUSE];
      s['rev'] = 2;
    });
    assert.equal((await command(r, applyBody(d))).kind, 'applied');
    assert.equal((await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } })).kind, 'applied');
    await stepUntil(r, 'u1', (f) => f.stage === 'plan-check' && f.outcome === 'approve');
    const h = handoverNow(r, U1);
    assert.ok(h !== null, 'a fresh session would get one');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });

    const [first, reopened] = readCalls(d.scenarioPath).filter(isBuildCall);
    assert.ok(first !== undefined && reopened !== undefined);
    const kept = flag(first.argv, '--session-id');
    assert.ok(kept !== undefined);
    assert.equal(flag(reopened.argv, '--resume'), kept, 'the reopen resumes the session the first build was launched with');
    assert.ok(!reopened.stdin.includes(HANDOVER_OPENS(h)) && !reopened.stdin.includes(NO_SESSION_NOTE));
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('handover.seat-move: a reopen whose plan-check moves the implementer seat to another model builds fresh, given the handover and the fresh respec directive', T, async () => {
  const thread = '00000000-0000-4000-8000-0000000ab002';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      { ...mulBuild(), threadId: thread } as Step,
      gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
      planCheckStep({ decision: 'approve', risk: 'high' }),
      claudeBuild([{ type: 'commit', message: 'mul zero', files: MUL_ZERO_TEST }], {
        argv: ['--permission-mode', 'bypassPermissions', '--session-id'], argvLacks: ['--resume'], stdinContains: [RESPEC_FRESH_DIRECTIVE, NO_SESSION_NOTE],
      }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor({ ...d, config: parseRepoConfig({ routing: { seats: { build: { high: 'frontier' } } } }) });
  try {
    const attempt = await park(r);
    editSpec(d, 'u1', (s) => {
      s['acceptance'] = [...(s['acceptance'] as unknown[]), NEW_CLAUSE];
      s['rev'] = 2;
    });
    assert.equal((await command(r, applyBody(d))).kind, 'applied');
    assert.equal((await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } })).kind, 'applied');
    await stepUntil(r, 'u1', (f) => f.stage === 'plan-check' && f.outcome === 'approve');
    const h = handoverNow(r, U1);
    assert.ok(h !== null);
    assert.deepEqual([h.lineage, h.gate?.decision, h.gate?.attempt, h.unmet], [[U1], 'escalate', attempt, [{ clause: 'A2', text: 'mul(0, 5) is 0', why: 'new' }]]);
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    const moved = readCalls(d.scenarioPath).filter(isBuildCall).at(-1)!;
    assert.equal(moved.as, 'claude');
    assert.ok(moved.stdin.includes(handoverText(h)));
    assert.ok(!moved.stdin.includes(RESPEC_DIRECTIVE), 'no directive claims the earlier work as the fresh session\'s own');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('handover.resolve-continues: a resolve round after a conflicted re-entry that commits only the merge while a clause is unmet goes back to its builder once, then on the normal path', T, async () => {
  const thread = '00000000-0000-4000-8000-0000000ab003';
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'escalate' }), gateStep({ decision: 'escalate' }),
      // u2: the resolve round, fresh with the handover; it commits the merge only.
      { ...codexStep([{ type: 'commit', message: 'resolve the merge', files: { 'src/mul.js': MUL['src/mul.js'] } }], { argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: [RESOLVE_DIRECTIVE, NO_SESSION_NOTE] }), threadId: thread } as Step,
      // Its continuation: the same session, told which clause is still unmet.
      codexStep([{ type: 'commit', message: 'mul zero', files: MUL_ZERO_TEST }], { argv: ['exec', 'resume', thread], stdinContains: [resolveUnmetDirective([{ clause: 'A2', text: 'mul(0, 5) is 0' }])] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  let r = contextFor(d);
  try {
    const attempt = await park(r);
    // Integration moves on with a conflicting mul.
    writeFileSync(join(d.repo, 'src', 'mul.js'), 'export function mul(a, b) {\n  return b * a; // main\n}\n');
    commitAll(d.repo, 'integration moves on');
    assert.equal(git(d.repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    r = await reenter(r, attempt);
    const h = handoverNow(r, U2);
    assert.ok(h !== null);
    assert.deepEqual(h.unmet, [{ clause: 'A2', text: 'mul(0, 5) is 0', why: 'new' }]);
    assert.deepEqual(await runUnit(r.ctx, r.unit('u2'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d, 'u2').slice(0, 2), ['prepare:conflicted', 'build:success'], 'one build outcome for the two calls');
    const builds = readCalls(d.scenarioPath).filter(isBuildCall);
    const [resolve, continued] = builds.slice(-2);
    assert.ok(resolve !== undefined && continued !== undefined);
    assert.ok(resolve.stdin.includes(handoverText(h)), 'the fresh resolve round lists the unmet clause in its handover');
    assert.ok(!continued.stdin.includes(HANDOVER_OPENS(h)), 'the continuation resumes the session: no handover');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'the continuation resumed the resolve round\'s session');
    const spawns = r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'build' && i.expect.subject.unit === U2);
    assert.equal(new Set(spawns.map((s) => s.parent.type === 'stage' ? s.parent.attempt : null)).size, 1, 'both calls are invocations of one attempt');
  } finally {
    r.journal.close();
  }
});
