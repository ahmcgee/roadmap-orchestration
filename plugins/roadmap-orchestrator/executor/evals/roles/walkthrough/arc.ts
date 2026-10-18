// One walkthrough trial end to end, the way the gate eval drives the real gate: the cell's product committed to a scratch
// repository and checked out detached, brought up from the milestone's bring-up (bringup.ts, the stand-in for agent C's
// until merge), and the real walkthrough session launched in the checkout with the production pieces byte for byte: the
// seat's routing (`walkthrough.arc`, `--rebind` through the repo config), the prompt module (`promptFor`), the
// `claude-acting-judge` call and its argv (`backendArgv`, `promptBytes`), this repository's walkthrough MCP config
// (Playwright MCP on Chromium, the evidence dir substituted), the stream reader (`readClaude`) and the report's reader
// (`validateWalkthroughOutput`). The call goes through the fake backend's PATH shim: its `real` act execs the real
// `claude`, a degenerate fake walker (`FakeWalker`) answers instead for the free tier.
//
// SWAP AT MERGE: once agent C's walk job lands, the trial runs it (bring-up, inputs, the repair turn, the job's validation
// of evidence and references) instead of this driver's direct launch, as the gate eval runs the production gate.
// Until then an answer the reader refuses voids the trial (`invalid`) with no repair turn, and cited evidence files
// missing from the evidence dir are counted, not refused.
//
// While the session runs, a monitor reads its stream every 5 s: a TRACE line every 30 s (tools by name, browser calls,
// shell calls, subagents, token load, spend) and the harness's brakes: the token load over 3x the cell's median so far
// (`runaway`), the live spend at list price over `--trial-cap` (`cap`), the session deadline (`runaway`). After the
// session ends, its process group is killed (the MCP server and the browser with it) and the product is stopped.
import { spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { canonicalJson, type JsonValue } from '../../../src/core/json.ts';
import { absPath } from '../../../src/core/values.ts';
import { backendArgv, type BackendCall, freshJudgmentSession, promptBytes } from '../../../src/backends/argv.ts';
import { readClaude } from '../../../src/backends/claude.ts';
import type { DocText, WalkthroughInputs } from '../../../src/prompts/inputs.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import { type WalkthroughOutput, validateWalkthroughOutput } from '../../../src/prompts/schemas.ts';
import { type RepoConfig, arcStack, resolveRouting } from '../../../src/routing/layers.ts';
import { repoPath } from '../../../src/core/values.ts';
import { tmpDir } from '../../../test/helpers/repo.ts';
import { type Step, writeScenario } from '../../../test/helpers/scenario.ts';
import { repositoryPaths, scanTranscript } from '../../m4a/transcript.ts';
import type { CellSet } from '../gate/cells.ts';
import { type Usage, parseEvents, readTranscript, toolCounts, unavailableCalls, usageOf } from '../transcript.ts';
import { BringUpFailed, EVAL_REPO_CONFIG, bringUp, substitutePorts, walkMcpConfig } from './bringup.ts';
import { FLOW_PAGE, pagePath } from './families.ts';
import { REFERENCE, type SlotKey, type WalkCell, type WalkFixture, type WalkKey, buildWalkFixture, git, materialise } from './fixture.ts';
import { type WalkGraded, gradeWalk } from './grade.ts';

/**
 * Degenerate walkers, each knowing the key (what a cheating walker would know): `clean-report` reports every journey
 * completed and nothing found; `oracle` exercises every slot's journey and reports every plant at its expected class;
 * `cite-plants` reports the same with no exercise (lucky); `flag-everything` reports a `deviates` finding on every slot,
 * twins included; `breaks-everything` a `breaks` on every slot; `overspend` streams one message billed far over any trial
 * cap and then hangs (the spend brake's own check).
 */
export const FAKE_WALKERS = ['clean-report', 'oracle', 'cite-plants', 'flag-everything', 'breaks-everything', 'overspend'] as const;
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
  /** The session's spend at list price from its transcript (`liveUsd`): what a session killed before its result cost. */
  estimatedUsd: number;
  wallMs: number;
  turns: number;
  load: number;
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
  /** Files the session left in its evidence dir (screenshots, transcripts, notes), and cited evidence paths that are not there. */
  evidence: Readonly<{ files: number; screenshots: number; missing: number }>;
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

const SESSION_MS = 45 * 60_000;
const POLL_MS = 5_000;
const TRACE_MS = 30_000;
const LOAD_FACTOR = 3;
const MODEL_FOR_FAKES = 'claude-opus-5-5';

/** The walk seat's triple under the run's routing: the built-in seats with the walk roles in force, `--rebind` applied. */
export function walkSeat(config: RepoConfig | null): Readonly<{ arm: string; triple: Extract<BackendCall, { kind: 'claude-acting-judge' }>['triple'] }> {
  const r = resolveRouting({ ...arcStack('default', config, null), arcScope: 'corpus', arcRoles: 'm4b', milestones: true });
  const t = r.table.walkthrough.arc;
  if (t.backend !== 'claude') throw new Error(`the walkthrough seat bound to ${t.model}: walks run on Claude only (codex-judgment)`);
  promptFor('walkthrough', t.model); // a rebind onto a model with no walkthrough prompt fails here, before any trial
  const cls = r.classes.walkthrough.arc;
  return { arm: `walkthrough.arc ${cls}${r.bindings[cls] === 'repo-config' ? ' (rebound)' : ''} ${t.model}:${t.effort}`, triple: t };
}

/** The run's repo config: this repository's walkthrough MCP servers, with `--rebind`'s class bindings. */
export const runConfig = (rebind: RepoConfig | null): RepoConfig => ({ ...EVAL_REPO_CONFIG, ...(rebind?.routing === undefined ? {} : { routing: rebind.routing }) });

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

function fakeFinding(s: SlotKey, cls: 'breaks' | 'deviates'): JsonValue {
  return {
    class: cls, journey: s.journeys[0]!, evidence: [EVIDENCE_NOTE], claim: s.what, cause: s.what,
    against: cls === 'breaks' ? { type: 'journey' } : { type: 'design', path: `${REFERENCE}/DESIGN.md`, anchor: 'Principles' }, paths: [s.files[0]!],
  };
}

/** A degenerate walker's report. */
function fakeAnswer(kind: Exclude<FakeWalker, 'overspend'>, f: WalkFixture): JsonValue {
  const findings = kind === 'clean-report' ? []
    : kind === 'flag-everything' ? f.slots.map((s) => fakeFinding(s, 'deviates'))
    : kind === 'breaks-everything' ? f.slots.map((s) => fakeFinding(s, 'breaks'))
    : f.slots.filter((s) => s.state === 'plant').map((s) => fakeFinding(s, s.expected === 'breaks' ? 'breaks' : 'deviates'));
  return {
    final: true,
    journeys: f.milestone.journeys.map((j) => ({ journey: j.id, outcome: 'completed', evidence: [EVIDENCE_NOTE], note: 'walked' })),
    findings, polish: [], premises: [], reasons: ['walked every journey'],
  };
}

const OVERSPEND: JsonValue = {
  type: 'assistant', parent_tool_use_id: null,
  message: { id: 'msg-overspend', model: MODEL_FOR_FAKES, content: [{ type: 'text', text: 'walking at length' }], usage: { input_tokens: 10, output_tokens: 1_000_000 } },
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walkerSteps(kind: WalkerKind, f: WalkFixture, base: string, evidence: string): readonly Step[] {
  if (kind === 'real') return [{ as: 'claude', expect: {}, acts: [{ type: 'real' }] }];
  const expect = { argv: ['-p', '--strict-mcp-config', '--mcp-config', '--setting-sources', 'project', '--permission-mode', 'bypassPermissions'] };
  if (kind === 'overspend') return [{ as: 'claude', expect, acts: [{ type: 'stream', events: [OVERSPEND] }, { type: 'hang', ms: 10 * 60_000 }] }];
  const events = kind === 'oracle' ? f.slots.flatMap((s, i) => exerciseEvents(s, base, f.data.month, i)) : [];
  return [{
    as: 'claude', expect,
    acts: [
      { type: 'writeToPrompt', pattern: `(${escapeRe(evidence)})`, file: EVIDENCE_NOTE, text: 'walked\n' },
      ...(events.length === 0 ? [] : [{ type: 'stream' as const, events }]),
      { type: 'emit', value: fakeAnswer(kind, f) },
    ],
  }];
}

// ---------------------------------------------------------------------------------------------------
// The trial

/** Every file under `dir` (relative), sorted. */
function filesUnder(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`])).sort();
}

/** The milestone's references as the walk reads them: every file under the reference dir at the walked commit. */
function referencesOf(checkout: string): readonly DocText[] {
  return filesUnder(join(checkout, REFERENCE)).map((p) => ({ path: repoPath(`${REFERENCE}/${p}`), text: readFileSync(join(checkout, REFERENCE, p), 'utf8') }));
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}

type Session = Readonly<{ exit: number | null; brake: Readonly<{ rule: 'load' | 'cap' | 'deadline'; detail: string }> | null; wallMs: number }>;

/** Runs `argv` with `stdin` in `cwd` (PATH led by the shims), stdout to `stdoutFile`, under the monitor's brakes. */
function runSession(
  argv: readonly string[], stdin: string, cwd: string, binDir: string, stdoutFile: string, stderrFile: string,
  o: Readonly<{ medianLoad: number | null; trialCap: number | null; label: string; log: (line: string) => void }>,
): Promise<Session> {
  return new Promise((done) => {
    const out = openSync(stdoutFile, 'w');
    const err = openSync(stderrFile, 'w');
    const started = Date.now();
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd, env: { ...process.env, PATH: `${binDir}:${process.env['PATH'] ?? ''}` }, stdio: ['pipe', out, err], detached: true,
    });
    closeSync(out);
    closeSync(err);
    if (child.stdin === null) throw new Error('a session spawned without its stdin pipe');
    child.stdin.end(stdin);
    let brake: Session['brake'] = null;
    let lastTrace = Date.now();
    const timer = setInterval(() => {
      const t = readTranscript(parseEvents(readFileSync(stdoutFile, 'utf8'), true));
      const now = Date.now();
      if (brake === null && o.trialCap !== null && t.liveUsd > o.trialCap) brake = { rule: 'cap', detail: `spent $${t.liveUsd.toFixed(2)} at list price, over the trial cap $${o.trialCap.toFixed(2)}` };
      if (brake === null && o.medianLoad !== null && t.load > LOAD_FACTOR * o.medianLoad) brake = { rule: 'load', detail: `token load ${t.load} over ${LOAD_FACTOR}x the cell median ${o.medianLoad}` };
      if (brake === null && now - started > SESSION_MS) brake = { rule: 'deadline', detail: `still running after ${SESSION_MS / 60_000} minutes` };
      if (brake !== null && child.pid !== undefined) {
        o.log(`BRAKE ${o.label} ${brake.rule}: ${brake.detail}`);
        killGroup(child.pid);
      }
      if (now - lastTrace >= TRACE_MS) {
        lastTrace = now;
        const counts = toolCounts(t);
        const browser = t.calls.filter((c) => c.name.startsWith('mcp__')).length;
        o.log(`TRACE ${o.label} ${Math.round((now - started) / 1000)}s tools=${JSON.stringify(counts)} browser=${browser} bash=${counts['Bash'] ?? 0} `
          + `subagents=${t.subagents.length} load=${t.load} spent=$${t.liveUsd.toFixed(2)}`);
      }
    }, POLL_MS);
    child.on('close', (code) => {
      clearInterval(timer);
      if (child.pid !== undefined) killGroup(child.pid); // the session's MCP server and browser, whatever is left
      done({ exit: code, brake, wallMs: Date.now() - started });
    });
  });
}

const emptyMethod: WalkRow['method'] = { available: [], tools: {}, browserCalls: 0, shellCalls: 0, subagents: [], denials: 0, unavailable: [] };

/** One trial; writes its artifacts and row.json into `o.out` and returns the row. */
export async function runWalkTrial(o: Omit<WalkWorkerArgs, 'cell'> & Readonly<{ cell: WalkCell; log: (line: string) => void }>): Promise<WalkRow> {
  const label = `${o.cell.id}#${o.trial}`;
  mkdirSync(o.out, { recursive: true });
  const f = buildWalkFixture(o.cell);
  const repo = tmpDir('walk-repo');
  const sha = materialise(f, repo);
  const checkout = join(tmpDir('walk-wt'), 'ledgerly');
  git(repo, 'worktree', 'add', '--quiet', '--detach', checkout, sha);
  const key: WalkKey = { cell: o.cell.id, seed: o.cell.seed, trial: o.trial, sha, slots: f.slots };
  writeFileSync(join(o.out, 'key.json'), `${JSON.stringify(key, null, 2)}\n`);
  const evidence = tmpDir('walk-evidence');
  const row = (fields: Partial<WalkRow> & Pick<WalkRow, 'void'>): WalkRow => ({
    set: o.set, cell: o.cell.id, trial: o.trial, walker: o.walker, graded: null, usage: null, estimatedUsd: 0, wallMs: 0, turns: 0, load: 0, models: [],
    method: emptyMethod, evidence: { files: 0, screenshots: 0, missing: 0 }, dir: o.out, ...fields,
  });
  const finish = (r: WalkRow): WalkRow => {
    cpSync(evidence, join(o.out, 'evidence'), { recursive: true });
    writeFileSync(join(o.out, 'row.json'), `${JSON.stringify(r, null, 2)}\n`);
    return r;
  };

  let instance;
  try {
    instance = await bringUp(checkout, f.milestone.bringUp, evidence);
  } catch (e) {
    if (!(e instanceof BringUpFailed)) throw e;
    return finish(row({ void: { reason: 'bring-up', detail: `${e.message}; log ${e.log}: ${readFileSync(e.log, 'utf8').slice(-400)}` } }));
  }
  try {
    const config = runConfig(o.config);
    const { triple } = walkSeat(o.config);
    const module = promptFor('walkthrough', triple.model);
    const journeys = f.milestone.journeys.map((j) => ({ ...j, entry: substitutePorts(j.entry, instance.ports) }));
    const inputs: WalkthroughInputs = {
      vision: f.vision, milestone: { id: f.milestone.id, text: f.milestone.text }, round: 1, journeys, references: referencesOf(checkout),
      tweaks: [], findings: [], product: { checkout: absPath(checkout), ports: instance.ports, env: instance.env }, units: f.units, evidenceDir: absPath(evidence),
    };
    const call: BackendCall = {
      kind: 'claude-acting-judge', role: 'walkthrough', triple, session: freshJudgmentSession(), schemaText: canonicalJson(module.schema),
      system: module.system, mcpConfig: walkMcpConfig(config, evidence), evidenceDirs: [absPath(evidence)],
    };
    const argv = backendArgv(call);
    const prompt = promptBytes(call, module.render(inputs));
    writeFileSync(join(o.out, 'prompt.txt'), prompt);
    writeFileSync(join(o.out, 'argv.json'), `${JSON.stringify(argv, null, 2)}\n`);
    const base = `http://127.0.0.1:${instance.ports['web']}`;
    const scenario = writeScenario(tmpDir('walk-scenario'), walkerSteps(o.walker, f, base, evidence));
    const scratch = tmpDir('walk-session');
    const stdoutFile = join(scratch, 'walk-1.jsonl');
    const session = await runSession(argv, prompt, checkout, scenario.binDir, stdoutFile, join(scratch, 'stderr.txt'), { medianLoad: o.medianLoad, trialCap: o.trialCap, label, log: o.log });
    cpSync(scratch, o.out, { recursive: true });
    const stdout = readFileSync(stdoutFile, 'utf8');
    const events = parseEvents(stdout, true);
    writeFileSync(join(o.out, 'transcript.jsonl'), events.map((event) => `${JSON.stringify({ turn: 1, event })}\n`).join(''));
    const t = readTranscript(events);
    const result = events.find((e) => e['type'] === 'result');
    const usage = result === undefined ? null : usageOf(result);
    const hits = scanTranscript(join(o.out, 'transcript.jsonl'), [o.out, dirname(o.out), 'evals/roles', ...repositoryPaths()]);
    let answer: WalkthroughOutput | null = null;
    let invalid: string | null = null;
    if (session.brake === null) {
      const reading = readClaude(stdout);
      if (reading.output.kind === 'absent') invalid = `no report: ${reading.output.why} (exit ${session.exit})`;
      else {
        try {
          answer = validateWalkthroughOutput(reading.output.value);
          writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(answer, null, 2)}\n`);
        } catch (e) {
          invalid = (e as Error).message;
          writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(reading.output.value, null, 2)}\n`);
        }
      }
    }
    const files = filesUnder(evidence);
    const cited = answer === null ? [] : [...new Set([...answer.journeys.flatMap((j) => j.evidence), ...answer.findings.flatMap((x) => x.evidence)])];
    const missing = cited.filter((p) => !existsSync(isAbsolute(p) ? p : join(evidence, p))).length;
    const voided: WalkRow['void'] = session.brake !== null ? { reason: session.brake.rule === 'cap' ? 'cap' : 'runaway', detail: `${session.brake.rule}: ${session.brake.detail}` }
      : hits.length > 0 ? { reason: 'needle', detail: hits.slice(0, 5).join('; ') }
      : invalid !== null ? { reason: 'invalid', detail: invalid }
      : null;
    const counts = toolCounts(t);
    return finish(row({
      void: voided, graded: voided === null && answer !== null ? gradeWalk(f.slots, t, answer) : null, usage, estimatedUsd: t.liveUsd, wallMs: session.wallMs,
      turns: t.turns, load: t.load, models: usage === null ? [triple.model] : Object.keys(usage.byModel),
      method: {
        available: t.tools, tools: counts, browserCalls: t.calls.filter((c) => c.name.startsWith('mcp__')).length, shellCalls: counts['Bash'] ?? 0,
        subagents: t.subagents.map((a) => ({ type: a.type, model: a.model, tokens: a.inputTokens + a.outputTokens })), denials: t.denials, unavailable: unavailableCalls(t),
      },
      evidence: { files: files.length, screenshots: files.filter((p) => /\.(png|jpe?g)$/i.test(p)).length, missing },
    }));
  } catch (e) {
    return finish(row({ void: { reason: 'error', detail: (e as Error).stack ?? String(e) } }));
  } finally {
    instance.stop();
  }
}
