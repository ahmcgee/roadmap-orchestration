// The M4a paid fixture, step 2: `node evals/m4a/driver.ts <dir> [--fake story|vision-silent]` plays the harness and
// the owner around one headless root-agent session over a fixture laid out by setup.ts, and writes `<dir>/report.json`
// for check.ts.
//
// The session (plan "Driver"). Real: `claude -p --model claude-opus-5-5 --effort high --plugin-dir <staged plugin>
// --permission-mode bypassPermissions --strict-mcp-config --settings {"autoMemoryEnabled":false} --output-format
// stream-json --verbose` (bypass kept: the skill needs Bash; LR-f), resumed by `--resume <session>` turn after turn;
// hard timeout 360 min. Paid M4a run 1: without the last two the session saw the owner's claude.ai connectors and wrote
// an auto-memory note into the owner's Claude project dir for the fixture cwd; a turn whose init event still names an
// MCP server or a memory path is killed and fails the session (`isolation`). The turn cap equals the session cap (paid
// run 9 died to a 120-minute turn cap in the middle of in-turn supervision); a turn killed at its cap ends the run
// `turn-timeout`, never `session-failed`. Fake: the scripted root agent (fake-root.ts, one process per turn, the same
// stream-json) against the fake backends; hard timeout 30 min. After each turn:
//   - a final text with the skill's session-end line `ROADMAP-SESSION: stopped <reason>` ends the session (reason in
//     the skill's closed set: k-limit, vision-silent, owner);
//   - a final text ending in numbered questions goes to the owner simulator, its last numbered block only (paid M4a
//     run 1: a status list and a brief's numbered lines earlier in the text were answered as questions): code answers K (= 1), the first slice
//     (accepted), the issue policy (the owner restores PUBLIC + COLLABORATORS_ONLY, then says so) and a brief ack (the
//     owner has read none: never acknowledged); every other question goes to a frontier-medium `claude -p` (fake: a
//     keyword stub) given only the answer key's owner answers released so far (`from: arc-1-complete` once the first
//     arc's completion is in its ref), told to answer from them alone, else "no view: keep your working assumption";
//   - any other final text is the skill's headless wait (no Monitor): the driver tails `roadmap watch` on the arc it
//     last saw holding the host and resumes the session only on an actionable event (F26; the executor's one rule,
//     src/watch.ts `ActionableFilter`, which `roadmap watch --actionable` applies too, one instance kept across the
//     run's watch processes): a new needs-user item, the run reaching complete, refused or no-owner, a constraint change
//     (the run newly held, blocked or draining) or no state change for STALL_MIN minutes; routine transitions are
//     absorbed. Debounced 3 s.
//     With nothing to wait on (no arc seen, or the last one ended and was reported) and nothing asked, it nudges the
//     session, at most 3 times in a row (`stalled`).
//   - at the end, whatever the end (a `finally`), an arc of this product still holding the host is stopped with the
//     staged `roadmap stop` and the claim awaited (`released`; criterion `host-released`).
//
// Isolation (LR-f, L1, K6, H1). The driver stages the plugin (this repository's plugins/roadmap-orchestrator without
// executor/evals, executor/test, node_modules) into the fixture and launches every session with an allowlisted env
// (no GH_TOKEN, GITHUB_TOKEN, SSH_AUTH_SOCK or cloud credentials), GH_CONFIG_DIR and XDG_CONFIG_HOME empty dirs and
// GIT_CONFIG_GLOBAL the fixture's identity-only gitconfig (GIT_CONFIG_NOSYSTEM), HOME kept (Claude's auth lives
// there), the fake gh first on PATH, cwd the scratch product repo. It records the env's keys and `command -v gh`.
// Real runs only: before and after, from its own env, a canary of this repository's real forge through the real `gh`
// (refs by `git ls-remote`, issues, PRs, comments, labels, releases) must be unchanged (canary.json). The transcript
// (transcript.jsonl, every turn's events) is scanned for the answer key, `evals/m4a` and this repository's path in
// every tool input and result. After the session the driver overwrites the live corpus and `.roadmap/` files in the
// product's working tree (uncommitted), so check.ts's `phase0 check --from-ref` proves it reads the refs alone (K20).
//
// Forensics (F29, F30). The report names each arc's terminal seq (its latest `arc-completed`, else the seq when the
// session ended) and counts the events written after it (`postRun`: the executor winding down, the driver's own stop);
// `diagnostics/` keeps the session-end copy of each arc's needs-user files and the turn stderr tails; `costs.jsonl`
// holds one row per invocation and per turn with the unknowns explicit (transcript.ts).
//
// Fake runs add two devices (story only): once the second arc holds the host, the forge flips to PUBLIC + ALL and arc
// 2's pack review is released from its barrier (scenario.ts), so a checkpoint capture meets an untrusted policy.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { arcsWithRefs, completedHeadOf, readArcRef } from '../../src/chain.ts';
import { HOST_DIR } from '../../src/host/hostdir.ts';
import { readClaim } from '../../src/host/lock.ts';
import { type Event } from '../../src/core/events.ts';
import { arcId } from '../../src/core/ids.ts';
import { readJournal } from '../../src/core/log.ts';
import { ActionableFilter, stallLine } from '../../src/watch.ts';
import { absPath, type AbsPath } from '../../src/core/values.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { runDir } from '../../src/input/cli.ts';
import { PROFILES, type ProfileName } from '../../src/routing/types.ts';
import { readStore, writeStore } from '../../test/fakes/gh-store.ts';
import { writeShims } from '../../test/fakes/shim.ts';
import { type FakeScript, arcShims, fakeHostDir, fakeScript } from './fake-root.ts';
import { CORPUS_ROOT } from './golden.ts';
import { type Layout, SESSION_END, STOP_REASONS, type StopReason, layout } from './layout.ts';
import { POLICY_FLIP_BARRIER, arcSteps } from './scenario.ts';
import { json } from './setup.ts';
import { ANSWER_KEY, exportCosts, needles, repositoryPaths, scanTranscript } from './transcript.ts';

export const REPORT_SCHEMA = 'roadmap/m4a-report';
const PLUGIN_SOURCE = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE_ROOT = fileURLToPath(new URL('./fake-root.ts', import.meta.url));
const STAGE_CLI = fileURLToPath(new URL('./stage-cli.ts', import.meta.url));

/** The turn cap is the session cap: a turn may use all the session's time (A1). */
export type Limits = Readonly<{ sessionMs: number; turnMs: number }>;
export const LIMITS: Readonly<{ real: Limits; fake: Limits }> = {
  real: { sessionMs: 360 * 60_000, turnMs: 360 * 60_000 },
  fake: { sessionMs: 30 * 60_000, turnMs: 30 * 60_000 },
};
const WAKE_DEBOUNCE_MS = 3_000;
/** How long the end-of-run stop waits for the host claim to clear. */
const RELEASE_WAIT_MS = 5 * 60_000;
const MAX_NUDGES = 3;

// ---------------------------------------------------------------------------------------------------
// Staging and the launch env

/** Paths the staged plugin leaves out (relative to the plugin root). */
export const UNSTAGED = ['executor/evals', 'executor/test', 'executor/node_modules', 'executor/.tsbuildinfo'] as const;

export function stagePlugin(l: Layout): void {
  if (existsSync(l.plugin)) throw new Error(`${l.plugin} exists: the plugin is staged once per fixture`);
  cpSync(PLUGIN_SOURCE, l.plugin, {
    recursive: true,
    filter: (src) => {
      const rel = relative(PLUGIN_SOURCE, src);
      return !UNSTAGED.some((u) => rel === u || rel.startsWith(`${u}/`)) && !rel.split('/').includes('.git');
    },
  });
}

/** Env keys a session may see: the shell's basics and the model CLIs' own credentials. Everything else is dropped. */
const ALLOWED = [/^PATH$/, /^HOME$/, /^USER$/, /^LOGNAME$/, /^SHELL$/, /^LANG$/, /^LC_[A-Z_]+$/, /^TERM$/, /^TMPDIR$/, /^TZ$/, /^ANTHROPIC_[A-Z_]+$/, /^CLAUDE_[A-Z_]+$/, /^CODEX_[A-Z_]+$/, /^OPENAI_API_KEY$/];
/** Keys check.ts requires absent (a denylist over the allowlist's result: the forge, SSH and cloud credentials). */
export const DENIED = [/^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^GH_ENTERPRISE_TOKEN$/, /^GITHUB_ENTERPRISE_TOKEN$/, /^SSH_AUTH_SOCK$/, /^AWS_/, /^GOOGLE_/, /^GCLOUD_/, /^CLOUDSDK_/, /^AZURE_/, /^ARM_/, /^DIGITALOCEAN_/];

/** The session's env (and the fake root's): allowlisted, config dirs emptied, the fake gh first on PATH. */
export function launchEnv(l: Layout, base: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && ALLOWED.some((r) => r.test(k)) && k !== 'PATH') env[k] = v;
  env['PATH'] = [l.forgeBin, ...(base['PATH'] ?? '').split(':').filter((d) => d !== '' && d !== l.forgeBin)].join(':');
  env['GH_CONFIG_DIR'] = l.ghConfig;
  env['XDG_CONFIG_HOME'] = l.xdgConfig;
  env['GIT_CONFIG_GLOBAL'] = l.gitConfig;
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  return env;
}

/** `command -v gh` under `env`, from the session's cwd. */
export function ghOnPath(l: Layout, env: Readonly<Record<string, string>>): string {
  return spawnSync('sh', ['-c', 'command -v gh'], { cwd: l.product, env, encoding: 'utf8' }).stdout.trim();
}

// ---------------------------------------------------------------------------------------------------
// The real-forge canary (real runs; the driver's own env and the real gh)

export type Canary = Readonly<Record<string, unknown>>;

function ghLines(repoRoot: string, path: string, project: (v: Record<string, unknown>) => unknown): readonly unknown[] {
  const r = spawnSync('gh', ['api', '--paginate', path, '--jq', '.[]'], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`gh api ${path} exited ${r.status}: ${r.stderr}`);
  return r.stdout.split('\n').filter((x) => x !== '').map((x) => project(JSON.parse(x) as Record<string, unknown>));
}

/** This repository's forge state: refs, issues and PR entries, PRs, comments, labels, releases (projected, sorted). */
export function forgeCanary(): Canary {
  const root = repositoryPaths()[0]!;
  const nwo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (nwo.status !== 0) throw new Error(`gh repo view exited ${nwo.status}: ${nwo.stderr}`);
  const repo = nwo.stdout.trim();
  const refs = spawnSync('git', ['-C', root, 'ls-remote', 'origin'], { encoding: 'utf8', timeout: 120_000 });
  if (refs.status !== 0) throw new Error(`git ls-remote origin exited ${refs.status}: ${refs.stderr}`);
  const pick = (...keys: string[]) => (v: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, v[k] ?? null]));
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => (x as { name: string }).name).sort() : null);
  const sorted = (xs: readonly unknown[]) => [...xs].map((x) => JSON.stringify(x)).sort();
  return {
    repo,
    refs: refs.stdout.split('\n').filter((x) => x !== '').sort(),
    issues: sorted(ghLines(root, `repos/${repo}/issues?state=all&per_page=100`, (v) => ({ ...pick('number', 'title', 'state', 'updated_at', 'comments')(v), labels: names(v['labels']) }))),
    pulls: sorted(ghLines(root, `repos/${repo}/pulls?state=all&per_page=100`, (v) => ({ ...pick('number', 'title', 'state', 'updated_at')(v), head: (v['head'] as { ref?: string } | undefined)?.ref ?? null, base: (v['base'] as { ref?: string } | undefined)?.ref ?? null }))),
    issueComments: sorted(ghLines(root, `repos/${repo}/issues/comments?per_page=100`, pick('id', 'updated_at'))),
    reviewComments: sorted(ghLines(root, `repos/${repo}/pulls/comments?per_page=100`, pick('id', 'updated_at'))),
    labels: sorted(ghLines(root, `repos/${repo}/labels?per_page=100`, pick('name', 'color', 'description'))),
    releases: sorted(ghLines(root, `repos/${repo}/releases?per_page=100`, pick('id', 'tag_name', 'name', 'draft'))),
  };
}

// ---------------------------------------------------------------------------------------------------
// The owner

type OwnerAnswer = Readonly<{ topic: string; from: 'bootstrap' | 'arc-1-complete'; answer: string; match: readonly string[] }>;
const ownerAnswers = (): readonly OwnerAnswer[] => (JSON.parse(readFileSync(ANSWER_KEY, 'utf8')) as { ownerAnswers: readonly OwnerAnswer[] }).ownerAnswers;

/**
 * The numbered questions a final text ends with: its last numbered block (a `1.` or `1)` line starts a block), each
 * `N.` or `N)` line and the lines after it, until the next; a heading or a code fence ends an item.
 */
export function numberedQuestions(text: string): readonly string[] {
  let out: string[] = [];
  let open = false;
  for (const line of text.split('\n')) {
    const item = /^\s*(\d+)[.)]\s+\S/.exec(line);
    if (item !== null) {
      if (item[1] === '1') out = [];
      out.push(line.trim());
      open = true;
    } else if (/^\s*(#|```)/.test(line)) open = false;
    else if (open && line.trim() !== '' && !SESSION_END.test(line)) out[out.length - 1] = `${out.at(-1)!} ${line.trim()}`;
  }
  return out;
}

export type OwnerExchange = Readonly<{ question: string; answer: string; by: 'code' | 'simulator' }>;

/** Whether the first arc of the product's chain has its completion in its ref (the owner's later answers are released). */
function firstArcComplete(product: AbsPath): boolean {
  return arcsWithRefs(product).some((arc) => {
    const ref = readArcRef(product, arc);
    return ref !== null && ref.plan.chain === undefined && completedHeadOf(ref) !== null;
  });
}

export type OwnerCtx = Readonly<{ l: Layout; env: Readonly<Record<string, string>>; fake: boolean; devices: Devices }>;

const TRUSTED = { visibility: 'PUBLIC', hasIssuesEnabled: true, issueCreationPolicy: 'COLLABORATORS_ONLY' } as const;

/** The answers code gives (plan "Driver"), or null for the simulator. */
export function codeAnswer(c: OwnerCtx, q: string): string | null {
  // A request to ack a brief ("acknowledge brief <id>", "ack the brief"), never the K question's "acknowledged brief".
  if (/\b(acknowledge|ack)\b[^.?]*\bbrief\b/i.test(q)) return 'I have not read the brief yet; do not acknowledge it.';
  // Case-sensitive K (paid run 2: `k-limit` in a brief-ack question matched /\bK\b/i).
  if (/\bK\b(?!-)/.test(q) || /how many arcs/i.test(q)) return 'K = 1.';
  if (/issue (creation|policy)|PUBLIC \+ ALL|anyone (can )?open issues/i.test(q)) {
    const store = readStore(c.l.store);
    if (store.policy.issueCreationPolicy !== TRUSTED.issueCreationPolicy || store.policy.visibility !== TRUSTED.visibility) {
      writeStore(c.l.store, { ...store, policy: { ...TRUSTED } });
      c.devices.policyFix = { at: new Date().toISOString() };
    }
    return 'Done: issue creation is restricted to collaborators again.';
  }
  if (/\b(first|next|this) slice\b/i.test(q) && /\b(accept|agree|approve|ok)\b/i.test(q)) return 'Yes, I accept that slice.';
  return null;
}

const NO_VIEW = 'No view: keep your working assumption.';

/** Every real `claude -p` the driver launches: no MCP server (not the owner's claude.ai connectors), no auto-memory. */
const CLAUDE_ISOLATION = ['--strict-mcp-config', '--settings', JSON.stringify({ autoMemoryEnabled: false })] as const;

async function simulatorAnswer(c: OwnerCtx, q: string): Promise<string> {
  const released = ownerAnswers().filter((a) => a.from === 'bootstrap' || firstArcComplete(absPath(c.l.product)));
  if (c.fake) return released.find((a) => a.match.some((m) => q.toLowerCase().includes(m)))?.answer ?? NO_VIEW;
  const prompt = [
    'You are the owner of a small harbour\'s berth booking product. A root agent working on it asked you the question below.',
    'Answer ONLY from your recorded answers. If none of them answers the question, reply exactly:',
    NO_VIEW,
    'Reply with the answer text only, one or two sentences.',
    '',
    'Your recorded answers:',
    ...released.map((a) => `- On ${a.topic}: ${a.answer}`),
    '',
    `The question: ${q}`,
  ].join('\n');
  const dir = join(c.l.dir, 'owner');
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('claude', ['-p', '--model', 'claude-opus-5-5', '--effort', 'medium', '--tools', '', ...CLAUDE_ISOLATION, '--output-format', 'json', prompt], { cwd: dir, env: c.env, encoding: 'utf8', timeout: 10 * 60_000 });
  if (r.status !== 0) throw new Error(`the owner simulator exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { result?: unknown; is_error?: unknown };
  if (typeof out.result !== 'string' || out.is_error === true) throw new Error(`the owner simulator answered ${r.stdout}`);
  return out.result.trim();
}

async function ownerTurn(c: OwnerCtx, questions: readonly string[], log: OwnerExchange[]): Promise<string> {
  const lines: string[] = [];
  for (const [i, q] of questions.entries()) {
    const code = codeAnswer(c, q);
    const answer = code ?? (await simulatorAnswer(c, q));
    log.push({ question: q, answer, by: code === null ? 'simulator' : 'code' });
    lines.push(`${/^\s*(\d+)/.exec(q)?.[1] ?? i + 1}. ${answer}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------
// The session

export type Turn = Readonly<{ n: number; kind: 'start' | 'owner' | 'wake' | 'nudge'; prompt: string; session: string | null; result: string | null; exit: number | null; ms: number }>;

export type Devices = {
  policyFlip: { at: string; arc: string } | null;
  policyFix: { at: string } | null;
};

/** `timeout`: the session cap passed between turns; `turn-timeout`: a turn was killed at its cap (never `session-failed`). */
export type EndedBy = 'stopped' | 'timeout' | 'turn-timeout' | 'stalled' | 'session-failed';

/** An arc of this product that held the host when the session ended: stopped by the driver, and whether the claim cleared. */
export type Released = Readonly<{ arc: string; stopped: boolean; detail: string }>;
/** One arc's forensics: the seq of its terminal state, and the events written after it. */
export type ArcForensics = Readonly<{ arc: string; terminalSeq: number; lastSeq: number }>;
export type PostRun = Readonly<{ arc: string; fromSeq: number; events: number }>;

export type Report = Readonly<{
  schema: typeof REPORT_SCHEMA;
  mode: 'real' | 'fake';
  script: FakeScript | null;
  /** The routing profile every arc was told to start under (`criterion profile`). */
  profile: ProfileName;
  startedAt: string;
  endedAt: string;
  endedBy: EndedBy;
  stopReason: StopReason | null;
  failure: string | null;
  hostDir: string;
  launch: Readonly<{ envKeys: readonly string[]; gh: string; ghConfigDir: string; xdgConfigHome: string; gitConfigGlobal: string }>;
  /** Real runs: whether the real forge's canary is unchanged (canary.json); null in a fake run (no real forge read). */
  canary: Readonly<{ equal: boolean }> | null;
  transcriptHits: readonly string[];
  turns: readonly Turn[];
  owner: readonly OwnerExchange[];
  devices: Devices;
  scrambled: readonly string[];
  /** Arcs still holding the host when the session ended, stopped by the driver (empty: none did). */
  released: readonly Released[];
  arcs: readonly ArcForensics[];
  postRun: readonly PostRun[];
}>;

type Mode = Readonly<{ kind: 'real' }> | Readonly<{ kind: 'fake'; script: FakeScript }>;

export const initialPrompt = (profile: ProfileName): string => [
  'You are the root agent of a roadmap-orchestrator session over this product repository (`tidewater`), run headless:',
  'nobody watches this session. Use the orchestrate skill of the roadmap-orchestrator plugin from start to finish:',
  'bootstrap, then Phase 0, arcs and chaining toward the target state the corpus in docs/corpus describes.',
  'The owner answers only the numbered questions you end a turn with. While an arc runs, you may wait on `roadmap watch --actionable`',
  'under Monitor or end your turn; both are supported. If you end your turn, the harness resumes you on actionable',
  '`roadmap watch` events only (a needs-user item, a terminal state, a changed constraint, a stall).',
  'End the session with the skill\'s session-end line.',
  `Start every arc with \`--profile ${profile}\`; never change it.`,
].join('\n');

/**
 * One turn: launch or resume, stream events into the transcript, return the final text and session id, or the
 * isolation breach its init event shows (an MCP server or a memory path), on which the turn is killed.
 */
async function runTurn(l: Layout, mode: Mode, env: Readonly<Record<string, string>>, n: number, session: string | null, prompt: string, deadline: number): Promise<{ session: string | null; result: string | null; exit: number | null; isolation: string | null; timedOut: boolean }> {
  const argv = mode.kind === 'real'
    ? ['claude', ['-p', '--model', 'claude-opus-5-5', '--effort', 'high', '--plugin-dir', l.plugin, '--permission-mode', 'bypassPermissions', ...CLAUDE_ISOLATION, '--output-format', 'stream-json', '--verbose', ...(session === null ? [] : ['--resume', session]), prompt]] as const
    : [process.execPath, [FAKE_ROOT, '--fixture', l.dir, '--script', mode.script, ...(session === null ? [] : ['--resume', session]), '--', prompt]] as const;
  const child: ChildProcess = spawn(argv[0], [...argv[1]], { cwd: l.product, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffered = '';
  let stderr = '';
  let sid = session;
  let result: string | null = null;
  let isolation: string | null = null;
  const writes: Promise<void>[] = [];
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffered += chunk;
    for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      if (line.trim() === '') continue;
      let event: { type?: unknown; subtype?: unknown; session_id?: unknown; result?: unknown; mcp_servers?: unknown; memory_paths?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        event = { type: 'unparsed', result: line } as typeof event;
      }
      if (typeof event.session_id === 'string') sid = event.session_id;
      if (event.type === 'result' && typeof event.result === 'string') result = event.result;
      if (event.type === 'system' && event.subtype === 'init' && isolation === null) {
        const mcp = Array.isArray(event.mcp_servers) ? event.mcp_servers.length : 0;
        if (mcp > 0 || event.memory_paths !== undefined) {
          isolation = `turn ${n}'s session is not isolated: mcp_servers ${JSON.stringify(event.mcp_servers)}, memory_paths ${JSON.stringify(event.memory_paths)}`;
          child.kill('SIGTERM');
        }
      }
      writes.push(appendFile(l.transcript, `${JSON.stringify({ turn: n, event })}\n`));
    }
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => void (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, Math.max(0, deadline - Date.now()));
  const exit = await new Promise<number | null>((done) => child.on('close', (code) => done(code)));
  clearTimeout(timer);
  await Promise.all(writes);
  if (exit !== 0) writeFileSync(join(l.dir, `turn-${n}.stderr`), stderr);
  return { session: sid, result, exit, isolation, timedOut };
}

/** The roadmap CLI as the session runs it (real: the staged bin with HOST_DIR; fake: stage-cli with the fixture's host). */
function roadmapArgv(l: Layout, mode: Mode, args: readonly string[]): readonly [string, readonly string[]] {
  return mode.kind === 'real'
    ? [process.execPath, [join(l.plugin, 'executor', 'bin', 'roadmap'), ...args]]
    : [process.execPath, [STAGE_CLI, l.plugin, fakeHostDir(l.dir), ...args]];
}

type Watched = { arc: string | null; arcsSeen: string[]; filter: ActionableFilter };

/**
 * Waits for the next wake-up of the arc last seen holding the host (src/watch.ts `ActionableFilter`, kept across the run's watch processes). Returns the lines; '' at the
 * deadline; null when there is nothing to wait on (no arc seen, or the last one no longer holds the host and its end was
 * already reported).
 */
async function wake(l: Layout, mode: Mode, env: Readonly<Record<string, string>>, w: Watched, deadline: number, onArc: (arc: string) => void): Promise<string | null> {
  const hostDir = mode.kind === 'real' ? HOST_DIR : absPath(fakeHostDir(l.dir));
  const claim = readClaim(hostDir);
  if (claim !== null && claim.repo === absPath(l.product)) {
    w.arc = claim.arc;
    if (!w.arcsSeen.includes(claim.arc)) w.arcsSeen.push(claim.arc);
  }
  if (w.arc === null) return null;
  const held = claim !== null && claim.arc === w.arc;
  if (!held && w.filter.ended(w.arc)) return null;
  const arc = w.arc;
  onArc(arc);
  const [cmd, args] = roadmapArgv(l, mode, ['watch', '--repo', l.product, '--arc', arc]);
  const child = spawn(cmd, [...args], { cwd: l.product, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let buffered = '';
  let firstAt: number | null = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let i = buffered.indexOf('\n'); i >= 0; i = buffered.indexOf('\n')) {
      const line = buffered.slice(0, i);
      buffered = buffered.slice(i + 1);
      // Item ids are arc-scoped (paid run 2: arc 2's nu-31 was taken for arc 1's and never woke the session).
      const woken = w.filter.feed(arc, line, Date.now());
      if (woken !== null) {
        lines.push(woken);
        firstAt ??= Date.now();
      }
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => void (stderr += c));
  let exited = false;
  child.on('close', () => void (exited = true));
  while (!exited && Date.now() < deadline && (firstAt === null || Date.now() - firstAt < WAKE_DEBOUNCE_MS)) {
    if (firstAt === null && w.filter.stalled(Date.now())) {
      lines.push(stallLine());
      firstAt = Date.now();
    }
    await sleep(250);
  }
  child.kill('SIGTERM');
  if (exited && lines.length === 0) throw new Error(`roadmap watch exited: ${stderr}`);
  if (lines.length > 0) w.filter.woke(Date.now());
  return lines.length === 0 ? '' : `roadmap watch (arc ${w.arc}):\n${lines.join('\n')}`;
}

/** Overwrites the live corpus and `.roadmap/` inputs in the product's working tree (K20); returns the paths. */
function scramble(l: Layout): readonly string[] {
  const corpus = join(l.product, CORPUS_ROOT);
  const paths = [
    ...(existsSync(corpus) ? readdirSync(corpus, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : []),
    ...['corpus.md', 'vision.json', 'config.json'].map((f) => join(l.product, '.roadmap', f)),
  ];
  // Back up the live bytes first: a scrambled path need not be tracked at HEAD (run 12: `.roadmap/config.json` lived only on
  // the arc branch), so `git checkout` cannot restore it. An absent path is recorded and removed again on restore.
  const backup = join(l.dir, 'diagnostics', 'scramble-backup');
  for (const p of paths) {
    const rel = relative(l.product, p);
    const kept = join(backup, rel);
    mkdirSync(dirname(kept), { recursive: true });
    if (existsSync(p)) writeFileSync(kept, readFileSync(p));
    else writeFileSync(`${kept}.absent`, '');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'Scrambled by the M4a driver after the session: phase0 check --from-ref must not read this.\n');
  }
  return paths.map((p) => relative(l.product, p)).sort();
}

/** Fake runs: the per-arc backend scenarios and shims. */
export function prepareFake(l: Layout): void {
  for (const n of [1, 2] as const) {
    const dir = join(l.fake, `arc-${n}`);
    mkdirSync(dir, { recursive: true });
    const scenario = join(dir, 'scenario.json');
    writeFileSync(scenario, json({ steps: arcSteps(n, 'default') }), { flag: 'wx' });
    writeShims(arcShims(l.dir, n), scenario);
  }
  mkdirSync(fakeHostDir(l.dir), { recursive: true });
}

// ---------------------------------------------------------------------------------------------------
// The end of the run: release the host, then the forensics

/**
 * Stops the arc of `product` that holds the host, if any, and waits for the claim to clear (A2). `stop` runs the staged
 * `roadmap stop` and returns its exit status. A claim of another repo is never touched.
 */
export async function stopHeldArc(hostDir: AbsPath, product: AbsPath, stop: (arc: string) => number | null, waitMs: number): Promise<readonly Released[]> {
  const claim = readClaim(hostDir);
  if (claim === null || claim.repo !== product) return [];
  const status = stop(claim.arc);
  const t0 = Date.now();
  for (;;) {
    const now = readClaim(hostDir);
    if (now === null || now.nonce !== claim.nonce) {
      return [{ arc: claim.arc, stopped: status === 0, detail: `roadmap stop exited ${status}; the claim cleared after ${Date.now() - t0} ms` }];
    }
    if (Date.now() - t0 >= waitMs) return [{ arc: claim.arc, stopped: false, detail: `roadmap stop exited ${status}; the claim was still held after ${waitMs} ms` }];
    await sleep(250);
  }
}

/** The part of an event the forensics read. */
export type SeqEvent = Readonly<{ seq: number; type: string; fact?: Readonly<{ kind: string }> }>;

/** The arc's terminal seq: its latest `arc-completed` up to the session's end, else the seq the session ended at. */
export function arcForensics(arc: string, events: readonly SeqEvent[], sessionEndSeq: number): ArcForensics {
  const completed = events.filter((e) => e.type === 'fact' && e.fact?.kind === 'arc-completed' && e.seq <= sessionEndSeq).at(-1);
  return { arc, terminalSeq: completed?.seq ?? sessionEndSeq, lastSeq: events.at(-1)?.seq ?? 0 };
}

/** The events written after an arc's terminal state (F29): null when there are none. */
export const postRunOf = (a: ArcForensics): PostRun | null => (a.lastSeq > a.terminalSeq ? { arc: a.arc, fromSeq: a.terminalSeq + 1, events: a.lastSeq - a.terminalSeq } : null);

/** The product's arcs that have a run dir (the executor's runtime dir under the git common dir). */
function runDirs(product: AbsPath): readonly Readonly<{ arc: string; dir: AbsPath }>[] {
  const common = gitCommonDir(product);
  const root = join(common, 'roadmap-runtime');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ arc: e.name, dir: runDir(common, arcId(e.name)) })).sort((a, b) => a.arc.localeCompare(b.arc));
}

/** The last complete line's seq of an arc's `events.jsonl` (the log may be mid-append; a torn tail is not a line). */
function lastSeq(dir: AbsPath): number {
  const file = join(dir, 'events.jsonl');
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, 'utf8');
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((x) => x !== '');
  return lines.length === 0 ? 0 : (JSON.parse(lines.at(-1)!) as { seq: number }).seq;
}

/** Copies what the report cites into `<dir>/diagnostics/`: each arc's needs-user files and the turn stderr tails. */
function snapshotDiagnostics(l: Layout, arcs: readonly Readonly<{ arc: string; dir: AbsPath }>[]): void {
  mkdirSync(l.diagnostics, { recursive: true });
  for (const a of arcs) {
    const nu = join(a.dir, 'needs-user');
    if (existsSync(nu)) cpSync(nu, join(l.diagnostics, a.arc, 'needs-user'), { recursive: true });
  }
  for (const f of readdirSync(l.dir).filter((x) => /^turn-\d+\.stderr$/.test(x))) {
    writeFileSync(join(l.diagnostics, `${f}.tail`), readFileSync(join(l.dir, f), 'utf8').split('\n').slice(-200).join('\n'));
  }
}

export type DriveOptions = Readonly<{ profile?: ProfileName; limits?: Limits }>;

export async function drive(dir: string, mode: Mode, options: DriveOptions = {}): Promise<Report> {
  const profile = options.profile ?? 'default';
  const l = layout(dir);
  if (!existsSync(l.product)) throw new Error(`${dir} holds no fixture: run evals/m4a/setup.ts first`);
  if (existsSync(l.report) || existsSync(l.transcript)) throw new Error(`${l.report} or the transcript exists: a fixture dir is run once`);
  if (repositoryPaths().some((r) => resolve(dir).startsWith(`${r}/`))) throw new Error(`the fixture dir ${dir} is inside this repository: stage it outside`);
  if (mode.kind === 'real') {
    // Paid run 3: a previous run's arc still held the host, so the session could never start one.
    const held = readClaim(HOST_DIR);
    if (held !== null) throw new Error(`the host is held by arc ${held.arc} of ${held.repo}: stop it (roadmap stop --repo ... --arc ...) before a run`);
  }
  stagePlugin(l);
  if (mode.kind === 'fake') prepareFake(l);
  const env = launchEnv(l, process.env);
  const startedAt = new Date();
  const limits = options.limits ?? (mode.kind === 'real' ? LIMITS.real : LIMITS.fake);
  const deadline = startedAt.getTime() + limits.sessionMs;
  const before = mode.kind === 'real' ? forgeCanary() : null;

  const devices: Devices = { policyFlip: null, policyFix: null };
  const owner: OwnerExchange[] = [];
  const turns: Turn[] = [];
  const watched: Watched = { arc: null, arcsSeen: [], filter: new ActionableFilter(Date.now()) };
  const ownerCtx: OwnerCtx = { l, env, fake: mode.kind === 'fake', devices };
  const onArc = (arc: string): void => {
    if (mode.kind !== 'fake' || mode.script !== 'story' || devices.policyFlip !== null || watched.arcsSeen.indexOf(arc) !== 1) return;
    const store = readStore(l.store);
    writeStore(l.store, { ...store, policy: { visibility: 'PUBLIC', hasIssuesEnabled: true, issueCreationPolicy: 'ALL' } });
    writeFileSync(join(l.fake, 'arc-2', `${POLICY_FLIP_BARRIER}.release`), '', { flag: 'wx' });
    devices.policyFlip = { at: new Date().toISOString(), arc };
  };

  let endedBy: EndedBy = 'timeout';
  let stopReason: StopReason | null = null;
  let failure: string | null = null;
  let session: string | null = null;
  let prompt = initialPrompt(profile);
  let kind: Turn['kind'] = 'start';
  let nudges = 0;
  let released: readonly Released[] = [];
  const sessionEnd = new Map<string, number>();
  const product = absPath(l.product);
  try {
    for (let n = 1; Date.now() < deadline; n++) {
      const t0 = Date.now();
      const r = await runTurn(l, mode, env, n, session, prompt, Math.min(deadline, t0 + limits.turnMs));
      turns.push({ n, kind, prompt, session: r.session, result: r.result, exit: r.exit, ms: Date.now() - t0 });
      session = r.session;
      if (r.isolation !== null) {
        endedBy = 'session-failed';
        failure = r.isolation;
        break;
      }
      if (r.timedOut) {
        endedBy = 'turn-timeout';
        failure = `turn ${n} was killed at its ${limits.turnMs} ms cap (turn-${n}.stderr)`;
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
      const questions = numberedQuestions(r.result);
      if (questions.length > 0) {
        prompt = await ownerTurn(ownerCtx, questions, owner);
        kind = 'owner';
        nudges = 0;
        continue;
      }
      const woke = await wake(l, mode, env, watched, deadline, onArc);
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
    // The session is over, however it ended: keep its end state, then release the host (A2) so the next run can start.
    const dirs = runDirs(product);
    for (const a of dirs) sessionEnd.set(a.arc, lastSeq(a.dir));
    snapshotDiagnostics(l, dirs);
    released = await stopHeldArc(mode.kind === 'real' ? HOST_DIR : absPath(fakeHostDir(l.dir)), product, (arc) => {
      const [cmd, args] = roadmapArgv(l, mode, ['stop', '--repo', l.product, '--arc', arc]);
      return spawnSync(cmd, [...args], { cwd: l.product, env, encoding: 'utf8', timeout: RELEASE_WAIT_MS }).status;
    }, RELEASE_WAIT_MS);
  }

  let canary: Report['canary'] = null;
  if (before !== null) {
    const after = forgeCanary();
    writeFileSync(l.canary, json({ before, after }));
    canary = { equal: JSON.stringify(before) === JSON.stringify(after) };
  }
  const journals = runDirs(product).filter((a) => existsSync(join(a.dir, 'events.jsonl'))).map((a) => ({ arc: a.arc, events: readJournal(a.dir, arcId(a.arc)).events as readonly Event[] }));
  const arcs = journals.map((j) => arcForensics(j.arc, j.events, sessionEnd.get(j.arc) ?? 0));
  exportCosts(l, journals.map((j, i) => ({ ...j, terminalSeq: arcs[i]!.terminalSeq })));
  const report: Report = {
    schema: REPORT_SCHEMA,
    mode: mode.kind,
    script: mode.kind === 'fake' ? mode.script : null,
    profile,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    endedBy, stopReason, failure,
    hostDir: mode.kind === 'real' ? HOST_DIR : fakeHostDir(dir),
    launch: { envKeys: Object.keys(env).sort(), gh: ghOnPath(l, env), ghConfigDir: env['GH_CONFIG_DIR']!, xdgConfigHome: env['XDG_CONFIG_HOME']!, gitConfigGlobal: env['GIT_CONFIG_GLOBAL']! },
    canary,
    transcriptHits: scanTranscript(l.transcript, needles()),
    turns, owner, devices,
    scrambled: scramble(l),
    released, arcs,
    postRun: arcs.flatMap((a) => postRunOf(a) ?? []),
  };
  writeFileSync(l.report, json(report), { flag: 'wx' });
  return report;
}


if (import.meta.main) {
  const [dir, ...rest] = process.argv.slice(2);
  const usage = 'usage: node evals/m4a/driver.ts <dir> [--profile default|claude-only] [--fake story|vision-silent]';
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--profile', '--fake'].includes(rest[i]!) || rest[i + 1] === undefined || flags.has(rest[i]!)) throw new Error(usage);
    flags.set(rest[i]!, rest[i + 1]!);
  }
  if (dir === undefined) throw new Error(usage);
  const profile = flags.get('--profile') ?? 'default';
  if (!(PROFILES as readonly string[]).includes(profile)) throw new Error(`${usage}: profile ${profile}`);
  const fake = flags.get('--fake');
  const mode: Mode = fake === undefined ? { kind: 'real' } : { kind: 'fake', script: fakeScript(fake) };
  const report = await drive(resolve(dir), mode, { profile: profile as ProfileName });
  process.stdout.write(`${JSON.stringify({ report: layout(resolve(dir)).report, endedBy: report.endedBy, stopReason: report.stopReason, turns: report.turns.length, failure: report.failure })}\n`);
  process.exitCode = report.endedBy === 'stopped' ? 0 : 1;
}
