// dev.59 scope item 2: what a chargeable-bound park and a candidate base-red park offer the root, and that the paths a
// base-red item names work end to end. Fake-backed over unit-common arcs: real processes, real git.
// Named tests: items.chargeable-bound-reenters, items.base-red-ack-resume, items.base-red-steer.
import assert from 'node:assert/strict';
import { existsSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CommandOutcome,applyCommand } from '../src/commands/apply.ts';
import { submitCommand } from '../src/commands/queue.ts';
import type { CommandId,NeedsUserId } from '../src/core/ids.ts';
import type { CommandBody,NeedsUserContent } from '../src/core/records.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { bytesSha256 } from '../src/spec/spec.ts';
import { absPath } from '../src/core/values.ts';
import { SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { ADD_FIXED,type ArcRun,U1,codexStep,commandContextFor,contextFor,gateStep,mulBuild,outcomes,setupArc } from './fixtures/unit-common.ts';
import { commitAll,git,tmpDir,writeFiles } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };

async function command(r: ArcRun, body: CommandBody): Promise<Readonly<{ id: CommandId; outcome: CommandOutcome }>> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r), file) };
}

/** Raises the park's item, as the scheduler does. */
function raiseParked(r: ArcRun, content: NeedsUserContent): NeedsUserId {
  const f = r.journal.view.unit(U1).decided!;
  return raiseNeedsUser(r.journal, r.ctx.runDir, content, { type: 'stage', unit: U1, stage: f.stage, attempt: f.attempt });
}

const counted = (r: ArcRun) => {
  const { builds, judged } = r.journal.view.attemptCounts(U1);
  return `has run ${builds} of 16 builds and ${judged} of 40 judged stages`;
};

test('items.chargeable-bound-reenters: a gate revise at the chargeable bound parks; the item names a re-entry with reset, never a spec revision, and the lineage\'s attempts against the caps', T, async () => {
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'revise', directives: ['Document mul.'] })] });
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: { limits?: object }[] };
  plan.units[0]!.limits = { chargeable: 1 };
  writeFileSync(d.planPath, JSON.stringify(plan));
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'chargeable-bound', JSON.stringify(parked));
    const f = r.journal.view.unit(U1).decided!;
    assert.equal(f.stage, 'gate');
    const rec = parked.needsUser.recommendation;
    assert.ok(rec.includes(`"reenters": {"unit": "u1", "fixes": "u1/gate#${f.attempt}", "reset": {"reason":`), rec);
    assert.ok(!rec.includes('"rev"'), `a revision does not reset the count, so the item never offers one: ${rec}`);
    assert.ok(rec.includes(counted(r)), rec);
  } finally {
    r.journal.close();
  }
});

test('items.base-red-ack-resume: a candidate base-red names ack then resume; once the base is fixed, ack and resume re-run the candidate as a new attempt, uncharged, and it merges', T, async () => {
  const d = setupArc({ base: 'red', steps: [planCheckStep({ decision: 'approve' }), mulBuild(), gateStep({ decision: 'approve' })] });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'base-red', JSON.stringify(parked));
    const rec = parked.needsUser.recommendation;
    assert.ok(rec.includes('`roadmap resume u1` re-runs the candidate'), rec);
    assert.ok(rec.includes('`roadmap steer u1 --brief <file> --budget <min> --resume`'), rec);
    assert.ok(!rec.includes('"reenters"') && !rec.includes('is final'), `the env park is not final: ${rec}`);
    assert.ok(rec.includes(counted(r)), rec);
    const item = raiseParked(r, parked.needsUser);
    const attempt = r.journal.view.unit(U1).decided!.attempt;

    // The base is repaired on integration.
    writeFiles(d.repo, { 'src/add.js': ADD_FIXED });
    commitAll(d.repo, 'fix add');
    const tip = git(d.repo, 'rev-parse', 'main');
    assert.equal((await command(r, { type: 'ack', needsUser: item, choice: null })).outcome.kind, 'applied');
    assert.equal(r.journal.view.ackOf(item) !== null, true);
    const resumed = await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } });
    assert.equal(resumed.outcome.kind, 'applied', JSON.stringify(resumed.outcome));
    const seen = outcomes(d).length;
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(seen), ['candidate:green', 'ff:published', 'snapshot:published']);
    assert.ok(r.journal.view.opsOf('candidate.merge').some((i) => i.parent.type === 'stage' && i.parent.attempt > attempt), 'a new candidate attempt');
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 0, 'uncharged');
    assert.equal(git(d.repo, 'rev-parse', 'main^1'), tip, 'published onto the repaired base');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});

test('items.base-red-steer: a candidate red the unit\'s own run left on T reads as base-red; steer --resume gives one build round that fixes it, then lanes, gate and candidate, and it merges; ack closes the item', T, async () => {
  // The suite lane runs against an estate outside the repo: a unit tree holding src/leak.txt leaves the estate broken
  // (the marker), and a broken estate turns every tree red, T alone included.
  const mark = join(tmpDir('base-red-estate'), 'broken');
  const estate = { id: 'estate', argv: ['node', '-e', `const fs = require('node:fs'); const leak = fs.existsSync('src/leak.txt'); if (leak) fs.writeFileSync(${JSON.stringify(mark)}, 'x'); process.exit(leak || fs.existsSync(${JSON.stringify(mark)}) ? 1 : 0);`] };
  const brief = 'STEER: drop src/leak.txt; it leaves the estate broken.';
  const briefPath = absPath(join(tmpDir('base-red-brief'), 'brief.md'));
  writeFileSync(briefPath, brief);
  const d = setupArc({
    suite: [estate],
    steps: [
      planCheckStep({ decision: 'approve' }), mulBuild({ 'src/leak.txt': 'x\n' }), gateStep({ decision: 'approve' }),
      codexStep([{ type: 'commit', message: 'drop the leak', files: { 'src/leak.txt': null } }], { argv: ['exec', '-C'], argvLacks: ['resume'], stdinContains: [brief] }),
      gateStep({ decision: 'approve' }),
    ],
  });
  const r = contextFor(d);
  try {
    const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
    assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'base-red', JSON.stringify(parked));
    assert.ok(outcomes(d).includes('lanes:base-red'), outcomes(d).join(' '));
    const item = raiseParked(r, parked.needsUser);
    const before = r.journal.view.unit(U1).counters.chargeableFailures;

    rmSync(mark);
    const steered = await command(r, { type: 'steer', unit: U1, brief: { path: briefPath, sha256: bytesSha256(Buffer.from(brief)) }, budgetMin: 5, class: null, resume: true });
    assert.equal(steered.outcome.kind, 'applied', JSON.stringify(steered.outcome));
    assert.equal((await command(r, { type: 'ack', needsUser: item, choice: null })).outcome.kind, 'applied');
    const seen = outcomes(d).length;
    assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
    assert.deepEqual(outcomes(d).slice(seen), [
      'build:success', 'quiesce:empty', 'evidence:captured', 'salvage:committed', 'teardown:released', 'lanes:green', 'gate:approve',
      'candidate:green', 'ff:published', 'snapshot:published',
    ]);
    assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, before, 'the steer pass charges nothing');
    assert.ok(!existsSync(mark), 'the fixed unit leaves the estate whole');
    assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
  } finally {
    r.journal.close();
  }
});
