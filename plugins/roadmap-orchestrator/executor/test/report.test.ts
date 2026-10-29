// The build's final report ends the invocation (src/runner/report.ts): the real runner over the fake CLIs. A build
// that reports `final: true` and leaves something pending (the CLI lingering for a wake-up, a descendant outliving it)
// is ended REPORT_GRACE_MS later with cause `reported` and its report read as the answer; an interim `final: false`
// answer never starts that clock, however long the wait after it.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapt, writeResult } from '../src/backends/adapter.ts';
import { statOf } from '../src/contain/proc.ts';
import { canonicalJson } from '../src/core/json.ts';
import { implementerSessionId } from '../src/core/ids.ts';
import type { BackendResult, ExitFile, LaunchTerminal } from '../src/core/records.ts';
import { SchemaError } from '../src/core/validate.ts';
import { absPath } from '../src/core/values.ts';
import { buildOutput, BUILD_SCHEMA } from '../src/prompts/schemas.ts';
import { awaitRunner, prepareLaunch, startRunner } from '../src/runner/launch.ts';
import { REPORT_GRACE_MS } from '../src/runner/report.ts';
import { launchBase, newInvocation } from './helpers/invocation.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Act, ROUTING_REV, fixtureInvocation, writeScenario } from './helpers/scenario.ts';

/** Every fake keeps its process (or a descendant) alive this long after its final report: far past the grace. */
const LINGER_MS = 120_000;
/** The interim wait: longer than the grace, so a clock an interim answer started would fire inside it. */
const INTERIM_WAIT_MS = REPORT_GRACE_MS + 5_000;
const T = { timeout: REPORT_GRACE_MS + 60_000 };

const report = (summary: string, final: boolean) => ({ summary, changedPaths: [], blockers: [], experiments: [], docsOnlySince: null, final });

type Run = Readonly<{ exit: ExitFile; result: BackendResult; wallMs: number }>;

/** One build invocation of the fake `as` CLI performing `acts`, through the real runner, adapted once the runner exits. */
async function build(as: 'claude' | 'codex', acts: readonly Act[]): Promise<Run> {
  const scenario = writeScenario(tmpDir('report-scenario'), [{ as, expect: {}, acts } as never]);
  const inv = newInvocation();
  const schemaPath = absPath(join(inv.root, 'schema.json'));
  writeFileSync(schemaPath, `${canonicalJson(BUILD_SCHEMA)}\n`);
  const session = randomUUID();
  const outputPath = absPath(join(inv.invDir, as === 'claude' ? 'stdout' : 'last.json'));
  const base = { type: 'backend', purpose: 'backend', routingRev: ROUTING_REV, schemaPath, outputPath, role: 'build' } as const;
  const terminal: LaunchTerminal = as === 'claude'
    ? { ...base, session: { backend: 'claude', mode: 'fresh', id: implementerSessionId(session) } }
    : { ...base, session: { backend: 'codex', mode: 'fresh' } };
  const argv = as === 'claude' ? ['claude', '-p', '--session-id', session] : ['codex', 'exec', '--json', '-o', outputPath, '-'];
  const launch = prepareLaunch({ ...launchBase(inv, { argv, deadlineMs: 5 * 60_000 }), env: { PATH: `${scenario.binDir}:${process.env['PATH']}` }, terminal });
  const started = Date.now();
  const handle = startRunner(inv.invDir, launch);
  const end = await awaitRunner(handle);
  const wallMs = Date.now() - started;
  assert.equal(end.kind, 'exited', JSON.stringify(end));
  assert.equal(readFileSync(join(inv.invDir, 'runner.log'), 'utf8'), '', 'the runner logged an error');
  const result = writeResult(inv.invDir);
  assert.equal(result.type, 'backend');
  return { exit: (end as Extract<typeof end, { kind: 'exited' }>).exit, result: result as BackendResult, wallMs };
}

function assertReported(run: Run, summary: string): void {
  assert.equal(run.exit.cause, 'reported');
  assert.deepEqual(run.result.outcome, { kind: 'success', value: report(summary, true) });
  assert.ok(run.wallMs >= REPORT_GRACE_MS, `ended ${run.wallMs} ms after the start, before the grace`);
  assert.ok(run.wallMs < REPORT_GRACE_MS + 20_000, `ended ${run.wallMs} ms after the start, not within the grace`);
}

describe('report: the final report ends the build', { concurrency: true }, () => {
  it('report.claude-lingers: a final result, then the CLI stays alive (a pending wake-up) → ended after the grace, cause reported', T, async () => {
    const run = await build('claude', [{ type: 'emit', value: report('done', true) }, { type: 'hang', ms: LINGER_MS }]);
    assertReported(run, 'done');
    assert.deepEqual(run.exit.child, { type: 'signalled', signal: 'SIGTERM' });
  });

  it('report.claude-descendant: a final result, the CLI exits, a descendant lives on → killed after the grace, cause reported', T, async () => {
    const pidFile = join(tmpDir('report-pid'), 'pid');
    const run = await build('claude', [
      { type: 'emit', value: report('done', true) },
      { type: 'forkSetsid', lifeMs: LINGER_MS, env: 'keepEnv', pidFile },
    ]);
    assertReported(run, 'done');
    assert.deepEqual(run.exit.child, { type: 'exited', code: 0 });
    // The descendant would have lived LINGER_MS; the runner's kill ended it.
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const stat = statOf(pid);
    assert.ok(stat === null || stat.state === 'Z', `descendant ${pid} is still running`);
  });

  it('report.codex-lingers: the -o file holds the final report, the process stays alive → ended after the grace, cause reported', T, async () => {
    const run = await build('codex', [{ type: 'emit', value: report('done', true) }, { type: 'hang', ms: LINGER_MS }]);
    assertReported(run, 'done');
  });

  it('report.interim-not-cut: an interim final:false answer, a wait longer than the grace, then the final report → runs to its own exit', T, async () => {
    const run = await build('claude', [
      { type: 'emit', value: report('waiting for the cluster', false) },
      { type: 'hang', ms: INTERIM_WAIT_MS },
      { type: 'emit', value: report('done after the wait', true) },
    ]);
    assert.equal(run.exit.cause, 'exited');
    assert.deepEqual(run.exit.child, { type: 'exited', code: 0 });
    assert.ok(run.wallMs >= INTERIM_WAIT_MS, `ended ${run.wallMs} ms after the start, inside the interim wait`);
    // The latest result is the answer: the final one, not the interim.
    assert.deepEqual(run.result.outcome, { kind: 'success', value: report('done after the wait', true) });
  });
});

describe('report: reading a reported build', () => {
  it('report.adapter: cause reported decides by the output, not the kill (success when schema-valid, else malformed)', () => {
    const killed = { type: 'signalled', signal: 'SIGTERM' } as const;
    const ok = adapt(fixtureInvocation('claude-judgment', killed, 'reported'));
    assert.equal(ok.type === 'backend' ? ok.outcome.kind : null, 'success');
    const failed = adapt(fixtureInvocation('claude-api-error', killed, 'reported'));
    assert.equal(failed.type === 'backend' ? failed.outcome.kind : null, 'malformed');
  });

  it('report.build-reader: an answer that is not final is not a report; one an earlier executor recorded reads as final', () => {
    assert.equal(buildOutput(report('s', true), 'build').final, true);
    assert.throws(() => buildOutput(report('s', false), 'build'), SchemaError);
    const { final: _, ...earlier } = report('s', true);
    assert.equal(buildOutput(earlier, 'build').final, true);
    const schema = BUILD_SCHEMA as { required: string[]; properties: Record<string, { type: string }> };
    assert.equal(schema.properties['final']?.type, 'boolean');
    assert.ok(schema.required.includes('final'));
  });
});
