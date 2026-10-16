// Scope growth (2026-10-15): units started with scopes too narrow, and every fix cost a build, a park and a re-entry.
// Integrated and fake-backed over a unit-common arc (real git, real lanes):
//
// scope.accept: a plan-check's verified proposal holds the unit (`plan-check scope-growth`, a blocking `scope-growth` item,
//   unverifiable patterns dropped and named); `scope accept` lands one ruled revision (a new ruling naming exactly the
//   patterns, the plan and spec scope widened; nothing written into the owner's files, and a later apply of them rebases
//   onto the growth and changes nothing),
//   acknowledges the item and releases the hold; the unit re-opens at plan-check on the grown spec, whose dispatch check
//   re-pins the wider scope before any build, and the build's edit there is salvaged.
// scope.reject: the hold released, no revision; the plan-check runs again told what was rejected, and a proposal of the
//   rejected pattern no longer holds it. A decision on a unit not held is rejected.
// scope.hold-before-patch: a verified proposal holds the unit whatever its redirect patch: the patch is neither judged nor
//   sent to a repair turn (nothing else of a growth answer applies).
// scope.reverted-visible: an out-of-scope edit salvage reverts reaches the gate (<scope_reverted>) and the next fix round's
//   directives, with where its content is kept.
// scope.references-row: Phase-0 row 10 lists the files outside a unit's scope that name what its spec `removes`, as an
//   advisory, and the plan-check reads the same scan.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { readReceipt, submitCommand } from '../src/commands/queue.ts';
import type { Fact } from '../src/core/events.ts';
import { arcId, unitId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { absPath, branchName } from '../src/core/values.ts';
import { inForceFiles, readInputFiles, requirePlanInForce, revisionInForce } from '../src/input/inforce.ts';
import { APPLY, phase0InputOf, phase0Rows } from '../src/phase0/rows.ts';
import { dispatchOf, unitBranch } from '../src/pipeline/dispatch.ts';
import { type Gate, runUnit } from '../src/pipeline/unit.ts';
import { raiseResult } from '../src/schedule/scheduler.ts';
import { raisedFor } from '../src/needsuser.ts';
import { fakeDocs } from './fixtures/docs-fake.ts';
import { SCENARIO_TIMEOUT_MS, planCheckStep } from './fixtures/stage-common.ts';
import { followingContext, unitInForce } from './fixtures/steer-common.ts';
import { type ArcDescriptor, type ArcRun, MUL, U1, applyBody, codexStep, commandContextFor, contextFor, gateStep, mulBuild, outcomes, setupArc } from './fixtures/unit-common.ts';
import { git } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

/** The files in force (the run dir's kept inputs), as `roadmap inputs export` writes them. */
function inForceNow(r: ArcRun) {
  const inForce = requirePlanInForce(r.ctx.runDir, r.journal.view);
  return inForceFiles(r.ctx.runDir, r.journal.view, inForce, revisionInForce(r.ctx.runDir, inForce), absPath(r.d.planPath), absPath(r.d.repo));
}
const GROWTH = [{ patterns: ['package.json', 'nope/**', 'src/**'], reason: 'it names the script the shell page used' }];
const PACKAGE = '{\n  "name": "unit-fixture",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n';

/** Admits every stage but `stop`: the unit's task ends there, held. */
const until = (stop: string): Gate => async (next) => next.stage !== stop;

const specPath = (d: ArcDescriptor): string => join(dirname(d.planPath), 'u1.json');
function editSpec(d: ArcDescriptor, edit: (s: Record<string, unknown>) => void): void {
  const s = JSON.parse(readFileSync(specPath(d), 'utf8')) as Record<string, unknown>;
  edit(s);
  writeFileSync(specPath(d), JSON.stringify(s));
}

const facts = (d: ArcDescriptor): readonly Fact[] =>
  readJournal(absPath(d.runDir), arcId(d.arc)).events.flatMap((e) => (e.type === 'fact' ? [e.fact] : []));

/** The command context, with a docs publication standing in for the executor's (a new ruling re-renders constraints.md). */
const commandContext = (r: ArcRun) => ({ ...commandContextFor(r, followingContext(r)), docs: fakeDocs(r.journal, absPath(r.d.repo), branchName('main')) });

async function command(r: ArcRun, body: CommandBody) {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(commandContext(r), file) };
}

const decide = (decision: 'accept' | 'reject', reason: string): CommandBody => ({ type: 'scope-decide', unit: U1, decision, reason });

/** Runs u1 to its scope-growth hold and raises the hold's item as the scheduler does. */
async function holdU1(r: ArcRun) {
  const f = followingContext(r);
  const held = await runUnit(f, unitInForce(f, 'u1'), until('build'));
  assert.ok(held.kind === 'held' && held.needsUser?.reason === 'scope-growth', JSON.stringify(held));
  raiseResult(f, U1, held);
  return held.needsUser;
}

test('scope.accept: a verified proposal holds the unit; `scope accept` lands one ruled revision, nothing written into the owner\'s files, and the re-opened plan-check re-pins the wider scope before any build', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve', scopeGrowth: GROWTH }), planCheckStep({ decision: 'approve' }), mulBuild({ 'package.json': PACKAGE })] });
  editSpec(d, (s) => void (s['removes'] = ['src/add.js']));
  const owned = [d.planPath, specPath(d), join(dirname(d.planPath), 'rulings.md')].map((p) => readFileSync(p, 'utf8'));
  const r = contextFor(d);
  try {
    const item = await holdU1(r);
    assert.ok(item !== null);
    assert.equal(item.blocking, true);
    assert.match(item.summary, /proposes growing its scope by `package\.json` \(it names the script the shell page used\)/);
    assert.match(item.summary, /Code dropped: `nope\/\*\*`: matches no file at the integration tip [0-9a-f]{40}; `src\/\*\*`: already inside the scope envelope\./);
    assert.match(item.recommendation, /roadmap scope accept u1 --reason/);
    assert.deepEqual(outcomes(d), ['plan-check:scope-growth']);
    const u = r.journal.view.unit(U1);
    assert.equal(u.status, 'held');
    assert.deepEqual(u.interrupted?.detail, { kind: 'scope-growth', proposals: [{ patterns: ['package.json'], reason: 'it names the script the shell page used' }] });
    assert.deepEqual([u.counters.chargeableFailures, u.counters.redirects], [0, 0], 'a hold charges nothing');
    // The plan-check read the reference sweep's start: Phase-0 row 10 over the spec's removes.
    assert.ok(readCalls(d.scenarioPath)[0]!.stdin.includes('<scope_references>\n- `src/add.js` is still named by: ARCHITECTURE.md\n</scope_references>'));

    const accepted = await command(r, decide('accept', 'the test lives there'));
    assert.equal(accepted.outcome.kind, 'applied', JSON.stringify(accepted.outcome));
    const applied = r.journal.view.planAppliedBy(accepted.id);
    assert.ok(applied !== null);
    assert.deepEqual(applied.changes.map((c) => `${c.type}:${'unit' in c ? c.unit : ''}${c.type === 'spec' ? `:${c.edit}` : ''}`).sort(), ['spec:u1:revision', 'unit-changed:u1']);
    const inForce = inForceNow(r);
    assert.match(inForce.ledger.bytes!.toString('utf8'), /^C-2 — Unit u1's scope grows by `package\.json`: proposed by its plan-check \(it names the script the shell page used\), accepted by the root agent \(the test lives there\)\.$/m);
    assert.deepEqual(inForce.plan.units[0]!.scope, ['src/**', 'test/**', 'contracts/**', 'package.json'], 'the plan in force widened');
    const spec = JSON.parse(inForce.specs.get(U1)!.bytes!.toString('utf8')) as { rev: number; scope: string[]; cites: { rulings: string[] } };
    assert.deepEqual([spec.rev, spec.scope.includes('package.json'), spec.cites.rulings], [2, true, ['C-1', 'C-2']], 'the spec in force grown');
    assert.deepEqual([d.planPath, specPath(d), join(dirname(d.planPath), 'rulings.md')].map((p) => readFileSync(p, 'utf8')), owned, 'the owner\'s files are never written');
    const after = r.journal.view.unit(U1);
    assert.deepEqual([after.status, after.pendingRevision?.rev, after.scopeDecisions.map((x) => x.decision)], ['active', 2, ['accepted']]);
    const raised = raisedFor(r.journal.view, { type: 'stage', unit: U1, stage: 'plan-check', attempt: 1 });
    assert.ok(raised !== null);
    assert.equal(r.journal.view.ackOf(raised)?.command, accepted.id, 'the hold\'s item acknowledged by the command');
    assert.ok(facts(d).some((x) => x.kind === 'scope-decided' && x.command === accepted.id && x.decision === 'accepted'));
    const receipt = readReceipt(r.ctx.runDir, accepted.id, 'applied');
    assert.ok(receipt?.state === 'applied' && receipt.verified.some((v) => /scope grows by package\.json, ruled by C-2/.test(v)), JSON.stringify(receipt));

    // A later apply of the owner's files as they are changes nothing: rebased onto the growth, which it keeps.
    const again = await command(r, applyBody(d));
    assert.equal(again.outcome.kind, 'applied', JSON.stringify(again.outcome));
    assert.equal(r.journal.view.planApplied()?.rev, applied.rev);

    // The unit re-opens on rev 2; its plan-check re-pins the grown scope before any build, and the build's edit is kept.
    const f = followingContext(r);
    const ran = await runUnit(f, unitInForce(f, 'u1'), until('lanes'));
    assert.equal(ran.kind, 'held', JSON.stringify(ran));
    assert.deepEqual(outcomes(d), ['plan-check:scope-growth', 'plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released']);
    assert.ok((dispatchOf(r.journal.view, U1).scope as readonly string[]).includes('package.json'), 'the dispatch re-pinned');
    assert.equal(r.journal.view.unit(U1).spec?.rev, 2);
    assert.ok(readCalls(d.scenarioPath)[1]!.stdin.includes('<scope_envelope>\n- contracts/**\n- package.json\n- src/**\n- test/**\n</scope_envelope>'));
    assert.equal(git(d.repo, 'show', `${unitBranch(r.ctx.plan().arc, U1)}:package.json`), PACKAGE.trimEnd());
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('scope.reject: the hold released with no revision; the plan-check runs again told so, and the rejected pattern no longer holds it', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve', scopeGrowth: GROWTH }), planCheckStep({ decision: 'approve', scopeGrowth: GROWTH })] });
  const r = contextFor(d);
  try {
    await holdU1(r);
    const before = r.journal.view.planApplied()?.rev;
    const rejected = await command(r, decide('reject', 'the package file is the owner\'s'));
    assert.equal(rejected.outcome.kind, 'applied', JSON.stringify(rejected.outcome));
    assert.equal(r.journal.view.planApplied()?.rev, before, 'no revision');
    assert.deepEqual(r.journal.view.unit(U1).scopeDecisions.map((x) => [x.decision, x.reason]), [['rejected', 'the package file is the owner\'s']]);

    const f = followingContext(r);
    await runUnit(f, unitInForce(f, 'u1'), until('build'));
    assert.deepEqual(outcomes(d), ['plan-check:scope-growth', 'plan-check:approve'], 'the same proposal no longer holds the unit');
    assert.ok(readCalls(d.scenarioPath)[1]!.stdin.includes(
      '<rejected_scope_growth>\n- `package.json`: proposed because it names the script the shell page used; rejected because the package file is the owner\'s\n</rejected_scope_growth>',
    ));
    assert.ok(!(dispatchOf(r.journal.view, U1).scope as readonly string[]).includes('package.json'));

    const late = await command(r, decide('accept', 'too late'));
    assert.ok(late.outcome.kind === 'rejected' && /scope accept u1: the unit is active.*not held for a scope-growth proposal/.test(late.outcome.reason), JSON.stringify(late.outcome));
  } finally {
    r.journal.close();
  }
});

test('scope.hold-before-patch: a verified proposal holds the unit though its redirect patch would be refused: the patch is neither judged nor sent to a repair turn', T, async () => {
  // A cite of no ledger ruling and a strike of no clause: either alone is a refusal (the repair turn) outside a hold.
  const patch = [{ op: 'cite', contracts: [], rulings: ['C-99'] }, { op: 'strike', id: 'A9' }] as const;
  const d = setupArc({ steps: [planCheckStep({ decision: 'redirect', patch, scopeGrowth: GROWTH })] });
  const r = contextFor(d);
  try {
    await holdU1(r);
    assert.deepEqual(outcomes(d), ['plan-check:scope-growth']);
    assert.equal(readCalls(d.scenarioPath).length, 1, 'no repair turn');
    assert.equal(r.journal.view.unit(U1).spec?.rev, 1, 'nothing of the answer applied');
  } finally {
    r.journal.close();
  }
});

test('scope.reverted-visible: an out-of-scope edit salvage reverts reaches the gate and the next fix round, with where its content is kept', T, async () => {
  const dirty = codexStep([{ type: 'dirty', files: { 'package.json': PACKAGE } }, { type: 'commit', message: 'add mul', files: MUL }], { argv: ['exec', '-C'] });
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), dirty, gateStep({ decision: 'revise', directives: ['name the helper better'] }), codexStep([])] });
  const r = contextFor(d);
  try {
    let lanes = 0;
    const ran = await runUnit(r.ctx, r.unit('u1'), async (next) => next.stage !== 'lanes' || ++lanes < 2);
    assert.equal(ran.kind, 'held', JSON.stringify(ran));
    assert.deepEqual(outcomes(d).slice(0, 8), ['plan-check:approve', 'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:revise']);
    assert.equal(git(d.repo, 'show', `${unitBranch(r.ctx.plan().arc, U1)}:package.json`).includes('scripts'), false, 'salvage reverted the edit');
    const calls = readCalls(d.scenarioPath);
    assert.ok(calls[2]!.stdin.includes('<scope_reverted>\n- package.json\n</scope_reverted>'), 'the gate reads the reverted path');
    const fix = calls[3]!.stdin;
    const kept = new RegExp(`The executor reverted your edits to these paths after your last round, because they are outside the unit's pinned scope: package\\.json \\(your versions are kept under ${d.runDir.replaceAll('/', '\\/')}\\/rejected\\/u1\\/[0-9a-f]{64}\\/files\\)`);
    assert.match(fix, kept);
    assert.match(fix, /scope growth: <path>: <why the spec needs it>/);
    const keptDir = /kept under (\S+)\/files\)/.exec(fix)![1]!;
    assert.equal(readFileSync(join(keptDir, 'files', 'package.json'), 'utf8'), PACKAGE);
  } finally {
    r.journal.close();
  }
});

test('scope.references-row: Phase-0 row 10 lists, as an advisory, the files outside a unit\'s scope that name what its spec removes', T, () => {
  const d = setupArc({ steps: [] });
  const advisories = () => phase0Rows(phase0InputOf(readInputFiles(absPath(d.planPath), absPath(d.repo)), null), APPLY);
  assert.deepEqual(advisories().advisories, [], 'no removes, no advisory');
  editSpec(d, (s) => void (s['removes'] = ['src/add.js', '`add(a, b)`', 'NOT-NAMED-ANYWHERE']));
  const out = advisories();
  assert.deepEqual(out.rows, [], 'an advisory never refuses');
  assert.deepEqual(out.advisories, [{ kind: 'scope-references-outside', unit: unitId('u1'), removed: 'src/add.js', referrers: ['ARCHITECTURE.md'] }],
    'contracts/api.md names `add(a, b)` inside the scope; nothing names the third');
});
