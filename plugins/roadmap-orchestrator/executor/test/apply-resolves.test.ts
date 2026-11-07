import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyCommand, evaluateApply } from '../src/commands/apply.ts';
import { readCommand, submitCommand, terminalReceipt } from '../src/commands/queue.ts';
import { needsUserId, unitId, findingId, sha, jobId } from '../src/core/ids.ts';
import { parseCommand } from '../src/input/cli.ts';
import { needsUserAckPath, raiseNeedsUser, readNeedsUserAck } from '../src/needsuser.ts';
import { events } from './fixtures/invoke-specs.ts';
import { PLAN_APPLY_RESOLVES, crashCells } from './matrix.ts';
import { openFinding } from '../src/holistic/findings.ts';
import { setupArc, contextFor, commandContextFor, syncInputs, applyBody } from './fixtures/unit-common.ts';
import type { NeedsUserContent } from '../src/core/records.ts';

test('resolves parses only unique nonempty journal ids', () => {
  const args = ['apply', '--from', '/p', '--rev', '1', '--reason', 'answer'];
  const parsed = parseCommand([...args, '--resolves', 'nu-1,nu-2']);
  assert.ok(parsed.command === 'apply');
  assert.deepEqual(parsed.resolves, ['nu-1', 'nu-2']);
  for (const ids of ['', 'nu-1,', ',nu-1', 'nu-1,nu-1', 'host-probe', 'sup-1-1', 'nu-0', 'nu-x']) assert.throws(() => parseCommand([...args, '--resolves', ids]));
});

const item = (r: ReturnType<typeof contextFor>, subject: NeedsUserContent['subject'] = { type: 'arc' }) => raiseNeedsUser(r.journal, r.ctx.runDir, { subject, blocking: true, reason: 'owner-request', summary: 'Answer this request', recommendation: 'Revise the plan', options: [], evidence: [] }, { type: 'arc' });
const edit = (r: ReturnType<typeof contextFor>) => {
  syncInputs(r);
  writeFileSync(r.d.planPath, JSON.stringify({ ...JSON.parse(readFileSync(r.d.planPath, 'utf8')), direction: 'Answer the named request' }));
};
const evaluate = (r: ReturnType<typeof contextFor>, body: ReturnType<typeof applyBody> & { resolves?: readonly ReturnType<typeof needsUserId>[] }) => evaluateApply({ ...commandContextFor(r), ...body, view: r.journal.view });

test('changed apply explicitly resolves only named arc requests and lists its closures', async () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    const named = item(r); const unrelated = item(r); edit(r);
    const body = { ...applyBody(r.d), resolves: [named] };
    assert.equal((await evaluate(r, body)).kind, 'accepted');
    const command = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
    assert.equal((await applyCommand(commandContextFor(r), command)).kind, 'applied');
    assert.equal(r.journal.view.ackOf(named)?.command, command.id);
    assert.equal(r.journal.view.ackOf(named)?.choice, null);
    assert.equal(r.journal.view.ackOf(unrelated), null);
    const receipt = terminalReceipt(r.ctx.runDir, command.id);
    assert.ok(receipt?.state === 'applied'); assert.deepEqual(receipt.resolved, [named]);
  } finally { r.journal.close(); }
});

test('no-op, unknown, host and already acknowledged requests refuse without closing anything', async () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    const named = item(r); const host = item(r, { type: 'host' });
    syncInputs(r);
    assert.equal((await evaluate(r, { ...applyBody(r.d), resolves: [named] })).kind, 'rejected');
    edit(r);
    for (const id of [needsUserId('nu-999999'), host]) assert.equal((await evaluate(r, { ...applyBody(r.d), resolves: [id] })).kind, 'rejected');
    const ack = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'ack', needsUser: named, choice: null });
    await applyCommand(commandContextFor(r), ack);
    const verdict = await evaluate(r, { ...applyBody(r.d), resolves: [named] });
    assert.equal(verdict.kind, 'rejected');
    assert.equal(r.journal.view.ackOf(host), null);
  } finally { r.journal.close(); }
});

test('unit-subject eligibility requires that unit to change', async () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    const named = item(r, { type: 'unit', unit: unitId('u1') }); edit(r);
    assert.equal((await evaluate(r, { ...applyBody(r.d), resolves: [named] })).kind, 'rejected');
    const path = join(r.d.planPath, '..', 'u1.json'); const spec = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...spec, intent: `${spec.intent} Answer the request.` }));
    const body = { ...applyBody(r.d), resolves: [named] };
    assert.equal((await evaluate(r, body)).kind, 'accepted');
    const command = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
    assert.equal((await applyCommand(commandContextFor(r), command)).kind, 'applied');
    assert.equal(r.journal.view.ackOf(named)?.command, command.id);
  } finally { r.journal.close(); }
});

test('finding-subject eligibility requires every finding answered by prospective repairs', async () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    for (const cause of ['first', 'second']) openFinding(r.journal, { lens: 'invariants', severity: 'P1', obligation: null, visionClauses: [], claim: 'lost write', cause, evidence: [{ path: 'src/add.js', blob: sha('a'.repeat(40)) }], mutant: null, source: { type: 'job', job: jobId('audit', 1) }, gateHadPassed: true });
    const named = item(r, { type: 'findings', findings: [findingId('F-1'), findingId('F-2')] });
    syncInputs(r); const path = join(r.d.planPath, '..', 'u1.json'); const spec = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...spec, repairs: ['F-1'] }));
    assert.equal((await evaluate(r, { ...applyBody(r.d), resolves: [named] })).kind, 'rejected');
    writeFileSync(path, JSON.stringify({ ...spec, repairs: ['F-1', 'F-2'] }));
    const body = { ...applyBody(r.d), resolves: [named] };
    assert.equal((await evaluate(r, body)).kind, 'accepted');
    const command = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
    assert.equal((await applyCommand(commandContextFor(r), command)).kind, 'applied');
    assert.equal(r.journal.view.ackOf(named)?.command, command.id);
    assert.ok(r.journal.view.holistic().findings.every((f) => f.state === 'open'));
  } finally { r.journal.close(); }
});

test('queued stale proposal and request closed after evaluation close nothing', async () => {
  const r = contextFor(setupArc({ steps: [] }));
  try {
    const named = item(r); edit(r);
    const body = { ...applyBody(r.d), resolves: [named] };
    assert.equal((await evaluate(r, body)).kind, 'accepted');
    const command = submitCommand(r.ctx.runDir, r.ctx.plan().arc, body);
    writeFileSync(r.d.planPath, JSON.stringify({ ...JSON.parse(readFileSync(r.d.planPath, 'utf8')), direction: 'Changed after submission' }));
    assert.equal((await applyCommand(commandContextFor(r), command)).kind, 'rejected');
    assert.equal(r.journal.view.ackOf(named), null);
    edit(r);
    const next = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { ...applyBody(r.d), resolves: [named] });
    const ack = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'ack', needsUser: named, choice: null });
    await applyCommand(commandContextFor(r), ack);
    assert.equal((await applyCommand(commandContextFor(r), next)).kind, 'rejected');
    assert.equal(r.journal.view.ackOf(named)?.command, ack.id);
    assert.equal(r.journal.view.planAppliedBy(next.id), null);
  } finally { r.journal.close(); }
});

const resolutionCells = crashCells(PLAN_APPLY_RESOLVES);
test('lists the linked apply resolution crash points', () => {
  assert.deepEqual(resolutionCells.map((c) => `${c.boundary} ${c.label}`), [
    'B3 revision.commit.after-fact', 'B4 command.apply.after-effect',
    'B4 command.apply.after-ack-file', 'B4 command.apply.after-ack', 'B4 command.apply.after-receipt',
  ]);
});

for (const { label } of resolutionCells) for (const occurrence of
  label === 'command.apply.after-ack-file' || label === 'command.apply.after-ack' ? [1, 2] : [1]
) test(`applied-resolution-replays-after-each-crash: ${label} #${occurrence}`, { timeout: 60_000 }, async () => {
  const { runFixture } = await import('./helpers/proc.ts');
  const { writeTrigger, assertFired } = await import('./helpers/crash.ts');
  const { tmpDir } = await import('./helpers/repo.ts');
  const { recover } = await import('../src/recover/recover.ts');
  const { followingContext } = await import('./fixtures/steer-common.ts');
  const d = setupArc({ steps: [] }); const before = contextFor(d);
  const ids = [item(before), item(before)]; edit(before);
  const file = submitCommand(before.ctx.runDir, before.ctx.plan().arc, { ...applyBody(d), resolves: ids }); before.journal.close();
  const trigger = writeTrigger(tmpDir('resolve-crash'), { label, occurrence });
  const crashed = await runFixture('apply-child.ts', [JSON.stringify(d), file.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 30_000 });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr); assertFired(trigger);
  const r = contextFor(d);
  try {
    const stage = followingContext(r); const commands = commandContextFor(r, stage);
    const existingAcks = ids.map((id) => readNeedsUserAck(r.ctx.runDir, id));
    await recover({ stage, commands });
    for (const [index, id] of ids.entries()) {
      assert.equal(r.journal.view.ackOf(id)?.command, file.id);
      assert.deepEqual(r.journal.view.ackOf(id), { command: file.id, choice: null });
      const ack = readNeedsUserAck(r.ctx.runDir, id);
      assert.ok(ack !== null);
      assert.deepEqual({ id: ack.id, command: ack.command, choice: ack.choice }, { id, command: file.id, choice: null });
      if (existingAcks[index] !== null) assert.deepEqual(ack, existingAcks[index], 'recovery preserves an existing ack file');
    }
    const journal = events(d.runDir);
    assert.deepEqual(journal.flatMap((e) => e.type === 'fact' && e.fact.kind === 'plan-applied' && e.fact.command === file.id ? [e.fact.rev] : []), [2]);
    assert.deepEqual(journal.flatMap((e) => e.type === 'fact' && e.fact.kind === 'needs-user-acked' ? [e.fact] : []),
      ids.map((id) => ({ kind: 'needs-user-acked', id, command: file.id, choice: null })));
    const applies = r.journal.view.opsOf('command.apply').filter((i) => i.expect.command === file.id);
    assert.equal(applies.length, 1);
    const apply = applies[0]!;
    const durable = readCommand(r.ctx.runDir, file.id, r.journal.view.arc);
    assert.equal(apply.expect.commandSha256, durable.sha256);
    assert.ok(durable.file.body.type === 'apply');
    assert.deepEqual(durable.file.body.resolves, ids, 'the durable command retains the resolution link');
    assert.deepEqual(journal.flatMap((e) => e.type === 'done' && e.op === apply.op ? [e.kind] : []), ['command.apply']);
    const receipt = terminalReceipt(r.ctx.runDir, file.id);
    assert.ok(receipt?.state === 'applied'); assert.deepEqual(receipt.resolved, ids);
    assert.equal(r.journal.view.opsOf('revision.commit').filter((i) => i.expect.rev === 2).length, 1);
    assert.equal(receipt.op, apply.op);
    const ackBytes = ids.map((id) => readFileSync(needsUserAckPath(r.ctx.runDir, id), 'utf8'));
    const high = r.journal.view.highWater(); await recover({ stage, commands }); assert.equal(r.journal.view.highWater(), high);
    assert.deepEqual(ids.map((id) => readFileSync(needsUserAckPath(r.ctx.runDir, id), 'utf8')), ackBytes);
    assert.deepEqual(terminalReceipt(r.ctx.runDir, file.id), receipt);
  } finally { r.journal.close(); }
});

test('concurrent acknowledgement after commit wins without overwrite or false receipt credit', { timeout: 60_000 }, async () => {
  const { runFixture } = await import('./helpers/proc.ts');
  const { writeTrigger } = await import('./helpers/crash.ts');
  const { tmpDir } = await import('./helpers/repo.ts');
  const { recover } = await import('../src/recover/recover.ts');
  const { followingContext } = await import('./fixtures/steer-common.ts');
  const { readNeedsUserAck } = await import('../src/needsuser.ts');
  const d = setupArc({ steps: [] }); const before = contextFor(d); const named = item(before); edit(before);
  const file = submitCommand(before.ctx.runDir, before.ctx.plan().arc, { ...applyBody(d), resolves: [named] }); before.journal.close();
  const trigger = writeTrigger(tmpDir('resolve-race'), { label: 'command.apply.after-effect', occurrence: 1 });
  const crashed = await runFixture('apply-child.ts', [JSON.stringify(d), file.id], { env: { ...process.env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: 30_000 }); assert.equal(crashed.signal, 'SIGKILL');
  const r = contextFor(d);
  try {
    assert.ok(r.journal.view.planAppliedBy(file.id));
    const stage = followingContext(r); const commands = commandContextFor(r, stage);
    const ack = submitCommand(r.ctx.runDir, r.ctx.plan().arc, { type: 'ack', needsUser: named, choice: null });
    await applyCommand(commands, ack);
    const bytes = JSON.stringify(readNeedsUserAck(r.ctx.runDir, named));
    await recover({ stage, commands });
    assert.equal(r.journal.view.ackOf(named)?.command, ack.id);
    assert.equal(JSON.stringify(readNeedsUserAck(r.ctx.runDir, named)), bytes);
    const receipt = terminalReceipt(r.ctx.runDir, file.id); assert.ok(receipt?.state === 'applied'); assert.deepEqual(receipt.resolved, []);
  } finally { r.journal.close(); }
});

test('resolves validates before CLI submission and dry-run uses the same predicate', { timeout: 60_000 }, async () => {
  const { mkdirSync, readdirSync, existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { absPath } = await import('../src/core/values.ts');
  const { runDir } = await import('../src/input/cli.ts');
  const { gitCommonDir } = await import('../src/preflight/checks.ts');
  const { exportInputs } = await import('../src/commands/inputs.ts');
  const { tmpDir } = await import('./helpers/repo.ts');
  const { runUntilExit } = await import('./helpers/proc.ts');
  const d = setupArc({ steps: [] }); const dir = runDir(gitCommonDir(absPath(d.repo)), d.arc as never); mkdirSync(dir, { recursive: true });
  const r = contextFor({ ...d, runDir: dir });
  const named = item(r, { type: 'unit', unit: unitId('u1') });
  r.journal.close();
  const out = absPath(join(tmpDir('resolve-export'), 'out'));
  const exported = await exportInputs({ repo: absPath(d.repo), arc: d.arc as never, out });
  const path = join(out, 'plan.json'); writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), direction: 'Unrelated to this unit request' }));
  const args = ['apply', '--repo', d.repo, '--arc', d.arc, '--from', out, '--rev', String(exported.planRev), '--reason', 'Answer', '--resolves', named];
  const bin = fileURLToPath(new URL('../bin/roadmap', import.meta.url));
  const opts = { env: { ...process.env }, timeoutMs: 30_000 };
  const dry = await runUntilExit(process.execPath, [bin, ...args, '--dry-run'], opts);
  assert.equal(JSON.parse(dry.stdout).kind, 'rejected', dry.stderr);
  const submitted = await runUntilExit(process.execPath, [bin, ...args], opts);
  assert.notEqual(submitted.code, 0); assert.match(submitted.stderr, /change or re-enter unit u1/);
  const incoming = join(dir, 'commands', 'incoming'); assert.deepEqual(existsSync(incoming) ? readdirSync(incoming) : [], []);
  const specPath = join(dirname(path), 'u1.json'); const spec = JSON.parse(readFileSync(specPath, 'utf8')); writeFileSync(specPath, JSON.stringify({ ...spec, intent: `${spec.intent} Address the request.` }));
  const accepted = await runUntilExit(process.execPath, [bin, ...args], opts);
  assert.equal(accepted.code, 0, accepted.stderr);
  const id = JSON.parse(accepted.stdout).command;
  const raw = JSON.parse(readFileSync(join(incoming, `${id}.json`), 'utf8')); assert.deepEqual(raw.body.resolves, [named]);
});
