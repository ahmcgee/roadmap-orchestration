import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { absPath } from '../src/core/values.ts';
import { CliError, parseCommand, parseStartArgs, runDir } from '../src/input/cli.ts';

const HOST = { type: 'host' } as const;
const EXPLICIT = ['--repo', '/r', '--arc', 'arc-1'];
const EXPLICIT_RUN = { type: 'explicit', repo: '/r', arc: 'arc-1' };

describe('cli', () => {
  it('--version', () => {
    assert.deepEqual(parseCommand(['--version']), { command: 'version' });
  });

  it('start with and without --profile', () => {
    assert.deepEqual(parseCommand(['start', '--repo', '.', '--plan', 'plan.json']), { command: 'start', args: { repo: '.', plan: 'plan.json', profile: 'default' } });
    assert.deepEqual(parseStartArgs(['--plan', 'p.json', '--profile', 'claude-only', '--repo', '/r']), { repo: '/r', plan: 'p.json', profile: 'claude-only' });
  });

  it('start refuses a missing or unknown argument', () => {
    assert.throws(() => parseStartArgs(['--plan', 'p.json']), /--repo <path> is required/);
    assert.throws(() => parseStartArgs(['--repo', '.']), /--plan <plan.json> is required/);
    assert.throws(() => parseStartArgs(['--repo', '.', '--plan', 'p', '--profile', 'codex-only']), /profile/);
    assert.throws(() => parseStartArgs(['--repo', '.', '--plan', 'p', '--force']), /unknown option --force/);
    assert.throws(() => parseStartArgs(['--repo', '.', '--repo', '..', '--plan', 'p']), /given twice/);
    assert.throws(() => parseStartArgs(['--repo', '--plan', 'p']), /--repo needs a value/);
  });

  for (const command of ['status', 'watch', 'stop'] as const) {
    it(`${command} locates the run by host claim or by --repo/--arc`, () => {
      assert.deepEqual(parseCommand([command]), { command, run: HOST });
      assert.deepEqual(parseCommand([command, ...EXPLICIT]), { command, run: EXPLICIT_RUN });
      assert.throws(() => parseCommand([command, '--repo', '/r']), /--repo and --arc go together/);
      assert.throws(() => parseCommand([command, 'extra']), /unexpected argument/);
    });
  }

  it('pause <unit> | --all', () => {
    assert.deepEqual(parseCommand(['pause', 'u1']), { command: 'pause', target: { type: 'unit', unit: 'u1' }, run: HOST });
    assert.deepEqual(parseCommand(['pause', '--all', ...EXPLICIT]), { command: 'pause', target: { type: 'all' }, run: EXPLICIT_RUN });
    assert.throws(() => parseCommand(['pause']), /exactly one of <unit> or --all/);
    assert.throws(() => parseCommand(['pause', 'u1', '--all']), /exactly one of <unit> or --all/);
    assert.throws(() => parseCommand(['pause', 'U1']), CliError);
  });

  it('ack <id> [--choice]', () => {
    assert.deepEqual(parseCommand(['ack', 'nu-3']), { command: 'ack', id: 'nu-3', choice: null, run: HOST });
    assert.deepEqual(parseCommand(['ack', 'sup-2-1', '--choice', 'isolated']), { command: 'ack', id: 'sup-2-1', choice: 'isolated', run: HOST });
    assert.throws(() => parseCommand(['ack']), /<needs-user-id> is required/);
    assert.throws(() => parseCommand(['ack', 'q-3']), /NeedsUserId/);
  });

  it('resume [<unit> | --backend]', () => {
    assert.deepEqual(parseCommand(['resume']), { command: 'resume', target: { type: 'all' }, run: HOST });
    assert.deepEqual(parseCommand(['resume', 'u1']), { command: 'resume', target: { type: 'unit', unit: 'u1' }, run: HOST });
    assert.deepEqual(parseCommand(['resume', '--backend', 'codex']), { command: 'resume', target: { type: 'backend', backend: 'codex' }, run: HOST });
    assert.throws(() => parseCommand(['resume', 'u1', '--backend', 'claude']), /at most one/);
    assert.throws(() => parseCommand(['resume', '--backend', 'gemini']), /backend/);
  });

  it('sweep [--resource]', () => {
    assert.deepEqual(parseCommand(['sweep']), { command: 'sweep', resource: null, run: HOST });
    assert.deepEqual(parseCommand(['sweep', '--resource', 'db', ...EXPLICIT]), { command: 'sweep', resource: 'db', run: EXPLICIT_RUN });
  });

  it('unknown commands are rejected', () => {
    for (const argv of [[], ['version'], ['run'], ['gc'], ['--help'], ['--version', 'x']]) {
      assert.throws(() => parseCommand(argv), CliError, JSON.stringify(argv));
    }
  });

  it('run dir is <git common dir>/roadmap-runtime/<arc>', () => {
    assert.equal(runDir(absPath('/work/repo/.git'), arcId('arc-1')), '/work/repo/.git/roadmap-runtime/arc-1');
    assert.equal(runDir(absPath('/work/main/.git'), arcId('arc-2')), '/work/main/.git/roadmap-runtime/arc-2');
  });
});
