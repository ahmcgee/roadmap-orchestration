// The durable command queue and the `command.apply` op (src/commands/{queue,apply}.ts, src/recover/command.ts):
// real journal, real invocations of res-tool.ts as the residue teardown, fake backends for the resume smoke,
// and a child executor SIGKILLed at the op's crash points.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import { type CommandContext, applyAtSafePoint, applyCommand, applyControl } from '../src/commands/apply.ts';
import { incomingPath, pollCommands, readReceipt, submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import { type IntentOf, probeTargetKey } from '../src/core/events.ts';
import { type ArcId, type CommandId, arcId, invocationId, needsUserId, opId, opKey, sha, specRev, unitId } from '../src/core/ids.ts';
import { type OpenJournal, openJournal } from '../src/core/log.ts';
import type { CommandBody, CommandFile } from '../src/core/records.ts';
import { absPath, isoTimeOf, refName } from '../src/core/values.ts';
import { readResidues, recordResidue, undispositioned } from '../src/host/residues.ts';
import { needsUserAckPath, openBlocking, raiseNeedsUser, readNeedsUserAck } from '../src/needsuser.ts';
import { recover } from '../src/recover/recover.ts';
import { type SweepHolder, cleanup, reserve, resourceTable, run as runReservation } from '../src/resources/reserve.ts';
import { requestOf } from '../src/resources/pool.ts';
import { ownerLabel } from '../src/resources/teardown.ts';
import type { ProberHandle } from '../src/park/probe.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { writeScenario } from './helpers/scenario.ts';
import { type CmdRun, openCommandRun } from './fixtures/cmd-common.ts';
import { dones, events } from './fixtures/invoke-specs.ts';
import { DB, QUEUE, UNIT, calls, newRun, stageHolder, stageParent } from './fixtures/res-plan.ts';
import { COMMAND_APPLY, crashCells } from './matrix.ts';

const T = { timeout: 60_000 };
const OTHER_ARC = arcId('old-arc');

function newCmdRun(binDir = join(tmpDir('cmd-bin'), 'bin')): CmdRun {
  return { ...newRun(), binDir };
}

function submit(ctx: CommandContext, body: CommandBody): CommandFile {
  return submitCommand(ctx.runDir, ctx.journal.view.arc, body);
}

const poll = (ctx: CommandContext): readonly CommandFile[] => pollCommands(ctx.runDir, ctx.journal.view.arc);

function raise(ctx: CommandContext, blocking = true, options: readonly { id: string; label: string }[] = []) {
  return raiseNeedsUser(ctx.journal, ctx.runDir, {
    blocking, subject: { type: 'unit', unit: UNIT }, reason: 'lane-blocked', summary: 'lane blocked twice', recommendation: 'look at the lane', options, evidence: [],
  }, { type: 'arc' });
}

/** A stage-parented intent left open: the stage is mid-flight. */
function openStageIntent(journal: OpenJournal) {
  return journal.begin({
    kind: 'worktree.create', key: opKey('wt:u1'), parent: { type: 'stage', unit: UNIT, stage: 'build', attempt: 1 }, deadlineAt: null,
    body: () => ({ expect: { path: absPath('/nowhere/u1'), checkout: { type: 'detached', at: sha('a'.repeat(40)) } }, post: null }),
  });
}

function openFfIntent(journal: OpenJournal) {
  return journal.begin({
    kind: 'integration.ff', key: opKey('ff'), parent: { type: 'arc' }, deadlineAt: null,
    body: () => ({
      expect: { ref: refName('refs/heads/main'), old: sha('a'.repeat(40)), new: sha('b'.repeat(40)), fingerprint: { unitCommit: sha('c'.repeat(40)), specRev: specRev(1), contractRevs: [], rulingRevs: [] } },
      post: null,
    }),
  });
}

function holdUnit(journal: OpenJournal): void {
  journal.fact({ kind: 'stage-outcome', unit: UNIT, stage: 'build', attempt: 1, outcome: 'interrupted', class: 'hold', chargeable: false });
}

const applyOps = (ctx: CommandContext, id: CommandId): readonly IntentOf<'command.apply'>[] =>
  ctx.journal.view.opsOf('command.apply').filter((i) => i.expect.command === id);

/** A residue of another arc for `resource`, whose teardown is res-tool.ts over this run's state dir. */
function otherArcResidue(run: CmdRun, resource: typeof DB, arc: ArcId = OTHER_ARC) {
  const label = ownerLabel(arc, UNIT);
  const entry = {
    type: 'residue', key: { arc, unit: UNIT, inv: invocationId(opId(arc, 7), 1), resource },
    teardown: { argv: [process.execPath, join(import.meta.dirname, 'fixtures', 'res-tool.ts'), 'teardown', run.stateDir, resource], cwd: absPath(run.repo), env: { RESOURCE_OWNER: label, PATH: process.env['PATH'] ?? '' } },
    label,
  } as const;
  recordResidue(absPath(run.hostDir), entry);
  writeFileSync(join(run.stateDir, `${resource}.occupant`), label);
  return entry;
}

function ackFacts(runDir: string, id: string) {
  return events(runDir).filter((e) => e.type === 'fact' && e.fact.kind === 'needs-user-acked' && e.fact.id === id);
}

describe('command queue', () => {
  it('cmd.accepted-not-applied: pickup writes accepted; the command stays pending and no op is done', T, () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const cmd = submit(ctx, { type: 'pause', target: { type: 'unit', unit: UNIT } });
    assert.equal(existsSync(incomingPath(ctx.runDir, cmd.id)), true);
    assert.equal(readReceipt(ctx.runDir, cmd.id, 'accepted'), null);

    assert.deepEqual(poll(ctx), [cmd]);
    const accepted = readFileSync(join(ctx.runDir, 'commands', 'receipts', `${cmd.id}.accepted.json`), 'utf8');
    assert.equal(readReceipt(ctx.runDir, cmd.id, 'accepted')?.state, 'accepted');
    assert.equal(terminalReceipt(ctx.runDir, cmd.id), null);
    assert.equal(applyOps(ctx, cmd.id).length, 0);
    // Accepted is not done: the next poll returns it again and rewrites nothing.
    assert.deepEqual(poll(ctx), [cmd]);
    assert.equal(readFileSync(join(ctx.runDir, 'commands', 'receipts', `${cmd.id}.accepted.json`), 'utf8'), accepted);
    journal.close();
  });

  it('cmd.receipts-and-acks-atomic: commands, receipts and ack files are published whole (temp and link), leaving only their final names', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const item = raise(ctx);
    const cmd = submit(ctx, { type: 'ack', needsUser: item, choice: null });
    assert.equal((await applyControl(ctx, poll(ctx))).kind, 'applied');
    assert.deepEqual(readdirSync(join(ctx.runDir, 'commands')).sort(), ['incoming', 'receipts']);
    assert.deepEqual(readdirSync(join(ctx.runDir, 'commands', 'incoming')), [`${cmd.id}.json`]);
    assert.deepEqual(readdirSync(join(ctx.runDir, 'commands', 'receipts')).sort(), [`${cmd.id}.accepted.json`, `${cmd.id}.applied.json`]);
    assert.deepEqual(readdirSync(join(ctx.runDir, 'needs-user')).filter((n) => n.startsWith(item)).sort(), [`${item}.ack.json`, `${item}.json`]);
    // Linked from a temp file that is then removed: one link left.
    for (const path of [incomingPath(ctx.runDir, cmd.id), join(ctx.runDir, 'commands', 'receipts', `${cmd.id}.applied.json`), needsUserAckPath(ctx.runDir, item)]) {
      assert.equal(statSync(path).nlink, 1, path);
    }
    assert.equal(readNeedsUserAck(ctx.runDir, item)?.command, cmd.id);
    journal.close();
  });

  it('ids sort in submission order', () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const ids: CommandId[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(submit(ctx, { type: 'stop' }).id);
      const until = Date.now() + 2;
      while (Date.now() < until) { /* next millisecond */ }
    }
    assert.deepEqual(poll(ctx).map((c) => c.id), ids);
    journal.close();
  });

  it('cmd.idempotent: re-delivering an applied command is a no-op', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const id = raise(ctx);
    const cmd = submit(ctx, { type: 'ack', needsUser: id, choice: null });
    const pending = poll(ctx);
    const first = await applyControl(ctx, pending);
    const again = await applyControl(ctx, pending);
    assert.equal(first.kind, 'applied');
    assert.deepEqual(again, first);
    assert.equal(applyOps(ctx, cmd.id).length, 1);
    assert.equal(ackFacts(ctx.runDir, id).length, 1);
    assert.deepEqual(await applyCommand(ctx, cmd), first.kind === 'applied' ? first.outcomes[0]?.outcome : assert.fail());
    assert.deepEqual(poll(ctx), []);
    journal.close();
  });

  it('cmd.control-timing: control applies while a mutation waits for a safe point, and waits only for an open ff', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const stage = openStageIntent(journal);
    const resume = submit(ctx, { type: 'resume', target: { type: 'all' } });
    const pause = submit(ctx, { type: 'pause', target: { type: 'unit', unit: UNIT } });
    assert.deepEqual(poll(ctx).map((c) => c.id), [resume.id, pause.id]);

    assert.equal((await applyAtSafePoint(ctx, poll(ctx))).kind, 'deferred');
    const control = await applyControl(ctx, poll(ctx));
    assert.deepEqual(control.kind === 'applied' ? control.outcomes.map((o) => [o.command, o.outcome.kind]) : control, [[pause.id, 'applied']]);
    assert.deepEqual(journal.view.control().pausedUnits, [UNIT]);
    assert.equal(terminalReceipt(ctx.runDir, resume.id), null, 'the mutation waits');
    const applied = readReceipt(ctx.runDir, pause.id, 'applied');
    assert.ok(applied?.state === 'applied');
    assert.equal(applied.op, applyOps(ctx, pause.id)[0]?.op);
    assert.ok(applied.verified.length > 0);

    // A control command waits only for the publication critical section.
    const ff = openFfIntent(journal);
    const stop = submit(ctx, { type: 'stop' });
    assert.equal((await applyControl(ctx, poll(ctx))).kind, 'deferred');
    journal.abort(ff.op, 'precondition', 'test: ff over');
    assert.equal((await applyControl(ctx, poll(ctx))).kind, 'applied');
    assert.equal(journal.view.control().stop, stop.id);

    journal.abort(stage.op, 'precondition', 'test: stage over');
    const mutations = await applyAtSafePoint(ctx, poll(ctx));
    assert.deepEqual(mutations.kind === 'applied' ? mutations.outcomes.map((o) => o.command) : mutations, [resume.id]);
    assert.deepEqual(journal.view.control(), { stop: stop.id, pausedAll: false, pausedUnits: [] });
    assert.deepEqual(poll(ctx), []);
    journal.close();
  });

  it('cmd.mutation-safe-point: a resume clears a hold only at a safe point, and the re-run is a new uncharged attempt', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    holdUnit(journal);
    const before = journal.view.unit(UNIT);
    assert.equal(before.status, 'held');
    const stage = openStageIntent(journal);
    const resume = submit(ctx, { type: 'resume', target: { type: 'unit', unit: UNIT } });
    assert.equal((await applyAtSafePoint(ctx, poll(ctx))).kind, 'deferred');
    assert.equal((await applyControl(ctx, poll(ctx))).kind, 'applied', 'no control command pending');
    assert.equal(journal.view.unit(UNIT).status, 'held');
    assert.equal(terminalReceipt(ctx.runDir, resume.id), null);

    journal.abort(stage.op, 'precondition', 'test: stage over');
    assert.equal((await applyAtSafePoint(ctx, poll(ctx))).kind, 'applied');
    const after = journal.view.unit(UNIT);
    assert.equal(after.status, 'active');
    assert.equal(after.stage, 'build');
    assert.deepEqual(after.counters, before.counters, 'a resume moves no counter');
    assert.equal(readReceipt(ctx.runDir, resume.id, 'applied')?.state, 'applied');
    journal.close();
  });

  it('cmd.unknown-ack-rejected: an unknown, an already acknowledged, or an unoffered choice is rejected, never applied', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const unknown = submit(ctx, { type: 'ack', needsUser: needsUserId('nu-999'), choice: null });
    const item = raise(ctx, true, [{ id: 'retry', label: 'retry the lane' }]);
    assert.deepEqual(openBlocking(journal.view), [item]);
    const first = submit(ctx, { type: 'ack', needsUser: item, choice: 'retry' });
    const second = submit(ctx, { type: 'ack', needsUser: item, choice: null });
    const other = raise(ctx, false);
    const badChoice = submit(ctx, { type: 'ack', needsUser: other, choice: 'nope' });
    await applyControl(ctx, poll(ctx));

    const reason = (id: CommandId): string => {
      const r = readReceipt(ctx.runDir, id, 'rejected');
      assert.equal(readReceipt(ctx.runDir, id, 'applied'), null, `${id} must not be applied`);
      return r?.state === 'rejected' ? r.reason : assert.fail(`${id} has no rejected receipt`);
    };
    assert.match(reason(unknown.id), /unknown needs-user nu-999/);
    assert.match(reason(second.id), new RegExp(`already acknowledged by ${first.id}`));
    assert.match(reason(badChoice.id), /offers no option nope/);
    assert.equal(readReceipt(ctx.runDir, first.id, 'applied')?.state, 'applied');
    const ack = readNeedsUserAck(ctx.runDir, item);
    assert.deepEqual([ack?.id, ack?.command, ack?.choice], [item, first.id, 'retry']);
    assert.equal(existsSync(needsUserAckPath(ctx.runDir, other)), false);
    assert.deepEqual(openBlocking(journal.view), []);
    for (const id of [unknown.id, second.id, badChoice.id]) {
      const done = dones(ctx.runDir, 'command.apply').find((d) => d.op === applyOps(ctx, id)[0]?.op);
      assert.ok(done?.kind === 'command.apply' && done.outcome.kind === 'rejected');
    }
    assert.deepEqual(poll(ctx), []);
    journal.close();
  });

  it('resume <unit> under pause --all is rejected; resume clears both', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    submit(ctx, { type: 'pause', target: { type: 'all' } });
    await applyControl(ctx, poll(ctx));
    const one = submit(ctx, { type: 'resume', target: { type: 'unit', unit: UNIT } });
    const unknown = submit(ctx, { type: 'resume', target: { type: 'unit', unit: unitId('nope') } });
    const all = submit(ctx, { type: 'resume', target: { type: 'all' } });
    await applyAtSafePoint(ctx, poll(ctx));
    const refused = readReceipt(ctx.runDir, one.id, 'rejected');
    assert.match(refused?.state === 'rejected' ? refused.reason : '', /whole arc is paused/);
    assert.equal(readReceipt(ctx.runDir, unknown.id, 'rejected')?.state, 'rejected');
    assert.equal(readReceipt(ctx.runDir, all.id, 'applied')?.state, 'applied');
    assert.deepEqual(journal.view.control(), { stop: null, pausedAll: false, pausedUnits: [] });
    journal.close();
  });

});

describe('resume.per-class: resume <unit> of a parked unit follows its park\'s class (A7)', () => {
  const resumeU1 = async (ctx: CommandContext) => {
    const cmd = submit(ctx, { type: 'resume', target: { type: 'unit', unit: UNIT } });
    await applyAtSafePoint(ctx, poll(ctx));
    return { cmd, receipt: terminalReceipt(ctx.runDir, cmd.id) };
  };
  const unitFacts = (ctx: CommandContext, kind: string) => events(ctx.runDir).filter((e) => e.type === 'fact' && e.fact.kind === kind);
  /** A prober whose run writes the probe fact with the result `results` names for the target, as the real one does. */
  const fakeProber = (journal: OpenJournal, results: Readonly<Record<string, 'pass' | 'fail'>>, ran: string[]): ProberHandle => ({
    due: () => [],
    running: () => [],
    resumeBackend: () => assert.fail('no resume --backend here'),
    run: (job) => {
      const key = probeTargetKey(job.target);
      const result = results[key] ?? assert.fail(`no result for probe target ${key}`);
      ran.push(`${key}@${job.covers.join(',')}`);
      journal.fact({ kind: 'probe', target: job.target, covers: job.covers, result, nextProbeAt: result === 'pass' ? null : isoTimeOf(new Date(Date.now() + 60_000)) });
      return Promise.resolve(result);
    },
  });
  const BACKEND = { type: 'backend', backend: 'codex' } as const;
  const HOST_TARGET = { type: 'host' } as const;
  const retryablePark = (journal: OpenJournal): number => journal.fact({
    kind: 'stage-outcome', unit: UNIT, stage: 'build', attempt: 1, outcome: 'process-fault', class: 'park', chargeable: false,
    park: { class: 'retryable', targets: [BACKEND, HOST_TARGET] },
  });

  it('operator env (a park 1.0.0-dev.4 wrote at lanes-blocked, read as env): the park\'s needs-user is acknowledged and the unit re-runs its lanes (unparked)', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    journal.fact({ kind: 'stage-outcome', unit: UNIT, stage: 'lanes', attempt: 1, outcome: 'blocked', class: 'park', chargeable: false });
    const item = raiseNeedsUser(ctx.journal, ctx.runDir, {
      blocking: true, subject: { type: 'unit', unit: UNIT }, reason: 'lane-blocked', summary: 'lane blocked twice', recommendation: 'resume u1', options: [], evidence: [],
    }, { type: 'stage', unit: UNIT, stage: 'lanes', attempt: 1 });
    assert.deepEqual(journal.view.unit(UNIT).park?.park, { class: 'operator', kind: 'env' });
    const { cmd, receipt } = await resumeU1(ctx);
    assert.ok(receipt?.state === 'applied', JSON.stringify(receipt));
    assert.deepEqual(receipt.verified.slice(-1), ['unit u1 re-entered at lanes']);
    const u = journal.view.unit(UNIT);
    assert.deepEqual([u.status, u.stage, u.park], ['active', 'lanes', null]);
    assert.equal(unitFacts(ctx, 'unparked').length, 1);
    assert.equal(readNeedsUserAck(ctx.runDir, item)?.command, cmd.id);
    assert.deepEqual(openBlocking(journal.view), []);
    journal.close();
  });

  it('operator design at a stage no revision re-opens: rejected, naming the re-entry; nothing changes', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    journal.fact({ kind: 'stage-outcome', unit: UNIT, stage: 'candidate', attempt: 1, outcome: 'red', class: 'park', chargeable: false, park: { class: 'operator', kind: 'design' } });
    const { receipt } = await resumeU1(ctx);
    assert.equal(receipt?.state === 'rejected' && receipt.reason,
      'unit u1 is parked (candidate-red) at candidate, a design park no revision re-opens there; re-enter it: a new unit with `reenters: {unit: u1}`, then `roadmap apply`');
    assert.equal(journal.view.unit(UNIT).status, 'park-pending');
    assert.deepEqual(unitFacts(ctx, 'unparked'), []);
    journal.close();
  });

  it('retryable, every target passing: the prober probes each outstanding target now, covering the park, and the probes recover the unit', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const seq = retryablePark(journal);
    // One target passed already (a scheduled probe): only the other is probed now.
    journal.fact({ kind: 'probe', target: BACKEND, covers: [seq], result: 'pass', nextProbeAt: null });
    const ran: string[] = [];
    const probing = { ...ctx, probes: { prober: fakeProber(journal, { host: 'pass' }, ran), signal: new AbortController().signal } };
    const { receipt } = await resumeU1(probing);
    assert.ok(receipt?.state === 'applied', JSON.stringify(receipt));
    assert.deepEqual(receipt.verified, ['unit u1 recovered: every target of its park passed; it re-runs build']);
    assert.deepEqual(ran, [`host@${seq}`]);
    const u = journal.view.unit(UNIT);
    assert.deepEqual([u.status, u.stage, u.park, u.lastRecovery?.targets], ['active', 'build', null, [BACKEND, HOST_TARGET]]);
    journal.close();
  });

  it('retryable, a target still failing: rejected naming it; the park stays with what passed, and the failed probe set its next probe', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const seq = retryablePark(journal);
    const ran: string[] = [];
    const probing = { ...ctx, probes: { prober: fakeProber(journal, { 'backend:codex': 'pass', host: 'fail' }, ran), signal: new AbortController().signal } };
    const { receipt } = await resumeU1(probing);
    assert.equal(receipt?.state === 'rejected' && receipt.reason, 'unit u1 is parked (process-fault) at build, retryable: host still failing; probing goes on');
    assert.deepEqual(ran, [`backend:codex@${seq}`, `host@${seq}`]);
    const u = journal.view.unit(UNIT);
    assert.equal(u.status, 'park-pending');
    assert.deepEqual(u.park?.passed, [BACKEND]);
    assert.equal(unitFacts(ctx, 'probe').length, 2);
    journal.close();
  });
});

describe('resume --backend', () => {
  it('re-runs that backend\'s smoke alone: a failed smoke is rejected and keeps the park; a passing one clears it and the holds', { timeout: 120_000 }, async () => {
    const s = writeScenario(tmpDir('cmd-scenario'), [
      { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'exit', code: 1 }] },
      { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: { ok: true } }] },
    ]);
    const run = newCmdRun(s.binDir);
    const { ctx, journal } = openCommandRun(run);
    journal.fact({ kind: 'backend-park', backend: 'claude', class: 'usage-limit', inv: invocationId(opId(ctx.journal.view.arc, 1), 1) });
    holdUnit(journal);
    assert.deepEqual(journal.view.parkedBackends(), ['claude']);

    const failed = submit(ctx, { type: 'resume', target: { type: 'backend', backend: 'claude' } });
    await applyAtSafePoint(ctx, poll(ctx));
    const rejected = readReceipt(ctx.runDir, failed.id, 'rejected');
    assert.match(rejected?.state === 'rejected' ? rejected.reason : '', /^smoke-failed: failed: seat planCheck\.low/);
    assert.deepEqual(journal.view.parkedBackends(), ['claude']);
    assert.equal(journal.view.unit(UNIT).status, 'held');

    const passed = submit(ctx, { type: 'resume', target: { type: 'backend', backend: 'claude' } });
    await applyAtSafePoint(ctx, poll(ctx));
    assert.equal(readReceipt(ctx.runDir, passed.id, 'applied')?.state, 'applied');
    assert.deepEqual(journal.view.parkedBackends(), []);
    assert.equal(journal.view.unit(UNIT).status, 'active');
    // The smoke spawns are journaled, one per resume, and nothing ran for codex.
    const smokes = events(ctx.runDir).filter((e) => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'smoke');
    assert.equal(smokes.length, 2);
    journal.close();
  });
});

describe('sweep', () => {
  it('sweep.cleans: an undispositioned residue is torn down under the sweep holder, released and disposed of as cleaned', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    const residue = otherArcResidue(run, DB);
    const cmd = submit(ctx, { type: 'sweep', resource: null });
    await applyAtSafePoint(ctx, poll(ctx));

    const receipt = readReceipt(ctx.runDir, cmd.id, 'applied');
    assert.ok(receipt?.state === 'applied');
    assert.deepEqual(receipt.verified, [`residue ${OTHER_ARC}/${UNIT}/${residue.key.inv}/db: cleaned`]);
    assert.deepEqual(undispositioned(absPath(run.hostDir)), []);
    const disposition = readResidues(absPath(run.hostDir)).find((l) => l.type === 'disposition');
    const teardown = events(ctx.runDir).find((e) => e.type === 'intent' && e.kind === 'proc.spawn' && e.expect.subject.purpose === 'teardown');
    assert.ok(disposition?.type === 'disposition' && disposition.disposition === 'cleaned' && teardown?.type === 'intent');
    assert.deepEqual(disposition.by, { arc: ctx.journal.view.arc, inv: invocationId(teardown.op, 1) });
    assert.deepEqual(teardown.parent, { type: 'command', command: cmd.id });
    assert.equal(existsSync(join(run.stateDir, 'db.occupant')), false);
    assert.deepEqual(calls(run), [`teardown db ${residue.label}`]);
    assert.equal(resourceTable(journal.view).get(DB)?.status.state, 'free');
    journal.close();
  });

  it('a failed teardown leaves the residue undisposed and the resource cleaning; the next sweep re-drives it', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    otherArcResidue(run, DB);
    writeFileSync(join(run.stateDir, 'db.teardown-fails'), '');
    const first = submit(ctx, { type: 'sweep', resource: DB });
    await applyAtSafePoint(ctx, poll(ctx));
    const r1 = readReceipt(ctx.runDir, first.id, 'applied');
    assert.ok(r1?.state === 'applied');
    assert.match(r1.verified.join('\n'), /teardown failed, left undisposed/);
    assert.equal(undispositioned(absPath(run.hostDir)).length, 1);
    const held = resourceTable(journal.view).get(DB)?.status;
    assert.ok(held?.state === 'cleaning' && held.holder.type === 'sweep' && held.holder.command === first.id);

    rmSync(join(run.stateDir, 'db.teardown-fails'));
    const second = submit(ctx, { type: 'sweep', resource: null });
    await applyAtSafePoint(ctx, poll(ctx));
    const r2 = readReceipt(ctx.runDir, second.id, 'applied');
    assert.ok(r2?.state === 'applied');
    assert.match(r2.verified.join('\n'), /: cleaned$/);
    assert.deepEqual(undispositioned(absPath(run.hostDir)), []);
    assert.equal(resourceTable(journal.view).get(DB)?.status.state, 'free');
    assert.equal(calls(run).filter((c) => c.startsWith('teardown db')).length, 2);
    journal.close();
  });

  it('reclaims this arc\'s own cleanup-failed resource, re-runs its teardown and frees it', T, async () => {
    const run = newCmdRun();
    const { ctx, journal } = openCommandRun(run);
    writeFileSync(join(run.stateDir, 'queue.teardown-fails'), '');
    const holder = stageHolder('build');
    const reserved = reserve(ctx, holder, requestOf(ctx.plan(), [QUEUE], 0), stageParent(holder));
    if (reserved.state === 'refused') assert.fail('queue is free');
    const cleaned = await cleanup(ctx, runReservation(ctx, reserved, stageParent(holder)), stageParent(holder));
    assert.equal(cleaned.kind, 'cleanup-failed');
    assert.equal(resourceTable(journal.view).get(QUEUE)?.status.state, 'cleanup-failed');
    rmSync(join(run.stateDir, 'queue.teardown-fails'));

    const cmd = submit(ctx, { type: 'sweep', resource: null });
    await applyAtSafePoint(ctx, poll(ctx));
    assert.equal(readReceipt(ctx.runDir, cmd.id, 'applied')?.state, 'applied');
    assert.deepEqual(undispositioned(absPath(run.hostDir)), []);
    assert.equal(resourceTable(journal.view).get(QUEUE)?.status.state, 'free');
    const reclaim = events(ctx.runDir).filter((e) => e.type === 'intent' && e.kind === 'resource.transition' && e.expect.edge.type === 'reclaim');
    assert.equal(reclaim.length, 1);
    assert.deepEqual(reclaim[0]?.type === 'intent' && reclaim[0].kind === 'resource.transition' ? reclaim[0].expect.holder : null, { type: 'sweep', command: cmd.id } satisfies SweepHolder);
    journal.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// Crash cells

type Scenario = 'ack' | 'sweep';

describe(`matrix row ${COMMAND_APPLY}`, () => {
  const cells = crashCells(COMMAND_APPLY);

  it('lists the op\'s crash points', () => {
    assert.deepEqual(cells.map((c) => `${c.boundary} ${c.label}`), [
      'B2 command.apply.before-effect', 'B3 spawn.after-intent', 'B4 command.apply.after-effect', 'B4 command.apply.after-receipt',
    ]);
  });

  for (const cell of cells) {
    const scenarios: readonly Scenario[] = cell.label.startsWith('spawn.') ? ['sweep'] : ['ack', 'sweep'];
    for (const scenario of scenarios) {
      test(`cmd.crash-cells ${cell.boundary} ${cell.label} (${scenario}): ${cell.recovery}`, T, async () => {
        const run = newCmdRun();
        const setup = openCommandRun(run);
        let expectAck: string | null = null;
        let body: CommandBody;
        if (scenario === 'ack') {
          expectAck = raise(setup.ctx);
          body = { type: 'ack', needsUser: needsUserId(expectAck), choice: null };
        } else {
          otherArcResidue(run, DB);
          body = { type: 'sweep', resource: null };
        }
        const cmd = submit(setup.ctx, body);
        assert.equal(poll(setup.ctx).length, 1);
        setup.journal.close();

        const trigger = writeTrigger(tmpDir('cmd-crash'), { label: cell.label, occurrence: 1 });
        const exit = await runFixture('cmd-child.ts', [JSON.stringify(run), cmd.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 30_000 });
        assert.equal(exit.signal, 'SIGKILL', `the child must crash at ${cell.label}: code ${exit.code}, stderr ${exit.stderr}`);
        assertFired(trigger);

        // Accepted is not done: the op is open, and until the terminal receipt exists the command is pending.
        const { ctx, stage, journal } = openCommandRun(run);
        const open = journal.view.openIntents().filter((i) => i.kind === 'command.apply');
        assert.equal(open.length, 1);
        const intent = open[0] as IntentOf<'command.apply'>;
        assert.equal(readReceipt(ctx.runDir, cmd.id, 'accepted')?.state, 'accepted');
        const receipted = cell.label === 'command.apply.after-receipt';
        assert.equal(terminalReceipt(ctx.runDir, cmd.id)?.state, receipted ? 'applied' : undefined);
        assert.deepEqual(poll(ctx).map((c) => c.id), receipted ? [] : [cmd.id]);
        await assert.rejects(applyCommand(ctx, cmd), /still open; recovery applies it/);

        const spawnsOpen = journal.view.openIntents().filter((i) => i.kind === 'proc.spawn').map((i) => i.op);
        assert.equal(spawnsOpen.length, cell.label === 'spawn.after-intent' ? 1 : 0);
        const mark = events(ctx.runDir).length;
        await recover({ stage, commands: ctx });

        // The recovery engine closes the op (reconciled), and the reconciler the sweep's open teardown spawn (lost,
        // reconciled); everything the remainder of the effect runs is a new op, done in the ordinary way.
        assert.equal(journal.view.openIntents().length, 0);
        const done = journal.view.doneOf(intent.op);
        assert.ok(done?.kind === 'command.apply' && done.outcome.kind === 'applied', JSON.stringify(done));
        assert.equal(done.recoveredBy, 'reconciled');
        for (const op of spawnsOpen) {
          const lost = journal.view.doneOf(op);
          assert.ok(lost?.kind === 'proc.spawn' && lost.outcome.kind === 'lost' && lost.recoveredBy === 'reconciled', JSON.stringify(lost));
        }
        const written = events(ctx.runDir).slice(mark).flatMap((e) => (e.type === 'done' ? [e] : []));
        assert.deepEqual(written.filter((e) => e.recoveredBy !== null).map((e) => [e.kind, e.op]).sort(), [...spawnsOpen.map((op) => ['proc.spawn', op]), ['command.apply', intent.op]].sort());
        const applied = readReceipt(ctx.runDir, cmd.id, 'applied');
        assert.ok(applied?.state === 'applied');
        assert.equal(applied.op, intent.op);
        assert.deepEqual(poll(ctx), []);
        if (expectAck !== null) {
          assert.equal(readNeedsUserAck(ctx.runDir, needsUserId(expectAck))?.command, cmd.id);
          assert.equal(ackFacts(ctx.runDir, expectAck).length, 1);
          assert.deepEqual(openBlocking(journal.view), []);
        } else {
          assert.deepEqual(undispositioned(absPath(run.hostDir)), []);
          assert.equal(readResidues(absPath(run.hostDir)).filter((l) => l.type === 'disposition').length, 1);
          assert.equal(resourceTable(journal.view).get(DB)?.status.state, 'free');
          // A crash before any teardown or after the whole effect runs the teardown once; a crash with the
          // teardown's spawn open reruns it as a new op after the lost one.
          assert.equal(calls(run).filter((c) => c.startsWith('teardown db')).length, 1);
        }
        journal.close();
        // Re-opening the log folds every record the recovery wrote.
        const again = openJournal(absPath(run.runDir), ctx.journal.view.arc);
        assert.equal(again.view.openIntents().length, 0);
        again.close();
      });
    }
  }
});
