// Shared by the recovery engine's tests (test/recover.test.ts) and rec-child.ts: a dead executor's log for
// every op kind that has a reconciler, made by crashing the real code that writes it (the unit driver, a
// backend call being paused, a needs-user raise, a command) at a crash point inside that op; the recovery
// engine run in a child that can itself be crashed; and the fixed point a finished recovery must reach.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sessionContainment } from '../../src/contain/session.ts';
import type { Event, IntentRecord, OpKind } from '../../src/core/events.ts';
import { arcId, invocationId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { checkManifest } from '../../src/git/evidence.ts';
import { refTarget, revParse } from '../../src/git/git.ts';
import { readResidues } from '../../src/host/residues.ts';
import { invocationDir } from '../../src/pipeline/invoke.ts';
import type { RecoveryContext } from '../../src/recover/recover.ts';
import { resourceTable } from '../../src/resources/reserve.ts';
import { runnerFiles } from '../../src/runner/files.ts';
import { fileSha256 } from '../../src/spec/spec.ts';
import { reached } from '../helpers/barrier.ts';
import { assertFired, writeTrigger } from '../helpers/crash.ts';
import { type Exit, fixture, runFixture } from '../helpers/proc.ts';
import { git, tmpDir } from '../helpers/repo.ts';
import { type Step, readCalls } from '../helpers/scenario.ts';
import { backend, run as procRun, scenario as procScenario } from './invoke-specs.ts';
import { planCheckStep } from './stage-common.ts';
import {
  type ArcDescriptor, type ArcOptions, type ArcRun, MUL, appendSteps, codexStep, commandContextFor, contextFor, gateStep, mulBuild, setupArc, stepUntil, workDirPattern,
} from './unit-common.ts';

/** Every op kind a reconciler recovers: one scenario each. */
export const REC_KINDS = [
  'proc.spawn', 'proc.kill', 'worktree.create', 'worktree.remove', 'evidence.snapshot', 'salvage.commit', 'mergein.prepare',
  'candidate.merge', 'integration.ff', 'snapshot.publish', 'resource.transition', 'spec.patch', 'needsuser.raise', 'command.apply',
] as const satisfies readonly OpKind[];
export type RecKind = (typeof REC_KINDS)[number];

const CHILD_TIMEOUT_MS = 90_000;

/** The recovery context of an arc, as the executor builds it (default profile). */
export function recoveryContext(r: ArcRun): RecoveryContext {
  return { stage: r.ctx, commands: commandContextFor(r) };
}

/** Declares resource `db` (res-tool.ts over `stateDir`) and gives it to every unit, as exec-common does. */
function withResource(d: ArcDescriptor, stateDir: string): void {
  const plan = JSON.parse(readFileSync(d.planPath, 'utf8')) as { resources: unknown[]; units: { resources: string[] }[] };
  const tool = (cmd: 'probe' | 'teardown') => ({ argv: [process.execPath, fixture('res-tool.ts'), cmd, stateDir, 'db'], cwd: '.', env: { set: {}, pass: [] } });
  plan.resources = [{ name: 'db', probe: tool('probe'), teardown: tool('teardown') }];
  for (const u of plan.units) u.resources = ['db'];
  writeFileSync(d.planPath, JSON.stringify(plan));
}

/** Runs `name` with a crash trigger at (label, occurrence) and asserts it died there. */
export async function crashFixture(name: string, args: readonly string[], label: string, occurrence: number, env: NodeJS.ProcessEnv = process.env): Promise<Exit> {
  const trigger = writeTrigger(tmpDir('rec-trigger'), { label, occurrence });
  const exit = await runFixture(name, args, { env: { ...env, ROADMAP_TEST_CRASH: trigger }, timeoutMs: CHILD_TIMEOUT_MS });
  assert.equal(exit.signal, 'SIGKILL', `${name} did not die at ${label}#${occurrence}: code ${exit.code}, stderr ${exit.stderr}`);
  assertFired(trigger);
  return exit;
}

const unitEnv = (d: ArcDescriptor): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${d.binDir}:${process.env['PATH'] ?? ''}` });

/** The unit driver on `d`, killed at (label, occurrence). */
export function crashUnit(d: ArcDescriptor, label: string, occurrence = 1): Promise<Exit> {
  return crashFixture('unit-child.ts', [JSON.stringify(d), 'u1'], label, occurrence, unitEnv(d));
}

/**
 * The straight scenario of u1: plan-check, the build that adds mul (writing decisions.json), the gate. The
 * build commits its work, or leaves it uncommitted for salvage to commit (`dirty`).
 */
function straight(d: ArcDescriptor, opts: Readonly<{ unitAdd?: string; dirty?: boolean }> = {}): void {
  const decisions = JSON.stringify({ decisions: [{ id: 'D1', text: 'mul multiplies with the * operator.' }] });
  const files = { ...MUL, ...(opts.unitAdd === undefined ? {} : { 'src/add.js': opts.unitAdd }) };
  const write = { type: 'writeToPrompt', pattern: workDirPattern(d), file: 'decisions.json', text: decisions } as const;
  appendSteps(d, [
    planCheckStep({ decision: 'approve' }),
    codexStep([write, opts.dirty === true ? { type: 'dirty', files } : { type: 'commit', message: 'add mul', files }], { argv: ['exec', '-C'] }),
    gateStep({ decision: 'approve' }),
  ]);
}

/** Where a unit-driver crash leaves an open intent of the kind (label, occurrence 1). */
const UNIT_CRASH: Partial<Record<RecKind, string>> = {
  'proc.spawn': 'spawn.after-runner-exit',
  'worktree.create': 'worktree.create.act-start',
  'worktree.remove': 'worktree.remove.act-start',
  'evidence.snapshot': 'evidence.act-start',
  'salvage.commit': 'salvage.act-start',
  'candidate.merge': 'candidate.act-start',
  'integration.ff': 'ff.act-start',
  'snapshot.publish': 'snapshot.act-start',
  'resource.transition': 'resource.after-intent',
  'spec.patch': 'spec.patch.before-write',
};

export type DeadRun = Readonly<{ d: ArcDescriptor; kind: RecKind; stateDir: string }>;

/** A fresh arc whose (dead) executor left an open intent of `kind`, the one recovery must settle first. */
export async function deadRun(kind: RecKind, opts: Partial<ArcOptions> = {}): Promise<DeadRun> {
  const d = setupArc({ steps: [], ...opts });
  const stateDir = tmpDir('rec-res');
  const unitLabel = UNIT_CRASH[kind];
  if (unitLabel !== undefined) {
    if (kind === 'resource.transition') {
      withResource(d, stateDir);
      // The teardown recovery reruns fails: a residue, which must be recorded once per resource.
      writeFileSync(join(stateDir, 'db.teardown-fails'), '');
    }
    straight(d, { dirty: kind === 'salvage.commit' });
    await crashUnit(d, unitLabel);
    return { d, kind, stateDir };
  }
  switch (kind) {
    case 'mergein.prepare': {
      // T moves under the approved unit: the candidate conflicts and the driver merges T in.
      straight(d, { unitAdd: 'export function add(a, b) {\n  return a + b; // unit u1\n}\n' });
      const r = contextFor(d);
      try {
        await stepUntil(r, 'u1', (f) => f.stage === 'gate' && f.outcome === 'approve');
      } finally {
        r.journal.close();
      }
      writeFileSync(join(d.repo, 'src', 'add.js'), 'export function add(a, b) {\n  return b + a; // integration\n}\n');
      git(d.repo, 'commit', '--quiet', '-am', 'integration changes add');
      await crashUnit(d, 'mergein.act-start');
      return { d, kind, stateDir };
    }
    case 'proc.kill': {
      // A backend call of u1 paused (proc.kill{pause}), the executor dead right after the kill's intent.
      const hang = procScenario([{ as: 'claude', expect: {}, acts: [{ type: 'hang', ms: 60_000 }] }]);
      const spec = { ...backend({ ...procRun(), runDir: d.runDir, arc: d.arc }, hang), cwd: d.repo };
      await crashFixture('invoke-child.ts', ['pause', JSON.stringify(spec)], 'kill.after-intent', 1);
      return { d, kind, stateDir };
    }
    case 'needsuser.raise':
      await crashFixture('needsuser-child.ts', [d.runDir, d.arc], 'needsuser.raise.before-publish', 1);
      return { d, kind, stateDir };
    case 'command.apply':
      await crashFixture('rec-child.ts', ['command', JSON.stringify(d)], 'command.apply.before-effect', 1);
      return { d, kind, stateDir };
    default:
      throw new Error(`no dead-run scenario for ${kind}`);
  }
}

/** The recovery engine in a child (rec-child.ts), killed at (label, occurrence). */
export function crashRecovery(d: ArcDescriptor, label: string, occurrence: number): Promise<Exit> {
  return crashFixture('rec-child.ts', ['recover', JSON.stringify(d)], label, occurrence, unitEnv(d));
}

// ---------------------------------------------------------------------------------------------------
// The fixed point

const eventsOf = (d: ArcDescriptor): readonly Event[] => readJournal(absPath(d.runDir), arcId(d.arc)).events;

/** The intents open in the log now, in log order. */
export function openNow(d: ArcDescriptor): readonly IntentRecord[] {
  return readJournal(absPath(d.runDir), arcId(d.arc)).view.openIntents();
}

/**
 * What recovery made of a dead run, independent of ids, times and SHAs, so two runs of the same scenario
 * compare: how each intent the dead executor left open ended, which ops recovery itself began and how they
 * ended, and how many needs-user items, usage facts, results and residues exist.
 */
export type FixedPoint = Readonly<{
  closures: readonly string[];
  added: readonly string[];
  needsUser: number;
  usage: number;
  results: number;
  residues: number;
  stillOpen: number;
}>;

function closureOf(view: ReturnType<typeof readJournal>['view'], events: readonly Event[], op: string): string {
  const done = view.doneOf(op as never);
  if (done !== null) return `done ${done.outcome.kind}`;
  return events.some((e) => e.type === 'abort' && e.op === op) ? 'abort' : 'open';
}

export function fixedPoint(d: ArcDescriptor, deadOpen: readonly IntentRecord[], seqBefore: number): FixedPoint {
  const { view, events } = readJournal(absPath(d.runDir), arcId(d.arc));
  const added = events.filter((e) => e.type === 'intent' && e.seq > seqBefore && e.ordinal === 1);
  const results = view.opsOf('proc.spawn').filter((i) => existsSync(join(invocationDir(absPath(d.runDir), invocationId(i.op, i.ordinal)), 'result.json'))).length;
  return {
    closures: deadOpen.map((i) => `${i.kind} ${closureOf(view, events, i.op)}`),
    added: added.map((e) => (e.type === 'intent' ? `${e.kind} ${closureOf(view, events, e.op)}` : '')).sort(),
    needsUser: view.needsUser().length,
    usage: events.filter((e) => e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable')).length,
    results,
    residues: existsSync(join(d.hostDir, 'residues.jsonl')) ? readResidues(absPath(d.hostDir)).filter((r) => r.type === 'residue').length : 0,
    stillOpen: view.openIntents().length,
  };
}

/** recoveredBy of every done that closed one of the dead run's open intents, by op. */
export function recoveredBy(d: ArcDescriptor, deadOpen: readonly IntentRecord[]): readonly (string | null)[] {
  const { view } = readJournal(absPath(d.runDir), arcId(d.arc));
  return deadOpen.map((i) => view.doneOf(i.op)?.recoveredBy ?? null);
}

/**
 * No effect happened twice, and every closed op's postcondition holds on disk: the SHAs its intent
 * recorded, one result and one usage fact per backend invocation, one residue per resource, one needs-user
 * per cause (and one file each), one applied receipt per command, and no backend called by recovery.
 */
export function assertNoDuplicateEffect(d: ArcDescriptor, callsBefore: number): void {
  const { view, events } = readJournal(absPath(d.runDir), arcId(d.arc));
  const runDir = absPath(d.runDir);
  const doneOps = new Set(events.flatMap((e) => (e.type === 'done' ? [e.op] : [])));
  assert.equal(events.filter((e) => e.type === 'done').length, doneOps.size, 'one done per op');

  for (const i of view.opsOf('proc.spawn')) {
    const done = view.doneOf(i.op);
    if (done === null || done.kind !== 'proc.spawn') continue;
    const inv = invocationId(i.op, i.ordinal);
    const files = runnerFiles(invocationDir(runDir, inv), inv);
    assert.equal(files.read('result.json') !== null, done.outcome.kind === 'result', `${inv}: a result exactly when done with one`);
    if (i.expect.subject.purpose === 'backend') {
      const usage = events.filter((e) => e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable') && e.fact.inv === inv);
      assert.equal(usage.length, 1, `${inv}: one usage fact`);
    }
    assert.ok(sessionContainment.empty({ inv, child: null }), `${inv}: no member left`);
  }
  for (const i of view.opsOf('salvage.commit')) if (view.doneOf(i.op) !== null) assert.equal(refTarget(i.expect.worktree, i.expect.branch), i.post.new, 'salvage: the recorded SHA');
  for (const i of view.opsOf('candidate.merge')) if (view.doneOf(i.op) !== null) assert.equal(refTarget(absPath(d.repo), i.expect.ref), i.post.new, 'candidate: the recorded SHA');
  for (const i of view.opsOf('snapshot.publish')) if (view.doneOf(i.op) !== null) assert.equal(refTarget(absPath(d.repo), i.expect.ref), i.post.new, 'snapshot: the recorded SHA');
  for (const i of view.opsOf('integration.ff')) {
    const done = view.doneOf(i.op);
    if (done?.kind === 'integration.ff' && done.outcome.kind === 'published') assert.equal(refTarget(absPath(d.repo), i.expect.ref), i.expect.new, 'ff: published the candidate');
  }
  for (const i of view.opsOf('mergein.prepare')) {
    const done = view.doneOf(i.op);
    if (done?.kind !== 'mergein.prepare') continue;
    const head = revParse(i.expect.worktree, 'HEAD');
    if (done.outcome.kind === 'conflicted') {
      assert.equal(head, i.expect.old, 'mergein conflicted: HEAD at the old tip');
      assert.equal(revParse(i.expect.worktree, 'MERGE_HEAD'), i.expect.integrationTip, 'mergein conflicted: MERGE_HEAD = T');
    }
  }
  for (const i of view.opsOf('evidence.snapshot')) if (view.doneOf(i.op) !== null) assert.equal(checkManifest(i.expect.dest).kind, 'verified', `evidence ${i.op}: manifest verifies`);
  for (const i of view.opsOf('worktree.create')) {
    // A detached checkout stays where it was made (a unit worktree's branch moves on with each round).
    const done = view.doneOf(i.op);
    const removed = view.opsOf('worktree.remove').some((r) => r.expect.path === i.expect.path && view.doneOf(r.op) !== null);
    if (done?.kind === 'worktree.create' && !removed && i.expect.checkout.type === 'detached') assert.equal(revParse(i.expect.path, 'HEAD'), done.outcome.head, 'worktree: at its recorded head');
  }
  for (const i of view.opsOf('worktree.remove')) if (view.doneOf(i.op) !== null) assert.ok(!existsSync(i.expect.path), `worktree ${i.expect.path} removed`);
  for (const i of view.opsOf('spec.patch')) if (view.doneOf(i.op) !== null && view.opsOf('spec.patch').at(-1)?.op === i.op) assert.equal(fileSha256(i.expect.path), i.post.newSha256, 'spec: the recorded bytes');

  // One needs-user per cause, one file per item.
  const raises = view.opsOf('needsuser.raise').filter((i) => view.doneOf(i.op) !== null);
  const causes = raises.map((i) => JSON.stringify(i.parent));
  assert.equal(new Set(causes).size, causes.length, `one needs-user per cause: ${causes.join(' ')}`);
  const dir = join(runDir, 'needs-user');
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => /^nu-[0-9]+\.json$/.test(n)) : [];
  assert.equal(files.length, raises.length, 'one needs-user file per raise');

  // One residue per resource; a failed resource is never released.
  if (existsSync(join(d.hostDir, 'residues.jsonl'))) {
    const keys = readResidues(absPath(d.hostDir)).flatMap((r) => (r.type === 'residue' ? [JSON.stringify(r.key)] : []));
    assert.equal(new Set(keys).size, keys.length, 'one residue per key');
  }
  for (const [name, e] of resourceTable(view)) assert.ok(e.pending === null && (e.status.state === 'free' || e.status.state === 'cleanup-failed'), `resource ${name} settled`);

  // One applied receipt per command op.
  const applied = view.opsOf('command.apply').filter((i) => view.doneOf(i.op) !== null);
  for (const i of applied) {
    const receipts = readdirSync(join(runDir, 'commands', 'receipts')).filter((n) => n.startsWith(`${i.expect.command}.applied`));
    assert.equal(receipts.length, 1, `${i.expect.command}: one applied receipt`);
  }
  assert.equal(readCalls(d.scenarioPath).length, callsBefore, 'recovery called no backend');
}

export const callsOf = (d: ArcDescriptor): number => readCalls(d.scenarioPath).length;
export const highWater = (d: ArcDescriptor): number => eventsOf(d).length;

// ---------------------------------------------------------------------------------------------------
// A backend call alive when its executor died

export type CallStage = 'plan-check' | 'build' | 'gate';
export const BARRIER = 'stranded';

/** u1's straight scenario, with the call at `stage` parked at barrier BARRIER (a build commits mul first). */
function strandedSteps(stage: CallStage): readonly Step[] {
  const wait = { type: 'barrier', name: BARRIER, timeoutMs: 120_000 } as const;
  const check = planCheckStep({ decision: 'approve' });
  return [
    stage === 'plan-check' ? { ...check, acts: [wait, ...check.acts] } as Step : check,
    stage === 'build' ? codexStep([{ type: 'commit', message: 'add mul', files: MUL }, wait], { argv: ['exec', '-C'] }) : mulBuild(),
    gateStep({ decision: 'approve' }, {}, stage === 'gate' ? [wait] : []),
  ];
}

/** A child process started in the background, with its exit. */
export type Background = Readonly<{ child: ChildProcess; exit: Promise<number | null> }>;

export function background(name: string, args: readonly string[], env: NodeJS.ProcessEnv): Background {
  const child = spawn(process.execPath, [fixture(name), ...args], { env, stdio: 'ignore' });
  return { child, exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
}

/** SIGKILLs a background child and waits for its end. */
export async function killBackground(b: Background): Promise<void> {
  b.child.kill('SIGKILL');
  await b.exit;
}

/**
 * u1's driver killed while the backend call of `stage` waits at its barrier: the executor is dead, the
 * call's runner (setsid) lives on, its spawn intent is open and its stage attempt has no outcome.
 */
export async function strandedCall(stage: CallStage): Promise<ArcDescriptor> {
  const d = setupArc({ steps: strandedSteps(stage) });
  const driver = background('unit-child.ts', [JSON.stringify(d), 'u1'], unitEnv(d));
  await reached(d.scenarioDir, BARRIER, CHILD_TIMEOUT_MS);
  await killBackground(driver);
  const open = openNow(d).filter((i) => i.kind === 'proc.spawn');
  assert.equal(open.length, 1, 'the stranded call is open');
  return d;
}

/**
 * The recovery engine in the background (it blocks while it adopts a live runner); resolves once it is about
 * to recover, so a runner released after that is one it adopts.
 */
export async function recoverInBackground(d: ArcDescriptor, trigger: string | null = null): Promise<Background> {
  const started = join(tmpDir('rec-started'), 'started');
  const env = trigger === null ? unitEnv(d) : { ...unitEnv(d), ROADMAP_TEST_CRASH: trigger };
  const b = background('rec-child.ts', ['recover', JSON.stringify(d), started], env);
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!existsSync(started)) {
    if (Date.now() >= deadline) throw new Error('the recovery child never started recovering');
    await sleep(20);
  }
  // Recovery reaches the open spawn within milliseconds of starting (nothing precedes it but open kills);
  // nothing shows the moment it starts waiting, so allow ample time on a loaded host.
  await sleep(1_500);
  return b;
}

/** The unit driver on `d` to its end, in a child; returns its printed result. */
export async function driveUnit(d: ArcDescriptor): Promise<unknown> {
  const exit = await runFixture('unit-child.ts', [JSON.stringify(d), 'u1'], { env: unitEnv(d), timeoutMs: CHILD_TIMEOUT_MS });
  assert.equal(exit.code, 0, exit.stderr);
  return JSON.parse(exit.stdout.trim());
}

