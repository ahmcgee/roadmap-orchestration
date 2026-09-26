// The targeted probe (`npm run probe`): the production argv builder, runner and adapter against the real,
// authenticated CLIs, through src/preflight/smoke.ts. Pennies per run. Checks:
//
//   smoke.<backend>     smoke() under the default profile, exactly as `roadmap start` runs it
//   codex.fresh/resume  gpt-5.6-sol, effort low, strict schema; the resume continues the fresh thread
//   shell.lane          a real shell command through the runner, graded on exit code and stdout
//   claude.judgment     claude-opus-5-5 judgment argv: --system-prompt, and --add-dir reading an evidence
//                       dir outside the cwd (the answer must carry a token only that dir holds)
//   claude.build.fresh/resume  claude-opus-5-5 implementer argv: writes a file (bypassPermissions), then
//                       the resumed session recalls it
//   fable.pin           claude-fable-5-1 resolves: one judgment call that returns {ok: true}
//   claude.build.killed-resume  claude-opus-5-5 implementer told to write a random token to a file then
//                       sleep; killed once the file exists through the production kill path (killWorkload,
//                       reason pause, as the executor's interruptLive runs it); the file is deleted and the
//                       launch-assigned session resumed with a CONTINUE_DIRECTIVE-style message: the answer
//                       must carry the token, which only the killed conversation holds
//   codex.killed-resume the same with gpt-5.6-sol, effort low: killed after thread.started and the file;
//                       the resume uses the thread id the adapter read into result.json
//
// Each check prints `PASS|FAIL <name> <detail>`; then one `USAGE <backend> <role> ...` line per pair.
// Exits non-zero on any FAIL. The run dir (journal, invocation dirs) is kept and printed for inspection.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshClaudeImplementerSession, freshJudgmentSession } from '../src/backends/argv.ts';
import { containmentFor, detectContainmentMode } from '../src/contain/detect.ts';
import { type ImplementerSessionId, arcId, invocationId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { openJournal } from '../src/core/log.ts';
import { type BackendResult, STDOUT_FILE, type Usage } from '../src/core/records.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import {
  type BackendInvocation, type InvocationContext, type Invoked, SMOKE_SCHEMA, backendEnv, invokeBackend, invokeCommand, smoke, smokeRejections,
} from '../src/preflight/smoke.ts';
import { invocationDir, killWorkload } from '../src/pipeline/invoke.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import type { Backend, Role } from '../src/routing/types.ts';
import { runnerFiles } from '../src/runner/files.ts';

const OPUS = { backend: 'claude', model: 'claude-opus-5-5', effort: 'default' } as const;
const FABLE = { backend: 'claude', model: 'claude-fable-5-1', effort: 'default' } as const;
const SOL = { backend: 'codex', model: 'gpt-5.6-sol', effort: 'low' } as const;
const SYSTEM = 'You are a probe of an unattended build orchestrator. Do exactly what the message asks, then answer in the structured format requested.';

const strict = (properties: Readonly<Record<string, JsonValue>>): JsonValue =>
  ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });

function dir(path: string): AbsPath {
  mkdirSync(path, { recursive: true });
  return absPath(path);
}

let failed = 0;
function report(pass: boolean, name: string, detail: string): void {
  if (!pass) failed += 1;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}\n`);
}

type Tokens = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
const usage = new Map<string, Tokens>();
function meter(backend: Backend, role: Role, spent: Usage): void {
  const key = `${backend} ${role}`;
  const t = usage.get(key) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  t.calls += 1;
  if (spent.kind === 'known') {
    const u = spent.tokens;
    t.input += u.inputTokens;
    t.output += u.outputTokens;
    t.cacheRead += u.cacheReadTokens ?? 0;
    t.cacheWrite += u.cacheWriteTokens ?? 0;
  }
  usage.set(key, t);
}

function describe(done: Invoked<BackendResult>): string {
  const o = done.result.outcome;
  const what = o.kind === 'success' ? JSON.stringify(o.value) : o.kind === 'refusal' ? o.stopReason : o.detail;
  const errors = done.result.backendErrors.map((e) => `${e.class}: ${e.message}`).join('; ');
  return `${done.inv} ${o.kind} ${what}${errors === '' ? '' : ` errors=[${errors}]`} usage=${done.result.usage.kind} dir=${done.invDir}`;
}

async function backend(ctx: InvocationContext, name: string, b: BackendInvocation, grade: (value: JsonValue) => boolean): Promise<Invoked<BackendResult>> {
  const done = await invokeBackend(ctx, b);
  meter(b.request.triple.backend, done.result.role, done.result.usage);
  const o = done.result.outcome;
  report(o.kind === 'success' && grade(o.value), name, describe(done));
  return done;
}

/** How long a killed-resume check waits for its workload to reach the kill point. */
const KILL_WAIT_MS = 150_000;

/**
 * Runs `b` and, once its runner is up and `ready(invDir)` holds, kills it with killWorkload{pause} exactly as
 * the executor's interruptLive does; then resumes the session the adapter recorded and grades the answer.
 * `after` runs between the kill and the resume.
 */
async function killedResume(
  ctx: InvocationContext, name: string, b: BackendInvocation, ready: (invDir: string) => boolean,
  resumeOf: (id: ImplementerSessionId) => BackendInvocation['request'], after: () => void, resume: Omit<BackendInvocation, 'request'>, grade: (value: JsonValue) => boolean,
): Promise<void> {
  const proc = { journal: ctx.journal, containment: containmentFor(detectContainmentMode()), runDir: ctx.runDir };
  let settled = false;
  const running = invokeBackend(ctx, b).finally(() => { settled = true; });
  const until = Date.now() + KILL_WAIT_MS;
  let waited = 'timeout';
  for (;;) {
    const intent = ctx.journal.view.openIntents().find((i) => i.kind === 'proc.spawn' && i.expect.subject.purpose === 'smoke' && i.expect.subject.check === b.check);
    if (settled) { waited = 'workload ended before the kill point'; break; }
    if (intent !== undefined) {
      const inv = invocationId(intent.op, intent.ordinal);
      const invDir = invocationDir(ctx.runDir, inv);
      const files = runnerFiles(invDir, inv);
      if (files.read('runner.json') !== null && files.read('exit.json') === null && (ready(invDir) || Date.now() >= until)) {
        if (Date.now() < until) waited = 'ready';
        await killWorkload(proc, { inv, scope: 'invocation', reason: 'pause' });
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const killed = await running;
  meter(b.request.triple.backend, killed.result.role, killed.result.usage);
  const session = killed.result.role === 'build' ? killed.result.session : null;
  const ok = waited === 'ready' && killed.exit.cause === 'cancel' && session !== null;
  report(ok, `${name}.kill`, `${waited} cause=${killed.exit.cause} session=${session} ${describe(killed)}`);
  if (!ok || session === null) return;
  after();
  await backend(ctx, name, { ...resume, request: resumeOf(session) }, grade);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'roadmap-probe-'));
  const runDir = dir(join(root, 'run'));
  const journal = openJournal(runDir, arcId('probe'));
  const ctx: InvocationContext = { journal, runDir, hostEnv: backendEnv(process.env) };
  const resolved = resolveRouting({ profile: 'default', repoConfig: null, plan: null, unit: null });
  const rev = resolved.rev;
  process.stdout.write(`probe run dir ${root}\n`);

  // smoke(), exactly as `roadmap start` calls it.
  const smoked = await smoke({ profile: 'default', resolved }, ctx);
  const rejections = smokeRejections(smoked);
  for (const b of smoked.backends) {
    if (b.ran) {
      meter(b.backend, b.seat.role, b.usage);
      const bad = rejections.find((r) => r.backend === b.backend);
      report(bad === undefined, `smoke.${b.backend}`, `${b.inv} seat=${b.seat.role}.${b.seat.tier} ${b.outcome.kind}${bad === undefined ? '' : ` ${bad.detail}`}`);
    } else {
      report(false, `smoke.${b.backend}`, `did not run: ${b.reason}`);
    }
  }

  // The calls below exercise triples directly, not seats; each meter fact names the default table's seat of
  // the same backend and role at the nearest tier (codex build: med; Opus build: high; Fable plan-check: high).
  // Codex fresh then resume, in one working dir (a resume runs where its thread was created).
  const codexDir = dir(join(root, 'codex'));
  const okSchema = SMOKE_SCHEMA;
  const isOk = (v: JsonValue): boolean => JSON.stringify(v) === '{"ok":true}';
  const fresh = await backend(ctx, 'codex.fresh', {
    check: 'codex-fresh', routingRev: rev, tier: 'med', system: SYSTEM, rendered: 'Reply with the JSON object {"ok": true}.', schema: okSchema, cwd: codexDir,
    request: { kind: 'codex-build', triple: SOL, session: { backend: 'codex', mode: 'fresh' } },
  }, isOk);
  const thread = fresh.result.role === 'build' ? fresh.result.session : null;
  if (thread === null) {
    report(false, 'codex.resume', 'no thread id from the fresh call');
  } else {
    const resumed = await backend(ctx, 'codex.resume', {
      check: 'codex-resume', routingRev: rev, tier: 'med', system: SYSTEM, rendered: 'Reply with the same JSON object again.', schema: okSchema, cwd: codexDir,
      request: { kind: 'codex-build', triple: SOL, session: { backend: 'codex', mode: 'resume', id: thread } },
    }, isOk);
    if (resumed.result.role === 'build' && resumed.result.session !== thread) report(false, 'codex.resume-session', `resumed ${thread}, got ${resumed.result.session}`);
  }

  // A real shell command through the runner: exit code and output are both graded.
  const shellDir = dir(join(root, 'shell'));
  const shell = await invokeCommand(ctx, { check: 'shell-lane', argv: ['sh', '-c', 'printf probe-output; exit 3'], cwd: shellDir, purpose: 'lane', expectedExit: 3 });
  const out = readFileSync(join(shell.invDir, 'stdout'), 'utf8');
  report(shell.result.verdict === 'pass' && out === 'probe-output', 'shell.lane', `${shell.inv} verdict=${shell.result.verdict} exit=${shell.result.exitCode} stdout=${JSON.stringify(out)}`);

  // Claude judgment: the token lives only in an evidence dir outside the cwd, so --add-dir must work.
  const judgeDir = dir(join(root, 'judge'));
  const evidence = dir(join(root, 'evidence'));
  const token = randomBytes(8).toString('hex');
  writeFileSync(join(evidence, 'token.txt'), `${token}\n`);
  await backend(ctx, 'claude.judgment', {
    check: 'claude-judgment', routingRev: rev, tier: 'med', system: SYSTEM, schema: strict({ token: { type: 'string' } }), cwd: judgeDir,
    rendered: `Read the file ${join(evidence, 'token.txt')} and reply with {"token": "<its content without the trailing newline>"}.`,
    request: { kind: 'claude-judgment', role: 'gate', triple: OPUS, session: freshJudgmentSession(), evidenceDirs: [evidence] },
  }, (v) => JSON.stringify(v) === JSON.stringify({ token }));

  // Claude implementer: a write in its cwd (bypassPermissions), then a resume that recalls it.
  const buildDir = dir(join(root, 'build'));
  const session = freshClaudeImplementerSession();
  const built = await backend(ctx, 'claude.build.fresh', {
    check: 'claude-build-fresh', routingRev: rev, tier: 'high', system: SYSTEM, schema: okSchema, cwd: buildDir,
    rendered: 'Create the file probe.txt in the current directory containing the word probe, then reply with {"ok": true}.',
    request: { kind: 'claude-build', triple: OPUS, session, evidenceDirs: [] },
  }, isOk);
  if (built.result.outcome.kind === 'success' && !existsSync(join(buildDir, 'probe.txt'))) report(false, 'claude.build.write', `no ${buildDir}/probe.txt`);
  await backend(ctx, 'claude.build.resume', {
    check: 'claude-build-resume', routingRev: rev, tier: 'high', system: SYSTEM, schema: strict({ file: { type: 'string' } }), cwd: buildDir,
    rendered: 'Which file did you create in your previous turn? Reply with {"file": "<its name>"}.',
    request: { kind: 'claude-build', triple: OPUS, session: { ...session, mode: 'resume' }, evidenceDirs: [] },
  }, (v) => JSON.stringify(v) === '{"file":"probe.txt"}');

  // Fable id pin: the id resolves and answers.
  await backend(ctx, 'fable.pin', {
    check: 'fable-pin', routingRev: rev, tier: 'high', system: SYSTEM, rendered: 'Reply with the JSON object {"ok": true}.', schema: okSchema, cwd: judgeDir,
    request: { kind: 'claude-judgment', role: 'planCheck', triple: FABLE, session: freshJudgmentSession(), evidenceDirs: [] },
  }, isOk);

  // Killed mid-run, then resumed: the token is in the killed conversation only (its file is deleted first).
  // The resume message is CONTINUE_DIRECTIVE's opening (rounds.ts); its evidence-dir sentence has no referent here.
  const killTask = (t: string): string =>
    `This task has three steps. 1. Create the file killed.txt in the current directory containing exactly ${t}. 2. Run the shell command \`sleep 90\` and wait for it to finish. 3. Reply with {"token": "<the token you wrote in step 1>"}.`;
  const CONTINUE = 'You were paused partway through this task and are now resumed. Continue from where you stopped; do not restart. The sleep of step 2 has already finished; do not run it again.';
  const tokenSchema = strict({ token: { type: 'string' } });

  const claudeKillDir = dir(join(root, 'claude-killed'));
  const claudeToken = randomBytes(8).toString('hex');
  const claudeKillFile = join(claudeKillDir, 'killed.txt');
  const claudeBase = { routingRev: rev, tier: 'high', system: SYSTEM, schema: tokenSchema, cwd: claudeKillDir } as const;
  await killedResume(ctx, 'claude.build.killed-resume', {
    ...claudeBase, check: 'claude-build-killed', rendered: killTask(claudeToken),
    request: { kind: 'claude-build', triple: OPUS, session: freshClaudeImplementerSession(), evidenceDirs: [] },
  }, () => existsSync(claudeKillFile), (id) => ({ kind: 'claude-build', triple: OPUS, session: { backend: 'claude', mode: 'resume', id }, evidenceDirs: [] }), () => rmSync(claudeKillFile),
  { ...claudeBase, check: 'claude-build-killed-resume', rendered: CONTINUE }, (v) => JSON.stringify(v) === JSON.stringify({ token: claudeToken }));

  const codexKillDir = dir(join(root, 'codex-killed'));
  const codexToken = randomBytes(8).toString('hex');
  const codexKillFile = join(codexKillDir, 'killed.txt');
  const codexBase = { routingRev: rev, tier: 'med', system: SYSTEM, schema: tokenSchema, cwd: codexKillDir } as const;
  await killedResume(ctx, 'codex.killed-resume', {
    ...codexBase, check: 'codex-killed', rendered: killTask(codexToken),
    request: { kind: 'codex-build', triple: SOL, session: { backend: 'codex', mode: 'fresh' } },
  }, (invDir) => existsSync(codexKillFile) && existsSync(join(invDir, STDOUT_FILE)) && readFileSync(join(invDir, STDOUT_FILE), 'utf8').includes('"thread.started"'),
  (id) => ({ kind: 'codex-build', triple: SOL, session: { backend: 'codex', mode: 'resume', id } }), () => rmSync(codexKillFile),
  { ...codexBase, check: 'codex-killed-resume', rendered: CONTINUE }, (v) => JSON.stringify(v) === JSON.stringify({ token: codexToken }));

  journal.close();
  for (const [key, t] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`USAGE ${key} calls=${t.calls} input=${t.input} output=${t.output} cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite}\n`);
  }
  process.stdout.write(`${failed === 0 ? 'probe passed' : `probe FAILED: ${failed} check(s)`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
