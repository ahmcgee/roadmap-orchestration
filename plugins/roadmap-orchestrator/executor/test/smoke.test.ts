// The backend smoke through fake CLIs behind PATH shims, with the real journal, runner and adapter.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type Event, parseEventLine } from '../src/core/events.ts';
import { arcId } from '../src/core/ids.ts';
import { EVENTS_FILE, openJournal } from '../src/core/log.ts';
import { absPath } from '../src/core/values.ts';
import { type SmokeReport, type SmokeRouting, backendEnv, smoke, smokeRejections } from '../src/preflight/smoke.ts';
import { resolveRouting } from '../src/routing/layers.ts';
import { MODEL_IDS, type ProfileName, type ClassBindings } from '../src/routing/types.ts';
import { tmpDir } from './helpers/repo.ts';
import { type Step, readCalls, writeScenario } from './helpers/scenario.ts';

const T = { timeout: 60_000 };
const OK = { ok: true } as const;

function routing(profile: ProfileName, classes: ClassBindings | null = null): SmokeRouting {
  return { profile, resolved: resolveRouting({ profile, classes, repoConfig: null, plan: null, unit: null }) };
}

type Run = Readonly<{ report: SmokeReport; runDir: string; events: readonly Event[] }>;

/** Smoke `profile` with `binDir` as the workload's whole PATH, then read back the run's event log. */
async function runSmoke(r: SmokeRouting, binDir: string): Promise<Run> {
  const runDir = absPath(tmpDir('smoke'));
  const journal = openJournal(runDir, arcId(`s-${randomBytes(6).toString('hex')}`));
  const home = process.env['HOME'];
  assert.ok(home !== undefined, 'tests need HOME');
  const report = await smoke(r, { journal, runDir, hostEnv: { PATH: binDir, HOME: home } });
  journal.close();
  const events = readFileSync(join(runDir, EVENTS_FILE), 'utf8').split('\n').filter((l) => l !== '').map(parseEventLine);
  return { report, runDir, events };
}

function smokeIntents(events: readonly Event[]): readonly Event[] {
  return events.filter((e) => e.type === 'intent' && e.kind === 'proc.spawn' && 'subject' in e.expect && e.expect.subject.purpose === 'smoke');
}

const claudeStep = (acts: Extract<Step, { as: 'claude' }>['acts']): Step => ({
  as: 'claude',
  expect: { argv: ['-p', '--json-schema', '--system-prompt'], argvLacks: ['--resume'], stdinContains: ['{"ok": true}'] },
  acts,
});

describe('smoke', () => {
  it('passes when both fakes answer, journaling each call as a smoke spawn with its meter fact', T, async () => {
    const s = writeScenario(tmpDir('scenario'), [
      claudeStep([{ type: 'emit', value: OK }]),
      // Codex has no system channel: the smoke's system text leads its stdin.
      { as: 'codex', expect: { argv: ['exec', '--output-schema', '-'], stdinContains: ['health check', '{"ok": true}'] }, acts: [{ type: 'emit', value: OK }] },
    ]);
    const { report, events } = await runSmoke(routing('default'), s.binDir);
    assert.deepEqual(report.backends.map((b) => [b.backend, b.ran, b.ran ? b.outcome.kind : b.reason]), [['claude', true, 'success'], ['codex', true, 'success']]);
    assert.deepEqual(smokeRejections(report), []);
    assert.deepEqual(readCalls(s.path).map((c) => [c.as, c.step]), [['claude', 0], ['codex', 1]]);

    const intents = smokeIntents(events);
    assert.equal(intents.length, 2);
    const targets = intents.map((e) => (e.type === 'intent' && 'subject' in e.expect && e.expect.subject.purpose === 'smoke' ? e.expect.subject.target : null));
    assert.deepEqual(targets.map((t) => t !== null && t.type === 'backend' ? [t.backend, t.role] : null), [['claude', 'planCheck'], ['codex', 'build']]);
    const done = events.filter((e) => e.type === 'done' && e.kind === 'proc.spawn');
    assert.deepEqual(done.map((e) => e.type === 'done' && e.outcome.kind === 'result' ? e.outcome.summary : null), [
      { type: 'backend', outcome: 'success' }, { type: 'backend', outcome: 'success' },
    ]);
    const meters = events.filter((e) => e.type === 'fact' && e.fact.kind === 'meter');
    assert.equal(meters.length, 2);
  });

  it('the report names no model except inside recorded argv, and neither do the rejections nor the event log', T, async () => {
    const s = writeScenario(tmpDir('scenario'), [
      claudeStep([{ type: 'emit', value: OK }]),
      { as: 'codex', expect: {}, acts: [{ type: 'exit', code: 1 }] },
    ]);
    const { report, runDir } = await runSmoke(routing('default'), s.binDir);
    const withoutArgv = JSON.stringify(report, (key, value: unknown) => (key === 'argv' ? undefined : value));
    const rejections = JSON.stringify(smokeRejections(report));
    const log = readFileSync(join(runDir, EVENTS_FILE), 'utf8');
    for (const model of MODEL_IDS) {
      assert.equal(withoutArgv.includes(model), false, `report names ${model}`);
      assert.equal(rejections.includes(model), false, `rejections name ${model}`);
      assert.equal(log.includes(model), false, `event log names ${model}`);
    }
    // The argv is the one place it may appear, and it does: the smoke ran the routed model.
    const argvModels = report.backends.flatMap((b) => (b.ran ? [b.argv[b.argv.indexOf(b.backend === 'claude' ? '--model' : '-m') + 1]] : []));
    assert.deepEqual(argvModels, ['claude-opus-5-5', 'gpt-5.6-luna']);
  });

  it('claude-only never invokes the codex shim', T, async () => {
    const s = writeScenario(tmpDir('scenario'), [claudeStep([{ type: 'emit', value: OK }])]);
    const { report, events } = await runSmoke(routing('claude-only'), s.binDir);
    assert.deepEqual(report.backends.find((b) => b.backend === 'codex'), { backend: 'codex', ran: false, reason: 'profile-excludes', seats: [] });
    assert.deepEqual(smokeRejections(report), []);
    assert.deepEqual(readCalls(s.path).map((c) => c.as), ['claude']);
    assert.equal(smokeIntents(events).length, 1);
  });

  it('claude-only with a class rebound to Codex is a missing Codex smoke', T, async () => {
    const s = writeScenario(tmpDir('scenario'), [claudeStep([{ type: 'emit', value: OK }])]);
    const classes: ClassBindings = { efficient: { backend: 'codex', model: 'gpt-5.6-luna', effort: 'medium' } };
    const { report } = await runSmoke(routing('claude-only', classes), s.binDir);
    assert.deepEqual(readCalls(s.path).map((c) => c.as), ['claude']);
    const [rejection, ...rest] = smokeRejections(report);
    assert.deepEqual(rest, []);
    assert.equal(rejection?.backend, 'codex');
    assert.equal(rejection?.problem, 'missing');
    assert.match(rejection?.detail ?? '', /build\.low/);
  });

  it('a fake that exits non-zero is backend-smoke{problem: failed}', T, async () => {
    const s = writeScenario(tmpDir('scenario'), [claudeStep([{ type: 'exit', code: 1 }])]);
    const { report, events } = await runSmoke(routing('claude-only'), s.binDir);
    const rejections = smokeRejections(report);
    assert.equal(rejections.length, 1);
    assert.deepEqual({ ...rejections[0], detail: undefined }, { kind: 'backend-smoke', profile: 'claude-only', backend: 'claude', problem: 'failed', detail: undefined });
    assert.match(rejections[0]?.detail ?? '', /process-fault: exit 1/);
    // A failed smoke still leaves its audit trail: the intent, its done record, and the usage-unavailable fact.
    assert.equal(smokeIntents(events).length, 1);
    assert.equal(events.filter((e) => e.type === 'fact' && e.fact.kind === 'usage-unavailable').length, 1);
  });

  it('a missing binary is backend-smoke{problem: missing}', T, async () => {
    const empty = tmpDir('empty-bin');
    mkdirSync(empty, { recursive: true });
    const { report, events } = await runSmoke(routing('claude-only'), empty);
    const claude = report.backends.find((b) => b.backend === 'claude');
    assert.equal(claude?.ran, false);
    assert.equal(claude !== undefined && !claude.ran ? claude.reason : null, 'missing');
    const rejections = smokeRejections(report);
    assert.deepEqual(rejections.map((r) => [r.backend, r.problem]), [['claude', 'missing']]);
    assert.match(rejections[0]?.detail ?? '', /ENOENT/);
    assert.equal(smokeIntents(events).length, 1);
  });

  it('backendEnv passes PATH, HOME and the CLIs\' config dirs, turns auto-memory off, nothing else, and requires PATH and HOME', () => {
    const host = { PATH: '/bin', HOME: '/home/u', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/k', CLAUDE_CODE_SESSION_ID: 'x', OTHER: 'y', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' };
    const off = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    assert.deepEqual(backendEnv(host), { PATH: '/bin', HOME: '/home/u', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/k', ...off });
    assert.deepEqual(backendEnv({ PATH: '/bin', HOME: '/home/u' }), { PATH: '/bin', HOME: '/home/u', ...off });
    assert.throws(() => backendEnv({ PATH: '/bin' }), /HOME/);
  });
});
