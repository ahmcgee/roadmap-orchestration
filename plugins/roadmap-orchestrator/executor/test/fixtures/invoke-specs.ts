// Shared by the invoke, reattach and recover-spawn tests and the invoke-child fixture: launch specs for
// each spawn purpose from a JSON-able descriptor (so a child executor can rebuild the exact spec), a
// stand-in for the recovery engine (step 14b) that runs the proc reconcilers over the open intents, and
// readers for the resulting log.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { freshJudgmentSession, backendArgv } from '../../src/backends/argv.ts';
import { sessionContainment } from '../../src/contain/session.ts';
import { type DoneRecord, type Event, type Fact, type IntentRecord, parseEventLine } from '../../src/core/events.ts';
import { type ArcId, type OpId, arcId, laneId, opKey, resourceName, sha, unitId } from '../../src/core/ids.ts';
import type { Disposition, Reconciler } from '../../src/core/interfaces.ts';
import { EVENTS_FILE, type OpenJournal, openJournal } from '../../src/core/log.ts';
import { type AbsPath, type IsoTime, absPath, isoTimeOf } from '../../src/core/values.ts';
import type { LaunchContent, LaunchSpec, ProcContext } from '../../src/pipeline/invoke.ts';
import { killReconciler } from '../../src/recover/kill.ts';
import { spawnReconciler } from '../../src/recover/spawn.ts';
import { type Exit, fixture, runFixture } from '../helpers/proc.ts';
import { tmpDir } from '../helpers/repo.ts';
import { OK_SCHEMA, ROUTING_REV, type Scenario, type Step, writeScenario } from '../helpers/scenario.ts';

export const UNIT = unitId('u1');
const SCHEMA_TEXT = readFileSync(OK_SCHEMA, 'utf8').trim();

export type Purpose = 'backend' | 'lane' | 'teardown' | 'probe';
export const PURPOSES: readonly Purpose[] = ['backend', 'lane', 'teardown', 'probe'];

/** Everything a spec needs, as plain JSON. `argv` is the command for command purposes; backends run `claude`. */
export type SpecDescriptor = Readonly<{
  runDir: string;
  arc: string;
  purpose: Purpose;
  /** Absent: a new op keyed `spawn:<purpose>`. Present: a retry of that op. */
  retryOf?: string;
  deadlineAt: string;
  graceMs: number;
  cwd: string;
  /** Command purposes: the workload argv. */
  argv?: readonly string[];
  /** Backend purpose: the fake shims' directory, put first on the workload's PATH. */
  binDir?: string;
}>;

export function deadlineIn(ms: number): IsoTime {
  return isoTimeOf(new Date(Date.now() + ms));
}

function path(): string {
  const p = process.env['PATH'];
  assert.ok(p !== undefined, 'tests need PATH');
  return p;
}

export function specFor(d: SpecDescriptor): LaunchSpec {
  const runDir = absPath(d.runDir);
  const cwd = absPath(d.cwd);
  const origin: LaunchSpec['origin'] = d.retryOf === undefined
    ? { type: 'new', key: opKey(`spawn:${d.purpose}`), parent: { type: 'stage', unit: UNIT, stage: 'build', attempt: 1 }, deadlineAt: isoTimeOf(new Date(d.deadlineAt)) }
    : { type: 'retry', op: d.retryOf as OpId };
  if (d.purpose === 'backend') {
    if (d.binDir === undefined) throw new Error('a backend spec needs binDir');
    const env = { PATH: `${d.binDir}:${path()}` };
    return {
      runDir, origin,
      subject: { purpose: 'backend', role: 'gate', routingRev: ROUTING_REV, unit: UNIT, attempt: 1 },
      launch: (invDir: AbsPath): LaunchContent => {
        const session = freshJudgmentSession();
        const argv = backendArgv({ kind: 'claude-judgment', role: 'gate', triple: { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' }, session, schemaText: SCHEMA_TEXT, system: 'You answer with the JSON object the schema describes.', evidenceDirs: [] });
        return {
          argv, cwd, env, stdinPath: null, graceMs: d.graceMs,
          terminal: { type: 'backend', purpose: 'backend', role: 'gate', routingRev: ROUTING_REV, schemaPath: absPath(OK_SCHEMA), outputPath: absPath(join(invDir, 'stdout')), session },
        };
      },
    };
  }
  if (d.argv === undefined) throw new Error(`a ${d.purpose} spec needs argv`);
  const argv = d.argv;
  const subject: LaunchSpec['subject'] = d.purpose === 'lane'
    ? { purpose: 'lane', unit: UNIT, lane: laneId('unit'), set: 'spec', at: sha('0'.repeat(40)) }
    : { purpose: d.purpose, unit: UNIT, resource: resourceName('db') };
  return {
    runDir, origin, subject,
    launch: (): LaunchContent => ({
      argv, cwd, env: { PATH: path() }, stdinPath: null, graceMs: d.graceMs,
      terminal: { type: 'command', purpose: d.purpose as Exclude<Purpose, 'backend'>, expectedExit: 0 },
    }),
  };
}

export function open(runDir: string, arc: string): OpenJournal {
  return openJournal(absPath(runDir), arcId(arc));
}

export function context(journal: OpenJournal, runDir: string): ProcContext {
  return { journal, containment: sessionContainment, runDir: absPath(runDir) };
}

export type Recovered = Readonly<{ op: OpId; kind: 'proc.spawn' | 'proc.kill'; disposition: Disposition<'proc.spawn'> | Disposition<'proc.kill'> }>;

/**
 * The recovery engine's proc part, as step 14b will order it: open proc.kill intents first, then
 * proc.spawn. Opens the journal, reconciles every open intent, closes it.
 */
export async function recover(runDir: string, arc: string): Promise<readonly Recovered[]> {
  const journal = open(runDir, arc);
  try {
    const ctx = context(journal, runDir);
    const kill: Reconciler<'proc.kill'> = killReconciler(ctx);
    const spawn: Reconciler<'proc.spawn'> = spawnReconciler(ctx);
    const out: Recovered[] = [];
    const open = journal.view.openIntents();
    for (const intent of open) if (intent.kind === 'proc.kill') out.push({ op: intent.op, kind: intent.kind, disposition: await kill(intent, journal.view) });
    for (const intent of open) if (intent.kind === 'proc.spawn') out.push({ op: intent.op, kind: intent.kind, disposition: await spawn(intent, journal.view) });
    const other = open.filter((i) => i.kind !== 'proc.kill' && i.kind !== 'proc.spawn');
    assert.deepEqual(other, [], 'only proc ops are open');
    assert.deepEqual(journal.view.openIntents(), [], 'recovery closed every proc intent');
    return out;
  } finally {
    journal.close();
  }
}

/** The open intents after a fresh open of the log (which also verifies it). */
export function openIntents(runDir: string, arc: string): readonly IntentRecord[] {
  const journal = open(runDir, arc);
  try {
    return journal.view.openIntents();
  } finally {
    journal.close();
  }
}

export function events(runDir: string): readonly Event[] {
  const text = readFileSync(join(runDir, EVENTS_FILE), 'utf8');
  return text.split('\n').filter((l) => l !== '').map(parseEventLine);
}

export const intents = (runDir: string, kind: IntentRecord['kind']): readonly IntentRecord[] =>
  events(runDir).filter((e): e is Event & IntentRecord => e.type === 'intent' && e.kind === kind);
export const dones = (runDir: string, kind: DoneRecord['kind']): readonly DoneRecord[] =>
  events(runDir).filter((e): e is Event & DoneRecord => e.type === 'done' && e.kind === kind);
export const usageFacts = (runDir: string): readonly Fact[] =>
  events(runDir).flatMap((e) => (e.type === 'fact' && (e.fact.kind === 'meter' || e.fact.kind === 'usage-unavailable') ? [e.fact] : []));

/** The invocation dirs that exist under the run dir, sorted (`<seq>-<ordinal>`). */
export function invocationDirs(runDir: string): readonly string[] {
  try {
    return readdirSync(join(runDir, 'inv')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function arcFor(): ArcId {
  return arcId(`t-${randomBytes(6).toString('hex')}`);
}

/** Runs test/fixtures/invoke-child.ts to completion (or to its crash), with an optional crash trigger. */
export function runChild(mode: 'invoke' | 'pause', d: SpecDescriptor, trigger: string | null): Promise<Exit> {
  const env = trigger === null ? { ...process.env } : { ...process.env, ROADMAP_TEST_CRASH: trigger };
  return runFixture('invoke-child.ts', [mode, JSON.stringify(d)], { env, timeoutMs: 25_000 });
}

/** Starts invoke-child.ts in the background, for tests that kill it from outside. */
export function startChild(d: SpecDescriptor): ChildProcess {
  return spawn(process.execPath, [fixture('invoke-child.ts'), 'invoke', JSON.stringify(d)], { env: process.env, stdio: 'ignore' });
}

// ---------------------------------------------------------------------------------------------------
// Descriptors for one test's run dir.

export type Run = Readonly<{ runDir: string; arc: string; work: string }>;

export function run(): Run {
  return { runDir: tmpDir('run'), arc: arcFor(), work: tmpDir('work') };
}

export function scenario(steps: readonly Step[]): Scenario {
  return writeScenario(tmpDir('scenario'), steps);
}

// Default deadlines outlast every test's own timeout, so a slow host fails a test by its timeout, never by
// a deadline the test did not ask for (the retry of a lost op inherits the first ordinal's deadline).
const NO_DEADLINE_MS = 60_000;

/** A gate judgment through the fake `claude` of `s`. */
export function backend(r: Run, s: Scenario, deadlineMs = NO_DEADLINE_MS, graceMs = 300): SpecDescriptor {
  return { runDir: r.runDir, arc: r.arc, purpose: 'backend', deadlineAt: deadlineIn(deadlineMs), graceMs, cwd: r.work, binDir: s.binDir };
}

export function command(r: Run, purpose: Exclude<Purpose, 'backend'>, argv: readonly string[], deadlineMs = NO_DEADLINE_MS, graceMs = 300): SpecDescriptor {
  return { runDir: r.runDir, arc: r.arc, purpose, deadlineAt: deadlineIn(deadlineMs), graceMs, cwd: r.work, argv };
}
