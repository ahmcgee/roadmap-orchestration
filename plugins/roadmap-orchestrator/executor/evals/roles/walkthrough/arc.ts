// One walkthrough trial end to end, through the production walk job, as the gate eval runs the production gate: a
// holistic arc whose repository is the cell's product (product.ts) and whose plan has one milestone (fixture.ts) over one
// unit, u1. u1 merges through the arc harness (fake plan-check, build and gate; its lanes, the product's own tests, run
// for real), which makes the milestone's walk due; then `runWalk` (src/walk/walk.ts) runs walk-1 exactly as an arc does:
// the capture, the detached checkout, the bring-up (src/walk/bringup.ts), the inputs, the acting-judge call
// (dispatch.ts `callActingJudge`, the walkthrough seat, the repo config's walkthrough MCP servers substituted by
// src/backends/mcp.ts), the reading (`validateWalkthroughOutput` and `walkRefusals`) with its one repair turn, minting
// and teardown. The walkthrough call goes through the fake backend's PATH shim: its `real` act execs the real `claude`
// (a second real act serves the repair turn), a degenerate fake walker (`FakeWalker`) answers instead for the free tier.
//
// A walk that ends `abandoned` after its calls (its report refused again after the repair turn) voids the trial as
// `invalid`, naming the reasons; `bring-up-failed` voids it as `bring-up`.
//
// While the session runs, a monitor reads its stream every 5 s: a TRACE line every 30 s (tools by name, browser calls,
// shell calls, subagents, token load, spend) and the harness's brakes, which kill the session: the token load over 3x
// the cell's median so far (`runaway`), past 45 minutes (`runaway`), the trial's live spend at list price over
// `--trial-cap` (`cap`; every walkthrough call of the trial counted).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type InvocationId, type JobId, arcId, invocationId } from '../../../src/core/ids.ts';
import type { JsonValue } from '../../../src/core/json.ts';
import { openJournal } from '../../../src/core/log.ts';
import { STDOUT_FILE, type RunStart } from '../../../src/core/records.ts';
import { atomicJson } from '../../../src/core/fsx.ts';
import { SchemaError } from '../../../src/core/validate.ts';
import { absPath, isoTimeOf } from '../../../src/core/values.ts';
import { SCHEMA_VERSION } from '../../../src/core/version.ts';
import { jobEvidenceRoot } from '../../../src/git/snapshot.ts';
import { readClaude } from '../../../src/backends/claude.ts';
import { readInputFiles, recordPlan, requirePlanInForce } from '../../../src/input/inforce.ts';
import { milestonesOf } from '../../../src/input/plan.ts';
import { invocationDir } from '../../../src/pipeline/invoke.ts';
import { holisticInForce } from '../../../src/pipeline/stages.ts';
import { runUnit } from '../../../src/pipeline/unit.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import { type WalkthroughOutput, validateWalkthroughOutput } from '../../../src/prompts/schemas.ts';
import { type RepoConfig, arcStack, resolveRouting } from '../../../src/routing/layers.ts';
import { profileName } from '../../../src/routing/types.ts';
import { runnerFiles } from '../../../src/runner/files.ts';
import { runWalk } from '../../../src/walk/walk.ts';
import { walkRefusals } from '../../../src/walk/report.ts';
import type { ArcRun } from '../../../test/fixtures/unit-common.ts';
import { type ArcDescriptor, contextFor, laneJson } from '../../../test/fixtures/unit-common.ts';
import { arcFor } from '../../../test/fixtures/invoke-specs.ts';
import { unitSteps } from '../../../test/fixtures/audit-common.ts';
import { obligationsJson } from '../../../test/fixtures/brake-common.ts';
import { admitAll } from '../../../test/fixtures/stage-common.ts';
import { unitInForce, walkContext } from '../../../test/fixtures/walk-common.ts';
import { makeRepo, revParse, tmpDir } from '../../../test/helpers/repo.ts';
import { type Step, readCalls, writeScenario } from '../../../test/helpers/scenario.ts';
import { writeWitnessControl } from '../../../test/helpers/witness.ts';
import { repositoryPaths, scanTranscript } from '../../m4a/transcript.ts';
import type { CellSet } from '../gate/cells.ts';
import { type Usage, parseEvents, readTranscript, sumUsage, toolCounts, unavailableCalls, usageOf } from '../transcript.ts';
import { FLOW_PAGE, pagePath } from './families.ts';
import {
  ADVANCES, MILESTONE_UNIT, REFERENCE, RELEASE_NOTE, type SlotKey, UNIT_ACCEPTANCE, VISION_JSON, type WalkCell, type WalkFixture, type WalkKey,
  buildWalkFixture, walkRepoConfig,
} from './fixture.ts';
import { type WalkGraded, gradeWalk } from './grade.ts';

/**
 * Degenerate walkers, each knowing the key (what a cheating walker would know): `clean-report` reports every journey
 * completed and nothing found; `oracle` exercises every slot's journey and reports every plant at its expected class;
 * `cite-plants` reports the same with no exercise (lucky); `flag-everything` reports a `deviates` finding on every slot,
 * twins included; `breaks-everything` a `breaks` on every slot; `refused` cites evidence that does not exist, twice, so
 * the walk job's repair turn fails too (void `invalid`); `overspend` streams one message billed far over any trial cap
 * and then hangs (the spend brake's own check).
 */
export const FAKE_WALKERS = ['clean-report', 'oracle', 'cite-plants', 'flag-everything', 'breaks-everything', 'refused', 'overspend'] as const;
export type FakeWalker = (typeof FAKE_WALKERS)[number];
export type WalkerKind = 'real' | FakeWalker;

export type WalkVoidReason = 'runaway' | 'cap' | 'error' | 'needle' | 'bring-up' | 'invalid';

export type WalkRow = Readonly<{
  set: CellSet;
  cell: string;
  trial: number;
  walker: WalkerKind;
  void: Readonly<{ reason: WalkVoidReason; detail: string }> | null;
  graded: WalkGraded | null;
  usage: Usage | null;
  /** The trial's spend at list price from its transcripts (`liveUsd`): what a session killed before its result cost. */
  estimatedUsd: number;
  wallMs: number;
  turns: number;
  load: number;
  /** Walkthrough calls made: 2 when the report took its repair turn. */
  calls: number;
  models: readonly string[];
  method: Readonly<{
    available: readonly string[];
    tools: Readonly<Record<string, number>>;
    browserCalls: number;
    shellCalls: number;
    subagents: readonly Readonly<{ type: string | null; model: string | null; tokens: number }>[];
    denials: number;
    unavailable: readonly string[];
  }>;
  /** Files the walk's evidence dir holds (screenshots, transcripts, notes, the product's logs), and how many are images. */
  evidence: Readonly<{ files: number; screenshots: number }>;
  dir: string;
}>;

export type WalkWorkerArgs = Readonly<{
  role: 'walkthrough';
  set: CellSet;
  cell: string;
  trial: number;
  walker: WalkerKind;
  /** The repo config of `--rebind` (`routing.classes`), or null. */
  config: RepoConfig | null;
  out: string;
  medianLoad: number | null;
  trialCap: number | null;
}>;

const JOB = 'walk-1' as JobId;
const SESSION_MS = 45 * 60_000;
const POLL_MS = 5_000;
const TRACE_MS = 30_000;
const LOAD_FACTOR = 3;
const MODEL_FOR_FAKES = 'claude-opus-5-5';
const RULINGS = '# Rulings\n\nC-1 — Every ledgerly surface follows the design reference in design/.\n';

/** The walk seat under the run's routing (the built-in seats with the walk roles in force, `--rebind` applied), as the arm names it. */
export function walkSeat(config: RepoConfig | null): Readonly<{ arm: string }> {
  const r = resolveRouting({ ...arcStack('default', config, null), arcScope: 'corpus', arcRoles: 'm4b', milestones: true });
  const t = r.table.walkthrough.arc;
  if (t.backend !== 'claude') throw new Error(`the walkthrough seat bound to ${t.model}: walks run on Claude only (codex-judgment)`);
  promptFor('walkthrough', t.model); // a rebind onto a model with no walkthrough prompt fails here, before any trial
  const cls = r.classes.walkthrough.arc;
  return { arm: `walkthrough.arc ${cls}${r.bindings[cls] === 'repo-config' ? ' (rebound)' : ''} ${t.model}:${t.effort}` };
}

// ---------------------------------------------------------------------------------------------------
// Degenerate walkers

/** The tool call a fake makes to exercise `s` (a browser visit or a shell command), as stream-json events. */
function exerciseEvents(s: SlotKey, base: string, month: string, n: number): JsonValue[] {
  const at = s.at;
  const page = at.kind === 'page' ? at.page : at.kind === 'flow' ? FLOW_PAGE[at.journey] : null;
  const call = page !== null
    ? { name: 'mcp__playwright__browser_navigate', input: { url: `${base}${pagePath(page, month)}` } }
    : { name: 'Bash', input: { command: shellCommand(s, base) } };
  const id = `toolu_fake_${n}`;
  return [
    { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_fake_${n}`, model: MODEL_FOR_FAKES, content: [{ type: 'tool_use', id, ...call }], usage: { input_tokens: 100, output_tokens: 20 } } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } },
  ];
}

function shellCommand(s: SlotKey, base: string): string {
  switch (s.family) {
    case 'W8': return s.journeys[0] === 'J-4' ? 'node bin/ledgerly.js import samples/bad.csv' : 'node bin/ledgerly.js report --team nope';
    case 'W9': return `curl -s -X POST ${base}/api/v1/entries -d '{}'`;
    case 'W10': return 'node bin/ledgerly.js config check';
    case 'W11': return 'node bin/ledgerly.js';
    case 'W12': return 'node ci/run.js';
    case 'W13': return 'node bin/ledgerly.js init --data .ledgerly';
    default: throw new Error(`${s.family} is not a shell slot`);
  }
}

const EVIDENCE_NOTE = 'notes.md';

function fakeFinding(s: SlotKey, cls: 'breaks' | 'deviates', evidence: string): JsonValue {
  return {
    class: cls, journey: s.journeys[0]!, evidence: [evidence], claim: s.what, cause: s.what,
    against: cls === 'breaks' ? { type: 'journey' } : { type: 'design', path: `${REFERENCE}/DESIGN.md`, anchor: 'Principles' }, paths: [s.files[0]!],
  };
}

/** A degenerate walker's report. */
function fakeAnswer(kind: Exclude<FakeWalker, 'overspend'>, f: WalkFixture): JsonValue {
  const evidence = kind === 'refused' ? 'nowhere.png' : EVIDENCE_NOTE;
  const findings = kind === 'clean-report' || kind === 'refused' ? []
    : kind === 'flag-everything' ? f.slots.map((s) => fakeFinding(s, 'deviates', evidence))
    : kind === 'breaks-everything' ? f.slots.map((s) => fakeFinding(s, 'breaks', evidence))
    : f.slots.filter((s) => s.state === 'plant').map((s) => fakeFinding(s, s.expected === 'breaks' ? 'breaks' : 'deviates', evidence));
  return {
    final: true,
    journeys: f.milestone.journeys.map((j) => ({ journey: j.id, outcome: 'completed', evidence: [evidence], note: 'walked' })),
    findings, polish: [], premises: [], reasons: ['walked every journey'],
  };
}

const OVERSPEND: JsonValue = {
  type: 'assistant', parent_tool_use_id: null,
  message: { id: 'msg-overspend', model: MODEL_FOR_FAKES, content: [{ type: 'text', text: 'walking at length' }], usage: { input_tokens: 10, output_tokens: 1_000_000 } },
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The walkthrough's calls: the real CLI (the call and its repair turn), or one fake answer (`refused`: refused twice). */
function walkerSteps(kind: WalkerKind, f: WalkFixture, evidence: string): readonly Step[] {
  const unit = JOB;
  if (kind === 'real') return [1, 2].map((): Step => ({ as: 'claude', unit, expect: {}, acts: [{ type: 'real' }] }));
  const expect = { argv: ['-p', '--strict-mcp-config', '--mcp-config', '--setting-sources', 'project', '--permission-mode', 'bypassPermissions'] };
  if (kind === 'overspend') return [{ as: 'claude', unit, expect, acts: [{ type: 'stream', events: [OVERSPEND] }, { type: 'hang', ms: 10 * 60_000 }] }];
  if (kind === 'refused') return [1, 2].map((): Step => ({ as: 'claude', unit, expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: fakeAnswer(kind, f) }] }));
  // A visit's address: grading matches the page's path, whatever the host and port.
  const base = 'http://127.0.0.1';
  const events = kind === 'oracle' ? f.slots.flatMap((s, i) => exerciseEvents(s, base, f.data.month, i)) : [];
  return [{
    as: 'claude', unit, expect,
    acts: [
      { type: 'writeToPrompt', pattern: `(${escapeRe(evidence)})`, file: EVIDENCE_NOTE, text: 'walked\n' },
      ...(events.length === 0 ? [] : [{ type: 'stream' as const, events }]),
      { type: 'emit', value: fakeAnswer(kind, f) },
    ],
  }];
}

// ---------------------------------------------------------------------------------------------------
// The arc

/** Lays out the trial's arc (the product as its repository, the milestone's plan) and records revision 1, as a start does. */
export function setupWalkArc(f: WalkFixture, kind: WalkerKind, config: RepoConfig): ArcDescriptor {
  const repo = tmpDir('walk-repo');
  for (const [path, text] of f.files) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  makeRepo(repo, { files: {} });
  const planDir = tmpDir('walk-plan');
  const lane = { id: 'unit', argv: ['node', '--test', 'test/*.test.js'] };
  const scope = ['CHANGELOG.md'];
  writeFileSync(join(planDir, `${MILESTONE_UNIT}.json`), JSON.stringify({
    schema: 'roadmap/spec-m1', unit: MILESTONE_UNIT, rev: 1, lanes: [{ ...laneJson(lane), state: 'active' }],
    acceptance: UNIT_ACCEPTANCE.map((clause, i) => ({ id: `A${i + 1}`, clause, failLoudIfUndelivered: true, state: 'active' })),
    scope, resources: [], decisions: [], facts: [], cites: { contracts: [`${REFERENCE}/api.md`], rulings: ['C-1'] },
  }));
  writeFileSync(join(planDir, 'rulings.md'), RULINGS);
  writeFileSync(join(planDir, 'vision.json'), JSON.stringify(VISION_JSON));
  const control = join(tmpDir('walk-witness'), 'control.json');
  writeWitnessControl(control, { trees: { '*': { outcomes: { t1: 'pass' } } } });
  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify(obligationsJson({ obligations: [{ id: 'I-1', testIds: ['t1'] }], mapping: [] }, control)));
  const arc = arcFor();
  const planPath = join(planDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: revParse(repo, 'main'), worktreeRoot: tmpDir('walk-wt'),
    contracts: [`${REFERENCE}/api.md`], rulings: 'rulings.md', architectureDoc: 'ARCHITECTURE.md', direction: 'Ship the milestone to its design reference.',
    suite: { lanes: [laneJson({ ...lane, id: 'suite' })] }, resources: [],
    units: [{ id: MILESTONE_UNIT, spec: `${MILESTONE_UNIT}.json`, risk: 'med', scope, resources: [] }],
    holistic: { vision: 'vision.json', advances: ADVANCES, obligations: 'obligations.json', audit: { lenses: ['vision'], every: 100 } },
    milestones: [JSON.parse(JSON.stringify(f.milestone)) as JsonValue],
  }));
  const runDir = tmpDir('walk-run');
  const scenarioDir = tmpDir('walk-scenario');
  const scenario = writeScenario(scenarioDir, [...unitSteps(MILESTONE_UNIT, RELEASE_NOTE), ...walkerSteps(kind, f, jobEvidenceRoot(absPath(runDir), JOB))]);
  const d: ArcDescriptor = { arc, repo, planPath, runDir, hostDir: join(tmpDir('walk-host'), 'roadmap'), binDir: scenario.binDir, scenarioPath: scenario.path, scenarioDir, config };
  // Revision 1 recorded as a first start records it (test/fixtures/publish-common.ts publishArc).
  const j = openJournal(absPath(runDir), arcId(arc));
  recordPlan(j, absPath(runDir), readInputFiles(absPath(planPath), absPath(repo)), [], { profile: 'default', config, arcRoles: 'm4b' });
  j.close();
  const start: RunStart = { v: SCHEMA_VERSION, generation: 1, at: isoTimeOf(new Date()), repo: absPath(repo), planFile: absPath(planPath), profile: profileName('default', 'profile') };
  atomicJson(join(runDir, 'start.json'), start);
  return d;
}

// ---------------------------------------------------------------------------------------------------
// The monitor: trace and brakes

type Brake = Readonly<{ rule: 'load' | 'cap' | 'deadline'; detail: string }>;

/** The walkthrough calls' spawn intents, in order. */
const walkSpawns = (r: ArcRun) => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'arc-backend' && i.expect.subject.role === 'walkthrough');

function readStdout(r: ArcRun, inv: InvocationId): string {
  const file = join(invocationDir(r.ctx.runDir, inv), STDOUT_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

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
    const view = r.journal.view;
    const open = walkSpawns(r).filter((i) => view.doneOf(i.op) === null).at(-1);
    if (open === undefined) return;
    const inv = invocationId(open.op, open.ordinal);
    if (braked !== null) return kill(inv);
    firstAt ??= Date.now();
    const spawns = walkSpawns(r);
    const t = readTranscript(parseEvents(spawns.map((s) => readStdout(r, invocationId(s.op, s.ordinal))).join('\n'), true));
    const now = Date.now();
    if (trialCap !== null && t.liveUsd > trialCap) braked = { rule: 'cap', detail: `live spend $${t.liveUsd.toFixed(2)} over the trial cap $${trialCap.toFixed(2)}` };
    else if (medianLoad !== null && t.load > LOAD_FACTOR * medianLoad) braked = { rule: 'load', detail: `token load ${t.load} over ${LOAD_FACTOR}x the cell median ${medianLoad}` };
    else if (now - firstAt > SESSION_MS) braked = { rule: 'deadline', detail: `still walking after ${SESSION_MS / 60_000} minutes` };
    if (braked !== null) {
      log(`BRAKE ${label} ${braked.rule}: ${braked.detail}`);
      kill(inv);
      return;
    }
    if (now - lastTrace >= TRACE_MS) {
      lastTrace = now;
      const counts = toolCounts(t);
      log(`TRACE ${label} ${Math.round((now - firstAt) / 1000)}s tools=${JSON.stringify(counts)} browser=${t.calls.filter((c) => c.name.startsWith('mcp__')).length} `
        + `bash=${counts['Bash'] ?? 0} subagents=${t.subagents.length} load=${t.load} spent=$${t.liveUsd.toFixed(2)} turns=${t.turns}`);
    }
  };
  const timer = setInterval(tick, POLL_MS);
  return { stop: () => clearInterval(timer), brake: () => braked };
}

// ---------------------------------------------------------------------------------------------------
// A trial

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): readonly string[] =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : [];

/** Why the walk job refused the last report (schema, or its own checks), for an `invalid` void. */
function refusals(r: ArcRun, value: unknown): string {
  let output: WalkthroughOutput;
  try {
    output = validateWalkthroughOutput(value);
  } catch (e) {
    if (e instanceof SchemaError) return `off its schema: ${e.message}`;
    throw e;
  }
  const plan = requirePlanInForce(r.ctx.runDir, r.journal.view).plan;
  const vision = holisticInForce(r.ctx).vision;
  if (vision === null) throw new Error('a walk trial without its vision in force');
  return walkRefusals({ milestone: milestonesOf(plan)[0]!, plan, vision, evidenceDir: jobEvidenceRoot(r.ctx.runDir, JOB) }, output).join('; ');
}

const emptyMethod: WalkRow['method'] = { available: [], tools: {}, browserCalls: 0, shellCalls: 0, subagents: [], denials: 0, unavailable: [] };

/** One trial; writes its artifacts and row.json into `o.out` and returns the row. */
export async function runWalkTrial(o: Omit<WalkWorkerArgs, 'cell'> & Readonly<{ cell: WalkCell; log: (line: string) => void }>): Promise<WalkRow> {
  const label = `${o.cell.id}#${o.trial}`;
  mkdirSync(o.out, { recursive: true });
  const f = buildWalkFixture(o.cell);
  const d = setupWalkArc(f, o.walker, walkRepoConfig(o.config));
  const key: WalkKey = { cell: o.cell.id, seed: o.cell.seed, trial: o.trial, sha: revParse(d.repo, 'main'), slots: f.slots };
  writeFileSync(join(o.out, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
  const r = contextFor(d);
  const { ctx, w } = walkContext(r);
  const tick = setInterval(() => w.arbiter.wake(), 50);
  const monitor = startMonitor(r, label, o.medianLoad, o.trialCap, o.log);
  const started = Date.now();
  let error: string | null = null;
  let ended: Awaited<ReturnType<typeof runWalk>> | null = null;
  try {
    const merged = await runUnit(w.stage, unitInForce(r, MILESTONE_UNIT), admitAll);
    if (merged.kind !== 'merged') throw new Error(`${MILESTONE_UNIT} did not merge: ${JSON.stringify(merged)}`);
    ended = await runWalk(ctx);
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    clearInterval(tick);
    monitor.stop();
  }
  const wallMs = Date.now() - started;
  const evidence = jobEvidenceRoot(r.ctx.runDir, JOB);
  if (existsSync(evidence)) cpSync(evidence, join(o.out, 'evidence'), { recursive: true, dereference: true });
  const perCall = walkSpawns(r).map((s) => {
    const inv = invocationId(s.op, s.ordinal);
    const stdout = readStdout(r, inv);
    const events = parseEvents(stdout, true);
    const result = events.findLast((e) => e['type'] === 'result');
    return { stdout, events, usage: result === undefined ? null : usageOf(result) };
  });
  perCall.forEach((c, i) => writeFileSync(join(o.out, `walk-${i + 1}.jsonl`), c.stdout));
  const calls = readCalls(d.scenarioPath).filter((c) => c.argv.includes('--strict-mcp-config') && c.argv.includes('bypassPermissions'));
  writeFileSync(join(o.out, 'prompt.txt'), calls[0]?.stdin ?? '');
  writeFileSync(join(o.out, 'argv.json'), `${JSON.stringify(calls[0]?.argv ?? [], null, 2)}\n`);
  // The `--mcp-config` file is kept in the arc's run dir, which the worker removes: the trial keeps a copy.
  const mcpFile = calls[0] === undefined ? null : calls[0].argv[calls[0].argv.indexOf('--mcp-config') + 1] ?? null;
  if (mcpFile !== null && existsSync(mcpFile)) cpSync(mcpFile, join(o.out, 'mcp.json'));
  const allEvents = perCall.flatMap((c) => c.events);
  const transcriptFile = join(o.out, 'transcript.jsonl');
  writeFileSync(transcriptFile, allEvents.map((event, i) => `${JSON.stringify({ turn: 1, line: i + 1, event })}\n`).join(''));
  const t = readTranscript(allEvents);
  const last = perCall.at(-1);
  const reading = last === undefined ? null : readClaude(last.stdout);
  const value = reading !== null && reading.output.kind === 'present' ? reading.output.value : null;
  if (value !== null) writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(value, null, 2)}\n`);
  const reported = ended?.kind === 'ended' && ended.outcome === 'reported';
  const answer = reported && value !== null ? validateWalkthroughOutput(value) : null;
  const hits = scanTranscript(transcriptFile, [o.out, dirname(o.out), 'evals/roles', ...repositoryPaths()]);
  const brake = monitor.brake();
  const voided: WalkRow['void'] = brake !== null ? { reason: brake.rule === 'cap' ? 'cap' : 'runaway', detail: `${brake.rule}: ${brake.detail}` }
    : error !== null ? { reason: 'error', detail: error }
    : ended?.kind !== 'ended' ? { reason: 'error', detail: `the walk did not end: ${JSON.stringify(ended)}` }
    : ended.outcome === 'bring-up-failed' ? { reason: 'bring-up', detail: r.journal.view.holistic().findings.filter((x) => x.lens === 'walkthrough').map((x) => x.claim).join('; ') }
    : ended.outcome === 'abandoned' ? { reason: 'invalid', detail: `abandoned after ${perCall.length} call(s): ${value === null ? 'no report' : refusals(r, value)}` }
    : hits.length > 0 ? { reason: 'needle', detail: hits.slice(0, 5).join('; ') }
    : null;
  const files = filesUnder(join(o.out, 'evidence'));
  const counts = toolCounts(t);
  const usage = sumUsage(perCall.flatMap((c) => (c.usage === null ? [] : [c.usage])));
  const row: WalkRow = {
    set: o.set, cell: o.cell.id, trial: o.trial, walker: o.walker, void: voided, graded: voided === null && answer !== null ? gradeWalk(f.slots, t, answer) : null,
    usage, estimatedUsd: t.liveUsd, wallMs, turns: t.turns, load: t.load, calls: perCall.length,
    models: usage === null ? [] : Object.keys(usage.byModel),
    method: perCall.length === 0 ? emptyMethod : {
      available: t.tools, tools: counts, browserCalls: t.calls.filter((c) => c.name.startsWith('mcp__')).length, shellCalls: counts['Bash'] ?? 0,
      subagents: t.subagents.map((a) => ({ type: a.type, model: a.model, tokens: a.inputTokens + a.outputTokens })), denials: t.denials, unavailable: unavailableCalls(t),
    },
    evidence: { files: files.length, screenshots: files.filter((p) => /\.(png|jpe?g)$/i.test(p)).length },
    dir: o.out,
  };
  r.journal.close();
  writeFileSync(join(o.out, 'row.json'), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

