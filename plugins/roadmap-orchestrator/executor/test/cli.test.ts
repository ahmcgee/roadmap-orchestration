import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { arcId } from '../src/core/ids.ts';
import { commandFile } from '../src/core/records.ts';
import { absPath } from '../src/core/values.ts';
import { CliError, parseCommand, parseStartArgs, runDir } from '../src/input/cli.ts';
import { runUntilExit } from './helpers/proc.ts';
import { makeRepo, tmpDir } from './helpers/repo.ts';

const HOST = { type: 'host' } as const;
const EXPLICIT = ['--repo', '/r', '--arc', 'arc-1'];
const EXPLICIT_RUN = { type: 'explicit', repo: '/r', arc: 'arc-1' };

describe('cli', () => {
  it('--version', () => {
    assert.deepEqual(parseCommand(['--version']), { command: 'version' });
  });

  it('start with and without --profile', () => {
    assert.deepEqual(parseCommand(['start', '--repo', '.', '--plan', 'plan.json']), { command: 'start', args: { repo: '.', plan: 'plan.json', profile: null } });
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

const BIN = fileURLToPath(new URL('../bin/roadmap', import.meta.url));
const roadmap = (args: readonly string[]) => runUntilExit(process.execPath, [BIN, ...args], { env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/' }, timeoutMs: 20_000 });

describe('bin/roadmap', () => {
  it('cli.writes-command-file: a run command writes one validated file into the run\'s queue and prints its id', { timeout: 30_000 }, async () => {
    const repo = makeRepo(tmpDir('cli-repo'), { files: { 'README.md': 'x\n' } });
    const dir = join(repo, '.git', 'roadmap-runtime', 'arc-1');
    mkdirSync(dir, { recursive: true });
    const cases: readonly [readonly string[], unknown][] = [
      [['pause', 'u1'], { type: 'pause', target: { type: 'unit', unit: 'u1' } }],
      [['stop'], { type: 'stop' }],
      [['ack', 'nu-7', '--choice', 'retry'], { type: 'ack', needsUser: 'nu-7', choice: 'retry' }],
      [['resume', '--backend', 'codex'], { type: 'resume', target: { type: 'backend', backend: 'codex' } }],
      [['sweep', '--resource', 'db'], { type: 'sweep', resource: 'db' }],
    ];
    const ids: string[] = [];
    for (const [args, body] of cases) {
      const exit = await roadmap([...args, '--repo', repo, '--arc', 'arc-1']);
      assert.equal(exit.code, 0, exit.stderr);
      const out = JSON.parse(exit.stdout) as { command: string; arc: string; type: string };
      assert.deepEqual({ arc: out.arc, type: out.type }, { arc: 'arc-1', type: (body as { type: string }).type });
      const file = commandFile(JSON.parse(readFileSync(join(dir, 'commands', 'incoming', `${out.command}.json`), 'utf8')), 'command');
      assert.deepEqual([file.id, file.arc, file.body], [out.command, 'arc-1', body]);
      ids.push(out.command);
    }
    assert.deepEqual(readdirSync(join(dir, 'commands', 'incoming')).sort(), ids.map((id) => `${id}.json`), 'one file per command, in submission order, no temp left');
    assert.deepEqual(readdirSync(join(dir, 'commands')).sort(), ['incoming']);
  });

  it('refuses a run that was never started, prints --version, and has no bare `version`', { timeout: 30_000 }, async () => {
    const repo = makeRepo(tmpDir('cli-repo'), { files: { 'README.md': 'x\n' } });
    const missing = await roadmap(['stop', '--repo', repo, '--arc', 'arc-9']);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /roadmap-runtime\/arc-9 does not exist/);
    const version = await roadmap(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+/);
    const bare = await roadmap(['version']);
    assert.equal(bare.code, 64);
    assert.match(bare.stderr, /unknown command "version"/);
  });
});
