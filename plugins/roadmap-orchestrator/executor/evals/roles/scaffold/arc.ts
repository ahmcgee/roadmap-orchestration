// One scaffold trial end to end, through the production scaffold stage, as test/scaffold.test.ts drives it: the cell's arc
// (fixture.ts), u1 run by the unit driver from its plan-check (fake: the cell's scaffold decision) through the scaffold stage
// (src/pipeline/scaffold.ts: the unit worktree, the scaffold seat's call, code's path and entry-point checks, the dry run of
// the load lane on the written tree, the commit; one retry told why, then a plan-defect park), held before the build. The
// writer's calls go through the fake backend's PATH shim: its `real` act execs the real `claude` with the production argv
// (a second serves the retry); a degenerate fake writer (`FAKE_WRITERS`) answers instead for the free tier.
//
// The grade is what code decided: `first` (scaffolded on the first attempt), `retry` (refused, then scaffolded) or `defect`
// (refused twice: the plan-defect park). Anything else voids the trial: `error` (the arc failed, or code recorded another
// outcome), `cap` and `runaway` (the monitor's brakes: live spend over `--trial-cap`, token load over 3x the cell's median),
// `needle` (the session touched the run dir, the eval's sources or this repository). The stage's own 30-minute call deadline
// bounds a session in time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { arcId, invocationId, type InvocationId } from '../../../src/core/ids.ts';
import type { JsonValue } from '../../../src/core/json.ts';
import { readJournal } from '../../../src/core/log.ts';
import { STDOUT_FILE } from '../../../src/core/records.ts';
import { absPath, matchesPattern, repoPath, repoPattern } from '../../../src/core/values.ts';
import { readClaude } from '../../../src/backends/claude.ts';
import { unitBranch } from '../../../src/pipeline/dispatch.ts';
import { invocationDir } from '../../../src/pipeline/invoke.ts';
import { runUnit } from '../../../src/pipeline/unit.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import { type RepoConfig, arcStack, resolveRouting } from '../../../src/routing/layers.ts';
import { runnerFiles } from '../../../src/runner/files.ts';
import { type ArcRun, U1, contextFor } from '../../../test/fixtures/unit-common.ts';
import { git, revParse } from '../../../test/helpers/repo.ts';
import { type Step, readCalls } from '../../../test/helpers/scenario.ts';
import { repositoryPaths, scanTranscript } from '../../m4a/transcript.ts';
import type { CellSet } from '../gate/cells.ts';
import { type Usage, parseEvents, readTranscript, sumUsage, toolCounts, unavailableCalls, usageOf } from '../transcript.ts';
import { OVERSPEND } from '../walkthrough/arc.ts';
import type { ScaffoldCell } from './cells.ts';
import { SCAFFOLD_TIER, keyOf, setupScaffoldArc } from './fixture.ts';

/**
 * Degenerate writers, each knowing the cell's reference skeleton: `oracle` writes it; `fix-on-retry` writes it without its
 * test files (the load test never runs: refused), then whole on the retry; `outside` writes it plus a note outside the new
 * system's paths, twice (refused, then the plan-defect park); `nothing` writes nothing, twice; `overspend` streams one
 * message billed far over any trial cap and then hangs (the spend brake's own check).
 */
export const FAKE_WRITERS = ['oracle', 'fix-on-retry', 'outside', 'nothing', 'overspend'] as const;
export type FakeWriter = (typeof FAKE_WRITERS)[number];
export type WriterKind = 'real' | FakeWriter;

export type ScaffoldVoidReason = 'runaway' | 'cap' | 'error' | 'needle';
/** What code decided: scaffolded on the first attempt, scaffolded after one refusal, or refused twice (plan-defect). */
export type Verdict = 'first' | 'retry' | 'defect';

export type ScaffoldRow = Readonly<{
  set: CellSet;
  cell: string;
  family: string;
  trial: number;
  writer: WriterKind;
  void: Readonly<{ reason: ScaffoldVoidReason; detail: string }> | null;
  verdict: Verdict | null;
  /** u1's stage outcomes, `stage:outcome`, in log order. */
  outcomes: readonly string[];
  /** Code's reasons for each refused attempt, in order (the `refused` and `plan-defect` outcomes' details). */
  refusals: readonly (readonly string[])[];
  /** The committed skeleton's paths and added lines, when one landed. */
  files: readonly string[];
  linesAdded: number | null;
  usage: Usage | null;
  /** The trial's spend at list price from its transcripts (`liveUsd`): what a session killed before its result cost. */
  estimatedUsd: number;
  wallMs: number;
  turns: number;
  load: number;
  /** Scaffold calls made: 2 when the first attempt was refused. */
  calls: number;
  models: readonly string[];
  method: Readonly<{
    available: readonly string[];
    tools: Readonly<Record<string, number>>;
    shellCalls: number;
    subagents: readonly Readonly<{ type: string | null; model: string | null; tokens: number }>[];
    denials: number;
    unavailable: readonly string[];
  }>;
  dir: string;
}>;

export type ScaffoldWorkerArgs = Readonly<{
  role: 'scaffold';
  set: CellSet;
  cell: string;
  trial: number;
  writer: WriterKind;
  /** The repo config of `--rebind` (`routing.classes`), or null. */
  config: RepoConfig | null;
  out: string;
  medianLoad: number | null;
  trialCap: number | null;
}>;

/** The scaffold seat under the run's routing (the dev17 role set, `--rebind` applied), as the arm names it. */
export function scaffoldSeat(config: RepoConfig | null): Readonly<{ arm: string }> {
  const r = resolveRouting({ ...arcStack('default', config, null), arcRoles: 'dev17' });
  const t = r.table.scaffold[SCAFFOLD_TIER];
  if (t.backend !== 'claude') throw new Error(`the scaffold seat bound to ${t.model}: the scaffold writer is Claude only`);
  promptFor('scaffold', t.model); // a rebind onto a model with no scaffold prompt fails here, before any trial
  const cls = r.classes.scaffold[SCAFFOLD_TIER];
  return { arm: `scaffold.${SCAFFOLD_TIER} ${cls}${r.bindings[cls] === 'repo-config' ? ' (rebound)' : ''} ${t.model}:${t.effort}` };
}

// ---------------------------------------------------------------------------------------------------
// The writers

/** The scaffold calls: the real CLI (the first attempt and the retry), or a fake writer's. */
function writerSteps(kind: WriterKind, c: ScaffoldCell): readonly Step[] {
  if (kind === 'real') return [1, 2].map((): Step => ({ as: 'claude', expect: {}, acts: [{ type: 'real' }] }));
  const step = (retry: boolean, files: Readonly<Record<string, string>>): Step => ({
    as: 'claude',
    expect: { argv: ['-p', '--permission-mode', 'bypassPermissions', '--session-id'], stdinContains: [`<new_system name="${c.newSystem.name}">`, ...(retry ? ['<previous_attempt>'] : [])] },
    acts: [...(Object.keys(files).length === 0 ? [] : [{ type: 'dirty' as const, files }]), { type: 'emit', value: { summary: 'Wrote the skeleton.', paths: Object.keys(files) } }],
  });
  const isTest = (p: string): boolean => c.newSystem.tests.some((g) => matchesPattern(repoPath(p), repoPattern(g)));
  const outside = { ...c.reference, [`notes/${c.newSystem.name}.md`]: `# ${c.newSystem.name}\n` };
  switch (kind) {
    case 'oracle': return [step(false, c.reference)];
    case 'fix-on-retry': return [step(false, Object.fromEntries(Object.entries(c.reference).filter(([p]) => !isTest(p)))), step(true, c.reference)];
    case 'outside': return [step(false, outside), step(true, outside)];
    case 'nothing': return [step(false, {}), step(true, {})];
    case 'overspend': return [{ as: 'claude', expect: {}, acts: [{ type: 'stream', events: [OVERSPEND] }, { type: 'hang', ms: 10 * 60_000 }] }];
  }
}

// ---------------------------------------------------------------------------------------------------
// The monitor: trace and brakes

const POLL_MS = 5_000;
const TRACE_MS = 30_000;
const LOAD_FACTOR = 3;

export type Brake = Readonly<{ rule: 'load' | 'cap'; detail: string }>;

/** The scaffold calls' spawn intents, in order. */
const scaffoldSpawns = (r: ArcRun) => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'scaffold');

function readStdout(r: ArcRun, inv: InvocationId): string {
  const file = join(invocationDir(r.ctx.runDir, inv), STDOUT_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Watches the trial's scaffold sessions: TRACE lines, and the brakes, which kill the open session (and any after it). */
function startMonitor(r: ArcRun, label: string, medianLoad: number | null, trialCap: number | null, log: (line: string) => void): { stop: () => void; brake: () => Brake | null } {
  let braked: Brake | null = null;
  let lastTrace = Date.now();
  let firstAt: number | null = null;
  const kill = (inv: InvocationId): void => {
    const runner = runnerFiles(invocationDir(r.ctx.runDir, inv), inv).read('runner.json');
    if (runner?.child === null || runner?.child === undefined) return;
    try {
      process.kill(-runner.child.sid, 'SIGKILL');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  };
  const tick = (): void => {
    const spawns = scaffoldSpawns(r);
    const open = spawns.filter((i) => r.journal.view.doneOf(i.op) === null).at(-1);
    if (open === undefined) return;
    const inv = invocationId(open.op, open.ordinal);
    if (braked !== null) return kill(inv);
    firstAt ??= Date.now();
    const t = readTranscript(parseEvents(spawns.map((s) => readStdout(r, invocationId(s.op, s.ordinal))).join('\n'), true));
    if (trialCap !== null && t.liveUsd > trialCap) braked = { rule: 'cap', detail: `live spend $${t.liveUsd.toFixed(2)} over the trial cap $${trialCap.toFixed(2)}` };
    else if (medianLoad !== null && t.load > LOAD_FACTOR * medianLoad) braked = { rule: 'load', detail: `token load ${t.load} over ${LOAD_FACTOR}x the cell median ${medianLoad}` };
    if (braked !== null) {
      log(`BRAKE ${label} ${braked.rule}: ${braked.detail}`);
      kill(inv);
      return;
    }
    const now = Date.now();
    if (now - lastTrace >= TRACE_MS) {
      lastTrace = now;
      const counts = toolCounts(t);
      log(`TRACE ${label} ${Math.round((now - firstAt) / 1000)}s tools=${JSON.stringify(counts)} bash=${counts['Bash'] ?? 0} subagents=${t.subagents.length} load=${t.load} spent=$${t.liveUsd.toFixed(2)} turns=${t.turns}`);
    }
  };
  const timer = setInterval(tick, POLL_MS);
  return { stop: () => clearInterval(timer), brake: () => braked };
}

// ---------------------------------------------------------------------------------------------------
// A trial

type Outcome = Readonly<{ stage: string; outcome: string; reasons: readonly string[] | null }>;

/** u1's stage outcomes in log order, each with its refusal or defect reasons. */
function outcomesOf(r: ArcRun): readonly Outcome[] {
  return readJournal(r.ctx.runDir, arcId(r.d.arc)).events.flatMap((e) => {
    if (e.type !== 'fact' || e.fact.kind !== 'stage-outcome' || e.fact.unit !== 'u1') return [];
    const d = e.fact.detail;
    return [{ stage: e.fact.stage, outcome: e.fact.outcome, reasons: d?.kind === 'scaffold-refused' || d?.kind === 'design-defect' ? d.reasons : null }];
  });
}

/** The verdict code's scaffold outcomes give, or null for any other sequence. */
function verdictOf(scaffold: readonly string[]): Verdict | null {
  switch (scaffold.join()) {
    case 'scaffolded': return 'first';
    case 'refused,scaffolded': return 'retry';
    case 'refused,plan-defect': return 'defect';
    default: return null;
  }
}

const emptyMethod: ScaffoldRow['method'] = { available: [], tools: {}, shellCalls: 0, subagents: [], denials: 0, unavailable: [] };

/** One trial; writes its artifacts and row.json into `o.out` and returns the row. */
export async function runScaffoldTrial(o: Omit<ScaffoldWorkerArgs, 'cell'> & Readonly<{ cell: ScaffoldCell; log: (line: string) => void }>): Promise<ScaffoldRow> {
  const label = `${o.cell.id}#${o.trial}`;
  mkdirSync(o.out, { recursive: true });
  const d = await setupScaffoldArc(o.cell, writerSteps(o.writer, o.cell), o.config);
  writeFileSync(join(o.out, 'key.json'), `${JSON.stringify(keyOf(o.cell, o.trial, revParse(d.repo, 'main')), null, 2)}\n`);
  const r = contextFor(d);
  const monitor = startMonitor(r, label, o.medianLoad, o.trialCap, o.log);
  const started = Date.now();
  let error: string | null = null;
  try {
    // Held before the build, or at once after a brake (no further call starts).
    await runUnit(r.ctx, r.unit('u1'), (next) => Promise.resolve(next.stage !== 'build' && monitor.brake() === null));
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    monitor.stop();
  }
  const wallMs = Date.now() - started;
  const outcomes = outcomesOf(r);
  const scaffold = outcomes.filter((x) => x.stage === 'scaffold');
  const verdict = verdictOf(scaffold.map((x) => x.outcome));

  const perCall = scaffoldSpawns(r).map((s) => {
    const stdout = readStdout(r, invocationId(s.op, s.ordinal));
    const events = parseEvents(stdout, true);
    const result = events.findLast((e) => e['type'] === 'result');
    return { stdout, events, usage: result === undefined ? null : usageOf(result) };
  });
  perCall.forEach((c, i) => writeFileSync(join(o.out, `scaffold-${i + 1}.jsonl`), c.stdout));
  // The calls after the plan-check's are the writer's: each attempt's prompt.
  const calls = readCalls(d.scenarioPath).slice(1);
  calls.forEach((c, i) => writeFileSync(join(o.out, `prompt-${i + 1}.txt`), c.stdin));
  writeFileSync(join(o.out, 'argv.json'), `${JSON.stringify(calls[0]?.argv ?? [], null, 2)}\n`);
  const allEvents = perCall.flatMap((c) => c.events);
  const transcriptFile = join(o.out, 'transcript.jsonl');
  writeFileSync(transcriptFile, allEvents.map((event, i) => `${JSON.stringify({ turn: 1, line: i + 1, event })}\n`).join(''));
  const t = readTranscript(allEvents);
  const last = perCall.at(-1);
  const reading = last === undefined ? null : readClaude(last.stdout);
  if (reading !== null && reading.output.kind === 'present') writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(reading.output.value as JsonValue, null, 2)}\n`);

  // The committed skeleton: the unit branch's one commit past the integration tip.
  const landed = verdict === 'first' || verdict === 'retry';
  const range = `main..${unitBranch(r.ctx.plan().arc, U1)}`;
  const numstat = landed ? git(d.repo, 'diff', '--numstat', range).split('\n').filter((l) => l !== '').map((l) => l.split('\t') as [string, string, string]) : [];
  if (landed) writeFileSync(join(o.out, 'skeleton.diff'), git(d.repo, 'diff', range));

  const hits = scanTranscript(transcriptFile, [o.out, dirname(o.out), 'evals/roles', ...repositoryPaths()]);
  const brake = monitor.brake();
  const voided: ScaffoldRow['void'] = brake !== null ? { reason: brake.rule === 'cap' ? 'cap' : 'runaway', detail: `${brake.rule}: ${brake.detail}` }
    : error !== null ? { reason: 'error', detail: error }
    : outcomes[0]?.outcome !== 'scaffold' ? { reason: 'error', detail: `the plan-check did not decide scaffold: ${outcomes.map((x) => `${x.stage}:${x.outcome}`).join(', ')}` }
    : verdict === null ? { reason: 'error', detail: `code recorded scaffold outcomes ${scaffold.map((x) => x.outcome).join(', ') || 'none'}` }
    : hits.length > 0 ? { reason: 'needle', detail: hits.slice(0, 5).join('; ') }
    : null;
  const counts = toolCounts(t);
  const usage = sumUsage(perCall.flatMap((c) => (c.usage === null ? [] : [c.usage])));
  const row: ScaffoldRow = {
    set: o.set, cell: o.cell.id, family: o.cell.family, trial: o.trial, writer: o.writer, void: voided, verdict: voided === null ? verdict : null,
    outcomes: outcomes.map((x) => `${x.stage}:${x.outcome}`), refusals: scaffold.flatMap((x) => (x.reasons === null ? [] : [x.reasons])),
    files: numstat.map(([, , p]) => p), linesAdded: landed ? numstat.reduce((a, [added]) => a + Number(added), 0) : null,
    usage, estimatedUsd: t.liveUsd, wallMs, turns: t.turns, load: t.load, calls: perCall.length, models: usage === null ? [] : Object.keys(usage.byModel),
    method: perCall.length === 0 ? emptyMethod : {
      available: t.tools, tools: counts, shellCalls: counts['Bash'] ?? 0,
      subagents: t.subagents.map((a) => ({ type: a.type, model: a.model, tokens: a.inputTokens + a.outputTokens })), denials: t.denials, unavailable: unavailableCalls(t),
    },
    dir: o.out,
  };
  r.journal.close();
  writeFileSync(join(o.out, 'row.json'), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}
