// Persistent scale example. Synthetic workload; real git, retained inputs, journal and runner schemas.
// Run from executor/: node test/fixtures/tui-scale-demo.ts [new-directory]
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { OutcomeStage, SpawnSubject } from '../../src/core/events.ts';
import { type InvocationId, arcId, implementerSessionId, judgmentSessionId, laneId, milestoneId, opKey, sha, sha256, specRev, unitId } from '../../src/core/ids.ts';
import { sha256Hex } from '../../src/core/json.ts';
import type { LaunchFile, ResultFile } from '../../src/core/records.ts';
import { absPath, isoTime, refName, repoPath } from '../../src/core/values.ts';
import { inputPath, keepInput, specShaInForce } from '../../src/input/inforce.ts';
import { pinDispatch } from '../../src/pipeline/dispatch.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import { at, record, start } from '../../src/pipeline/stages.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { launchSha256 } from '../../src/runner/launch.ts';
import { Observer } from '../../src/tui/observer.ts';
import { git } from '../helpers/repo.ts';
import { VISION, ADVANCES } from './brake-common.ts';
import { contextFor, setupArc } from './unit-common.ts';

const DEFAULT_UNITS = 205;
const DEFAULT_INVOCATIONS = 3000;
const MILESTONES = 8;
const KIB = 1024;
const MIB = 1024 * KIB;
const begun = performance.now();
const count = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
};
const unitCount = count('SCALE_UNITS', DEFAULT_UNITS);
const invocationCount = count('SCALE_INVOCATIONS', DEFAULT_INVOCATIONS);
const mergedCount = Math.round(unitCount * 0.7);
const runningCount = Math.min(10, unitCount - mergedCount, Math.max(0, invocationCount - 1));
const heldCount = Math.min(4, unitCount - mergedCount - runningCount);
const blockedCount = Math.min(3, unitCount - mergedCount - runningCount - heldCount);
const workedCount = Math.max(1, mergedCount + runningCount + heldCount + blockedCount);
const id = (i: number): string => `unit-${String(i + 1).padStart(3, '0')}`;
// Layers of ten: each non-root has one to three distinct predecessors in the previous layer.
const units = Array.from({ length: unitCount }, (_, i) => {
  const previous = Math.floor(i / 10) * 10 - 10;
  const after = previous < 0 ? [] : Array.from({ length: 1 + i % 3 }, (_, j) => id(previous + (i + j * 3) % 10));
  return { id: id(i), after };
});
const base = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync('/var/tmp/roadmap-scale-demo-');
if (process.argv[2]) mkdirSync(base); // Never overwrite an existing example.
const tmp = process.env['TMPDIR']; process.env['TMPDIR'] = base;
const exitHooks = new Set(process.listeners('exit'));
let initial;
try { initial = setupArc({ units, steps: [] }); }
finally {
  // Test helpers normally delete fixtures on exit; this explicit demo command retains its directories.
  for (const hook of process.listeners('exit')) if (!exitHooks.has(hook)) process.removeListener('exit', hook);
  if (tmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = tmp;
}
const d = { ...initial, arc: 'scale-example', runDir: join(initial.repo, '.git', 'roadmap-runtime', 'scale-example') };
mkdirSync(d.runDir, { recursive: true });
const plan = JSON.parse(readFileSync(d.planPath, 'utf8'));
plan.arc = d.arc;
writeFileSync(join(dirname(d.planPath), 'vision.json'), JSON.stringify(VISION));
plan.holistic = { vision: 'vision.json', advances: ADVANCES };
plan.direction = 'SYNTHETIC SCALE FIXTURE: stopped snapshot, no model calls or live executor. Journal stage outcomes simulate work; integration commits retain the baseline tree.';
plan.milestones = Array.from({ length: Math.min(MILESTONES, unitCount) }, (_, i) => ({
  id: `MS-${i + 1}`, text: `Deliver platform layer ${i + 1}.`,
  units: units.slice(Math.floor(i * unitCount / Math.min(MILESTONES, unitCount)), Math.floor((i + 1) * unitCount / Math.min(MILESTONES, unitCount))).map((u) => u.id),
  design: { supplied: true }, references: ['contracts'], bringUp: { setup: [], serve: [], env: {}, seed: [] },
  journeys: [{ id: `J-${i + 1}`, text: 'Verify the delivered calculation workflow.', via: 'shell', entry: 'node --test', budget: null }], resources: [],
}));
writeFileSync(d.planPath, JSON.stringify(plan, null, 2));
const r = contextFor(d);
const runDir = absPath(d.runDir);
const arc = arcId(d.arc);
const routingRev = r.ctx.routing(null).rev;
const deadlineAt = isoTime('2099-01-01T00:00:00.000Z');
const promptPaths = [false, true].map((large) => {
  const prompt = Buffer.from('Synthetic retained agent input. Read the unit specification, contracts and verification results.\n'
    + 'Keep scope bounded; report evidence and unresolved questions.\n'.repeat(large ? 6000 : 40));
  return inputPath(runDir, keepInput(runDir, prompt, 'prompt.txt'), 'prompt.txt');
});
const schemaPath = absPath(join(base, 'report.schema.json'));
writeFileSync(schemaPath, JSON.stringify({ type: 'object', properties: { decision: { type: 'string' } } }));

// Every stream is valid Claude stream-json, including command logs for a consistent parser workload.
// Normal lines are ~4 KB; three streams also contain a >64 KB tool result near the tail.
function transcript(target: number, running: boolean, longLine: boolean): string {
  const line = (value: unknown): string => JSON.stringify(value) + '\n';
  const init = line({ type: 'system', subtype: 'init', model: 'scripted-scale-fixture' });
  const turn = line({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'Reviewing implementation and checking contracts. '.repeat(35) },
    { type: 'tool_use', id: 'tool-scale', name: 'Read', input: { file_path: 'src/mul.js' } },
  ] } }) + line({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool-scale', content: 'Verified calculation contract and test evidence. '.repeat(40), is_error: false },
  ] } });
  const long = longLine ? line({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tool-scale', content: 'Long evidence line. '.repeat(4200), is_error: false },
  ] } }) : '';
  const end = running ? line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Verification is still in progress.' }] } })
    : line({ type: 'result', subtype: 'success', is_error: false, result: 'Synthetic verification complete.', structured_output: { decision: 'approve', evidence: ['node --test passed'] } });
  return init + turn.repeat(Math.max(1, Math.ceil((target - init.length - long.length - end.length) / turn.length))) + long + end;
}
let stdoutBytes = 0;
let largeCount = 0;
let largeInvocation: InvocationId | null = null;
let runningInvocation: InvocationId | null = null;
let serial = 0;
const endedCount = invocationCount - runningCount;
const attempt = <S extends OutcomeStage>(unit: ReturnType<typeof unitId>, stage: S) => at(start(r.ctx, unit, stage), stage);
const roleStages = ['plan-check', 'build', 'lanes', 'gate'] as const;

function spawn(i: number, running: boolean): void {
  const index = serial++;
  const unit = unitId(id(i));
  const stage = roleStages[index % roleStages.length]!;
  const parent = start(r.ctx, unit, stage);
  const walk = !running && index % 20 === 19;
  const job = walk ? r.journal.view.nextJobId('walk') : null;
  if (job) r.journal.fact({ kind: 'walk-started', job, milestone: milestoneId(`MS-${1 + Math.floor(i * plan.milestones.length / unitCount)}`), round: 1, sha: sha(plan.baseline), ports: {} });
  const unitRole = stage === 'plan-check' ? 'planCheck' : stage === 'gate' ? 'gate' : 'build';
  const role = walk ? 'walkthrough' : unitRole;
  const subject: SpawnSubject = job ? { purpose: 'arc-backend', role: 'walkthrough', tier: 'arc', job, attempt: 1, routingRev }
    : stage === 'lanes' ? { purpose: 'lane', unit, lane: laneId('mul'), set: 'spec', at: sha(plan.baseline) }
    : { purpose: 'backend', role: unitRole, tier: 'med', unit, attempt: parent.attempt, routingRev };
  const sessionText = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  const session = role === 'build' ? implementerSessionId(sessionText) : judgmentSessionId(sessionText);
  let launch!: LaunchFile;
  const durable = r.journal.begin({ kind: 'proc.spawn', key: opKey(`scale:${index}`), parent: job ? { type: 'job', job } : parent, deadlineAt,
    body: (op, inv) => {
      const dir = invocationDir(runDir, inv);
      launch = { v: 1, arc, op, inv, argv: stage === 'lanes' && !walk ? ['node', '--test', 'test/mul.test.js']
        : ['claude', '-p', '--output-format', 'stream-json', '--model', 'scripted-scale-fixture'],
      cwd: absPath(d.repo), env: {}, stdinPath: subject.purpose === 'lane' ? null : promptPaths[index % 10 === 0 ? 1 : 0]!,
      deadlineAt, stallMs: null, graceMs: 1000, containment: 'session', test: null,
      terminal: subject.purpose === 'lane' ? { type: 'command', purpose: 'lane', expectedExit: 0 }
        : role === 'build' ? { type: 'backend', purpose: 'backend', role, routingRev, schemaPath, outputPath: absPath(join(dir, 'stdout')),
          session: { backend: 'claude', mode: 'fresh', id: implementerSessionId(session) } }
        : { type: 'backend', purpose: 'backend', role, routingRev, schemaPath, outputPath: absPath(join(dir, 'stdout')),
          session: { backend: 'claude', mode: 'fresh', id: judgmentSessionId(session) } } };
      return { expect: { subject, launchSha256: launchSha256(launch) }, post: null };
    } });
  const dir = invocationDir(runDir, durable.inv); mkdirSync(dir, { recursive: true });
  const files = runnerFiles(dir, durable.inv);
  files.write('launch.json', launch);
  const large = index % 20 === 0;
  const target = large ? (2 + Math.floor(index / 20) % 18) * MIB : (50 + index * 37 % 251) * KIB;
  const stdout = transcript(target, running, index < 3);
  writeFileSync(join(dir, 'stdout'), stdout);
  stdoutBytes += Buffer.byteLength(stdout); if (large) largeCount++;
  writeFileSync(join(dir, 'stderr'), '');
  writeFileSync(join(dir, 'runner.log'), 'Synthetic runner records; no process was launched.\n');
  if (running) { runningInvocation ??= durable.inv; return; }
  if (large && (!largeInvocation || statSync(join(invocationDir(runDir, largeInvocation), 'stdout')).size < target)) largeInvocation = durable.inv;
  const binding = { v: 1 as const, arc, op: durable.op, inv: durable.inv };
  const now = isoTime(new Date().toISOString());
  files.write('exit.json', { ...binding, child: { type: 'exited', code: 0 }, cause: 'exited', endedAt: now, quiescedAt: now, cpu: null });
  const result: ResultFile = launch.terminal.type === 'command' ? { ...binding, type: 'command', purpose: 'lane', expectedExit: 0, exitCode: 0, verdict: 'pass' }
    : role === 'build' ? { ...binding, type: 'backend', role, routingRev, session: implementerSessionId(session), outcome: { kind: 'success', value: { decision: 'approve' } }, usage: { kind: 'unavailable', reason: 'absent' }, backendErrors: [] }
    : { ...binding, type: 'backend', role, routingRev, session: judgmentSessionId(session), outcome: { kind: 'success', value: { decision: 'approve' } }, usage: { kind: 'unavailable', reason: 'absent' }, backendErrors: [] };
  files.write('result.json', result);
  r.journal.done(durable.op, 'proc.spawn', { kind: 'result', pressure: null, resultSha256: sha256(sha256Hex(readFileSync(join(dir, 'result.json')))),
    summary: result.type === 'command' ? { type: 'command', verdict: result.verdict } : { type: 'backend', outcome: result.outcome.kind } }, null);
  if (job) r.journal.fact({ kind: 'walk-ended', job, outcome: 'reported', findings: [], proposals: [], dropped: [] });
  else if (stage === 'plan-check') record(r.ctx, at(parent, stage), 'approve');
  else if (stage === 'build') record(r.ctx, at(parent, stage), 'success');
  else if (stage === 'lanes') record(r.ctx, at(parent, stage), 'green');
  else record(r.ctx, at(parent, stage), 'approve');
}

try {
  for (let i = 0; i < workedCount; i++) {
    const unit = unitId(id(i));
    pinDispatch(r.ctx, r.unit(unit), { rev: specRev(1), sha256: specShaInForce(r.journal.view, unit) });
    const calls = Math.floor((i + 1) * endedCount / workedCount) - Math.floor(i * endedCount / workedCount);
    for (let j = 0; j < calls; j++) spawn(i, false);
    if (i < mergedCount) {
      // The real transition table classifies each fact; snapshot/published retires a unit (status: merged).
      record(r.ctx, attempt(unit, 'plan-check'), 'approve');
      record(r.ctx, attempt(unit, 'build'), 'success');
      record(r.ctx, attempt(unit, 'quiesce'), 'empty');
      record(r.ctx, attempt(unit, 'evidence'), 'captured');
      record(r.ctx, attempt(unit, 'salvage'), 'committed');
      record(r.ctx, attempt(unit, 'teardown'), 'released');
      record(r.ctx, attempt(unit, 'lanes'), 'green');
      record(r.ctx, attempt(unit, 'gate'), 'approve');
      record(r.ctx, attempt(unit, 'candidate'), 'green');
      const old = sha(git(d.repo, 'rev-parse', 'refs/heads/main'));
      const next = sha(git(d.repo, 'commit-tree', `${old}^{tree}`, '-p', old, '-m', `Synthetic delivery ${unit}`));
      const parent = start(r.ctx, unit, 'ff');
      const op = r.journal.begin({ kind: 'integration.ff', key: opKey(`scale:ff:${unit}`), parent, deadlineAt: null,
        body: () => ({ expect: { ref: refName('refs/heads/main'), old, new: next,
          fingerprint: { unitCommit: next, specRev: specRev(1), contractRevs: [{ path: repoPath('contracts/api.md'), blob: sha(git(d.repo, 'rev-parse', `${old}:contracts/api.md`)) }], rulingRevs: [] } }, post: null }) });
      git(d.repo, 'update-ref', 'refs/heads/main', next, old);
      r.journal.done(op.op, 'integration.ff', { kind: 'published' }, null);
      record(r.ctx, at(parent, 'ff'), 'published');
      record(r.ctx, attempt(unit, 'snapshot'), 'published');
    } else if (i >= mergedCount + runningCount) {
      if (i < mergedCount + runningCount + heldCount) record(r.ctx, attempt(unit, 'gate'), 'interrupted');
      else record(r.ctx, attempt(unit, 'ff'), 'foreign-move');
    }
    if ((i + 1) % 25 === 0) process.stderr.write(`Staged ${i + 1}/${workedCount} worked units (${Math.round(performance.now() - begun)} ms)\n`);
  }
  for (let i = 0; i < runningCount; i++) spawn(mergedCount + i, true);
} finally { r.journal.close(); }
writeFileSync(join(d.runDir, 'start.json'), JSON.stringify({ v: 1, generation: 1, at: new Date().toISOString(), repo: d.repo, planFile: d.planPath, profile: 'default' }));
const reply = new Observer().observe({ locator: { type: 'host' }, hostDir: absPath(d.hostDir), pinned: { arc, runDir }, token: 1 });
assert.equal(reply.error, null);
assert.equal(reply.display!.status.units.length, unitCount);
assert.equal(reply.display!.invocations.length, invocationCount);
assert.equal(reply.display!.status.units.filter((u) => u.state === 'merged').length, mergedCount);
assert.equal(reply.display!.invocations.filter((inv) => inv.endedAt === null).length, runningCount);
const states = Object.fromEntries([...new Set(reply.display!.status.units.map((u) => u.state))].map((state) => [state, reply.display!.status.units.filter((u) => u.state === state).length]));
writeFileSync(join(base, 'demo.json'), JSON.stringify({ ...d, scripted: true, base, unitCount, invocationCount, mergedCount, runningCount, largeCount, stdoutBytes, largeInvocation, runningInvocation, states, generationMs: performance.now() - begun }, null, 2));
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const cli = fileURLToPath(new URL('./exec-cli.ts', import.meta.url));
writeFileSync(join(base, 'tui'), `#!/bin/sh\nexec ${[process.execPath, cli, d.hostDir, 'tui', '--repo', d.repo, '--arc', d.arc].map(quote).join(' ')} "$@"\n`);
chmodSync(join(base, 'tui'), 0o755);
writeFileSync(join(base, 'README.txt'), `Synthetic scale snapshot: ${unitCount} units, ${invocationCount} invocations, ${largeCount} large transcripts.\nOpen: ${base}/tui\n\nNo live executor or model calls. Stage outcomes are simulated through the real journal API.\nIntegration commits are real empty commits; unit implementations are not delivered.\n${runningCount} open invocations retain stdout, without invented live process identities; the stopped observer labels these unowned.\nUnit states: ${JSON.stringify(states)}\nPrompts are content-addressed retained inputs shared across agent calls.\n`);
process.stdout.write(`Staged scale example: ${base}/tui (${Math.round(performance.now() - begun)} ms)\n`);
