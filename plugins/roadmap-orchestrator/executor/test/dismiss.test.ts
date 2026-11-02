import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyCommand } from '../src/commands/apply.ts';
import { pollCommands, submitCommand, readReceipt } from '../src/commands/queue.ts';
import { findingId, obligationId, sha, jobId } from '../src/core/ids.ts';
import { readJournal } from '../src/core/log.ts';
import { commandBody } from '../src/core/records.ts';
import { openFinding, p1Blocking, isActive, findingMetrics } from '../src/holistic/findings.ts';
import { raiseNeedsUser, openBlocking } from '../src/needsuser.ts';
import { recover } from '../src/recover/recover.ts';
import { openCommandRun } from './fixtures/cmd-common.ts';
import { newRun } from './fixtures/res-plan.ts';
import { assertFired, writeTrigger } from './helpers/crash.ts';
import { runFixture } from './helpers/proc.ts';
import { tmpDir } from './helpers/repo.ts';
import { DISMISS, crashCells } from './matrix.ts';

const draft = () => ({lens: 'invariants' as const, severity: 'P1' as const, obligation: obligationId('I-1'), visionClauses: [], claim: 'write disappears', cause: 'lost write', evidence: [{path: 'src/a.ts', blob: sha('a'.repeat(40))}], mutant: null, source: {type: 'job' as const, job: jobId('audit', 1)}, gateHadPassed: true});
function setup() {
  const run = {...newRun(), binDir: join(tmpDir('dismiss-bin'), 'bin')};
  const r = openCommandRun(run);
  openFinding(r.journal, draft());
  const item = raiseNeedsUser(r.journal, r.ctx.runDir, {blocking: true, subject: {type: 'findings', findings: [findingId('F-1')]}, reason: 'owner-request', summary: 'Dismiss false positive', recommendation: 'Review counter-evidence', options: [], evidence: []}, {type: 'arc'});
  const cmd = submitCommand(r.ctx.runDir, r.journal.view.arc, {type: 'dismiss', finding: findingId('F-1'), counterEvidence: 'test/restart.ts:8 persists the committed write across restart'});
  pollCommands(r.ctx.runDir, r.journal.view.arc);
  return {run, ...r, item, cmd};
}

test('dismiss: P1 stops gating and dedupe survives replay; unrelated arc items remain open', async () => {
  const r = setup();
  try {
    const unrelated = raiseNeedsUser(r.journal, r.ctx.runDir, {blocking: true, subject: {type: 'arc'}, reason: 'owner-request', summary: 'Decide a resource', recommendation: 'Owner decision', options: [], evidence: []}, {type: 'arc'});
    const blocked = () => p1Blocking(r.journal.view.holistic().findings, new Set([obligationId('I-1')]), new Set());
    assert.deepEqual(blocked(), {finding: 'F-1', obligation: 'I-1'});
    assert.equal((await applyCommand(r.ctx, r.cmd)).kind, 'applied');
    assert.equal(blocked(), null);
    const metric = findingMetrics(readJournal(r.ctx.runDir, r.journal.view.arc).events, r.journal.view.holistic().findings)[0]!;
    assert.equal(metric.disposition, 'dismissed');
    assert.ok(metric.timeToResolveMs !== null && metric.timeToResolveMs >= 0, 'status metrics time the root dismissal fact');
    assert.deepEqual(r.journal.view.holistic().findings.filter(isActive), []);
    assert.equal(r.journal.view.ackOf(r.item)?.command, r.cmd.id);
    assert.deepEqual(openBlocking(r.journal.view), [unrelated]);
    assert.deepEqual(openFinding(r.journal, draft()), {kind: 'suppressed', by: 'F-1'});
    const last = r.journal.view.holistic().findings[0]!.last;
    assert.deepEqual(last, {state: 'ruled', disposition: 'dismissed', by: {type: 'root', command: r.cmd.id, counterEvidence: r.cmd.body.type === 'dismiss' ? r.cmd.body.counterEvidence : '', role: 'root', routingRev: r.ctx.routing(null).resolved.rev}});
    const before = r.journal.view.highWater();
    assert.equal((await applyCommand(r.ctx, r.cmd)).kind, 'applied');
    assert.equal(r.journal.view.highWater(), before);
    assert.equal(openFinding(r.journal, {...draft(), evidence: [{path: 'src/a.ts', blob: sha('b'.repeat(40))}]}).kind, 'opened');
  } finally {r.journal.close();}
});

test('dismiss: missing/blank counter-evidence, unknown and closed findings are refused', async () => {
  for (const counterEvidence of [undefined, '', '  ']) assert.throws(() => commandBody({type: 'dismiss', finding: 'F-1', ...(counterEvidence === undefined ? {} : {counterEvidence})}, 'command'));
  const r = setup();
  try {
    const unknown = submitCommand(r.ctx.runDir, r.journal.view.arc, {type: 'dismiss', finding: findingId('F-99'), counterEvidence: 'proof'});
    assert.match(JSON.stringify(await applyCommand(r.ctx, unknown)), /unknown finding/);
    await applyCommand(r.ctx, r.cmd);
    const closed = submitCommand(r.ctx.runDir, r.journal.view.arc, r.cmd.body);
    assert.match(JSON.stringify(await applyCommand(r.ctx, closed)), /is ruled/);
  } finally {r.journal.close();}
});

for (const label of [...new Set(crashCells(DISMISS).map((c) => c.label))]) test(`dismiss.crash: ${label}`, {timeout: 60_000}, async () => {
  const r = setup();
  r.journal.close();
  const trigger = writeTrigger(tmpDir('dismiss-crash'), {label, occurrence: 1});
  const first = await runFixture('cmd-child.ts', [JSON.stringify(r.run), r.cmd.id], {env: {...process.env, ROADMAP_TEST_CRASH: trigger}, timeoutMs: 30_000});
  assert.equal(first.signal, 'SIGKILL', first.stderr);
  assertFired(trigger);
  const next = openCommandRun(r.run);
  try {
    const out = await recover({stage: next.stage, commands: next.ctx});
    assert.deepEqual(out.parked, [], JSON.stringify(out));
    assert.equal(readReceipt(next.ctx.runDir, r.cmd.id, 'applied')?.state, 'applied');
    assert.deepEqual(openBlocking(next.journal.view), []);
    assert.deepEqual(openFinding(next.journal, draft()), {kind: 'suppressed', by: 'F-1'});
    assert.equal(next.journal.view.holistic().findings[0]?.last?.state, 'ruled');
    assert.equal(next.journal.view.findingsAt(next.journal.view.highWater()).length, 1);
  } finally {next.journal.close();}
});


test('dismiss closes a grouped finding request only after its last finding settles', async () => {
  const r = setup();
  try {
    openFinding(r.journal, {...draft(), cause: 'second false positive'});
    const grouped = raiseNeedsUser(r.journal, r.ctx.runDir, {blocking: true, subject: {type: 'findings', findings: [findingId('F-1'), findingId('F-2')]}, reason: 'new-finding-draining', summary: 'Two findings', recommendation: 'Review both', options: [], evidence: []}, {type: 'arc'});
    await applyCommand(r.ctx, r.cmd);
    assert.equal(r.journal.view.ackOf(grouped), null, 'F-2 still blocks');
    const second = submitCommand(r.ctx.runDir, r.journal.view.arc, {type: 'dismiss', finding: findingId('F-2'), counterEvidence: 'test/a.ts:10 rejects the second premise'});
    await applyCommand(r.ctx, second);
    assert.equal(r.journal.view.ackOf(grouped)?.command, second.id);
    assert.deepEqual(openBlocking(r.journal.view), []);
  } finally {r.journal.close();}
});


test('root apply supplying a repair answers finding requests without dismissing the finding', async () => {
  const {readFileSync, writeFileSync} = await import('node:fs');
  const {contextFor, setupArc, syncInputs, applyBody, commandContextFor} = await import('./fixtures/unit-common.ts');
  const d = setupArc({steps: []});
  const r = contextFor(d);
  try {
    openFinding(r.journal, {...draft(), obligation: null});
    openFinding(r.journal, {...draft(), obligation: null, cause: 'second false positive'});
    const item = (findings: string[]) => raiseNeedsUser(r.journal, r.ctx.runDir, {blocking: true, subject: {type: 'findings', findings: findings.map((id) => findingId(id))}, reason: 'owner-request', summary: findings.join(','), recommendation: 'Admit a repair or dismiss with counter-evidence', options: [], evidence: []}, {type: 'arc'});
    const one = item(['F-1']);
    const both = item(['F-1', 'F-2']);
    syncInputs(r);
    const path = join(d.planPath, '..', 'u1.json');
    writeFileSync(path, JSON.stringify({...JSON.parse(readFileSync(path, 'utf8')), repairs: ['F-1']}));
    const cmd = submitCommand(r.ctx.runDir, r.journal.view.arc, applyBody(d));
    const out = await applyCommand(commandContextFor(r), cmd);
    assert.equal(out.kind, 'applied', JSON.stringify(out));
    assert.equal(r.journal.view.ackOf(one)?.command, cmd.id);
    assert.equal(r.journal.view.ackOf(both), null, 'the revision supplies no repair for F-2');
    assert.ok(r.journal.view.holistic().findings.every(isActive), 'a root repair response does not dismiss either finding');
  } finally {r.journal.close();}
});
