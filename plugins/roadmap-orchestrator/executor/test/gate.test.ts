// The gate stage (src/pipeline/gate.ts) through the unit driver, fake-backed: real processes, real git.
// Named tests: gate.fingerprint-invalidated, gate.risk-promotion; also the approval fingerprint's content,
// a revise round's directives and their re-check with the round handoff, the fingerprint's cited-only set, and
// the empty-diff refusal. M3 step A3: gate.inputs-not-in-ff-window (the capture under the revision fence),
// gate.obligations-selected, plan-check.vision-context. M3 Checkpoint A: gate.no-cpu-fence-deadlock,
// gate.approval-captured-fingerprint, gate.partial-supersession-regates. 2026-10-16 (the read surface widened; a refused read
// voids nothing): gate.read-surface, plan-check.read-surface. 2026-10-16 (prompt_too_long): context-exceeded.gate,
// context-exceeded.plan-check, context-exceeded.build. dev.12: gate.repair-turn; the large-diff gate: gate.large-diff,
// gate.large-diff-seat, gate.cluster-coverage. dev.13: gate.acting-checkout. dev.16: gate.symlink-in-checkout.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { applyCommand, evaluateRevision, keepRevision, payloadOf } from '../src/commands/apply.ts';
import { holdFence } from '../src/core/fence.ts';
import { holderUnits, resourceTable } from '../src/resources/reserve.ts';
import { reached, release } from './helpers/barrier.ts';
import { type Wired, publishArc, ruleRecord, submitRule, wire } from './fixtures/publish-common.ts';
import { rulingId } from '../src/core/ids.ts';
import { gateDiffShownOf, gateLargeDiffOf } from '../src/core/upgrade.ts';
import type { JsonValue } from '../src/core/json.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath, repoPath } from '../src/core/values.ts';
import { CHANGED_LIST, CLUSTER_PATHS_SHOWN, gateAnswerFor } from '../src/pipeline/gate.ts';
import { ACTING_JUDGE_TOOLS, writeDenyRules } from '../src/backends/argv.ts';
import { FILES_DIR, readManifest } from '../src/git/evidence.ts';
import { evidenceRoot, verificationWorktree } from '../src/pipeline/dispatch.ts';
import { promptFor } from '../src/prompts/index.ts';
import { clusterCoverage } from '../src/prompts/schemas.ts';
import { laneRevOf, parseObligations } from '../src/holistic/types.ts';
import { commitRevisionNow, readInputFiles } from '../src/input/inforce.ts';
import { invocationDir } from '../src/pipeline/invoke.ts';
import { runUnit, step } from '../src/pipeline/unit.ts';
import { git, tmpDir } from './helpers/repo.ts';
import { type CallRecord, type Step, readCalls } from './helpers/scenario.ts';
import { events } from './fixtures/invoke-specs.ts';
import { SCENARIO_TIMEOUT_MS, admitAll, planCheckStep } from './fixtures/stage-common.ts';
import type { Gate } from '../src/pipeline/unit.ts';
import { type ArcDescriptor, MUL, U1, codexStep, contextFor, gateRepairStep, gateStep, isGateCall as isGate, mulBuild, outcomes, setupArc, stepUntil } from './fixtures/unit-common.ts';
import { BASE, editPlan, followContext, planDirOf, recordFirst, stepTo, unitOf } from './fixtures/route-common.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
/** Every stage admitted at once: the unit runs on its own. */
const live = (): Gate => admitAll;
const sessionOf = (c: CallRecord): string => c.argv[c.argv.indexOf('--session-id') + 1]!;

test('gate.fingerprint-invalidated: a contract changes on T between approve and ff; the unit is re-gated in a fresh session and published', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const first = r.journal.view.unit(U1).approval!;
    const tip = first.fingerprint.contractRevs;
    // The fingerprint: blob ids at the gated tip, sorted by path; every cited ruling at rev 1.
    assert.deepEqual(tip.map((c) => c.path), ['ARCHITECTURE.md', 'contracts/api.md']);
    for (const c of tip) assert.equal(c.blob, git(d.repo, 'rev-parse', `main:${c.path}`));
    assert.deepEqual(first.fingerprint.rulingRevs, [{ id: rulingId('C-1'), rev: 1 }]);

    writeFileSync(join(d.repo, 'contracts', 'api.md'), '# API contract\n\n`add(a, b)` returns the sum; `mul(a, b)` the product.\n');
    git(d.repo, 'commit', '--quiet', '-am', 'the contract changes on integration');
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(9), ['ff:fingerprint-invalid', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
    const gates = readCalls(d.scenarioPath).filter(isGate);
    assert.equal(gates.length, 2);
    assert.notEqual(sessionOf(gates[0]!), sessionOf(gates[1]!), 'the re-gate is a fresh session');
    assert.ok(gates.every((g) => !g.argv.includes('--resume')));
    assert.ok(gates[1]!.stdin.includes('the product'), 'the re-gate read the changed contract');
    const approvals = events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'approval' ? [e.fact] : []));
    assert.equal(approvals.length, 2);
    assert.notDeepEqual(approvals[0]!.fingerprint.contractRevs, approvals[1]!.fingerprint.contractRevs);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'an invalidated approval charges nothing');
  } finally {
    r.journal.close();
  }
});

test('gate.fingerprint-cited-only: the approval binds the spec\'s cited contracts and rulings; an uncited contract changing on T does not re-gate', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const specFile = join(dirname(d.planPath), 'u1.json');
  writeFileSync(specFile, JSON.stringify({ ...JSON.parse(readFileSync(specFile, 'utf8')), cites: { contracts: [], rulings: [] } }));
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'candidate' && f.outcome === 'green');
    const { fingerprint } = r.journal.view.unit(U1).approval!;
    assert.deepEqual(fingerprint.contractRevs.map((c) => c.path), ['ARCHITECTURE.md'], 'the architecture doc always, no uncited contract');
    assert.deepEqual(fingerprint.rulingRevs, []);
    writeFileSync(join(d.repo, 'contracts', 'api.md'), '# API contract\n\nChanged, but no spec cites it.\n');
    git(d.repo, 'commit', '--quiet', '-am', 'an uncited contract changes on integration');
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.ok(!outcomes(d).includes('ff:fingerprint-invalid'), 'the approval still holds');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 1);
  } finally {
    r.journal.close();
  }
});

test('gate.risk-promotion: a contract path in the unit\'s diff promotes the gate dispatch to the escalation seat', T, async () => {
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild({ 'contracts/api.md': '# API contract\n\nAlso `mul(a, b)`.\n' }),
      // W3: the escalation seat's preface says why the gate sits there.
      gateStep({ decision: 'approve' }, { stdinContains: ['<escalation>', 'A runtime risk trigger'] }),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'salvage');
    assert.equal(outcomes(d).at(-1), 'salvage:committed-contract-touched');
    assert.equal(r.journal.view.unit(U1).promotion, true);
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const [planCall, , gateCall] = readCalls(d.scenarioPath);
    assert.ok(planCall!.argv.includes('claude-opus-5-5') && planCall!.argv.includes('medium'), 'plan-check sat on the unit\'s med seat (frontier: Opus medium, dev.17)');
    assert.ok(gateCall!.argv.includes('xhigh'), 'the gate sat on the escalation seat');
    assert.ok(!planCall!.stdin.includes('<escalation>'), 'no preface below the escalation seat');
    assert.equal(r.journal.view.unit(U1).promotion, false, 'the promotion was for that dispatch only');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('gate.revise: the directives go to a fix round, and the next gate rules on its prior round with the delta since', T, async () => {
  const directive = 'Export mul as the default export too.';
  const finding = { severity: 'blocking', path: 'src/mul.js', text: 'mul has no default export.', contractRef: 'contracts/api.md', experiments: [], debt: null };
  const premises = [
    { claim: 'mul multiplies', evidence: [{ path: 'src/mul.js', line: 2 }] },
    { claim: 'add is untouched', evidence: [{ path: 'src/add.js', line: 1 }] },
  ];
  const d = setupArc({
    steps: [
      planCheckStep({ decision: 'approve' }),
      mulBuild(),
      gateStep({ decision: 'revise', directives: [directive], findings: [finding], premises }),
      codexStep([{ type: 'commit', message: 'default export', files: { 'src/mul.js': `${MUL['src/mul.js']}export default mul;\n` } }], { argv: ['exec', 'resume'], stdinContains: [directive] }),
      gateStep({ decision: 'approve' }, {
        stdinContains: [
          directive, '[blocking] src/mul.js: mul has no default export. (contracts/api.md)', 'mul multiplies [src/mul.js:2]',
          'Paths the fix changed since:\n- src/mul.js\n', 'Premise files changed since:\n- src/mul.js\nRules',
        ],
      }),
    ],
  });
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.deepEqual(result, { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(6, 16), [
      'lanes:green', 'gate:revise', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve', 'candidate:green',
    ]);
    const u = r.journal.view.unit(U1).counters;
    assert.equal(u.reviseRounds, 1);
    assert.equal(u.chargeableFailures, 1);
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null), 'the fix round and the second gate saw the directive');
  } finally {
    r.journal.close();
  }
});

test('gate.empty-diff: a unit whose branch adds nothing is refused at the gate without a judgment call, and parks', T, async () => {
  const d = setupArc({ units: [{ id: 'u1', lanes: [] }], steps: [planCheckStep({ decision: 'approve' }), codexStep([], { argv: ['exec', '-C'] })] });
  const r = contextFor(d);
  try {
    const result = await runUnit(r.ctx, r.unit('u1'), live());
    assert.equal(result.kind, 'parked');
    assert.ok(result.kind === 'parked');
    assert.equal(result.needsUser.reason, 'empty-diff');
    assert.equal(outcomes(d).at(-1), 'gate:empty-diff');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 0);
    // A parked unit stays parked: the next step reports it and runs nothing.
    const again = await step(r.ctx, r.unit('u1'));
    assert.equal(again.kind, 'parked');
    assert.ok(again.kind === 'parked');
    assert.equal(again.needsUser.reason, 'empty-diff');
  } finally {
    r.journal.close();
  }
});

// Paid M4b run 5: a gate Globbed the evidence root above its --add-dirs and was refused. Since 2026-10-16 the judge's read
// surface is the repository and the run dir (dispatch.ts `judgmentReadDirs`), named in its system text (`judgmentSurface`), and
// a refused read is recorded, voiding nothing.
const deniedGate = () => gateStep({ decision: 'approve' }, {}, [{ type: 'globAboveAddDir' }]);
const addDirs = (c: CallRecord): readonly string[] => c.argv.flatMap((t, i) => (c.argv[i - 1] === '--add-dir' ? [t] : []));

test('gate.repair-turn (dev.12): an answer off the gate\'s schema goes back once in its own session with why; the repaired answer is the attempt\'s; refused again, the attempt is malformed', T, async () => {
  const offSchema: Step = { as: 'claude', expect: {}, acts: [{ type: 'emit', value: { decision: 'approve', findings: [], directives: [], reasons: ['A1 holds'] } }] };
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), offSchema, gateRepairStep({ decision: 'approve' }, ['premises'])] });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d).filter((o) => o.startsWith('gate:')), ['gate:approve'], 'no malformed attempt: the repair turn settled it');
    const [fresh, repair] = readCalls(d.scenarioPath).filter(isGate);
    assert.equal(repair!.argv[repair!.argv.indexOf('--resume') + 1], sessionOf(fresh!), 'the repair turn resumes the refused answer\'s session');
    assert.equal(r.journal.view.unit(U1).counters.retries.gate, 0);
  } finally {
    r.journal.close();
  }
  const twice = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), offSchema, { ...offSchema, expect: { argv: ['--resume'] } }, gateStep({ decision: 'approve' })] });
  const r2 = contextFor(twice);
  try {
    assert.deepEqual(await runUnit(r2.ctx, r2.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(twice).filter((o) => o.startsWith('gate:')), ['gate:malformed', 'gate:approve'], 'refused again: malformed, and the retry is a fresh gate');
  } finally {
    r2.journal.close();
  }
});

test('gate.acting-checkout (dev.13): the gate is an acting judge with no MCP server, in its own detached checkout of the salvage SHA, removed once its call is read with what it wrote kept as evidence', T, async () => {
  const experiment = { 'probe-mul.mjs': "import { mul } from './src/mul.ts';\nconsole.log(mul(2, 3));\n" };
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }, {}, [{ type: 'dirty', files: experiment }])] });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    const gate = readCalls(d.scenarioPath).filter(isGate)[0]!;
    const after = (flag: string): string | undefined => gate.argv[gate.argv.indexOf(flag) + 1];
    // The acting-judge profile (argv.ts `claude-acting-judge`): a shell, bypassPermissions, project settings, no MCP server.
    assert.equal(after('--tools'), ACTING_JUDGE_TOOLS);
    assert.equal(after('--permission-mode'), 'bypassPermissions');
    assert.equal(after('--setting-sources'), 'project');
    assert.ok(gate.argv.includes('--strict-mcp-config') && !gate.argv.includes('--mcp-config'), 'no MCP server');
    assert.ok(!gate.argv.includes('--system-prompt') && !gate.argv.includes('--no-session-persistence'), 'its text is appended; its session persists');
    assert.equal(after('--append-system-prompt'), promptFor('gate', after('--model') as 'claude-sonnet-5-5').system, 'the module\'s system text, appended as it stands');
    assert.deepEqual(addDirs(gate).slice(0, 2), [d.repo, d.runDir], 'the judgment read surface');
    // Its Write, Edit and NotebookEdit are denied the repository and the run dir (Bash stays trusted to the prompt).
    const rules = gate.argv.slice(gate.argv.indexOf('--disallowedTools') + 1, gate.argv.indexOf('--permission-mode'));
    assert.deepEqual(rules, writeDenyRules([absPath(d.repo), absPath(d.runDir)]));
    // Its cwd: the attempt's own checkout, detached at the salvage SHA the lanes certified, never the verification checkout.
    const view = r.journal.view;
    const attempt = view.unit(U1).approval!.attempt;
    const plan = r.ctx.plan();
    assert.equal(gate.cwd, join(plan.worktreeRoot, plan.arc, `u1.gate-${attempt}`));
    const created = view.opsOf('worktree.create').find((i) => i.expect.path === gate.cwd)!;
    assert.ok(created !== undefined && view.doneOf(created.op) !== null, 'code made the checkout');
    assert.deepEqual(created.parent, { type: 'stage', unit: U1, stage: 'gate', attempt });
    const verify = view.opsOf('worktree.create').filter((i) => i.parent.type === 'stage' && i.parent.stage === 'lanes'
      && i.expect.path === verificationWorktree(plan.worktreeRoot, plan.arc, U1, i.parent.attempt)).at(-1)!;
    assert.notEqual(gate.cwd, verify.expect.path);
    assert.deepEqual(created.expect.checkout, { type: 'detached', at: view.unit(U1).approval!.fingerprint.unitCommit });
    assert.deepEqual(created.expect.checkout, verify.expect.checkout, 'the same commit the lanes ran at');
    // Removed by code once the call was read, citing a snapshot that kept the experiment the gate wrote.
    const removed = view.opsOf('worktree.remove').find((i) => i.expect.path === gate.cwd)!;
    assert.ok(removed !== undefined && view.doneOf(removed.op) !== null && !existsSync(gate.cwd), 'the checkout is gone');
    assert.deepEqual(removed.parent, created.parent);
    const kept = join(evidenceRoot(absPath(d.runDir), { type: 'stage', unit: U1, stage: 'gate', attempt }), `u1.gate-${attempt}`, FILES_DIR, 'probe-mul.mjs');
    assert.equal(readFileSync(kept, 'utf8'), experiment['probe-mul.mjs']);
    // The transitions are unchanged: an approve, then the candidate.
    assert.deepEqual(outcomes(d).filter((o) => o.startsWith('gate:') || o.startsWith('candidate:')), ['gate:approve', 'candidate:green']);
  } finally {
    r.journal.close();
  }
});

test('gate.symlink-in-checkout (dev.16): a symlink the gate leaves in its checkout is named on the snapshot, not captured, and the checkout is still removed', T, async () => {
  // The field case (gate-23): `node_modules -> <another checkout>/node_modules` crashed the removal's snapshot every generation.
  const target = tmpDir('gate-link-target');
  const experiment = { 'probe-mul.mjs': 'console.log(6);\n' };
  const d = setupArc({
    steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }, {}, [{ type: 'dirty', files: experiment }, { type: 'symlink', path: 'node_modules', target }])],
  });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    const gate = readCalls(d.scenarioPath).filter(isGate)[0]!;
    const view = r.journal.view;
    const removed = view.opsOf('worktree.remove').find((i) => i.expect.path === gate.cwd)!;
    assert.ok(removed !== undefined && view.doneOf(removed.op) !== null && !existsSync(gate.cwd), 'the checkout is gone');
    const snap = view.latestIntent(removed.expect.evidence);
    assert.ok(snap.kind === 'evidence.snapshot');
    assert.deepEqual(snap.expect.notRegular, ['node_modules']);
    assert.deepEqual(readManifest(snap.expect.dest)?.files.map((f) => f.path), ['probe-mul.mjs'], 'the experiment kept, the link not');
    assert.ok(existsSync(target), 'the link\'s target untouched');
  } finally {
    r.journal.close();
  }
});

test('gate.read-surface: the gate reads the repository and the run dir; an approve from a session refused a read is an approval, the refusal on record', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), deniedGate()] });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d).filter((o) => o.startsWith('gate:')), ['gate:approve']);
    const gate = readCalls(d.scenarioPath).filter(isGate)[0]!;
    const dirs = addDirs(gate);
    assert.deepEqual(dirs.slice(0, 2), [d.repo, d.runDir], 'the repository and the run dir lead the read surface');
    assert.ok(dirs.slice(2).every((x) => !x.startsWith(`${d.runDir}/`) && !x.startsWith(`${d.repo}/`)), `no dir inside them is named again: ${dirs.join(' ')}`);
    // dev.13: the gate's text is appended to Claude Code's default prompt, which names the --add-dir dirs itself, so the
    // executor adds no <readable_directories> list (a read-only judgment's --system-prompt does).
    const system = gate.argv[gate.argv.indexOf('--append-system-prompt') + 1]!;
    assert.ok(!system.includes('<readable_directories>'), system.slice(-600));
    // The refusal is on record in the call's reads.json, for audit.
    const inv = events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'meter' && e.fact.subject.type === 'seat' && e.fact.subject.role === 'gate' ? [e.fact.inv] : []))[0]!;
    const reads = JSON.parse(readFileSync(join(invocationDir(absPath(d.runDir), inv), 'reads.json'), 'utf8')) as { denied: unknown[] };
    assert.deepEqual(reads.denied, [{ tool: 'Glob', pattern: '**/*', path: dirname(dirname(d.repo)) }]);
    assert.equal(r.journal.view.unit(U1).counters.retries.gate, 0);
  } finally {
    r.journal.close();
  }
});

// 2026-10-16: a call whose prompt or context outgrew the model's window parks its unit, uncharged, operator env, with no
// probe target and no backend park; the item names the role, the call and the prompt's size.
const stageOutcome = (d: ArcDescriptor, stage: string) => events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'stage-outcome' && e.fact.stage === stage ? [e.fact] : [])).at(-1)!;
const backendParks = (d: ArcDescriptor) => events(d.runDir).filter((e) => e.type === 'fact' && e.fact.kind === 'backend-park');

function assertContextPark(d: ArcDescriptor, r: ReturnType<typeof contextFor>, result: Awaited<ReturnType<typeof runUnit>>, stage: string, role: string): void {
  assert.ok(result.kind === 'parked', JSON.stringify(result));
  assert.equal(result.needsUser.reason, 'context-exceeded');
  const f = stageOutcome(d, stage);
  assert.equal(f.outcome, 'context-exceeded');
  assert.deepEqual(f.park, { class: 'operator', kind: 'env' }, 'operator env: no probe, so no repeat rule');
  assert.equal(f.chargeable, false);
  assert.ok(f.detail?.kind === 'context-exceeded' && f.detail.promptBytes > 0, JSON.stringify(f.detail));
  assert.match(result.needsUser.summary, new RegExp(`The ${role} call ${f.detail.inv.replace(/[#/]/g, '.')} outgrew the model's context window: its prompt was ${f.detail.promptBytes} bytes\\.`));
  assert.match(result.needsUser.recommendation, new RegExp(`roadmap resume u1\` re-runs ${stage}, uncharged`));
  assert.deepEqual(backendParks(d), [], 'the backend is not parked');
  assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0);
}

test('context-exceeded.gate: a gate prompt over the model\'s window parks the unit (env, uncharged), naming the gate call and its size', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }, {}, [{ type: 'contextExceeded' }])] });
  const r = contextFor(d);
  try {
    assertContextPark(d, r, await runUnit(r.ctx, r.unit('u1'), live()), 'gate', 'gate');
    assert.equal(r.journal.view.unit(U1).approval, null);
  } finally {
    r.journal.close();
  }
});

test('context-exceeded.plan-check: a plan-check prompt over the window parks before any build', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }, {}, [{ type: 'contextExceeded' }])] });
  const r = contextFor(d);
  try {
    assertContextPark(d, r, await runUnit(r.ctx, r.unit('u1'), live()), 'plan-check', 'planCheck');
    assert.ok(!outcomes(d).some((o) => o.startsWith('build:')), 'no build ran');
  } finally {
    r.journal.close();
  }
});

test('context-exceeded.build: a Codex build over its context window parks the same way', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), codexStep([{ type: 'contextExceeded' }], { argv: ['exec', '-C'] })] });
  const r = contextFor(d);
  try {
    assertContextPark(d, r, await runUnit(r.ctx, r.unit('u1'), live()), 'build', 'build');
  } finally {
    r.journal.close();
  }
});

test('plan-check.read-surface: the plan-check reads the repository and the run dir; an approve from a session refused a read is an approval', T, async () => {
  const deniedCheck = planCheckStep({ decision: 'approve' }, {}, [{ type: 'globAboveAddDir' }]);
  const d = setupArc({ steps: [deniedCheck, mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), live()), { kind: 'merged' });
    assert.deepEqual(outcomes(d).filter((o) => o.startsWith('plan-check:')), ['plan-check:approve']);
    const check = readCalls(d.scenarioPath).find((c) => c.as === 'claude' && !isGate(c))!;
    assert.deepEqual(addDirs(check).slice(0, 2), [d.repo, d.runDir]);
    assert.equal(r.journal.view.unit(U1).counters.retries['plan-check'], 0);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// M3 step A3: judgment inputs under the revision fence; the obligations and the vision a judgment reads

const judgmentInputs = (d: ReturnType<typeof setupArc>, stage: string) =>
  events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'judgment-inputs' && e.fact.stage === stage ? [e.fact] : []));
const straightToGate = () => [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })];

test('gate.inputs-not-in-ff-window: while a revision holds the fence the gate neither captures its inputs nor calls; it then reads the revision that committed', T, async () => {
  const d = setupArc({ steps: straightToGate() });
  recordFirst(d);
  const r = contextFor(d);
  const ctx = followContext(r);
  try {
    await stepTo(ctx, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
    const hold = await holdFence(r.journal);
    const gating = step(ctx, unitOf(ctx, 'u1'));
    await sleep(2_000);
    // Checkpoint A: the capture precedes the `@cpu` entry, so the waiting gate holds nothing and has journaled nothing.
    assert.equal(r.journal.view.unit(U1).open, null, 'the gate attempt has not started: it takes @cpu only after its capture');
    assert.deepEqual(holderUnits(r.journal.view, { type: 'stage', unit: U1, stage: 'gate', attempt: r.journal.view.unit(U1).counters.attempts + 1 }), []);
    assert.deepEqual(judgmentInputs(d, 'gate'), [], 'no judgment-inputs while the fence is held');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 0, 'no gate call while the fence is held');

    // A harmless revision commits while the fence is held: a new unit u2, plan rev 2.
    const u1Spec = JSON.parse(readFileSync(join(planDirOf(d), 'u1.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(planDirOf(d), 'u2.json'), JSON.stringify({ ...u1Spec, unit: 'u2' }));
    editPlan(d, (p) => void p.units.push({ ...p.units[0]!, id: 'u2', spec: 'u2.json' }));
    const rctx = { runDir: r.ctx.runDir, view: r.journal.view, hostDir: r.ctx.hostDir, planFile: absPath(d.planPath), routingBase: BASE, laneEnv: process.env };
    const v = evaluateRevision(rctx, readInputFiles(absPath(d.planPath), absPath(d.repo)), { type: 'apply' });
    assert.ok(v.kind === 'accepted', JSON.stringify(v));
    keepRevision(r.ctx.runDir, v);
    commitRevisionNow(r.journal, r.ctx.runDir, payloadOf(v.draft, { type: 'start' }), { type: 'arc' });
    assert.equal(r.journal.view.planApplied()?.rev, 2);
    hold.release();

    assert.equal((await gating).kind, 'continue');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const inputs = judgmentInputs(d, 'gate');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.planRev, 2, 'the gate captured the plan the revision committed');
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 1);
  } finally {
    r.journal.close();
  }
});

const VISION = {
  schema: 'roadmap/vision-m3', rev: 1, confirmation: null, clauses: [
    { id: 'V-1', kind: 'purpose', text: 'Multiply numbers in one call.', rank: null, state: 'active' },
    { id: 'V-2', kind: 'non-negotiable', text: 'Never lose a digit.', rank: null, state: 'active' },
    { id: 'V-3', kind: 'world', text: 'A developer multiplies any two numbers in one call and trusts every digit.', rank: null, state: 'active' },
  ],
  questions: [],
};
const JOURNEY = { id: 'journey', argv: ['node', '-e', '0'], cwd: '.', env: { set: {}, pass: ['PATH'] }, expectedExit: 0, tier: 'fast', resources: [], evidenceGlobs: [], reporter: 'jsonl' };
const LANE_REV = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'x', lanes: [JOURNEY], obligations: [], mapping: { paths: [] } }).lanes[0]!);
function obligation(id: string, statement: string): Record<string, unknown> {
  return {
    id, rev: 1, statement, docRef: { path: 'ARCHITECTURE.md', anchor: 'Architecture', quotedText: 'One module' }, serves: ['V-1'],
    witness: { lane: 'journey', testIds: [`t-${id}`] }, proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev: LANE_REV, witness: { lane: 'journey', testIds: [`t-${id}`] } },
    deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' },
  };
}
const OBLIGATIONS = {
  schema: 'roadmap/obligations-m3', cutLine: 'the arc ends when mul ships', lanes: [JOURNEY],
  obligations: [obligation('I-1', 'mul multiplies.'), obligation('I-2', 'add stays fixed.')],
  mapping: { paths: [{ pattern: 'docs/**', obligations: ['I-1'] }] },
};

/** A holistic arc over u1: its vision and obligations in force from revision 1, as an M3 first start records them. */
function holisticArc(): ReturnType<typeof setupArc> {
  const d = setupArc({ steps: straightToGate() });
  writeFileSync(join(planDirOf(d), 'vision.json'), JSON.stringify(VISION));
  writeFileSync(join(planDirOf(d), 'obligations.json'), JSON.stringify(OBLIGATIONS));
  editPlan(d, (p) => void (p['holistic'] = { vision: 'vision.json', advances: ['V-1', 'V-2', 'V-3'], obligations: 'obligations.json' }));
  recordFirst(d);
  return d;
}

test('gate.obligations-selected: in a holistic arc the gate prompt lists the obligations the diff selects and the approval fingerprint carries their revs; outside one the fingerprint has no obligationRevs', T, async () => {
  const d = holisticArc();
  const r = contextFor(d);
  try {
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    // The diff's paths (src/mul.js, test/mul.test.js) map to no obligation: every must-hold one is selected.
    const [g] = readCalls(d.scenarioPath).filter(isGate);
    assert.ok(g!.stdin.includes('- I-1 (rev 1; must-hold; active): mul multiplies.'), g!.stdin);
    assert.ok(g!.stdin.includes('- I-2 (rev 1; must-hold; active): add stays fixed.'));
    assert.deepEqual(r.journal.view.unit(U1).approval?.fingerprint.obligationRevs, [{ id: 'I-1', rev: 1 }, { id: 'I-2', rev: 1 }]);
  } finally {
    r.journal.close();
  }

  const plain = setupArc({ steps: straightToGate() });
  recordFirst(plain);
  const p = contextFor(plain);
  try {
    await stepTo(followContext(p), 'u1', (f) => f.stage === 'gate');
    const fingerprint = p.journal.view.unit(U1).approval?.fingerprint;
    assert.ok(fingerprint !== undefined);
    assert.ok(!('obligationRevs' in fingerprint), 'no obligationRevs key outside a holistic arc');
  } finally {
    p.journal.close();
  }
});

test('gate.bounded-diff: the gate reads its diff as the bounded attachment (orientation, inlined diffs, what the unit claims), its files dir readable, and judgment-inputs records what it inlined', T, async () => {
  const d = setupArc({ steps: straightToGate() });
  recordFirst(d);
  const r = contextFor(d);
  try {
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    const [g] = readCalls(d.scenarioPath).filter(isGate);
    assert.match(g!.stdin, /<orientation>\nDiff [0-9a-f]{40}\.\.[0-9a-f]{40}\. Files named below are readable with Read\.\nStat:\n src\/mul\.js/);
    assert.match(g!.stdin, /Claimed by the unit \(stated in full above\): acceptance A1[^;]*; witness items none; obligations none\n<\/orientation>\n<diff>\n/);
    assert.match(g!.stdin, /<pasted_content id="[0-9a-f]{8}">\ndiff --git a\/src\/mul\.js b\/src\/mul\.js/);
    assert.ok(!g!.stdin.includes('<not_inlined>'), 'a small diff is inlined whole');
    const addDirs = g!.argv.flatMap((a, i) => (g!.argv[i - 1] === '--add-dir' ? [a] : []));
    const attempt = Number(new RegExp(`- ${d.runDir}/evidence/u1/(\\d+)-gate/diff\\n`).exec(g!.stdin)?.[1]);
    assert.ok(attempt > 0 && addDirs.includes(d.runDir), `the attachment's dir is readable, inside the run dir: ${addDirs.join(', ')}`);
    assert.match(g!.stdin, new RegExp(`<evidence_dirs>[^<]*- ${d.runDir}/evidence/u1/${attempt}-gate/diff\\n[^<]*</evidence_dirs>`), 'and listed with the evidence');
    const inputs = r.journal.view.judgmentInputs(U1, 'gate', attempt)!;
    assert.deepEqual(inputs.diffShown, { inlined: ['src/mul.js', 'test/mul.test.js'], notInlined: [] });
    assert.deepEqual(gateDiffShownOf(inputs), inputs.diffShown);
    // A dev.11 executor's gate recorded none: read as nothing recorded (scaffolding).
    const { diffShown: _, ...dev11 } = inputs;
    assert.deepEqual(gateDiffShownOf(dev11), { inlined: [], notInlined: [] });
    // Under the large-diff threshold: the unit's own seat (med: frontier, Opus medium since dev.17), the plain prompt, no map.
    assert.equal(inputs.largeDiff, null);
    assert.ok(g!.argv.includes('claude-opus-5-5') && g!.argv.includes('medium'), 'a small diff keeps the unit\'s seat');
    assert.ok(!g!.stdin.includes('<large_diff>'), 'and the plain prompt');
  } finally {
    r.journal.close();
  }
});

test('plan-check.vision-context: in a holistic arc the plan-check prompt carries the vision clauses in force; the gate prompt does not', T, async () => {
  const d = holisticArc();
  const r = contextFor(d);
  try {
    await stepTo(followContext(r), 'u1', (f) => f.stage === 'gate');
    const calls = readCalls(d.scenarioPath);
    const check = calls[0]!;
    assert.ok(check.as === 'claude' && !isGate(check));
    assert.ok(check.stdin.includes([
      'Vision revision 1', 'V-3 (world): A developer multiplies any two numbers in one call and trusts every digit.',
      'V-1 (purpose): Multiply numbers in one call.', 'V-2 (non-negotiable): Never lose a digit.', 'This arc advances: V-1, V-2, V-3',
    ].join('\n')), check.stdin);
    const [g] = calls.filter(isGate);
    for (const text of ['Multiply numbers in one call.', 'Never lose a digit.', 'Vision revision']) assert.ok(!g!.stdin.includes(text), `the gate prompt carries "${text}"`);
  } finally {
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// M3 Checkpoint A: one acquisition order (the fence, then @cpu); the approval records the fingerprint it captured;
// a partial supersession of a cited ruling re-gates.

/** Wakes the arbiter as the scheduler's loop does, so a released `@cpu` is granted to its next waiter. */
function ticking(w: Wired): () => void {
  const timer = setInterval(() => w.arbiter.wake(), 50);
  return () => clearInterval(timer);
}

/** Resolves with `p`, or fails the test when it has not settled within `ms` (a deadlock never settles). */
async function within<V>(p: Promise<V>, ms: number, what: string): Promise<V> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not settled within ${ms} ms (deadlocked)`)), ms);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const approvals = (d: ArcDescriptor) => events(d.runDir).flatMap((e) => (e.type === 'fact' && e.fact.kind === 'approval' ? [e.fact] : []));

test('gate.no-cpu-fence-deadlock: @cpu capacity 2, a gate and a rule whose docs lane needs both tokens race for the fence; both finish', T, async () => {
  // The gate's `@cpu`×1 and a fast lane's ×2 cannot run together: a gate holding its token while it waits for the
  // fence the rule holds through its docs publication (whose lane waits for @cpu) would deadlock.
  const d = publishArc({ steps: straightToGate() }, (a) => editPlan(a, (p) => {
    p['capacity'] = { cpu: 2 };
    p.units[0]!['cpu'] = 2;
  }));
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
    const hold = await holdFence(r.journal);
    // The rule queues on the fence first, then the gate.
    const ruling = applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2')));
    await sleep(1_500);
    const gating = step(w.stage, r.unit('u1'));
    await sleep(1_500);
    assert.equal(r.journal.view.unit(U1).open, null, 'the gate waits for the fence before its @cpu entry');
    assert.deepEqual([...resourceTable(r.journal.view).values()].filter((e) => e.status.state !== 'free'), [], 'nothing holds @cpu while both wait for the fence');
    hold.release();
    const [outcome, gated] = await within(Promise.all([ruling, gating]), 120_000, 'the rule and the gate');
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    assert.equal(gated.kind, 'continue');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    assert.equal(judgmentInputs(d, 'gate')[0]!.planRev, 2, 'the gate captured the revision the rule committed');
    assert.deepEqual(r.journal.view.openIntents(), []);
  } finally {
    stop();
    r.journal.close();
  }
});

test('gate.approval-captured-fingerprint: a docs-only rule superseding a cited ruling while the gate runs: the approval binds the ruling it judged, and ff re-gates', T, async () => {
  const d = publishArc({
    steps: [
      planCheckStep({ decision: 'approve' }), mulBuild(),
      gateStep({ decision: 'approve' }, {}, [{ type: 'barrier', name: 'gate', timeoutMs: 120_000 }]),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes' && f.outcome === 'green');
    const gating = step(w.stage, r.unit('u1'));
    await reached(d.scenarioDir, 'gate', 120_000);
    // While the gate's session runs: C-2 fully supersedes the cited C-1 (no contract op: no fingerprinted blob moves).
    const outcome = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2', { supersedes: [{ id: 'C-1', part: null }] })));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    release(d.scenarioDir, 'gate');
    assert.equal((await gating).kind, 'continue');
    assert.equal(outcomes(d).at(-1), 'gate:approve');
    const [first] = approvals(d);
    assert.deepEqual(first!.fingerprint.rulingRevs, [{ id: rulingId('C-1'), rev: 1 }], 'the approval binds the ruling the gate judged');
    assert.deepEqual(judgmentInputs(d, 'gate')[0]!.fingerprint, first!.fingerprint, 'exactly the fingerprint captured with the inputs');
    assert.deepEqual(await runUnit(w.stage, r.unit('u1'), live()), { kind: 'merged' });
    assert.ok(outcomes(d).includes('ff:fingerprint-invalid'), outcomes(d).join(' '));
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 2, 'the approval did not publish without a re-gate');
    assert.deepEqual(approvals(d)[1]!.fingerprint.rulingRevs, [], 'the re-gate binds the ledger in force');
  } finally {
    stop();
    r.journal.close();
  }
});

test('gate.partial-supersession-regates: an approved unit citing C-1; C-2 partially supersedes C-1; ff re-gates and the new approval binds C-1 at rev 2', T, async () => {
  const d = publishArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' }), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  const w = wire(r);
  const stop = ticking(w);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
    assert.deepEqual(r.journal.view.unit(U1).approval!.fingerprint.rulingRevs, [{ id: rulingId('C-1'), rev: 1 }]);
    const outcome = await applyCommand(w.commands, submitRule(r, ruleRecord(r, 'C-2', { supersedes: [{ id: 'C-1', part: 'where helpers are tested' }] })));
    assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
    assert.deepEqual(await runUnit(w.stage, r.unit('u1'), live()), { kind: 'merged' });
    assert.ok(outcomes(d).includes('ff:fingerprint-invalid'), outcomes(d).join(' '));
    assert.equal(readCalls(d.scenarioPath).filter(isGate).length, 2);
    assert.deepEqual(approvals(d).map((a) => a.fingerprint.rulingRevs), [[{ id: rulingId('C-1'), rev: 1 }], [{ id: rulingId('C-1'), rev: 2 }]]);
  } finally {
    stop();
    r.journal.close();
  }
});

// ---------------------------------------------------------------------------------------------------
// The large-diff gate (1.0.0-dev.12)

/** Generated sources too large to inline together: 40 new files of ~8 KB each under src/gen/ (the gate's budget is 128 KiB). */
const BIG: Readonly<Record<string, string>> = Object.fromEntries(Array.from({ length: 40 }, (_, f) => [
  `src/gen/table-${f.toString().padStart(2, '0')}.js`,
  Array.from({ length: 160 }, (_, i) => `export const t${f}_${i.toString().padStart(4, '0')} = ${f * 1000 + i}; // generated row\n`).join(''),
]));
/** A cluster map covering MUL and BIG exactly once. */
const COVERING: readonly JsonValue[] = [
  { id: 'generated', paths: ['src/gen/**'], review: 'description' },
  { id: 'mul', paths: ['src/mul.js', 'test/'], review: 'close' },
];

test('gate.large-diff: at low risk a diff over the threshold seats the gate on high, renders the large-diff method, records the threshold, and a map missing a path takes the repair turn naming it', T, async () => {
  const d = setupArc({
    units: [{ id: 'u1', risk: 'low' }],
    steps: [
      planCheckStep({ decision: 'approve', risk: 'low' }),
      mulBuild(BIG),
      gateStep({ decision: 'approve', clusters: [COVERING[0]!] }, { stdinContains: ['<large_diff>'] }),
      gateRepairStep({ decision: 'approve', clusters: COVERING }, ['2 paths in no cluster: src/mul.js, test/mul.test.js']),
    ],
  });
  const r = contextFor(d);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(d).at(-1), 'gate:approve', 'the repaired map covers every path');
    const [fresh] = readCalls(d.scenarioPath).filter(isGate);
    assert.ok(fresh!.argv.includes('claude-opus-5-5') && !fresh!.argv.includes('xhigh'), `the gate sat on the high seat (frontier), not escalation: ${fresh!.argv.join(' ')}`);
    const attempt = r.journal.view.unit(U1).decided!.attempt;
    const inputs = r.journal.view.judgmentInputs(U1, 'gate', attempt)!;
    assert.ok(inputs.largeDiff !== null && inputs.largeDiff !== undefined && inputs.largeDiff.overflow > 0, `largeDiff recorded: ${JSON.stringify(inputs.largeDiff)}`);
    assert.deepEqual(gateLargeDiffOf(inputs), inputs.largeDiff);
    const list = `${d.runDir}/evidence/u1/${attempt}-gate/diff/${CHANGED_LIST}`;
    assert.ok(fresh!.stdin.includes(list), 'the prompt names the list of paths the map covers');
    assert.deepEqual(readFileSync(list, 'utf8').split('\n').filter((l) => l !== ''), [...Object.keys(BIG), ...Object.keys(MUL)].sort());
    assert.ok(fresh!.stdin.includes(`${inputs.largeDiff.overflow} of its files did not fit`), 'the section carries the overflow');
    // The seat follows from the recorded inputs: a dev.11 gate recorded none, read as under the threshold (scaffolding).
    const { largeDiff: _, ...dev11 } = inputs;
    assert.equal(gateLargeDiffOf(dev11), null);
  } finally {
    r.journal.close();
  }
});

test('gate.large-diff-seat: at med risk the large diff seats the gate on high; a pending risk promotion keeps the escalation seat', T, async () => {
  const med = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(BIG), gateStep({ decision: 'approve', clusters: COVERING }, { stdinContains: ['<large_diff>'] })] });
  const r = contextFor(med);
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(med).at(-1), 'gate:approve');
    const [g] = readCalls(med.scenarioPath).filter(isGate);
    assert.ok(g!.argv.includes('claude-opus-5-5') && !g!.argv.includes('xhigh'), `med moved to high: ${g!.argv.join(' ')}`);
  } finally {
    r.journal.close();
  }
  const contract = { 'contracts/api.md': '# API contract\n\nAlso `mul(a, b)`.\n' };
  const covering = [...COVERING, { id: 'contract', paths: ['contracts/api.md'], review: 'close' }];
  const promoted = setupArc({
    steps: [planCheckStep({ decision: 'approve' }), mulBuild({ ...BIG, ...contract }), gateStep({ decision: 'approve', clusters: covering }, { stdinContains: ['<large_diff>', '<escalation>'] })],
  });
  const p = contextFor(promoted);
  try {
    await stepUntil(p, 'u1', (f) => f.stage === 'gate');
    assert.equal(outcomes(promoted).at(-1), 'gate:approve');
    const [g] = readCalls(promoted.scenarioPath).filter(isGate);
    assert.ok(g!.argv.includes('xhigh'), 'the escalation seat stays');
  } finally {
    p.journal.close();
  }
});

describe('gate.cluster-coverage: the large-diff answer\'s cluster map against the diff\'s paths', () => {
  const answer = (clusters: JsonValue): JsonValue => ({ decision: 'approve', findings: [], directives: [], reasons: ['A1 holds'], premises: [], unreviewed: [], clusters });
  const paths = ['packages/a/src/x.ts', 'packages/a/src/y.ts', 'packages/b/[id].tsx', 'README.md'].map((p) => repoPath(p));
  const large = { overflow: 2 };
  const refused = (f: () => unknown, pattern: RegExp): void => {
    assert.throws(f, (e: unknown) => e instanceof SchemaError && pattern.test(e.message));
  };

  it('valid: exact paths, directories and globs, each path in one cluster', () => {
    const out = gateAnswerFor(large, paths)(answer([
      { id: 'a', paths: ['packages/a/src/*.ts'], review: 'description' }, { id: 'b', paths: ['packages/b/[id].tsx'], review: 'close' }, { id: 'docs', paths: ['README.md'], review: 'routine' },
    ]));
    assert.deepEqual(out.clusters?.map((c) => c.id), ['a', 'b', 'docs']);
    assert.deepEqual(clusterCoverage(out.clusters!, paths), { uncovered: [], duplicated: [] });
  });

  it('missing: the paths no cluster covers are named', () => {
    refused(() => gateAnswerFor(large, paths)(answer([{ id: 'a', paths: ['packages/a/'], review: 'routine' }])), /2 paths in no cluster: packages\/b\/\[id\]\.tsx, README\.md/);
  });

  it('duplicate: a path in two clusters is named with both', () => {
    refused(() => gateAnswerFor(large, paths)(answer([
      { id: 'all', paths: ['**'], review: 'routine' }, { id: 'a', paths: ['packages/a/src/x.ts'], review: 'close' },
    ])), /1 paths in more than one: packages\/a\/src\/x\.ts \(all, a\)/);
  });

  it('a long list is cut to CLUSTER_PATHS_SHOWN and counted', () => {
    const many = Array.from({ length: CLUSTER_PATHS_SHOWN + 5 }, (_, i) => repoPath(`src/f${i.toString().padStart(3, '0')}.ts`));
    refused(() => gateAnswerFor(large, many)(answer([{ id: 'none', paths: ['docs/'], review: 'routine' }])), new RegExp(`${many.length} paths in no cluster: [^;]* and 5 more`));
  });

  it('threshold: a map is required over it and refused under it; under it null passes', () => {
    refused(() => gateAnswerFor(large, paths)(answer(null)), /a cluster map covering each of the diff's 4 changed paths/);
    refused(() => gateAnswerFor(null, [])(answer([{ id: 'a', paths: ['**'], review: 'routine' }])), /null: the diff fit/);
    assert.equal(gateAnswerFor(null, [])(answer(null)).clusters, null);
  });
});
