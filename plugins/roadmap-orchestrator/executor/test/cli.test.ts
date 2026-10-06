import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    assert.deepEqual(parseCommand(['start', '--repo', '.', '--plan', 'plan.json']), { command: 'start', args: { repo: '.', plan: 'plan.json', profile: null, waitMs: null } });
    assert.deepEqual(parseStartArgs(['--plan', 'p.json', '--profile', 'claude-only', '--repo', '/r']), { repo: '/r', plan: 'p.json', profile: 'claude-only', waitMs: null });
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
      const extra = command === 'watch' ? { actionable: false } : {};
      assert.deepEqual(parseCommand([command]), { command, ...extra, run: HOST });
      assert.deepEqual(parseCommand([command, ...EXPLICIT]), { command, ...extra, run: EXPLICIT_RUN });
      assert.throws(() => parseCommand([command, '--repo', '/r']), /--repo and --arc go together/);
      assert.throws(() => parseCommand([command, 'extra']), /unexpected argument/);
    });
  }

  it('watch --actionable', () => {
    assert.deepEqual(parseCommand(['watch', '--actionable']), { command: 'watch', actionable: true, run: HOST });
    assert.deepEqual(parseCommand(['watch', '--actionable', ...EXPLICIT]), { command: 'watch', actionable: true, run: EXPLICIT_RUN });
    assert.throws(() => parseCommand(['status', '--actionable']), /unknown option --actionable/);
  });

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

  it('resolve-edge <edge> --evidence', () => {
    assert.deepEqual(parseCommand(['resolve-edge', 'e-top', '--evidence', 'the vendor shipped v2']), {
      command: 'resolve-edge', edge: 'e-top', evidence: 'the vendor shipped v2', run: HOST,
    });
    assert.throws(() => parseCommand(['resolve-edge', '--evidence', 'x']), /<edge> is required/);
    assert.throws(() => parseCommand(['resolve-edge', 'e-top']), /--evidence <text> is required/);
    assert.throws(() => parseCommand(['resolve-edge', 'e-top', '--evidence', ' ']), /--evidence <text> is required/);
    assert.throws(() => parseCommand(['resolve-edge', 'E_TOP', '--evidence', 'x']), CliError);
  });

  it('run-only <unit>... | --clear: the units ascending and unique', () => {
    assert.deepEqual(parseCommand(['run-only', 'u3', 'u1', 'u3', ...EXPLICIT]), { command: 'run-only', units: ['u1', 'u3'], run: EXPLICIT_RUN });
    assert.deepEqual(parseCommand(['run-only', '--clear']), { command: 'run-only', units: null, run: HOST });
    assert.throws(() => parseCommand(['run-only']), /either <unit>\.\.\. or --clear/);
    assert.throws(() => parseCommand(['run-only', 'u1', '--clear']), /either <unit>\.\.\. or --clear/);
    assert.throws(() => parseCommand(['run-only', 'U1']), CliError);
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
      [['resolve-edge', 'e-top', '--evidence', 'shipped'], { type: 'resolve-edge', edge: 'e-top', evidence: 'shipped' }],
      [['run-only', 'u2', 'u1'], { type: 'run-only', units: ['u1', 'u2'] }],
      [['run-only', '--clear'], { type: 'run-only', units: null }],
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

describe('cli: M3 forms', () => {
  it('cli.m3-forms: rule, reverse, steer, merge-in, audit, close-admissions, gc', () => {
    assert.deepEqual(parseCommand(['rule', 'rulings/C-7.json']), { command: 'rule', record: 'rulings/C-7.json', run: HOST });
    assert.deepEqual(parseCommand(['reverse', 'D-3', ...EXPLICIT]), { command: 'reverse', divergence: 'D-3', run: EXPLICIT_RUN });
    assert.deepEqual(parseCommand(['steer', 'u1', '--brief', 'b.md', '--budget', '45']), {
      command: 'steer', unit: 'u1', brief: 'b.md', budgetMin: 45, class: null, resume: false, run: HOST,
    });
    assert.deepEqual(parseCommand(['steer', 'u1', '--brief', 'b.md', '--budget', '45', '--class', 'summit', '--resume']), {
      command: 'steer', unit: 'u1', brief: 'b.md', budgetMin: 45, class: 'summit', resume: true, run: HOST,
    });
    assert.deepEqual(parseCommand(['merge-in', 'u1']), { command: 'merge-in', unit: 'u1', run: HOST });
    assert.deepEqual(parseCommand(['audit']), { command: 'audit', lenses: null, run: HOST });
    assert.deepEqual(parseCommand(['audit', '--lens', 'vision,drift,vision']), { command: 'audit', lenses: ['drift', 'vision'], run: HOST });
    assert.deepEqual(parseCommand(['close-admissions', ...EXPLICIT]), { command: 'close-admissions', run: EXPLICIT_RUN });
    assert.deepEqual(parseCommand(['gc', '--repo', '/r']), { command: 'gc', repo: '/r', keep: null, dryRun: false });
    assert.deepEqual(parseCommand(['gc', '--repo', '/r', '--keep', '3', '--dry-run']), { command: 'gc', repo: '/r', keep: 3, dryRun: true });
  });

  it('cli.m3-refusals: missing or malformed arguments name the command', () => {
    const refuses = (args: readonly string[], message: RegExp): void => assert.throws(() => parseCommand(args), (err: unknown) => err instanceof CliError && message.test(err.message), args.join(' '));
    refuses(['rule'], /rule: <record\.json> is required/);
    refuses(['rule', 'a.json', 'b.json'], /unexpected argument "b\.json"/);
    refuses(['reverse', 'C-3'], /DivergenceId/);
    refuses(['steer', 'u1', '--budget', '5'], /steer: --brief <file> is required/);
    refuses(['steer', 'u1', '--brief', 'b.md'], /steer: --budget <minutes> is required/);
    refuses(['steer', 'u1', '--brief', 'b.md', '--budget', '0'], /--budget takes a positive integer of minutes/);
    refuses(['steer', 'u1', '--brief', 'b.md', '--budget', '5', '--class', 'turbo'], /class/);
    refuses(['steer', '--brief', 'b.md', '--budget', '5'], /steer: <unit> is required/);
    refuses(['merge-in'], /merge-in: <unit> is required/);
    refuses(['audit', '--lens', 'style'], /lens/);
    refuses(['audit', 'now'], /unexpected argument/);
    refuses(['close-admissions', 'now'], /unexpected argument/);
    refuses(['gc'], /gc: --repo <path> is required/);
    refuses(['gc', '--repo', '/r', '--keep', '-1'], /needs a value|positive integer/);
    refuses(['gc', '--repo', '/r', '--arc', 'arc-1'], /unknown option --arc/);
  });

  it('cli.m3-writes-command-file: the M3 commands queue their bodies; rule and steer hash the file they name', { timeout: 30_000 }, async () => {
    const repo = makeRepo(tmpDir('cli-repo'), { files: { 'README.md': 'x\n' } });
    const dir = join(repo, '.git', 'roadmap-runtime', 'arc-1');
    mkdirSync(dir, { recursive: true });
    const record = join(repo, 'C-7.json');
    writeFileSync(record, '{"id":"C-7"}\n');
    const sha = createHash('sha256').update('{"id":"C-7"}\n').digest('hex');
    const cases: readonly [readonly string[], unknown][] = [
      [['rule', record], { type: 'rule', path: record, sha256: sha }],
      [['reverse', 'D-2'], { type: 'reverse', divergence: 'D-2' }],
      [['steer', 'u1', '--brief', record, '--budget', '30', '--class', 'frontier'], { type: 'steer', unit: 'u1', brief: { path: record, sha256: sha }, budgetMin: 30, class: 'frontier', resume: false }],
      [['merge-in', 'u1'], { type: 'merge-in', unit: 'u1' }],
      [['audit', '--lens', 'invariants'], { type: 'audit', lenses: ['invariants'] }],
      [['close-admissions'], { type: 'close-admissions' }],
    ];
    for (const [args, body] of cases) {
      const exit = await roadmap([...args, '--repo', repo, '--arc', 'arc-1']);
      assert.equal(exit.code, 0, exit.stderr);
      const out = JSON.parse(exit.stdout) as { command: string };
      const file = commandFile(JSON.parse(readFileSync(join(dir, 'commands', 'incoming', `${out.command}.json`), 'utf8')), 'command');
      assert.deepEqual(file.body, body, args.join(' '));
    }
    const missing = await roadmap(['rule', join(repo, 'nope.json'), '--repo', repo, '--arc', 'arc-1']);
    assert.equal(missing.code, 64);
    assert.match(missing.stderr, /rule: no file/);
    // gc runs for real (test/gc.test.ts, against a test host dir): here only on a repo with no arc, which it refuses
    // before it reads the host dir, so the machine's own host dir is never touched.
    const empty = makeRepo(tmpDir('cli-repo'), { files: { 'README.md': 'x\n' } });
    const gc = await roadmap(['gc', '--repo', empty]);
    assert.equal(gc.code, 78, gc.stderr);
    assert.deepEqual(JSON.parse(gc.stdout), { refused: { kind: 'no-arcs', runtime: join(empty, '.git', 'roadmap-runtime') } });
  });
});
