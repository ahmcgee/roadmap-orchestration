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
//
// Each check prints `PASS|FAIL <name> <detail>`; then one `USAGE <backend> <role> ...` line per pair.
// Exits non-zero on any FAIL. The run dir (journal, invocation dirs) is kept and printed for inspection.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshClaudeImplementerSession, freshJudgmentSession } from '../src/backends/argv.ts';
import { arcId } from '../src/core/ids.ts';
import type { JsonValue } from '../src/core/json.ts';
import { openJournal } from '../src/core/log.ts';
import type { BackendResult, Usage } from '../src/core/records.ts';
import { type AbsPath, absPath } from '../src/core/values.ts';
import {
  type BackendInvocation, type InvocationContext, type Invoked, SMOKE_SCHEMA, backendEnv, invokeBackend, invokeCommand, smoke, smokeRejections,
} from '../src/preflight/smoke.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import type { Backend, Role } from '../src/routing/types.ts';

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

  // Codex fresh then resume, in one working dir (a resume runs where its thread was created).
  const codexDir = dir(join(root, 'codex'));
  const okSchema = SMOKE_SCHEMA;
  const isOk = (v: JsonValue): boolean => JSON.stringify(v) === '{"ok":true}';
  const fresh = await backend(ctx, 'codex.fresh', {
    check: 'codex-fresh', routingRev: rev, system: SYSTEM, rendered: 'Reply with the JSON object {"ok": true}.', schema: okSchema, cwd: codexDir,
    request: { kind: 'codex-build', triple: SOL, session: { backend: 'codex', mode: 'fresh' } },
  }, isOk);
  const thread = fresh.result.role === 'build' ? fresh.result.session : null;
  if (thread === null) {
    report(false, 'codex.resume', 'no thread id from the fresh call');
  } else {
    const resumed = await backend(ctx, 'codex.resume', {
      check: 'codex-resume', routingRev: rev, system: SYSTEM, rendered: 'Reply with the same JSON object again.', schema: okSchema, cwd: codexDir,
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
    check: 'claude-judgment', routingRev: rev, system: SYSTEM, schema: strict({ token: { type: 'string' } }), cwd: judgeDir,
    rendered: `Read the file ${join(evidence, 'token.txt')} and reply with {"token": "<its content without the trailing newline>"}.`,
    request: { kind: 'claude-judgment', role: 'gate', triple: OPUS, session: freshJudgmentSession(), evidenceDirs: [evidence] },
  }, (v) => JSON.stringify(v) === JSON.stringify({ token }));

  // Claude implementer: a write in its cwd (bypassPermissions), then a resume that recalls it.
  const buildDir = dir(join(root, 'build'));
  const session = freshClaudeImplementerSession();
  const built = await backend(ctx, 'claude.build.fresh', {
    check: 'claude-build-fresh', routingRev: rev, system: SYSTEM, schema: okSchema, cwd: buildDir,
    rendered: 'Create the file probe.txt in the current directory containing the word probe, then reply with {"ok": true}.',
    request: { kind: 'claude-build', triple: OPUS, session, evidenceDirs: [] },
  }, isOk);
  if (built.result.outcome.kind === 'success' && !existsSync(join(buildDir, 'probe.txt'))) report(false, 'claude.build.write', `no ${buildDir}/probe.txt`);
  await backend(ctx, 'claude.build.resume', {
    check: 'claude-build-resume', routingRev: rev, system: SYSTEM, schema: strict({ file: { type: 'string' } }), cwd: buildDir,
    rendered: 'Which file did you create in your previous turn? Reply with {"file": "<its name>"}.',
    request: { kind: 'claude-build', triple: OPUS, session: { ...session, mode: 'resume' }, evidenceDirs: [] },
  }, (v) => JSON.stringify(v) === '{"file":"probe.txt"}');

  // Fable id pin: the id resolves and answers.
  await backend(ctx, 'fable.pin', {
    check: 'fable-pin', routingRev: rev, system: SYSTEM, rendered: 'Reply with the JSON object {"ok": true}.', schema: okSchema, cwd: judgeDir,
    request: { kind: 'claude-judgment', role: 'planCheck', triple: FABLE, session: freshJudgmentSession(), evidenceDirs: [] },
  }, isOk);

  journal.close();
  for (const [key, t] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
    process.stdout.write(`USAGE ${key} calls=${t.calls} input=${t.input} output=${t.output} cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite}\n`);
  }
  process.stdout.write(`${failed === 0 ? 'probe passed' : `probe FAILED: ${failed} check(s)`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
