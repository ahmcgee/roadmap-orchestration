// One gate trial end to end, through the production unit driver: the arc harness of the gate tests
// (test/fixtures/unit-common.ts contextFor, stepUntil) over the fixture's repo. Plan-check and build are fake steps (the
// build lays down the generated unit commit: the `checkoutTree` act), the lanes run for real and must be green (or red on
// the goldens' regenerate check, dev.12: the trial ends there, `caught: 'regenerate'`, with no gate call), and the
// gate step is the `real` act: the fake entry execs the real `claude` with the production argv, stdin, cwd and
// environment, so the eval tests the production prompt, capture, bounded diff, tools and add-dirs byte for byte. A
// degenerate fake gate (`FakeGate`) answers instead, to test the harness and the graders for free. The read-only arm (dev.13,
// run.ts `--read-only`, readonly.ts) runs the real gate's call rewritten into the dev.12 gate's judgment profile.
//
// While the gate runs, a monitor reads its stream every 5 s: a trace line every 30 s (tools by name, subagents with model
// and tokens, time to the first Read and Agent, coverage so far, token load, denials, calls of unavailable tools) and the
// harness's brakes (no Read or Agent in 3 minutes while files are not inlined; coverage flat over 8 tool turns; token load
// over 3x the cell's median), which kill the session and void the trial as `runaway`; and the spend brake (`trialCap`,
// run.ts `--trial-cap`): the session's live spend at list price (transcript.ts `liveUsd`, every gate call of the trial)
// over the cap kills it and voids the trial as `cap`. Brakes are the harness's, never the gate's: method choices are
// reported, not failed.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DiffShown, JudgmentInputs, StageOutcomeFact } from '../../../src/core/events.ts';
import { gateLargeDiffOf } from '../../../src/core/upgrade.ts';
import { diffBase } from '../../../src/git/transient.ts';
import { type RepoConfig, arcStack, resolveRouting } from '../../../src/routing/layers.ts';
import type { RiskTier } from '../../../src/routing/types.ts';
import { modelInfo } from '../../../src/routing/models.ts';
import { type InvocationId, invocationId, sha } from '../../../src/core/ids.ts';
import type { JsonValue } from '../../../src/core/json.ts';
import { STDOUT_FILE } from '../../../src/core/records.ts';
import { invocationDir } from '../../../src/pipeline/invoke.ts';
import { judgmentOutput, judgmentSpawns } from '../../../src/pipeline/stages.ts';
import { type GateOutput, validateGateOutput } from '../../../src/prompts/schemas.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import { runnerFiles } from '../../../src/runner/files.ts';
import { tmpDir } from '../../../test/helpers/repo.ts';
import { type Step, readCalls, writeScenario } from '../../../test/helpers/scenario.ts';
import { arcFor } from '../../../test/fixtures/invoke-specs.ts';
import { BUILD_REPORT, planCheckAnswer } from '../../../test/fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, U1, contextFor, isGateCall, laneJson, outcomes, stepUntil } from '../../../test/fixtures/unit-common.ts';
import { repositoryPaths, scanTranscript } from '../../m4a/transcript.ts';
import { TEST_ARGV } from '../gen/tsrepo.ts';
import { type Transcript, type Usage, parseEvents, readTranscript, sumUsage, toolCounts, unavailableCalls, usageOf } from '../transcript.ts';
import { isCorpusCell, type Cell } from './cells.ts';
import { type AnswerKey, DERIVED, DERIVED_PATTERNS, type Fixture, buildFixture, materialise } from './fixture.ts';
import { boundedDiff, diffPaths } from '../../../src/git/boundeddiff.ts';
import { GATE_DIFF_BUDGET, largeDiffOf } from '../../../src/pipeline/gate.ts';
import { guideAt } from '../../../src/corpus/guide.ts';
import { derivePin, writePin } from '../../../src/corpus/pin.ts';
import { EMPTY_REGISTRY } from '../../../src/corpus/registry.ts';
import { openSource } from '../../../src/corpus/source.ts';
import { PHASE0_FILE, PIN_FILE, writePhase0 } from '../../../test/helpers/corpusarc.ts';
import { witnessLaneArgv, writeWitnessControl } from '../../../test/helpers/witness.ts';
import { laneRevOf, parseObligations } from '../../../src/holistic/types.ts';
import { absPath } from '../../../src/core/values.ts';
import { type ClusterGrade, type Graded, grade, gradeClusters, touched } from './grade.ts';
import type { ReadOnlyArm } from './readonly.ts';

/**
 * Degenerate gates: approve everything; revise everything (one blocking finding off the plant); cite every changed path; cite
 * the plant without reading; and `overspend`, a session that streams one message billed far over any trial cap and then
 * hangs, never answering (the spend brake's own check).
 */
export const FAKE_GATES = ['approve-all', 'revise-all', 'cite-every-path', 'cite-plant', 'overspend'] as const;
export type FakeGate = (typeof FAKE_GATES)[number];
export type GateKind = 'real' | FakeGate;

const RULINGS = fileURLToPath(new URL('../../../test/fixtures/unit-rulings.md', import.meta.url));
const SCOPE = ['packages/**', 'goldens/**', 'tools/**'] as const;
const LANE = { id: 'unit', argv: TEST_ARGV } as const;

// ---------------------------------------------------------------------------------------------------
// The arc

const finding = (path: string, text: string): JsonValue => ({ severity: 'blocking', path, text, contractRef: null, experiments: [], debt: null, defect: 'incorrect-behaviour', reraises: null, hunk: null });

/**
 * A degenerate gate's answer for the fixture (it knows the key: what a cheating gate would know). `large`: the diff is over
 * the large-diff threshold, so the answer carries a cluster map (one cluster over everything) that code accepts.
 */
function fakeAnswer(kind: Exclude<FakeGate, 'overspend'>, key: AnswerKey, large: boolean): JsonValue {
  const decoy = key.changed.find((p) => p !== key.plant?.path) ?? 'ARCHITECTURE.md';
  const clusters: JsonValue = large ? [{ id: 'all', paths: ['**'], review: 'routine' }] : null;
  const revise = (findings: JsonValue[]): JsonValue => ({ decision: 'revise', findings, directives: ['Fix the findings.'], reasons: ['A1 is not met'], premises: [], unreviewed: [], clusters, rulings: [] });
  switch (kind) {
    case 'approve-all':
      return { decision: 'approve', findings: [], directives: [], reasons: ['A1 holds'], premises: [], unreviewed: [], clusters, rulings: [] };
    case 'revise-all':
      return revise([finding(decoy, 'This change is wrong.')]);
    case 'cite-every-path':
      return revise(key.changed.map((p) => finding(p, 'This file is wrong.')));
    case 'cite-plant':
      return revise([finding(key.plant?.path ?? decoy, 'This file is wrong.')]);
  }
}

/** `overspend`'s one message: a million Opus 5.5 output tokens, $20 at list price. */
const OVERSPEND: JsonValue = {
  type: 'assistant', parent_tool_use_id: null,
  message: { id: 'msg-overspend', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'thinking at length' }], usage: { input_tokens: 10, output_tokens: 1_000_000 } },
};

/**
 * The gate's steps: the real CLI (the first call and up to two follow-ups: a repair turn or a retry; `readOnly`, the arm that
 * rewrites each into the judgment profile) or one fake answer.
 */
function gateSteps(kind: GateKind, key: AnswerKey, large: boolean, readOnly: ReadOnlyArm | null): readonly Step[] {
  if (kind === 'real') return [0, 1, 2].map((): Step => ({ as: 'claude', expect: {}, acts: [readOnly === null ? { type: 'real' } : { type: 'real', readOnly }] }));
  if (kind === 'overspend') return [{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'stream', events: [OVERSPEND] }, { type: 'hang', ms: 10 * 60_000 }] }];
  return [{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: fakeAnswer(kind, key, large) }] }];
}

/** Whether the gate's attached diff of `base..head` will be over the large-diff threshold (a fake gate's answer needs a map then). */
function overThreshold(repo: string, base: string, head: string, removes: readonly string[]): boolean {
  const d = boundedDiff(absPath(repo), sha(base), sha(head), { budget: GATE_DIFF_BUDGET, derived: DERIVED_PATTERNS, removes, dir: absPath(tmpDir('roles-threshold')) });
  return largeDiffOf(d) !== null;
}

/**
 * The arm a run measures: the gate seat its risk picks, the class there and the triple that class binds under the run's
 * repo config (the production routing stack: built-in seats, the `default` profile's catalogue, `routing.classes`
 * rebinds), e.g. `gate.low frontier claude-opus-5-5:medium`.
 */
export function gateArm(risk: RiskTier, config: RepoConfig | null, readOnly = false): string {
  const r = resolveRouting(arcStack('default', config, null));
  const t = r.table.gate[risk];
  promptFor('gate', t.model); // a rebind onto a model with no gate prompt fails here, before any trial
  return `gate.${risk} ${r.classes.gate[risk]}${r.bindings[r.classes.gate[risk]] === 'repo-config' ? ' (rebound)' : ''} ${t.model}:${t.effort}${readOnly ? ' read-only' : ''}`;
}

/** The scripted build call's backend and argv: the build seat the unit's risk picks under the run's routing. */
function buildCall(risk: RiskTier, config: RepoConfig | null): Pick<Step, 'as' | 'expect'> {
  const backend = modelInfo(resolveRouting(arcStack('default', config, null)).table.build[risk].model).backend;
  return backend === 'codex' ? { as: 'codex', expect: { argv: ['exec', '-C'] } } : { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions'] } };
}

/**
 * Lays out the fixture's repo, plan, spec and scenario (plan-check approves; the build commits the unit's tree). `readOnly`:
 * a real gate runs as the read-only comparison arm.
 */
export function setupGateArc(f: Fixture, kind: GateKind, risk: RiskTier, config: RepoConfig | null = null, readOnly = false): ArcDescriptor {
  const repo = tmpDir('roles-repo');
  const { base, head } = materialise(f, repo);
  const planDir = tmpDir('roles-plan');
  writeFileSync(join(planDir, 'u1.json'), JSON.stringify({
    schema: 'roadmap/spec-m1', unit: 'u1', rev: 1, lanes: [{ ...laneJson(LANE), state: 'active' }],
    acceptance: f.acceptance.map((c) => ({ id: c.id, clause: c.clause, failLoudIfUndelivered: true, state: 'active' })),
    scope: SCOPE, resources: [], decisions: [], facts: [], cites: { contracts: ['contracts/api.md'], rulings: ['C-1'] },
    ...(isCorpusCell(f.cell) ? { obligations: ['I-1'] } : {}),
    ...(f.removes.length === 0 ? {} : { removes: f.removes }),
  }));
  cpSync(RULINGS, join(planDir, 'rulings.md'));
  const arc = arcFor();
  const planPath = join(planDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify({
    schema: 'roadmap/plan-m1', arc, integrationBranch: 'main', baseline: base,
    worktreeRoot: tmpDir('roles-wt'), contracts: ['contracts/api.md'], rulings: 'rulings.md', ...(isCorpusCell(f.cell) ? { corpus: PIN_FILE, phase0: PHASE0_FILE, holistic: { advances: ['V-1'], obligations: 'obligations.json' } } : { architectureDoc: 'ARCHITECTURE.md' }),
    direction: 'Keep every sweep mechanical: behaviour never changes unless the spec says so.', suite: { lanes: [laneJson({ ...LANE, id: 'suite' })] }, resources: [],
    derived: DERIVED, units: [{ id: 'u1', spec: 'u1.json', risk, scope: SCOPE, resources: [] }],
  }));
  if (isCorpusCell(f.cell)) writeCorpusInputs(repo, planDir, base);
  const scenarioDir = tmpDir('roles-scenario');
  const runDir = tmpDir('roles-run');
  const steps: Step[] = [
    // The plan-check's risk is the dispatch's: it picks the gate's seat.
    { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'planCheck', value: planCheckAnswer({ decision: 'approve', risk }) }] },
    // The build's backend is the one its risk routes to (built-in: codex low/med under the default profile, Claude Opus high).
    { ...buildCall(risk, config), acts: [{ type: 'checkoutTree', sha: head, message: f.message }, { type: 'emit', value: BUILD_REPORT }] },
    ...gateSteps(kind, f.key, kind !== 'real' && overThreshold(repo, base, head, f.removes), readOnly ? { repo, runDir } : null),
  ];
  const scenario = writeScenario(scenarioDir, steps);
  return { arc, repo, planPath, runDir, hostDir: join(tmpDir('roles-host'), 'roadmap'), binDir: scenario.binDir, scenarioPath: scenario.path, scenarioDir, ...(config === null ? {} : { config }) };
}

// ---------------------------------------------------------------------------------------------------
// The monitor: trace and brakes

export type Brake = Readonly<{ rule: 'no-read' | 'flat-coverage' | 'load' | 'cap'; detail: string }>;

const NO_READ_MS = 3 * 60_000;
const FLAT_TURNS = 8;
const LOAD_FACTOR = 3;
const POLL_MS = 5_000;
const TRACE_MS = 30_000;

type Live = { inv: InvocationId; startedAt: number; firstRead: number | null; firstAgent: number | null; coverage: number[] };

/** The latest gate attempt's `judgment-inputs` (null before a gate spawn). */
function gateInputs(r: ArcRun): JudgmentInputs | null {
  const parent = judgmentSpawns(r.ctx, U1, 'gate').at(-1)?.parent;
  if (parent === undefined) return null;
  if (parent.type !== 'stage') throw new Error(`a gate spawn under ${parent.type}`);
  const inputs = r.journal.view.judgmentInputs(U1, 'gate', parent.attempt);
  if (inputs === null) throw new Error(`gate#${parent.attempt}: a gate spawn without its judgment-inputs`);
  return inputs;
}

/** What the latest gate attempt recorded it was shown (null before its inputs are captured): what placement and coverage read. */
function gateShown(r: ArcRun): DiffShown | null {
  const inputs = gateInputs(r);
  if (inputs === null) return null;
  if (inputs.diffShown === undefined) throw new Error(`gate#${inputs.attempt}: a gate spawn without its judgment-inputs diffShown`);
  return inputs.diffShown;
}

function gatePrompt(d: ArcDescriptor): string | null {
  return readCalls(d.scenarioPath).find(isGateCall)?.stdin ?? null;
}

function startMonitor(
  r: ArcRun, label: string, medianLoad: number | null, trialCap: number | null, log: (line: string) => void,
): { stop: () => void; brake: () => Brake | null; firsts: () => Readonly<{ read: number | null; agent: number | null }> } {
  let live: Live | null = null;
  // The finished gate calls' spend so far (a repair turn or a retry follows a finished call), by invocation.
  const finished = new Map<InvocationId, number>();
  let braked: Brake | null = null;
  let lastTrace = Date.now();
  let firstRead: number | null = null;
  let firstAgent: number | null = null;
  const kill = (inv: InvocationId): void => {
    const runner = runnerFiles(invocationDir(r.ctx.runDir, inv), inv).read('runner.json');
    if (runner?.child !== null && runner?.child !== undefined) {
      try {
        process.kill(-runner.child.sid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  };
  const tick = (): void => {
    const open = r.journal.view.openIntents().find((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'gate');
    if (open === undefined || open.kind !== 'proc.spawn') return;
    const inv = invocationId(open.op, open.ordinal);
    if (braked !== null) return kill(inv);
    if (live === null || live.inv !== inv) {
      if (live !== null) finished.set(live.inv, readTranscript(parseEvents(readStdout(r, live.inv))).liveUsd);
      live = { inv, startedAt: Date.now(), firstRead: null, firstAgent: null, coverage: [] };
    }
    const t = readTranscript(parseEvents(readStdout(r, inv), true));
    const now = Date.now();
    const s = (ms: number | null): string => (ms === null ? '-' : `${Math.round(ms / 1000)}s`);
    if (live.firstRead === null && t.calls.some((c) => c.name === 'Read' || c.name === 'Grep')) live.firstRead = now - live.startedAt;
    if (live.firstAgent === null && t.calls.some((c) => c.name === 'Agent' || c.name === 'Task')) live.firstAgent = now - live.startedAt;
    firstRead ??= live.firstRead;
    firstAgent ??= live.firstAgent;
    const omitted = gateShown(r)?.notInlined ?? [];
    const covered = omitted.filter((p) => touched(t, p)).length;
    while (live.coverage.length < t.toolTurns.length) live.coverage.push(covered);
    // Only when the prompt left something out: with every file inlined, answering without a tool is a method choice.
    if (omitted.length > 0 && live.firstRead === null && live.firstAgent === null && now - live.startedAt > NO_READ_MS) {
      braked = { rule: 'no-read', detail: `no Read, Grep or Agent in ${NO_READ_MS / 60_000} minutes with ${omitted.length} files not inlined` };
    }
    const recent = live.coverage.slice(-FLAT_TURNS - 1);
    if (braked === null && omitted.length > 0 && covered < omitted.length && recent.length > FLAT_TURNS && recent[0] === recent.at(-1)) {
      braked = { rule: 'flat-coverage', detail: `coverage flat at ${covered}/${omitted.length} over ${FLAT_TURNS} tool turns` };
    }
    if (braked === null && medianLoad !== null && t.load > LOAD_FACTOR * medianLoad) braked = { rule: 'load', detail: `token load ${t.load} over ${LOAD_FACTOR}x the cell median ${medianLoad}` };
    const spent = [...finished.values()].reduce((a, b) => a + b, t.liveUsd);
    if (braked === null && trialCap !== null && spent > trialCap) braked = { rule: 'cap', detail: `live spend $${spent.toFixed(2)} over the trial cap $${trialCap.toFixed(2)}` };
    if (braked !== null) {
      log(`BRAKE ${label} ${braked.rule}: ${braked.detail}`);
      kill(inv);
      return;
    }
    if (now - lastTrace >= TRACE_MS) {
      lastTrace = now;
      const agents = t.subagents.map((a) => `${a.type ?? '?'}/${a.model ?? '?'}:${a.inputTokens + a.outputTokens}`).join(',');
      log(`TRACE ${label} t=${s(now - live.startedAt)} tools=${JSON.stringify(toolCounts(t))} agents=[${agents}] firstRead=${s(live.firstRead)} firstAgent=${s(live.firstAgent)} `
        + `coverage=${covered}/${omitted.length} load=${t.load} spent=$${spent.toFixed(2)} turns=${t.turns} denials=${t.denials} unavailable=${JSON.stringify(unavailableCalls(t))}`);
    }
  };
  const timer = setInterval(tick, POLL_MS);
  return { stop: () => clearInterval(timer), brake: () => braked, firsts: () => ({ read: firstRead, agent: firstAgent }) };
}

/** A gate call's stdout so far ('' before it is written). */
function readStdout(r: ArcRun, inv: InvocationId): string {
  try {
    return readFileSync(join(invocationDir(r.ctx.runDir, inv), STDOUT_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------
// A trial

/** `cap`: the spend brake killed the trial's session (run.ts `--trial-cap`). */
export type VoidReason = 'runaway' | 'cap' | 'error' | 'needle' | 'placement-miss';

export type TrialRow = Readonly<{
  set: 'dev' | 'holdout';
  cell: string;
  family: string;
  trial: number;
  planted: boolean;
  gate: GateKind;
  /** The gate's stage outcome (approve, revise, escalate, malformed, ...), null when it recorded none. */
  outcome: string | null;
  /**
   * dev.12: `regenerate` when the executor's regenerate check (a red regenerate lane at the lanes stage) stopped the unit
   * before any gate: the plant was caught by code, so the trial is neither graded nor void. null otherwise.
   */
  caught: 'regenerate' | null;
  decision: GateOutput['decision'] | null;
  void: Readonly<{ reason: VoidReason; detail: string }> | null;
  graded: Graded | null;
  /** dev.13: whether the gate ran as the read-only comparison arm (the dev.12 gate's profile), and the experiments its answer's findings cite. */
  readOnly: boolean;
  experiments: number;
  /** The large-diff gate: whether the gate's diff was over the threshold (its inputs' `largeDiff`), and its answer's cluster map graded (null: no map). */
  largeDiff: boolean;
  clusters: ClusterGrade | null;
  usage: Usage | null;
  /** The trial's spend at list price from its transcripts (`liveUsd`): what a call killed before its result cost, which `usage` cannot say. */
  estimatedUsd: number;
  wallMs: number;
  /** Main-session turns over every gate call; gate calls made; the token load (transcript.ts `load`, the load brake's measure). */
  turns: number;
  load: number;
  calls: number;
  /** The gate seat's model(s), from the launch argv. */
  models: readonly string[];
  method: Readonly<{
    /** The tools the session's init event listed. */
    available: readonly string[];
    tools: Readonly<Record<string, number>>;
    subagents: readonly Readonly<{ type: string | null; model: string | null; tokens: number }>[];
    firstReadS: number | null;
    firstAgentS: number | null;
    denials: number;
    unavailable: readonly string[];
  }>;
  /** Every stage outcome of the unit, in order (the lanes' must read green). */
  stages: readonly string[];
  dir: string;
}>;

export type TrialOptions = Readonly<{
  set: 'dev' | 'holdout';
  cell: Cell;
  trial: number;
  seed: string;
  size: number;
  gate: GateKind;
  /** The unit's risk tier (the plan's and the plan-check's), which picks the gate's seat (built-in since dev.17: frontier at every tier). */
  risk: RiskTier;
  /** The repo config whose `routing.classes` rebinds classes for the trial (run.ts `--rebind`), or null: the built-in bindings. */
  config: RepoConfig | null;
  /** The trial's directory in the eval run dir (the answer key and artifacts go here, outside every dir the gate reads). */
  out: string;
  /** The cell's median token load so far (the load brake), or null. */
  medianLoad: number | null;
  /** The spend brake (run.ts `--trial-cap`): live spend in USD over which the session is killed, or null for none. */
  trialCap: number | null;
  /** run.ts `--read-only`: a real gate runs as the read-only comparison arm. */
  readOnly: boolean;
  log: (line: string) => void;
}>;

const flagOf = (argv: readonly string[], flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
};

export async function runGateTrial(o: TrialOptions): Promise<TrialRow> {
  mkdirSync(o.out, { recursive: true });
  const label = `${o.cell.id}#${o.trial}`;
  const fx = buildFixture(o.cell, { seed: o.seed, trial: o.trial, size: o.size, scratch: tmpDir('roles-scratch') });
  writeFileSync(join(o.out, 'key.json'), `${JSON.stringify(fx.key, null, 2)}\n`);
  const d = setupGateArc(fx, o.gate, o.risk, o.config, o.readOnly);
  const r = contextFor(d);
  const monitor = startMonitor(r, label, o.medianLoad, o.trialCap, o.log);
  const started = Date.now();
  let error: string | null = null;
  try {
    await stepUntil(r, 'u1', (f: StageOutcomeFact) => f.stage === 'gate' || (f.stage === 'lanes' && f.outcome === 'red'));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    monitor.stop();
  }
  const wallMs = Date.now() - started;
  const spawns = judgmentSpawns(r.ctx, U1, 'gate');
  const perCall = spawns.map((s) => {
    const inv = invocationId(s.op, s.ordinal);
    const dir = invocationDir(r.ctx.runDir, inv);
    let stdout = '';
    try {
      stdout = readFileSync(join(dir, STDOUT_FILE), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const events = parseEvents(stdout, true);
    const launch = runnerFiles(dir, inv).read('launch.json');
    const result = events.findLast((e) => e['type'] === 'result');
    return { stdout, events, model: launch === null ? null : flagOf(launch.argv, '--model'), usage: result === undefined ? null : usageOf(result) };
  });
  perCall.forEach((c, i) => writeFileSync(join(o.out, `gate-${i + 1}.jsonl`), c.stdout));
  const allEvents = perCall.flatMap((c) => c.events);
  const transcriptFile = join(o.out, 'transcript.jsonl');
  writeFileSync(transcriptFile, allEvents.map((event, i) => `${JSON.stringify({ turn: 1, line: i + 1, event })}\n`).join(''));
  const t: Transcript = readTranscript(allEvents);
  const prompt = gatePrompt(d) ?? '';
  writeFileSync(join(o.out, 'prompt.txt'), prompt);
  const last = spawns.at(-1);
  const answer = last === undefined ? null : judgmentOutput(r.ctx, last, validateGateOutput);
  writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(answer, null, 2)}\n`);
  const decided = r.journal.view.unit(U1).decided;
  // A lanes red is the regenerate check's when that attempt ran a regenerate lane (the spec lane passed: the fast suite ran).
  const caught: TrialRow['caught'] = decided?.stage === 'lanes' && decided.outcome === 'red' && r.journal.view.opsOf('proc.spawn').some((i) => {
    const s = i.expect.subject;
    return s.purpose === 'lane' && s.lane.startsWith('regenerate.') && i.parent.type === 'stage' && i.parent.stage === 'lanes' && i.parent.attempt === decided.attempt;
  }) ? 'regenerate' : null;
  const shown = gateShown(r);
  const inputs = gateInputs(r);
  const largeDiff = inputs !== null && gateLargeDiffOf(inputs) !== null;
  const clusters = answer === null || answer.clusters === null || inputs === null || inputs.head === null ? null
    : gradeClusters(answer, diffPaths(absPath(d.repo), diffBase(absPath(d.repo), inputs.tip, inputs.head), inputs.head));
  const stages = outcomes(d);
  r.journal.close();

  if (answer !== null && shown === null) throw new Error(`${label}: a gate answer without the gate's judgment-inputs`);
  const graded = answer === null ? null : grade(fx.key, shown!, prompt, t, answer);
  const hits = scanTranscript(transcriptFile, [o.out, dirname(o.out), 'evals/roles', ...repositoryPaths()]);
  const brake = monitor.brake();
  const voided: TrialRow['void'] = brake !== null ? { reason: brake.rule === 'cap' ? 'cap' : 'runaway', detail: `${brake.rule}: ${brake.detail}` }
    : error !== null ? { reason: 'error', detail: error }
    : caught !== null ? null
    : answer === null ? { reason: 'error', detail: `the gate gave no valid answer (outcome ${decided?.outcome ?? 'none'})` }
    : hits.length > 0 ? { reason: 'needle', detail: hits.slice(0, 5).join('; ') }
    : graded?.placementMiss === true ? { reason: 'placement-miss', detail: `the plant's diff was ${graded.placement}, the cell asks ${fx.key.plant?.intended}` }
    : null;
  const firsts = monitor.firsts();
  const row: TrialRow = {
    set: o.set, cell: o.cell.id, family: o.cell.family, trial: o.trial, planted: fx.key.plant !== null, gate: o.gate,
    outcome: decided !== null && decided.stage === 'gate' ? decided.outcome : null, caught, decision: answer?.decision ?? null, void: voided, graded,
    readOnly: o.readOnly, experiments: answer === null ? 0 : answer.findings.reduce((a, f) => a + f.experiments.length, 0), largeDiff, clusters,
    usage: sumUsage(perCall.flatMap((c) => (c.usage === null ? [] : [c.usage]))), estimatedUsd: perCall.reduce((a, c) => a + readTranscript(c.events).liveUsd, 0),
    wallMs, turns: t.turns, load: t.load, calls: spawns.length,
    models: [...new Set(perCall.flatMap((c) => (c.model === null ? [] : [c.model])))],
    method: {
      available: t.tools, tools: toolCounts(t), subagents: t.subagents.map((a) => ({ type: a.type, model: a.model, tokens: a.inputTokens + a.outputTokens })),
      firstReadS: firsts.read === null ? null : Math.round(firsts.read / 1000), firstAgentS: firsts.agent === null ? null : Math.round(firsts.agent / 1000),
      denials: t.denials, unavailable: unavailableCalls(t),
    },
    stages, dir: o.out,
  };
  writeFileSync(join(o.out, 'row.json'), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

/** Pin and census through the production readers, just as the corpus unit harness records its first revision. */
function writeCorpusInputs(repo: string, planDir: string, base: string): void {
  const guide = guideAt(absPath(repo), sha(base));
  if (guide === null) throw new Error('a corpus fixture has no guide');
  const source = openSource(absPath(repo), guide.guide, { rev: base, fetch: false });
  if (source.kind === 'refused') throw new Error(JSON.stringify(source.problem));
  const derived = derivePin(guide, source.opened, EMPTY_REGISTRY);
  if (derived.kind === 'refused') throw new Error(JSON.stringify(derived.problems));
  const pin = derived.pin;
  writePin(absPath(join(planDir, PIN_FILE)), pin);
  writePhase0(planDir, {});
  const control = join(planDir, 'witness-control.json');
  writeWitnessControl(control, { trees: { '*': { outcomes: { export: 'pass' } } } });
  const lane = { ...laneJson({ id: 'journey', argv: witnessLaneArgv('jsonl', planDir, control) }), reporter: 'jsonl' };
  const laneRev = laneRevOf(parseObligations({ schema: 'roadmap/obligations-m3', cutLine: 'export', lanes: [lane], obligations: [], mapping: { paths: [] } }).lanes[0]!);
  const witness = { lane: 'journey', testIds: ['export'] };
  writeFileSync(join(planDir, 'obligations.json'), JSON.stringify({
    schema: 'roadmap/obligations-m3', cutLine: 'vessel export ships', lanes: [lane], mapping: { paths: [] },
    obligations: [{ id: 'I-1', rev: 1, statement: 'Vessel exports satisfy the export contract.', rule: { id: 'T-1', textSha256: pin.rules[0]!.textSha256 }, serves: ['V-1'], witness,
      proofJudgment: { verdict: 'proves', obligationRev: 1, laneRev, witness }, deliveredBy: [], activation: 'must-hold', contracts: [], state: { type: 'active' } }],
    census: pin.rules.map((r) => ({ rule: r.id, state: r.id === 'T-1' ? { type: 'obligation', id: 'I-1' } : { type: r.id === 'T-2' ? 'untestable' : 'out-of-slice' } })),
  }));
}
