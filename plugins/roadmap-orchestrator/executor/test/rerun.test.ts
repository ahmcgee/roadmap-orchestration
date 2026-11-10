// `roadmap rerun` (dev.59; src/commands/rerun.ts, the fold's `lanes-rerun`, stages.ts `lanes`), integrated and fake-backed over a
// unit-common arc whose spec lane `estate` is red on the unit's tree while a marker file outside the repo is missing (the estate
// it runs against) and green once it exists; it passes on the base, so a repeat red there is the unit's (`regression`).
// Named tests: rerun.green-from-fix-decision, rerun.red-parks-resume-restores, rerun.from-bound-park, rerun.bound-red-resume-refused,
// rerun.rejections, rerun.fold-validates, rerun.crash-cells.
import assert from 'node:assert/strict';
import { existsSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe,test } from 'node:test';
import { type CommandOutcome,applyCommand } from '../src/commands/apply.ts';
import { readReceipt,submitCommand } from '../src/commands/queue.ts';
import { type Event,type Fact,prevHash,serializeEvent } from '../src/core/events.ts';
import { type CommandId,arcId,commandId,laneId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import type { CommandBody } from '../src/core/records.ts';
import { fold } from '../src/core/state.ts';
import { absPath } from '../src/core/values.ts';
import { raiseNeedsUser } from '../src/needsuser.ts';
import { unitBranch,verificationWorktree } from '../src/pipeline/dispatch.ts';
import { runUnit } from '../src/pipeline/unit.ts';
import { recover } from '../src/recover/recover.ts';
import { revParse } from '../src/git/git.ts';
import { SCENARIO_TIMEOUT_MS,admitAll,planCheckStep } from './fixtures/stage-common.ts';
import { type ArcDescriptor,type ArcRun,MUL_LANE,U1,codexStep,commandContextFor,contextFor,gateStep,mulBuild,outcomes,setupArc,stepUntil,unitWorktreePath } from './fixtures/unit-common.ts';
import { assertFired,writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { commitAll,tmpDir,writeFiles } from './helpers/repo.ts';
import { readCalls } from './helpers/scenario.ts';
import { RERUN,crashCells } from './matrix.ts';

const T = { timeout: SCENARIO_TIMEOUT_MS };
const EVIDENCE = 'staging db was down 10:02-10:40 (ops ticket 41)';

type Estate = Readonly<{ d: ArcDescriptor; mark: string }>;

/** An arc whose u1 lane `estate` needs `mark` (outside the repo) once mul exists; `limits` override u1's bounds. */
function estateArc(steps: Parameters<typeof setupArc>[0]['steps'], limits?: Readonly<Record<string, number>>): Estate {
  const mark = join(tmpDir('rerun-estate'), 'up');
  const estate = { id: 'estate', argv: ['node', '-e', `const fs = require('node:fs'); process.exit(fs.existsSync('src/mul.js') && !fs.existsSync(${JSON.stringify(mark)}) ? 1 : 0);`] };
  const d = setupArc({ steps: [planCheckStep({ decision: 'approve' }), mulBuild(), ...steps], units: [{ id: 'u1', lanes: [MUL_LANE, estate] }], suite: [] });
  if (limits !== undefined) {
    const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { units: { limits?: object }[] };
    plan.units[0]!.limits = limits;
    writeFileSync(d.planPath, JSON.stringify(plan));
  }
  return { d, mark };
}

const rerunBody = (attempt: number, o: Partial<Extract<CommandBody, { type: 'rerun' }>> = {}): CommandBody =>
  ({ type: 'rerun', unit: U1, attempt, lane: laneId('estate'), cause: 'estate', evidence: EVIDENCE, ...o });

async function command(r: ArcRun, body: CommandBody): Promise<Readonly<{ id: CommandId; outcome: CommandOutcome }>> {
  const file = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
  return { id: file.id, outcome: await applyCommand(commandContextFor(r), file) };
}

const rejected = (o: CommandOutcome): string => {
  assert.equal(o.kind, 'rejected', JSON.stringify(o));
  return o.kind === 'rejected' ? o.reason : '';
};

/** Raises the park's item, as the scheduler does; returns its id. */
function raiseParked(r: ArcRun, needsUser: Parameters<typeof raiseNeedsUser>[2]) {
  const f = r.journal.view.unit(U1).decided!;
  return raiseNeedsUser(r.journal, r.ctx.runDir, needsUser, { type: 'stage', unit: U1, stage: f.stage, attempt: f.attempt });
}

const builds = (d: ArcDescriptor) => readCalls(d.scenarioPath).filter((c) => c.as === 'codex').length;
const tipOf = (r: ArcRun) => revParse(r.ctx.repo, unitBranch(r.ctx.plan().arc, U1));
const lanesAttempt = (r: ArcRun): number => r.journal.view.unit(U1).decided!.attempt;
const counters = (r: ArcRun) => {
  const c = r.journal.view.unit(U1).counters;
  return { chargeableFailures: c.chargeableFailures, unchargedLanesReds: c.unchargedLanesReds, candidateReds: c.candidateReds, reviseRounds: c.reviseRounds };
};

describe('rerun command', () => {
  test('rerun.green-from-fix-decision: a lanes red (a fix round decided) is waived; the lanes run again at the same commit in a fresh checkout, no build; green goes on to the gate and merges; the charge stands', T, async () => {
    const { d, mark } = estateArc([gateStep({ decision: 'approve' })]);
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      const red = r.journal.view.unit(U1).decided!;
      assert.deepEqual([red.outcome, red.chargeable], ['red', false], 'the first red is uncharged under the certification allowance');
      const before = { counters: counters(r), attempts: r.journal.view.attemptCounts(U1), builds: builds(d), tip: tipOf(r) };
      const { id, outcome } = await command(r, rerunBody(red.attempt));
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
      const [fact] = r.journal.view.holistic().lanesReruns;
      assert.deepEqual(fact && { ...fact, seq: 0 }, {
        unit: U1, command: id, attempt: red.attempt, lane: 'estate', at: before.tip, cause: 'estate', evidence: EVIDENCE,
        by: { role: 'root', routingRev: commandContextFor(r).routing(null).resolved.rev }, seq: 0,
      });
      const u = r.journal.view.unit(U1);
      assert.deepEqual([u.status, u.entry?.kind, u.rerun?.waived.attempt], ['active', 'rerun', red.attempt]);
      assert.ok(readReceipt(r.ctx.runDir, id, 'applied')?.state === 'applied');

      writeFileSync(mark, 'up\n');
      const seen = outcomes(d).length;
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.deepEqual(outcomes(d).slice(seen), ['lanes:green', 'gate:approve', 'candidate:green', 'ff:published', 'snapshot:published']);
      assert.equal(builds(d), before.builds, 'no build ran');
      const after = r.journal.view.attemptCounts(U1);
      assert.equal(after.builds, before.attempts.builds, 'the build cap is untouched');
      assert.equal(after.judged, before.attempts.judged + 2, 'the rerun\'s lanes and the gate count as judged stages');
      assert.deepEqual(counters(r), before.counters, 'the waived red\'s charge stands; the rerun charges nothing');
      // A fresh checkout: the waived attempt's stable checkout was removed by the rerun's attempt before it ran.
      const rerunParent = { type: 'stage', unit: U1, stage: 'lanes', attempt: red.attempt + 1 } as const;
      const stable = verificationWorktree(r.ctx.plan().worktreeRoot, r.ctx.plan().arc, U1);
      assert.ok(r.journal.view.opsOfParent('worktree.remove', rerunParent).some((i) => i.expect.path === stable), 'the stable checkout was discarded');
      assert.ok(r.journal.view.opsOfParent('worktree.create', rerunParent).some((i) => i.expect.path === stable && i.expect.checkout.type === 'detached' && i.expect.checkout.at === before.tip));
      assert.ok(readCalls(d.scenarioPath).every((c) => c.step !== null));
    } finally {
      r.journal.close();
    }
  });

  test('rerun.red-parks-resume-restores: a red rerun parks rerun-red, uncharged and with no fix round; the same lane at the same head is refused; resume restores the waived fix round', T, async () => {
    const { d } = estateArc([codexStep([], { argv: ['exec', 'resume'] })]);
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      const red = r.journal.view.unit(U1).decided!;
      const before = { counters: counters(r), builds: builds(d) };
      assert.equal((await command(r, rerunBody(red.attempt))).outcome.kind, 'applied');
      const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
      assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'rerun-red', JSON.stringify(parked));
      assert.match(parked.needsUser.recommendation, /roadmap resume u1` ends the rerun and restores lanes#\d+'s decision/);
      assert.equal(outcomes(d).at(-1), 'lanes:rerun-red');
      const park = r.journal.view.unit(U1).decided!;
      assert.deepEqual([park.class, park.chargeable, park.park], ['park', false, { class: 'operator', kind: 'env' }]);
      assert.deepEqual(counters(r), before.counters);
      assert.equal(builds(d), before.builds, 'no fix round');
      const item = raiseParked(r, parked.needsUser);

      const again = await command(r, rerunBody(park.attempt));
      assert.match(rejected(again.outcome), /reruns at most once per head/);
      assert.match(rejected((await command(r, rerunBody(park.attempt, { lane: laneId('mul') }))).outcome), /lane mul did not run red/);

      const resumed = await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } });
      assert.equal(resumed.outcome.kind, 'applied', JSON.stringify(resumed.outcome));
      assert.equal(r.journal.view.ackOf(item)?.command, resumed.id);
      const u = r.journal.view.unit(U1);
      assert.deepEqual([u.status, u.rerun, u.entry, u.decided?.attempt], ['active', null, null, red.attempt], 'the waived decision is back');
      await stepUntil(r, 'u1', (f) => f.stage === 'build');
      assert.equal(builds(d), before.builds + 1, 'the waived fix round ran');
      assert.match(rejected((await command(r, rerunBody(red.attempt))).outcome), /not unit u1's latest decision/);
    } finally {
      r.journal.close();
    }
  });

  test('rerun.from-bound-park: a red at the chargeable bound is rerun from its park; green goes on to the gate, the bound park\'s item closed by the command', T, async () => {
    const { d, mark } = estateArc([gateStep({ decision: 'approve' })], { chargeable: 1, certifications: 1 });
    const r = contextFor(d);
    try {
      const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
      assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'chargeable-bound', JSON.stringify(parked));
      assert.match(parked.needsUser.recommendation, /roadmap rerun u1\/lanes#\d+\/<lane> --cause estate\|infra --evidence <line>/, 'a lanes red offers the rerun');
      const item = raiseParked(r, parked.needsUser);
      const red = r.journal.view.unit(U1).decided!;
      const { id, outcome } = await command(r, rerunBody(red.attempt, { cause: 'infra' }));
      assert.equal(outcome.kind, 'applied', JSON.stringify(outcome));
      assert.equal(r.journal.view.ackOf(item)?.command, id);
      assert.equal(r.journal.view.unit(U1).status, 'active');
      writeFileSync(mark, 'up\n');
      assert.deepEqual(await runUnit(r.ctx, r.unit('u1'), admitAll), { kind: 'merged' });
      assert.equal(r.journal.view.unit(U1).counters.chargeableFailures, 1, 'the bound\'s charge stands');
    } finally {
      r.journal.close();
    }
  });

  test('rerun.bound-red-resume-refused: a red rerun of a bound park parks rerun-red; resume is refused, the bound park standing, with the re-entry it needs', T, async () => {
    const { d } = estateArc([], { chargeable: 1, certifications: 1 });
    const r = contextFor(d);
    try {
      await runUnit(r.ctx, r.unit('u1'), admitAll);
      const red = r.journal.view.unit(U1).decided!;
      assert.equal((await command(r, rerunBody(red.attempt))).outcome.kind, 'applied');
      const parked = await runUnit(r.ctx, r.unit('u1'), admitAll);
      assert.ok(parked.kind === 'parked' && parked.needsUser.reason === 'rerun-red', JSON.stringify(parked));
      assert.match(parked.needsUser.recommendation, /resume u1` is refused: lanes#\d+'s park stands/);
      const reason = rejected((await command(r, { type: 'resume', target: { type: 'unit', unit: U1 } })).outcome);
      assert.match(reason, new RegExp(`lanes#${red.attempt}'s park \\(chargeable-bound\\) stands`));
      assert.match(reason, new RegExp(`"fixes": "u1/lanes#${red.attempt}"`));
      assert.equal(r.journal.view.unit(U1).status, 'park-pending');
    } finally {
      r.journal.close();
    }
  });

  test('rerun.rejections: unknown unit, an attempt that is not the latest, a lane that did not run red, a moved branch', T, async () => {
    const { d } = estateArc([]);
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      const n = lanesAttempt(r);
      assert.match(rejected((await command(r, rerunBody(n, { unit: 'u9' as never }))).outcome), /unknown unit u9/);
      assert.match(rejected((await command(r, rerunBody(n - 1))).outcome), /not unit u1's latest decision/);
      assert.match(rejected((await command(r, rerunBody(n, { lane: laneId('mul') }))).outcome), /lane mul did not run red/);
      assert.match(rejected((await command(r, rerunBody(n, { lane: laneId('nope') }))).outcome), /lane nope did not run red/);
      // The unit's branch moved off the commit lanes#n ran on.
      const wt = unitWorktreePath(r);
      writeFiles(wt, { 'moved.txt': 'x\n' });
      commitAll(wt, 'moved');
      assert.match(rejected((await command(r, rerunBody(n))).outcome), /no longer at [0-9a-f]{40}, the commit lanes#\d+ ran on/);
      assert.deepEqual(r.journal.view.holistic().lanesReruns, []);
    } finally {
      r.journal.close();
    }
  });

  test('rerun.fold-validates: a second rerun of one lane at one head, or one of an attempt that is not the latest, fails the fold', T, async () => {
    const { d } = estateArc([]);
    const r = contextFor(d);
    try {
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      assert.equal((await command(r, rerunBody(lanesAttempt(r)))).outcome.kind, 'applied');
    } finally {
      r.journal.close();
    }
    const log = readJournal(absPath(d.runDir), arcId(d.arc)).events;
    const i = log.findLastIndex((e) => e.type === 'fact' && e.fact.kind === 'lanes-rerun');
    const e = log[i] as Extract<Event, { type: 'fact' }>;
    const f = e.fact;
    if (f.kind !== 'lanes-rerun') throw new Error('no lanes-rerun');
    assert.doesNotThrow(() => fold(arcId(d.arc), log));
    assert.throws(() => fold(arcId(d.arc), [...log.slice(0, i), { ...e, fact: { ...f, attempt: f.attempt - 1 } }]), /not its latest stage attempt/);
    const second = { ...e, seq: e.seq + 1, prev: prevHash(Buffer.from(serializeEvent(e), 'utf8')), fact: { ...f, command: commandId('cmd-00000000000000ff') } };
    assert.throws(() => fold(arcId(d.arc), [...log.slice(0, i + 1), second]), /second lanes-rerun of u1 lane estate at/);
  });
});

/** `log` with facts appended, chained as the journal chains them. */
function appended(log: readonly Event[], facts: readonly Fact[]): readonly Event[] {
  const out = [...log];
  for (const fact of facts) {
    const last = out.at(-1)!;
    out.push({ ...last, type: 'fact', seq: last.seq + 1, prev: prevHash(Buffer.from(serializeEvent(last), 'utf8')), fact } as Event);
  }
  return out;
}

test('rerun.fold-restore: a rerun short of a verdict stays in progress through a retry or an env park, whose resume runs the rerun\'s lanes again; its rerun-red park\'s resume restores the waived decision', T, async () => {
  const { d } = estateArc([]);
  const r = contextFor(d);
  let waived: number;
  try {
    await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
    waived = lanesAttempt(r);
    assert.equal((await command(r, rerunBody(waived))).outcome.kind, 'applied');
  } finally {
    r.journal.close();
  }
  const log = readJournal(absPath(d.runDir), arcId(d.arc)).events;
  const unitOf = (events: readonly Event[]) => fold(arcId(d.arc), events).units.find((u) => u.unit === U1)!;
  const outcome = (attempt: number, o: Record<string, unknown>): Fact => ({ kind: 'stage-outcome', unit: U1, stage: 'lanes', attempt, chargeable: false, ...o } as Fact);
  const env = { class: 'park', park: { class: 'operator', kind: 'env' } };
  const resume = { kind: 'unparked', unit: U1, command: commandId('cmd-00000000000000aa') } as Fact;

  const occupied = appended(log, [outcome(waived + 1, { outcome: 'occupied', ...env })]);
  assert.deepEqual([unitOf(occupied).status, unitOf(occupied).entry, unitOf(occupied).rerun?.waived.attempt], ['park-pending', null, waived], 'an env park short of a verdict keeps the rerun');
  const resumed = unitOf(appended(occupied, [resume]));
  assert.deepEqual([resumed.status, resumed.entry?.kind, resumed.rerun?.waived.attempt], ['active', 'rerun', waived], 'its resume runs the rerun\'s lanes again');

  const retried = unitOf(appended(log, [outcome(waived + 1, { outcome: 'blocked', class: 'retry' })]));
  assert.deepEqual([retried.entry, retried.rerun?.waived.attempt], [null, waived], 'a retry keeps the rerun: the retried lanes are its lanes');

  const red = appended(log, [outcome(waived + 1, { outcome: 'rerun-red', ...env })]);
  const back = unitOf(appended(red, [resume]));
  assert.deepEqual([back.status, back.rerun, back.entry, back.decided?.attempt, back.decided?.outcome], ['active', null, null, waived, 'red'], 'the waived decision');

  const green = unitOf(appended(log, [outcome(waived + 1, { outcome: 'green', class: 'advance' })]));
  assert.deepEqual([green.rerun, green.entry], [null, null], 'a verdict that goes on ends the rerun');
});

describe(`matrix row ${RERUN}`, () => {
  const cells = crashCells(RERUN);

  test('lists the row\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), [
      'B2 command.apply.before-effect', 'B4 rerun.after-fact', 'B4 command.apply.after-effect', 'B4 command.apply.after-receipt',
    ]);
  });

  for (const cell of cells) {
    test(`rerun.crash-cells ${cell.boundary} ${cell.label}: ${cell.recovery}`, T, async () => {
      const { d } = estateArc([]);
      const r = contextFor(d);
      await stepUntil(r, 'u1', (f) => f.stage === 'lanes');
      const attempt = lanesAttempt(r);
      const cmd = submitCommand(r.ctx.runDir, r.ctx.plan().arc, rerunBody(attempt));
      r.journal.close();

      const trigger = writeTrigger(tmpDir('rerun-crash'), { label: cell.label, occurrence: 1 });
      const exit = await runFixture('mergein-child.ts', [JSON.stringify(d), cmd.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 60_000 });
      assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stderr ${exit.stderr}`);
      assertFired(trigger);

      const again = contextFor(d);
      try {
        const report = await recover({ stage: again.ctx, commands: commandContextFor(again) });
        assert.deepEqual(report.parked, []);
        assert.deepEqual(again.journal.view.openIntents(), []);
        const reruns = again.journal.view.holistic().lanesReruns;
        assert.deepEqual(reruns.map((f) => [f.command, f.attempt, f.lane]), [[commandId(cmd.id), attempt, 'estate']], 'one lanes-rerun fact');
        const apply = again.journal.view.opsOf('command.apply').filter((i) => i.expect.command === cmd.id);
        assert.equal(apply.length, 1);
        assert.equal(again.journal.view.doneOf(apply[0]!.op)?.outcome.kind, 'applied');
        assert.ok(readReceipt(again.ctx.runDir, commandId(cmd.id), 'applied')?.state === 'applied');
      } finally {
        again.journal.close();
      }
      const replayed = contextFor(d);
      assert.equal(replayed.journal.view.unit(U1).entry?.kind, 'rerun', 'the fold replays the rerun entry');
      assert.ok(existsSync(d.runDir));
      replayed.journal.close();
    });
  }
});
