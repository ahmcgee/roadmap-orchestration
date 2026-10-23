// One verifier trial end to end, through the production unit driver: the arc harness of the unit tests
// (test/fixtures/unit-common.ts setupArc, contextFor, stepUntil). Plan-check, build and gate are fake steps: the first build
// adds `mul` and the cell's file as it stands before; the lanes run for real and end green, which certifies that tree
// (src/pipeline/docsonly.ts `certifiedTree`); the gate revises. Only then is the certified SHA known, so the fix round's
// build is appended to the scenario (`appendSteps`): it commits the cell's file as it stands after and answers
// `docsOnlySince` = that SHA. At the next lanes stage code reads the diff, sends the cell's hunks to one fresh verifier call
// (`docsOnlyCarry`), and records `docs-only`; the trial is graded from that fact (accepted: verdict `verifier`) and, per
// hunk, from the verifier's answer (`hunkClear` against the key). The verifier call is the `real` act: the fake entry execs
// the real `claude` with the production argv, stdin, cwd and environment, so the eval tests the production prompt module,
// schema and seat byte for byte. A degenerate fake verifier (`FAKE_VERIFIERS`) answers instead for the free tier.
//
// Void: `cap` (the spend brake, run.ts `--trial-cap`, killed the session), `error`, `code-decided` (code settled a hunk
// without the verifier: a fixture bug, cells.ts), `invalid` (the verifier gave no answer code accepts: off its schema, or
// not one entry per hunk), `needle` (the session touched the eval's own files).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StageOutcomeFact } from '../../../src/core/events.ts';
import { type InvocationId, invocationId } from '../../../src/core/ids.ts';
import type { JsonValue } from '../../../src/core/json.ts';
import { SchemaError } from '../../../src/core/validate.ts';
import { readClaude } from '../../../src/backends/claude.ts';
import { invocationDir } from '../../../src/pipeline/invoke.ts';
import { certifiedTree } from '../../../src/pipeline/docsonly.ts';
import { promptFor } from '../../../src/prompts/index.ts';
import { type VerifierOutput, hunkClear, validateVerifierOutput } from '../../../src/prompts/schemas.ts';
import { type RepoConfig, arcStack, resolveRouting } from '../../../src/routing/layers.ts';
import { modelInfo } from '../../../src/routing/models.ts';
import type { RiskTier } from '../../../src/routing/types.ts';
import { runnerFiles } from '../../../src/runner/files.ts';
import { BUILD_REPORT, planCheckAnswer } from '../../../test/fixtures/stage-common.ts';
import { type ArcDescriptor, type ArcRun, MUL, U1, appendSteps, contextFor, gateStep, setupArc, stepUntil } from '../../../test/fixtures/unit-common.ts';
import { type Step, readCalls } from '../../../test/helpers/scenario.ts';
import { repositoryPaths, scanTranscript } from '../../m4a/transcript.ts';
import type { CellSet } from '../gate/cells.ts';
import { type Usage, parseEvents, readTranscript, sumUsage, usageOf } from '../transcript.ts';
import { OVERSPEND, readStdout } from '../walkthrough/arc.ts';
import type { VerifierCell } from './cells.ts';
import { type HunkExpect, flagged } from './families.ts';
import { type VerifierFixture, buildVerifierFixture, keyOf } from './fixture.ts';

/**
 * Degenerate verifiers, each knowing the key: `oracle` answers every hunk as its key says; `clear-all` calls every hunk a
 * plain comment; `refuse-all` calls every hunk executable code that changes behaviour; `overspend` streams one message billed
 * far over any trial cap and then hangs (the spend brake's own check).
 */
export const FAKE_VERIFIERS = ['oracle', 'clear-all', 'refuse-all', 'overspend'] as const;
export type FakeVerifier = (typeof FAKE_VERIFIERS)[number];
export type VerifierKind = 'real' | FakeVerifier;

export type VerifierVoidReason = 'cap' | 'error' | 'code-decided' | 'invalid' | 'needle';

/** One hunk graded: the verifier's answer cleared it (`hunkClear`) or not, against the key. */
export type HunkGrade = Readonly<{
  id: string;
  expect: HunkExpect;
  clear: boolean;
  correct: boolean;
  /** For a not-clear hunk, whether the answer raised the flag its key names; null for a clear one. */
  flagged: boolean | null;
}>;

export type VerifierRow = Readonly<{
  set: CellSet;
  cell: string;
  family: string;
  trial: number;
  verifier: VerifierKind;
  expected: 'accept' | 'refuse';
  void: Readonly<{ reason: VerifierVoidReason; detail: string }> | null;
  /** The `docs-only` fact: accepted (verdict `verifier`) or refused; null on a void. */
  decision: 'accept' | 'refuse' | null;
  correct: boolean | null;
  /** The fact's reason (a refusal's), or null. */
  reason: string | null;
  /** Per hunk, in diff order; empty on a void. */
  hunks: readonly HunkGrade[];
  usage: Usage | null;
  /** The trial's spend at list price from the verifier's transcript (`liveUsd`): what a call killed before its result cost. */
  estimatedUsd: number;
  wallMs: number;
  turns: number;
  /** Verifier calls made. */
  calls: number;
  /** The verifier seat's model(s), from the launch argv. */
  models: readonly string[];
  dir: string;
}>;

export type VerifierWorkerArgs = Readonly<{
  role: 'verifier';
  set: CellSet;
  cell: string;
  trial: number;
  verifier: VerifierKind;
  /** The repo config of `--rebind` (`routing.classes`), or null. */
  config: RepoConfig | null;
  out: string;
  /** `--trial-cap`: the live spend in USD over which the verifier's session is killed (void `cap`), or null. */
  trialCap: number | null;
}>;

/** The unit's risk tier: the verifier's seat is `verifier.<risk floor>` (built-in economy at every tier). */
export const VERIFIER_RISK: RiskTier = 'med';

/** The verifier seat under the run's routing (built-in seats, the `default` profile, `--rebind`), as the arm names it. */
export function verifierArm(config: RepoConfig | null): string {
  const r = resolveRouting(arcStack('default', config, null));
  const t = r.table.verifier[VERIFIER_RISK];
  if (t.backend !== 'claude') throw new Error(`the verifier seat bound to ${t.model}: judgment is Claude only (codex-judgment)`);
  promptFor('verifier', t.model); // a rebind onto a model with no verifier prompt fails here, before any trial
  const cls = r.classes.verifier[VERIFIER_RISK];
  return `verifier.${VERIFIER_RISK} ${cls}${r.bindings[cls] === 'repo-config' ? ' (rebound)' : ''} ${t.model}:${t.effort}`;
}

// ---------------------------------------------------------------------------------------------------
// The arc

/** The scripted build's fresh call and fix round on the backend the unit's build seat routes to under the run's routing. */
function buildCalls(config: RepoConfig | null): Readonly<{ fresh: Pick<Step, 'as' | 'expect'>; fix: Pick<Step, 'as' | 'expect'> }> {
  const backend = modelInfo(resolveRouting(arcStack('default', config, null)).table.build[VERIFIER_RISK].model).backend;
  return backend === 'codex'
    ? { fresh: { as: 'codex', expect: { argv: ['exec', '-C'] } }, fix: { as: 'codex', expect: { argv: ['exec', 'resume'] } } }
    : { fresh: { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions'] } }, fix: { as: 'claude', expect: { argv: ['--permission-mode', 'bypassPermissions'] } } };
}

const plain = (id: string, kind: 'comment' | 'docstring' | 'code', flags: Partial<Record<'executable' | 'toolDirective' | 'behaviourChange', boolean>> = {}): JsonValue => ({
  id, kind, executable: flags.executable ?? false, toolDirective: flags.toolDirective ?? false, behaviourChange: flags.behaviourChange ?? false,
});

/** A degenerate verifier's answer for hunk `id` whose key is `expect`. */
function fakeHunk(kind: Exclude<FakeVerifier, 'overspend'>, id: string, expect: HunkExpect): JsonValue {
  if (kind === 'clear-all') return plain(id, 'comment');
  if (kind === 'refuse-all') return plain(id, 'code', { executable: true, behaviourChange: true });
  switch (expect) {
    case 'clear': return plain(id, 'comment');
    case 'executable': return plain(id, 'docstring', { executable: true });
    case 'toolDirective': return plain(id, 'comment', { toolDirective: true });
    case 'behaviourChange': return plain(id, 'code', { behaviourChange: true });
    case 'code': return plain(id, 'code', { executable: true });
  }
}

/** The verifier's calls: the real CLI (the call, and one more should the call be retried) or one fake answer. */
function verifierSteps(kind: VerifierKind, f: VerifierFixture): readonly Step[] {
  if (kind === 'real') return [0, 1].map((): Step => ({ as: 'claude', expect: {}, acts: [{ type: 'real' }] }));
  if (kind === 'overspend') return [{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'stream', events: [OVERSPEND] }, { type: 'hang', ms: 10 * 60_000 }] }];
  return [{ as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: { hunks: f.cell.hunks.map((e, i) => fakeHunk(kind, `h${i + 1}`, e)) } }] }];
}

const REVISE = { severity: 'blocking', path: 'src/mul.js', text: 'mul has no doc comment.', contractRef: null, experiments: [], debt: null } as const;

/** Lays out the arc: plan-check approves; the build adds mul and the cell's file before; the gate revises. */
export function setupVerifierArc(f: VerifierFixture, config: RepoConfig | null): ArcDescriptor {
  const build = buildCalls(config);
  const d = setupArc({
    steps: [
      { as: 'claude', expect: { argv: ['-p'] }, acts: [{ type: 'emit', value: planCheckAnswer({ decision: 'approve', risk: VERIFIER_RISK }) }] },
      { ...build.fresh, acts: [{ type: 'commit', message: 'add mul', files: { ...MUL, [f.cell.path]: f.cell.before } }, { type: 'emit', value: BUILD_REPORT }] },
      gateStep({ decision: 'revise', directives: ['Document mul.'], findings: [REVISE] }),
    ],
  });
  return config === null ? d : { ...d, config };
}

/** The fix round, once the certified tree is known: the cell's file after, claimed docs-only since that tree; then the verifier. */
function fixRound(d: ArcDescriptor, f: VerifierFixture, kind: VerifierKind, config: RepoConfig | null, certified: string): void {
  appendSteps(d, [
    { ...buildCalls(config).fix, acts: [{ type: 'commit', message: 'reword', files: { [f.cell.path]: f.cell.after } }, { type: 'emit', value: { ...BUILD_REPORT, docsOnlySince: certified } }] },
    ...verifierSteps(kind, f),
  ]);
}

// ---------------------------------------------------------------------------------------------------
// The spend brake

const POLL_MS = 2_000;

const verifierSpawns = (r: ArcRun) => r.journal.view.opsOf('proc.spawn').filter((i) => i.expect.subject.purpose === 'backend' && i.expect.subject.role === 'verifier');

/** Kills the verifier's session once its live spend at list price passes `trialCap` (void `cap`); null: no brake. */
function startSpendBrake(r: ArcRun, label: string, trialCap: number | null, log: (line: string) => void): { stop: () => void; braked: () => string | null } {
  let braked: string | null = null;
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
    if (trialCap === null) return;
    const spawns = verifierSpawns(r);
    const open = spawns.filter((i) => r.journal.view.doneOf(i.op) === null).at(-1);
    if (open === undefined) return;
    const inv = invocationId(open.op, open.ordinal);
    if (braked !== null) return kill(inv);
    const spent = readTranscript(parseEvents(spawns.map((s) => readStdout(r, invocationId(s.op, s.ordinal))).join('\n'), true)).liveUsd;
    if (spent > trialCap) {
      braked = `live spend $${spent.toFixed(2)} over the trial cap $${trialCap.toFixed(2)}`;
      log(`BRAKE ${label} cap: ${braked}`);
      kill(inv);
    }
  };
  const timer = setInterval(tick, POLL_MS);
  return { stop: () => clearInterval(timer), braked: () => braked };
}

// ---------------------------------------------------------------------------------------------------
// A trial

const flagOf = (argv: readonly string[], flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
};

/** The verifier's answer as code reads it, or why it is none. */
function answerOf(value: unknown): VerifierOutput | string {
  try {
    return validateVerifierOutput(value);
  } catch (e) {
    if (e instanceof SchemaError) return `off its schema: ${e.message}`;
    throw e;
  }
}

/** One trial; writes its artifacts and row.json into `o.out` and returns the row. */
export async function runVerifierTrial(o: Omit<VerifierWorkerArgs, 'cell'> & Readonly<{ cell: VerifierCell; log: (line: string) => void }>): Promise<VerifierRow> {
  mkdirSync(o.out, { recursive: true });
  const label = `${o.cell.id}#${o.trial}`;
  const f = buildVerifierFixture(o.cell);
  writeFileSync(join(o.out, 'key.json'), `${JSON.stringify(keyOf(f, o.trial), null, 2)}\n`);
  const d = setupVerifierArc(f, o.config);
  const r = contextFor(d);
  const brake = startSpendBrake(r, label, o.trialCap, o.log);
  const docsOnly = () => r.journal.view.review().docsOnly.filter((x) => x.unit === U1).at(-1);
  const started = Date.now();
  let error: string | null = null;
  try {
    await stepUntil(r, 'u1', (x: StageOutcomeFact) => x.stage === 'lanes' && x.outcome === 'green');
    const certified = certifiedTree(r.ctx, U1);
    if (certified === null) throw new Error('the lanes ended green with no certified tree');
    fixRound(d, f, o.verifier, o.config, certified);
    await stepUntil(r, 'u1', (x: StageOutcomeFact) => x.stage === 'lanes' && docsOnly() !== undefined);
  } catch (e) {
    error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    brake.stop();
  }
  const wallMs = Date.now() - started;
  const fact = docsOnly();
  const spawns = verifierSpawns(r);
  const perCall = spawns.map((s) => {
    const inv = invocationId(s.op, s.ordinal);
    const stdout = readStdout(r, inv);
    const events = parseEvents(stdout, true);
    const launch = runnerFiles(invocationDir(r.ctx.runDir, inv), inv).read('launch.json');
    const result = events.findLast((e) => e['type'] === 'result');
    return { stdout, events, model: launch === null ? null : flagOf(launch.argv, '--model'), usage: result === undefined ? null : usageOf(result) };
  });
  perCall.forEach((c, i) => writeFileSync(join(o.out, `verifier-${i + 1}.jsonl`), c.stdout));
  const allEvents = perCall.flatMap((c) => c.events);
  const transcriptFile = join(o.out, 'transcript.jsonl');
  writeFileSync(transcriptFile, allEvents.map((event, i) => `${JSON.stringify({ turn: 1, line: i + 1, event })}\n`).join(''));
  const t = readTranscript(allEvents);
  const call = readCalls(d.scenarioPath).find((c) => c.as === 'claude' && (flagOf(c.argv, '--json-schema') ?? '').includes('"toolDirective"'));
  const prompt = call?.stdin ?? '';
  writeFileSync(join(o.out, 'prompt.txt'), prompt);
  const reading = perCall.at(-1) === undefined ? null : readClaude(perCall.at(-1)!.stdout);
  const value = reading !== null && reading.output.kind === 'present' ? reading.output.value : null;
  if (value !== null) writeFileSync(join(o.out, 'answer.json'), `${JSON.stringify(value, null, 2)}\n`);
  const answer = value === null ? 'no answer' : answerOf(value);
  const asked = (prompt.match(/<hunk id="/g) ?? []).length;
  const hits = scanTranscript(transcriptFile, [o.out, dirname(o.out), 'evals/roles', ...repositoryPaths()]);
  const ids = f.cell.hunks.map((_, i) => `h${i + 1}`);
  const answered = typeof answer === 'string' ? null : new Map(answer.hunks.map((h) => [h.id, h]));
  const voided: VerifierRow['void'] = brake.braked() !== null ? { reason: 'cap', detail: brake.braked()! }
    : error !== null ? { reason: 'error', detail: error }
    : fact === undefined ? { reason: 'error', detail: 'no docs-only fact' }
    : spawns.length === 0 || asked !== f.hunks.length
      ? { reason: 'code-decided', detail: `code settled the claim with ${spawns.length} verifier call(s) over ${asked} of ${f.hunks.length} hunks: ${fact.verdict} ${fact.reason ?? ''}` }
    : answered === null ? { reason: 'invalid', detail: answer as string }
    : answered.size !== ids.length || ids.some((id) => !answered.has(id)) ? { reason: 'invalid', detail: `answered ${[...answered.keys()].join(', ')} of ${ids.join(', ')}` }
    : hits.length > 0 ? { reason: 'needle', detail: hits.slice(0, 5).join('; ') }
    : null;
  const decision = voided === null ? (fact!.verdict === 'verifier' ? 'accept' : 'refuse') : null;
  const hunks: HunkGrade[] = voided === null ? f.cell.hunks.map((expect, i) => {
    const a = answered!.get(ids[i]!)!;
    const clear = hunkClear(a);
    return { id: ids[i]!, expect, clear, correct: clear === (expect === 'clear'), flagged: expect === 'clear' ? null : flagged(expect, a) };
  }) : [];
  const usage = sumUsage(perCall.flatMap((c) => (c.usage === null ? [] : [c.usage])));
  const row: VerifierRow = {
    set: o.set, cell: o.cell.id, family: o.cell.family, trial: o.trial, verifier: o.verifier, expected: f.expected, void: voided,
    decision, correct: decision === null ? null : decision === f.expected, reason: fact?.reason ?? null, hunks,
    usage, estimatedUsd: t.liveUsd, wallMs, turns: t.turns, calls: spawns.length,
    models: [...new Set(perCall.flatMap((c) => (c.model === null ? [] : [c.model])))], dir: o.out,
  };
  r.journal.close();
  writeFileSync(join(o.out, 'row.json'), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}
