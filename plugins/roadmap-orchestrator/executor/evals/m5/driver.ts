// The M5 paid fixture, step 2: `node evals/m5/driver.ts <dir> [--profile default|claude-only]` plays the harness and the
// owner around one headless root-agent session over a fixture laid out by setup.ts, and writes `<dir>/report.json` for
// check.ts. Paid only: M5 has no scripted root agent (evals/README.md "The M5 fixture").
//
// The session is M4a's (evals/m4a/driver.ts, whose helpers this reuses: staging without executor/evals and
// executor/test, the allowlisted launch env with the fake gh first on PATH, `runTurn` with its isolation kill on an MCP
// server or a memory path in the init event, `wake` on actionable `roadmap watch` events, the turn-end and session-end
// cleanup, `stopHeldArc`, the forensics and the cost export): `claude -p --model claude-opus-5-5 --effort high
// --plugin-dir <staged plugin> --permission-mode bypassPermissions --strict-mcp-config` resumed turn after turn, hard
// timeout 360 min. The root agent's own session has no MCP server; the walk sessions get the Playwright server from the
// product's `.roadmap/config.json` through the executor. After each turn:
//   - the skill's session-end line ends the session (reason in the skill's closed set);
//   - numbered questions go to the owner: code answers K (= 1), the first slice (both world scenes, V-1 and V-2: SLICE_ANSWER), a brief ack (never: the owner
//     read none) and the frontend-design recommendation (already satisfied: the skill is committed); everything else
//     goes to a frontier-medium `claude -p` given only answer-key.json's owner answers, told to answer from them alone,
//     else "no view: keep your working assumption". The owner declines nothing the arc needs. The brief's open P-n
//     questions are answered the same way through `roadmap answer`, every ANSWER_POLL_MS while a turn runs and at
//     every turn end; a spend or cost hold gets "spend approved", once per arc;
//   - any other final text is the skill's headless wait: resumed on the next actionable watch event; with nothing to
//     wait on it nudges, at most MAX_NUDGES times in a row (`stalled`).
//
// The demo (agent G's `status.demo`, SCHEMAS.md "The demo"). Every owner poll and at the session's end, before the held
// arc is stopped, the driver reads `roadmap status` of the first arc to apply a plan (the fail-fast's arc, the one
// check.ts grades) and records its `demo` whenever it changes (`demo.seen`); at the end it also GETs the demo's `where`
// when it is a URL (`{type: url}`, `demo.final.probe`). check.ts's `demo-serving` grades both.
//
// Fail-fast: once the first arc's first plan in force is in its run dir (arcs in start order), `planShape` (shape.ts) must hold: two or more
// milestones, a browser flow with its design unit, and a dependent milestone with a unit descending from it. Otherwise
// the turn is killed and the run ends `fail-fast` (it would cost hours and grade nothing of M5).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { arcsWithRefs } from '../../src/chain.ts';
import type { Event } from '../../src/core/events.ts';
import { arcId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { absPath } from '../../src/core/values.ts';
import { HOST_DIR } from '../../src/host/hostdir.ts';
import { readClaim } from '../../src/host/lock.ts';
import { PLAN_INPUT, keptInput } from '../../src/input/inforce.ts';
import { type PlanM1, parsePlan } from '../../src/input/plan.ts';
import { parseBriefPayload } from '../../src/phase0/types.ts';
import { PROFILES, type ProfileName } from '../../src/routing/types.ts';
import { ActionableFilter, HEARTBEAT_MIN } from '../../src/watch.ts';
import {
  type ArcForensics, CLAUDE_ISOLATION, LEFTOVER_GRACE_MS, MAX_NUDGES, type Mode, NO_VIEW, type OwnerExchange, type PostRun, RELEASE_WAIT_MS,
  type Released, SPEND_APPROVED, type Turn, type Watched, arcForensics, fixtureProcesses, ghOnPath, killProcs, launchEnv, lastSeq, noView,
  numberedQuestions, openBriefQuestions, postRunOf, roadmapArgv, run, runDirs, runTurn, showProc, snapshotDiagnostics, spendHold, stagePlugin,
  stopHeldArc, wake,
} from '../m4a/driver.ts';
import { exportCosts, repositoryPaths, scanTranscript } from '../m4a/transcript.ts';
import { json } from '../m4a/setup.ts';
import { DESIGN_SKILL, type Layout, SESSION_END, STOP_REASONS, type StopReason, layout } from './layout.ts';
import { planShape } from './shape.ts';

export const REPORT_SCHEMA = 'roadmap/m5-report';
/** The answer key: never staged, never read by a session. */
export const ANSWER_KEY = new URL('./answer-key.json', import.meta.url).pathname;
export const SESSION_MS = 360 * 60_000;
const ANSWER_POLL_MS = 60_000;
const REAL: Mode = { kind: 'real' };

/** What a session must never touch: the key (path and name), the fixture sources, the real repository. */
export const needles = (): readonly string[] => [ANSWER_KEY, 'answer-key', 'evals/m5', ...repositoryPaths()];

// ---------------------------------------------------------------------------------------------------
// The owner

type OwnerAnswer = Readonly<{ topic: string; answer: string }>;
const ownerAnswers = (): readonly OwnerAnswer[] => (JSON.parse(readFileSync(ANSWER_KEY, 'utf8')) as { ownerAnswers: readonly OwnerAnswer[] }).ownerAnswers;

export const SKILL_SATISFIED = `It is already done: ${DESIGN_SKILL.dir}/ is committed in the repo with its SKILL.md and licence. Nothing more to do.`;

/** The answers code gives, or null for the simulator. */
export function codeAnswer(q: string): string | null {
  if (/how many arcs/i.test(q)) return 'K = 1.';
  if (/\b(acknowledge|ack)\b[^.?]*\bbrief\b/i.test(q)) return 'I have not read the brief yet; do not acknowledge it.';
  if (/\bK\b(?!-)/.test(q)) return 'K = 1.';
  if (/frontend-design/i.test(q)) return SKILL_SATISFIED;
  if (/\bslice\b/i.test(q)) return SLICE_ANSWER;
  return null;
}

/** The owner takes both world scenes in the first arc, so its plan holds both milestones and one arc covers the corpus. */
export const SLICE_ANSWER = 'Take both world scenes, V-1 and V-2, in this first arc: reserving from the page, and the keeper\'s tools and settings on top of it.';

type OwnerCtx = Readonly<{ l: Layout; env: Readonly<Record<string, string>> }>;

async function simulatorAnswer(c: OwnerCtx, q: string): Promise<string> {
  const prompt = [
    'You are Dev, who keeps a street\'s book swap shelf and owns its small web page and tools. A root agent working on them asked you the question below.',
    'Answer ONLY from your recorded answers. If none of them answers the question, reply exactly:',
    NO_VIEW,
    'Reply with the answer text only, one or two sentences.',
    '',
    'Your recorded answers:',
    ...ownerAnswers().map((a) => `- On ${a.topic}: ${a.answer}`),
    '',
    `The question: ${q}`,
  ].join('\n');
  const dir = join(c.l.dir, 'owner');
  mkdirSync(dir, { recursive: true });
  const r = await run('claude', ['-p', '--model', 'claude-opus-5-5', '--effort', 'medium', '--tools', '', ...CLAUDE_ISOLATION, '--output-format', 'json', prompt], { cwd: dir, env: c.env, timeoutMs: 10 * 60_000 });
  if (r.status !== 0) throw new Error(`the owner simulator exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { result?: unknown; is_error?: unknown };
  if (typeof out.result !== 'string' || out.is_error === true) throw new Error(`the owner simulator answered ${r.stdout}`);
  return out.result.trim();
}

/** P-n ids answered, those asked already (the simulator's answers never change), the arcs whose spend was approved. */
type OwnerMemory = { answered: Set<string>; asked: Set<string>; spendApprovedAt: number };

async function answerFromBrief(c: OwnerCtx, memory: OwnerMemory, log: OwnerExchange[], inTurn: number | null): Promise<void> {
  if (arcsWithRefs(absPath(c.l.product)).length === 0) return;
  const [cmd, args] = roadmapArgv(c.l, REAL, ['brief', '--repo', c.l.product, '--json']);
  const b = await run(cmd, args, { cwd: c.l.product, env: c.env, timeoutMs: 120_000 });
  if (b.status !== 0) throw new Error(`the owner's roadmap brief exited ${b.status}: ${b.stdout}${b.stderr}`);
  for (const q of openBriefQuestions(parseBriefPayload((JSON.parse(b.stdout) as { payload: unknown }).payload))) {
    if (memory.answered.has(q.id) || memory.asked.has(q.id)) continue;
    memory.asked.add(q.id);
    const question = `${q.id}: ${q.text} Working assumption: ${q.assumption}`;
    const code = codeAnswer(question);
    const answer = code ?? (await simulatorAnswer(c, question));
    if (noView(answer)) continue;
    const [acmd, aargs] = roadmapArgv(c.l, REAL, ['answer', q.id, '--repo', c.l.product, '--text', answer]);
    const r = await run(acmd, aargs, { cwd: c.l.product, env: c.env, timeoutMs: 120_000 });
    const out = r.status === 0 || r.status === 78 ? (JSON.parse(r.stdout) as { refused?: { type: string } }) : null;
    if (out === null || (out.refused !== undefined && out.refused.type !== 'question-not-open')) throw new Error(`the owner's roadmap answer ${q.id} exited ${r.status}: ${r.stdout}${r.stderr}`);
    memory.answered.add(q.id);
    if (out.refused === undefined) log.push({ question, answer, by: code === null ? 'simulator' : 'code', via: 'answer', inTurn });
  }
}

async function ownerReply(c: OwnerCtx, text: string, memory: OwnerMemory, log: OwnerExchange[]): Promise<string | null> {
  const lines: string[] = [];
  for (const [i, q] of numberedQuestions(text).entries()) {
    const code = codeAnswer(q);
    const answer = code ?? (await simulatorAnswer(c, q));
    log.push({ question: q, answer, by: code === null ? 'simulator' : 'code', via: 'numbered', inTurn: null });
    lines.push(`${/^\s*(\d+)/.exec(q)?.[1] ?? i + 1}. ${answer}`);
    const id = /\bP-\d+\b/.exec(q)?.[0];
    if (id !== undefined && !noView(answer)) memory.answered.add(id);
  }
  await answerFromBrief(c, memory, log, null);
  const hold = spendHold(text);
  const arcs = arcsWithRefs(absPath(c.l.product)).length;
  if (hold !== null && memory.spendApprovedAt < arcs) {
    memory.spendApprovedAt = arcs;
    log.push({ question: hold, answer: SPEND_APPROVED, by: 'code', via: 'spend-hold', inTurn: null });
    lines.push(SPEND_APPROVED);
  }
  return lines.length === 0 ? null : lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// The demo and the fail-fast, from the product's run dirs

/** `status.demo` as `roadmap status` printed it (absent before agent G's merge: recorded as null). */
export type DemoSeen = Readonly<{ at: string; arc: string; demo: unknown }>;
export type DemoProbe = Readonly<{ url: string; status: number | null; error: string | null }>;
export type DemoFinal = Readonly<{ arc: string; demo: unknown; probe: DemoProbe | null }>;

async function statusDemo(l: Layout, env: Readonly<Record<string, string>>): Promise<Readonly<{ arc: string; demo: unknown }> | null> {
  // The arc under test's demo (the fail-fast's arc): a later arc's status is no part of the grade.
  const arc = firstPlan(l)?.arc;
  if (arc === undefined) return null;
  const [cmd, args] = roadmapArgv(l, REAL, ['status', '--repo', l.product, '--arc', arc]);
  const r = await run(cmd, args, { cwd: l.product, env, timeoutMs: 120_000 });
  if (r.status !== 0) throw new Error(`roadmap status exited ${r.status}: ${r.stdout}${r.stderr}`);
  return { arc, demo: (JSON.parse(r.stdout) as { demo?: unknown }).demo ?? null };
}

/** The URL `status.demo.where` names (`DemoWhere` `{type: url}`), null for a path, no `where` or no demo. */
export const demoUrl = (demo: unknown): string | null => {
  const where = (demo as { where?: { type?: unknown; url?: unknown } | null } | null)?.where;
  return where?.type === 'url' && typeof where.url === 'string' ? where.url : null;
};

async function probe(url: string): Promise<DemoProbe> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer();
    return { url, status: res.status, error: null };
  } catch (error) {
    return { url, status: null, error: (error as Error).message };
  }
}

/** An arc of the product with its first plan in force (its first `plan-applied`), null before it has one. */
export type StartedArc = Readonly<{ arc: string; plan: PlanM1 | null }>;

/** The product's arcs that have a journal, in the order they started (each journal's first record), with their first plans. */
export function arcsStarted(l: Layout): readonly StartedArc[] {
  const arcs = runDirs(absPath(l.product)).filter((a) => existsSync(join(a.dir, 'events.jsonl'))).map((a) => {
    const events = readJournal(a.dir, arcId(a.arc)).events;
    const first = events.find((e) => e.type === 'fact' && e.fact.kind === 'plan-applied');
    if (first === undefined || first.type !== 'fact' || first.fact.kind !== 'plan-applied') return { arc: a.arc, at: events[0]?.at ?? '', plan: null };
    const bytes = keptInput(a.dir, first.fact.planSha256, PLAN_INPUT);
    if (bytes === null) throw new Error(`${a.arc}: its first plan-applied names ${first.fact.planSha256}.${PLAN_INPUT}, which its run dir does not keep`);
    return { arc: a.arc, at: events[0]!.at, plan: parsePlan(JSON.parse(bytes.toString('utf8'))) };
  });
  return arcs.sort((a, b) => a.at.localeCompare(b.at)).map(({ arc, plan }) => ({ arc, plan }));
}

/** The first plan in force of the first arc to have one (arcs in start order), or null before there is one. */
export function firstPlan(l: Layout): Readonly<{ arc: string; plan: PlanM1 }> | null {
  const a = arcsStarted(l).find((x) => x.plan !== null);
  return a === undefined ? null : { arc: a.arc, plan: a.plan! };
}

// ---------------------------------------------------------------------------------------------------
// The session

export type EndedBy = 'stopped' | 'timeout' | 'turn-timeout' | 'stalled' | 'session-failed' | 'fail-fast';

export type Report = Readonly<{
  schema: typeof REPORT_SCHEMA;
  profile: ProfileName;
  startedAt: string;
  endedAt: string;
  endedBy: EndedBy;
  stopReason: StopReason | null;
  failure: string | null;
  hostDir: string;
  launch: Readonly<{ envKeys: readonly string[]; gh: string; ghConfigDir: string; xdgConfigHome: string; gitConfigGlobal: string }>;
  transcriptHits: readonly string[];
  turns: readonly Turn[];
  owner: readonly OwnerExchange[];
  demo: Readonly<{ seen: readonly DemoSeen[]; final: DemoFinal | null }>;
  released: readonly Released[];
  leftovers: readonly string[];
  arcs: readonly ArcForensics[];
  postRun: readonly PostRun[];
}>;

export const initialPrompt = (profile: ProfileName): string => [
  'You are the root agent of a roadmap-orchestrator session over this product repository (`swapshelf`), run headless:',
  'nobody watches this session. Use the orchestrate skill of the roadmap-orchestrator plugin from start to finish:',
  'bootstrap, then Phase 0, arcs and chaining toward the target state the corpus in docs/corpus describes.',
  'The owner answers the numbered questions you end a turn with, and answers the brief\'s open questions any time with `roadmap answer`.',
  'While an arc runs, you may wait on `roadmap watch --actionable` under Monitor or end your turn; both are supported.',
  'If you end your turn, the harness resumes you on actionable `roadmap watch` events only.',
  'End the session with the skill\'s session-end line.',
  `Start every arc with \`--profile ${profile}\`; never change it.`,
].join('\n');

export async function drive(dir: string, profile: ProfileName): Promise<Report> {
  const l = layout(dir);
  if (!existsSync(l.product)) throw new Error(`${dir} holds no fixture: run evals/m5/setup.ts first`);
  if (existsSync(l.report) || existsSync(l.transcript)) throw new Error(`${l.report} or the transcript exists: a fixture dir is run once`);
  if (repositoryPaths().some((r) => resolve(dir).startsWith(`${r}/`))) throw new Error(`the fixture dir ${dir} is inside this repository: stage it outside`);
  const held = readClaim(HOST_DIR);
  if (held !== null) throw new Error(`the host is held by arc ${held.arc} of ${held.repo}: stop it before a run`);
  stagePlugin(l);
  const env = launchEnv(l, process.env);
  const startedAt = new Date();
  const deadline = startedAt.getTime() + SESSION_MS;
  const owner: OwnerExchange[] = [];
  const turns: Turn[] = [];
  const seen: DemoSeen[] = [];
  const watched: Watched = { arc: null, arcsSeen: [], filter: new ActionableFilter(Date.now(), HEARTBEAT_MIN) };
  const ownerCtx: OwnerCtx = { l, env };
  const memory: OwnerMemory = { answered: new Set(), asked: new Set(), spendApprovedAt: -1 };
  const observeDemo = async (): Promise<void> => {
    const s = await statusDemo(l, env);
    if (s !== null && JSON.stringify(s.demo) !== JSON.stringify(seen.at(-1)?.demo ?? null)) seen.push({ at: new Date().toISOString(), ...s });
  };
  let shapeChecked = false;
  let shapeFailure: string | null = null;
  const checkShape = (): void => {
    if (shapeChecked) return;
    const first = firstPlan(l);
    if (first === null) return;
    shapeChecked = true;
    const s = planShape(first.plan);
    if (s.kind === 'off') shapeFailure = `fail-fast: ${first.arc}'s first plan in force is off the M5 shape: ${s.problems.join('; ')}`;
  };

  let endedBy: EndedBy = 'timeout';
  let stopReason: StopReason | null = null;
  let failure: string | null = null;
  let session: string | null = null;
  let prompt = initialPrompt(profile);
  let kind: Turn['kind'] = 'start';
  let nudges = 0;
  let released: readonly Released[] = [];
  let leftovers: readonly string[] = [];
  let final: DemoFinal | null = null;
  const sessionEnd = new Map<string, number>();
  const product = absPath(l.product);
  try {
    for (let n = 1; Date.now() < deadline; n++) {
      const t0 = Date.now();
      const abort = new AbortController();
      let polling: Promise<void> = Promise.resolve();
      let pollFailure: unknown = null;
      let inFlight = false;
      const poller = setInterval(() => {
        if (inFlight || pollFailure !== null) return;
        inFlight = true;
        polling = answerFromBrief(ownerCtx, memory, owner, n).then(observeDemo).then(() => {
          checkShape();
          if (shapeFailure !== null) abort.abort();
        }).catch((error: unknown) => void (pollFailure = error)).finally(() => void (inFlight = false));
      }, ANSWER_POLL_MS);
      const r = await runTurn(l, REAL, env, n, session, prompt, deadline, abort.signal).finally(() => clearInterval(poller));
      await polling;
      turns.push({ n, kind, prompt, session: r.session, result: r.result, exit: r.exit, ms: Date.now() - t0 });
      if (pollFailure !== null) throw pollFailure;
      session = r.session;
      checkShape();
      if (shapeFailure !== null) {
        endedBy = 'fail-fast';
        failure = shapeFailure;
        break;
      }
      if (r.isolation !== null) {
        endedBy = 'session-failed';
        failure = r.isolation;
        break;
      }
      if (r.timedOut) {
        endedBy = 'turn-timeout';
        failure = `turn ${n} was killed at the session's ${SESSION_MS} ms deadline, ${Date.now() - t0} ms into the turn (turn-${n}.stderr)`;
        break;
      }
      if (r.exit !== 0 || r.result === null) {
        endedBy = 'session-failed';
        failure = `turn ${n} exited ${r.exit}${r.result === null ? ' without a result' : ''} (turn-${n}.stderr)`;
        break;
      }
      const stop = SESSION_END.exec(r.result);
      if (stop !== null) {
        const reason = STOP_REASONS.find((x) => x === stop[1]);
        if (reason === undefined) {
          endedBy = 'session-failed';
          failure = `the session ended with an unknown stop reason ${JSON.stringify(stop[1])}`;
        } else {
          endedBy = 'stopped';
          stopReason = reason;
        }
        break;
      }
      const reply = await ownerReply(ownerCtx, r.result, memory, owner);
      if (reply !== null) {
        prompt = reply;
        kind = 'owner';
        nudges = 0;
        continue;
      }
      const woke = await wake(l, REAL, env, watched, deadline, () => {});
      if (woke === '') break;
      if (woke === null) {
        if (++nudges > MAX_NUDGES) {
          endedBy = 'stalled';
          failure = `${MAX_NUDGES} turns in a row ended with no question, no session-end line and nothing to wake on`;
          break;
        }
        prompt = 'No arc of this product holds the host and you asked nothing. Continue per the skill, or end the session with its session-end line.';
        kind = 'nudge';
        continue;
      }
      nudges = 0;
      prompt = woke;
      kind = 'wake';
    }
  } catch (error) {
    endedBy = 'session-failed';
    failure = (error as Error).stack ?? String(error);
  } finally {
    const dirs = runDirs(product);
    for (const a of dirs) sessionEnd.set(a.arc, lastSeq(a.dir));
    snapshotDiagnostics(l, dirs);
    // The demo as the owner would find it now, before the driver stops anything.
    try {
      await observeDemo();
      const last = seen.at(-1);
      if (last !== undefined) {
        const where = demoUrl(last.demo);
        final = { arc: last.arc, demo: last.demo, probe: where !== null && /^https?:\/\//.test(where) ? await probe(where) : null };
      }
    } catch (error) {
      failure ??= `the end-of-run demo read failed: ${(error as Error).message}`;
    }
    released = await stopHeldArc(HOST_DIR, product, (arc) => {
      const [cmd, args] = roadmapArgv(l, REAL, ['stop', '--repo', l.product, '--arc', arc]);
      return spawnSync(cmd, [...args], { cwd: l.product, env, encoding: 'utf8', timeout: RELEASE_WAIT_MS }).status;
    }, RELEASE_WAIT_MS);
    const graceEnd = Date.now() + LEFTOVER_GRACE_MS;
    let left = fixtureProcesses(l.dir);
    while (left.length > 0 && Date.now() < graceEnd) {
      await sleep(250);
      left = fixtureProcesses(l.dir);
    }
    leftovers = left.map(showProc);
    await killProcs(left);
  }

  const journals = runDirs(product).filter((a) => existsSync(join(a.dir, 'events.jsonl'))).map((a) => ({ arc: a.arc, events: readJournal(a.dir, arcId(a.arc)).events as readonly Event[] }));
  const arcs = journals.map((j) => arcForensics(j.arc, j.events, sessionEnd.get(j.arc) ?? 0));
  exportCosts(l, journals.map((j, i) => ({ ...j, terminalSeq: arcs[i]!.terminalSeq })));
  const report: Report = {
    schema: REPORT_SCHEMA,
    profile,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    endedBy, stopReason, failure,
    hostDir: HOST_DIR,
    launch: { envKeys: Object.keys(env).sort(), gh: ghOnPath(l, env), ghConfigDir: env['GH_CONFIG_DIR']!, xdgConfigHome: env['XDG_CONFIG_HOME']!, gitConfigGlobal: env['GIT_CONFIG_GLOBAL']! },
    transcriptHits: scanTranscript(l.transcript, needles()),
    turns, owner,
    demo: { seen, final },
    released, leftovers, arcs,
    postRun: arcs.flatMap((a) => postRunOf(a) ?? []),
  };
  writeFileSync(l.report, json(report), { flag: 'wx' });
  return report;
}

if (import.meta.main) {
  const [dir, ...rest] = process.argv.slice(2);
  const usage = 'usage: node evals/m5/driver.ts <dir> [--profile default|claude-only]';
  if (dir === undefined || !(rest.length === 0 || (rest.length === 2 && rest[0] === '--profile'))) throw new Error(usage);
  const profile = rest[1] ?? 'claude-only';
  if (!(PROFILES as readonly string[]).includes(profile)) throw new Error(`${usage}: profile ${profile}`);
  const report = await drive(resolve(dir), profile as ProfileName);
  process.stdout.write(`${JSON.stringify({ report: layout(resolve(dir)).report, endedBy: report.endedBy, stopReason: report.stopReason, turns: report.turns.length, failure: report.failure })}\n`);
  process.exitCode = report.endedBy === 'stopped' ? 0 : 1;
}
