// One polish-judge trial end to end, through the production compare job, as the walkthrough eval runs the production
// walk: the walkthrough eval's milestone arc (walkthrough/arc.ts `setupMilestoneArc`) over the cell's before product.
// u1 merges through the arc harness (fake plan-check, build and gate; the product's own tests run for real), which makes
// walk-1 due; walk-1 runs through the production walk job with a scripted walker whose one polish proposal is the cell's
// (its text, its journey, its unit u2 over the reference and the product, citing the walk's note of what it saw); the
// production polish revision (src/walk/polish.ts `applyPolish`) admits u2; u2 runs its pipeline (fake plan-check, a fake
// build committing the cell's after-state, real lanes, fake gate) and waits at its candidate admission for its compare;
// then `runCompare` (src/walk/compare.ts) runs compare-1 exactly as an arc does: the capture under the fence, the
// reservation, two detached checkouts brought up side by side (before: the integration tip; after: u2's approved
// commit), the polishJudge call through `callActingJudge` (the polishJudge seat, frontier: Opus 5.5 medium; Playwright
// MCP for a browser journey, the repo config's walkthrough servers), the validation with its one repair turn, teardown and
// `tweak-judged`. The judge's calls go through the fake backend's PATH shim: its `real` act execs the real `claude` (a
// second serves the repair turn); a degenerate fake judge (`FAKE_JUDGES`) answers instead for the free tier.
//
// A compare abandoned after its calls (the answer refused again after the repair turn) voids the trial `invalid`; an
// after-state that does not come up (`tweak-judged{drop, bring-up-failed}`) voids it `bring-up` (a fixture bug: every
// after-state comes up). The monitor and its brakes are the walkthrough eval's (walkthrough/arc.ts `startMonitor`), on
// the polishJudge's calls.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type JobId, type UnitId, invocationId } from '../../../src/core/ids.ts';
import type { JsonValue } from '../../../src/core/json.ts';
import { SchemaError } from '../../../src/core/validate.ts';
import { absPath } from '../../../src/core/values.ts';
import { jobEvidenceRoot } from '../../../src/git/snapshot.ts';
import { readClaude } from '../../../src/backends/claude.ts';
import { runUnit, type Gate } from '../../../src/pipeline/unit.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import { type PolishJudgeOutput, validatePolishJudgeOutput, validateWalkthroughOutput } from '../../../src/prompts/schemas.ts';
import { type RepoConfig, arcStack, resolveRouting } from '../../../src/routing/layers.ts';
import { holisticContexts } from '../../../src/schedule/scheduler.ts';
import { type CompareOutcome, judgeRefusals, runCompare, tweakOf } from '../../../src/walk/compare.ts';
import { applyPolish } from '../../../src/walk/polish.ts';
import { runWalk } from '../../../src/walk/walk.ts';
import { contextFor } from '../../../test/fixtures/unit-common.ts';
import { admitAll } from '../../../test/fixtures/stage-common.ts';
import { polishSteps, unitInForce, walkContext } from '../../../test/fixtures/walk-common.ts';
import { admitSpecWire } from '../../../test/helpers/holistic.ts';
import { revParse } from '../../../test/helpers/repo.ts';
import { type Step, readCalls } from '../../../test/helpers/scenario.ts';
import { repositoryPaths, scanTranscript } from '../../m4a/transcript.ts';
import type { CellSet } from '../gate/cells.ts';
import { type Usage, parseEvents, readTranscript, sumUsage, toolCounts, unavailableCalls, usageOf } from '../transcript.ts';
import { OVERSPEND, escapeRe, filesUnder, readStdout, roleSpawns, setupMilestoneArc, startMonitor } from '../walkthrough/arc.ts';
import { MILESTONE_UNIT, walkRepoConfig } from '../walkthrough/fixture.ts';
import type { PolishCell } from './cells.ts';
import { expectedDecision } from './families.ts';
import { COMPARE_JOB, POLISH_SCOPE, POLISH_UNIT, type PolishFixture, WALK_JOB, WALK_NOTE, buildPolishFixture, keyOf } from './fixture.ts';

/**
 * Degenerate judges, each knowing the key (what a cheating judge would know): `oracle` keeps exactly the better
 * after-states; `keep-all` keeps every tweak; `drop-all` drops every tweak; `refused` cites evidence that does not exist,
 * twice, so the compare's repair turn fails too (void `invalid`); `overspend` streams one message billed far over any
 * trial cap and then hangs (the spend brake's own check). Each but `refused` and `overspend` saves a note per side and cites it.
 */
export const FAKE_JUDGES = ['oracle', 'keep-all', 'drop-all', 'refused', 'overspend'] as const;
export type FakeJudge = (typeof FAKE_JUDGES)[number];
export type JudgeKind = 'real' | FakeJudge;

export type PolishVoidReason = 'runaway' | 'cap' | 'error' | 'needle' | 'bring-up' | 'invalid';

export type PolishRow = Readonly<{
  set: CellSet;
  cell: string;
  family: string;
  variant: PolishCell['variant'];
  trial: number;
  judge: JudgeKind;
  void: Readonly<{ reason: PolishVoidReason; detail: string }> | null;
  /** The judge's decision (`tweak-judged{judged}`), or null on a void. */
  decision: 'keep' | 'drop' | null;
  /** `keep` on a better after-state, `drop` on a worse or neutral one; null on a void. */
  correct: boolean | null;
  reasons: readonly string[];
  usage: Usage | null;
  /** The trial's spend at list price from its transcripts (`liveUsd`): what a session killed before its result cost. */
  estimatedUsd: number;
  wallMs: number;
  turns: number;
  load: number;
  /** polishJudge calls made: 2 when the answer took its repair turn. */
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
  /** Files the compare's evidence dir holds (the judge's captures and notes, both instances' logs), and how many are images. */
  evidence: Readonly<{ files: number; screenshots: number }>;
  dir: string;
}>;

export type PolishWorkerArgs = Readonly<{
  role: 'polishJudge';
  set: CellSet;
  cell: string;
  trial: number;
  judge: JudgeKind;
  /** The repo config of `--rebind` (`routing.classes`), or null. */
  config: RepoConfig | null;
  out: string;
  medianLoad: number | null;
  trialCap: number | null;
}>;

/** The polishJudge seat under the run's routing (the walk roles in force, `--rebind` applied), as the arm names it. */
export function polishSeat(config: RepoConfig | null): Readonly<{ arm: string }> {
  const r = resolveRouting({ ...arcStack('default', config, null), arcScope: 'corpus', arcRoles: 'm4b', milestones: true });
  const t = r.table.polishJudge.arc;
  if (t.backend !== 'claude') throw new Error(`the polishJudge seat bound to ${t.model}: compares run on Claude only (codex-judgment)`);
  promptFor('polishJudge', t.model); // a rebind onto a model with no polishJudge prompt fails here, before any trial
  const cls = r.classes.polishJudge.arc;
  return { arm: `polishJudge.arc ${cls}${r.bindings[cls] === 'repo-config' ? ' (rebound)' : ''} ${t.model}:${t.effort}` };
}

// ---------------------------------------------------------------------------------------------------
// The scripted walk and the judges

/** walk-1's report: every journey completed, nothing found, the cell's one proposal (its unit u2 at rev 1). */
function walkAnswer(f: PolishFixture, planDir: string): JsonValue {
  const u1 = JSON.parse(readFileSync(join(planDir, `${MILESTONE_UNIT}.json`), 'utf8')) as Record<string, unknown>;
  const spec = admitSpecWire({ ...u1, unit: POLISH_UNIT, rev: 1, scope: [...POLISH_SCOPE] });
  const value = {
    final: true,
    journeys: f.walk.milestone.journeys.map((j) => ({ journey: j.id, outcome: 'completed', evidence: [WALK_NOTE], note: 'walked' })),
    findings: [],
    polish: [{ journey: f.family.journey, evidence: [WALK_NOTE], text: f.cell.proposal, unit: { id: POLISH_UNIT, scope: [...POLISH_SCOPE], spec } }],
    premises: [],
    reasons: ['walked every journey'],
  } as unknown as JsonValue;
  validateWalkthroughOutput(value);
  return value;
}

function judgeAnswer(decision: 'keep' | 'drop', evidence: readonly string[]): JsonValue {
  return { final: true, decision, evidence: [...evidence], reasons: [`scripted ${decision}`], premises: [] };
}

/** The polishJudge's calls: the real CLI (the call and its repair turn), or a fake's. */
function judgeSteps(kind: JudgeKind, f: PolishFixture, evidenceDir: string): readonly Step[] {
  const unit = COMPARE_JOB;
  if (kind === 'real') return [1, 2].map((): Step => ({ as: 'claude', unit, expect: {}, acts: [{ type: 'real' }] }));
  const browser = f.walk.milestone.journeys.find((j) => j.id === f.family.journey)!.via === 'browser';
  const expect = {
    argv: ['-p', '--strict-mcp-config', ...(browser ? ['--mcp-config'] : []), '--permission-mode', 'bypassPermissions'],
    ...(browser ? {} : { argvLacks: ['--mcp-config'] }),
  };
  if (kind === 'overspend') return [{ as: 'claude', unit, expect, acts: [{ type: 'stream', events: [OVERSPEND] }, { type: 'hang', ms: 10 * 60_000 }] }];
  if (kind === 'refused') return [1, 2].map((): Step => ({ as: 'claude', unit, expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: judgeAnswer('keep', ['nowhere.png']) }] }));
  const decision = kind === 'keep-all' ? 'keep' : kind === 'drop-all' ? 'drop' : expectedDecision(f.cell.variant);
  const pattern = `(${escapeRe(evidenceDir)})`;
  return [{
    as: 'claude', unit, expect,
    acts: [
      { type: 'writeToPrompt', pattern, file: 'before.txt', text: 'walked the before\n' },
      { type: 'writeToPrompt', pattern, file: 'after.txt', text: 'walked the after\n' },
      { type: 'emit', value: judgeAnswer(decision, ['before.txt', 'after.txt']) },
    ],
  }];
}

// ---------------------------------------------------------------------------------------------------
// A trial

/** Why the compare refused the last answer (schema, or a cited file missing), for an `invalid` void. */
function refusals(value: unknown, dirs: readonly string[]): string {
  let output: PolishJudgeOutput;
  try {
    output = validatePolishJudgeOutput(value);
  } catch (e) {
    if (e instanceof SchemaError) return `off its schema: ${e.message}`;
    throw e;
  }
  return judgeRefusals(dirs.map((d) => absPath(d)), output).join('; ');
}

const emptyMethod: PolishRow['method'] = { available: [], tools: {}, browserCalls: 0, shellCalls: 0, subagents: [], denials: 0, unavailable: [] };

/** One trial; writes its artifacts and row.json into `o.out` and returns the row. */
export async function runPolishTrial(o: Omit<PolishWorkerArgs, 'cell'> & Readonly<{ cell: PolishCell; log: (line: string) => void }>): Promise<PolishRow> {
  const label = `${o.cell.id}#${o.trial}`;
  mkdirSync(o.out, { recursive: true });
  const f = buildPolishFixture(o.cell);
  const d = setupMilestoneArc(f.walk, walkRepoConfig(o.config), (runDir, planDir) => [
    {
      as: 'claude', unit: WALK_JOB, expect: { argv: ['-p'] },
      acts: [
        { type: 'writeToPrompt', pattern: `(${escapeRe(jobEvidenceRoot(absPath(runDir), WALK_JOB as JobId))})`, file: WALK_NOTE, text: f.family.observed },
        { type: 'emit', value: walkAnswer(f, planDir) },
      ],
    },
    ...polishSteps(POLISH_UNIT, f.changed),
    ...judgeSteps(o.judge, f, jobEvidenceRoot(absPath(runDir), COMPARE_JOB as JobId)),
  ]);
  writeFileSync(join(o.out, 'key.json'), `${JSON.stringify(keyOf(f, o.trial, revParse(d.repo, 'main')), null, 2)}\n`);
  const r = contextFor(d);
  const { ctx, w } = walkContext(r);
  const h = holisticContexts(w).checkpoint;
  const tick = setInterval(() => w.arbiter.wake(), 50);
  const unit = POLISH_UNIT as UnitId;
  // Admission as the scheduler gives a polish unit: everything but a candidate its compare has not kept.
  const polishGate: Gate = (next) => Promise.resolve(!(next.kind === 'admission' && next.stage === 'candidate' && tweakOf(r.journal.view, unit)?.decision !== 'keep'));
  let monitor: ReturnType<typeof startMonitor> | null = null;
  const started = Date.now();
  let error: string | null = null;
  let compared: CompareOutcome | null = null;
  try {
    const merged = await runUnit(w.stage, unitInForce(r, MILESTONE_UNIT), admitAll);
    if (merged.kind !== 'merged') throw new Error(`${MILESTONE_UNIT} did not merge: ${JSON.stringify(merged)}`);
    const walked = await runWalk(ctx);
    if (walked.kind !== 'ended' || walked.outcome !== 'reported') throw new Error(`walk-1 did not report: ${JSON.stringify(walked)}`);
    const applied = await applyPolish(h);
    if (applied.kind !== 'applied' || applied.admitted.join() !== POLISH_UNIT) {
      const refused = r.journal.view.walkFacts().flatMap((x) => (x.fact.kind === 'polish-refused' ? x.fact.reasons : []));
      throw new Error(`the polish revision did not admit ${POLISH_UNIT}: ${JSON.stringify(applied)} ${refused.join('; ')}`);
    }
    const held = await runUnit(w.stage, unitInForce(r, POLISH_UNIT), polishGate);
    if (held.kind !== 'held' || r.journal.view.unit(unit).approval === null) throw new Error(`${POLISH_UNIT} did not wait approved at its candidate: ${JSON.stringify(held)}`);
    monitor = startMonitor(r, label, o.medianLoad, o.trialCap, o.log, 'polishJudge');
    compared = await runCompare(h);
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    clearInterval(tick);
    monitor?.stop();
  }
  const wallMs = Date.now() - started;
  const evidenceDir = jobEvidenceRoot(r.ctx.runDir, COMPARE_JOB as JobId);
  const walkEvidenceDir = jobEvidenceRoot(r.ctx.runDir, WALK_JOB as JobId);
  if (existsSync(evidenceDir)) cpSync(evidenceDir, join(o.out, 'evidence'), { recursive: true, dereference: true });
  const perCall = roleSpawns(r, 'polishJudge').map((s) => {
    const stdout = readStdout(r, invocationId(s.op, s.ordinal));
    const events = parseEvents(stdout, true);
    const result = events.findLast((e) => e['type'] === 'result');
    return { stdout, events, usage: result === undefined ? null : usageOf(result) };
  });
  perCall.forEach((c, i) => writeFileSync(join(o.out, `compare-${i + 1}.jsonl`), c.stdout));
  const calls = readCalls(d.scenarioPath).filter((c) => c.unit === COMPARE_JOB);
  writeFileSync(join(o.out, 'prompt.txt'), calls[0]?.stdin ?? '');
  writeFileSync(join(o.out, 'argv.json'), `${JSON.stringify(calls[0]?.argv ?? [], null, 2)}\n`);
  // The `--mcp-config` file is kept in the arc's run dir, which the worker removes: the trial keeps a copy.
  const mcpAt = calls[0]?.argv.indexOf('--mcp-config') ?? -1;
  const mcpFile = mcpAt < 0 ? null : calls[0]!.argv[mcpAt + 1] ?? null;
  if (mcpFile !== null && existsSync(mcpFile)) cpSync(mcpFile, join(o.out, 'mcp.json'));
  const allEvents = perCall.flatMap((c) => c.events);
  const transcriptFile = join(o.out, 'transcript.jsonl');
  writeFileSync(transcriptFile, allEvents.map((event, i) => `${JSON.stringify({ turn: 1, line: i + 1, event })}\n`).join(''));
  const t = readTranscript(allEvents);
  const last = perCall.at(-1);
  const reading = last === undefined ? null : readClaude(last.stdout);
  const value = reading !== null && reading.output.kind === 'present' ? reading.output.value : null;
  if (value !== null) writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(value, null, 2)}\n`);
  const hits = scanTranscript(transcriptFile, [o.out, dirname(o.out), 'evals/roles', ...repositoryPaths()]);
  const brake = monitor?.brake() ?? null;
  const voided: PolishRow['void'] = brake !== null ? { reason: brake.rule === 'cap' ? 'cap' : 'runaway', detail: `${brake.rule}: ${brake.detail}` }
    : error !== null ? { reason: 'error', detail: error }
    : compared?.kind === 'abandoned' ? { reason: 'invalid', detail: `abandoned after ${perCall.length} call(s): ${value === null ? compared.detail : refusals(value, [evidenceDir, walkEvidenceDir])}` }
    : compared?.kind !== 'judged' ? { reason: 'error', detail: `the compare did not judge: ${JSON.stringify(compared)}` }
    : compared.reason === 'bring-up-failed' ? { reason: 'bring-up', detail: 'the after-state did not come up' }
    : compared.reason !== 'judged' ? { reason: 'error', detail: `the tweak was dropped by code (${compared.reason}), not judged` }
    : hits.length > 0 ? { reason: 'needle', detail: hits.slice(0, 5).join('; ') }
    : null;
  const decision = voided === null && compared?.kind === 'judged' ? compared.decision : null;
  const files = filesUnder(join(o.out, 'evidence'));
  const counts = toolCounts(t);
  const usage = sumUsage(perCall.flatMap((c) => (c.usage === null ? [] : [c.usage])));
  const answer = decision !== null && value !== null ? validatePolishJudgeOutput(value) : null;
  const row: PolishRow = {
    set: o.set, cell: o.cell.id, family: o.cell.family, variant: o.cell.variant, trial: o.trial, judge: o.judge, void: voided,
    decision, correct: decision === null ? null : decision === expectedDecision(o.cell.variant), reasons: answer?.reasons ?? [],
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
