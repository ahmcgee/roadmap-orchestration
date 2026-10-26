import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { tmpDir } from './helpers/repo.ts';

const installer = fileURLToPath(new URL('../bin/install-roadmap', import.meta.url));
const module = fileURLToPath(new URL('../src/cli/install.ts', import.meta.url));
const run = (script: string, dir: string, path = dir) => spawnSync(process.execPath, [script, '--bin-dir', dir], { encoding: 'utf8', env: { ...process.env, PATH: path } });

function plugin(root: string, name: string): string {
  mkdirSync(join(root, 'src/cli'), { recursive: true }); mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  cpSync(module, join(root, 'src/cli/install.ts')); cpSync(installer, join(root, 'bin/install-roadmap'));
  writeFileSync(join(root, 'bin/roadmap'), `process.stdout.write(JSON.stringify({ version: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd() }));`);
  return join(root, 'bin/install-roadmap');
}

test('container launcher installs the real CLI on PATH and is idempotent', () => {
  const root = tmpDir('install'); const dir = join(root, 'bin');
  const first = run(installer, dir); assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /Ready: roadmap --version/);
  const target = join(dir, 'roadmap'); const before = lstatSync(target);
  assert.equal(before.mode & 0o777, 0o755);
  const version = spawnSync('roadmap', ['--version'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: dir } });
  assert.equal(version.status, 0, version.stderr); assert.match(version.stdout, /1\.0\.0-dev\./);
  const again = run(installer, dir); assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /Already current/);
  assert.equal(lstatSync(target).ino, before.ino); assert.equal(lstatSync(target).mtimeMs, before.mtimeMs);
});

test('launcher refreshes its plugin target and preserves literal paths, arguments and cwd without relying on node in PATH', () => {
  const root = tmpDir('install-quotes'); const dir = join(root, "bin ' $ ` ;");
  const one = plugin(join(root, "plugin ' $(touch SHOULD_NOT_EXIST) ` odd"), 'one');
  const two = plugin(join(root, 'plugin two'), 'two');
  assert.equal(run(one, dir).status, 0);
  const args = ['tui', 'space and newline\nargument', '$(touch SHOULD_NOT_EXIST)', "a'b", '`printf unsafe`'];
  const invoke = () => spawnSync(join(dir, 'roadmap'), args, { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });
  let result = invoke(); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { version: 'one', argv: args, cwd: root });
  assert.equal(run(two, dir).status, 0); result = invoke(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { version: 'two', argv: args, cwd: root });
});

test('installer refuses unrelated commands, directories and symlinks without changing them', () => {
  for (const kind of ['file', 'directory', 'symlink']) {
    const root = tmpDir('install-conflict'); const dir = join(root, 'bin'); mkdirSync(dir);
    const target = join(dir, 'roadmap'); const other = join(root, 'other'); writeFileSync(other, 'unrelated target');
    if (kind === 'file') writeFileSync(target, 'unrelated command');
    else if (kind === 'directory') mkdirSync(target);
    else symlinkSync(other, target);
    const before = lstatSync(target); const result = run(installer, dir);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Refusing to replace/); assert.equal(lstatSync(target).ino, before.ino);
    assert.equal(readFileSync(other, 'utf8'), 'unrelated target');
    if (kind === 'file') assert.equal(readFileSync(target, 'utf8'), 'unrelated command');
  }
});

test('installer reports a missing PATH entry or shadowing command instead of claiming roadmap is available', () => {
  const root = tmpDir('install-path'); const dir = join(root, 'bin');
  const absent = run(installer, dir, '/nonexistent'); assert.equal(absent.status, 0); assert.match(absent.stdout, /not on this terminal.*PATH/); assert.doesNotMatch(absent.stdout, /Ready:/);
  const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'roadmap'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const shadowed = run(installer, dir, `${other}:${dir}`); assert.equal(shadowed.status, 0); assert.match(shadowed.stdout, /PATH currently resolves/); assert.doesNotMatch(shadowed.stdout, /Ready:/);
});
