// Observe real dev.54-written records with the new detached service; no runtime-schema bump or migration.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ensureConsole, stopConsole } from '../../src/console/lease.ts';
import { arcId } from '../../src/core/ids.ts';
import { absPath } from '../../src/core/values.ts';
import { sha256Hex } from '../../src/core/json.ts';
import { gitCommonDir } from '../../src/git/git.ts';
import { CONSOLE_PROTOCOL } from '../../src/observation/protocol.ts';
import { setConsolePort } from '../fixtures/console.ts';
import { tmpDir } from '../helpers/repo.ts';

const PREVIOUS_REF = 'c1cd2413';
function contents(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else out[path.slice(root.length)] = sha256Hex(readFileSync(path)); } };
  walk(root); return out;
}
test('dev.54 records are adopted read-only by the console with identical canonical status and no schema rewrite', { timeout: 60_000 }, async (t) => {
  const root = tmpDir('console-previous'); const relative = 'plugins/roadmap-orchestrator/executor';
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const tar = join(root, 'previous.tar');
  execFileSync('git', ['archive', '-o', tar, PREVIOUS_REF, relative], { cwd: repoRoot }); execFileSync('tar', ['-xf', tar, '-C', root]);
  const previous = join(root, relative);
  assert.equal(JSON.parse(readFileSync(join(previous, 'package.json'), 'utf8')).version, '1.0.0-dev.54');
  const script = `import { parityArc, portableStatus } from ${JSON.stringify(pathToFileURL(join(previous, 'test/fixtures/status-parity.ts')).href)};
    import { status } from ${JSON.stringify(pathToFileURL(join(previous, 'src/status.ts')).href)};
    import { arcId } from ${JSON.stringify(pathToFileURL(join(previous, 'src/core/ids.ts')).href)};
    const f = parityArc(); const full = portableStatus(status(f.runDir, arcId(f.d.arc), f.hostDir));
    process.removeAllListeners('exit'); process.stdout.write(JSON.stringify({ ...f, full }));`;
  const f = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: root }, timeout: 30_000 })) as { d: { repo: string; arc: string }; runDir: string; hostDir: string; full: unknown };
  const repo = absPath(f.d.repo), hostDir = absPath(f.hostDir), common = gitCommonDir(repo);
  const runDir = join(common, 'roadmap-runtime', f.d.arc); mkdirSync(join(common, 'roadmap-runtime'), { recursive: true }); cpSync(f.runDir, runDir, { recursive: true });
  setConsolePort(repo, 0); const before = contents(runDir);
  t.after(() => stopConsole(repo)); const lease = await ensureConsole(repo, hostDir);
  const response = await fetch(`${lease.url}/api/${CONSOLE_PROTOCOL}/runs/${arcId(f.d.arc)}/status`); assert.equal(response.status, 200);
  const e = await response.json() as { data: unknown };
  const { portableStatus } = await import('../fixtures/status-parity.ts');
  assert.deepEqual(portableStatus(e.data), f.full); assert.deepEqual(contents(runDir), before);
  assert.equal(JSON.parse(readFileSync(join(runDir, 'start.json'), 'utf8')).v, 2);
});
